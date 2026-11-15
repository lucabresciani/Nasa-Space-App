"""H1 load test: 10 parallel guests against the live HOMELINE API (docs/hardening/load-test.md).

Stdlib + httpx only. Run it against a running `make serve` (or any API base) on 127.0.0.1:

    HL_TEAM_TOKEN=loadtest flock /tmp/hl-heavy.lock \
      uv run --no-sync python docs/hardening/load.py --base http://127.0.0.1:8012/api/v1 \
      --root-pid <pid of the server process tree root> --out /tmp/h1-run

What it does (all guests share 127.0.0.1, so they share one rate-limit key):
- every guest polls GET /health every 3 s (the live client's cadence) and, between think times,
  GETs /defaults, /engine/version, the official permalink files (/results/{official}/...,
  run_record.json included) and POSTs /pads/validate and /pads/screen on random valid and
  invalid points;
- guests 0 and 1 submit the SAME new pad at the same moment (one job, one attach);
- guest 2 submits a cached result (done, not counted), distinct new pads up to the per-IP
  limit, then one more (expects 429 + Retry-After), plus attaches (not counted);
- halfway, the kill switch is flipped on with the team token (POST /admin/heavy-jobs off):
  a new heavy job must get 503 heavy_jobs_off while reads, attaches and cached results still
  work; then it is flipped off;
- a sampler records the RSS of the server process tree every second, and the script lists the
  tree at the end (pool workers).

Outputs in --out: requests.jsonl (one line per request), mem.tsv, jobs.json, summary.json, and a
human summary on stdout. Exit 0 when nothing broke (no unexpected 5xx, /health p95 < 2 s while
2 jobs run, no job lost or failed, the expected 429 / 503 / attach outcomes).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import statistics
import sys
import time
from pathlib import Path

import httpx

GUESTS = 10
HEALTH_EVERY_S = 3.0
HEALTH_LIMIT_S = 2.0  # config/backend.yaml api.health_timeout_s
JOB_POLL_S = 5.0
JSON = {"content-type": "application/json"}


# ------------------------------------------------------------------------- recording ----
class Rec:
    def __init__(self, out: Path):
        self.t0 = time.monotonic()
        self.rows: list[dict] = []
        self.fh = (out / "requests.jsonl").open("w")
        self.running = 0  # jobs this test knows to be running (from GET /jobs polls)
        self.events: list[dict] = []

    def now(self) -> float:
        return time.monotonic() - self.t0

    def add(self, **row) -> None:
        row["t"] = round(self.now(), 3)
        self.rows.append(row)
        self.fh.write(json.dumps(row) + "\n")

    def event(self, msg: str, **kw) -> None:
        e = {"t": round(self.now(), 1), "event": msg, **kw}
        self.events.append(e)
        print(f"[{e['t']:7.1f}] {msg} {json.dumps(kw) if kw else ''}", flush=True)


async def call(rec: Rec, client: httpx.AsyncClient, guest: int, label: str, method: str,
               url: str, timeout: float = 30.0, **kw) -> httpx.Response | None:
    t = time.perf_counter()
    try:
        r = await client.request(method, url, timeout=timeout, **kw)
        status, err = r.status_code, None
    except httpx.HTTPError as e:
        r, status, err = None, None, type(e).__name__
    dt = time.perf_counter() - t
    code = None
    if r is not None and r.status_code >= 400:
        try:
            code = r.json().get("error")
        except ValueError:
            code = None
    rec.add(guest=guest, ep=label, status=status, err=err, code=code, s=round(dt, 4),
            running=rec.running)
    return r


# ---------------------------------------------------------------------------- memory ----
def _children(pid: int) -> list[int]:
    out = []
    for task in Path(f"/proc/{pid}/task").glob("*"):
        try:
            out += [int(c) for c in (task / "children").read_text().split()]
        except OSError:
            pass
    return out


def tree(root: int) -> list[int]:
    seen, todo = [], [root]
    while todo:
        p = todo.pop()
        if p in seen:
            continue
        seen.append(p)
        todo += _children(p)
    return seen


def rss_kb(pid: int) -> int:
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except OSError:
        pass
    return 0


def ppid(pid: int) -> int:
    try:
        return int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
    except (OSError, IndexError, ValueError):
        return 0


def cmdline(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode().strip()
    except OSError:
        return ""


async def mem_sampler(rec: Rec, root: int, out: Path, stop: asyncio.Event, peak: dict) -> None:
    with (out / "mem.tsv").open("w") as fh:
        fh.write("t\ttree_rss_mib\tprocs\tlargest_mib\n")
        while not stop.is_set():
            pids = tree(root)
            per = {p: rss_kb(p) for p in pids}
            total = sum(per.values())
            fh.write(f"{rec.now():.1f}\t{total / 1024:.1f}\t{len(pids)}\t"
                     f"{max(per.values(), default=0) / 1024:.1f}\n")
            if total > peak.get("kb", 0):
                peak.update(kb=total, t=round(rec.now(), 1),
                            procs={str(p): [round(k / 1024, 1), cmdline(p)[:90]]
                                   for p, k in per.items()})
            try:
                await asyncio.wait_for(stop.wait(), 1.0)
            except TimeoutError:
                pass


# --------------------------------------------------------------------------- guests ----
async def health_loop(rec: Rec, client, g: int, stop: asyncio.Event) -> None:
    await asyncio.sleep(random.uniform(0, HEALTH_EVERY_S))
    while not stop.is_set():
        t = time.monotonic()
        await call(rec, client, g, "GET /health", "GET", "/health", timeout=10.0)
        await asyncio.sleep(max(0.0, HEALTH_EVERY_S - (time.monotonic() - t)))


async def permalink(rec: Rec, client, g: int, official: str, files: list[str]) -> None:
    sem = asyncio.Semaphore(6)  # the web app loads them in parallel; a browser opens ~6 per host

    async def one(f):
        async with sem:
            await call(rec, client, g, "GET /results/{official}/*", "GET",
                       f"/results/{official}/{f}")
    await asyncio.gather(*(one(f) for f in files))


def random_point(rng: random.Random, centre: tuple[float, float]) -> dict:
    if rng.random() < 0.1:  # far away: outside the grid
        return {"lon": centre[0] + rng.choice([-1, 1]) * rng.uniform(0.1, 0.5),
                "lat": centre[1] + rng.choice([-1, 1]) * rng.uniform(0.1, 0.5)}
    return {"lon": round(centre[0] + rng.uniform(-0.04, 0.04), 6),
            "lat": round(centre[1] + rng.uniform(-0.04, 0.04), 6)}


async def reader(rec: Rec, client, g: int, ctx: dict, stop: asyncio.Event) -> None:
    rng = random.Random(1000 + g)
    await call(rec, client, g, "GET /defaults", "GET", "/defaults")
    await call(rec, client, g, "GET /engine/version", "GET", "/engine/version")
    await permalink(rec, client, g, ctx["official"], ctx["files"])
    while not stop.is_set():
        x = rng.random()
        if x < 0.35:
            p = rng.choice(ctx["valid"]) if rng.random() < 0.5 else random_point(rng, ctx["centre"])
            await call(rec, client, g, "POST /pads/validate", "POST", "/pads/validate", json=p)
        elif x < 0.65:
            p = rng.choice(ctx["valid"]) if rng.random() < 0.6 else random_point(rng, ctx["centre"])
            body = {"contract_version": ctx["cv"], "pad": p}
            await call(rec, client, g, "POST /pads/screen", "POST", "/pads/screen", json=body)
        elif x < 0.80:
            await permalink(rec, client, g, ctx["official"], ctx["files"])
        elif x < 0.90:
            await call(rec, client, g, "GET /defaults", "GET", "/defaults")
        else:
            await call(rec, client, g, "GET /engine/version", "GET", "/engine/version")
        try:
            await asyncio.wait_for(stop.wait(), rng.uniform(1.0, 4.0))
        except TimeoutError:
            pass


# ----------------------------------------------------------------------------- jobs ----
class Jobs:
    """Every POST /jobs this test makes, its answer, and the polled state of each job id."""

    def __init__(self, rec: Rec, cv: str):
        self.rec, self.cv = rec, cv
        self.submits: list[dict] = []
        self.state: dict[str, dict] = {}  # job id -> last GET /jobs/{id} body

    def body(self, pad: dict) -> dict:
        return {"type": "plan", "inputs": {"contract_version": self.cv,
                                           "title": f"H1 load {pad['lon']},{pad['lat']}",
                                           "pad": {"lon": pad["lon"], "lat": pad["lat"]}}}

    async def submit(self, client, g: int, pad: dict, why: str, inputs: dict | None = None):
        body = self.body(pad) if inputs is None else {"type": "plan", "inputs": inputs}
        r = await call(self.rec, client, g, "POST /jobs", "POST", "/jobs", json=body)
        row = {"t": round(self.rec.now(), 1), "guest": g, "why": why,
               "pad": None if inputs is not None else pad,
               "status": None if r is None else r.status_code}
        if r is not None:
            doc = r.json()
            row.update(error=doc.get("error"), retry_after_s=doc.get("retry_after_s"),
                       retry_after=r.headers.get("retry-after"), job=doc.get("id"),
                       job_status=doc.get("status"), attached=doc.get("attached"),
                       hash=doc.get("hash"))
            if r.status_code == 202 and doc.get("id"):
                self.state.setdefault(doc["id"], doc)
        self.submits.append(row)
        self.rec.event("POST /jobs", **{k: v for k, v in row.items() if k != "t"})
        return row

    async def poller(self, client, stop: asyncio.Event) -> None:
        while not stop.is_set():
            for jid in list(self.state):
                if self.state[jid].get("status") in ("done", "error", "timeout"):
                    continue
                r = await call(self.rec, client, 99, "GET /jobs/{id}", "GET", f"/jobs/{jid}")
                if r is not None and r.status_code == 200:
                    old = self.state[jid].get("status")
                    self.state[jid] = r.json()
                    if self.state[jid].get("status") != old:
                        self.rec.event("job", id=jid, status=self.state[jid].get("status"),
                                       stage=self.state[jid].get("stage"))
                elif r is not None:
                    self.state[jid] = {"status": f"LOST:{r.status_code}"}
            self.rec.running = sum(1 for j in self.state.values() if j.get("status") == "running")
            try:
                await asyncio.wait_for(stop.wait(), JOB_POLL_S)
            except TimeoutError:
                pass


async def submit_new(jobs: Jobs, client, g: int, pool: list[dict], why: str) -> dict:
    """Submit pads from the pool until one starts a NEW job (or is refused)."""
    while pool:
        row = await jobs.submit(client, g, pool.pop(0), why)
        if not (row["status"] == 202 and row["attached"]):
            return row
        jobs.rec.event("pad already computed or running; next pad", hash=row["hash"])
    raise RuntimeError("pad pool exhausted")


async def scenario(rec: Rec, base: str, ctx: dict, jobs: Jobs, duration: float, token: str,
                   checks: dict) -> None:
    pool = list(ctx["job_pads"])
    async with httpx.AsyncClient(base_url=base) as c0, httpx.AsyncClient(base_url=base) as c1, \
            httpx.AsyncClient(base_url=base) as c2, httpx.AsyncClient(base_url=base) as adm:
        await asyncio.sleep(5)
        # 1. two guests, the same new pad, at the same moment
        p1 = pool.pop(0)
        a, b = await asyncio.gather(jobs.submit(c0, 0, p1, "same pad A"),
                                    jobs.submit(c1, 1, p1, "same pad B"))
        checks["same_pad_one_job"] = (a["status"] == b["status"] == 202 and a["job"] == b["job"]
                                      and sorted([a["attached"], b["attached"]]) == [False, True])
        new = 1
        await asyncio.sleep(5)
        # 2. a cached result (official inputs): done at once, not counted
        off = await jobs.submit(c2, 2, {}, "official (cached)", inputs=ctx["official_inputs"])
        checks["cached_done"] = off["status"] == 202 and off["job_status"] == "done"
        for _ in range(2):  # P2, P3
            row = await submit_new(jobs, c2, 2, pool, "distinct new pad")
            new += row["status"] == 202
        await asyncio.sleep(2)
        att = await jobs.submit(c2, 2, p1, "attach P1")
        checks["attach_before_kill"] = att["status"] == 202 and att["attached"] is True

        # 3. kill switch halfway
        await asyncio.sleep(max(0.0, duration / 2 - rec.now()))
        hdr = {"X-HL-Team": token, **JSON}
        r = await call(rec, adm, 98, "POST /admin/heavy-jobs", "POST", "/admin/heavy-jobs",
                       headers=hdr, json={"heavy_jobs": "off"})
        rec.event("kill switch ON", status=None if r is None else r.status_code)
        h = await call(rec, adm, 98, "GET /health", "GET", "/health")
        checks["kill_health_off"] = h is not None and h.json().get("heavy_jobs") == "off"
        k_pad = pool.pop(0)
        k = await jobs.submit(c2, 2, k_pad, "new pad, kill switch on")
        checks["kill_new_503"] = k["status"] == 503 and k["error"] == "heavy_jobs_off"
        ka = await jobs.submit(c1, 1, p1, "attach/cached P1, kill switch on")
        checks["kill_attach_ok"] = ka["status"] == 202 and ka["attached"] is True
        ko = await jobs.submit(c2, 2, {}, "official, kill switch on", inputs=ctx["official_inputs"])
        checks["kill_cached_ok"] = ko["status"] == 202 and ko["job_status"] == "done"
        rr = await call(rec, adm, 98, "GET /results/{official}/*", "GET",
                        f"/results/{ctx['official']}/run_record.json")
        checks["kill_reads_ok"] = rr is not None and rr.status_code == 200
        await asyncio.sleep(20)
        r = await call(rec, adm, 98, "POST /admin/heavy-jobs", "POST", "/admin/heavy-jobs",
                       headers=hdr, json={"heavy_jobs": "on"})
        rec.event("kill switch OFF", status=None if r is None else r.status_code)
        h = await call(rec, adm, 98, "GET /health", "GET", "/health")
        checks["kill_health_on"] = h is not None and h.json().get("heavy_jobs") == "on"
        pool.insert(0, k_pad)

        # 4. fill the per-IP budget (6 new heavy jobs / 10 min), then the 7th
        while new < ctx["limit"]:
            row = await submit_new(jobs, c2, 2, pool, "distinct new pad")
            if row["status"] != 202:
                checks["budget_filled"] = False
                break
            new += 1
        seventh = await jobs.submit(c2, 2, pool.pop(0), "7th new heavy job")
        ra = seventh.get("retry_after")
        checks["seventh_429"] = (seventh["status"] == 429 and seventh["error"] == "rate_limited"
                                 and ra is not None and ra.isdigit() and 0 < int(ra) <= 600)
        att2 = await jobs.submit(c0, 0, p1, "attach/cached P1 after the limit")
        checks["attach_after_limit_ok"] = att2["status"] == 202 and att2["attached"] is True
        off2 = await jobs.submit(c2, 2, {}, "official after the limit",
                                 inputs=ctx["official_inputs"])
        checks["cached_after_limit_ok"] = off2["status"] == 202 and off2["job_status"] == "done"
        checks["new_jobs_accepted"] = new


# ----------------------------------------------------------------------------- main ----
def pct(xs: list[float], q: float) -> float:
    if not xs:
        return float("nan")
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, math.ceil(q * len(xs)) - 1))]


def summarise(rows: list[dict]) -> dict:
    out: dict = {}
    for ep in sorted({r["ep"] for r in rows}):
        rs = [r for r in rows if r["ep"] == ep]
        lat = [r["s"] for r in rs if r["status"] is not None]
        by: dict[str, int] = {}
        for r in rs:
            k = str(r["status"] or r["err"]) + (f" {r['code']}" if r.get("code") else "")
            by[k] = by.get(k, 0) + 1
        out[ep] = {"n": len(rs), "by_status": by,
                   "p50_ms": round(1000 * statistics.median(lat), 1) if lat else None,
                   "p95_ms": round(1000 * pct(lat, 0.95), 1) if lat else None,
                   "max_ms": round(1000 * max(lat), 1) if lat else None}
    return out


async def setup(base: str) -> dict:
    async with httpx.AsyncClient(base_url=base, timeout=30) as c:
        d = (await c.get("/defaults")).json()
        cv = d["inputs"]["contract_version"]
        off_pad = d["inputs"]["pad"]
        centre = (off_pad["lon"], off_pad["lat"])
        known = [(p["lon"], p["lat"]) for p in d.get("pads", [])] + [centre]
        # official hash: the official inputs give a done job at once; its hash
        r = await c.post("/plans/import", json=d["inputs"])
        official = r.json()["hash"]
        rr = (await c.get(f"/results/{official}/run_record.json")).json()
        assert rr.get("origin") == "precomputed", f"{official} is not the official tree: {rr}"
        idx = (await c.get(f"/results/{official}/scenarios/index.json")).json()
        files = ["run_record.json", "provenance", "manifest.json", "scenarios/index.json",
                 "pad.json", "labels.json", "stations.json"]
        for s in idx["scenarios"]:
            if s.get("suit_kg") == 104 or s["id"].startswith("nom_"):
                files += [f for f in s["files"].values() if f not in files]
        # valid pads: the nearest valid block of random points, re-validated, distinct
        rng, valid, seen = random.Random(71), [], set()
        for _ in range(4000):  # nearest valid blocks repeat: stop when enough or tried out
            if len(valid) >= 24:
                break
            p = random_point(rng, centre)
            v = (await c.post("/pads/validate", json=p)).json()
            q = v if v.get("valid") else v.get("nearest_valid")
            if not isinstance(q, dict) or "lon" not in q:
                continue
            q = {"lon": round(q["lon"], 6), "lat": round(q["lat"], 6)}
            key = (q["lon"], q["lat"])
            if key in seen or any(abs(q["lon"] - a) < 3e-4 and abs(q["lat"] - b) < 3e-4
                                  for a, b in known):
                continue
            if (await c.post("/pads/validate", json=q)).json().get("valid"):
                seen.add(key)
                valid.append(q)
        # job pads: only pads with no result tree yet (a re-run must not hit run-1 results)
        fresh = []
        for q in valid:
            body = {"contract_version": cv, "pad": q}
            h = (await c.post("/plans/import", json=body)).json().get("hash")
            if h and (await c.get(f"/results/{h}/run_record.json")).status_code == 404:
                fresh.append(q)
    return {"cv": cv, "centre": centre, "official": official, "official_inputs": d["inputs"],
            "files": files, "valid": valid, "job_pads": fresh[:12]}


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base", default="http://127.0.0.1:8012/api/v1")
    ap.add_argument("--duration", type=float, default=600.0)
    ap.add_argument("--root-pid", type=int, required=True, help="server process tree root")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--limit", type=int, default=6, help="limits.guest_heavy_jobs.count")
    ap.add_argument("--dry", action="store_true", help="reads only, no jobs (a smoke run)")
    a = ap.parse_args()
    token = os.environ.get("HL_TEAM_TOKEN", "")
    if not token:
        sys.exit("HL_TEAM_TOKEN must be set (the server's team token, for the kill switch)")
    a.out.mkdir(parents=True, exist_ok=True)

    ctx = await setup(a.base)
    ctx["limit"] = a.limit
    print(f"official {ctx['official']}, {len(ctx['files'])} permalink files, "
          f"{len(ctx['valid'])} valid pads", flush=True)
    rec = Rec(a.out)
    stop, mstop, peak, checks = asyncio.Event(), asyncio.Event(), {}, {}
    jobs = Jobs(rec, ctx["cv"])
    clients = [httpx.AsyncClient(base_url=a.base) for _ in range(GUESTS)]
    pclient = httpx.AsyncClient(base_url=a.base)
    tasks = [asyncio.create_task(mem_sampler(rec, a.root_pid, a.out, mstop, peak)),
             asyncio.create_task(jobs.poller(pclient, stop))]
    for g, c in enumerate(clients):
        tasks += [asyncio.create_task(health_loop(rec, c, g, stop)),
                  asyncio.create_task(reader(rec, c, g, ctx, stop))]
    scen = asyncio.create_task(asyncio.sleep(0) if a.dry else
                               scenario(rec, a.base, ctx, jobs, a.duration, token, checks))
    await asyncio.sleep(a.duration)
    stop.set()
    try:
        await asyncio.wait_for(scen, 60)
    except Exception as e:  # noqa: BLE001 - reported, not hidden
        checks["scenario_error"] = repr(e)
    await asyncio.gather(*tasks[1:], return_exceptions=True)
    # final job states
    for jid in jobs.state:
        r = await pclient.get(f"/jobs/{jid}")
        jobs.state[jid] = r.json() if r.status_code == 200 else {"status": f"LOST:{r.status_code}"}
    adm = await pclient.get("/admin/status", headers={"X-HL-Team": token})
    mstop.set()
    await tasks[0]
    for c in [*clients, pclient]:
        await c.aclose()

    rows = rec.rows
    summ = summarise(rows)
    health2 = [r["s"] for r in rows if r["ep"] == "GET /health" and r["running"] >= 2
               and r["status"] is not None]
    health_all = [r for r in rows if r["ep"] == "GET /health"]
    unexpected_5xx = [r for r in rows if (r["status"] or 0) >= 500
                      and not (r["ep"] == "POST /jobs" and r["code"] == "heavy_jobs_off")]
    transport = [r for r in rows if r["status"] is None]
    states = {jid: j.get("status") for jid, j in jobs.state.items()}
    bad_jobs = {k: v for k, v in states.items() if v not in ("queued", "running", "done")}
    procs = {str(p): cmdline(p)[:120] for p in tree(a.root_pid)}
    # pool workers: spawned children of the API process (under --reload the API process is
    # itself a spawn_main child of the reloader)
    api = {p for p in tree(a.root_pid) if "uvicorn" in cmdline(ppid(p))
           or "spawn_main" not in cmdline(ppid(p))}
    workers = [p for p, cl in procs.items() if "spawn_main" in cl and int(p) not in api]
    outcome: dict[str, int] = {}
    for s in jobs.submits:
        k = (str(s["status"]) + " " + (s.get("error") or (
            "attached" if s.get("attached") else "new")) + ("/done" if s.get("job_status") ==
                                                            "done" else ""))
        outcome[k] = outcome.get(k, 0) + 1
    result = {
        "endpoints": summ, "checks": checks, "events": rec.events, "submits": jobs.submits,
        "job_states": states, "submit_outcomes": outcome,
        "health": {"n": len(health_all),
                   "over_2s": sum(1 for r in health_all if (r["s"] > HEALTH_LIMIT_S)
                                  or r["status"] is None),
                   "n_while_2_running": len(health2),
                   "p95_ms_while_2_running": round(1000 * pct(health2, 0.95), 1) if health2
                   else None,
                   "max_ms_while_2_running": round(1000 * max(health2), 1) if health2 else None},
        "peak_rss_gib": round(peak.get("kb", 0) / 2**20, 2), "peak_at_s": peak.get("t"),
        "peak_procs_mib": peak.get("procs"),
        "unexpected_5xx": len(unexpected_5xx), "transport_errors": len(transport),
        "bad_jobs": bad_jobs, "admin_status_end": adm.json() if adm.status_code == 200 else None,
        "procs_end": procs, "pool_workers_end": len(workers),
    }
    (a.out / "summary.json").write_text(json.dumps(result, indent=1))
    (a.out / "jobs.json").write_text(json.dumps(jobs.state, indent=1))

    print("\nendpoint                        n     p50ms   p95ms    maxms  statuses")
    for ep, s in summ.items():
        print(f"{ep:30s}{s['n']:5d} {s['p50_ms']:8} {s['p95_ms']:8} {s['max_ms']:8}  "
              f"{s['by_status']}")
    for k in ("health", "peak_rss_gib", "submit_outcomes", "job_states", "unexpected_5xx",
              "transport_errors", "pool_workers_end", "checks"):
        print(f"{k}: {json.dumps(result[k])}")
    ok = (not unexpected_5xx and not transport and not bad_jobs and len(workers) == 2
          and health2 and pct(health2, 0.95) < HEALTH_LIMIT_S
          and "scenario_error" not in checks
          and all(v for k, v in checks.items() if k not in ("new_jobs_accepted",))
          and checks.get("new_jobs_accepted") == a.limit)
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

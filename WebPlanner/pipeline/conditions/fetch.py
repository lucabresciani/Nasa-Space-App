"""Fetch and cache the WS4 inputs (F14; brief WS4 task 1; SPEC §5.1 items 10-13).

Everything lands in ``data/raw/conditions/`` (git-ignored) with a cache index
``data/raw/conditions/index.json``: per cached file the source URL (``api_key`` stripped),
fetch time (UTC), byte count and SHA-256. ``python -m pipeline.conditions`` builds every output
from this cache only; fetching is a separate, explicit step:

    uv run --no-sync python -m pipeline.conditions.fetch all          # skip what is cached
    uv run --no-sync python -m pipeline.conditions.fetch rad --force  # refresh the latest RAD

Sources (endpoints verified by D0, docs/discovery.md §4):
* RAD L2 via the CDAS REST API (not HAPI): baseline week + storm window, and the last
  ``rad.latest_window_days`` days;
* REMS outreach feed (stale) and a row subset of PDS ``mslrem_1001`` MODRDR (RMD) for the
  Ls window: one multi-range HTTP request per sol (``rems.pds_rows_per_sol`` rows);
* DONKI (one request per endpoint; key from ``NASA_API_KEY``, never written anywhere);
* JPL Horizons one-way light time for the event weekend.

Downloaded content is untrusted data: it is parsed (JSON / fixed-width text), never executed,
and each response is size-capped.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests

from pipeline.conditions.config import RAW, fmt_utc, load_conditions, parse_utc

INDEX = RAW / "index.json"
TIMEOUT_S = 90
MAX_BYTES = 25_000_000  # per response; the whole WS4 cache must stay < 50 MB
BUDGET_BYTES = 50_000_000
USER_AGENT = "homeline-ws4-pipeline/1.0"


class FetchError(RuntimeError):
    pass


# --------------------------------------------------------------------------- cache index


def strip_secret(url: str) -> str:
    """Drop any api_key query parameter from a URL before it is stored or printed."""
    p = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if k.lower() != "api_key"]
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(q, safe=",:'@"), p.fragment))


def load_index() -> dict[str, Any]:
    return json.loads(INDEX.read_text()) if INDEX.exists() else {}


def cached(name: str) -> Path | None:
    p = RAW / name
    return p if p.exists() and name in load_index() else None


def put(name: str, content: bytes, url: str, **meta: Any) -> Path:
    """Write a cached file and its index entry (URL stored without the key)."""
    if "api_key=" in (url or "").lower() and strip_secret(url) == url:
        raise FetchError("refusing to store a URL that still carries a key")
    path = RAW / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    idx = load_index()
    idx[name] = {
        "url": strip_secret(url),
        "fetched_utc": fmt_utc(datetime.now(UTC)),
        "bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        **meta,
    }
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    INDEX.write_text(json.dumps(dict(sorted(idx.items())), indent=1) + "\n")
    return path


def total_bytes() -> int:
    return sum(int(e.get("bytes", 0)) for e in load_index().values())


def _check_budget(extra: int = 0) -> None:
    if total_bytes() + extra > BUDGET_BYTES:
        raise FetchError(f"WS4 cache would exceed {BUDGET_BYTES / 1e6:.0f} MB")


_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT


def http_get(url: str, *, params: dict | None = None, headers: dict | None = None,
             tries: int = 3) -> requests.Response:
    """GET with timeout, retries and a size cap; errors never echo the key."""
    last: Exception | None = None
    for k in range(tries):
        try:
            r = _session.get(url, params=params, headers=headers, timeout=TIMEOUT_S, stream=True)
            body = b""
            for chunk in r.iter_content(1 << 16):
                body += chunk
                if len(body) > MAX_BYTES:
                    raise FetchError(f"response over {MAX_BYTES} bytes: {strip_secret(r.url)}")
            r._content = body  # noqa: SLF001 (streamed with a cap, then exposed as usual)
            if r.status_code >= 500 and k + 1 < tries:
                raise FetchError(f"HTTP {r.status_code}")
            return r
        except (requests.RequestException, FetchError) as e:
            last = e
            time.sleep(2 * (k + 1))
    safe = strip_secret(requests.Request("GET", url, params=params).prepare().url or url)
    raise FetchError(f"GET failed after {tries} tries: {safe}: {type(last).__name__}")


def _ok(r: requests.Response) -> requests.Response:
    if r.status_code not in (200, 206):
        raise FetchError(f"HTTP {r.status_code} for {strip_secret(r.url)}")
    return r


# --------------------------------------------------------------------------- RAD (CDAS REST)


def _cdas_time(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def rad_windows(cfg: dict[str, Any], now: datetime) -> dict[str, tuple[datetime, datetime]]:
    from pipeline.conditions.rad import baseline_days  # noqa: PLC0415

    r = cfg["rad"]
    t0, t1 = (parse_utc(s) for s in r["storm_window_utc"])
    days = int(r["latest_window_days"])
    end = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return {
        "rad/rad_l2_storm.txt": (t0 - timedelta(days=baseline_days(cfg)), t1),
        "rad/rad_l2_latest.txt": (end - timedelta(days=days), end),
    }


def fetch_rad(cfg: dict[str, Any], now: datetime, force: bool = False,
              only_latest: bool = False) -> list[Path]:
    r = cfg["rad"]
    out = []
    for name, (a, b) in rad_windows(cfg, now).items():
        if only_latest and "latest" not in name:
            continue
        refresh = force and ("latest" in name or not only_latest)
        if cached(name) and not refresh:
            out.append(RAW / name)
            continue
        span = f"{_cdas_time(a)},{_cdas_time(b)}"
        api = f"{r['source_api']}/{r['dataset']}/data/{span}/{r['dose_variable']}"
        desc = _ok(http_get(api, params={"format": "text"},
                            headers={"Accept": "application/json"})).json()
        files = desc.get("FileDescription") or []
        if not files:
            raise FetchError(f"CDAS returned no file for {api}: {desc.get('Error') or desc}")
        furl = str(files[0]["Name"])
        if not furl.startswith("https://cdaweb.gsfc.nasa.gov/"):
            raise FetchError(f"unexpected CDAS file host: {furl}")
        body = _ok(http_get(furl)).content
        _check_budget(len(body))
        out.append(put(name, body, api + "?format=text", window_utc=[fmt_utc(a), fmt_utc(b)],
                       cdas_file=furl))
    return out


# --------------------------------------------------------------------------- REMS


def fetch_rems_feed(cfg: dict[str, Any], force: bool = False) -> Path:
    name = "rems/feed_msl_weather.json"
    if cached(name) and not force:
        return RAW / name
    url = cfg["rems"]["feed_url"]
    body = _ok(http_get(url)).content
    json.loads(body)  # must be JSON
    _check_budget(len(body))
    return put(name, body, url)


def ls_window_sols(feed: dict[str, Any], ls_window: list[float],
                   mars_years: list[int]) -> dict[int, list[int]]:
    """{MY: [sol, ...]} for sols whose feed Ls is in the window, per Mars year.

    The feed lists ``sol`` and integer ``ls``; Mars years are counted from the wrap of Ls
    (the feed has no MY), anchored on the latest feed entry's MY from Mars24.
    """
    from pipeline.conditions import marstime  # noqa: PLC0415

    rows = sorted(
        ((int(s["sol"]), float(s["ls"]), s["terrestrial_date"]) for s in feed["soles"]
         if str(s.get("sol", "")).isdigit() and _num(s.get("ls")) is not None),
    )
    last_sol, _, last_date = rows[-1]
    my_last = marstime.mars_time(parse_utc(f"{last_date}T12:00:00Z")).mars_year
    wraps = 0
    my_of: dict[int, int] = {}
    for k in range(len(rows) - 1, -1, -1):
        if k < len(rows) - 1 and rows[k][1] > rows[k + 1][1] + 180:
            wraps += 1
        my_of[rows[k][0]] = my_last - wraps
    lo, hi = ls_window
    out: dict[int, list[int]] = {}
    for sol, ls, _ in rows:
        my = my_of[sol]
        if my in mars_years and lo <= ls <= hi:
            out.setdefault(my, []).append(sol)
    if not out:
        raise FetchError("no feed sols in the Ls window for the configured Mars years")
    # fill sols missing from the feed between the first and last sol of each year
    return {my: list(range(min(s), max(s) + 1)) for my, s in sorted(out.items())}


def _num(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x


_HREF = re.compile(r'href="([^"?/][^"]*)"')


def _listing(url: str) -> list[str]:
    r = _ok(http_get(url))
    return _HREF.findall(r.text)


def pds_sol_folders(base: str) -> list[tuple[int, int, str]]:
    out = []
    for h in _listing(base + "/"):
        m = re.fullmatch(r"SOL_(\d{5})_(\d{5})/?", h)
        if m:
            out.append((int(m.group(1)), int(m.group(2)), h.rstrip("/")))
    return sorted(out)


def sample_rows(n_rows: int, k: int) -> list[int]:
    """k row indices spread evenly over 0 .. n_rows-1 (all rows if n_rows <= k)."""
    if n_rows <= k:
        return list(range(n_rows))
    return sorted({round(i * (n_rows - 1) / (k - 1)) for i in range(k)})



def fetch_rems_pds(cfg: dict[str, Any], force: bool = False, log=print) -> list[Path]:
    rc = cfg["rems"]
    feed = json.loads((RAW / "rems/feed_msl_weather.json").read_text())
    sols = ls_window_sols(feed, rc["ls_window_deg"], rc["pds_mars_years"])
    base = rc["pds_base_url"].rstrip("/")
    folders = pds_sol_folders(base)
    k = int(rc["pds_rows_per_sol"])
    row_bytes = int(rc["pds_rmd_record_bytes"])
    out = []
    for my, sol_list in sols.items():
        for sol in sol_list:
            name = f"rems/pds_rmd/SOL{sol:05d}_RMD_rows.bin"
            if cached(name) and not force:
                out.append(RAW / name)
                continue
            folder = next((f for a, b, f in folders if a <= sol <= b), None)
            if folder is None:
                log(f"  sol {sol}: not in PDS (latest folder ends at {folders[-1][1]})")
                continue
            sol_url = f"{base}/{folder}/SOL{sol:05d}/"
            try:
                tabs = [h for h in _listing(sol_url) if re.fullmatch(r"RME_\d+RMD\w*\.TAB", h)]
            except FetchError as e:
                log(f"  sol {sol}: no folder ({e})")
                continue
            if not tabs:
                log(f"  sol {sol}: no RMD table")
                continue
            tab_url = sol_url + sorted(tabs)[-1]
            h = _session.head(tab_url, timeout=TIMEOUT_S)
            size = int(h.headers.get("Content-Length", "0"))
            if size <= 0 or size % row_bytes:
                log(f"  sol {sol}: unexpected RMD size {size}")
                continue
            rows = sample_rows(size // row_bytes, k)
            rng = ",".join(f"{i * row_bytes}-{(i + 1) * row_bytes - 1}" for i in rows)
            r = _ok(http_get(tab_url, headers={"Range": f"bytes={rng}"}))
            body = r.content
            _check_budget(len(body))
            out.append(put(name, body, tab_url, mars_year=my, sol=sol, file_bytes=size,
                           row_bytes=row_bytes, rows_requested=len(rows),
                           content_type=r.headers.get("Content-Type", "")))
            log(f"  sol {sol} (MY {my}): {len(rows)} rows, {len(body)} bytes")
    return out


# --------------------------------------------------------------------------- DONKI


def fetch_donki(cfg: dict[str, Any], force: bool = False) -> list[Path]:
    d = cfg["donki"]
    key = os.environ.get("NASA_API_KEY")
    a, b = (parse_utc(s) for s in d["window_utc"])
    out = []
    for typ, ep in d["endpoints"].items():
        name = f"donki/{typ}.json"
        if cached(name) and not force:
            out.append(RAW / name)
            continue
        if not key:
            raise FetchError("NASA_API_KEY is not set")
        path, _, q = ep.partition("?")
        params = dict(parse_qsl(q))
        params.update(startDate=a.strftime("%Y-%m-%d"),
                      endDate=(b - timedelta(seconds=1)).strftime("%Y-%m-%d"))
        url = f"{d['base_url']}/{path}"
        r = _ok(http_get(url, params={**params, "api_key": key}))
        body = r.content
        if key.encode() in body:
            raise FetchError("DONKI response echoes the key; not cached")
        json.loads(body or b"[]")
        _check_budget(len(body))
        out.append(put(name, body, f"{url}?{urlencode(params)}", window_utc=list(d["window_utc"])))
    return out


# --------------------------------------------------------------------------- Horizons


def fetch_horizons(cfg: dict[str, Any], force: bool = False) -> Path:
    name = "horizons/mars_lighttime.json"
    if cached(name) and not force:
        return RAW / name
    h = cfg["horizons"]
    a, b = (parse_utc(s) for s in h["window_utc"])
    params = {
        "format": "json", "COMMAND": "'499'", "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'500@399'",
        "START_TIME": f"'{a:%Y-%m-%d %H:%M}'", "STOP_TIME": f"'{b:%Y-%m-%d %H:%M}'",
        "STEP_SIZE": f"'{h['step']}'", "QUANTITIES": "'20,21'",
    }
    r = _ok(http_get(h["api_url"], params=params))
    doc = r.json()
    if "result" not in doc:
        raise FetchError(f"Horizons: no result ({doc.get('error')})")
    return put(name, r.content, r.url)


# --------------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("what", nargs="+", choices=["all", "rad", "rad-latest", "rems-feed",
                                                 "rems-pds", "donki", "horizons"])
    ap.add_argument("--force", action="store_true", help="re-fetch even if cached")
    a = ap.parse_args(argv)
    cfg = load_conditions()
    now = datetime.now(UTC)
    w = set(a.what)
    every = "all" in w
    if every or "rad" in w:
        fetch_rad(cfg, now, a.force)
    if "rad-latest" in w:
        fetch_rad(cfg, now, True, only_latest=True)
    if every or "rems-feed" in w:
        fetch_rems_feed(cfg, a.force)
    if every or "donki" in w:
        fetch_donki(cfg, a.force)
    if every or "horizons" in w:
        fetch_horizons(cfg, a.force)
    if every or "rems-pds" in w:
        fetch_rems_pds(cfg, a.force)
    print(f"WS4 cache: {total_bytes() / 1e6:.2f} MB in {len(load_index())} files ({INDEX})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

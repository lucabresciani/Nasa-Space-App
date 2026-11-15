"""Per-IP rate limit on heavy jobs, kill switch and queue cap through the app, CORS (WS12 plan row
2.5, brief task 4; spec §8; F36).

Known answers (written before the limiter):
- the seventh heavy guest job from one IP within limits.guest_heavy_jobs.window_min is refused:
  429, openapi Error with retry_after_s and a Retry-After header; a second IP is unaffected;
- the key is the ASGI client host only (uvicorn sets it from the trusted proxy); a client's own
  X-Forwarded-For or CF-Connecting-IP header changes nothing;
- requests that start no new job (attach to a running job, a cached result, a refusal by the
  queue cap or the kill switch, a 422) do not use the quota;
- the 429 carries the CORS header for an allowed origin (the limiter sits inside CORS);
- CORS refuses an origin outside api.cors_origins;
- the kill switch refuses new heavy jobs and lets cached results through;
- every response validates against contracts/backend/openapi.yaml.
"""

from __future__ import annotations

import math
from contextlib import contextmanager

import pytest

pytest.importorskip("fastapi")  # server dependency group (uv sync --group server)
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402

from server.api.auth.limits import SlidingWindow  # noqa: E402
from server.api.compute import identity_provider  # noqa: E402
from server.app import create_app  # noqa: E402
from server.engine import jobs  # noqa: E402
from server.engine.testjobs import TEST_JOB  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests.test_jobs import (  # noqa: E402
    IDENT,
    TIMEOUT_S,
    assert_valid,
    cfg_override,
    finished,
    inputs,
    submit,
    wait_job,
)

PREFIX = settings().api.prefix
LIMIT = settings().limits.guest_heavy_jobs
IP_A, IP_B = ("203.0.113.7", 40001), ("198.51.100.9", 40002)


@pytest.fixture
def server_data(tmp_path, monkeypatch):
    sd = tmp_path / "server"
    sd.mkdir()
    monkeypatch.setenv("HL_SERVER_DATA", str(sd))
    monkeypatch.delenv(settings().deploy.kill_switch_env, raising=False)
    return sd


@contextmanager
def app_clients(*clients, workers: int = 2, queue: int = 20, timeout_s: float = TIMEOUT_S):
    """One app (test job type, injected identity); one TestClient per client address."""
    runner = jobs.JobRunner.from_config(
        cfg_override(workers=workers, queue_max_waiting=queue, job_timeout_s=timeout_s),
        job_types={"plan": TEST_JOB})
    app = create_app(warmup=lambda: None, jobs=runner)
    app.dependency_overrides[identity_provider] = lambda: (lambda: IDENT)
    with TestClient(app, client=clients[0]) as first:
        first.runner = runner
        others = [TestClient(app, client=c) for c in clients[1:]]
        yield (first, *others)


# ----------------------------------------------------------------------------- config ----
def test_the_limit_is_the_config_value():
    assert (LIMIT.count, LIMIT.window_min) == (6, 10)  # spec §8: guests 6 heavy jobs / 10 min / IP


# -------------------------------------------------------------------- the sliding window ----
class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def start(w, key):
    """Reserve and confirm one job start; the token, or the reserve answer when refused."""
    tok, retry = w.reserve(key)
    if tok is None:
        return None, retry
    w.confirm(key, tok)
    return tok, None


def test_window_seventh_in_ten_minutes_is_refused_with_the_time_until_a_slot_frees():
    clk = Clock()
    w = SlidingWindow(count=6, window_s=600, clock=clk)
    for _ in range(6):
        tok, retry = start(w, "a")
        assert tok is not None and retry is None
        clk.t += 10  # one job every 10 s: the first at 1000, the sixth at 1050
    assert start(w, "a") == (None, 540)  # at 1060; the first one leaves the window at 1600
    assert start(w, "b")[0] is not None  # another key is unaffected
    clk.t = 1599.5
    assert start(w, "a") == (None, 1)  # rounded up, never 0
    clk.t = 1600.0
    assert start(w, "a")[0] is not None  # the first one has left the window


def test_window_release_gives_the_slot_back():
    w = SlidingWindow(count=1, window_s=600, clock=Clock())
    tok, _ = w.reserve("a")
    assert w.reserve("a") == (None, None)  # undecided while the first is pending
    w.release("a", tok)
    tok2, _ = w.reserve("a")
    assert tok2 is not None and tok2 != tok
    w.confirm("a", tok2)
    assert w.reserve("a") == (None, 600)  # confirmed: refused


def test_window_pending_reservations_never_pass_the_limit():
    w = SlidingWindow(count=3, window_s=600, clock=Clock())
    toks = [w.reserve("a")[0] for _ in range(3)]
    assert all(toks) and w.reserve("a") == (None, None)
    for t in toks:
        w.confirm("a", t)
    assert w.reserve("a") == (None, 600)


def test_window_forgets_idle_keys():
    clk = Clock()
    w = SlidingWindow(count=2, window_s=60, clock=clk)
    for k in ("a", "b", "c"):
        start(w, k)
    assert w.keys() == 3
    clk.t += 61
    start(w, "d")
    assert w.keys() == 1


def test_window_does_not_keep_the_address_in_clear():
    w = SlidingWindow(count=2, window_s=60, clock=Clock())
    start(w, w.key("203.0.113.7"))
    assert "203.0.113.7" not in repr(w._hits)
    assert w.key("203.0.113.7") == w.key("203.0.113.7") != w.key("203.0.113.8")


def test_concurrent_identical_submits_all_attach(server_data):
    """More concurrent submits of one plan than the limit: one job, every answer 202."""
    import threading
    with app_clients(IP_A) as (a,):
        doc, out, barrier = inputs(137.0, "sleep:0.3"), [], threading.Barrier(LIMIT.count + 4)

        def go():
            barrier.wait()
            out.append(submit(a, doc))

        threads = [threading.Thread(target=go) for _ in range(LIMIT.count + 4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert [r.status_code for r in out] == [202] * (LIMIT.count + 4)
        assert len({r.json()["id"] for r in out}) == 1
        for i in range(1, LIMIT.count):  # one start used: 5 more
            assert submit(a, inputs(137.0 + i / 100)).status_code == 202
        assert submit(a, inputs(137.5)).status_code == 429


def test_a_concurrent_burst_of_new_jobs_never_passes_the_limit(server_data):
    import threading
    n = LIMIT.count + 4
    with app_clients(IP_A) as (a,):
        out, barrier = [], threading.Barrier(n)

        def go(i):
            barrier.wait()
            out.append(submit(a, inputs(126.0 + i / 100)))

        threads = [threading.Thread(target=go, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        codes = sorted(r.status_code for r in out)
        assert codes == [202] * LIMIT.count + [429] * 4


# ------------------------------------------------------------------------- through the API ----
def test_the_seventh_heavy_job_from_one_ip_is_429_with_a_retry_time_and_another_ip_is_not(
        server_data):
    with app_clients(IP_A, IP_B) as (a, b):
        hashes = set()
        for i in range(LIMIT.count):
            r = submit(a, inputs(136.0 + i / 100))
            body = assert_valid(r, "post", "/jobs")
            assert r.status_code == 202 and body["attached"] is False
            hashes.add(body["hash"])
        assert len(hashes) == LIMIT.count
        r = submit(a, inputs(136.5))
        assert r.status_code == 429
        body = assert_valid(r, "post", "/jobs")
        assert body["error"] == "rate_limited"
        assert isinstance(body["retry_after_s"], int)
        assert 0 < body["retry_after_s"] <= math.ceil(LIMIT.window_min * 60)
        assert r.headers["Retry-After"] == str(body["retry_after_s"])
        assert r.headers["Cache-Control"] == "no-store"
        assert a.runner.jobs_started <= LIMIT.count
        # a second IP is unaffected
        r = submit(b, inputs(136.6))
        assert r.status_code == 202 and assert_valid(r, "post", "/jobs")["attached"] is False


def test_forwarded_headers_from_the_client_are_ignored(server_data):
    spoof = {"X-Forwarded-For": "192.0.2.1", "CF-Connecting-IP": "192.0.2.2",
             "X-Real-IP": "192.0.2.3", "Forwarded": "for=192.0.2.4"}
    with app_clients(IP_A) as (a,):
        for i in range(LIMIT.count):
            hdr = {k: f"192.0.2.{10 + i}" for k in spoof}  # a new "address" each time
            assert a.post(f"{PREFIX}/jobs", headers=hdr, json={
                "type": "plan", "inputs": inputs(135.0 + i / 100)}).status_code == 202
        r = a.post(f"{PREFIX}/jobs", headers=spoof,
                   json={"type": "plan", "inputs": inputs(135.5)})
        assert r.status_code == 429


def test_attaching_and_cached_results_do_not_use_the_quota(server_data):
    with app_clients(IP_A) as (a,):
        first = submit(a, inputs(134.0, "sleep:0.5")).json()
        for _ in range(LIMIT.count + 2):  # attach to the running job
            b = assert_valid(submit(a, inputs(134.0, "sleep:0.5")), "post", "/jobs")
            assert b["attached"] is True and b["id"] == first["id"]
        assert wait_job(a, first["id"], finished)["status"] == "done"
        for _ in range(LIMIT.count + 2):  # the cached result
            b = assert_valid(submit(a, inputs(134.0)), "post", "/jobs")
            assert b["status"] == "done"
        for _ in range(LIMIT.count + 2):  # refused as invalid
            assert a.post(f"{PREFIX}/jobs", json={"type": "plan"}).status_code == 422
        for i in range(1, LIMIT.count):  # 5 more new jobs: 6 in all
            assert submit(a, inputs(134.0 + i / 100)).status_code == 202
        assert submit(a, inputs(134.5)).status_code == 429


def test_a_queue_full_refusal_does_not_use_the_quota(server_data):
    with app_clients(IP_A, workers=1, queue=1) as (a,):
        j = submit(a, inputs(133.0, "hang")).json()
        wait_job(a, j["id"], lambda b: b["status"] == "running")
        k = submit(a, inputs(133.01, "hang")).json()
        assert k["status"] == "queued"
        for i in range(LIMIT.count + 2):
            r = submit(a, inputs(133.1 + i / 100))
            assert r.status_code == 429
            assert assert_valid(r, "post", "/jobs")["error"] == "queue_full"
        for x in (j, k):
            assert wait_job(a, x["id"], finished)["status"] == "timeout"
        for i in range(2, LIMIT.count):  # the two hangs used two slots; 4 more fit
            n = submit(a, inputs(133.5 + i / 100))
            assert n.status_code == 202, n.json()
            wait_job(a, n.json()["id"], finished)
        assert assert_valid(submit(a, inputs(133.9)), "post", "/jobs")["error"] == "rate_limited"


def test_the_429_is_readable_cross_origin(server_data):
    origin = settings().api.cors_origins[0]
    with app_clients(IP_A) as (a,):
        for i in range(LIMIT.count):
            submit(a, inputs(132.0 + i / 100))
        r = a.post(f"{PREFIX}/jobs", headers={"Origin": origin},
                   json={"type": "plan", "inputs": inputs(132.5)})
        assert r.status_code == 429
        assert r.headers.get("access-control-allow-origin") == origin


def test_other_routes_are_not_limited(server_data):
    with app_clients(IP_A) as (a,):
        for i in range(LIMIT.count):
            submit(a, inputs(131.0 + i / 100))
        assert submit(a, inputs(131.5)).status_code == 429
        assert a.get(f"{PREFIX}/health").status_code == 200
        assert a.get(f"{PREFIX}/jobs/j_nope").status_code == 404


# ------------------------------------------------------------------------- kill switch ----
def test_the_kill_switch_refuses_new_heavy_jobs_and_lets_cached_results_through(server_data):
    with app_clients(IP_A) as (a,):
        done = wait_job(a, submit(a, inputs(130.0)).json()["id"], finished)
        assert done["status"] == "done"
        jobs.set_heavy_jobs_off(True)
        try:
            r = submit(a, inputs(130.1))
            assert r.status_code == 503
            assert assert_valid(r, "post", "/jobs")["error"] == "heavy_jobs_off"
            b = assert_valid(submit(a, inputs(130.0)), "post", "/jobs")
            assert (b["status"], b["id"]) == ("done", done["id"])
            assert a.get(f"{PREFIX}/results/{done['hash']}/provenance").status_code == 200
            assert a.get(f"{PREFIX}/health").json()["heavy_jobs"] == "off"
        finally:
            jobs.set_heavy_jobs_off(False)
        for i in range(1, LIMIT.count):  # the refusals used no quota: 1 + 5 new jobs
            assert submit(a, inputs(130.1 + i / 100)).status_code == 202


# --------------------------------------------------------------------------------- CORS ----
def test_cors_refuses_an_origin_outside_the_allow_list(server_data):
    with app_clients(IP_A) as (a,):
        for path in ("/health", "/plans/import", "/admin/status"):
            pre = a.options(f"{PREFIX}{path}", headers={
                "Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
            assert pre.status_code == 400
            assert "access-control-allow-origin" not in pre.headers
        r = a.get(f"{PREFIX}/health", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in r.headers
        good = settings().api.cors_origins[0]
        r = a.get(f"{PREFIX}/health", headers={"Origin": good})
        assert r.headers.get("access-control-allow-origin") == good

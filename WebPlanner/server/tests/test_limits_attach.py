"""At the per-IP heavy-job limit, attaches and cached results still pass (H1-2, load test H1; WS12
O3b; spec §8; F36).

Known answers (written before the fix; H1 run 1 answered 429 for the first two):
- at the limit, a submit of a plan that is running (or queued) gets 202 ``attached: true``, the
  same job id;
- at the limit, a submit of a plan whose result is done gets 202 ``status: done``;
- at the limit, a new distinct plan still gets 429 ``rate_limited`` with retry_after_s and
  Retry-After (the rate limit on new heavy jobs is not weakened);
- 8 concurrent identical submits give one job and no 429 (O3's rule, kept);
- attaches and cached results never use a slot: the 7th NEW job is the one refused, however many
  attaches and cached submits come between the new ones;
- the kill switch refuses new jobs and lets attaches and cached results through, at the limit too;
- an invalid submit at the limit is answered as before (429: it takes the reserve path);
- a submit that passed as an attach but started a new job after all (its job ended between the
  check and the route) is counted.
"""

from __future__ import annotations

import threading

import pytest

pytest.importorskip("fastapi")  # server dependency group (uv sync --group server)
pytest.importorskip("httpx")

from server.engine import jobs  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests.test_jobs import assert_valid, finished, inputs, submit, wait_job  # noqa: E402
from server.tests.test_limits import (  # noqa: E402
    IP_A,
    IP_B,
    LIMIT,
    PREFIX,
    app_clients,
    server_data,  # noqa: F401  (fixture)
)

SLOW = "sleep:3"  # long enough to stay running or queued for a test; the job timeout is above it
TIMEOUT_S = 10.0


def new_job(c, lon: float, title: str | None = SLOW) -> dict:
    r = submit(c, inputs(lon, title))
    body = assert_valid(r, "post", "/jobs")
    assert r.status_code == 202 and body["attached"] is False, body
    return body


def assert_rate_limited(r) -> None:
    assert r.status_code == 429, r.json()
    body = assert_valid(r, "post", "/jobs")
    assert body["error"] == "rate_limited"
    assert 0 < body["retry_after_s"] <= LIMIT.window_min * 60
    assert r.headers["Retry-After"] == str(body["retry_after_s"])


def test_at_the_limit_an_attach_to_a_running_or_queued_job_is_202_attached(server_data):  # noqa: F811
    with app_clients(IP_A, timeout_s=TIMEOUT_S) as (a,):
        started = [new_job(a, 120.0 + i / 100) for i in range(LIMIT.count)]  # 2 run, 4 queue
        first = wait_job(a, started[0]["id"], lambda b: b["status"] == "running")
        assert_rate_limited(submit(a, inputs(120.5, SLOW)))  # at the limit
        for _ in range(3):
            r = submit(a, inputs(120.0, SLOW))
            body = assert_valid(r, "post", "/jobs")
            assert r.status_code == 202, body
            assert (body["attached"], body["id"]) == (True, first["id"])
        last = started[-1]
        assert a.runner.status(last["id"])["status"] == "queued"
        r = submit(a, inputs(120.0 + (LIMIT.count - 1) / 100, SLOW))
        body = assert_valid(r, "post", "/jobs")
        assert r.status_code == 202 and (body["attached"], body["id"]) == (True, last["id"])
        assert_rate_limited(submit(a, inputs(120.6, SLOW)))  # still refused afterwards
        assert a.runner.jobs_started <= LIMIT.count


def test_at_the_limit_a_cached_result_is_202_done(server_data):  # noqa: F811
    with app_clients(IP_A, timeout_s=TIMEOUT_S) as (a,):
        done = wait_job(a, new_job(a, 121.0, None)["id"], finished)
        assert done["status"] == "done"
        for i in range(1, LIMIT.count):
            new_job(a, 121.0 + i / 100)
        assert_rate_limited(submit(a, inputs(121.5)))
        for _ in range(LIMIT.count + 2):
            r = submit(a, inputs(121.0))
            body = assert_valid(r, "post", "/jobs")
            assert r.status_code == 202, body
            assert (body["status"], body["hash"]) == ("done", done["hash"])
        assert_rate_limited(submit(a, inputs(121.6)))


def test_at_the_limit_a_new_distinct_job_is_still_429_and_another_ip_is_not(
        server_data):  # noqa: F811
    with app_clients(IP_A, IP_B, timeout_s=TIMEOUT_S) as (a, b):
        for i in range(LIMIT.count):
            new_job(a, 122.0 + i / 100, None)
        before = a.runner.jobs_started
        for i in range(3):
            assert_rate_limited(submit(a, inputs(122.5 + i / 100)))
        assert a.runner.jobs_started == before
        new_job(b, 122.9, None)


def test_eight_concurrent_identical_submits_give_one_job_and_no_429(server_data):  # noqa: F811
    with app_clients(IP_A, timeout_s=TIMEOUT_S) as (a,):
        out, barrier = [], threading.Barrier(8)

        def go():
            barrier.wait()
            out.append(submit(a, inputs(123.0, "sleep:0.3")))

        threads = [threading.Thread(target=go) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert [r.status_code for r in out] == [202] * 8
        assert len({r.json()["id"] for r in out}) == 1
        assert sorted(r.json()["attached"] for r in out) == [False] + [True] * 7
        for i in range(1, LIMIT.count):  # one slot used: 5 more
            new_job(a, 123.0 + i / 100, None)
        assert_rate_limited(submit(a, inputs(123.5)))


def test_concurrent_attaches_at_the_limit_all_pass(server_data):  # noqa: F811
    with app_clients(IP_A, timeout_s=TIMEOUT_S) as (a,):
        first = new_job(a, 124.0)
        for i in range(1, LIMIT.count):
            new_job(a, 124.0 + i / 100)
        out, barrier = [], threading.Barrier(8)

        def go():
            barrier.wait()
            out.append(submit(a, inputs(124.0, SLOW)))

        threads = [threading.Thread(target=go) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert [r.status_code for r in out] == [202] * 8
        assert {r.json()["id"] for r in out} == {first["id"]}


def test_attaches_and_cached_results_never_use_a_slot(server_data):  # noqa: F811
    """Interleaved: after each new job, attaches to it and a cached submit; the 7th NEW is
    refused."""
    with app_clients(IP_A, timeout_s=TIMEOUT_S) as (a,):
        cached = wait_job(a, new_job(a, 125.0, None)["id"], finished)
        assert cached["status"] == "done"
        for i in range(1, LIMIT.count):
            j = new_job(a, 125.0 + i / 100)
            for _ in range(2):
                b = assert_valid(submit(a, inputs(125.0 + i / 100, SLOW)), "post", "/jobs")
                assert (b["attached"], b["id"]) == (True, j["id"])
            b = assert_valid(submit(a, inputs(125.0)), "post", "/jobs")
            assert b["status"] == "done"
        assert_rate_limited(submit(a, inputs(125.5)))  # the 7th new job


def test_the_kill_switch_refuses_new_jobs_and_lets_attaches_and_cached_results_through(
        server_data):  # noqa: F811
    with app_clients(IP_A, timeout_s=TIMEOUT_S) as (a,):
        cached = wait_job(a, new_job(a, 126.0, None)["id"], finished)
        running = new_job(a, 126.01)
        jobs.set_heavy_jobs_off(True)
        try:
            r = submit(a, inputs(126.5))  # under the limit: the kill switch answers
            assert r.status_code == 503
            assert assert_valid(r, "post", "/jobs")["error"] == "heavy_jobs_off"
            b = assert_valid(submit(a, inputs(126.01, SLOW)), "post", "/jobs")
            assert (b["attached"], b["id"]) == (True, running["id"])
            b = assert_valid(submit(a, inputs(126.0)), "post", "/jobs")
            assert (b["status"], b["id"]) == ("done", cached["id"])
        finally:
            jobs.set_heavy_jobs_off(False)
        for i in range(2, LIMIT.count):
            new_job(a, 126.0 + i / 100)
        jobs.set_heavy_jobs_off(True)
        try:  # at the limit and switched off: new jobs refused, attaches and cached pass
            assert_rate_limited(submit(a, inputs(126.6)))  # the limiter answers first, as before
            b = assert_valid(submit(a, inputs(126.01, SLOW)), "post", "/jobs")
            assert (b["attached"], b["id"]) == (True, running["id"])
            b = assert_valid(submit(a, inputs(126.0)), "post", "/jobs")
            assert b["status"] == "done"
        finally:
            jobs.set_heavy_jobs_off(False)
        assert_rate_limited(submit(a, inputs(126.7)))


def test_invalid_submits_are_answered_as_before(server_data):  # noqa: F811
    with app_clients(IP_A, timeout_s=TIMEOUT_S) as (a,):
        bad = {"contract_version": settings().contract_version, "pad": {"lon": "x", "lat": 0}}
        for body in ({"type": "plan"}, {"type": "plan", "inputs": bad}, {"inputs": inputs(1.0)}):
            assert a.post(f"{PREFIX}/jobs", json=body).status_code == 422  # uncounted
        assert a.post(f"{PREFIX}/jobs", content=b"{not json",
                      headers={"content-type": "application/json"}).status_code == 422
        for i in range(LIMIT.count):
            new_job(a, 127.0 + i / 100, None)
        assert_rate_limited(a.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": bad}))


def test_a_passed_submit_that_started_a_new_job_after_all_is_counted(server_data):  # noqa: F811
    """The check and the route are not one step: a running job can end (error, timeout) between
    them. Such a submit started a new job, so it counts like one."""
    with app_clients(IP_A, timeout_s=TIMEOUT_S) as (a,):
        for i in range(LIMIT.count - 1):
            new_job(a, 128.0 + i / 100, None)
        a.runner.lookup = lambda h, identity=None: "running"  # the check says: attach
        try:
            new_job(a, 128.5, None)  # passed as an attach, started a job: the 6th
        finally:
            del a.runner.lookup
        assert_rate_limited(submit(a, inputs(128.6)))


def test_the_body_read_for_the_check_is_replayed_to_the_route_whole():
    import anyio

    from server.api.auth.limits import read_body

    async def go():
        msgs = [{"type": "http.request", "body": b'{"a":', "more_body": True},
                {"type": "http.request", "body": b' 1}', "more_body": False},
                {"type": "http.disconnect"}]

        async def receive():
            return msgs.pop(0)

        body, replay = await read_body(receive)
        assert body == b'{"a": 1}'
        assert await replay() == {"type": "http.request", "body": b'{"a": 1}', "more_body": False}
        assert await replay() == {"type": "http.disconnect"}  # then the server's own receive

        gone = [{"type": "http.disconnect"}]

        async def receive_gone():
            return gone[0]

        body, replay = await read_body(receive_gone)
        assert body == b"" and await replay() == {"type": "http.disconnect"}

    anyio.run(go)

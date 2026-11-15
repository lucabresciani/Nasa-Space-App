"""GET /admin/status, the kill-switch control and result pinning (WS12 plan row 2.5, brief tasks 4,
5 and 7; F36; spec §4.1 cache).

Known answers (written before the routes):
- admin without a team token, with a wrong one, or with none configured (HL_TEAM_TOKEN unset:
  admin disabled) is 403 with the openapi Error body; the token is compared in constant time and
  never appears in a response or the log;
- /admin/status with the token: uptime, queue length, workers, kill-switch state, engine identity,
  cache size, pinned hashes; it validates against openapi AdminStatus;
- the admin control flips the kill switch (E7 set_heavy_jobs_off): new heavy jobs are refused,
  cached results still answer, /health and /admin/status report "off";
- pinning: config cache.pinned names (official, picker) resolve to the official hash and one hash
  per picker pad; eviction (cache.max_gb, LRU) never removes a pinned tree or an unfinished one.
"""

from __future__ import annotations

import json
import logging
import os
import time

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from server.api.auth.admin import TEAM_HEADER, TEAM_TOKEN_ENV  # noqa: E402
from server.api.plans import pinning  # noqa: E402
from server.engine import defaults, jobs  # noqa: E402
from server.engine.hashing import official_hash, official_inputs, result_hash  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests.test_jobs import IDENT, assert_valid, finished, inputs, submit, wait_job  # noqa: E402
from server.tests.test_limits import IP_A, app_clients  # noqa: E402

PREFIX = settings().api.prefix
TOKEN = "t0p-s3cret-team-token-for-tests"
STATUS = f"{PREFIX}/admin/status"
CONTROL = f"{PREFIX}/admin/heavy-jobs"


@pytest.fixture
def server_data(tmp_path, monkeypatch):
    sd = tmp_path / "server"
    sd.mkdir()
    monkeypatch.setenv("HL_SERVER_DATA", str(sd))
    monkeypatch.delenv(settings().deploy.kill_switch_env, raising=False)
    monkeypatch.setenv(TEAM_TOKEN_ENV, TOKEN)
    yield sd
    jobs.set_heavy_jobs_off(False)


def get_status(c, token=TOKEN):
    return c.get(STATUS, headers={} if token is None else {TEAM_HEADER: token})


# -------------------------------------------------------------------------- the token ----
def test_the_token_env_and_header_are_the_contract_names():
    assert TEAM_TOKEN_ENV == "HL_TEAM_TOKEN"
    from server.tests.test_app import OPENAPI
    scheme = OPENAPI["components"]["securitySchemes"]["teamToken"]
    assert (scheme["in"], scheme["name"]) == ("header", TEAM_HEADER)


@pytest.mark.parametrize("token", [None, "", "wrong", TOKEN[:-1], TOKEN + "x", TOKEN.upper()])
def test_admin_without_or_with_a_wrong_token_is_403(server_data, token):
    with app_clients(IP_A) as (c,):
        r = get_status(c, token)
        assert r.status_code == 403
        assert assert_valid(r, "get", "/admin/status")["error"] == "forbidden"
        assert TOKEN not in r.text
        r = c.post(CONTROL, headers={} if token is None else {TEAM_HEADER: token},
                   json={"heavy_jobs": "off"})
        assert r.status_code == 403 and not jobs.heavy_jobs_off()


def test_without_a_configured_token_admin_is_disabled(server_data, monkeypatch):
    monkeypatch.delenv(TEAM_TOKEN_ENV)
    with app_clients(IP_A) as (c,):
        for tok in (None, "", TOKEN):
            r = get_status(c, tok)
            assert r.status_code == 403
            assert assert_valid(r, "get", "/admin/status")["error"] == "admin_disabled"
    monkeypatch.setenv(TEAM_TOKEN_ENV, "")  # an empty value is "not configured" too
    with app_clients(IP_A) as (c,):
        assert get_status(c, "").status_code == 403


def test_the_token_is_compared_in_constant_time(monkeypatch):
    import hmac

    from server.api.auth import admin
    calls = []
    real = hmac.compare_digest
    monkeypatch.setattr(admin.hmac, "compare_digest", lambda a, b: calls.append(1) or real(a, b))
    monkeypatch.setenv(TEAM_TOKEN_ENV, TOKEN)
    assert admin.token_ok(TOKEN) and not admin.token_ok("nope") and not admin.token_ok(None)
    assert len(calls) >= 2


def test_the_token_is_never_logged(server_data, caplog):
    caplog.set_level(logging.DEBUG)
    with app_clients(IP_A) as (c,):
        get_status(c)
        get_status(c, "wrong-token")
    assert TOKEN not in caplog.text and "wrong-token" not in caplog.text


# ----------------------------------------------------------------------------- status ----
def test_admin_status_known_answers(server_data):
    with app_clients(IP_A) as (c,):
        time.sleep(0.05)
        r = get_status(c)
        assert r.status_code == 200
        assert r.headers["Cache-Control"] == "no-store"
        s = assert_valid(r, "get", "/admin/status")
        assert s["queue_length"] == 0 and s["heavy_jobs"] == "on"
        assert s["uptime_s"] > 0
        assert s["workers"] == c.runner.workers == 2
        assert s["queue_max_waiting"] == c.runner.queue_max_waiting
        assert s["cache_gb"] == 0
        assert s["cache_max_gb"] == settings().cache.max_gb
        assert s["pinned"] == pinning.pinned_hashes(IDENT)
        assert set(s["engine"]) >= {"engine_tree", "commit", "config_hash"}
        assert s["engine"]["engine_tree"] == IDENT.engine_tree
        assert s["engine"]["terrain_hash"] == IDENT.terrain_hash
        assert s["engine"]["config_hash"] == IDENT.config_hash


def test_admin_status_counts_the_queue_and_the_cache(server_data):
    with app_clients(IP_A, workers=1, queue=2) as (c,):
        a = submit(c, inputs(129.0, "hang")).json()
        wait_job(c, a["id"], lambda b: b["status"] == "running")
        submit(c, inputs(129.1, "hang"))
        s = assert_valid(get_status(c), "get", "/admin/status")
        assert s["queue_length"] == 1 == c.get(f"{PREFIX}/health").json()["queue_length"]
    big = server_data / settings().cache.dir / ("e" * 16)
    big.mkdir(parents=True)
    (big / "x.bin").write_bytes(b"\0" * 2_000_000)
    with app_clients(IP_A) as (c,):
        s = assert_valid(get_status(c), "get", "/admin/status")
        assert s["cache_gb"] == pytest.approx(2_000_000 / 1e9, abs=1e-6)


# ---------------------------------------------------------------------- kill switch ----
def test_the_admin_control_flips_the_kill_switch(server_data):
    with app_clients(IP_A) as (c,):
        done = wait_job(c, submit(c, inputs(128.0)).json()["id"], finished)
        r = c.post(CONTROL, headers={TEAM_HEADER: TOKEN}, json={"heavy_jobs": "off"})
        assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"
        body = r.json()
        assert body["heavy_jobs"] == "off" and jobs.heavy_jobs_off()
        assert assert_valid(get_status(c), "get", "/admin/status")["heavy_jobs"] == "off"
        assert c.get(f"{PREFIX}/health").json()["heavy_jobs"] == "off"
        r = submit(c, inputs(128.1))
        assert r.status_code == 503 and r.json()["error"] == "heavy_jobs_off"
        b = assert_valid(submit(c, inputs(128.0)), "post", "/jobs")  # cached result
        assert (b["status"], b["id"]) == ("done", done["id"])
        r = c.post(CONTROL, headers={TEAM_HEADER: TOKEN}, json={"heavy_jobs": "on"})
        assert r.status_code == 200 and r.json()["heavy_jobs"] == "on"
        assert not jobs.heavy_jobs_off()
        assert submit(c, inputs(128.1)).status_code == 202


def test_the_admin_control_body_is_checked(server_data):
    with app_clients(IP_A) as (c,):
        for body in ({}, {"heavy_jobs": True}, {"heavy_jobs": "maybe"},
                     {"heavy_jobs": "off", "x": 1}, []):
            r = c.post(CONTROL, headers={TEAM_HEADER: TOKEN}, json=body)
            assert r.status_code == 422 and r.json()["error"] == "invalid_request"
        r = c.post(CONTROL, headers={TEAM_HEADER: TOKEN, "content-type": "application/json"},
                   content=b"{nope")
        assert r.status_code == 422
        assert not jobs.heavy_jobs_off()


def test_the_control_body_validates_against_admin_status(server_data):
    from jsonschema import Draft202012Validator

    from server.tests.test_app import API_ID, REGISTRY
    with app_clients(IP_A) as (c,):
        r = c.post(CONTROL, headers={TEAM_HEADER: TOKEN}, json={"heavy_jobs": "off"})
        v = Draft202012Validator({"$ref": f"{API_ID}#/components/schemas/AdminStatus"},
                                 registry=REGISTRY)
        assert not list(v.iter_errors(r.json()))


# ---------------------------------------------------------------------------- pinning ----
def test_pinned_names_come_from_config():
    assert settings().cache.pinned == ["official", "picker"]
    assert set(pinning.PINNERS) >= set(settings().cache.pinned)


def test_pinned_hashes_are_the_official_and_picker_pads():
    pads = [p for p in defaults.pads() if p.get("picker") and not p.get("official")]
    assert len(pads) == 4  # rank2, rank3, rank4, pad_default (scenarios/pads/index.json)
    want = {official_hash(IDENT)}
    for p in pads:
        doc = official_inputs()
        doc["pad"] = {"id": p["id"], "lon": p["lon"], "lat": p["lat"]}
        want.add(result_hash(doc, IDENT))
    got = pinning.pinned_hashes(IDENT)
    assert set(got) == want and len(got) == 5 and got == sorted(got)


def test_an_unknown_pinned_name_is_refused():
    cfg = settings()
    bad = cfg.model_copy(update={"cache": cfg.cache.model_copy(update={"pinned": ["nope"]})})
    with pytest.raises(ValueError, match="nope"):
        pinning.pinned_hashes(IDENT, bad)


def make_tree(root, h: str, size: int, age_s: float, done: bool = True):
    d = root / h
    d.mkdir(parents=True)
    (d / "data.bin").write_bytes(b"\0" * size)
    if done:
        (d / "run_record.json").write_text(json.dumps({"status": "done"}))
    t = time.time() - age_s
    for p in d.iterdir():
        os.utime(p, (t, t))
    return d


def test_eviction_is_lru_and_never_removes_a_pinned_or_unfinished_tree(tmp_path):
    root = tmp_path / "results"
    pinned = "a" * 16
    make_tree(root, pinned, 400, age_s=5000)  # oldest, but pinned
    make_tree(root, "b" * 16, 400, age_s=4000, done=False)  # old but unfinished (a job runs)
    make_tree(root, "c" * 16, 400, age_s=3000)
    make_tree(root, "d" * 16, 400, age_s=2000)
    make_tree(root, "e" * 16, 400, age_s=1000)
    (root / ".job-j_x").mkdir()  # hidden temp dirs are the runner's
    removed = pinning.evict(root, max_bytes=1300, pinned={pinned})
    assert removed == ["c" * 16, "d" * 16]  # oldest unpinned finished trees first, down to the cap
    assert sorted(p.name for p in root.iterdir()) == [".job-j_x", "a" * 16, "b" * 16, "e" * 16]
    # nothing left that may go: the cap is not met, and pinned/unfinished trees stay
    assert pinning.evict(root, max_bytes=1, pinned={pinned}) == ["e" * 16]
    assert sorted(p.name for p in root.iterdir()) == [".job-j_x", "a" * 16, "b" * 16]


def test_eviction_under_the_cap_removes_nothing(tmp_path):
    root = tmp_path / "results"
    make_tree(root, "c" * 16, 100, age_s=10)
    assert pinning.evict(root, max_bytes=10_000, pinned=set()) == []
    assert pinning.evict(tmp_path / "missing", max_bytes=1, pinned=set()) == []


def test_eviction_without_an_identity_removes_nothing(server_data, monkeypatch):
    root = server_data / settings().cache.dir
    make_tree(root, "c" * 16, 100, age_s=10)

    def no_identity():
        from server.engine import version
        raise version.Unavailable("no server data manifest")

    assert pinning.evict_cache(no_identity, max_bytes=1) == []
    assert (root / ("c" * 16)).is_dir()

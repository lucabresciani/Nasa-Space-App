"""Job runner and POST /jobs, GET /jobs/{id} (WS11 plan row 2.3, brief task 7; F23, F24 stages).

Known answers (written before the runner):
- the same inputs give one hash and one job, also for concurrent submits; a title change attaches;
- a finished hash whose tree exists answers done at once (the official hash: the precomputed tree);
- past the queue cap (compute.queue_max_waiting) a submit is refused: 429, Error body with
  retry_after_s and a Retry-After header;
- a timed-out job frees its worker (the next job runs to done) and reports timeout with an error;
- a failing job reports its error and leaves no result tree;
- stages appear in order; the files of a finished stage are readable under result_url while the job
  still runs; run_record.json is written last and validates;
- the kill switch (deploy.kill_switch_env) refuses new heavy jobs; cached results stay;
- every response validates against contracts/backend/openapi.yaml.

Test jobs: server.engine.testjobs (the shipped test job type, registered here as "plan"),
sub-second, with a small job timeout through a config override (settings().model_copy).
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import pytest

pytest.importorskip("fastapi")  # server dependency group (uv sync --group server)
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402
from jsonschema import Draft202012Validator  # noqa: E402

from server.api.compute import identity_provider  # noqa: E402
from server.app import create_app  # noqa: E402
from server.engine import jobs, results  # noqa: E402
from server.engine.hashing import EngineIdentity, official_inputs, result_hash  # noqa: E402
from server.engine.testjobs import TEST_JOB  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests.test_app import API_ID, OPENAPI, REGISTRY  # noqa: E402

PREFIX = settings().api.prefix
IDENT = EngineIdentity("a" * 40, "sha256:" + "b" * 64, "sha256:" + "c" * 64)
WAIT_S = 20.0
TIMEOUT_S = 1.0  # test override of compute.job_timeout_s (config: 600 s)


# ------------------------------------------------------------------------------- helpers ----
def response_schema(method: str, path: str, status: int) -> dict:
    resp = OPENAPI["paths"][path][method]["responses"][str(status)]
    if "$ref" in resp:
        resp = OPENAPI["components"]["responses"][resp["$ref"].rsplit("/", 1)[1]]
    return resp


def assert_valid(r, method: str, path: str) -> dict:
    """The response status is listed for the operation and the body validates against it."""
    resp = response_schema(method, path, r.status_code)
    ref = resp["content"]["application/json"]["schema"]["$ref"]
    body = r.json()
    v = Draft202012Validator({"$ref": f"{API_ID}{ref}"}, registry=REGISTRY)
    errors = sorted(v.iter_errors(body), key=str)
    assert not errors, [e.message for e in errors]
    for name in resp.get("headers", {}):
        assert name in r.headers, f"{name} header missing"
    return body


def inputs(lon: float, title: str | None = None) -> dict:
    doc = {"contract_version": settings().contract_version, "pad": {"lon": lon, "lat": -4.7}}
    if title is not None:
        doc["title"] = title
    return doc


def submit(c, doc: dict, type_: str = "plan"):
    return c.post(f"{PREFIX}/jobs", json={"type": type_, "inputs": doc})


def get_job(c, jid: str):
    r = c.get(f"{PREFIX}/jobs/{jid}")
    return assert_valid(r, "get", "/jobs/{id}") if r.status_code == 200 else r.json()


def wait_job(c, jid: str, pred, timeout_s: float = WAIT_S) -> dict:
    t0 = time.monotonic()
    while True:
        body = get_job(c, jid)
        if pred(body):
            return body
        assert time.monotonic() - t0 < timeout_s, body
        time.sleep(0.01)


def finished(b: dict) -> bool:
    return b["status"] in ("done", "error", "timeout")


def cfg_override(**compute):
    cfg = settings()
    return cfg.model_copy(update={"compute": cfg.compute.model_copy(update=compute)})


@pytest.fixture
def server_data(tmp_path, monkeypatch):
    sd = tmp_path / "server"
    sd.mkdir()
    monkeypatch.setenv("HL_SERVER_DATA", str(sd))
    monkeypatch.delenv(settings().deploy.kill_switch_env, raising=False)
    return sd


@contextmanager
def live(workers: int = 2, queue: int = 2, timeout_s: float = TIMEOUT_S):
    runner = jobs.JobRunner.from_config(
        cfg_override(workers=workers, queue_max_waiting=queue, job_timeout_s=timeout_s),
        job_types={"plan": TEST_JOB})
    app = create_app(warmup=lambda: None, jobs=runner)
    app.dependency_overrides[identity_provider] = lambda: (lambda: IDENT)
    with TestClient(app) as c:
        c.runner = runner
        yield c
    assert not any(p.is_alive() for p in runner.processes()), "a worker outlived the app"


def results_dir(sd: Path) -> Path:
    return sd / settings().cache.dir


# ------------------------------------------------------------------------ config values ----
def test_runner_limits_come_from_config():
    r = jobs.JobRunner.from_config(job_types={"plan": TEST_JOB})
    c = settings().compute
    assert (r.workers, r.queue_max_waiting, r.job_timeout_s) == (c.workers, c.queue_max_waiting,
                                                                 c.job_timeout_s)
    assert (c.workers, c.queue_max_waiting, c.job_timeout_s) == (2, 20, 600)  # spec §4.1; D81


def test_job_types_are_the_contract_names():
    schema = json.loads((Path(results.BACKEND_CONTRACTS) / "job.schema.json").read_text())
    assert jobs.JOB_TYPE_NAMES == tuple(schema["properties"]["type"]["enum"])
    with pytest.raises(ValueError):
        jobs.JobRunner.from_config(job_types={"sleep": TEST_JOB})


# ------------------------------------------------------------------------- de-duplication ----
def test_same_inputs_give_one_hash_and_one_job_concurrently(server_data):
    doc = inputs(137.1, "sleep:0.3")
    with live() as c:
        out, barrier = [], threading.Barrier(8)

        def go():
            barrier.wait()
            out.append(submit(c, doc))

        threads = [threading.Thread(target=go) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        bodies = [assert_valid(r, "post", "/jobs") for r in out]
        assert {r.status_code for r in out} == {202}
        assert len({b["id"] for b in bodies}) == 1
        assert len({b["hash"] for b in bodies}) == 1
        assert bodies[0]["hash"] == result_hash(doc, IDENT)
        assert sorted(b["attached"] for b in bodies) == [False] + [True] * 7
        # a title change does not change the hash: it attaches too
        again = assert_valid(submit(c, inputs(137.1, "another title")), "post", "/jobs")
        assert again["id"] == bodies[0]["id"] and again["attached"] is True
        done = wait_job(c, bodies[0]["id"], finished)
        assert done["status"] == "done", done
        # finished: the same inputs answer done at once, with the same job, and no new run
        r = submit(c, doc)
        b = assert_valid(r, "post", "/jobs")
        assert (b["status"], b["id"], b["attached"], b["progress"]) == ("done", done["id"], True, 1)
        assert b["result_url"] == f"{PREFIX}/results/{b['hash']}/"
        assert c.runner.jobs_started == 1


def test_different_inputs_give_two_jobs(server_data):
    with live() as c:
        a = submit(c, inputs(137.2)).json()
        b = submit(c, inputs(137.3)).json()
        assert a["id"] != b["id"] and a["hash"] != b["hash"]
        assert not a["attached"] and not b["attached"]
        for j in (a, b):
            assert wait_job(c, j["id"], finished)["status"] == "done"


def test_a_finished_tree_on_disk_answers_done_without_a_job(server_data):
    doc = inputs(137.4)
    with live() as c:
        first = wait_job(c, submit(c, doc).json()["id"], finished)
        assert first["status"] == "done"
    with live() as c:  # a new process: the job store is empty, the tree is on disk
        b = assert_valid(submit(c, doc), "post", "/jobs")
        assert (b["status"], b["attached"], b["hash"]) == ("done", True, first["hash"])
        assert b["stages_done"] == list(TEST_JOB.stages)
        assert get_job(c, b["id"])["status"] == "done"
        assert c.runner.jobs_started == 0


def test_the_official_hash_answers_done_from_the_precomputed_tree(server_data):
    with live() as c:
        b = assert_valid(submit(c, official_inputs()), "post", "/jobs")
        assert (b["status"], b["attached"], b["progress"]) == ("done", True, 1)
        assert b["hash"] == results.resolve_tree(b["hash"], lambda: IDENT).hash
        assert results.resolve_tree(b["hash"], lambda: IDENT).precomputed
        assert c.runner.jobs_started == 0
        assert not results_dir(server_data).joinpath(b["hash"]).exists()


# -------------------------------------------------------------------------- stages, tree ----
def test_stages_appear_in_order_and_are_readable_while_running(server_data):
    with live() as c:
        r = submit(c, inputs(137.5, "sleep:0.4"))
        j = assert_valid(r, "post", "/jobs")
        assert j["status"] in ("queued", "running") and j["stages_done"] == []
        assert j["result_url"] is None and j["progress"] == 0
        seen, readable_while_running = [], False
        while True:
            b = get_job(c, j["id"])
            if not seen or seen[-1] != b["stages_done"]:
                seen.append(list(b["stages_done"]))
            if b["status"] == "running" and len(b["stages_done"]) < len(TEST_JOB.stages):
                assert b["stage"] == TEST_JOB.stages[len(b["stages_done"])]
            if b["status"] == "running" and b["stages_done"] == ["inputs"]:
                # the first stage's files are readable under result_url before the job ends
                assert b["result_url"] == f"{PREFIX}/results/{j['hash']}/"
                assert 0 < b["progress"] < 1
                f = c.get(f"{b['result_url']}inputs.json")
                assert f.status_code == 200, f.text
                assert f.json()["pad"]["lon"] == 137.5
                rr = c.get(f"{b['result_url']}run_record.json")
                if get_job(c, j["id"])["stages_done"] == ["inputs"]:  # still in "work" after it:
                    assert rr.status_code == 404  # the run record cannot exist yet
                    readable_while_running = True
            if finished(b):
                break
            time.sleep(0.01)
        assert b["status"] == "done" and b["stage"] is None and b["progress"] == 1
        assert readable_while_running
        stages = list(TEST_JOB.stages)
        for s in seen:  # every observation is a prefix of the declared order
            assert s == stages[:len(s)]
        assert seen[-1] == stages
        rec = c.get(f"{PREFIX}/results/{j['hash']}/provenance")
        assert rec.status_code == 200
        rec = rec.json()
        results.validate_run_record(rec)
        assert rec["status"] == "done" and rec["origin"] == "computed_live"
        assert rec["label"] == settings().labels.live
        assert rec["hash"] == j["hash"] and rec["inputs"]["title"] == "sleep:0.4"
        assert [s["name"] for s in rec["stages"]] == stages
        assert [s["started_utc"] for s in rec["stages"]] == sorted(s["started_utc"]
                                                                    for s in rec["stages"])
        assert rec["stages"][0]["files"] == ["inputs.json"]
        assert {f["path"] for f in rec["files"]} == {"inputs.json", "work.json", "summary.json"}
        assert (rec["engine"]["tree"], rec["engine"]["config_hash"], rec["terrain_hash"]) == IDENT
        rd = results_dir(server_data)
        tree = rd / j["hash"]
        assert tree.is_dir() and not tree.is_symlink()
        assert sorted(p.name for p in tree.iterdir()) == ["inputs.json", "run_record.json",
                                                          "summary.json", "work.json"]
        assert not [p for p in rd.iterdir() if p.name.startswith(".")]  # no temp dir left
        assert not [p for p in tree.rglob(".*")]  # no temp file left


# ---------------------------------------------------------------------------- failures ----
def test_a_failing_job_reports_its_error(server_data):
    with live() as c:
        j = submit(c, inputs(137.6, "fail:boom at work")).json()
        b = wait_job(c, j["id"], finished)
        assert b["status"] == "error", b
        assert "boom at work" in b["error"]
        assert b["stages_done"] == ["inputs"] and b["stage"] is None
        assert not results_dir(server_data).joinpath(j["hash"]).exists()
        assert not [p for p in results_dir(server_data).iterdir()]
        assert c.get(f"{PREFIX}/results/{j['hash']}/inputs.json").status_code == 404
        # a new submit of the failed inputs is a new job (a retry), not an attach to the failure
        again = submit(c, inputs(137.6, "fail:boom at work")).json()
        assert again["id"] != j["id"] and again["attached"] is False


def test_a_timed_out_job_frees_its_worker_and_reports_timeout(server_data):
    with live(workers=1, queue=2) as c:
        hang = submit(c, inputs(137.7, "hang")).json()
        nxt = submit(c, inputs(137.8, "sleep:0.05")).json()
        assert nxt["status"] == "queued" or nxt["status"] == "running"
        pid0 = wait_job(c, hang["id"], lambda b: b["status"] == "running") and c.runner.pids()
        t0 = time.monotonic()
        b = wait_job(c, hang["id"], finished)
        assert b["status"] == "timeout", b
        assert b["error"] and "timed out" in b["error"]
        assert time.monotonic() - t0 < TIMEOUT_S + 5
        # the single worker was recycled and the queued job runs to done on it
        assert wait_job(c, nxt["id"], finished)["status"] == "done"
        assert c.runner.pids() != pid0
        assert not results_dir(server_data).joinpath(hang["hash"]).exists()
        assert not [p for p in results_dir(server_data).iterdir() if p.name.startswith(".")]


# ------------------------------------------------------------------------------ the cap ----
def test_past_the_queue_cap_the_submit_is_refused_with_retry_after(server_data):
    with live(workers=1, queue=1) as c:
        a = submit(c, inputs(137.91, "hang")).json()
        wait_job(c, a["id"], lambda b: b["status"] == "running")
        b = assert_valid(submit(c, inputs(137.92, "hang")), "post", "/jobs")
        assert b["status"] == "queued" and b["queue_position"] == 0
        h = c.get(f"{PREFIX}/health").json()
        assert h["queue_length"] == 1
        r = submit(c, inputs(137.93))
        assert r.status_code == 429
        body = assert_valid(r, "post", "/jobs")
        assert body["error"] == "queue_full"
        assert isinstance(body["retry_after_s"], int)
        assert 0 <= body["retry_after_s"] <= math.ceil(TIMEOUT_S)
        assert r.headers["Retry-After"] == str(body["retry_after_s"])
        # identical inputs still attach while the queue is full
        same = assert_valid(submit(c, inputs(137.92, "hang")), "post", "/jobs")
        assert same["id"] == b["id"] and same["attached"] is True


def test_retry_after_is_the_time_until_a_worker_must_free():
    assert jobs.retry_after_s([12.2, 30.0], 180) == 13
    assert jobs.retry_after_s([], 180) == 180  # no running job yet (workers starting)
    assert jobs.retry_after_s([-0.5], 180) == 0


def test_submit_returns_at_once(server_data):
    with live(workers=1, queue=2) as c:
        t0 = time.monotonic()
        r = submit(c, inputs(137.94, "hang"))
        assert r.status_code == 202 and time.monotonic() - t0 < 1.0


# ------------------------------------------------------------------------ kill switch ----
def test_the_kill_switch_refuses_new_heavy_jobs(server_data, monkeypatch):
    with live() as c:
        done = wait_job(c, submit(c, inputs(137.95)).json()["id"], finished)
        jobs.set_heavy_jobs_off(True)
        try:
            assert jobs.heavy_jobs_off()
            assert c.get(f"{PREFIX}/health").json()["heavy_jobs"] == "off"
            r = submit(c, inputs(137.96))
            assert r.status_code == 503
            assert assert_valid(r, "post", "/jobs")["error"] == "heavy_jobs_off"
            # cached results stay
            b = assert_valid(submit(c, inputs(137.95)), "post", "/jobs")
            assert b["status"] == "done" and b["id"] == done["id"]
        finally:
            jobs.set_heavy_jobs_off(False)
        assert not jobs.heavy_jobs_off()
        assert submit(c, inputs(137.96)).status_code == 202


# --------------------------------------------------------------------- request errors ----
@pytest.mark.parametrize("body", [
    {"type": "plan"},
    {"inputs": {"contract_version": "1.0.1", "pad": {"lon": 1, "lat": 1}}},
    {"type": "sleep", "inputs": {"contract_version": "1.0.1", "pad": {"lon": 1, "lat": 1}}},
    {"type": "plan", "inputs": {"contract_version": "1.0.1", "pad": {"lon": 1, "lat": 1}}, "x": 1},
    {"type": "plan", "inputs": {"contract_version": "1.0.1"}},
    {"type": "plan", "inputs": {"contract_version": "1.0.1", "pad": {"lon": 999, "lat": 1}}},
    [],
])
def test_invalid_requests_are_422(server_data, body):
    with live() as c:
        r = c.post(f"{PREFIX}/jobs", json=body)
        assert r.status_code == 422
        assert assert_valid(r, "post", "/jobs")["error"] in ("invalid_request", "invalid_inputs")
        assert c.runner.jobs_started == 0


def test_a_job_type_without_a_handler_is_503(server_data):
    with live() as c:
        r = submit(c, inputs(137.97), "siting")
        assert r.status_code == 503
        assert assert_valid(r, "post", "/jobs")["error"] == "job_type_unavailable"


def test_unknown_job_is_404(server_data):
    with live() as c:
        r = c.get(f"{PREFIX}/jobs/j_nope")
        assert r.status_code == 404
        assert assert_valid(r, "get", "/jobs/{id}")["error"] == "unknown_job"


def test_without_server_data_identity_the_submit_is_503(server_data):
    with live() as c:
        c.app.dependency_overrides.pop(identity_provider)  # live identity: no manifest.json
        r = submit(c, inputs(137.98))
        assert r.status_code == 503
        assert assert_valid(r, "post", "/jobs")["error"] == "server_data_missing"


# --------------------------------------------------------------------------- lifecycle ----
def test_the_pool_starts_after_the_warm_up_and_stops_with_the_app(server_data):
    release = threading.Event()
    runner = jobs.JobRunner.from_config(cfg_override(job_timeout_s=TIMEOUT_S),
                                        job_types={"plan": TEST_JOB})
    app = create_app(warmup=lambda: release.wait(WAIT_S), jobs=runner)
    app.dependency_overrides[identity_provider] = lambda: (lambda: IDENT)
    with TestClient(app) as c:
        time.sleep(0.2)
        assert runner.processes() == []  # not before the warm-up
        j = submit(c, inputs(137.99)).json()
        assert j["status"] == "queued"  # accepted while warming, runs after
        release.set()
        assert wait_job(c, j["id"], finished)["status"] == "done"
        procs = runner.processes()
        assert len(procs) == 2 and all(p.is_alive() for p in procs)
    assert not any(p.is_alive() for p in procs)


def test_stale_temp_dirs_are_cleaned_at_start(server_data):
    # Stale = no running job can own it (E7b, H1-1): its owner process is gone (a crash), or it is
    # older than 2 x job_timeout_s. Live owners: server/tests/test_jobs_owner.py.
    rd = results_dir(server_data)
    (rd / ".job-j_old").mkdir(parents=True)
    (rd / ".job-j_old" / "x.json").write_text("{}")
    gone = int(subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"],
                              capture_output=True, text=True, check=True).stdout)
    owner = {**jobs.owner_record(TIMEOUT_S), "pid": gone}  # the crashed server
    (rd / ".job-j_old" / jobs.OWNER_FILE).write_text(json.dumps(owner))
    (rd / ".job-j_older").mkdir()  # no owner file, older than 2 x the timeout
    t = time.time() - 2 * TIMEOUT_S - 1
    os.utime(rd / ".job-j_older", (t, t))
    with live():
        pass
    assert not (rd / ".job-j_old").exists()
    assert not (rd / ".job-j_older").exists()


def test_a_partial_tree_is_replaced_when_its_hash_runs_again(server_data):
    doc = inputs(137.15)
    partial = results_dir(server_data) / result_hash(doc, IDENT)
    partial.mkdir(parents=True)
    (partial / "stale.json").write_text("{}")  # left by a crash: no run record
    with live() as c:
        j = assert_valid(submit(c, doc), "post", "/jobs")
        assert j["status"] != "done"
        assert wait_job(c, j["id"], finished)["status"] == "done"
        assert not (partial / "stale.json").exists()
        assert (partial / "run_record.json").is_file()

"""Job worker initializer (E8b; WS11 spec §4.1 "Numba compiled at start-up"; E7 note: spawned
workers do not inherit the parent's compiled kernels).

Known answers (written before the initializer):
- every worker of the pool runs ``warmup.worker_init`` before its first job: a probe job reads the
  flag the initializer set in its own process, and the engine's real jitted Dijkstra
  (pipeline.engine.dijkstra._dijkstra, imported, not copied) already has a compiled signature there;
- with server data present the worker has the grid open as read-only memory maps;
- a worker respawned after a timeout kill runs the initializer again (new pid, flag set);
- without server data the pool still starts and jobs still run (the initializer logs and goes on);
- the app's default job runner passes ``worker_init`` to its workers.

The probe job type lives in this module (``run_probe`` is pickled by reference into the spawned
worker), so this module keeps its imports light.
"""

from __future__ import annotations

import json
import time
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
pytest.importorskip("numba")
from fastapi.testclient import TestClient  # noqa: E402

from server.api.compute import identity_provider  # noqa: E402
from server.app import create_app  # noqa: E402
from server.engine import jobs, version, warmup  # noqa: E402
from server.engine.jobs import JobContext, JobType  # noqa: E402
from server.tests.test_jobs import (  # noqa: E402
    IDENT,
    cfg_override,
    finished,
    inputs,
    results_dir,
    submit,
    wait_job,
)

WAIT_S = 120.0  # each worker loads the compiled kernels (Numba cache) before its first job
GRID_N = 5


# ------------------------------------------------------------------------- the probe job ----
def run_probe(inputs: dict, ctx: JobContext) -> None:
    """Report what the worker's initializer left in this process; ``hang`` never finishes and
    ``sleep:<s>`` holds the worker (so the next job goes to the other worker)."""
    import os

    from pipeline.engine import dijkstra

    title = str(inputs.get("title") or "")
    if title == "hang":
        while True:
            time.sleep(3600)
    if title.startswith("sleep:"):
        time.sleep(float(title.removeprefix("sleep:")))
    g = warmup.WORKER["grid"]
    ctx.write_json("probe.json", {
        "pid": os.getpid(),
        "initialized": warmup.WORKER["initialized"],
        "init_pid": warmup.WORKER["pid"],
        "numba_warm": warmup.WORKER["numba_warm"],
        "compiled": len(dijkstra._dijkstra.signatures),
        "grid_shape": None if g is None else list(g.shape),
        "grid_memmap": g is not None and isinstance(g.elev, np.memmap),
        "errors": warmup.WORKER["errors"],
    })
    ctx.stage("probe")


PROBE = JobType(run=run_probe, stages=("probe",))


# ----------------------------------------------------------------------------- fixtures ----
@pytest.fixture
def no_server_data(tmp_path, monkeypatch):
    sd = tmp_path / "server"
    sd.mkdir()
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(sd))
    return sd


@pytest.fixture
def grid_server_data(no_server_data):
    """A server data folder with just a manifest and its grid arrays (what open_grid reads)."""
    sd = no_server_data
    (sd / "grid").mkdir()
    arrays = {"elev": np.zeros((GRID_N, GRID_N)), "maxslope": np.zeros((GRID_N, GRID_N)),
              "slope": np.zeros((GRID_N, GRID_N)),
              "cellstate": np.zeros((GRID_N, GRID_N), np.uint8),
              "stepguard": np.zeros((GRID_N, GRID_N), bool)}
    entries = {}
    for k, a in arrays.items():
        np.save(sd / "grid" / f"{k}.npy", a)
        entries[k] = {"dtype": str(a.dtype), "path": f"grid/{k}.npy"}
    (sd / version.SERVER_DATA_MANIFEST).write_text(json.dumps({"grid": {
        "arrays": entries, "res_m": 3.0, "x0": 0.0, "y0": 0.0, "crs": "", "shape": [GRID_N] * 2}}))
    return sd


@contextmanager
def live(workers: int, timeout_s: float = WAIT_S):
    runner = jobs.JobRunner.from_config(
        cfg_override(workers=workers, queue_max_waiting=4, job_timeout_s=timeout_s),
        job_types={"plan": PROBE}, initializer=warmup.worker_init)
    app = create_app(warmup=lambda: None, preload=None, jobs=runner)
    app.dependency_overrides[identity_provider] = lambda: (lambda: IDENT)
    with TestClient(app) as c:
        c.runner = runner
        yield c
    assert not any(p.is_alive() for p in runner.processes()), "a worker outlived the app"


def probe(c, sd: Path, job: dict) -> dict:
    b = wait_job(c, job["id"], finished, WAIT_S)
    assert b["status"] == "done", b
    return json.loads((results_dir(sd) / b["hash"] / "probe.json").read_text())


# -------------------------------------------------------------------------------- tests ----
def test_every_worker_runs_the_initializer_before_its_first_job(grid_server_data):
    with live(workers=2) as c:
        a = submit(c, inputs(137.1, "sleep:1")).json()  # holds one worker: b goes to the other
        b = submit(c, inputs(137.2)).json()
        pa, pb = probe(c, grid_server_data, a), probe(c, grid_server_data, b)
        assert pa["pid"] != pb["pid"]
        assert {pa["pid"], pb["pid"]} == set(c.runner.pids())
        for p in (pa, pb):
            assert p["initialized"] and p["init_pid"] == p["pid"], p
            assert p["numba_warm"] and p["compiled"] >= 1, p  # the real kernel, compiled
            assert p["grid_shape"] == [GRID_N, GRID_N] and p["grid_memmap"], p
            assert p["errors"] == [], p


def test_a_worker_recycled_after_a_timeout_runs_the_initializer_again(no_server_data):
    # the job timeout counts from dispatch, after the worker's initializer: a probe takes ms
    with live(workers=1, timeout_s=2.0) as c:
        first = probe(c, no_server_data, submit(c, inputs(137.3)).json())
        hang = submit(c, inputs(137.4, "hang")).json()
        assert wait_job(c, hang["id"], finished, WAIT_S)["status"] == "timeout"
        again = probe(c, no_server_data, submit(c, inputs(137.5)).json())
        assert again["pid"] != first["pid"]  # a new process took the slot
        assert again["initialized"] and again["init_pid"] == again["pid"], again
        assert again["numba_warm"] and again["compiled"] >= 1, again


def test_missing_server_data_does_not_break_the_pool(no_server_data):
    assert not (no_server_data / version.SERVER_DATA_MANIFEST).exists()
    with live(workers=1) as c:
        p = probe(c, no_server_data, submit(c, inputs(137.6)).json())
        assert p["initialized"] and p["numba_warm"], p
        assert p["grid_shape"] is None
        assert [e for e in p["errors"] if e.startswith("server data:")], p


def test_the_default_runner_gives_every_worker_the_initializer(no_server_data):
    app = create_app(warmup=lambda: None, preload=None)
    assert app.state.jobs.initializer is warmup.worker_init


def test_the_initializer_records_what_it_could_not_do(no_server_data):
    """In-process call (the same function the workers run): no server data is an error entry,
    never an exception."""
    warmup.worker_init()
    assert warmup.WORKER["initialized"] and warmup.WORKER["numba_warm"]
    assert warmup.WORKER["grid"] is None
    assert any("ServerDataMissing" in e for e in warmup.WORKER["errors"])

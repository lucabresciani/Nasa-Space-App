"""Temp dir ownership and the read-only lookup (WS11 E7b, load test H1 finding H1-1).

Known answers (written before the fix):
- a runner starting while another runner (a separate process) has a running job on the same
  $HL_SERVER_DATA does not delete that job's temp dir, and the job completes (H1-1);
- a temp dir whose owner pid is dead is removed;
- a temp dir whose owner pid is alive but whose recorded process start time differs (pid reused) is
  removed;
- a temp dir older than 2 x compute.job_timeout_s is removed even if its owner looks alive;
- a temp dir whose owner is alive and that is younger than that is kept, also by a periodic
  cleanup of the owner's own runner;
- a temp dir without an owner file (a server from before this fix, or one created a microsecond
  ago) is kept until it is older than 2 x job_timeout_s (by its mtime);
- an owner on another host or in another pid namespace cannot be checked: age only;
- ``JobRunner.lookup(hash)`` answers running / queued / done / None and changes nothing (no job, no
  reservation, no file).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")  # server dependency group (uv sync --group server)
pytest.importorskip("httpx")

from server.engine import jobs  # noqa: E402
from server.engine.hashing import official_inputs, result_hash  # noqa: E402
from server.engine.testjobs import TEST_JOB  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests.test_jobs import (  # noqa: E402
    IDENT,
    WAIT_S,
    cfg_override,
    finished,
    inputs,
    live,
    results_dir,
    submit,
    wait_job,
)

REPO = Path(__file__).resolve().parents[2]
TIMEOUT_S = 10.0  # the job timeout of the runners built here
LINUX = Path("/proc/self/stat").is_file()


@pytest.fixture
def server_data(tmp_path, monkeypatch):
    """A scratch $HL_SERVER_DATA (as server/tests/test_jobs.py), never the shared one."""
    sd = tmp_path / "server"
    sd.mkdir()
    monkeypatch.setenv("HL_SERVER_DATA", str(sd))
    monkeypatch.delenv(settings().deploy.kill_switch_env, raising=False)
    return sd


def runner(timeout_s: float = TIMEOUT_S, **compute) -> jobs.JobRunner:
    return jobs.JobRunner.from_config(cfg_override(job_timeout_s=timeout_s, **compute),
                                      job_types={"plan": TEST_JOB})


def make_tmp(rd: Path, name: str, owner: dict | None) -> Path:
    d = rd / f"{jobs.TMP_PREFIX}{name}"
    d.mkdir(parents=True)
    if owner is not None:
        (d / jobs.OWNER_FILE).write_text(json.dumps(owner), encoding="utf-8")
    (d / "inputs.json").write_text("{}", encoding="utf-8")
    return d


def dead_pid() -> int:
    """The pid of a process that has exited and been reaped."""
    p = subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"],
                       capture_output=True, text=True, check=True)
    pid = int(p.stdout)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return pid
    pytest.skip("the pid of the exited process was reused at once")


def start_and_stop(r: jobs.JobRunner) -> None:
    r.start(ready=lambda _t: True)
    r.stop()


# ----------------------------------------------------------------------- owner records ----
def test_the_owner_record_names_this_process(server_data):
    o = jobs.owner_record(TIMEOUT_S)
    assert o["pid"] == os.getpid()
    assert o["hostname"] and o["created_at"].endswith("Z")
    assert abs(o["created_unix"] - time.time()) < 5
    assert o["job_timeout_s"] == TIMEOUT_S
    if LINUX:
        assert isinstance(o["start_ticks"], int) and o["boot_id"] and o["pid_ns"]
    assert jobs.owner_alive(o) is True


def test_a_dispatched_job_writes_its_owner_file_first(server_data):
    with live(workers=1, timeout_s=TIMEOUT_S) as c:
        j = submit(c, inputs(137.61, "sleep:1")).json()
        wait_job(c, j["id"], lambda b: b["status"] == "running")
        tmps = [p for p in results_dir(server_data).iterdir()
                if p.name.startswith(jobs.TMP_PREFIX)]
        assert len(tmps) == 1
        owner = json.loads((tmps[0] / jobs.OWNER_FILE).read_text(encoding="utf-8"))
        assert owner["pid"] == os.getpid() and jobs.owner_alive(owner) is True
        b = wait_job(c, j["id"], finished)
        assert b["status"] == "done"
    tree = results_dir(server_data) / b["hash"]
    assert not (tree / jobs.OWNER_FILE).exists()  # hidden: never published
    record = json.loads((tree / "run_record.json").read_text(encoding="utf-8"))
    assert all(not f["path"].startswith(".") for f in record["files"])


# ---------------------------------------------------------------- start-up cleanup (H1-1) ----
CHILD = textwrap.dedent("""
    import sys
    from server.tests.test_jobs import finished, inputs, live, submit, wait_job
    with live(workers=1, timeout_s=60.0) as c:
        j = submit(c, inputs(137.71, "sleep:3")).json()
        wait_job(c, j["id"], lambda b: b["status"] == "running")
        print("RUNNING", j["id"], flush=True)
        b = wait_job(c, j["id"], finished, timeout_s=60.0)
        print("FINAL", b["status"], b["error"], flush=True)
""")


def test_a_starting_runner_keeps_the_temp_dir_of_another_live_server(server_data):
    """H1-1: the job of another server process on the same data dir survives our start-up."""
    rd = results_dir(server_data)
    child = subprocess.Popen([sys.executable, "-c", CHILD], cwd=REPO, env=os.environ.copy(),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = child.stdout.readline()
        assert line.startswith("RUNNING"), (line, child.stderr.read() if child.poll() else "")
        jid = line.split()[1]
        tmp = rd / f"{jobs.TMP_PREFIX}{jid}"
        assert tmp.is_dir()
        start_and_stop(runner())  # our server starts (and stops) while the other job runs
        assert tmp.is_dir(), "the start-up cleanup removed a live job's temp dir"
        out, err = child.communicate(timeout=WAIT_S + 60)
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate()
    assert child.returncode == 0, err
    assert "FINAL done None" in out, (out, err)
    h = result_hash(inputs(137.71), IDENT)
    assert (rd / h / "run_record.json").is_file()
    assert not tmp.exists()  # its owner removed it when the job ended


def test_a_temp_dir_whose_owner_pid_is_dead_is_removed(server_data):
    rd = results_dir(server_data)
    owner = {**jobs.owner_record(TIMEOUT_S), "pid": dead_pid()}
    d = make_tmp(rd, "j_dead", owner)
    start_and_stop(runner())
    assert not d.exists()


@pytest.mark.skipif(not LINUX, reason="process start times come from /proc")
def test_a_temp_dir_whose_pid_was_reused_is_removed(server_data):
    rd = results_dir(server_data)
    o = jobs.owner_record(TIMEOUT_S)
    d = make_tmp(rd, "j_reused", {**o, "start_ticks": o["start_ticks"] + 1})
    start_and_stop(runner())
    assert not d.exists()


@pytest.mark.skipif(not LINUX, reason="boot ids come from /proc")
def test_a_temp_dir_from_before_a_reboot_is_removed(server_data):
    rd = results_dir(server_data)
    d = make_tmp(rd, "j_boot", {**jobs.owner_record(TIMEOUT_S), "boot_id": "not-this-boot"})
    start_and_stop(runner())
    assert not d.exists()


def test_a_temp_dir_older_than_twice_the_timeout_is_removed_even_if_its_pid_looks_alive(
        server_data):
    rd = results_dir(server_data)
    o = jobs.owner_record(TIMEOUT_S)
    assert jobs.owner_alive(o) is True  # this very process
    old = {**o, "created_unix": time.time() - 2 * TIMEOUT_S - 1}
    d = make_tmp(rd, "j_old_alive", old)
    keep = make_tmp(rd, "j_young_alive", {**o, "created_unix": time.time() - 2 * TIMEOUT_S + 5})
    start_and_stop(runner())
    assert not d.exists()
    assert keep.is_dir()  # alive and younger than 2 x timeout: never removed


def test_the_owner_job_timeout_counts_when_it_is_longer(server_data):
    """A server running with a longer job timeout keeps its dirs for 2 x its own timeout."""
    rd = results_dir(server_data)
    o = jobs.owner_record(10 * TIMEOUT_S)
    d = make_tmp(rd, "j_long", {**o, "created_unix": time.time() - 3 * TIMEOUT_S})
    start_and_stop(runner())
    assert d.is_dir()


def test_a_temp_dir_without_an_owner_file_is_kept_until_it_is_old(server_data):
    rd = results_dir(server_data)
    young = make_tmp(rd, "j_legacy_young", None)
    old = make_tmp(rd, "j_legacy_old", None)
    t = time.time() - 2 * TIMEOUT_S - 1
    os.utime(old, (t, t))
    bad = make_tmp(rd, "j_bad_owner", None)
    (bad / jobs.OWNER_FILE).write_text("not json", encoding="utf-8")
    start_and_stop(runner())
    assert young.is_dir() and bad.is_dir()
    assert not old.exists()


def test_an_owner_on_another_host_is_judged_by_age_only(server_data):
    rd = results_dir(server_data)
    o = {**jobs.owner_record(TIMEOUT_S), "hostname": "elsewhere", "pid": dead_pid()}
    assert jobs.owner_alive(o) is None  # cannot be checked from here
    young = make_tmp(rd, "j_other_young", o)
    old = make_tmp(rd, "j_other_old", {**o, "created_unix": time.time() - 2 * TIMEOUT_S - 1})
    ns = make_tmp(rd, "j_other_ns", {**jobs.owner_record(TIMEOUT_S), "pid_ns": "pid:[1]",
                                     "pid": dead_pid()})
    start_and_stop(runner())
    assert young.is_dir() and ns.is_dir()
    assert not old.exists()


def test_a_periodic_cleanup_keeps_the_runners_own_running_job(server_data):
    with live(workers=1, timeout_s=TIMEOUT_S) as c:
        j = submit(c, inputs(137.62, "sleep:1")).json()
        wait_job(c, j["id"], lambda b: b["status"] == "running")
        tmp = results_dir(server_data) / f"{jobs.TMP_PREFIX}{j['id']}"
        assert tmp.is_dir()
        assert c.runner.clean_stale() == []
        assert tmp.is_dir()
        assert wait_job(c, j["id"], finished)["status"] == "done"


def test_only_job_temp_dirs_are_considered(server_data):
    rd = results_dir(server_data)
    rd.mkdir(parents=True)
    t = time.time() - 100 * TIMEOUT_S
    other = rd / ".jobx"
    other.mkdir()
    link_target = rd / "target"
    link_target.mkdir()
    link = rd / f"{jobs.TMP_PREFIX}link"
    link.symlink_to(link_target, target_is_directory=True)
    for p in (other, link_target):
        os.utime(p, (t, t))
    start_and_stop(runner())
    assert other.is_dir() and link.is_symlink() and link_target.is_dir()


# -------------------------------------------------------------------------- lookup ----
def snapshot(r: jobs.JobRunner, rd: Path) -> tuple:
    files = sorted(p.relative_to(rd).as_posix() for p in rd.rglob("*")) if rd.is_dir() else []
    return (r.queue_length, r.jobs_started, sorted(r._jobs), dict(r._active), dict(r._done),
            files)


def test_lookup_answers_running_queued_done_or_none_and_changes_nothing(server_data):
    rd = results_dir(server_data)
    look = {}
    with live(workers=1, queue=2, timeout_s=TIMEOUT_S) as c:
        r = c.runner
        fast = submit(c, inputs(137.81)).json()
        assert wait_job(c, fast["id"], finished)["status"] == "done"
        run = submit(c, inputs(137.82, "sleep:2")).json()
        wait_job(c, run["id"], lambda b: b["stages_done"] == ["inputs"])  # then 2 s quiet
        queued = submit(c, inputs(137.83)).json()
        assert queued["status"] == "queued"
        official = result_hash(official_inputs(), IDENT)
        unknown = result_hash(inputs(137.84), IDENT)
        before = snapshot(r, rd)
        ident = lambda: IDENT  # noqa: E731
        for name, h in (("run", run["hash"]), ("queued", queued["hash"]),
                        ("fast", fast["hash"]), ("official", official), ("unknown", unknown),
                        ("not_a_hash", "zz")):
            look[name] = r.lookup(h, ident)
        assert snapshot(r, rd) == before  # no job, no reservation, no file
        assert look == {"run": "running", "queued": "queued", "fast": "done",
                        "official": "done", "unknown": None, "not_a_hash": None}
        for j in (run, queued):
            assert wait_job(c, j["id"], finished)["status"] == "done"
        assert r.lookup(run["hash"], ident) == "done"


def test_lookup_in_a_new_process_sees_the_tree_on_disk_without_making_a_job(server_data):
    doc = inputs(137.85)
    with live() as c:
        h = wait_job(c, submit(c, doc).json()["id"], finished)["hash"]
    partial = results_dir(server_data) / result_hash(inputs(137.86), IDENT)
    partial.mkdir(parents=True)
    (partial / "inputs.json").write_text("{}")  # a crash leftover: no run record
    r = runner()
    ident = lambda: IDENT  # noqa: E731
    assert r.lookup(h, ident) == "done"
    assert r.lookup(partial.name, ident) is None
    assert r._jobs == {} and r._done == {} and r.jobs_started == 0
    assert (partial / "inputs.json").is_file()


def test_lookup_without_an_identity_still_answers_for_cached_trees(server_data):
    with live() as c:
        h = wait_job(c, submit(c, inputs(137.87)).json()["id"], finished)["hash"]

    def unavailable():
        from server.engine import version
        raise version.Unavailable("no manifest")

    r = runner()
    assert r.lookup(h, unavailable) == "done"
    assert r.lookup(result_hash(inputs(137.88), IDENT), unavailable) is None


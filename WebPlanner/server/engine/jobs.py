"""Job runner (WS11 plan row 2.3, brief task 7; F23, F24 stages; backend spec §4.1).

One ``JobRunner`` lives inside the one uvicorn process. It owns ``compute.workers`` worker
processes (multiprocessing, start method "spawn", so no thread state of the server is forked) and
one supervisor thread. HTTP never waits on a job: ``submit`` answers at once (queued, attached or
done) and the client polls ``status`` (openapi createJob / getJob,
contracts/backend/job.schema.json).

Rules (every limit from config/backend.yaml ``compute``, read through server.settings):
- **De-duplication by result hash (D57).** A submit whose hash has a queued or running job attaches
  to it (``attached: true``). A hash whose result tree is complete (the precomputed official tree,
  or ``results/{hash}/run_record.json`` with status done) answers ``done`` at once without a run.
- **Queue cap.** At most ``queue_max_waiting`` jobs wait for a worker; past it the submit raises
  ``QueueFull`` with ``retry_after_s`` (route: 429 + Retry-After). backend.yaml has no retry key, so
  the value is derived, not chosen: the seconds until the running job closest to its
  ``job_timeout_s`` deadline must have freed its worker (``retry_after_s()``).
- **Timeout.** A job running longer than ``job_timeout_s`` is killed with its worker process
  (SIGKILL; a CPU-bound Numba search cannot be interrupted), the job reports ``timeout`` with an
  error, and a fresh worker takes the slot, so the next queued job runs.
- **Stages.** A job type declares its stage names; the handler calls ``ctx.stage(name)`` as each one
  finishes, in that order. The worker sends the event over its own pipe (one pipe per worker, so
  killing one worker cannot corrupt another's channel); GET shows ``stages_done``, ``stage``
  (the one now running) and ``progress``.
- **Result tree.** A job writes into a hidden temp dir ``results/.job-{id}/`` (hidden names are
  never served, E3). When a stage is done, the worker publishes that stage's new files into
  ``results/{hash}/``: a hard link under a hidden name, then a rename into place (atomic per file),
  so the files of finished stages are readable under ``result_url`` while the job runs
  (job.schema.json ``stages_done``) and a published file never moves again (a request in flight is
  never cut off). On success the worker writes ``run_record.json`` last (validated against
  run_record.schema.json); a tree is complete exactly when its run record says done. On error or
  timeout the supervisor removes the temp dir and the partial public tree.
- **Temp dir owner (H1-1).** Several server processes may share one $HL_SERVER_DATA (a demo
  server, a test server, a Docker stack). Each temp dir starts with ``.owner.json`` (pid, hostname,
  boot id, pid namespace, process start time, created_at, job timeout). A cleanup (at start-up,
  or any later periodic one: ``clean_stale_temp_dirs``) removes a temp dir only when its owner
  process is gone (pid not alive on this host, or reused: another start time or boot) or when it is
  older than 2 x the job timeout (the owner's or ours, the longer). It never removes the dir of a
  live owner younger than that. A dir without a readable owner file (a server from before this
  rule, or one created a moment ago) and an owner on another host or pid namespace are judged by
  age only.
- **Kill switch.** ``heavy_jobs_off()`` reads the ``deploy.kill_switch_env`` variable
  (HL_HEAVY_JOBS_OFF); ``set_heavy_jobs_off()`` flips it in-process (E8, O3). While it is on, new
  heavy jobs are refused (route: 503 heavy_jobs_off); attaching and cached results still answer.
- **Job types are pluggable.** ``register_job_type(name, JobType(run, stages))`` with a contract
  name (plan, siting, replan). ``run(inputs, ctx)`` must be a module-level function (it is pickled
  by reference into the spawned worker). This package ships only the test type
  (server.engine.testjobs, behind the ``HL_TEST_JOBS`` flag); the real ``plan`` type is E8.

Jobs live in memory for the life of the process (no database in the demo cut, D69); the result trees
on disk are what persists.
"""

from __future__ import annotations

import json
import logging
import math
import multiprocessing as mp
import os
import secrets
import shutil
import signal
import socket
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from multiprocessing import connection as mpc
from pathlib import Path
from typing import Any

from server.engine import results, version
from server.engine.hashing import EngineIdentity
from server.settings import BackendConfig, settings

log = logging.getLogger(__name__)

JOB_SCHEMA = results.BACKEND_CONTRACTS / "job.schema.json"
JOB_TYPE_NAMES: tuple[str, ...] = tuple(
    json.loads(JOB_SCHEMA.read_text(encoding="utf-8"))["properties"]["type"]["enum"])
TMP_PREFIX = ".job-"  # hidden: never served (server.engine.results.safe_parts)
OWNER_FILE = ".owner.json"  # in each temp dir, written first; hidden: never published
# A temp dir older than this many job timeouts cannot belong to a running job (a job is killed at
# its timeout), whatever its owner looks like (H1-1, pid reuse guard).
STALE_AFTER_TIMEOUTS = 2
TEST_JOBS_ENV = "HL_TEST_JOBS"  # test flag: register the shipped test job type as "plan"

# Process management (not product limits): how long to wait for a worker to exit after a stop
# message or a SIGKILL before giving up on it (it is a daemon process either way).
EXIT_JOIN_S = 5.0
# How often the supervisor re-checks the warm-up while waiting for it before starting the pool.
WARM_POLL_S = 0.05

QUEUED, RUNNING, DONE, ERROR, TIMEOUT = "queued", "running", "done", "error", "timeout"
FINISHED = (DONE, ERROR, TIMEOUT)


# ------------------------------------------------------------------------- kill switch ----
def heavy_jobs_off() -> bool:
    """True while the kill switch (config deploy.kill_switch_env) is set to a non-empty value."""
    return bool(os.environ.get(settings().deploy.kill_switch_env))


def set_heavy_jobs_off(off: bool) -> None:
    """Flip the kill switch in this process (same variable /health reports)."""
    name = settings().deploy.kill_switch_env
    if off:
        os.environ[name] = "1"
    else:
        os.environ.pop(name, None)


# --------------------------------------------------------------------------- job types ----
@dataclass(frozen=True)
class JobType:
    """A pluggable job: ``run(inputs, ctx) -> dict | None`` in a worker process.

    ``inputs`` are the canonical plan inputs (what was hashed) plus the title if any. ``run`` writes
    its files with ``ctx.write_bytes``/``ctx.write_json`` (or into ``ctx.out_dir``) and calls
    ``ctx.stage(name)`` after each of ``stages``, in order. It may return ``{"range_flags": [...],
    "route_mode": ..., "feasibility": {...}, "infeasible": {...}}`` for the run record (D97: without
    ``route_mode`` the record takes the inputs' route mode, auto when absent; ``feasibility`` is
    written only when returned). Raising reports the job as ``error``."""

    run: Callable[[dict, JobContext], dict | None]
    stages: tuple[str, ...]
    heavy: bool = True  # refused while the kill switch is on


JOB_TYPES: dict[str, JobType] = {}


def register_job_type(name: str, job_type: JobType) -> None:
    """Register ``job_type`` under a contract job type name (job.schema.json ``type``)."""
    if name not in JOB_TYPE_NAMES:
        raise ValueError(f"job type {name!r} is not one of {JOB_TYPE_NAMES}")
    JOB_TYPES[name] = job_type


def default_job_types() -> dict[str, JobType]:
    """The registered types, plus the test type as "plan" when $HL_TEST_JOBS is set (and no real
    plan type is registered)."""
    types = dict(JOB_TYPES)
    if os.environ.get(TEST_JOBS_ENV) and "plan" not in types:
        from server.engine.testjobs import TEST_JOB

        types["plan"] = TEST_JOB
    return types


# ------------------------------------------------------------------------ worker side ----
def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _listing(root: Path) -> set[str]:
    out = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if not name.startswith("."):
                out.add((Path(dirpath) / name).relative_to(root).as_posix())
    return out


def _publish_file(src: Path, dst: Path) -> None:
    """Make ``src`` readable at ``dst`` atomically: hard link to a hidden name, then rename."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.name}.publish")
    tmp.unlink(missing_ok=True)
    try:
        os.link(src, tmp)
    except OSError:  # no hard links on this filesystem: copy (the temp dir is in the same dir)
        shutil.copy2(src, tmp)
    os.replace(tmp, dst)


class JobContext:
    """What a job handler sees in the worker: its output dir and the stage reporter."""

    def __init__(self, conn, job_id: str, out_dir: Path, public_dir: Path,
                 stages: tuple[str, ...]):
        self._conn = conn
        self.job_id = job_id
        self.out_dir = out_dir  # hidden temp dir: write here
        self.public_dir = public_dir  # results/{hash}: finished stages are published here
        self.stages = stages
        self._published: dict[str, tuple[int, int]] = {}  # rel path -> (inode, mtime_ns)
        self.done: list[str] = []
        self.records: list[dict] = []
        self._seen: set[str] = set()
        self._t = time.monotonic()
        self._utc = utc_now()

    def path(self, rel: str) -> Path:
        """``out_dir / rel`` for a servable relative path (no hidden, absolute or '..' parts)."""
        return self.out_dir.joinpath(*results.safe_parts(rel))

    def write_bytes(self, rel: str, data: bytes) -> Path:
        """Write atomically: a hidden temp name in the same directory, then rename."""
        p = self.path(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f".{p.name}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)
        return p

    def write_json(self, rel: str, doc: Any) -> Path:
        return self.write_bytes(rel, (json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
                                .encode("utf-8"))

    def stage(self, name: str) -> None:
        """Report stage ``name`` as finished; its files must already be written."""
        i = len(self.done)
        if i >= len(self.stages) or self.stages[i] != name:
            nxt = self.stages[i] if i < len(self.stages) else None
            raise RuntimeError(f"stage {name!r} reported out of order (expected {nxt!r})")
        now, files = time.monotonic(), _listing(self.out_dir)
        self.publish()
        self.records.append({"name": name, "started_utc": self._utc,
                             "seconds": round(now - self._t, 3),
                             "files": sorted(files - self._seen)})
        self._seen, self._t, self._utc = files, now, utc_now()
        self.done.append(name)
        self._conn.send(("stage", self.job_id, name))

    def publish(self) -> None:
        """Publish every new or rewritten file of the temp dir into the public tree."""
        for rel in sorted(_listing(self.out_dir)):
            src = self.out_dir / rel
            st = src.stat()
            key = (st.st_ino, st.st_mtime_ns)
            if self._published.get(rel) != key:
                _publish_file(src, self.public_dir / rel)
                self._published[rel] = key


RUN_EXTRA_KEYS = {"range_flags", "route_mode", "feasibility", "infeasible"}


def _route_mode(inputs: dict) -> str:
    """D97 run_record.route_mode: inputs.route.mode, auto when the route is absent."""
    return (inputs.get("route") or {}).get("mode", "auto")


def _run_job(conn, job_id: str, run, inputs: dict, out_dir: str, public_dir: str, record: dict,
             stages: tuple[str, ...]) -> None:
    ctx = JobContext(conn, job_id, Path(out_dir), Path(public_dir), stages)
    started = utc_now()
    extra = run(inputs, ctx) or {}
    if ctx.done != list(stages):
        raise RuntimeError(f"job ended after stages {ctx.done}, declared {list(stages)}")
    if set(extra) - RUN_EXTRA_KEYS:
        raise RuntimeError(f"unknown run record keys {sorted(set(extra) - RUN_EXTRA_KEYS)}")
    doc = {**record, "status": DONE, "started_utc": started, "finished_utc": utc_now(),
           "stages": ctx.records, "files": results.tree_files(ctx.out_dir),
           "range_flags": extra.get("range_flags", []),
           "route_mode": extra.get("route_mode") or _route_mode(inputs),
           **({"feasibility": extra["feasibility"]} if extra.get("feasibility") else {}),
           "infeasible": extra.get("infeasible"), "error": None, "dummy": False}
    results.validate_run_record(doc)
    ctx.publish()  # files written after the last stage
    ctx.write_json(results.RUN_RECORD, doc)
    ctx.publish()  # last: a tree with a done run record is complete
    conn.send(("done", job_id))


def _worker_main(conn, initializer: Callable[[], object] | None) -> None:
    """Worker process loop: one job at a time, events back over ``conn``."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # Ctrl-C stops the server; it stops the pool
    if initializer is not None:
        initializer()  # e.g. E8: warm the Numba kernels, map the grids
    conn.send(("ready",))
    while True:
        try:
            msg = conn.recv()
        except (EOFError, OSError):  # the server is gone
            return
        if msg[0] == "stop":
            return
        _, job_id, run, inputs, out_dir, public_dir, record, stages = msg
        try:
            _run_job(conn, job_id, run, inputs, out_dir, public_dir, record, stages)
        except Exception as e:  # reported as the job's error; the worker stays
            log.exception("job %s failed", job_id)
            conn.send(("error", job_id, f"{type(e).__name__}: {e}"))


# ---------------------------------------------------------------- temp dir owner (H1-1) ----
def _read_text(path: str) -> str | None:
    try:
        with open(path, encoding="ascii", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return None


def _boot_id() -> str | None:
    return _read_text("/proc/sys/kernel/random/boot_id")


def _pid_ns() -> str | None:
    try:
        return os.readlink("/proc/self/ns/pid")
    except OSError:
        return None


def _proc_stat(pid: int) -> tuple[str, int] | None:
    """(state, start time in clock ticks since boot) of ``pid`` from /proc, or None."""
    stat = _read_text(f"/proc/{pid}/stat")
    if not stat:
        return None
    fields = stat[stat.rfind(")") + 2:].split()  # the command name may hold spaces or ')'
    try:
        return fields[0], int(fields[19])  # stat(5): field 3 state, field 22 starttime
    except (IndexError, ValueError):
        return None


def owner_record(job_timeout_s: float) -> dict:
    """The ``.owner.json`` of a temp dir created now by this process."""
    stat = _proc_stat(os.getpid())
    return {
        "pid": os.getpid(),
        "hostname": socket.gethostname(),
        "boot_id": _boot_id(),
        "pid_ns": _pid_ns(),
        "start_ticks": stat[1] if stat else None,
        "created_at": utc_now(),
        "created_unix": time.time(),
        "job_timeout_s": job_timeout_s,
    }


def owner_alive(owner: dict) -> bool | None:
    """Is the process that wrote ``owner`` still running? None: it cannot be checked from here
    (another host or pid namespace)."""
    if owner.get("hostname") != socket.gethostname() or owner.get("pid_ns") != _pid_ns():
        return None
    boot = owner.get("boot_id")
    if boot is not None and _boot_id() is not None and boot != _boot_id():
        return False  # written before a reboot
    pid = owner.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # alive, another user's
        pass
    except OSError:
        return None
    stat = _proc_stat(pid)
    if stat is not None:
        state, ticks = stat
        if state in ("Z", "X"):
            return False  # exited, not reaped yet
        if owner.get("start_ticks") is not None and owner["start_ticks"] != ticks:
            return False  # the pid was reused by another process
    return True


def write_owner(tmp: Path, job_timeout_s: float) -> None:
    """Write the owner file of a fresh temp dir (atomically: a reader sees all of it or none)."""
    part = tmp / f"{OWNER_FILE}.part"
    part.write_text(json.dumps(owner_record(job_timeout_s)) + "\n", encoding="utf-8")
    os.replace(part, tmp / OWNER_FILE)


def _read_owner(tmp: Path) -> dict | None:
    try:
        doc = json.loads((tmp / OWNER_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def temp_dir_stale(tmp: Path, job_timeout_s: float, now: float | None = None) -> bool:
    """True when the temp dir ``tmp`` cannot belong to a running job (see the module docstring):
    its owner is gone, or it is older than 2 x the job timeout (the owner's or ours, the longer)."""
    now = time.time() if now is None else now
    owner = _read_owner(tmp)
    limit = job_timeout_s
    created = None
    if owner is not None:
        limit = max(limit, _num(owner.get("job_timeout_s")) or 0.0)
        created = _num(owner.get("created_unix"))
        if owner_alive(owner) is False:
            return True
    if created is None:  # no readable owner: the dir's own time
        try:
            created = tmp.stat().st_mtime
        except OSError:
            return False  # gone already
    return now - created > STALE_AFTER_TIMEOUTS * limit


def clean_stale_temp_dirs(results_dir: Path, job_timeout_s: float,
                          now: float | None = None) -> list[Path]:
    """Remove the stale ``.job-*`` temp dirs of ``results_dir`` (start-up, or any periodic
    cleanup). A partial public tree (no done run record) stays until its hash is computed again
    (dispatch replaces it). Returns the removed dirs."""
    if not results_dir.is_dir():
        return []
    removed = []
    for p in sorted(results_dir.iterdir()):
        if not p.name.startswith(TMP_PREFIX) or p.is_symlink() or not p.is_dir():
            continue
        if temp_dir_stale(p, job_timeout_s, now):
            log.info("removing stale job temp dir %s", p)
            shutil.rmtree(p, ignore_errors=True)
            removed.append(p)
    return removed


# ------------------------------------------------------------------------ server side ----
class QueueFull(Exception):
    def __init__(self, retry_after_s: int, waiting: int):
        self.retry_after_s = retry_after_s
        super().__init__(f"{waiting} jobs are waiting (compute.queue_max_waiting); "
                         f"retry in {retry_after_s} s")


class HeavyJobsOff(Exception):
    pass


class UnknownJobType(LookupError):
    pass


def retry_after_s(remaining_s: list[float], job_timeout_s: float) -> int:
    """Seconds until a waiting slot must be free: the running job closest to its deadline is done
    or killed by then. With no running job (workers still starting) a full job timeout."""
    return max(0, math.ceil(min(remaining_s) if remaining_s else job_timeout_s))


@dataclass
class Job:
    id: str
    type: str
    hash: str
    stages: tuple[str, ...]
    inputs: dict | None = None  # dropped once dispatched
    record: dict | None = None
    status: str = QUEUED
    stages_done: list[str] = field(default_factory=list)
    result_url: str | None = None
    error: str | None = None
    attached: bool = False
    deadline: float | None = None
    tmp: Path | None = None

    def view(self, queue_position: int | None, attached: bool | None = None) -> dict:
        """The job.schema.json body."""
        n = len(self.stages)
        if self.status == DONE:
            progress = 1.0
        else:
            progress = len(self.stages_done) / n if n else 0.0
        running = self.status == RUNNING and len(self.stages_done) < n
        return {
            "id": self.id,
            "type": self.type,
            "hash": self.hash,
            "status": self.status,
            "stage": self.stages[len(self.stages_done)] if running else None,
            "progress": progress,
            "stages_done": list(self.stages_done),
            "queue_position": queue_position,
            "result_url": self.result_url,
            "attached": self.attached if attached is None else attached,
            "error": self.error,
            "retry_after_s": None,
        }


@dataclass
class _Slot:
    index: int
    proc: Any = None
    conn: Any = None
    ready: bool = False
    job: str | None = None
    started: bool = False  # sent "ready" at least once (a slot dying before that is not respawned)


def result_done(h: str, identity: Callable[[], EngineIdentity]) -> bool:
    """True when a complete result tree exists for ``h``: the precomputed official tree, or a cache
    folder whose run_record.json says done."""
    try:
        tree = results.resolve_tree(h, identity)
    except (results.ResultNotFound, version.Unavailable):
        return False
    if tree.precomputed:
        return True
    try:
        rec = json.loads((tree.root / results.RUN_RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(rec, dict) and rec.get("status") == DONE


class JobRunner:
    """The process pool, queue and job store of this server process (see the module docstring)."""

    def __init__(self, *, workers: int, queue_max_waiting: int, job_timeout_s: float,
                 result_url_prefix: str, job_types: dict[str, JobType] | None = None,
                 results_dir: Callable[[], Path] = results.cache_dir,
                 initializer: Callable[[], object] | None = None):
        types = default_job_types() if job_types is None else dict(job_types)
        bad = sorted(set(types) - set(JOB_TYPE_NAMES))
        if bad:
            raise ValueError(f"job types {bad} are not contract names {JOB_TYPE_NAMES}")
        if workers < 1 or queue_max_waiting < 0 or job_timeout_s <= 0:
            raise ValueError("workers >= 1, queue_max_waiting >= 0, job_timeout_s > 0")
        self.workers = workers
        self.queue_max_waiting = queue_max_waiting
        self.job_timeout_s = job_timeout_s
        self.job_types = types
        self._url = result_url_prefix
        self._results_dir = results_dir
        self._initializer = initializer
        self._ctx = mp.get_context("spawn")
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._active: dict[str, str] = {}  # hash -> queued/running job id
        self._done: dict[str, str] = {}  # hash -> done job id
        self._waiting: deque[str] = deque()
        self._slots: list[_Slot] = []
        self._thread: threading.Thread | None = None
        self._stopping = threading.Event()
        self._wake_r, self._wake_w = os.pipe()
        os.set_blocking(self._wake_w, False)
        self.jobs_started = 0

    @classmethod
    def from_config(cls, cfg: BackendConfig | None = None, **kw) -> JobRunner:
        cfg = cfg or settings()
        c = cfg.compute
        return cls(workers=c.workers, queue_max_waiting=c.queue_max_waiting,
                   job_timeout_s=c.job_timeout_s, result_url_prefix=f"{cfg.api.prefix}/results/",
                   **kw)

    # ------------------------------------------------------------------------ public ----
    @property
    def queue_length(self) -> int:
        """Jobs waiting for a worker (/health queue_length)."""
        with self._lock:
            return len(self._waiting)

    @property
    def initializer(self) -> Callable[[], object] | None:
        """What every worker runs before it reports ready (also a worker respawned after a
        timeout or a crash)."""
        return self._initializer

    def processes(self) -> list:
        with self._lock:
            return [s.proc for s in self._slots if s.proc is not None]

    def pids(self) -> list[int]:
        return [p.pid for p in self.processes()]

    def start(self, ready: Callable[[float], bool] | None = None) -> None:
        """Start the supervisor; it starts the workers once ``ready(timeout)`` (the engine warm-up)
        returns True. Jobs submitted before that wait in the queue."""
        with self._lock:
            if self._thread is not None:
                raise RuntimeError("JobRunner.start called twice")
            self.clean_stale()
            self._thread = threading.Thread(target=self._supervise, args=(ready,),
                                            name="job-supervisor", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        """Stop the workers (running jobs end as errors) and the supervisor."""
        self._stopping.set()
        self._wake()
        if self._thread is not None:
            self._thread.join()
        fds, self._wake_w = (self._wake_r, self._wake_w), -1  # a late submit must not write to a
        for fd in fds:                                       # reused descriptor number
            try:
                os.close(fd)
            except OSError:
                pass

    def submit(self, job_type: str, h: str, inputs: dict, record: dict,
               done: Callable[[], bool]) -> dict:
        """Queue a job for hash ``h`` or attach to the existing one; never waits for a worker.

        ``done()`` tells whether a complete result tree for ``h`` already exists."""
        with self._lock:
            jt = self.job_types.get(job_type)
            if jt is None:
                raise UnknownJobType(f"no handler for job type {job_type!r} on this server")
            jid = self._active.get(h)
            if jid is not None:
                return self._view(self._jobs[jid], attached=True)
            if done():
                job = self._jobs.get(self._done.get(h, ""))
                if job is None:  # a tree from an earlier process, or the precomputed tree
                    job = Job(self._new_id(), job_type, h, jt.stages, status=DONE,
                              stages_done=list(jt.stages), result_url=self._result_url(h),
                              attached=True)
                    self._jobs[job.id], self._done[h] = job, job.id
                return self._view(job, attached=True)
            if jt.heavy and heavy_jobs_off():
                raise HeavyJobsOff(f"{settings().deploy.kill_switch_env} is set")
            idle = sum(1 for s in self._slots if s.ready and s.job is None)
            if len(self._waiting) >= self.queue_max_waiting + idle:
                now = time.monotonic()
                remaining = [self._jobs[s.job].deadline - now for s in self._slots
                             if s.job is not None]
                raise QueueFull(retry_after_s(remaining, self.job_timeout_s), len(self._waiting))
            job = Job(self._new_id(), job_type, h, jt.stages, inputs=inputs, record=record)
            self._jobs[job.id], self._active[h] = job, job.id
            self._waiting.append(job.id)
            view = self._view(job)
        self._wake()
        return view

    def status(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return None if job is None else self._view(job)

    def lookup(self, h: str, identity: results.IdentityProvider = results.engine_identity
               ) -> str | None:
        """What a submit of hash ``h`` would find, read-only (O3b: attaches and cached results
        pass the per-IP limit): "running" or "queued" (a job of this runner), "done" (a complete
        result tree: the precomputed official tree, or a cache tree whose run record says done),
        or None (a submit would start a new job). No job is made, nothing is reserved or
        written."""
        with self._lock:
            jid = self._active.get(h)
            if jid is not None:
                return self._jobs[jid].status
        return DONE if result_done(h, identity) else None

    def clean_stale(self) -> list[Path]:
        """Remove the temp dirs no running job can own (start-up, or any periodic cleanup): owner
        gone, or older than 2 x job_timeout_s. Never the dir of a live owner (H1-1)."""
        return clean_stale_temp_dirs(self._results_dir(), self.job_timeout_s)

    # ----------------------------------------------------------------------- helpers ----
    def _new_id(self) -> str:
        while (jid := f"j_{secrets.token_hex(8)}") in self._jobs:
            pass
        return jid

    def _result_url(self, h: str) -> str:
        return f"{self._url}{h}/"

    def _view(self, job: Job, attached: bool | None = None) -> dict:
        pos = self._waiting.index(job.id) if job.status == QUEUED else None
        return job.view(pos, attached)

    def _wake(self) -> None:
        if self._wake_w < 0:
            return
        try:
            os.write(self._wake_w, b"x")
        except (BlockingIOError, OSError):  # already pending, or closed at shutdown
            pass

    # -------------------------------------------------------------------- supervisor ----
    def _supervise(self, ready: Callable[[float], bool] | None) -> None:
        try:
            while ready is not None and not self._stopping.is_set():
                if ready(WARM_POLL_S):
                    break
            if not self._stopping.is_set():
                with self._lock:
                    self._slots = [_Slot(i) for i in range(self.workers)]
                    for s in self._slots:
                        self._spawn(s)
            while not self._stopping.is_set():
                self._step()
        except Exception:
            log.exception("job supervisor crashed")
        finally:
            self._shutdown()

    def _spawn(self, slot: _Slot) -> None:
        parent, child = self._ctx.Pipe()
        proc = self._ctx.Process(target=_worker_main, args=(child, self._initializer),
                                 name=f"hl-job-worker-{slot.index}", daemon=True)
        proc.start()
        child.close()
        slot.proc, slot.conn, slot.ready, slot.job, slot.started = proc, parent, False, None, False

    def _step(self) -> None:
        with self._lock:
            self._dispatch()
            now = time.monotonic()
            deadlines = [self._jobs[s.job].deadline for s in self._slots if s.job is not None]
            timeout = max(0.0, min(deadlines) - now) if deadlines else None
            conns = [s.conn for s in self._slots if s.conn is not None]
        ready = mpc.wait([*conns, self._wake_r], timeout)
        with self._lock:
            if self._wake_r in ready:
                try:
                    os.read(self._wake_r, 4096)
                except OSError:
                    pass
            for s in self._slots:
                if s.conn is not None and s.conn in ready:
                    self._drain(s)
            self._check_deadlines()

    def _dispatch(self) -> None:
        for slot in self._slots:
            if not self._waiting:
                return
            if not slot.ready or slot.job is not None:
                continue
            job = self._jobs[self._waiting.popleft()]
            try:
                rd = self._results_dir()
                rd.mkdir(parents=True, exist_ok=True)
                self._remove_public(rd / job.hash)  # an incomplete leftover (done() said no)
                job.tmp = rd / f"{TMP_PREFIX}{job.id}"
                shutil.rmtree(job.tmp, ignore_errors=True)  # our own fresh id: never another's
                job.tmp.mkdir()
                write_owner(job.tmp, self.job_timeout_s)  # first, before any job file
                jt = self.job_types[job.type]
                slot.conn.send(("run", job.id, jt.run, job.inputs, str(job.tmp),
                                str(rd / job.hash), job.record, jt.stages))
            except Exception as e:
                self._finish(job, ERROR, f"could not start the job: {type(e).__name__}: {e}")
                continue
            job.inputs = job.record = None
            job.status, job.deadline = RUNNING, time.monotonic() + self.job_timeout_s
            slot.job = job.id
            self.jobs_started += 1

    def _drain(self, slot: _Slot) -> None:
        while slot.conn is not None:
            try:
                if not slot.conn.poll():
                    return
                msg = slot.conn.recv()
            except (EOFError, OSError):
                self._worker_died(slot)
                return
            self._event(slot, msg)

    def _event(self, slot: _Slot, msg: tuple) -> None:
        kind = msg[0]
        if kind == "ready":
            slot.ready = slot.started = True
            return
        job = self._jobs.get(msg[1])
        if job is None or slot.job != job.id or job.status != RUNNING:
            return  # a late event of a job that already ended
        if kind == "stage":  # the worker has published the stage's files under result_url
            job.result_url = self._result_url(job.hash)
            job.stages_done.append(msg[2])
        elif kind == "done":
            slot.job = None
            self._finish(job, DONE, None)
        elif kind == "error":
            slot.job = None
            self._finish(job, ERROR, msg[2])

    def _check_deadlines(self) -> None:
        now = time.monotonic()
        for slot in self._slots:
            if slot.job is None:
                continue
            job = self._jobs[slot.job]
            if now < job.deadline:
                continue
            self._kill(slot)
            self._finish(job, TIMEOUT, f"timed out after {self.job_timeout_s:g} s "
                                       "(config compute.job_timeout_s); the worker was recycled")
            self._spawn(slot)

    def _worker_died(self, slot: _Slot) -> None:
        code = slot.proc.exitcode if slot.proc is not None else None
        job = self._jobs.get(slot.job) if slot.job else None
        was_started = slot.started
        self._kill(slot)
        if job is not None:
            self._finish(job, ERROR, f"worker process exited unexpectedly (exit code {code})")
        if self._stopping.is_set():
            return
        if was_started:
            self._spawn(slot)
            return
        log.error("job worker %d died during start-up (exit code %s); slot left empty",
                  slot.index, code)
        if not any(s.proc is not None for s in self._slots):  # nothing will ever run them
            for jid in list(self._waiting):
                self._finish(self._jobs[jid], ERROR, "no job worker could start")

    def _kill(self, slot: _Slot) -> None:
        if slot.proc is not None and slot.proc.is_alive():
            slot.proc.kill()
        if slot.proc is not None:
            slot.proc.join(EXIT_JOIN_S)
        if slot.conn is not None:
            slot.conn.close()
        slot.proc, slot.conn, slot.ready, slot.job = None, None, False, None

    def _finish(self, job: Job, status: str, error: str | None) -> None:
        if job.id in self._waiting:
            self._waiting.remove(job.id)
        job.status, job.error, job.deadline = status, error, None
        job.inputs = job.record = None
        if self._active.get(job.hash) == job.id:
            del self._active[job.hash]
        if status == DONE:
            self._done[job.hash] = job.id
        elif job.tmp is not None:  # no partial tree is left
            self._remove_public(job.tmp.parent / job.hash)
        if job.tmp is not None:  # the published files are hard links: they stay
            shutil.rmtree(job.tmp, ignore_errors=True)
            job.tmp = None
        if status != DONE:
            job.result_url = None

    @staticmethod
    def _remove_public(p: Path) -> None:
        if p.is_symlink() or p.is_file():
            p.unlink()
        elif p.is_dir():
            shutil.rmtree(p, ignore_errors=True)

    def _shutdown(self) -> None:
        with self._lock:
            for s in self._slots:
                if s.conn is not None and s.ready and s.job is None:
                    try:
                        s.conn.send(("stop",))
                    except OSError:
                        pass
            for s in self._slots:
                job = self._jobs.get(s.job) if s.job else None
                if s.proc is not None and s.ready and s.job is None:
                    s.proc.join(EXIT_JOIN_S)
                self._kill(s)
                if job is not None:
                    self._finish(job, ERROR, "the server shut down")
            for jid in list(self._waiting):
                self._finish(self._jobs[jid], ERROR, "the server shut down")

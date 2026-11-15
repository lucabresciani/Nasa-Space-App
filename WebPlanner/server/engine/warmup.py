"""Numba warm-up of the real engine kernels (plan row 1.1, spec §4.1: "Numba compiled at start-up,
before /health reports warm").

The kernels are imported from pipeline/engine (never copied, WS11 rule 1). The warm-up runs one
return-field and one forward-field search on a tiny synthetic grid, which compiles the jitted
Dijkstra (``dijkstra._dijkstra`` with its heap helpers) for the argument types every real search
uses. With ``cache=True`` later starts load the compiled code from Numba's cache.

Three entry points (E8b):
- ``warm_engine()``: the Numba warm-up of the API process (E1).
- ``preload_server_data()``: the API start-up preload of the pad tool's server data (E6:
  ``server.engine.pads.preload``), so the first /pads request does not load them. Missing or
  incomplete server data are logged and skipped (the pad routes then answer 503 as before).
- ``worker_init()``: the job worker initializer (``JobRunner(initializer=...)``). Spawned workers do
  not inherit the parent's compiled kernels, so each worker runs the same warm-up, imports the plan
  job's engine modules and opens the server data grid memory maps once. Nothing in it may break the
  pool: every failure is logged and recorded in ``WORKER`` and the worker reports ready (a job then
  fails cleanly, as without the initializer). A worker respawned after a timeout runs it again.
"""

from __future__ import annotations

import importlib
import logging
import os
import threading
import time
from collections.abc import Callable

log = logging.getLogger("homeline.engine")

# A grid just big enough for every one of the 16 moves to have an in-grid neighbour. A warm-up
# shape, not a limit: the compiled code does not depend on the grid size.
WARMUP_CELLS = 7
WARMUP_VARIANT = "nominal"  # variants.yaml variant every precomputed scenario uses as "nom"
# The engine modules the plan job (server.engine.plan_job) imports when it runs.
PLAN_JOB_IMPORTS = ("pipeline.engine.plan", "pipeline.engine.scenarios", "pipeline.engine.graph",
                    "pipeline.engine.physio", "pipeline.provenance", "tools.make_web")


def warm_engine() -> None:
    """Compile the engine's Numba kernels with one tiny search in each direction."""
    from pipeline.engine import dijkstra, physio, synthetic

    grid = synthetic.make_grid(synthetic.plane(n=WARMUP_CELLS))
    table = physio.grade_table(physio.params(WARMUP_VARIANT))
    mid = (WARMUP_CELLS // 2, WARMUP_CELLS // 2)
    dijkstra.return_field(grid, table, mid)
    dijkstra.forward_field(grid, table, mid)


def preload_server_data() -> None:
    """Load the pad tool's server data (memory maps + D21 siting blocks) once, at API start."""
    from server.engine import pads

    t0 = time.perf_counter()
    try:
        pads.preload()
    except pads.ServerDataMissing as e:  # no server data yet: the pad routes answer 503
        log.warning("pad tool preload skipped: %s", e)
        return
    except Exception:  # the pad routes report it per request; /health and the jobs stay up
        log.exception("pad tool preload failed")
        return
    log.info("pad tool server data preloaded in %.1f s", time.perf_counter() - t0)


# State of the job worker process this module runs in (set by worker_init; read by tests and by a
# job that wants the worker's grid maps).
WORKER: dict = {"initialized": False, "pid": None, "numba_warm": False, "grid": None,
                "errors": [], "seconds": None}


def worker_init() -> None:
    """Job worker initializer: Numba warm-up, plan job imports, server data grid maps (once)."""
    t0 = time.perf_counter()
    errors: list[str] = []
    WORKER.update(initialized=False, pid=os.getpid(), numba_warm=False, grid=None, errors=errors)
    try:
        warm_engine()
        WORKER["numba_warm"] = True
    except Exception as e:  # a job then compiles (or fails) by itself, as without the warm-up
        errors.append(f"warm_engine: {type(e).__name__}: {e}")
        log.exception("job worker %d: Numba warm-up failed", os.getpid())
    for name in PLAN_JOB_IMPORTS:
        try:
            importlib.import_module(name)
        except Exception as e:
            errors.append(f"import {name}: {type(e).__name__}: {e}")
            log.exception("job worker %d: import %s failed", os.getpid(), name)
    try:
        from server.engine import pads

        WORKER["grid"] = pads.open_grid()
    except Exception as e:  # missing server data: the job fails cleanly when it needs them
        errors.append(f"server data: {type(e).__name__}: {e}")
        log.warning("job worker %d: server data grid not opened: %s", os.getpid(), e)
    WORKER["seconds"] = time.perf_counter() - t0
    WORKER["initialized"] = True
    log.info("job worker %d initialized in %.1f s", os.getpid(), WORKER["seconds"])


class EngineState:
    """Warm-up status of this server process; the warm-up runs once, in a background thread."""

    def __init__(self, warmup: Callable[[], object] = warm_engine):
        self._warmup = warmup
        self._done = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self.warm = False
        self.error: str | None = None
        self.seconds: float | None = None

    @property
    def ok(self) -> bool:
        """False only when the warm-up failed (the server is up but cannot plan)."""
        return self.error is None

    def start(self) -> None:
        with self._lock:
            if self._thread is not None:
                return
            # daemon: a shutdown during the warm-up must not wait for the compiler
            self._thread = threading.Thread(target=self._run, name="engine-warmup", daemon=True)
            self._thread.start()

    def wait(self, timeout: float | None = None) -> bool:
        """Block until the warm-up has finished (or failed); True if it finished in time."""
        return self._done.wait(timeout)

    def _run(self) -> None:
        t0 = time.perf_counter()
        try:
            self._warmup()
        except Exception as e:  # reported by /health (ok: false), never swallowed silently
            self.error = f"{type(e).__name__}: {e}"
            log.exception("engine warm-up failed")
        else:
            self.warm = True
        finally:
            self.seconds = time.perf_counter() - t0
            if self.warm:
                log.info("engine warm after %.1f s", self.seconds)
            self._done.set()

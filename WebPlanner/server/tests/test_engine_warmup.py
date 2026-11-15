"""Engine warm-up (plan row 1.1, spec §4.1): the real warm-up compiles the engine's Numba kernels
(pipeline/engine/dijkstra.py) on a tiny synthetic grid, and the warm state follows it."""

import threading

import pytest

pytest.importorskip("numba")

from pipeline.engine import dijkstra  # noqa: E402
from server.engine.warmup import EngineState, warm_engine  # noqa: E402


def test_real_warm_up_compiles_the_engine_kernels():
    warm_engine()
    # the jitted Dijkstra of pipeline/engine (imported, not copied) has a compiled signature
    # (its heap helpers are compiled into it as callees)
    assert dijkstra._dijkstra.signatures


def test_engine_state_goes_warm_after_the_warm_up():
    release = threading.Event()
    s = EngineState(warmup=lambda: release.wait(5))
    assert not s.warm and s.error is None
    s.start()
    assert not s.warm
    release.set()
    assert s.wait(5)
    assert s.warm and s.ok and s.error is None and s.seconds is not None


def test_engine_state_records_a_failed_warm_up():
    def broken():
        raise RuntimeError("boom")

    s = EngineState(warmup=broken)
    s.start()
    s.wait(5)
    assert not s.warm and not s.ok
    assert "boom" in s.error


def test_engine_state_starts_once():
    calls = []
    s = EngineState(warmup=lambda: calls.append(1))
    s.start()
    s.start()
    s.wait(5)
    assert calls == [1]

"""API start-up preload of the pad tool's server data (E8b; E6 note: without it the first /pads
request loads them, ~4 s on the real grid).

Known answers (written before the preload):
- /health stays not warm (engine_warm false) until the warm-up AND the preload have finished, and
  the Health body keeps its contract shape (openapi.yaml Health, v1.1.0);
- after /health is warm, the first /pads/screen and /pads/validate load nothing: the server data
  loader (server.engine.pads._load, counted) ran exactly once, during the start-up;
- missing server data do not stop the start-up: /health turns warm and ok, the pad routes answer
  503 server_data_missing as before.
"""

from __future__ import annotations

import threading
import time

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402

from server.api.compute import identity_provider  # noqa: E402
from server.app import create_app  # noqa: E402
from server.engine import pads, version  # noqa: E402
from server.engine.hashing import official_inputs  # noqa: E402
from server.tests.test_app import assert_valid as assert_health  # noqa: E402
from server.tests.test_jobs import IDENT  # noqa: E402
from server.tests.test_pads import (  # noqa: E402
    PREFIX,
    inputs_at,
    screen,
    validate,
    world,  # noqa: F401  (module fixture: the synthetic $HL_SERVER_DATA)
)

WAIT_S = 30.0


def health(c) -> dict:
    body = c.get(f"{PREFIX}/health").json()
    assert_health(body, "/health")
    return body


def wait_warm(c) -> dict:
    t0 = time.monotonic()
    while not (b := health(c))["engine_warm"]:
        assert time.monotonic() - t0 < WAIT_S, b
        time.sleep(0.01)
    return b


@pytest.fixture
def loads(monkeypatch):
    """Count the pad tool's server data loads; start from an unloaded process."""
    calls = []
    real = pads._load

    def counted(root, key):
        calls.append(key)
        return real(root, key)

    monkeypatch.setattr(pads, "_load", counted)
    monkeypatch.setattr(pads, "_WORLD", None)
    return calls


def app_with(**kw):
    app = create_app(**kw)
    app.dependency_overrides[identity_provider] = lambda: (lambda: IDENT)
    return app


def test_health_is_not_warm_until_the_preload_has_finished(tmp_path, monkeypatch):
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(tmp_path))
    warmed, release = threading.Event(), threading.Event()
    order = []

    def preload():
        order.append("preload")
        assert release.wait(WAIT_S)

    def warm():
        order.append("warmup")
        warmed.set()

    with TestClient(app_with(warmup=warm, preload=preload)) as c:
        assert warmed.wait(WAIT_S)
        time.sleep(0.1)
        b = health(c)
        assert b["engine_warm"] is False and b["ok"] is True  # warm-up done, preload running
        release.set()
        assert wait_warm(c)["ok"] is True
    assert order == ["warmup", "preload"]


def test_the_first_pad_requests_after_warm_load_nothing(world, monkeypatch, loads):  # noqa: F811
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(world))
    with TestClient(app_with(warmup=lambda: None)) as c:  # default preload
        wait_warm(c)
        assert len(loads) == 1  # loaded during the start-up
        off = official_inputs()["pad"]
        t0 = time.perf_counter()
        body = screen(c, inputs_at({"lon": off["lon"], "lat": off["lat"]}))
        validate(c, {"lon": off["lon"], "lat": off["lat"]})
        assert time.perf_counter() - t0 < 2.0
        assert body["feasible_evas"] >= 0
        assert len(loads) == 1  # nothing loaded by the requests


def test_without_server_data_the_start_up_still_turns_warm(tmp_path, monkeypatch, loads):
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(tmp_path))
    with TestClient(app_with(warmup=lambda: None)) as c:
        b = wait_warm(c)
        assert b["ok"] is True
        assert loads == []  # nothing to load (no manifest)
        r = c.post(f"{PREFIX}/pads/validate", json={"lon": 137.4, "lat": -4.7})
        assert r.status_code == 503 and r.json()["error"] == "server_data_missing"


def test_a_broken_preload_is_logged_and_the_start_up_goes_on(tmp_path, monkeypatch, caplog):
    from server.engine import warmup

    monkeypatch.setenv(version.SERVER_DATA_ENV, str(tmp_path))

    def broken():
        raise RuntimeError("boom")

    monkeypatch.setattr(pads, "preload", broken)
    with caplog.at_level("ERROR", logger=warmup.log.name):
        warmup.preload_server_data()
    assert "boom" in caplog.text

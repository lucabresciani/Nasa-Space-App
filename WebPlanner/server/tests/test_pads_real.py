"""POST /pads/validate and /pads/screen on the REAL server data (~/hl-data/server, make serverdata);
skipped when it is absent (CI). Known answers from web/public/data (the batch's published tree):
- the official pad is valid, and the number of valid blocks equals the D21 screening's
  n_blocks_screened (pad.json);
- its screen equals the published D21 screening: feasible EVAs = scenarios/pads/index.json
  screen_count, reachable stations and their T_home = stations.json t_home_min of the D21 scenario;
- the published route's own order, timed on the preview's matrices, equals the published route
  time within config parity.preview_vs_full_rel (the leg times agree);
- brief KAT "preview route time equals the full plan within 1%": the preview's best route against
  the published route. FINDING E6-1 (xfail strict, the 1 % is not loosened): the preview has no
  route margin check, so it picks another route (see the test);
- E8's live custom pad (137.401783, -4.771407) is refused (disc_off_grid; FINDING E6-2); its
  computed route's own order, timed on the preview's matrices, equals its route time within 1 %;
- answers under 2 s after the warm-up.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402

from pipeline.engine import orienteering, padpick  # noqa: E402
from server.app import create_app  # noqa: E402
from server.engine import pads, version  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests.test_pads import assert_api  # noqa: E402

REAL = Path.home() / "hl-data" / "server"
PUBLISHED = Path(__file__).resolve().parents[2] / "web" / "public" / "data"
E8_PAD = {"lon": 137.401783, "lat": -4.771407}  # /tmp/hl-orch/notes/E8.md, real custom-pad job
E8_HASH = "b58468cde4501261"
PREFIX = settings().api.prefix
REL = settings().parity.preview_vs_full_rel

pytestmark = pytest.mark.skipif(not (REAL / version.SERVER_DATA_MANIFEST).is_file(),
                                reason=f"no real server data at {REAL} (make serverdata)")


def _json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def real(monkeypatch):
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(REAL))


@pytest.fixture(scope="module")
def official() -> dict:
    row = next(p for p in _json(PUBLISHED / "scenarios/pads/index.json")["pads"] if p["official"])
    return row


def route_of(path: Path) -> tuple[list[str], float]:
    """(station order, total minutes) of a route GeoJSON (traverse.write)."""
    legs = [f["properties"] for f in _json(path)["features"]]
    return [lg["to"] for lg in legs if lg["to"] != "pad"], float(legs[-1]["t_end_min"])


def same_order_min(pad: dict, order: list[str]) -> float:
    m = pads.matrices(pad["lon"], pad["lat"])
    t = orienteering.evaluate([m.ids.index(s) for s in order], m.dwell, m.t_from, m.t_to,
                              m.t_leg, m.budget_min)  # fmt: skip
    assert t is not None
    return float(t)


def inputs(pad: dict) -> dict:
    return {"contract_version": settings().contract_version,
            "pad": {"lon": pad["lon"], "lat": pad["lat"]}}


def test_official_pad_valid_and_valid_blocks_are_the_d21_set(official):
    chk = pads.check_pad(official["lon"], official["lat"])
    assert chk == {"valid": True, "reason": None, "nearest_valid": None}
    screening = _json(PUBLISHED / "pad.json")["d21"]["screening"]
    assert len(pads.world().valid_ids) == screening["n_blocks_screened"]


def test_official_screen_equals_the_published_screening(official):
    body = pads.screen(inputs(official))
    assert_api(body, "/pads/screen", 200)
    assert body["feasible_evas"] == official["feasible"]["screen_count"] == official[
        "screen_score"]
    scen = padpick.settings_from_config().scenario
    published = {s["id"]: s["t_home_min"].get(scen) for s in _json(PUBLISHED / "stations.json")}
    rows = {r["id"]: r for r in body["stations"]}
    assert set(rows) == set(published)
    assert {k for k, r in rows.items() if r["reachable"]} == {
        k for k, v in published.items() if v is not None}
    assert {k: r["t_home_min"] for k, r in rows.items()} == published


def test_published_route_order_times_agree_within_tolerance(official):
    scen = padpick.settings_from_config().scenario
    order, total = route_of(PUBLISHED / f"route_{scen}.geojson")
    assert order == official["route"]["stops"] and total == official["route"]["total_min"]
    assert same_order_min(official, order) == pytest.approx(total, rel=REL)


@pytest.mark.xfail(strict=True, reason=(
    "FINDING E6-1: the preview's best route has no route margin check (it needs the leg paths, "
    "not in the server data); on the official pad it picks S2,S8,S6,S1 = 381.37 min against the "
    "full plan's S7,S6,S1,S4 = 325.94 min (+17.0 %). The leg times agree (previous test). "
    "Open for N/S; the 1 % is not loosened."))
def test_preview_route_time_equals_the_full_plan_within_1pct(official):
    best = pads.screen(inputs(official))["best_route"]
    assert best is not None
    assert best["total_min"] == pytest.approx(official["route"]["total_min"], rel=REL)


def test_e8_custom_pad_is_refused_disc_off_grid():
    """FINDING E6-2: E8's real custom-pad job ran on a pad whose flat 30-min disc leaves the
    grid (it is 360 m north of the official pad, 38 cells short of the north edge)."""
    chk = pads.check_pad(E8_PAD["lon"], E8_PAD["lat"])
    assert chk["valid"] is False and chk["reason"] == "disc_off_grid"
    assert chk["nearest_valid"]["distance_m"] > 0
    assert pads.check_pad(chk["nearest_valid"]["lon"], chk["nearest_valid"]["lat"])["valid"]


def test_e8_custom_route_order_times_agree_within_tolerance():
    tree = REAL / "results" / E8_HASH
    if not (tree / "run_record.json").is_file():
        pytest.skip(f"E8's custom-pad result {E8_HASH} is not in the cache")
    assert _json(tree / "run_record.json")["inputs"]["pad"] == E8_PAD
    order, total = route_of(tree / "route_nom_104.geojson")
    assert same_order_min(E8_PAD, order) == pytest.approx(total, rel=REL)


def test_answers_under_2s_after_warm_up(official):
    pad = {"lon": official["lon"], "lat": official["lat"]}
    with TestClient(create_app(warmup=lambda: None)) as c:
        assert c.post(f"{PREFIX}/pads/validate", json=pad).status_code == 200  # warm-up
        t0 = time.perf_counter()
        r1 = c.post(f"{PREFIX}/pads/validate", json=E8_PAD)
        r2 = c.post(f"{PREFIX}/pads/screen", json=inputs(pad))
        dt = time.perf_counter() - t0
    assert r1.status_code == 200 and r2.status_code == 200
    assert_api(r1.json(), "/pads/validate", 200)
    assert_api(r2.json(), "/pads/screen", 200)
    assert dt < 2.0

"""Known-answer tests for the access-cell rule (user decision 2026-11-14 11:40).

A station keeps its science coordinate. Routing and T_home use the nearest walkable cell
(cell state assessed and reachable in the scenario) within variants.yaml route.access_radius_m.
The walk-in leg from the access cell to the science point is not modelled; its straight-line
distance and slope are reported. Synthetic grids only (fixtures, not data).
"""

import math

import numpy as np
import pytest

from pipeline.engine import access, dijkstra, physio, provenance, stations
from pipeline.engine.config import load
from pipeline.engine.geo import lonlat_of_xy, validate
from pipeline.engine.graph import ASSESSED, BLOCKED, Grid
from pipeline.engine.synthetic import make_grid

RES = 3.0
N = 121
C0 = N // 2  # station cell (row and col)


@pytest.fixture(autouse=True)
def manifest_dir(tmp_path, monkeypatch):
    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "manifest"))


def _world(blocked: np.ndarray, grade_east: float = 0.1) -> Grid:
    """Plane rising east by `grade_east`; `blocked` cells get state 1 and a 35 deg max slope."""
    cols = np.arange(N, dtype=np.float64)[None, :] * np.ones((N, 1))
    elev = grade_east * RES * cols
    maxslope = np.full((N, N), math.degrees(math.atan(grade_east)))
    state = np.full((N, N), ASSESSED, np.uint8)
    state[blocked] = BLOCKED
    maxslope[blocked] = 35.0
    return make_grid(elev, RES, cellstate=state, maxslope=maxslope)


def _field(g: Grid, pad):
    p = physio.scenario_params("nom_104")
    return dijkstra.return_field(g, physio.grade_table(p), pad)


def _station(g: Grid, r=C0, c=C0, sid="S1"):
    lon, lat = lonlat_of_xy(*g.xy_of_rc(r, c), g.crs)
    return {"id": sid, "name": "t", "lon": float(lon), "lat": float(lat), "value": 0.5,
            "dwell_min": 30}  # fmt: skip


def test_radius_from_config():
    r = load("variants")["route"]
    assert access.radius_m() == r["access_radius_m"] == 50


def test_station_on_wall_gets_walkable_cell_at_30_m():
    """Wall: every cell west of col C0 + 10 within 60 m blocked; station at its centre.
    Nearest walkable cell = (C0, C0 + 10), exactly 30 m east."""
    r, c = np.indices((N, N))
    blocked = (np.hypot(r - C0, c - C0) * RES <= 60.0) & (c < C0 + 10)
    g = _world(blocked)
    pad = (C0, N - 5)
    f = _field(g, pad)
    s = _station(g)
    a = access.find(g, f, s["lon"], s["lat"], 50.0)
    assert a.rc == (C0, C0 + 10)
    assert a.dist_m == pytest.approx(30.0, abs=1e-6)
    assert a.reason is None
    assert a.t_home_min == pytest.approx(float(f.t_min[C0, C0 + 10]))
    assert a.o2_home_L == pytest.approx(float(f.o2_l[C0, C0 + 10]))
    lon, lat = lonlat_of_xy(*g.xy_of_rc(C0, C0 + 10), g.crs)
    assert (a.lon, a.lat) == pytest.approx((lon, lat), abs=1e-9)
    # walk-in leg: 30 m west, 10 % plane -> 3 m down to the science point
    w = a.walk_in
    assert w["dist_m"] == pytest.approx(30.0, abs=1e-6)
    assert w["rise_m"] == pytest.approx(-3.0, abs=1e-6)
    assert w["mean_slope_deg"] == pytest.approx(math.degrees(math.atan(0.1)), abs=1e-3)
    assert w["max_slope_deg"] == pytest.approx(math.degrees(math.atan(0.1)), abs=1e-3)
    assert w["max_terrain_slope_deg"] == pytest.approx(35.0)
    assert w["modelled"] is False


def test_nearest_not_first_found():
    """Two walkable pockets connected to the pad: one at 45 m north, one at 36 m south;
    the 36 m one wins."""
    r, c = np.indices((N, N))
    blocked = np.hypot(r - C0, c - C0) * RES <= 70.0
    blocked[: C0 - 15 + 1, C0] = False  # corridor from 45 m north to the edge
    blocked[C0 + 12 :, C0] = False  # corridor from 36 m south to the edge
    g = _world(blocked, grade_east=0.0)
    f = _field(g, (N - 1, C0))
    # both corridors reach the open ring outside the disc, so both pockets are reachable
    a = access.find(g, f, *_lonlat(g, C0, C0), 50.0)
    assert a.rc == (C0 + 12, C0) and a.dist_m == pytest.approx(36.0)


def _lonlat(g, r, c):
    return lonlat_of_xy(*g.xy_of_rc(r, c), g.crs)


def test_none_within_radius_gives_null_and_reason():
    r, c = np.indices((N, N))
    blocked = np.hypot(r - C0, c - C0) * RES <= 60.0
    g = _world(blocked)
    f = _field(g, (C0, N - 5))
    a = access.find(g, f, *_lonlat(g, C0, C0), 50.0)
    assert a.rc is None and a.lon is None and a.lat is None
    assert a.dist_m is None and a.t_home_min is None and a.walk_in is None
    assert "no assessed cell" in a.reason and "50 m" in a.reason


def test_assessed_but_unreachable_gives_null_and_reason():
    """An assessed pocket 30 m away, sealed off by blocked cells: assessed, not reachable."""
    r, c = np.indices((N, N))
    d = np.hypot(r - C0, c - C0) * RES
    blocked = d <= 60.0
    pocket = (np.abs(r - C0) <= 1) & (np.abs(c - (C0 + 10)) <= 1)
    blocked &= ~pocket
    g = _world(blocked)
    f = _field(g, (C0, N - 5))
    assert not np.isfinite(f.t_min[C0, C0 + 10])
    a = access.find(g, f, *_lonlat(g, C0, C0), 50.0)
    assert a.rc is None
    assert "none with a walk home" in a.reason


def test_station_on_walkable_cell_is_its_own_access():
    g = _world(np.zeros((N, N), bool))
    f = _field(g, (C0, N - 5))
    s = _station(g)
    s["lon"] += 1e-6  # off the cell centre: access is still the science point itself
    a = access.find(g, f, s["lon"], s["lat"], 50.0)
    assert a.rc == (C0, C0)
    assert (a.lon, a.lat) == (s["lon"], s["lat"])
    assert a.dist_m == 0.0
    assert a.t_home_min == pytest.approx(float(f.t_min[C0, C0]))
    assert a.walk_in["dist_m"] == 0.0 and a.walk_in["mean_slope_deg"] is None


def test_station_records_carry_access_and_validate():
    """stations.json: lon/lat stay the science point; t_home_min is at the access cell;
    per-scenario access block and default-scenario access_* fields; contract-valid."""
    r, c = np.indices((N, N))
    blocked = (np.hypot(r - C0, c - C0) * RES <= 60.0) & (c < C0 + 10)
    g = _world(blocked)
    f = _field(g, (C0, N - 5))
    s1 = _station(g)
    s2 = _station(g, C0, N - 20, sid="S2")
    st = [s1, s2]
    stations.attach_cells(g, st)
    fields = {"nom_104": f}
    access.resolve(g, fields, st, 50.0)
    recs = stations.station_records(st, fields, None, 60, default="nom_104")
    validate(recs, "stations.schema.json")
    r1 = recs[0]
    assert (r1["lon"], r1["lat"]) == (round(s1["lon"], 6), round(s1["lat"], 6))
    assert r1["t_home_min"]["nom_104"] == pytest.approx(float(f.t_min[C0, C0 + 10]), abs=0.01)
    assert r1["access_dist_m"] == pytest.approx(30.0)
    assert r1["access"]["nom_104"]["dist_m"] == pytest.approx(30.0)
    assert r1["access_radius_m"] == 50.0
    assert recs[1]["access_dist_m"] == 0.0
    assert (recs[1]["access_lon"], recs[1]["access_lat"]) == (recs[1]["lon"], recs[1]["lat"])


# ------------------------------------------------------------------ card timeline fragments


def test_card_fragments_match_timeline(tmp_path):
    """cards/{S}.timeline.json (C decision 11:42): arrive/leave/turn_back are the timeline's
    rows for that station; margin_binding is the binding term at the station's lowest margin;
    contingency names the haul time from the access cell; stations without an access cell get
    nulls and the reason."""
    from pipeline.engine import cards, margin, traverse

    r, c = np.indices((N, N))
    blocked = (np.hypot(r - C0, c - C0) * RES <= 60.0) & (c < C0 + 10)
    blocked |= np.hypot(r - 20, c - 20) * RES <= 70.0  # S3 sealed in: no access cell
    g = _world(blocked, grade_east=0.02)
    pad = (C0, N - 5)
    f = _field(g, pad)
    st = [_station(g), _station(g, C0 - 30, C0 + 30, sid="S2"), _station(g, 20, 20, sid="S3")]
    stations.attach_cells(g, st)
    access.resolve(g, {"nom_104": f}, st, 50.0)
    rst, none = access.routing_stations(st, "nom_104")
    assert [s["id"] for s in rst] == ["S1", "S2"] and "S3" in none
    p = physio.scenario_params("nom_104")
    mi = margin.inputs(p, 600.0, 400.0)
    res = traverse.plan(g, physio.grade_table(p), f, pad, rst, 390.0, 30.0, mi)
    assert sorted(res.order) == ["S1", "S2"]
    # timeline and route carry the walk-in distance (not modelled)
    arr = {e["station"]: e for e in res.timeline if e["event"] == "arrive"}
    assert arr["S1"]["access_dist_m"] == pytest.approx(30.0)
    assert arr["S2"]["access_dist_m"] == 0.0
    leg = next(lg for lg in res.legs if lg["to"] == "S1")
    assert leg["to_access_dist_m"] == pytest.approx(30.0)
    haul_t = np.full(g.shape, 42.0)  # stand-in haul field: 42 min everywhere
    frags = cards.fragments(st, res, "nom_104", haul_t, 179.0, "cart", 60.0, 50.0)
    assert set(frags) == {"S1", "S2", "S3"}
    for sid in ("S1", "S2"):
        fr = frags[sid]
        rows = [e for e in res.timeline if e["station"] == sid]
        ev = {e["event"]: e["t_min"] for e in rows}
        assert fr["timeline"] == {"arrive": ev["arrive"], "leave": ev["leave"],
                                  "turn_back": ev["turn_back"]}  # fmt: skip
        low = min((e for e in rows if e["event"] in ("arrive", "leave")),
                  key=lambda e: e["margin_min"])  # fmt: skip
        assert fr["margin_binding"] == low["margin_binding"] in ("O2", "daylight", "dose")
        assert fr["margin_min"] == low["margin_min"]
        assert "42 min" in fr["contingency"]
        assert fr["on_route"] is True
    assert frags["S1"]["access"]["dist_m"] == pytest.approx(30.0)
    s3 = frags["S3"]
    assert s3["timeline"] == {"arrive": None, "leave": None, "turn_back": None}
    assert s3["margin_binding"] is None and s3["on_route"] is False
    assert "no assessed cell" in s3["access"]["reason"]
    cards.write(frags, tmp_path)
    assert (tmp_path / "cards" / "S1.timeline.json").exists()

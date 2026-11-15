"""WP2a KATs (D97 waypoint block): free-point validity, free-point fields and stop spacing
(pipeline/engine/waypoints.py). Synthetic world (docs/dummy.md, fixtures, not data) plus one
real-grid check that runs only when data/interim is present (run it under the heavy lock)."""

import math
import time
from pathlib import Path

import numpy as np
import pytest

from pipeline.engine import padpick, physio, waypoints
from pipeline.engine.geo import lonlat_of_xy
from pipeline.engine.graph import BLOCKED, UNKNOWN
from pipeline.engine.stations import bearing_dist
from pipeline.engine.synthetic import dummy_world

SID = "nom_104"
RADIUS = 50.0  # variants.yaml route.access_radius_m (D27)
CODES = {"route_point_outside_grid", "route_point_unassessed", "route_point_not_walkable",
         "route_point_unreachable"}  # fmt: skip


def _settings() -> padpick.Settings:
    s = padpick.settings_from_config()
    assert s.access_radius_m == RADIUS
    return s


def _ll(g, rc) -> tuple[float, float]:
    lon, lat = lonlat_of_xy(*g.xy_of_rc(*rc), g.crs)
    return float(lon), float(lat)


def _ring(g, center, inner, outer):
    """Blocked ring around ``center`` (cells): the assessed cells inside form a sealed pocket."""
    rr, cc = np.mgrid[0 : g.shape[0], 0 : g.shape[1]]
    d = np.hypot(rr - center[0], cc - center[1])
    ring = (d >= inner) & (d < outer)
    g.cellstate[ring] = BLOCKED
    g.maxslope[ring] = 60.0


def _disc(g, center, radius_cells):
    rr, cc = np.mgrid[0 : g.shape[0], 0 : g.shape[1]]
    return np.hypot(rr - center[0], cc - center[1]) <= radius_cells


# Fixture geometry (dummy_world(3.0, half_m=700): 467 x 467 cells, pad at the centre).
POCKET = (150, 190)  # small sealed pocket (ring 3-4.5 cells): its science cell is skipped
POCKET_SCI = (150, 191)
POCKET_OUT = (150, 195)  # nearest cell outside the ring (12 m east)
SEALED = (380, 80)  # sealed pocket wider than the access radius (ring 18-20 cells = 54-60 m)
CLIFF = (100, 120)  # 70 m disc of known terrain, all blocked and steep
MID = (60, 330)  # 70 m disc of assessed cells at 18.5 deg: nominal ok (20), conservative not (17)
HOLE = (351, 351)  # docs/dummy.md nodata hole (r 80 m) centre: unknown terrain within 50 m
OPEN = ((60, 60), (300, 120), (233, 233), (400, 100))  # open terrain


@pytest.fixture(scope="module")
def world():
    g, pad, _ = dummy_world(3.0, half_m=700.0)
    g.cellstate = g.cellstate.copy()
    g.maxslope = g.maxslope.copy()
    _ring(g, POCKET, 3.0, 4.5)
    _ring(g, SEALED, 18.0, 20.0)
    cliff = _disc(g, CLIFF, 70.0 / 3.0)
    g.cellstate[cliff] = BLOCKED
    g.maxslope[cliff] = 40.0
    mid = _disc(g, MID, 70.0 / 3.0)
    g.maxslope[mid] = 18.5
    assert g.cellstate[HOLE] == UNKNOWN
    p = physio.scenario_params(SID)
    return g, g.with_nogo(p.nogo_deg), physio.grade_table(p), pad


# ------------------------------------------------------------------ a point on a station


@pytest.mark.parametrize("rc", [OPEN[0], OPEN[1], POCKET_SCI])
def test_point_on_a_station_equals_station_fields(world, rc):
    """A free point exactly on a station's lon/lat: same access cell as station_cell and
    byte-identical fields as station_fields (also bounded), the sealed pocket skipped alike."""
    g, gv, tab, _ = world
    lon, lat = _ll(g, rc)
    st = {"id": "S9", "lon": lon, "lat": lat}
    s = _settings()
    v = waypoints.point_validity(g, lon, lat, scenario=SID, settings=s)
    cell = padpick.station_cell(gv, st, RADIUS, tab)
    assert v["ok"] and v["code"] is None
    assert v["access_cell"] == cell[1:] and v["access_dist_m"] == cell[0]
    if rc == POCKET_SCI:
        assert v["access_cell"] == POCKET_OUT and v["access_dist_m"] == pytest.approx(12.0)
    else:
        assert v["access_cell"] == rc and v["access_dist_m"] == 0.0
    fwd, rev = waypoints.point_fields(g, lon, lat, SID, s)
    ref_f, ref_r = padpick.station_fields(g, st, SID, s)
    for a, b in ((fwd, ref_f), (rev, ref_r)):
        for k in ("t_min", "o2_l", "ptr"):
            x, y = getattr(a, k), getattr(b, k)
            assert x.dtype == y.dtype and x.tobytes() == y.tobytes(), k
        assert a.reverse == b.reverse and a.seeds.tolist() == b.seeds.tolist()
    assert fwd.t_min[v["access_cell"]] == 0 and rev.t_min[v["access_cell"]] == 0
    bf, br = waypoints.point_fields(g, lon, lat, SID, s, tmax_min=5.0)
    rf, rr = padpick.station_fields(g, st, SID, s, tmax_min=5.0)
    assert bf.t_min.tobytes() == rf.t_min.tobytes() and br.t_min.tobytes() == rr.t_min.tobytes()


def test_default_scenario_and_settings_from_config(world):
    """scenario=None = the D21 scenario (variants.yaml d21.scenario), settings from config."""
    g, _, _, _ = world
    lon, lat = _ll(g, OPEN[2])
    assert waypoints.point_validity(g, lon, lat) == waypoints.point_validity(
        g, lon, lat, scenario=_settings().scenario, settings=_settings())


# ------------------------------------------------------------------ one KAT per code


def _invalid(g, lon, lat, code, scenario=SID):
    v = waypoints.point_validity(g, lon, lat, scenario=scenario, settings=_settings())
    assert v == {"ok": False, "code": code, "access_cell": None, "access_dist_m": None}
    with pytest.raises(waypoints.PointError) as e:
        waypoints.point_fields(g, lon, lat, scenario, _settings())
    assert e.value.code == code and isinstance(e.value, ValueError)
    assert e.value.index is None and code in str(e.value)


def test_outside_grid(world):
    g, _, _, _ = world
    # 10 m west of the grid's west edge: within 50 m of grid cells, but the point's own cell is
    # not in the grid (the pad rule, server/engine/pads.py outside_grid)
    for x, y in ((g.x0 - 10.0, g.y0 - 300.0), (g.x0 - 5000.0, g.y0 + 5000.0)):
        lon, lat = lonlat_of_xy(x, y, g.crs)
        _invalid(g, float(lon), float(lat), "route_point_outside_grid")
    _invalid(g, float("nan"), 0.0, "route_point_outside_grid")


def test_unassessed(world):
    """Inside the nodata hole (r 80 m): every cell within 50 m is unknown terrain."""
    g, _, _, _ = world
    _invalid(g, *_ll(g, HOLE), "route_point_unassessed")


def test_unassessed_needs_no_known_cell_in_the_radius(world):
    """45 m inside the hole edge: known cells within 50 m, so the point is valid."""
    g, _, _, _ = world
    rc = (HOLE[0], HOLE[1] - int((80.0 - 45.0) / 3.0))
    assert g.cellstate[rc] == UNKNOWN
    v = waypoints.point_validity(g, *_ll(g, rc), scenario=SID, settings=_settings())
    assert v["ok"] and 0 < v["access_dist_m"] <= RADIUS


def test_not_walkable_blocked_terrain(world):
    """Known terrain (blocked, 40 deg) everywhere within 50 m: too steep, not unassessed."""
    g, _, _, _ = world
    _invalid(g, *_ll(g, CLIFF), "route_point_not_walkable")


def test_not_walkable_depends_on_the_scenario(world):
    """Assessed cells at 18.5 deg: walkable at the nominal no-go (20 deg), not at the
    conservative one (17 deg, D23); the error carries the code for that scenario only."""
    g, _, _, _ = world
    lon, lat = _ll(g, MID)
    v = waypoints.point_validity(g, lon, lat, scenario=SID, settings=_settings())
    assert v["ok"] and v["access_cell"] == MID
    _invalid(g, lon, lat, "route_point_not_walkable", scenario="con_104")
    p = physio.scenario_params("con_104")  # physio.Params is accepted as the scenario, too
    assert waypoints.point_validity(g, lon, lat, scenario=p)["code"] == "route_point_not_walkable"


def test_unreachable_sealed_pocket(world):
    """Every assessed cell within 50 m is in a sealed pocket: no walk to the main terrain."""
    g, gv, tab, _ = world
    lon, lat = _ll(g, SEALED)
    assert gv.passable[SEALED]
    assert padpick.station_cell(gv, {"id": "W?", "lon": lon, "lat": lat}, RADIUS, tab) is None
    _invalid(g, lon, lat, "route_point_unreachable")


def test_codes_are_the_contract_codes():
    api = Path(__file__).resolve().parents[3] / "contracts" / "backend" / "openapi.yaml"
    text = api.read_text(encoding="utf-8")
    assert set(waypoints.POINT_CODES) == CODES
    assert all(c in text for c in CODES)


# ------------------------------------------------------------------ spacing


def _lonlat_at(g, pad_rc, dx, dy):
    x, y = g.xy_of_rc(*pad_rc)
    lon, lat = lonlat_of_xy(x + dx, y + dy, g.crs)
    return float(lon), float(lat)


def test_spacing_pairs_including_the_pad(world):
    g, pad = world[0], world[3]
    pts = [_lonlat_at(g, pad, 30.0, 0.0),  # 0: 30 m from the pad
           _lonlat_at(g, pad, 200.0, 0.0),  # 1
           _lonlat_at(g, pad, 200.0, 20.0),  # 2: 20 m from 1
           _lonlat_at(g, pad, -300.0, 0.0),  # 3: alone
           _lonlat_at(g, pad, 200.0, 45.0)]  # 4: 45 m from 1, 25 m from 2
    pad_ll = _lonlat_at(g, pad, 0.0, 0.0)
    assert waypoints.stop_spacing_violations(pts, pad_ll, 50.0) == [(0, -1), (1, 2), (1, 4),
                                                                    (2, 4)]  # fmt: skip
    assert waypoints.stop_spacing_violations(pts, pad_ll, 10.0) == []
    assert waypoints.stop_spacing_violations(pts, None, 50.0) == [(1, 2), (1, 4), (2, 4)]
    assert waypoints.stop_spacing_violations([], pad_ll, 50.0) == []


def test_spacing_distance_is_the_engine_great_circle(world):
    """Distance = stations.bearing_dist (Mars sphere, site.yaml crs.mars_radius_m); closer than
    min_m is a violation, exactly min_m is not."""
    g, pad = world[0], world[3]
    a, b = _lonlat_at(g, pad, 100.0, 0.0), _lonlat_at(g, pad, 100.0, 50.0)
    d = bearing_dist(*a, *b)[1]
    assert d == pytest.approx(50.0, abs=0.05)
    assert waypoints.stop_spacing_violations([a, b], None, d) == []
    assert waypoints.stop_spacing_violations([a, b], None, math.nextafter(d, math.inf)) == [(0, 1)]
    assert waypoints.stop_spacing_violations([a, a], None, 50.0) == [(0, 1)]  # same point


# ------------------------------------------------------------------ determinism


def test_deterministic(world):
    g, _, _, _ = world
    s = _settings()
    for rc in (OPEN[1], POCKET_SCI):
        lon, lat = _ll(g, rc)
        assert (waypoints.point_validity(g, lon, lat, scenario=SID, settings=s)
                == waypoints.point_validity(g, lon, lat, scenario=SID, settings=s))  # fmt: skip
        f1, r1 = waypoints.point_fields(g, lon, lat, SID, s)
        f2, r2 = waypoints.point_fields(g, lon, lat, SID, s)
        assert f1.t_min.tobytes() == f2.t_min.tobytes()
        assert r1.t_min.tobytes() == r2.t_min.tobytes()


def test_no_input_mutation(world):
    g, _, _, _ = world
    before = (g.passable.tobytes(), g.cellstate.tobytes(), g.maxslope.tobytes())
    waypoints.point_validity(g, *_ll(g, MID), scenario="con_104")
    assert (g.passable.tobytes(), g.cellstate.tobytes(), g.maxslope.tobytes()) == before


# ------------------------------------------------------------------ real grid (local only)

ROOT = Path(__file__).resolve().parents[3]
TERRAIN = ROOT / "data" / "interim" / "terrain"
DEMO_POINT = (137.3962, -4.7781)  # the demo pad's neighbourhood (waypoint block brief)


@pytest.mark.skipif(not (TERRAIN / "elev_3m.tif").exists() or not all(
    (TERRAIN / f).exists() for f in ("slope_3m.tif", "stepguard_3m.tif")),
    reason="data/interim WS1 grid not present")  # fmt: skip
def test_real_grid_demo_point(capsys):
    """Validity of the demo pad's neighbourhood point and one point_fields timing (nom_104).
    Heavy: run under ``flock /tmp/hl-heavy.lock``."""
    from pipeline.engine.graph import load_ws1_grid

    g = load_ws1_grid(TERRAIN)
    s = _settings()
    t0 = time.perf_counter()
    v = waypoints.point_validity(g, *DEMO_POINT, scenario=SID, settings=s)
    t_valid = time.perf_counter() - t0
    assert v["ok"] and v["code"] is None and 0.0 <= v["access_dist_m"] <= RADIUS
    t0 = time.perf_counter()
    fwd, rev = waypoints.point_fields(g, *DEMO_POINT, SID, s)
    t_fields = time.perf_counter() - t0
    assert fwd.t_min[v["access_cell"]] == 0 and rev.t_min[v["access_cell"]] == 0
    n = int(np.isfinite(fwd.t_min).sum())
    assert n > 1_000_000 and int(np.isfinite(rev.t_min).sum()) > 1_000_000
    with capsys.disabled():
        print(f"\nWP2a real grid {g.shape}: point_validity {t_valid:.1f} s, point_fields "
              f"{t_fields:.1f} s ({SID}); access cell {v['access_cell']} "
              f"{v['access_dist_m']:.1f} m; forward reaches {n} cells")

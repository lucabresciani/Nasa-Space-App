"""W4 KATs (E5 finding): the station access cell of ``padpick.station_cell`` / ``station_fields``
skips sealed pockets the way the D21 screening and access.find do. Synthetic world with a
planted sealed pocket (fixtures, not data), plus a real-grid check that runs only when
data/interim is present."""

import json
from pathlib import Path

import numpy as np
import pytest

from pipeline.engine import access, dijkstra, padpick, physio
from pipeline.engine.geo import lonlat_of_xy
from pipeline.engine.graph import BLOCKED
from pipeline.engine.synthetic import dummy_world

SID = "nom_104"
RADIUS = 50.0  # variants.yaml route.access_radius_m (D27); the tests pass it explicitly


def _settings() -> padpick.Settings:
    s = padpick.settings_from_config()
    assert s.access_radius_m == RADIUS
    return s


def _world(center=(150, 190), inner=3.0, outer=4.5):
    """The dummy world (docs/dummy.md) with a blocked ring around ``center``: the assessed
    cells inside it form a sealed pocket. Returns (grid, nominal grid, table, pad_rc)."""
    g, pad, _ = dummy_world(3.0, half_m=700.0)
    rr, cc = np.mgrid[0 : g.shape[0], 0 : g.shape[1]]
    d = np.hypot(rr - center[0], cc - center[1])
    ring = (d >= inner) & (d < outer)
    g.cellstate = g.cellstate.copy()
    g.maxslope = g.maxslope.copy()
    g.cellstate[ring] = BLOCKED
    g.maxslope[ring] = 60.0
    p = physio.scenario_params(SID)
    gv = g.with_nogo(p.nogo_deg)
    return g, gv, physio.grade_table(p), pad


def _station(g, rc, sid="P"):
    lon, lat = lonlat_of_xy(*g.xy_of_rc(*rc), g.crs)
    return {"id": sid, "lon": float(lon), "lat": float(lat)}


def _reach(f) -> int:
    return int(np.isfinite(f.t_min).sum())


# the science point one cell east of the ring centre: inside the pocket, and the nearest cell
# outside the ring is unique: 4 cells east (12 m)
CENTER = (150, 190)
SCIENCE = (150, 191)
OUTSIDE = (150, 195)


def test_planted_pocket_is_sealed():
    """Fixture check: the science cell is passable and assessed, but its fields stay inside
    the ring (the cell the old rule picked)."""
    g, gv, tab, _ = _world(CENTER)
    assert gv.passable[SCIENCE] and g.cellstate[SCIENCE] == 0
    fwd, rev = padpick.access_fields(gv, tab, SCIENCE)
    assert 1 <= _reach(fwd) < 40 and _reach(rev) == _reach(fwd)
    assert not np.isfinite(fwd.t_min[OUTSIDE])


def test_station_cell_skips_sealed_pocket():
    g, gv, tab, pad = _world(CENTER)
    st = _station(g, SCIENCE)
    cell = padpick.station_cell(gv, st, RADIUS, tab)
    assert cell is not None
    assert cell[1:] == OUTSIDE and cell[0] == pytest.approx(12.0)
    # the 3-argument form uses the D21 (nominal) scenario's grade table: same cell here
    assert padpick.station_cell(gv, st, RADIUS) == cell
    # same cell as the batch rule: access.find with the pad's return field (published cards)
    home = dijkstra.return_field(gv, tab, pad)
    a = access.find(gv, home, st["lon"], st["lat"], RADIUS)
    assert a.rc == cell[1:] and a.dist_m == pytest.approx(cell[0])
    # and as the D21 screening's access run for that pad
    acc = padpick.station_access(gv, tab, st, [padpick.Candidate("p", "block", pad, 0, 0, 0)],
                                 RADIUS)  # fmt: skip
    assert acc.runs[acc.assign[0]].cell == cell[1:]


def test_station_fields_reach_the_terrain_not_the_pocket():
    g, gv, tab, pad = _world(CENTER)
    st = _station(g, SCIENCE)
    fwd, rev = padpick.station_fields(g, st, SID, _settings())
    n_pass = int(gv.passable.sum())
    assert fwd.t_min[OUTSIDE] == 0 and rev.t_min[OUTSIDE] == 0
    # a large share of the grid both ways (all passable cells minus the pocket here)
    assert _reach(fwd) > 0.9 * n_pass and _reach(rev) > 0.9 * n_pass
    assert np.isfinite(fwd.t_min[pad]) and np.isfinite(rev.t_min[pad])
    # identical to the access-cell pair; a bounded run uses the same cell
    ref_f, ref_r = padpick.access_fields(gv, tab, OUTSIDE)
    np.testing.assert_array_equal(fwd.t_min, ref_f.t_min)
    np.testing.assert_array_equal(rev.t_min, ref_r.t_min)
    bf, br = padpick.station_fields(g, st, SID, _settings(), tmax_min=5.0)
    assert bf.t_min[OUTSIDE] == 0 and br.t_min[OUTSIDE] == 0
    assert _reach(bf) < _reach(fwd)


def test_no_access_when_every_cell_in_radius_is_sealed():
    """A ring wider than the access radius: every assessed cell within 50 m is in the pocket,
    so there is no access cell (None; station_fields raises MissingInput, as before)."""
    g, gv, tab, pad = _world(CENTER, inner=18.0, outer=20.0)  # 54-60 m > 50 m
    st = _station(g, SCIENCE)
    assert gv.passable[SCIENCE]
    assert padpick.station_cell(gv, st, RADIUS, tab) is None
    with pytest.raises(physio.MissingInput):
        padpick.station_fields(g, st, SID, _settings())
    # the batch rule agrees: no cell within the radius with a walk home to the pad
    home = dijkstra.return_field(gv, tab, pad)
    assert access.find(gv, home, st["lon"], st["lat"], RADIUS).rc is None


def test_station_cell_matches_access_find_without_pockets():
    """Stations on open terrain: the science cell itself (distance 0), as access.find."""
    g, gv, tab, pad = _world(CENTER)
    home = dijkstra.return_field(gv, tab, pad)
    for rc in ((60, 60), (300, 120), (233, 233), (400, 100)):
        st = _station(g, rc)
        cell = padpick.station_cell(gv, st, RADIUS, tab)
        a = access.find(gv, home, st["lon"], st["lat"], RADIUS)
        assert cell is not None and cell[1:] == a.rc and cell[0] == pytest.approx(a.dist_m)


# ------------------------------------------------------------------ real grid (local only)

ROOT = Path(__file__).resolve().parents[3]
TERRAIN = ROOT / "data" / "interim" / "terrain"
PUBLISHED = ROOT / "web" / "public" / "data" / "stations.json"


@pytest.mark.skipif(not (TERRAIN / "elev_3m.tif").exists(), reason="data/interim not present")
def test_real_grid_s2_s6_fields_reach_the_terrain():
    """E5: S2 and S6 nom_104 reached 1-8 cells. Their fields must now reach > 1 M cells, from
    the access cell the published station data records (D27)."""
    from pipeline.engine.geo import xy_of_lonlat
    from pipeline.engine.graph import load_ws1_grid
    from pipeline.engine.stations import load_ws1_stations

    g = load_ws1_grid(TERRAIN)
    st = {s["id"]: s for s in load_ws1_stations(TERRAIN / "stations.json")[0]}
    pub = {s["id"]: s for s in json.loads(PUBLISHED.read_text(encoding="utf-8"))}
    s = _settings()
    for sid in ("S2", "S6"):
        fwd, rev = padpick.station_fields(g, st[sid], SID, s)
        assert _reach(fwd) > 1_000_000 and _reach(rev) > 1_000_000, sid
        a = pub[sid]["access"][SID]
        rc = g.rc_of_xy(*xy_of_lonlat(a["lon"], a["lat"], g.crs))
        assert fwd.t_min[rc] == 0 and rev.t_min[rc] == 0, sid

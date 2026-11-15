"""D48 known-answer tests: build_plan (the batch and the server share it), station_fields,
crew overrides (F26) and the manifest redirection. Synthetic worlds only (fixtures, not data)."""

import json

import numpy as np
import pytest

from pipeline.engine import dijkstra, padpick, physio, provenance, scenarios
from pipeline.engine.config import load
from pipeline.engine.graph import load_ws1_grid
from pipeline.engine.plan import build_plan
from pipeline.engine.synthetic import dummy_world, make_grid, plane
from pipeline.engine.tests.test_scenarios import _write_tif

SIDS = ["nom_104", "con_104", "opt_104"]
STAGES = ["return_fields", "web_products", "diagnostics", "partner", "stations", "routes",
          "trade", "siting", "summary"]  # fmt: skip


@pytest.fixture(autouse=True)
def manifest_dir(tmp_path, monkeypatch):
    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "manifest"))
    return tmp_path / "manifest"


def _terrain(tmp_path):
    """WS1-shaped inputs on the dummy world (as test_main_on_synthetic_terrain)."""
    from pipeline.engine.geo import lonlat_of_xy

    grid, pad, _ = dummy_world(3.0, half_m=700.0)
    terr = tmp_path / "terrain"
    terr.mkdir()
    _write_tif(terr / "elev_3m.tif", np.nan_to_num(grid.elev, nan=-32767), grid, "float32",
               -32767)  # fmt: skip
    for name in ("maxslope_3m.tif", "slope_3m.tif"):
        _write_tif(terr / name, np.nan_to_num(grid.maxslope, nan=-1), grid, "float32", -1)
    _write_tif(terr / "cellstate_3m.tif", grid.cellstate, grid, "uint8", 255)
    sg = np.where(grid.cellstate == 2, 255, 0).astype(np.uint8)
    _write_tif(terr / "stepguard_3m.tif", sg, grid, "uint8", 255)
    ridge = np.zeros((grid.shape[0] * 3, grid.shape[1] * 3), np.float32)
    ridge[:, 600] = 1.0
    _write_tif(terr / "ridge_index.tif", ridge, grid, "float32", -9999, res=1.0)
    st = []
    for i, (r, c) in enumerate([(pad[0] - 80, pad[1] + 10), (pad[0] + 60, pad[1] - 40)]):
        lon, lat = lonlat_of_xy(*grid.xy_of_rc(r, c), grid.crs)
        st.append({"id": f"S{i + 1}", "name": f"Test {i + 1}", "lon": round(float(lon), 6),
                   "lat": round(float(lat), 6), "value": 0.5 + 0.1 * i, "objective": "",
                   "tasks": [], "dwell_min": 30, "t_home_min": {}, "in_partner_line": None,
                   "card": f"cards/S{i + 1}.json"})  # fmt: skip
    (terr / "stations.json").write_text(json.dumps(st))
    return terr


def _tree(root):
    """{relative path: bytes}, summary.json without its timing."""
    out = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        b = p.read_bytes()
        if rel == "summary.json":
            d = json.loads(b)
            d.pop("timing_s")
            b = json.dumps(d, sort_keys=True).encode()
        out[rel] = b
    return out


def test_build_plan_equals_batch_main(tmp_path):
    """The batch (scenarios.main) and a direct build_plan call with explicit inputs (grid,
    stations and ridge in memory, other output dirs) write the same tree byte for byte, and
    on_stage reports every stage in order with the files it wrote."""
    terr = _terrain(tmp_path)
    out_a = tmp_path / "a"
    assert scenarios.main(["--terrain", str(terr), "--out", str(out_a), "--scenarios", *SIDS,
                           "--siting", "--no-conditions"]) == 0  # fmt: skip

    grid = load_ws1_grid(terr)
    st, missing = scenarios.stations.load_ws1_stations(terr / "stations.json")
    st_before = json.dumps(st, sort_keys=True)
    cond = scenarios.conditions_inputs(None, None, "storm", False)
    settings = scenarios.settings_from_config(None)
    stages, cb = [], []
    out_b = tmp_path / "b"
    summ = build_plan(grid, pad_lonlat=None, scenario_ids=SIDS, settings=settings,
                      out_dir=out_b, public_dir=out_b / "public", terrain_dir=None,
                      stations_list=st, stations_missing=missing,
                      ridge=scenarios.load_ridge(terr, grid), cond=cond, dose_fn=None,
                      siting=True, skipped={}, on_stage=lambda n, f: stages.append((n, f)),
                      timing_cb=lambda n, s: cb.append(n), verbose=False)  # fmt: skip
    assert json.dumps(st, sort_keys=True) == st_before  # inputs are never mutated
    ta, tb = _tree(out_a), _tree(out_b)
    assert sorted(ta) == sorted(tb)
    diff = [k for k in ta if ta[k] != tb[k]]
    assert diff == []
    assert [n for n, _ in stages] == STAGES and cb == STAGES[:-1]
    assert list(summ["timing_s"]) == STAGES[:-1]
    seen = {p.relative_to(out_b).as_posix() for _, files in stages for p in files}
    assert seen == set(tb)  # every written file was reported by exactly the stages
    by = {n: {p.relative_to(out_b).as_posix() for p in f} for n, f in stages}
    assert "nom_104/t_home.tif" in by["return_fields"]
    assert "public/scenarios/index.json" in by["web_products"]
    assert "public/stations.json" in by["stations"] and "summary.json" in by["summary"]


def test_build_plan_manifest_dir(tmp_path, manifest_dir):
    """manifest_dir: every record of the plan goes there, none to the default fragments."""
    terr = _terrain(tmp_path)
    grid = load_ws1_grid(terr)
    mine = tmp_path / "plan_manifest"
    build_plan(grid, pad_lonlat=None, scenario_ids=["nom_104"], settings=
               scenarios.settings_from_config(None), out_dir=tmp_path / "o",
               terrain_dir=terr, cond={}, partner=False, manifest_dir=mine,
               verbose=False)  # fmt: skip
    keys = provenance.load_all(mine)
    assert "reachable_pct.nom_104.60" in keys and "file.stations.json" in keys
    assert provenance.load_all(manifest_dir) == {}


# ------------------------------------------------------------------ station_fields


def test_station_fields_equal_d21_screening():
    """station_fields runs the same Dijkstra pair as the D21 screening's first access run."""
    from pipeline.engine.geo import lonlat_of_xy

    n = 121
    g = make_grid(plane(n, 3.0, 0.04), 3.0)
    p = physio.scenario_params("nom_104")
    gv, tab = g.with_nogo(p.nogo_deg), physio.grade_table(p)
    lon, lat = lonlat_of_xy(*g.xy_of_rc(30, 90), g.crs)
    st = {"id": "A", "lon": float(lon), "lat": float(lat)}
    cands = [padpick.Candidate("p0", "block", (60, 60), 0, 0, 0.0)]
    s = padpick.settings_from_config()
    acc = padpick.station_access(gv, tab, st, cands, s.access_radius_m)
    fwd, rev = padpick.station_fields(g, st, "nom_104", s)
    run = acc.runs[0]
    assert run.cell == padpick.station_cell(gv, st, s.access_radius_m)[1:]
    np.testing.assert_array_equal(fwd.t_min.astype(np.float32), run.fwd)
    np.testing.assert_array_equal(rev.t_min.astype(np.float32), run.rev)
    # forward = from the station, reverse = to the station; Params input gives the same
    assert fwd.t_min[run.cell] == 0 and rev.t_min[run.cell] == 0
    ref = dijkstra.return_field(gv, tab, run.cell)
    np.testing.assert_array_equal(rev.t_min, ref.t_min)
    f2, r2 = padpick.station_fields(g, st, p, s)
    np.testing.assert_array_equal(f2.t_min, fwd.t_min)
    # on the plane rising north, going to the station (north) is uphill: slower than from it
    assert rev.t_min[60, 60] > fwd.t_min[60, 60]


def test_station_fields_no_cell():
    from pipeline.engine.graph import UNKNOWN

    g = make_grid(plane(41, 3.0, 0.0), 3.0, cellstate=np.full((41, 41), UNKNOWN, np.uint8))
    from pipeline.engine.geo import lonlat_of_xy

    lon, lat = lonlat_of_xy(*g.xy_of_rc(20, 20), g.crs)
    with pytest.raises(physio.MissingInput):
        padpick.station_fields(g, {"id": "X", "lon": float(lon), "lat": float(lat)})


# ------------------------------------------------------------------ crew (F26)


def test_crew_defaults_identical():
    """No override, an empty one and one equal to the config give the same Params and table."""
    c = load("crew")
    same = {k: c[k] for k in physio.CREW_KEYS}
    for v in ("optimistic", "nominal", "conservative"):
        p0 = physio.params(v, suit_kg=104)
        for crew in ({}, None, same, {"tools_kg": None}):
            p = physio.params(v, suit_kg=104, crew=crew)
            assert p == p0
        t0, t1 = physio.grade_table(p0), physio.grade_table(physio.params(v, crew=same))
        np.testing.assert_array_equal(t0.pace_s_per_m, t1.pace_s_per_m)
        np.testing.assert_array_equal(t0.o2_l_per_m, t1.o2_l_per_m)
    assert physio.crew_values() == same
    with pytest.raises(ValueError, match="unknown crew override"):
        physio.params("nominal", crew={"suit_kg": 90})


def test_crew_override_changes_the_walker():
    p0 = physio.params("nominal", suit_kg=104)
    p = physio.params("nominal", suit_kg=104, crew={"body_mass_kg": 90, "tools_kg": 20,
                                                    "vo2max_ml_kg_min": 40,
                                                    "effort_cap_frac": 0.6})  # fmt: skip
    assert (p.m_b, p.carried_kg, p.vo2max, p.effort_cap) == (90.0, 124.0, 40.0, 0.6)
    assert p0.carried_kg == 104 + load("crew")["tools_kg"]
    sp = physio.scenario_params("nom_104", crew={"tools_kg": 20})
    assert sp.carried_kg == 124.0


def test_heavier_suit_never_increases_reach(tmp_path):
    """Monotonic KAT (F26): more carried mass (suit masses and heavier tools via the crew
    override) never shortens T_home anywhere, so the reachable area never grows."""
    grid, pad, _ = dummy_world(3.0, half_m=600.0)
    settings = scenarios.settings_from_config(None)
    cases = [("nom_80", None), ("nom_104", None), ("nom_104", {"tools_kg": 25}),
             ("nom_120", None), ("nom_120", {"tools_kg": 40})]  # carried 90..160 kg
    prev, prev_m = None, -1.0
    for k, (sid, crew) in enumerate(cases):
        m = physio.scenario_params(sid, crew=crew).carried_kg
        assert m > prev_m
        prev_m = m
        f = scenarios.return_fields(grid, pad, [sid], settings, out_dir=tmp_path / str(k),
                                    crew=crew)[sid]  # fmt: skip
        t = np.where(np.isfinite(f.t_min), f.t_min, np.inf)
        if prev is not None:
            assert np.all(t >= prev - 1e-9)
            for b in (5, 10, 15):
                assert (t <= b).sum() <= (prev <= b).sum()
        prev = t
    # and heavier does cost something on this world
    first = scenarios.return_fields(grid, pad, ["nom_80"], settings, out_dir=tmp_path / "x")
    assert (prev <= 10).sum() < (first["nom_80"].t_min <= 10).sum()


def test_build_plan_crew_default_equals_none(tmp_path):
    """crew = the config values writes the same products as crew=None (only the summary gets
    the crew block)."""
    terr = _terrain(tmp_path)
    grid = load_ws1_grid(terr)
    c = load("crew")
    kw = dict(pad_lonlat=None, scenario_ids=["nom_104"], settings=
              scenarios.settings_from_config(None), terrain_dir=terr, cond={}, verbose=False)
    build_plan(grid, out_dir=tmp_path / "a", **kw)
    s = build_plan(grid, out_dir=tmp_path / "b", crew={k: c[k] for k in physio.CREW_KEYS}, **kw)
    ta, tb = _tree(tmp_path / "a"), _tree(tmp_path / "b")
    assert sorted(ta) == sorted(tb)
    assert [k for k in ta if ta[k] != tb[k]] == ["summary.json"]
    assert s["crew"] == {k: c[k] for k in physio.CREW_KEYS}

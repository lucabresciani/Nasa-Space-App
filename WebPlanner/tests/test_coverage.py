"""Known-answer tests for WS1 terrain (briefs/WS1.md "Tests"; SPEC §9 Terrain, F1, F2).

- Source-mask fractions over a window match a direct count / the footprint area within 1%.
- An unknown island is never assessed and is excluded from percentages.
- A cell within 20 m of a source boundary is flagged as a data edge.
- Slope of a synthetic 10% plane = 5.71 deg +- 0.05 deg (Horn 3x3 and the 5 m plane fit).
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from shapely.geometry import Polygon, box

from pipeline.terrain import coverage, routing, slope
from pipeline.terrain.grid import Grid

# ---------------------------------------------------------------- source mask


def test_mask_fraction_matches_footprint_area_within_1pct():
    g = Grid(x0=0.0, y0=1000.0, res=1.0, width=1000, height=1000)
    quad = Polygon([(120, 80), (870, 210), (760, 940), (60, 700)])  # skewed STAC-like quad
    m = coverage.rasterize_footprints([quad], g)
    frac_raster = m.mean()
    frac_area = quad.intersection(box(*g.bounds)).area / box(*g.bounds).area
    assert abs(frac_raster - frac_area) <= 0.01 * frac_area


def test_source_fractions_match_direct_count():
    rng = np.random.default_rng(1)
    mask = rng.choice(np.array([0, 1, 2, 3], np.uint8), size=(300, 400), p=[.1, .5, .3, .1])
    win = (slice(20, 220), slice(50, 350))
    fr = coverage.source_fractions(mask, win)
    sub = mask[win]
    for code in (0, 1, 2, 3):
        assert fr[code] == pytest.approx((sub == code).mean(), abs=0.01)
    assert sum(fr.values()) == pytest.approx(1.0)


def test_source_mask_codes():
    dem = np.zeros((10, 10), np.float32)
    dem[0, 0] = np.nan
    hirise = np.zeros((10, 10), bool)
    hirise[:, :5] = True
    m = coverage.source_mask(dem, hirise)
    assert m[0, 0] == coverage.NODATA
    assert (m[1:, :5] == coverage.HIRISE).all()
    assert (m[:, 5:] == coverage.NON_HIRISE).all()


# ---------------------------------------------------------------- cell states, island


def _flat_world(n3=60):
    """1 m DEM of a flat plane, all HiRISE, with a 10x10-m unknown island (CTX)."""
    n1 = 3 * n3
    dem = np.zeros((n1, n1), np.float32)
    mask = np.full((n1, n1), coverage.HIRISE, np.uint8)
    mask[90:100, 90:100] = coverage.NON_HIRISE  # island
    return dem, mask


def test_unknown_island_never_assessed_and_excluded():
    dem, mask = _flat_world()
    slope1 = np.zeros_like(dem)
    cg = routing.cell_grids(dem, slope1, mask, res_m=1.0, step_guard_deg=30.0)
    state3 = cg.state(20.0)
    island3 = np.zeros(state3.shape, bool)
    island3[90 // 3:(100 + 2) // 3, 90 // 3:(100 + 2) // 3] = True
    assert (state3[island3] == routing.UNKNOWN).all()
    assert (state3[~island3] == routing.ASSESSED).all()
    # percentages exclude unknown cells
    vals = np.ones(state3.shape)
    vals[island3] = 1e9  # would dominate if it leaked in
    assert routing.mean_over_known(vals, state3) == pytest.approx(1.0)
    # coverage counts the island as unknown
    disc = np.ones(state3.shape, bool)
    cov = coverage.disc_coverage(state3, disc)
    assert cov["unknown_frac"] == pytest.approx(island3.mean())
    assert cov["assessed_frac"] + cov["unknown_frac"] == pytest.approx(1.0)


def test_nodata_cell_is_unknown():
    dem = np.zeros((9, 9), np.float32)
    dem[0, 0] = np.nan
    mask = coverage.source_mask(dem, np.ones(dem.shape, bool))
    cg = routing.cell_grids(dem, np.zeros_like(dem), mask, res_m=1.0, step_guard_deg=30.0)
    st = cg.state(20.0)
    assert st[0, 0] == routing.UNKNOWN and st[1, 1] == routing.ASSESSED
    assert np.isnan(cg.slope[0, 0]) and cg.stepguard_u8()[0, 0] == routing.STEPGUARD_NODATA


# ---------------------------------------------------------------- D22 cell slope + step guard

NOGO = {"optimistic": 25.0, "nominal": 20.0, "conservative": 17.0}  # D23


def _plane(theta_deg, azimuth_deg, n=30, res=1.0, offset=0.0, dtype=np.float64):
    """z = tan(theta) * (distance along the azimuth), x east, y north (rows run south)."""
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    x, y = xx * res, -yy * res
    a = math.radians(azimuth_deg)
    return (offset + math.tan(math.radians(theta_deg)) * (math.sin(a) * x + math.cos(a) * y)
            ).astype(dtype)


@pytest.mark.parametrize("theta", [5.710593137499643, 17.0, 20.0, 25.0, 40.0])
@pytest.mark.parametrize("azimuth", [0.0, 90.0, 137.0, 250.0])
def test_plane_fit_cell_slope_of_an_exact_plane(theta, azimuth):
    """D22: the 3 m plane-fit slope of an exact plane equals its slope (every cell)."""
    s = routing.plane_slope_blocks(_plane(theta, azimuth), 1.0)
    assert s.shape == (10, 10)
    assert np.abs(s - theta).max() < 1e-6
    # realistic heights in float32 (pad -3627 m): still within 0.01 deg
    z32 = _plane(theta, azimuth, offset=-3627.74, dtype=np.float32)
    assert np.abs(routing.plane_slope_blocks(z32, 1.0) - theta).max() < 0.01
    # the 10 % grade of the brief: 5.71 deg
    assert routing.plane_slope_blocks(_plane(5.710593137499643, 0.0), 1.0)[0, 0] == \
        pytest.approx(5.71, abs=0.005)


def test_plane_fit_cell_slope_equals_3x3_plane_fit_at_the_cell_centre():
    """Same estimator as slope.plane_fit(window 3) evaluated at each block's centre pixel."""
    rng = np.random.default_rng(3)
    z = rng.normal(0, 1.5, (30, 30))
    blocks = routing.plane_slope_blocks(z, 1.0)
    moving, _ = slope.plane_fit(z.astype(np.float32), 1.0, window_px=3)
    centres = moving[1::3, 1::3]
    ok = np.isfinite(centres)
    assert ok.sum() >= 60
    assert np.abs(blocks[ok] - centres[ok]).max() < 1e-3


def test_plane_fit_nan_elevation_gives_nan():
    z = np.zeros((9, 9))
    z[4, 4] = np.nan
    s = routing.plane_slope_blocks(z, 1.0)
    assert np.isnan(s[1, 1]) and np.isfinite(np.delete(s.ravel(), 4)).all()


def test_step_guard_blocks_a_single_steep_1m_step_with_low_plane_slope():
    """D22: one 1 m spike inside a cell -> 1 m Horn slopes > 30 deg around it, plane-fit slope
    0 (the spike is the block centre) -> blocked by the step guard at every no-go."""
    dem = np.zeros((30, 30), np.float32)
    dem[10, 10] = 3.0                      # centre pixel of 3 m cell (3, 3)
    s1 = slope.horn(dem, 1.0)
    mask = np.full(dem.shape, coverage.HIRISE, np.uint8)
    cg = routing.cell_grids(dem, s1, mask, res_m=1.0, step_guard_deg=30.0)
    assert cg.slope[3, 3] == pytest.approx(0.0, abs=1e-9)
    assert cg.maxslope[3, 3] == pytest.approx(math.degrees(math.atan(0.75)), abs=1e-4)  # 36.87
    assert cg.stepguard[3, 3] and cg.stepguard.sum() == 1
    sg = cg.stepguard_u8()
    assert sg[3, 3] == 1 and sg[2, 2] == 0
    inner = np.zeros(cg.known.shape, bool)
    inner[1:-1, 1:-1] = True               # border cells have no Horn slope: unknown
    for nogo in NOGO.values():
        st = cg.state(nogo)
        assert st[3, 3] == routing.BLOCKED
        assert (st[inner & ~cg.stepguard] == routing.ASSESSED).all()
        assert (st[~inner] == routing.UNKNOWN).all()
    # the old max-slope rule would also block it, but plane-fit alone would not
    assert routing.cell_state(cg.known, cg.slope, np.zeros_like(cg.stepguard), 17.0)[3, 3] \
        == routing.ASSESSED


def test_step_guard_threshold_is_strict():
    dem = np.zeros((9, 9), np.float32)
    s1 = np.zeros_like(dem)
    s1[1, 1] = 30.0                        # cell (0, 0): exactly 30 -> not fired
    s1[4, 4] = 30.01                       # cell (1, 1): fired
    mask = np.full(dem.shape, coverage.HIRISE, np.uint8)
    cg = routing.cell_grids(dem, s1, mask, res_m=1.0, step_guard_deg=30.0)
    assert not cg.stepguard[0, 0] and cg.stepguard[1, 1]
    st = cg.state(25.0)
    assert st[0, 0] == routing.ASSESSED and st[1, 1] == routing.BLOCKED


def test_unknown_cells_stay_unknown_in_every_variant():
    rng = np.random.default_rng(5)
    dem = rng.normal(0, 3.0, (30, 30)).astype(np.float32)   # steep noise everywhere
    s1 = np.full(dem.shape, 45.0, np.float32)
    mask = np.full(dem.shape, coverage.HIRISE, np.uint8)
    mask[0:3, 0:3] = coverage.NON_HIRISE    # cell (0, 0): non-HiRISE
    dem[4, 4] = np.nan                      # cell (1, 1): no elevation
    s1[7, 7] = np.nan                       # cell (2, 2): no slope
    cg = routing.cell_grids(dem, s1, mask, res_m=1.0, step_guard_deg=30.0)
    unk = [(0, 0), (1, 1), (2, 2)]
    for nogo in NOGO.values():
        st = cg.state(nogo)
        for rc in unk:
            assert st[rc] == routing.UNKNOWN
        assert (np.delete(st.ravel(), [0, 11, 22]) == routing.BLOCKED).all()
    for rc in unk:
        assert np.isnan(cg.slope[rc]) and cg.stepguard_u8()[rc] == routing.STEPGUARD_NODATA


def _random_cells(seed=0, n=60):
    rng = np.random.default_rng(seed)
    dem = np.cumsum(rng.normal(0, 0.35, (n, n)), axis=1).astype(np.float32)
    s1 = slope.horn(dem, 1.0)
    mask = np.full(dem.shape, coverage.HIRISE, np.uint8)
    mask[:9, :9] = coverage.NON_HIRISE
    return routing.cell_grids(dem, s1, mask, res_m=1.0, step_guard_deg=30.0)


@pytest.mark.parametrize("variant", list(NOGO))
def test_cell_state_is_blocked_iff_plane_slope_over_nogo_or_step_guard(variant):
    cg = _random_cells()
    nogo = NOGO[variant]
    st = cg.state(nogo)
    with np.errstate(invalid="ignore"):
        exp_blocked = cg.known & ((cg.slope > nogo) | cg.stepguard)
    assert ((st == routing.BLOCKED) == exp_blocked).all()
    assert ((st == routing.UNKNOWN) == ~cg.known).all()
    assert ((st == routing.ASSESSED) == (cg.known & ~exp_blocked)).all()
    # both branches occur in this synthetic world, so the KAT bites
    with np.errstate(invalid="ignore"):
        assert (cg.known & (cg.slope > nogo)).any()
        assert (cg.known & cg.stepguard & (cg.slope <= nogo)).any()
        assert (st == routing.ASSESSED).any()
    # WS2's rule from the written rasters gives the same cells
    nominal = cg.state(NOGO["nominal"])
    assert (routing.passable(nominal, cg.slope, cg.stepguard_u8(), nogo)
            == (st == routing.ASSESSED)).all()


def test_variants_nest_and_share_unknown():
    cg = _random_cells(seed=2)
    o, n, c = (cg.state(NOGO[v]) for v in ("optimistic", "nominal", "conservative"))
    assert ((o == routing.BLOCKED) <= (n == routing.BLOCKED)).all()
    assert ((n == routing.BLOCKED) <= (c == routing.BLOCKED)).all()
    assert ((o == routing.UNKNOWN) == (c == routing.UNKNOWN)).all()


def test_site_config_d22_d23_values():
    from pipeline.terrain import grid as G

    sl = G.site()["slope"]
    assert sl["nogo_deg"] == {"optimistic": 25, "nominal": 20, "conservative": 17}   # D23
    assert sl["step_guard_deg"] == 30 and sl["step_guard_assumed"] is True          # D22
    assert sl["flag_beyond_tested_deg"] == 17
    assert sl["cell_slope"] == "plane_fit_3x3"


# ---------------------------------------------------------------- data edge


def test_data_edge_within_20m():
    state = np.zeros((100, 100), np.uint8)
    state[:, 60:] = routing.UNKNOWN  # boundary between col 59 and col 60
    edge = coverage.data_edge(state, res=3.0, buffer_m=20.0)
    # cell centre to the boundary: (59.5 - c) * 3 m for assessed col c
    for c in range(0, 60):
        d = (60 - c - 0.5) * 3.0
        assert edge[50, c] == (d <= 20.0), (c, d)
    assert not edge[:, 60:].any()  # unknown cells are not "edges", they are unknown


# ---------------------------------------------------------------- slope


@pytest.mark.parametrize("res", [1.0, 3.0])
def test_slope_10pct_plane(res):
    n = 64
    yy, xx = np.mgrid[0:n, 0:n] * res
    z = 0.10 * xx + 0.0 * yy
    s = slope.horn(z.astype(np.float32), res)
    inner = s[1:-1, 1:-1]
    assert np.nanmax(np.abs(inner - math.degrees(math.atan(0.1)))) < 0.05
    assert math.degrees(math.atan(0.1)) == pytest.approx(5.71, abs=0.01)
    assert np.isnan(s[0]).all()  # border has no full window: unknown, not filled


def test_slope_diagonal_plane_and_plane_fit():
    n = 64
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    z = (0.06 * xx - 0.08 * yy).astype(np.float32)  # |grad| = 0.10
    s = slope.horn(z, 1.0)
    assert np.nanmax(np.abs(s - 5.7106)) < 0.05
    s5, rough = slope.plane_fit(z, 1.0, window_px=5)
    assert np.nanmax(np.abs(s5 - 5.7106)) < 0.05
    assert np.nanmax(rough) < 1e-3  # a plane has no roughness


def test_roughness_of_known_bumps():
    rng = np.random.default_rng(0)
    z = rng.normal(0, 0.2, size=(200, 200)).astype(np.float32)
    _, rough = slope.plane_fit(z, 1.0, window_px=5)
    # RMS residual of a 3-parameter plane over 25 samples: sigma * sqrt(22/25)
    assert np.nanmedian(rough) == pytest.approx(0.2 * math.sqrt(22 / 25), rel=0.1)


def test_nodata_propagates_to_slope():
    z = np.zeros((20, 20), np.float32)
    z[10, 10] = np.nan
    s = slope.horn(z, 1.0)
    assert np.isnan(s[9:12, 9:12]).all()
    assert s[5, 5] == pytest.approx(0.0)


# -------------------------------------------------- web shape, contracts v1.0.0 (F1, F16)

REPO = __import__("pathlib").Path(__file__).resolve().parents[1]


def _schema(name):
    import json

    from jsonschema import Draft202012Validator

    return Draft202012Validator(json.loads((REPO / "contracts" / name).read_text()))


def test_disc_state_pct_is_a_partition_of_the_disc():
    from pipeline.terrain import webout

    st = np.zeros((10, 10), np.uint8)
    st[0, :] = routing.BLOCKED       # 10 blocked
    st[1, :5] = routing.UNKNOWN      # 5 unknown
    disc = np.ones(st.shape, bool)
    disc[9, :] = False               # 90 cells; row 9 (all assessed) outside
    p = webout.disc_state_pct(st, disc)
    assert p == {"assessed_pct": pytest.approx(75 / 90 * 100, abs=0.01),
                 "blocked_pct": pytest.approx(10 / 90 * 100, abs=0.01),
                 "unknown_pct": pytest.approx(5 / 90 * 100, abs=0.01)}
    assert sum(p.values()) == pytest.approx(100.0, abs=0.02)
    assert webout.disc_state_pct(st, np.zeros(st.shape, bool)) == {
        "assessed_pct": None, "blocked_pct": None, "unknown_pct": None}


_PAD_DISCS = [{"budget_min": 30, "radius_m": 1764.0, "assessed_pct": 55.0, "blocked_pct": 40.0,
               "unknown_pct": 5.0},
              {"budget_min": 60, "radius_m": 3528.0, "assessed_pct": 92.0, "blocked_pct": 3.0,
               "unknown_pct": 5.0}]


def test_pad_check_shows_both_readings_and_picks_none_while_open():
    """Pad check (SPEC F1 acceptance, WS1 G0): the reading of "assessed" is open (S/C), so both
    readings are reported - data coverage (assessed + blocked) and state 0 only - and pass is
    null until site.yaml coverage.pad_check_reading names one."""
    from pipeline.terrain import webout

    pc = webout.pad_check(_PAD_DISCS, budget_min=30, min_pct=90)
    assert pc["budget_min"] == 30 and pc["min_assessed_pct"] == 90
    assert pc["reading"] is None and pc["pass"] is None
    r = pc["readings"]
    assert set(r) == {"data_coverage", "state0_only"}
    assert r["data_coverage"]["pct"] == pytest.approx(95.0) and r["data_coverage"]["pass"] is True
    assert r["state0_only"]["pct"] == pytest.approx(55.0) and r["state0_only"]["pass"] is False
    assert pc["known_pct"] == pytest.approx(95.0)
    assert all(v["definition"] for v in r.values())
    r60 = webout.pad_check(_PAD_DISCS, budget_min=60, min_pct=90)["readings"]
    assert r60["data_coverage"]["pass"] is True and r60["state0_only"]["pass"] is True
    nulls = [{**_PAD_DISCS[0], "assessed_pct": None, "blocked_pct": None, "unknown_pct": None}]
    rn = webout.pad_check(nulls, budget_min=30, min_pct=90)
    assert rn["pass"] is None
    assert rn["readings"]["data_coverage"]["pass"] is None
    assert rn["readings"]["state0_only"]["pass"] is None


@pytest.mark.parametrize("reading,expected", [("data_coverage", True), ("state0_only", False)])
def test_pad_check_pass_follows_a_decided_reading(reading, expected):
    from pipeline.terrain import webout

    pc = webout.pad_check(_PAD_DISCS, budget_min=30, min_pct=90, reading=reading)
    assert pc["reading"] == reading and pc["pass"] is expected
    with pytest.raises(ValueError):
        webout.pad_check(_PAD_DISCS, budget_min=30, min_pct=90, reading="assessed")


def test_pad_check_reading_in_config_is_the_decided_one():
    """Decision log 2026-11-14 12:37 (user, for S/C): "assessed" = cells with data (walkable or
    blocked), not unknown -> data_coverage."""
    from pipeline.terrain import grid as G

    assert G.site()["coverage"]["pad_check_reading"] == "data_coverage"


def test_prov_record_goes_through_ws6_fragment(tmp_path, monkeypatch):
    """WS1 provenance uses WS6's manifest.record (per-script fragment, no pending file); a
    non-finite value is recorded as None (unknown), never NaN."""
    import json

    from pipeline.terrain import prov

    monkeypatch.setenv("HOMELINE_MANIFEST_DIR", str(tmp_path))
    script = prov.REPO / "pipeline" / "terrain" / "build.py"
    prov.record("terrain.test.value", np.float32(1.5), "m", "validation/coverage.json", script)
    prov.record("terrain.test.unknown", float("nan"), "m", "validation/coverage.json", script)
    frag = json.loads((tmp_path / "pipeline__terrain__build.json").read_text())
    assert frag["terrain.test.value"]["value"] == 1.5
    assert frag["terrain.test.value"]["file"] == "validation/coverage.json"
    assert frag["terrain.test.value"]["script"] == "pipeline/terrain/build.py"
    assert frag["terrain.test.unknown"]["value"] is None
    assert not hasattr(prov, "PENDING")


def test_source_fractions_pct_names_and_region():
    from pipeline.terrain import webout

    m = np.array([[1, 1, 2, 0], [1, 3, 1, 1]], np.uint8)
    region = np.ones(m.shape, bool)
    region[:, 3] = False             # drop one nodata and one HiRISE cell
    p = webout.source_fractions_pct(m, region)
    assert p == {"hirise": pytest.approx(400 / 6), "ctx": pytest.approx(100 / 6),
                 "hrsc_mola": pytest.approx(100 / 6), "nodata": pytest.approx(0.0)}


def test_lonlat_bounds_are_pixel_edges():
    from pipeline.terrain import grid as G
    from pipeline.terrain import webout

    g = G.route_grid()
    w, s, e, n = webout.lonlat_bounds(g)
    x0, y0 = G.xy_of_lonlat(w, n)
    x1, y1 = G.xy_of_lonlat(e, s)
    assert (x0, y0) == (pytest.approx(g.x0, abs=0.06), pytest.approx(g.y0, abs=0.06))
    assert x1 == pytest.approx(g.x0 + g.width * g.res, abs=0.06)
    assert y1 == pytest.approx(g.y0 - g.height * g.res, abs=0.06)


def test_coverage_map_rgba_uses_only_legend_colours():
    from pipeline.terrain import webout

    st = np.zeros((200, 200), np.uint8)
    st[:50] = routing.BLOCKED
    st[:, :20] = routing.UNKNOWN
    g = Grid(x0=0.0, y0=600.0, res=3.0, width=200, height=200)
    rgba, legend = webout.coverage_map_rgba(st, g, (300.0, 300.0), [150.0, 280.0])
    assert rgba.shape == (200, 200, 4) and rgba.dtype == np.uint8
    assert (rgba[..., 3] == 255).all()
    cols = {tuple(c) for c in rgba[..., :3].reshape(-1, 3)}
    leg = {tuple(int(k[i:i + 2], 16) for i in (1, 3, 5)) for k in legend}
    assert cols <= leg
    # far from the circles and the pad, each class has its own legend colour
    inv = {v: k for k, v in legend.items()}
    hexc = "#{:02x}{:02x}{:02x}".format
    assert hexc(*rgba[199, 199, :3]) == inv[webout.LABELS["assessed"]]
    assert hexc(*rgba[0, 199, :3]) == inv[webout.LABELS["blocked"]]
    assert hexc(*rgba[199, 0, :3]) == inv[webout.LABELS["unknown"]]


def test_coverage_web_document_validates_and_keeps_internal_keys():
    from pipeline.terrain import webout

    internal = {"discs": {"30": {"radius_m": 1764.0}}, "d3": {"status": "OPEN"},
                "pad": {"lon": 137.382, "lat": -4.806, "xy": [1.0, 2.0]}}
    discs = [{"budget_min": 30, "radius_m": 1764.0, "assessed_pct": 59.0, "blocked_pct": 41.0,
              "unknown_pct": 0.0}]
    doc = webout.coverage_web(
        internal, discs=discs, source_pct={"hirise": 100.0, "ctx": 0.0, "hrsc_mola": 0.0,
                                           "nodata": 0.0},
        pad_chk=webout.pad_check(discs, 30, 90), speed_ms=0.98, origin="STAC",
        map_meta={"png": "validation/coverage.png", "bounds": [1, 2, 3, 4],
                  "legend": {"#000000": "x"}})
    errs = list(_schema("coverage.schema.json").iter_errors(doc))
    assert not errs, errs
    assert doc["d3"] == {"status": "OPEN"}                         # evidence kept
    assert doc["discs_by_budget"] == {"30": {"radius_m": 1764.0}}  # old dict kept, renamed
    assert doc["pad"]["xy"] == [1.0, 2.0]


def test_grid_spec_fields_grid_corner():
    from pipeline.terrain import grid as G
    from pipeline.terrain import webout

    s = G.site()
    gf = G.fields_grid()
    spec = webout.grid_spec(gf)
    px, py = G.pad_xy()
    r = s["planning_radius_m"]
    assert spec["nw_xy"] == [pytest.approx(px - r), pytest.approx(py + r)]
    assert spec["width"] == spec["height"] == int(2 * r / s["grids_m"]["fields"])
    assert spec["res_m"] == s["grids_m"]["fields"]
    assert spec["transform_gdal"] == [gf.x0, gf.res, 0.0, gf.y0, 0.0, -gf.res]
    assert spec["bounds_lonlat"] == webout.lonlat_bounds(gf)


# -------------------------------------------------- basemap zooms (brief WS1 task 7)


def test_basemap_zoom_range_for_025_to_10_m():
    """Mars lon/lat passed to MapLibre as-is (D4): m/px at zoom z = 2 pi R / (256 * 2^z).
    R = 3,396,190 m -> z18 = 0.318 m/px (nearest to 0.25 m), z13 = 10.18 m/px (nearest to 10 m)."""
    from pipeline.terrain import build

    r = 3396190.0
    assert 2 * math.pi * r / (256 * 2 ** 18) == pytest.approx(0.31798, abs=1e-4)
    assert build._zoom_for(0.25) == 18
    assert build._zoom_for(10.0) == 13
    assert build._zoom_for(1.0) == 16


# ---------------------------------------------------------------- conservative cell states (task 8)

def test_cell_state_summary_splits_slope_and_step_guard_shares():
    from pipeline.terrain import webout

    g = Grid(x0=0.0, y0=30.0, res=3.0, width=10, height=10)
    known = np.ones((10, 10), bool)
    known[9, :] = False                    # 10 unknown cells
    sl = np.full((10, 10), 10.0, np.float32)
    sl[0, :] = 22.0                        # 10 cells: blocked by slope at 20 and 17, not 25
    sl[1, :] = 18.0                        # 10 cells: blocked by slope at 17 only
    sl[~known] = np.nan
    sg = np.zeros((10, 10), bool)
    sg[2, :5] = True                       # 5 cells: step guard only
    sg[0, :2] = True                       # 2 cells: step guard and slope (counted as slope)
    mx = np.full((10, 10), 21.0, np.float32)   # old rule: every known cell > 20 and > 17
    nogo = {"optimistic": 25.0, "nominal": 20.0, "conservative": 17.0}
    states = {v: routing.cell_state(known, sl, sg, d) for v, d in nogo.items()}
    doc = webout.cell_state_summary(states, sl, sg, known, mx, g, (15.0, 15.0), {30: 100.0},
                                    nogo_deg=nogo, step_guard_deg=30.0, rasters={})
    assert doc["step_guard_deg"] == 30.0
    row = {v: doc["variants"][v]["discs"][0] for v in nogo}
    assert row["optimistic"]["blocked_slope_pct"] == 0.0
    assert row["optimistic"]["blocked_stepguard_only_pct"] == pytest.approx(7.0)
    assert row["optimistic"]["blocked_pct"] == pytest.approx(7.0)
    assert row["optimistic"]["maxslope_rule_blocked_pct"] == pytest.approx(0.0)
    assert row["nominal"]["blocked_slope_pct"] == pytest.approx(10.0)
    assert row["nominal"]["blocked_stepguard_only_pct"] == pytest.approx(5.0)
    assert row["nominal"]["blocked_pct"] == pytest.approx(15.0)
    assert row["nominal"]["maxslope_rule_blocked_pct"] == pytest.approx(90.0)
    assert row["conservative"]["blocked_slope_pct"] == pytest.approx(20.0)
    assert row["conservative"]["blocked_stepguard_only_pct"] == pytest.approx(5.0)
    assert row["conservative"]["blocked_pct"] == pytest.approx(25.0)
    assert row["conservative"]["unknown_pct"] == pytest.approx(10.0)
    assert row["conservative"]["assessed_pct"] == pytest.approx(65.0)
    assert doc["discs_stepguard"][0]["stepguard_pct"] == pytest.approx(7.0)
    assert doc["variants"]["nominal"]["nogo_deg"] == 20.0


# ---------------------------------------------------------------- manifest file paths (WS6 audit 1)


def _leaves(obj):
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _leaves(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _leaves(v)
    else:
        yield obj


def test_every_ws1_manifest_key_cites_a_web_path_that_holds_its_value(tmp_path, monkeypatch):
    """WS6 audit 1: WS5's <Num> matches a key by its web file. Every WS1 key cites the path
    `make web` publishes (contracts/README.md sources: validation/... from WS1, stations.json
    from WS2's mirror), never data/interim/..., and its value appears in that file."""
    import json

    from pipeline.terrain import build, webout

    monkeypatch.setenv("HOMELINE_MANIFEST_DIR", str(tmp_path / "manifest"))
    monkeypatch.setattr(build, "OUT", tmp_path)
    xcheck = {"items": {"DTEEC_X": {"median_m": -9.426, "p90_abs_m": 15.34}}}
    slope_summary = {"slope_compare": {"median_abs_diff_deg": 0.341},
                     "discs": {"30": {"blocked_pct_of_known": 41.23},
                               "60": {"blocked_pct_of_known": 31.357}}}
    row = {"budget_min": 30, "radius_m": 1764.0, "assessed_pct": 70.0, "blocked_pct": 30.0,
           "unknown_pct": 0.0, "blocked_slope_pct": 21.5, "blocked_stepguard_only_pct": 8.5,
           "maxslope_rule_blocked_pct": 41.23}
    con = {"step_guard_deg": 30.0, "discs_stepguard": [{"budget_min": 30, "stepguard_pct": 9.1}],
           "variants": {v: {"nogo_deg": d, "discs": [row]}
                        for v, d in (("optimistic", 25.0), ("nominal", 20.0),
                                     ("conservative", 17.0))}}
    discs = [{"budget_min": 30, "radius_m": 1764.0, "assessed_pct": 58.77, "blocked_pct": 41.23,
              "unknown_pct": 0.0}]
    doc = {"discs": discs, "source_fractions_pct": {"hirise": 100.0},
           "pad_check": webout.pad_check(discs, 30, 90, reading="data_coverage"),
           "terrain_checks": webout.terrain_checks(xcheck, slope_summary, con)}
    cg = {"dx_m": 0.0, "dy_m": 0.0, "residual_median_m": 0.0, "residual_mad_m": 0.037, "n": 537}
    (tmp_path / "coverage.json").write_text(json.dumps(doc))
    (tmp_path / "coverage.png").write_bytes(b"png")
    (tmp_path / "coreg.json").write_text(json.dumps(cg))
    build._record_validation(doc, cg)
    stations = [{"id": "S1", "value": 0.8683}, {"id": "S3", "value": None}]
    build._record_stations({"stations": stations})

    frag = json.loads((tmp_path / "manifest" / "pipeline__terrain__build.json").read_text())
    shown = {"validation/coverage.json": doc, "validation/coreg.json": cg,
             "stations.json": stations}
    for key, e in frag.items():
        assert not e["file"].startswith("data/"), (key, e["file"])
        if key.startswith("file."):
            assert e["file"] == key[len("file."):]
            continue
        assert e["file"] in shown, (key, e["file"])
        assert e["value"] in list(_leaves(shown[e["file"]])), (key, e["value"])
    for key in ("stations.S1.value", "terrain.xcheck.DTEEC_X.median",
                "terrain.xcheck.DTEEC_X.p90_abs", "terrain.slope_compare.median_abs_diff",
                "terrain.blocked_pct.30min", "terrain.blocked_pct.60min",
                "terrain.nogo_deg.conservative", "terrain.nogo_deg.optimistic",
                "terrain.step_guard_deg", "terrain.stepguard.disc_30.pct",
                "terrain.cellstates.conservative.disc_30.blocked_pct",
                "terrain.cellstates.nominal.disc_30.blocked_stepguard_only_pct",
                "terrain.cellstates.optimistic.disc_30.maxslope_rule_blocked_pct"):
        assert key in frag, key
    # D23: the old "20 - V1 RMSE" keys are gone
    assert not [k for k in frag if k.startswith("terrain.conservative.")
                or k == "terrain.nogo_conservative_deg"]
    assert frag["stations.S1.value"]["file"] == "stations.json"
    assert "stations.S3.value" not in frag                    # unknown stays unrecorded


# ---------------------------------------------------------------- stations (D26, D32; F7)


def test_station_spacing_rule_300m():
    from pipeline.terrain import stations as ST

    x = np.array([0.0, 299.9, 300.0, 0.0, 500.0])
    y = np.array([0.0, 0.0, 0.0, -300.0, 400.0])
    ok = ST.spacing_ok(x, y, [(0.0, 0.0)], 300.0)
    assert ok.tolist() == [False, False, True, True, True]     # >= 300 m from every station
    ok2 = ST.spacing_ok(x, y, [(0.0, 0.0), (500.0, 300.0)], 300.0)
    assert ok2.tolist() == [False, False, True, True, False]
    assert ST.spacing_ok(x, y, [], 300.0).all()


def test_station_focus_area_filter_is_inclusive_box():
    from pipeline.terrain import stations as ST

    f = {"west": 137.37, "east": 137.42, "south": -4.82, "north": -4.77}
    lon = np.array([137.37, 137.395, 137.42, 137.3699, 137.4201, 137.40, 137.40])
    lat = np.array([-4.82, -4.80, -4.77, -4.80, -4.80, -4.8201, -4.7699])
    assert ST.in_focus(lon, lat, f).tolist() == [True, True, True, False, False, False, False]


def test_station_walkable_filter_uses_the_3m_cell_under_the_point():
    from pipeline.terrain import stations as ST

    g3 = Grid(x0=0.0, y0=30.0, res=3.0, width=10, height=10)
    st = np.zeros((10, 10), np.uint8)
    st[0, 1] = routing.BLOCKED
    st[0, 2] = routing.UNKNOWN
    x = np.array([1.5, 4.5, 7.5, 10.5, -1.0, 31.0])
    y = np.array([28.5, 28.5, 28.5, 28.5, 28.5, 28.5])
    # assessed -> walkable; blocked, unknown, off the grid -> not walkable
    assert ST.walkable_at(st, g3, x, y).tolist() == [True, False, False, True, False, False]


@pytest.mark.parametrize("crism,ridge,expected", [
    ({"D2300": 0.92, "SINDEX2": 0.10}, 0.20, "high D2300 clay signal"),
    ({"D2300": 0.10, "SINDEX2": 0.81}, 0.00, "high SINDEX2 sulfate signal"),
    ({"D2300": 0.30, "SINDEX2": 0.20}, 1.00, "dense ridge network"),
    ({"D2300": 0.60, "SINDEX2": 0.20}, 1.00, "dense ridge network + high D2300 clay signal"),
    ({"D2300": 0.90, "SINDEX2": 0.20}, 0.70, "high D2300 clay signal + dense ridge network"),
    ({"D2300": 0.30, "SINDEX2": 0.20}, 0.40, "F7 score without a dominant component"),
])
def test_station_name_comes_from_the_score_components(crism, ridge, expected):
    from pipeline.terrain import stations as ST

    words = {"D2300": "clay", "SINDEX2": "sulfate"}
    name, finding = ST.finding_name(crism, ridge, min_norm=0.5, index_words=words)
    assert name == expected
    # the finding states the numbers the name rests on, never a geological claim
    assert "D2300" in finding and "SINDEX2" in finding and "ridge density" in finding
    for bad in ("nodule", "boulder", "vein", "sulfur", "water", "ancient"):
        assert bad not in name.lower()


def test_station_extras_are_greedy_by_value_and_respect_every_filter():
    from pipeline.terrain import stations as ST

    #           0      1      2      3      4      5      6
    x = np.array([0.0, 100.0, 500.0, 900.0, 1300.0, 2000.0, 2600.0])
    y = np.zeros(7)
    value = np.array([0.9, 0.95, 0.7, 0.8, 0.6, 0.99, 0.5])
    eligible = np.array([True, True, True, True, True, False, True])  # 5: off focus/unwalkable
    placed = [(0.0, 400.0)]                                           # 500 m from 0, 412 from 1
    pick = ST.place_extras(x, y, value, eligible, placed, n_max=3, min_m=300.0)
    # 1 (0.95) first; 0 is 100 m from 1 -> out; 3 (0.8); 2 is 400 m from 3 and 400 from 1 -> ok
    assert pick == [1, 3, 2]
    pts = placed + [(x[i], y[i]) for i in pick]
    for i, a in enumerate(pts):
        for b in pts[i + 1:]:
            assert math.hypot(a[0] - b[0], a[1] - b[1]) >= 300.0
    assert ST.place_extras(x, y, value, np.zeros(7, bool), placed, 3, 300.0) == []
    assert len(ST.place_extras(x, y, value, eligible, [], n_max=2, min_m=300.0)) == 2


def test_stations_config_d26_d32():
    from pipeline.terrain import grid as G

    st = G.stations_cfg()
    assert st["scoring_weights"] == {"crism": 0.4, "ridge_density": 0.4, "manual": 0.2}
    assert st["scoring_weights_assumed"] is True                                 # D32
    assert st["min_spacing_m"] == 300                                            # D32
    assert st["extras"]["max"] == 3 and st["extras"]["manual_priority"] == 0
    assert {s["id"] for s in st["stations"] if s.get("status") == "dropped"} == {"S3", "S5"}


# ------------------------------------------- same-name compass suffix (D44, set A, user 17:28)


@pytest.mark.parametrize("bearing,expected", [
    (0.0, "north"), (22.49, "north"), (22.5, "north-east"), (45.0, "north-east"),
    (67.49, "north-east"), (67.5, "east"), (90.0, "east"), (135.0, "south-east"),
    (180.0, "south"), (225.0, "south-west"), (237.9, "south-west"), (247.49, "south-west"),
    (247.5, "west"), (270.0, "west"), (315.0, "north-west"), (337.49, "north-west"),
    (337.5, "north"), (359.99, "north"), (360.0, "north"), (-45.0, "north-west"),
])
def test_compass8_sectors_are_45_deg_centred_on_the_points(bearing, expected):
    from pipeline.terrain import stations as ST

    assert ST.compass8(bearing) == expected


@pytest.mark.parametrize("dx,dy,expected", [
    (0.0, 100.0, 0.0), (100.0, 0.0, 90.0), (0.0, -100.0, 180.0), (-100.0, 0.0, 270.0),
    (100.0, 100.0, 45.0), (-100.0, -100.0, 225.0),
])
def test_pad_bearing_is_clockwise_from_grid_north(dx, dy, expected):
    from pipeline.terrain import stations as ST

    pad = (1000.0, -2000.0)
    assert ST.bearing_deg(pad, pad[0] + dx, pad[1] + dy) == pytest.approx(expected)


def _st(sid, name, x, y):
    return {"id": sid, "name": name, "x": x, "y": y}


def test_compass_suffix_only_for_duplicated_names():
    from pipeline.terrain import stations as ST

    a = "dense ridge network + high SINDEX2 sulfate signal"
    recs = [_st("S1", "Boxwork ridge-hollow transect", 0.0, -500.0),
            _st("S6", a, 400.0, 400.0),             # north-east of the pad
            _st("S7", a, -300.0, 10.0),             # west
            _st("S8", "dense ridge network + high D2300 clay signal", 0.0, 900.0)]
    out = ST.add_compass_suffixes(recs, (0.0, 0.0))
    assert [r["name"] for r in out] == [
        "Boxwork ridge-hollow transect", f"{a} (north-east)", f"{a} (west)",
        "dense ridge network + high D2300 clay signal"]
    assert out[1]["name_base"] == a and out[1]["name_suffix"]["compass"] == "north-east"
    assert out[1]["name_suffix"]["bearing_deg"] == pytest.approx(45.0)
    assert "name_suffix" not in out[0] and "name_suffix" not in out[3]
    # only names and labels change: coordinates and ids untouched, input not mutated
    assert [(r["id"], r["x"], r["y"]) for r in out] == [(r["id"], r["x"], r["y"]) for r in recs]
    assert recs[1]["name"] == a


def test_compass_suffix_collision_is_broken_by_distance_from_the_pad():
    from pipeline.terrain import stations as ST

    a = "dense ridge network + high SINDEX2 sulfate signal"
    # today's S6/S7 geometry (pad rank1): both south-west, S6 ~1.28 km, S7 ~1.83 km
    two = ST.add_compass_suffixes([_st("S6", a, -1081.0, -678.0), _st("S7", a, -1681.0, -728.0)],
                                  (0.0, 0.0))
    assert [r["name"] for r in two] == [f"{a} (south-west, nearer)",
                                        f"{a} (south-west, farther)"]
    three = ST.add_compass_suffixes([_st("S6", a, -900.0, -900.0), _st("S7", a, -300.0, -300.0),
                                     _st("S8", a, -600.0, -600.0)], (0.0, 0.0))
    assert [r["name"] for r in three] == [f"{a} (south-west, farthest)",
                                          f"{a} (south-west, nearest)",
                                          f"{a} (south-west, 2nd nearest)"]
    assert len({r["name"] for r in three}) == 3
    # a distance tie falls back to the station id
    tie = ST.add_compass_suffixes([_st("S7", a, -500.0, -500.0), _st("S6", a, -500.0, -500.0)],
                                  (0.0, 0.0))
    assert [r["name"] for r in tie] == [f"{a} (south-west, farther)",
                                        f"{a} (south-west, nearer)"]


def test_compass_suffix_skips_unplaced_stations():
    from pipeline.terrain import stations as ST

    recs = [_st("S6", "x", None, None), _st("S7", "x", 0.0, 100.0)]
    out = ST.add_compass_suffixes(recs, (0.0, 0.0))
    assert out[0]["name"] == "x" and out[1]["name"] == "x"      # no duplicate among placed


def test_official_pad_comes_from_pad_json_with_site_fallback(tmp_path):
    import json

    from pipeline.terrain import stations as ST

    fallback = {"lon": 137.382, "lat": -4.806}
    p = tmp_path / "pad.json"
    p.write_text(json.dumps({"pad": {"id": "rank1", "lon": 137.401783, "lat": -4.77748},
                             "alternatives": [{"id": "rank2", "lon": 1.0, "lat": 2.0}]}))
    lon, lat, src = ST.official_pad(p, fallback)
    assert (lon, lat) == (137.401783, -4.77748)
    assert "pad.json" in src and "rank1" in src
    lon, lat, src = ST.official_pad(tmp_path / "missing.json", fallback)
    assert (lon, lat) == (137.382, -4.806) and "pad_default" in src


def test_stations_config_d44_final_list_and_assumptions():
    from pipeline.terrain import grid as G

    st = G.stations_cfg()
    ex = st["extras"]
    assert ex["assumed"] is True and ex["manual_priority"] == 0 and ex["name_min_norm"] == 0.5
    assert "D44" in st["placement"]["walkable"]
    assert ex["same_name_suffix"]["assumed"] is True
    text = (G.CONFIG / "stations.yaml").read_text()
    assert "19:00" not in text and "unless S" not in text

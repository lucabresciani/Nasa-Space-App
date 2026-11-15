"""Envelope, isochrone, band, headline and edge-cause tests on synthetic grids (SPEC F4, F5).

Output settings come from variants.yaml ``outputs`` (2 m simplification, 1..60 min, F5/D2).
"""

import math

import numpy as np
import pytest
from shapely.geometry import Point

from pipeline.engine import dijkstra, edges, envelope, geo, physio
from pipeline.engine.config import load
from pipeline.engine.graph import UNKNOWN
from pipeline.engine.synthetic import dummy_world, make_grid, plane

RES = 3.0
OUT = load("variants")["outputs"]
SIMPLIFY_M = float(OUT["simplify_tolerance_m"])
BUDGETS = list(OUT["band_budgets_min"])
ISO = OUT["isochrone_minutes"]
BUFFER_M = load("site")["coverage"]["source_edge_buffer_m"]
P_NOM = physio.params("nominal", suit_kg=104)
TAB = physio.grade_table(P_NOM)
V_LEVEL = physio.governor(P_NOM, 0.0)
LATTICE_MAX = 1.0 / math.cos(math.atan(0.5) / 2)


@pytest.fixture(scope="module")
def world():
    grid, pad, feats = dummy_world(RES)
    f = dijkstra.return_field(grid, TAB, pad)
    return grid, pad, feats, f


def _local(grid, pad, x, y):
    px, py = grid.xy_of_rc(*pad)
    return x - px, y - py


# ------------------------------------------------------------------ edge causes


def test_dummy_world_edge_causes(world):
    """Wall edge is 'slope', hole edge is 'data' (brief WS2 tests)."""
    grid, pad, feats, f = world
    lines = edges.edge_lines(grid, f.t_min, BUDGETS[0], BUFFER_M)
    hx, hy = feats["hole_c"]
    near_wall, near_hole = [], []
    for line, cause in lines:
        for x, y in line.coords:
            lx, ly = _local(grid, pad, x, y)
            if abs(lx - feats["wall_x"]) < 15 and abs(ly) < feats["wall_half_len"] - 10:
                near_wall.append(cause)
            if math.hypot(lx - hx, ly - hy) < feats["hole_r"] + 5:
                near_hole.append(cause)
    assert near_wall and set(near_wall) == {"slope"}
    assert near_hole and set(near_hole) == {"data"}


def test_dummy_world_physiology_edge(world):
    """A short budget ends in open terrain: physiology everywhere."""
    grid, _, _, f = world
    causes = {c for _, c in edges.edge_lines(grid, f.t_min, 3, BUFFER_M)}
    assert causes == {"physiology"}


def test_edges_contract(world):
    grid, _, _, f = world
    fc = edges.edges(grid, f.t_min, BUDGETS, BUFFER_M, SIMPLIFY_M)
    geo.validate(fc, "edges.schema.json")
    assert {ft["properties"]["cause"] for ft in fc["features"]} >= {"slope", "data"}


def test_source_boundary_buffer_is_data():
    """An edge stopped by physiology but within the buffer of unknown cells is 'data'."""
    n = 121
    state = np.zeros((n, n), np.uint8)
    state[:, 100:] = UNKNOWN
    g = make_grid(np.zeros((n, n)), RES, cellstate=state)
    f = dijkstra.return_field(g, TAB, (60, 60))
    budget = (100 - 60 - 4) * RES / V_LEVEL / 60  # stops ~4 cells (12 m) short of the strip
    lines = edges.edge_lines(g, f.t_min, budget, BUFFER_M)
    east = [c for ln, c in lines for x, _ in ln.coords if x > g.xy_of_rc(0, 94)[0]]
    assert east and set(east) == {"data"}


# ------------------------------------------------------------------ isochrones / bands


def test_isochrones_contract_and_nesting(world):
    grid, _, _, f = world
    fc = envelope.isochrones(grid, f.t_min, range(ISO["min"], ISO["max"] + 1), SIMPLIFY_M)
    geo.validate(fc, "isochrones.schema.json")
    mins = [ft["properties"]["minutes"] for ft in fc["features"]]
    assert mins == sorted(mins) and mins[0] == 1
    # nesting in the analysis CRS (allow the simplification tolerance)
    a10 = envelope.mask_polygon(grid, envelope.envelope_mask(f.t_min, 10), SIMPLIFY_M)
    a20 = envelope.mask_polygon(grid, envelope.envelope_mask(f.t_min, 20), SIMPLIFY_M)
    assert a10.difference(a20.buffer(SIMPLIFY_M + 0.01)).area < 1.0


def test_isochrone_hole_for_unknown(world):
    grid, pad, feats, f = world
    poly = envelope.mask_polygon(grid, envelope.envelope_mask(f.t_min, 25), SIMPLIFY_M)
    px, py = grid.xy_of_rc(*pad)
    hx, hy = feats["hole_c"]
    assert not poly.contains(Point(px + hx, py + hy))
    assert poly.contains(Point(px + hx, py + hy + feats["hole_r"] + 20))


def test_isochrone_radius_flat():
    """Flat plane: the 5-min polygon area ~ pi (v t)^2 within the lattice bound."""
    g = make_grid(plane(201, RES, 0.0), RES)
    f = dijkstra.return_field(g, TAB, (100, 100))
    poly = envelope.mask_polygon(g, envelope.envelope_mask(f.t_min, 5), SIMPLIFY_M)
    r = V_LEVEL * 300
    assert math.pi * (r / LATTICE_MAX) ** 2 * 0.97 <= poly.area <= math.pi * (r + RES) ** 2


def test_bands_contract(world):
    grid, _, _, f = world
    fc = envelope.bands(grid, {"nominal": f.t_min, "conservative": f.t_min + 1}, BUDGETS,
                        SIMPLIFY_M)  # fmt: skip
    geo.validate(fc, "bands.schema.json")
    assert len(fc["features"]) == 4


def test_lonlat_output_near_pad(world):
    grid, pad, _, f = world
    fc = envelope.isochrones(grid, f.t_min, [1], SIMPLIFY_M)
    lon, lat = np.array(fc["features"][0]["geometry"]["coordinates"][0]).T
    site = load("site")["pad_default"]
    assert abs(lon.mean() - site["lon"]) < 0.002 and abs(lat.mean() - site["lat"]) < 0.002
    s = str(fc["features"][0]["geometry"]["coordinates"][0][0][0])
    assert len(s.split(".")[1]) <= 6


# ------------------------------------------------------------------ headline


def test_headline_flat_full():
    """Flat plane, disc at the governor speed: reachable % in [100/1.0275^2, 100]."""
    g = make_grid(plane(201, RES, 0.0), RES)
    f = dijkstra.return_field(g, TAB, (100, 100))
    pct = envelope.reachable_pct(g, f.t_min, (100, 100), 4, V_LEVEL)
    assert 100 / LATTICE_MAX**2 - 2 <= pct <= 100


def test_headline_excludes_unknown():
    n = 201
    state = np.zeros((n, n), np.uint8)
    rr, cc = np.indices((n, n))
    state[np.hypot(rr - 100, cc - 140) <= 15] = UNKNOWN
    g0 = make_grid(np.zeros((n, n)), RES)
    g1 = make_grid(np.zeros((n, n)), RES, cellstate=state)
    p0 = envelope.reachable_pct(g0, dijkstra.return_field(g0, TAB, (100, 100)).t_min,
                                (100, 100), 4, V_LEVEL)  # fmt: skip
    p1 = envelope.reachable_pct(g1, dijkstra.return_field(g1, TAB, (100, 100)).t_min,
                                (100, 100), 4, V_LEVEL)  # fmt: skip
    # The hole is left out of the denominator; only its shadow lowers the percentage a little.
    assert p1 == pytest.approx(p0, abs=4)


def test_headline_contract_shape(world):
    grid, pad, _, f = world
    speed = load("crew")["anchor"]["speed_ms"]
    h = envelope.headline(
        grid, {"nominal": f.t_min, "conservative": f.t_min * 1.2, "optimistic": f.t_min * 0.9},
        pad, 10, speed,
    )  # fmt: skip
    lo, hi = h["range_pct"]
    assert lo <= h["reachable_pct"] <= hi
    # a disc running off the grid gives None, never a wrong number
    assert envelope.reachable_pct(grid, f.t_min, pad, 30, speed) is None


def test_d41_in_data_share_known_answer():
    """D41 (user 17:22): a disc that leaves the grid gives the share over its part inside the
    terrain data, plus that part's size. Pad on the west edge (col 0), radius 30 cells: the
    in-grid part is the half-disc incl. the centre column (61 cells): (N + 61) / 2 of the full
    disc's N cells. Reachable = every in-grid disc cell with col >= 1: (N - 61) / 2 cells."""
    n, res = 101, 3.0
    g = make_grid(np.zeros((n, n)), res)
    pad = (50, 0)
    radius_m = 30 * res
    speed = radius_m / 60.0  # 1-min disc of 30 cells
    full = sum(1 for dr in range(-30, 31) for dc in range(-30, 31) if np.hypot(dr, dc) <= 30)
    t = np.zeros((n, n))
    t[:, 0] = np.inf  # the centre column is not reachable
    assert envelope.reachable_pct(g, t, pad, 1, speed) is None  # strict rule unchanged
    share = envelope.reachable_pct(g, t, pad, 1, speed, in_data=True)
    assert share == pytest.approx(100.0 * (full - 61) / (full + 61))
    assert envelope.disc_in_data_pct(g, pad, 1, speed) == pytest.approx(
        100.0 * (full + 61) / 2 / full)
    # a disc fully inside: 100 % in data, same share as the strict rule
    t2 = np.zeros((n, n))
    assert envelope.disc_in_data_pct(g, (50, 50), 1, speed) == pytest.approx(100.0)
    assert envelope.reachable_pct(g, t2, (50, 50), 1, speed, in_data=True) == \
        envelope.reachable_pct(g, t2, (50, 50), 1, speed) == pytest.approx(100.0)
    # unknown cells are not terrain data: out of the share and out of the in-data part
    state = np.zeros((n, n), np.uint8)
    state[:, 25:] = UNKNOWN
    gu = make_grid(np.zeros((n, n)), res, cellstate=state)
    rr, cc = np.indices((n, n))
    disc = (np.hypot(rr - 50, cc) <= 30)
    known = disc & (cc < 25)
    assert envelope.disc_in_data_pct(gu, pad, 1, speed) == pytest.approx(
        100.0 * known.sum() / full)
    assert envelope.reachable_pct(gu, t, pad, 1, speed, in_data=True) == pytest.approx(
        100.0 * (known & (cc >= 1)).sum() / known.sum())


def test_d41_headline_entry():
    """scenarios.headline_entry: strict when the disc is inside the grid (basis full_disc),
    the in-data share with in_data_pct and the label when it leaves it (basis in_data)."""
    from pipeline.engine import scenarios

    n, res = 101, 3.0
    g = make_grid(np.zeros((n, n)), res)
    speed = 30 * res / 60.0
    t = np.zeros((n, n))
    t[:, 0] = np.inf
    e = scenarios.headline_entry(g, t, t * 2, t * 0.5, (50, 0), 1, speed, in_data=True)
    assert e["basis"] == "in_data" and e["budget_min"] == 1
    assert e["reachable_pct"] == round(envelope.reachable_pct(g, t, (50, 0), 1, speed,
                                                              in_data=True), 1)  # fmt: skip
    assert e["in_data_pct"] == round(envelope.disc_in_data_pct(g, (50, 0), 1, speed), 1)
    assert e["label"] == f"{e['in_data_pct']:.1f} % of the circle lies inside the terrain data"
    assert len(e["range_pct"]) == 2
    f = scenarios.headline_entry(g, t, t, t, (50, 50), 1, speed, in_data=True)
    assert scenarios.headline_entry(g, t, t, t, (50, 0), 1, speed)["reachable_pct"] is None
    assert f["basis"] == "full_disc" and f["in_data_pct"] == 100.0 and f["label"] is None


# ------------------------------------------------- display size filter (C decision 11:42)


def test_display_hole_threshold_from_config():
    assert OUT["display_min_hole_m2"] == 100


def test_isochrone_drops_holes_below_threshold():
    """Flat plane, two blocked islands inside the 10-min contour: 2 x 2 cells (36 m2) and
    5 x 5 cells (225 m2). With the 100 m2 display filter only the 225 m2 hole is kept;
    without it both are holes. Routing (T_home) is unchanged."""
    from shapely.geometry import shape

    n = 121
    state = np.zeros((n, n), np.uint8)
    ms = np.zeros((n, n))
    ms[40:42, 40:42] = 35.0  # 36 m2
    ms[70:75, 70:75] = 35.0  # 225 m2
    g = make_grid(np.zeros((n, n)), RES, cellstate=state, maxslope=ms)
    f = dijkstra.return_field(g, TAB, (60, 60))
    full = envelope.isochrones(g, f.t_min, [10], SIMPLIFY_M)
    shown = envelope.isochrones(g, f.t_min, [10], SIMPLIFY_M, min_hole_m2=100.0)
    holes = lambda fc: len(shape(fc["features"][0]["geometry"]).interiors)  # noqa: E731
    assert holes(full) == 2 and holes(shown) == 1
    assert np.isinf(f.t_min[40, 40]) and np.isinf(f.t_min[72, 72])


def test_edges_merged_per_budget_and_cause(world):
    """Edge pieces are merged into one MultiLineString per (budget, cause): same total length
    (lossless), one feature per pair."""
    grid, pad, _, f = world
    from shapely.geometry import shape

    from pipeline.engine.geo import validate

    fc = edges.edges(grid, f.t_min, BUDGETS, BUFFER_M, SIMPLIFY_M)
    validate(fc, "edges.schema.json")
    keys = [(x["properties"]["budget"], x["properties"]["cause"]) for x in fc["features"]]
    assert len(keys) == len(set(keys))
    pieces = edges.edge_lines(grid, f.t_min, BUDGETS[0], BUFFER_M)
    n_pieces = {c: sum(1 for _, cc in pieces if cc == c) for c in edges.CAUSES}
    for ft in fc["features"]:
        if ft["properties"]["budget"] == BUDGETS[0]:
            g = shape(ft["geometry"])
            n = len(g.geoms) if g.geom_type == "MultiLineString" else 1
            assert n == n_pieces[ft["properties"]["cause"]]

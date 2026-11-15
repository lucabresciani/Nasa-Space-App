"""P3 / WS16: pipeline/export/contours.py, overlays.py, highlights.py (DESIGN §6.1, U7, §5.4).

Known-answer tests on synthetic grids (contour positions, slope classes, rough mask, mode
downsampling, tile sampling, mineral image, ridge / mineral / blocked polygons), determinism,
the frozen highlights contract (contracts/highlights.schema.json, preliminary flag per R9), and the
committed web files: budget (performance.overlays_mb), contour levels and focus extent, the tile
scheme of the elevation tiles, config-backed thresholds and the manifest rows.
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path

import numpy as np
import pytest
import yaml
from jsonschema import Draft202012Validator
from PIL import Image

from pipeline.export import contours as C
from pipeline.export import highlights as H
from pipeline.export import overlays as O
from pipeline.export import terrain_tiles as T

REPO = Path(__file__).resolve().parents[1]
PUBLIC = REPO / "web" / "public" / "data"
SCHEMA = json.loads((REPO / "contracts" / "highlights.schema.json").read_text())
DESIGN = yaml.safe_load((REPO / "config" / "design.yaml").read_text())
SITE = yaml.safe_load((REPO / "config" / "site.yaml").read_text())
OV = DESIGN["overlays"]
MIB = 2 ** 20
FOCUS = [SITE["aoi_focus"][k] for k in ("west", "south", "east", "north")]


def validate(doc: dict) -> list[str]:
    return [e.message for e in Draft202012Validator(SCHEMA).iter_errors(doc)]


# --------------------------------------------------------------------- contours (synthetic)


def test_contours_on_a_ramp_are_straight_lines_at_the_right_x():
    # z = x (m): 1 m grid, pixel centres at x0 + (c + 0.5); 10 m levels are N-S lines at x = level
    w, h = 120, 40
    x0, y0 = 0.0, 1000.0
    xc = x0 + np.arange(w) + 0.5
    z = np.broadcast_to(xc[None, :], (h, w)).astype("float32")
    lines = C.contour_lines(z, x0, y0, 1.0, minor=10, simplify_m=1.0)
    levels = sorted({lv for lv, _ in lines})
    assert levels == [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110]
    for lv, ln in lines:
        xs = np.asarray(ln.coords)[:, 0]
        assert np.allclose(xs, lv, atol=1e-6)
        assert len(ln.coords) == 2  # a straight line simplifies to its end points


def test_contour_index_flag_every_50_m_including_negative_heights():
    assert C.is_index(-4000, 50) and C.is_index(-3950, 50) and not C.is_index(-3990, 50)
    assert C.is_index(0, 50) and not C.is_index(10, 50)


def test_contours_skip_nodata():
    z = np.full((30, 30), np.nan, "float32")
    assert C.contour_lines(z, 0.0, 30.0, 1.0, minor=10, simplify_m=1.0) == []


def test_contours_collection_deterministic():
    yy, xx = np.mgrid[0:60, 0:60]
    z = (np.hypot(xx - 30, yy - 30) * 2.0 - 4000).astype("float32")
    a = C.collection(C.contour_lines(z, 0.0, 0.0, 1.0, minor=10, simplify_m=1.0),
                     index=50, meta={"interval_m": 10})
    b = C.collection(C.contour_lines(z, 0.0, 0.0, 1.0, minor=10, simplify_m=1.0),
                     index=50, meta={"interval_m": 10})
    assert O.dumps(a) == O.dumps(b)
    assert a["type"] == "FeatureCollection" and a["features"]
    for f in a["features"]:
        assert f["geometry"]["type"] == "LineString"
        p = f["properties"]
        assert p["elev_m"] % 10 == 0 and p["index"] == (p["elev_m"] % 50 == 0)


# ------------------------------------------------------------- slope classes, rough, tiles


def test_slope_classes_match_config_breaks_and_the_nogo_rule():
    breaks = OV["slope_classes_deg"]
    assert breaks == [0, 10, 17, 20]
    s = np.array([0.0, 5, 10, 10.01, 17, 17.5, 20, 20.01, 45, np.nan])
    got = O.classify_slope(s, breaks)
    # blocked iff slope > nogo (D22): exactly 20 deg is still class 2 (17-20)
    assert got.tolist() == [0, 0, 0, 1, 1, 2, 2, 3, 3, O.UNKNOWN]


def test_rough_mask_is_max_slope_above_the_configured_variant_nogo():
    nogo = SITE["slope"]["nogo_deg"][OV["rough_footing_variant"]]
    m = O.rough_mask(np.array([nogo - 1, nogo, nogo + 0.01, np.nan]), nogo)
    assert m.tolist() == [0, 0, 1, O.UNKNOWN]


def test_mode_downsample_ties_go_to_the_higher_class():
    a = np.array([[0, 0, 1, 1],
                  [0, 1, 3, 3],
                  [2, 2, 3, 0],
                  [2, O.UNKNOWN, O.UNKNOWN, 0]], np.uint8)
    got = O.mode_level(a, 2, n_classes=4)
    assert got.tolist() == [[0, 3], [2, 0]]  # [0,0,0,1] -> 0; [1,1,3,3] tie -> 3; ...
    allu = np.full((2, 2), O.UNKNOWN, np.uint8)
    assert O.mode_level(allu, 2, n_classes=4).tolist() == [[O.UNKNOWN]]


def test_class_grid_samples_the_cell_under_each_tile_pixel():
    # a 3 m grid in the analysis CRS around the pad: west half class 1, east half class 3
    px_, py_ = (float(v) for v in T.xy_of_lonlat(SITE["pad_default"]["lon"],
                                                 SITE["pad_default"]["lat"]))
    a = np.full((200, 200), 1, np.uint8)
    a[:, 100:] = 3
    g = O.ClassGrid(a, px_ - 300.0, py_ + 300.0, 3.0, n_classes=4)
    lon_w, lat = T.lonlat_of_xy(px_ - 30.0, py_)
    lon_e, _ = T.lonlat_of_xy(px_ + 30.0, py_)
    lon_out, _ = T.lonlat_of_xy(px_ + 900.0, py_)
    got = g.sample(np.array([float(lon_w), float(lon_e), float(lon_out)]),
                   np.array([float(lat)] * 3), px_m=1.0)
    assert got.tolist() == [1, 3, O.UNKNOWN]


def test_indexed_png_palette_and_transparency():
    idx = np.array([[0, 1], [2, O.UNKNOWN]], np.uint8)
    pal = [None, (61, 214, 140), (251, 146, 60)]
    png = O.encode_indexed_png(idx, pal)
    im = Image.open(io.BytesIO(png))
    assert im.mode == "P"
    rgba = np.asarray(im.convert("RGBA"))
    assert rgba[0, 0, 3] == 0 and rgba[1, 1, 3] == 0          # class 0 "none", unknown
    assert tuple(rgba[0, 1]) == (61, 214, 140, 255)
    assert tuple(rgba[1, 0]) == (251, 146, 60, 255)
    assert O.encode_indexed_png(idx, pal) == png              # deterministic bytes


def test_tile_palette_colours_come_from_tokens():
    tok = json.loads((REPO / "web" / "src" / "ui" / "tokens.json").read_text())["color"]
    pal = O.palettes()
    assert pal["slope_class"]["tokens"] == [None, "safe", "caution", "limit"]
    assert pal["slope_class"]["rgb"][3] == O.hex_rgb(tok["limit"])  # > 20 deg in `limit` (U7)
    assert pal["rough"]["rgb"][1] == O.hex_rgb(tok[pal["rough"]["tokens"][1]])
    assert O.mineral_colour() == O.hex_rgb(tok["science"])


# ------------------------------------------------------------------------- mineral image


def test_mineral_image_alpha_is_normalised_strength():
    v = np.array([[np.nan, 0.0, 0.5], [1.0, 2.0, -1.0]], "float32")
    rgba = O.mineral_rgba(v, 0.0, 1.0, (96, 165, 250))
    assert rgba.shape == (2, 3, 4)
    assert rgba[..., 3].tolist() == [[0, 0, 128], [255, 255, 0]]
    assert (rgba[0, 2, :3] == (96, 165, 250)).all()


def test_raster_corners_are_the_lonlat_rectangle_of_the_grid():
    px_, py_ = (float(v) for v in T.xy_of_lonlat(137.38, -4.80))
    c = O.raster_corners(px_, py_, 18.0, 10, 5)
    (w, n), (e, n2), (e2, s), (w2, s2) = c
    assert n == n2 and e == e2 and s == s2 and w == w2
    lon_e, lat_s = T.lonlat_of_xy(px_ + 180.0, py_ - 90.0)
    assert math.isclose(w, 137.38, abs_tol=1e-6) and math.isclose(n, -4.80, abs_tol=1e-6)
    assert math.isclose(e, float(lon_e), abs_tol=1e-6)
    assert math.isclose(s, float(lat_s), abs_tol=1e-6)


# ------------------------------------------------------------------------ highlights (KATs)


def _geo_origin():
    return (float(v) for v in T.xy_of_lonlat(SITE["pad_default"]["lon"],
                                             SITE["pad_default"]["lat"]))


def test_skeleton_length_straight_and_diagonal():
    m = np.zeros((20, 40), bool)
    m[5, 3:33] = True                          # 30 px horizontal
    lab = (m * 1).astype(np.int32)
    assert H.skeleton_length(m, lab, 1, 1.0)[1] == pytest.approx(29.0)
    d = np.zeros((30, 30), bool)
    d[np.arange(20), np.arange(20)] = True     # 20 px diagonal
    assert H.skeleton_length(d, d.astype(np.int32), 1, 1.0)[1] == pytest.approx(19 * math.sqrt(2))


def test_ridges_keep_connected_ridges_at_least_min_length():
    x0, y0 = _geo_origin()
    r = np.zeros((40, 60), "float32")
    r[10, 5:40] = 2.0          # 35 m ridge, relief 2.0 m
    r[11, 5:40] = 1.0
    r[30, 50:54] = 3.0         # 4 m blob: shorter than the min length
    r[0, 0] = np.nan
    feats = H.ridge_features(r, x0, y0, 1.0, threshold=0.75, min_length_m=15, simplify_m=1.0)
    assert len(feats) == 1
    p = feats[0]["properties"]
    assert p["relief_m"] == pytest.approx(2.0)
    assert 33.0 <= p["length_m"] <= 35.0
    assert p["area_m2"] == pytest.approx(70.0)
    assert p["id"] == "R1"


def test_mineral_patches_above_threshold_with_type_and_strength():
    x0, y0 = _geo_origin()
    v = np.zeros((20, 20), "float32")
    v[2:4, 2:4] = 0.021         # 4 cells (float32 0.02 / 0.02 rounds below 1)
    v[2, 2] = 0.03
    v[15, 15] = 0.025           # 1 cell
    v[10, 10] = np.nan
    feats = H.mineral_features(v, x0, y0, 18.0, kind="sulfate", lo=0.0, hi=0.02,
                               threshold_norm=1.0, simplify_m=1.0)
    assert len(feats) == 2
    big = max(feats, key=lambda f: f["properties"]["area_m2"])["properties"]
    assert big["type"] == "sulfate"
    assert big["strength"] == pytest.approx((0.03 + 3 * 0.021) / 4, rel=1e-5)
    assert big["strength_max"] == pytest.approx(0.03, rel=1e-5)
    assert big["area_m2"] == pytest.approx(4 * 18 * 18)


def test_blocked_reasons_and_area():
    x0, y0 = _geo_origin()
    state = np.zeros((12, 12), np.uint8)
    slope = np.full((12, 12), 5.0, "float32")
    guard = np.zeros((12, 12), np.uint8)
    state[1:3, 1:3] = 1                     # slope only, 4 cells
    slope[1:3, 1:3] = 25.0
    state[6, 6] = 1                         # step guard only, 1 cell
    guard[6, 6] = 1
    state[9, 1:4] = 1                       # mixed, 3 cells
    slope[9, 1] = 30.0
    guard[9, 2:4] = 1
    feats = H.blocked_features(state, slope, guard, x0, y0, 3.0, nogo=20.0, simplify_m=1.0)
    by = sorted((f["properties"]["reason"], f["properties"]["area_m2"]) for f in feats)
    assert by == [("mixed", 27.0), ("slope_class", 36.0), ("step_guard", 9.0)]


def test_highlight_collections_validate_and_say_preliminary():
    x0, y0 = _geo_origin()
    r = np.zeros((30, 40), "float32")
    r[10, 2:30] = 2.0
    ridges = H.collection("ridges", H.ridge_features(r, x0, y0, 1.0, threshold=0.75,
                                                      min_length_m=15, simplify_m=1.0),
                          H.threshold_info("ridges"))
    assert ridges["preliminary"] is True
    assert validate(ridges) == []
    blocked = H.collection("blocked", [], None, variant="nominal")
    assert validate(blocked) == []


def test_preliminary_thresholds_come_from_config_while_r9_open():
    t = H.threshold_info("ridges")
    if OV["ridge_index_threshold_m"] is None:
        assert t["preliminary"] is True
        assert t["value"] == OV["preliminary"]["ridge_index_threshold_m"]
        assert t["name"] == "overlays.preliminary.ridge_index_threshold_m"
    m = H.threshold_info("mineral")
    if OV["mineral_threshold"] is None:
        assert m["preliminary"] is True
        assert m["value"] == OV["preliminary"]["mineral_threshold"]


# ----------------------------------------------------------------- committed web files


def _committed(rel: str) -> Path:
    p = PUBLIC / rel
    if not p.exists():
        pytest.skip(f"{rel} not published yet")
    return p


def test_budget_overlays_and_highlights():
    total = sum(p.stat().st_size for d in ("overlays", "highlights") if (PUBLIC / d).exists()
                for p in (PUBLIC / d).rglob("*") if p.is_file())
    assert total <= DESIGN["performance"]["overlays_mb"] * MIB
    for d in ("overlays", "highlights"):
        for p in (PUBLIC / d).rglob("*") if (PUBLIC / d).exists() else []:
            assert p.stat().st_size < 50 * 10 ** 6


def test_committed_highlights_valid_against_frozen_schema():
    for kind in ("ridges", "mineral", "blocked"):
        doc = json.loads(_committed(f"highlights/{kind}.geojson").read_text())
        assert validate(doc) == [], kind
        assert doc["kind"] == kind
        if kind != "blocked":
            assert doc["preliminary"] is (OV[{"ridges": "ridge_index_threshold_m",
                                              "mineral": "mineral_threshold"}[kind]] is None)
            assert doc["features"], kind
        ids = [f["properties"]["id"] for f in doc["features"]]
        assert len(ids) == len(set(ids))


def test_committed_contours_levels_flags_and_focus_extent():
    doc = json.loads(_committed("overlays/contours.geojson").read_text())
    cm = OV["contours_m"]
    assert doc["interval_m"] == cm["minor"] and doc["index_m"] == cm["index"]
    assert doc["simplify_m"] == OV["simplify_m"]
    assert doc["features"]
    w, s, e, n = FOCUS
    eps = 1e-4
    for f in doc["features"]:
        p = f["properties"]
        assert p["elev_m"] % cm["minor"] == 0
        assert p["index"] == (p["elev_m"] % cm["index"] == 0)
        xy = np.asarray(f["geometry"]["coordinates"])
        assert (xy[:, 0] >= w - eps).all() and (xy[:, 0] <= e + eps).all()
        assert (xy[:, 1] >= s - eps).all() and (xy[:, 1] <= n + eps).all()


def test_committed_overlay_index_tiles_and_mineral_bounds():
    idx = json.loads(_committed("overlays/index.json").read_text())
    tt = DESIGN["terrain_tiles"]
    for name in ("slope_class", "rough"):
        ts = idx[name]
        assert ts["scheme"] == "xyz" and ts["tile_px"] == tt["tile_px"]
        assert [ts["minzoom"], ts["maxzoom"]] == tt["zooms_planning_extent"]
        files = sorted((PUBLIC / "overlays" / name).rglob("*.png"))
        assert sum(ts["tile_count"].values()) == len(files) > 0
        for z in range(ts["minzoom"], ts["maxzoom"] + 1):
            want = set(T.tiles_covering(ts["bounds"], z))
            got = {(int(p.parent.name), int(p.stem)) for p in files
                   if p.parent.parent.name == str(z)}
            assert got == want
    assert idx["slope_class"]["breaks_deg"] == OV["slope_classes_deg"]
    for kind in ("sulfate", "clay"):
        m = idx[f"mineral_{kind}"]
        im = Image.open(_committed(m["image"]))
        assert im.mode == "RGBA" and m["res_m"] == 18
        (w, n), (e, _), (_, s), _ = m["coordinates"]
        assert w < e and s < n
        lo, hi = m["norm_range"]
        assert lo < hi


def test_manifest_rows_for_legends():
    mf = PUBLIC / "manifest.json"
    if not (PUBLIC / "overlays" / "index.json").exists():
        pytest.skip("overlays not published yet")
    man = json.loads(mf.read_text())
    assert man["overlays.slope_class.breaks_deg"]["value"] == OV["slope_classes_deg"]
    assert man["overlays.contours.interval_m"]["value"] == OV["contours_m"]["minor"]
    idx = json.loads((PUBLIC / "overlays" / "index.json").read_text())
    for kind in ("sulfate", "clay"):
        assert man[f"overlays.mineral_{kind}.norm_range"]["value"] == \
            idx[f"mineral_{kind}"]["norm_range"]

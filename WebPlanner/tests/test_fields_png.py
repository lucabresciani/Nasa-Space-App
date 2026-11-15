"""WS7 known-answer tests: field PNG encoding (SPEC §6.1, §9), sampling and worst-case fields.

Encoding (contracts/README.md, config/hud.yaml ``field_png``): counts = round(value / scale),
R = counts >> 8, G = counts & 255, B = 0, A = 255 valid / 0 unknown.
"""

from __future__ import annotations

import io
import json
import re
from pathlib import Path

import numpy as np
import pytest
import yaml
from jsonschema import Draft202012Validator
from PIL import Image

from pipeline.export import fields_png as fp
from pipeline.export import worstcase as wc

REPO = Path(__file__).resolve().parent.parent
HUD = yaml.safe_load((REPO / "config" / "hud.yaml").read_text())
VARIANTS = yaml.safe_load((REPO / "config" / "variants.yaml").read_text())
DUMMY = REPO / "web" / "public" / "data-dummy"
SCHEMA = json.loads((REPO / "contracts" / "fields_index.schema.json").read_text())
INTERIM = REPO / "data" / "interim"


# ------------------------------------------------------------------------- encode / decode ----
@pytest.mark.parametrize("name", sorted(HUD["field_scales"]))
def test_round_trip_exact_to_one_count(name):
    scale = HUD["field_scales"][name]["per_count"]
    rng = np.random.default_rng(7)
    vals = rng.uniform(0, fp.MAX_COUNTS * scale, size=(37, 53))
    vals[0, 0], vals[0, 1] = 0.0, fp.MAX_COUNTS * scale  # both ends of the range
    out = fp.decode_png(fp.encode_png(vals, scale), scale)
    assert np.all(np.isfinite(out))
    assert np.all(np.abs(out - vals) <= scale / 2 + 1e-9 * fp.MAX_COUNTS * scale)
    assert np.array_equal(np.rint(out / scale), np.rint(vals / scale))


def test_rgba_layout():
    rgba = fp.encode_rgba(np.array([[0.0, 0.1, 25.6, 6553.5]]), 0.1)  # counts 0, 1, 256, 65535
    assert rgba[0, :, 0].tolist() == [0, 0, 1, 255]
    assert rgba[0, :, 1].tolist() == [0, 1, 0, 255]
    assert rgba[0, :, 2].tolist() == [0, 0, 0, 0]
    assert rgba[0, :, 3].tolist() == [255, 255, 255, 255]


def test_unknown_cells_decode_as_unknown():
    vals = np.array([[1.0, np.nan], [np.inf, -np.inf]])
    rgba = fp.encode_rgba(vals, 0.01)
    assert rgba[..., 3].tolist() == [[255, 0], [0, 0]]
    assert rgba[0, 1].tolist() == [0, 0, 0, 0]
    out = fp.decode_rgba(rgba, 0.01)
    assert out[0, 0] == pytest.approx(1.0)
    assert np.isnan(out[0, 1]) and np.isnan(out[1, 0]) and np.isnan(out[1, 1])


def test_png_is_8bit_rgba():
    img = Image.open(io.BytesIO(fp.encode_png(np.zeros((4, 5)), 0.1)))
    assert img.mode == "RGBA" and img.size == (5, 4)


def test_out_of_range_refused_not_clipped():
    with pytest.raises(ValueError):
        fp.encode_png(np.array([[-1.0]]), 0.1)
    with pytest.raises(ValueError):
        fp.encode_png(np.array([[6553.6]]), 0.1)  # 65536 counts
    out = fp.decode_png(fp.encode_png(np.array([[-1.0, 7000.0]]), 0.1, clip=True), 0.1)
    assert out.tolist() == [[0.0, pytest.approx(6553.5)]]


def test_half_count_rounding_matches_numpy_rint():
    out = fp.decode_png(fp.encode_png(np.array([[0.5, 1.5, 2.5, 2.5001]]), 1.0), 1.0)
    assert out.tolist() == [[0.0, 2.0, 2.0, 3.0]]


def test_same_pixels_as_dummy_generator():
    md = pytest.importorskip("tools.make_dummy")
    rng = np.random.default_rng(3)
    vals = rng.uniform(0, 300, size=(64, 64))
    vals[5:9, 5:9] = np.nan
    a = fp.decode_png(fp.encode_png(vals, 0.1), 0.1)
    b = fp.decode_png(md.encode_png(vals, 0.1), 0.1)
    np.testing.assert_array_equal(a, b)


def test_field_scale_lookup_from_config():
    assert fp.field_scale("t_home", HUD) == (0.1, "min")
    assert fp.field_scale("t_home_worst_50", HUD) == (0.1, "min")
    assert fp.field_scale("o2_home_worst_100", HUD) == (0.01, "L")
    assert fp.field_scale("home_bearing", HUD) == (0.01, "deg")
    assert fp.field_scale("fix_interval_medium", HUD) == (1, "m")
    assert fp.field_scale("slope", HUD) == (0.01, "deg")
    with pytest.raises(KeyError):
        fp.field_scale("no_such_field", HUD)


def test_write_field_and_index_validate(tmp_path):
    vals = np.full((3, 4), 12.3)
    vals[0, 0] = np.nan
    frag = tmp_path / "manifest"
    entry = fp.write_field(tmp_path, "nom_104/t_home", vals, "nom_104", HUD,
                           manifest_fragment_dir=frag)
    assert entry == {"file": "fields/nom_104/t_home.png", "scale": 0.1, "units": "min",
                     "scenario": "nom_104"}
    out = fp.decode_png((tmp_path / entry["file"]).read_bytes(), entry["scale"])
    assert np.isnan(out[0, 0]) and out[1, 1] == pytest.approx(12.3)
    idx = fp.build_index([137.3, -4.9, 137.5, -4.7], 4, 3, HUD["field_png"]["res_m"],
                         {"nom_104/t_home": entry}, dummy=False)
    Draft202012Validator(SCHEMA).validate(idx)
    m = json.loads(next(frag.glob("*.json")).read_text())
    assert m["fields.nom_104/t_home.max"]["value"] == pytest.approx(12.3)
    assert m["fields.nom_104/t_home.max"]["units"] == "min"
    assert m["fields.nom_104/t_home.max"]["file"] == "fields/nom_104/t_home.png"
    assert m["fields.nom_104/t_home.known_pct"]["value"] == pytest.approx(100 * 11 / 12, abs=0.01)
    import hashlib
    assert m["fields.nom_104/t_home.sha256"]["value"] == hashlib.sha256(
        (tmp_path / entry["file"]).read_bytes()).hexdigest()


def test_write_field_file_key_and_refuses_wrong_shape(tmp_path):
    e = fp.write_field(tmp_path, "slope", np.zeros((2, 2)), None, HUD, file_key="shared/slope",
                       record_manifest=False)
    assert e["file"] == "fields/shared/slope.png" and (tmp_path / e["file"]).exists()
    with pytest.raises(ValueError):
        fp.write_field(tmp_path, "nom_104/t_home", np.zeros(5), "nom_104", HUD,
                       record_manifest=False)


# ---------------------------------------------- committed dummy PNGs (TS decoder KAT source) ----
# Mirrored in web/src/hud/fields.test.ts; both decoders must agree exactly.
DUMMY_PIXELS = [
    # (index key, row, col, expected value) on the 1481 x 1481 dummy grid
    ("nom_104/t_home", 740, 740, 0.0),        # the pad: T_home = 0
    ("nom_104/t_home", 620, 740, 11.1),       # S1, 600 m north (timeline t_home_min 11.1)
    ("nom_104/o2_home", 620, 740, 2.78),      # 0.25 L/min x 11.1 min
    ("slope", 740, 740, 2.85),                # dummy 5% plane less the hill, as stored
    ("nom_104/home_bearing", 620, 740, 180.0),  # S1 is due north of the pad
    ("nom_104/t_home_worst_50", 620, 740, 12.0),
]


@pytest.mark.skipif(not (DUMMY / "fields" / "index.json").exists(), reason="no dummy tree")
@pytest.mark.parametrize(("key", "row", "col", "expected"), DUMMY_PIXELS)
def test_decode_committed_dummy_pixels(key, row, col, expected):
    idx = json.loads((DUMMY / "fields" / "index.json").read_text())
    f = idx["fields"][key]
    arr = fp.decode_png((DUMMY / f["file"]).read_bytes(), f["scale"])
    assert arr.shape == (idx["height"], idx["width"])
    assert arr[row, col] == pytest.approx(expected, abs=1e-9)


@pytest.mark.skipif(not (DUMMY / "fields" / "index.json").exists(), reason="no dummy tree")
def test_dummy_hole_is_unknown():
    idx = json.loads((DUMMY / "fields" / "index.json").read_text())
    f = idx["fields"]["nom_104/t_home"]
    arr = fp.decode_png((DUMMY / f["file"]).read_bytes(), f["scale"])
    assert np.isnan(arr[740 + 71, 740 + 71])  # nodata hole, 500 m SE


def test_ts_decoder_kat_mirrors_python_pixels():
    ts = (REPO / "web" / "src" / "hud" / "fields.test.ts").read_text()
    rows = re.findall(r"\['([\w/]+)', (\d+), (\d+), ([\d.]+)\]", ts)
    got = [(k, int(r), int(c), float(v)) for k, r, c, v in rows]
    assert got == [(k, r, c, float(v)) for k, r, c, v in DUMMY_PIXELS]


# -------------------------------------------------------------------------------- sampling ----
def test_sample_3m_to_5m_centre_cell_and_ties():
    # 3 m source with value = 10 * col + row/100 (unique per cell); target 5 m grid offset 2 m
    # east and 2 m south of the source NW corner (the real fields_5m vs route_3m layout).
    hs = ws = 30
    src = (10.0 * np.arange(ws)[None, :] + np.arange(hs)[:, None] / 100.0)
    out = fp.sample_centres(src, (0.0, 0.0), 3.0, (2.0, -2.0), 5.0, (16, 16))
    # centres at 4.5 + 5k m -> 1.5, 3.17, 4.83, 6.5, 8.17 cells: never on a 3 m edge
    assert [int(out[1, c] // 10) for c in range(5)] == [1, 3, 4, 6, 8]
    # rows: same lattice going south; row 0 -> cell 1, row 1 -> cell 3
    assert round(out[0, 1] % 10 * 100) == 1 and round(out[1, 1] % 10 * 100) == 3


def test_sample_tie_ignores_unknown_and_outside_is_unknown():
    src = np.array([[1.0, np.nan, 5.0], [2.0, 3.0, 4.0]])
    # 1 m source, 2 m target from the NW corner: centre at 1.0 -> tie cells 0, 1 on each axis
    out = fp.sample_centres(src, (0.0, 0.0), 1.0, (0.0, 0.0), 2.0, (1, 2))
    assert out[0, 0] == 3.0                # tie on both axes: max of known {1, nan, 2, 3}
    assert out[0, 1] == 5.0                # x = 3.0 ties cells 2 | 3 (outside): max {5, 4}
    allnan = fp.sample_centres(np.full((2, 2), np.nan), (0, 0), 1.0, (0, 0), 1.0, (2, 2))
    assert np.isnan(allnan).all()
    far = fp.sample_centres(np.ones((2, 2)), (0, 0), 1.0, (10.0, 0.0), 1.0, (1, 1))
    assert np.isnan(far[0, 0])


def test_sample_1m_slope_takes_window_centre_cell():
    # 1 m posting, 5 m pixels starting 200 m in: pixel k uses 1 m cell 200 + 5k + 2
    src = np.tile(np.arange(300, dtype=float), (300, 1))
    src = src + 1000.0 * np.arange(300)[:, None]
    out = fp.sample_centres(src, (0.0, 0.0), 1.0, (200.0, -200.0), 5.0, (3, 3))
    # centre 202.5 m -> 1 m cell 202, the centre of the 5 x 5 window 200..204
    assert out[0, 0] == 1000 * 202 + 202
    assert out[2, 1] == 1000 * 212 + 207


def test_home_bearing_points_at_the_pad():
    b = fp.home_bearing_deg((0.0, 0.0), 1.0, (3, 3), (1.5, -1.5))  # pad at the centre pixel centre
    assert b[0, 1] == pytest.approx(180.0)  # north of the pad -> head south
    assert b[1, 0] == pytest.approx(90.0)   # west -> east
    assert b[2, 1] == pytest.approx(0.0)    # south -> north
    assert b[0, 0] == pytest.approx(135.0)
    assert np.all((b >= 0) & (b < 360))


# ------------------------------------------------------------------------- worst-case ----
def test_disc_offsets_are_a_disc():
    offs = wc.disc_offsets(2)
    assert (0, 0) in offs and (2, 0) in offs and (0, -2) in offs
    assert (2, 1) not in offs and (1, 1) in offs and len(offs) == 13


def test_worst_case_spreads_a_peak_into_a_disc():
    a = np.zeros((41, 41))
    a[20, 20] = 9.0
    out = wc.disc_max(a, 5)
    yy, xx = np.mgrid[-20:21, -20:21]
    inside = yy**2 + xx**2 <= 25
    assert np.all(out[inside] == 9.0) and np.all(out[~inside] == 0.0)


def test_worst_case_radius_zero_is_identity():
    a = np.random.default_rng(1).uniform(0, 10, (20, 30))
    assert np.array_equal(wc.disc_max(a, 0), a)


@pytest.mark.parametrize("mode", ["propagate", "ignore"])
def test_worst_case_ge_point_field_everywhere(mode):
    rng = np.random.default_rng(5)
    a = rng.uniform(0, 60, (80, 90))
    a[10:14, 30:40] = np.nan
    for r in (1, 3, 10):
        out = wc.disc_max(a, r, unknown=mode)
        both = np.isfinite(out) & np.isfinite(a)
        assert np.all(out[both] >= a[both])
        if mode == "propagate":
            assert np.all(np.isnan(out[np.isnan(a)]))
        else:  # ignore: every known point keeps a value (its own cell is in the disc)
            assert np.all(np.isfinite(out[np.isfinite(a)]))


def test_worst_case_unknown_modes():
    a = np.array([[1.0, np.nan, 3.0]])
    assert np.isnan(wc.disc_max(a, 1, unknown="propagate")).all()
    assert wc.disc_max(a, 1, unknown="ignore").tolist() == [[1.0, 3.0, 3.0]]
    assert np.isnan(wc.disc_max(np.full((2, 2), np.nan), 1, unknown="ignore")).all()
    with pytest.raises(ValueError):
        wc.disc_max(a, 1, unknown="zero")


def test_worst_case_ignores_cells_outside_the_extent():
    a = np.arange(25, dtype=float).reshape(5, 5)
    assert wc.disc_max(a, 1)[0, 0] == max(a[0, 0], a[0, 1], a[1, 0])


def test_worst_case_radius_rounds_up_on_the_3m_grid():
    res = 3.0
    got = {r: wc.radius_px(r, res) for r in HUD["worst_case_radii_m"]}
    assert got == {10: 4, 50: 17, 100: 34}  # 12, 51, 102 m: never a smaller disc
    assert wc.radius_px(10, 5.0) == 2
    t = np.random.default_rng(2).uniform(0, 60, (60, 60))
    out = wc.worst_case_fields(t, res, HUD["worst_case_radii_m"])
    prev = t
    for r in sorted(out):
        r_eff, f = out[r]
        assert r_eff >= r
        assert np.all(f >= prev)  # monotonic in radius
        prev = f


# ------------------------------------------------------------------------- pointer helper ----
STENCIL = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1],
           [-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2]]


def test_pointer_values_and_follow():
    ptr = np.array([[-1, 0, 15], [3, 7, -1]], dtype=np.int8)
    v = fp.pointer_values(ptr, len(STENCIL))
    assert np.isnan(v[0, 0]) and np.isnan(v[1, 2]) and v[0, 2] == 15
    with pytest.raises(ValueError):
        fp.pointer_values(np.array([[16]]), len(STENCIL))
    w = np.full((3, 3), np.nan)
    w[2, 0] = 3  # east
    w[2, 1] = 5  # north-east
    assert fp.follow_pointer(w, STENCIL, 2, 0) == ([(2, 0), (2, 1), (1, 2)], "stop")
    assert fp.follow_pointer(np.array([[3.0, 2.0]]), STENCIL, 0, 0)[1] == "cycle"
    assert fp.follow_pointer(np.array([[0.0]]), STENCIL, 0, 0) == ([(0, 0)], "outside")


# ------------------------------------------------------------------ CLI on a synthetic tree ----
CRS = yaml.safe_load((REPO / "config" / "site.yaml").read_text())["crs"]["analysis_proj"]


def _write_tif(path, arr, nw, res, nodata):
    import rasterio
    from rasterio.transform import from_origin

    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", driver="GTiff", height=arr.shape[0], width=arr.shape[1],
                       count=1, dtype=arr.dtype, crs=CRS,
                       transform=from_origin(nw[0], nw[1], res, res), nodata=nodata) as ds:
        ds.write(arr, 1)


PAD_RC = (20, 19)  # 3 m cell SW of the pad corner (0, 0) on the 40 x 40 synthetic grid


def _synthetic_pointer():
    """Greedy king moves toward PAD_RC (move index into STENCIL), -1 at the pad cell."""
    n3 = 40
    ptr = np.full((n3, n3), -1, dtype=np.int8)
    for r in range(n3):
        for c in range(n3):
            dr, dc = int(np.sign(PAD_RC[0] - r)), int(np.sign(PAD_RC[1] - c))
            if (dr, dc) != (0, 0):
                ptr[r, c] = STENCIL.index([dr, dc])
    return ptr


def _synthetic_tree(root, *, with_o2=True, pointer_moves=False):
    """Pad corner at (0, 0); 3 m grid +-60 m (NW at (-60, 60)); 5 m grid +-55 m (NW (-55, 55));
    slope at 1 m +-60 m. T_home = distance from the pad / 1 m/s in minutes."""
    n3 = 40
    x3 = -60 + (np.arange(n3) + 0.5) * 3
    d = np.hypot(x3[None, :], x3[:, None])
    t = (d / 60.0).astype(np.float32)
    t[5:8, 5:8] = np.nan
    eng = root / "engine" / "nom_104"
    _write_tif(eng / "t_home.tif", t, (-60.0, 60.0), 3.0, np.float32(np.nan))
    if with_o2:
        _write_tif(eng / "o2_home.tif", (t * 0.7).astype(np.float32), (-60.0, 60.0), 3.0,
                   np.float32(np.nan))
    ptr = _synthetic_pointer() if pointer_moves else np.full((n3, n3), -1, dtype=np.int8)
    _write_tif(eng / "pointer.tif", ptr, (-60.0, 60.0), 3.0, -1)
    slope = np.random.default_rng(3).uniform(0, 40, (120, 120)).astype(np.float32)
    _write_tif(root / "terrain" / "slope_5m.tif", slope, (-60.0, 60.0), 1.0, np.float32(np.nan))
    (root / "engine" / "pointer_offsets.json").write_text(
        json.dumps({"offsets_drow_dcol": STENCIL}))
    grid = {"crs": CRS, "pad": {"lon": 137.39, "lat": 0.0, "xy": [0.0, 0.0]}, "grids": {
        "route_3m": {"res_m": 3.0, "width": n3, "height": n3, "nw_xy": [-60.0, 60.0],
                     "bounds_lonlat": [137.38, -0.001, 137.40, 0.001]},
        "fields_5m": {"res_m": 5.0, "width": 22, "height": 22, "nw_xy": [-55.0, 55.0],
                      "bounds_lonlat": [137.381, -0.0009, 137.399, 0.0009]}}}
    (root / "terrain" / "grid.json").write_text(json.dumps(grid))
    return {"t": t, "slope": slope}


def test_cli_writes_contract_valid_index(tmp_path):
    src = _synthetic_tree(tmp_path / "interim")
    out = tmp_path / "out"
    rep = fp.run(interim=tmp_path / "interim", out_root=out,
                 manifest_fragment_dir=tmp_path / "manifest", log=lambda *a: None)
    idx = json.loads((out / "fields" / "index.json").read_text())
    Draft202012Validator(SCHEMA).validate(idx)
    assert idx["dummy"] is False and (idx["width"], idx["height"], idx["res_m"]) == (22, 22, 5.0)
    radii = HUD["worst_case_radii_m"]
    want = {"slope", "nom_104/t_home", "nom_104/o2_home", "nom_104/home_bearing"}
    want |= {f"nom_104/{b}_worst_{r}" for b in ("t_home", "o2_home") for r in radii}
    want |= {"nom_104/pointer"}  # the way-home pointer is in the default run (contracts v1.1.1)
    assert set(idx["fields"]) == want
    for k, e in idx["fields"].items():
        assert (out / e["file"]).exists(), k
        size = (e.get("width", 22), e.get("height", 22))
        assert Image.open(out / e["file"]).size == size
    assert idx["fields"]["slope"]["file"] == "fields/shared/slope.png"
    assert idx["fields"]["slope"]["scenario"] is None
    # T_home at the pad pixel SW of the pad corner (5 m pixel (11, 10)): the 3 m cell under its
    # centre (-2.5, -2.5) is cell (20, 19) whose centre is 2.12 m from the pad
    t5 = fp.decode_png(out / idx["fields"]["nom_104/t_home"]["file"], 0.1)
    t3 = src["t"].astype(float)
    assert t5[11, 10] == pytest.approx(round(t3[20, 19] * 10) / 10)
    # worst >= point everywhere both are known
    for r in radii:
        w5 = fp.decode_png(out / f"fields/nom_104/t_home_worst_{r}.png", 0.1)
        both = np.isfinite(w5) & np.isfinite(t5)
        assert both.any() and np.all(w5[both] >= t5[both])
    hb = fp.decode_png(out / "fields/nom_104/home_bearing.png", 0.01)
    assert hb[0, 0] == pytest.approx(135.0, abs=0.01)
    assert hb[-1, -1] == pytest.approx(315.0, abs=0.01)
    frag = json.loads((tmp_path / "manifest" / "pipeline__export__fields_png.json").read_text())
    for k in idx["fields"]:
        assert f"fields.{k}.sha256" in frag
    # every key cites the published web path (make web drops entries citing interim sources)
    assert frag and all(e["file"].startswith("fields/") and e["file"].endswith(".png")
                        for e in frag.values())
    assert rep["total_bytes"] == sum(rep["sizes"].values()) > 0
    for sc in ("opt_80", "con_120"):
        assert "missing" in rep["skipped"][f"{sc}/t_home"] and not (out / "fields" / sc).exists()


def test_cli_skips_missing_inputs_never_fakes(tmp_path):
    _synthetic_tree(tmp_path / "interim", with_o2=False)
    out = tmp_path / "out"
    rep = fp.run(interim=tmp_path / "interim", out_root=out, scenarios=["nom_104"],
                 manifest_fragment_dir=tmp_path / "manifest", log=lambda *a: None)
    idx = json.loads((out / "fields" / "index.json").read_text())
    assert "nom_104/o2_home" not in idx["fields"]
    assert not any(k.startswith("nom_104/o2_home_worst") for k in idx["fields"])
    assert "WS2" in rep["skipped"]["nom_104/o2_home"]


def test_cli_dry_run_writes_nothing(tmp_path):
    _synthetic_tree(tmp_path / "interim")
    out = tmp_path / "out"
    rep = fp.run(interim=tmp_path / "interim", out_root=out, dry_run=True, log=lambda *a: None)
    assert not out.exists()
    rows = {r["path"]: r for r in rep["inputs"]}
    assert rows[str(Path("engine/nom_104/t_home.tif"))]["present"] is True
    assert rows[str(Path("engine/con_104/t_home.tif"))] == {
        "path": str(Path("engine/con_104/t_home.tif")), "owner": "WS2", "present": False}


def test_cli_pointer_by_default_on_its_own_grid(tmp_path):
    """contracts v1.1.1: {sc}/pointer on WS2's 3 m grid with its own bounds/size/res + stencil."""
    _synthetic_tree(tmp_path / "interim", pointer_moves=True)
    out = tmp_path / "out"
    fp.run(interim=tmp_path / "interim", out_root=out, scenarios=["nom_104"],
           manifest_fragment_dir=tmp_path / "manifest", log=lambda *a: None)
    idx = json.loads((out / "fields" / "index.json").read_text())
    p = idx["fields"]["nom_104/pointer"]
    Draft202012Validator(SCHEMA).validate(idx)
    assert p["file"] == "fields/nom_104/pointer.png" and p["scenario"] == "nom_104"
    assert (p["width"], p["height"], p["res_m"], p["stencil"]) == (40, 40, 3.0, STENCIL)
    assert p["bounds"] == [137.38, -0.001, 137.40, 0.001]
    assert (p["scale"], p["units"]) == (1, "move")
    # exact round trip of the move index; -1 (pad / unreached) decodes as unknown
    v = fp.decode_png(out / p["file"], 1)
    ptr = _synthetic_pointer()
    assert np.array_equal(np.isnan(v), ptr == -1)
    assert np.array_equal(v[ptr >= 0], ptr[ptr >= 0])
    # following it from any cell with a move ends on the pad cell
    path, why = fp.follow_pointer(v, p["stencil"], 0, 0)
    assert why == "stop" and path[-1] == PAD_RC


def test_cli_no_pointer_opt_out(tmp_path):
    _synthetic_tree(tmp_path / "interim")
    out = tmp_path / "out"
    fp.run(interim=tmp_path / "interim", out_root=out, scenarios=["nom_104"], with_pointer=False,
           manifest_fragment_dir=tmp_path / "manifest", log=lambda *a: None)
    idx = json.loads((out / "fields" / "index.json").read_text())
    assert "nom_104/pointer" not in idx["fields"]
    a = fp.build_arg_parser().parse_args([])
    assert a.with_pointer is True
    assert fp.build_arg_parser().parse_args(["--no-pointer"]).with_pointer is False


def test_cli_missing_pointer_is_reported_not_faked(tmp_path):
    _synthetic_tree(tmp_path / "interim")
    (tmp_path / "interim" / "engine" / "nom_104" / "pointer.tif").unlink()
    out = tmp_path / "out"
    rep = fp.run(interim=tmp_path / "interim", out_root=out, scenarios=["nom_104"],
                 manifest_fragment_dir=tmp_path / "manifest", log=lambda *a: None)
    idx = json.loads((out / "fields" / "index.json").read_text())
    assert "nom_104/pointer" not in idx["fields"]
    assert "WS2" in rep["skipped"]["nom_104/pointer"]


def test_cli_partial_run_keeps_other_scenarios(tmp_path):
    _synthetic_tree(tmp_path / "interim")
    out = tmp_path / "out"
    kw = dict(interim=tmp_path / "interim", out_root=out,
              manifest_fragment_dir=tmp_path / "manifest", log=lambda *a: None)
    fp.run(**kw)
    first = json.loads((out / "fields" / "index.json").read_text())
    fp.run(scenarios=["nom_104"], **kw)
    assert json.loads((out / "fields" / "index.json").read_text()) == first


def test_lonlat_to_grid_xy_reproduces_the_grid_pad():
    """grid.json pad lon/lat -> analysis-CRS xy (the grid's own crs string) = grid.json pad xy."""
    g = {"crs": CRS, "pad": {"lon": 137.382, "lat": -4.806}}
    x, y = fp.lonlat_to_grid_xy(g, 137.382, -4.806)
    assert (x, y) == pytest.approx((-472.5345025279597, -284874.1962970097), abs=1e-6)


def test_home_bearing_points_at_the_official_pad(tmp_path):
    """D21: home_bearing aims at engine/public/pad.json `pad` (the pad in use), not grid.json's
    pad_default; without pad.json it falls back to grid.json and says so."""
    interim = tmp_path / "interim"
    _synthetic_tree(interim)
    out = tmp_path / "out"
    rep = fp.run(interim=interim, out_root=out, scenarios=["nom_104"], with_pointer=False,
                 manifest_fragment_dir=tmp_path / "m0", log=lambda *a: None)
    assert rep["pad"]["source"] == "terrain/grid.json pad"
    # official pad 20 m east, 20 m north of the grid pad (lon/lat of that xy in the grid crs)
    lon, lat = fp.grid_lonlat_of_xy({"crs": CRS}, 20.0, 20.0)
    pub = interim / "engine" / "public"
    pub.mkdir(parents=True)
    (pub / "pad.json").write_text(json.dumps({"pad": {"lon": lon, "lat": lat}}))
    rep = fp.run(interim=interim, out_root=out, scenarios=["nom_104"], with_pointer=False,
                 manifest_fragment_dir=tmp_path / "m1", log=lambda *a: None)
    assert rep["pad"]["source"] == "engine/public/pad.json pad"
    assert rep["pad"]["xy"] == pytest.approx([20.0, 20.0], abs=1e-6)
    hb = fp.decode_png(out / "fields/nom_104/home_bearing.png", 0.01)
    # pixel (row 10, col 13): centre (12.5, 2.5); the pad (20, 20) is at atan2(7.5, 17.5)
    assert hb[10, 13] == pytest.approx(np.degrees(np.arctan2(7.5, 17.5)) % 360, abs=0.01)
    assert hb[0, 0] == pytest.approx(np.degrees(np.arctan2(72.5, -32.5)) % 360, abs=0.01)
    frag = json.loads((tmp_path / "m1" / "pipeline__export__fields_png.json").read_text())
    assert frag["fields.nom_104/home_bearing.pad_lon"]["value"] == pytest.approx(lon)
    assert frag["fields.nom_104/home_bearing.pad_lat"]["value"] == pytest.approx(lat)


# ---------------------------------------------------------- real data (skipped when absent) ----
REAL_IDX = INTERIM / "export" / "fields" / "index.json"
REAL_T = INTERIM / "engine" / "nom_104" / "t_home.tif"


@pytest.mark.skipif(not REAL_IDX.exists(), reason="no real field export yet")
def test_real_index_valid_and_pad_zero():
    idx = json.loads(REAL_IDX.read_text())
    Draft202012Validator(SCHEMA).validate(idx)
    assert idx["dummy"] is False
    for k, e in idx["fields"].items():
        # WS9's fix_interval PNGs stay in navigation/ (WS9's make web rule copies them)
        root = INTERIM / "navigation" if k.startswith("fix_interval_") else REAL_IDX.parent.parent
        f = root / e["file"]
        assert f.exists(), k
        assert f.stat().st_size < 50e6
    sc = VARIANTS["scenarios"]["default"]
    if f"{sc}/t_home" in idx["fields"]:
        t = fp.decode_png(REAL_IDX.parent.parent / idx["fields"][f"{sc}/t_home"]["file"], 0.1)
        # since D21 the pad is not the grid anchor: no 5 m centre need fall on WS2's single
        # T_home = 0 cell, so the field minimum is within the HUD's 0.5 min tolerance of 0
        assert 0.0 <= np.nanmin(t) <= 0.5
        assert t.shape == (idx["height"], idx["width"])


@pytest.mark.skipif(not REAL_T.exists(), reason="no WS2 nom_104 t_home")
def test_real_worst_case_ge_point_on_crop():
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(REAL_T) as ds:
        t = ds.read(1, window=Window(1100, 1100, 200, 200)).astype(np.float64)
        res = ds.transform.a
    s = HUD["field_scales"]["t_home"]["per_count"]
    for r_m, (r_eff, f) in wc.worst_case_fields(t, res, HUD["worst_case_radii_m"],
                                                 unknown="ignore").items():
        assert r_eff >= r_m
        both = np.isfinite(t) & np.isfinite(f)
        assert np.all(f[both] >= t[both])
        assert np.all(np.isfinite(f[np.isfinite(t)]))
        a = fp.decode_png(fp.encode_png(t, s), s)
        b = fp.decode_png(fp.encode_png(f, s), s)
        assert np.all(b[both] >= a[both])


REAL_PAD = INTERIM / "engine" / "public" / "pad.json"


@pytest.mark.skipif(not (REAL_IDX.exists() and REAL_T.exists() and REAL_PAD.exists()),
                    reason="no real export / WS2 pad.json")
def test_real_bearing_and_t_home_zero_at_the_official_pad():
    """The exported home_bearing aims at pad.json's pad, and WS2's T_home = 0 cell is that pad."""
    import rasterio

    idx = json.loads(REAL_IDX.read_text())
    sc = VARIANTS["scenarios"]["default"]
    grid = json.loads((INTERIM / "terrain" / "grid.json").read_text())
    pad = json.loads(REAL_PAD.read_text())["pad"]
    px, py = fp.lonlat_to_grid_xy(grid, pad["lon"], pad["lat"])
    g5 = grid["grids"]["fields_5m"]
    nw = g5["nw_xy"]
    hb = fp.decode_png(REAL_IDX.parent.parent / idx["fields"][f"{sc}/home_bearing"]["file"], 0.01)
    for r, c in ((0, 0), (0, g5["width"] - 1), (g5["height"] - 1, 0), (700, 900)):
        x = nw[0] + (c + 0.5) * g5["res_m"]
        y = nw[1] - (r + 0.5) * g5["res_m"]
        want = np.degrees(np.arctan2(px - x, py - y)) % 360
        assert hb[r, c] == pytest.approx(want, abs=0.011), (r, c)
    with rasterio.open(REAL_T) as ds:
        t = ds.read(1)
        zr, zc = map(int, np.argwhere(t == 0)[0])
        cx, cy = ds.transform * (zc + 0.5, zr + 0.5)
        res = ds.transform.a
    assert abs(cx - px) <= res and abs(cy - py) <= res  # the pad is a corner of the T_home = 0 cell


@pytest.mark.skipif(not REAL_IDX.exists() or not REAL_T.exists(), reason="no real export / WS2")
def test_real_pointer_leads_home_downhill_in_t_home():
    """The exported pointer PNG (v1.1.1) leads from any reached cell to the pad (T_home 0), and
    WS2's T_home never rises along the way (F18 way-home path = WS2's route home)."""
    import rasterio

    idx = json.loads(REAL_IDX.read_text())
    sc = VARIANTS["scenarios"]["default"]
    e = idx["fields"].get(f"{sc}/pointer")
    if e is None:
        pytest.skip("no pointer in the real export")
    Draft202012Validator(SCHEMA).validate(idx)
    v = fp.decode_png(REAL_IDX.parent.parent / e["file"], e["scale"])
    assert v.shape == (e["height"], e["width"]) and e["res_m"] == 3
    with rasterio.open(REAL_T) as ds:
        t = ds.read(1).astype(np.float64)
        if ds.nodata is not None and np.isfinite(ds.nodata):
            t[t == ds.nodata] = np.nan
    assert t.shape == v.shape
    # a move exactly where WS2 has a finite T_home > 0; none at the pad / unreached
    assert np.array_equal(np.isfinite(v), np.isfinite(t) & (t > 0))
    pad = np.argwhere(t == 0)
    assert len(pad) == 1
    rng = np.random.default_rng(7)
    reached = np.argwhere(np.isfinite(v))
    for r, c in reached[rng.choice(len(reached), 60, replace=False)]:
        path, why = fp.follow_pointer(v, e["stencil"], int(r), int(c))
        assert why == "stop" and path[-1] == tuple(pad[0]), (r, c, why)
        tt = np.array([t[i, j] for i, j in path])
        assert np.all(np.diff(tt) <= 1e-4), (r, c)


# --------------------------------------------------------- WS9 fix-interval index merge ----
def _nav_index(root, grid_bounds, *, width=22, res=5.0, key="fix_interval_medium"):
    nav = root / "navigation"
    (nav / "fields").mkdir(parents=True, exist_ok=True)
    (nav / "fields" / f"{key}.png").write_bytes(fp.encode_png(np.full((22, 22), 300.0), 1))
    idx = {"bounds": grid_bounds, "width": width, "height": 22, "res_m": res,
           "fields": {key: {"file": f"fields/{key}.png", "scale": 1, "units": "m",
                            "scenario": "nom_104"}}, "note": "WS9"}
    (nav / "fields_index_nav.json").write_text(json.dumps(idx))


def test_cli_merges_ws9_fix_interval_on_the_same_grid(tmp_path):
    _synthetic_tree(tmp_path / "interim")
    _nav_index(tmp_path / "interim", [137.381, -0.0009, 137.399, 0.0009])
    out = tmp_path / "out"
    rep = fp.run(interim=tmp_path / "interim", out_root=out, scenarios=["nom_104"],
                 manifest_fragment_dir=tmp_path / "manifest", log=lambda *a: None)
    idx = json.loads((out / "fields" / "index.json").read_text())
    Draft202012Validator(SCHEMA).validate(idx)
    assert rep["merged_nav"] == ["fix_interval_medium"]
    assert idx["fields"]["fix_interval_medium"] == {
        "file": "fields/fix_interval_medium.png", "scale": 1, "units": "m", "scenario": "nom_104"}


@pytest.mark.parametrize("bad", [dict(width=21), dict(res=10.0), dict(key="slope"),
                                 dict(bounds=[137.38, -0.0009, 137.399, 0.0009])])
def test_cli_refuses_ws9_index_on_another_grid(tmp_path, bad):
    _synthetic_tree(tmp_path / "interim")
    b = bad.pop("bounds", [137.381, -0.0009, 137.399, 0.0009])
    _nav_index(tmp_path / "interim", b, **bad)
    out = tmp_path / "out"
    rep = fp.run(interim=tmp_path / "interim", out_root=out, scenarios=["nom_104"],
                 manifest_fragment_dir=tmp_path / "manifest", log=lambda *a: None)
    idx = json.loads((out / "fields" / "index.json").read_text())
    assert not any(k.startswith("fix_interval") for k in idx["fields"])
    assert idx["fields"]["slope"]["file"] == "fields/shared/slope.png"  # WS9 never overrides
    assert rep["skipped"]["fix_interval"]


def test_ws1_and_ws9_field_grids_agree():
    """WS1 grid.json fields_5m (used here) == WS9 real.field_grid() (pad +- planning radius)."""
    gj = INTERIM / "terrain" / "grid.json"
    if not gj.exists():
        pytest.skip("no WS1 grid.json")
    nav = pytest.importorskip("pipeline.navigation.real")
    g5 = json.loads(gj.read_text())["grids"]["fields_5m"]
    g9 = nav.field_grid()
    assert (g9["width"], g9["height"], g9["res_m"]) == (g5["width"], g5["height"], g5["res_m"])
    assert g9["x0"] == pytest.approx(g5["nw_xy"][0], abs=1e-6)
    assert g9["y1"] == pytest.approx(g5["nw_xy"][1], abs=1e-6)
    assert g9["bounds"] == [round(b, 6) for b in g5["bounds_lonlat"]]

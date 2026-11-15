"""P2 / WS16: pipeline/export/terrain_tiles.py + relief_lowzoom.py (DESIGN §6.1, U1, §5.4).
P2c: heights are elevation x factor + terrain_tiles.vertical_offset_m (site near 0 m on the map).

Checks the committed elevation tiles (web/public/data/terrain/, terrain_low/) against the frozen
contract (contracts/terrain_tiles.schema.json), config/design.yaml (factor, zooms, budgets) and
config/site.yaml (planning extent, focus area), and the exporter itself on a synthetic DEM
(Terrarium round trip, finest-source-first fallback, budget enforcement, determinism). The real
pad check (decoded tile = 1 m DEM x factor) needs the git-ignored DEM in ~/hl-data.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
from pathlib import Path

import numpy as np
import pytest
import yaml
from jsonschema import Draft202012Validator
from PIL import Image

from pipeline.export import relief_lowzoom as RL
from pipeline.export import terrain_tiles as T

REPO = Path(__file__).resolve().parents[1]
PUBLIC = REPO / "web" / "public" / "data"
SCHEMA = json.loads((REPO / "contracts" / "terrain_tiles.schema.json").read_text())
DESIGN = yaml.safe_load((REPO / "config" / "design.yaml").read_text())
SITE = yaml.safe_load((REPO / "config" / "site.yaml").read_text())
TT = DESIGN["terrain_tiles"]
FACTOR = DESIGN["scale"]["elevation_factor"]
MB = 2 ** 20
DEM_1M = REPO / "data" / "interim" / "terrain" / "dem_1m.tif"
needs_dem = pytest.mark.skipif(not DEM_1M.exists(),
                               reason="1 m merged DEM not cached (git-ignored, ~/hl-data)")
# Full re-export (~2 min, ~1 GB RAM): opt-in, run as
# HL_REGEN_TILES=1 flock /tmp/hl-heavy.lock pytest tests/test_terrain_tiles.py -k regenerated
needs_regen = pytest.mark.skipif(os.environ.get("HL_REGEN_TILES") != "1",
                                 reason="heavy re-export; set HL_REGEN_TILES=1 (under flock)")
CAP = TT["height_step_cap_m"]  # coarsest height step, m of true elevation, per tile set
OFFSET = TT["vertical_offset_m"]  # P2c: m added after scaling, h = elevation * factor + offset
PAD_JSON = json.loads((PUBLIC / "pad.json").read_text())  # the official pad (D21)


def meta(name: str) -> dict:
    return json.loads((PUBLIC / name / "tiles.json").read_text())


def tile_png(name: str, z: int, x: int, y: int) -> Path:
    return PUBLIC / name / str(z) / str(x) / f"{y}.png"


def tile_files(name: str) -> list[Path]:
    """{z}/{x}/{y}.png under the set's folder (terrain/ also holds WS1's cellstate*.png)."""
    root = PUBLIC / name
    return sorted(p for p in root.rglob("*.png") if len(p.relative_to(root).parts) == 3)


def decode_file(path: Path) -> np.ndarray:
    im = Image.open(path)
    assert im.mode == "RGB", f"{path}: {im.mode}"
    return T.decode_terrarium(np.asarray(im))


# ------------------------------------------------------------------------------- tile maths


def test_tile_maths_known_answers():
    assert T.lonlat_to_tile(0.0, 0.0, 1) == pytest.approx((1.0, 1.0))
    assert T.lonlat_to_tile(-180.0, 0.0, 3)[0] == pytest.approx(0.0)
    w, s, e, n = T.tile_bounds(1, 1, 1)
    assert (w, s, e, n) == pytest.approx((0.0, -85.0511287798, 180.0, 0.0))
    # every pixel centre of a tile lies inside the tile and maps back to the right pixel
    lon, lat = T.pixel_lonlat(15, 29271, 16822, 256)
    fx, fy = T.lonlat_to_tile(lon, lat, 15)
    assert np.allclose((fx - 29271) * 256, np.arange(256)[None, :] + 0.5, atol=1e-6)
    assert np.allclose((fy - 16822) * 256, np.arange(256)[:, None] + 0.5, atol=1e-6)


def test_tiles_covering_contains_bounds():
    b = [137.33, -4.84, 137.43, -4.77]
    for z in (10, 13, 15):
        tiles = T.tiles_covering(b, z)
        u = T.union_bounds([T.tile_bounds(z, x, y) for x, y in tiles])
        assert u[0] <= b[0] and u[1] <= b[1] and u[2] >= b[2] and u[3] >= b[3]
        # minimal: dropping the outer ring would no longer cover
        xs = {x for x, _ in tiles}
        ys = {y for _, y in tiles}
        assert len(tiles) == len(xs) * len(ys)


def test_terrarium_round_trip():
    h = np.array([[-4521.37, -0.002, 0.0, 1234.5678, -32767.9, 32767.5]])
    back = T.decode_terrarium(T.encode_terrarium(h))
    assert np.all(np.abs(back - h) <= 0.5 / 256 + 1e-9)


def test_lonlat_xy_round_trip_uses_site_crs():
    pad = SITE["pad_default"]
    x, y = T.xy_of_lonlat(np.array([pad["lon"]]), np.array([pad["lat"]]))
    lon, lat = T.lonlat_of_xy(x, y)
    assert lon[0] == pytest.approx(pad["lon"], abs=1e-9)
    assert lat[0] == pytest.approx(pad["lat"], abs=1e-9)


# --------------------------------------------------------------------- synthetic DEM builds


def _plane(x, y):
    return -4500.0 + 0.05 * (x - X0) - 0.03 * (y - Y0)


X0, Y0 = T.xy_of_lonlat(np.array([SITE["pad_default"]["lon"]]),
                        np.array([SITE["pad_default"]["lat"]]))
X0, Y0 = float(X0[0]), float(Y0[0])
COARSE_OFFSET = 100.0


def _write_raster(path: Path, res: float, half: float, offset: float = 0.0, hole=None) -> Path:
    import rasterio
    from rasterio.transform import from_origin

    n = int(round(2 * half / res))
    xs = X0 - half + (np.arange(n) + 0.5) * res
    ys = Y0 + half - (np.arange(n) + 0.5) * res
    z = _plane(xs[None, :], ys[:, None]).astype("float32") + offset
    if hole is not None:
        z[hole] = np.nan
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32",
                       crs=T.analysis_crs(), transform=from_origin(X0 - half, Y0 + half, res, res),
                       nodata=float("nan")) as d:
        d.write(z, 1)
    return path


@pytest.fixture(scope="module")
def synth(tmp_path_factory):
    d = tmp_path_factory.mktemp("synth")
    fine = _write_raster(d / "fine_1m.tif", 1.0, 400.0)
    coarse = _write_raster(d / "coarse_20m.tif", 20.0, 4000.0, offset=COARSE_OFFSET)
    half_deg = 300.0 / (math.pi * T.mars_radius_m() / 180.0)
    pad = SITE["pad_default"]
    bounds = [pad["lon"] - half_deg, pad["lat"] - half_deg, pad["lon"] + half_deg,
              pad["lat"] + half_deg]
    focus = [pad["lon"] - half_deg / 3, pad["lat"] - half_deg / 3, pad["lon"] + half_deg / 3,
             pad["lat"] + half_deg / 3]
    kw = dict(name="terrain", sources=[fine, coarse], zooms=(13, 15), focus_zooms=(16, 16),
              bounds=bounds, focus_bounds=focus, factor=FACTOR, tile_px=TT["tile_px"],
              budget_bytes=TT["budget_mb"] * MB, max_step_true_m=CAP["terrain"],
              vertical_offset_m=OFFSET)
    a = T.build(out_dir=d / "a" / "terrain", **kw)
    b = T.build(out_dir=d / "b" / "terrain", **kw)
    return {"dir": d, "a": a, "b": b, "kw": kw, "fine": fine, "coarse": coarse}


def test_synthetic_meta_schema_valid(synth):
    m = synth["a"]
    errs = list(Draft202012Validator(SCHEMA).iter_errors(m))
    assert not errs, errs
    assert m["factor"] == FACTOR and m["minzoom"] == 13 and m["maxzoom"] == 16
    assert m["vertical_offset_m"] == OFFSET
    assert m["focus"] == {"minzoom": 16, "maxzoom": 16, "bounds": synth["kw"]["focus_bounds"]}
    files = sorted((synth["dir"] / "a" / "terrain").rglob("*.png"))
    assert m["total_bytes"] == sum(p.stat().st_size for p in files)
    assert sum(m["tile_count"].values()) == len(files)


def test_synthetic_deterministic(synth):
    da, db = synth["dir"] / "a" / "terrain", synth["dir"] / "b" / "terrain"
    fa = {p.relative_to(da): p.read_bytes() for p in da.rglob("*") if p.is_file()}
    fb = {p.relative_to(db): p.read_bytes() for p in db.rglob("*") if p.is_file()}
    assert fa.keys() == fb.keys() and fa == fb


def test_synthetic_pad_pixel_is_dem_times_factor(synth):
    pad = SITE["pad_default"]
    for z in (13, 14, 15, 16):
        fx, fy = T.lonlat_to_tile(pad["lon"], pad["lat"], z)
        x, y = int(fx), int(fy)
        i, j = int((fy - y) * 256), int((fx - x) * 256)
        h = decode_file(synth["dir"] / "a" / "terrain" / str(z) / str(x) / f"{y}.png")[i, j]
        lon, lat = T.pixel_lonlat(z, x, y, 256)
        px, py = T.xy_of_lonlat(lon[i:i + 1, j], lat[i:i + 1, j])
        want = _plane(float(px[0]), float(py[0])) * FACTOR + OFFSET
        assert abs(h - want) <= 0.1 * FACTOR, (z, h, want)


def test_synthetic_falls_back_to_coarser_source(synth):
    """Pixels the 1 m raster doesn't cover come from the next source (here: plane + 100 m)."""
    z = 13
    tiles = T.tiles_covering(synth["kw"]["bounds"], z)
    seen_coarse = False
    for x, y in tiles:
        h = decode_file(synth["dir"] / "a" / "terrain" / str(z) / str(x) / f"{y}.png")
        lon, lat = T.pixel_lonlat(z, x, y, 256)
        px, py = T.xy_of_lonlat(lon, lat)
        plane = _plane(px, py)
        outside = (np.abs(px - X0) > 450) | (np.abs(py - Y0) > 450)
        inside = (np.abs(px - X0) < 350) & (np.abs(py - Y0) < 350)
        if outside.any():
            seen_coarse = True
            d = (h[outside] - OFFSET) / FACTOR - plane[outside]
            assert np.allclose(d, COARSE_OFFSET, atol=0.1)
        if inside.any():
            assert np.allclose((h[inside] - OFFSET) / FACTOR, plane[inside], atol=0.1)
    assert seen_coarse
    assert synth["a"]["source"][0].endswith("fine_1m.tif")


def test_synthetic_budget_enforced(synth, tmp_path):
    kw = dict(synth["kw"], budget_bytes=1000)
    with pytest.raises(T.BudgetError):
        T.build(out_dir=tmp_path / "terrain", **kw)


def test_synthetic_offset_shifts_every_pixel_by_the_constant(synth, tmp_path):
    """P2c: the offset is a pure vertical shift: a build without it decodes to exactly
    (with-offset - offset) at every pixel of every tile (same quantisation grid)."""
    kw = dict(synth["kw"], vertical_offset_m=0.0)
    m0 = T.build(out_dir=tmp_path / "terrain", log=lambda _: None, **kw)
    assert m0["vertical_offset_m"] == 0.0 and synth["a"]["vertical_offset_m"] == OFFSET
    assert m0["precision_m"] == synth["a"]["precision_m"]
    da = synth["dir"] / "a" / "terrain"
    n = 0
    for p in sorted(da.rglob("*.png")):
        rel = p.relative_to(da)
        d = decode_file(p) - decode_file(tmp_path / "terrain" / rel)
        assert np.allclose(d, OFFSET, atol=0.5 / 256 + 1e-9), rel
        n += 1
    assert n == sum(m0["tile_count"].values())


def test_vertical_offset_comes_from_config_and_centres_the_official_pad():
    """P2c: one offset for both sets (continuous intro descent), from design.yaml (assumed),
    chosen so the official pad (pad.json, D21) encodes near 0 m: with the ground at ~-7000 m
    MapLibre 6.18 selects no tiles above ~62 deg pitch (black map)."""
    assert T.load_config()["vertical_offset_m"] == OFFSET == RL.load_config()["vertical_offset_m"]
    line = next(ln for ln in (REPO / "config" / "design.yaml").read_text().splitlines()
                if ln.strip().startswith("vertical_offset_m:"))
    assert "assumed: true" in line and "MapLibre" in line
    assert OFFSET == -round(PAD_JSON["pad"]["elev_m"] * FACTOR)
    # the build key covers it: a different offset re-exports
    c = dict(T.load_config(), sources=[])  # no source stat (the DEM is not in CI)
    assert T.build_key(c, []) != T.build_key(dict(c, vertical_offset_m=OFFSET + 1), [])


def test_source_hash_over_files_in_order(synth):
    h = hashlib.sha256()
    for p in (synth["fine"], synth["coarse"]):
        h.update(Path(p).read_bytes())
    assert synth["a"]["source_hash"] == h.hexdigest()


def test_constants_come_from_config():
    c = T.load_config()
    assert c["factor"] == FACTOR
    assert c["tile_px"] == TT["tile_px"]
    assert c["zooms"] == tuple(TT["zooms_planning_extent"])
    assert c["focus_zooms"] == tuple(TT["zooms_focus_area"])
    assert c["budget_bytes"] == TT["budget_mb"] * MB
    f = SITE["aoi_focus"]
    assert c["focus_bounds"] == [f["west"], f["south"], f["east"], f["north"]]
    lc = RL.load_config()
    assert lc["zooms"] == tuple(TT["lowzoom_intro"])
    assert lc["budget_bytes"] == TT["lowzoom_budget_mb"] * MB
    assert lc["factor"] == FACTOR


def test_height_step_caps_come_from_config():
    """P2b: the Terrarium step caps live in design.yaml terrain_tiles.height_step_cap_m."""
    assert T.load_config()["max_step_true_m"] == CAP["terrain"] == 0.1  # brief tolerance (U1)
    assert RL.load_config()["max_step_true_m"] == CAP["low"]
    # no hard-coded fallbacks left in the exporters
    assert not hasattr(T, "MAX_STEP_TRUE_M") and not hasattr(RL, "MAX_STEP_TRUE_M")
    assert "assumed: true" in next(ln for ln in (REPO / "config" / "design.yaml").read_text()
                                   .splitlines() if ln.strip().startswith("low:"))


def test_run_passes_config_step_cap_to_build(synth, tmp_path):
    """run() takes the cap from the cfg dict: a budget that needs a coarser step than the cap
    fails, the same budget with the cap lifted fits."""
    kw = synth["kw"]
    cfg = {k: kw[k] for k in ("name", "sources", "zooms", "focus_zooms", "bounds",
                              "focus_bounds", "factor", "tile_px", "vertical_offset_m")}
    fine_total = synth["a"]["total_bytes"]  # at the finest step that fits 25 MiB
    cfg["budget_bytes"] = fine_total // 2
    cfg["max_step_true_m"] = synth["a"]["precision_m"] / FACTOR  # no coarser step allowed
    with pytest.raises(T.BudgetError):
        T.run(cfg, tmp_path / "capped", force=True, scripts=[], log=lambda _: None)
    cfg["max_step_true_m"] = 100.0
    doc, rebuilt = T.run(cfg, tmp_path / "lifted", force=True, scripts=[], log=lambda _: None)
    assert rebuilt and doc["precision_m"] > synth["a"]["precision_m"]
    assert doc["total_bytes"] <= cfg["budget_bytes"]


# -------------------------------------------------------------------- committed output: U1


def _check_tileset(name: str, budget_mb: float, max_step_true_m: float):
    m = meta(name)
    errs = list(Draft202012Validator(SCHEMA).iter_errors(m))
    assert not errs, errs
    assert m["name"] == name and m["encoding"] == "terrarium" and m["format"] == "png"
    assert m["tiles"] == [f"{name}/{{z}}/{{x}}/{{y}}.png"]
    assert m["factor"] == FACTOR and m["tile_px"] == TT["tile_px"]
    assert m["vertical_offset_m"] == OFFSET  # P2c: equal to config, same in both sets
    files = tile_files(name)
    total = sum(p.stat().st_size for p in files)
    assert m["total_bytes"] == total
    assert total <= budget_mb * MB, f"{name}: {total / MB:.2f} MB > {budget_mb} MB"
    assert m["budget_bytes"] == budget_mb * MB
    # height step chosen to fit the budget: a power of two, capped in true metres
    assert math.log2(m["precision_m"]).is_integer() and m["precision_m"] >= 1 / 256
    assert m["precision_m"] / FACTOR <= max_step_true_m
    assert {k: v for k, v in m["tile_count"].items() if v} == {
        str(z): sum(1 for _ in (PUBLIC / name / str(z)).rglob("*.png"))
        for z in range(m["minzoom"], m["maxzoom"] + 1)}
    return m, files


def test_terrain_tiles_contract_budget_zooms():
    m, files = _check_tileset("terrain", TT["budget_mb"], CAP["terrain"])
    z0, z1 = TT["zooms_planning_extent"]
    fz0, fz1 = TT["zooms_focus_area"]
    assert (m["minzoom"], m["maxzoom"]) == (z0, fz1)
    f = SITE["aoi_focus"]
    assert m["focus"] == {"minzoom": fz0, "maxzoom": fz1,
                          "bounds": [f["west"], f["south"], f["east"], f["north"]]}
    for z in range(z0, fz1 + 1):  # exactly the tiles covering bounds / focus bounds
        b = m["bounds"] if z < fz0 else m["focus"]["bounds"]
        want = {(z, x, y) for x, y in T.tiles_covering(b, z)}
        got = {(z, int(p.parent.name), int(p.stem)) for p in files
               if p.parent.parent.name == str(z)}
        assert got == want, z
    im = Image.open(files[0])
    assert im.size == (TT["tile_px"], TT["tile_px"])


def test_terrain_bounds_cover_planning_extent():
    m = meta("terrain")
    r = SITE["planning_radius_m"]
    pad = SITE["pad_default"]
    # planning extent = pad +/- planning_radius_m in the analysis CRS (pipeline/terrain/grid.py)
    xs = X0 + np.array([-r, r, r, -r, 0, 0])
    ys = Y0 + np.array([-r, -r, r, r, -r, r])
    lon, lat = T.lonlat_of_xy(xs, ys)
    w, s, e, n = m["bounds"]
    assert w <= lon.min() and e >= lon.max() and s <= lat.min() and n >= lat.max()
    assert w <= pad["lon"] <= e and s <= pad["lat"] <= n
    for z in range(TT["zooms_planning_extent"][0], TT["zooms_planning_extent"][1] + 1):
        u = T.union_bounds([T.tile_bounds(z, x, y) for x, y in T.tiles_covering(m["bounds"], z)])
        assert u[0] <= w and u[1] <= s and u[2] >= e and u[3] >= n
        for x, y in T.tiles_covering(m["bounds"], z):
            assert tile_png("terrain", z, x, y).exists()


def test_terrain_low_contract_budget_zooms():
    m, _ = _check_tileset("terrain_low", TT["lowzoom_budget_mb"], CAP["low"])
    assert (m["minzoom"], m["maxzoom"]) == tuple(TT["lowzoom_intro"])
    assert m["focus"] is None
    for z in range(m["minzoom"], m["maxzoom"] + 1):
        for x, y in T.tiles_covering(m["bounds"], z):
            assert tile_png("terrain_low", z, x, y).exists()


@needs_dem
def test_terrain_pad_pixel_is_dem_times_factor():
    """Decoding the z16 tile pixel at the pad gives the 1 m DEM elevation x factor (+-0.1 m*f)."""
    import rasterio

    pad = SITE["pad_default"]
    z = TT["zooms_focus_area"][1]
    fx, fy = T.lonlat_to_tile(pad["lon"], pad["lat"], z)
    x, y = int(fx), int(fy)
    i, j = int((fy - y) * 256), int((fx - x) * 256)
    h = decode_file(tile_png("terrain", z, x, y))[i, j]
    lon, lat = T.pixel_lonlat(z, x, y, 256)
    px, py = T.xy_of_lonlat(lon[i:i + 1, j], lat[i:i + 1, j])
    with rasterio.open(DEM_1M) as d:  # independent bilinear sample of the DEM at the pixel centre
        c, r = ~d.transform * (float(px[0]), float(py[0]))
        c0, r0 = int(math.floor(c - 0.5)), int(math.floor(r - 0.5))
        win = d.read(1, window=((r0, r0 + 2), (c0, c0 + 2))).astype(float)
    fr, fc = r - 0.5 - r0, c - 0.5 - c0
    dem = (win[0, 0] * (1 - fr) * (1 - fc) + win[0, 1] * (1 - fr) * fc
           + win[1, 0] * fr * (1 - fc) + win[1, 1] * fr * fc)
    assert np.isfinite(dem)
    assert abs(h - (dem * FACTOR + OFFSET)) <= 0.1 * FACTOR, (h, dem * FACTOR + OFFSET)


def _pixel_at(name: str, z: int, lon: float, lat: float) -> float:
    fx, fy = T.lonlat_to_tile(lon, lat, z)
    x, y = int(fx), int(fy)
    return float(decode_file(tile_png(name, z, x, y))[int((fy - y) * 256), int((fx - x) * 256)])


def test_official_pad_sits_near_zero_and_sets_hand_over():
    """P2c: at the official pad the decoded height is ~0 m (pad cell elevation x factor + offset;
    the tile pixel is not the pad cell, so a few metres of local relief), in terrain/ at every zoom
    and in terrain_low/ at its finest zoom, and both sets agree at their shared zoom (z10)."""
    pad = PAD_JSON["pad"]
    for z in range(TT["zooms_planning_extent"][0], TT["zooms_focus_area"][1] + 1):
        assert abs(_pixel_at("terrain", z, pad["lon"], pad["lat"])) <= 15 * FACTOR, z
    z = TT["lowzoom_intro"][1]
    low = _pixel_at("terrain_low", z, pad["lon"], pad["lat"])
    assert abs(low) <= 15 * FACTOR
    if z >= TT["zooms_planning_extent"][0]:
        assert abs(low - _pixel_at("terrain", z, pad["lon"], pad["lat"])) <= 10 * FACTOR


@needs_dem
def test_terrain_source_hash_matches_cached_sources():
    m = meta("terrain")
    assert m["source"][0] == "data/interim/terrain/dem_1m.tif"
    assert m["source_hash"] == T.source_hash([REPO / s for s in m["source"]])


def test_manifest_has_factor_and_hash():
    man = json.loads((PUBLIC / "manifest.json").read_text())
    for name in ("terrain", "terrain_low"):
        m = meta(name)
        assert man[f"{name}_tiles.factor"]["value"] == m["factor"]
        assert man[f"{name}_tiles.source_hash"]["value"] == m["source_hash"]
        assert man[f"{name}_tiles.factor"]["file"] == f"{name}/tiles.json"
        assert man[f"{name}_tiles.vertical_offset_m"]["value"] == m["vertical_offset_m"] == OFFSET
        assert man[f"{name}_tiles.vertical_offset_m"]["units"] == "m"


def test_png_bytes_deterministic_encoder():
    rng = np.random.default_rng(0)
    h = rng.normal(-4500, 30, (256, 256))
    a, b = T.encode_png(T.encode_terrarium(h)), T.encode_png(T.encode_terrarium(h))
    assert a == b
    assert np.allclose(T.decode_terrarium(np.asarray(Image.open(io.BytesIO(a)))), h,
                       atol=0.5 / 256 + 1e-9)


def _digests(root: Path) -> dict[str, str]:
    """sha256 of tiles.json and every {z}/{x}/{y}.png under ``root`` (relative path -> hex)."""
    files = [root / "tiles.json"] + [p for p in root.rglob("*.png")
                                     if len(p.relative_to(root).parts) == 3]
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


@needs_regen
@needs_dem
@pytest.mark.parametrize("mod", [T, RL], ids=["terrain", "terrain_low"])
def test_regenerated_tiles_byte_identical(mod, tmp_path):
    """P2b: with the caps read from config, a fresh export equals the published tiles byte for
    byte (written to a temp dir; web/public/data and the manifest are not touched)."""
    out = tmp_path / mod.NAME
    assert mod.main(["--out", str(out), "--force", "--no-record"]) == 0
    got, want = _digests(out), _digests(PUBLIC / mod.NAME)
    assert got.keys() == want.keys()
    assert [k for k in got if got[k] != want[k]] == []

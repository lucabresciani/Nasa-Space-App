"""KATs for tools/make_web.py (`make web`, owner C): tile math, TileJSON, cell-state encoding,
refusals (dummy, synthetic, pre-H0), missing report, basemap budget, end-to-end on a tmp tree."""

from __future__ import annotations

import io
import json
import math
import os
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
import yaml
from jsonschema import Draft202012Validator
from PIL import Image

from tools import make_web as mw

REPO = Path(__file__).resolve().parent.parent
CONTRACTS = REPO / "contracts"
SITE = yaml.safe_load((REPO / "config" / "site.yaml").read_text())
H0 = datetime(2026, 11, 14, 8, 0, tzinfo=UTC)
SETTINGS = {"format": "webp", "quality": 80, "method": 0, "maxzoom": 18, "budget_mb": 50,
            "tile_size_px": 256, "attribution": "HiRISE: NASA/JPL/University of Arizona"}


def schema(name: str) -> Draft202012Validator:
    return Draft202012Validator(json.loads((CONTRACTS / name).read_text()))


def errors(name: str, doc) -> list[str]:
    return [e.message for e in schema(name).iter_errors(doc)]


# --------------------------------------------------------------------------- tile math


def test_tile_lonlat_world_tile():
    w, s, e, n = mw.tile_lonlat(0, 0, 0)
    assert (w, e) == (-180.0, 180.0)
    assert n == pytest.approx(85.0511287798, abs=1e-9) and s == pytest.approx(-n)


def test_tile_lonlat_z1_south_east():
    assert mw.tile_lonlat(1, 1, 1) == pytest.approx((0.0, -85.0511287798, 180.0, 0.0))


def test_tilejson_bounds_and_zoom_bounds():
    """z1 world (4 tiles), z2 world (16 tiles) = full; z3 one tile = partial (focus only)."""
    tiles = ([(1, x, y) for x in (0, 1) for y in (0, 1)]
             + [(2, x, y) for x in range(4) for y in range(4)] + [(3, 4, 4)])
    doc = mw.tilejson_for(tiles, SETTINGS, "src")
    assert doc["minzoom"] == 1 and doc["maxzoom"] == 3
    assert doc["bounds"] == pytest.approx([-180, -85.051129, 180, 85.051129])
    assert doc["zoom_bounds"] == {"3": pytest.approx([0.0, -40.979898, 45.0, 0.0], abs=1e-5)}
    assert doc["tile_count"] == {"1": 4, "2": 16, "3": 1}
    assert doc["tiles"] == ["tiles/basemap/{z}/{x}/{y}.webp"]
    assert errors("tilejson.schema.json", doc) == []


# --------------------------------------------------------------------------- cell states


def decode(png: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(png)).convert("RGBA")).astype(int)


def test_cellstate_encoding_round_trip():
    state = np.array([[0, 1], [2, 255]], dtype=np.uint8)
    png, pct = mw.encode_cellstate(state)
    rgba = decode(png)
    counts = rgba[..., 0] * 256 + rgba[..., 1]
    assert rgba[..., 3].tolist() == [[255, 255], [0, 0]]  # A = 0 unknown (2 and any other code)
    assert counts[rgba[..., 3] == 255].tolist() == [0, 1]
    assert (rgba[..., 2] == 0).all()
    assert pct == {"assessed": 25.0, "blocked": 25.0, "unknown": 50.0}


def test_lonlat_bounds_eqc_known_answer():
    """eqc: x = R cos(lat_ts) (lon - lon_0), y = R lat, so a 3,000 m wide raster spans
    3000 / (R cos 4.8 deg) rad of longitude and 1,500 m tall spans 1500 / R rad of latitude."""
    from rasterio.transform import Affine

    r = SITE["crs"]["mars_radius_m"]
    t = Affine(3.0, 0, 0.0, 0, -3.0, -284874.0)
    b = mw.lonlat_bounds(t, 1000, 500, SITE)
    dlon = math.degrees(3000 / (r * math.cos(math.radians(4.8))))
    assert b[0] == pytest.approx(137.39, abs=1e-6)
    assert b[2] - b[0] == pytest.approx(dlon, abs=2e-6)
    assert b[3] - b[1] == pytest.approx(math.degrees(1500 / r), abs=2e-6)
    assert b[3] == pytest.approx(math.degrees(-284874.0 / r), abs=1e-6)


# --------------------------------------------------------------------------- fixtures


def write_tile(path: Path, rgb=(120, 90, 60)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(len(str(path)))
    arr = np.clip(rng.normal(rgb, 25, (256, 256, 3)), 0, 255).astype(np.uint8)
    Image.fromarray(arr, "RGB").save(path)


def write_cellstate_tif(path: Path, blocked_rows: int = 10) -> None:
    import rasterio
    from rasterio.transform import Affine

    state = np.zeros((40, 50), dtype=np.uint8)
    state[:blocked_rows, :] = 1
    state[30:, 40:] = 2
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", driver="GTiff", height=40, width=50, count=1, dtype="uint8",
                       crs=SITE["crs"]["analysis_proj"],
                       transform=Affine(3.0, 0, -100.0, 0, -3.0, -284800.0)) as ds:
        ds.write(state, 1)


def entry(file: str, value=1.0) -> dict:
    return {"value": value, "units": "1", "file": file, "script": "pipeline/x.py",
            "commit": "abc", "utc": "2026-11-14T10:00:00Z"}


@pytest.fixture
def tree(tmp_path: Path) -> dict[str, Path]:
    interim = tmp_path / "interim"
    rad = json.loads((REPO / "web/public/data-dummy/conditions/rad.json").read_text())
    rad.pop("dummy", None)
    (interim / "conditions").mkdir(parents=True)
    (interim / "conditions" / "rad.json").write_text(json.dumps(rad))
    for x, y in ((0, 0), (0, 1)):
        write_tile(interim / "terrain/tiles/basemap/13" / str(x) / f"{y}.png")
    write_tile(interim / "terrain/tiles/basemap/14/0/0.png")
    write_cellstate_tif(interim / "terrain" / "cellstate_3m.tif")
    (interim / "terrain" / "coreg.json").write_text(json.dumps(
        {"dx_m": 0.0, "dy_m": 0.0, "residual_median_m": 1.2, "residual_mad_m": 0.4,
         "residuals": []}))
    (interim / "terrain" / "manifest_pending.json").write_text(
        json.dumps({"coreg.dx_m": entry("validation/coreg.json", 0.0)}))
    frags = interim / "manifest"
    frags.mkdir()
    (frags / "pipeline__conditions__rad.json").write_text(
        json.dumps({"rad.baseline_uGy_day": entry("conditions/rad.json", 152.3)}))
    dummy = tmp_path / "dummy"
    dummy.mkdir()
    public = tmp_path / "public"
    public.mkdir()
    (public / ".gitkeep").write_text("")
    (public / "stale.json").write_text("{}")
    return {"interim": interim, "public": public, "dummy": dummy, "frags": frags,
            "rec": tmp_path / "rec"}


def run(tree, **kw) -> tuple[int, list[str]]:
    lines: list[str] = []
    rc = mw.run(tree["interim"], tree["public"], dummy_tree=tree["dummy"],
                settings=kw.pop("settings", SETTINGS), site=SITE, h0=H0,
                record_dir=tree["rec"], out=lines.append, **kw)
    return rc, lines


# --------------------------------------------------------------------------- plan


def test_plan_missing_grouped_by_owner(tree):
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    owners = {o for o, _, _ in p.missing}
    assert "WS2" in owners and "WS7" in owners and "WS4" in owners  # clock/rems/donki missing
    assert ("WS4", "conditions/clock.json", "data/interim/conditions/clock.json") in p.missing
    assert {c.dst.as_posix() for c in p.copies if c.kind == "copy"} == {
        "conditions/rad.json", "validation/coreg.json"}
    assert len(p.tiles) == 3 and not p.refused


@pytest.mark.parametrize("flag", ["dummy", "synthetic"])
def test_plan_refuses_flagged_json(tree, flag):
    (tree["interim"] / "vo").mkdir()
    (tree["interim"] / "vo" / "probe.json").write_text(json.dumps({flag: True}))
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    assert any(f'"{flag}": true' in r for r in p.refused)


def test_plan_refuses_pre_h0_source(tree):
    src = tree["interim"] / "conditions" / "rad.json"
    t = datetime(2026, 11, 13, 12, tzinfo=UTC).timestamp()
    os.utime(src, (t, t))
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    assert any("before H0" in r for r in p.refused)


def test_plan_skips_tiles_above_maxzoom(tree):
    p = mw.plan(tree["interim"], settings={**SETTINGS, "maxzoom": 13},
                dummy_tree=tree["dummy"], h0=H0)
    assert len(p.tiles) == 2 and any("above maxzoom 13" in s for s in p.skipped)


# --------------------------------------------------------------------------- run


def test_run_end_to_end(tree):
    rc, lines = run(tree)
    pub = tree["public"]
    assert rc == 0, "\n".join(lines)
    assert not (pub / "stale.json").exists() and (pub / ".gitkeep").exists()
    assert (pub / "conditions/rad.json").is_file()
    assert sorted(p.relative_to(pub).as_posix() for p in pub.glob("tiles/basemap/*/*/*")) == [
        "tiles/basemap/13/0/0.webp", "tiles/basemap/13/0/1.webp", "tiles/basemap/14/0/0.webp"]
    tj = json.loads((pub / mw.TILEJSON).read_text())
    assert errors("tilejson.schema.json", tj) == [] and tj["maxzoom"] == 14
    cs = json.loads((pub / mw.CELLSTATE_JSON).read_text())
    assert errors("cellstate.schema.json", cs) == []
    assert (cs["width"], cs["height"], cs["res_m"], cs["variant"]) == (50, 40, 3.0, "nominal")
    assert cs["pct"] == {"assessed": 70.0, "blocked": 25.0, "unknown": 5.0}
    rgba = decode((pub / mw.CELLSTATE_PNG).read_bytes())
    assert rgba.shape == (40, 50, 4) and (rgba[30:, 40:, 3] == 0).all()
    m = json.loads((pub / "manifest.json").read_text())
    assert m["dummy"] is False
    assert {"coreg.dx_m", "rad.baseline_uGy_day", "terrain.cellstate.pct.unknown"} <= set(m)
    src_t = (tree["interim"] / "conditions/rad.json").stat().st_mtime
    assert (pub / "conditions/rad.json").stat().st_mtime == pytest.approx(src_t)
    assert any(line.startswith("  WS2: 0 files present") for line in lines)


def test_run_conservative_cellstate_own_web_path(tree):
    """WS1's cellstate_3m_conservative.tif -> terrain/cellstate_conservative.{png,json}
    (variant from the file name, own manifest keys); the nominal files are unchanged."""
    write_cellstate_tif(tree["interim"] / "terrain" / "cellstate_3m_conservative.tif", 20)
    rc, lines = run(tree)
    assert rc == 0, "\n".join(lines)
    pub = tree["public"]
    nom = json.loads((pub / mw.CELLSTATE_JSON).read_text())
    con = json.loads((pub / mw.CELLSTATE_CONS_JSON).read_text())
    assert errors("cellstate.schema.json", con) == []
    assert (nom["variant"], nom["image"]) == ("nominal", mw.CELLSTATE_PNG)
    assert (con["variant"], con["image"]) == ("conservative", mw.CELLSTATE_CONS_PNG)
    assert nom["pct"] == {"assessed": 70.0, "blocked": 25.0, "unknown": 5.0}
    assert con["pct"] == {"assessed": 45.0, "blocked": 50.0, "unknown": 5.0}
    assert con["bounds"] == nom["bounds"]
    rgba = decode((pub / mw.CELLSTATE_CONS_PNG).read_bytes())
    assert (rgba[:20, :, 1] == 1).all() and (rgba[20:30, :, 1] == 0).all()
    m = json.loads((pub / "manifest.json").read_text())
    assert m["terrain.cellstate.pct.blocked"]["value"] == 25.0
    assert m["terrain.cellstate_conservative.pct.blocked"]["value"] == 50.0
    assert m["terrain.cellstate_conservative.pct.blocked"]["file"] == mw.CELLSTATE_CONS_JSON
    assert not any(line.startswith("DANGLING") for line in lines)


def test_run_records_cellstate_keys_before_clearing_public(tree, monkeypatch):
    """git_commit() is '-dirty' once make web has rewritten the tracked public tree, so the
    cell-state keys are recorded first (WS6 audit 1: terrain.cellstate.pct.* were dirty)."""
    seen = {}
    real_clear = mw.clear_public

    def spy(public):
        f = tree["rec"] / "tools__make_web.json"
        seen["keys"] = set(json.loads(f.read_text())) if f.is_file() else set()
        return real_clear(public)

    monkeypatch.setattr(mw, "clear_public", spy)
    rc, lines = run(tree)
    assert rc == 0, "\n".join(lines)
    assert {"terrain.cellstate.pct.assessed", "terrain.cellstate.pct.blocked",
            "terrain.cellstate.pct.unknown"} <= seen["keys"]


def test_run_without_conservative_drops_its_keys(tree):
    """A stale conservative key in make_web's own fragment never cites an unwritten file."""
    (tree["rec"]).mkdir()
    (tree["rec"] / "tools__make_web.json").write_text(json.dumps({
        "terrain.cellstate_conservative.pct.blocked": entry(mw.CELLSTATE_CONS_JSON, 50.0)}))
    (tree["frags"] / "tools__make_web.json").write_text(json.dumps({
        "terrain.cellstate_conservative.pct.blocked": entry(mw.CELLSTATE_CONS_JSON, 50.0)}))
    rc, lines = run(tree)
    assert rc == 0, "\n".join(lines)
    m = json.loads((tree["public"] / "manifest.json").read_text())
    assert "terrain.cellstate.pct.blocked" in m
    assert "terrain.cellstate_conservative.pct.blocked" not in m
    assert ("WS1", "terrain/cellstate_conservative.json",
            "data/interim/terrain/cellstate_3m_conservative.tif") in mw.plan(
        tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0).missing


def test_run_withholds_pad_json(tree, monkeypatch):
    """The WITHHELD mechanism (used for pad.json 14:58-15:30, C decision): a withheld web path is
    reported, never copied, and its manifest entries are left out; other files publish as normal."""
    monkeypatch.setitem(mw.WITHHELD, "pad.json", "test: withheld")
    pub_src = tree["interim"] / "engine" / "public"
    pub_src.mkdir(parents=True)
    (pub_src / "pad.json").write_text(json.dumps({"dummy": False, "pad": {}}))
    (pub_src / "siting.png").write_bytes(b"png")
    (pub_src / "siting_png.json").write_text(json.dumps(
        {"image": "siting.png", "coordinates": [[0, 1], [1, 1], [1, 0], [0, 0]]}))
    (tree["frags"] / "pipeline__engine__siting.json").write_text(json.dumps({
        "pad.lon": entry("pad.json", 137.4), "siting.x": entry("siting_png.json", 1.0)}))
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    assert "pad.json" not in {c.dst.as_posix() for c in p.copies}
    assert not any(w == "pad.json" for _, w, _ in p.missing)
    assert any(s.startswith("withheld: data/interim/engine/public/pad.json") for s in p.skipped)
    rc, lines = run(tree)
    pub = tree["public"]
    assert not (pub / "pad.json").exists() and (pub / "siting.png").is_file()
    m = json.loads((pub / "manifest.json").read_text())
    assert "pad.lon" not in m and "siting.x" in m


def test_pad_json_published_when_not_withheld(tree):
    """After WS2 session 5 (pad = pad_default, proposal block) pad.json is published again."""
    assert "pad.json" not in mw.WITHHELD
    pub_src = tree["interim"] / "engine" / "public"
    pub_src.mkdir(parents=True)
    (pub_src / "pad.json").write_text(json.dumps({"dummy": False, "pad": {}}))
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    assert "pad.json" in {c.dst.as_posix() for c in p.copies}


PAD_FILES = ("summary.json", "bands_104.geojson", "edges.geojson", "partner.geojson",
             "route_nom_104.geojson", "timeline_nom_104.json")


def write_pads(interim: Path, ids=("rank2", "pad_default")) -> Path:
    root = interim / "engine" / "public" / "scenarios" / "pads"
    root.mkdir(parents=True)
    (root / "index.json").write_text(json.dumps({"dummy": False, "pads": []}))
    for pid in ids:
        (root / pid).mkdir()
        for name in PAD_FILES:
            (root / pid / name).write_text(json.dumps({"id": pid}))
    # internal products next to them are never copied
    (root / "rank2" / "t_home.tif").write_bytes(b"II*")
    return root


def test_plan_ws2_pads_rules(tree):
    """v1.1.4 D21 picker (C layout 16:17): scenarios/pads/** mirrors the web tree, owner WS2;
    no isochrones, no rasters."""
    write_pads(tree["interim"])
    (tree["interim"] / "engine/public/scenarios/pads/rank2/isochrones.geojson").write_text("{}")
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    got = {c.dst.as_posix() for c in p.copies if c.owner == "WS2"}
    want = {"scenarios/pads/index.json"} | {f"scenarios/pads/{i}/{n}"
                                            for i in ("rank2", "pad_default") for n in PAD_FILES}
    assert got == want and not p.refused
    assert not any("scenarios/pads" in w for o, w, _ in p.missing)


def test_plan_ws2_pads_missing_reported(tree):
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    assert ("WS2", "scenarios/pads/index.json",
            "data/interim/engine/public/scenarios/pads/index.json") in p.missing


def test_dangling_pads_references(tmp_path):
    pub = tmp_path
    d = pub / "scenarios" / "pads" / "rank2"
    d.mkdir(parents=True)
    (d / "summary.json").write_text(json.dumps({"id": "rank2", "files": {
        "bands": "scenarios/pads/rank2/bands_104.geojson",
        "edges": "scenarios/pads/rank2/edges.geojson"}}))
    (d / "edges.geojson").write_text("{}")
    (pub / "scenarios" / "pads" / "index.json").write_text(json.dumps({"dummy": False, "pads": [
        {"id": "rank1", "official": True, "summary": None},
        {"id": "rank2", "summary": "scenarios/pads/rank2/summary.json"},
        {"id": "rank3", "summary": "scenarios/pads/rank3/summary.json"}]}))
    assert mw.dangling(pub) == [
        "scenarios/pads/rank3/summary.json (named in scenarios/pads/index.json rank3)",
        "scenarios/pads/rank2/bands_104.geojson (named in scenarios/pads/rank2/summary.json)"]


def test_plan_ws8_far_texture_rule(tree):
    """WS8 STATUS: far texture fp3d/far_tex.jpg (8 m ortho over the far mesh)."""
    src = tree["interim"] / "export" / "fp3d" / "far_tex.jpg"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"\xff\xd8jpg")
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    assert any(c.owner == "WS8" and c.dst.as_posix() == "fp3d/far_tex.jpg" for c in p.copies)


def test_run_drops_top_zoom_over_budget(tree):
    rc, lines = run(tree)
    assert rc == 0, "\n".join(lines)
    z = {k: sum(p.stat().st_size for p in tree["public"].glob(f"tiles/basemap/{k}/*/*.webp"))
         for k in (13, 14)}
    budget_mb = (z[13] + z[14] / 2) / 1e6  # z13 fits, z13 + z14 does not
    rc, lines = run(tree, settings={**SETTINGS, "budget_mb": budget_mb})
    assert rc == 0, "\n".join(lines)
    assert any("dropped z14" in s for s in lines)
    tj = json.loads((tree["public"] / mw.TILEJSON).read_text())
    assert tj["maxzoom"] == 13 and tj["tile_count"] == {"13": 2} and tj["zoom_bounds"] == {}
    assert not (tree["public"] / "tiles/basemap/14").exists()


def test_run_budget_below_one_zoom_fails(tree):
    with pytest.raises(RuntimeError, match="one zoom level alone"):
        run(tree, settings={**SETTINGS, "budget_mb": 1e-6})


def test_run_refuses_dummy_manifest_fragment(tree):
    bad = entry("x.json") | {"script": "tools/make_dummy.py", "commit": "dummy"}
    (tree["frags"] / "tools__make_dummy.json").write_text(json.dumps({"x.y": bad}))
    rc, lines = run(tree)
    assert rc == 1 and (tree["public"] / "stale.json").exists()  # public tree untouched
    assert any("dummy entries" in s for s in lines)


def test_run_ws1_fragment_wins_over_pending(tree):
    (tree["frags"] / mw.WS1_FRAGMENT).write_text(
        json.dumps({"coreg.dx_m": entry("validation/coreg.json", 0.0)}))
    rc, lines = run(tree)
    assert rc == 0, "\n".join(lines)  # no duplicate key: pending is not bridged
    assert not any("bridge" in s for s in lines)


def test_run_skip_owner_leaves_files_and_manifest_entries_out(tree):
    (tree["frags"] / "pipeline__conditions__rad.json").write_text(json.dumps({
        "rad.baseline_uGy_day": entry("conditions/rad.json", 152.3),
        "x.other": entry("terrain/cellstate.json"),
        "x.interim": entry("data/interim/conditions/rad.json")}))
    rc, lines = run(tree, skip_owners=("WS4",))
    assert rc == 0, "\n".join(lines)
    assert not (tree["public"] / "conditions").exists()
    m = json.loads((tree["public"] / "manifest.json").read_text())
    assert "rad.baseline_uGy_day" not in m and "x.interim" not in m and "x.other" in m
    assert not any(line.startswith("  WS4:") for line in lines)


def test_run_leaves_out_entries_naming_unwritten_web_files(tree):
    """The manifest never cites a web file that is not in the tree (an owner's output missing
    this run); entries citing pipeline-internal files (data/...) stay."""
    (tree["frags"] / "pipeline__navigation__x.json").write_text(json.dumps({
        "nav.a": entry("nav/fixes.json"), "nav.b": entry("data/interim/navigation/x.tif")}))
    (tree["interim"] / "terrain" / "manifest_pending.json").write_text(json.dumps({
        "coreg.dx_m": entry("validation/coreg.json", 0.0),
        "coverage.pct": entry("validation/coverage.json", 99.0)}))
    rc, lines = run(tree)
    assert rc == 0, "\n".join(lines)
    m = json.loads((tree["public"] / "manifest.json").read_text())
    assert "nav.a" not in m and "nav.b" in m
    assert "coreg.dx_m" in m and "coverage.pct" not in m


def test_dangling_references(tmp_path):
    pub = tmp_path
    (pub / "scenarios" / "a").mkdir(parents=True)
    (pub / "scenarios" / "a" / "isochrones.geojson").write_text("{}")
    (pub / "scenarios" / "index.json").write_text(json.dumps({"dummy": False, "scenarios": [
        {"id": "a", "files": {"isochrones": "scenarios/a/isochrones.geojson",
                              "partner": "scenarios/b/partner.geojson"}}]}))
    (pub / "stations.json").write_text(json.dumps([{"id": "S1", "card": "cards/S1.json"}]))
    assert mw.dangling(pub) == ["scenarios/b/partner.geojson (named in scenarios/index.json a)",
                                "cards/S1.json (named in stations.json S1)"]


# --------------------------------------------------------------------------- station cards


def horizon_part(st: str = "S2", position: str = "access_cell", lon: float = 137.382736,
                 lat: float = -4.777025) -> dict:
    """Shaped like WS3's horizon/public/cards/{S}.json (pipeline/horizon/cards.py)."""
    return {
        "station": st, "producer": "WS3 pipeline/horizon/cards.py", "provisional": False,
        "observer": {"id": st, "science_lon": 137.383058, "science_lat": -4.776687,
                     "lon": lon, "lat": lat, "position": position, "provisional": False},
        "navcam": {"sol": 4414, "image_id": "NLB_789347468EDR_F1120798NCAM00279M_",
                   "url_local": f"cards/{st}/navcam.png", "overlay_png": f"cards/{st}/overlay.png",
                   "stop_id": "v112_798", "dist_to_observer_m": 924.8, "credit": "NASA/JPL"},
        "skyline_error_deg": {"near": None, "mid": None, "far": 3.183},
        "skyline_error_scope": "median |detected - predicted| per class",
        "panorama_png": f"cards/{st}/panorama.png",
        "landmarks": [{"name": "Gediz Vallis", "bearing_deg": 134.47, "dist_km": 3.7,
                       "kind": "official", "above_skyline": False}],
        "landmarks_note": None, "built_utc": "2026-11-14T11:04:16Z"}


def timeline_part(st: str = "S2", access: bool = True) -> dict:
    """Shaped like WS2's engine/public/cards/{S}.timeline.json (pipeline/engine/cards.py)."""
    rule = {"radius_m": 50.0, "rule": "nearest assessed cell with a walk home"}
    if not access:
        return {"station": st, "scenario": "nom_104", "on_route": False,
                "timeline": {"arrive": None, "leave": None, "turn_back": None},
                "margin_binding": None, "margin_min": None,
                "contingency": "No access cell within 50 m.", "t_home_min": None,
                "o2_home_L": None, "science": {"lon": 137.383058, "lat": -4.776687},
                "access": {"lon": None, "lat": None, "dist_m": None, "t_home_min": None,
                           "o2_home_L": None, "reason": "none with a walk home",
                           "walk_in": None, **rule}}
    return {"station": st, "scenario": "nom_104", "on_route": True,
            "timeline": {"arrive": 108.73, "leave": 138.73, "turn_back": 409.15},
            "margin_binding": "dose", "margin_min": 14.89, "contingency": "Cart haul 108 min.",
            "t_home_min": 71.01, "o2_home_L": 95.56,
            "science": {"lon": 137.383058, "lat": -4.776687},
            "access": {"lon": 137.382736, "lat": -4.777025, "dist_m": 27.6, "t_home_min": 71.01,
                       "o2_home_L": 95.56, "reason": None,
                       "walk_in": {"dist_m": 27.6, "modelled": False, "rise_m": 7.79,
                                   "mean_slope_deg": 15.77, "max_slope_deg": 21.99,
                                   "max_terrain_slope_deg": 43.44}, **rule}}


def test_merge_card_takes_every_key_from_one_part():
    h, t = horizon_part(), timeline_part()
    card = mw.merge_card("S2", h, t, {"WS3": "a.json", "WS2": "b.timeline.json"})
    assert errors("card.schema.json", card) == []
    assert card["station"] == "S2"
    for k in ("navcam", "skyline_error_deg", "panorama_png", "landmarks", "observer"):
        assert card[k] == h[k]
    for k in ("timeline", "margin_binding", "contingency", "access", "science", "margin_min"):
        assert card[k] == t[k]
    assert "producer" not in card and "built_utc" not in card  # moved into parts
    assert card["parts"]["WS3"] == {"source": "a.json", "producer": h["producer"],
                                    "built_utc": h["built_utc"]}
    assert card["parts"]["WS2"]["source"] == "b.timeline.json"


def test_merge_card_no_access_cell_has_null_binding():
    """S1 (user decision 11:40): no access cell -> null times, null binding; still a valid card."""
    h = horizon_part("S1", position="science_coordinate_no_access", lon=137.383058,
                     lat=-4.776687)
    card = mw.merge_card("S1", h, timeline_part("S1", access=False))
    assert errors("card.schema.json", card) == []
    assert card["margin_binding"] is None and card["access"]["dist_m"] is None
    assert card["timeline"] == {"arrive": None, "leave": None, "turn_back": None}


@pytest.mark.parametrize("change, match", [
    (lambda h, t: t.update(station="S4"), "is for station 'S4'"),
    (lambda h, t: t.update(navcam={}), r"both parts set \['navcam'\]"),
    (lambda h, t: h["observer"].update(lon=137.4), "not WS2's access cell"),
    (lambda h, t: h["observer"].update(science_lat=-4.7), "science point differs"),
    (lambda h, t: t.update(access={**t["access"], "lon": None, "lat": None}),
     "WS2 has none"),
])
def test_merge_card_refuses_disagreeing_parts(change, match):
    h, t = horizon_part(), timeline_part()
    change(h, t)
    with pytest.raises(mw.CardMergeError, match=match):
        mw.merge_card("S2", h, t)


def write_card_parts(interim: Path, st: str, ws3: bool = True, ws2: bool = True) -> None:
    hc = interim / "horizon/public/cards"
    ec = interim / "engine/public/cards"
    if ws3:
        (hc / st).mkdir(parents=True, exist_ok=True)
        (hc / f"{st}.json").write_text(json.dumps(horizon_part(st)))
        for name in ("navcam", "overlay", "panorama"):
            Image.new("RGBA", (4, 4)).save(hc / st / f"{name}.png")
    if ws2:
        ec.mkdir(parents=True, exist_ok=True)
        (ec / f"{st}.timeline.json").write_text(json.dumps(timeline_part(st)))


def test_plan_pairs_card_parts_and_reports_the_absent_part(tree):
    write_card_parts(tree["interim"], "S2")
    write_card_parts(tree["interim"], "S4", ws2=False)  # WS2 part absent
    write_card_parts(tree["interim"], "S7", ws3=False)  # WS3 part absent
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    assert not p.refused
    assert [c.station for c in p.cards] == ["S2"] and p.unbuilt_cards == ["S4", "S7"]
    assert ("WS2", "cards/S4.json (timeline part (WS2))",
            "data/interim/engine/public/cards/S4.timeline.json") in p.missing
    assert ("WS3", "cards/S7.json (horizon part (WS3))",
            "data/interim/horizon/public/cards/S7.json") in p.missing
    imgs = sorted(c.dst.as_posix() for c in p.copies if c.kind == "card_image")
    assert imgs == ["cards/S2/navcam.png", "cards/S2/overlay.png", "cards/S2/panorama.png"]
    assert not any("timeline" in c.dst.name for c in p.copies)


def test_plan_refuses_disagreeing_card_parts(tree):
    write_card_parts(tree["interim"], "S2")
    f = tree["interim"] / "engine/public/cards/S2.timeline.json"
    f.write_text(json.dumps(timeline_part("S2") | {"station": "S3"}))
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    assert any("card S2" in r for r in p.refused) and not p.cards


def test_run_writes_merged_cards_only(tree):
    write_card_parts(tree["interim"], "S2")
    write_card_parts(tree["interim"], "S4", ws2=False)
    (tree["frags"] / "pipeline__horizon__cards.json").write_text(json.dumps({
        "navcam_sol.S2": entry("cards/S2.json", 4414),
        "navcam_sol.S4": entry("cards/S4.json", 4164)}))
    rc, lines = run(tree)
    assert rc == 0, "\n".join(lines)
    pub = tree["public"]
    assert sorted(p.relative_to(pub).as_posix() for p in pub.glob("cards/**/*") if p.is_file()) \
        == ["cards/S2.json", "cards/S2/navcam.png", "cards/S2/overlay.png",
            "cards/S2/panorama.png"]
    card = json.loads((pub / "cards/S2.json").read_text())
    assert errors("card.schema.json", card) == [] and card["margin_binding"] == "dose"
    parts = [tree["interim"] / "horizon/public/cards/S2.json",
             tree["interim"] / "engine/public/cards/S2.timeline.json"]
    assert (pub / "cards/S2.json").stat().st_mtime == pytest.approx(
        max(q.stat().st_mtime for q in parts))
    m = json.loads((pub / "manifest.json").read_text())
    assert "navcam_sol.S2" in m and "navcam_sol.S4" not in m  # no card S4, so no S4 entries
    assert "cards: built S2; not built S4" in lines
    assert not any(line.startswith("DANGLING") for line in lines)


def test_run_skip_ws2_builds_no_card(tree):
    write_card_parts(tree["interim"], "S2")
    rc, lines = run(tree, skip_owners=("WS2",))
    assert rc == 0, "\n".join(lines)
    assert not (tree["public"] / "cards").exists()
    assert "skipped: cards/S2.json not built (WS2 skipped)" in lines
    assert not any(line.startswith("  WS2:") for line in lines)


def test_dangling_fp3d_index(tmp_path):
    (tmp_path / "fp3d" / "near").mkdir(parents=True)
    (tmp_path / "fp3d" / "near" / "1_2.f32.gz").write_bytes(b"x")
    (tmp_path / "fp3d" / "far.f32.gz").write_bytes(b"x")
    (tmp_path / "fp3d" / "index.json").write_text(json.dumps({
        "dummy": False, "horizon_ring": "fp3d/horizon_ring.json",
        "far": {"file": "fp3d/far.f32.gz", "tex": "fp3d/far_tex.jpg"},
        "chunk_grid": {"chunks": [{"i": 1, "j": 2, "file": "fp3d/near/1_2.f32.gz",
                                   "tex": "fp3d/near_tex/1_2.jpg"}]}}))
    assert mw.dangling(tmp_path) == [
        "fp3d/near_tex/1_2.jpg (named in fp3d/index.json chunk 1_2)",
        "fp3d/far_tex.jpg (named in fp3d/index.json far)",
        "fp3d/horizon_ring.json (named in fp3d/index.json)"]


def test_dangling_card_images(tmp_path):
    (tmp_path / "cards" / "S2").mkdir(parents=True)
    (tmp_path / "cards" / "S2" / "navcam.png").write_bytes(b"x")
    (tmp_path / "cards" / "S2.json").write_text(json.dumps(horizon_part("S2")))
    assert mw.dangling(tmp_path) == ["cards/S2/overlay.png (named in cards/S2.json)",
                                     "cards/S2/panorama.png (named in cards/S2.json)"]


def test_plan_ws2_golden_rule(tree):
    """v1.1.5: engine/public/physio/golden.json -> physio/golden.json (WS2)."""
    src = tree["interim"] / "engine/public/physio/golden.json"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text(json.dumps({"version": "1.0.0", "kind": "homeline_physio_golden",
                               "tolerances": {}, "cases": {"physio": [{"id": "a"}]}}))
    p = mw.plan(tree["interim"], settings=SETTINGS, dummy_tree=tree["dummy"], h0=H0)
    assert [c.owner for c in p.copies if c.dst.as_posix() == "physio/golden.json"] == ["WS2"]

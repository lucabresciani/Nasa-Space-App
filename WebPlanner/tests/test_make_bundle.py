"""tools/make_bundle.py: simulator plan bundle + world pack (D41, contracts/bundle/ v1.0.0).

Known answers first (frame, config hash, field decode, route resampling, storm re-timing, zip
determinism, tamper detection), then the committed fixture: it validates, its zips round-trip
(unzip -> validate -> sha256 match), and repacking reproduces the committed bytes. The full
rebuild from data/interim runs only where the inputs are present and unchanged (not in CI).
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import zipfile
import zlib
from pathlib import Path

import numpy as np
import pytest
from jsonschema import Draft202012Validator
from PIL import Image

from tools import make_bundle as mb

REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / "contracts" / "bundle" / "fixtures" / "official_pad_v1"
PROJ = "+proj=eqc +lat_ts=-4.8 +lat_0=0 +lon_0=137.39 +x_0=0 +y_0=0 +R=3396190 +units=m +no_defs"
R = 3396190.0


def bundle_schema(name: str) -> dict:
    return json.loads((REPO / "contracts" / "bundle" / name).read_text(encoding="utf-8"))


# ------------------------------------------------------------------------------ frame ----
def test_frame_pad_is_origin_and_axes_known_answer():
    f = mb.Frame(pad_id="rank1", lon=137.401783, lat=-4.77748, elev_m=-3742.4, proj=PROJ)
    x, y = f.local(137.401783, -4.77748)
    assert abs(x) < 1e-6 and abs(y) < 1e-6
    # eqc: X = R cos(lat_ts) dlon, Y = R lat (radians)
    x, y = f.local(137.401783 + 0.001, -4.77748 + 0.002)
    assert x == pytest.approx(R * math.cos(math.radians(4.8)) * math.radians(0.001), abs=1e-6)
    assert y == pytest.approx(R * math.radians(0.002), abs=1e-6)
    assert f.pad_xy[0] == pytest.approx(R * math.cos(math.radians(4.8))
                                        * math.radians(137.401783 - 137.39), abs=1e-6)


def test_frame_block_validates():
    f = mb.Frame(pad_id="rank1", lon=137.401783, lat=-4.77748, elev_m=-3742.4, proj=PROJ)
    schema = bundle_schema("bundle.schema.json")
    sub = dict(schema["$defs"]["frame"], **{"$defs": schema["$defs"]})
    assert list(Draft202012Validator(sub).iter_errors(f.block())) == []


# ------------------------------------------------------------------------ config hash ----
def test_config_hash_known_answer(tmp_path):
    (tmp_path / "b.yaml").write_bytes(b"x: 2\n")
    (tmp_path / "a.yaml").write_bytes(b"x: 1\n")
    (tmp_path / "notes.txt").write_bytes(b"ignored")
    want = hashlib.sha256(b"a.yaml\0x: 1\n\0b.yaml\0x: 2\n\0").hexdigest()
    assert mb.config_hash(tmp_path) == f"sha256:{want}"


def test_config_snapshot_validates_and_carries_hash(tmp_path):
    (tmp_path / "crew.yaml").write_text("crew: {body_mass_kg: 75}\n")
    doc, yml = mb.config_snapshot(tmp_path)
    assert doc["files"]["crew.yaml"] == {"crew": {"body_mass_kg": 75}}
    assert doc["config_hash"] == mb.config_hash(tmp_path)
    assert b"body_mass_kg: 75" in yml
    v = Draft202012Validator(bundle_schema("config_snapshot.schema.json"))
    assert list(v.iter_errors(doc)) == []


# ----------------------------------------------------------------------- field decode ----
def _png(counts: np.ndarray, alpha: np.ndarray) -> bytes:
    rgba = np.zeros(counts.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = counts // 256
    rgba[..., 1] = counts % 256
    rgba[..., 3] = alpha
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG")
    return buf.getvalue()


def test_field_png_to_f32_known_answer():
    counts = np.array([[0, 1, 300], [65535, 2, 3]], dtype=np.int64)
    alpha = np.array([[255, 255, 255], [255, 0, 255]], dtype=np.uint8)
    raw = mb.field_png_to_f32(_png(counts, alpha), scale=0.1)
    got = np.frombuffer(raw, dtype="<f4").reshape(2, 3)
    want = np.array([[0.0, 0.1, 30.0], [6553.5, mb.NODATA, 0.3]], dtype=np.float32)
    assert np.array_equal(got, want)
    assert len(raw) == 4 * 6


# ----------------------------------------------------------------------- route sample ----
def test_resample_leg_every_metre_known_answer():
    xs = np.array([0.0, 10.5])
    ys = np.array([0.0, 0.0])
    ts = np.array([1.0, 2.05])  # 10.5 m in 1.05 min
    s, x, y, t = mb.resample_leg(xs, ys, ts, step_m=1.0)
    assert s.tolist() == [float(k) for k in range(11)] + [10.5]
    assert x.tolist() == s.tolist() and set(y.tolist()) == {0.0}
    assert t[0] == 1.0 and t[-1] == pytest.approx(2.05) and t[5] == pytest.approx(1.5)


def test_resample_leg_bends_follow_arc_length():
    xs, ys, ts = np.array([0.0, 3.0, 3.0]), np.array([0.0, 0.0, 4.0]), np.array([0.0, 3.0, 7.0])
    s, x, y, t = mb.resample_leg(xs, ys, ts, step_m=1.0)
    assert s.tolist() == [0, 1, 2, 3, 4, 5, 6, 7]
    assert (x[4], y[4], t[4]) == (3.0, 1.0, 4.0)


def test_route_rows_speed_and_grade():
    rows = mb.route_rows(leg=1, s=np.array([0.0, 1.0, 2.0]), x=np.array([0.0, 1.0, 2.0]),
                         y=np.zeros(3), z=np.array([0.0, 1.0, 1.0]),
                         t=np.array([0.0, 1 / 60, 3 / 60]), slope=[5.0, None, 7.5])
    assert rows[0][6] == pytest.approx(1.0) and rows[1][6] == pytest.approx(0.5)
    assert rows[0][7] == pytest.approx(45.0) and rows[1][7] == pytest.approx(0.0)
    assert rows[2][6] is None and rows[2][7] is None
    assert rows[1][8] is None and rows[2][8] == 7.5


# ---------------------------------------------------------------------------- storm ----
def test_storm_retime_known_answer():
    rad = {"baseline_uGy_day": 150.0, "leash": {"D_allow_mGy": 0.5},
           "storm_2024": {"series": [["2024-05-20T05:00:00Z", 240.0],
                                     ["2024-05-20T06:00:00Z", 4800.0]],
                          "tripwire_utc": "2024-05-20T05:30:00Z",
                          "tripwire_threshold_uGy_day": 450.0, "tripwire_rule": "3x",
                          "peak_uGy_day": 4800.0, "peak_utc": "2024-05-20T06:00:00Z"}}
    doc = mb.storm_doc(rad, t_star_min=44.0, source="rad.json")
    assert doc["rows"][0] == [14.0, "2024-05-20T05:00:00Z", 240.0, 0.01]
    assert doc["rows"][1] == [74.0, "2024-05-20T06:00:00Z", 4800.0, 0.2]
    assert doc["tripwire_eva_min"] == 44.0 and doc["peak_eva_min"] == 74.0
    assert list(Draft202012Validator(bundle_schema("storm.schema.json")).iter_errors(doc)) == []
    none = mb.storm_doc(rad, t_star_min=None, source="rad.json")
    assert none["rows"][0][0] is None and none["tripwire_eva_min"] is None


# ------------------------------------------------------------------------ local geojson ----
def test_geojson_to_local_keeps_properties():
    f = mb.Frame(pad_id="p", lon=137.39, lat=0.0, elev_m=0.0, proj=PROJ)
    doc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"band": 30},
         "geometry": {"type": "MultiLineString",
                      "coordinates": [[[137.39, 0.0], [137.391, 0.0]]]}}]}
    out = mb.geojson_to_local(doc, f)
    c = out["features"][0]["geometry"]["coordinates"][0]
    assert c[0] == [0.0, 0.0]
    assert c[1][0] == pytest.approx(round(R * math.cos(math.radians(4.8)) * math.radians(0.001), 3))
    assert out["features"][0]["properties"] == {"band": 30} and out["frame"] == "pad-local"
    assert doc["features"][0]["geometry"]["coordinates"][0][0] == [137.39, 0.0]  # not mutated


# ---------------------------------------------------------------------------- zip ----
def test_zip_is_deterministic_index_first_then_sorted():
    entries = {"b/z.json": b"{}\n", "index.json": b"{}\n", "a.f32": b"\0\0\0\0"}
    one, two = mb.zip_bytes(entries), mb.zip_bytes(dict(reversed(list(entries.items()))))
    assert one == two
    z = zipfile.ZipFile(io.BytesIO(one))
    assert z.namelist() == ["index.json", "a.f32", "b/z.json"]
    assert {i.date_time for i in z.infolist()} == {mb.ZIP_DATE}


def _tiny_bundle() -> dict[str, bytes]:
    data = np.arange(6, dtype="<f4").tobytes()
    files = {"terrain/x.f32": data, "planner/note.json": b'{"a":1}\n'}
    frame = mb.Frame(pad_id="p", lon=137.39, lat=0.0, elev_m=0.0, proj=PROJ)
    grid = mb.grid_header((2, 3), 1.0, (0.0, 2.0), None, "m", "test")
    entries = [mb.entry("terrain/x.f32", data, role="test grid", frame="pad-local", units="m",
                        contract=None, grid=grid),
               mb.entry("planner/note.json", files["planner/note.json"], role="note",
                        frame="none", units=None, contract=None)]
    index = mb.index_doc(kind="world", bundle_id="world-test", world_version="world-test",
                         engine_commit="abc", config_hash="sha256:" + "0" * 64,
                         created_utc="2026-11-14T16:00:00Z", frame=frame,
                         bounds_m=[0, 0, 3, 2], files=entries)
    files["index.json"] = mb.dump_json(index)
    return files


def test_verify_accepts_tiny_bundle_and_rejects_tampering():
    files = _tiny_bundle()
    assert mb.verify_zip_bytes(mb.zip_bytes(files)) == []
    bad = dict(files, **{"terrain/x.f32": b"\1" * 24})
    assert any("sha256" in e for e in mb.verify_zip_bytes(mb.zip_bytes(bad)))
    extra = dict(files, **{"extra.json": b"{}\n"})
    assert any("not listed" in e for e in mb.verify_zip_bytes(mb.zip_bytes(extra)))
    gone = {k: v for k, v in files.items() if k != "planner/note.json"}
    assert any("missing" in e for e in mb.verify_zip_bytes(mb.zip_bytes(gone)))
    short = dict(files, **{"terrain/x.f32": b"\0" * 20})
    assert any("4 * 2 * 3" in e or "bytes" in e for e in mb.verify_zip_bytes(mb.zip_bytes(short)))


# ----------------------------------------------------------------------- the fixture ----
def fixture_zips() -> list[Path]:
    return sorted(FIXTURE.glob("*.zip"))


@pytest.fixture(scope="module")
def fixture_meta() -> dict:
    p = FIXTURE / "fixture.json"
    if not p.is_file():
        pytest.skip("no committed fixture yet")
    return json.loads(p.read_text(encoding="utf-8"))


def test_fixture_present_and_small(fixture_meta):
    names = {p.name for p in fixture_zips()}
    assert names == set(fixture_meta["zips"]) and {"plan_bundle.zip", "world_pack.zip"} <= names
    for p in fixture_zips() + [FIXTURE / "plan.json"]:
        assert p.stat().st_size < 50 * 1024 * 1024


@pytest.mark.parametrize("name", ["plan_bundle.zip", "world_pack.zip"])
def test_fixture_round_trip_validates(fixture_meta, name):
    """Unzip -> every listed file present with its bytes and sha256 -> every file validates."""
    raw = (FIXTURE / name).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == fixture_meta["zips"][name]["sha256"]
    assert mb.verify_zip_bytes(raw) == []


def test_fixture_plan_json_matches_bundle(fixture_meta):
    z = zipfile.ZipFile(FIXTURE / "plan_bundle.zip")
    assert z.read("plan.json") == (FIXTURE / "plan.json").read_bytes()
    plan = json.loads(z.read("plan.json"))
    index = json.loads(z.read("index.json"))
    world = json.loads(zipfile.ZipFile(FIXTURE / "world_pack.zip").read("index.json"))
    assert plan["pad"]["kind"] == "official" and plan["origin"] == "precomputed"
    assert index["world_version"] == plan["world"]["version"]
    if not world.get("cropped"):
        assert world["world_version"] == plan["world"]["version"]


@pytest.mark.parametrize("name", ["plan_bundle.zip", "world_pack.zip"])
def test_fixture_repack_is_byte_identical(fixture_meta, name):
    """make_bundle's packer reproduces the committed zip from its own entries. Deflate output
    depends on the zlib build, so byte equality is asserted where zlib matches the build's."""
    raw = (FIXTURE / name).read_bytes()
    z = zipfile.ZipFile(io.BytesIO(raw))
    entries = {n: z.read(n) for n in z.namelist()}
    again = mb.zip_bytes(entries)
    if zlib.ZLIB_RUNTIME_VERSION != fixture_meta.get("zlib_runtime"):
        z2 = zipfile.ZipFile(io.BytesIO(again))
        assert z2.namelist() == z.namelist()
        assert [i.CRC for i in z2.infolist()] == [i.CRC for i in z.infolist()]
        pytest.skip(f"zlib {zlib.ZLIB_RUNTIME_VERSION} != build zlib "
                    f"{fixture_meta.get('zlib_runtime')}: entries equal, bytes not compared")
    assert again == raw


def test_fixture_rebuild_from_inputs_is_byte_identical(fixture_meta, tmp_path):
    """Full rebuild from data/interim + config/ (local only: needs the git-ignored inputs, and
    only while every recorded source sha256 still matches)."""
    stale = mb.stale_sources(FIXTURE)
    if stale is None:
        pytest.skip("pipeline inputs (data/interim) not present")
    if stale:
        pytest.skip(f"inputs changed since the fixture was built ({len(stale)} files, e.g. "
                    f"{stale[0]}): run make bundle-fixture")
    if zlib.ZLIB_RUNTIME_VERSION != fixture_meta.get("zlib_runtime"):
        pytest.skip("different zlib build")
    mb.main(["--fixture", "--out", str(tmp_path)])
    for name in fixture_meta["zips"]:
        assert (tmp_path / name).read_bytes() == (FIXTURE / name).read_bytes(), name
    assert (tmp_path / "plan.json").read_bytes() == (FIXTURE / "plan.json").read_bytes()


# ------------------------------------------------- result trees: build_plan_bundle (F30, D53) ----
def _tree(root: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    return root


def test_layered_sources_prefer_the_result_tree(tmp_path):
    public = _tree(tmp_path / "public", {"pad.json": '{"static": true}',
                                         "stations.json": '{"static": true}',
                                         "clock.json": '{"same": 1}'})
    base = mb.Sources(tmp_path / "no-interim", public)
    res = _tree(tmp_path / "results" / "0123456789abcdef",
                {"pad.json": '{"live": true}', "clock.json": '{"same": 1}'})
    srcs = mb.LayeredSources(res, base)
    assert srcs.need("pad.json").json() == {"live": True}
    assert srcs.need("pad.json").path == "results/0123456789abcdef/pad.json"
    assert srcs.need("pad.json").web == "pad.json"
    assert srcs.need("stations.json").json() == {"static": True}
    # byte-identical to the static file: the static provenance is kept
    assert srcs.need("clock.json").path == base.need("clock.json").path
    assert srcs.web("missing.json") is None


def test_layered_sources_list_result_files_and_override_the_manifest(tmp_path):
    public = _tree(tmp_path / "public", {"cards/S1.json": "{}", "cards/S2.json": "{}",
                                         "manifest.json": json.dumps(
                                             {"a": {"file": "x", "v": 1},
                                              "b": {"file": "y", "v": 2}})})
    base = mb.Sources(tmp_path / "no-interim", public)
    assert base.web_paths("cards/", ".json") == ["cards/S1.json", "cards/S2.json"]
    res = _tree(tmp_path / "res", {"cards/S9.json": "{}", "cards/sub/x.json": "{}",
                                   "route_nom.geojson": "{}",
                                   "manifest.json": json.dumps({"b": {"file": "y", "v": 3},
                                                                "version": "1"})})
    srcs = mb.LayeredSources(res, base)
    assert srcs.web_paths("cards/", ".json") == ["cards/S1.json", "cards/S2.json",
                                                 "cards/S9.json"]
    assert srcs.web_paths("route_", ".geojson") == ["route_nom.geojson"]
    assert srcs.manifest == {"a": {"file": "x", "v": 1}, "b": {"file": "y", "v": 3}}


def test_result_origin_and_default_scenario(tmp_path):
    assert mb.result_origin(tmp_path) == "precomputed"  # no run record: a static tree
    (tmp_path / "run_record.json").write_text('{"origin": "computed_live"}')
    assert mb.result_origin(tmp_path) == "computed_live"
    (tmp_path / "run_record.json").write_text('{"origin": "live"}')
    with pytest.raises(ValueError):
        mb.result_origin(tmp_path)
    one = mb.Sources(tmp_path / "x", _tree(tmp_path / "p1", {
        "scenarios/index.json": '{"scenarios": [{"id": "nom"}]}'}))
    assert mb.default_scenario(one) == "nom"
    many = mb.Sources(tmp_path / "x", _tree(tmp_path / "p2", {
        "scenarios/index.json": '{"scenarios": [{"id": "nom"}, {"id": "opt"}]}'}))
    with pytest.raises(ValueError):
        mb.default_scenario(many)


def _interim_as_recorded(fixture: Path, out: Path) -> Path | None:
    """data/interim as the fixture recorded it: a symlink farm over data/interim with every
    stale verbatim-copied source restored from the fixture's copy. None when a stale source
    cannot be restored (it was transformed, not copied)."""
    stale = mb.stale_sources(fixture)
    restore: dict[str, bytes] = {}
    for name in sorted(fixture.glob("*.zip")):
        z = zipfile.ZipFile(name)
        for e in json.loads(z.read("index.json"))["files"]:
            s = e.get("source")
            if s and s["path"] in stale and s["transform"] == "copy" \
                    and hashlib.sha256(data := z.read(e["path"])).hexdigest() == s["sha256"]:
                restore[s["path"].removeprefix("data/interim/")] = data
    if len(restore) != len(set(stale)):
        return None

    def farm(src: Path, dst: Path, rels: set[str]) -> None:
        dst.mkdir(parents=True)
        for c in sorted(src.iterdir()):
            hits = {r for r in rels if r == c.name or r.startswith(c.name + "/")}
            if not hits:
                (dst / c.name).symlink_to(c)
            elif c.name not in hits:
                farm(c, dst / c.name, {r[len(c.name) + 1:] for r in hits})

    farm(mb.INTERIM, out, set(restore))
    for rel, data in restore.items():
        (out / rel).write_bytes(data)
    return out


def _assert_same_zip(got: bytes, want: bytes, zlib_build: str | None) -> None:
    """README rule: bytes compared when the zlib build matches the fixture's, else entries
    and CRCs."""
    if zlib.ZLIB_RUNTIME_VERSION == zlib_build:
        assert got == want
        return
    a, b = zipfile.ZipFile(io.BytesIO(got)), zipfile.ZipFile(io.BytesIO(want))
    assert a.namelist() == b.namelist()
    assert [i.CRC for i in a.infolist()] == [i.CRC for i in b.infolist()]


def test_build_plan_bundle_official_result_tree_equals_fixture(fixture_meta, tmp_path):
    """Known answer (kit K2, plan 0.9): the official pad's result tree (web/public/data, a
    copy of the pipeline's published files) gives the committed fixture's plan_bundle.zip.
    Local only: the shared files come from data/interim; sources that changed since the
    fixture was built are restored from the fixture's verbatim copies."""
    if mb.stale_sources(FIXTURE) is None:
        pytest.skip("pipeline inputs (data/interim) not present")
    interim = _interim_as_recorded(FIXTURE, tmp_path / "interim")
    if interim is None:
        pytest.skip("inputs changed since the fixture was built: run make bundle-fixture")
    fixture_pad = json.loads(zipfile.ZipFile(FIXTURE / "plan_bundle.zip").read("planner/pad.json"))
    public_pad = json.loads((mb.PUBLIC / "pad.json").read_text(encoding="utf-8"))
    if public_pad != fixture_pad and public_pad == _drop_key(fixture_pad, "screening_s"):
        pytest.skip("D51 dropped screening_s from the published pad.json; the frozen fixture "
                    "predates it (C rebuilds it with make bundle-fixture to re-arm this test)")
    raw = mb.build_plan_bundle(mb.PUBLIC, interim=interim)
    _assert_same_zip(raw, (FIXTURE / "plan_bundle.zip").read_bytes(),
                     fixture_meta.get("zlib_runtime"))
    plan = json.loads(zipfile.ZipFile(io.BytesIO(raw)).read("plan.json"))
    assert plan["plan_id"] == fixture_meta["plan_id"] and plan["origin"] == "precomputed"


# entries that carry data/interim-only inputs: source paths, provenance, D39 t*, grid origins
INTERIM_DEPENDENT = {"index.json", "plan.json", "manifest_subset.json", "route.json",
                     "conditions/sun.json", "conditions/storm.json"}


def test_build_plan_bundle_without_interim_matches_fixture_data(fixture_meta, tmp_path):
    """CI half of the known answer: from web/public/data alone (no data/interim) the bundle
    validates (build_plan_bundle raises otherwise), has the fixture's entries, and every entry
    but the provenance-bearing ones is byte-identical to the fixture's."""
    res = mb.PUBLIC
    raw = mb.build_plan_bundle(res, interim=tmp_path / "no-interim", origin="precomputed")
    got, want = zipfile.ZipFile(io.BytesIO(raw)), zipfile.ZipFile(FIXTURE / "plan_bundle.zip")
    assert got.namelist() == want.namelist()
    diff = [n for n in want.namelist() if got.read(n) != want.read(n)]
    # D51: screening_s (wall-clock) left the published pad.json; the frozen fixture keeps it.
    # That is the only allowed difference in planner/pad.json: everything else stays equal.
    if "planner/pad.json" in diff and _drop_key(json.loads(got.read("planner/pad.json")),
                                                "screening_s") == _drop_key(
            json.loads(want.read("planner/pad.json")), "screening_s"):
        diff.remove("planner/pad.json")
    assert set(diff) <= INTERIM_DEPENDENT, diff
    assert json.loads(got.read("plan.json"))["plan_id"] == fixture_meta["plan_id"]


def _drop_key(obj, key):
    """obj with every `key` removed at any depth (D51 fixture comparison)."""
    if isinstance(obj, dict):
        return {k: _drop_key(v, key) for k, v in obj.items() if k != key}
    if isinstance(obj, list):
        return [_drop_key(v, key) for v in obj]
    return obj

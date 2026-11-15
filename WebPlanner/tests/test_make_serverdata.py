"""WS11 task 5 (backend plan 2.1): tools/make_serverdata.py on the synthetic world (CI-fast, no
real data). Known answers first: the fields are padpick.station_fields' own, the manifest lists
every file with its sha256, and a second run gives the same manifest byte for byte."""

import hashlib
import json

import numpy as np
import pytest

from pipeline.engine import padpick
from pipeline.engine.config import load
from pipeline.engine.geo import lonlat_of_xy
from pipeline.engine.graph import load_ws1_grid
from pipeline.engine.synthetic import dummy_world
from pipeline.engine.tests.test_scenarios import _write_tif
from tools import make_serverdata as msd


def _inputs(root):
    """WS1-shaped terrain on the dummy world (as pipeline/engine/tests/test_plan.py), two WS4
    conditions files and WS3 card parts. S3 sits in the nodata hole: no access cell."""
    grid, pad, feats = dummy_world(3.0, half_m=700.0)
    terr = root / "terrain"
    terr.mkdir(parents=True)
    _write_tif(terr / "elev_3m.tif", np.nan_to_num(grid.elev, nan=-32767), grid, "float32",
               -32767)  # fmt: skip
    for name in ("maxslope_3m.tif", "slope_3m.tif"):
        _write_tif(terr / name, np.nan_to_num(grid.maxslope, nan=-1), grid, "float32", -1)
    _write_tif(terr / "cellstate_3m.tif", grid.cellstate, grid, "uint8", 255)
    _write_tif(terr / "stepguard_3m.tif", np.where(grid.cellstate == 2, 255, 0).astype(np.uint8),
               grid, "uint8", 255)  # fmt: skip
    ridge = np.zeros((grid.shape[0] * 3, grid.shape[1] * 3), np.float32)
    ridge[:, 600] = 1.0
    _write_tif(terr / "ridge_index.tif", ridge, grid, "float32", -9999, res=1.0)
    hx, hy = feats["hole_c"]
    hole_rc = grid.rc_of_xy(grid.x0 + 700.0 + hx, grid.y0 - 700.0 + hy)
    rcs = [(pad[0] - 80, pad[1] + 10), (pad[0] + 60, pad[1] - 40), hole_rc]
    st = []
    for i, (r, c) in enumerate(rcs):
        lon, lat = lonlat_of_xy(*grid.xy_of_rc(r, c), grid.crs)
        st.append({"id": f"S{i + 1}", "name": f"Test {i + 1}", "lon": round(float(lon), 6),
                   "lat": round(float(lat), 6)})  # fmt: skip
    st.append({"id": "S9", "name": "No position", "lon": None, "lat": None})
    (terr / "stations.json").write_text(json.dumps({"stations": st}))
    cond = root / "conditions"
    cond.mkdir()
    (cond / "rad.json").write_text('{"leash": {"tau_min_at_peak": 50}}\n')
    (cond / "clock.json").write_text('{"eva": {"t_dark_min": 400}}\n')
    cards = root / "cards"
    (cards / "S1").mkdir(parents=True)
    (cards / "S1.json").write_text('{"station": "S1", "navcam": "cards/S1/navcam.png"}\n')
    (cards / "S2.json").write_text('{"station": "S2"}\n')
    (cards / "S1" / "navcam.png").write_bytes(b"png")  # an image, not a card part
    (cards / "S1.timeline.json").write_text("{}\n")  # the engine part, not WS3's
    return {"terrain": terr, "conditions": cond, "cards": cards}


def _run(out, src, **kw):
    return msd.make_serverdata(out, src["terrain"], src["conditions"], src["cards"],
                               say=lambda *a, **k: None, **kw)  # fmt: skip


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("serverdata")
    src = _inputs(root / "in")
    out = root / "server"
    m, rebuilt = _run(out, src)
    assert rebuilt
    return out, src, m


def test_fields_equal_a_direct_station_fields_call(built):
    """Known answer: each stored field is padpick.station_fields' t_min as float32 (the engine's
    own numbers, no second engine), memory-mappable, for the three variants at 104 kg."""
    out, src, m = built
    grid = load_ws1_grid(src["terrain"])
    stations = {s["id"]: s for s in json.loads((src["terrain"] / "stations.json").read_text())
                ["stations"]}  # fmt: skip
    assert m["suit_kg"] == load("crew")["default_suit_kg"] == 104
    assert m["scenarios"] == ["opt_104", "nom_104", "con_104"]
    checked = 0
    for sid in ("S1", "S2"):
        for scen in m["scenarios"]:
            fwd, rev = padpick.station_fields(grid, stations[sid], scen)
            rec = m["stations"][sid]["fields"][scen]
            assert rec["access_rc"] == [int(v) for v in fwd.seeds[0]]
            for kind, f in (("forward", fwd), ("reverse", rev)):
                got = np.load(out / rec[kind], mmap_mode="r")
                assert isinstance(got, np.memmap) and got.dtype == np.float32
                assert np.array_equal(got, f.t_min.astype(np.float32))
                assert np.isfinite(got).sum() > 1000
                checked += 1
    assert checked == 12


def test_station_without_access_or_position_is_reported_not_invented(built):
    out, _, m = built
    s3 = m["stations"]["S3"]
    assert s3["fields"] == {} and set(s3["no_access"]) == set(m["scenarios"])
    assert all("no passable assessed cell" in r for r in s3["no_access"].values())
    assert not (out / "fields" / "nom_104" / "S3.forward.npy").exists()
    assert m["stations_without_position"] == ["S9"] and "S9" not in m["stations"]


def test_manifest_lists_every_file_with_its_sha256(built):
    out, src, m = built
    on_disk = {p.relative_to(out).as_posix(): p for p in out.rglob("*") if p.is_file()}
    assert set(on_disk) == set(m["files"]) | {msd.MANIFEST}
    for rel, e in m["files"].items():
        b = on_disk[rel].read_bytes()
        assert e == {"sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)}, rel
    assert json.loads((out / msd.MANIFEST).read_bytes()) == m
    # inputs: byte copies; WS3 card parts only (no images, no engine timeline part)
    assert sorted(r for r in m["files"] if r.startswith("cards/")) == ["cards/S1.json",
                                                                      "cards/S2.json"]
    assert sorted(r for r in m["files"] if r.startswith("conditions/")) == [
        "conditions/clock.json", "conditions/rad.json"]
    for rel, sha in m["built_from"]["inputs"].items():
        assert m["files"][rel]["sha256"] == sha
    assert (out / "terrain/elev_3m.tif").read_bytes() == (src["terrain"] / "elev_3m.tif"
                                                          ).read_bytes()  # fmt: skip


def test_grid_arrays_are_load_ws1_grid_memory_mapped(built):
    out, src, m = built
    grid = load_ws1_grid(src["terrain"])
    g = m["grid"]
    assert g["shape"] == list(grid.shape) and g["res_m"] == grid.res_m
    assert (g["x0"], g["y0"], g["crs"]) == (grid.x0, grid.y0, grid.crs)
    for name in msd.GRID_ARRAYS:
        a = np.load(out / g["arrays"][name]["path"], mmap_mode="r")
        assert isinstance(a, np.memmap)
        assert np.array_equal(a, getattr(grid, name), equal_nan=a.dtype.kind == "f"), name
    ridge = np.load(out / g["arrays"]["ridge_3m"]["path"], mmap_mode="r")
    assert ridge.shape == grid.shape and ridge[:, 200].max() == 1.0
    # build_plan / load_ws1_grid run on the copied terrain folder unchanged
    assert np.array_equal(load_ws1_grid(out / "terrain").elev, grid.elev, equal_nan=True)


def test_manifest_validates_and_rejects_a_bad_one(built):
    _, _, m = built
    msd.validate_manifest(m)
    bf = m["built_from"]
    assert bf["tool"] == "tools/make_serverdata.py" and len(bf["engine_tree"]) == 40
    assert bf["config_hash"].startswith("sha256:")
    for bad in ({**m, "files": {**m["files"], "../x": {"sha256": "0" * 64, "bytes": 1}}},
                {**m, "files": {k: v for k, v in m["files"].items() if not k.startswith("grid/")}},
                {**m, "extra": 1},
                {**m, "fields": {**m["fields"], "dtype": "float64"}}):
        with pytest.raises(ValueError):
            msd.validate_manifest(bad)


def test_second_run_gives_the_same_manifest(built, tmp_path):
    """Idempotent: a rebuild (--force) writes the same bytes; a plain re-run is a verified
    no-op. A different output folder gives the same manifest too (no host paths in it)."""
    out, src, m = built
    before = (out / msd.MANIFEST).read_bytes()
    m2, rebuilt = _run(out, src, force=True)
    assert rebuilt and (out / msd.MANIFEST).read_bytes() == before and m2 == m
    m3, rebuilt = _run(out, src)
    assert not rebuilt and m3 == m
    other = tmp_path / "elsewhere"
    _run(other, src)
    assert (other / msd.MANIFEST).read_bytes() == before


def test_terrain_hash_is_the_manifest_sha256(built, monkeypatch):
    """E1's /engine/version terrain_hash (and E2's D57 identity) reads the file this writes."""
    version = pytest.importorskip("server.engine.version")
    out, _, _ = built
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(out))
    assert version.SERVER_DATA_MANIFEST == msd.MANIFEST
    assert version.terrain_hash() == "sha256:" + hashlib.sha256(
        (out / msd.MANIFEST).read_bytes()).hexdigest()  # fmt: skip


def test_changed_input_rebuilds_and_keeps_unowned_entries(built, tmp_path):
    """A changed input rebuilds (new manifest); the swap keeps entries it does not own (the
    results/ cache) and leaves no temp folder behind."""
    _, src0, m0 = built
    src = _inputs(tmp_path / "in")
    out = tmp_path / "server"
    _run(out, src)
    (out / "results" / "abc").mkdir(parents=True)
    (out / "results" / "abc" / "run_record.json").write_text("{}")
    (src["conditions"] / "rad.json").write_text('{"leash": {"tau_min_at_peak": 51}}\n')
    m, rebuilt = _run(out, src)
    assert rebuilt and m["built_from"]["inputs"]["conditions/rad.json"] != \
        m0["built_from"]["inputs"]["conditions/rad.json"]  # fmt: skip
    assert (out / "results" / "abc" / "run_record.json").read_text() == "{}"
    assert not any(k.startswith("results/") for k in m["files"])
    assert sorted(p.name for p in tmp_path.iterdir()) == ["in", "server"]


def test_missing_input_fails_and_leaves_out_untouched(built, tmp_path):
    out, src, _ = built
    before = (out / msd.MANIFEST).read_bytes()
    bad = {**src, "cards": tmp_path / "nocards"}
    with pytest.raises(msd.ServerDataError, match="WS3 horizon card parts"):
        _run(out, bad, force=True)
    assert (out / msd.MANIFEST).read_bytes() == before
    assert msd.main(["--out", str(tmp_path / "x"), "--terrain", str(tmp_path / "none"),
                     "--conditions", str(src["conditions"]), "--cards", str(src["cards"])]) == 2
    assert not (tmp_path / "x").exists()

"""Known-answer tests for WS6 provenance (briefs/WS6.md "Tests", SPEC §9 "Provenance").

- H0 check fails on a planted pre-H0 timestamp and passes otherwise.
- Manifest merge keeps keys unique.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
import yaml
from jsonschema import Draft202012Validator

from pipeline.provenance import check_h0, manifest

REPO = Path(__file__).resolve().parent.parent
EVENT = yaml.safe_load((REPO / "config/event.yaml").read_text())
H0 = check_h0.load_h0()
AFTER_H0 = H0 + timedelta(hours=4)
MANIFEST_SCHEMA = json.loads((REPO / "contracts/manifest.schema.json").read_text())


@pytest.fixture
def frag_dir(tmp_path, monkeypatch):
    d = tmp_path / "fragments"
    monkeypatch.setenv(manifest.FRAGMENT_DIR_ENV, str(d))
    monkeypatch.setattr(manifest, "_utcnow", lambda: AFTER_H0)
    return d


# --------------------------------------------------------------------------- manifest


def test_record_adds_commit_and_utc(frag_dir):
    entry = manifest.record(
        "reachable_pct.nom_104.30", 42.5, "%", "data/interim/x.tif", "pipeline/engine/x.py"
    )
    assert entry["value"] == 42.5
    assert entry["units"] == "%"
    assert entry["file"] == "data/interim/x.tif"
    assert entry["script"] == "pipeline/engine/x.py"
    assert entry["utc"] == AFTER_H0.strftime("%Y-%m-%dT%H:%M:%SZ")
    assert entry["utc"].endswith("Z")
    assert isinstance(entry["commit"], str) and entry["commit"]
    frag = json.loads((frag_dir / "pipeline__engine__x.json").read_text())
    assert frag["reachable_pct.nom_104.30"] == entry


def test_record_relativises_absolute_repo_paths(frag_dir):
    entry = manifest.record(
        "k.abs", 1, "m", str(REPO / "web/public/data/a.json"), str(REPO / "pipeline/a.py")
    )
    assert entry["file"] == "web/public/data/a.json"
    assert entry["script"] == "pipeline/a.py"


def test_record_converts_numpy_and_rejects_nan(frag_dir):
    e = manifest.record("k.np", np.float32(1.5), "deg", "f", "s.py")
    assert e["value"] == 1.5 and type(e["value"]) is float
    e = manifest.record("k.arr", np.array([1, 2]), None, "f", "s.py")
    assert e["value"] == [1, 2] and e["units"] is None
    assert manifest.record("k.none", None, "deg", "f", "s.py")["value"] is None
    with pytest.raises(ValueError):
        manifest.record("k.nan", float("nan"), "deg", "f", "s.py")
    with pytest.raises(ValueError):
        manifest.record("k.inf", [1.0, math.inf], "deg", "f", "s.py")


def test_record_rejects_bad_keys_and_units(frag_dir):
    for bad in ["", "has space", "dummy", 3]:
        with pytest.raises(ValueError):
            manifest.record(bad, 1, "m", "f", "s.py")
    with pytest.raises(ValueError):
        manifest.record("k.u", 1, 5, "f", "s.py")


def test_drop_removes_only_own_keys(frag_dir):
    """drop() retires keys from the calling script's own fragment; other scripts are untouched."""
    manifest.record("a.keep", 1, None, "x.json", "pipeline/a.py")
    manifest.record("a.old", 2, None, "x.json", "pipeline/a.py")
    manifest.record("b.old", 3, None, "x.json", "pipeline/b.py")
    assert manifest.drop(["a.old", "a.never", "b.old"], "pipeline/a.py") == ["a.old"]
    frags = manifest.load_fragments()
    assert set(frags["pipeline__a.json"]) == {"a.keep"}
    assert set(frags["pipeline__b.json"]) == {"b.old"}
    assert manifest.drop(["x"], "pipeline/none.py") == []  # no fragment: no-op


def test_record_refuses_pre_h0_clock(frag_dir, monkeypatch):
    monkeypatch.setattr(manifest, "_utcnow", lambda: H0 - timedelta(seconds=1))
    with pytest.raises(manifest.ManifestError, match="H0"):
        manifest.record("k.early", 1, "m", "f", "s.py")


def test_rerecord_same_script_overwrites(frag_dir):
    manifest.record("k.a", 1, "m", "f", "s.py")
    manifest.record("k.a", 2, "m", "f", "s.py")
    out = manifest.merge(out_path=frag_dir.parent / "manifest.json")
    assert out["k.a"]["value"] == 2


def test_merge_keeps_keys_unique(frag_dir, tmp_path):
    manifest.record("k.a", 1, "m", "f", "pipeline/one.py")
    manifest.record("k.b", 2, "m", "f", "pipeline/two.py")
    out_path = tmp_path / "public" / "manifest.json"
    merged = manifest.merge(out_path=out_path)
    assert set(merged) == {"dummy", "k.a", "k.b"}
    assert merged["dummy"] is False
    on_disk = json.loads(out_path.read_text())
    assert on_disk == merged

    # Same key from a second script: merge must refuse rather than silently pick one.
    manifest.record("k.a", 99, "m", "f", "pipeline/two.py")
    with pytest.raises(manifest.DuplicateKeyError) as exc:
        manifest.merge(out_path=out_path)
    assert "k.a" in str(exc.value)
    assert json.loads(out_path.read_text()) == merged  # untouched on failure


def test_merge_dummy_flag(frag_dir, tmp_path):
    manifest.record("k.a", 1, "m", "f", "tools/make_dummy.py")
    merged = manifest.merge(out_path=tmp_path / "m.json", dummy=True)
    assert merged["dummy"] is True


def test_merged_manifest_validates_against_contract(frag_dir, tmp_path):
    manifest.record("k.a", {"lo": 1, "hi": 2}, "min", "f", "s.py")
    manifest.record("k.b", "O2", None, "f", "s.py")
    merged = manifest.merge(out_path=tmp_path / "m.json")
    Draft202012Validator(MANIFEST_SCHEMA).validate(merged)


def test_merge_cli(frag_dir, tmp_path):
    manifest.record("k.a", 1, "m", "f", "s.py")
    out = tmp_path / "cli.json"
    assert manifest.main(["merge", "--out", str(out)]) == 0
    assert json.loads(out.read_text())["k.a"]["value"] == 1
    manifest.record("k.a", 2, "m", "f", "t.py")
    assert manifest.main(["merge", "--out", str(out)]) == 1


def test_git_commit_dirty_on_untracked_code_not_data(tmp_path, monkeypatch):
    def git(*a):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", str(tmp_path),
                        *a], check=True, capture_output=True)

    git("init", "-q")
    (tmp_path / "README").write_text("x\n")
    git("add", "README")
    git("commit", "-q", "-m", "init")
    monkeypatch.setattr(manifest, "REPO", tmp_path)
    manifest.git_commit.cache_clear()
    try:
        clean = manifest.git_commit()
        assert len(clean) == 40 and not clean.endswith("-dirty")
        (tmp_path / "data").mkdir()
        (tmp_path / "data" / "out.json").write_text("{}")
        manifest.git_commit.cache_clear()
        assert manifest.git_commit() == clean  # untracked outputs are not code
        (tmp_path / "pipeline").mkdir()
        (tmp_path / "pipeline" / "new_step.py").write_text("x = 1\n")
        manifest.git_commit.cache_clear()
        assert manifest.git_commit() == clean + "-dirty"  # uncommitted generating code
    finally:
        manifest.git_commit.cache_clear()


def test_fragment_files_are_world_readable(frag_dir):
    manifest.record("t.mode", 1, "1", "x.json", "pipeline/x.py")
    (frag,) = list(frag_dir.glob("*.json"))
    assert frag.stat().st_mode & 0o044 == 0o044


# --------------------------------------------------------------------------- H0 check


def _write_manifest(d: Path, utcs: list[str]) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    body: dict = {"dummy": False}
    for i, u in enumerate(utcs):
        body[f"k.{i}"] = {"value": i, "units": None, "file": "f", "script": "s", "commit": "c",
                          "utc": u}
    p = d / "manifest.json"
    p.write_text(json.dumps(body))
    return p


def _touch(p: Path, when: datetime) -> None:
    os.utime(p, (when.timestamp(), when.timestamp()))


def test_h0_comes_from_config_and_is_0900_local():
    assert H0 == datetime(2026, 11, 14, 8, 0, tzinfo=UTC)
    assert H0 == check_h0.parse_aware(EVENT["h0_utc"])
    assert H0 == check_h0.parse_aware(EVENT["h0_local"])  # 09:00 Europe/Zurich (UTC+1)


def test_load_h0_refuses_inconsistent_config(tmp_path):
    (tmp_path / "event.yaml").write_text(
        'h0_local: "2026-11-14T09:00:00+01:00"\nh0_utc: "2026-11-14T09:00:00Z"\n')
    with pytest.raises(ValueError, match="disagree"):
        check_h0.load_h0(tmp_path)


def test_h0_check_passes_after_h0(tmp_path):
    d = tmp_path / "data"
    p = _write_manifest(d, ["2026-11-14T08:00:00Z", "2026-11-14T10:30:00+01:00"])
    _touch(p, AFTER_H0)
    assert check_h0.check(d, H0) == []


def test_h0_check_fails_on_planted_pre_h0_manifest_time(tmp_path):
    d = tmp_path / "data"
    p = _write_manifest(d, ["2026-11-14T10:00:00Z", "2026-11-14T07:59:59Z"])
    _touch(p, AFTER_H0)
    problems = check_h0.check(d, H0)
    assert len(problems) == 1 and "k.1" in problems[0]


def test_h0_check_fails_on_nested_manifest(tmp_path):
    d = tmp_path / "data"
    p = _write_manifest(d / "sub", ["2026-11-13T23:00:00Z"])
    _touch(p, AFTER_H0)
    assert len(check_h0.check(d, H0)) == 1


def test_h0_check_fails_on_bad_or_naive_manifest_time(tmp_path):
    d = tmp_path / "data"
    p = _write_manifest(d, ["2026-11-14T10:00:00", "not a time"])
    _touch(p, AFTER_H0)
    assert len(check_h0.check(d, H0)) == 2


def test_h0_check_fails_on_planted_pre_h0_mtime(tmp_path):
    d = tmp_path / "data"
    (d / "scenarios").mkdir(parents=True)
    f = d / "scenarios" / "old.geojson"
    f.write_text("{}")
    _touch(f, H0 - timedelta(seconds=1))
    problems = check_h0.check(d, H0)
    assert len(problems) == 1 and "old.geojson" in problems[0]
    _touch(f, H0)
    assert check_h0.check(d, H0) == []


def test_h0_check_empty_or_missing_dir_passes(tmp_path):
    assert check_h0.check(tmp_path / "missing", H0) == []
    assert check_h0.check(tmp_path, H0) == []
    keep = tmp_path / ".gitkeep"  # git placeholder, not a data file
    keep.write_text("")
    _touch(keep, H0 - timedelta(days=1))
    assert check_h0.check(tmp_path, H0) == []


def test_h0_check_refuses_data_dummy(tmp_path):
    pub = tmp_path / "public"
    d = pub / "data"
    d.mkdir(parents=True)
    dummy = pub / "data-dummy"
    p = _write_manifest(dummy, ["2020-01-01T00:00:00Z"])
    _touch(p, H0 - timedelta(days=1))
    assert check_h0.check(d, H0) == []  # the sibling dummy tree is not scanned
    with pytest.raises(ValueError):
        check_h0.check(dummy, H0)


def test_h0_check_main_exit_codes(tmp_path):
    d = tmp_path / "data"
    p = _write_manifest(d, ["2026-11-13T22:00:00Z"])
    _touch(p, AFTER_H0)
    assert check_h0.main(["--data-dir", str(d)]) == 1
    p.unlink()
    assert check_h0.main(["--data-dir", str(d)]) == 0


def test_h0_check_extra_manifest_argument(tmp_path):
    """CI also checks the merged interim manifest/fragments when given."""
    frag = tmp_path / "frag"
    frag.mkdir()
    (frag / "pipeline__x.json").write_text(json.dumps(
        {"k.a": {"value": 1, "units": "m", "file": "f", "script": "s", "commit": "c",
                 "utc": "2026-11-14T07:00:00Z"}}))
    assert check_h0.main(["--data-dir", str(tmp_path / "none"), "--fragments", str(frag)]) == 1


# --------------------------------------------------------------------------- V1 tilt (F13)
# Brief KAT: V1 on a synthetic 10% plane gives bias ~ 0.

import xml.etree.ElementTree as ET  # noqa: E402

from rasterio.transform import Affine  # noqa: E402

from pipeline.validation import figures, v1_tilt  # noqa: E402

SITE = yaml.safe_load((REPO / "config/site.yaml").read_text())
VCFG = yaml.safe_load((REPO / "config/validation.yaml").read_text())["v1"]
V1_SCHEMA = json.loads((REPO / "contracts/v1.schema.json").read_text())
RES = 1.0
GRADE = 0.10  # 10% plane
PLANE_TILT = math.degrees(math.atan(GRADE))  # 5.7106 deg
FP = 3.0  # test footprint (any odd number of 1 m cells works for the plane KATs)


def _north_up(west, north, res=RES):
    return Affine(res, 0.0, west, 0.0, -res, north)


def _centres(t, cols, rows):
    return t.c + t.a * cols, t.f + t.e * rows


def _plane_dem(n=60, gx=GRADE, gy=0.0, x0=1000.0, y0=2000.0):
    """North-up DEM z = gx*x + gy*y on cell centres; returns (dem, transform)."""
    t = _north_up(x0, y0)
    cols, rows = np.meshgrid(np.arange(n), np.arange(n))
    xs, ys = _centres(t, cols + 0.5, rows + 0.5)
    return (gx * xs + gy * ys).astype(np.float64), t


def _drive_ends(t, n=60, k=25, seed=1):
    rng = np.random.default_rng(seed)
    x = t.c + rng.uniform(5.0, n * RES - 5.0, k)
    y = t.f - rng.uniform(5.0, n * RES - 5.0, k)
    return x, y


def test_v1_config_thresholds_from_spec():
    assert v1_tilt.confusion_thresholds() == (10.0, 20.0)
    assert VCFG["confusion_thresholds_deg"] == [10, 20]


def test_v1_synthetic_10pct_plane_bias_zero():
    dem, t = _plane_dem()
    x, y = _drive_ends(t)
    dem_tilt = v1_tilt.dem_tilt_at(dem, t, x, y, FP)
    np.testing.assert_allclose(dem_tilt, PLANE_TILT, atol=1e-6)
    res = v1_tilt.compare(dem_tilt, np.full_like(dem_tilt, PLANE_TILT), (10, 20))
    assert abs(res["bias_deg"]) < 1e-6
    assert res["rmse_deg"] < 1e-6
    assert res["n"] == len(x) and res["n_excluded"] == 0
    assert res["r"] is None  # zero variance: r undefined, never invented


@pytest.mark.parametrize("fp", [3.0, 5.0])
def test_v1_plane_direction_and_footprint_do_not_matter(fp):
    g = GRADE / math.sqrt(2)
    dem, t = _plane_dem(gx=g, gy=-g)
    x, y = _drive_ends(t)
    np.testing.assert_allclose(v1_tilt.dem_tilt_at(dem, t, x, y, fp), PLANE_TILT, atol=1e-6)


def test_v1_known_imu_offset_gives_bias():
    dem, t = _plane_dem()
    x, y = _drive_ends(t)
    dem_tilt = v1_tilt.dem_tilt_at(dem, t, x, y, FP)
    res = v1_tilt.compare(dem_tilt, dem_tilt + 1.0, (10, 20))  # bias = DEM - IMU
    assert res["bias_deg"] == pytest.approx(-1.0)
    assert res["rmse_deg"] == pytest.approx(1.0)


def test_v1_varying_slope_correlates():
    # z = 0.5*k*x^2: tan(slope) = k*x; a symmetric window plane fit is exact at the centre.
    n, k = 80, 0.004
    t = _north_up(0.0, 100.0)
    cols, rows = np.meshgrid(np.arange(n), np.arange(n))
    xs, _ = _centres(t, cols + 0.5, rows + 0.5)
    dem = 0.5 * k * xs**2
    x = np.arange(5, 75, 3) + 0.5  # cell centres, so the window is symmetric
    y = np.full_like(x, 50.5)
    imu = np.degrees(np.arctan(k * x))
    dem_tilt = v1_tilt.dem_tilt_at(dem, t, x, y, FP)
    np.testing.assert_allclose(dem_tilt, imu, atol=1e-6)
    assert v1_tilt.compare(dem_tilt, imu, (10, 20))["r"] == pytest.approx(1.0)


def test_v1_nodata_and_outside_are_excluded_not_filled():
    dem, t = _plane_dem()
    nodata = -3.4e38
    dem[30, 30] = nodata
    dem[10, 10] = np.nan
    x0, y0 = _centres(t, 30.5, 30.5)
    x1, y1 = _centres(t, 10.5, 10.5)
    x = np.array([x0, x0 + 10, t.c - 50.0, x1])  # nodata, valid, outside the DEM, NaN
    y = np.array([y0, y0, y0, y1])
    tilt = v1_tilt.dem_tilt_at(dem, t, x, y, FP, nodata=nodata)
    assert math.isnan(tilt[0]) and math.isnan(tilt[2]) and math.isnan(tilt[3])
    assert tilt[1] == pytest.approx(PLANE_TILT)
    res = v1_tilt.compare(tilt, np.full(4, PLANE_TILT), (10, 20))
    assert res["n"] == 1 and res["n_excluded"] == 3


def test_v1_rejects_rotated_transform():
    dem, _ = _plane_dem()
    with pytest.raises(ValueError):
        v1_tilt.dem_tilt_at(dem, Affine(1, 0.1, 0, 0, -1, 0), [5.0], [-5.0], FP)


def test_v1_confusion_matrix_known_answer():
    dem = np.array([5.0, 12.0, 25.0, 8.0, 21.0, 15.0])
    imu = np.array([4.0, 9.0, 22.0, 11.0, 19.0, 16.0])
    cm = v1_tilt.compare(dem, imu, (10, 20))["confusion"]
    # positive = tilt >= threshold; DEM is the prediction, IMU the reference
    assert cm["10"] == {"tp": 3, "fp": 1, "fn": 1, "tn": 1}
    assert cm["20"] == {"tp": 1, "fp": 1, "fn": 0, "tn": 4}


def test_v1_stats_known_answer():
    dem = np.array([1.0, 2.0, 3.0, 4.0])
    imu = np.array([2.0, 2.0, 2.0, 6.0])
    res = v1_tilt.compare(dem, imu, (10, 20))
    assert res["bias_deg"] == pytest.approx(-0.5)  # mean(-1, 0, 1, -2)
    assert res["rmse_deg"] == pytest.approx(math.sqrt(1.5))  # sqrt((1+0+1+4)/4)
    assert res["r"] == pytest.approx(np.corrcoef(dem, imu)[0, 1])


def test_v1_empty_gives_nulls():
    res = v1_tilt.compare([], [], (10, 20))
    assert res["n"] == 0 and res["bias_deg"] is None and res["rmse_deg"] is None
    assert res["r"] is None


def test_v1_tilt_from_roll_pitch():
    assert v1_tilt.tilt_from_roll_pitch(0.0, 0.0) == pytest.approx(0.0)
    assert v1_tilt.tilt_from_roll_pitch(10.0, 0.0) == pytest.approx(10.0)
    assert v1_tilt.tilt_from_roll_pitch(0.0, -7.0) == pytest.approx(7.0)
    # cos(tilt) = cos(roll) cos(pitch): 6 deg and 8 deg combine to about 9.99 deg
    want = math.degrees(math.acos(math.cos(math.radians(6)) * math.cos(math.radians(8))))
    assert v1_tilt.tilt_from_roll_pitch(6.0, 8.0) == pytest.approx(want)


def test_v1_focus_filter_uses_config_aoi():
    aoi = SITE["aoi_focus"]
    lon = np.array([(aoi["west"] + aoi["east"]) / 2, aoi["east"] + 0.01])
    lat = np.array([(aoi["south"] + aoi["north"]) / 2, aoi["north"]])
    assert v1_tilt.in_focus(lon, lat).tolist() == [True, False]


def test_v1_real_run_refuses_unset_footprint(tmp_path, monkeypatch):
    monkeypatch.setattr(v1_tilt, "_v1_config", lambda: {**VCFG, "footprint_m": None})
    with pytest.raises(v1_tilt.V1Blocked, match="footprint"):
        v1_tilt.footprint_m()


def test_v1_write_result_validates_records_and_plots(tmp_path, frag_dir):
    dem = np.array([5.0, 12.0, 25.0, 8.0])
    imu = np.array([4.0, 9.0, 22.0, np.nan])
    res = v1_tilt.compare(dem, imu, (10, 20))
    out, svg = tmp_path / "v1.json", tmp_path / "v1.svg"
    doc = v1_tilt.write_result(res, out, svg, footprint_m=FP, dem_file="data/interim/dem.tif")
    data = json.loads(out.read_text())
    assert data == doc
    errors = list(Draft202012Validator(V1_SCHEMA).iter_errors(data))
    assert not errors, errors
    assert data["n"] == 3 and data["n_excluded"] == 1 and len(data["points"]) == 3
    assert data["footprint_m"] == FP
    merged = manifest.merge(out_path=tmp_path / "manifest.json")
    for key in ("v1.bias_deg", "v1.rmse_deg", "v1.r", "v1.n", "v1.n_excluded", "v1.footprint_m",
                "v1.confusion.10.tp", "v1.confusion.20.tn"):
        assert merged[key]["file"] == "validation/v1.json", key
        assert merged[key]["script"] == "pipeline/validation/v1_tilt.py"
    assert merged["v1.n"]["value"] == 3
    assert merged["v1.bias_deg"]["units"] == "deg"
    circles = ET.parse(svg).getroot().findall(f".//{{{figures.SVG_NS}}}circle")
    assert len(circles) == 3


def _write_plane_tif(path: Path, xc: float, yc: float, n: int = 200) -> None:
    import rasterio
    from rasterio.crs import CRS

    t = _north_up(round(xc) - n / 2, round(yc) + n / 2)
    cols, rows = np.meshgrid(np.arange(n), np.arange(n))
    xs, _ = _centres(t, cols + 0.5, rows + 0.5)
    prof = dict(driver="GTiff", width=n, height=n, count=1, dtype="float32",
                crs=CRS.from_proj4(SITE["crs"]["analysis_proj"]), transform=t,
                nodata=float("nan"))
    with rasterio.open(path, "w", **prof) as dst:
        dst.write((GRADE * xs).astype(np.float32), 1)


def test_v1_run_on_geotiff_plane_bias_zero(tmp_path, frag_dir):
    a = SITE["aoi_focus"]
    lon_c, lat_c = (a["west"] + a["east"]) / 2, (a["south"] + a["north"]) / 2
    lon = lon_c + np.array([0.0, 0.0002, -0.0002, 0.01, 0.0])
    lat = lat_c + np.array([0.0, 0.0001, -0.0001, 0.0, 0.0])
    lon[4] = a["east"] + 0.01  # outside the focus area: not counted at all
    x, y = v1_tilt.lonlat_to_xy(lon, lat)
    dem = tmp_path / "dem_1m.tif"
    _write_plane_tif(dem, float(x[0]), float(y[0]))  # point 3 (0.01 deg east) is off the DEM
    out = tmp_path / "v1.json"
    doc = v1_tilt.run(dem, lon, lat, np.full(5, PLANE_TILT), out, None, footprint_m=FP)
    assert doc["n_drive_ends"] == 5 and doc["n_in_focus"] == 4
    assert doc["n"] == 3 and doc["n_excluded"] == 1
    assert abs(doc["bias_deg"]) < 1e-4 and doc["rmse_deg"] < 1e-4
    assert Draft202012Validator(V1_SCHEMA).is_valid(json.loads(out.read_text()))


def test_v1_run_refuses_dem_in_wrong_crs(tmp_path, frag_dir):
    import rasterio
    from rasterio.crs import CRS

    dem = tmp_path / "wrong.tif"
    prof = dict(driver="GTiff", width=10, height=10, count=1, dtype="float32",
                crs=CRS.from_epsg(4326), transform=_north_up(0, 0, 0.001))
    with rasterio.open(dem, "w", **prof) as dst:
        dst.write(np.zeros((1, 10, 10), np.float32))
    with pytest.raises(ValueError, match="CRS"):
        v1_tilt.run(dem, [137.39], [-4.8], [1.0], tmp_path / "v1.json", None, footprint_m=FP)


def test_records_under_pytest_never_reach_shared_fragments(monkeypatch):
    monkeypatch.delenv(manifest.FRAGMENT_DIR_ENV, raising=False)
    monkeypatch.setattr(manifest, "_utcnow", lambda: AFTER_H0)
    d = manifest._fragment_dir(None)
    assert d != manifest.DEFAULT_FRAGMENT_DIR
    manifest.record("t.leak", 1, "1", "x.json", "pipeline/leak_probe.py")
    assert (d / "pipeline__leak_probe.json").exists()
    assert not (manifest.DEFAULT_FRAGMENT_DIR / "pipeline__leak_probe.json").exists()



def _mmgis(path: Path, rows: list[dict]) -> Path:
    feats = [{"type": "Feature", "geometry": {"type": "Point",
                                              "coordinates": [r["lon"], r["lat"], -3700.0]},
              "properties": {"RMC": f"1_{i}", "sol": 4000 + i, "drive_type": "final", **r}}
             for i, r in enumerate(rows)]
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    return path


def test_v1_load_mmgis_and_imu_tilt_validity(tmp_path):
    p = _mmgis(tmp_path / "wp.json", [
        {"lon": 137.39, "lat": -4.80, "tilt": 5.0, "roll": 3.0, "pitch": 4.0},
        {"lon": 137.39, "lat": -4.80, "tilt": -2.24, "roll": 1.0, "pitch": 2.0},  # anomaly
        {"lon": 137.39, "lat": -4.80, "tilt": None, "roll": 0.0, "pitch": 0.0},
    ])
    de = v1_tilt.load_mmgis(p)
    assert de["rmc"].tolist() == ["1_0", "1_1", "1_2"] and de["sol"].tolist() == [4000, 4001, 4002]
    t = v1_tilt.imu_tilt(de, "tilt")
    assert t[0] == 5.0 and math.isnan(t[1]) and math.isnan(t[2])  # negative tilt is invalid
    rp = v1_tilt.imu_tilt(de, "roll_pitch")
    assert rp[0] == pytest.approx(v1_tilt.tilt_from_roll_pitch(3.0, 4.0))
    with pytest.raises(ValueError):
        v1_tilt.imu_tilt(de, "yaw")


def test_v1_coreg_shift_is_applied(tmp_path, frag_dir):
    """Drive ends sit on a ridge-free slope z = 0.5*k*x^2 whose tilt varies with x: a known x
    shift moves every DEM tilt; applying it gives zero bias, omitting it does not."""
    a = SITE["aoi_focus"]
    lon_c, lat_c = (a["west"] + a["east"]) / 2, (a["south"] + a["north"]) / 2
    lon = lon_c + np.array([-0.0003, 0.0, 0.0003])
    lat = np.full(3, lat_c)
    x, y = v1_tilt.lonlat_to_xy(lon, lat)
    shift = (20.0, 0.0)  # DEM frame = rover position + shift
    xd = x + shift[0]
    import rasterio
    from rasterio.crs import CRS

    n, k = 200, 0.004
    x_origin = round(float(x[1])) - n / 2
    t = _north_up(x_origin, round(float(y[1])) + n / 2)
    cols, rows = np.meshgrid(np.arange(n), np.arange(n))
    xs, _ = _centres(t, cols + 0.5, rows + 0.5)
    u = xs - x_origin
    dem = tmp_path / "dem.tif"
    prof = dict(driver="GTiff", width=n, height=n, count=1, dtype="float64",
                crs=CRS.from_proj4(SITE["crs"]["analysis_proj"]), transform=t, nodata=None)
    with rasterio.open(dem, "w", **prof) as dst:
        dst.write(0.5 * k * u**2, 1)
    imu = np.degrees(np.arctan(k * (xd - x_origin)))  # truth at the shifted positions
    good = v1_tilt.run(dem, lon, lat, imu, tmp_path / "a.json", None, footprint_m=FP,
                       shift_xy_m=shift)
    assert good["n"] == 3 and good["shift_xy_m"] == [20.0, 0.0]
    assert abs(good["bias_deg"]) < 0.2  # the 1 m window centres within 0.5 m of the point
    bad = v1_tilt.run(dem, lon, lat, imu, tmp_path / "b.json", None, footprint_m=FP)
    assert abs(bad["bias_deg"]) > 1.0



def _real_inputs(tmp_path: Path, dx=0.0, dy=0.0):
    a = SITE["aoi_focus"]
    lon_c, lat_c = (a["west"] + a["east"]) / 2, (a["south"] + a["north"]) / 2
    rows = [
        {"lon": lon_c, "lat": lat_c, "tilt": PLANE_TILT, "roll": 0.0, "pitch": PLANE_TILT},
        {"lon": lon_c + 2e-4, "lat": lat_c + 1e-4, "tilt": PLANE_TILT, "roll": 0.0,
         "pitch": PLANE_TILT},
        {"lon": lon_c - 2e-4, "lat": lat_c, "tilt": -2.24, "roll": 0.0, "pitch": PLANE_TILT},
        {"lon": lon_c + 0.01, "lat": lat_c, "tilt": PLANE_TILT, "roll": 0.0,
         "pitch": PLANE_TILT},  # in focus, off the DEM
        {"lon": a["east"] + 0.01, "lat": lat_c, "tilt": PLANE_TILT, "roll": 0.0,
         "pitch": PLANE_TILT},  # outside the focus area
    ]
    mm = _mmgis(tmp_path / "wp.json", rows)
    x, y = v1_tilt.lonlat_to_xy([lon_c], [lat_c])
    dem = tmp_path / "dem_1m.tif"
    _write_plane_tif(dem, float(x[0]), float(y[0]))
    coreg = tmp_path / "coreg.json"
    coreg.write_text(json.dumps({"dx_m": dx, "dy_m": dy, "residual_median_m": 0.0,
                                 "residual_mad_m": 0.0, "residuals": []}))
    return mm, coreg, dem


def test_v1_config_footprint_decided_3m():
    """User decision 2026-11-14 12:37 (STATUS Decision log): 3 m (SPEC F13); 5 m is sensitivity."""
    assert VCFG["footprint_m"] == 3 and v1_tilt.footprint_m() == 3.0
    assert 5 in VCFG["footprint_candidates_m"]


def test_v1_run_real_blocked_until_footprint_decided(tmp_path, frag_dir, monkeypatch):
    monkeypatch.setattr(v1_tilt, "_v1_config", lambda: {**VCFG, "footprint_m": None})
    mm, coreg, dem = _real_inputs(tmp_path)
    assert v1_tilt.main(["--mmgis", str(mm), "--coreg", str(coreg), "--dem", str(dem),
                         "--out", str(tmp_path / "v1.json"), "--svg", str(tmp_path / "v1.svg")]
                        ) == 2
    assert not (tmp_path / "v1.json").exists()


def test_v1_run_real_blocked_on_null_shift(tmp_path, frag_dir, monkeypatch):
    monkeypatch.setattr(v1_tilt, "_v1_config", lambda: {**VCFG, "footprint_m": FP})
    mm, coreg, dem = _real_inputs(tmp_path)
    coreg.write_text(json.dumps({"dx_m": None, "dy_m": None}))
    with pytest.raises(v1_tilt.V1Blocked):
        v1_tilt.run_real(mm, coreg, dem, tmp_path / "v1.json", None)


def test_v1_run_real_plane(tmp_path, frag_dir, monkeypatch):
    monkeypatch.setattr(v1_tilt, "_v1_config", lambda: {**VCFG, "footprint_m": FP})
    mm, coreg, dem = _real_inputs(tmp_path)
    out, svg = tmp_path / "v1.json", tmp_path / "v1.svg"
    doc = v1_tilt.run_real(mm, coreg, dem, out, svg)
    assert doc["n_drive_ends"] == 5 and doc["n_in_focus"] == 4
    assert doc["n"] == 2 and doc["n_excluded"] == 2
    assert doc["excluded"] == {"dem_nodata_or_outside": 1, "imu_invalid": 1}
    assert doc["point_ids"] == ["1_0", "1_1"]
    assert abs(doc["bias_deg"]) < 1e-4 and doc["rmse_deg"] < 1e-4
    sens = doc["sensitivity"]
    assert set(sens) == {"footprint_5m", "imu_roll_pitch", "all_in_dem"}  # 3 m is primary
    assert abs(sens["footprint_5m"]["bias_deg"]) < 1e-4
    assert sens["imu_roll_pitch"]["n"] == 3  # roll/pitch is valid where tilt was -2.24
    assert Draft202012Validator(V1_SCHEMA).is_valid(json.loads(out.read_text()))
    m = manifest.merge(out_path=tmp_path / "manifest.json")
    assert m["v1.rmse_deg"]["file"] == "validation/v1.json"
    assert "v1.sensitivity.footprint_5m.rmse_deg" in m
    assert len(ET.parse(svg).getroot().findall(f".//{{{figures.SVG_NS}}}circle")) == 2
    # D23 (user 16:16/16:20): V1 is a validation, not a margin. No no-go is derived from the
    # RMSE; the conservative limit is only cited from config, and never as a v1.* manifest key.
    assert doc["role"] == "V1 = validation of the slope model, not a safety margin"
    assert "conservative_nogo" not in doc
    ctx = doc["nogo_context"]
    assert ctx["derived_from_v1"] is False and ctx["decision"] == "D23"
    assert ctx["conservative_nogo_deg"] == 17.0
    assert ctx["text"] == "conservative no-go = 17° (D23, config)"
    assert not [k for k in m if k.startswith("v1.conservative_nogo") or "nogo" in k]


def test_v1_run_real_drops_retired_nogo_key(tmp_path, frag_dir, monkeypatch):
    """A fragment from a pre-D23 run still holds v1.conservative_nogo.nogo_deg; the re-run
    removes it so the merged manifest never shows a V1-derived no-go."""
    monkeypatch.setattr(v1_tilt, "_v1_config", lambda: {**VCFG, "footprint_m": FP})
    manifest.record("v1.conservative_nogo.nogo_deg", 14.553, "deg", "validation/v1.json",
                    v1_tilt.__file__)
    mm, coreg, dem = _real_inputs(tmp_path)
    v1_tilt.run_real(mm, coreg, dem, tmp_path / "v1.json", None)
    m = manifest.merge(out_path=tmp_path / "manifest.json")
    assert "v1.conservative_nogo.nogo_deg" not in m and "v1.rmse_deg" in m


NOGO_SRC_V = "config/variants.yaml variants.conservative.nogo_deg"
NOGO_SRC_S = "config/site.yaml slope.nogo_deg.conservative"


def _nogo_cfg(monkeypatch, variants_val, site_val):
    var = yaml.safe_load((REPO / "config/variants.yaml").read_text())
    var["variants"]["conservative"]["nogo_deg"] = variants_val
    site = {**SITE, "slope": {**SITE["slope"],
                              "nogo_deg": {**SITE["slope"]["nogo_deg"], "conservative": site_val}}}
    monkeypatch.setattr(v1_tilt, "_variants", lambda: var)
    monkeypatch.setattr(v1_tilt, "_site", lambda: site)


def test_v1_nogo_context_real_config():
    """Main and WS2's branch both resolve to D23's 17 deg (number in site.yaml and/or
    variants.yaml; the legacy string is never evaluated)."""
    ctx = v1_tilt.nogo_context()
    assert ctx["conservative_nogo_deg"] == 17.0 and ctx["derived_from_v1"] is False
    assert ctx["source"] in (NOGO_SRC_V, NOGO_SRC_S)


def test_v1_nogo_context_number(monkeypatch):
    _nogo_cfg(monkeypatch, 17, 17)
    assert v1_tilt.nogo_context() == {
        "conservative_nogo_deg": 17.0, "source": NOGO_SRC_V, "decision": "D23",
        "derived_from_v1": False, "text": "conservative no-go = 17° (D23, config)",
        "note": "Config citation for context, not a V1 output."}


def test_v1_nogo_context_legacy_variants_falls_back_to_site(monkeypatch):
    _nogo_cfg(monkeypatch, "20 - v1_rmse_deg", 17)
    ctx = v1_tilt.nogo_context()
    assert ctx["conservative_nogo_deg"] == 17.0 and ctx["source"] == NOGO_SRC_S


def test_v1_nogo_context_legacy_everywhere_is_unknown_not_evaluated(monkeypatch):
    _nogo_cfg(monkeypatch, "20 - v1_rmse_deg", "20 - v1_rmse_deg")
    ctx = v1_tilt.nogo_context()  # must not raise
    assert ctx["conservative_nogo_deg"] is None and ctx["derived_from_v1"] is False
    assert "legacy" in ctx["note"] and "not evaluated" in ctx["note"]
    assert ctx["text"] == "conservative no-go: not a number in config (D23)"


def test_v1_nogo_context_conflict_is_unknown(monkeypatch):
    _nogo_cfg(monkeypatch, 17, 16.5)
    ctx = v1_tilt.nogo_context()
    assert ctx["conservative_nogo_deg"] is None and "disagree" in ctx["note"]


def test_v1_write_result_role_on_every_doc(tmp_path, frag_dir):
    doc = v1_tilt.write_result(v1_tilt.compare(np.array([5.0, 12.0]), np.array([4.0, 11.0]),
                                               (10.0,)),
                               tmp_path / "v1.json", None, footprint_m=FP, dem_file="x.tif")
    assert doc["role"] == v1_tilt.ROLE
    assert json.loads((tmp_path / "v1.json").read_text())["role"] == v1_tilt.ROLE


def test_v1_all_in_dem_sensitivity_ignores_focus(tmp_path, frag_dir, monkeypatch):
    """Primary set = drive ends in the focus area (SPEC F13); `all_in_dem` drops the focus
    filter and keeps every drive end whose footprint lies on the DEM."""
    monkeypatch.setattr(v1_tilt, "_v1_config", lambda: {**VCFG, "footprint_m": FP})
    mm, coreg, dem = _real_inputs(tmp_path)
    a = SITE["aoi_focus"]
    lon_c, lat_c = (a["west"] + a["east"]) / 2, (a["south"] + a["north"]) / 2
    tiny = {"west": lon_c - 1e-5, "east": lon_c + 1e-5, "south": lat_c - 1e-5,
            "north": lat_c + 1e-5}
    monkeypatch.setattr(v1_tilt, "_site", lambda: {**SITE, "aoi_focus": tiny})
    doc = v1_tilt.run_real(mm, coreg, dem, tmp_path / "v1.json", None)
    assert doc["n_in_focus"] == 1 and doc["n"] == 1
    alld = doc["sensitivity"]["all_in_dem"]
    assert alld["n"] == 2 and alld["n_excluded"] == 3  # 1 invalid IMU, 2 off the DEM
    assert alld["n_drive_ends"] == 5 and abs(alld["bias_deg"]) < 1e-4


# --------------------------------------------------------------------------- KAT pass list (F16)

from pipeline.provenance import kats  # noqa: E402

JUNIT_XUNIT1 = """<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="1" failures="1" skipped="2" tests="6" time="1.0">
<testcase classname="tests.test_router" file="tests/test_router.py" line="10"
  name="test_flat_plane" time="0.25"/>
<testcase classname="tests.test_rad" file="tests/test_rad.py" line="20"
  name="test_real_storm" time="0.5"><failure message="assert 7.3 == 8.2">trace</failure></testcase>
<testcase classname="tests.test_clock" file="tests/test_clock.py" line="30"
  name="test_navcam_labels" time="0.0"><skipped type="pytest.skip"
  message="needs Navcam frames">skip</skipped></testcase>
<testcase classname="tests.test_nav.TestSky" file="tests/test_nav.py" line="40"
  name="test_skyline_fix_recovers_known_observer[a]" time="0.1"/>
<testcase classname="tests.test_haul" file="tests/test_haul.py" line="5"
  name="test_x" time="0.0"><skipped type="pytest.xfail" message="known bug">x</skipped></testcase>
<testcase classname="" name="tests.test_broken" time="0.0"><error
  message="collection failure">ImportError</error></testcase>
</testsuite></testsuites>
"""


def test_kats_parse_junit_outcomes_and_reasons(tmp_path):
    p = tmp_path / "junit.xml"
    p.write_text(JUNIT_XUNIT1)
    rows = kats.parse_junit(p)
    by_id = {r["id"]: r for r in rows}
    assert len(rows) == 6
    assert by_id["tests/test_router.py::test_flat_plane"]["outcome"] == "passed"
    assert by_id["tests/test_router.py::test_flat_plane"]["duration_s"] == pytest.approx(0.25)
    fail = by_id["tests/test_rad.py::test_real_storm"]
    assert fail["outcome"] == "failed" and "7.3" in fail["reason"]
    assert by_id["tests/test_clock.py::test_navcam_labels"]["reason"] == "needs Navcam frames"
    nav = by_id["tests/test_nav.py::TestSky::test_skyline_fix_recovers_known_observer[a]"]
    assert nav["outcome"] == "passed" and nav["area"] == "F22 skyline fix"
    xfail = by_id["tests/test_haul.py::test_x"]
    assert xfail["outcome"] == "skipped" and xfail["reason"].startswith("xfail")
    broken = [r for r in rows if "test_broken" in r["id"]]
    assert broken and broken[0]["outcome"] == "failed"  # collection errors are never hidden


def test_kats_area_and_feature_map():
    assert kats.classify("tests/test_router.py::test_flat_plane") == ("Router", ["F4"])
    assert kats.classify("tests/test_coreg.py::test_shift") == ("Co-registration", ["F1"])
    assert kats.classify("tests/test_nav.py::test_skyline_fix_x")[0] == "F22 skyline fix"
    assert kats.classify("tests/test_nav.py::test_error_resets_at_fix")[0] == "F21 navigation"
    assert kats.classify("tests/test_provenance.py::test_v1_plane") == ("V1", ["F13"])
    assert kats.classify("tests/test_provenance.py::test_h0_x") == ("Provenance", ["F16"])
    assert kats.classify("web/src/hud/hud.test.ts > HUD > t_home")[0] == "HUD logic"
    assert kats.classify("tests/test_new_thing.py::test_y") == ("other", [])
    assert kats.classify("tests/test_fp3d_export.py::test_chunk") == ("3D", ["F20"])


def test_kats_document_validates_and_records_summary(tmp_path, frag_dir):
    p = tmp_path / "junit.xml"
    p.write_text(JUNIT_XUNIT1)
    out = tmp_path / "kats.json"
    kats.write_kats(kats.parse_junit(p), out, runner="pytest", exit_codes={"pytest": 1})
    on_disk = json.loads(out.read_text())
    errors = list(Draft202012Validator(kats.schema()).iter_errors(on_disk))
    assert not errors, errors
    s = on_disk["summary"]
    assert s == {"total": 6, "passed": 2, "failed": 2, "skipped": 2}
    assert on_disk["exit_codes"] == {"pytest": 1}
    assert on_disk["generated_utc"] == AFTER_H0.strftime("%Y-%m-%dT%H:%M:%SZ")
    m = manifest.merge(out_path=tmp_path / "manifest.json")
    for k in ("total", "passed", "failed", "skipped"):
        assert m[f"kats.summary.{k}"]["value"] == s[k]
        assert m[f"kats.summary.{k}"]["file"] == "validation/kats.json"
    assert on_disk["commit"] == m["kats.summary.total"]["commit"]


def test_kats_parse_vitest_json(tmp_path):
    vj = {"testResults": [{
        "name": str(REPO / "web/src/hud/hud.test.ts"),
        "assertionResults": [
            {"ancestorTitles": ["HUD"], "title": "T_home is 0 at the pad", "status": "passed",
             "duration": 3.0, "failureMessages": []},
            {"ancestorTitles": ["HUD"], "title": "alarm", "status": "failed", "duration": 1.0,
             "failureMessages": ["expected 3 to be 4"]},
            {"ancestorTitles": [], "title": "later", "status": "todo", "duration": None,
             "failureMessages": []},
        ]}]}
    p = tmp_path / "vitest.json"
    p.write_text(json.dumps(vj))
    rows = kats.parse_vitest_json(p)
    assert [r["outcome"] for r in rows] == ["passed", "failed", "skipped"]
    assert rows[0]["id"] == "web/src/hud/hud.test.ts > HUD > T_home is 0 at the pad"
    assert rows[0]["area"] == "HUD logic" and rows[0]["duration_s"] == pytest.approx(0.003)
    assert "expected 3" in rows[1]["reason"]


def test_kats_proposed_schema_is_valid():
    Draft202012Validator.check_schema(kats.schema())

"""Tests for tools/make_dummy.py (M0, docs/dummy.md, contracts v1.0.0).

The generator must be deterministic (two runs give identical bytes), offline, and every JSON /
GeoJSON file it writes must validate against contracts/ with no warnings
(tools/validate_contracts.py). Known-answer checks make sure the dummy fields follow the PNG
encoding in contracts/README.md and the HUD logic rules in SPEC §9.
"""

from __future__ import annotations

import gzip
import io
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from tools import make_dummy as md
from tools import validate_contracts as vc

REPO = Path(__file__).resolve().parent.parent
COMMITTED = REPO / "web" / "public" / "data-dummy"
MAX_TOTAL_BYTES = 10 * 1024 * 1024  # M0 target: keep the dummy tree <= 10 MB


def _tree(root: Path) -> dict[str, bytes]:
    return {
        p.relative_to(root).as_posix(): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file() and p.name != ".gitkeep"
    }


@pytest.fixture(scope="module")
def runs(tmp_path_factory):
    a = tmp_path_factory.mktemp("dummy_a") / "data-dummy"
    b = tmp_path_factory.mktemp("dummy_b") / "data-dummy"
    md.generate(a)
    md.generate(b)
    return a, b


@pytest.fixture(scope="module")
def out(runs):
    return runs[0]


def _json(root: Path, rel: str):
    return json.loads((root / rel).read_text(encoding="utf-8"))


def _decode(root: Path, rel: str, scale: float) -> np.ndarray:
    rgba = np.asarray(Image.open(root / rel))
    assert rgba.dtype == np.uint8 and rgba.shape[2] == 4
    assert (rgba[..., 2] == 0).all(), "B channel must be 0"
    assert set(np.unique(rgba[..., 3]).tolist()) <= {0, 255}
    val = (rgba[..., 0].astype(np.int64) * 256 + rgba[..., 1]) * scale
    return np.where(rgba[..., 3] == 255, val, np.nan)


def test_deterministic(runs):
    a, b = runs
    ta, tb = _tree(a), _tree(b)
    assert ta, "generator wrote nothing"
    assert list(ta) == list(tb)
    diff = [k for k in ta if ta[k] != tb[k]]
    assert not diff, f"non-deterministic files: {diff}"


def test_every_file_validates_against_contracts(out, tmp_path):
    report = vc.run(data_dir=tmp_path / "no_public", dummy_dir=out)
    assert report.ok, report.errors
    assert not report.warnings, report.warnings


def test_dummy_tree_would_fail_as_public_data(out, tmp_path):
    """The no-dummy-in-public check catches the dummy tree if it is ever copied to data/."""
    report = vc.run(data_dir=out, dummy_dir=tmp_path / "none")
    assert not report.ok
    assert any('"dummy": true is not allowed' in e for e in report.errors)


def test_expected_files(out):
    rels = set(_tree(out))
    for rel in [
        "scenarios/index.json",
        "scenarios/bands_104.geojson",
        "stations.json",
        "route_nom_104.geojson",
        "timeline_nom_104.json",
        "trade_table.json",
        "pad.json",
        "conditions/rad.json",
        "manifest.json",
        "fields/index.json",
        "fields/fix_interval_medium.png",
        "nav/montecarlo_medium.json",
        "nav/fixes.json",
        "nav/tracks_medium.geojson",
        "nav/fix_interval_summary.json",
        "fp3d/index.json",
        "fp3d/far.f32.gz",
        "fp3d/horizon_ring.json",
        "cards/placeholder.png",
    ]:
        assert rel in rels, rel
    for sc in ("nom_104", "opt_104", "con_104"):
        for f in ("isochrones", "edges", "partner"):
            assert f"scenarios/{sc}/{f}.geojson" in rels
    for s in ("S1", "S2", "S3"):
        assert f"cards/{s}.json" in rels


def test_index_files_flagged(out):
    for rel in ("scenarios/index.json", "fields/index.json", "fp3d/index.json", "pad.json",
                "manifest.json"):
        assert _json(out, rel)["dummy"] is True, rel


def test_size_budget(out):
    sizes = [p.stat().st_size for p in out.rglob("*") if p.is_file()]
    assert max(sizes) < vc.MAX_BYTES
    assert sum(sizes) <= MAX_TOTAL_BYTES, f"dummy tree is {sum(sizes) / 2**20:.1f} MiB"


def test_scenarios(out):
    idx = _json(out, "scenarios/index.json")
    assert idx["default"] == "nom_104"
    assert [s["id"] for s in idx["scenarios"]] == ["nom_104", "opt_104", "con_104"]
    for s in idx["scenarios"]:
        iso = _json(out, s["files"]["isochrones"])
        assert [f["properties"]["minutes"] for f in iso["features"]] == list(range(1, 61))
        causes = {f["properties"]["cause"] for f in _json(out, s["files"]["edges"])["features"]}
        assert causes == {"physiology", "slope", "data"}, s["id"]
    bands = _json(out, "scenarios/bands_104.geojson")["features"]
    assert {(f["properties"]["budget"], f["properties"]["variant"]) for f in bands} == {
        (b, v) for b in (30, 60) for v in ("optimistic", "nominal", "conservative")}


def test_fields_encoding(out):
    idx = _json(out, "fields/index.json")
    hud = md.load_config()["hud"]
    assert idx["res_m"] == hud["field_png"]["res_m"]
    w, s, e, n = idx["bounds"]
    assert w < 137.382 < e and s < -4.806 < n
    for name, f in idx["fields"].items():
        img = Image.open(out / f["file"])
        assert img.mode == "RGBA", name
        assert img.size == (idx["width"], idx["height"]), name
    assert idx["fields"]["slope"]["scenario"] is None
    t = idx["fields"]["nom_104/t_home"]
    assert t["scale"] == hud["field_scales"]["t_home"]["per_count"]
    th = _decode(out, t["file"], t["scale"])
    cy, cx = idx["height"] // 2, idx["width"] // 2
    assert th[cy, cx] == 0.0, "T_home must be 0 at the pad"
    assert np.isnan(th).any(), "unknown cells (nodata hole) must decode as unknown"
    # worst-case field >= point field wherever both are known (SPEC §9 HUD logic)
    for r in hud["worst_case_radii_m"]:
        wf = idx["fields"][f"nom_104/t_home_worst_{r}"]
        wc = _decode(out, wf["file"], wf["scale"])
        both = ~np.isnan(wc) & ~np.isnan(th)
        assert (wc[both] >= th[both] - 1e-9).all()
    # o2_home = 0.25 L per minute of t_home (docs/dummy.md), within one count each
    o2 = idx["fields"]["nom_104/o2_home"]
    ov = _decode(out, o2["file"], o2["scale"])
    ok = ~np.isnan(ov) & ~np.isnan(th)
    assert np.allclose(ov[ok], th[ok] * md.DUMMY_O2_L_PER_MIN, atol=0.03)


def test_fix_interval_zero_outside_and_small_near_edge(out):
    idx = _json(out, "fields/index.json")
    f = idx["fields"]["fix_interval_medium"]
    dmax = _decode(out, f["file"], f["scale"])
    t = idx["fields"]["nom_104/t_home"]
    th = _decode(out, t["file"], t["scale"])
    outside = ~np.isnan(dmax) & (th > 30.05)
    assert (dmax[outside] == 0).all()
    cy, cx = idx["height"] // 2, idx["width"] // 2
    assert dmax[cy, cx] > _json(out, "nav/fix_interval_summary.json")["edge_p10_m"]


def test_station_t_home_matches_field(out):
    idx = _json(out, "fields/index.json")
    f = idx["fields"]["nom_104/t_home"]
    th = _decode(out, f["file"], f["scale"])
    w, s, e, n = idx["bounds"]
    for st in _json(out, "stations.json"):
        col = int((st["lon"] - w) / (e - w) * idx["width"])
        row = int((n - st["lat"]) / (n - s) * idx["height"])
        assert abs(th[row, col] - st["t_home_min"]["nom_104"]) <= 0.1 + 1e-9, st["id"]


def test_timeline(out):
    tl = _json(out, "timeline_nom_104.json")
    ts = [e["t_min"] for e in tl]
    assert ts == sorted(ts) and ts[0] == 0
    assert tl[0]["t_home_min"] == 0 and tl[-1]["t_home_min"] == 0
    assert tl[0]["o2_left_L"] == md.load_config()["crew"]["o2_budget"]["primary_L"]
    st = {s["id"]: s for s in _json(out, "stations.json")}
    for ev in tl:
        if ev["station"]:
            assert ev["t_home_min"] == st[ev["station"]]["t_home_min"]["nom_104"]


def test_rad_tripwire_before_peak_and_leash(out):
    rad = _json(out, "conditions/rad.json")
    s24 = rad["storm_2024"]
    peak_t = max(s24["series"], key=lambda p: p[1])[0]
    assert s24["onset_utc"] < s24["tripwire_utc"] < peak_t
    assert rad["baseline_uGy_day"] == pytest.approx(9.0 * 24)
    assert s24["peak_uGy_day"] == pytest.approx(350.0 * 24)
    peak_mgy_h = s24["peak_uGy_day"] / 24 / 1000
    leash = rad["leash"]
    assert leash["tau_min_at_peak"] == pytest.approx(60 * leash["D_allow_mGy"] / peak_mgy_h,
                                                     abs=0.05)


def test_nav(out):
    mc = _json(out, "nav/montecarlo_medium.json")
    hud = md.load_config()["hud"]["fallback_drift"]
    for row in mc["per_minute"]:
        expect = max(hud["pct_of_distance"] / 100 * row["dist_since_fix_m"],
                     hud["sigma_floor_m"])
        assert row["r95_m"] == pytest.approx(expect, abs=0.01)
    fixes = _json(out, "nav/fixes.json")
    assert [f["station"] for f in fixes] == [None, "S1", "S2", "S3", None]
    kinds = {f["properties"].get("kind") for f in
             _json(out, "nav/tracks_medium.geojson")["features"]}
    assert kinds == {"true", "estimated", "ellipse95"}


def test_fp3d_chunks(out):
    idx = _json(out, "fp3d/index.json")
    grid = idx["chunk_grid"]
    assert grid["chunks"], "no near chunks"
    size = grid["chunk_px"]
    for c in grid["chunks"]:
        raw = gzip.decompress((out / c["file"]).read_bytes())
        assert len(raw) == size * size * 4
        Image.open(io.BytesIO((out / c["tex"]).read_bytes())).verify()
    far = gzip.decompress((out / idx["far"]["file"]).read_bytes())
    assert len(far) == idx["far"]["width"] * idx["far"]["height"] * 4
    budget = md.load_config()["hud"]["performance"]["budget_3d_mb"]
    total = sum(p.stat().st_size for p in (out / "fp3d").rglob("*") if p.is_file())
    assert total <= budget * 1024 * 1024


def test_manifest_covers_displayed_numbers(out):
    m = _json(out, "manifest.json")
    for k in ("reachable_pct.nom_104.30", "reachable_pct_range.nom_104.30.low",
              "t_home_min.S1.nom_104", "turn_back_min.S1", "timeline.nom_104.0.margin_min",
              "rad.storm_2024.peak_uGy_day", "rad.leash.tau_min_at_peak",
              "trade.30.104.reachable_pct", "nav.fix_interval.medium.median_m",
              "nav.r95_fit.medium.a", "pad.lon"):
        assert k in m, k
    for k, v in m.items():
        if k != "dummy":
            assert v["script"] == "tools/make_dummy.py", k


@pytest.mark.skipif(not COMMITTED.is_dir() or not _tree(COMMITTED),
                    reason="no committed dummy tree")
def test_committed_tree_is_fresh(out):
    """web/public/data-dummy/ in git must equal a fresh run (re-run `make dummy`)."""
    committed, fresh = _tree(COMMITTED), _tree(out)
    assert sorted(committed) == sorted(fresh)
    stale = [k for k in fresh if committed[k] != fresh[k]]
    assert not stale, f"stale dummy files (run `make dummy`): {stale}"

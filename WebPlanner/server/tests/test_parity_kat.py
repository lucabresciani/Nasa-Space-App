"""Known answers for the parity comparator (D56, plan row 1.4), written before the harness.

A deliberately perturbed copy must FAIL: one field cell, one GeoJSON coordinate at the 5th
decimal, one manifest value, one PNG byte. Noise at the 7th decimal must pass, and so must the
fields in the IGNORED allow-list (manifest utc/commit, K9 timings in summary.json) and only
there. The fixtures are copies of committed files in web/public/data (no real grid needed).
"""

import copy
import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from server.tests.parity_compare import (
    IGNORED,
    compare_file,
    compare_json,
    compare_manifest,
    compare_trees,
    numbers_equal,
    report,
)

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "web" / "public" / "data"
ROUTE = "route_nom_104.geojson"
PNG = "siting.png"


def _trees(tmp_path, *rels):
    a, b = tmp_path / "server", tmp_path / "batch"
    for rel in rels:
        for root in (a, b):
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(DATA / rel, root / rel)
    return a, b


def _edit_json(path: Path, fn) -> None:
    doc = json.loads(path.read_text(encoding="utf-8"))
    fn(doc)
    path.write_text(json.dumps(doc), encoding="utf-8")


def _write_tif(path: Path, arr: np.ndarray) -> None:
    import rasterio
    from affine import Affine

    with rasterio.open(path, "w", driver="GTiff", height=arr.shape[0], width=arr.shape[1],
                       count=1, dtype=arr.dtype.name, crs="EPSG:32633",
                       transform=Affine(3, 0, 1000, 0, -3, 2000), nodata=-1) as ds:  # fmt: skip
        ds.write(arr, 1)


# ------------------------------------------------------------------ numbers


@pytest.mark.parametrize("a, b", [
    (137.401783, 137.401783 + 1e-7),   # 7th-decimal noise
    (137.401783, 137.401783 - 4e-7),
    (0.1234565, 0.1234566),            # straddles a 6-decimal rounding boundary
    (75, 75.0),
    (float("nan"), float("nan")),
    (float("inf"), float("inf")),
])  # fmt: skip
def test_parity_numbers_equal_to_6_decimals(a, b):
    assert numbers_equal(a, b)


@pytest.mark.parametrize("a, b", [
    (137.401783, 137.401783 + 1e-5),   # 5th decimal
    (137.401783, 137.401784),          # 6th decimal
    (2, 3),
    (1.0, float("nan")),
    (float("inf"), float("-inf")),
])  # fmt: skip
def test_parity_numbers_differ(a, b):
    assert not numbers_equal(a, b)


def test_parity_json_types_keys_lengths():
    assert compare_json({"a": [1, 2.0, "x", None, True]}, {"a": [1, 2, "x", None, True]},
                        file="f.json") == []  # fmt: skip
    cases = [({"a": 1}, {"a": True}), ({"a": "1"}, {"a": 1}), ({"a": None}, {"a": 0}),
             ({"a": 1}, {"b": 1}), ({"a": [1]}, {"a": [1, 1]}), ({"a": {}}, {"a": []}),
             ({"a": "x"}, {"a": "y"})]  # fmt: skip
    for s, b in cases:
        assert compare_json(s, b, file="f.json"), (s, b)


# ------------------------------------------------------------------ GeoJSON


def test_parity_geojson_identical_copy_passes(tmp_path):
    a, b = _trees(tmp_path, ROUTE)
    res = compare_trees(a, b, [ROUTE])
    assert res.ok and res.identical_bytes == [ROUTE]


def test_parity_geojson_coordinate_5th_decimal_fails(tmp_path):
    a, b = _trees(tmp_path, ROUTE)

    def nudge(doc):
        doc["features"][0]["geometry"]["coordinates"][3][1] += 1e-5

    _edit_json(a / ROUTE, nudge)
    res = compare_trees(a, b, [ROUTE])
    assert not res.ok
    assert res.differing_files == [ROUTE]
    assert [d.where for d in res.diffs] == ["/features/0/geometry/coordinates/3/1"]


def test_parity_geojson_noise_7th_decimal_passes(tmp_path):
    a, b = _trees(tmp_path, ROUTE)

    def noise(doc):
        for i, xy in enumerate(doc["features"][0]["geometry"]["coordinates"]):
            xy[0] += (1 if i % 2 else -1) * 3e-7
            xy[1] += 1e-7

    _edit_json(a / ROUTE, noise)
    res = compare_trees(a, b, [ROUTE])
    assert res.ok, report(res)
    assert res.identical_bytes == []  # the bytes differ; the values are equal to 6 decimals


def test_parity_geojson_property_change_fails(tmp_path):
    a, b = _trees(tmp_path, ROUTE)

    def edit(doc):
        doc["features"][0]["properties"]["parity_kat"] = 1

    _edit_json(a / ROUTE, edit)
    assert compare_trees(a, b, [ROUTE]).diffs[0].detail == "only on the server"


# ------------------------------------------------------------------ fields and bytes


@pytest.mark.parametrize("suffix", [".tif", ".npy"])
def test_parity_field_one_cell_fails(tmp_path, suffix):
    rng = np.random.default_rng(56)
    field = rng.uniform(0, 300, (40, 30)).astype(np.float32)
    field[0, :5] = np.nan
    a, b = tmp_path / f"server{suffix}", tmp_path / f"batch{suffix}"
    write = _write_tif if suffix == ".tif" else (lambda p, x: np.save(p, x))
    write(b, field)
    write(a, field.copy())
    assert compare_file(a, b, "f" + suffix).ok  # NaN == NaN
    bumped = field.copy()
    bumped[17, 11] = np.nextafter(bumped[17, 11], np.float32(np.inf))  # one ulp in one cell
    write(a, bumped)
    res = compare_file(a, b, "f" + suffix)
    assert not res.ok
    detail = res.diffs[0].detail
    assert detail.startswith("1 cells differ")
    assert ("[0, 17, 11]" if suffix == ".tif" else "[17, 11]") in detail  # band, row, col


def test_parity_field_dtype_or_georeference_fails(tmp_path):
    field = np.zeros((5, 5), np.float32)
    _write_tif(tmp_path / "b.tif", field)
    _write_tif(tmp_path / "a.tif", field.astype(np.float64))
    assert not compare_file(tmp_path / "a.tif", tmp_path / "b.tif", "f.tif").ok


def test_parity_png_one_byte_fails(tmp_path):
    a, b = _trees(tmp_path, PNG)
    raw = bytearray((a / PNG).read_bytes())
    raw[-20] ^= 1
    (a / PNG).write_bytes(bytes(raw))
    res = compare_trees(a, b, [PNG])
    assert res.differing_files == [PNG] and "byte-exact" in res.diffs[0].detail


def test_parity_missing_file_fails(tmp_path):
    a, b = _trees(tmp_path, ROUTE)
    (a / ROUTE).unlink()
    assert compare_trees(a, b, [ROUTE]).diffs[0].detail == "missing in the server tree"


# ------------------------------------------------------------------ manifest and allow-list


@pytest.fixture(scope="module")
def manifest():
    m = json.loads((DATA / "manifest.json").read_text(encoding="utf-8"))
    return {k: v for k, v in m.items() if k.startswith(("headline.", "file.route_nom_104"))
            or k.startswith("stations.S4")}  # fmt: skip


def test_parity_manifest_value_fails(manifest):
    key = next(k for k, v in manifest.items() if isinstance(v.get("value"), float))
    server = copy.deepcopy(manifest)
    server[key]["value"] = round(server[key]["value"] + 0.01, 6)
    res = compare_manifest(server, manifest)
    assert [d.where for d in res.diffs] == [f"/{key}/value"]


def test_parity_manifest_file_hash_and_key_set_fail(manifest):
    server = copy.deepcopy(manifest)
    server["file.route_nom_104.geojson"]["value"] = "0" * 64
    del server[sorted(server)[-1]]
    res = compare_manifest(server, manifest)
    assert len(res.diffs) == 2
    assert any(d.detail == "missing on the server" for d in res.diffs)


def test_parity_manifest_stamps_are_ignored(manifest):
    server = copy.deepcopy(manifest)
    for v in server.values():
        v["utc"], v["commit"] = "2099-01-01T00:00:00Z", "f" * 40
    assert compare_manifest(server, manifest).ok
    server[next(iter(server))]["units"] = "parsecs"  # any other entry field still counts
    assert not compare_manifest(server, manifest).ok


def test_parity_allow_list_is_the_k9_list_only():
    """The allow-list: manifest stamps + the K9 timings (internal summary.json), nothing else."""
    assert IGNORED == {
        "manifest.json": (("*", "utc"), ("*", "commit")),
        "summary.json": (("timing_s",), ("d21", "screening", "screening_s")),
    }
    s = {"timing_s": {"web_products": 1.0}, "d21": {"screening": {"screening_s": 3.0, "n": 4}}}
    b = {"timing_s": {"web_products": 9.0, "x": 1}, "d21": {"screening": {"screening_s": 8.0,
                                                                          "n": 4}}}  # fmt: skip
    assert compare_json(s, b, file="summary.json") == []
    b["d21"]["screening"]["n"] = 5  # a non-timing field next to a timing still counts
    assert len(compare_json(s, b, file="summary.json")) == 1
    # the same fields in any other file are compared (timings never reach a published file)
    assert len(compare_json(s, b, file="scenarios/pads/rank2/summary.json")) == 4
    assert compare_json({"utc": 1}, {"utc": 2}, file="pad.json")


# ------------------------------------------------------------------ report


def test_parity_report_lists_every_differing_file(tmp_path, manifest):
    a, b = _trees(tmp_path, ROUTE, PNG, "trade_table.json")

    def nudge(doc):
        doc["features"][1]["geometry"]["coordinates"][0][0] += 1e-5

    _edit_json(a / ROUTE, nudge)
    (a / PNG).write_bytes((a / PNG).read_bytes() + b"\0")
    res = compare_trees(a, b, [ROUTE, PNG, "trade_table.json"])
    server = copy.deepcopy(manifest)
    key = sorted(server)[0]
    server[key]["value"] = "changed"
    res.extend(compare_manifest(server, manifest))
    text = report(res)
    assert res.differing_files == sorted([ROUTE, PNG, "manifest.json"])
    for f in (ROUTE, PNG, "manifest.json"):
        assert f"  {f} (" in text
    assert "4 files compared, 1 byte-identical, 3 differ" in text

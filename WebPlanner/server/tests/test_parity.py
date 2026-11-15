"""Parity (D56, kit K3 + rule 3, WS11 rule 3, plan row 1.4): the official pad with the default
plan_inputs, built the server's way, equals the batch (docs/backend.md F35: fields exact, GeoJSON
to 6 decimals, manifest values equal).

- ``test_parity_synthetic_official_pad`` (CI, ``make parity-synthetic``): on the synthetic
  world (pipeline/engine/synthetic.py) centred on the official pad, ``make engine``'s batch
  (scenarios.main) and the server path (one build_plan call from the default plan_inputs) write
  the same tree: every file, every field raster, the internal summary.json (K9 timings aside)
  and the manifest fragments.
- ``test_parity_real_official_pad`` (``make parity``, HL_PARITY_REAL=1; skipped otherwise): on
  the real WS1 grid, the server path equals the published web/public/data/ over the K8 file
  list, the card parts equal the merged cards, the manifest values equal the published
  manifest, the field rasters equal the batch's own (data/interim/engine) when present, and the
  official hash served by GET /results/{hash}/... (E3) gives the same bytes. HEAVY: run it as
  ``flock /tmp/hl-heavy.lock make parity``.

The comparator and its known answers: parity_compare.py, test_parity_kat.py. The paths and the
file list: parity_harness.py.
"""

import json
import os
import time
from fnmatch import fnmatch

import pytest

from pipeline.engine import provenance
from pipeline.engine.graph import load_ws1_grid
from server.tests import parity_harness as H
from server.tests.parity_compare import (
    Diff,
    Result,
    compare_json,
    compare_manifest,
    compare_trees,
    read_tree_files,
    report,
)

REAL = os.environ.get("HL_PARITY_REAL") == "1"


@pytest.fixture(autouse=True)
def no_shared_manifest(tmp_path, monkeypatch):
    """Safety net: any record outside an explicit manifest_dir lands in tmp, never in
    data/interim/manifest (the published manifest's source)."""
    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "stray_manifest"))


def _tree_sets(res: Result, server: set[str], batch: set[str], what: str) -> None:
    for rel in sorted(server - batch):
        res.diffs.append(Diff(rel, "", f"written by the server path, not in {what}"))
    for rel in sorted(batch - server):
        res.diffs.append(Diff(rel, "", f"in {what}, not written by the server path"))


@pytest.fixture(scope="module")
def synthetic(tmp_path_factory):
    """The synthetic world centred on the official pad, the batch tree and the server tree."""
    root = tmp_path_factory.mktemp("parity_synthetic")
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv(provenance.FRAGMENT_DIR_ENV, str(root / "stray_manifest"))
        inputs = H.default_inputs()
        pad = (inputs["pad"]["lon"], inputs["pad"]["lat"])
        terrain = H.synthetic_world(root / "terrain", pad)
        H.batch_build(terrain_dir=terrain, out_dir=root / "batch",
                      manifest_dir=root / "batch_manifest", pad_lonlat=pad)  # fmt: skip
        H.server_build(inputs, terrain_dir=terrain, out_dir=root / "server",
                       manifest_dir=root / "server_manifest", conditions=False)  # fmt: skip
    return root, inputs, terrain


def _synthetic_parity(root, server: str, server_manifest: str) -> Result:
    s_files = set(read_tree_files(root / server))
    b_files = set(read_tree_files(root / "batch"))
    res = compare_trees(root / server, root / "batch", s_files & b_files)
    _tree_sets(res, s_files, b_files, "the batch tree")
    res.extend(compare_manifest(H.manifest_entries(root / server_manifest),
                                H.manifest_entries(root / "batch_manifest")))  # fmt: skip
    return res


def test_parity_synthetic_official_pad(synthetic):
    root, _, _ = synthetic
    res = _synthetic_parity(root, "server", "server_manifest")
    assert res.ok, report(res, title="synthetic parity (server vs batch)")

    # the K8 list is what build_plan writes for a pad (every listed file exists, every card part)
    s_files = read_tree_files(root / "server")
    public = {f.removeprefix("public/") for f in s_files if f.startswith("public/")}
    assert set(H.server_files()) <= public, sorted(set(H.server_files()) - public)
    assert {"cards/S1.timeline.json", "cards/S2.timeline.json"} <= public
    assert not [f for f in public if H.is_batch_only(f)]
    assert sum(f.endswith(".tif") for f in res.compared) >= 3 * len(H.scenario_ids())  # fields
    assert "summary.json" in res.compared and "manifest.json" in res.compared
    assert len(res.compared) == len(s_files) + 1


def test_parity_synthetic_detects_a_moved_pad(synthetic, tmp_path):
    """Sensitivity: the server path with the pad one cell (3 m) east is NOT equal to the batch,
    and the report names every differing file (fields, GeoJSON, JSON and manifest)."""
    root, inputs, terrain = synthetic
    from pipeline.engine.geo import lonlat_of_xy, xy_of_lonlat

    crs = load_ws1_grid(terrain).crs
    x, y = xy_of_lonlat(inputs["pad"]["lon"], inputs["pad"]["lat"], crs)
    lon, lat = lonlat_of_xy(x + 3.0, y, crs)
    moved = {**inputs, "pad": {"lon": float(lon), "lat": float(lat)}}
    H.server_build(moved, terrain_dir=terrain, out_dir=root / "moved",
                   manifest_dir=root / "moved_manifest", conditions=False)  # fmt: skip
    res = _synthetic_parity(root, "moved", "moved_manifest")
    files = res.differing_files
    text = report(res)
    assert not res.ok
    assert "nom_104/t_home.tif" in files, text
    assert "nom_104/t_home.tif" in files and "public/scenarios/nom_104/isochrones.geojson" in files
    assert "summary.json" in files and "manifest.json" in files
    assert all(f"  {f} (" in text for f in files)


@pytest.mark.skipif(
    not REAL,
    reason="real-data parity runs only via `make parity` "
    "(HL_PARITY_REAL=1, needs the WS1 grids; kit K3)",
)
def test_parity_real_official_pad(tmp_path):
    missing = [p for p in (H.REAL_TERRAIN / "elev_3m.tif", H.REAL_TERRAIN / "stations.json",
                           H.REAL_RAD) if not p.exists()]  # fmt: skip
    assert not missing, f"make parity needs the real inputs (data -> ~/hl-data): {missing}"
    inputs = H.default_inputs()
    out, mdir = tmp_path / "server", tmp_path / "server_manifest"
    t0 = time.perf_counter()
    summary = H.server_build(inputs, terrain_dir=H.REAL_TERRAIN, out_dir=out, manifest_dir=mdir)
    build_s = time.perf_counter() - t0
    pub = out / "public"

    # 1. public files vs web/public/data (K8 list minus the batch-only D21 picker and siting)
    written = set(read_tree_files(pub))
    parts = sorted(f for f in written if fnmatch(f, H.CARD_PART))
    plain = written - set(parts)
    res = compare_trees(pub, H.PUBLISHED, plain)
    for rel in sorted(set(H.server_files()) - plain):
        res.diffs.append(Diff(rel, "", "in the K8 list, not written by the server path"))

    # 2. card parts vs the merged cards/{S}.json (make web copies the part's keys unchanged)
    for rel in parts:
        card = H.PUBLISHED / rel.replace(".timeline.json", ".json")
        if not card.is_file():
            res.diffs.append(Diff(rel, "", f"no published {card.name}"))
            continue
        a, b = H.card_part_view(json.loads((pub / rel).read_text(encoding="utf-8")),
                                json.loads(card.read_text(encoding="utf-8")))  # fmt: skip
        res.extend(Result(diffs=compare_json(a, b, file=rel), compared=[rel]))

    # 3. manifest values: the server's fragments == the published entries of the same scripts
    published = json.loads((H.PUBLISHED / "manifest.json").read_text(encoding="utf-8"))
    mine = H.manifest_entries(mdir)
    res.extend(compare_manifest(mine, H.published_engine_manifest(published)))

    # 4. field rasters vs the batch's own build_plan out_dir (when this machine has it)
    rasters = H.raster_files(out)
    batch_engine = H.REAL_BATCH_ENGINE if H.REAL_BATCH_ENGINE.is_dir() else None
    if batch_engine is not None:
        res.extend(compare_trees(out, batch_engine, rasters))

    # 5. E3: the official hash serves the same bytes as the server path wrote
    served = _served_bytes(pub, sorted(plain))
    res.extend(served)

    lines = [
        f"real parity: build_plan (server path) {build_s:.1f} s on {H.REAL_TERRAIN}; scenarios "
        f"{summary['scenarios_run']}; pad {inputs['pad']}",
        f"  public files vs web/public/data: {len(plain)} ({len(parts)} card parts vs merged "
        f"cards); manifest entries: {len(mine)} server / "
        f"{len(H.published_engine_manifest(published))} published",
        f"  field rasters vs {batch_engine}: {len(rasters) if batch_engine else 'not compared'}",
        f"  served by /results/<official hash>/: {len(served.compared)} files",
        report(res, title="  result"),
    ]
    print("\n".join(lines))
    assert res.ok, "\n".join(lines)


def _served_bytes(pub, rels: list[str]) -> Result:
    """GET /results/{official hash}/{rel} (E3, live identity) == the server path's bytes."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from server.app import create_app
    from server.engine import version
    from server.engine.hashing import engine_identity, official_hash
    from server.settings import settings

    res = Result()
    try:
        h = official_hash(engine_identity())
    except version.Unavailable as e:
        res.diffs.append(
            Diff("/results/{official hash}", "", f"identity unavailable: {e} (run make serverdata)")
        )
        return res
    client = TestClient(create_app(warmup=lambda: None))
    base = f"{settings().api.prefix}/results/{h}"
    for rel in rels:
        r = client.get(f"{base}/{rel}")
        res.compared.append(f"served:{rel}")
        if r.status_code != 200:
            res.diffs.append(Diff(f"served:{rel}", "", f"HTTP {r.status_code}: {r.text[:120]}"))
        elif r.content != (pub / rel).read_bytes():
            res.diffs.append(Diff(f"served:{rel}", "", "served bytes != server path bytes"))
        else:
            res.identical_bytes.append(f"served:{rel}")
    return res

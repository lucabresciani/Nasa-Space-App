"""Parity harness (D56, kit K3, WS11 rule 3, plan row 1.4): the two paths and the file list.

- SERVER PATH (``server_build``): what the plan job (E8, plan row 2.4) runs for "official pad,
  default inputs": the canonical default plan_inputs (server.engine.hashing) -> one
  ``pipeline.engine.plan.build_plan`` call into a fresh out_dir with its own manifest_dir.
  No D21 pick and no F8 siting: those are batch-only steps (padpick.run feeds the batch's pad;
  F33 siting on demand is a separate stretch job).
  ``server_build`` calls the plan job's own inputs -> build_plan function
  (server.engine.plan_job.build, E8), so parity tests exactly what the server runs.
- BATCH PATH: ``scenarios.main`` (what ``make engine`` runs) on the synthetic world, or the
  published tree web/public/data (real data, ``make parity``).
- FILE LIST (kit K8, STATUS.md WS2 2026-11-14T19:44Z): ``SERVER_FILES`` = the public files
  build_plan writes for the official pad, minus ``BATCH_ONLY`` (D21 picker + F8 siting).
  The card timeline parts (cards/{S}.timeline.json) are merged by make web into cards/{S}.json,
  so they are compared key by key with the merged card (``card_part_view``).
"""

from __future__ import annotations

import json
from dataclasses import replace
from fnmatch import fnmatch
from pathlib import Path

import numpy as np

from pipeline.engine import provenance, scenarios
from pipeline.engine.config import load

REPO = Path(__file__).resolve().parents[2]
PUBLISHED = REPO / "web" / "public" / "data"
INTERIM = REPO / "data" / "interim"
REAL_TERRAIN = INTERIM / "terrain"
REAL_RAD = INTERIM / "conditions" / "rad.json"
REAL_BATCH_ENGINE = INTERIM / "engine"  # the batch's own build_plan out_dir (rasters)

# build_plan stages that write manifest keys on the server path (file -> script in the manifest)
SERVER_SCRIPTS = ("pipeline/engine/scenarios.py", "pipeline/engine/traverse.py",
                  "pipeline/engine/cards.py")  # fmt: skip
# Published engine files the server path does not write (K8): the D21 picker (padpick, batch
# only) and the F8 siting products. Their manifest keys are not compared either.
BATCH_ONLY = ("pad.json", "siting.png", "siting_png.json", "scenarios/pads/*")
CARD_PART = "cards/*.timeline.json"  # WS2 card part -> cards/{S}.json via make web


def scenario_ids() -> list[str]:
    return list(load("variants")["scenarios"]["ids"])


def server_files() -> list[str]:
    """K8: the public files build_plan writes for the official pad, minus BATCH_ONLY (the
    card parts are listed separately: ``card_parts``)."""
    default = load("variants")["scenarios"]["default"]
    sids = scenario_ids()
    suits = sorted({s.split("_")[1] for s in sids}, key=int)
    files = ["stations.json", "trade_table.json", f"route_{default}.geojson",
             f"timeline_{default}.json", "scenarios/index.json"]  # fmt: skip
    files += [f"scenarios/bands_{s}.geojson" for s in suits]
    files += [f"scenarios/{sid}/{k}.geojson" for sid in sids for k in ("isochrones", "edges")]
    files += [f"scenarios/nom_{s}/partner.geojson" for s in suits]
    return sorted(files)


def is_batch_only(rel: str) -> bool:
    return any(fnmatch(rel, p) for p in BATCH_ONLY)


# ------------------------------------------------------------------ server path


def default_inputs() -> dict:
    """The canonical default plan_inputs (official pad), as the server hashes them (D57)."""
    from server.engine.hashing import canonical_inputs, official_inputs

    return canonical_inputs(official_inputs())


def server_build(
    inputs: dict,
    *,
    terrain_dir: Path,
    out_dir: Path,
    manifest_dir: Path,
    conditions: bool = True,
    rad_json: Path = REAL_RAD,
) -> dict:
    """Server path: the plan job's own inputs -> build_plan function
    (server.engine.plan_job.build, E8), so parity tests exactly what the server runs. For the
    official pad it keeps the full official scenario set (D81). Returns the run summary.
    ``conditions``: WS4 margin inputs on (real data) or off (synthetic world, as the batch's
    --no-conditions)."""
    from server.engine.plan_job import build

    return build(inputs, terrain_dir=terrain_dir, out_dir=out_dir, public_dir=out_dir / "public",
                 manifest_dir=manifest_dir, conditions=conditions, rad_json=rad_json)


def manifest_entries(fragment_dir: Path) -> dict:
    return provenance.load_all(fragment_dir)


# ------------------------------------------------------------------ batch path (synthetic)


def batch_build(
    *, terrain_dir: Path, out_dir: Path, manifest_dir: Path, pad_lonlat: tuple[float, float]
) -> None:
    """``make engine`` on a world with the pad fixed (``--pad``; the D21 pick is batch-only and
    would choose the pad itself) and WS4 conditions off. Manifest fragments -> manifest_dir."""
    argv = ["--terrain", str(terrain_dir), "--out", str(out_dir), "--no-conditions",
            "--pad", repr(pad_lonlat[0]), repr(pad_lonlat[1])]  # fmt: skip
    with provenance.to_dir(manifest_dir):
        rc = scenarios.main(argv)
    if rc != 0:
        raise RuntimeError(f"scenarios.main {argv} exited {rc}")


def synthetic_world(terrain_dir: Path, pad_lonlat: tuple[float, float], half_m: float = 450.0
                    ) -> Path:  # fmt: skip
    """WS1-shaped inputs (3 m grids, 1 m ridge index, stations.json) of the docs/dummy.md world
    (pipeline.engine.synthetic.dummy_world), moved so that its centre is the pad. A fixture,
    never data. Two stations: one reachable uphill to the north, one downhill to the south-west.
    """
    import rasterio
    from affine import Affine

    from pipeline.engine.geo import lonlat_of_xy, xy_of_lonlat
    from pipeline.engine.synthetic import dummy_world, pad_xy

    grid, pad, _ = dummy_world(3.0, half_m=half_m)
    (dx0, dy0), (px, py) = pad_xy(), xy_of_lonlat(*pad_lonlat, grid.crs)
    # move the world so the pad sits at a cell centre (the dummy world puts it on a corner, where
    # float noise in a lon/lat round trip can pick either cell)
    h = grid.res_m / 2
    grid = replace(grid, x0=grid.x0 + px - dx0 - h, y0=grid.y0 + py - dy0 + h)
    terrain_dir.mkdir(parents=True, exist_ok=True)

    def tif(name, arr, dtype, nodata, res=grid.res_m):
        t = Affine(res, 0, grid.x0, 0, -res, grid.y0)
        with rasterio.open(terrain_dir / name, "w", driver="GTiff", height=arr.shape[0],
                           width=arr.shape[1], count=1, dtype=dtype, crs=grid.crs,
                           transform=t, nodata=nodata) as ds:  # fmt: skip
            ds.write(arr.astype(dtype), 1)

    tif("elev_3m.tif", np.nan_to_num(grid.elev, nan=-32767), "float32", -32767)
    for name in ("maxslope_3m.tif", "slope_3m.tif"):
        tif(name, np.nan_to_num(grid.maxslope, nan=-1), "float32", -1)
    tif("cellstate_3m.tif", grid.cellstate, "uint8", 255)
    tif("stepguard_3m.tif", np.where(grid.cellstate == 2, 255, 0), "uint8", 255)
    ridge = np.zeros((grid.shape[0] * 3, grid.shape[1] * 3), np.float32)
    ridge[:, grid.shape[1] * 3 // 2 + 60] = 1.0  # one 1 m ridge column east of the pad
    tif("ridge_index.tif", ridge, "float32", -9999, res=1.0)
    st = []
    for i, (dr, dc) in enumerate([(-80, 10), (60, -40)]):
        lon, lat = lonlat_of_xy(*grid.xy_of_rc(pad[0] + dr, pad[1] + dc), grid.crs)
        st.append({"id": f"S{i + 1}", "name": f"Parity {i + 1}", "lon": round(float(lon), 6),
                   "lat": round(float(lat), 6), "value": 0.5 + 0.1 * i, "objective": "",
                   "tasks": [], "dwell_min": 30, "t_home_min": {}, "in_partner_line": None,
                   "card": f"cards/S{i + 1}.json"})  # fmt: skip
    (terrain_dir / "stations.json").write_text(json.dumps(st), encoding="utf-8")
    return terrain_dir


# ------------------------------------------------------------------ real data (make parity)


def card_part_view(part: dict, card: dict) -> tuple[dict, dict]:
    """(part, the same keys of the merged card): make web copies every key of WS2's card part
    into cards/{S}.json except tools.make_web.CARD_DROP["WS2"] (nothing is computed there)."""
    from tools.make_web import CARD_DROP

    keys = [k for k in part if k not in CARD_DROP["WS2"]]
    return {k: part[k] for k in keys}, {k: card[k] for k in keys if k in card}


def published_engine_manifest(published: dict) -> dict:
    """The published manifest entries the server path must reproduce: the build_plan scripts'
    keys on files that are not BATCH_ONLY."""
    return {k: v for k, v in published.items()
            if isinstance(v, dict) and v.get("script") in SERVER_SCRIPTS
            and not is_batch_only(v.get("file", ""))}  # fmt: skip


def raster_files(out_dir: Path) -> list[str]:
    """The internal field rasters build_plan wrote (out_dir-relative)."""
    return sorted(p.relative_to(out_dir).as_posix() for p in out_dir.rglob("*.tif"))

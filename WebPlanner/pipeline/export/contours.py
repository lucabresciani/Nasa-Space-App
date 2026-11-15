"""Contour lines for the U7 terrain group -> ``overlays/contours.geojson`` (DESIGN §6.1, §2.2 U7).

10 m contours (``config/design.yaml overlays.contours_m.minor``) with an ``index`` flag every 50 m
(``contours_m.index``) from the 1 m merged DEM (``dem_1m.tif``, areoid heights, the WS1 grid)
over the focus area (``site.yaml aoi_focus``; the whole 1 m cells covering it). Lines are traced
through the pixel centres (marching squares, ``skimage.measure.find_contours``; no-data cells are
masked, never filled), simplified with Douglas-Peucker at ``overlays.simplify_m`` (1 m) in the
analysis CRS, then written as Mars planetocentric lon/lat (7 decimals). No smoothing: the
lines are those of the 1 m model.

Feature properties: ``elev_m`` (the level, m, areoid), ``index`` (true on 50 m lines; the app
labels those). Top-level foreign members: interval, index, simplify, bounds, source and hash.
Deterministic (sorted by level, then trace order). Skipped when inputs/config/code are unchanged.

Usage: ``python -m pipeline.export.contours [--force] [--no-record]``.
"""

from __future__ import annotations

import argparse
import math
import sys
from collections.abc import Callable
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from pipeline.export import overlays as O  # noqa: E402
from pipeline.export import terrain_tiles as T  # noqa: E402

DEM = O.TERRAIN / "dem_1m.tif"
NAME = "contours.geojson"
WEB = f"overlays/{NAME}"


def is_index(level: float, index: float) -> bool:
    return math.isclose(math.remainder(level, index), 0.0, abs_tol=1e-9)


def contour_lines(z: np.ndarray, x0: float, y0: float, res: float, *, minor: float,
                  simplify_m: float) -> list:
    """[(level, LineString in the analysis CRS)] for every multiple of ``minor`` in range."""
    from shapely.geometry import LineString
    from skimage.measure import find_contours

    z = np.asarray(z, float)
    valid = np.isfinite(z)
    if valid.sum() < 4:
        return []
    zf = np.where(valid, z, np.nanmin(z))
    lo, hi = math.ceil(np.nanmin(z) / minor), math.floor(np.nanmax(z) / minor)
    out = []
    for k in range(lo, hi + 1):
        level = k * minor
        for rc in find_contours(zf, level, mask=valid):
            if len(rc) < 2:
                continue
            xs = x0 + (rc[:, 1] + 0.5) * res
            ys = y0 - (rc[:, 0] + 0.5) * res
            ln = LineString(np.column_stack([xs, ys])).simplify(simplify_m, preserve_topology=False)
            if ln.is_empty or ln.length == 0:
                continue
            out.append((int(level) if float(level).is_integer() else level, ln))
    return out


def collection(lines: list, *, index: float, meta: dict) -> dict:
    feats = []
    for level, ln in lines:
        feats.append({"type": "Feature",
                      "geometry": {"type": "LineString",
                                   "coordinates": O.to_lonlat_coords(np.asarray(ln.coords))},
                      "properties": {"elev_m": level, "index": is_index(level, index)}})
    return {"type": "FeatureCollection", **meta, "features": feats}


def load_config() -> dict:
    ov = O.design()["overlays"]
    return {"minor": float(ov["contours_m"]["minor"]), "index": float(ov["contours_m"]["index"]),
            "simplify_m": float(ov["simplify_m"]), "bounds": O.focus_bounds(), "source": DEM}


def _num(v: float):
    return int(v) if float(v).is_integer() else v


def build(cfg: dict, out: Path, log: Callable[[str], None] = print) -> dict:
    z, x0, y0, res = O.read_raster(cfg["source"], cfg["bounds"])
    z = z.astype("float32")
    lines = contour_lines(z, x0, y0, res, minor=cfg["minor"], simplify_m=cfg["simplify_m"])
    meta = {"interval_m": _num(cfg["minor"]), "index_m": _num(cfg["index"]),
            "simplify_m": _num(cfg["simplify_m"]), "bounds": cfg["bounds"],
            "height_datum": "m above the Mars areoid (MSL Gale merged DEM v3, grid.json)",
            "source": O.rel(cfg["source"]), "source_hash": O.sha256([cfg["source"]])}
    doc = collection(lines, index=cfg["index"], meta=meta)
    out.parent.mkdir(parents=True, exist_ok=True)
    text = O.dumps(doc)
    out.write_text(text)
    levels = [f["properties"]["elev_m"] for f in doc["features"]]
    log(f"contours: {len(doc['features'])} lines, levels {min(levels)}..{max(levels)} m, "
        f"{len(text.encode()) / O.MIB:.2f} MiB")
    return doc


def record_manifest(doc: dict) -> None:
    from pipeline.provenance.manifest import record

    record("overlays.contours.interval_m", doc["interval_m"], "m", WEB, __file__)
    record("overlays.contours.index_m", doc["index_m"], "m", WEB, __file__)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=O.OUT / NAME)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-record", action="store_true")
    a = ap.parse_args(argv)
    cfg = load_config()
    if not cfg["source"].exists():
        raise FileNotFoundError(f"contours: missing source {cfg['source']}")
    key = O.build_key(cfg, [cfg["source"]], [Path(__file__), Path(O.__file__), Path(T.__file__)])
    stamp = a.out.with_name(".build_key_contours")
    if not a.force and O.up_to_date(a.out, stamp, key):
        print(f"contours: up to date ({a.out})")
        return 0
    doc = build(cfg, a.out)
    stamp.write_text(key + "\n")
    if not a.no_record:
        record_manifest(doc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

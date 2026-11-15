"""Low-zoom Gale crater relief for the intro -> ``terrain_low/{z}/{x}/{y}.png`` + ``tiles.json``
(DESIGN §6.1, §2.2 U6 step 3, budget §5.4; contract ``contracts/terrain_tiles.schema.json`` v1;
WS16).

Same tiles as ``terrain_tiles.py`` (256 px Terrarium PNG, elevation x
``scale.elevation_factor`` + ``terrain_tiles.vertical_offset_m`` (the same offset as terrain/),
XYZ with Mars lon/lat passed through, D4) at
``config/design.yaml terrain_tiles.lowzoom_intro`` (z6-10), no focus area, budget
``lowzoom_budget_mb``, height step capped at ``height_step_cap_m.low`` m of true elevation.

Extent: the IAU gazetteer box of the crater "Gale" (``config/horizon.yaml landmarks_source.csv``,
columns min/max lon/lat), intersected with what the cached sources cover. Sources (DESIGN §6.1:
CTX 20 m, MOLA-HRSC 200 m), finest first, the canonical bands of ``config/horizon.yaml``:
``ctx_20m_v2.tif`` (pad +/- 33.7 km) and ``mola_hrsc_200m.tif`` (pad +/- 84 km). Nothing is
downloaded here.

Known gap (PARTIAL): the cached MOLA-HRSC window (pad +/- 84 km) does not reach Gale's south-east
rim, and a z6-z8 tile is wider than any cached source. Pixels of the written tiles beyond the
MOLA-HRSC window are edge-extended from its border (nearest border sample: a visual fill, never a
measured value); their share is ``edge_extended_pixel_pct`` in tiles.json, and ``bounds`` is the
part of Gale the sources do cover. ``python -m pipeline.export.relief_lowzoom --plan`` prints the
exact download step that closes the gap (not run automatically: the global MOLA-HRSC GeoTIFF is
striped and uncompressed, 11.4 GB, so a 200 m window reads whole 213 kB rows).

Usage: ``python -m pipeline.export.relief_lowzoom`` writes data/interim/export/terrain_low/
(copied to web/public/data/terrain_low/ by ``make web``) and records ``terrain_low_tiles.factor``,
``.vertical_offset_m``, ``.source_hash``, ``.total_bytes`` in the manifest.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from pipeline.export import terrain_tiles as T  # noqa: E402

NAME = "terrain_low"
OUT = T.EXPORT / NAME
GAZETTEER_NAME = "Gale"  # DESIGN §6.1 "Gale crater relief"; the IAU feature name
ATTRIBUTION = ("Elevation: USGS controlled CTX DTMs; HRSC-MOLA blended DEM 200 m v2 "
               "(USGS Astrogeology)")


def gale_bounds(csv_path: Path | None = None) -> list[float]:
    """[w, s, e, n] of the IAU gazetteer feature "Gale" (east-positive lon, as the app)."""
    p = csv_path or REPO / T._yaml("horizon.yaml")["landmarks_source"]["csv"]
    with open(p, newline="") as f:
        rows = [r for r in csv.DictReader(f) if r["clean_name"] == GAZETTEER_NAME]
    if not rows:
        raise KeyError(f"{p}: no gazetteer feature named {GAZETTEER_NAME!r}")
    r = rows[0]
    return [float(r[k]) for k in ("min_lon", "min_lat", "max_lon", "max_lat")]


def intersect(a, b) -> list[float]:
    return [max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])]


def load_config() -> dict:
    d = T._yaml("design.yaml")
    tt = d["terrain_tiles"]
    return {"name": NAME, "factor": float(d["scale"]["elevation_factor"]),
            "tile_px": int(tt["tile_px"]),
            "zooms": tuple(int(z) for z in tt["lowzoom_intro"]),
            "focus_zooms": None, "focus_bounds": None,
            "budget_bytes": int(round(float(tt["lowzoom_budget_mb"]) * T.MIB)),
            # coarsest height step, m of TRUE elevation (assumed: true in design.yaml)
            "max_step_true_m": float(tt["height_step_cap_m"]["low"]),
            # same offset as terrain/ (P2c), so the intro descent hands over without a jump
            "vertical_offset_m": float(tt["vertical_offset_m"]),
            "sources": T.band_paths("ctx_20m", "mola_hrsc_200m")}


def coverage(cfg: dict) -> dict:
    """Gale box, the last (coarsest) source's footprint, their intersection, the tile extent."""
    gale = gale_bounds()
    foot = T.Source(cfg["sources"][-1]).lonlat_footprint()
    inner = intersect(gale, foot)
    z0 = cfg["zooms"][0]
    need = T.union_bounds([T.tile_bounds(z0, x, y) for x, y in T.tiles_covering(inner, z0)])
    return {"gale": gale, "footprint": T.outward(foot),
            "bounds": [round(v, 6) for v in inner], "tile_extent_z0": need,
            "gale_covered": inner == gale}


def download_step(cfg: dict, cov: dict) -> str:
    """The exact command that fetches MOLA-HRSC over Gale's full box at 200 m (not run here)."""
    url = T._yaml("horizon.yaml")["bands"]["mola_hrsc_200m"]["url"]
    w, s, e, n = cov["gale"]
    pad = 0.75  # deg: one z8 tile, so every z9-z10 tile over the box is covered
    return ("gdal_translate -of GTiff -co COMPRESS=DEFLATE -co TILED=YES "
            f"-projwin {w - pad:.4f} {n + pad:.4f} {e + pad:.4f} {s - pad:.4f} "
            f"/vsicurl/{url} data/raw/terrain/mola/mola_hrsc_200m_gale.tif"
            "   # then reproject onto the analysis CRS like pipeline/horizon/bands.py does for "
            "mola_hrsc_200m.tif and list it in config/horizon.yaml bands")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--force", action="store_true", help="rebuild even if inputs are unchanged")
    ap.add_argument("--no-record", action="store_true", help="skip the manifest fragment")
    ap.add_argument("--plan", action="store_true", help="print coverage + download step only")
    a = ap.parse_args(argv)
    cfg = load_config()
    cov = coverage(cfg)
    cfg["bounds"] = cov["bounds"]
    if not cov["gale_covered"] or a.plan:
        print(f"{NAME}: Gale box {cov['gale']}; cached MOLA-HRSC covers {cov['footprint']}; "
              f"tiling {cov['bounds']} (z{cfg['zooms'][0]} tiles span {cov['tile_extent_z0']}); "
              "beyond the cached window the tiles are edge-extended (visual fill)")
        print(f"{NAME}: to cover all of Gale: {download_step(cfg, cov)}")
    if a.plan:
        return 0
    doc, rebuilt = T.run(cfg, a.out, force=a.force, scripts=[Path(__file__), Path(T.__file__)],
                         edge_extend_last=True, attribution=ATTRIBUTION)
    if not a.no_record and rebuilt:
        T.record_manifest(doc, __file__)
    if not math.isclose(doc.get("edge_extended_pixel_pct", 0.0), 0.0):
        print(f"{NAME}: PARTIAL: {doc['edge_extended_pixel_pct']} % of tile pixels are "
              "edge-extended beyond the cached MOLA-HRSC window")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

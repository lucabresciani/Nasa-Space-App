"""Far-field DEM bands for the horizon engine (F12): MOLA-HRSC 200 m and a CTX 20 m mosaic,
windowed from the public COGs and reprojected to the analysis CRS (site.yaml).

    python -m pipeline.horizon.bands [--build mola|ctx|all]

The engine reads the canonical bands named by horizon.yaml ``bands.{source}.path`` (WS1's
far-field bands since C's decision at 11:15); without ``--build`` this module only reports the
height offsets between them. ``--build`` remakes WS3's own reference bands (below).

Inputs (docs/discovery.md 2.4, 2.5):
  * MOLA-HRSC blend v2 (geographic, uncompressed 1-row strips): read with GTIFF_DIRECT_IO=YES so
    GDAL range-reads only the needed bytes (discovery: the 80 km window costs about 2.2 MB).
  * CTX controlled DTMs: ``geoid_adjusted_dem`` assets only (plain ``dem`` is 567 m lower at the
    pad). No single item covers more than 46 % of the 30 km box, so items are picked greedily by
    footprint gain over the horizon disc from D0's STAC listing of items at the pad
    (horizon.yaml ``bands.ctx``); the engine falls back to MOLA-HRSC where the mosaic has no data.

Raw windows go to data/raw/horizon/ (cache, git-ignored); reprojected bands to
data/interim/horizon/bands/{source}.tif. The run report (bands.json) lists every item, its
footprint gain and the median offset to the next finer band where they overlap.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

from pipeline.horizon import config as hcfg
from pipeline.horizon.geo import geographic_proj, lonlat_to_xy

REPO = hcfg.REPO
RAW = REPO / "data" / "raw" / "horizon"
OUT = REPO / "data" / "interim" / "horizon" / "bands"


def _cfg() -> dict:
    return hcfg.load()["bands"]


def _pad_xy() -> tuple[float, float]:
    p = hcfg.site()["pad_default"]
    return lonlat_to_xy(p["lon"], p["lat"])


def _now() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def target_grid(radius_m: float, res_m: float) -> tuple[tuple, int, int]:
    """North-up analysis-CRS grid centred on the pad, covering pad +/- radius (snapped to res)."""
    px, py = _pad_xy()
    x0 = math.floor((px - radius_m) / res_m) * res_m
    y1 = math.ceil((py + radius_m) / res_m) * res_m
    n = int(math.ceil(2 * radius_m / res_m)) + 1
    return (x0, res_m, 0.0, y1, 0.0, -res_m), n, n


def _reproject(src_ds, gt, w, h, resampling="bilinear", src_nodata=None) -> np.ndarray:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import reproject

    dst = np.full((h, w), np.nan, dtype=np.float32)
    reproject(
        source=rasterio.band(src_ds, 1), destination=dst,
        src_nodata=src_nodata if src_nodata is not None else src_ds.nodata,
        dst_transform=rasterio.Affine(gt[1], 0, gt[0], 0, gt[5], gt[3]),
        dst_crs=hcfg.analysis_proj(), dst_nodata=np.nan,
        resampling=getattr(Resampling, resampling),
    )
    return dst


def _write(path: Path, z: np.ndarray, gt) -> Path:
    import rasterio

    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", driver="GTiff", width=z.shape[1], height=z.shape[0], count=1,
                       dtype="float32", crs=hcfg.analysis_proj(), nodata=np.nan,
                       transform=rasterio.Affine(gt[1], 0, gt[0], 0, gt[5], gt[3]),
                       compress="deflate", predictor=3, tiled=True) as ds:
        ds.write(z.astype(np.float32), 1)
    return path


# --------------------------------------------------------------------------------------------
# MOLA-HRSC
# --------------------------------------------------------------------------------------------

def build_mola(log=print) -> dict:
    import rasterio
    from rasterio.windows import from_bounds

    c = _cfg()["mola_hrsc_200m"]
    radius = float(c["radius_m"])
    pad = hcfg.site()["pad_default"]
    deg = radius / (hcfg.mars_radius_m() * math.pi / 180.0)
    dlon = deg / math.cos(math.radians(abs(pad["lat"]) + deg))
    bounds = (pad["lon"] - dlon, pad["lat"] - deg, pad["lon"] + dlon, pad["lat"] + deg)
    raw = RAW / "mola_hrsc_200m_window.tif"
    if not raw.exists():
        RAW.mkdir(parents=True, exist_ok=True)
        with rasterio.Env(GTIFF_DIRECT_IO="YES", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"), \
                rasterio.open("/vsicurl/" + c["url"]) as src:
            win = from_bounds(*bounds, transform=src.transform).round_offsets().round_lengths()
            z = src.read(1, window=win)
            prof = {"driver": "GTiff", "width": z.shape[1], "height": z.shape[0], "count": 1,
                    "dtype": z.dtype, "crs": src.crs, "transform": src.window_transform(win),
                    "nodata": src.nodata, "compress": "deflate"}
            with rasterio.open(raw, "w", **prof) as dst:
                dst.write(z, 1)
        log(f"MOLA-HRSC window {z.shape[1]}x{z.shape[0]} px -> {raw}")
    gt, w, h = target_grid(radius, float(c["res_m"]))
    with rasterio.open(raw) as src:
        if src.crs is None or "longlat" not in src.crs.to_proj4():
            raise ValueError(f"{raw}: expected geographic CRS, got {src.crs}")
        z = _reproject(src, gt, w, h)
    out = _write(OUT / "mola_hrsc_200m.tif", z, gt)
    log(f"MOLA-HRSC band {w}x{h} at {c['res_m']} m -> {out}")
    return {"source": "mola_hrsc_200m", "url": c["url"], "raw": str(raw.relative_to(REPO)),
            "raw_bytes": raw.stat().st_size, "geographic_crs": geographic_proj(),
            "band": str(out.relative_to(REPO)), "valid_pct": round(100 * np.isfinite(z).mean(), 2)}


# --------------------------------------------------------------------------------------------
# CTX mosaic
# --------------------------------------------------------------------------------------------

def pick_ctx_items(features: list[dict], disc, max_items: int, min_gain_frac: float,
                   to_xy=lonlat_to_xy, exclude=()) -> list[dict]:
    """Greedy: repeatedly the item whose footprint adds most new area of ``disc``; stop at
    ``max_items`` or when the gain is below ``min_gain_frac`` of the disc. Ties by id."""
    import shapely
    from shapely.geometry import shape

    def tr(g):
        return shapely.transform(g, lambda c: np.column_stack(to_xy(c[:, 0], c[:, 1])))

    polys = sorted(((f["id"], tr(shape(f["geometry"])).intersection(disc)) for f in features
                    if f["id"] not in set(exclude)), key=lambda p: p[0])
    cov, out = None, []
    while len(out) < max_items:
        gains = [(p.area if cov is None else p.difference(cov).area, i) for i, p in polys]
        if not gains:
            break
        g, best = max(gains, key=lambda t: t[0])  # first (lowest id) wins ties
        if g < min_gain_frac * disc.area:
            break
        poly = dict(polys)[best]
        cov = poly if cov is None else cov.union(poly)
        out.append({"id": best, "gain_pct": round(100 * g / disc.area, 2),
                    "cum_pct": round(100 * cov.area / disc.area, 2)})
        polys = [(i, p) for i, p in polys if i != best]
    return out


def _stac_item(item_id: str) -> dict:
    import requests

    c = _cfg()["ctx_20m"]
    cache = RAW / "stac" / f"{item_id}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    r = requests.get(c["stac_item_url"].format(id=item_id), timeout=60)
    r.raise_for_status()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(r.content)
    return r.json()


def offset_to_band(z: np.ndarray, gt, ref_path: Path) -> dict:
    """Median (z - reference) on the reference band's grid (z block-averaged onto it)."""
    import rasterio
    from rasterio.warp import Resampling, reproject

    with rasterio.open(ref_path) as ref:
        zr = ref.read(1)
        za = np.full(zr.shape, np.nan, dtype=np.float32)
        reproject(z, za, src_transform=rasterio.Affine(gt[1], 0, gt[0], 0, gt[5], gt[3]),
                  src_crs=hcfg.analysis_proj(), src_nodata=np.nan, dst_transform=ref.transform,
                  dst_crs=ref.crs, dst_nodata=np.nan, resampling=Resampling.average)
    ok = np.isfinite(za) & np.isfinite(zr)
    if not ok.any():
        return {"n": 0, "median_m": None}
    return {"n": int(ok.sum()), "median_m": round(float(np.median(za[ok] - zr[ok])), 2)}


def build_ctx(log=print) -> dict:
    """Greedy CTX mosaic; an item whose median offset to MOLA-HRSC exceeds
    ``max_offset_to_mola_m`` is rejected (datum/alignment check) and the next-best item tried."""
    import rasterio
    from shapely.geometry import Point

    c = _cfg()["ctx_20m"]
    radius = float(c["radius_m"])
    listing = json.loads((REPO / c["listing"]).read_text())["features"]
    disc = Point(*_pad_xy()).buffer(radius, 256)
    mola = OUT / "mola_hrsc_200m.tif"
    if not mola.exists():
        raise FileNotFoundError(f"{mola}: build the MOLA-HRSC band first (--build mola)")
    gt, w, h = target_grid(radius, float(c["res_m"]))
    mosaic = np.full((h, w), np.nan, dtype=np.float32)
    accepted, rejected = [], []
    while len(accepted) < int(c["max_items"]) and len(rejected) < int(c["max_rejects"]):
        picks = pick_ctx_items(listing, disc, len(accepted) + 1, float(c["min_gain_pct"]) / 100,
                               exclude=[r["id"] for r in rejected])
        if len(picks) <= len(accepted):
            break
        p = picks[-1]
        item = _stac_item(p["id"])
        href = item["assets"][c["asset"]]["href"]
        raw = RAW / "ctx" / f"{p['id']}_geoidadj_window.tif"
        if not raw.exists():
            raw.parent.mkdir(parents=True, exist_ok=True)
            with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"), \
                    rasterio.open("/vsicurl/" + href) as src:
                z = _reproject(src, gt, w, h)
            _write(raw, z, gt)
        with rasterio.open(raw) as ds:
            z = ds.read(1)
        p.update({"href": href, "raw": str(raw.relative_to(REPO)), "raw_bytes": raw.stat().st_size,
                  "offset_to_mola": offset_to_band(z, gt, mola)})
        off = p["offset_to_mola"]["median_m"]
        if off is None or abs(off) > float(c["max_offset_to_mola_m"]):
            p["rejected"] = (f"median offset to MOLA-HRSC {off} m "
                             f"(limit {c['max_offset_to_mola_m']})")
            rejected.append(p)
            log(f"CTX {p['id']}: REJECTED, {p['rejected']}")
            continue
        fill = np.isnan(mosaic) & np.isfinite(z)
        p["filled_pct_of_grid"] = round(100 * fill.mean(), 2)
        mosaic[fill] = z[fill]
        accepted.append(p)
        log(f"CTX {p['id']}: +{p['filled_pct_of_grid']}% of grid, offset to MOLA {off} m")
    out = _write(OUT / "ctx_20m.tif", mosaic, gt)
    return {"source": "ctx_20m", "asset": c["asset"], "items": accepted, "rejected": rejected,
            "band": str(out.relative_to(REPO)),
            "valid_pct_of_grid": round(100 * np.isfinite(mosaic).mean(), 2)}


# --------------------------------------------------------------------------------------------
# Offsets between bands (datum check)
# --------------------------------------------------------------------------------------------

def band_offsets(paths: dict[str, Path]) -> list[dict]:
    """Median (coarse - fine) height difference where consecutive bands overlap, sampled at the
    coarse band's pixel centres."""
    import rasterio
    from rasterio.warp import Resampling, reproject

    order = [s["source"] for s in hcfg.load()["sampling"]]
    have = [s for s in order if s in paths and Path(paths[s]).exists()]
    out = []
    for fine, coarse in zip(have, have[1:], strict=False):
        with rasterio.open(paths[coarse]) as c, rasterio.open(paths[fine]) as f:
            zc = c.read(1)
            zf = np.full(zc.shape, np.nan, dtype=np.float32)
            reproject(rasterio.band(f, 1), zf, src_nodata=f.nodata, dst_transform=c.transform,
                      dst_crs=c.crs, dst_nodata=np.nan, resampling=Resampling.average)
        ok = np.isfinite(zc) & np.isfinite(zf)
        d = zc[ok] - zf[ok]
        out.append({"fine": fine, "coarse": coarse, "n": int(ok.sum()),
                    "median_m": round(float(np.median(d)), 2) if ok.any() else None,
                    "p5_m": round(float(np.percentile(d, 5)), 2) if ok.any() else None,
                    "p95_m": round(float(np.percentile(d, 95)), 2) if ok.any() else None})
    return out


def band_paths() -> dict[str, Path]:
    """The bands the engine reads: horizon.yaml ``bands.{source}.path`` (canonical: WS1's
    far-field bands, C decision 11:15)."""
    c = _cfg()
    return {s: REPO / c[s]["path"] for s in ("dem_1m", "ctx_20m", "mola_hrsc_200m")}


def own_band_paths() -> dict[str, Path]:
    """WS3's reference build (``--build``), kept for comparison only."""
    return {"dem_1m": REPO / _cfg()["dem_1m"]["path"],
            "ctx_20m": OUT / "ctx_20m.tif", "mola_hrsc_200m": OUT / "mola_hrsc_200m.tif"}


def load_engine(log=print):
    """HorizonEngine over every band present (horizon.yaml ``sampling`` order); each band must
    be north-up in the analysis CRS."""
    import rasterio
    from pyproj import CRS

    from pipeline.horizon.rays import DemBand, HorizonEngine

    want = CRS.from_proj4(hcfg.analysis_proj())
    bands = []
    for src, path in band_paths().items():
        if not path.exists():
            log(f"band {src}: missing ({path}); rays fall back to the next coarser band")
            continue
        with rasterio.open(path) as ds:
            if ds.crs is None or not CRS.from_user_input(ds.crs).equals(want):
                raise ValueError(f"{path}: CRS {ds.crs} is not the analysis CRS")
        bands.append(DemBand.from_geotiff(path, src))
    return HorizonEngine(bands)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--build", choices=["mola", "ctx", "all"],
                    help="rebuild WS3's own reference bands (not used by the engine)")
    a = ap.parse_args(argv)
    os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "3")
    rep_path = OUT / "bands.json"
    rep = json.loads(rep_path.read_text()) if rep_path.exists() else {}
    if a.build in ("all", "mola"):
        rep["mola_hrsc_200m"] = build_mola()
    if a.build in ("all", "ctx"):
        rep["ctx_20m"] = build_ctx()
    if a.build:
        rep["offsets"] = band_offsets(own_band_paths())
    missing = [str(p) for p in band_paths().values() if not p.exists()]
    if missing:
        print(f"canonical bands missing: {missing} (WS1 make terrain)")
    rep["canonical"] = {s: str(p.relative_to(REPO)) for s, p in band_paths().items()}
    rep["canonical_offsets"] = band_offsets(band_paths())
    rep["built_utc"] = _now()
    rep_path.parent.mkdir(parents=True, exist_ok=True)
    rep_path.write_text(json.dumps(rep, indent=1))
    print(json.dumps(rep["canonical_offsets"], indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())

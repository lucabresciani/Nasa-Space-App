"""Raster I/O helpers: every WS1 raster is a COG in the analysis CRS (contracts/README.md)."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import numpy as np

from . import grid as G


def write_cog(path: Path, arr: np.ndarray, g: G.Grid, nodata=None, predictor: int | None = None,
              tags: dict | None = None) -> Path:
    """Write ``arr`` on grid ``g`` as a DEFLATE COG (via a temporary GTiff + gdal COG copy)."""
    import rasterio
    from rasterio.shutil import copy as rio_copy

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if nodata is None and arr.dtype.kind == "f":
        nodata = np.nan
    tmp = path.with_name(path.stem + ".tmp.tif")
    with rasterio.open(tmp, "w", driver="GTiff", height=arr.shape[0], width=arr.shape[1],
                       count=1, dtype=arr.dtype, crs=G.analysis_crs(), transform=g.transform,
                       nodata=nodata, tiled=True, compress="deflate", BIGTIFF="IF_SAFER") as ds:
        ds.write(arr, 1)
        if tags:
            ds.update_tags(**{k: str(v) for k, v in tags.items()})
    pred = predictor if predictor is not None else (3 if arr.dtype.kind == "f" else 2)
    rio_copy(tmp, path, driver="COG", compress="DEFLATE", predictor=pred, BIGTIFF="IF_SAFER",
             overviews="AUTO", resampling="average" if arr.dtype.kind == "f" else "nearest")
    os.unlink(tmp)
    return path


def read(path: Path, window=None) -> tuple[np.ndarray, G.Grid]:
    import rasterio

    with rasterio.open(path) as ds:
        a = ds.read(1, window=window, masked=False)
        t = ds.window_transform(window) if window is not None else ds.transform
        if a.dtype.kind == "f" and ds.nodata is not None and np.isfinite(ds.nodata):
            a = np.where(a == ds.nodata, np.nan, a).astype(a.dtype)
        g = G.Grid(x0=t.c, y0=t.f, res=t.a, width=a.shape[1], height=a.shape[0])
    return a, g


def warp_to_grid(src: str | Path, dst: Path, g: G.Grid, resampling: str, src_nodata=None,
                 dst_nodata="nan", out_type: str | None = None, src_srs: str | None = None,
                 extra: list[str] | None = None) -> Path:
    """gdalwarp ``src`` onto grid ``g`` (analysis CRS) as a COG."""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    w, s, e, n = g.bounds
    cmd = ["gdalwarp", "-q", "-overwrite", "-t_srs", G.analysis_crs(), "-te", repr(w), repr(s),
           repr(e), repr(n), "-ts", str(g.width), str(g.height), "-r", resampling,
           "-multi", "-wo", "NUM_THREADS=8", "-of", "COG", "-co", "COMPRESS=DEFLATE",
           "-co", "BIGTIFF=IF_SAFER", "-co", "NUM_THREADS=8"]
    if src_srs:
        cmd += ["-s_srs", src_srs]
    if src_nodata is not None:
        cmd += ["-srcnodata", str(src_nodata)]
    if dst_nodata is not None:
        cmd += ["-dstnodata", str(dst_nodata)]
    if out_type:
        cmd += ["-ot", out_type]
    if out_type in (None, "Float32", "Float64"):
        cmd += ["-co", "PREDICTOR=3"]
    cmd += (extra or []) + [str(src), str(dst)]
    env = {**os.environ, "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR"}
    subprocess.run(cmd, check=True, env=env)
    return dst

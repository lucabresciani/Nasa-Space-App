#!/usr/bin/env python3
"""Build the satellite image of the HD play terrain (Assets/Mars/Resources/MarsPlayOrtho.jpg) straight from the
USGS mosaic, without the web app's tiles.

    python -I Tools/ortho/build_play_ortho_cog.py [--deps <dir>] [--size 4096] [--keep <file.npy>]

Source (official, public): USGS Astrogeology MSL Gale HiRISE LRGB mosaic, 78 quads, 0.25 m
    https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif
    (HiRISE: NASA/JPL-Caltech/University of Arizona). It is a cloud-optimised GeoTIFF in the same equirectangular
    projection as the DEM (sphere R = 3,396,190 m, standard parallel 0), so the play area is an axis-aligned
    rectangle in it: projected x = lon * metersPerDegree, y = lat * metersPerDegree.

Output: the same contract as Tools/ortho/build_play_ortho.py (which builds it from the web app's tiles): a north-up
image whose columns and rows are linear in longitude and latitude over exactly the play terrain of
Assets/Mars/Data/MountSharp/MountSharp.json (south-west post to north-east post), and MarsPlayOrtho_meta.json with
the lat/lon bounds that HUD/MapView.cs and Homeline/Ui/PlanMap.cs read. The window is resampled by area averaging
(GDAL warp, "average", from the overview at or finer than the output pixel). Pixels the mosaic does not cover get
the mean colour and are counted in "coverage".

Requires numpy, rasterio, pillow; --deps adds a folder of pip --target packages to sys.path.
"""
import argparse
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
MOUNT_SHARP = os.path.join(ROOT, "Assets", "Mars", "Data", "MountSharp", "MountSharp.json")
OUT_DIR = os.path.join(ROOT, "Assets", "Mars", "Resources")
COG = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--deps", help="folder of pip --target packages to add to sys.path")
    ap.add_argument("--size", type=int, default=4096, help="output pixels per side")
    ap.add_argument("--keep", help="also save the RGBA float array (row 0 = north) to this .npy, for the splat rule")
    args = ap.parse_args()
    if args.deps:
        sys.path.insert(0, args.deps)
    import numpy as np
    import rasterio
    from affine import Affine
    from rasterio.enums import Resampling
    from rasterio.vrt import WarpedVRT
    from PIL import Image

    ms = json.load(open(MOUNT_SHARP))
    play, mpd, east = ms["play"], ms["metersPerDegree"], ms["eastScale"]
    lat_s, lon_w = play["swLat"], play["swLon"]
    lat_n = lat_s + play["sizeZ"] / mpd
    lon_e = lon_w + play["sizeX"] / (mpd * east)
    x_w, x_e, y_s, y_n = lon_w * mpd, lon_e * mpd, lat_s * mpd, lat_n * mpd      # projected metres
    n = args.size
    transform = Affine((x_e - x_w) / n, 0.0, x_w, 0.0, -(y_n - y_s) / n, y_n)

    env = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
               GDAL_HTTP_MAX_RETRY=5, GDAL_HTTP_RETRY_DELAY=2)
    with rasterio.Env(**env):
        with rasterio.open("/vsicurl/" + COG) as ds:
            src_bounds = ds.bounds
            # the coarsest overview that is still at least as fine as the output pixel (a warped VRT would
            # otherwise read the 0.25 m base level: sixteen times the transfer for the same picture)
            factors = [f for f in ds.overviews(1) if ds.res[0] * f <= transform.a]
            level = ds.overviews(1).index(max(factors)) if factors else None
        with rasterio.open("/vsicurl/" + COG, **({} if level is None else {"overview_level": level})) as ds:
            source_res = ds.res[0]
            with WarpedVRT(ds, crs=ds.crs, transform=transform, width=n, height=n,
                           resampling=Resampling.average, add_alpha=True) as vrt:
                data = vrt.read()                                   # (4, n, n) uint8: R, G, B, alpha
    rgb = np.moveaxis(data[:3], 0, 2).astype(np.float32)
    alpha = data[3].astype(np.float32) / 255.0
    # The mosaic also holds pure-black fill inside its valid mask in places: treat it as uncovered too.
    covered = (alpha > 0.5) & (rgb.sum(2) > 0)
    mean = rgb[covered].mean(axis=0) if covered.any() else np.array([140.0, 107.0, 84.0])
    out = np.where(covered[..., None], rgb, mean)
    if args.keep:
        np.save(args.keep, np.dstack([out, covered.astype(np.float32) * 255.0]).astype(np.uint8))

    os.makedirs(OUT_DIR, exist_ok=True)
    Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGB").save(
        os.path.join(OUT_DIR, "MarsPlayOrtho.jpg"), quality=86, optimize=True, progressive=False)
    meta = {
        "schema": "mars-play-ortho/1",
        "image": "MarsPlayOrtho.jpg",
        "size_px": [n, n],
        "orientation": "north up; columns linear in east longitude, rows linear in latitude",
        "bounds": {"lat_south": lat_s, "lat_north": lat_n, "lon_west": lon_w, "lon_east": lon_e},
        "ground_m_per_px": [play["sizeX"] / n, play["sizeZ"] / n],
        "coverage": round(float(covered.mean()), 4),
        "source": COG,
        "source_bounds_projected_m": [src_bounds.left, src_bounds.bottom, src_bounds.right, src_bounds.top],
        "resampling": "area average (GDAL warp) from the mosaic's %g m overview" % source_res,
        "credit": "HiRISE: NASA/JPL/University of Arizona",
        "built_by": "Tools/ortho/build_play_ortho_cog.py",
    }
    with open(os.path.join(OUT_DIR, "MarsPlayOrtho_meta.json"), "w", newline="\n") as f:
        f.write(json.dumps(meta, indent=1) + "\n")
    print(json.dumps(meta, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_mars_globe.py - Mars globe textures for the MARVIS title / pause screen.

Outputs (written to --out-dir)
------------------------------
  mars_color.jpg    --size x --size/2 (default 8192x4096), sRGB, JPEG q92 4:4:4
  mars_normal.png   --size/2 x --size/4 (default 4096x2048), 8-bit RGB tangent-space normal map

Both maps are equirectangular (simple cylindrical, planetocentric, east-positive):
longitude -180..+180 left to right (0E in the centre column), +90 in the top row.
Shader mapping: u = lon/360 + 0.5, v = lat/180 + 0.5, u wraps.

Data products (official NASA only)
----------------------------------
1. Colour: Viking Orbiter MDIM 2.1 colorized global mosaic, 232 m/px, served by
   NASA Mars Trek (JPL Solar System Treks) as the WMTS layer
   Mars_Viking_MDIM21_ClrMosaic_global_232m.
     Capabilities: https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/WMTSCapabilities.xml
     Tiles:        https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{row}/{col}.jpg
     Tile matrix set default028mm: 256 px tiles, top-left corner (-180, +90),
     level z is 2^(z+1) columns x 2^z rows; row 0 is the northernmost row,
     column 0 starts at 180W. Level 4 = 32 x 16 tiles = 8192 x 4096 px.
     Credit: NASA/JPL-Caltech/USGS (Viking Orbiter MDIM 2.1, via NASA Mars Trek).

2. Relief: Mars Global Surveyor MOLA Mission Experiment Gridded Data Record
   (MEGDR), 16 pixel/degree median topography, product MEGT90N000EB.IMG,
   data set MGS-M-MOLA-5-MEGDR-L3-V1.0, NASA PDS Geosciences Node.
     https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.img
     https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.lbl
     Label: 2880 lines x 5760 samples, 16-bit MSB signed integers, metres above
     the areoid, simple cylindrical, planetocentric, east-positive, first line
     at 90N, first sample at 0E (lon 0..360). Pixel-centre registration.
     Credit: NASA/GSFC/MOLA Science Team (Smith, D. E. et al., "Mars Global
     Surveyor Laser Altimeter Mission Experiment Gridded Data Record", NASA
     Planetary Data System, MGS-M-MOLA-5-MEGDR-L3-V1.0, 2003).

Processing
----------
Colour (no grading, sharpening or retouching - grading happens in the shader):
  1. Read the WMTS capabilities, pick the tile-matrix level whose full width is
     --size (else the next larger one, else the highest available).
  2. Fetch every tile (8 threads, retries, on-disk cache), validate 256x256.
  3. Paste the tiles row/column-wise; Lanczos resample only if the level size
     differs from --size.
  4. Encode JPEG quality 92, 4:4:4 chroma (no subsampling).

Normal map:
  1. Read the label, load the big-endian int16 grid, roll the columns by half
     the width so 0E is the centre column.
  2. Gaussian pre-blur, sigma = 1 px (wrapping in longitude).
  3. Central differences on the 5760x2880 grid on a sphere of radius
     R = 3,396,000 m:  east spacing = R*cos(lat)*dlon (cos(lat) clamped to
     >= 0.08 near the poles), north spacing = R*dlat, longitude wraps.
  4. Vertical exaggeration E = 8 baked in:
        n = normalize(-E*dh/dEast, -E*dh/dNorth, 1)
  5. Lanczos resample the float normal field to --size/2 x --size/4 (with
     longitude wrap padding), renormalise.
  6. Encode RGB = round((n*0.5+0.5)*255): R = east, G = north, B = up.
     A slope rising toward the east gives R < 128, rising toward the north
     gives G < 128.

Constants: E = 8 (vertical exaggeration), R = 3,396,000 m (sphere radius).

Usage
-----
  python build_mars_globe.py --out-dir <dir> --cache-dir <dir> [--size 8192]

Dependencies: Python 3 stdlib + numpy + Pillow.
"""

import argparse
import concurrent.futures
import hashlib
import io
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image

LAYER = "Mars_Viking_MDIM21_ClrMosaic_global_232m"
TREK_BASE = "https://trek.nasa.gov/tiles/Mars/EQ/" + LAYER + "/1.0.0/"
CAPS_URL = TREK_BASE + "WMTSCapabilities.xml"
TILE_URL = TREK_BASE + "default/default028mm/{z}/{row}/{col}.jpg"

MOLA_BASE = "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/"
MOLA_IMG = "megt90n000eb.img"
MOLA_LBL = "megt90n000eb.lbl"
MOLA_IMG_BYTES = 33177600

MARS_RADIUS_M = 3396000.0      # R
EXAGGERATION = 8.0             # E
COS_LAT_MIN = 0.08
BLUR_SIGMA_PX = 1.0

USER_AGENT = "Mozilla/5.0 (build_mars_globe.py)"
MAX_WORKERS = 8
RETRIES = 5

Image.MAX_IMAGE_PIXELS = None


# --------------------------------------------------------------------------- net

def http_get(url, timeout=60):
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001 - retry on anything, report at the end
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("download failed after %d tries: %s (%s)" % (RETRIES, url, last))


def cached_download(url, path, expect_bytes=None):
    if os.path.isfile(path) and (expect_bytes is None or os.path.getsize(path) == expect_bytes):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as fh:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    fh.write(chunk)
            if expect_bytes is not None and os.path.getsize(tmp) != expect_bytes:
                raise RuntimeError("size %d != expected %d" % (os.path.getsize(tmp), expect_bytes))
            os.replace(tmp, path)
            return path
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError("download failed: %s (%s)" % (url, last))


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------------ colour

def read_tile_matrices(cache_dir):
    """Returns [(z, cols, rows, tile_w, tile_h, top_left)] from the WMTS capabilities."""
    path = os.path.join(cache_dir, "dl", "WMTSCapabilities.xml")
    if not os.path.isfile(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(http_get(CAPS_URL))
    ns = {"w": "http://www.opengis.net/wmts/1.0", "ows": "http://www.opengis.net/ows/1.1"}
    root = ET.parse(path).getroot()
    out = []
    for tm in root.findall(".//w:TileMatrixSet/w:TileMatrix", ns):
        z = int(tm.find("ows:Identifier", ns).text)
        cols = int(float(tm.find("w:MatrixWidth", ns).text))
        rows = int(float(tm.find("w:MatrixHeight", ns).text))
        tw = int(tm.find("w:TileWidth", ns).text)
        th = int(tm.find("w:TileHeight", ns).text)
        top_left = tuple(float(v) for v in tm.find("w:TopLeftCorner", ns).text.split())
        out.append((z, cols, rows, tw, th, top_left))
    if not out:
        raise RuntimeError("no TileMatrix entries in the WMTS capabilities")
    return sorted(out)


def fetch_tile(cache_dir, z, row, col, tw, th):
    path = os.path.join(cache_dir, "tiles", str(z), str(row), "%d.jpg" % col)
    data = None
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        with open(path, "rb") as fh:
            data = fh.read()
    for attempt in range(2):
        fresh = data is None
        if fresh:
            data = http_get(TILE_URL.format(z=z, row=row, col=col))
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
            if im.format != "JPEG" or im.size != (tw, th):
                raise ValueError("unexpected tile %s %s" % (im.format, im.size))
        except Exception:  # noqa: BLE001 - corrupt cache entry or bad response: refetch once
            data = None
            if attempt == 1:
                raise
            continue
        if fresh:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path + ".part", "wb") as fh:
                fh.write(data)
            os.replace(path + ".part", path)
        return row, col, im.convert("RGB")
    raise RuntimeError("unreachable")


def build_color(out_dir, cache_dir, size):
    matrices = read_tile_matrices(cache_dir)
    for m in matrices:
        if m[5] != (-180.0, 90.0):
            raise RuntimeError("unexpected TopLeftCorner %r at level %d" % (m[5], m[0]))
    exact = [m for m in matrices if m[1] * m[3] == size]
    larger = [m for m in matrices if m[1] * m[3] > size]
    level = exact[0] if exact else (larger[0] if larger else matrices[-1])
    z, cols, rows, tw, th, _ = level
    full_w, full_h = cols * tw, rows * th
    if full_w != 2 * full_h:
        raise RuntimeError("level %d is not 2:1 (%dx%d)" % (z, full_w, full_h))
    print("colour: WMTS level %d, %d x %d tiles of %dx%d -> %dx%d" % (z, cols, rows, tw, th, full_w, full_h))

    mosaic = Image.new("RGB", (full_w, full_h))
    jobs = [(r, c) for r in range(rows) for c in range(cols)]
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = [pool.submit(fetch_tile, cache_dir, z, r, c, tw, th) for r, c in jobs]
        for fut in concurrent.futures.as_completed(futures):
            row, col, tile = fut.result()      # raises on a missing tile
            mosaic.paste(tile, (col * tw, row * th))
            done += 1
    if done != len(jobs):
        raise RuntimeError("only %d of %d tiles" % (done, len(jobs)))
    print("colour: %d tiles stitched" % done)

    if full_w != size:
        if full_w > size:
            mosaic = mosaic.resize((size, size // 2), Image.Resampling.LANCZOS)
            print("colour: downsampled (Lanczos) to %dx%d" % mosaic.size)
        else:
            print("colour: WARNING level smaller than --size, keeping native %dx%d" % mosaic.size)

    path = os.path.join(out_dir, "mars_color.jpg")
    mosaic.save(path, "JPEG", quality=92, subsampling=0, optimize=True)
    print("colour: wrote %s (%d bytes)" % (path, os.path.getsize(path)))

    prev = mosaic.resize((1024, 512), Image.Resampling.LANCZOS)
    prev.save(os.path.join(cache_dir, "mars_color_preview.png"))
    return z, done, mosaic.size


# ------------------------------------------------------------------------ normal

def parse_label(path):
    with open(path, "r", encoding="latin-1") as fh:
        text = fh.read()

    def get(key):
        m = re.search(r"^\s*" + re.escape(key) + r"\s*=\s*(.+?)\s*$", text, re.M)
        if not m:
            raise RuntimeError("label key missing: " + key)
        return m.group(1).strip().strip('"')

    def num(key):
        return float(re.match(r"[-+0-9.eE]+", get(key)).group(0))

    lbl = {
        "lines": int(num("LINES")),
        "samples": int(num("LINE_SAMPLES")),
        "type": get("SAMPLE_TYPE"),
        "bits": int(num("SAMPLE_BITS")),
        "unit": get("UNIT"),
        "proj": get("MAP_PROJECTION_TYPE"),
        "lon_dir": get("POSITIVE_LONGITUDE_DIRECTION"),
        "max_lat": num("MAXIMUM_LATITUDE"),
        "min_lat": num("MINIMUM_LATITUDE"),
        "west": num("WESTERNMOST_LONGITUDE"),
        "east": num("EASTERNMOST_LONGITUDE"),
        "ppd": num("MAP_RESOLUTION"),
        "radius_km": num("A_AXIS_RADIUS"),
        "system": get("COORDINATE_SYSTEM_NAME"),
    }
    return lbl


def gaussian_blur_wrap(h, sigma):
    """Separable Gaussian: wraps in longitude (axis 1), edge-replicates in latitude."""
    radius = max(1, int(np.ceil(3.0 * sigma)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-0.5 * (x / sigma) ** 2)
    k = (k / k.sum()).astype(np.float32)
    out = np.zeros_like(h)
    for i, w in enumerate(k):
        out += w * np.roll(h, i - radius, axis=1)
    padded = np.pad(out, ((radius, radius), (0, 0)), mode="edge")
    out2 = np.zeros_like(h)
    rows = h.shape[0]
    for i, w in enumerate(k):
        out2 += w * padded[i:i + rows]
    return out2


def resize_wrap(field, out_w, out_h):
    """Lanczos resize of a float32 2D field with longitude wrap padding."""
    src_h, src_w = field.shape
    # pad so that the padded width maps to an integer number of output pixels
    pad_out = 32
    pad_src = int(round(pad_out * src_w / out_w))
    if abs(pad_src * out_w - pad_out * src_w) > 0:
        raise RuntimeError("wrap padding is not pixel exact for %d -> %d" % (src_w, out_w))
    padded = np.concatenate([field[:, -pad_src:], field, field[:, :pad_src]], axis=1)
    im = Image.fromarray(np.ascontiguousarray(padded, dtype=np.float32))
    im = im.resize((out_w + 2 * pad_out, out_h), Image.Resampling.LANCZOS)
    return np.asarray(im, dtype=np.float32)[:, pad_out:pad_out + out_w]


def build_normal(out_dir, cache_dir, size):
    out_w, out_h = size // 2, size // 4
    lbl_path = cached_download(MOLA_BASE + MOLA_LBL, os.path.join(cache_dir, "dl", MOLA_LBL))
    img_path = cached_download(MOLA_BASE + MOLA_IMG, os.path.join(cache_dir, "dl", MOLA_IMG), MOLA_IMG_BYTES)
    digest = sha256_of(img_path)
    print("normal: %s sha256 %s" % (MOLA_IMG, digest))

    lbl = parse_label(lbl_path)
    print("normal: label %r" % (lbl,))
    expect = (lbl["type"] == "MSB_INTEGER" and lbl["bits"] == 16 and lbl["unit"] == "METER"
              and lbl["proj"] == "SIMPLE CYLINDRICAL" and lbl["lon_dir"] == "EAST"
              and lbl["max_lat"] == 90.0 and lbl["min_lat"] == -90.0
              and lbl["west"] == 0.0 and lbl["east"] == 360.0
              and lbl["system"] == "PLANETOCENTRIC"
              and lbl["samples"] == int(round(360 * lbl["ppd"]))
              and lbl["lines"] == int(round(180 * lbl["ppd"])))
    if not expect:
        raise RuntimeError("label does not match the expected MEGDR layout")
    lines, samples = lbl["lines"], lbl["samples"]
    if os.path.getsize(img_path) != lines * samples * 2:
        raise RuntimeError("image size does not match the label")

    h = np.fromfile(img_path, dtype=">i2").reshape(lines, samples).astype(np.float32)
    # first sample is 0E: roll by half the width so the centre column is 0E (-180..+180)
    h = np.roll(h, samples // 2, axis=1)

    dlat = np.deg2rad(180.0 / lines)
    dlon = np.deg2rad(360.0 / samples)
    lat = np.deg2rad(90.0 - (np.arange(lines) + 0.5) * (180.0 / lines))     # row centres, north first
    lon_deg = -180.0 + (np.arange(samples) + 0.5) * (360.0 / samples)

    # registration check on the raw heights
    imax = np.unravel_index(np.argmax(h), h.shape)
    imin = np.unravel_index(np.argmin(h), h.shape)
    print("normal: max %.0f m at lat %.2f lon %.2f (Olympus Mons expected 18.65N, -133.8E)"
          % (h[imax], np.rad2deg(lat[imax[0]]), lon_deg[imax[1]]))
    print("normal: min %.0f m at lat %.2f lon %.2f (Hellas expected about 30-45S, 60-75E)"
          % (h[imin], np.rad2deg(lat[imin[0]]), lon_deg[imin[1]]))

    hb = gaussian_blur_wrap(h, BLUR_SIGMA_PX)
    del h

    coslat = np.maximum(np.cos(lat), COS_LAT_MIN).astype(np.float32)[:, None]
    d_east = (np.roll(hb, -1, axis=1) - np.roll(hb, 1, axis=1)) / (2.0 * MARS_RADIUS_M * dlon * coslat)
    # rows run north -> south, so d/dNorth = -d/dRow (one-sided at the two polar rows)
    d_north = -np.gradient(hb, axis=0) / (MARS_RADIUS_M * dlat)
    del hb

    nx = (-EXAGGERATION * d_east).astype(np.float32)
    ny = (-EXAGGERATION * d_north).astype(np.float32)
    del d_east, d_north
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + 1.0)
    nx *= inv
    ny *= inv
    nz = inv.astype(np.float32)

    rx = resize_wrap(nx, out_w, out_h)
    ry = resize_wrap(ny, out_w, out_h)
    rz = resize_wrap(nz, out_w, out_h)
    del nx, ny, nz
    rz = np.maximum(rz, 1e-3)
    inv = 1.0 / np.sqrt(rx * rx + ry * ry + rz * rz)
    n = np.stack([rx * inv, ry * inv, rz * inv], axis=-1)
    rgb = np.clip(np.rint((n * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)

    # sign convention self-check on the flanks of Olympus Mons (18.65N, -133.8E)
    def px(lat_deg, lon_d):
        return (int((90.0 - lat_deg) / 180.0 * out_h), int((lon_d + 180.0) / 360.0 * out_w))

    def mean_patch(lat_deg, lon_d, ch):
        r, c = px(lat_deg, lon_d)
        return float(rgb[r - 6:r + 7, c - 6:c + 7, ch].mean())

    west_r = mean_patch(18.65, -136.3, 0)   # west flank rises toward the east -> R < 128
    east_r = mean_patch(18.65, -131.3, 0)   # east flank falls toward the east -> R > 128
    south_g = mean_patch(16.2, -133.8, 1)   # south flank rises toward the north -> G < 128
    north_g = mean_patch(21.1, -133.8, 1)   # north flank falls toward the north -> G > 128
    print("normal: Olympus flanks  west R %.1f  east R %.1f  south G %.1f  north G %.1f"
          % (west_r, east_r, south_g, north_g))
    if not (west_r < 128 < east_r and south_g < 128 < north_g):
        raise RuntimeError("normal map sign convention check failed")
    print("normal: channel means R %.2f G %.2f B %.2f, min B %d"
          % (rgb[..., 0].mean(), rgb[..., 1].mean(), rgb[..., 2].mean(), int(rgb[..., 2].min())))

    path = os.path.join(out_dir, "mars_normal.png")
    Image.fromarray(rgb).save(path, "PNG", optimize=True)
    print("normal: wrote %s (%d bytes)" % (path, os.path.getsize(path)))

    # preview: the map itself on top, a simple lit version (sun from the north-west) below
    small = Image.fromarray(rgb).resize((1024, 512), Image.Resampling.LANCZOS)
    v = np.asarray(small, dtype=np.float32) / 127.5 - 1.0
    light = np.array([-0.5, 0.5, 0.707], dtype=np.float32)
    light /= np.linalg.norm(light)
    shade = np.clip((v @ light) * 255.0 * 1.2, 0, 255).astype(np.uint8)
    prev = Image.new("RGB", (1024, 1024))
    prev.paste(small, (0, 0))
    prev.paste(Image.fromarray(shade).convert("RGB"), (0, 512))
    prev.save(os.path.join(cache_dir, "mars_normal_preview.png"))
    return digest, rgb.shape


# -------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Build the Mars globe colour and normal maps (NASA data only).")
    ap.add_argument("--out-dir", required=True, help="folder that receives mars_color.jpg and mars_normal.png")
    ap.add_argument("--cache-dir", required=True, help="folder for downloads, tile cache and previews")
    ap.add_argument("--size", type=int, default=8192,
                    help="colour map width in px (height = size/2, normal map = size/2 x size/4)")
    ap.add_argument("--only", choices=["color", "normal"], help="build just one of the two maps")
    args = ap.parse_args()
    if args.size % 128 != 0:
        ap.error("--size must be a multiple of 128")
    os.makedirs(args.out_dir, exist_ok=True)
    os.makedirs(args.cache_dir, exist_ok=True)

    if args.only != "normal":
        build_color(args.out_dir, args.cache_dir, args.size)
    if args.only != "color":
        build_normal(args.out_dir, args.cache_dir, args.size)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# build_star_strip.py - star-field strip for the MARVIS title / pause backdrop.
#
# PRODUCT
#   NASA Goddard Scientific Visualization Studio, "Deep Star Maps 2020" (SVS ID 4851)
#   https://svs.gsfc.nasa.gov/4851/
#   File: starmap_2020_8k_gal.exr  (8192x4096, plate carree, GALACTIC coordinates,
#         OpenEXR half-float RGB, linear colorspace; images replaced by SVS on 2021-01-04)
#   URL:  https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_8k_gal.exr
#   SHA-256: d70924422d3e0159764b16a19658784befcf73b97e06e5c16614860c1514bb58 (160,735,772 bytes)
#   Per the SVS page: "The map is centered at 0 deg longitude, and longitude increases to
#   the left." The stars are plotted from Hipparcos-2, Tycho-2 and Gaia DR2 (with Yale BSC,
#   UCAC3, XHIP); pixel values are linear-light RGB star flux, not display-referred.
#
# CREDIT (as requested on the SVS page)
#   NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.
#   Constellation figures based on those developed for the IAU by Alan MacRobert of
#   Sky and Telescope magazine (Roger Sinnott and Rick Fienberg).
#
# PROCESSING (nothing else: no resample, sharpen, denoise, glow, flip or paint)
#   1. Crop: rows 1024..3071 of the 4096-row map = galactic latitude +45 deg (top row)
#      to -45 deg (bottom row); all 8192 columns = the full 360 deg of longitude, so the
#      left and right edges are neighbours on the sky and tile seamlessly.
#   2. Tone map, one global curve:  m = max(R, G, B);  m' = 1 - exp(-EXPOSURE * m);
#      RGB' = RGB * (m' / m).  An exponential shoulder on the brightest channel with the
#      channel ratios left untouched, so star colours are neither desaturated nor clipped
#      (output is always < 1.0). For small values this is simply RGB * EXPOSURE.
#   3. sRGB OETF (piecewise IEC 61966-2-1), round to 8 bit.
#   4. JPEG quality 92, 4:4:4 chroma (no subsampling), baseline.
#
# OUTPUT
#   <out-dir>/stars_strip.jpg  (8192x2048). The matching stars_strip.jpg.meta is kept by
#   hand in the repo (fixed guid, import settings) and is NOT written by this script.
#   Previews for eyeballing go to <cache-dir>: stars_preview_2048.png, stars_crop_gc.png.
#
# USAGE
#   python build_star_strip.py --out-dir Assets/Mars/UI/Resources/Title --cache-dir <dir>
#   Needs numpy, OpenEXR (>= 3.3, the OpenEXR.File API) and Pillow.

import argparse
import hashlib
import os
import sys
import urllib.request

import numpy as np
import OpenEXR
from PIL import Image

URL = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_8k_gal.exr"
EXR_NAME = "starmap_2020_8k_gal.exr"
EXR_SHA256 = "d70924422d3e0159764b16a19658784befcf73b97e06e5c16614860c1514bb58"
OUT_NAME = "stars_strip.jpg"

SRC_W, SRC_H = 8192, 4096
LAT_HALF_DEG = 45.0            # strip covers galactic latitude +45 .. -45
EXPOSURE = 4.75                # linear gain ahead of the shoulder (the only tone constant)
JPEG_QUALITY = 92


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(cache_dir):
    path = os.path.join(cache_dir, EXR_NAME)
    if not os.path.isfile(path):
        os.makedirs(cache_dir, exist_ok=True)
        print("downloading", URL)
        req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
        tmp = path + ".part"
        with urllib.request.urlopen(req) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(tmp, path)
    digest = sha256_of(path)
    print("input", path, os.path.getsize(path), "bytes, sha256", digest)
    if digest != EXR_SHA256:
        sys.exit("SHA-256 mismatch: expected " + EXR_SHA256)
    return path


def load_band(path):
    channels = OpenEXR.File(path).channels()
    if "RGB" in channels:
        rgb = channels["RGB"].pixels
    else:
        rgb = np.stack([channels[c].pixels for c in "RGB"], axis=-1)
    if rgb.shape != (SRC_H, SRC_W, 3):
        sys.exit("unexpected EXR shape %r" % (rgb.shape,))
    rows = int(round(SRC_H * (2.0 * LAT_HALF_DEG) / 180.0))    # 2048
    top = (SRC_H - rows) // 2                                  # 1024
    return np.ascontiguousarray(rgb[top:top + rows]).astype(np.float32)


def tone_map(lin, exposure):
    m = lin.max(axis=-1)
    safe = np.maximum(m, 1e-8)
    scale = np.where(m > 1e-8, -np.expm1(-exposure * safe) / safe, exposure)
    out = lin * scale[..., None].astype(np.float32)
    out = np.clip(out, 0.0, 1.0)
    srgb = np.where(out <= 0.0031308,
                    12.92 * out,
                    1.055 * np.power(np.maximum(out, 1e-12), 1.0 / 2.4) - 0.055)
    return np.round(srgb * 255.0).astype(np.uint8)


def report(img8):
    h, w, _ = img8.shape
    edge = h // 10
    edges = np.concatenate([img8[:edge], img8[h - edge:]])
    gray = img8.astype(np.float32).mean(axis=-1)
    blocks = gray.reshape(h // 32, 32, w // 32, 32).mean(axis=(1, 3))
    print("top+bottom 10%% rows: median %.1f / 255" % np.median(edges))
    print("Milky Way 32 px block mean: max %.1f, p99.9 %.1f, p99 %.1f"
          % (blocks.max(), np.percentile(blocks, 99.9), np.percentile(blocks, 99)))
    print("channel means R %.2f G %.2f B %.2f" % tuple(img8.reshape(-1, 3).mean(axis=0)))
    print("fraction of channel values >= 250: %.5f" % (img8 >= 250).mean())
    print("seam: mean |col0 - col(w-1)| %.2f vs mean |col0 - col1| %.2f"
          % (np.abs(img8[:, 0].astype(int) - img8[:, -1].astype(int)).mean(),
             np.abs(img8[:, 0].astype(int) - img8[:, 1].astype(int)).mean()))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.normpath(os.path.join(here, "..", ".."))
    ap = argparse.ArgumentParser(description="Build the title-screen star strip from NASA SVS 4851.")
    ap.add_argument("--out-dir", default=os.path.join(repo, "Assets", "Mars", "UI", "Resources", "Title"))
    ap.add_argument("--cache-dir", required=True, help="download + preview folder (outside the repo)")
    ap.add_argument("--exposure", type=float, default=EXPOSURE)
    args = ap.parse_args()

    Image.MAX_IMAGE_PIXELS = None
    exr = fetch(args.cache_dir)
    lin = load_band(exr)
    print("band", lin.shape, "linear max %.3f" % lin.max(), "exposure", args.exposure)
    img8 = tone_map(lin, args.exposure)
    del lin

    os.makedirs(args.out_dir, exist_ok=True)
    out_path = os.path.join(args.out_dir, OUT_NAME)
    Image.fromarray(img8, "RGB").save(out_path, "JPEG", quality=JPEG_QUALITY, subsampling=0, optimize=True)
    print("wrote", out_path, os.path.getsize(out_path), "bytes, sha256", sha256_of(out_path))

    back = Image.open(out_path)
    back.load()
    decoded = np.asarray(back.convert("RGB"))
    print("decoded JPEG", back.size, back.mode)
    report(decoded)

    # previews of the encoded file (not deliverables)
    back.resize((2048, 512), Image.LANCZOS).save(os.path.join(args.cache_dir, "stars_preview_2048.png"))
    cx, cy = back.size[0] // 2, back.size[1] // 2      # galactic centre: l = 0, b = 0
    back.crop((cx - 800, cy - 450, cx + 800, cy + 450)).save(os.path.join(args.cache_dir, "stars_crop_gc.png"))


if __name__ == "__main__":
    main()

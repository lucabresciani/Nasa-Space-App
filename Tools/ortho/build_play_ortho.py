"""Build the satellite image of the HD play terrain for the EVA map (G): Assets/Mars/Resources/MarsPlayOrtho.jpg.

Source: the HOMELINE web app's HiRISE basemap tiles (home-line repo, web/public/data/tiles/basemap: XYZ Web Mercator,
256 px WebP, zoom 13-18), cut by WS1 from the USGS mosaic MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif
(HiRISE: NASA/JPL/University of Arizona). The Mission Planer shows the same tiles, so both maps look alike.

Output: a north-up image whose rows and columns are linear in latitude and longitude over exactly the play terrain
(Assets/Mars/Data/MountSharp/MountSharp.json "play": swLat, swLon, sizeX, sizeZ, with the scene's equirectangular
metersPerDegree and eastScale), so Unity maps it onto the terrain through MarsGeoReference.WorldXZ with no
reprojection. Each pixel samples the finest zoom that has data there (17, else 16; bilinear; 18 is finer than the
output and skipped), with alpha-weighted blending; pixels with no tile data get the mean colour and are counted.
Writes MarsPlayOrtho_meta.json beside it (bounds, size, coverage, sources).

Usage: uv run --with pillow --with numpy python Tools/ortho/build_play_ortho.py <home-line>/web/public/data/tiles/basemap
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MOUNT_SHARP = ROOT / "Assets/Mars/Data/MountSharp/MountSharp.json"
OUT_DIR = ROOT / "Assets/Mars/Resources"
SIZE = 4096
ZOOMS = (17, 16)  # finest first
TILE = 256


def merc_px(lon: np.ndarray, lat: np.ndarray, z: int) -> tuple[np.ndarray, np.ndarray]:
    n = TILE * 2 ** z
    x = (lon + 180.0) / 360.0 * n
    phi = np.radians(lat)
    y = (1.0 - np.log(np.tan(phi) + 1.0 / np.cos(phi)) / math.pi) / 2.0 * n
    return x, y


def mosaic(tiles: Path, z: int, x0: float, x1: float, y0: float, y1: float) -> tuple[np.ndarray, int, int, int]:
    """RGBA float mosaic of the tiles covering mercator pixels [x0, x1] x [y0, y1]; missing tiles alpha 0."""
    tx0, tx1 = int(math.floor(x0 / TILE)) - 1, int(math.floor(x1 / TILE)) + 1
    ty0, ty1 = int(math.floor(y0 / TILE)) - 1, int(math.floor(y1 / TILE)) + 1
    w, h = (tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE
    m = np.zeros((h, w, 4), dtype=np.float32)
    found = 0
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            p = tiles / str(z) / str(tx) / f"{ty}.webp"
            if not p.exists():
                continue
            im = np.asarray(Image.open(p).convert("RGBA"), dtype=np.float32) / 255.0
            im[..., :3] *= im[..., 3:]   # premultiply: transparent texels keep stray colour in these WebPs
            m[(ty - ty0) * TILE:(ty - ty0 + 1) * TILE, (tx - tx0) * TILE:(tx - tx0 + 1) * TILE] = im
            found += 1
    return m, tx0 * TILE, ty0 * TILE, found


def bilinear(m: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = m.shape[:2]
    x = np.clip(x - 0.5, 0, w - 1.001)
    y = np.clip(y - 0.5, 0, h - 1.001)
    xi, yi = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = (x - xi)[..., None], (y - yi)[..., None]
    a, b = m[yi, xi], m[yi, xi + 1]
    c, d = m[yi + 1, xi], m[yi + 1, xi + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    tiles = Path(sys.argv[1])
    tj = json.loads((tiles / "tilejson.json").read_text())
    ms = json.loads(MOUNT_SHARP.read_text())
    play, mpd, east = ms["play"], ms["metersPerDegree"], ms["eastScale"]
    lat_s, lon_w = play["swLat"], play["swLon"]
    lat_n = lat_s + play["sizeZ"] / mpd
    lon_e = lon_w + play["sizeX"] / (mpd * east)

    # Pixel centres, north-up.
    j, i = np.mgrid[0:SIZE, 0:SIZE].astype(np.float64)
    lon = lon_w + (i + 0.5) / SIZE * (lon_e - lon_w)
    lat = lat_n - (j + 0.5) / SIZE * (lat_n - lat_s)

    rgb = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    cover = np.zeros((SIZE, SIZE), dtype=np.float32)   # accumulated alpha
    used = {}
    for z in ZOOMS:
        x, y = merc_px(lon, lat, z)
        m, ox, oy, found = mosaic(tiles, z, x.min(), x.max(), y.min(), y.max())
        used[z] = found
        s = bilinear(m, x - ox, y - oy)
        a = s[..., 3]
        # premultiplied samples: divide by alpha for the colour, so coverage edges neither darken nor flare
        col = np.where(a[..., None] > 1e-3, s[..., :3] / np.maximum(a[..., None], 1e-3), 0.0)
        take = np.clip(a, 0, 1) * (1.0 - cover)
        rgb += col * take[..., None]
        cover += take
    covered = cover > 0.5
    mean = (rgb[covered] / cover[covered][:, None]).mean(axis=0) if covered.any() else np.array([0.55, 0.42, 0.33])
    out = np.where(cover[..., None] > 1e-3, rgb / np.maximum(cover[..., None], 1e-3), mean)
    out = np.where(cover[..., None] < 1.0, out * cover[..., None] + mean * (1.0 - cover[..., None]), out)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img = Image.fromarray(np.clip(out * 255.0 + 0.5, 0, 255).astype(np.uint8), "RGB")
    img.save(OUT_DIR / "MarsPlayOrtho.jpg", quality=86, optimize=True, progressive=False)
    meta = {
        "schema": "mars-play-ortho/1",
        "image": "MarsPlayOrtho.jpg",
        "size_px": [SIZE, SIZE],
        "orientation": "north up; columns linear in east longitude, rows linear in latitude",
        "bounds": {"lat_south": lat_s, "lat_north": lat_n, "lon_west": lon_w, "lon_east": lon_e},
        "ground_m_per_px": [play["sizeX"] / SIZE, play["sizeZ"] / SIZE],
        "coverage": round(float((cover > 0.99).mean()), 4),
        "tiles_used": {str(k): v for k, v in used.items()},
        "source": tj.get("source"),
        "tiles": "HOMELINE web app web/public/data/tiles/basemap (" + tj.get("name", "") + ")",
        "credit": tj.get("attribution", "HiRISE: NASA/JPL/University of Arizona"),
        "built_by": "Tools/ortho/build_play_ortho.py",
    }
    (OUT_DIR / "MarsPlayOrtho_meta.json").write_text(json.dumps(meta, indent=1) + "\n")
    print(json.dumps(meta, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

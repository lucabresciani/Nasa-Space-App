#!/usr/bin/env python3
"""Builds the high-definition ("play") terrain of the Mars EVA simulator from the USGS 1 m Gale DEM.

    python -I Tools/mountsharp/build_play_terrain.py --cache <dir> [--deps <dir>] [--extend 1024] [--stage ...]

Source (official, public): USGS Astrogeology Science Center, MSL Gale Merged DEM Mosaic 1 m v3
    https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif
    Mars_Equirectangular_clon0 on the sphere R = 3,396,190 m, standard parallel 0: one pixel is 1 m north-south and
    cos(lat) = 0.996489 m east-west on the ground here. Float32 metres above the MOLA areoid, nodata -32767.
    The file stores every row as one strip across the full width (about 80 KB), so the window is read as row ranges
    over HTTP and cached in --cache as .npy chunks (about 0.5 GB of transfer for --extend 1024).

What it writes, in Assets/Mars/Data/MountSharp (read by Assets/Mars/Editor/MarsTerrain.cs):
    play_height.r16.gz   gzip of little-endian uint16, RES x RES posts, row 0 = south, column 0 = west;
                         elevation = minElevation + value / 65535 * (maxElevation - minElevation)
    play_splat.png       ground-cover weights, RGBA = Dust, Gravel, Bedrock, DarkSand; top row = north
    MountSharp.json      play size / corner / elevation range, spawn, summit and backdrop offsets, backdrop hole
    rocks_hirise.csv, craters.csv   same rows, x and z moved to the new south-west corner

Stages (--stage, default all): fetch, heights (r16 + json + csv), splat. The splat stage needs the satellite image
of the NEW area (Assets/Mars/Resources/MarsPlayOrtho.jpg from Tools/ortho/build_play_ortho_cog.py, which reads the
corner from the json the heights stage wrote), so a first run is: --stage heights, the ortho script, --stage splat.

How the heights are made (everything here is measured DEM data or stated arithmetic on it):
  * The ORIGINAL play area is 4096 x 4096 DEM pixels whose south-west post is the centre of DEM pixel
    (column 13389, row 41925). That window was verified against the previous play_height.r16.gz: 256 m or more
    inside the edges the two agree to the 16-bit quantisation (median 3 mm, max 6 mm).
  * --extend N adds N DEM pixels on every side: (4096 + 2N) pixels per side, (4097 + 2N) posts.
  * Unity heightmaps hold at most 4097 posts per side, so the window is resampled to 4097 posts by AREA AVERAGING:
    each output post is the mean of the DEM over its own footprint (a box STEP x STEP source pixels centred on the
    post, STEP = (4096 + 2N) / 4096, 1.5 for N = 1024), applied separably along rows and columns. With N = 0 this is
    the identity (the original 1 m posts).
  * Planetary curvature: elevation - r^2 / (2R), r = ground distance from the spawn point, R = 3,396,190 m
    (same convention as the backdrop and MarsGeoReference.CurvatureDrop).
  * Edge feather (DERIVED, not measured): within FEATHER_M metres of the border the heights are blended into the
    32 m backdrop surface (backdrop_height.r16.gz, bilinear), weight smoothstep(distance / FEATHER_M), so the border
    posts equal the backdrop exactly and no crack shows at the backdrop's hole. The previous data did the same over
    about 144 m (measured from it); the old feather band is now interior and carries the plain DEM.
  * Nodata cells (none are expected in this window) are reported and, if present, filled from the mean of their
    valid neighbours; the count is printed and written to MountSharp.json.

How the ground cover (splat) is made: see derive_splat(). Inside the original 4 km it is the previous map, resampled;
in the new ring it is DERIVED BY RULE from the DEM slope and the HiRISE image brightness, a rule fitted to the
original area's own map. It is a plausible continuation, not a mapped product.

Requires: numpy, rasterio (fetch only), pillow. --deps adds a folder of pip --target packages to sys.path.
"""
import argparse
import gzip
import json
import os
import re
import sys
import time

# ---------------------------------------------------------------------------------------------- fixed geometry
DEM_URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif"
DEM_ORIGIN_X = 8127993.4927860238      # projected metres of the DEM's top-left pixel corner
DEM_ORIGIN_Y = -244781.07518943801
DEM_NODATA = -32767.0

BASE_COL0 = 13389                      # DEM column of the original play area's west post
BASE_ROW_S = 41925                     # DEM row of the original play area's south post (rows count southwards)
BASE_PX = 4096                         # original play area, DEM pixels per side
OUT_RES = 4097                         # Unity's largest heightmap

# Values of the original MountSharp.json; positions are measured from the original south-west corner.
BASE_SIZE_X = 4081.620616                                 # ground metres east-west of the original 4096 pixels
BASE_SW_LAT, BASE_SW_LON = -4.83691334, 137.35005552      # original south-west post (a pixel centre)
BASE_SPAWN_X, BASE_SPAWN_Z = 2041.27, 2047.707            # ground metres east / north of the SW post
BASE_SUMMIT_X, BASE_SUMMIT_Z = 30325.166, -31520.0
BASE_BACKDROP_OFFSET_X, BASE_BACKDROP_OFFSET_Z = -30962.918895, -35520.0
BASE_HOLE = (971, 1110, 1099, 1238)                       # backdrop cells x0, z0, x1, z1 under the original area
BASE_SPLAT_RES = 2048                                     # the original splat: 2 m per texel over the 4096 pixels
BACKDROP_CELL_PX = 32                                     # one backdrop cell = 32 DEM pixels

FEATHER_M = 144.0                      # width of the blend into the backdrop along the border, DEM pixels (m N-S)
CHUNK_ROWS = 64
BASE_SPLAT_NAME = "play_splat_original_4km.png"           # copy of the original splat kept in --cache


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------------------------------------- DEM window
def window_geometry(extend):
    n_px = BASE_PX + 2 * extend
    col0 = BASE_COL0 - extend              # west post
    row_s = BASE_ROW_S + extend            # south post
    row_n = row_s - n_px                   # north post
    return n_px, col0, row_n, row_s


def fetch_window(extend, cache, workers):
    """Returns the (n_px + 1)^2 float32 window, row 0 = NORTH (as stored), reading missing row chunks over HTTP."""
    import numpy as np
    n_px, col0, row_n, _ = window_geometry(extend)
    n = n_px + 1
    whole = os.path.join(cache, f"dem_window_c{col0}_r{row_n}_n{n}.npy")
    if os.path.exists(whole):
        return np.load(whole)

    import rasterio
    from rasterio.windows import Window
    from concurrent.futures import ThreadPoolExecutor
    chunk_dir = os.path.join(cache, f"chunks_c{col0}_n{n}")
    os.makedirs(chunk_dir, exist_ok=True)
    env = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
               GDAL_HTTP_MULTIRANGE="YES", GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", VSI_CACHE="FALSE",
               GDAL_HTTP_MAX_RETRY=5, GDAL_HTTP_RETRY_DELAY=2)
    starts = list(range(0, n, CHUNK_ROWS))

    def path(r0):
        return os.path.join(chunk_dir, f"rows_{row_n + r0}.npy")

    def read(r0):
        if os.path.exists(path(r0)):
            return 0
        rows = min(CHUNK_ROWS, n - r0)
        with rasterio.Env(**env):
            with rasterio.open("/vsicurl/" + DEM_URL) as ds:
                block = ds.read(1, window=Window(col0, row_n + r0, n, rows))
        tmp = path(r0) + ".tmp.npy"
        np.save(tmp, block)
        os.replace(tmp, path(r0))
        return rows

    t0 = time.time()
    todo = [r for r in starts if not os.path.exists(path(r))]
    log(f"fetch: {len(todo)} of {len(starts)} chunks of {CHUNK_ROWS} rows to read, {workers} connections")
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for _ in pool.map(read, todo):
            done += 1
            if done % 8 == 0 or done == len(todo):
                log(f"  {done}/{len(todo)} chunks, {time.time() - t0:.0f} s")
    window = np.concatenate([np.load(path(r)) for r in starts], axis=0)
    assert window.shape == (n, n), window.shape
    np.save(whole, window)
    log(f"fetch: window {window.shape} cached in {whole} ({time.time() - t0:.0f} s)")
    return window


# ---------------------------------------------------------------------------------------------- heights
def fill_nodata(win):
    """Replaces nodata cells by the mean of their valid 8-neighbours, repeatedly. Returns the number filled."""
    import numpy as np
    bad = win == DEM_NODATA
    total = int(bad.sum())
    while bad.any():
        valid = (~bad).astype(np.float32)
        vals = np.where(bad, 0.0, win).astype(np.float32)
        acc = np.zeros_like(vals)
        cnt = np.zeros_like(vals)
        pv, pc = np.pad(vals, 1), np.pad(valid, 1)
        for dz in (0, 1, 2):
            for dx in (0, 1, 2):
                acc += pv[dz:dz + win.shape[0], dx:dx + win.shape[1]]
                cnt += pc[dz:dz + win.shape[0], dx:dx + win.shape[1]]
        fix = bad & (cnt > 0)
        if not fix.any():
            raise SystemExit("nodata cells with no valid neighbour at all: the window is not usable")
        win[fix] = acc[fix] / cnt[fix]
        bad &= ~fix
    return total


def box_taps(n_src, n_out):
    """Area-average taps along one axis: output sample i is centred on source post i * step and averages the source
    over [centre - step / 2, centre + step / 2]; a source post k stands for [k - 0.5, k + 0.5]. Edges are clamped."""
    import numpy as np
    step = (n_src - 1) / (n_out - 1)
    centre = np.arange(n_out) * step
    lo, hi = centre - step / 2, centre + step / 2
    k0 = np.floor(lo + 0.5).astype(np.int64)
    taps = int(np.ceil(step)) + 1
    idx = k0[:, None] + np.arange(taps)[None, :]
    w = np.clip(np.minimum(hi[:, None], idx + 0.5) - np.maximum(lo[:, None], idx - 0.5), 0.0, None) / step
    return np.clip(idx, 0, n_src - 1), w


def area_resample(a, n_out):
    """Separable area average of a square grid of posts to n_out posts per side (identity when the sizes match)."""
    import numpy as np
    idx, w = box_taps(a.shape[0], n_out)
    rows = np.zeros((n_out, a.shape[1]), dtype=np.float64)
    for t in range(idx.shape[1]):
        rows += w[:, t][:, None] * a[idx[:, t], :]
    out = np.zeros((n_out, n_out), dtype=np.float64)
    for t in range(idx.shape[1]):
        out += w[:, t][None, :] * rows[:, idx[:, t]]
    return out


def read_r16(path, res):
    import numpy as np
    with gzip.open(path) as f:
        return np.frombuffer(f.read(), dtype="<u2").reshape(res, res)


def geometry(info, extend):
    """Everything in MountSharp.json that depends on where the play area's south-west post is."""
    n_px, col0, _, row_s = window_geometry(extend)
    mpd = info["metersPerDegree"]
    east = BASE_SIZE_X / BASE_PX            # ground metres per DEM pixel east-west (cos of the centre latitude)
    cells = extend // BACKDROP_CELL_PX
    return dict(
        n_px=n_px, east=east, step=n_px / (OUT_RES - 1),
        size_x=n_px * east, size_z=float(n_px),
        # the SW post is the CENTRE of DEM pixel (col0, row_s); the geotransform origin is the grid's top-left corner
        sw_lon=round((DEM_ORIGIN_X + col0 + 0.5) / mpd, 8), sw_lat=round((DEM_ORIGIN_Y - (row_s + 0.5)) / mpd, 8),
        spawn_x=BASE_SPAWN_X + extend * east, spawn_z=BASE_SPAWN_Z + extend,
        summit_x=BASE_SUMMIT_X + extend * east, summit_z=BASE_SUMMIT_Z + extend,
        offset_x=BASE_BACKDROP_OFFSET_X + extend * east, offset_z=BASE_BACKDROP_OFFSET_Z + extend,
        hole=(BASE_HOLE[0] - cells, BASE_HOLE[1] - cells, BASE_HOLE[2] + cells, BASE_HOLE[3] + cells),
    )


def build_heights(dem_north_up, info, g, data_dir):
    """DEM window -> play_height.r16.gz. Returns (elevation grid, row 0 = south; min; max; nodata cells filled)."""
    import numpy as np
    win = dem_north_up[::-1].astype(np.float32)                     # row 0 = south, like the terrain
    filled = fill_nodata(win)
    log(f"heights: DEM window {win.shape}, {win.min():.2f} .. {win.max():.2f} m, nodata cells filled: {filled}")
    h = area_resample(win, OUT_RES)

    # planetary curvature, measured from the spawn point (ground metres)
    radius = info["planetRadius"]
    x = np.arange(OUT_RES) * (g["size_x"] / (OUT_RES - 1)) - g["spawn_x"]
    z = np.arange(OUT_RES) * (g["size_z"] / (OUT_RES - 1)) - g["spawn_z"]
    h -= (x[None, :] ** 2 + z[:, None] ** 2) / (2.0 * radius)

    # feather into the backdrop surface along the border (derived, see the module docstring)
    bd = info["backdrop"]
    b = read_r16(os.path.join(data_dir, bd["heightFile"]), bd["resolution"])
    b = bd["minElevation"] + b.astype(np.float64) / 65535.0 * (bd["maxElevation"] - bd["minElevation"])
    src = np.arange(OUT_RES) * g["step"]                            # post position in DEM pixels from the SW post
    fx, fz = g["hole"][0] + src / BACKDROP_CELL_PX, g["hole"][1] + src / BACKDROP_CELL_PX
    ix = np.clip(np.floor(fx).astype(int), 0, bd["resolution"] - 2)
    iz = np.clip(np.floor(fz).astype(int), 0, bd["resolution"] - 2)
    tx, tz = (fx - ix)[None, :], (fz - iz)[:, None]
    surface = (b[np.ix_(iz, ix)] * (1 - tx) * (1 - tz) + b[np.ix_(iz, ix + 1)] * tx * (1 - tz)
               + b[np.ix_(iz + 1, ix)] * (1 - tx) * tz + b[np.ix_(iz + 1, ix + 1)] * tx * tz)
    edge = np.minimum(src, g["n_px"] - src)                         # distance to the nearest border along one axis
    d = np.minimum(edge[None, :], edge[:, None])
    t = np.clip(d / FEATHER_M, 0.0, 1.0)
    wgt = t * t * (3.0 - 2.0 * t)
    gap = np.abs(h - surface)[wgt < 1.0]
    log(f"heights: feather band {FEATHER_M:.0f} m; DEM against the backdrop surface inside it: median {np.median(gap):.2f} m, "
        f"95% {np.percentile(gap, 95):.2f} m, max {gap.max():.2f} m")
    h = wgt * h + (1.0 - wgt) * surface

    lo, hi = float(h.min()), float(h.max())
    q = np.round((h - lo) / (hi - lo) * 65535.0).astype("<u2")
    out = os.path.join(data_dir, info["play"]["heightFile"])
    with open(out, "wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0, filename="") as f:
            f.write(q.tobytes())
    log(f"heights: {out} written, {os.path.getsize(out) / 1e6:.1f} MB, {lo:.3f} .. {hi:.3f} m, quantum {(hi - lo) / 65535 * 100:.2f} cm")
    return h, lo, hi, filled


def shift_csv(path, extend, east):
    """Boulder / crater tables hold x, z in metres from the play area's SW post: move them to the new corner.
    A '# extend=N' line records which corner the file is in, so running this again does not shift twice."""
    if not os.path.exists(path):
        return 0
    lines = open(path, encoding="utf-8").read().splitlines()
    current = 0
    for line in lines:
        m = re.match(r"#\s*extend=(\d+)", line)
        if m:
            current = int(m.group(1))
    dx, dz = (extend - current) * east, float(extend - current)
    out, n = [], 0
    for line in lines:
        if line.startswith("#"):
            continue
        parts = line.split(",")
        try:
            x, z = float(parts[0]), float(parts[1])
        except (ValueError, IndexError):
            out.append(line)                                         # the header
            out.append(f"# extend={extend} x and z are metres east and north of the play area's south-west post "
                       f"(Tools/mountsharp/build_play_terrain.py); mapped in the original 4 km only")
            continue
        out.append(",".join([f"{x + dx:.3f}", f"{z + dz:.3f}"] + parts[2:]))
        n += 1
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out) + "\n")
    return n


def write_json(info, data_dir):
    with open(os.path.join(data_dir, "MountSharp.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(info, indent=2) + "\n")


def update_json(info, g, extend, lo, hi, filled):
    play, bd = info["play"], info["backdrop"]

    def r6(v):
        return round(float(v), 6)

    play.update(resolution=OUT_RES, sizeX=r6(g["size_x"]), sizeZ=r6(g["size_z"]), minElevation=r6(lo), maxElevation=r6(hi),
                swLat=g["sw_lat"], swLon=g["sw_lon"])
    # informational (the Unity loader ignores unknown keys)
    play["extendPx"] = extend
    play["sourcePixels"] = g["n_px"]
    play["postSpacingM"] = [r6(g["size_x"] / (OUT_RES - 1)), r6(g["size_z"] / (OUT_RES - 1))]
    play["nodataFilled"] = filled
    play["derivation"] = (
        f"USGS MSL Gale DEM 1 m v3, DEM columns {BASE_COL0 - extend}..{BASE_COL0 - extend + g['n_px']}, rows "
        f"{BASE_ROW_S + extend - g['n_px']}..{BASE_ROW_S + extend}, area-averaged to {OUT_RES} posts "
        f"({g['step']:g} DEM pixels per post), minus the curvature drop r^2/2R from the spawn; the outer {FEATHER_M:.0f} m "
        f"are blended into the 32 m backdrop surface (derived, not measured). Tools/mountsharp/build_play_terrain.py")
    bd.update(offsetX=r6(g["offset_x"]), offsetZ=r6(g["offset_z"]),
              holeX0=g["hole"][0], holeZ0=g["hole"][1], holeX1=g["hole"][2], holeZ1=g["hole"][3])
    info["spawn"].update(x=r6(g["spawn_x"]), z=r6(g["spawn_z"]))
    info["summit"].update(x=r6(g["summit_x"]), z=r6(g["summit_z"]))


# ---------------------------------------------------------------------------------------------- ground cover
LAYERS = ("Dust", "Gravel", "Bedrock", "DarkSand")        # PNG channels R, G, B, A (MarsTerrain.ReadSplat)
SLOPE_BIN_DEG, SLOPE_BINS = 2.5, 24                       # 0..60 degrees
GRAY_BIN, GRAY_BINS = 8, 32                               # 0..255 image brightness
SLOPE_SMOOTH_PX = 2                                       # the DEM is box-smoothed over (2 * 2 + 1) px before the slope
SPLAT_FADE_M = 48.0                                       # original map <-> rule cross-fade, metres


def box_mean(a, r):
    """Mean over a (2r + 1)^2 window, edges clamped."""
    import numpy as np
    k = 2 * r + 1
    p = np.pad(a, r, mode="edge").astype(np.float64)
    c = np.cumsum(p, 0)
    p = np.vstack([c[k - 1:k], c[k:] - c[:-k]])
    c = np.cumsum(p, 1)
    p = np.hstack([c[:, k - 1:k], c[:, k:] - c[:, :-k]])
    return (p / (k * k)).astype(np.float32)


def derive_splat(dem_north_up, info, g, extend, data_dir, ortho_dir, base_splat_path):
    """Ground cover for the whole play area -> play_splat.png. Returns the agreement report (dict).

    The original 4 km keeps its own map (USGS orthophoto derived, made by the original data preparation), resampled
    bilinearly into the new raster, except its outer FEATHER_M metres, where that map was already a fade into the
    coarse backdrop map. Everywhere else nothing was mapped, so the weights are DERIVED BY RULE:

        weights = TABLE[slope class][brightness class]

    slope      = slope of the 1 m DEM after a 5 x 5 px mean, averaged over the texel, in 2.5 degree classes;
    brightness = luminance of the HiRISE LRGB image (MarsPlayOrtho.jpg) averaged over the texel, in classes of 8/255;
    TABLE      = the mean weights that the original map has, inside the original 4 km, for that pair of classes
                 (pairs that never occur there use the slope class alone).
    So the ring gets, for every texel, the average ground cover of the places in the original area that are as steep
    and as bright. In practice: steep ground (above about 20 degrees) is bedrock, dark ground is sand, bright ground
    is dust, the rest gravel. The table is rebuilt from the data at every run, nothing is hand-tuned; how well it
    reproduces the original map inside the original area is measured and returned.
    """
    import numpy as np
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    res = info["play"]["splatResolution"]
    texel = g["n_px"] / res                                         # DEM pixels per texel

    # slope per texel (row 0 = south)
    win = dem_north_up[::-1].astype(np.float32)
    fill_nodata(win)
    smooth = box_mean(win, SLOPE_SMOOTH_PX)
    slope = np.degrees(np.arctan(np.hypot(np.gradient(smooth, g["east"], axis=1), np.gradient(smooth, 1.0, axis=0)))).astype(np.float32)
    slope = np.asarray(Image.fromarray(slope[:g["n_px"], :g["n_px"]], "F").resize((res, res), Image.BOX))

    # image brightness per texel (the image is north-up: flip)
    meta = json.load(open(os.path.join(ortho_dir, "MarsPlayOrtho_meta.json"), encoding="utf-8"))
    b = meta["bounds"]
    if abs(b["lat_south"] - g["sw_lat"]) > 1e-7 or abs(b["lon_west"] - g["sw_lon"]) > 1e-7:
        raise SystemExit("MarsPlayOrtho.jpg does not cover this play area: run Tools/ortho/build_play_ortho_cog.py, then --stage splat")
    gray = np.asarray(Image.open(os.path.join(ortho_dir, "MarsPlayOrtho.jpg")).convert("L").resize((res, res), Image.BOX))[::-1].astype(np.float32)

    # the original map in the new raster: texel centre (DEM px) -> original texel coordinate, bilinear, edge clamped
    old = np.asarray(Image.open(base_splat_path).convert("RGBA"))[::-1].astype(np.float32) / 255.0
    assert old.shape[0] == BASE_SPLAT_RES, old.shape
    centre = (np.arange(res) + 0.5) * texel                         # texel centre, DEM pixels from the SW post
    oc = np.clip((centre - extend) / (BASE_PX / BASE_SPLAT_RES) - 0.5, 0, BASE_SPLAT_RES - 1)
    i0 = np.clip(np.floor(oc).astype(int), 0, BASE_SPLAT_RES - 2)
    t = (oc - i0).astype(np.float32)
    tz, tx = t[:, None, None], t[None, :, None]
    w_old = (old[np.ix_(i0, i0)] * (1 - tz) * (1 - tx) + old[np.ix_(i0, i0 + 1)] * (1 - tz) * tx
             + old[np.ix_(i0 + 1, i0)] * tz * (1 - tx) + old[np.ix_(i0 + 1, i0 + 1)] * tz * tx)
    w_old /= np.maximum(w_old.sum(2, keepdims=True), 1e-6)
    # Metres inside the original border (negative outside). The original map was itself faded into the coarse
    # backdrop map over its outer FEATHER_M metres (its border texels equal backdrop_splat.png), so it is the mapped
    # product only from FEATHER_M inwards: that is where it is kept and where the table is learned.
    inner = np.minimum(centre - extend, extend + BASE_PX - centre)
    inner = np.minimum(inner[:, None], inner[None, :])
    inside = inner >= FEATHER_M

    # the table, learned inside the original area
    sb = np.clip((slope / SLOPE_BIN_DEG).astype(int), 0, SLOPE_BINS - 1)
    gb = np.clip((gray / GRAY_BIN).astype(int), 0, GRAY_BINS - 1)
    idx = sb * GRAY_BINS + gb
    n_cells = SLOPE_BINS * GRAY_BINS
    count = np.bincount(idx[inside], minlength=n_cells).astype(np.float64)
    table = np.stack([np.bincount(idx[inside], weights=w_old[..., k][inside], minlength=n_cells) for k in range(4)], 1)
    by_slope_n = np.bincount(sb[inside], minlength=SLOPE_BINS).astype(np.float64)
    by_slope = np.stack([np.bincount(sb[inside], weights=w_old[..., k][inside], minlength=SLOPE_BINS) for k in range(4)], 1)
    overall = w_old[inside].mean(0)
    by_slope = np.where(by_slope_n[:, None] > 0, by_slope / np.maximum(by_slope_n, 1)[:, None], overall[None, :])
    table = np.where(count[:, None] > 0, table / np.maximum(count, 1)[:, None], np.repeat(by_slope, GRAY_BINS, axis=0))
    w_rule = table[idx].astype(np.float32)
    w_rule /= np.maximum(w_rule.sum(2, keepdims=True), 1e-6)

    # how well the rule reproduces the original map where that map exists
    dom_old, dom_rule = w_old.argmax(2), w_rule.argmax(2)
    report = {"dominantLayerAgreementPct": round(float((dom_old == dom_rule)[inside].mean() * 100), 1), "layers": {}}
    for k, name in enumerate(LAYERS):
        was, now = inside & (dom_old == k), inside & (dom_rule == k)
        report["layers"][name] = {
            "foundPct": round(float((dom_rule[was] == k).mean() * 100), 1) if was.any() else None,      # of the original layer's texels
            "rightPct": round(float((dom_old[now] == k).mean() * 100), 1) if now.any() else None,       # of the rule's texels
            "meanWeightErrorPct": round(float(np.abs(w_rule[..., k] - w_old[..., k])[inside].mean() * 100), 1),
            "sharePctOriginal": round(float(was[inside].mean() * 100), 1), "sharePctRule": round(float(now[inside].mean() * 100), 1),
        }
    report["measuredOn"] = f"the original area, {FEATHER_M:.0f} m or more inside its border ({int(inside.sum())} texels)"
    ring = ~inside
    report["ringSharePct"] = {name: round(float((dom_rule[ring] == k).mean() * 100), 1) for k, name in enumerate(LAYERS)}

    # original map inside, rule outside, fading over the last SPLAT_FADE_M metres of the original map's own margin
    f = np.clip((inner - (FEATHER_M - SPLAT_FADE_M)) / SPLAT_FADE_M, 0.0, 1.0)
    f = (f * f * (3.0 - 2.0 * f))[..., None]
    w = f * w_old + (1.0 - f) * w_rule

    # along the new border: fade into the backdrop's own map, as the original did, so the ground cover is continuous
    bd = info["backdrop"]
    back = np.asarray(Image.open(os.path.join(data_dir, bd["splatFile"])).convert("RGBA"))[::-1].astype(np.float32) / 255.0
    back /= np.maximum(back.sum(2, keepdims=True), 1e-6)
    per_texel = (bd["resolution"] - 1) * BACKDROP_CELL_PX / bd["splatResolution"]       # DEM pixels per backdrop texel
    fx = (g["hole"][0] * BACKDROP_CELL_PX + centre) / per_texel - 0.5
    fz = (g["hole"][1] * BACKDROP_CELL_PX + centre) / per_texel - 0.5
    ix, iz = np.floor(fx).astype(int), np.floor(fz).astype(int)
    ux, uz = (fx - ix).astype(np.float32)[None, :, None], (fz - iz).astype(np.float32)[:, None, None]
    w_back = (back[np.ix_(iz, ix)] * (1 - uz) * (1 - ux) + back[np.ix_(iz, ix + 1)] * (1 - uz) * ux
              + back[np.ix_(iz + 1, ix)] * uz * (1 - ux) + back[np.ix_(iz + 1, ix + 1)] * uz * ux)
    edge = np.minimum(centre, g["n_px"] - centre)
    e = np.clip(np.minimum(edge[:, None], edge[None, :]) / FEATHER_M, 0.0, 1.0)
    e = (e * e * (3.0 - 2.0 * e))[..., None]
    w = e * w + (1.0 - e) * w_back
    w /= np.maximum(w.sum(2, keepdims=True), 1e-6)
    q = np.floor(w * 255.0).astype(np.int32)
    top = w.argmax(2)
    np.put_along_axis(q, top[..., None], np.take_along_axis(q, top[..., None], 2) + (255 - q.sum(2, keepdims=True)), 2)   # sum = 255
    out = os.path.join(data_dir, info["play"]["splatFile"])
    Image.fromarray(q[::-1].astype(np.uint8), "RGBA").save(out, optimize=True)
    log(f"splat: {out} written, {os.path.getsize(out) / 1e6:.1f} MB, {res} px, {texel:g} m per texel")
    log("splat: rule against the original map inside the original area: " + json.dumps(report))
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--old-splat", help=f"the original 4 km play_splat.png (default: {BASE_SPLAT_NAME} in --cache, saved by the first run)")
    ap.add_argument("--ortho", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "Assets", "Mars", "Resources"),
                    help="folder with MarsPlayOrtho.jpg and MarsPlayOrtho_meta.json of the new area")
    ap.add_argument("--extend", type=int, default=1024, help="DEM pixels added on every side of the original 4096 px area (multiple of 32)")
    ap.add_argument("--cache", required=True, help="folder for the cached DEM window and the saved original splat")
    ap.add_argument("--deps", help="folder of pip --target packages (numpy, rasterio, pillow) to add to sys.path")
    ap.add_argument("--data", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "Assets", "Mars", "Data", "MountSharp"))
    ap.add_argument("--workers", type=int, default=8, help="parallel HTTP connections for the fetch")
    ap.add_argument("--stage", choices=("fetch", "heights", "splat", "all"), default="all")
    args = ap.parse_args()
    if args.deps:
        sys.path.insert(0, args.deps)
    if args.extend % BACKDROP_CELL_PX or args.extend < 0:
        sys.exit("--extend must be a non-negative multiple of 32 (one backdrop cell)")
    os.makedirs(args.cache, exist_ok=True)
    data_dir = os.path.abspath(args.data)
    import numpy as np

    dem = fetch_window(args.extend, args.cache, args.workers)
    if args.stage == "fetch":
        sys.exit(0)
    info = json.load(open(os.path.join(data_dir, "MountSharp.json"), encoding="utf-8"))
    g = geometry(info, args.extend)
    base = geometry(info, 0)
    assert (base["sw_lat"], base["sw_lon"]) == (BASE_SW_LAT, BASE_SW_LON), "the pixel grid does not give the original corner"

    # Keep the original 4 km splat before anything is overwritten: the splat stage re-uses it at every run.
    base_splat = args.old_splat or os.path.join(args.cache, BASE_SPLAT_NAME)
    if not os.path.exists(base_splat):
        if info["play"].get("extendPx", 0) != 0:
            sys.exit(f"the original 4 km play_splat.png is needed: pass --old-splat (git show <commit before the extension>:"
                     f"Assets/Mars/Data/MountSharp/play_splat.png) or put it in the cache as {BASE_SPLAT_NAME}")
        import shutil
        shutil.copyfile(os.path.join(data_dir, info["play"]["splatFile"]), base_splat)

    if args.stage in ("heights", "all"):
        h, lo, hi, filled = build_heights(dem, info, g, data_dir)
        np.save(os.path.join(args.cache, f"play_elevation_extend{args.extend}.npy"), h.astype(np.float32))
        update_json(info, g, args.extend, lo, hi, filled)
        write_json(info, data_dir)
        for name in (info.get("rocksFile"), info.get("cratersFile")):
            if name:
                log(f"{name}: {shift_csv(os.path.join(data_dir, name), args.extend, g['east'])} rows moved to the new corner")
        log(f"MountSharp.json: play {g['size_x']:.3f} x {g['size_z']:.1f} m, sw {g['sw_lat']}, {g['sw_lon']}, "
            f"spawn {g['spawn_x']:.3f}, {g['spawn_z']:.3f}, backdrop hole {g['hole']}")

    if args.stage in ("splat", "all"):
        if args.extend == 0:
            import shutil
            shutil.copyfile(base_splat, os.path.join(data_dir, info["play"]["splatFile"]))      # nothing to derive
        else:
            report = derive_splat(dem, info, g, args.extend, data_dir, os.path.abspath(args.ortho), base_splat)
            info["play"]["splatDerivation"] = (
                f"inside the original 4 km ({FEATHER_M:.0f} m or more from its border): the original map, resampled; elsewhere: derived by rule from the DEM slope and the HiRISE "
                f"image brightness (table learned on the original area, Tools/mountsharp/build_play_terrain.py derive_splat), "
                f"which reproduces the original map's dominant layer on {report['dominantLayerAgreementPct']}% of the original area; "
                f"the outer {FEATHER_M:.0f} m fade into backdrop_splat.png")
            info["play"]["splatRuleAgreement"] = report
            write_json(info, data_dir)

"""Cached raw downloads for the terrain stack (F1; AGENTS.md rule 9; docs/discovery.md 2.x).

Everything lands in ``data/raw/terrain/`` with one entry per file in ``cache_index.json``
(url, request, bytes on the wire, file size, UTC time). A cached entry whose file exists is never
fetched again. Every network read counts against ``site.yaml download_budget_bytes``; a fetch that
would cross it raises ``BudgetExceeded`` before any byte is requested.

Merged DEM (D0 2.1): a striped GeoTIFF (one 33 km row per LZW strip), so a window costs whole
rows. We cache full-width row bands of ``raw_fetch_chunk_rows`` rows, a few in parallel, and
mosaic them locally with a VRT. COG sources (HiRISE DTMs, ortho, LRGB, CTX) are read as windows.

CLI::

    python -m pipeline.terrain.fetch dem          # merged-DEM row bands over the dem window
    python -m pipeline.terrain.fetch hirise       # both HiRISE DTM windows
    python -m pipeline.terrain.fetch crism        # D2300 + SINDEX2 bands (byte ranges)
    python -m pipeline.terrain.fetch lrgb         # LRGB colour ortho (WS8, basemap)
    python -m pipeline.terrain.fetch red          # HiRISE RED ortho 019698 at ~1 m (WS8 grey)
    python -m pipeline.terrain.fetch status
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from . import grid as G

INDEX = G.RAW / "cache_index.json"
_lock = threading.Lock()

GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "GDAL_HTTP_MAX_RETRY": "6",
    "GDAL_HTTP_RETRY_DELAY": "3",
    "GDAL_HTTP_TIMEOUT": "120",
}
CLI_ENV = {**GDAL_ENV, "CPL_VSIL_SHOW_NETWORK_STATS": "YES"}  # gdal_translate: count bytes


class BudgetExceeded(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_index() -> dict:
    return json.loads(INDEX.read_text()) if INDEX.exists() else {}


def _save_index(idx: dict) -> None:
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    tmp = INDEX.with_suffix(".tmp")
    tmp.write_text(json.dumps(idx, indent=1, sort_keys=True))
    os.replace(tmp, INDEX)


def downloaded_total(idx: dict | None = None) -> int:
    idx = load_index() if idx is None else idx
    return sum(int(e.get("bytes_downloaded") or 0) for e in idx.values())


def _check_budget(estimate: int) -> None:
    budget = int(G.site()["download_budget_bytes"])
    used = downloaded_total()
    if used + estimate > budget:
        raise BudgetExceeded(
            f"fetch of ~{estimate / 1e6:.0f} MB would exceed the WS1 budget "
            f"({used / 1e6:.0f} MB used of {budget / 1e6:.0f} MB)")


def cached(name: str) -> Path | None:
    e = load_index().get(name)
    if e and (G.REPO / e["path"]).exists():
        return G.REPO / e["path"]
    return None


def _register(name: str, path: Path, url: str, request: dict, nbytes: int) -> None:
    with _lock:
        idx = load_index()
        idx[name] = {
            "path": str(path.relative_to(G.REPO)) if path.is_relative_to(G.REPO)
            else str(path),
            "url": url,
            "request": request,
            "bytes_downloaded": int(nbytes),
            "file_bytes": path.stat().st_size,
            "utc": _now(),
        }
        _save_index(idx)


def _net_bytes(text: str) -> int:
    """Sum of GET downloaded_bytes from GDAL's CPL_VSIL_SHOW_NETWORK_STATS dump."""
    m = text.find("Network statistics:")
    if m < 0:
        return 0
    blob = text[m + len("Network statistics:"):]
    try:
        stats = json.JSONDecoder().raw_decode(blob.strip())[0]
        return int(stats["methods"]["GET"]["downloaded_bytes"])
    except (ValueError, KeyError):
        nums = re.findall(r'"downloaded_bytes":(\d+)', blob)
        return int(nums[0]) if nums else 0


def gdal_translate(name: str, url: str, out: Path, srcwin=None, projwin=None,
                   extra: list[str] | None = None, estimate: int = 0) -> Path:
    """Cached ``gdal_translate`` of a /vsicurl/ window to a local tiled GeoTIFF."""
    if (p := cached(name)) is not None:
        return p
    _check_budget(estimate)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".part")
    cmd = ["gdal_translate", "-q", "-of", "GTiff"]
    if srcwin is not None:
        cmd += ["-srcwin", *map(str, srcwin)]
    if projwin is not None:
        cmd += ["-projwin", *map(repr, projwin)]
    cmd += extra or ["-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-co", "BIGTIFF=IF_SAFER"]
    cmd += [f"/vsicurl/{url}", str(tmp)]
    env = {**os.environ, **CLI_ENV}
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise RuntimeError(f"{name}: gdal_translate failed: {r.stderr[-2000:]}")
    os.replace(tmp, out)
    _register(name, out, url, {"srcwin": srcwin, "projwin": projwin}, _net_bytes(
        r.stdout + r.stderr))
    return out


def http_range(name: str, url: str, out: Path, start: int, length: int) -> Path:
    """Cached HTTP byte-range download (curl)."""
    if (p := cached(name)) is not None:
        return p
    _check_budget(length)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".part")
    r = subprocess.run(["curl", "-sSfL", "--retry", "5", "-r", f"{start}-{start + length - 1}",
                        "-o", str(tmp), url], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{name}: curl failed: {r.stderr}")
    if tmp.stat().st_size != length:
        raise RuntimeError(f"{name}: expected {length} bytes, got {tmp.stat().st_size}")
    os.replace(tmp, out)
    _register(name, out, url, {"range": [start, start + length - 1]}, length)
    return out


# --------------------------------------------------------------------------- merged DEM


def merged_dem_tif_url() -> str:
    """The VRT (site.yaml sources.merged_dem_vrt) wraps one TIFF of the same stem (D0 2.1)."""
    vrt = G.site()["sources"]["merged_dem_vrt"]
    return vrt[: -len(".vrt")] + ".tif"


def merged_dem_rows(margin_m: float | None = None) -> tuple[int, int]:
    """Source rows [r0, r1) of the merged DEM covering the dem grid +/- margin.

    Analysis y and source y are both R*lat (lat_0 = 0 in both CRSs), so rows map 1:1.
    """
    import rasterio

    s = G.site()
    margin = s["raw_fetch_margin_m"] if margin_m is None else margin_m
    with rasterio.Env(**GDAL_ENV), rasterio.open(f"/vsicurl/{merged_dem_tif_url()}") as ds:
        t, h = ds.transform, ds.height
    _, south, _, north = G.dem_grid().bounds
    r0 = max(0, math.floor((t.f - (north + margin)) / -t.e))
    r1 = min(h, math.ceil((t.f - (south - margin)) / -t.e))
    return r0, r1


def fetch_merged_dem(workers: int = 4) -> list[Path]:
    import rasterio

    s = G.site()
    url = merged_dem_tif_url()
    with rasterio.Env(**GDAL_ENV), rasterio.open(f"/vsicurl/{url}") as ds:
        width = ds.width
    r0, r1 = merged_dem_rows()
    step = int(s["raw_fetch_chunk_rows"])
    starts = list(range(r0, r1, step))
    per_row = 81_000  # D0 2.1: ~81 KB per compressed row near the pad (budget estimate only)
    jobs = []
    for a in starts:
        n = min(step, r1 - a)
        name = f"merged_dem_v3_rows_{a:05d}_{a + n:05d}"
        out = G.RAW / "merged_dem_rows" / f"{name}.tif"
        jobs.append((name, out, (0, a, width, n), n * per_row))

    def run(job):
        name, out, win, est = job
        p = gdal_translate(name, url, out, srcwin=win, estimate=est,
                           extra=["-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3",
                                  "-co", "TILED=YES", "-co", "BLOCKXSIZE=512",
                                  "-co", "BLOCKYSIZE=512"])
        print(f"{name}: ok ({downloaded_total() / 1e6:.0f} MB total)", flush=True)
        return p

    with ThreadPoolExecutor(workers) as ex:
        paths = list(ex.map(run, jobs))
    vrt = G.RAW / "merged_dem_rows.vrt"
    subprocess.run(["gdalbuildvrt", "-q", str(vrt), *map(str, paths)], check=True)
    return paths


# --------------------------------------------------------------------------- HiRISE DTMs


def fetch_hirise_dtms() -> dict[str, Path]:
    """Windows of both HiRISE DTMs over the dem grid (+margin), in their native grid."""
    out = {}
    s = G.site()
    margin = s["raw_fetch_margin_m"]
    w, so, e, n = G.dem_grid().bounds
    lon_w, lat_s = G.lonlat_of_xy(w - margin, so - margin)
    lon_e, lat_n = G.lonlat_of_xy(e + margin, n + margin)
    src = G._tr(G.geo_crs(), G.source_crs())
    xw, yn = src.transform(lon_w, lat_n)
    xe, ys = src.transform(lon_e, lat_s)
    for pid, url in s["d0_sources"]["hirise_dtm_href"].items():
        name = f"hirise_dtm_{pid}_win"
        out[pid] = gdal_translate(
            name, url, G.RAW / "hirise" / f"{name}.tif", projwin=(xw, yn, xe, ys),
            estimate=150_000_000,
            extra=["-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3", "-co", "TILED=YES"])
        print(f"{name}: ok ({downloaded_total() / 1e6:.0f} MB total)", flush=True)
    return out


# --------------------------------------------------------------------------- ortho (WS8, basemap)


def _src_projwin(w, s_, e, n):
    """Analysis-CRS bounds -> source (eqc clon 0) projwin (ulx, uly, lrx, lry)."""
    lon_w, lat_n = G.lonlat_of_xy(w, n)
    lon_e, lat_s = G.lonlat_of_xy(e, s_)
    src = G._tr(G.geo_crs(), G.source_crs())
    xw, yn = src.transform(lon_w, lat_n)
    xe, ys = src.transform(lon_e, lat_s)
    return xw, yn, xe, ys


def fetch_lrgb() -> dict[str, Path]:
    """Gale LRGB colour COG (D0 2.6): 1 m overview over the dem window (+margin) for WS8 and
    the low basemap zooms; full 0.25 m over the focus area for the high zooms."""
    s = G.site()
    url = s["d0_sources"]["lrgb_cog_href"]
    m = s["raw_fetch_margin_m"]
    w, so, e, n = G.dem_grid().bounds
    out = {}
    jpeg = ["-co", "COMPRESS=JPEG", "-co", "PHOTOMETRIC=YCBCR", "-co", "TILED=YES",
            "-co", "JPEG_QUALITY=90", "--config", "GDAL_TIFF_INTERNAL_MASK", "YES"]
    out["1m"] = gdal_translate("lrgb_1m_demwin", url, G.RAW / "ortho" / "lrgb_1m_demwin.tif",
                               projwin=_src_projwin(w - m, so - m, e + m, n + m),
                               estimate=80_000_000,
                               extra=["-oo", "OVERVIEW_LEVEL=1", *jpeg])
    print(f"lrgb 1m ok ({downloaded_total() / 1e6:.0f} MB total)", flush=True)
    f = s["aoi_focus"]
    fx0, fy1 = G.xy_of_lonlat(f["west"], f["north"])
    fx1, fy0 = G.xy_of_lonlat(f["east"], f["south"])
    out["025m"] = gdal_translate("lrgb_025m_focus", url, G.RAW / "ortho" / "lrgb_025m_focus.tif",
                                 projwin=_src_projwin(fx0, fy0, fx1, fy1), estimate=250_000_000,
                                 extra=jpeg)
    print(f"lrgb 0.25m ok ({downloaded_total() / 1e6:.0f} MB total)", flush=True)
    return out


def fetch_red() -> Path:
    """HiRISE RED ortho of 019698 (site.yaml d0_sources.hirise_ortho_href; UInt16 COG with
    scale/offset, 0.253 m) at its second overview (~1.01 m) over the dem window (+margin): the
    greyscale base texture for WS8 (config/fp3d.yaml texture.grey_from: red)."""
    s = G.site()
    url = s["d0_sources"]["hirise_ortho_href"]
    m = s["raw_fetch_margin_m"]
    w, so, e, n = G.dem_grid().bounds
    p = gdal_translate("hirise_red_019698_1m_demwin", url,
                       G.RAW / "ortho" / "hirise_red_019698_1m_demwin.tif",
                       projwin=_src_projwin(w - m, so - m, e + m, n + m), estimate=120_000_000,
                       extra=["-oo", "OVERVIEW_LEVEL=1", "-co", "COMPRESS=DEFLATE",
                              "-co", "PREDICTOR=2", "-co", "TILED=YES"])
    print(f"hirise red ok ({downloaded_total() / 1e6:.0f} MB total)", flush=True)
    return p


# --------------------------------------------------------------------------- MOLA-HRSC (WS3)


def mola_radius_m() -> float:
    """MOLA-HRSC band outer edge (horizon.yaml sampling, source mola_hrsc_200m) + planning
    radius + raw_fetch_margin_m."""
    import yaml

    h = yaml.safe_load((G.CONFIG / "horizon.yaml").read_text())
    to_m = max(b["to_m"] for b in h["sampling"] if b["source"] == "mola_hrsc_200m")
    s = G.site()
    return float(to_m + s["planning_radius_m"] + s["raw_fetch_margin_m"])


def fetch_mola() -> Path:
    """MOLA-HRSC blend 200 m (geographic lon/lat, uncompressed 1-row strips): window of
    mola_radius_m around the pad. GTIFF_DIRECT_IO=YES range-reads only the needed bytes of each
    strip (D0 2.5: an 80 km window cost 2.2 MB instead of ~170 MB)."""
    s = G.site()
    url = s["d0_sources"]["mola_hrsc_200m_href"]
    r = mola_radius_m()
    px, py = G.pad_xy()
    lon_w, lat_n = G.lonlat_of_xy(px - r, py + r)
    lon_e, lat_s = G.lonlat_of_xy(px + r, py - r)
    p = gdal_translate("mola_hrsc_200m_win", url, G.RAW / "mola" / "mola_hrsc_200m_win.tif",
                       projwin=(lon_w, lat_n, lon_e, lat_s), estimate=10_000_000,
                       extra=["--config", "GTIFF_DIRECT_IO", "YES", "-co", "COMPRESS=DEFLATE",
                              "-co", "TILED=YES"])
    print(f"mola ok ({downloaded_total() / 1e6:.0f} MB total)", flush=True)
    return p


# --------------------------------------------------------------------------- CRISM


def _envi_hdr(path: Path) -> dict:
    txt = path.read_text()
    out = {}
    for k in ("samples", "lines", "bands", "header offset", "data type", "byte order"):
        m = re.search(rf"^{k}\s*=\s*(\S+)", txt, re.M)
        out[k] = int(m.group(1)) if m else None
    m = re.search(r"^map info\s*=\s*\{([^}]*)\}", txt, re.M)
    out["map info"] = [v.strip() for v in m.group(1).split(",")] if m else None
    return out


def fetch_crism() -> dict[str, dict[str, Path]]:
    """Byte-range download of the D2300 and SINDEX2 bands of each MTRDR SU cube (D0 2.7)."""
    s = G.site()["d0_sources"]
    res: dict[str, dict[str, Path]] = {}
    for pid, url in s["crism_su_img"].items():
        hdr = G.REPO / "data" / "raw" / "discovery" / f"crism_{pid}_su.hdr"
        h = _envi_hdr(hdr)
        if h["data type"] != 4 or h["byte order"] != 0:
            raise RuntimeError(f"{pid}: unexpected ENVI type/order {h}")
        band_bytes = h["samples"] * h["lines"] * 4
        res[pid] = {}
        for idx_name, band in s["crism_band_1based"].items():
            name = f"crism_{pid}_{idx_name}_b{band}"
            start = h["header offset"] + (band - 1) * band_bytes
            res[pid][idx_name] = http_range(name, url, G.RAW / "crism" / f"{name}.f32", start,
                                            band_bytes)
    return res


# --------------------------------------------------------------------------- CTX (WS3 mid field)


def ctx_radius_m() -> float:
    """CTX band outer edge (horizon.yaml sampling, source ctx_20m) + planning radius."""
    import yaml

    h = yaml.safe_load((G.CONFIG / "horizon.yaml").read_text())
    to_m = max(b["to_m"] for b in h["sampling"] if b["source"] == "ctx_20m")
    return float(to_m + G.site()["planning_radius_m"])


def ctx_candidates() -> list[dict]:
    """CTX DTM items from D0's cached STAC responses (docs/discovery.md 2.4), analysis-CRS
    footprints and the geoid-adjusted asset href."""
    import shapely
    from shapely.geometry import shape

    disc_dir = G.REPO / "data" / "raw" / "discovery"
    # D0 2.4: first 500 of the 3,263 items intersecting the pad (id, bbox, geometry only)
    feats = json.loads((disc_dir / "stac_ctx_pad_point_idbbox.json").read_text())["features"]
    for p in sorted((G.RAW / "stac").glob("ctx_point_*.json")):  # extra point queries
        feats += json.loads(p.read_text())["features"]
    asset = G.site()["d0_sources"]["ctx_asset"]
    suffix = {"geoid_adjusted_dem": "-DEM-geoid-adj.tif"}[asset]
    out, seen = [], set()
    for f in feats:
        if f["id"] in seen or f.get("geometry") is None:
            continue
        seen.add(f["id"])
        href = (f.get("assets", {}).get(asset, {}).get("href")
                or f"{CTX_BASE}/{f['id']}/{f['id']}{suffix}")  # pattern verified on D0 items
        geom = shapely.transform(shape(f["geometry"]), lambda c: np.column_stack(
            G.xy_of_lonlat(c[:, 0], c[:, 1])))
        out.append({"id": f["id"], "href": href, "poly": geom})
    return out


STAC_SEARCH = "https://stac.astrogeology.usgs.gov/api/search"
CTX_BASE = "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs"


def stac_ctx_point(lon: float, lat: float, limit: int = 100) -> Path:
    """Cached STAC search for CTX DTMs intersecting one point (fills gaps in D0's list)."""
    name = f"stac_ctx_point_{lon:.3f}_{lat:.3f}"
    if (p := cached(name)) is not None:
        return p
    out = G.RAW / "stac" / f"ctx_point_{lon:.3f}_{lat:.3f}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps({"collections": ["mro_ctx_controlled_usgs_dtms"], "limit": limit,
                       "intersects": {"type": "Point", "coordinates": [lon, lat]}})
    r = subprocess.run(["curl", "-sSf", "--retry", "3", "-H", "Content-Type: application/json",
                        "-d", body, "-o", str(out), STAC_SEARCH], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"STAC query failed: {r.stderr}")
    _register(name, out, STAC_SEARCH, {"intersects": [lon, lat], "limit": limit},
              out.stat().st_size)
    return out


def uncovered_points(radius_m: float, picked: list[dict]) -> list[tuple[float, float]]:
    import shapely

    px, py = G.pad_xy()
    k = int(radius_m // 5000)
    out = []
    for i in range(-k, k + 1):
        for j in range(-k, k + 1):
            x, y = px + 5000.0 * i, py + 5000.0 * j
            if np.hypot(x - px, y - py) > radius_m:
                continue
            pt = shapely.Point(x, y)
            if not any(c["poly"].contains(pt) for c in picked):
                out.append(tuple(map(float, G.lonlat_of_xy(x, y))))
    return out


def pick_ctx(radius_m: float, max_items: int = 6, min_gain: float = 0.02,
             exclude: frozenset = frozenset()) -> list[dict]:
    """Greedy cover of the pad disc of ``radius_m`` by STAC footprints (1 km sample grid)."""
    import shapely

    px, py = G.pad_xy()
    k = int(radius_m // 1000)
    xs, ys = np.meshgrid(np.arange(-k, k + 1) * 1000.0 + px, np.arange(-k, k + 1) * 1000.0 + py)
    keep = np.hypot(xs - px, ys - py) <= radius_m
    pts = shapely.points(xs[keep], ys[keep])
    cands = [c for c in ctx_candidates() if c["id"] not in exclude]
    cov = {c["id"]: shapely.contains(c["poly"], pts) for c in cands}
    have = np.zeros(pts.size, bool)
    picked = []
    while len(picked) < max_items:
        best = max(cands, key=lambda c: (cov[c["id"]] & ~have).sum())
        gain = (cov[best["id"]] & ~have).mean()
        if gain < min_gain:
            break
        have |= cov[best["id"]]
        picked.append({**best, "gain": float(gain), "cum": float(have.mean())})
    return picked


def fetch_ctx(radius_m: float, exclude: frozenset = frozenset()) -> list[tuple[dict, Path]]:
    px, py = G.pad_xy()
    lon_w, lat_n = G.lonlat_of_xy(px - radius_m, py + radius_m)
    lon_e, lat_s = G.lonlat_of_xy(px + radius_m, py - radius_m)
    src = G._tr(G.geo_crs(), G.source_crs())
    xw, yn = src.transform(lon_w, lat_n)
    xe, ys = src.transform(lon_e, lat_s)
    out = []
    for c in pick_ctx(radius_m, exclude=exclude):
        name = f"ctx_{c['id']}_geoidadj_win"
        url = c["href"]
        import rasterio

        with rasterio.Env(**GDAL_ENV), rasterio.open(f"/vsicurl/{url}") as ds:
            b = ds.bounds
        win = (max(xw, b.left), min(yn, b.top), min(xe, b.right), max(ys, b.bottom))
        p = gdal_translate(name, url, G.RAW / "ctx" / f"{name}.tif", projwin=win,
                           estimate=40_000_000,
                           extra=["-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3",
                                  "-co", "TILED=YES"])
        print(f"{name}: gain {c['gain']:.3f} cum {c['cum']:.3f} "
              f"({downloaded_total() / 1e6:.0f} MB total)", flush=True)
        out.append(({k: v for k, v in c.items() if k != "poly"}, p))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["dem", "hirise", "crism", "ctx", "mola", "lrgb", "red",
                                     "status"])
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(argv)
    if a.what == "dem":
        print("rows", merged_dem_rows())
        fetch_merged_dem(a.workers)
    elif a.what == "hirise":
        fetch_hirise_dtms()
    elif a.what == "crism":
        fetch_crism()
    elif a.what == "lrgb":
        fetch_lrgb()
    elif a.what == "red":
        fetch_red()
    elif a.what == "ctx":
        fetch_ctx(ctx_radius_m())
    elif a.what == "mola":
        fetch_mola()
    idx = load_index()
    print(f"cache entries: {len(idx)}, downloaded {downloaded_total(idx) / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

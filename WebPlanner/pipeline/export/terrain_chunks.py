"""Near terrain chunks for the 3D first-person view (WS8, F20) + the shared fp3d helpers.

Writes ``fp3d/near/{i}_{j}.f32.gz`` and ``fp3d/index.json`` under ``data/interim/export/``
(contracts/README.md "3D files" and "make web sources"; contract fp3d_index.schema.json). The
layout, recorded in index.json, is identical to the M0 dummy (tools/make_dummy.py) the web view
is built against:

* Chunk grid (``chunk_grid``): square, centred on the pad (the pad sits at the centre of the middle
  chunk), ``n = 2 ceil((R - S/2) / S) + 1`` chunks of ``S = chunk_px * res_m`` metres per side, so
  it covers the planning disc of radius ``R`` (config/site.yaml ``planning_radius_m``).
  ``origin_xy_m`` is the NW corner in the analysis CRS; chunk ``(i, j)`` has ``i`` = column from
  west, ``j`` = row from north, NW corner ``(x0 + i S, y0 - j S)``.
* Pixels: ``chunk_px x chunk_px`` heights at pixel centres ``x0 + i S + (c + 0.5) res``,
  ``y0 - j S - (r + 0.5) res``; row 0 = north; little-endian float32, metres =
  stored * ``height_scale`` (1) + ``height.offset_m`` (0), rounded to ``height.quantum_m``
  (config/fp3d.yaml) so gzip works; gzip with mtime 0 (deterministic bytes).
* Only chunks touching the corridor (route buffered by ``corridor_half_width_m``) are written.
* DEM nodata inside a chunk is filled from the nearest valid pixel and counted (``filled_px``);
  a chunk with no data at all is not written (the client shows the far mesh there).

Every constant comes from config/fp3d.yaml, config/site.yaml and config/hud.yaml.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import numpy as np
from affine import Affine
from jsonschema import Draft202012Validator
from pyproj import Transformer
from scipy import ndimage

REPO = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO / "config"
CONTRACTS = REPO / "contracts"
DEFAULT_OUT = REPO / "data" / "interim" / "export"  # files land in <out>/fp3d/... (make web source)
WEB_INDEX = "fp3d/index.json"  # published path of <out>/fp3d/index.json (make web); manifest file

NEAR_DIR = "fp3d/near"
TEX_DIR = "fp3d/near_tex"
FAR_FILE = "fp3d/far.f32.gz"
FAR_TEX_FILE = "fp3d/far_tex.jpg"
RING_FILE = "fp3d/horizon_ring.json"  # written by WS3 (horizon/public/fp3d/), referenced here


@cache
def _config() -> dict[str, dict]:
    import yaml

    return {p.stem: yaml.safe_load(p.read_text(encoding="utf-8"))
            for p in sorted(CONFIG_DIR.glob("*.yaml"))}


def load_config() -> dict[str, dict]:
    """All config/*.yaml keyed by stem (do not mutate)."""
    return _config()


# ------------------------------------------------------------------------------ geography ----
PAD_JSON = REPO / "data" / "interim" / "engine" / "public" / "pad.json"


def official_pad(pad_json: str | Path = PAD_JSON) -> dict:
    """The official pad (D21, user 2026-11-14 16:14): WS2 ``pad.json``'s top-level ``pad``.

    Never ``site.yaml pad_default``, an ``alternatives`` entry or the ``proposal`` block. A
    missing file, a dummy file or one without a top-level pad is refused (no silent fallback).
    Returns {id, lon, lat, source, pad_source}."""
    p = Path(pad_json)
    doc = json.loads(p.read_text(encoding="utf-8"))  # FileNotFoundError when missing
    if doc.get("dummy"):
        raise ValueError(f"{p}: dummy pad.json refused (AGENTS rule 7)")
    d = doc.get("pad") or {}
    try:
        lon, lat = float(d["lon"]), float(d["lat"])
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError(f"{p}: no top-level pad with lon/lat (D21)") from e
    return {"id": str(d.get("id", "pad")), "lon": lon, "lat": lat,
            "source": f"WS2 {_repo_rel(p)} top-level pad (D21 official pad)",
            "pad_source": d.get("source")}


class Geo:
    """Analysis-CRS metres <-> lon/lat on the Mars 2000 sphere (config/site.yaml ``crs``).

    ``pad`` = the official pad ({lon, lat}, from :func:`official_pad`). Without it the pad is
    ``site.yaml pad_default``: only the M0 dummy tree (built on pad_default) and tests use that;
    ``make fp3d`` always passes the official pad (D21)."""

    def __init__(self, site: dict, pad: dict | None = None):
        crs = site["crs"]
        geog = f"+proj=longlat +R={crs['mars_radius_m']} +no_defs"
        self.analysis_proj = crs["analysis_proj"]
        self._fwd = Transformer.from_crs(geog, self.analysis_proj, always_xy=True)
        self._inv = Transformer.from_crs(self.analysis_proj, geog, always_xy=True)
        pad = pad if pad is not None else site["pad_default"]
        self.pad_lonlat = (float(pad["lon"]), float(pad["lat"]))
        self.pad_xy = self.xy(*self.pad_lonlat)

    def xy(self, lon, lat):
        x, y = self._fwd.transform(lon, lat)
        return (float(x), float(y)) if np.ndim(x) == 0 else (np.asarray(x), np.asarray(y))

    def lonlat(self, x, y):
        lon, lat = self._inv.transform(x, y)
        return (float(lon), float(lat)) if np.ndim(lon) == 0 else (np.asarray(lon),
                                                                      np.asarray(lat))


# ----------------------------------------------------------------------------- chunk grid ----
@dataclass(frozen=True)
class ChunkGrid:
    x0: float  # west edge, analysis CRS metres
    y0: float  # north edge
    chunk_px: int
    res_m: float
    n: int  # chunks per side

    @property
    def size_m(self) -> float:
        return self.chunk_px * self.res_m

    @property
    def extent_m(self) -> float:
        return self.n * self.size_m

    def chunk_bounds_xy(self, i: int, j: int) -> tuple[float, float, float, float]:
        """(west, south, east, north) of chunk (i, j) in metres."""
        w = self.x0 + i * self.size_m
        n = self.y0 - j * self.size_m
        return (w, n - self.size_m, w + self.size_m, n)

    def chunk_bounds_lonlat(self, i: int, j: int, geo: Geo) -> list[float]:
        w, s, e, n = self.chunk_bounds_xy(i, j)
        lw, ls = geo.lonlat(w, s)
        le, ln = geo.lonlat(e, n)
        return [round(lw, 6), round(ls, 6), round(le, 6), round(ln, 6)]

    def pixel_centres(self, i: int, j: int) -> tuple[np.ndarray, np.ndarray]:
        """x of each column and y of each row (row 0 = north) of chunk (i, j)."""
        w, _, _, n = self.chunk_bounds_xy(i, j)
        k = np.arange(self.chunk_px) + 0.5
        return w + k * self.res_m, n - k * self.res_m

    def chunk_of(self, x: float, y: float) -> tuple[int, int] | None:
        i = math.floor((x - self.x0) / self.size_m)
        j = math.floor((self.y0 - y) / self.size_m)
        if 0 <= i < self.n and 0 <= j < self.n:
            return (i, j)
        return None


def pad_centred_grid(pad_xy: tuple[float, float], planning_radius_m: float, chunk_px: int,
                     res_m: float) -> ChunkGrid:
    """Square chunk grid centred on the pad covering the planning disc (same rule as the dummy)."""
    size = chunk_px * res_m
    n = 2 * math.ceil((planning_radius_m - size / 2) / size) + 1
    return ChunkGrid(x0=pad_xy[0] - n * size / 2, y0=pad_xy[1] + n * size / 2,
                     chunk_px=int(chunk_px), res_m=float(res_m), n=n)


def snap_grid_to_lattice(grid: ChunkGrid, transform: Affine) -> ChunkGrid:
    """Move ``grid`` by less than half a pixel per axis so its pixel centres are the DEM's
    (``transform``, same resolution, north-up). The official pad (D21) is not on WS1's dem_1m
    lattice; without this every near chunk would be a half-pixel bilinear resample (smoothed)."""
    t = transform
    same_res = math.isclose(t.a, grid.res_m) and math.isclose(-t.e, grid.res_m)
    if t.b != 0 or t.d != 0 or not same_res:
        raise ValueError(f"DEM lattice {tuple(t)[:6]} is not north-up at {grid.res_m} m")
    x0 = t.c + round((grid.x0 - t.c) / t.a) * t.a
    y0 = t.f - round((t.f - grid.y0) / -t.e) * -t.e
    return ChunkGrid(x0=x0, y0=y0, chunk_px=grid.chunk_px, res_m=grid.res_m, n=grid.n)


def grid_from_config(geo: Geo, cfg: dict | None = None) -> ChunkGrid:
    cfg = cfg or load_config()
    near = cfg["fp3d"]["near"]
    return pad_centred_grid(geo.pad_xy, cfg["site"]["planning_radius_m"], near["chunk_px"],
                            near["res_m"])


# -------------------------------------------------------------------------- encode/decode ----
def encode_heights(h: np.ndarray, quantum_m: float | None) -> bytes:
    """Row-major (row 0 = north) little-endian float32, rounded to ``quantum_m``, gzipped."""
    h = np.asarray(h, dtype=np.float64)
    if h.ndim != 2:
        raise ValueError(f"heights must be 2-D, got shape {h.shape}")
    if not np.isfinite(h).all():
        raise ValueError("heights contain NaN/inf; fill nodata first")
    if quantum_m:
        h = np.round(h / quantum_m) * quantum_m
    return gzip.compress(h.astype("<f4").tobytes(), compresslevel=9, mtime=0)


def decode_heights(data: bytes, shape: tuple[int, int]) -> np.ndarray:
    """Inverse of :func:`encode_heights` (accepts gzipped or raw bytes)."""
    raw = gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
    want = 4 * shape[0] * shape[1]
    if len(raw) != want:
        raise ValueError(f"expected {want} bytes for {shape} float32, got {len(raw)}")
    return np.frombuffer(raw, dtype="<f4").reshape(shape).astype(np.float32)


# ------------------------------------------------------------------------------- sampling ----
_SNAP = 1e-9


def sample_bilinear(arr: np.ndarray, transform: Affine, x, y) -> np.ndarray:
    """Bilinear sample of a north-up raster at points (x, y), pixel-centre convention.

    Exact at pixel centres (no neighbour is touched, so a NaN neighbour does not leak). Points
    inside the raster footprint but beyond the outermost centres take the edge value; points
    outside the footprint, or whose interpolation touches a NaN, give NaN.
    """
    if transform.b != 0 or transform.d != 0 or transform.e >= 0:
        raise ValueError("north-up rasters only")
    hgt, wid = arr.shape
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    px = (x - transform.c) / transform.a
    py = (transform.f - y) / -transform.e
    inside = (px >= 0) & (px <= wid) & (py >= 0) & (py <= hgt)
    c = np.clip(px - 0.5, 0, wid - 1)
    r = np.clip(py - 0.5, 0, hgt - 1)
    c0 = np.floor(c)
    r0 = np.floor(r)
    fc = c - c0
    fr = r - r0
    up_c = fc > 1 - _SNAP
    up_r = fr > 1 - _SNAP
    c0 = np.where(up_c, c0 + 1, c0)
    r0 = np.where(up_r, r0 + 1, r0)
    fc = np.where(up_c | (fc < _SNAP), 0.0, fc)
    fr = np.where(up_r | (fr < _SNAP), 0.0, fr)
    c0 = np.minimum(c0, wid - 1).astype(np.intp)
    r0 = np.minimum(r0, hgt - 1).astype(np.intp)
    c1 = np.minimum(c0 + 1, wid - 1)
    r1 = np.minimum(r0 + 1, hgt - 1)
    out = np.zeros(np.broadcast(x, y).shape)
    for rr, cc, w in ((r0, c0, (1 - fr) * (1 - fc)), (r0, c1, (1 - fr) * fc),
                      (r1, c0, fr * (1 - fc)), (r1, c1, fr * fc)):
        out = out + np.where(w > 0, arr[rr, cc].astype(np.float64) * w, 0.0)
    return np.where(inside, out, np.nan)


def resample_mean(arr: np.ndarray, transform: Affine, x_west: float, y_north: float,
                  res_out: float, shape_out: tuple[int, int]) -> np.ndarray:
    """Area mean of a raster over output cells (supersampled bilinear; exact block mean when the
    output grid is aligned with the source and ``res_out`` is a multiple of its pixel). A cell is
    NaN unless all its subsamples are valid."""
    k = max(1, math.ceil(res_out / abs(transform.a) - 1e-9))
    sub = (np.arange(k) + 0.5) * (res_out / k)
    rows, cols = shape_out
    out = np.empty(shape_out)
    xs = (x_west + np.arange(cols)[:, None] * res_out + sub[None, :]).ravel()
    # strips of output rows bound the memory (cols * k * k * strip samples)
    strip = max(1, int(4_000_000 // max(1, cols * k * k)))
    for r0 in range(0, rows, strip):
        r1 = min(rows, r0 + strip)
        ys = (y_north - np.arange(r0, r1)[:, None] * res_out - sub[None, :]).ravel()
        xx, yy = np.meshgrid(xs, ys)
        v = sample_bilinear(arr, transform, xx, yy)
        out[r0:r1] = v.reshape(r1 - r0, k, cols, k).mean(axis=(1, 3))
    return out


def fill_nodata(h: np.ndarray) -> tuple[np.ndarray, int]:
    """Fill NaN cells from the nearest valid cell; returns (filled copy, number filled)."""
    bad = ~np.isfinite(h)
    n = int(bad.sum())
    if n == 0:
        return np.array(h, dtype=np.float64), 0
    if n == h.size:
        raise ValueError("no valid data to fill from")
    idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
    return np.asarray(h, dtype=np.float64)[tuple(idx)], n


# ------------------------------------------------------------------------------- corridor ----
def route_lines_xy(fc: dict, geo: Geo) -> list[np.ndarray]:
    """LineStrings of a route FeatureCollection (lon/lat) as (N, 2) arrays in analysis metres."""
    lines = []
    for feat in fc["features"]:
        g = feat["geometry"]
        parts = [g["coordinates"]] if g["type"] == "LineString" else (
            g["coordinates"] if g["type"] == "MultiLineString" else [])
        for part in parts:
            if len(part) < 2:
                continue
            lon, lat = np.asarray(part, dtype=np.float64).T[:2]
            x, y = geo.xy(lon, lat)
            lines.append(np.column_stack([x, y]))
    return lines


def corridor_chunks(grid: ChunkGrid, lines: list[np.ndarray], half_width_m: float,
                    points: list[tuple[float, float]] | None = None) -> list[tuple[int, int]]:
    """Chunks (i, j) whose square touches the route (plus optional points, e.g. the stations)
    buffered by ``half_width_m``; j-major order."""
    from shapely.geometry import LineString, MultiLineString, MultiPoint, box

    geom = MultiLineString([LineString(ln) for ln in lines if len(ln) >= 2])
    if geom.is_empty:
        raise ValueError("route has no line geometry: no corridor")
    if points:
        geom = geom.union(MultiPoint([tuple(p) for p in points]))
    corridor = geom.buffer(half_width_m)
    out = []
    for j in range(grid.n):
        for i in range(grid.n):
            if corridor.intersects(box(*grid.chunk_bounds_xy(i, j))):
                out.append((i, j))
    return out


# ---------------------------------------------------------------------------- near export ----
def chunk_heights(dem: np.ndarray, transform: Affine, grid: ChunkGrid, i: int, j: int
                  ) -> np.ndarray:
    xs, ys = grid.pixel_centres(i, j)
    xx, yy = np.meshgrid(xs, ys)
    return sample_bilinear(dem, transform, xx, yy)


def export_near(dem: np.ndarray, transform: Affine, grid: ChunkGrid,
                chunks: list[tuple[int, int]], out_dir: Path, quantum_m: float) -> list[dict]:
    """Write ``<out_dir>/fp3d/near/{i}_{j}.f32.gz`` for each chunk; returns index entries."""
    out_dir = Path(out_dir)
    (out_dir / NEAR_DIR).mkdir(parents=True, exist_ok=True)
    entries = []
    for i, j in chunks:
        h = chunk_heights(dem, transform, grid, i, j)
        try:
            h, filled = fill_nodata(h)
        except ValueError:
            continue  # no DEM here at all: the client shows the far mesh
        rel = f"{NEAR_DIR}/{i}_{j}.f32.gz"
        data = encode_heights(h, quantum_m)
        (out_dir / rel).write_bytes(data)
        entries.append({"i": i, "j": j, "file": rel, "bytes": len(data), "filled_px": filled})
    return entries


def prune_stale_chunks(out_dir: Path, idx: dict) -> list[str]:
    """Delete near/near_tex files under ``<out_dir>/fp3d`` that ``idx`` does not list (make web
    copies those directories by glob). Returns the removed paths, relative to ``out_dir``."""
    out_dir = Path(out_dir)
    keep = set()
    for ch in idx["chunk_grid"]["chunks"]:
        keep.add(ch["file"])
        if ch.get("tex"):
            keep.add(ch["tex"])
    removed = []
    for d in (NEAR_DIR, TEX_DIR):
        if not (out_dir / d).is_dir():
            continue
        for f in sorted((out_dir / d).iterdir()):
            rel = f"{d}/{f.name}"
            if f.is_file() and rel not in keep:
                f.unlink()
                removed.append(rel)
    return removed


# ---------------------------------------------------------------------------------- index ----
@cache
def _index_validator() -> Draft202012Validator:
    return Draft202012Validator(json.loads((CONTRACTS / "fp3d_index.schema.json").read_text()))


def validate_index(idx: dict) -> None:
    _index_validator().validate(idx)


def build_index(grid: ChunkGrid, geo: Geo, near: list[dict], tex: list[dict], far: dict, *,
                quantum_m: float, datum: str, eye_height_m: float, sources: dict,
                ring_file: str | None = RING_FILE, skyline_check: dict | None = None,
                texture_note: str | None = None, pad: dict | None = None,
                station_rings: dict | None = None) -> dict:
    """fp3d/index.json (real data: ``dummy`` false), same shape as the M0 dummy index.
    ``pad`` = the pad the grids are centred on (:func:`official_pad`), recorded as ``pad``."""
    tex_by = {(t["i"], t["j"]): t for t in tex}
    chunks = []
    for e in near:
        ch = {"i": e["i"], "j": e["j"], "file": e["file"]}
        t = tex_by.get((e["i"], e["j"]))
        if t is not None:
            ch["tex"] = t["tex"]
        ch["bounds"] = grid.chunk_bounds_lonlat(e["i"], e["j"], geo)
        ch["bytes"] = e["bytes"]
        if t is not None:
            ch["tex_bytes"] = t["bytes"]
            ch["tex_nodata_px"] = t.get("nodata_px", 0)
        ch["filled_px"] = e["filled_px"]
        chunks.append(ch)
    fw, fs = geo.lonlat(grid.x0, grid.y0 - grid.extent_m)
    fe, fn = geo.lonlat(grid.x0 + grid.extent_m, grid.y0)
    bounds = [round(fw, 6), round(fs, 6), round(fe, 6), round(fn, 6)]
    total = (sum(c["bytes"] + c.get("tex_bytes", 0) for c in chunks) + far.get("bytes", 0)
             + far.get("tex_bytes", 0))
    far = dict(far)
    if "origin_xy_m" in far and "width" in far:
        fx0, fy0 = far["origin_xy_m"]
        ext = far["width"] * far["res_m"]
        a = geo.lonlat(fx0, fy0 - ext)
        b = geo.lonlat(fx0 + ext, fy0)
        far["bounds"] = [round(a[0], 6), round(a[1], 6), round(b[0], 6), round(b[1], 6)]
    else:
        far["bounds"] = bounds
    idx = {
        "dummy": False,
        "bounds": bounds,
        "chunk_grid": {
            "cols": grid.n, "rows": grid.n, "chunk_px": grid.chunk_px, "res_m": grid.res_m,
            "index": "i = column from west, j = row from north",
            "origin_xy_m": [round(grid.x0, 3), round(grid.y0, 3)],
            "crs": geo.analysis_proj,
            "chunks": chunks,
        },
        "height_scale": 1.0,
        "height": {"dtype": "float32", "byte_order": "little", "row_order": "north_to_south",
                   "sample": "cell centres", "offset_m": 0.0, "units": "m",
                   "quantum_m": quantum_m, "datum": datum,
                   "nodata": "filled from the nearest valid pixel (count per chunk: filled_px)"},
        "far": far,
        "texture": texture_note or "HiRISE ortho JPEG per near chunk",
        "eye_height_m": eye_height_m,
        "sources": sources,
        "download_bytes": int(total),
    }
    if ring_file:
        idx["horizon_ring"] = ring_file
    if skyline_check is not None:
        idx["skyline_check"] = skyline_check
    if pad is not None:
        idx["pad"] = pad
    if station_rings is not None:
        idx["station_rings"] = station_rings
    validate_index(idx)
    return idx


# ---------------------------------------------------------------------- skyline check ----
NO_ACCESS_REASON = ("no access cell in WS2 stations.json: not on the route, the camera never "
                    "stands there (C decision 2026-11-14 12:35)")


def skyline_exclusions(stations: list[dict]) -> dict[str, str]:
    """Stations reported but outside the F20 pass rule (C 12:35: the rule covers the pad and the
    route stations): those WS2 gives no access cell (``access_lon`` present and null)."""
    return {s["id"]: NO_ACCESS_REASON for s in stations
            if "access_lon" in s and s["access_lon"] is None}


def skyline_reference(profiles: list, geo: Geo, cfg: dict | None = None, *, source: str,
                      excluded: dict[str, str] | None = None) -> dict:
    """fp3d/index.json ``skyline_check``: the computed horizon (WS3 HorizonProfile) at each
    station, resampled to ``fp3d.skyline_check.az_step_deg``, for the SPEC F20 acceptance check
    (rendered skyline within ``tolerance_deg``). ``profiles`` = [(station_id, HorizonProfile)].
    Unknown elevations stay null. ``excluded`` = {id: reason} for stations reported but not in
    the pass rule (``pass_rule`` false)."""
    excluded = excluded or {}
    cfg = load_config() if cfg is None else cfg
    chk = cfg["fp3d"]["skyline_check"]
    step = float(chk["az_step_deg"])
    az = np.arange(int(round(360.0 / step))) * step
    stations = []
    for sid, prof in profiles:
        x, y = float(prof.observer["x"]), float(prof.observer["y"])
        lon, lat = geo.lonlat(x, y)
        el = np.asarray(prof.elevation_at(az), dtype=float)
        stations.append({
            "id": sid, "lon": round(lon, 6), "lat": round(lat, 6),
            "x_m": round(x, 3), "y_m": round(y, 3),
            "eye_height_m": float(prof.eye_height_m),
            "elevation_deg": [None if not np.isfinite(v) else round(float(v), 4) for v in el],
            "pass_rule": sid not in excluded,
            **({"excluded_reason": excluded[sid]} if sid in excluded else {}),
        })
    return {
        "source": source,
        "tolerance_deg": chk["tolerance_deg"],
        "az_step_deg": step,
        "azimuth_convention": "deg clockwise from grid north (analysis CRS); index k = k * step",
        "curvature": "drop = d^2 / (2 R), R = config/site.yaml crs.mars_radius_m",
        "stations": stations,
        "pass_rule_note": "pass_rule true = in the F20 pass rule (pad and route stations, "
                          "C 12:35); false = reported only (excluded_reason)",
    }


def check_pad_observer(profiles: list, geo: Geo) -> None:
    """Refuse a WS3 ``pad`` horizon whose observer is not the official pad ``geo`` is centred on
    (compared at pad.json's 6-decimal precision): a stale pad horizon is never compared."""
    for sid, prof in profiles:
        if sid != "pad":
            continue
        lon, lat = geo.lonlat(float(prof.observer["x"]), float(prof.observer["y"]))
        if (round(lon, 6), round(lat, 6)) != (round(geo.pad_lonlat[0], 6),
                                              round(geo.pad_lonlat[1], 6)):
            raise ValueError(f"WS3 pad horizon observer ({lon:.6f}, {lat:.6f}) is not the "
                             f"official pad {geo.pad_lonlat} (D21): re-run make horizons")


def station_rings(profiles: list, square: dict, radius_m: float, *, source: str) -> dict:
    """fp3d/index.json ``station_rings`` (F20 "the computed horizon as a far-skyline ring"):
    WS3's ring (horizon_ring.json) holds the pad's far skyline only. For each station's WS3
    horizon (not the pad), the horizon points beyond the far-mesh ``square`` ({west, north,
    size}, analysis CRS m) are placed at their true position, z = z_eye + d tan(el) + d^2/2R
    (WS3 ring_doc's formula), in the viewer's ring format (dist_m/z_m per azimuth, observer x/y).
    Points inside the square or unknown stay null: the mesh draws those."""
    rings = []
    w, n, size = float(square["west"]), float(square["north"]), float(square["size"])
    for sid, prof in profiles:
        if sid == "pad":
            continue
        ox, oy = float(prof.observer["x"]), float(prof.observer["y"])
        z_eye = float(prof.observer["z"])
        a = np.radians(np.asarray(prof.az_deg, dtype=float))
        d = np.asarray(prof.distance_m, dtype=float)
        el = np.asarray(prof.elevation_deg, dtype=float)
        with np.errstate(invalid="ignore"):
            x, y = ox + d * np.sin(a), oy + d * np.cos(a)
            inside = (x >= w) & (x <= w + size) & (y <= n) & (y >= n - size)
            ok = np.isfinite(d) & np.isfinite(el) & (d > 0) & ~inside
            z = z_eye + d * np.tan(np.radians(el)) + d * d / (2.0 * radius_m)
        rings.append({
            "id": sid, "observer": {"x": round(ox, 3), "y": round(oy, 3)},
            "az_step_deg": float(prof.az_step_deg),
            "elev_deg": [round(float(v), 4) if k else None for v, k in zip(el, ok, strict=True)],
            "dist_m": [round(float(v), 1) if k else None for v, k in zip(d, ok, strict=True)],
            "z_m": [round(float(v), 2) if k else None for v, k in zip(z, ok, strict=True)],
        })
    return {
        "source": source,
        "note": "per station: WS3 horizon points beyond the far-mesh square at their true "
                "position (z = z_eye + d tan(el) + d^2/2R, R = config/site.yaml "
                "crs.mars_radius_m); null = inside the square (drawn by the mesh) or unknown. "
                "Drawn as extra far-skyline curtains next to WS3's pad ring",
        "rings": rings,
    }


def read_station_horizons(horizon_dir: Path, ids: list[str]) -> list:
    """WS3 ``horizons/{id}.json`` (HorizonProfile.write_json) for the ids that exist."""
    from pipeline.horizon.rays import HorizonProfile

    out = []
    for sid in ids:
        p = Path(horizon_dir) / f"{sid}.json"
        if p.exists():
            out.append((sid, HorizonProfile.read_json(p)))
    return out


# ------------------------------------------------------------------------------------ CLI ----
def _read_raster(path: Path):
    import rasterio

    with rasterio.open(path) as ds:
        arr = ds.read(1, masked=True).astype(np.float32).filled(np.nan)
        return arr, ds.transform


def record_manifest(*, download_bytes: int, near_chunks: int, near_res_m: float,
                    far_res_m: float, far_extent_m: float, corridor_half_width_m: float,
                    fragment_dir: str | Path | None = None) -> float:
    """Record the fp3d.* numbers shown in the app, citing the web path ``fp3d/index.json``
    (make web publishes data/interim/export/fp3d/index.json there and drops entries that cite
    the interim source). Returns the download size in MB."""
    from pipeline.provenance.manifest import record

    mb = round(download_bytes / 1e6, 2)
    rows = {"fp3d.download_mb": (mb, "MB"),
            "fp3d.near_chunks": (near_chunks, None),
            "fp3d.near_res_m": (near_res_m, "m"),
            "fp3d.far_res_m": (far_res_m, "m"),
            "fp3d.far_extent_m": (round(far_extent_m, 1), "m"),
            "fp3d.corridor_half_width_m": (corridor_half_width_m, "m")}
    for key, (value, units) in rows.items():
        record(key, value, units, WEB_INDEX, __file__, fragment_dir=fragment_dir)
    return mb


def _repo_rel(p) -> str:
    """Path relative to the repo (``data/`` is a symlink, so no resolve())."""
    a = Path(p).absolute()
    return str(a.relative_to(REPO)) if a.is_relative_to(REPO) else str(p)


def default_far_sources(cfg: dict | None = None) -> list[Path]:
    """Far-mesh sources after dem_1m, in priority order: the canonical bands of
    config/horizon.yaml ``bands`` (ctx_20m, then mola_hrsc_200m), the ones WS3's horizon engine
    reads (C decisions 11:15 and 14:13)."""
    cfg = load_config() if cfg is None else cfg
    bands = cfg["horizon"]["bands"]
    return [REPO / bands["ctx_20m"]["path"], REPO / bands["mola_hrsc_200m"]["path"]]


def main(argv: list[str] | None = None) -> int:
    """Export near chunks, far mesh, ortho textures and fp3d/index.json."""
    from pipeline.export import far_mesh, ortho_chunks

    terrain = REPO / "data" / "interim" / "terrain"
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dem-1m", type=Path, default=terrain / "dem_1m.tif",
                    help="WS1 dem_1m.tif (analysis CRS)")
    ap.add_argument("--route", type=Path,
                    default=REPO / "data/interim/engine/public/route_nom_104.geojson",
                    help="WS2 route_{scenario}.geojson (the corridor)")
    ap.add_argument("--far-source", type=Path, action="append",
                    help="coarser DEMs for the far mesh, in priority order (default: the "
                         "canonical bands of config/horizon.yaml, ctx_20m then mola_hrsc_200m)")
    ap.add_argument("--ortho", type=Path, default=terrain / "ortho_lrgb_1m.tif",
                    help="WS1 colour ortho (RGB + alpha)")
    ap.add_argument("--datum", default="areoid heights of WS1 dem_1m.tif (m)",
                    help="height datum of the DEM, for index.json")
    ap.add_argument("--station-horizons", type=Path,
                    default=REPO / "data/interim/horizon/horizons",
                    help="WS3 horizons/ dir ({id}.json) for the F20 skyline check")
    ap.add_argument("--stations", type=Path,
                    default=REPO / "data/interim/engine/public/stations.json",
                    help="stations.json (ids for --station-horizons)")
    ap.add_argument("--pad-json", type=Path, default=PAD_JSON,
                    help="WS2 pad.json: its top-level pad is the official pad (D21)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    cfg = load_config()
    far_sources_p = args.far_source or default_far_sources(cfg)
    f3 = cfg["fp3d"]
    pad = official_pad(args.pad_json)
    geo = Geo(cfg["site"], pad=pad)
    dem, tr = _read_raster(args.dem_1m)
    grid = snap_grid_to_lattice(grid_from_config(geo, cfg), tr)
    q = f3["height"]["quantum_m"]
    fc = json.loads(args.route.read_text())
    if fc.get("dummy") or fc.get("synthetic"):
        raise SystemExit(f"{args.route}: dummy/synthetic route refused (AGENTS rule 7)")
    lines = route_lines_xy(fc, geo)
    stations = json.loads(args.stations.read_text()) if args.stations.exists() else []
    # every station (visited or not) gets 1 m terrain around it: the F20 skyline check is "at each
    # station", and the station cards link to the 3D view
    st_xy = [geo.xy(s["lon"], s["lat"]) for s in stations]
    chunks = corridor_chunks(grid, lines, f3["near"]["corridor_half_width_m"], st_xy)

    near = export_near(dem, tr, grid, chunks, args.out, q)
    far_sources = [(dem, tr)] + [_read_raster(p) for p in far_sources_p]
    fgrid = far_mesh.far_grid(grid, f3["far"].get("half_extent_m"))
    far = far_mesh.export_far(far_sources, fgrid, f3["far"]["res_m"], args.out, q,
                              source_names=[_repo_rel(args.dem_1m)]
                              + [_repo_rel(p) for p in far_sources_p])
    del dem, far_sources
    ground = cfg["horizon"]["panorama"]["ground_rgb"]
    ftex = f3["far"].get("texture")
    if ftex:
        far.update(ortho_chunks.export_far_texture_from_file(
            args.ortho, fgrid, args.out, res_m=ftex["res_m"], quality=ftex["jpeg_quality"],
            nodata_rgb=ground))
    tex = ortho_chunks.export_textures_from_file(
        args.ortho, grid, [(e["i"], e["j"]) for e in near], args.out,
        tex_px=f3["texture"]["chunk_px"], quality=f3["texture"]["jpeg_quality"],
        nodata_rgb=ground)
    rel = _repo_rel
    sources = {"dem": rel(args.dem_1m),
               "far": [rel(args.dem_1m)] + [rel(p) for p in far_sources_p],
               "ortho": rel(args.ortho), "route": rel(args.route),
               "pad": rel(args.pad_json)}
    check = None
    ids = ["pad"] + [s["id"] for s in stations]
    profs = read_station_horizons(args.station_horizons, ids)
    check_pad_observer(profs, geo)
    rings = None
    if profs:
        check = skyline_reference(profs, geo, cfg,
                                  source=f"WS3 horizon engine, {rel(args.station_horizons)}",
                                  excluded=skyline_exclusions(stations))
        fx0, fy0 = far["origin_xy_m"]
        rings = station_rings(
            profs, {"west": fx0, "north": fy0, "size": far["width"] * far["res_m"]},
            cfg["site"]["crs"]["mars_radius_m"],
            source=f"WS3 horizon engine, {rel(args.station_horizons)}")
    idx = build_index(
        grid, geo, near, tex, far, quantum_m=q, datum=args.datum,
        eye_height_m=cfg["hud"]["eye_height_m"], sources=sources, skyline_check=check,
        texture_note="WS1 HiRISE LRGB ortho (colour, greyscale where the mosaic is greyscale), "
                     "JPEG per near chunk; no-ortho texels = horizon.yaml panorama.ground_rgb",
        pad=pad, station_rings=rings)
    out_index = args.out / "fp3d" / "index.json"
    out_index.write_text(json.dumps(idx, indent=1) + "\n", encoding="utf-8")
    stale = prune_stale_chunks(args.out, idx)
    if stale:
        print(f"fp3d: removed {len(stale)} chunk files of an earlier grid")

    mb = record_manifest(download_bytes=idx["download_bytes"], near_chunks=len(near),
                         near_res_m=grid.res_m, far_res_m=f3["far"]["res_m"],
                         far_extent_m=fgrid.extent_m,
                         corridor_half_width_m=f3["near"]["corridor_half_width_m"])
    print(f"fp3d: {len(near)} near chunks, {len(tex)} textures, far {far['width']}x{far['height']}"
          f", {mb:.1f} MB -> {args.out / 'fp3d'}; skyline check stations: "
          f"{[s['id'] for s in check['stations']] if check else 'none'}")
    budget = cfg["hud"]["performance"]["budget_3d_mb"]
    if idx["download_bytes"] / 1e6 > budget:
        print(f"WARNING: 3D download exceeds the {budget} MB budget (config/hud.yaml)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

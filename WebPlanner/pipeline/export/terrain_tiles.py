"""Elevation tiles for the 3D planning map -> ``terrain/{z}/{x}/{y}.png`` + ``terrain/tiles.json``
(DESIGN §6.1, §2.2 U1, budget §5.4; contract ``contracts/terrain_tiles.schema.json`` v1; WS16).

Tiles: 256 px RGB PNG, MapLibre ``raster-dem`` Terrarium encoding
``h = (R * 256 + G + B / 256) - 32768`` m, with ``h = true elevation * factor + vertical_offset_m``.
``factor`` = ``config/design.yaml scale.elevation_factor`` (Earth / Mars radius = 1.878): Mars
lon/lat go straight into MapLibre's Earth-sized Web Mercator (D4), which stretches horizontal
ground metres by that ratio, so the heights are stretched by the same ratio here and terrain
exaggeration 1 on screen is true shape. ``vertical_offset_m`` = ``terrain_tiles.vertical_offset_m``
(P2c): a constant added after scaling so the official pad sits near 0 m on the map (with the
ground at ~-7000 m MapLibre 6.18 selects no tiles at pitch above ~62 deg and the map renders
black). A constant shift leaves the shape (and exaggeration about it) unchanged. True elevation
= (h - vertical_offset_m) / factor; elevation readouts never come from these tiles.

Tile scheme: XYZ (top-left origin) WebMercatorQuad with Mars planetocentric lon/lat passed through
as if they were Earth lon/lat: the scheme of the WS1 HiRISE basemap
(``pipeline/terrain/build.py step_ortho``, ``tiles/basemap/tilejson.json``), so the relief registers
with the basemap. Each tile pixel is the elevation at the pixel *centre* (pixel-is-area, as the
basemap tiles written by ``gdal raster tile``).

Zooms / extents (config): ``terrain_tiles.zooms_planning_extent`` (z10-15) over the planning
extent = pad +/- ``site.yaml planning_radius_m`` (route / fields grid, pipeline/terrain/grid.py),
``zooms_focus_area`` (z16) over ``site.yaml aoi_focus`` only. ``tiles.json bounds`` /
``focus.bounds`` are those two lon/lat boxes; every tile intersecting them is written.

Sources, finest first (``config/horizon.yaml bands``: the canonical DEM stack, C decisions
11:15 and 14:13): the 1 m merged DEM ``dem_1m.tif``, then the 20 m CTX ``ctx_20m_v2.tif`` (each
item co-registered to dem_1m), then MOLA-HRSC 200 m. Each output pixel takes the finest source
with data there. A source finer than the tile pixel is first block-averaged by
``k = floor(pixel_m / source_res)`` (no aliasing), then sampled bilinearly at the pixel centre;
a pixel whose 2 x 2 neighbourhood touches no-data falls through to the next source. A pixel no
source covers is an error (never filled) unless the caller asks for edge extension of the last
source (relief_lowzoom.py only; counted and recorded).

``tiles.json`` lists only the sources that supplied pixels; ``source_hash`` = sha256 over those
files in that order. Size vs budget (``terrain_tiles.budget_mb``, MiB): the scaled heights are
rounded to the finest power-of-two step, starting at Terrarium's own 1/256 m, whose PNGs fit
the budget (``precision_m`` in tiles.json, scaled metres; true step = precision_m / factor). If
even a step of ``terrain_tiles.height_step_cap_m.terrain`` true metres doesn't fit: error,
nothing is left behind.
Output is deterministic (no timestamps; Pillow PNG with fixed options), and a re-run with
unchanged sources, config and code is skipped.

Usage: ``python -m pipeline.export.terrain_tiles`` writes data/interim/export/terrain/ (copied to
web/public/data/terrain/ by ``make web``) and records ``terrain_tiles.factor``,
``.vertical_offset_m``, ``.source_hash``, ``.total_bytes`` in the manifest. ``--force`` rebuilds
even if unchanged.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import shutil
import sys
import warnings
from collections.abc import Callable, Sequence
from functools import cache
from pathlib import Path

import numpy as np
import yaml

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

CONFIG = REPO / "config"
EXPORT = REPO / "data" / "interim" / "export"
OUT = EXPORT / "terrain"
NAME = "terrain"
MIB = 2 ** 20
TERRARIUM_OFFSET = 32768.0  # Terrarium encoding constant (MapLibre), not a tunable
MAX_LAT = 85.0511287798066  # Web Mercator limit
BUILD_KEY = ".build_key"  # sidecar in the interim output dir (not published)
ATTRIBUTION = ("Elevation: USGS Astrogeology MSL Gale merged DEM 1 m v3 (HiRISE/CTX/HRSC on "
               "MOLA), USGS controlled CTX DTMs, HRSC-MOLA blended DEM 200 m v2")


class BudgetError(RuntimeError):
    """The tile set is larger than its budget (DESIGN §5.4)."""


class CoverageError(RuntimeError):
    """A tile pixel has no elevation in any source."""


# ----------------------------------------------------------------------------------- config


@cache
def _yaml(name: str) -> dict:
    return yaml.safe_load((CONFIG / name).read_text())


def mars_radius_m() -> float:
    return float(_yaml("site.yaml")["crs"]["mars_radius_m"])


def analysis_crs() -> str:
    return _yaml("site.yaml")["crs"]["analysis_proj"]


def geo_crs() -> str:
    return f"+proj=longlat +R={mars_radius_m()} +no_defs"


@cache
def _transformer(src: str, dst: str):
    from pyproj import Transformer

    return Transformer.from_crs(src, dst, always_xy=True)


def xy_of_lonlat(lon, lat):
    x, y = _transformer(geo_crs(), analysis_crs()).transform(np.asarray(lon, float),
                                                              np.asarray(lat, float))
    return np.asarray(x), np.asarray(y)


def lonlat_of_xy(x, y):
    lon, lat = _transformer(analysis_crs(), geo_crs()).transform(np.asarray(x, float),
                                                                  np.asarray(y, float))
    return np.asarray(lon), np.asarray(lat)


def planning_bounds() -> list[float]:
    """[w, s, e, n] lon/lat of the planning extent: pad +/- planning_radius_m (analysis CRS)."""
    s = _yaml("site.yaml")
    r = float(s["planning_radius_m"])
    px, py = xy_of_lonlat(s["pad_default"]["lon"], s["pad_default"]["lat"])
    lon, lat = lonlat_of_xy(float(px) + np.array([-r, r, r, -r]),
                            float(py) + np.array([-r, -r, r, r]))
    return outward([lon.min(), lat.min(), lon.max(), lat.max()])


def outward(b: Sequence[float], nd: int = 6) -> list[float]:
    """[w, s, e, n] rounded to ``nd`` decimals away from the box centre (still covers it)."""
    f = 10.0 ** nd
    return [math.floor(b[0] * f) / f, math.floor(b[1] * f) / f, math.ceil(b[2] * f) / f,
            math.ceil(b[3] * f) / f]


def band_paths(*names: str) -> list[Path]:
    """Canonical DEM band files (config/horizon.yaml bands.<name>.path)."""
    bands = _yaml("horizon.yaml")["bands"]
    return [REPO / bands[n]["path"] for n in names]


def load_config() -> dict:
    d = _yaml("design.yaml")
    tt = d["terrain_tiles"]
    f = _yaml("site.yaml")["aoi_focus"]
    if tt["encoding"] != "terrarium":
        raise ValueError(f"terrain_tiles.encoding {tt['encoding']!r}: only terrarium is written")
    return {"name": NAME, "factor": float(d["scale"]["elevation_factor"]),
            "tile_px": int(tt["tile_px"]),
            "zooms": tuple(int(z) for z in tt["zooms_planning_extent"]),
            "focus_zooms": tuple(int(z) for z in tt["zooms_focus_area"]),
            "bounds": planning_bounds(),
            "focus_bounds": [f["west"], f["south"], f["east"], f["north"]],
            "budget_bytes": int(round(float(tt["budget_mb"]) * MIB)),
            # coarsest height step, m of TRUE elevation (the brief's +-0.1 m pad tolerance)
            "max_step_true_m": float(tt["height_step_cap_m"]["terrain"]),
            "vertical_offset_m": float(tt["vertical_offset_m"]),
            "sources": band_paths("dem_1m", "ctx_20m", "mola_hrsc_200m")}


# ------------------------------------------------------------------------------- tile maths


def lonlat_to_tile(lon, lat, z: int):
    """Fractional XYZ tile coordinates (Web Mercator; Mars lon/lat passed through, D4)."""
    n = 2.0 ** z
    lat = np.clip(np.asarray(lat, float), -MAX_LAT, MAX_LAT)
    x = (np.asarray(lon, float) + 180.0) / 360.0 * n
    y = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2.0 * n
    if np.ndim(x) == 0:
        return float(x), float(y)
    return x, y


def _tile_lat(yf, z: int):
    return np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * np.asarray(yf, float) / 2.0 ** z))))


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    n = 2.0 ** z
    return (x / n * 360.0 - 180.0, float(_tile_lat(y + 1, z)), (x + 1) / n * 360.0 - 180.0,
            float(_tile_lat(y, z)))


def tiles_covering(bounds: Sequence[float], z: int) -> list[tuple[int, int]]:
    """Every (x, y) tile at zoom z intersecting [w, s, e, n], sorted."""
    w, s, e, n = bounds
    x0, y0 = lonlat_to_tile(w, n, z)
    x1, y1 = lonlat_to_tile(e, s, z)
    lim = 2 ** z - 1
    xs = range(max(0, math.floor(x0)), min(lim, math.ceil(x1) - 1) + 1)
    ys = range(max(0, math.floor(y0)), min(lim, math.ceil(y1) - 1) + 1)
    return [(x, y) for x in xs for y in ys]


def union_bounds(boxes) -> list[float]:
    b = np.asarray(list(boxes), float)
    return [float(b[:, 0].min()), float(b[:, 1].min()), float(b[:, 2].max()), float(b[:, 3].max())]


def pixel_lonlat(z: int, x: int, y: int, px: int):
    """(lon, lat) arrays (px, px) of the pixel centres of tile z/x/y (row = north to south)."""
    f = (np.arange(px) + 0.5) / px
    lon = (x + f) / 2.0 ** z * 360.0 - 180.0
    lat = _tile_lat(y + f, z)
    return np.broadcast_to(lon[None, :], (px, px)), np.broadcast_to(lat[:, None], (px, px))


def pixel_m(z: int, lat: float, px: int) -> float:
    """Mars ground metres per tile pixel at zoom z and latitude lat."""
    return 2 * math.pi * mars_radius_m() * math.cos(math.radians(lat)) / (px * 2.0 ** z)


# --------------------------------------------------------------------------------- encoding


def encode_terrarium(h) -> np.ndarray:
    """Heights (m, already scaled) -> uint8 RGB, rounded to 1/256 m."""
    q = np.rint((np.asarray(h, float) + TERRARIUM_OFFSET) * 256.0)
    q = np.clip(q, 0, 2 ** 24 - 1).astype(np.int64)
    return np.stack([(q >> 16) & 255, (q >> 8) & 255, q & 255], axis=-1).astype(np.uint8)


def decode_terrarium(rgb) -> np.ndarray:
    a = np.asarray(rgb)[..., :3].astype(float)
    return a[..., 0] * 256.0 + a[..., 1] + a[..., 2] / 256.0 - TERRARIUM_OFFSET


def encode_png(rgb: np.ndarray) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(rgb), "RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------------- sources


class Source:
    """One elevation raster, sampled bilinearly at lon/lat, block-averaged per pixel size."""

    def __init__(self, path: Path, *, clamp: bool = False):
        import rasterio

        self.path = Path(path)
        with rasterio.open(self.path) as d:
            z = d.read(1).astype("float32")
            if d.nodata is not None and not math.isnan(d.nodata):
                z[z == d.nodata] = np.nan
            t = d.transform
            if t.b != 0 or t.d != 0 or t.e >= 0:
                raise ValueError(f"{path}: only north-up rasters are supported")
            self.x0, self.y0, self.res = t.c, t.f, t.a
            self.crs = d.crs.to_wkt()
        self.clamp = clamp
        self._levels: dict[int, np.ndarray] = {1: z}

    @property
    def rel(self) -> str:
        try:
            return self.path.relative_to(REPO).as_posix()
        except ValueError:
            return str(self.path)

    def level(self, k: int) -> np.ndarray:
        if k not in self._levels:
            z = self._levels[1]
            h, w = (z.shape[0] // k) * k, (z.shape[1] // k) * k
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN blocks stay NaN
                self._levels[k] = np.nanmean(z[:h, :w].reshape(h // k, k, w // k, k),
                                             axis=(1, 3)).astype("float32")
        return self._levels[k]

    def sample(self, lon, lat, px_m: float):
        """(values, edge) at lon/lat; NaN where no data. ``edge`` marks clamped samples."""
        k = max(1, int(math.floor(px_m / self.res)))
        z = self.level(k)
        res = self.res * k
        x, y = _transformer(geo_crs(), self.crs).transform(np.asarray(lon, float),
                                                            np.asarray(lat, float))
        c = (np.asarray(x) - self.x0) / res - 0.5
        r = (self.y0 - np.asarray(y)) / res - 0.5
        h, w = z.shape
        edge = np.zeros(c.shape, bool)
        if self.clamp:
            edge = (c < 0) | (c > w - 1) | (r < 0) | (r > h - 1)
            c, r = np.clip(c, 0, w - 1), np.clip(r, 0, h - 1)
        c0 = np.floor(c).astype(np.int64)
        r0 = np.floor(r).astype(np.int64)
        c0 = np.where(c0 == w - 1, w - 2, c0)  # exactly on the last centre
        r0 = np.where(r0 == h - 1, h - 2, r0)
        ok = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < w) & (r0 + 1 < h)
        cc, rr = np.where(ok, c0, 0), np.where(ok, r0, 0)
        fc, fr = c - cc, r - rr
        v = (z[rr, cc] * (1 - fr) * (1 - fc) + z[rr, cc + 1] * (1 - fr) * fc
             + z[rr + 1, cc] * fr * (1 - fc) + z[rr + 1, cc + 1] * fr * fc)
        return np.where(ok, v, np.nan), edge & ok

    def lonlat_footprint(self) -> list[float]:
        """[w, s, e, n] lon/lat of the raster's extent (corners and edge midpoints)."""
        z = self._levels[1]
        xs = self.x0 + np.array([0, 0.5, 1, 1, 1, 0.5, 0, 0]) * z.shape[1] * self.res
        ys = self.y0 - np.array([0, 0, 0, 0.5, 1, 1, 1, 0.5]) * z.shape[0] * self.res
        lon, lat = _transformer(self.crs, geo_crs()).transform(xs, ys)
        return [float(np.min(lon)), float(np.min(lat)), float(np.max(lon)), float(np.max(lat))]


def source_hash(paths: Sequence[Path]) -> str:
    h = hashlib.sha256()
    for p in paths:
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 22), b""):
                h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------------------------ build


def render_tile(sources: Sequence[Source], z: int, x: int, y: int, px: int, factor: float):
    """(scaled heights, per-source pixel counts, edge-extended pixel count) of tile z/x/y."""
    lon, lat = pixel_lonlat(z, x, y, px)
    pm = pixel_m(z, float(lat[px // 2, 0]), px)
    out = np.full((px, px), np.nan)
    counts = []
    n_edge = 0
    for s in sources:
        todo = np.isnan(out)
        if not todo.any():
            counts.append(0)
            continue
        v, edge = s.sample(lon[todo], lat[todo], pm)
        got = ~np.isnan(v)
        idx = np.flatnonzero(todo.ravel())[got]
        out.ravel()[idx] = v[got]
        counts.append(int(got.sum()))
        n_edge += int((edge & got).sum())
    if np.isnan(out).any():
        raise CoverageError(f"tile {z}/{x}/{y}: {int(np.isnan(out).sum())} pixels have no "
                            "elevation in any source")
    return out * factor, counts, n_edge


def build(*, name: str, sources: Sequence[Path], zooms: tuple[int, int],
          focus_zooms: tuple[int, int] | None, bounds: Sequence[float],
          focus_bounds: Sequence[float] | None, factor: float, tile_px: int,
          budget_bytes: int, out_dir: Path, max_step_true_m: float,
          vertical_offset_m: float, edge_extend_last: bool = False,
          attribution: str | None = ATTRIBUTION, log: Callable[[str], None] = print) -> dict:
    """Write ``out_dir/{z}/{x}/{y}.png`` and ``out_dir/tiles.json``; returns the tiles.json doc.

    Zooms ``zooms[0]..zooms[1]`` over ``bounds``; ``focus_zooms`` over ``focus_bounds`` only.
    Heights written: true elevation * ``factor`` + ``vertical_offset_m`` (scaled metres)."""
    srcs = [Source(p, clamp=edge_extend_last and i == len(sources) - 1)
            for i, p in enumerate(sources)]
    out_dir = Path(out_dir)
    _clear(out_dir)
    plan: list[tuple[int, list[tuple[int, int]]]] = [
        (z, tiles_covering(bounds, z)) for z in range(zooms[0], zooms[1] + 1)]
    if focus_zooms is not None:
        plan += [(z, tiles_covering(focus_bounds, z))
                 for z in range(focus_zooms[0], focus_zooms[1] + 1)]
    used = [0] * len(srcs)
    n_edge = n_px = 0
    tile_count: dict[str, int] = {}
    heights: list[tuple[int, int, int, np.ndarray]] = []
    for z, tiles in plan:
        for x, y in tiles:
            h, counts, e = render_tile(srcs, z, x, y, tile_px, factor)
            used = [a + b for a, b in zip(used, counts, strict=True)]
            n_edge += e
            n_px += tile_px * tile_px
            heights.append((z, x, y, h + vertical_offset_m))
        tile_count[str(z)] = tile_count.get(str(z), 0) + len(tiles)
        log(f"{name}: z{z} {len(tiles)} tiles")
    # Precision: the finest power-of-two step (from Terrarium's 1/256 m) whose PNGs fit the
    # budget; never coarser than max_step_true_m of true elevation (then: over budget).
    step = 1.0 / 256.0
    try:
        while True:
            total, pngs = 0, []
            for *_, h in heights:
                png = encode_png(encode_terrarium(np.round(h / step) * step))
                total += len(png)
                if total > budget_bytes:
                    break
                pngs.append(png)
            log(f"{name}: step {step:g} m (scaled): "
                + (f"{total / MIB:.2f} MiB" if total <= budget_bytes else
                   f"> {budget_bytes / MIB:.2f} MiB budget"))
            if total <= budget_bytes:
                break
            if 2 * step / factor > max_step_true_m + 1e-12:
                raise BudgetError(f"{name}: over budget {budget_bytes} B "
                                  f"({budget_bytes / MIB:.2f} MiB) even at a "
                                  f"{step:g} m step (scaled)")
            step *= 2
        for (z, x, y, _), png in zip(heights, pngs, strict=True):
            p = out_dir / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(png)
    except Exception:
        _clear(out_dir)
        raise
    keep = [i for i, n in enumerate(used) if n > 0]
    doc = {"name": name, "encoding": "terrarium", "format": "png", "scheme": "xyz",
           "tile_px": tile_px, "factor": factor, "vertical_offset_m": float(vertical_offset_m),
           "tiles": [f"{name}/{{z}}/{{x}}/{{y}}.png"],
           "minzoom": zooms[0], "maxzoom": max(zooms[1], focus_zooms[1] if focus_zooms else 0),
           "bounds": [float(v) for v in bounds],
           "focus": (None if focus_zooms is None else
                     {"minzoom": focus_zooms[0], "maxzoom": focus_zooms[1],
                      "bounds": [float(v) for v in focus_bounds]}),
           "source": [srcs[i].rel for i in keep],
           "source_hash": source_hash([srcs[i].path for i in keep]),
           "total_bytes": total, "budget_bytes": int(budget_bytes), "tile_count": tile_count,
           "precision_m": step,
           "source_pixel_pct": {srcs[i].rel: round(100.0 * used[i] / n_px, 3) for i in keep}}
    if edge_extend_last:
        doc["edge_extended_pixel_pct"] = round(100.0 * n_edge / n_px, 3)
    if attribution:
        doc["attribution"] = attribution
    (out_dir / "tiles.json").write_text(json.dumps(doc, indent=1) + "\n")
    log(f"{name}: {sum(tile_count.values())} tiles, {total / MIB:.2f} MiB "
        f"(budget {budget_bytes / MIB:.0f} MiB), sources {doc['source_pixel_pct']}")
    return doc


def _clear(out_dir: Path) -> None:
    """Remove a previous tile set (zoom folders + tiles.json) from ``out_dir`` only."""
    if not out_dir.exists():
        return
    for p in out_dir.iterdir():
        if p.is_dir() and p.name.isdigit():
            shutil.rmtree(p)
        elif p.name in ("tiles.json", BUILD_KEY):
            p.unlink()


# ----------------------------------------------------------------------- run, skip, manifest


def build_key(cfg: dict, scripts: Sequence[Path]) -> str:
    """Hash of the inputs: source file sizes+mtimes, the resolved config, the exporter code."""
    h = hashlib.sha256()
    h.update(json.dumps({k: (v if not isinstance(v, list | tuple) else
                             [str(a) for a in v]) for k, v in sorted(cfg.items())},
                        sort_keys=True, default=str).encode())
    for p in cfg["sources"]:
        st = Path(p).stat()
        h.update(f"{p}:{st.st_size}:{st.st_mtime_ns}".encode())
    for s in scripts:
        h.update(Path(s).read_bytes())
    return h.hexdigest()


def run(cfg: dict, out_dir: Path, *, force: bool, scripts: Sequence[Path],
        log: Callable[[str], None] = print, **extra) -> tuple[dict, bool]:
    """Build unless ``out_dir`` already holds the output of the same inputs; (doc, rebuilt)."""
    key = build_key(cfg, scripts)
    meta, stamp = out_dir / "tiles.json", out_dir / BUILD_KEY
    if not force and meta.exists() and stamp.exists() and stamp.read_text().strip() == key:
        log(f"{cfg['name']}: up to date ({meta})")
        return json.loads(meta.read_text()), False
    missing = [str(p) for p in cfg["sources"] if not Path(p).exists()]
    if missing:
        raise FileNotFoundError(f"{cfg['name']}: missing sources {missing}")
    args = {k: cfg[k] for k in ("name", "sources", "zooms", "focus_zooms", "bounds",
                                "focus_bounds", "factor", "tile_px", "budget_bytes",
                                "max_step_true_m", "vertical_offset_m")}
    doc = build(out_dir=out_dir, log=log, **args, **extra)
    stamp.write_text(key + "\n")
    return doc, True


def record_manifest(doc: dict, script: str) -> None:
    """Rule 6 / DESIGN U1: the factor, vertical offset and source hash (and size) of the set."""
    from pipeline.provenance.manifest import record

    web = f"{doc['name']}/tiles.json"
    k = f"{doc['name']}_tiles"
    record(f"{k}.factor", doc["factor"], "1", web, script)
    record(f"{k}.vertical_offset_m", doc["vertical_offset_m"], "m", web, script)
    record(f"{k}.source_hash", doc["source_hash"], None, web, script)
    record(f"{k}.total_bytes", doc["total_bytes"], "B", web, script)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--force", action="store_true", help="rebuild even if inputs are unchanged")
    ap.add_argument("--no-record", action="store_true", help="skip the manifest fragment")
    a = ap.parse_args(argv)
    cfg = load_config()
    doc, rebuilt = run(cfg, a.out, force=a.force, scripts=[Path(__file__)])
    if not a.no_record and rebuilt:
        record_manifest(doc, __file__)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

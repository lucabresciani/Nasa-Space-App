"""Terrain and science overlays for the U7 layer manager -> ``overlays/`` (DESIGN §6.1, U7, §5.4).

Writes (data/interim/export/overlays/, copied to web/public/data/overlays/ by ``make web``):

* ``slope_class/{z}/{x}/{y}.png``: four slope classes of the 3 m plane-fit slope grid (D22,
  ``slope_3m.tif``), breaks ``config/design.yaml overlays.slope_classes_deg`` [0, 10, 17, 20]:
  class = number of breaks above 0 that the slope *exceeds* (so exactly 20 deg is 17-20, as a cell
  is blocked iff slope > no-go). Indexed PNG; palette from ``web/src/ui/tokens.json``: 0-10 no
  tint, 10-17 ``safe``, 17-20 ``caution``, > 20 ``limit`` (U7 "> 20 deg in limit").
* ``rough/{z}/{x}/{y}.png``: rough-footing mask = max 1 m slope in the 3 m cell
  (``maxslope_3m.tif``, D22 "kept only as a rough footing overlay") > ``site.yaml
  slope.nogo_deg[overlays.rough_footing_variant]``; one colour (``caution``).
* ``mineral_sulfate.png``, ``mineral_clay.png``: CRISM SINDEX2 / D2300 at 18 m (WS1
  ``crism_*_18m.tif``), one georeferenced RGBA image each, colour ``science``, alpha = the index
  normalised linearly p2 -> 0, p98 -> 1 over the valid cells (stations.yaml scoring_assumptions,
  the same normalisation the station scores use), clipped; no data = transparent.
* ``index.json``: metadata for every overlay (tile sets: scheme, zooms, bounds, tile counts,
  legend with token names; minerals: image path, MapLibre image-source ``coordinates``, norm range;
  contours: written by contours.py, listed here by path).

Tile scheme = the elevation tiles' (pipeline/export/terrain_tiles.py, = the WS1 basemap): XYZ
WebMercatorQuad with Mars lon/lat passed through (D4), 256 px, zooms
``terrain_tiles.zooms_planning_extent`` over the planning extent (no z16: the source is 3 m,
MapLibre overzooms z15). Each tile pixel takes the class of the grid cell under its centre; where
the tile pixel is >= 2 grid cells the grid is first reduced to blocks of ``k`` cells by the mode
(ties to the higher class, i.e. the more cautious one). Unknown / outside = transparent.

The mineral PNGs live in the analysis CRS (equirectangular), so lon and lat are linear in the
pixel grid: the image is an axis-aligned lon/lat rectangle. MapLibre stretches an image source
linearly in Web Mercator; over this 0.13 deg span the latitude non-linearity is < 0.3 m (vs 18 m
pixels).

Budget: overlays/ + highlights/ <= ``performance.overlays_mb`` MiB (§5.4); the tile sets are
checked here, the total by tests/test_overlays_export.py. Deterministic (no timestamps, fixed
PNG options); a re-run with unchanged inputs, config and code is skipped (``--force`` rebuilds).

Usage: ``python -m pipeline.export.overlays [--force] [--no-record]``.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import shutil
import sys
from collections.abc import Callable, Sequence
from functools import cache
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from pipeline.export import terrain_tiles as T  # noqa: E402

TERRAIN = REPO / "data" / "interim" / "terrain"
EXPORT = REPO / "data" / "interim" / "export"
OUT = EXPORT / "overlays"
TOKENS = REPO / "web" / "src" / "ui" / "tokens.json"
MIB = 2 ** 20
UNKNOWN = 255
BUILD_KEY = ".build_key"
NDIGITS = 7  # lon/lat decimals in GeoJSON (1e-7 deg = 6 mm on Mars)
WEB_INDEX = "overlays/index.json"
CRISM = {"sulfate": ("SINDEX2", "crism_sindex2_18m.tif"), "clay": ("D2300", "crism_d2300_18m.tif")}


class BudgetError(RuntimeError):
    """Overlays + highlights larger than DESIGN §5.4 allows."""


# ------------------------------------------------------------------------------- shared helpers


def design() -> dict:
    return T._yaml("design.yaml")


def site() -> dict:
    return T._yaml("site.yaml")


def stations_cfg() -> dict:
    return T._yaml("stations.yaml")


def budget_bytes() -> int:
    return int(round(float(design()["performance"]["overlays_mb"]) * MIB))


def focus_bounds() -> list[float]:
    f = site()["aoi_focus"]
    return [f["west"], f["south"], f["east"], f["north"]]


def read_raster(path: Path, window_lonlat: Sequence[float] | None = None):
    """(array float32/uint8 with NaN or nodata kept, x0, y0, res) of a north-up analysis-CRS
    raster; ``window_lonlat`` [w, s, e, n] crops to the whole cells covering that box."""
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(path) as d:
        t = d.transform
        if t.b != 0 or t.d != 0 or t.e >= 0 or abs(t.a + t.e) > 1e-9:
            raise ValueError(f"{path}: only north-up square-pixel rasters are supported")
        res = t.a
        if window_lonlat is None:
            return d.read(1), t.c, t.f, res
        w, s, e, n = window_lonlat
        xs, ys = T.xy_of_lonlat([w, e, e, w], [s, s, n, n])
        c0 = max(0, math.floor((xs.min() - t.c) / res))
        c1 = min(d.width, math.ceil((xs.max() - t.c) / res))
        r0 = max(0, math.floor((t.f - ys.max()) / res))
        r1 = min(d.height, math.ceil((t.f - ys.min()) / res))
        a = d.read(1, window=Window(c0, r0, c1 - c0, r1 - r0))
        return a, t.c + c0 * res, t.f - r0 * res, res


def to_lonlat_coords(coords) -> list:
    """Nested analysis-CRS coordinate arrays -> lon/lat lists rounded to NDIGITS."""
    a = np.asarray(coords, float)
    lon, lat = T.lonlat_of_xy(a[..., 0], a[..., 1])
    return np.round(np.stack([lon, lat], axis=-1), NDIGITS).tolist()


def geom_lonlat(g) -> dict:
    """Shapely geometry (analysis CRS) -> GeoJSON geometry dict in lon/lat."""
    import shapely

    t = shapely.transform(g, lambda xy: np.stack(T.lonlat_of_xy(xy[:, 0], xy[:, 1]), axis=-1))
    d = shapely.geometry.mapping(t)
    return json.loads(json.dumps(d, default=list), parse_float=lambda s: round(float(s), NDIGITS))


def dumps(doc: dict) -> str:
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False) + "\n"


def sha256(paths: Sequence[Path]) -> str:
    return T.source_hash(paths)


def rel(p: Path) -> str:
    try:
        return Path(p).relative_to(REPO).as_posix()
    except ValueError:
        return str(p)


def build_key(cfg: dict, sources: Sequence[Path], scripts: Sequence[Path]) -> str:
    h = hashlib.sha256(json.dumps(cfg, sort_keys=True, default=str).encode())
    for p in sources:
        st = Path(p).stat()
        h.update(f"{p}:{st.st_size}:{st.st_mtime_ns}".encode())
    for s in scripts:
        h.update(Path(s).read_bytes())
    return h.hexdigest()


def up_to_date(out_marker: Path, key_file: Path, key: str) -> bool:
    return out_marker.exists() and key_file.exists() and key_file.read_text().strip() == key


# ------------------------------------------------------------------------------- colours


@cache
def _tokens() -> dict:
    return json.loads(TOKENS.read_text())["color"]


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


SLOPE_TOKENS = [None, "safe", "caution", "limit"]  # 0-10 no tint; > 20 deg in limit (U7)
ROUGH_TOKENS = [None, "caution"]


def palettes() -> dict:
    t = _tokens()
    return {name: {"tokens": toks, "rgb": [None if k is None else hex_rgb(t[k]) for k in toks]}
            for name, toks in (("slope_class", SLOPE_TOKENS), ("rough", ROUGH_TOKENS))}


def mineral_colour() -> tuple[int, int, int]:
    return hex_rgb(_tokens()["science"])


# --------------------------------------------------------------------------- classification


def classify_slope(slope, breaks: Sequence[float]) -> np.ndarray:
    """Class 0..len(breaks)-1 = number of breaks above the first that the slope exceeds."""
    s = np.asarray(slope, float)
    out = np.zeros(s.shape, np.uint8)
    for b in breaks[1:]:
        out += (s > b).astype(np.uint8)
    out[~np.isfinite(s)] = UNKNOWN
    return out


def rough_mask(maxslope, min_deg: float) -> np.ndarray:
    s = np.asarray(maxslope, float)
    out = (s > min_deg).astype(np.uint8)
    out[~np.isfinite(s)] = UNKNOWN
    return out


def mode_level(a: np.ndarray, k: int, n_classes: int) -> np.ndarray:
    """Blocks of k x k cells -> their most frequent known class (ties: the higher class);
    a block with no known cell is UNKNOWN. Trailing partial blocks are dropped."""
    if k <= 1:
        return a
    h, w = (a.shape[0] // k) * k, (a.shape[1] // k) * k
    b = a[:h, :w].reshape(h // k, k, w // k, k)
    counts = np.stack([(b == c).sum(axis=(1, 3)) for c in range(n_classes)], axis=-1)
    # argmax of reversed counts -> the highest class among the maxima
    best = (n_classes - 1 - np.argmax(counts[..., ::-1], axis=-1)).astype(np.uint8)
    best[counts.sum(axis=-1) == 0] = UNKNOWN
    return best


class ClassGrid:
    """A categorical analysis-CRS grid sampled (nearest, mode-reduced) at tile pixel centres."""

    def __init__(self, a: np.ndarray, x0: float, y0: float, res: float, n_classes: int):
        self.a, self.x0, self.y0, self.res, self.n = a, x0, y0, res, n_classes
        self._levels: dict[int, np.ndarray] = {1: a}

    def level(self, k: int) -> np.ndarray:
        if k not in self._levels:
            self._levels[k] = mode_level(self.a, k, self.n)
        return self._levels[k]

    def sample(self, lon, lat, px_m: float) -> np.ndarray:
        k = max(1, int(math.floor(px_m / self.res)))
        g = self.level(k)
        res = self.res * k
        x, y = T.xy_of_lonlat(lon, lat)
        c = np.floor((np.asarray(x) - self.x0) / res).astype(np.int64)
        r = np.floor((self.y0 - np.asarray(y)) / res).astype(np.int64)
        ok = (c >= 0) & (r >= 0) & (c < g.shape[1]) & (r < g.shape[0])
        return np.where(ok, g[np.where(ok, r, 0), np.where(ok, c, 0)], UNKNOWN).astype(np.uint8)


def encode_indexed_png(idx: np.ndarray, palette: Sequence[tuple[int, int, int] | None]) -> bytes:
    """Palette PNG: entry i = palette[i] (None = transparent); UNKNOWN -> transparent entry."""
    from PIL import Image

    n = len(palette)
    clear = n  # one extra transparent entry for UNKNOWN
    data = np.where(idx == UNKNOWN, clear, idx).astype(np.uint8)
    pal, alpha = [], []
    for c in list(palette) + [None]:
        pal += list(c) if c is not None else [0, 0, 0]
        alpha.append(255 if c is not None else 0)
    im = Image.fromarray(np.ascontiguousarray(data), "P")
    im.putpalette(pal, rawmode="RGB")
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True, transparency=bytes(alpha))
    return buf.getvalue()


def build_tileset(name: str, grid: ClassGrid, palette, zooms: tuple[int, int],
                  bounds: Sequence[float], tile_px: int, out_dir: Path,
                  log: Callable[[str], None] = print) -> dict:
    """Write out_dir/{z}/{x}/{y}.png; return the index entry (without legend)."""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    total, count = 0, {}
    for z in range(zooms[0], zooms[1] + 1):
        tiles = T.tiles_covering(bounds, z)
        for x, y in tiles:
            lon, lat = T.pixel_lonlat(z, x, y, tile_px)
            pm = T.pixel_m(z, float(lat[tile_px // 2, 0]), tile_px)
            idx = grid.sample(lon.ravel(), lat.ravel(), pm).reshape(tile_px, tile_px)
            png = encode_indexed_png(idx, palette)
            p = out_dir / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(png)
            total += len(png)
        count[str(z)] = len(tiles)
        log(f"overlays/{name}: z{z} {len(tiles)} tiles")
    return {"format": "png", "scheme": "xyz", "tile_px": tile_px,
            "tiles": [f"overlays/{name}/{{z}}/{{x}}/{{y}}.png"], "minzoom": zooms[0],
            "maxzoom": zooms[1], "bounds": [float(v) for v in bounds], "tile_count": count,
            "total_bytes": total}


# ----------------------------------------------------------------------------------- mineral


def norm_range(v: np.ndarray) -> list[float]:
    """[p_lo, p_hi] of the valid cells (stations.yaml crism_norm_percentiles)."""
    lo, hi = stations_cfg()["scoring_assumptions"]["crism_norm_percentiles"]
    a = v[np.isfinite(v)]
    return [float(np.percentile(a, lo)), float(np.percentile(a, hi))]


def mineral_rgba(v: np.ndarray, lo: float, hi: float, rgb: tuple[int, int, int]) -> np.ndarray:
    n = np.clip((np.asarray(v, float) - lo) / (hi - lo), 0.0, 1.0)
    alpha = np.where(np.isfinite(n), np.rint(n * 255.0), 0).astype(np.uint8)
    out = np.zeros(v.shape + (4,), np.uint8)
    out[..., :3] = rgb
    out[..., 3] = alpha
    return out


def raster_corners(x0: float, y0: float, res: float, w: int, h: int) -> list[list[float]]:
    """MapLibre image-source coordinates [[w, n], [e, n], [e, s], [w, s]] of a raster."""
    lon, lat = T.lonlat_of_xy(np.array([x0, x0 + w * res]), np.array([y0, y0 - h * res]))
    W, E = float(round(lon[0], NDIGITS)), float(round(lon[1], NDIGITS))
    N, S = float(round(lat[0], NDIGITS)), float(round(lat[1], NDIGITS))
    return [[W, N], [E, N], [E, S], [W, S]]


def encode_rgba_png(rgba: np.ndarray) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(rgba), "RGBA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# -------------------------------------------------------------------------------------- build


def load_config() -> dict:
    d, s = design(), site()
    ov, tt = d["overlays"], d["terrain_tiles"]
    variant = ov["rough_footing_variant"]
    return {"breaks_deg": [float(b) for b in ov["slope_classes_deg"]],
            "rough_variant": variant, "rough_min_deg": float(s["slope"]["nogo_deg"][variant]),
            "zooms": tuple(int(z) for z in tt["zooms_planning_extent"]),
            "tile_px": int(tt["tile_px"]), "bounds": T.planning_bounds(),
            "budget_bytes": budget_bytes(),
            "norm_percentiles": stations_cfg()["scoring_assumptions"]["crism_norm_percentiles"],
            "tokens": _tokens(),
            "sources": {"slope": TERRAIN / "slope_3m.tif", "maxslope": TERRAIN / "maxslope_3m.tif",
                        **{k: TERRAIN / f for k, (_, f) in CRISM.items()}}}


def build(cfg: dict, out_dir: Path, log: Callable[[str], None] = print) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    pal = palettes()
    src = cfg["sources"]
    idx: dict = {"version": "1", "contours": "overlays/contours.geojson"}

    slope, x0, y0, res = read_raster(src["slope"])
    g = ClassGrid(classify_slope(slope, cfg["breaks_deg"]), x0, y0, res,
                  n_classes=len(cfg["breaks_deg"]))
    del slope
    ts = build_tileset("slope_class", g, pal["slope_class"]["rgb"], cfg["zooms"], cfg["bounds"],
                       cfg["tile_px"], out_dir / "slope_class", log)
    b = cfg["breaks_deg"]
    ts.update({"breaks_deg": [int(v) if float(v).is_integer() else v for v in b],
               "legend": [{"class": i, "range_deg": [b[i], b[i + 1] if i + 1 < len(b) else None],
                           "token": pal["slope_class"]["tokens"][i]} for i in range(len(b))],
               "rule": "class = number of breaks above 0 the 3 m plane-fit slope exceeds "
                       "(D22; exactly 20 deg is 17-20: a cell is blocked iff slope > no-go)",
               "source": rel(src["slope"]), "source_hash": sha256([src["slope"]])})
    idx["slope_class"] = ts

    ms, x0, y0, res = read_raster(src["maxslope"])
    g = ClassGrid(rough_mask(ms, cfg["rough_min_deg"]), x0, y0, res, n_classes=2)
    del ms
    ts = build_tileset("rough", g, pal["rough"]["rgb"], cfg["zooms"], cfg["bounds"],
                       cfg["tile_px"], out_dir / "rough", log)
    ts.update({"min_deg": cfg["rough_min_deg"], "variant": cfg["rough_variant"],
               "legend": [{"class": 1, "label": "rough footing", "token": "caution"}],
               "rule": "max 1 m Horn slope inside the 3 m cell > site.yaml slope.nogo_deg"
                       f"[{cfg['rough_variant']}] (D22 rough-footing overlay)",
               "source": rel(src["maxslope"]), "source_hash": sha256([src["maxslope"]])})
    idx["rough"] = ts

    rgb = mineral_colour()
    for kind, (index_name, _) in CRISM.items():
        v, x0, y0, res = read_raster(src[kind])
        v = v.astype("float32")
        lo, hi = norm_range(v)
        png = encode_rgba_png(mineral_rgba(v, lo, hi, rgb))
        name = f"mineral_{kind}.png"
        (out_dir / name).write_bytes(png)
        idx[f"mineral_{kind}"] = {
            "image": f"overlays/{name}", "index": index_name, "type": kind,
            "res_m": int(res) if float(res).is_integer() else res,
            "width": int(v.shape[1]), "height": int(v.shape[0]),
            "coordinates": raster_corners(x0, y0, res, v.shape[1], v.shape[0]),
            "norm_range": [round(lo, 6), round(hi, 6)], "norm_percentiles": cfg["norm_percentiles"],
            "encoding": "RGBA; colour = token science; alpha = 255 * clip((index - lo) / "
                        "(hi - lo), 0, 1); no data = alpha 0",
            "token": "science", "caption": "Orbital hint, not an identification",
            "source": rel(src[kind]), "source_hash": sha256([src[kind]]), "bytes": len(png)}
        log(f"overlays/{name}: {v.shape[1]}x{v.shape[0]}, {len(png)} B, norm [{lo:.5f}, {hi:.5f}]")

    total = sum(p.stat().st_size for p in out_dir.rglob("*.png"))
    idx["total_bytes"] = total
    if total > cfg["budget_bytes"]:
        raise BudgetError(f"overlays: {total} B > budget {cfg['budget_bytes']} B")
    (out_dir / "index.json").write_text(json.dumps(idx, indent=1) + "\n")
    log(f"overlays: {total / MIB:.2f} MiB of tiles/images (budget for overlays + highlights "
        f"{cfg['budget_bytes'] / MIB:.0f} MiB)")
    return idx


def record_manifest(idx: dict) -> None:
    from pipeline.provenance.manifest import record

    s = __file__
    record("overlays.slope_class.breaks_deg", idx["slope_class"]["breaks_deg"], "deg", WEB_INDEX, s)
    record("overlays.rough.min_deg", idx["rough"]["min_deg"], "deg", WEB_INDEX, s)
    for kind in CRISM:
        record(f"overlays.mineral_{kind}.norm_range", idx[f"mineral_{kind}"]["norm_range"], "1",
               WEB_INDEX, s)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-record", action="store_true")
    a = ap.parse_args(argv)
    cfg = load_config()
    srcs = list(cfg["sources"].values())
    missing = [str(p) for p in srcs if not Path(p).exists()]
    if missing:
        raise FileNotFoundError(f"overlays: missing sources {missing}")
    key = build_key(cfg, srcs, [Path(__file__), Path(T.__file__)])
    if not a.force and up_to_date(a.out / "index.json", a.out / BUILD_KEY, key):
        print(f"overlays: up to date ({a.out / 'index.json'})")
        return 0
    idx = build(cfg, a.out)
    (a.out / BUILD_KEY).write_text(key + "\n")
    if not a.no_record:
        record_manifest(idx)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

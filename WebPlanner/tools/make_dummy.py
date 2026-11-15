#!/usr/bin/env python3
"""M0 dummy-data generator: fake but contract-valid data in web/public/data-dummy/.

Implements docs/dummy.md against contracts v1.0.0. Deterministic (seed 20261114), offline,
well under a minute. Every format setting comes from config/*.yaml and every output follows
contracts/ (SPEC §6, §6.1, §6.2). The numbers are FAKE: they come from a synthetic world, not
from Mars data. Every index file (and every other object-shaped JSON file) carries
"dummy": true. Never use them in captures, the video or the project page.

Run:  uv run --no-sync python tools/make_dummy.py [--out web/public/data-dummy]
      (or `make dummy`)

Geometry convention: internally everything is in metres relative to the default pad
(x east, y north) in the analysis CRS (config/site.yaml crs.analysis_proj); output coordinates
are lon/lat (Mars 2000 planetocentric sphere), 6 decimals. Raster rows run north to south.
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import shutil
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import numpy as np
import shapely
import yaml
from affine import Affine
from PIL import Image, ImageDraw
from pyproj import Transformer
from rasterio.features import shapes
from scipy import ndimage
from scipy.sparse.csgraph import dijkstra
from shapely.geometry import LineString, MultiLineString, Polygon, box, mapping, shape
from shapely.ops import unary_union

REPO = Path(__file__).resolve().parent.parent
CONFIG_DIR = REPO / "config"
OUT_DIR = REPO / "web" / "public" / "data-dummy"
SCRIPT = "tools/make_dummy.py"

# ---------------------------------------------------------------------------------------------
# DUMMY-ONLY constants (docs/dummy.md). They define the fake synthetic world and its fake
# numbers; they are NOT science constants and must never be used by the real pipeline.
# ---------------------------------------------------------------------------------------------
DUMMY_SEED = 20261114
DUMMY_SCENARIOS = {"nom_104": 0.9, "opt_104": 1.0, "con_104": 0.8}  # id -> walking speed, m/s
DUMMY_ROUTE_SCENARIO = "nom_104"                  # route/timeline/nav/worst-case scenario
DUMMY_PLANE_GRADE = 0.05                          # 5% plane rising to the south
DUMMY_HILL = {"height_m": 40.0, "sigma_m": 150.0, "dist_m": 600.0, "bearing_deg": 45.0}
DUMMY_WALL = {"length_m": 300.0, "height_m": 8.0, "slope_deg": 35.0, "dist_m": 400.0,
              "bearing_deg": 270.0}               # straight N-S wall west of the pad
DUMMY_HOLE = {"radius_m": 80.0, "dist_m": 500.0, "bearing_deg": 135.0}  # nodata circle
DUMMY_CTX_STRIP_X_M = (700.0, 1000.0)  # east 300 m of the 2 x 2 km tile, extended N-S (CTX)
DUMMY_RIDGES = {"amp_m": 1.2, "wavelength_m": 20.0, "size_m": 200.0, "dist_m": 300.0,
                "bearing_deg": 0.0}
DUMMY_STATIONS = [("S1", 600.0, 0.0), ("S2", 900.0, 90.0), ("S3", 1400.0, 180.0)]  # dist, brg
DUMMY_STATION_VALUE_RANGE = (0.3, 1.0)
DUMMY_O2_L_PER_MIN = 0.25                         # o2_home = 0.25 L per minute of t_home
DUMMY_PARTNER_FRAC = 0.4                          # partner line = 40% of the 60-min radius
DUMMY_TRADE_SPEED_EXP = 0.5                       # v(M) = v_nom * (M_default / M)^0.5
DUMMY_RAD = {"baseline_uGy_h": 9.0, "peak_uGy_h": 350.0, "onset_h": 2.0, "rise_h": 3.0,
             "decay_h": 24.0, "step_h": 1.0}
DUMMY_RAD_LATEST_UTC = "2026-11-01T00:00:00Z"
DUMMY_RAD_LAG_DAYS = 13.0
DUMMY_ELLIPSE_AXIS_RATIO = 0.5                    # b = 0.5 a; major axis across track
DUMMY_ELLIPSE_EVERY_MIN = 5                       # SPEC §6.2: ellipse polygons every 5 min
DUMMY_TAN_RGB = (196, 164, 124)                   # flat tan texture
DUMMY_PLACEHOLDER_GREY = 128
DUMMY_HEIGHT_QUANTUM_M = 1.0 / 64.0               # exact binary step; makes gzip effective
DUMMY_NEAR_CHUNK_PX = 256                         # contracts/README.md: 256 x 256 at 1 m
DUMMY_NEAR_RES_M = 1.0
DUMMY_FAR_RES_M = 8.0                             # contracts/README.md: far heights at 8 m
DUMMY_CORRIDOR_HALF_M = 150.0                     # "corridor ~300 m wide along the route"
DUMMY_RAY_STEP_M = 5.0
DUMMY_MANIFEST_UTC = "2026-11-14T09:00:00Z"       # fixed (not wall clock) => deterministic
DUMMY_COMMIT = "dummy"
DUMMY_OBSTACLE_POLY_N = 32                        # polygon sides for geodesic waypoints
DUMMY_PAD_ALTERNATIVES = [(150.0, 30.0), (250.0, 200.0), (320.0, 120.0)]  # dist, bearing
DUMMY_SITE_RULE_VERSION = "DUMMY"
# D21 parking-option picker (contracts v1.1.4): picker pads (dist m, bearing deg from the pad);
# the dummy official pad is the pad of pad.json. Ids rank{n} follow the computed D21 order.
DUMMY_PICKER_PADS = [(380.0, 270.0), (400.0, 135.0)]  # beside the wall and the hole

CAUSES = ("physiology", "slope", "data")
VARIANT_OF = {"opt": "optimistic", "nom": "nominal", "con": "conservative"}


# --------------------------------------------------------------------------------- config ----
def load_config(config_dir: Path = CONFIG_DIR) -> dict[str, dict]:
    return {
        p.stem: yaml.safe_load(p.read_text(encoding="utf-8"))
        for p in sorted(Path(config_dir).glob("*.yaml"))
    }


def polar(dist_m: float, bearing_deg: float) -> tuple[float, float]:
    b = math.radians(bearing_deg)
    return dist_m * math.sin(b), dist_m * math.cos(b)


def bearing_deg(dx, dy):
    return np.mod(np.degrees(np.arctan2(dx, dy)), 360.0)


# ------------------------------------------------------------------------------ geography ----
class Geo:
    """Pad-relative metres <-> lon/lat via the analysis CRS from config/site.yaml."""

    def __init__(self, site: dict):
        crs = site["crs"]
        geog = f"+proj=longlat +R={crs['mars_radius_m']} +no_defs"
        self.fwd = Transformer.from_crs(geog, crs["analysis_proj"], always_xy=True)
        self.inv = Transformer.from_crs(crs["analysis_proj"], geog, always_xy=True)
        pad = site["pad_default"]
        self.pad_lonlat = (pad["lon"], pad["lat"])
        self.pad_xy = self.fwd.transform(pad["lon"], pad["lat"])
        self.analysis_proj = crs["analysis_proj"]

    def lonlat(self, x, y):
        lon, lat = self.inv.transform(np.asarray(x) + self.pad_xy[0],
                                      np.asarray(y) + self.pad_xy[1])
        return np.round(lon, 6), np.round(lat, 6)

    def lonlat_pt(self, x: float, y: float) -> tuple[float, float]:
        lon, lat = self.lonlat(x, y)
        return float(lon), float(lat)

    def geom(self, g):
        def f(xy):
            lon, lat = self.lonlat(xy[:, 0], xy[:, 1])
            return np.column_stack([lon, lat])

        return shapely.transform(g, f)


# -------------------------------------------------------------------------- synthetic world --
@dataclass
class World:
    hill_xy: tuple[float, float]
    wall_a: tuple[float, float]
    wall_b: tuple[float, float]
    wall_half_w: float
    hole_xy: tuple[float, float]
    hole_r: float
    ridge_xy: tuple[float, float]
    ctx_x: tuple[float, float]

    @classmethod
    def build(cls) -> World:
        wx, wy = polar(DUMMY_WALL["dist_m"], DUMMY_WALL["bearing_deg"])
        half = DUMMY_WALL["length_m"] / 2
        return cls(
            hill_xy=polar(DUMMY_HILL["dist_m"], DUMMY_HILL["bearing_deg"]),
            wall_a=(wx, wy - half),
            wall_b=(wx, wy + half),
            wall_half_w=DUMMY_WALL["height_m"] / math.tan(math.radians(DUMMY_WALL["slope_deg"])),
            hole_xy=polar(DUMMY_HOLE["dist_m"], DUMMY_HOLE["bearing_deg"]),
            hole_r=DUMMY_HOLE["radius_m"],
            ridge_xy=polar(DUMMY_RIDGES["dist_m"], DUMMY_RIDGES["bearing_deg"]),
            ctx_x=DUMMY_CTX_STRIP_X_M,
        )

    def wall_dist(self, x, y):
        return point_seg_dist(x, y, *self.wall_a, *self.wall_b)

    def elevation(self, x, y):
        """Synthetic height (m, pad-relative frame). Defined everywhere (hole filled)."""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        h = -DUMMY_PLANE_GRADE * y
        hx, hy = self.hill_xy
        s = DUMMY_HILL["sigma_m"]
        h = h + DUMMY_HILL["height_m"] * np.exp(-((x - hx) ** 2 + (y - hy) ** 2) / (2 * s * s))
        slope = math.tan(math.radians(DUMMY_WALL["slope_deg"]))
        h = h + np.maximum(0.0, DUMMY_WALL["height_m"] - self.wall_dist(x, y) * slope)
        rx, ry = self.ridge_xy
        half = DUMMY_RIDGES["size_m"] / 2
        inside = (np.abs(x - rx) <= half) & (np.abs(y - ry) <= half)
        ridge = DUMMY_RIDGES["amp_m"] * 0.5 * (
            1 - np.cos(2 * np.pi * (y - ry + half) / DUMMY_RIDGES["wavelength_m"]))
        return h + np.where(inside, ridge, 0.0)

    def hole(self, x, y):
        return np.hypot(np.asarray(x) - self.hole_xy[0], np.asarray(y) - self.hole_xy[1]) \
            < self.hole_r

    def wall(self, x, y):
        return self.wall_dist(x, y) < self.wall_half_w

    def ctx(self, x, y):
        x = np.asarray(x)
        return (x >= self.ctx_x[0]) & (x <= self.ctx_x[1])

    def blocked_segment(self, ax, ay, bx, by, eps: float = 1e-3):
        """True where segment a->b crosses the wall footprint or the nodata hole."""
        hit_hole = point_seg_dist(self.hole_xy[0], self.hole_xy[1], ax, ay, bx, by) \
            < self.hole_r - eps
        hit_wall = seg_seg_dist(ax, ay, bx, by, *self.wall_a, *self.wall_b) \
            < self.wall_half_w - eps
        return hit_hole | hit_wall

    def waypoints(self) -> np.ndarray:
        """Vertices of polygons circumscribing each obstacle (shortest paths bend only there)."""
        n = DUMMY_OBSTACLE_POLY_N
        ang = 2 * np.pi * (np.arange(n) + 0.5) / n
        grow = 1 / math.cos(math.pi / n)
        pts = []
        for (cx, cy), r in ((self.hole_xy, self.hole_r), (self.wall_a, self.wall_half_w),
                            (self.wall_b, self.wall_half_w)):
            rr = r * grow + 0.5
            pts.append(np.column_stack([cx + rr * np.sin(ang), cy + rr * np.cos(ang)]))
        p = np.vstack(pts)
        keep = ~self.hole(p[:, 0], p[:, 1]) & (self.wall_dist(p[:, 0], p[:, 1])
                                               > self.wall_half_w + 0.25)
        return p[keep]

    def cause(self, x, y, buffer_m: float):
        """Edge cause index into CAUSES: slope near the wall, data near the hole / CTX strip."""
        slope = self.wall_dist(x, y) <= self.wall_half_w + buffer_m
        data = (np.hypot(x - self.hole_xy[0], y - self.hole_xy[1]) <= self.hole_r + buffer_m) | (
            (x >= self.ctx_x[0] - buffer_m) & (x <= self.ctx_x[1] + buffer_m))
        return np.where(slope, 1, np.where(data, 2, 0))


def point_seg_dist(px, py, ax, ay, bx, by):
    px, py, ax, ay, bx, by = (np.asarray(v, dtype=np.float64) for v in (px, py, ax, ay, bx, by))
    dx, dy = bx - ax, by - ay
    ll = dx * dx + dy * dy
    with np.errstate(invalid="ignore", divide="ignore"):
        t = np.where(ll > 0, ((px - ax) * dx + (py - ay) * dy) / np.where(ll > 0, ll, 1), 0.0)
    t = np.clip(t, 0.0, 1.0)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy))


def seg_seg_dist(ax, ay, bx, by, cx, cy, dx, dy):
    def orient(px, py, qx, qy, rx, ry):
        return np.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))

    o1 = orient(ax, ay, bx, by, cx, cy)
    o2 = orient(ax, ay, bx, by, dx, dy)
    o3 = orient(cx, cy, dx, dy, ax, ay)
    o4 = orient(cx, cy, dx, dy, bx, by)
    cross = (o1 * o2 < 0) & (o3 * o4 < 0)
    d = np.minimum(
        np.minimum(point_seg_dist(ax, ay, cx, cy, dx, dy), point_seg_dist(bx, by, cx, cy, dx, dy)),
        np.minimum(point_seg_dist(cx, cy, ax, ay, bx, by), point_seg_dist(dx, dy, ax, ay, bx, by)),
    )
    return np.where(cross, 0.0, d)


def geodesic_distance(world: World, x: np.ndarray, y: np.ndarray,
                      origin: tuple[float, float] = (0.0, 0.0)) -> np.ndarray:
    """Shortest walking distance (m) from ``origin`` (default the pad) around the wall and
    hole; inf on obstacles.

    Visible cells: straight-line distance. Shadow cells: via the visibility graph of waypoints
    circumscribing the (convex) obstacles, solved with Dijkstra. Exact to < 1 m here.
    """
    ox, oy = origin
    blocked = world.wall(x, y) | world.hole(x, y)
    d = np.hypot(x - ox, y - oy)
    shadow = world.blocked_segment(ox, oy, x, y) & ~blocked
    nodes = np.vstack([[ox, oy], world.waypoints()])
    n = len(nodes)
    ii, jj = np.triu_indices(n, 1)
    clear = ~world.blocked_segment(nodes[ii, 0], nodes[ii, 1], nodes[jj, 0], nodes[jj, 1])
    w = np.zeros((n, n))
    lens = np.hypot(nodes[ii, 0] - nodes[jj, 0], nodes[ii, 1] - nodes[jj, 1])
    w[ii[clear], jj[clear]] = lens[clear]
    dv = dijkstra(w, directed=False, indices=0)
    sx, sy = x[shadow], y[shadow]
    best = np.full(sx.shape, np.inf)
    for k in range(1, n):
        if not np.isfinite(dv[k]):
            continue
        vx, vy = nodes[k]
        cand = dv[k] + np.hypot(sx - vx, sy - vy)
        ok = ~world.blocked_segment(vx, vy, sx, sy)
        best = np.where(ok & (cand < best), cand, best)
    d[shadow] = best
    d[blocked] = np.inf
    # Any free cell still unresolved (thin slivers next to an obstacle): nearest resolved + gap.
    bad = ~np.isfinite(d) & ~blocked
    if bad.any():
        idx = ndimage.distance_transform_edt(~np.isfinite(d), return_distances=False,
                                             return_indices=True)
        ry, rx = idx[0][bad], idx[1][bad]
        d[bad] = d[ry, rx] + np.hypot(x[bad] - x[ry, rx], y[bad] - y[ry, rx])
    return d


# ---------------------------------------------------------------------------- raster grid ----
@dataclass
class Grid:
    res: float
    n: int  # square, odd, pad at the centre pixel

    @classmethod
    def centred(cls, radius_m: float, res: float) -> Grid:
        return cls(res=res, n=2 * math.ceil(radius_m / res) + 1)

    @property
    def half(self) -> float:
        return self.n * self.res / 2

    @property
    def centre(self) -> int:
        return self.n // 2

    def xy(self):
        v = (np.arange(self.n) - self.centre) * self.res
        return np.meshgrid(v, -v)  # row 0 = north

    def transform(self, r0: int = 0, c0: int = 0) -> Affine:
        return Affine(self.res, 0, -self.half + c0 * self.res, 0, -self.res,
                      self.half - r0 * self.res)

    def pixel(self, x: float, y: float) -> tuple[int, int]:
        return self.centre - round(y / self.res), self.centre + round(x / self.res)


def horn_slope_deg(h: np.ndarray, res: float) -> np.ndarray:
    """Horn 3x3 slope (config/site.yaml slope.method = horn_3x3), degrees."""
    p = np.pad(h, 1, mode="edge")
    a, b, c = p[:-2, :-2], p[:-2, 1:-1], p[:-2, 2:]
    d, f = p[1:-1, :-2], p[1:-1, 2:]
    g, hh, i = p[2:, :-2], p[2:, 1:-1], p[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * res)
    dzdy = ((g + 2 * hh + i) - (a + 2 * b + c)) / (8 * res)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy)))


def encode_png(values: np.ndarray, scale: float) -> bytes:
    """contracts/README.md: counts = value / scale; R*256 + G = counts; B = 0; A = 0 unknown."""
    valid = np.isfinite(values)
    counts = np.zeros(values.shape, dtype=np.int64)
    counts[valid] = np.clip(np.rint(values[valid] / scale), 0, 65535).astype(np.int64)
    rgba = np.zeros(values.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = counts >> 8
    rgba[..., 1] = counts & 255
    rgba[..., 3] = np.where(valid, 255, 0)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", compress_level=6)
    return buf.getvalue()


def disc_max(values: np.ndarray, radius_px: int) -> np.ndarray:
    """Worst case within a disc: max filter; any unknown cell in the disc -> unknown."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius_px + 1, 2 * radius_px + 1))
    v = np.where(np.isfinite(values), values, np.float32(3.0e38)).astype(np.float32)
    out = cv2.dilate(v, k, borderType=cv2.BORDER_REPLICATE).astype(np.float64)
    out[out >= 1.0e38] = np.inf
    return out


def region_polygon(mask: np.ndarray, grid: Grid, simplify_m: float):
    """Polygon (pad-relative metres) of True cells, cropped for speed, simplified."""
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    if rows.size == 0:
        return Polygon()
    r0, r1_, c0, c1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    sub = mask[r0:r1_, c0:c1].astype(np.uint8)
    polys = [shape(g) for g, v in shapes(sub, mask=sub.astype(bool),
                                         transform=grid.transform(r0, c0)) if v == 1]
    g = unary_union(polys)
    return g.simplify(simplify_m, preserve_topology=True)


def circle(cx: float, cy: float, r: float, n: int = 128) -> Polygon:
    a = 2 * np.pi * np.arange(n) / n
    return Polygon(np.column_stack([cx + r * np.sin(a), cy + r * np.cos(a)]))


def ellipse(cx: float, cy: float, a: float, b: float, theta_deg: float, n: int = 48) -> Polygon:
    """Ellipse with semi-major a along azimuth theta (deg clockwise from north)."""
    t = 2 * np.pi * np.arange(n) / n
    u, v = a * np.cos(t), b * np.sin(t)
    th = math.radians(theta_deg)
    ex, ey = math.sin(th), math.cos(th)  # major-axis unit vector
    nx, ny = ey, -ex                     # minor axis (90 deg clockwise)
    return Polygon(np.column_stack([cx + u * ex + v * nx, cy + u * ey + v * ny]))


# --------------------------------------------------------------------------- output utils ----
@dataclass
class Out:
    root: Path
    geo: Geo
    manifest: dict = field(default_factory=dict)
    written: list[Path] = field(default_factory=list)

    def write_bytes(self, rel: str, data: bytes) -> None:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        self.written.append(p)

    def write_json(self, rel: str, obj, compact: bool = False) -> None:
        if compact:
            text = json.dumps(obj, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
        else:
            text = json.dumps(obj, indent=2, allow_nan=False, ensure_ascii=False)
        self.write_bytes(rel, (text + "\n").encode("utf-8"))

    def record(self, key: str, value, units: str | None, file: str) -> None:
        self.manifest[key] = {"value": value, "units": units, "file": file, "script": SCRIPT,
                              "commit": DUMMY_COMMIT, "utc": DUMMY_MANIFEST_UTC}

    def feature(self, geom_m, props: dict) -> dict:
        return {"type": "Feature", "properties": props, "geometry": mapping(self.geo.geom(geom_m))}


def fc(features: list[dict]) -> dict:
    return {"dummy": True, "type": "FeatureCollection", "features": features}


def r1(v: float) -> float:
    return round(float(v), 1)


def r2(v: float) -> float:
    return round(float(v), 2)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ------------------------------------------------------------------------------ generator ----
def safe_clear(out: Path) -> None:
    """Remove a previous dummy tree. Refuses to wipe a directory that is not a dummy tree."""
    if not out.exists():
        return
    contents = [p for p in out.iterdir() if p.name != ".gitkeep"]
    if contents:
        idx = out / "scenarios" / "index.json"
        ok = out.name == "data-dummy" or (
            idx.is_file() and json.loads(idx.read_text(encoding="utf-8")).get("dummy") is True)
        if not ok:
            raise SystemExit(f"refusing to clear {out}: not a dummy data tree")
    for p in contents:
        shutil.rmtree(p) if p.is_dir() else p.unlink()


def generate(out_dir: Path = OUT_DIR, config_dir: Path = CONFIG_DIR) -> list[Path]:
    cfg = load_config(config_dir)
    site, hud, nav, crew = cfg["site"], cfg["hud"], cfg["nav"], cfg["crew"]
    stations_cfg, variants, conditions = cfg["stations"], cfg["variants"], cfg["conditions"]
    rng = np.random.default_rng(DUMMY_SEED)
    out_dir = Path(out_dir)
    safe_clear(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    geo = Geo(site)
    o = Out(out_dir, geo)
    world = World.build()

    res = hud["field_png"]["res_m"]
    web_res = site["grids_m"]["web"]
    step = int(round(web_res / res))
    buffer_m = site["coverage"]["source_edge_buffer_m"]
    budgets = crew["walkback_budgets_min"]
    band_budgets = variants["outputs"]["band_budgets_min"]
    iso_cfg = variants["outputs"]["isochrone_minutes"]
    iso_minutes = list(range(iso_cfg["min"], iso_cfg["max"] + 1, iso_cfg["step"]))
    suit = crew["default_suit_kg"]
    eva_min = crew["eva_h"] * 60
    reserve_min = crew["reserve_min"]
    scales = hud["field_scales"]
    rs = DUMMY_ROUTE_SCENARIO
    assert variants["scenarios"]["default"] in DUMMY_SCENARIOS

    # ---- fields grid (5 m over the planning extent) ----------------------------------------
    grid = Grid.centred(site["planning_radius_m"], res)
    gx, gy = grid.xy()
    dist = geodesic_distance(world, gx, gy)
    hole = world.hole(gx, gy)
    elev5 = world.elevation(gx, gy)
    slope5 = horn_slope_deg(elev5, res)
    slope5[hole] = np.nan

    t_fields = {sc: dist / v / 60.0 for sc, v in DUMMY_SCENARIOS.items()}
    fields: dict[str, dict] = {}

    def add_field(key: str, rel: str, values: np.ndarray, scale_key: str, scenario) -> None:
        o.write_bytes(rel, encode_png(values, scales[scale_key]["per_count"]))
        fields[key] = {"file": rel, "scale": scales[scale_key]["per_count"],
                       "units": scales[scale_key]["units"], "scenario": scenario}

    for sc, t in t_fields.items():
        add_field(f"{sc}/t_home", f"fields/{sc}/t_home.png", t, "t_home", sc)
        add_field(f"{sc}/o2_home", f"fields/{sc}/o2_home.png", t * DUMMY_O2_L_PER_MIN,
                  "o2_home", sc)
    bearing = bearing_deg(-gx, -gy)
    bearing[~np.isfinite(dist)] = np.nan
    add_field(f"{rs}/home_bearing", f"fields/{rs}/home_bearing.png", bearing, "home_bearing", rs)
    for r in hud["worst_case_radii_m"]:
        wc = disc_max(t_fields[rs], int(round(r / res)))
        add_field(f"{rs}/t_home_worst_{r}", f"fields/{rs}/t_home_worst_{r}.png", wc,
                  "t_home", rs)
        add_field(f"{rs}/o2_home_worst_{r}", f"fields/{rs}/o2_home_worst_{r}.png",
                  wc * DUMMY_O2_L_PER_MIN, "o2_home", rs)
    add_field("slope", "fields/shared/slope.png", slope5, "slope", None)

    # fix_interval_{set}: D_max = 2 x distance to the 30-min edge (0 outside the homeline)
    nav_set = nav["default_set"]
    inside30 = t_fields[rs] <= budgets[0]
    edge_dist = ndimage.distance_transform_edt(inside30) * res
    dmax = np.where(inside30, 2.0 * edge_dist, 0.0)
    dmax[~np.isfinite(dist)] = np.nan
    add_field(f"fix_interval_{nav_set}", f"fields/fix_interval_{nav_set}.png", dmax,
              "fix_interval", rs)

    w_, s_ = geo.lonlat_pt(-grid.half, -grid.half)
    e_, n_ = geo.lonlat_pt(grid.half, grid.half)
    o.write_json("fields/index.json", {
        "dummy": True, "bounds": [w_, s_, e_, n_], "width": grid.n, "height": grid.n,
        "res_m": res, "fields": fields})

    # terrain/cellstate.{png,json} (contracts v1.1.0): 0 assessed, 1 blocked (slope over the
    # nominal no-go limit), 2 unknown (hole or CTX strip) = A 0. On the 5 m field grid here; the
    # real file is on WS1's 3 m routing grid (res_m says which).
    cs_unknown = hole | world.ctx(gx, gy) | ~np.isfinite(slope5)
    cs_blocked = ~cs_unknown & (np.nan_to_num(slope5) > site["slope"]["nogo_deg"]["nominal"])
    cs = np.where(cs_blocked, 1.0, 0.0)
    cs[cs_unknown] = np.nan
    o.write_bytes("terrain/cellstate.png", encode_png(cs, 1))
    n_cs = cs.size
    o.write_json("terrain/cellstate.json", {
        "dummy": True, "image": "terrain/cellstate.png", "bounds": [w_, s_, e_, n_],
        "width": grid.n, "height": grid.n, "res_m": res, "variant": "nominal",
        "codes": {"0": "assessed", "1": "blocked", "2": "unknown"},
        "pct": {"assessed": r2(100 * np.count_nonzero(cs == 0) / n_cs),
                "blocked": r2(100 * np.count_nonzero(cs_blocked) / n_cs),
                "unknown": r2(100 * np.count_nonzero(cs_unknown) / n_cs)},
        "source": "tools/make_dummy.py (synthetic world)"})

    # fix-interval summary (SPEC §6.2)
    classes = nav["fix_interval"]["classes_m"]
    vals = dmax[inside30 & np.isfinite(dmax)]
    near_edge = inside30 & (edge_dist <= classes[0]) & np.isfinite(dmax)
    edges_c = [0, *classes, np.inf]
    labels = [f"<{classes[0]}", f"{classes[0]}-{classes[1]}", f"{classes[1]}-{classes[2]}",
              f">{classes[2]}"]
    pct = {lab: r1(100 * np.mean((vals >= lo) & (vals < hi)))
           for lab, lo, hi in zip(labels, edges_c[:-1], edges_c[1:], strict=True)}
    fis = {"dummy": True, "set": nav_set, "median_m": r1(np.median(vals)),
           "edge_p10_m": r1(np.percentile(dmax[near_edge], 10)), "class_area_pct": pct}
    fis_file = "nav/fix_interval_summary.json"
    o.write_json(fis_file, fis)
    for kk in ("median_m", "edge_p10_m"):
        o.record(f"nav.fix_interval.{nav_set}.{kk}", fis[kk], "m", fis_file)
    for lab, v in pct.items():
        o.record(f"nav.fix_interval.{nav_set}.class_area_pct.{lab}", v, "%", fis_file)

    # ---- vector products on the web grid (10 m) ---------------------------------------------
    wgrid = Grid(res=web_res, n=len(range(0, grid.n, step)))
    assert wgrid.centre * step == grid.centre
    simplify_m = variants["outputs"]["simplify_tolerance_m"]
    band_feats, headline = [], {}

    def edge_features(g, b: int) -> list[dict]:
        """Band boundary split by cause (slope at the wall, data at the hole / CTX strip)."""
        parts: dict[int, list] = {0: [], 1: [], 2: []}
        for line in getattr(g.boundary, "geoms", [g.boundary]):
            c = np.asarray(shapely.segmentize(line, web_res).coords)
            mid = (c[:-1] + c[1:]) / 2
            cause = world.cause(mid[:, 0], mid[:, 1], buffer_m)
            start = 0
            for k in range(1, len(cause) + 1):
                if k == len(cause) or cause[k] != cause[start]:
                    parts[int(cause[start])].append(LineString(c[start:k + 1]))
                    start = k
        return [o.feature(MultiLineString(lines), {"budget": b, "cause": CAUSES[ci]})
                for ci, lines in parts.items() if lines]

    for sc, v in DUMMY_SCENARIOS.items():
        t10 = t_fields[sc][::step, ::step]
        iso_feats, regions = [], {}
        for m in iso_minutes:
            g = region_polygon(t10 <= m, wgrid, simplify_m)
            iso_feats.append(o.feature(g, {"minutes": m}))
            regions[m] = g
        o.write_json(f"scenarios/{sc}/isochrones.geojson", fc(iso_feats), compact=True)

        variant = VARIANT_OF[sc.split("_")[0]]
        edge_feats = []
        for b in band_budgets:
            g = regions[b]
            band_feats.append(o.feature(g, {"budget": b, "variant": variant, "scenario": sc}))
            edge_feats += edge_features(g, b)
        o.write_json(f"scenarios/{sc}/edges.geojson", fc(edge_feats), compact=True)

        r_partner = DUMMY_PARTNER_FRAC * v * max(band_budgets) * 60
        o.write_json(f"scenarios/{sc}/partner.geojson", fc([o.feature(
            circle(0, 0, r_partner), {"radius_m": r1(r_partner)})]), compact=True)
        o.record(f"partner_radius_m.{sc}", r1(r_partner), "m", f"scenarios/{sc}/partner.geojson")

        cells = np.count_nonzero(t_fields[sc] <= budgets[0]) * res * res
        flat = math.pi * (v * budgets[0] * 60) ** 2
        headline[sc] = r1(100 * cells / flat)
    o.write_json(f"scenarios/bands_{suit}.geojson", fc(band_feats), compact=True)

    lo, hi = min(headline.values()), max(headline.values())
    o.write_json("scenarios/index.json", {
        "dummy": True,
        "default": variants["scenarios"]["default"],
        "scenarios": [{
            "id": sc, "variant": VARIANT_OF[sc.split("_")[0]], "suit_kg": suit,
            "files": {"isochrones": f"scenarios/{sc}/isochrones.geojson",
                      "bands": f"scenarios/bands_{suit}.geojson",
                      "edges": f"scenarios/{sc}/edges.geojson",
                      "partner": f"scenarios/{sc}/partner.geojson"},
            "headline": {"budget_min": budgets[0], "reachable_pct": headline[sc],
                         "range_pct": [lo, hi]},
        } for sc in DUMMY_SCENARIOS]})
    for sc in DUMMY_SCENARIOS:
        o.record(f"reachable_pct.{sc}.{budgets[0]}", headline[sc], "%", "scenarios/index.json")
        o.record(f"reachable_pct_range.{sc}.{budgets[0]}.low", lo, "%", "scenarios/index.json")
        o.record(f"reachable_pct_range.{sc}.{budgets[0]}.high", hi, "%", "scenarios/index.json")

    # ---- stations, route, timeline -----------------------------------------------------------
    st_xy = {sid: polar(d, b) for sid, d, b in DUMMY_STATIONS}
    st_cfg = {s["id"]: s for s in stations_cfg["stations"]}
    values = rng.uniform(*DUMMY_STATION_VALUE_RANGE, size=len(DUMMY_STATIONS))
    dwell = stations_cfg["dwell_min"]
    v_route = DUMMY_SCENARIOS[rs]
    o2_start = crew["o2_budget"]["primary_L"]  # crew.yaml o2_budget.margin_uses = primary_L

    def t_at(sc: str, x: float, y: float) -> float:
        return r1(t_fields[sc][grid.pixel(x, y)])

    stops = [("pad", (0.0, 0.0))] + [(sid, st_xy[sid]) for sid, _, _ in DUMMY_STATIONS] \
        + [("pad", (0.0, 0.0))]
    legs, timeline, events = [], [], []  # events: (t_start, t_end, kind, data)
    t = 0.0

    def tl(ev: str, station, x: float, y: float) -> None:
        th = t_at(rs, x, y)
        timeline.append({"t_min": r1(t), "event": ev, "station": station,
                         "o2_left_L": r1(o2_start - DUMMY_O2_L_PER_MIN * t),
                         "t_home_min": th, "margin_min": r1(eva_min - reserve_min - t - th)})

    tl("depart", None, 0.0, 0.0)
    arrive, leave = {}, {}
    for k in range(len(stops) - 1):
        (a_id, (ax, ay)), (b_id, (bx, by)) = stops[k], stops[k + 1]
        assert not world.blocked_segment(ax, ay, bx, by), f"dummy leg {a_id}->{b_id} blocked"
        length = math.hypot(bx - ax, by - ay)
        dur = length / v_route / 60
        legs.append({"from": a_id, "to": b_id, "a": (ax, ay), "b": (bx, by), "length": length,
                     "t0": t, "t1": t + dur, "heading": float(bearing_deg(bx - ax, by - ay))})
        events.append((t, t + dur, "walk", len(legs) - 1))
        t += dur
        if b_id == "pad":
            tl("arrive_home", None, bx, by)
        else:
            arrive[b_id] = t
            tl("arrive", b_id, bx, by)
            events.append((t, t + dwell, "dwell", b_id))
            t += dwell
            leave[b_id] = t
            tl("leave", b_id, bx, by)
    t_end = t
    o.write_json(f"timeline_{rs}.json", timeline)
    o.record(f"timeline.{rs}.end_min", r1(t_end), "min", f"timeline_{rs}.json")
    for i, row in enumerate(timeline):
        for kk, u in (("t_min", "min"), ("o2_left_L", "L"), ("t_home_min", "min"),
                      ("margin_min", "min")):
            o.record(f"timeline.{rs}.{i}.{kk}", row[kk], u, f"timeline_{rs}.json")

    route_feats = []
    for i, lg in enumerate(legs):
        line = shapely.segmentize(LineString([lg["a"], lg["b"]]), web_res)
        route_feats.append(o.feature(line, {
            "leg": i + 1, "from": lg["from"], "to": lg["to"], "length_m": r1(lg["length"]),
            "speed_ms": v_route, "t_start_min": r1(lg["t0"]), "t_end_min": r1(lg["t1"])}))
        o.record(f"route.{rs}.leg{i + 1}.length_m", r1(lg["length"]), "m",
                 f"route_{rs}.geojson")
    o.write_json(f"route_{rs}.geojson", fc(route_feats), compact=True)

    hill_xy = world.hill_xy
    wall_mid = ((world.wall_a[0] + world.wall_b[0]) / 2, (world.wall_a[1] + world.wall_b[1]) / 2)
    r_partner_rs = DUMMY_PARTNER_FRAC * v_route * max(band_budgets) * 60
    st_json = []
    for (sid, d, _), val in zip(DUMMY_STATIONS, values, strict=True):
        x, y = st_xy[sid]
        lon, lat = geo.lonlat_pt(x, y)
        t_home = {sc: t_at(sc, x, y) for sc in DUMMY_SCENARIOS}
        st_json.append({
            "id": sid, "name": f"[DUMMY] {st_cfg[sid]['name']}", "lon": lon, "lat": lat,
            "value": r2(val), "objective": "DUMMY objective (synthetic world, not Mars data)",
            "tasks": ["DUMMY task A", "DUMMY task B"], "dwell_min": dwell,
            "t_home_min": t_home, "in_partner_line": bool(d <= r_partner_rs),
            "card": f"cards/{sid}.json"})
        for sc, th in t_home.items():
            o.record(f"t_home_min.{sid}.{sc}", th, "min", "stations.json")
        o.record(f"dwell_min.{sid}", dwell, "min", "stations.json")
        o.record(f"station_value.{sid}", r2(val), None, "stations.json")
        o.record(f"station_lon.{sid}", lon, "deg", "stations.json")
        o.record(f"station_lat.{sid}", lat, "deg", "stations.json")

        def lm(name: str, px: float, py: float, x=x, y=y) -> dict:
            return {"name": name, "bearing_deg": r1(bearing_deg(px - x, py - y)),
                    "dist_km": round(math.hypot(px - x, py - y) / 1000, 3)}

        turn_back = r1(eva_min - reserve_min - t_home[rs])
        # Synthetic landmarks only: real names come from config/landmarks.yaml with coordinates
        # verified at H0, which the dummy world does not have.
        landmarks = [lm("DUMMY synthetic hill", *hill_xy),
                     lm("DUMMY synthetic wall", *wall_mid), lm("Pad", 0.0, 0.0)]
        for j, lmk in enumerate(landmarks):
            for kk, u in (("bearing_deg", "deg"), ("dist_km", "km")):
                o.record(f"landmarks.{sid}.{j}.{kk}", lmk[kk], u, f"cards/{sid}.json")
        o.record(f"arrive_min.{sid}", r1(arrive[sid]), "min", f"cards/{sid}.json")
        o.record(f"leave_min.{sid}", r1(leave[sid]), "min", f"cards/{sid}.json")
        o.record(f"turn_back_min.{sid}", turn_back, "min", f"cards/{sid}.json")
        o.write_json(f"cards/{sid}.json", {
            "dummy": True,
            "navcam": {"sol": None, "image_id": None, "url_local": "cards/placeholder.png",
                       "overlay_png": None},
            "skyline_error_deg": {"near": None, "mid": None, "far": None},
            "panorama_png": None,
            "landmarks": landmarks,
            "timeline": {"arrive": r1(arrive[sid]), "leave": r1(leave[sid]),
                         "turn_back": turn_back},
            "margin_binding": "O2",
            "contingency": "DUMMY contingency: walk straight back to the pad.",
        })
    o.write_json("stations.json", st_json)

    img = Image.new("RGB", (320, 240), (DUMMY_PLACEHOLDER_GREY,) * 3)
    ImageDraw.Draw(img).text((100, 112), "DUMMY - no Navcam frame", fill=(235, 235, 235))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    o.write_bytes("cards/placeholder.png", buf.getvalue())

    # ---- trade table (rows = budgets, cols = suit masses) -------------------------------------
    masses = crew["suit_masses_kg"]
    in_disc = np.hypot(gx, gy) <= site["planning_radius_m"]
    disc_cells = np.count_nonzero(in_disc)
    unit = {"science_value": None, "reachable_pct": "%", "partner_area_km2": "km2"}
    cells = []
    for b in budgets:
        row = []
        for m in masses:
            r = v_route * (suit / m) ** DUMMY_TRADE_SPEED_EXP * b * 60
            reach = r1(100 * np.count_nonzero(in_disc & (dist <= r)) / disc_cells)
            # dummy science value: total station value scaled by the reachable fraction
            sci = r2(float(values.sum()) * reach / 100)
            rp = DUMMY_PARTNER_FRAC * r
            row.append({"science_value": sci, "reachable_pct": reach,
                        "partner_area_km2": round(math.pi * rp * rp / 1e6, 3)})
            for kk, vv in row[-1].items():
                o.record(f"trade.{b}.{m}.{kk}", vv, unit[kk], "trade_table.json")
        cells.append(row)
    o.write_json("trade_table.json", {"dummy": True, "rows": budgets, "cols": masses,
                                      "cells": cells})

    # ---- conditions/rad.json ------------------------------------------------------------------
    rad = DUMMY_RAD
    t0, t1 = (parse_utc(s) for s in conditions["rad"]["storm_window_utc"])
    hours = np.arange(0, (t1 - t0).total_seconds() / 3600 + 1e-9, rad["step_h"])
    on, pk = rad["onset_h"], rad["onset_h"] + rad["rise_h"]
    end = pk + rad["decay_h"]
    base, peak = rad["baseline_uGy_h"], rad["peak_uGy_h"]
    rate_h = np.interp(hours, [0, on, pk, end, hours[-1]], [base, base, peak, base, base])
    rate_day = rate_h * 24
    # tripwire, real rule (config/conditions.yaml rad.tripwire): factor x baseline for
    # consecutive_samples samples in a row; fires at the last of them.
    trip = conditions["rad"]["tripwire"]
    above = rate_day > trip["factor"] * base * 24
    n_c = trip["consecutive_samples"]
    trip_k = next(k for k in range(n_c - 1, len(above)) if above[k - n_c + 1:k + 1].all())
    excess_mgy = float(np.sum((rate_h[1:] + rate_h[:-1] - 2 * base) / 2 * np.diff(hours))) / 1000
    peak_day = float(rate_day.max())
    d_allow = conditions["leash"]["d_allow_mgy"]
    tau = 60 * d_allow / (peak_day / 24 / 1000)  # conditions.yaml leash.formula
    radj = {
        "dummy": True,
        "latest": {"utc": DUMMY_RAD_LATEST_UTC, "dose_rate_uGy_day": r1(base * 24),
                   "lag_days": DUMMY_RAD_LAG_DAYS},
        "baseline_uGy_day": r1(base * 24),
        "storm_2024": {
            "series": [[iso(t0 + timedelta(hours=float(h))), r1(v)]
                       for h, v in zip(hours, rate_day, strict=True)],
            "peak_uGy_day": r1(peak_day), "excess_mGy": round(excess_mgy, 3),
            "onset_utc": iso(t0 + timedelta(hours=on)),
            "tripwire_utc": iso(t0 + timedelta(hours=float(hours[trip_k]))),
        },
        "leash": {"D_allow_mGy": d_allow, "tau_min_at_peak": r1(tau)},
    }
    o.write_json("conditions/rad.json", radj)
    s24, lsh, lat_ = radj["storm_2024"], radj["leash"], radj["latest"]
    for k, val, u in (("rad.latest.utc", lat_["utc"], None),
                      ("rad.latest.dose_rate_uGy_day", lat_["dose_rate_uGy_day"], "uGy/day"),
                      ("rad.latest.lag_days", lat_["lag_days"], "days"),
                      ("rad.baseline_uGy_day", radj["baseline_uGy_day"], "uGy/day"),
                      ("rad.storm_2024.peak_uGy_day", s24["peak_uGy_day"], "uGy/day"),
                      ("rad.storm_2024.excess_mGy", s24["excess_mGy"], "mGy"),
                      ("rad.storm_2024.onset_utc", s24["onset_utc"], None),
                      ("rad.storm_2024.tripwire_utc", s24["tripwire_utc"], None),
                      ("rad.leash.D_allow_mGy", lsh["D_allow_mGy"], "mGy"),
                      ("rad.leash.tau_min_at_peak", lsh["tau_min_at_peak"], "min")):
        o.record(k, val, u, "conditions/rad.json")

    # ---- navigation ---------------------------------------------------------------------------
    drift = hud["fallback_drift"]
    pct_d = drift["pct_of_distance"] / 100
    floor = drift["sigma_floor_m"]

    def state(tm: float):
        """(x, y, dist_since_fix_m, heading_deg) at EVA minute tm (fixes at each stop)."""
        for e0, e1, kind, data in events:
            if e0 <= tm <= e1:
                if kind == "dwell":
                    return (*st_xy[data], 0.0, 0.0)
                lg = legs[data]
                f = 0.0 if e1 == e0 else (tm - e0) / (e1 - e0)
                (ax, ay), (bx, by) = lg["a"], lg["b"]
                return ax + f * (bx - ax), ay + f * (by - ay), f * lg["length"], lg["heading"]
        return 0.0, 0.0, 0.0, 0.0

    def ell(d: float, heading: float):
        r95 = max(pct_d * d, floor)
        return {"a_m": r2(r95), "b_m": r2(r95 * DUMMY_ELLIPSE_AXIS_RATIO),
                "theta_deg": r1((heading + 90) % 360)}, r2(r95)

    per_minute = []
    for tm in range(0, math.floor(t_end) + 1):
        _, _, d, hd = state(float(tm))
        e, r95 = ell(d, hd)
        per_minute.append({"t_eva_min": tm, "dist_since_fix_m": r1(d), "ellipse": e,
                           "r95_m": r95})
    mcf = f"nav/montecarlo_{nav_set}.json"
    o.write_json(mcf, {
        "dummy": True, "set": nav_set, "params": nav["sets"][nav_set],
        "runs": nav["monte_carlo"]["runs"], "per_minute": per_minute,
        "r95_fit": {"a": pct_d, "b": 0.0}}, compact=True)
    last = per_minute[-1]
    for k, val, u in ((f"nav.r95_fit.{nav_set}.a", pct_d, "1"),
                      (f"nav.r95_fit.{nav_set}.b", 0.0, "1/m"),
                      (f"nav.montecarlo.{nav_set}.runs", nav["monte_carlo"]["runs"], "1"),
                      (f"nav.montecarlo.{nav_set}.final.r95_m", last["r95_m"], "m"),
                      (f"nav.montecarlo.{nav_set}.final.a_m", last["ellipse"]["a_m"], "m"),
                      (f"nav.montecarlo.{nav_set}.final.t_eva_min", last["t_eva_min"], "min")):
        o.record(k, val, u, mcf)

    fsig = nav["fix_sigma_m"]
    fixes = [{"t_eva_min": 0.0, "station": None, "type": "rover", "sigma_m": fsig["rover"],
              "error_m": None, "image_id": None}]
    fixes += [{"t_eva_min": r1(arrive[sid]), "station": sid, "type": "station",
               "sigma_m": fsig["station"], "error_m": None, "image_id": None}
              for sid, _, _ in DUMMY_STATIONS]
    fixes.append({"t_eva_min": r1(t_end), "station": None, "type": "rover",
                  "sigma_m": fsig["rover"], "error_m": None, "image_id": None})
    o.write_json("nav/fixes.json", fixes)
    for i, fx in enumerate(fixes):
        o.record(f"nav.fixes.{i}.t_eva_min", fx["t_eva_min"], "min", "nav/fixes.json")
        o.record(f"nav.fixes.{i}.sigma_m", fx["sigma_m"], "m", "nav/fixes.json")

    true_line = shapely.segmentize(LineString([lg["a"] for lg in legs] + [legs[-1]["b"]]),
                                   web_res)
    est_parts = []
    for lg in legs:
        c = np.asarray(shapely.segmentize(LineString([lg["a"], lg["b"]]), web_res).coords)
        along = np.hypot(c[:, 0] - lg["a"][0], c[:, 1] - lg["a"][1])
        h = math.radians(lg["heading"] + 90)  # offset to the right of travel
        off = pct_d * along
        est_parts.append(LineString(np.column_stack([c[:, 0] + off * math.sin(h),
                                                     c[:, 1] + off * math.cos(h)])))
    track_feats = [
        o.feature(true_line, {"t_eva_min": r1(t_end), "kind": "true"}),
        o.feature(MultiLineString(est_parts), {"t_eva_min": r1(t_end), "kind": "estimated"}),
    ]
    for tm in range(0, math.floor(t_end) + 1, DUMMY_ELLIPSE_EVERY_MIN):
        x, y, d, hd = state(float(tm))
        e, r95 = ell(d, hd)
        track_feats.append(o.feature(ellipse(x, y, e["a_m"], e["b_m"], e["theta_deg"]),
                                     {"t_eva_min": tm, "kind": "ellipse95", **e, "r95_m": r95}))
    o.write_json(f"nav/tracks_{nav_set}.geojson", fc(track_feats), compact=True)

    # ---- pad.json (F8) ------------------------------------------------------------------------
    pad_lon, pad_lat = geo.pad_lonlat
    disc30 = np.hypot(gx, gy) <= crew["anchor"]["speed_ms"] * budgets[0] * 60
    unknown = hole | world.ctx(gx, gy)
    assessed30 = r1(100 * np.count_nonzero(disc30 & ~unknown) / np.count_nonzero(disc30))
    blk = site["siting"]["block_m"] / 2
    pad_block = (np.abs(gx) <= blk) & (np.abs(gy) <= blk)
    max_slope = r2(np.nanmax(slope5[pad_block]))
    rule_ok = bool(max_slope <= site["siting"]["max_slope_deg"]
                   and assessed30 >= site["coverage"]["pad_disc_assessed_min_pct"])
    alts = []
    for dd, bb in DUMMY_PAD_ALTERNATIVES:
        lon, lat = geo.lonlat_pt(*polar(dd, bb))
        alts.append({"lon": lon, "lat": lat, "elev_m": None, "score": r2(rng.uniform(0.5, 2.5))})
    alts.sort(key=lambda a: -a["score"])
    alts = [{"rank": k + 1, **a} for k, a in enumerate(alts)]
    o.write_json("pad.json", {
        "dummy": True,
        "pad": {"lon": pad_lon, "lat": pad_lat, "elev_m": None, "score": None,
                "checks": {"assessed_pct_30min": assessed30, "max_slope_deg": max_slope,
                           "rule_passed": rule_ok}},
        "alternatives": alts, "hop_options": [], "site_rule_version": DUMMY_SITE_RULE_VERSION})
    o.record("pad.lon", pad_lon, "deg", "pad.json")
    o.record("pad.lat", pad_lat, "deg", "pad.json")
    o.record("pad.checks.assessed_pct_30min", assessed30, "%", "pad.json")
    o.record("pad.checks.max_slope_deg", max_slope, "deg", "pad.json")
    o.record("pad.checks.rule_passed", rule_ok, None, "pad.json")

    # ---- fp3d ---------------------------------------------------------------------------------
    cp = DUMMY_NEAR_CHUNK_PX
    csz = cp * DUMMY_NEAR_RES_M
    nch = 2 * math.ceil((site["planning_radius_m"] - csz / 2) / csz) + 1  # pad-centred chunk
    x0, y0 = -nch * csz / 2, nch * csz / 2                                  # NW corner
    corridor = true_line.buffer(DUMMY_CORRIDOR_HALF_M)
    q = DUMMY_HEIGHT_QUANTUM_M

    def heights(xs: np.ndarray, ys: np.ndarray) -> bytes:
        xx, yy = np.meshgrid(xs, ys)
        hgt = np.round(world.elevation(xx, yy) / q) * q
        return gzip.compress(hgt.astype("<f4").tobytes(), compresslevel=9, mtime=0)

    tex = io.BytesIO()
    Image.new("RGB", (cp, cp), DUMMY_TAN_RGB).save(tex, format="JPEG", quality=85)
    chunks = []
    for j in range(nch):
        for i in range(nch):
            bx0, by1 = x0 + i * csz, y0 - j * csz
            if not corridor.intersects(box(bx0, by1 - csz, bx0 + csz, by1)):
                continue
            xs = bx0 + (np.arange(cp) + 0.5) * DUMMY_NEAR_RES_M
            ys = by1 - (np.arange(cp) + 0.5) * DUMMY_NEAR_RES_M
            o.write_bytes(f"fp3d/near/{i}_{j}.f32.gz", heights(xs, ys))
            o.write_bytes(f"fp3d/near_tex/{i}_{j}.jpg", tex.getvalue())
            w, s = geo.lonlat_pt(bx0, by1 - csz)
            e, n = geo.lonlat_pt(bx0 + csz, by1)
            chunks.append({"i": i, "j": j, "file": f"fp3d/near/{i}_{j}.f32.gz",
                           "tex": f"fp3d/near_tex/{i}_{j}.jpg", "bounds": [w, s, e, n]})
    nf = int(round(nch * csz / DUMMY_FAR_RES_M))
    fxs = x0 + (np.arange(nf) + 0.5) * DUMMY_FAR_RES_M
    o.write_bytes("fp3d/far.f32.gz", heights(fxs, -fxs))

    # horizon ring: simple ray cast from the pad at eye height, with curvature drop
    # (config/horizon.yaml curvature: drop = d^2 / (2 R))
    hz = cfg["horizon"]
    eye = hud["eye_height_m"]
    radius = site["crs"]["mars_radius_m"]
    az = np.arange(0, 360, hz["az_step_coarse_deg"])
    dd = np.arange(DUMMY_RAY_STEP_M, site["planning_radius_m"] + 1e-9, DUMMY_RAY_STEP_M)
    azr = np.radians(az)[:, None]
    hz_h = world.elevation(dd * np.sin(azr), dd * np.cos(azr)) - dd ** 2 / (2 * radius)
    h0 = float(world.elevation(0.0, 0.0)) + eye
    elev_deg = np.degrees(np.arctan2(hz_h - h0, dd)).max(axis=1)
    o.write_json("fp3d/horizon_ring.json", {
        "dummy": True, "observer": {"lon": pad_lon, "lat": pad_lat, "eye_height_m": eye},
        "az_step_deg": hz["az_step_coarse_deg"], "max_range_m": site["planning_radius_m"],
        "az_deg": [r2(a) for a in az], "elev_deg": [r2(e) for e in elev_deg]}, compact=True)

    fw, fs = geo.lonlat_pt(x0, -y0)
    fe, fn = geo.lonlat_pt(-x0, y0)
    o.write_json("fp3d/index.json", {
        "dummy": True,
        "bounds": [fw, fs, fe, fn],
        "chunk_grid": {"cols": nch, "rows": nch, "chunk_px": cp, "res_m": DUMMY_NEAR_RES_M,
                       "index": "i = column from west, j = row from north",
                       "origin_xy_m": [r2(geo.pad_xy[0] + x0), r2(geo.pad_xy[1] + y0)],
                       "crs": geo.analysis_proj, "chunks": chunks},
        "height_scale": 1.0,
        "height": {"dtype": "float32", "byte_order": "little", "row_order": "north_to_south",
                   "sample": "cell centres", "offset_m": 0.0, "units": "m",
                   "datum": "DUMMY: pad-relative synthetic heights (pad ground = 0)",
                   "nodata": "none (nodata hole filled with the synthetic surface)"},
        "far": {"file": "fp3d/far.f32.gz", "res_m": DUMMY_FAR_RES_M, "width": nf, "height": nf,
                "bounds": [fw, fs, fe, fn]},
        "horizon_ring": "fp3d/horizon_ring.json",
        "texture": "DUMMY flat tan JPEG per near chunk",
        "eye_height_m": eye,
    })

    # ---- scenarios/pads: D21 parking-option picker (contracts v1.1.4) -------------------------
    # Same synthetic model as the main scenarios (walking distance around the wall and hole /
    # speed, here on the 10 m web grid), nominal suit only, no isochrones or fields (C layout
    # 16:17). Score = station subsets whose straight-leg tour (DUMMY_STATIONS order, dwell each)
    # fits the EVA minus the reserve; tiebreak 1 = reachable % at the first budget (nominal),
    # tiebreak 2 = lower elevation (pad-relative synthetic heights). The official row is the pad
    # of pad.json.
    flat_v = {sc: v for sc, v in DUMMY_SCENARIOS.items()}
    sc_con = next(sc for sc in DUMMY_SCENARIOS if sc.startswith("con_"))
    sc_opt = next(sc for sc in DUMMY_SCENARIOS if sc.startswith("opt_"))

    def pad_tour(px: float, py: float, sids) -> tuple[float, list[tuple]]:
        pts = [("pad", (px, py))] + [(sid, st_xy[sid]) for sid in sids] + [("pad", (px, py))]
        legs_, t_ = [], 0.0
        for (a_id, a), (b_id, b) in zip(pts[:-1], pts[1:], strict=True):
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            dur = length / v_route / 60
            legs_.append((a_id, b_id, a, b, length, t_, t_ + dur))
            t_ += dur + (dwell if b_id != "pad" else 0.0)
        return t_, legs_

    def pad_reach(dist_p: np.ndarray, sc: str, b: int, off: float) -> float | None:
        r_flat = flat_v[sc] * b * 60
        if off + r_flat > grid.half:   # the flat disc leaves the grid: not computed (as WS2)
            return None
        cells = np.count_nonzero(dist_p / flat_v[sc] / 60.0 <= b) * web_res * web_res
        return r1(100 * cells / (math.pi * r_flat ** 2))

    sids_all = [sid for sid, _, _ in DUMMY_STATIONS]
    wgx, wgy = gx[::step, ::step], gy[::step, ::step]  # on the 10 m web grid (speed)
    cands = [(0.0, 0.0)] + [polar(dd, bb) for dd, bb in DUMMY_PICKER_PADS]
    pads_info = []
    for k, (px, py) in enumerate(cands):
        dist_p = dist[::step, ::step] if k == 0 else geodesic_distance(world, wgx, wgy,
                                                                        origin=(px, py))
        n_ok = sum(1 for m in range(1, 2 ** len(sids_all))
                   if pad_tour(px, py, [s_ for i, s_ in enumerate(sids_all) if m >> i & 1])[0]
                   <= eva_min - reserve_min)
        off = math.hypot(px, py)
        heads = {b: {"budget_min": b, "reachable_pct": pad_reach(dist_p, rs, b, off),
                     "range_pct": [pad_reach(dist_p, sc_con, b, off),
                                   pad_reach(dist_p, sc_opt, b, off)]} for b in band_budgets}
        lon, lat = geo.lonlat_pt(px, py)
        pads_info.append({"xy": (px, py), "dist": dist_p, "lon": lon, "lat": lat,
                          "elev": r1(float(world.elevation(px, py))), "score": n_ok,
                          "tb1": heads[budgets[0]]["reachable_pct"], "heads": heads,
                          "official": k == 0})
    pads_info.sort(key=lambda q: (-q["score"], -(q["tb1"] or 0.0), q["elev"]))
    assert pads_info[0]["official"], "dummy picker pad outranks the dummy official pad"
    tb1_name = f"reachable_pct_{budgets[0]}"
    pads_f = "scenarios/pads/index.json"
    rows = []
    for rank, q in enumerate(pads_info, start=1):
        pid = q["id"] = f"rank{rank}"
        row = {"id": pid, "kind": "dummy", "lon": q["lon"], "lat": q["lat"], "elev_m": q["elev"],
               "rank": rank, "score": q["score"], "official": q["official"],
               "picker": not q["official"],
               "tiebreak": {tb1_name: q["tb1"], "elev_m": q["elev"]},
               "summary": None if q["official"] else f"scenarios/pads/{pid}/summary.json"}
        rows.append(row)
        for kk, u in (("lon", "deg"), ("lat", "deg"), ("elev_m", "m"), ("rank", None),
                      ("score", None)):
            o.record(f"pads.{pid}.{kk}", row[kk], u, pads_f)
        for kk, val in row["tiebreak"].items():
            o.record(f"pads.{pid}.tiebreak.{kk}", val, "m" if kk == "elev_m" else "%", pads_f)
    official_id = next(q["id"] for q in pads_info if q["official"])
    o.write_json(pads_f, {
        "dummy": True, "scenario": rs, "score_kind": "dummy_feasible_eva_count",
        "order": "DUMMY: feasible station subsets desc; tiebreak 1 reachable % at "
                 f"{budgets[0]} min desc; tiebreak 2 elevation asc",
        "official": official_id, "decision": "D21 (dummy picker, synthetic world)",
        "ids": "rank{n} = dummy D21 rank n", "pads": rows})

    for q in pads_info:
        if q["official"]:
            continue
        pid, (px, py), dist_p = q["id"], q["xy"], q["dist"]
        d = f"scenarios/pads/{pid}"
        t_p = dist_p / v_route / 60.0
        pb, pe = [], []
        for b in band_budgets:
            g = region_polygon(t_p <= b, wgrid, simplify_m)
            pb.append(o.feature(g, {"budget": b, "variant": VARIANT_OF[rs.split("_")[0]],
                                    "scenario": rs}))
            pe += edge_features(g, b)
        o.write_json(f"{d}/bands_{suit}.geojson", fc(pb), compact=True)
        o.write_json(f"{d}/edges.geojson", fc(pe), compact=True)
        o.write_json(f"{d}/partner.geojson", fc([o.feature(
            circle(px, py, r_partner_rs), {"radius_m": r1(r_partner_rs)})]), compact=True)

        t_tot, plegs = pad_tour(px, py, sids_all)
        feats: list[dict] = []
        tl_rows: list[dict] = []

        def tl_row(ev: str, station, t_: float, x: float, y: float,
                   t_p=t_p, tl_rows=tl_rows) -> None:
            th = r1(t_p[wgrid.pixel(x, y)])
            tl_rows.append({"t_min": r1(t_), "event": ev, "station": station,
                            "o2_left_L": r1(o2_start - DUMMY_O2_L_PER_MIN * t_),
                            "t_home_min": th, "margin_min": r1(eva_min - reserve_min - t_ - th)})

        tl_row("depart", None, 0.0, px, py)
        for i, (a_id, b_id, a, b, length, t0, t1) in enumerate(plegs, start=1):
            assert not world.blocked_segment(*a, *b), f"dummy pad {pid} leg {a_id}->{b_id}"
            props = {"leg": i, "from": a_id, "to": b_id, "length_m": r1(length),
                     "t_min": r1(t1 - t0), "o2_L": r1(DUMMY_O2_L_PER_MIN * (t1 - t0)),
                     "t_start_min": r1(t0), "t_end_min": r1(t1)}
            feats.append(o.feature(shapely.segmentize(LineString([a, b]), web_res), props))
            for kk, u in (("t_min", "min"), ("length_m", "m"), ("o2_L", "L")):
                o.record(f"pads.{pid}.route.leg.{i}.{kk}", props[kk], u, f"{d}/route_{rs}.geojson")
            if b_id == "pad":
                tl_row("return", None, t1, *b)
            else:
                tl_row("arrive", b_id, t1, *b)
                tl_row("leave", b_id, t1 + dwell, *b)
        o.write_json(f"{d}/route_{rs}.geojson", fc(feats), compact=True)
        o.write_json(f"{d}/timeline_{rs}.json", tl_rows)
        for i, row in enumerate(tl_rows):
            for kk, u in (("t_min", "min"), ("o2_left_L", "L"), ("t_home_min", "min"),
                          ("margin_min", "min")):
                o.record(f"pads.{pid}.timeline.{i}.{kk}", row[kk], u, f"{d}/timeline_{rs}.json")

        heads = {str(b): h for b, h in q["heads"].items()}
        o.write_json(f"{d}/summary.json", {
            "dummy": True, "id": pid, "kind": "dummy", "scenario": rs,
            "pad": {"lon": q["lon"], "lat": q["lat"], "elev_m": q["elev"]},
            "rank": rows[pads_info.index(q)]["rank"], "official": False, "score": q["score"],
            "score_kind": "dummy_feasible_eva_count",
            "tiebreak": rows[pads_info.index(q)]["tiebreak"], "headline": heads,
            "route": {"stops": sids_all, "total_min": r1(t_tot),
                      "n_feasible_subsets": q["score"]},
            "files": {"bands": f"{d}/bands_{suit}.geojson", "edges": f"{d}/edges.geojson",
                      "partner": f"{d}/partner.geojson", "route": f"{d}/route_{rs}.geojson",
                      "timeline": f"{d}/timeline_{rs}.json"},
            "note": "DUMMY parking option (synthetic world, not Mars data)"})
        sf = f"{d}/summary.json"
        o.record(f"pads.{pid}.score", q["score"], None, sf)
        o.record(f"pads.{pid}.route.total_min", r1(t_tot), "min", sf)
        for b, h in heads.items():
            o.record(f"pads.{pid}.headline.{b}.reachable_pct", h["reachable_pct"], "%", sf)
            o.record(f"pads.{pid}.headline.{b}.range_pct.low", h["range_pct"][0], "%", sf)
            o.record(f"pads.{pid}.headline.{b}.range_pct.high", h["range_pct"][1], "%", sf)

    # ---- manifest last --------------------------------------------------------------------------
    o.write_json("manifest.json", {"dummy": True, **o.manifest})
    return o.written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=OUT_DIR, help="output tree (data-dummy)")
    ap.add_argument("-q", "--quiet", action="store_true", help="print only the summary line")
    args = ap.parse_args(argv)
    t0 = time.perf_counter()
    files = generate(args.out)
    total = 0
    for p in sorted(files):
        size = p.stat().st_size
        total += size
        if not args.quiet:
            print(f"{size:>10,}  {p.relative_to(args.out).as_posix()}")
    print(f"make_dummy: {len(files)} files, {total / 2**20:.2f} MiB in "
          f"{time.perf_counter() - t0:.1f} s -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

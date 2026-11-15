"""Point-horizon ray engine (F12; SPEC §2.2): 1,440 rays, multi-resolution DEM sampling, curvature.

Elevation angle of a terrain sample at horizontal distance d:
    el = atan((z - z0 - d^2 / (2 R)) / d)        (horizon.yaml ``curvature``, R from site.yaml)
The horizon is the running maximum along the ray; the engine also records the distance to the
horizon point and the DEM source it came from.

Sampling follows horizon.yaml ``sampling`` (1 m on dem_1m, 20 m to 30 km on ctx_20m, 200 m to
80 km on mola_hrsc_200m). A segment with ``handover: band_edge`` (dem_1m; C decision 2026-11-14
12:35) runs on each ray to max(to_m, the distance where the ray leaves its band's valid extent),
capped at the next segment's to_m; the next segment's samples start one of its steps after that
handover. The valid extent is the bounding box of the band's valid pixel centres. A sample with no
data in its configured source falls back to the next coarser source supplied (horizon.yaml
``band_fallback``, assumed). Rays with no valid sample stay NaN ("unknown stays unknown").

Conventions: bands are north-up rasters in the analysis CRS (metres); azimuth is clockwise from
grid north (= true north in the equirectangular analysis CRS); bilinear interpolation between
pixel centres; any NaN neighbour makes the sample invalid.

API for WS9 (F22): ``HorizonEngine(bands).horizon(x, y, ...)`` for one observer and
``HorizonEngine.horizons(xs, ys, az_step_deg=..., min_dist_m=...)`` for a candidate grid.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numba
import numpy as np

from pipeline.horizon import config as hcfg


def curvature_drop(d_m, radius_m: float | None = None):
    """Height drop of a sphere below the tangent plane at distance d: d^2 / (2 R)."""
    r = hcfg.mars_radius_m() if radius_m is None else float(radius_m)
    out = np.asarray(d_m, dtype=float) ** 2 / (2.0 * r)
    return float(out) if out.ndim == 0 else out


@dataclass
class DemBand:
    """A north-up elevation raster in the analysis CRS. ``z`` uses NaN for no data."""

    source: str
    z: np.ndarray
    x0: float  # left edge of column 0
    y0: float  # top edge of row 0
    dx: float  # > 0
    dy: float  # < 0 (north-up)
    _vbox: np.ndarray | None = field(default=None, repr=False, compare=False)  # valid_box cache

    @classmethod
    def from_transform(cls, source: str, z: np.ndarray, gt, nodata=None) -> DemBand:
        """``gt`` is a GDAL geotransform (x0, dx, rx, y0, ry, dy)."""
        x0, dx, rx, y0, ry, dy = (float(v) for v in gt)
        if rx != 0.0 or ry != 0.0 or dx <= 0.0 or dy >= 0.0:
            raise ValueError(f"{source}: only north-up, unrotated rasters are supported")
        z = np.array(z, dtype=np.float32, copy=True)
        if nodata is not None and not np.isnan(nodata):
            z[z == nodata] = np.nan
        return cls(source, z, x0, y0, dx, dy)

    @classmethod
    def from_geotiff(cls, path, source: str) -> DemBand:
        import rasterio  # noqa: PLC0415

        with rasterio.open(path) as ds:
            z = ds.read(1, masked=False).astype(np.float32)
            t = ds.transform
            return cls.from_transform(source, z, (t.c, t.a, t.b, t.f, t.d, t.e), ds.nodata)


@dataclass
class HorizonProfile:
    az_deg: np.ndarray
    elevation_deg: np.ndarray
    distance_m: np.ndarray
    source: list
    observer: dict
    eye_height_m: float
    az_step_deg: float
    min_dist_m: float = 0.0
    meta: dict = field(default_factory=dict)

    def elevation_at(self, az_deg):
        """Linear interpolation of elevation over azimuth, with 360 deg wrap."""
        return _interp_wrap(az_deg, self.az_deg, self.elevation_deg)

    def distance_at(self, az_deg):
        """Distance of the nearest ray's horizon point (no interpolation across occlusions)."""
        i = np.rint(np.asarray(az_deg, dtype=float) % 360.0 / self.az_step_deg).astype(int)
        return self.distance_m[i % self.az_deg.size]

    def distance_class(self, distance_m=None):
        return classify_distance(self.distance_m if distance_m is None else distance_m)

    def to_dict(self, observer_id: str) -> dict:
        def f(a, nd):
            return [None if not np.isfinite(v) else round(float(v), nd) for v in a]

        return {
            "observer_id": observer_id,
            "observer": self.observer,
            "eye_height_m": self.eye_height_m,
            "az_step_deg": self.az_step_deg,
            "min_dist_m": self.min_dist_m,
            "radius_m": hcfg.mars_radius_m(),
            "azimuth_convention": "deg clockwise from grid north (analysis CRS)",
            "elevation_deg": f(self.elevation_deg, 6),
            "distance_m": f(self.distance_m, 1),
            "source": list(self.source),
            **({"meta": self.meta} if self.meta else {}),
        }

    def write_json(self, path, observer_id: str) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(observer_id), separators=(",", ":")))
        return path

    @classmethod
    def read_json(cls, path) -> HorizonProfile:
        d = json.loads(Path(path).read_text())
        n = len(d["elevation_deg"])
        return cls(
            az_deg=np.arange(n) * d["az_step_deg"],
            elevation_deg=np.array([np.nan if v is None else v for v in d["elevation_deg"]]),
            distance_m=np.array([np.nan if v is None else v for v in d["distance_m"]]),
            source=d["source"], observer=d["observer"], eye_height_m=d["eye_height_m"],
            az_step_deg=d["az_step_deg"], min_dist_m=d.get("min_dist_m", 0.0),
            meta=d.get("meta", {}),
        )


def classify_distance(distance_m) -> np.ndarray:
    """'near' (< 0.5 km), 'mid' (0.5-2 km), 'far' (> 2 km) from horizon.yaml distance_classes_km;
    'unknown' for NaN."""
    lo, hi = hcfg.distance_classes_m()
    d = np.asarray(distance_m, dtype=float)
    out = np.where(d < lo, "near", np.where(d <= hi, "mid", "far")).astype(object)
    out[~np.isfinite(d)] = "unknown"
    return out


def valid_box(band: DemBand) -> np.ndarray:
    """(xmin, xmax, ymin, ymax) of the band's valid pixel centres; NaN if it has no data.
    Cached on the band (its ``z`` is not modified after the engine is built)."""
    if band._vbox is None:
        band._vbox = _valid_box(band)
    return band._vbox


def _valid_box(band: DemBand) -> np.ndarray:
    ok = np.isfinite(band.z)
    rows = np.flatnonzero(ok.any(axis=1))
    cols = np.flatnonzero(ok.any(axis=0))
    if rows.size == 0:
        return np.full(4, np.nan)
    xs = band.x0 + (np.array([cols[0], cols[-1]]) + 0.5) * band.dx
    ys = band.y0 + (np.array([rows[-1], rows[0]]) + 0.5) * band.dy  # dy < 0: last row = ymin
    return np.array([xs[0], xs[1], ys[0], ys[1]], dtype=float)


def _interp_wrap(x, xp, fp):
    x = np.asarray(x, dtype=float) % 360.0
    xp2 = np.concatenate([xp, [xp[0] + 360.0]])
    fp2 = np.concatenate([fp, [fp[0]]])
    return np.interp(x, xp2, fp2)


# ---------------------------------------------------------------------------------------------
# Numba kernels
# ---------------------------------------------------------------------------------------------

@numba.njit(cache=True, inline="always")
def _sample(data, off, nrow, ncol, x0, y0, dx, dy, b, x, y):
    fc = (x - x0[b]) / dx[b] - 0.5
    fr = (y - y0[b]) / dy[b] - 0.5
    nc = ncol[b]
    nr = nrow[b]
    if fc < 0.0 or fr < 0.0 or fc > nc - 1 or fr > nr - 1:
        return np.nan
    c0 = int(fc)
    r0 = int(fr)
    if c0 >= nc - 1:
        c0 = nc - 2 if nc > 1 else 0
    if r0 >= nr - 1:
        r0 = nr - 2 if nr > 1 else 0
    tc = fc - c0
    tr = fr - r0
    c1 = c0 + 1 if nc > 1 else c0
    r1 = r0 + 1 if nr > 1 else r0
    base = off[b]
    z00 = data[base + r0 * nc + c0]
    z01 = data[base + r0 * nc + c1]
    z10 = data[base + r1 * nc + c0]
    z11 = data[base + r1 * nc + c1]
    # weight-aware NaN check: a NaN neighbour with zero weight is ignored (exact pixel centres)
    v = 0.0
    w = (1.0 - tr) * (1.0 - tc)
    if w > 0.0:
        if z00 != z00:
            return np.nan
        v += w * z00
    w = (1.0 - tr) * tc
    if w > 0.0:
        if z01 != z01:
            return np.nan
        v += w * z01
    w = tr * (1.0 - tc)
    if w > 0.0:
        if z10 != z10:
            return np.nan
        v += w * z10
    w = tr * tc
    if w > 0.0:
        if z11 != z11:
            return np.nan
        v += w * z11
    return v


@numba.njit(cache=True)
def _ground(data, off, nrow, ncol, x0, y0, dx, dy, x, y):
    for b in range(off.size):
        v = _sample(data, off, nrow, ncol, x0, y0, dx, dy, b, x, y)
        if v == v:
            return v
    return np.nan


@numba.njit(cache=True, inline="always")
def _ray_exit(ox, oy, sa, ca, xmin, xmax, ymin, ymax):
    """Distance along the ray (direction (sa, ca)) at which it leaves the box for the last time;
    0 if the ray never meets the box ahead of the observer (or the box is empty / NaN)."""
    if not (xmin <= xmax and ymin <= ymax):
        return 0.0
    t_in = -np.inf
    t_out = np.inf
    if sa != 0.0:
        t1 = (xmin - ox) / sa
        t2 = (xmax - ox) / sa
        t_in = max(t_in, min(t1, t2))
        t_out = min(t_out, max(t1, t2))
    elif ox < xmin or ox > xmax:
        return 0.0
    if ca != 0.0:
        t1 = (ymin - oy) / ca
        t2 = (ymax - oy) / ca
        t_in = max(t_in, min(t1, t2))
        t_out = min(t_out, max(t1, t2))
    elif oy < ymin or oy > ymax:
        return 0.0
    if t_out < 0.0 or t_out < t_in:
        return 0.0
    return t_out


@numba.njit(cache=True, inline="always")
def _seg_end(s, ox, oy, sa, ca, seg_d1, seg_hband, vbox):
    """End distance of segment ``s`` on this ray (handover rule for ``band_edge`` segments)."""
    end = seg_d1[s]
    hb = seg_hband[s]
    if hb >= 0:
        ex = _ray_exit(ox, oy, sa, ca, vbox[hb, 0], vbox[hb, 1], vbox[hb, 2], vbox[hb, 3])
        if ex > end:
            end = ex
        if s + 1 < seg_d1.size and end > seg_d1[s + 1]:
            end = seg_d1[s + 1]
    return end


@numba.njit(cache=True)
def _handover_kernel(ox, oy, az_rad, s, seg_d1, seg_hband, vbox, out):
    for j in range(az_rad.size):
        out[j] = _seg_end(s, ox, oy, math.sin(az_rad[j]), math.cos(az_rad[j]),
                          seg_d1, seg_hband, vbox)


@numba.njit(parallel=True, cache=True)
def _horizon_kernel(obs_x, obs_y, obs_z, az_rad, seg_d0, seg_d1, seg_step, seg_band,
                    seg_hband, vbox, data, off, nrow, ncol, x0, y0, dx, dy, radius, min_dist,
                    out_el, out_dist, out_src):
    n_obs = obs_x.size
    n_az = az_rad.size
    n_band = off.size
    for k in numba.prange(n_obs * n_az):
        i = k // n_az
        j = k - i * n_az
        sa = math.sin(az_rad[j])
        ca = math.cos(az_rad[j])
        best = -np.inf
        best_d = np.nan
        best_b = -1
        prev_end = 0.0
        for s in range(seg_d0.size):
            step = seg_step[s]
            end = _seg_end(s, obs_x[i], obs_y[i], sa, ca, seg_d1, seg_hband, vbox)
            start = prev_end + step
            n = int(math.floor((end - start) / step + 1e-9)) + 1
            if end > prev_end:
                prev_end = end
            for m in range(n):
                d = start + m * step
                if d < min_dist or d <= 0.0:
                    continue
                x = obs_x[i] + d * sa
                y = obs_y[i] + d * ca
                z = np.nan
                used = -1
                for b in range(seg_band[s], n_band):
                    z = _sample(data, off, nrow, ncol, x0, y0, dx, dy, b, x, y)
                    if z == z:
                        used = b
                        break
                if used < 0:
                    continue
                t = (z - obs_z[i] - d * d / (2.0 * radius)) / d
                if t > best:
                    best = t
                    best_d = d
                    best_b = used
        if best_b >= 0:
            out_el[i, j] = math.degrees(math.atan(best))
            out_dist[i, j] = best_d
            out_src[i, j] = best_b
        else:
            out_el[i, j] = np.nan
            out_dist[i, j] = np.nan
            out_src[i, j] = -1


# ---------------------------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------------------------

class HorizonEngine:
    """Ray-casting horizon engine over a fine-to-coarse stack of DEM bands.

    ``bands``: DemBand objects whose ``source`` names match horizon.yaml ``sampling`` sources.
    Missing sources are allowed (their distance range falls back to the next coarser band given).
    """

    def __init__(self, bands, cfg: dict | None = None, radius_m: float | None = None):
        self.cfg = hcfg.load() if cfg is None else cfg
        self.radius_m = hcfg.mars_radius_m() if radius_m is None else float(radius_m)
        fb = hcfg.value(self.cfg.get("band_fallback", "coarser"))
        if fb != "coarser":
            raise ValueError(f"band_fallback {fb!r} not supported (only 'coarser')")
        order = [s["source"] for s in self.cfg["sampling"]]
        by_src = {b.source: b for b in bands}
        unknown = set(by_src) - set(order)
        if unknown:
            raise ValueError(f"bands with unknown sources {sorted(unknown)}; expected {order}")
        self.bands = [by_src[s] for s in order if s in by_src]
        if not self.bands:
            raise ValueError("no DEM bands")
        self.source_names = [b.source for b in self.bands]
        self._pack()
        # segments: (nominal d_start, nominal d_end, step, first band index allowed,
        # handover band index (-1 = end at to_m)); valid boxes per band for the handover rule
        d0s, d1s, steps, sb, hb = [], [], [], [], []
        self._vbox = np.full((len(self.bands), 4), np.nan)
        prev = 0.0
        for s in self.cfg["sampling"]:
            step = float(s["step_m"])
            d0s.append(prev + step)
            d1s.append(float(s["to_m"]))
            steps.append(step)
            later = [i for i, name in enumerate(self.source_names)
                     if order.index(name) >= order.index(s["source"])]
            sb.append(later[0] if later else len(self.bands))
            hb.append(self._handover_band(s))
            prev = float(s["to_m"])
        self._seg = (np.array(d0s), np.array(d1s), np.array(steps), np.array(sb, dtype=np.int64),
                     np.array(hb, dtype=np.int64))

    def _handover_band(self, seg: dict) -> int:
        """Band whose valid extent sets this segment's end (``handover: band_edge``), or -1."""
        rule = seg.get("handover")
        if rule is None:
            return -1
        if rule != "band_edge":
            raise ValueError(f"sampling handover {rule!r} not supported (only 'band_edge')")
        if seg["source"] not in self.source_names:
            return -1  # band missing: the segment ends at to_m and falls back to coarser bands
        i = self.source_names.index(seg["source"])
        self._vbox[i] = valid_box(self.bands[i])
        return i

    def handover_m(self, x: float, y: float, az_deg, source: str | None = None) -> np.ndarray:
        """Per-azimuth end distance of the ``handover: band_edge`` segment (default: the first
        one) for an observer at (x, y): max(to_m, where the ray leaves the band's valid extent),
        capped at the next segment's to_m."""
        hbs = self._seg[4]
        segs = [k for k, s in enumerate(self.cfg["sampling"])
                if s.get("handover") and (source is None or s["source"] == source)]
        if not segs:
            raise ValueError("no handover segment in sampling")
        az = np.radians(np.atleast_1d(np.asarray(az_deg, dtype=float)))
        out = np.empty(az.size)
        _handover_kernel(float(x), float(y), az, segs[0], self._seg[1], hbs, self._vbox, out)
        return out

    def _pack(self):
        sizes = [b.z.size for b in self.bands]
        self._data = np.concatenate([b.z.ravel().astype(np.float32) for b in self.bands])
        self._off = np.concatenate([[0], np.cumsum(sizes)[:-1]]).astype(np.int64)
        self._nrow = np.array([b.z.shape[0] for b in self.bands], dtype=np.int64)
        self._ncol = np.array([b.z.shape[1] for b in self.bands], dtype=np.int64)
        self._x0 = np.array([b.x0 for b in self.bands])
        self._y0 = np.array([b.y0 for b in self.bands])
        self._dx = np.array([b.dx for b in self.bands])
        self._dy = np.array([b.dy for b in self.bands])

    def _geo(self):
        return (self._data, self._off, self._nrow, self._ncol, self._x0, self._y0,
                self._dx, self._dy)

    def ground_z(self, x: float, y: float) -> float:
        """Terrain height at (x, y) from the finest band with data (NaN if none)."""
        return float(_ground(*self._geo(), float(x), float(y)))

    def horizons(self, xs, ys, *, eye_height_m: float | None = None, z_obs=None,
                 az_step_deg: float | None = None, min_dist_m: float = 0.0):
        """Batch horizons. Returns (elevation_deg, distance_m, source_index), each (n_obs, n_az);
        source_index is an index into ``self.source_names`` (-1 = no data)."""
        xs = np.atleast_1d(np.asarray(xs, dtype=float))
        ys = np.atleast_1d(np.asarray(ys, dtype=float))
        h = self.cfg["eye_height_m"] if eye_height_m is None else float(eye_height_m)
        if z_obs is None:
            zs = np.array([self.ground_z(x, y) for x, y in zip(xs, ys, strict=True)]) + h
        else:
            zs = np.broadcast_to(np.asarray(z_obs, dtype=float), xs.shape).copy()
        step = self.cfg["az_step_deg"] if az_step_deg is None else float(az_step_deg)
        n_az = int(round(360.0 / step))
        az = np.radians(np.arange(n_az) * step)
        el = np.empty((xs.size, n_az))
        dist = np.empty((xs.size, n_az))
        src = np.empty((xs.size, n_az), dtype=np.int64)
        _horizon_kernel(xs, ys, zs, az, *self._seg, self._vbox, *self._geo(), self.radius_m,
                        float(min_dist_m), el, dist, src)
        el[~np.isfinite(zs)] = np.nan  # observer off the DEM: unknown
        return el, dist, src

    def horizon(self, x: float, y: float, *, eye_height_m: float | None = None,
                z_obs: float | None = None, az_step_deg: float | None = None,
                min_dist_m: float = 0.0) -> HorizonProfile:
        h = self.cfg["eye_height_m"] if eye_height_m is None else float(eye_height_m)
        step = self.cfg["az_step_deg"] if az_step_deg is None else float(az_step_deg)
        el, dist, src = self.horizons([x], [y], eye_height_m=h, z_obs=z_obs,
                                      az_step_deg=step, min_dist_m=min_dist_m)
        zg = self.ground_z(x, y)
        z0 = float(z_obs) if z_obs is not None else zg + h
        return HorizonProfile(
            az_deg=np.arange(el.shape[1]) * step,
            elevation_deg=el[0], distance_m=dist[0],
            source=[self.source_names[s] if s >= 0 else None for s in src[0]],
            observer={"x": float(x), "y": float(y), "z": z0,
                      "z_ground": None if math.isnan(zg) else zg},
            eye_height_m=h, az_step_deg=step, min_dist_m=float(min_dist_m),
        )

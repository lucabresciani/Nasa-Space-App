"""Pedestrian dead-reckoning error model (F21; SPEC §2.4). Simulated, not a real system.

Per time step ``dt`` (``nav.yaml monte_carlo.dt_s``) the crew walks a true distance ``d`` along a
true heading. The suit's estimate (all parameters from ``config/nav.yaml``, conventions in
``nav.yaml model_conventions``):

* distance  d_est = d * s + sum over the n = d / L steps of N(0, step_noise_frac * L)
            (+ on slopes above ``slip_min_slope_deg``: sum of N(0, slip * sin(slope) * L))
            with a per-run scale factor s ~ N(1, sigma_s) and L = ``step_m``;
* heading   psi_est = psi_true + dpsi, where dpsi starts at psi0 ~ N(0, psi0_deg) after every
            fix, and integrates a per-run gyro bias b_g ~ N(0, sigma_b_deg_h) and an angle random
            walk N(0, psi_rw_deg_sqrt_min * sqrt(dt_min)); the step uses dpsi at mid-interval.
            Mars has no global magnetic field, so nothing corrects the heading.

A fix (rover pad, surveyed station, F22 skyline) resets the position error to N(0, sigma) per
axis and the heading error to a new psi0 draw (the gyro bias is a property of the sensor and
stays).

Coordinates: local metres (x east, y north) relative to ``Trajectory.origin_xy`` in the analysis
CRS (site.yaml ``crs.analysis_proj``); headings and azimuths are clockwise from grid north.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field, replace
from functools import cache
from pathlib import Path

import numpy as np
import yaml

REPO = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO / "config"

FIX_TYPES = ("rover", "station", "skyline")


# --------------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------------

@cache
def _yaml(name: str) -> dict:
    return yaml.safe_load((CONFIG_DIR / f"{name}.yaml").read_text())


def load_config() -> dict:
    """config/nav.yaml (do not mutate)."""
    return _yaml("nav")


def crew_config() -> dict:
    return _yaml("crew")


def site_config() -> dict:
    return _yaml("site")


def walking_speed_ms() -> float:
    """Synthetic-route walking speed: the crew.yaml anchor speed (0.98 m/s, SPEC F3/F21)."""
    return float(crew_config()["anchor"]["speed_ms"])


# --------------------------------------------------------------------------------------------
# Coordinates (analysis CRS <-> Mars 2000 lon/lat)
# --------------------------------------------------------------------------------------------

@cache
def _transformers():
    from pyproj import Transformer  # noqa: PLC0415

    crs = site_config()["crs"]
    geo = f"+proj=longlat +R={crs['mars_radius_m']} +no_defs"
    fwd = Transformer.from_crs(geo, crs["analysis_proj"], always_xy=True)
    inv = Transformer.from_crs(crs["analysis_proj"], geo, always_xy=True)
    return fwd, inv


def lonlat_to_xy(lon, lat):
    return _transformers()[0].transform(lon, lat)


def xy_to_lonlat(x, y):
    return _transformers()[1].transform(x, y)


def pad_lonlat() -> tuple[float, float]:
    """site.yaml pad_default (verify_at_h0); origin of synthetic routes."""
    p = site_config()["pad_default"]
    return float(p["lon"]), float(p["lat"])


def pad_xy() -> tuple[float, float]:
    x, y = lonlat_to_xy(*pad_lonlat())
    return float(x), float(y)


# --------------------------------------------------------------------------------------------
# Parameters
# --------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class NavParams:
    """One dead-reckoning parameter set (nav.yaml ``sets`` + the shared step constants)."""

    name: str
    sigma_s: float              # per-run step-scale sigma (fraction)
    sigma_b_deg_h: float        # gyro bias sigma (deg/h)
    psi0_deg: float             # initial heading error sigma after a fix (deg)
    psi_rw_deg_sqrt_min: float  # heading random walk (deg/sqrt(min))
    slip: float                 # slip factor (fraction of step per sin(slope))
    step_m: float
    step_noise_frac: float
    slip_min_slope_deg: float

    @classmethod
    def from_config(cls, set_name: str | None = None, cfg: dict | None = None) -> NavParams:
        cfg = load_config() if cfg is None else cfg
        name = cfg["default_set"] if set_name is None else set_name
        s = cfg["sets"][name]
        return cls(
            name=name,
            sigma_s=float(s["sigma_s"]),
            sigma_b_deg_h=float(s["sigma_b_deg_h"]),
            psi0_deg=float(s["psi0_deg"]),
            psi_rw_deg_sqrt_min=float(s["psi_rw_deg_sqrt_min"]),
            slip=float(s["slip"]),
            step_m=float(cfg["step_m"]),
            step_noise_frac=float(cfg["step_noise_frac"]),
            slip_min_slope_deg=float(cfg["slip_min_slope_deg"]),
        )

    def replace(self, **kw) -> NavParams:
        return replace(self, **kw)

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------------------------
# Fix events
# --------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class FixEvent:
    """A position fix (contracts/fixes.schema.json). ``error_m``/``image_id``: skyline only."""

    t_eva_min: float
    type: str
    sigma_m: float
    station: str | None = None
    error_m: float | None = None
    image_id: str | None = None

    def __post_init__(self):
        if self.type not in FIX_TYPES:
            raise ValueError(f"fix type {self.type!r} not in {FIX_TYPES}")
        if self.type == "skyline" and (self.error_m is None or self.image_id is None):
            raise ValueError("a skyline fix needs error_m and image_id")
        if not (self.sigma_m >= 0):
            raise ValueError("sigma_m must be >= 0")

    def to_dict(self) -> dict:
        return {"t_eva_min": float(self.t_eva_min), "station": self.station, "type": self.type,
                "sigma_m": float(self.sigma_m),
                "error_m": None if self.error_m is None else float(self.error_m),
                "image_id": self.image_id}


# --------------------------------------------------------------------------------------------
# Trajectories
# --------------------------------------------------------------------------------------------

@dataclass
class Trajectory:
    """True track sampled every dt: times (s since EVA start), local x/y (m), slope per interval."""

    t_s: np.ndarray
    x: np.ndarray
    y: np.ndarray
    slope_deg: np.ndarray            # (n - 1,) slope underfoot on each interval
    origin_xy: tuple[float, float] = field(default_factory=pad_xy)
    label: str = "synthetic"

    def __post_init__(self):
        self.t_s = np.asarray(self.t_s, dtype=float)
        self.x = np.asarray(self.x, dtype=float)
        self.y = np.asarray(self.y, dtype=float)
        self.slope_deg = np.broadcast_to(np.asarray(self.slope_deg, dtype=float),
                                         (self.t_s.size - 1,)).copy()
        if not (self.x.shape == self.y.shape == self.t_s.shape):
            raise ValueError("t_s, x, y must have the same shape")
        if np.any(np.diff(self.t_s) <= 0):
            raise ValueError("t_s must increase")

    @property
    def step_dist_m(self) -> np.ndarray:
        return np.hypot(np.diff(self.x), np.diff(self.y))

    @property
    def heading_deg(self) -> np.ndarray:
        """True heading per interval, clockwise from north (0 where stationary)."""
        return np.degrees(np.arctan2(np.diff(self.x), np.diff(self.y)))

    @property
    def distance_m(self) -> np.ndarray:
        return np.concatenate([[0.0], np.cumsum(self.step_dist_m)])

    def lonlat(self, x=None, y=None):
        x = self.x if x is None else x
        y = self.y if y is None else y
        return xy_to_lonlat(np.asarray(x) + self.origin_xy[0], np.asarray(y) + self.origin_xy[1])


def _time_grid(total_s: float, dt_s: float) -> np.ndarray:
    n = int(math.floor(total_s / dt_s + 1e-9))
    t = np.arange(n + 1) * dt_s
    if total_s - t[-1] > 1e-9:
        t = np.append(t, total_s)
    return t


def piecewise_route(points, speed_ms: float, *, dwell_s: dict | None = None,
                    dt_s: float | None = None, slope_deg=0.0, origin_xy=None,
                    label: str = "synthetic") -> Trajectory:
    """Walk the polyline ``points`` (local metres) at constant speed, dwelling ``dwell_s[i]``
    seconds at vertex i. ``slope_deg``: a constant, or a callable (x, y) -> slope (deg)."""
    dt = float(load_config()["monte_carlo"]["dt_s"]) if dt_s is None else float(dt_s)
    pts = np.asarray(points, dtype=float)
    dwell_s = dwell_s or {}
    # knots of the piecewise-linear time -> position map
    kt, kx, ky = [0.0], [pts[0, 0]], [pts[0, 1]]
    for i in range(len(pts)):
        if i > 0:
            seg = math.hypot(*(pts[i] - pts[i - 1]))
            kt.append(kt[-1] + seg / speed_ms)
            kx.append(pts[i, 0])
            ky.append(pts[i, 1])
        if dwell_s.get(i, 0.0) > 0:
            kt.append(kt[-1] + float(dwell_s[i]))
            kx.append(pts[i, 0])
            ky.append(pts[i, 1])
    kt = np.array(kt)
    # drop zero-length knots (repeated points) so interp stays well defined
    keep = np.concatenate([[True], np.diff(kt) > 0])
    kt, kx, ky = kt[keep], np.array(kx)[keep], np.array(ky)[keep]
    t = _time_grid(float(kt[-1]), dt)
    x = np.interp(t, kt, kx)
    y = np.interp(t, kt, ky)
    if callable(slope_deg):
        slope = slope_deg(0.5 * (x[1:] + x[:-1]), 0.5 * (y[1:] + y[:-1]))
    else:
        slope = slope_deg
    return Trajectory(t, x, y, slope, origin_xy=pad_xy() if origin_xy is None else origin_xy,
                      label=label)


def timed_route(t_s, x, y, *, dt_s: float | None = None, slope_deg=0.0, origin_xy=None,
                label: str = "route") -> Trajectory:
    """Trajectory through timed knots (seconds since EVA start, local metres): positions are
    linear in time between knots (so a repeated position = a dwell), sampled every ``dt_s``
    (nav.yaml ``monte_carlo.dt_s``) from t = 0 to the last knot. A knot at the same time as the
    previous one is dropped (no teleporting); before the first knot the crew stands at it.
    ``slope_deg``: a constant, or a callable (x, y) -> slope (deg) evaluated at mid-interval."""
    dt = float(load_config()["monte_carlo"]["dt_s"]) if dt_s is None else float(dt_s)
    kt = np.asarray(t_s, dtype=float)
    kx = np.asarray(x, dtype=float)
    ky = np.asarray(y, dtype=float)
    if not (kt.shape == kx.shape == ky.shape) or kt.size < 2:
        raise ValueError("timed_route needs >= 2 knots with matching t, x, y")
    if not np.all(np.isfinite(kt) & np.isfinite(kx) & np.isfinite(ky)):
        raise ValueError("timed_route knots must be finite")
    if np.any(np.diff(kt) < 0):
        raise ValueError("knot times must not decrease")
    keep = np.concatenate([[True], np.diff(kt) > 0])
    kt, kx, ky = kt[keep], kx[keep], ky[keep]
    if kt[0] < 0:
        raise ValueError("knot times must be >= 0 (EVA start)")
    t = _time_grid(float(kt[-1]), dt)
    xs = np.interp(t, kt, kx)
    ys = np.interp(t, kt, ky)
    slope = slope_deg(0.5 * (xs[1:] + xs[:-1]), 0.5 * (ys[1:] + ys[:-1])) if callable(slope_deg) \
        else slope_deg
    return Trajectory(t, xs, ys, slope, origin_xy=pad_xy() if origin_xy is None else origin_xy,
                      label=label)


def straight_route(duration_s: float, speed_ms: float, *, heading_deg: float = 90.0,
                   dt_s: float | None = None, slope_deg=0.0, origin_xy=None) -> Trajectory:
    """Synthetic straight route from the origin (default: the pad) at constant speed."""
    L = duration_s * speed_ms
    h = math.radians(heading_deg)
    end = (L * math.sin(h), L * math.cos(h))
    return piecewise_route([(0.0, 0.0), end], speed_ms, dt_s=dt_s, slope_deg=slope_deg,
                           origin_xy=origin_xy, label="synthetic_straight")


# --------------------------------------------------------------------------------------------
# Simulation
# --------------------------------------------------------------------------------------------

@dataclass
class SimResult:
    trajectory: Trajectory
    params: NavParams
    runs: int
    seed: int
    rec_idx: np.ndarray          # sample indices that were recorded
    t_s: np.ndarray              # times of the records (s)
    est_x: np.ndarray            # (runs, n_rec) estimated local x
    est_y: np.ndarray
    true_x: np.ndarray           # (n_rec,)
    true_y: np.ndarray
    dist_since_fix_m: np.ndarray  # (n_rec,) true distance walked since the last fix
    t_last_fix_s: np.ndarray     # (n_rec,) time of the last fix (NaN = none yet)
    gyro_bias_deg_h: np.ndarray  # (runs,)
    scale_factor: np.ndarray     # (runs,)
    fixes: list
    sample_run: dict | None = None  # full-resolution run 0 {"x", "y"} if requested

    def record_index(self, minute: float) -> int:
        """Index of the record at ``minute`` (exact match required; -1 style not allowed)."""
        k = np.flatnonzero(np.isclose(self.t_s, minute * 60.0, atol=1e-6))
        if k.size == 0:
            raise KeyError(f"no record at t = {minute} min")
        return int(k[0])

    def errors(self, k: int) -> np.ndarray:
        """(runs, 2) estimate minus truth at record k (x east, y north; metres)."""
        return np.column_stack([self.est_x[:, k] - self.true_x[k],
                                self.est_y[:, k] - self.true_y[k]])


def simulate(traj: Trajectory, params: NavParams, *, runs: int | None = None,
             seed: int | None = None, record_every_s: float = 60.0, fixes=(),
             keep_sample_run: bool = False) -> SimResult:
    """Monte Carlo of the dead-reckoning error along ``traj`` (vectorised over runs).

    ``fixes``: FixEvent list; a fix at time t is applied to the state at the first sample with
    t_s >= t (so the record at a fix time shows the post-fix state). Runs and seed default to
    nav.yaml ``monte_carlo``.
    """
    mcfg = load_config()["monte_carlo"]
    runs = int(mcfg["runs"]) if runs is None else int(runs)
    seed = int(mcfg["seed"]) if seed is None else int(seed)
    rng = np.random.default_rng(seed)
    p = params

    t = traj.t_s
    n = t.size
    d = traj.step_dist_m
    hd = np.radians(traj.heading_deg)
    sin_h, cos_h = np.sin(hd), np.cos(hd)
    dt = np.diff(t)
    slip_sd = np.where(traj.slope_deg > p.slip_min_slope_deg,
                       p.slip * np.sin(np.radians(traj.slope_deg)), 0.0)
    # per-interval sd of the summed per-step noise: sd_step * L * sqrt(d / L) = sd * sqrt(L d)
    sqrt_ld = np.sqrt(p.step_m * d)
    step_sd = p.step_noise_frac * sqrt_ld
    slip_sd = slip_sd * sqrt_ld
    rw_sd = np.radians(p.psi_rw_deg_sqrt_min) * np.sqrt(dt / 60.0)

    scale = 1.0 + p.sigma_s * rng.standard_normal(runs)
    bias_deg_h = p.sigma_b_deg_h * rng.standard_normal(runs)
    bias = np.radians(bias_deg_h) / 3600.0  # rad/s
    dpsi = np.radians(p.psi0_deg) * rng.standard_normal(runs)

    rec = np.zeros(n, dtype=bool)
    rec[np.isclose(np.mod(t + 1e-9, record_every_s), 0.0, atol=1e-6)] = True
    rec[-1] = True
    rec_idx = np.flatnonzero(rec)
    n_rec = rec_idx.size
    est_x = np.empty((runs, n_rec))
    est_y = np.empty((runs, n_rec))
    dsf = np.empty(n_rec)
    tlf = np.empty(n_rec)

    fix_list = sorted(fixes, key=lambda f: f.t_eva_min)
    fix_at = {}
    for f in fix_list:
        i = int(np.searchsorted(t, f.t_eva_min * 60.0 - 1e-9))
        if i < n:
            fix_at.setdefault(i, []).append(f)

    ex = np.zeros(runs)  # estimate minus truth
    ey = np.zeros(runs)
    dist_since = 0.0
    t_last = np.nan
    sample = {"x": np.empty(n), "y": np.empty(n)} if keep_sample_run else None
    r = 0
    for i in range(n):
        if i > 0:
            j = i - 1
            # heading error at mid-interval (bias integrates over the full interval)
            half = 0.5 * bias * dt[j]
            mid = dpsi + half
            d_est = d[j] * scale
            if step_sd[j] > 0:
                d_est = d_est + step_sd[j] * rng.standard_normal(runs)
            if slip_sd[j] > 0:
                d_est = d_est + slip_sd[j] * rng.standard_normal(runs)
            if d[j] > 0:
                h_est = hd[j] + mid
                ex += d_est * np.sin(h_est) - d[j] * sin_h[j]
                ey += d_est * np.cos(h_est) - d[j] * cos_h[j]
            dpsi = dpsi + 2.0 * half
            if rw_sd[j] > 0:
                dpsi = dpsi + rw_sd[j] * rng.standard_normal(runs)
            dist_since += d[j]
        for f in fix_at.get(i, ()):
            ex = f.sigma_m * rng.standard_normal(runs)
            ey = f.sigma_m * rng.standard_normal(runs)
            dpsi = np.radians(p.psi0_deg) * rng.standard_normal(runs)
            dist_since = 0.0
            t_last = t[i]
        if sample is not None:
            sample["x"][i] = traj.x[i] + ex[0]
            sample["y"][i] = traj.y[i] + ey[0]
        if rec[i]:
            est_x[:, r] = traj.x[i] + ex
            est_y[:, r] = traj.y[i] + ey
            dsf[r] = dist_since
            tlf[r] = t_last
            r += 1

    return SimResult(
        trajectory=traj, params=p, runs=runs, seed=seed, rec_idx=rec_idx, t_s=t[rec_idx],
        est_x=est_x, est_y=est_y, true_x=traj.x[rec_idx], true_y=traj.y[rec_idx],
        dist_since_fix_m=dsf, t_last_fix_s=tlf, gyro_bias_deg_h=bias_deg_h,
        scale_factor=scale, fixes=fix_list, sample_run=sample,
    )

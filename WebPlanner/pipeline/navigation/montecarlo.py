"""Monte Carlo summaries for F21 (SPEC §2.4, §6.2): 95 % error ellipses every minute, r95 over
distance since the last fix, the fit r95(D) = a*D + b*D^2, and the contract exports
``nav/montecarlo_{set}.json``, ``nav/tracks_{set}.geojson`` and ``nav/fixes.json``.

Ellipse convention: from the second moment of the error about zero (the truth relative to the
estimate), scaled by the chi-square 2-dof quantile k^2 = -2 ln(1 - conf); ``a_m``/``b_m`` are the
semi-major/minor axes in metres, ``theta_deg`` the azimuth of the major axis clockwise from grid
north in [0, 180).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy.optimize import nnls

from pipeline.navigation import deadreckon as dr

THETA_CONVENTION = "major-axis azimuth, deg clockwise from grid north (analysis CRS), [0, 180)"


# --------------------------------------------------------------------------------------------
# Ellipses and r95
# --------------------------------------------------------------------------------------------

def chi2_2dof_k(conf: float) -> float:
    """Mahalanobis radius of the conf-ellipse for a 2D Gaussian: sqrt(-2 ln(1 - conf))."""
    return math.sqrt(-2.0 * math.log(1.0 - conf))


def second_moment(e: np.ndarray) -> np.ndarray:
    e = np.asarray(e, dtype=float)
    return e.T @ e / e.shape[0]


def error_ellipse(e, conf: float) -> dict:
    """95 % (``conf``) ellipse of errors ``e`` (runs, 2) [x east, y north]."""
    m = second_moment(e)
    w, v = np.linalg.eigh(m)  # ascending
    w = np.clip(w, 0.0, None)
    k = chi2_2dof_k(conf)
    a = k * math.sqrt(w[1])
    b = k * math.sqrt(w[0])
    if a == 0.0:
        return {"a_m": 0.0, "b_m": 0.0, "theta_deg": 0.0}
    vx, vy = v[0, 1], v[1, 1]
    theta = math.degrees(math.atan2(vx, vy)) % 180.0
    return {"a_m": a, "b_m": b, "theta_deg": theta}


def coverage(e, ellipse: dict, conf: float) -> float:
    """Fraction of runs whose error lies inside the ellipse (KAT: 93-97 % at conf = 0.95)."""
    e = np.asarray(e, dtype=float)
    m = second_moment(e)
    k = chi2_2dof_k(conf)
    md2 = np.einsum("ij,jk,ik->i", e, np.linalg.pinv(m), e)
    return float(np.mean(md2 <= k * k))


def r95(e, conf: float) -> float:
    """``conf`` quantile of the radial error."""
    return float(np.quantile(np.hypot(e[:, 0], e[:, 1]), conf))


def fit_r95(D, r) -> dict:
    """r95(D) = a*D + b*D^2 (nav.yaml r95_fit), non-negative least squares, no intercept."""
    D = np.asarray(D, dtype=float)
    r = np.asarray(r, dtype=float)
    ok = np.isfinite(D) & np.isfinite(r) & (D > 0)
    A = np.column_stack([D[ok], D[ok] ** 2])
    # column scaling keeps NNLS well conditioned (D^2 reaches 1e7)
    s = np.maximum(np.abs(A).max(axis=0), 1e-300)
    coef, _ = nnls(A / s, r[ok])
    a, b = (coef / s).tolist()
    resid = r[ok] - (a * D[ok] + b * D[ok] ** 2)
    return {"a": a, "b": b, "rmse_m": float(np.sqrt(np.mean(resid**2))) if resid.size else None,
            "n": int(ok.sum())}


def inverse_r95(fit: dict, r):
    """Largest D with a*D + b*D^2 <= r (fix interval D_max for margin radius r)."""
    a, b = float(fit["a"]), float(fit["b"])
    r = np.asarray(r, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        if b > 0:
            D = (-a + np.sqrt(a * a + 4.0 * b * np.clip(r, 0, None))) / (2.0 * b)
        elif a > 0:
            D = np.clip(r, 0, None) / a
        else:
            D = np.where(r >= 0, np.inf, 0.0)
    D = np.where(np.isfinite(r), D, np.nan)
    return float(D) if D.ndim == 0 else D


# --------------------------------------------------------------------------------------------
# Summary: nav/montecarlo_{set}.json
# --------------------------------------------------------------------------------------------

def summarise(res: dr.SimResult, params: dr.NavParams | None = None, *,
              conf: float | None = None) -> dict:
    """Per-minute ellipse and r95, and the r95(D) fit (contracts/montecarlo.schema.json)."""
    cfg = dr.load_config()
    conf = float(cfg["ellipse_conf"]) if conf is None else conf
    params = res.params if params is None else params
    per_minute = []
    for k, t in enumerate(res.t_s):
        if not math.isclose(t % 60.0, 0.0, abs_tol=1e-6) and not math.isclose(
                t % 60.0, 60.0, abs_tol=1e-6):
            continue
        e = res.errors(k)
        ell = error_ellipse(e, conf)
        per_minute.append({
            "t_eva_min": round(t / 60.0, 6),
            "dist_since_fix_m": round(float(res.dist_since_fix_m[k]), 3),
            "ellipse": {key: round(float(v), 3) for key, v in ell.items()},
            "r95_m": round(r95(e, conf), 3),
        })
    D = [m["dist_since_fix_m"] for m in per_minute]
    R = [m["r95_m"] for m in per_minute]
    fit = fit_r95(D, R)
    return {
        "set": params.name,
        "params": params.to_dict(),
        "runs": int(res.runs),
        "seed": int(res.seed),
        "dt_s": float(dr.load_config()["monte_carlo"]["dt_s"]),
        "ellipse_conf": conf,
        "theta_convention": THETA_CONVENTION,
        "route": res.trajectory.label,
        "fixes": [f.to_dict() for f in res.fixes],
        "per_minute": per_minute,
        "r95_fit": {"a": fit["a"], "b": fit["b"], "rmse_m": fit["rmse_m"], "n": fit["n"],
                    "formula": cfg["r95_fit"]},
        "simulated": True,
    }


def write_json(obj, path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")))
    return path


# --------------------------------------------------------------------------------------------
# nav/tracks_{set}.geojson
# --------------------------------------------------------------------------------------------

def _corner_indices(x, y) -> np.ndarray:
    """Vertices of the true track: ends plus every sample where direction or motion changes."""
    dx, dy = np.diff(x), np.diff(y)
    h = np.round(np.arctan2(dx, dy), 9)
    moving = np.hypot(dx, dy) > 1e-9
    change = (h[1:] != h[:-1]) | (moving[1:] != moving[:-1])
    return np.concatenate([[0], np.flatnonzero(change) + 1, [x.size - 1]])


def _coords(lon, lat) -> list:
    return [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon, lat, strict=True)]


def ellipse_ring(cx, cy, ell: dict, n_vertices: int):
    """Closed polygon (local metres) of an ellipse with semi-axes a, b along azimuth theta."""
    t = np.linspace(0.0, 2.0 * math.pi, n_vertices, endpoint=False)
    th = math.radians(ell["theta_deg"])
    major = np.array([math.sin(th), math.cos(th)])
    minor = np.array([math.cos(th), -math.sin(th)])
    pts = (ell["a_m"] * np.cos(t))[:, None] * major + (ell["b_m"] * np.sin(t))[:, None] * minor
    xs = np.append(cx + pts[:, 0], cx + pts[0, 0])
    ys = np.append(cy + pts[:, 1], cy + pts[0, 1])
    return xs, ys


def tracks_geojson(res: dr.SimResult, params: dr.NavParams | None = None, *,
                   sample_run: int = 0) -> dict:
    """True track, one sample estimated track (run ``sample_run``, at the record times), and
    95 % ellipse polygons every ``nav.yaml tracks.ellipse_every_min`` minutes, centred on the
    sample estimate (where the crew thinks it is). Every feature has ``t_eva_min`` (lines: the
    end time, as in the M0 dummy). ``kind``: "true" | "estimated" | "ellipse95" (M0 dummy names)."""
    cfg = dr.load_config()
    tcfg = cfg["tracks"]
    conf = float(cfg["ellipse_conf"])
    params = res.params if params is None else params
    tr = res.trajectory
    feats = []
    ci = _corner_indices(tr.x, tr.y)
    lon, lat = tr.lonlat(tr.x[ci], tr.y[ci])
    feats.append({"type": "Feature",
                  "geometry": {"type": "LineString", "coordinates": _coords(lon, lat)},
                  "properties": {"kind": "true", "t_eva_min": round(tr.t_s[-1] / 60.0, 6),
                                 "t_eva_min_vertices": [round(t / 60.0, 4)
                                                        for t in tr.t_s[ci]]}})
    ex, ey = res.est_x[sample_run], res.est_y[sample_run]
    lon, lat = tr.lonlat(ex, ey)
    feats.append({"type": "Feature",
                  "geometry": {"type": "LineString", "coordinates": _coords(lon, lat)},
                  "properties": {"kind": "estimated", "run": sample_run, "set": params.name,
                                 "t_eva_min": round(res.t_s[-1] / 60.0, 6),
                                 "t_eva_min_vertices": [round(t / 60.0, 4) for t in res.t_s]}})
    every = float(tcfg["ellipse_every_min"]) * 60.0
    for k, t in enumerate(res.t_s):
        if not math.isclose(t % every, 0.0, abs_tol=1e-6):
            continue
        ell = error_ellipse(res.errors(k), conf)
        xs, ys = ellipse_ring(ex[k], ey[k], ell, int(tcfg["ellipse_vertices"]))
        lon, lat = tr.lonlat(xs, ys)
        feats.append({"type": "Feature",
                      "geometry": {"type": "Polygon", "coordinates": [_coords(lon, lat)]},
                      "properties": {"kind": "ellipse95", "t_eva_min": round(t / 60.0, 6),
                                     "set": params.name,
                                     **{key: round(float(v), 3) for key, v in ell.items()},
                                     "r95_m": round(r95(res.errors(k), conf), 3),
                                     "dist_since_fix_m": round(float(res.dist_since_fix_m[k]),
                                                               3)}})
    return {"type": "FeatureCollection", "features": feats,
            "properties": {"set": params.name, "runs": res.runs, "simulated": True}}


# --------------------------------------------------------------------------------------------
# nav/fixes.json
# --------------------------------------------------------------------------------------------

def fixes_json(fixes) -> list:
    return [f.to_dict() for f in sorted(fixes, key=lambda f: f.t_eva_min)]


# --------------------------------------------------------------------------------------------
# Provenance (call only for real outputs after H0; tests pass a tmp fragment_dir)
# --------------------------------------------------------------------------------------------

def record_manifest(summary: dict, file, *, fragment_dir=None) -> list[str]:
    """Record the displayed Monte Carlo numbers: the r95 fit and the end-of-EVA ellipse."""
    from pipeline.provenance.manifest import record  # noqa: PLC0415

    s = summary["set"]
    last = summary["per_minute"][-1]
    items = [
        (f"nav.r95_fit.{s}.a", summary["r95_fit"]["a"], "1"),
        (f"nav.r95_fit.{s}.b", summary["r95_fit"]["b"], "1/m"),
        (f"nav.montecarlo.{s}.runs", summary["runs"], "1"),
        (f"nav.montecarlo.{s}.final.r95_m", last["r95_m"], "m"),
        (f"nav.montecarlo.{s}.final.a_m", last["ellipse"]["a_m"], "m"),
        (f"nav.montecarlo.{s}.final.t_eva_min", last["t_eva_min"], "min"),
    ]
    for key, value, units in items:
        record(key, value, units, file, __file__, fragment_dir=fragment_dir)
    return [k for k, _, _ in items]


def record_fixes_manifest(fixes, file, *, fragment_dir=None) -> list[str]:
    """Record the fix times and sigmas shown on the HUD and /nav (same keys as the M0 dummy)."""
    from pipeline.provenance.manifest import record  # noqa: PLC0415

    keys = []
    for i, f in enumerate(sorted(fixes, key=lambda f: f.t_eva_min)):
        for k, v, u in ((f"nav.fixes.{i}.t_eva_min", f.t_eva_min, "min"),
                        (f"nav.fixes.{i}.sigma_m", f.sigma_m, "m")):
            record(k, v, u, file, __file__, fragment_dir=fragment_dir)
            keys.append(k)
    return keys

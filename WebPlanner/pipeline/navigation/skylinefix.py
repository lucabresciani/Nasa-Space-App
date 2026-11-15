"""Skyline-matching navigation fix (F22; SPEC §2.4). A coarse backup fix (tens to hundreds of
metres), not navigation, and never compared favourably with MGL.

Given the skyline detected in a Navcam frame as (azimuth, elevation) per image column (WS3:
``sky.detect_skyline`` + ``cahvor.pixels_to_az_el``), find the observer position whose predicted
horizon (WS3 ``HorizonEngine``) matches best:

1. Coarse: candidates on a ``coarse_grid_m`` grid over ``search_extent_m`` x ``search_extent_m``
   around the prior; ``az_step_coarse_deg`` rays (horizon.yaml) and only terrain beyond
   ``far_field_min_m``.
2. Refine: a ``refine_grid_m`` grid over the coarse cell (half-width coarse_grid_m / 2) around each
   of the best ``refine_top_k`` coarse candidates; full rays (horizon.yaml ``az_step_deg``), all
   distances.
3. Score: weighted RMS of (detected - predicted) elevation over the columns, weights by the
   predicted horizon distance class (nav.yaml ``column_weights``: far > mid > near).
4. sigma from the score surface: the refine candidates with RMS <= 1.5 x the minimum form a
   region; sigma_m = its equivalent-circle radius sqrt(n * refine_grid_m^2 / pi).

All numbers from config/nav.yaml ``skyline_fix`` and config/horizon.yaml. Interface used from WS3
(branch ``ws3-horizon``): ``HorizonEngine.horizons(xs, ys, eye_height_m, az_step_deg, min_dist_m)
-> (elevation_deg, distance_m, source)``, ``rays.classify_distance`` and horizon.yaml
``navcam_height_m``, ``az_step_deg``, ``az_step_coarse_deg``. Coordinates are the
analysis CRS (metres, the DEM bands' CRS). The fix fed to F21 uses sigma = the measured error
against Curiosity's true drive end (SPEC F21), with the score-surface sigma reported alongside.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from pipeline.navigation import deadreckon as dr

if TYPE_CHECKING:  # WS3's engine; imported lazily so F21 runs without it (branch ws3-horizon)
    from pipeline.horizon.rays import HorizonEngine


def _hcfg() -> dict:
    """config/horizon.yaml through WS3's accessor."""
    from pipeline.horizon import config as hcfg  # noqa: PLC0415

    return hcfg.load()


def _cfg() -> dict:
    return dr.load_config()["skyline_fix"]


def _sigma_factor() -> float:
    """1.5 from nav.yaml sigma_rule ("region with RMS <= 1.5 x minimum RMS")."""
    rule = _cfg()["sigma_rule"]
    return float(rule.split("<=")[1].split("x")[0])


# --------------------------------------------------------------------------------------------
# Candidates
# --------------------------------------------------------------------------------------------

def grid_around(center, extent_m: float, step_m: float):
    """Square grid of side ``extent_m`` (inclusive edges) centred on ``center``."""
    k = int(round(extent_m / 2.0 / step_m))
    off = np.arange(-k, k + 1) * step_m
    gx, gy = np.meshgrid(center[0] + off, center[1] + off)
    return gx.ravel(), gy.ravel()


def standalone_prior(true_xy, rng: np.random.Generator):
    """SPEC F22 standalone test: the true position plus a ``standalone_prior_offset_m`` offset
    in a random direction."""
    r = float(_cfg()["standalone_prior_offset_m"])
    a = rng.uniform(0.0, 2.0 * math.pi)
    return true_xy[0] + r * math.sin(a), true_xy[1] + r * math.cos(a)


# --------------------------------------------------------------------------------------------
# Score
# --------------------------------------------------------------------------------------------

def _interp_rows(el, step, az):
    """Linear interpolation over azimuth (360 deg wrap) of each row of ``el`` at ``az``."""
    n = el.shape[1]
    f = np.mod(np.asarray(az, dtype=float), 360.0) / step
    i0 = np.floor(f).astype(int) % n
    i1 = (i0 + 1) % n
    w = f - np.floor(f)
    return el[:, i0] * (1.0 - w) + el[:, i1] * w


def score(engine: HorizonEngine, xs, ys, obs_az, obs_el, *, az_step_deg: float,
          min_dist_m: float, eye_height_m: float) -> np.ndarray:
    """Weighted RMS (deg) of detected minus predicted skyline elevation for each candidate.
    Columns with no detection or no prediction are left out; NaN if none is left."""
    obs_az = np.asarray(obs_az, dtype=float)
    obs_el = np.asarray(obs_el, dtype=float)
    ok = np.isfinite(obs_az) & np.isfinite(obs_el)
    if not ok.any():
        return np.full(np.size(xs), np.nan)
    from pipeline.horizon.rays import classify_distance  # noqa: PLC0415

    obs_az, obs_el = obs_az[ok], obs_el[ok]
    el, dist, _ = engine.horizons(xs, ys, eye_height_m=eye_height_m, az_step_deg=az_step_deg,
                                  min_dist_m=min_dist_m)
    pred = _interp_rows(el, az_step_deg, obs_az)
    # distance class of the nearest ray (no interpolation across occlusions)
    j = np.rint(np.mod(obs_az, 360.0) / az_step_deg).astype(int) % el.shape[1]
    cls = classify_distance(dist[:, j])
    wmap = _cfg()["column_weights"]
    w = np.zeros(cls.shape)
    for name, val in wmap.items():
        w[cls == name] = float(val)
    r = obs_el[None, :] - pred
    good = np.isfinite(r) & (w > 0)
    w = np.where(good, w, 0.0)
    r = np.where(good, r, 0.0)
    sw = w.sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        rms = np.sqrt((w * r * r).sum(axis=1) / sw)
    rms[sw == 0] = np.nan
    return rms


# --------------------------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------------------------

@dataclass
class SkylineFixResult:
    x: float
    y: float
    rms_deg: float
    sigma_m: float
    candidates_evaluated: int
    prior_xy: tuple
    coarse: dict = field(repr=False, default_factory=dict)
    refine: dict = field(repr=False, default_factory=dict)


def locate(engine: HorizonEngine, obs_az, obs_el, prior_xy, *,
           eye_height_m: float | None = None) -> SkylineFixResult:
    """Coarse-to-fine skyline match around ``prior_xy``. Raises ValueError if no candidate
    can be scored (no detected skyline, or the search area is off the DEM)."""
    c = _cfg()
    hc = _hcfg()
    h = float(hc["navcam_height_m"]) if eye_height_m is None else float(eye_height_m)
    cx, cy = grid_around(prior_xy, float(c["search_extent_m"]), float(c["coarse_grid_m"]))
    c_rms = score(engine, cx, cy, obs_az, obs_el, az_step_deg=float(hc["az_step_coarse_deg"]),
                  min_dist_m=float(c["far_field_min_m"]), eye_height_m=h)
    if not np.isfinite(c_rms).any():
        raise ValueError("no coarse candidate could be scored (no skyline or off the DEM)")
    order = np.argsort(np.where(np.isfinite(c_rms), c_rms, np.inf))
    top = order[: int(c["refine_top_k"])]
    top = top[np.isfinite(c_rms[top])]
    seeds = list(zip(cx[top], cy[top], strict=True))
    step = float(c["refine_grid_m"])
    half = float(c["coarse_grid_m"]) / 2.0
    rx, ry = [], []
    for sx, sy in seeds:
        gx, gy = grid_around((sx, sy), 2.0 * (half - half % step), step)
        rx.append(gx)
        ry.append(gy)
    pts = np.unique(np.round(np.column_stack([np.concatenate(rx), np.concatenate(ry)]), 6),
                    axis=0)
    rx, ry = pts[:, 0], pts[:, 1]
    r_rms = score(engine, rx, ry, obs_az, obs_el, az_step_deg=float(hc["az_step_deg"]),
                  min_dist_m=0.0, eye_height_m=h)
    if not np.isfinite(r_rms).any():
        raise ValueError("no refine candidate could be scored")
    b = int(np.nanargmin(r_rms))
    rmin = float(r_rms[b])
    region = np.isfinite(r_rms) & (r_rms <= _sigma_factor() * rmin)
    sigma = math.sqrt(int(region.sum()) * step * step / math.pi)
    return SkylineFixResult(
        x=float(rx[b]), y=float(ry[b]), rms_deg=rmin, sigma_m=sigma,
        candidates_evaluated=int(cx.size + rx.size), prior_xy=tuple(map(float, prior_xy)),
        coarse={"x": cx, "y": cy, "rms_deg": c_rms},
        refine={"x": rx, "y": ry, "rms_deg": r_rms},
    )


# --------------------------------------------------------------------------------------------
# Outputs
# --------------------------------------------------------------------------------------------

def _lonlat(x, y) -> dict:
    lon, lat = dr.xy_to_lonlat(x, y)
    return {"lon": round(float(lon), 6), "lat": round(float(lat), 6)}


def localisation_record(res: SkylineFixResult, true_xy) -> dict:
    """localisation/{image_id}.json (contracts/localisation.schema.json)."""
    err = math.hypot(res.x - true_xy[0], res.y - true_xy[1])
    return {
        "true": _lonlat(*true_xy),
        "recovered": _lonlat(res.x, res.y),
        "error_m": round(err, 2),
        "rms_deg": round(res.rms_deg, 4),
        "candidates_evaluated": int(res.candidates_evaluated),
        "sigma_m": round(res.sigma_m, 2),
        "prior": _lonlat(*res.prior_xy),
        "prior_offset_m": round(math.hypot(res.prior_xy[0] - true_xy[0],
                                           res.prior_xy[1] - true_xy[1]), 2),
    }


def fix_event(rec: dict, *, t_eva_min: float, station: str | None, image_id: str) -> dr.FixEvent:
    """F21 fix with sigma = the measured error (SPEC F21)."""
    return dr.FixEvent(t_eva_min=t_eva_min, type="skyline", sigma_m=rec["error_m"],
                       station=station, error_m=rec["error_m"], image_id=image_id)


def try_frames(engine: HorizonEngine, frames, *, rng: np.random.Generator,
               eye_height_m: float | None = None) -> list[dict]:
    """Run the fix on every frame and report every one, failures included (SPEC F22).
    ``frames``: dicts with image_id, true_xy, obs_az, obs_el and optionally prior_xy (else the
    standalone prior)."""
    out = []
    for f in frames:
        row = {"image_id": f["image_id"]}
        try:
            prior = f.get("prior_xy") or standalone_prior(f["true_xy"], rng)
            res = locate(engine, f["obs_az"], f["obs_el"], prior, eye_height_m=eye_height_m)
            rec = localisation_record(res, f["true_xy"])
            row.update(status="ok", **rec)
        except Exception as exc:  # report, never hide (AGENTS rule 7)
            row.update(status="failed", reason=f"{type(exc).__name__}: {exc}", error_m=None)
        out.append(row)
    return out


def write_json(rec: dict, path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rec, separators=(",", ":")))
    return path


def record_manifest(rec: dict, image_id: str, file, *, fragment_dir=None) -> list[str]:
    from pipeline.provenance.manifest import record  # noqa: PLC0415

    items = [(f"nav.skyline.{image_id}.error_m", rec["error_m"], "m"),
             (f"nav.skyline.{image_id}.sigma_m", rec["sigma_m"], "m"),
             (f"nav.skyline.{image_id}.rms_deg", rec["rms_deg"], "deg"),
             (f"nav.skyline.{image_id}.candidates_evaluated", rec["candidates_evaluated"], "1")]
    for key, value, units in items:
        record(key, value, units, file, __file__, fragment_dir=fragment_dir)
    return [k for k, _, _ in items]

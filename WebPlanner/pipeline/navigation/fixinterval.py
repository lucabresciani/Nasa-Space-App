"""Fix-interval map (F21; SPEC §2.4 "Fix-interval map", §6.2): how far a crew may walk on dead
reckoning before it must take a fix.

For every assessed cell x:

1. Margin radius r_m(x): the largest radius such that the worst T_home within r_m stays at or
   below the limit (the 30-min walkback budget, crew.yaml ``walkback_budgets_min[0]``, minus
   nav.yaml ``fix_interval_ws9.reserve_min``).
   * ``edt`` (default): the worst T_home within r is the circular max filter of T_home, so the
     criterion holds exactly while r is below the distance to the nearest cell over the limit.
     r_m = Euclidean distance transform of the "over the limit" mask (unknown counts as over).
     Exact and not capped at the largest precomputed radius.
   * ``worst_fields``: SPEC's literal recipe, linear interpolation in the precomputed
     ``t_home_worst_{10,50,100}`` fields (WS7); censored at the largest radius.
2. D_max(x) = the largest D with r95(D) <= r_m(x), from the Monte Carlo fit (montecarlo.py).
3. Classes nav.yaml ``fix_interval.classes_m`` (< 100, 100-300, 300-1000, > 1000 m).

Outputs (contracts v1.0.0): ``fields/fix_interval_{set}.png`` per set, and one summary file
``nav/fix_interval_summary.json`` with a ``set`` field (SPEC §6.2; ``SUMMARY_PATH``), written
for nav.yaml ``default_set``. The other sets' summaries stay in the run report until the contract
carries more than one set.

Outside the homeline D_max = 0; unknown cells stay unknown (NaN, alpha 0 in the PNG).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.ndimage import distance_transform_edt

from pipeline.navigation import deadreckon as dr
from pipeline.navigation import montecarlo as mc

MAX_COUNTS = 65535  # R*256 + G (contracts/README.md "Field PNGs")


def _cfg() -> dict:
    return dr.load_config()


def homeline_limit_min() -> float:
    """Walkback budget for the fix-interval criterion (min)."""
    budget = float(dr.crew_config()["walkback_budgets_min"][0])
    return budget - float(_cfg()["fix_interval_ws9"]["reserve_min"])


def class_labels(classes_m=None) -> list[str]:
    c = _cfg()["fix_interval"]["classes_m"] if classes_m is None else classes_m
    c = [int(v) for v in c]
    return [f"<{c[0]}"] + [f"{a}-{b}" for a, b in zip(c[:-1], c[1:], strict=True)] + [f">{c[-1]}"]


# --------------------------------------------------------------------------------------------
# Margin radius
# --------------------------------------------------------------------------------------------

def margin_radius_edt(t_home, res_m: float, limit_min: float | None = None) -> np.ndarray:
    """r_m by distance transform. NaN T_home (unknown) counts as over the limit and stays NaN.
    The raster border is treated as over the limit (nothing is known beyond it)."""
    lim = homeline_limit_min() if limit_min is None else float(limit_min)
    t = np.asarray(t_home, dtype=float)
    ok = np.isfinite(t) & (t <= lim)
    padded = np.pad(ok, 1, constant_values=False)
    r = distance_transform_edt(padded, sampling=float(res_m))[1:-1, 1:-1]
    r[~np.isfinite(t)] = np.nan
    return r


def margin_radius_from_worst(t_point, worst: dict, limit_min: float | None = None):
    """r_m by linear interpolation in worst-case fields {radius_m: T_worst}. Returns
    (r_m, censored) where censored marks cells whose largest radius is still within the limit
    (r_m is then a lower bound equal to that radius)."""
    lim = homeline_limit_min() if limit_min is None else float(limit_min)
    radii = [0.0] + sorted(float(r) for r in worst)
    fields = [np.asarray(t_point, dtype=float)] + [np.asarray(worst[r], dtype=float)
                                                   for r in sorted(worst)]
    out = np.full(fields[0].shape, np.nan)
    done = ~np.isfinite(fields[0])
    out[~done & (fields[0] > lim)] = 0.0
    done |= fields[0] > lim
    for j in range(1, len(radii)):
        tj, tp = fields[j], fields[j - 1]
        hit = ~done & ~(np.isfinite(tj) & (tj <= lim))  # over the limit (or unknown) at r_j
        with np.errstate(invalid="ignore", divide="ignore"):
            frac = np.where(np.isfinite(tj) & (tj > tp), (lim - tp) / (tj - tp), 0.0)
        out[hit] = radii[j - 1] + np.clip(frac[hit], 0.0, 1.0) * (radii[j] - radii[j - 1])
        done |= hit
    censored = ~done
    out[censored] = radii[-1]
    return out, censored


# --------------------------------------------------------------------------------------------
# D_max
# --------------------------------------------------------------------------------------------

def fix_interval(t_home, res_m: float, fit: dict, *, limit_min: float | None = None,
                 method: str | None = None, worst: dict | None = None) -> np.ndarray:
    """D_max (m) per cell: 0 outside the homeline, NaN where T_home is unknown."""
    method = _cfg()["fix_interval_ws9"]["margin_radius_method"] if method is None else method
    if method == "edt":
        r_m = margin_radius_edt(t_home, res_m, limit_min)
    elif method == "worst_fields":
        if worst is None:
            raise ValueError("method 'worst_fields' needs the worst-case fields")
        r_m, _ = margin_radius_from_worst(t_home, worst, limit_min)
    else:
        raise ValueError(f"unknown margin_radius_method {method!r}")
    return mc.inverse_r95(fit, r_m)


def summarise(d_max, t_home, set_name: str, *, limit_min: float | None = None) -> dict:
    """``nav/fix_interval_summary.json`` (contracts/fix_interval_summary.schema.json, one set)
    over the cells inside the homeline (T_home <= limit).
    ``median_m``: median D_max; ``edge_p10_m``: the nav.yaml ``edge_percentile`` percentile
    (the near-edge figure of the headline); classes as % of the homeline area."""
    lim = homeline_limit_min() if limit_min is None else float(limit_min)
    t = np.asarray(t_home, dtype=float)
    d = np.asarray(d_max, dtype=float)
    inside = np.isfinite(t) & (t <= lim) & np.isfinite(d)
    labels = class_labels()
    edges = [float(v) for v in _cfg()["fix_interval"]["classes_m"]]
    if not inside.any():
        return {"set": set_name, "median_m": None, "edge_p10_m": None,
                "class_area_pct": dict.fromkeys(labels)}
    v = d[inside]
    bins = np.digitize(v, edges)  # 0: < edges[0], ..., len(edges): >= edges[-1]
    pct = {lab: round(100.0 * float(np.mean(bins == i)), 3) for i, lab in enumerate(labels)}
    p = float(_cfg()["fix_interval_ws9"]["edge_percentile"])
    return {
        "set": set_name,
        "median_m": round(float(np.median(v)), 1),
        "edge_p10_m": round(float(np.percentile(v, p)), 1),
        "class_area_pct": pct,
        "limit_min": lim,
        "cells_inside": int(inside.sum()),
        "simulated": True,
    }


# --------------------------------------------------------------------------------------------
# PNG (contracts/README.md "Field PNGs"; 1 m per count from hud.yaml field_scales.fix_interval)
# --------------------------------------------------------------------------------------------

def _per_count() -> float:
    return float(dr._yaml("hud")["field_scales"]["fix_interval"]["per_count"])


def encode_rgba(d_max) -> np.ndarray:
    d = np.asarray(d_max, dtype=float)
    ok = np.isfinite(d) | np.isposinf(d)
    counts = np.zeros(d.shape, dtype=np.int64)
    counts[ok] = np.clip(np.rint(np.minimum(d[ok], MAX_COUNTS * _per_count()) / _per_count()),
                         0, MAX_COUNTS)
    rgba = np.zeros(d.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = counts // 256
    rgba[..., 1] = counts % 256
    rgba[..., 3] = np.where(ok, 255, 0)
    return rgba


def write_png(d_max, path) -> Path:
    from PIL import Image  # noqa: PLC0415

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(encode_rgba(d_max), mode="RGBA").save(path, optimize=True)
    return path


def read_png(path) -> np.ndarray:
    from PIL import Image  # noqa: PLC0415

    a = np.asarray(Image.open(path).convert("RGBA")).astype(np.int64)
    v = (a[..., 0] * 256 + a[..., 1]).astype(float) * _per_count()
    v[a[..., 3] == 0] = np.nan
    return v


SUMMARY_PATH = "nav/fix_interval_summary.json"  # contracts v1.0.0: one file, ``set`` field


def png_path(set_name: str) -> str:
    """Data path of a set's D_max field (contracts/README.md "Field PNGs")."""
    return f"fields/fix_interval_{set_name}.png"


def write_summary(summary: dict, path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, separators=(",", ":")))
    return path


# --------------------------------------------------------------------------------------------
# Provenance (real outputs only after H0; tests pass a tmp fragment_dir)
# --------------------------------------------------------------------------------------------

def record_manifest(summary: dict, file, *, fragment_dir=None) -> list[str]:
    from pipeline.provenance.manifest import record  # noqa: PLC0415

    s = summary["set"]
    items = [(f"nav.fix_interval.{s}.median_m", summary["median_m"], "m"),
             (f"nav.fix_interval.{s}.edge_p10_m", summary["edge_p10_m"], "m")]
    for lab, v in summary["class_area_pct"].items():
        items.append((f"nav.fix_interval.{s}.class_area_pct.{lab}", v, "%"))
    for key, value, units in items:
        record(key, value, units, file, __file__, fragment_dir=fragment_dir)
    return [k for k, _, _ in items]

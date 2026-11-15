"""Worst-case fields for position uncertainty (F19; SPEC §2.3; brief WS7).

``t_home_worst_{r}`` / ``o2_home_worst_{r}`` = circular max filter of the point field with radius
r metres (``config/hud.yaml`` ``worst_case_radii_m``), nominal 104 kg scenario only
(``config/variants.yaml`` ``scenarios.default``). The HUD picks the smallest precomputed radius
≥ σ and shows that value, so the result must never be optimistic:

* the disc is every cell whose centre is within ``r_px`` cells of the cell centre
  (dy² + dx² ≤ r_px²); on a grid whose cell size does not divide r, ``r_px`` is rounded **up**
  (10 m on the 3 m route grid -> 4 cells = 12 m), so the disc is never smaller than r;
* cells outside the raster extent are ignored (never padded with a value);
* ``unknown="ignore"`` (used for the real fields, assumption A-WS7-2 in STATUS.md): cells with no
  T_home (blocked > no-go slope, unreached, no data) are places the crew cannot be on the plan,
  so the worst case is the max over the reachable cells in the disc; unknown only if none is.
  ``unknown="propagate"``: any unknown cell in the disc makes the worst case unknown (the M0 dummy
  convention).

Exact in float64: the disc is decomposed into one 1-D running max per row offset, so the
worst-case field is ≥ the point field everywhere the point field is known.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

import numpy as np
from scipy.ndimage import maximum_filter1d


def disc_offsets(radius_px: int) -> list[tuple[int, int]]:
    """All integer (dy, dx) with dy² + dx² ≤ radius_px²."""
    r = int(radius_px)
    return [(dy, dx) for dy in range(-r, r + 1) for dx in range(-r, r + 1)
            if dy * dy + dx * dx <= r * r]


def _disc_reduce_max(v: np.ndarray, r: int) -> np.ndarray:
    """Max over the disc, treating cells outside the array as -inf."""
    h = v.shape[0]
    out = np.full(v.shape, -np.inf)
    for dy in range(-r, r + 1):
        w = math.isqrt(r * r - dy * dy)
        row_max = maximum_filter1d(v, size=2 * w + 1, axis=1, mode="constant", cval=-np.inf)
        # out[y] takes row_max[y + dy] where that row exists
        if dy >= 0:
            np.maximum(out[: h - dy], row_max[dy:], out=out[: h - dy])
        else:
            np.maximum(out[-dy:], row_max[: h + dy], out=out[-dy:])
    return out


def disc_max(values: np.ndarray, radius_px: int, *, unknown: str = "propagate") -> np.ndarray:
    """Circular max filter of a 2-D field (NaN = unknown); see the module docstring."""
    if unknown not in ("propagate", "ignore"):
        raise ValueError(f"unknown must be 'propagate' or 'ignore', got {unknown!r}")
    v = np.asarray(values, dtype=np.float64)
    if v.ndim != 2:
        raise ValueError(f"field must be 2-D, got shape {v.shape}")
    r = int(radius_px)
    if r < 0:
        raise ValueError("radius must be >= 0")
    bad = ~np.isfinite(v)
    if r == 0:
        out = v.copy()
        out[bad] = np.nan
        return out
    out = _disc_reduce_max(np.where(bad, -np.inf, v), r)
    if unknown == "propagate":
        out[_disc_reduce_max(bad.astype(np.float64), r) > 0] = np.nan
    else:
        out[~np.isfinite(out)] = np.nan  # no known cell in the disc
    return out


def radius_px(radius_m: float, res_m: float) -> int:
    """Disc radius in whole cells, rounded up (never a smaller disc than asked)."""
    r_px = radius_m / res_m
    if abs(r_px - round(r_px)) <= 1e-9:
        return int(round(r_px))
    return int(math.ceil(r_px))


def worst_case_fields(values: np.ndarray, res_m: float, radii_m: Iterable[float], *,
                      unknown: str = "propagate") -> dict[int, tuple[float, np.ndarray]]:
    """``{radius_m: (effective radius m, disc_max field)}`` for each configured radius."""
    out: dict[int, tuple[float, np.ndarray]] = {}
    for r_m in radii_m:
        r_px = radius_px(r_m, res_m)
        out[int(r_m)] = (r_px * res_m, disc_max(values, r_px, unknown=unknown))
    return out

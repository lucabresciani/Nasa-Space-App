"""Slope and roughness (F2; site.yaml ``slope``, ``roughness_window_m``).

* ``horn``: Horn (1981) 3x3 finite differences, degrees. Any NaN in the 3x3 window (and the
  one-cell border) gives NaN: unknown stays unknown, never filled.
* ``plane_fit``: least-squares plane over an odd ``window_px`` square (the 5 m comparison slope
  and the roughness = RMS residual about that plane, metres). Same NaN rule.

Both work on float32 arrays in row strips with a halo, so a 7,800 x 7,800 grid fits in memory.
"""

from __future__ import annotations

import math
from collections.abc import Callable

import numpy as np
from scipy.ndimage import uniform_filter


def strips(func: Callable[[np.ndarray], tuple[np.ndarray, ...] | np.ndarray], z: np.ndarray,
           halo: int, rows: int = 1024):
    """Apply ``func`` to row strips of ``z`` with a ``halo``; returns arrays of z.shape."""
    h = z.shape[0]
    outs = None
    for r0 in range(0, h, rows):
        r1 = min(h, r0 + rows)
        a0, a1 = max(0, r0 - halo), min(h, r1 + halo)
        res = func(z[a0:a1])
        single = not isinstance(res, tuple)
        res = (res,) if single else res
        if outs is None:
            outs = [np.full(z.shape, np.nan, np.float32) for _ in res]
        for o, v in zip(outs, res, strict=True):
            piece = v[r0 - a0: r0 - a0 + (r1 - r0)]
            o[r0:r1] = piece
        # strips that touch the global top/bottom keep the func's own border NaNs
    return outs[0] if single else tuple(outs)


def _horn(z: np.ndarray, res: float) -> np.ndarray:
    z = z.astype(np.float64)
    out = np.full(z.shape, np.nan, np.float32)
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    d, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * res)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * res)
    with np.errstate(invalid="ignore"):
        out[1:-1, 1:-1] = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
    out[~np.isfinite(z)] = np.nan  # Horn ignores the centre cell; a cell without height is unknown
    return out


def horn(z: np.ndarray, res: float, rows: int = 1024) -> np.ndarray:
    """Slope in degrees (Horn 3x3). NaN where the 3x3 window is incomplete."""
    return strips(lambda s: _horn(s, res), z, halo=1, rows=rows)


def _plane_fit(z: np.ndarray, res: float, w: int) -> tuple[np.ndarray, np.ndarray]:
    if w % 2 != 1:
        raise ValueError("window_px must be odd")
    nan = ~np.isfinite(z)
    base = float(np.nanmean(z)) if (~nan).any() else 0.0
    zz = np.where(nan, 0.0, z.astype(np.float64) - base)
    k = np.arange(w) - w // 2
    n = w * w
    sxx = w * float((k ** 2).sum()) * res * res  # sum of x^2 over the window
    from scipy.ndimage import correlate

    kx = np.tile(k * res, (w, 1))  # x grows to the east (columns)
    ky = -kx.T  # y grows to the north (rows go south)
    mean = uniform_filter(zz, w, mode="constant")
    mean2 = uniform_filter(zz * zz, w, mode="constant")
    sxz = correlate(zz, kx, mode="constant")
    syz = correlate(zz, ky, mode="constant")
    bx, by = sxz / sxx, syz / sxx
    var = mean2 - mean ** 2 - (bx * bx + by * by) * sxx / n
    bad = uniform_filter(nan.astype(np.float32), w, mode="constant") > 1e-6
    half = w // 2
    bad[:half] = bad[-half:] = True
    bad[:, :half] = bad[:, -half:] = True
    slope = np.degrees(np.arctan(np.hypot(bx, by))).astype(np.float32)
    rough = np.sqrt(np.maximum(var, 0.0)).astype(np.float32)
    slope[bad] = np.nan
    rough[bad] = np.nan
    return slope, rough


def plane_fit(z: np.ndarray, res: float, window_px: int, rows: int = 1024):
    """(slope deg, RMS residual m) of a least-squares plane over a window_px square."""
    return strips(lambda s: _plane_fit(s, res, window_px), z, halo=window_px // 2, rows=rows)


def window_px(window_m: float, res: float) -> int:
    """Odd window size in pixels for a window of ``window_m`` metres."""
    n = int(round(window_m / res))
    return n if n % 2 == 1 else n + 1


def slope_of_grade(grade: float) -> float:
    return math.degrees(math.atan(grade))

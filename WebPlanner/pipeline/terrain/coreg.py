"""Co-registration of the DEM to Curiosity drive ends (F1; site.yaml ``coreg``).

Grid-search the horizontal shift (dx, dy) of the rover positions, within +/- search_m in step_m
steps, that minimises the MAD of r = DEM(x + dx, y + dy) - rover elevation. The median of r is the
vertical offset (DEM minus rover; rover elevations are MMGIS ``elev_geoid``, areoid). Points off
the DEM or on nodata are dropped for that shift, never filled.

Sign convention: (dx, dy) is added to the rover positions (analysis CRS, m) to put them on the DEM,
so dx > 0 means the DEM sits east of where MMGIS puts the rover.
"""

from __future__ import annotations

import numpy as np

from .grid import Grid


def sample_bilinear(z: np.ndarray, g: Grid, x, y) -> np.ndarray:
    """Bilinear sample at analysis-CRS points (cell centres are the nodes). NaN off-grid."""
    x = np.asarray(x, np.float64)
    y = np.asarray(y, np.float64)
    fc = (x - g.x0) / g.res - 0.5
    fr = (g.y0 - y) / g.res - 0.5
    c0 = np.floor(fc).astype(np.int64)
    r0 = np.floor(fr).astype(np.int64)
    tc, tr = fc - c0, fr - r0
    ok = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < z.shape[1]) & (r0 + 1 < z.shape[0])
    out = np.full(x.shape, np.nan)
    c0o, r0o, tco, tro = c0[ok], r0[ok], tc[ok], tr[ok]
    z00 = z[r0o, c0o]
    z01 = z[r0o, c0o + 1]
    z10 = z[r0o + 1, c0o]
    z11 = z[r0o + 1, c0o + 1]
    out[ok] = (z00 * (1 - tco) * (1 - tro) + z01 * tco * (1 - tro) + z10 * (1 - tco) * tro
               + z11 * tco * tro)
    return out


def _mad(r: np.ndarray) -> tuple[float, float, int]:
    r = r[np.isfinite(r)]
    if r.size == 0:
        return np.inf, np.nan, 0
    med = float(np.median(r))
    return float(np.median(np.abs(r - med))), med, int(r.size)


def grid_search(z: np.ndarray, g: Grid, x, y, elev, search_m: float, step_m: float,
                min_frac: float = 0.9) -> dict:
    """Best (dx, dy) by MAD. Shifts that lose more than (1 - min_frac) of the points are skipped
    so that the search cannot win by pushing awkward points off the grid."""
    x, y, elev = (np.asarray(a, np.float64) for a in (x, y, elev))
    n_all = int(np.isfinite(sample_bilinear(z, g, x, y)).sum())
    k = int(round(search_m / step_m))
    shifts = np.arange(-k, k + 1) * step_m
    best = (np.inf, 0.0, 0.0, np.nan, 0)
    surface = np.full((shifts.size, shifts.size), np.nan)
    for i, dy in enumerate(shifts):
        for j, dx in enumerate(shifts):
            r = sample_bilinear(z, g, x + dx, y + dy) - elev
            mad, med, n = _mad(r)
            if n < min_frac * n_all:
                continue
            surface[i, j] = mad
            # ties: prefer the smaller shift
            if mad < best[0] - 1e-12 or (abs(mad - best[0]) <= 1e-12
                                         and dx * dx + dy * dy < best[1] ** 2 + best[2] ** 2):
                best = (mad, float(dx), float(dy), med, n)
    mad, dx, dy, med, n = best
    return {"dx": dx, "dy": dy, "mad": mad, "median": med, "n_used_at_best": n,
            "n_points": int(x.size), "n_on_grid_at_zero": n_all,
            "shifts_m": shifts, "mad_surface": surface}


def residuals(z: np.ndarray, g: Grid, x, y, elev, dx: float, dy: float) -> np.ndarray:
    return sample_bilinear(z, g, np.asarray(x) + dx, np.asarray(y) + dy) - np.asarray(elev)

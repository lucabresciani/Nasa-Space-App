"""Source mask, coverage fractions and data edges (F1; site.yaml ``coverage``).

Source mask codes (contracts/README.md): 1 HiRISE, 2 CTX, 3 HRSC/MOLA, 0 nodata.

D3 (NOT decided: SPEC 11 recommended default applied, awaiting confirmation at G0; site.yaml d3;
"STAC footprints if the mosaic gives none"):
the merged DEM publishes no footprints (docs/discovery.md 2.2), so HiRISE cells are the union of
the STAC ``mro_hirise_socet_dtms`` footprint quads of the pairs the mosaic's Astropedia page lists,
intersected with valid merged-DEM cells. Non-HiRISE valid cells are coded 2: without footprints
CTX and HRSC cannot be told apart, and both are "unknown" for routing anyway (F1). That limitation
is written into coverage.json.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import distance_transform_edt

from .grid import Grid

NODATA, HIRISE, NON_HIRISE, HRSC_MOLA = 0, 1, 2, 3


def rasterize_footprints(polys, g: Grid) -> np.ndarray:
    """Boolean grid: cell centre inside any polygon (analysis CRS)."""
    from rasterio.features import rasterize

    if not polys:
        return np.zeros(g.shape, bool)
    out = rasterize([(p, 1) for p in polys], out_shape=g.shape, transform=g.transform,
                    fill=0, dtype="uint8", all_touched=False)
    return out.astype(bool)


def source_mask(dem: np.ndarray, hirise: np.ndarray) -> np.ndarray:
    m = np.full(dem.shape, NON_HIRISE, np.uint8)
    m[hirise] = HIRISE
    m[~np.isfinite(dem)] = NODATA
    return m


def source_fractions(mask: np.ndarray, window=None) -> dict[int, float]:
    sub = mask if window is None else mask[window]
    n = sub.size
    counts = np.bincount(sub.ravel(), minlength=4)
    return {c: float(counts[c] / n) for c in range(4)}


def disc(g: Grid, centre_xy, radius_m: float) -> np.ndarray:
    """Cells whose centre lies within ``radius_m`` of ``centre_xy``."""
    r = np.arange(g.height)
    c = np.arange(g.width)
    x, y = g.xy_of_rc(r[:, None], c[None, :])
    return (x - centre_xy[0]) ** 2 + (y - centre_xy[1]) ** 2 <= radius_m ** 2


def disc_coverage(state: np.ndarray, disc_mask: np.ndarray, unknown_code: int = 2) -> dict:
    """Assessed (state != unknown) / unknown fractions of a disc. Blocked counts as assessed."""
    n = int(disc_mask.sum())
    unk = int((state[disc_mask] == unknown_code).sum())
    return {"cells": n, "assessed_frac": (n - unk) / n if n else None,
            "unknown_frac": unk / n if n else None}


def data_edge(state: np.ndarray, res: float, buffer_m: float, unknown_code: int = 2):
    """Known cells whose centre is within ``buffer_m`` of an unknown cell's boundary.

    Distance is measured centre-to-centre minus half a cell (to the shared boundary).
    """
    unknown = state == unknown_code
    if not unknown.any():
        return np.zeros(state.shape, bool)
    d = distance_transform_edt(~unknown) * res - res / 2.0
    return (~unknown) & (d <= buffer_m + 1e-9)

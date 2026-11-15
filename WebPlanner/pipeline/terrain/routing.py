"""3 m routing grids (F1, F2; SPEC 11 D22, D23): mean elevation, cell slope, step guard, states.

D22 (user 2026-11-14 16:16 CET):

* **Cell slope** (``slope_3m.tif``) = slope of the least-squares plane through the cell's nine
  1 m elevations (``plane_slope_blocks``).
* **Step guard** (``stepguard_3m.tif``) = any 1 m Horn slope inside the cell exceeds
  ``site.yaml slope.step_guard_deg`` (30 deg, assumed); such a cell is blocked at every no-go.
* **Max 1 m slope** (``maxslope_3m.tif``) is kept only as the "rough footing" overlay.

Cell states (contracts/README.md): 0 assessed, 1 blocked, 2 unknown. A cell is **known** iff all
nine 1 m cells are HiRISE and have a finite elevation and a finite 1 m slope; otherwise unknown,
whatever its slope. At a no-go limit (D23: optimistic 25, nominal 20, conservative 17 deg) a known
cell is blocked iff ``slope_3m > nogo`` or the step guard fires (``cell_state``). Unknown cells are
never entered by a route and are left out of every percentage (``mean_over_known``).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import coverage

ASSESSED, BLOCKED, UNKNOWN = 0, 1, 2
STEPGUARD_NODATA = 255  # stepguard_3m.tif on unknown cells


def _blocks(a: np.ndarray, k: int) -> np.ndarray:
    h, w = a.shape
    if h % k or w % k:
        raise ValueError(f"shape {a.shape} is not a multiple of {k}")
    return a.reshape(h // k, k, w // k, k).swapaxes(1, 2).reshape(h // k, w // k, k * k)


def plane_slope_blocks(dem1: np.ndarray, res_m: float, k: int = 3,
                       rows: int = 512) -> np.ndarray:
    """Slope (deg) of the least-squares plane through each non-overlapping k x k block of 1 m
    elevations (D22). x grows east (columns), y north (rows run south). NaN if any elevation in
    the block is not finite. Computed in float64, in row strips of ``rows`` blocks."""
    h, w = dem1.shape
    if h % k or w % k:
        raise ValueError(f"shape {dem1.shape} is not a multiple of {k}")
    off = (np.arange(k) - (k - 1) / 2.0) * res_m       # cell-centre offsets from the block centre
    sxx = k * float((off ** 2).sum())                  # sum of x^2 over the block (= sum of y^2)
    out = np.full((h // k, w // k), np.nan, np.float32)
    for b0 in range(0, h // k, rows):
        b1 = min(h // k, b0 + rows)
        z = dem1[b0 * k:b1 * k].astype(np.float64).reshape(b1 - b0, k, w // k, k)
        # z[block_row, i (row in block, south), block_col, j (col in block, east)]
        bx = np.einsum("aibj,j->ab", z, off) / sxx
        by = np.einsum("aibj,i->ab", z, -off) / sxx
        with np.errstate(invalid="ignore"):
            out[b0:b1] = np.degrees(np.arctan(np.hypot(bx, by)))
    return out


@dataclass
class CellGrids:
    elev: np.ndarray      # float32, mean of the nine 1 m elevations (NaN if any missing)
    maxslope: np.ndarray  # float32, max 1 m Horn slope (NaN if any missing); rough footing
    slope: np.ndarray     # float32, D22 plane-fit slope; NaN on unknown cells
    stepguard: np.ndarray  # bool, step guard fires (known cells only)
    known: np.ndarray     # bool

    def state(self, nogo_deg: float) -> np.ndarray:
        return cell_state(self.known, self.slope, self.stepguard, nogo_deg)

    def stepguard_u8(self) -> np.ndarray:
        """stepguard_3m.tif codes: 0 no, 1 step guard fires, 255 unknown cell."""
        out = np.full(self.known.shape, STEPGUARD_NODATA, np.uint8)
        out[self.known] = self.stepguard[self.known].astype(np.uint8)
        return out


def cell_grids(dem1: np.ndarray, slope1: np.ndarray, mask1: np.ndarray, *, res_m: float,
               step_guard_deg: float, k: int = 3) -> CellGrids:
    """1 m arrays (aligned, multiples of k) -> the D22 3 m grids."""
    z = _blocks(dem1.astype(np.float32), k)
    s = _blocks(slope1.astype(np.float32), k)
    m = _blocks(mask1, k)
    zfin = np.isfinite(z).all(axis=2)
    sfin = np.isfinite(s).all(axis=2)
    known = (m == coverage.HIRISE).all(axis=2) & zfin & sfin
    with np.errstate(invalid="ignore"):
        elev = np.where(zfin, z.mean(axis=2), np.nan).astype(np.float32)
        mx = np.where(sfin, s.max(axis=2), np.nan).astype(np.float32)
    del z, s, m
    plane = plane_slope_blocks(dem1, res_m, k)
    plane[~known] = np.nan
    with np.errstate(invalid="ignore"):
        sg = known & (mx > step_guard_deg)
    return CellGrids(elev=elev, maxslope=mx, slope=plane, stepguard=sg, known=known)


def cell_state(known: np.ndarray, slope3: np.ndarray, stepguard: np.ndarray,
               nogo_deg: float) -> np.ndarray:
    """D22 cell state at one no-go limit: unknown stays unknown; a known cell is blocked iff
    its plane-fit slope > ``nogo_deg`` or its step guard fires. A known cell without a finite
    plane slope is unknown (never assessed)."""
    known = np.asarray(known, bool) & np.isfinite(slope3)
    out = np.full(known.shape, UNKNOWN, np.uint8)
    out[known] = ASSESSED
    with np.errstate(invalid="ignore"):
        out[known & ((np.asarray(slope3) > nogo_deg) | np.asarray(stepguard, bool))] = BLOCKED
    return out


def passable(cellstate: np.ndarray, slope3: np.ndarray, stepguard_u8: np.ndarray,
             nogo_deg: float) -> np.ndarray:
    """Passability from the written rasters at any no-go (the rule WS2 can use):
    cellstate != unknown, stepguard == 0 and slope_3m <= nogo. Equals ``cellstate_3m_{variant}
    == 0`` at the variant's no-go."""
    with np.errstate(invalid="ignore"):
        return ((np.asarray(cellstate) != UNKNOWN) & (np.asarray(stepguard_u8) == 0)
                & np.isfinite(slope3) & (np.asarray(slope3) <= nogo_deg))


def mean_over_known(values: np.ndarray, state: np.ndarray) -> float:
    keep = state != UNKNOWN
    return float(values[keep].mean()) if keep.any() else float("nan")


def restate_maxslope(state: np.ndarray, maxslope: np.ndarray, nogo_deg: float) -> np.ndarray:
    """The OLD rule (before D22), kept only to compare: a known cell is blocked iff its max 1 m
    slope > ``nogo_deg``; unknown stays unknown; a known cell without a max slope is unknown."""
    st = np.asarray(state)
    mx = np.asarray(maxslope, dtype=np.float64)
    out = np.full(st.shape, UNKNOWN, np.uint8)
    known = (st != UNKNOWN) & np.isfinite(mx)
    out[known] = ASSESSED
    with np.errstate(invalid="ignore"):
        out[known & (mx > nogo_deg)] = BLOCKED
    return out

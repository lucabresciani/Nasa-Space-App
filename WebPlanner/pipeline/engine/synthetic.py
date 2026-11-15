"""Synthetic routing grids for the known-answer tests (planes, walls, holes, the dummy world).

These are test fixtures, not data: nothing here is ever exported or shown in the app.
Geometry numbers for the dummy world are the ones in docs/dummy.md.
"""

from __future__ import annotations

import numpy as np
from pyproj import Transformer

from .config import load
from .graph import ASSESSED, UNKNOWN, Grid


def maxslope_from_elev(elev: np.ndarray, res: float) -> np.ndarray:
    """Per-cell slope (deg) from central differences; a stand-in for WS1's max 1 m slope."""
    gy, gx = np.gradient(elev, res)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def make_grid(elev, res=3.0, *, cellstate=None, nogo_deg=None, x0=None, y0=None, maxslope=None,
              ) -> Grid:  # fmt: skip
    """Synthetic grid; nogo_deg defaults to the nominal variant limit (variants.yaml)."""
    if nogo_deg is None:
        nogo_deg = float(load("variants")["variants"]["nominal"]["nogo_deg"])
    elev = np.asarray(elev, dtype=np.float64)
    h, w = elev.shape
    if cellstate is None:
        cellstate = np.full(elev.shape, ASSESSED, dtype=np.uint8)
    if maxslope is None:
        maxslope = maxslope_from_elev(elev, res)
    x0 = -w * res / 2 if x0 is None else x0
    y0 = h * res / 2 if y0 is None else y0
    g = Grid(
        elev=elev,
        passable=np.ones(elev.shape, bool),
        res_m=res,
        x0=x0,
        y0=y0,
        crs=load("site")["crs"]["analysis_proj"],
        cellstate=np.asarray(cellstate, dtype=np.uint8),
        maxslope=maxslope,
    )
    return g.with_nogo(nogo_deg)


def plane(n=201, res=3.0, grade_north=0.0) -> np.ndarray:
    """Plane rising to the north by `grade_north` (dz/dy); rows grow southwards."""
    rows = np.arange(n, dtype=np.float64)[:, None] * np.ones((1, n))
    return -grade_north * res * rows


def pad_xy() -> tuple[float, float]:
    """Default pad (site.yaml pad_default) in the analysis CRS."""
    site = load("site")
    tr = Transformer.from_crs(_geo_crs(), site["crs"]["analysis_proj"], always_xy=True)
    return tr.transform(site["pad_default"]["lon"], site["pad_default"]["lat"])


def _geo_crs() -> str:
    r = load("site")["crs"]["mars_radius_m"]
    return f"+proj=longlat +R={r} +no_defs"


def dummy_world(res=3.0, half_m=1000.0):
    """docs/dummy.md synthetic world on a `res` grid, centred on the default pad.

    5 % plane rising south; Gaussian hill 40 m / sigma 150 m 600 m NE; straight wall 300 m long,
    8 m high, 35 deg, 400 m W (running N-S); nodata hole r 80 m 500 m SE; CTX strip 300 m on the
    east edge. Returns (grid, pad_rc, features) with feature centres in grid-local metres.
    """
    n = int(round(2 * half_m / res))
    px, py = pad_xy()
    x0, y0 = px - half_m, py + half_m
    xs = (np.arange(n) + 0.5) * res - half_m  # local east, pad at 0
    ys = half_m - (np.arange(n) + 0.5) * res  # local north
    X, Y = np.meshgrid(xs, ys)
    z = -0.05 * Y  # rises to the south
    d45 = 600.0 / np.sqrt(2)
    z += 40.0 * np.exp(-((X - d45) ** 2 + (Y - d45) ** 2) / (2 * 150.0**2))
    # Wall: a ridge 8 m high with 35 deg flanks along x = -400, 300 m long (N-S).
    ridge = np.clip(8.0 - np.abs(X + 400.0) * np.tan(np.radians(35.0)), 0.0, None)
    z += np.where(np.abs(Y) <= 150.0, ridge, 0.0)
    maxslope = maxslope_from_elev(z, res)
    state = np.full((n, n), ASSESSED, np.uint8)
    hole = np.hypot(X - 500 / np.sqrt(2), Y + 500 / np.sqrt(2)) <= 80.0
    state[hole] = UNKNOWN
    state[X >= half_m - 300.0] = UNKNOWN  # CTX strip -> not HiRISE -> unknown (SPEC F1)
    z[hole] = np.nan
    grid = make_grid(z, res, cellstate=state, x0=x0, y0=y0, maxslope=maxslope)
    pad_rc = grid.rc_of_xy(px, py)
    feats = {
        "wall_x": -400.0,
        "wall_half_len": 150.0,
        "hole_c": (500 / np.sqrt(2), -500 / np.sqrt(2)),
        "hole_r": 80.0,
    }
    return grid, pad_rc, feats

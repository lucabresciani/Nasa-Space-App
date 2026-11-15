"""Routing grid and the 16-neighbour directed move set (SPEC F4, D6).

The graph is implicit: every cell of the 3 m grid links to its 8 neighbours and 8 knight moves.
Edge time t(x->y) = length / v*(theta_xy), theta_xy from the elevation difference over the
horizontal length (physio.GradeTable). A move is allowed only if both end cells are passable
and every cell its straight segment crosses is passable (no corner cutting, no knight jumps
over a one-cell wall). Cell states follow contracts/README.md (cellstate_3m.tif).

D22 (user 2026-11-14 16:16): passability uses WS1's 3 m plane-fit cell slope (slope_3m.tif) and
step guard (stepguard_3m.tif: 0 no, 1 fires, 255 unknown cell); a cell is passable at a no-go
limit iff it is not unknown, the step guard does not fire and slope_3m <= nogo (= WS1's
cellstate_3m_{variant} == 0). maxslope_3m.tif is only the "rough footing" overlay (walk-in
report). Synthetic grids without ``slope`` fall back to ``maxslope`` as their cell slope.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

ASSESSED, BLOCKED, UNKNOWN = 0, 1, 2

# (drow, dcol); rows grow southwards, cols eastwards.
OFFSETS = np.array(
    [
        (-1, 0), (1, 0), (0, -1), (0, 1),
        (-1, -1), (-1, 1), (1, -1), (1, 1),
        (-2, -1), (-2, 1), (2, -1), (2, 1),
        (-1, -2), (-1, 2), (1, -2), (1, 2),
    ],
    dtype=np.int64,
)  # fmt: skip


def _crossings() -> tuple[np.ndarray, np.ndarray]:
    """Intermediate cells (relative to the move's origin) each move's segment passes through."""
    cross = np.zeros((16, 2, 2), dtype=np.int64)
    n = np.zeros(16, dtype=np.int64)
    for k, (di, dj) in enumerate(OFFSETS):
        if abs(di) == 1 and abs(dj) == 1:
            cells = [(di, 0), (0, dj)]
        elif abs(di) == 2:
            cells = [(di // 2, 0), (di // 2, dj)]
        elif abs(dj) == 2:
            cells = [(0, dj // 2), (di, dj // 2)]
        else:
            cells = []
        for m, c in enumerate(cells):
            cross[k, m] = c
        n[k] = len(cells)
    return cross, n


CROSS, NCROSS = _crossings()
UNIT_LENGTH = np.hypot(OFFSETS[:, 0], OFFSETS[:, 1]).astype(np.float64)


@dataclass
class Grid:
    """A routing grid in the analysis CRS (north-up, square cells)."""

    elev: np.ndarray  # float64, metres
    passable: np.ndarray  # bool
    res_m: float
    x0: float  # west edge, analysis-CRS metres
    y0: float  # north edge
    crs: str
    cellstate: np.ndarray | None = None  # uint8 (0 assessed, 1 blocked, 2 unknown)
    maxslope: np.ndarray | None = None  # degrees, max 1 m slope (D22: rough footing only)
    slope: np.ndarray | None = None  # degrees, D22 plane-fit cell slope (routing)
    stepguard: np.ndarray | None = None  # bool, D22 step guard fires

    @property
    def routing_slope(self) -> np.ndarray | None:
        """Cell slope for passability and the siting block test (D22 plane fit when loaded)."""
        return self.slope if self.slope is not None else self.maxslope

    @property
    def shape(self) -> tuple[int, int]:
        return self.elev.shape

    def xy_of_rc(self, r, c):
        """Cell-centre coordinates."""
        x = self.x0 + (np.asarray(c) + 0.5) * self.res_m
        y = self.y0 - (np.asarray(r) + 0.5) * self.res_m
        return x, y

    def rc_of_xy(self, x, y) -> tuple[int, int]:
        c = int(np.floor((x - self.x0) / self.res_m))
        r = int(np.floor((self.y0 - y) / self.res_m))
        if not (0 <= r < self.shape[0] and 0 <= c < self.shape[1]):
            raise ValueError(f"point ({x}, {y}) outside the grid")
        return r, c

    @property
    def transform(self):
        from affine import Affine

        return Affine(self.res_m, 0.0, self.x0, 0.0, -self.res_m, self.y0)

    def with_nogo(self, nogo_deg: float) -> Grid:
        """Copy whose passable mask uses a variant's slope limit (needs cellstate + maxslope)."""
        if self.cellstate is None or self.routing_slope is None:
            raise ValueError("grid has no cellstate/slope to re-derive passability")
        g = Grid(**self.__dict__)
        g.passable = passable_mask(self.cellstate, self.routing_slope, nogo_deg, self.elev,
                                   self.stepguard)  # fmt: skip
        return g


def passable_mask(cellstate, slope, nogo_deg: float, elev=None, stepguard=None) -> np.ndarray:
    """Passable = not unknown, cell slope within the variant's limit, no step guard (D22),
    finite elevation. Each variant has its own limit (variants.yaml nogo_deg), so blocked is
    re-derived here from the cell slope (equals WS1's cellstate_3m_{variant} == 0)."""
    with np.errstate(invalid="ignore"):
        ok = (np.asarray(cellstate) != UNKNOWN) & (np.asarray(slope) <= nogo_deg)
    ok &= np.isfinite(slope)
    if stepguard is not None:
        ok &= ~np.asarray(stepguard, bool)
    if elev is not None:
        ok &= np.isfinite(elev)
    return ok


D22_FILES = ("slope_3m.tif", "stepguard_3m.tif")


def load_ws1_grid(terrain_dir: Path) -> Grid:
    """Read WS1's elev_3m.tif, maxslope_3m.tif, cellstate_3m.tif and the D22 slope_3m.tif +
    stepguard_3m.tif (required: the engine never routes on the max 1 m slope again)."""
    import rasterio

    def read(name):
        with rasterio.open(terrain_dir / name) as ds:
            band = ds.read(1, masked=True)
            return np.ma.filled(band.astype(np.float64), np.nan), ds

    elev, ds = read("elev_3m.tif")
    maxslope, _ = read("maxslope_3m.tif")
    with rasterio.open(terrain_dir / "cellstate_3m.tif") as cs:
        cellstate = cs.read(1).astype(np.uint8)
    for f in D22_FILES:
        if not (terrain_dir / f).exists():
            raise FileNotFoundError(f"D22 routing grid {terrain_dir / f} missing (WS1)")
    slope, _ = read("slope_3m.tif")
    with rasterio.open(terrain_dir / "stepguard_3m.tif") as sg:
        stepguard = sg.read(1) == 1
    t = ds.transform
    if abs(t.a + t.e) > 1e-9 or t.b != 0 or t.d != 0:
        raise ValueError("routing grid must be north-up with square cells")
    return Grid(
        elev=elev,
        passable=cellstate == ASSESSED,  # WS1's own limit; call with_nogo() per variant
        res_m=float(t.a),
        x0=float(t.c),
        y0=float(t.f),
        crs=ds.crs.to_string() if ds.crs else "",
        cellstate=cellstate,
        maxslope=maxslope,
        slope=slope,
        stepguard=stepguard,
    )

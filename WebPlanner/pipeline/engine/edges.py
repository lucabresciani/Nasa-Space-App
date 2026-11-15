"""Edge causes of the homeline (SPEC F4).

For the envelope {T_home <= budget}, every boundary piece separates an inside cell from an
outward neighbour. The outward cell decides the cause:

* ``data``       - unknown, off the grid, or within ``buffer_m`` of an unknown cell
                   (site.yaml coverage.source_edge_buffer_m);
* ``slope``      - not passable for this variant (max slope above its limit);
* ``physiology`` - passable but too far.

Boundaries come from marching squares at level 0.5 on the inside mask, so every vertex sits
midway between one inside and one outside cell. Consecutive vertices with the same cause are
merged into LineStrings.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import distance_transform_edt
from shapely.geometry import LineString, MultiLineString
from skimage.measure import find_contours

from .envelope import envelope_mask
from .geo import feature_collection
from .graph import UNKNOWN, Grid

CAUSES = ("physiology", "slope", "data")
PHYS, SLOPE, DATA = 0, 1, 2


def cause_grid(grid: Grid, buffer_m: float) -> np.ndarray:
    """Cause code each cell would give if it were the outward neighbour of the envelope."""
    if grid.cellstate is None:
        raise ValueError("edge causes need the cell-state grid")
    unknown = (grid.cellstate == UNKNOWN) | ~np.isfinite(grid.elev)
    dist = distance_transform_edt(~unknown) * grid.res_m if unknown.any() else None
    out = np.full(grid.shape, PHYS, dtype=np.int8)
    out[~grid.passable] = SLOPE
    data = unknown if dist is None else (dist <= buffer_m)
    out[data] = DATA
    return out


def edge_lines(grid: Grid, t_min: np.ndarray, budget: float, buffer_m: float):
    """[(LineString in analysis CRS, cause)] for one budget."""
    inside = np.pad(envelope_mask(t_min, budget), 1)
    causes = np.pad(cause_grid(grid, buffer_m), 1, constant_values=DATA)  # off-grid -> data
    out = []
    for contour in find_contours(inside.astype(np.float64), 0.5):
        if len(contour) < 2:
            continue
        codes = np.array([_vertex_cause(inside, causes, r, c) for r, c in contour])
        x = grid.x0 + (contour[:, 1] - 1 + 0.5) * grid.res_m
        y = grid.y0 - (contour[:, 0] - 1 + 0.5) * grid.res_m
        start = 0
        for i in range(1, len(codes) + 1):
            if i == len(codes) or codes[i] != codes[start]:
                end = min(i, len(codes) - 1)  # share the transition vertex
                if end > start:
                    seg = LineString(np.column_stack([x[start : end + 1], y[start : end + 1]]))
                    out.append((seg, CAUSES[codes[start]]))
                start = i
    return out


def _vertex_cause(inside, causes, r, c) -> int:
    """Cause of the outside cell adjacent to a marching-squares vertex at (r, c)."""
    r0, r1 = int(np.floor(r)), int(np.ceil(r))
    c0, c1 = int(np.floor(c)), int(np.ceil(c))
    best = PHYS
    for rr in {r0, r1}:
        for cc in {c0, c1}:
            if not inside[rr, cc]:
                best = max(best, int(causes[rr, cc]))  # data > slope > physiology
    return best


def edges(grid: Grid, t_min: np.ndarray, budgets, buffer_m: float, simplify_m: float) -> dict:
    """edges.geojson FeatureCollection (contract edges) for the given budgets: one
    MultiLineString per (budget, cause), lossless (same pieces as separate LineStrings, without
    the per-feature overhead; the contract allows MultiLineString)."""
    items = []
    for b in budgets:
        parts: dict[str, list] = {c: [] for c in CAUSES}
        for line, cause in edge_lines(grid, t_min, b, buffer_m):
            geom = line.simplify(simplify_m) if simplify_m else line
            if not geom.is_empty:
                parts[cause].append(geom)
        for cause in CAUSES:
            if parts[cause]:
                g = parts[cause][0] if len(parts[cause]) == 1 else MultiLineString(parts[cause])
                items.append((g, {"budget": int(b), "cause": cause}))
    return feature_collection(items, grid.crs)

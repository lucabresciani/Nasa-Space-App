"""Envelopes from a return field: isochrones (F5), bands (F4) and the headline percentage (F4).

All geometry is built in the analysis CRS on cell edges, simplified, then reprojected by
geo.feature_collection. Unreached and unknown cells are never inside an envelope, so unknown
islands appear as holes.
"""

from __future__ import annotations

import numpy as np
from rasterio.features import shapes
from shapely import make_valid
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import unary_union

from .geo import feature_collection
from .graph import UNKNOWN, Grid


def envelope_mask(t_min: np.ndarray, minutes: float) -> np.ndarray:
    return np.isfinite(t_min) & (t_min <= minutes)


def drop_small_holes(geom, min_hole_m2: float):
    """Fill interior rings smaller than min_hole_m2 (display filter; routing unchanged)."""
    if geom is None or not min_hole_m2:
        return geom

    def fix(p):
        return Polygon(p.exterior, [r for r in p.interiors if Polygon(r).area >= min_hole_m2])

    if geom.geom_type == "Polygon":
        return fix(geom)
    if geom.geom_type == "MultiPolygon":
        return MultiPolygon([fix(p) for p in geom.geoms])
    if geom.geom_type == "GeometryCollection":  # make_valid can return one; keep areal parts
        parts = [fix(p) for g in geom.geoms for p in getattr(g, "geoms", [g])
                 if p.geom_type == "Polygon"]  # fmt: skip
        return MultiPolygon(parts) if parts else None
    return geom


def mask_polygon(grid: Grid, mask: np.ndarray, simplify_m: float, min_hole_m2: float = 0.0):
    """Union of the cells in `mask` as a (Multi)Polygon in the analysis CRS. Holes smaller than
    min_hole_m2 are filled before simplification (display filter)."""
    if not mask.any():
        return None
    polys = [
        shape(g)
        for g, _ in shapes(
            mask.astype(np.uint8), mask=mask, transform=grid.transform, connectivity=8
        )
    ]
    geom = make_valid(unary_union(polys))
    geom = drop_small_holes(geom, min_hole_m2)
    if simplify_m:
        geom = make_valid(geom.simplify(simplify_m, preserve_topology=True))
    return geom


def isochrones(grid: Grid, t_min: np.ndarray, minutes, simplify_m: float,
               min_hole_m2: float = 0.0) -> dict:  # fmt: skip
    """FeatureCollection with one {T_home <= m} polygon per m (contract isochrones).
    min_hole_m2: display filter (variants.yaml outputs.display_min_hole_m2)."""
    items = [
        (mask_polygon(grid, envelope_mask(t_min, m), simplify_m, min_hole_m2),
         {"minutes": int(m)})
        for m in minutes
    ]  # fmt: skip
    return feature_collection(items, grid.crs)


def bands(grid: Grid, t_by_variant: dict[str, np.ndarray], budgets, simplify_m: float) -> dict:
    """bands_{suit}: one polygon per variant x budget (contract bands)."""
    items = [
        (mask_polygon(grid, envelope_mask(t, b), simplify_m), {"budget": int(b), "variant": v})
        for v, t in t_by_variant.items()
        for b in budgets
    ]
    return feature_collection(items, grid.crs)


def flat_disc(grid: Grid, pad_rc, radius_m: float) -> np.ndarray:
    r, c = np.indices(grid.shape)
    return np.hypot(r - pad_rc[0], c - pad_rc[1]) * grid.res_m <= radius_m


def disc_in_grid(grid: Grid, pad_rc, radius_m: float) -> bool:
    r0, c0 = pad_rc
    n = int(np.ceil(radius_m / grid.res_m))
    return not (r0 - n < 0 or c0 - n < 0 or r0 + n >= grid.shape[0] or c0 + n >= grid.shape[1])


def full_disc_cells(radius_m: float, res_m: float) -> int:
    """Cells of the flat disc on an unbounded grid (same centre-distance test as flat_disc)."""
    n = int(np.ceil(radius_m / res_m))
    r, c = np.mgrid[-n : n + 1, -n : n + 1]
    return int((np.hypot(r, c) * res_m <= radius_m).sum())


def disc_in_data_pct(grid: Grid, pad_rc, budget_min: float, disc_speed_ms: float) -> float:
    """D41: % of the flat disc (r = disc_speed x budget) that lies inside the terrain data
    (inside the routing grid and not unknown), of the whole disc's cells."""
    radius = disc_speed_ms * budget_min * 60.0
    inside = flat_disc(grid, pad_rc, radius) & (grid.cellstate != UNKNOWN)
    return 100.0 * int(inside.sum()) / full_disc_cells(radius, grid.res_m)


def reachable_pct(grid: Grid, t_min, pad_rc, budget_min: float, disc_speed_ms: float,
                  in_data: bool = False):  # fmt: skip
    """% of the assessed flat disc (r = disc_speed x budget) with T_home <= budget.

    Unknown cells are left out of numerator and denominator (SPEC F1). Returns None when the
    disc holds no assessed cell or runs off the grid (the number would be wrong, not small),
    unless ``in_data`` (D41, user 17:22): then the share is over the part of the disc inside
    the terrain data (report its size with ``disc_in_data_pct``).
    """
    if grid.cellstate is None:
        raise ValueError("headline needs the cell-state grid")
    radius = disc_speed_ms * budget_min * 60.0
    if not in_data and not disc_in_grid(grid, pad_rc, radius):
        return None
    disc = flat_disc(grid, pad_rc, radius) & (grid.cellstate != UNKNOWN)
    den = int(disc.sum())
    if den == 0:
        return None
    return 100.0 * int((disc & envelope_mask(t_min, budget_min)).sum()) / den


def headline(grid, t_by_variant, pad_rc, budget_min, disc_speed_ms) -> dict:
    """{budget_min, reachable_pct (nominal), range_pct [conservative, optimistic]} (contract)."""
    pct = {
        v: reachable_pct(grid, t, pad_rc, budget_min, disc_speed_ms)
        for v, t in t_by_variant.items()
    }
    lo, hi = pct.get("conservative"), pct.get("optimistic")
    if lo is not None and hi is not None and lo > hi:
        lo, hi = hi, lo
    return {"budget_min": budget_min, "reachable_pct": pct.get("nominal"), "range_pct": [lo, hi]}

"""Far terrain mesh for the 3D view (WS8, F20): ``fp3d/far.f32.gz``.

One height grid at ``far.res_m`` (config/fp3d.yaml, 8 m per contracts/README.md), a square
centred on the pad. By default it is the near-chunk grid square (the M0 dummy's 928 x 928); with
``far.half_extent_m`` it is the smallest pad-centred square of whole near chunks covering that
half-width (NW corner recorded as ``far.origin_xy_m``), so the terrain a few km beyond the route is
a mesh and the pad-centred skyline ring only draws the distant rim. Each cell is the area mean of
the best source that covers it completely (sources in priority order: the 1 m DEM, then CTX
20 m, then MOLA-HRSC); cells no source covers are filled from the nearest valid cell. Same byte
layout as the near chunks (see :mod:`pipeline.export.terrain_chunks`).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from affine import Affine

from pipeline.export.terrain_chunks import (
    FAR_FILE,
    ChunkGrid,
    encode_heights,
    fill_nodata,
    resample_mean,
)


def far_grid(grid: ChunkGrid, half_extent_m: float | None = None) -> ChunkGrid:
    """The far-mesh square as a chunk grid sharing the near grid's centre and chunk size."""
    if not half_extent_m or half_extent_m <= grid.extent_m / 2:
        return grid
    size = grid.size_m
    n = 2 * math.ceil((half_extent_m - size / 2) / size) + 1
    k = (n - grid.n) // 2
    return ChunkGrid(x0=grid.x0 - k * size, y0=grid.y0 + k * size, chunk_px=grid.chunk_px,
                     res_m=grid.res_m, n=n)


def far_shape(grid: ChunkGrid, res_m: float) -> tuple[int, int]:
    n = int(round(grid.extent_m / res_m))
    if abs(n * res_m - grid.extent_m) > 1e-6:
        raise ValueError(f"far res {res_m} m does not divide the grid extent {grid.extent_m} m")
    return (n, n)


def far_cell_centres(grid: ChunkGrid, res_m: float) -> tuple[np.ndarray, np.ndarray]:
    """x of each column and y of each row (row 0 = north) of the far grid."""
    rows, cols = far_shape(grid, res_m)
    return (grid.x0 + (np.arange(cols) + 0.5) * res_m,
            grid.y0 - (np.arange(rows) + 0.5) * res_m)


def far_heights(sources: list[tuple[np.ndarray, Affine]], grid: ChunkGrid, res_m: float
                ) -> tuple[np.ndarray, list[int]]:
    """Far grid heights: per cell, the area mean from the first source covering it fully.
    Returns (heights, cells taken from each source; the last entry = filled cells)."""
    shape = far_shape(grid, res_m)
    out = np.full(shape, np.nan)
    counts = []
    for arr, tr in sources:
        todo = ~np.isfinite(out)
        if not todo.any():
            counts.append(0)
            continue
        v = resample_mean(arr, tr, grid.x0, grid.y0, res_m, shape)
        take = todo & np.isfinite(v)
        out[take] = v[take]
        counts.append(int(take.sum()))
    filled, nfill = fill_nodata(out)
    return filled, counts + [nfill]


def export_far(sources: list[tuple[np.ndarray, Affine]], grid: ChunkGrid, res_m: float,
               out_dir: Path, quantum_m: float, *, source_names: list[str] | None = None) -> dict:
    """Write ``<out_dir>/fp3d/far.f32.gz`` over ``grid`` (see :func:`far_grid`); returns the
    index.json ``far`` entry (bounds are added by the index builder)."""
    h, counts = far_heights(sources, grid, res_m)
    data = encode_heights(h, quantum_m)
    path = Path(out_dir) / FAR_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    rows, cols = h.shape
    names = source_names or [f"source_{k}" for k in range(len(sources))]
    return {"file": FAR_FILE, "res_m": float(res_m), "width": cols, "height": rows,
            "origin_xy_m": [round(grid.x0, 3), round(grid.y0, 3)], "bytes": len(data),
            "cells_by_source": {**dict(zip(names, counts[:-1], strict=True)),
                                "filled_nearest": counts[-1]}}

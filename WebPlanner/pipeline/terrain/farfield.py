"""Far-field band co-registration (WS1 session 2; WS3 Blocked 3 "band step at 2 km").

The canonical ``ctx_20m.tif`` levels each CTX item to MOLA-HRSC by one median over the whole
34 km disc. Where CTX overlaps ``dem_1m`` it then sits ~+20 m above it, which lifts predicted
skylines at the 2 km dem_1m -> CTX handover. ``ctx_20m_v2.tif`` instead co-registers each CTX
item to ``dem_1m`` (block-averaged to 20 m) in their overlap: a horizontal grid search (MAD, the
same metric as the rover co-registration) and then the median vertical offset. Items without
enough overlap keep the MOLA levelling.

Sign convention (as ``coreg.py``): the fit's (dx, dy) is added to positions to sample the item,
``corrected(x, y) = item(x + dx, y + dy) - offset_m``; i.e. the item's content sits (dx, dy) away
from the reference frame. No cell is filled: NaN stays NaN.
"""

from __future__ import annotations

import numpy as np

from . import coreg
from .grid import Grid


def block_mean(a: np.ndarray, k: int) -> np.ndarray:
    """Mean over k x k blocks (trailing partial blocks dropped); NaN if any cell is NaN."""
    h, w = a.shape[0] // k * k, a.shape[1] // k * k
    return a[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))


def reference_on(gc: Grid, ref: np.ndarray, gr: Grid) -> np.ndarray:
    """The fine reference block-averaged onto the coarse grid ``gc`` (NaN where it has no data).
    The reference lattice must nest in the coarse one (edges at gc.x0 + k * gc.res)."""
    k = int(round(gc.res / gr.res))
    if abs(k * gr.res - gc.res) > 1e-9:
        raise ValueError(f"reference res {gr.res} does not divide item res {gc.res}")
    c0 = (gr.x0 - gc.x0) / gc.res
    r0 = (gc.y0 - gr.y0) / gc.res
    if abs(c0 - round(c0)) > 1e-6 or abs(r0 - round(r0)) > 1e-6:
        raise ValueError("reference lattice does not nest in the item lattice")
    c0, r0 = int(round(c0)), int(round(r0))
    b = block_mean(ref, k)
    out = np.full(gc.shape, np.nan, np.float32)
    rs, cs = max(0, r0), max(0, c0)
    re_, ce = min(gc.height, r0 + b.shape[0]), min(gc.width, c0 + b.shape[1])
    if re_ > rs and ce > cs:
        out[rs:re_, cs:ce] = b[rs - r0:re_ - r0, cs - c0:ce - c0]
    return out


def _stats(d: np.ndarray) -> dict:
    d = d[np.isfinite(d)]
    if d.size == 0:
        return {"n": 0, "median_m": None, "mad_m": None, "p5_m": None, "p95_m": None}
    med = float(np.median(d))
    return {"n": int(d.size), "median_m": round(med, 3),
            "mad_m": round(float(np.median(np.abs(d - med))), 3),
            "p5_m": round(float(np.percentile(d, 5)), 3),
            "p95_m": round(float(np.percentile(d, 95)), 3)}


def coregister_to_reference(item: np.ndarray, gc: Grid, ref: np.ndarray, gr: Grid, *,
                            search_m: float, step_m: float, n_sample: int, min_cells: int,
                            seed: int = 0) -> dict | None:
    """Best (dx, dy) by MAD of item(x + dx, y + dy) - reference over the overlap, then the
    median offset. None if fewer than ``min_cells`` overlapping coarse cells."""
    refc = reference_on(gc, ref, gr)
    ok = np.isfinite(refc) & np.isfinite(item)
    if int(ok.sum()) < min_cells:
        return None
    rr, cc = np.where(ok)
    rng = np.random.default_rng(seed)
    sel = rng.choice(rr.size, size=min(n_sample, rr.size), replace=False)
    x, y = gc.xy_of_rc(rr[sel], cc[sel])
    h = refc[rr[sel], cc[sel]]
    s = coreg.grid_search(item, gc, x, y, h, search_m=search_m, step_m=step_m)
    before = _stats((item - refc)[ok])
    fit = {"dx": float(s["dx"]), "dy": float(s["dy"]), "offset_m": float(s["median"]),
           "n_overlap_cells": int(ok.sum()), "n_sample": int(sel.size),
           "search_m": search_m, "step_m": step_m, "before": before}
    corr = apply_fit(item, gc, fit)
    fit["after"] = _stats(corr - refc)
    return fit


def _bilinear_exact_nodes(z: np.ndarray, g: Grid, x, y, eps: float = 1e-6) -> np.ndarray:
    """Bilinear sample where a neighbour with zero weight is ignored, so a point on a cell centre
    (or on a centre row/column) returns that value even at the grid edge or next to NaN. A NaN
    neighbour with non-zero weight gives NaN (never filled)."""
    fc = (np.asarray(x, np.float64) - g.x0) / g.res - 0.5
    fr = (g.y0 - np.asarray(y, np.float64)) / g.res - 0.5
    fc = np.where(np.abs(fc - np.round(fc)) < eps, np.round(fc), fc)
    fr = np.where(np.abs(fr - np.round(fr)) < eps, np.round(fr), fr)
    c0 = np.floor(fc).astype(np.int64)
    r0 = np.floor(fr).astype(np.int64)
    tc, tr = fc - c0, fr - r0
    acc = np.zeros(fc.shape)
    bad = np.zeros(fc.shape, bool)
    for dr, dc, w in ((0, 0, (1 - tr) * (1 - tc)), (0, 1, (1 - tr) * tc),
                      (1, 0, tr * (1 - tc)), (1, 1, tr * tc)):
        r, c = r0 + dr, c0 + dc
        need = w > 0
        inside = (r >= 0) & (r < z.shape[0]) & (c >= 0) & (c < z.shape[1])
        v = np.full(fc.shape, np.nan)
        v[inside] = z[r[inside], c[inside]]
        bad |= need & ~np.isfinite(v)
        acc += np.where(need, np.nan_to_num(v) * w, 0.0)
    return np.where(bad, np.nan, acc)


def apply_fit(item: np.ndarray, gc: Grid, fit: dict, rows_per_chunk: int = 256) -> np.ndarray:
    """corrected(x, y) = item(x + dx, y + dy) - offset_m (bilinear; NaN stays NaN, off-grid NaN).
    Whole-cell shifts reproduce the item values exactly."""
    out = np.full(item.shape, np.nan, np.float32)
    cols = np.arange(gc.width)
    for r0 in range(0, gc.height, rows_per_chunk):
        rows = np.arange(r0, min(gc.height, r0 + rows_per_chunk))
        x, y = gc.xy_of_rc(rows[:, None], cols[None, :])
        x = np.broadcast_to(x, (rows.size, cols.size))
        y = np.broadcast_to(y, (rows.size, cols.size))
        v = _bilinear_exact_nodes(item, gc, x + fit["dx"], y + fit["dy"])
        out[rows[0]:rows[-1] + 1] = (v - fit["offset_m"]).astype(np.float32)
    return out


def ring_stats(z: np.ndarray, gz: Grid, ref_sampler, centre: tuple[float, float],
               rings_m: list[tuple[float, float]], n_sample: int = 200000, seed: int = 0) -> dict:
    """Median etc. of z - ref per distance ring from ``centre`` (ref_sampler(x, y) -> values)."""
    rr, cc = np.where(np.isfinite(z))
    if rr.size == 0:
        return {f"{a:g}-{b:g}": _stats(np.array([])) for a, b in rings_m}
    sel = np.random.default_rng(seed).choice(rr.size, size=min(n_sample, rr.size), replace=False)
    x, y = gz.xy_of_rc(rr[sel], cc[sel])
    d = z[rr[sel], cc[sel]] - ref_sampler(x, y)
    dist = np.hypot(x - centre[0], y - centre[1])
    return {f"{a:g}-{b:g}": _stats(d[(dist >= a) & (dist < b)]) for a, b in rings_m}

"""Numba binary-heap Dijkstra on the implicit 16-neighbour grid (SPEC F4, decision D6).

* reverse=True  (return field): seeds are the destination (pad). For a settled cell y, every
  predecessor x = y - off_k is relaxed with the cost of the *real* move x->y. Result: T_home(x),
  O2_home(x) and a pointer k with next cell = x + off_k.
* reverse=False (forward field): seeds are the start (station). Neighbour y = x + off_k is
  relaxed with the cost of x->y. Pointer k on y means previous cell = y - off_k.

Times are minimised; O2 is accumulated along the time-optimal path. Edge costs come from a
physio.GradeTable (per-metre pace and O2 vs grade angle, linear interpolation).
"""

from __future__ import annotations

from dataclasses import dataclass

import numba as nb
import numpy as np

from .graph import CROSS, NCROSS, OFFSETS, UNIT_LENGTH, Grid
from .physio import GradeTable

NO_POINTER = -1


@nb.njit(cache=True)
def _heap_push(hk, hv, size, key, val):
    if size == hk.shape[0]:
        nk = np.empty(2 * size, dtype=hk.dtype)
        nv = np.empty(2 * size, dtype=hv.dtype)
        nk[:size] = hk
        nv[:size] = hv
        hk, hv = nk, nv
    i = size
    hk[i] = key
    hv[i] = val
    while i > 0:
        p = (i - 1) >> 1
        if hk[p] <= hk[i]:
            break
        hk[p], hk[i] = hk[i], hk[p]
        hv[p], hv[i] = hv[i], hv[p]
        i = p
    return hk, hv, size + 1


@nb.njit(cache=True)
def _heap_pop(hk, hv, size):
    key, val = hk[0], hv[0]
    size -= 1
    hk[0], hv[0] = hk[size], hv[size]
    i = 0
    while True:
        lft = 2 * i + 1
        if lft >= size:
            break
        m = lft
        if lft + 1 < size and hk[lft + 1] < hk[lft]:
            m = lft + 1
        if hk[i] <= hk[m]:
            break
        hk[m], hk[i] = hk[i], hk[m]
        hv[m], hv[i] = hv[i], hv[m]
        i = m
    return key, val, size


@nb.njit(cache=True)
def _dijkstra(elev, passable, res, seeds, reverse, pace, o2t, th0, dth, tmax_s, offs, cross, ncross,
              unit_len):  # fmt: skip
    H, W = elev.shape
    T = np.full((H, W), np.inf)
    O2 = np.full((H, W), np.inf)
    ptr = np.full((H, W), -1, dtype=np.int8)
    done = np.zeros((H, W), dtype=np.bool_)
    ntab = pace.shape[0]
    hk = np.empty(1 << 16, dtype=np.float64)
    hv = np.empty(1 << 16, dtype=np.int64)
    size = 0
    for s in range(seeds.shape[0]):
        r, c = seeds[s, 0], seeds[s, 1]
        T[r, c] = 0.0
        O2[r, c] = 0.0
        hk, hv, size = _heap_push(hk, hv, size, 0.0, r * W + c)
    rad2deg = 180.0 / np.pi
    while size > 0:
        key, idx, size = _heap_pop(hk, hv, size)
        r = idx // W
        c = idx - r * W
        if done[r, c] or key > T[r, c]:
            continue
        if key > tmax_s:
            break
        done[r, c] = True
        for k in range(16):
            di, dj = offs[k, 0], offs[k, 1]
            if reverse:
                nr, nc = r - di, c - dj
            else:
                nr, nc = r + di, c + dj
            if nr < 0 or nr >= H or nc < 0 or nc >= W:
                continue
            if done[nr, nc] or not passable[nr, nc]:
                continue
            # origin of the real move: x (= neighbour) in reverse, the settled cell forward
            orr, orc = (nr, nc) if reverse else (r, c)
            blocked = False
            for m in range(ncross[k]):
                cr, cc = orr + cross[k, m, 0], orc + cross[k, m, 1]
                if cr < 0 or cr >= H or cc < 0 or cc >= W or not passable[cr, cc]:
                    blocked = True
                    break
            if blocked:
                continue
            length = res * unit_len[k]
            if reverse:
                dz = elev[r, c] - elev[nr, nc]
            else:
                dz = elev[nr, nc] - elev[r, c]
            theta = np.arctan2(dz, length) * rad2deg
            f = (theta - th0) / dth
            i0 = int(f)
            if i0 < 0:
                i0 = 0
            elif i0 > ntab - 2:
                i0 = ntab - 2
            w = f - i0
            p0, p1 = pace[i0], pace[i0 + 1]
            if not (np.isfinite(p0) and np.isfinite(p1)):
                continue
            nt = key + length * (p0 + w * (p1 - p0))
            if nt < T[nr, nc]:
                T[nr, nc] = nt
                O2[nr, nc] = O2[r, c] + length * (o2t[i0] + w * (o2t[i0 + 1] - o2t[i0]))
                ptr[nr, nc] = k
                hk, hv, size = _heap_push(hk, hv, size, nt, nr * W + nc)
    return T, O2, ptr


@dataclass
class Field:
    """Result of one Dijkstra run. t_min / o2_l are inf where unreached."""

    t_min: np.ndarray
    o2_l: np.ndarray
    ptr: np.ndarray  # int8 move index, -1 at seeds and unreached cells
    seeds: np.ndarray  # (n, 2) row, col
    reverse: bool


def run(grid: Grid, table: GradeTable, seeds, *, reverse: bool, tmax_min: float | None = None,
        ) -> Field:  # fmt: skip
    seeds = np.atleast_2d(np.asarray(seeds, dtype=np.int64))
    tmax_s = np.inf if tmax_min is None else float(tmax_min) * 60.0
    T, O2, ptr = _dijkstra(
        np.ascontiguousarray(grid.elev, dtype=np.float64),
        np.ascontiguousarray(grid.passable, dtype=np.bool_),
        float(grid.res_m),
        seeds,
        bool(reverse),
        table.pace_s_per_m,
        table.o2_l_per_m,
        float(table.theta_deg[0]),
        float(table.step_deg),
        tmax_s,
        OFFSETS,
        CROSS,
        NCROSS,
        UNIT_LENGTH,
    )
    return Field(T / 60.0, O2, ptr, seeds, reverse)


def return_field(grid: Grid, table: GradeTable, pad_rc, tmax_min: float | None = None) -> Field:
    """T_home, O2_home and way-home pointer: one reverse Dijkstra from the pad."""
    return run(grid, table, [pad_rc], reverse=True, tmax_min=tmax_min)


def forward_field(grid: Grid, table: GradeTable, src_rc, tmax_min: float | None = None) -> Field:
    """Time and O2 from src to every cell: one forward Dijkstra."""
    return run(grid, table, [src_rc], reverse=False, tmax_min=tmax_min)


def trace(field: Field, rc) -> list[tuple[int, int]]:
    """Cells along the optimal path: to the seed (reverse) or back from the seed (forward)."""
    r, c = int(rc[0]), int(rc[1])
    if not np.isfinite(field.t_min[r, c]):
        raise ValueError(f"cell {rc} not reached")
    path = [(r, c)]
    sign = 1 if field.reverse else -1
    for _ in range(field.ptr.size):
        k = field.ptr[r, c]
        if k == NO_POINTER:
            break
        r, c = r + sign * int(OFFSETS[k, 0]), c + sign * int(OFFSETS[k, 1])
        path.append((r, c))
    if not field.reverse:
        path.reverse()
    return path

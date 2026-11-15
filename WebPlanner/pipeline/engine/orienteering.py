"""Traverse optimiser (SPEC F9): exact orienteering DP over station subsets, plus brute force.

Times in minutes. Node indices 0..n-1 are stations; the pad is separate. A route starts and
ends at the pad, visits each chosen station once and dwells there. Feasible when
sum(walk + dwell) <= budget and every leg passes `leg_ok(frm, to, depart_min)` (frm/to = -1 for
the pad). leg_ok must be monotone in departure time (earlier is never worse), which holds for
the route margin (O2 left, daylight, dose all shrink with time); then minimising the time per
(subset, last station) state keeps the DP exact.
"""

from __future__ import annotations

import itertools
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

PAD = -1
LegOk = Callable[[int, int, float], bool]


@dataclass
class Plan:
    value: float
    order: list[int]
    total_min: float


def _always(_frm, _to, _t):
    return True


def _better(a: Plan | None, b: Plan) -> bool:
    if a is None:
        return True
    if b.value > a.value + 1e-9:
        return True
    return abs(b.value - a.value) <= 1e-9 and b.total_min < a.total_min - 1e-9


def solve(values, dwell, t_from_pad, t_to_pad, t_leg, budget_min, leg_ok: LegOk | None = None,
          ) -> Plan:  # fmt: skip
    """Exact DP, O(2^n n^2). Maximise value, then minimise total time."""
    ok = leg_ok or _always
    values = np.asarray(values, float)
    dwell = np.broadcast_to(np.asarray(dwell, float), values.shape)
    n = len(values)
    if n > 20:
        raise ValueError("DP over more than 20 stations is not supported")
    inf = np.inf
    done = np.full((1 << n, n), inf)  # time when leaving station j having visited mask
    prev = np.full((1 << n, n), -2, dtype=np.int64)
    for j in range(n):
        if np.isfinite(t_from_pad[j]) and ok(PAD, j, 0.0):
            done[1 << j, j] = t_from_pad[j] + dwell[j]
            prev[1 << j, j] = PAD
    best = Plan(0.0, [], 0.0)
    for mask in range(1, 1 << n):
        for j in range(n):
            t = done[mask, j]
            if not np.isfinite(t) or t > budget_min:
                continue
            back = t + t_to_pad[j]
            if back <= budget_min + 1e-9 and ok(j, PAD, t):
                cand = Plan(float(values[[i for i in range(n) if mask >> i & 1]].sum()), [], back)
                if _better(best, cand):
                    cand.order = _unwind(prev, mask, j)
                    best = cand
            for k in range(n):
                if mask >> k & 1 or not np.isfinite(t_leg[j, k]):
                    continue
                tk = t + t_leg[j, k] + dwell[k]
                nm = mask | (1 << k)
                if tk < done[nm, k] and tk <= budget_min and ok(j, k, t):
                    done[nm, k] = tk
                    prev[nm, k] = j
    return best


def feasible_subsets(dwell, t_from_pad, t_to_pad, t_leg, budget_min, leg_ok: LegOk | None = None,
                     ) -> list[int]:  # fmt: skip
    """D21: every non-empty station subset (bit mask) with at least one feasible route (pad ->
    each station once in some order -> pad, sum(walk + dwell) <= budget, every leg_ok). Exact by
    the same argument as ``solve``: with leg_ok monotone in departure time, the earliest time
    per (subset, last station) dominates. O(2^n n^2)."""
    ok = leg_ok or _always
    t_from_pad = np.asarray(t_from_pad, float)
    n = len(t_from_pad)
    dwell = np.broadcast_to(np.asarray(dwell, float), (n,))
    t_to_pad, t_leg = np.asarray(t_to_pad, float), np.asarray(t_leg, float).reshape(n, n)
    if n > 20:
        raise ValueError("more than 20 stations is not supported")
    done = np.full((1 << n, n), np.inf)
    for j in range(n):
        if np.isfinite(t_from_pad[j]) and ok(PAD, j, 0.0):
            done[1 << j, j] = t_from_pad[j] + dwell[j]
    feas = []
    for mask in range(1, 1 << n):
        good = False
        for j in range(n):
            t = done[mask, j]
            if not np.isfinite(t) or t > budget_min + 1e-9:
                continue
            if not good and t + t_to_pad[j] <= budget_min + 1e-9 and ok(j, PAD, t):
                good = True
            for k in range(n):
                if mask >> k & 1 or not np.isfinite(t_leg[j, k]):
                    continue
                tk = t + t_leg[j, k] + dwell[k]
                nm = mask | (1 << k)
                if tk < done[nm, k] and tk <= budget_min + 1e-9 and ok(j, k, t):
                    done[nm, k] = tk
        if good:
            feas.append(mask)
    return feas


def feasible_subsets_brute(dwell, t_from_pad, t_to_pad, t_leg, budget_min, leg_ok=None,
                           ) -> list[int]:  # fmt: skip
    """Reference for the KAT: a subset is feasible if any ordering passes ``evaluate``."""
    n = len(t_from_pad)
    out = []
    for mask in range(1, 1 << n):
        members = [i for i in range(n) if mask >> i & 1]
        if any(evaluate(list(o), dwell, t_from_pad, t_to_pad, t_leg, budget_min, leg_ok)
               is not None for o in itertools.permutations(members)):  # fmt: skip
            out.append(mask)
    return out


def _unwind(prev, mask, j) -> list[int]:
    order = []
    while j != PAD:
        order.append(j)
        pj = int(prev[mask, j])
        mask &= ~(1 << j)
        j = pj
    return order[::-1]


def evaluate(order, dwell, t_from_pad, t_to_pad, t_leg, budget_min, leg_ok=None):
    """Total minutes of a given order, or None if infeasible."""
    dw = np.broadcast_to(np.asarray(dwell, float), (len(t_from_pad),)).tolist()
    return _evaluate(order, dw, list(t_from_pad), list(t_to_pad), np.asarray(t_leg).tolist(),
                     budget_min, leg_ok or _always)  # fmt: skip


def _evaluate(order, dw, t_from, t_to, t_leg, budget_min, ok):
    t, here = 0.0, PAD
    for k in order:
        leg = t_from[k] if here == PAD else t_leg[here][k]
        if leg == np.inf or not ok(here, k, t):
            return None
        t += leg + dw[k]
        if t > budget_min + 1e-9:
            return None
        here = k
    if order:
        if not ok(here, PAD, t):
            return None
        t += t_to[here]
    return t if t <= budget_min + 1e-9 else None


def brute_force(values, dwell, t_from_pad, t_to_pad, t_leg, budget_min, leg_ok=None) -> Plan:
    """Every ordered subset; the reference for the DP KAT."""
    values = np.asarray(values, float).tolist()
    n = len(values)
    dw = np.broadcast_to(np.asarray(dwell, float), (n,)).tolist()
    tf, tt, tl = list(t_from_pad), list(t_to_pad), np.asarray(t_leg).tolist()
    ok = leg_ok or _always
    best = Plan(0.0, [], 0.0)
    for r in range(1, n + 1):
        for order in itertools.permutations(range(n), r):
            t = _evaluate(order, dw, tf, tt, tl, budget_min, ok)
            if t is not None:
                cand = Plan(sum(values[i] for i in order), list(order), t)
                if _better(best, cand):
                    best = cand
    return best


def timeline(
    plan: Plan, names, dwell, t_from_pad, t_to_pad, t_leg, o2_from_pad, o2_to_pad, o2_leg,
    t_home_at_station, checkpoint_min, o2_capacity_l=None,
) -> list[dict]:  # fmt: skip
    """Timeline events (contract timeline): depart, arrive, leave, return, O2 checkpoints.

    o2_left_L needs the suit O2 capacity (not in config yet) and margin_min needs the WS4 leash
    and daylight; both stay null until those inputs exist.
    """
    dwell = np.broadcast_to(np.asarray(dwell, float), (len(t_from_pad),))
    ev, t, used, here = [], 0.0, 0.0, PAD

    def add(tm, event, st, t_home):
        left = None if o2_capacity_l is None else round(o2_capacity_l - used, 2)
        ev.append({"t_min": round(tm, 2), "event": event, "station": st, "o2_left_L": left,
                   "t_home_min": None if t_home is None else round(float(t_home), 2),
                   "margin_min": None})  # fmt: skip

    add(0.0, "depart", None, 0.0)
    for k in plan.order:
        leg_t = t_from_pad[k] if here == PAD else t_leg[here, k]
        leg_o2 = o2_from_pad[k] if here == PAD else o2_leg[here, k]
        t += leg_t
        used += leg_o2
        add(t, "arrive", names[k], t_home_at_station[k])
        t += dwell[k]
        add(t, "leave", names[k], t_home_at_station[k])
        here = k
    if plan.order:
        t += t_to_pad[here]
        used += o2_to_pad[here]
    add(t, "return", None, 0.0)
    total = t
    for tc in np.arange(checkpoint_min, total, checkpoint_min):
        ev.append({"t_min": float(tc), "event": "o2_checkpoint", "station": None,
                   "o2_left_L": None, "t_home_min": None, "margin_min": None})  # fmt: skip
    ev.sort(key=lambda e: e["t_min"])
    return ev


def route_features(legs) -> list:
    """[(LineString in analysis CRS, props)] for route_{scenario}.geojson.

    legs: iterable of (from_name, to_name, xy coords (n, 2), t_min, o2_l).
    """
    from shapely.geometry import LineString

    out = []
    for i, (frm, to, xy, t, o2) in enumerate(legs):
        props = {"leg": i, "from": frm, "to": to, "t_min": round(float(t), 2),
                 "o2_L": None if o2 is None else round(float(o2), 2)}  # fmt: skip
        out.append((LineString(xy), props))
    return out

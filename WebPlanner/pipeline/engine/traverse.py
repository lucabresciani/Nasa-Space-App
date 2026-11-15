"""Traverse (F9) on a routing grid: forward runs from the pad and each reachable station, the
exact orienteering DP with the route-margin check, route legs with per-vertex times, and the
timeline with O2 checkpoints, turn-back times and margins.

Route legs (``route_{scenario}.geojson``; contract route, properties proposed by WS2): ``leg``
(1-based), ``from``, ``to``, ``t_min`` (walk time), ``o2_L``, ``length_m``, ``t_start_min`` /
``t_end_min`` (minutes since EVA start) and ``times_min``: one number per LineString vertex,
minutes since EVA start, non-decreasing (WS7/WS8/WS9 interpolate the playback position from
it). Geometry is not simplified, so vertices and times stay aligned.

Margin check in the DP (SPEC F9 "margin m(t) >= 0 along every leg, using T_home at sampled
path points"): every vertex of the leg path is checked. O2 used at departure is bounded by
the effort-capped rate x elapsed time (VO2 never exceeds the cap), which makes the check depend
on departure time only and keeps the DP exact; the timeline then reports the actual margins.

Stations with no walk home (T_home infinite) are left out and listed in ``unreachable``.

Access cells (access.py): a station's ``rc`` is its access cell for the scenario. Its optional
``access_dist_m`` (walk-in leg to the science point, not modelled) is copied to the station's
timeline rows and, as ``to_access_dist_m``, to the leg that arrives there.

Ordered route (D97, ``plan(..., route=[...])``): the stations are visited in exactly the given
order (nothing is reordered; the orienteering search is skipped). Legs, margins, dwell and
outputs are the auto path's. An order that breaks a limit is a result, not an error:
``Result.feasibility`` names the first failing leg (see ``_route_order``) and only the legs
before it are walked and written. A stop that cannot be routed at all raises
``RouteStopError``. ``route=None`` is the auto path, unchanged.

Free points (D97 WP2b): a stop ``{lon, lat, label?}`` is a synthetic station named W1, W2, ...
in its order among the free stops (``resolve_route``): value 0 (no science scoring), the
default station dwell, ``rc`` = its access cell in the scenario (waypoints.point_fields, the
D48 station-field rule). It appears in legs, timeline and feasibility under its W id like a
station; it is not a station (no card, trade-table or scorecard entry) and its label never
enters the engine outputs.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np

from . import dijkstra, orienteering, provenance
from . import margin as margin_mod
from .geo import feature_collection, write_json
from .graph import Grid
from .margin import (
    MarginInputs,
    latest_departure,
    latest_departure_terms,
    margin,
    o2_margin_min,
)
from .physio import GradeTable

SCRIPT = "pipeline/engine/traverse.py"
VERTEX_TIME_KEY = "times_min"
PAD = orienteering.PAD


@dataclass
class LegPath:
    cells: np.ndarray  # (k, 2) row, col from start to end
    tau: np.ndarray  # min since leg start, per vertex
    o2: np.ndarray  # L used since leg start, per vertex
    t_home: np.ndarray  # T_home at each vertex
    o2_home: np.ndarray

    @property
    def t(self) -> float:
        return float(self.tau[-1])

    @property
    def o2_total(self) -> float:
        return float(self.o2[-1])


@dataclass
class Result:
    order: list[str]
    unreachable: list[str]
    total_min: float
    value: float
    route: dict
    timeline: list[dict]
    legs: list[dict] = field(default_factory=list)
    margin_terms: list[str] = field(default_factory=list)
    t_star_min: float | None = None  # D39: route minute of the largest T_home (storm tripwire)
    dose: dict | None = None  # D39 summary (t*, tau at t*, lowest dose margin, violation)
    track_min_margin: dict = field(default_factory=dict)  # lowest margin per term on the track
    n_feasible_subsets: int | None = None  # D21: station subsets with a feasible route
    # D40 golden cases (physio/golden.json): the walked legs and each visited station's way
    # home as dicts {cells, tau, o2, t_home, o2_home, t_start, u_start}, and the dense track
    # (t, O2 used, T_home, O2_home). Not written to any product.
    leg_paths: list = field(default_factory=list)
    back_paths: dict = field(default_factory=dict)
    track: tuple | None = None
    # D97 ordered route: {feasible: true} or {feasible: false, leg, from, to, limit,
    # shortfall_min, legs_planned} (run_record.feasibility); None on the auto path
    feasibility: dict | None = None


class RouteStopError(ValueError):
    """D97: a stop of an ordered route that cannot be routed at all. ``index`` is the stop's
    index in the route, ``code`` the openapi.yaml ``Error.stop`` code (the server maps it to a
    422)."""

    def __init__(self, index: int, code: str, message: str):
        super().__init__(f"route stop {index}: {code}: {message}")
        self.index, self.code, self.message = index, code, message


def is_free_point(stop) -> bool:
    """D97: a free route point ``{lon, lat, label?}`` (plan_inputs.route), not a station stop."""
    return (isinstance(stop, dict) and "station" not in stop
            and all(isinstance(stop.get(k), (int, float)) and not isinstance(stop.get(k), bool)
                    for k in ("lon", "lat")))  # fmt: skip


def stop_station_id(stop, index: int) -> str:
    """The station id of a route stop: ``"S4"`` or ``{"station": "S4"}`` (plan_inputs.route).
    Free points ({lon, lat}) are named by ``resolve_route``."""
    if isinstance(stop, str):
        return stop
    if isinstance(stop, dict) and isinstance(stop.get("station"), str):
        return stop["station"]
    raise RouteStopError(index, "route_station_unknown", f"not a station stop: {stop!r}")


def free_point_ids(route) -> list[str | None]:
    """W1, W2, ... for the free stops in their order among the free stops; None for stations."""
    out, k = [], 0
    for stop in route:
        k += is_free_point(stop)
        out.append(f"W{k}" if is_free_point(stop) else None)
    return out


def resolve_route(route, stations: list[dict], no_access: dict | None = None,
                  point_station=None) -> list[dict]:  # fmt: skip
    """The one place that turns route stops into station dicts, in route order.

    stations: the routable stations (dicts with ``id``). no_access: {id: reason} for known
    stations without an access cell in the scenario (access.routing_stations); such a stop is
    ``route_point_unreachable``, any other unknown id ``route_station_unknown``. A repeated
    station is ``route_station_duplicate``. Raises RouteStopError for the first bad stop.

    Free points (``is_free_point``) are named W1.. (``free_point_ids``). point_station(wid,
    lon, lat) -> the synthetic station dict (scenarios.free_point_station); a
    waypoints.PointError it raises becomes RouteStopError(stop index, code, message). Without
    point_station a free point resolves to ``{id, lon, lat}`` only (the cheap check before any
    work: station errors and the stop positions for the spacing check)."""
    by_id = {s["id"]: s for s in stations}
    out, seen = [], set()
    wids = free_point_ids(route)
    for i, stop in enumerate(route):
        if wids[i] is not None:
            lon, lat = float(stop["lon"]), float(stop["lat"])
            if point_station is None:
                out.append({"id": wids[i], "lon": lon, "lat": lat})
                continue
            from .waypoints import PointError

            try:
                out.append(point_station(wids[i], lon, lat))
            except PointError as e:
                raise RouteStopError(i, e.code, f"{wids[i]}: {e.message}") from e
            continue
        sid = stop_station_id(stop, i)
        if sid in seen:
            raise RouteStopError(i, "route_station_duplicate", f"station {sid} is already a stop")
        seen.add(sid)
        if sid not in by_id:
            if no_access and sid in no_access:
                raise RouteStopError(i, "route_point_unreachable",
                                     f"station {sid}: {no_access[sid]}")  # fmt: skip
            raise RouteStopError(i, "route_station_unknown", f"no station {sid}")
        out.append(by_id[sid])
    return out


def check_spacing(stops: list[dict], pad_lonlat, min_m: float) -> None:
    """D97: raise RouteStopError(index, "route_stop_spacing") when two stops, or a stop and the
    pad, are closer than min_m (waypoints.stop_spacing_violations; stops = resolve_route's
    dicts with lon/lat, stations at their science point). The index is the later stop of the
    pair (the stop itself for a pad pair); of several violations the lowest such index."""
    from .waypoints import stop_spacing_violations

    pairs = stop_spacing_violations([(s["lon"], s["lat"]) for s in stops], pad_lonlat, min_m)
    if not pairs:
        return
    i, j = min(pairs, key=lambda ij: (ij[1] if ij[1] >= 0 else ij[0], ij[0]))
    other = "the pad" if j < 0 else f"stop {i} ({stops[i]['id']})"
    at = j if j >= 0 else i
    raise RouteStopError(at, "route_stop_spacing",
                         f"stop {at} ({stops[at]['id']}) is closer than {min_m:g} m to "
                         f"{other}")  # fmt: skip


def _forward_leg(fld: dijkstra.Field, dst, home: dijkstra.Field) -> LegPath:
    cells = np.array(dijkstra.trace(fld, dst))
    r, c = cells[:, 0], cells[:, 1]
    return LegPath(cells, fld.t_min[r, c].copy(), fld.o2_l[r, c].copy(), home.t_min[r, c],
                   home.o2_l[r, c])  # fmt: skip


def _home_leg(home: dijkstra.Field, src) -> LegPath:
    """Walk home along the return field's pointers (T_home falls to 0 at the pad)."""
    cells = np.array(dijkstra.trace(home, src))
    r, c = cells[:, 0], cells[:, 1]
    t, o2 = home.t_min[r, c], home.o2_l[r, c]
    return LegPath(cells, t[0] - t, o2[0] - o2, t, o2)


def plan(grid: Grid, table: GradeTable, home: dijkstra.Field, pad, stations: list[dict],
         budget_min: float, checkpoint_min: float, mi: MarginInputs,
         partner_t: np.ndarray | None = None, partner_min: float | None = None,
         dose_fn=None, fpad: dijkstra.Field | None = None, route=None,
         point_station=None) -> Result:  # fmt: skip
    """stations: dicts with id, rc, value, dwell_min. home: the scenario's return field.

    dose_fn (D39): callable t* -> margin.DoseTiming. When given, the DP plans without the dose
    term (its timing depends on the route), t* = the minute of the route's largest T_home, and
    the timeline margins and turn-back times use the timed dose term. ``Result.dose`` reports
    the lowest dose margin on the route (a negative value is a violation, reported, not hidden).

    route (D97): station stops in visiting order (``resolve_route``); None = the auto plan
    (orienteering over ``stations``). With a route only its stations are planned, legs
    pad -> stops[0] -> ... -> pad in that order, and ``Result.feasibility`` is set.
    point_station (D97, free points in the route): ``resolve_route``'s resolver, built per
    scenario by scenarios.plan_route.
    """
    if route is not None:
        stations = resolve_route(route, stations, point_station=point_station or _no_points)
        if not stations:
            raise RouteStopError(0, "route_station_unknown", "an ordered route needs a stop")
    reach = [s for s in stations if math.isfinite(float(home.t_min[s["rc"]]))]
    unreachable = [s["id"] for s in stations if s not in reach]
    n = len(reach)
    rc = [tuple(s["rc"]) for s in reach]
    if dose_fn is not None and (mi.dose_timing is not None or mi.tau_dose_min is not None):
        raise ValueError("dose_fn replaces the dose term; pass mi without one")
    if route is not None and len(reach) < len(stations):
        i = next(i for i, x in enumerate(stations) if x not in reach)
        raise RouteStopError(i, "route_point_unreachable",
                             f"station {stations[i]['id']}: no walk home to the pad")  # fmt: skip
    if fpad is None:
        fpad = dijkstra.forward_field(grid, table, pad)
    fst = [dijkstra.forward_field(grid, table, x) for x in rc]
    out_legs = [_forward_leg(fpad, x, home) if np.isfinite(fpad.t_min[x]) else None for x in rc]
    back_legs = [_home_leg(home, x) for x in rc]
    mid = [[_forward_leg(fst[i], rc[j], home) if i != j and np.isfinite(fst[i].t_min[rc[j]])
            else None for j in range(n)] for i in range(n)]  # fmt: skip

    def tt(lp):
        return np.inf if lp is None else lp.t

    t_from = np.array([tt(lp) for lp in out_legs])
    t_to = np.array([lp.t for lp in back_legs])
    t_leg = np.array([[tt(mid[i][j]) for j in range(n)] for i in range(n)]).reshape(n, n)

    # latest departure per leg under the bounded-O2 margin check (monotone in time)
    def latest(lp):
        if lp is None:
            return -np.inf
        return latest_departure(mi, 0.0, 0.0, mi.o2_rate_l_min, lp.tau, lp.o2, lp.t_home,
                                lp.o2_home)  # fmt: skip

    lat_from = [latest(lp) for lp in out_legs]
    lat_to = [latest(lp) for lp in back_legs]
    lat_mid = [[latest(mid[i][j]) for j in range(n)] for i in range(n)]

    def leg_ok(frm, to, t):
        if frm == PAD:
            return t <= lat_from[to]
        if to == PAD:
            return t <= lat_to[frm]
        return t <= lat_mid[frm][to]

    values = [float(s["value"]) for s in reach]
    dwell = [float(s["dwell_min"]) for s in reach]
    if route is None:
        p = orienteering.solve(values, dwell, t_from, t_to, t_leg, budget_min, leg_ok)
        n_feasible = len(orienteering.feasible_subsets(dwell, t_from, t_to, t_leg, budget_min,
                                                       leg_ok))  # fmt: skip
        feasibility = None
    else:
        for i, lp in enumerate(out_legs[:1] + [mid[i][i + 1] for i in range(n - 1)]):
            if lp is None:
                raise RouteStopError(i, "route_point_unreachable",
                                     f"station {reach[i]['id']}: no path from the previous stop")
        p, feasibility = _route_order(mi, out_legs[0], [mid[i][i + 1] for i in range(n - 1)],
                                      back_legs[-1], values, dwell, budget_min,
                                      ["pad"] + [s["id"] for s in reach])  # fmt: skip
        n_feasible = None
    names = [s["id"] for s in reach]

    # walk the plan: legs with absolute times and O2, a dense (t, used, T_home, O2_home) track
    seq = []  # (from_name, to_name, LegPath, dwell_before)
    here = PAD
    for k in p.order:
        lp = out_legs[k] if here == PAD else mid[here][k]
        seq.append(("pad" if here == PAD else names[here], names[k], lp,
                    0.0 if here == PAD else dwell[here]))  # fmt: skip
        here = k
    if p.order:
        seq.append((names[here], "pad", back_legs[here], dwell[here]))
    if feasibility is not None and not feasibility["feasible"] and p.order:
        seq.pop()  # D97: the route stops before its failing leg; no way home is walked

    in_partner = {}
    if partner_t is not None and partner_min is not None:
        for s in reach:
            tp = float(partner_t[s["rc"]])
            in_partner[s["id"]] = bool(math.isfinite(tp) and tp <= partner_min)

    access_dist = {s["id"]: s.get("access_dist_m") for s in reach}

    def walk(mi_ev: MarginInputs, emit: bool):
        """Walk the plan: dense track (t, used, T_home, O2_home), legs and timeline rows."""
        t, used = 0.0, 0.0
        track_t, track_u, track_th, track_oh = [0.0], [0.0], [0.0], [0.0]
        items, legs, events = [], [], []
        paths.clear()
        dwell_iv = []  # (t_arrive, t_leave) per visited station, for O2_station_tasks

        def tasks_left(tm):
            for a, b in dwell_iv:
                if a - 1e-9 <= tm < b:
                    return (b - tm) * mi_ev.dwell_rate_l_min
            return 0.0

        def ev(tm, event, st, u, th, oh, tasks=None, binding=None):
            if not emit:
                return
            tasks = tasks_left(tm) if tasks is None else tasks
            m, b = margin(mi_ev, tm, u, th, oh, tasks)
            row = {"t_min": round(tm, 2), "event": event, "station": st,
                   "o2_left_L": round(mi_ev.o2_capacity_l - u, 2),
                   "t_home_min": round(float(th), 2),
                   "margin_min": round(m, 2), "margin_binding": binding or b,
                   "o2_tasks_left_L": round(float(tasks), 2)}  # fmt: skip
            if mi_ev.planning_rate_l_min is not None:
                row["o2_margin_min_planning_rate"] = round(
                    o2_margin_min(mi_ev, u, oh, tasks, rate_l_min=mi_ev.planning_rate_l_min), 2)
            if st is not None and st in in_partner:
                row["in_partner_line"] = in_partner[st]
            if st is not None and access_dist.get(st) is not None:
                row["access_dist_m"] = access_dist[st]  # walk-in leg, not modelled (access.py)
            events.append(row)

        ev(0.0, "depart", None, 0.0, 0.0, 0.0)
        for i, (frm, to, lp, dw) in enumerate(seq):
            if dw > 0:  # dwell at `frm` before this leg
                t += dw
                used += dw * mi_ev.dwell_rate_l_min
                track_t.append(t)
                track_u.append(used)
                track_th.append(float(lp.t_home[0]))
                track_oh.append(float(lp.o2_home[0]))
                ev(t, "leave", frm, used, lp.t_home[0], lp.o2_home[0], tasks=0.0)
            times = t + lp.tau
            if emit:
                paths.append({"from": frm, "to": to, "path": lp, "t_start": t, "u_start": used})
            track_t.extend(times[1:].tolist())
            track_u.extend((used + lp.o2[1:]).tolist())
            track_th.extend(lp.t_home[1:].tolist())
            track_oh.extend(lp.o2_home[1:].tolist())
            if emit:
                xy = np.column_stack(grid.xy_of_rc(lp.cells[:, 0], lp.cells[:, 1]))
                if len(xy) == 1:
                    xy, times = np.vstack([xy, xy]), np.concatenate([times, times])
                props = {
                    "leg": i + 1, "from": frm, "to": to,
                    "t_min": round(lp.t, 2), "o2_L": round(lp.o2_total, 2),
                    "length_m": round(float(np.hypot(*np.diff(xy, axis=0).T).sum()), 1),
                    "t_start_min": round(t, 2), "t_end_min": round(t + lp.t, 2),
                    VERTEX_TIME_KEY: [round(float(v), 2) for v in times],
                }  # fmt: skip
                if access_dist.get(to) is not None:
                    props["to_access_dist_m"] = access_dist[to]  # walk-in to the science point
                legs.append(props)
                from shapely.geometry import LineString

                items.append((LineString(xy), props))
            t += lp.t
            used += lp.o2_total
            if to == "pad":
                ev(t, "return", None, used, 0.0, 0.0)
            else:
                k = names.index(to)
                dwell_iv.append((t, t + dwell[k]))
                ev(t, "arrive", to, used, lp.t_home[-1], lp.o2_home[-1])
                if emit:
                    back = back_legs[k]
                    terms = latest_departure_terms(mi_ev, t, used, mi_ev.dwell_rate_l_min,
                                                   back.tau, back.o2, back.t_home,
                                                   back.o2_home)  # fmt: skip
                    bind = min(terms, key=terms.get)
                    tb = terms[bind]
                    if math.isfinite(tb):
                        u_tb = used + (tb - t) * mi_ev.dwell_rate_l_min
                        ev(tb, "turn_back", to, u_tb, back.t_home[0], back.o2_home[0],
                           tasks=0.0, binding=bind)  # fmt: skip
        if not seq:
            ev(0.0, "return", None, 0.0, 0.0, 0.0)
        tr = (np.array(track_t), np.array(track_u), np.array(track_th), np.array(track_oh))
        if emit:
            for tc in np.arange(checkpoint_min, t, checkpoint_min):
                j = int(np.searchsorted(tr[0], tc, side="right") - 1)
                u = float(np.interp(tc, tr[0], tr[1]))
                ev(float(tc), "o2_checkpoint", None, u, tr[2][j], tr[3][j])
        return tr, items, legs, events

    paths: list[dict] = []
    mi_ev = mi
    t_star_min, dose = None, None
    if dose_fn is not None and p.order:
        tr, *_ = walk(mi, emit=False)
        t_star_min = margin_mod.t_star(tr[0], tr[2])
        mi_ev = replace(mi, dose_timing=dose_fn(t_star_min))
    tr, items, legs, events = walk(mi_ev, emit=True)
    if (feasibility is not None and feasibility["feasible"] and dose_fn is not None
            and mi_ev.dose_timing is not None):  # fmt: skip
        cut = _route_dose_check(mi_ev.dose_timing, tr, seq, ["pad"] + names)
        if cut is not None:  # D97: the timed dose term fails on leg cut["leg"]
            feasibility = cut
            del seq[cut["leg"]:]
            p = orienteering.Plan(_value(values, p.order[:cut["leg"]]), p.order[:cut["leg"]],
                                  _seq_end(seq))  # fmt: skip
            tr, items, legs, events = walk(mi_ev, emit=True)
    track_min = _track_min_margin(mi_ev, tr)
    if mi_ev.dose_timing is not None:
        dt = mi_ev.dose_timing
        j = int(np.argmin(dt.tau_min(tr[0]) - tr[2]))
        dose = {"t_star_min": round(t_star_min, 2),
                "t_home_at_t_star_min": round(float(np.max(tr[2])), 2),
                "tau_at_t_star_min": round(float(dt.tau_min(t_star_min)), 2),
                "tau_min_on_route_min": round(float(np.min(dt.tau_min(tr[0]))), 2),
                "lowest_dose_margin_min": round(float(dt.tau_min(tr[0][j]) - tr[2][j]), 2),
                "lowest_dose_margin_at_min": round(float(tr[0][j]), 2),
                "violation": bool(dt.tau_min(tr[0][j]) - tr[2][j] < 0),
                "source": dt.source}  # fmt: skip
    events.sort(key=lambda e: (e["t_min"], e["event"] != "depart"))
    route = feature_collection(items, grid.crs)
    def as_dict(lp: LegPath) -> dict:
        return {"cells": lp.cells, "tau": lp.tau, "o2": lp.o2, "t_home": lp.t_home,
                "o2_home": lp.o2_home}  # fmt: skip

    leg_paths = [{**as_dict(x["path"]), "from": x["from"], "to": x["to"], "t_start": x["t_start"],
                  "u_start": x["u_start"]} for x in paths]  # fmt: skip
    back = {names[k]: as_dict(back_legs[k]) for k in p.order}
    return Result([names[k] for k in p.order], unreachable, float(p.total_min), float(p.value),
                  route, events, legs, mi_ev.terms, t_star_min, dose, track_min,
                  n_feasible, leg_paths, back, tr, feasibility)  # fmt: skip


def _no_points(wid, lon, lat):
    """traverse.plan alone cannot resolve a free point (it needs the scenario's params)."""
    raise NotImplementedError(f"free point {wid} ({lon}, {lat}) needs point_station "
                              "(scenarios.plan_route builds it per scenario)")  # fmt: skip


def _route_order(mi: MarginInputs, first: LegPath, mids: list[LegPath], home: LegPath,
                 values, dwell, budget_min: float, ids: list[str]):  # fmt: skip
    """D97: an ordered route (stations 0..n-1 in order) checked leg by leg with the auto
    path's rules (orienteering._evaluate with traverse's leg_ok); feasible exactly when the DP
    would accept this order.

    * Leg i departs at t = walk + dwell so far (leg 0 at 0). Margin check (D45, as leg_ok):
      m >= 0 at every vertex with the O2 used at departure bounded by the effort-cap rate x t,
      i.e. t <= min(latest_departure_terms(mi, 0, 0, effort rate, leg)). Terms: O2, daylight,
      EVA duration (D28), static dose. The timed dose term (D39) is checked on the walked route
      by ``_route_dose_check``, the way the auto path reports it.
    * The DP's EVA budget: arrival + dwell at a station <= budget_min (checked when the crew
      leaves that station, i.e. at the next leg's departure) and arrival at the pad <=
      budget_min (on the way home). With the D28 term on (budget = crew.eva_h x 60) the margin
      check of the same leg always fails first, so this only answers when that term is off.

    The first leg that fails is the answer: limit = the argmin of its latest-departure terms,
    shortfall_min = t - that latest departure (how many minutes earlier the crew would have to
    leave on that leg). Budget: limit "EVA duration", shortfall = t - budget_min (home leg:
    arrival - budget_min). A term no departure time satisfies (static dose with max T_home >
    tau_dose) has shortfall max(T_home - tau_dose) on the leg. Returns (orienteering.Plan of
    the stations reached before the failing leg, feasibility)."""
    n = len(dwell)
    legs = [first, *mids, home]
    t, order = 0.0, []
    for i, lp in enumerate(legs):
        terms = latest_departure_terms(mi, 0.0, 0.0, mi.o2_rate_l_min, lp.tau, lp.o2,
                                       lp.t_home, lp.o2_home)  # fmt: skip
        bind = min(terms, key=terms.get)
        fail = None
        if not t <= terms[bind]:  # leg_ok(frm, to, t) is t <= latest
            short = t - terms[bind]
            if not math.isfinite(short):
                short = _never_ok_shortfall(mi, bind, t, lp)
            fail = (bind, short)
        elif i and t > budget_min:  # the DP's done[] <= budget at the station left
            fail = (margin_mod.EVA, t - budget_min)
        elif i == n and t + lp.t > budget_min + 1e-9:  # the DP's back <= budget
            fail = (margin_mod.EVA, t + lp.t - budget_min)
        if fail is not None:
            plan = orienteering.Plan(_value(values, order), order, t)
            return plan, {"feasible": False, "leg": i, "from": ids[i],
                          "to": ids[i + 1] if i < n else "pad", "limit": fail[0],
                          "shortfall_min": round(max(0.0, float(fail[1])), 2),
                          "legs_planned": i}  # fmt: skip
        t = t + lp.t + (dwell[i] if i < n else 0.0)  # the DP's sum order (same float bits)
        if i < n:
            order.append(i)
    return orienteering.Plan(_value(values, order), order, t), {"feasible": True}


def _value(values, order) -> float:
    """Science value of the visited stations, summed as orienteering.solve does (by index)."""
    return float(np.asarray(values, float)[sorted(order)].sum())


def _never_ok_shortfall(mi: MarginInputs, term: str, t: float, lp: LegPath) -> float:
    """Shortfall of a term whose latest departure is -inf (no departure time works): the
    largest negative margin of that term on the leg departing at t."""
    tau = mi.tau_dose_at(t + lp.tau) if term == "dose" else None
    if tau is None:
        return 0.0
    return float(np.max(lp.t_home - np.asarray(tau, float)))


def _seq_end(seq) -> float:
    """Minute the walked sequence ends (dwell before each leg + walk)."""
    return float(sum(dw + lp.t for _f, _t, lp, dw in seq))


def _route_dose_check(dt, tr, seq, ids: list[str]) -> dict | None:
    """D97 + D39: the timed dose term on the walked route (t* placed by dose_fn, as the auto
    path). The first track point with tau_dose(t) - T_home < 0 fails the leg it lies on (a
    point in the dwell before a leg belongs to that leg: the departure is too late);
    shortfall_min = the lowest dose margin on that leg (dwell included), as a positive number.
    None if the dose margin stays >= 0."""
    t, th = tr[0], tr[2]
    m = np.asarray(dt.tau_min(t), float) - th
    bad = np.flatnonzero(m < 0)
    if not bad.size:
        return None
    tf = float(t[bad[0]])
    lo = 0.0
    for i, (frm, to, lp, dw) in enumerate(seq):
        hi = lo + dw + lp.t
        if tf <= hi + 1e-9 or i == len(seq) - 1:
            on = (t > lo - 1e-9) & (t <= hi + 1e-9) if i else (t <= hi + 1e-9)
            short = float(-np.min(m[on])) if on.any() else float(-m[bad[0]])
            return {"feasible": False, "leg": i, "from": frm, "to": to, "limit": "dose",
                    "shortfall_min": round(max(0.0, short), 2), "legs_planned": i}  # fmt: skip
        lo = hi
    return None


def _track_min_margin(mi: MarginInputs, tr) -> dict:
    """Lowest value of each margin term along the dense route track (O2 without station tasks;
    report only)."""
    t, u, th, oh = tr
    out = {}
    o2 = np.array([o2_margin_min(mi, a, b) for a, b in zip(u, oh, strict=True)])
    out["O2"] = round(float(o2.min()), 2)
    if mi.t_dark_min is not None:
        out["daylight"] = round(float(np.min(mi.t_dark_min - t - th)), 2)
    tau = mi.tau_dose_at(t)
    if tau is not None:
        out["dose"] = round(float(np.min(np.asarray(tau) - th)), 2)
    if mi.eva_budget_min is not None:
        out["EVA duration"] = round(float(np.min(mi.eva_budget_min - t - th)), 2)
    return out


def write(res: Result, sid: str, public: Path, rel_dir: str = "", key_prefix: str = "",
          route_name: str | None = None, timeline_name: str | None = None) -> None:
    """route + timeline files, validated; manifest keys. Default paths route_{sid}.geojson /
    timeline_{sid}.json at the web root; picker pads (D21) pass rel_dir
    'scenarios/pads/{id}/', key_prefix 'pads.{id}.' and their own file names."""
    rfile = f"{rel_dir}{route_name or f'route_{sid}.geojson'}"
    tfile = f"{rel_dir}{timeline_name or f'timeline_{sid}.json'}"
    rp = write_json(public / rfile, res.route, "route.schema.json")
    tp = write_json(public / tfile, res.timeline, "timeline.schema.json")
    kp = key_prefix
    ks = "" if key_prefix else f".{sid}"  # picker keys: pads.{id}.timeline.{i}.* (no sid)
    units = {"t_min": "min", "o2_left_L": "L", "t_home_min": "min", "margin_min": "min",
             "o2_margin_min_planning_rate": "min", "o2_tasks_left_L": "L"}
    for i, row in enumerate(res.timeline):
        for k, u in units.items():
            if row.get(k) is not None:
                provenance.record(f"{kp}timeline{ks}.{i}.{k}", row[k], u, tfile, SCRIPT)
        if row.get("margin_binding") is not None:
            provenance.record(f"{kp}timeline{ks}.{i}.margin_binding", row["margin_binding"],
                              None, tfile, SCRIPT)  # fmt: skip
    # WS6 audit: per-leg numbers (leg = 1-based "leg" property) and each station's walk-in
    # distance shown with the timeline
    leg_units = {"t_min": "min", "o2_L": "L", "length_m": "m", "t_start_min": "min",
                 "t_end_min": "min", "to_access_dist_m": "m"}  # fmt: skip
    for lg in res.legs:
        for k, u in leg_units.items():
            if lg.get(k) is not None:
                provenance.record(f"{kp}route{ks}.leg.{lg['leg']}.{k}", lg[k], u, rfile,
                                  SCRIPT)  # fmt: skip
    seen = {}
    for row in res.timeline:
        if row.get("station") is not None and row.get("access_dist_m") is not None:
            seen.setdefault(row["station"], row["access_dist_m"])
    for st, d in seen.items():
        provenance.record(f"{kp}timeline{ks}.{st}.access_dist_m", d, "m", tfile, SCRIPT)
    provenance.record(f"{kp}route{ks}.total_min", round(res.total_min, 2), "min", tfile, SCRIPT)
    provenance.record(f"{kp}route{ks}.margin_terms", res.margin_terms, None, tfile, SCRIPT)
    if res.dose is not None:
        for k, u in (("t_star_min", "min"), ("tau_at_t_star_min", "min"),
                     ("lowest_dose_margin_min", "min"), ("violation", None)):  # fmt: skip
            provenance.record(f"{kp}route{ks}.dose.{k}", res.dose[k], u, tfile, SCRIPT)
    provenance.record_file(rfile, rp, SCRIPT)
    provenance.record_file(tfile, tp, SCRIPT)

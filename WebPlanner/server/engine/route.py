"""plan_inputs ``route`` on the server (D97 waypoint block, package R3; contracts/backend/README.md
"Route (v1.2.0, D97)", openapi.yaml ``Error.stop``).

A missing route and ``mode: auto`` are the same plan (the engine picks stations and order, F9):
nothing here applies to them. An ``ordered`` route is checked where plan_inputs are accepted
(POST /jobs, POST /plans/import) before a hash is taken, and a bad stop is a 422 whose
``Error.stop`` is its index in ``route.stops`` (``RouteError``; ``stop`` is None when the error
concerns the whole route). Checks, in this order (the first failing one answers):

1. ``route_mode_conflict`` (stop None): an ordered route together with ``stations.mode`` set/order
   or ``stations.custom`` (both stay cut, D69);
2. ``route_too_many_stops``: more than ``route.max_stops`` stops; stop = the first one over;
3. ``route_too_many_free_points``: more than ``route.max_free_points`` free points; stop = the
   first free point over;
4. per stop, in visiting order: ``route_label_too_long`` (a free point's label longer than
   ``limits.title_max_chars``), ``route_station_unknown`` (not in stations.json),
   ``route_station_duplicate`` (the same station again; stop = the repeat),
   ``route_stop_spacing`` (closer than ``route.min_stop_spacing_m`` to the pad or to an earlier
   stop; stop = the later one).

Every limit comes from config/backend.yaml (``settings()``), never a literal. Distances are metres
in the analysis projection (config/site.yaml ``crs.analysis_proj``, the planner's frame) between
the stops' lon/lat (a station's stations.json position) and the pad.

Free points (``{lon, lat, label?}``) pass the checks above (their grid checks,
route_point_outside_grid / unassessed / not_walkable / unreachable, come with them in R4) but this
server does not plan them yet: ``unsupported_stop`` names the first one and the routes answer 422
``unsupported_inputs`` with ``Error.stop`` set, as the server refuses every other input it cannot
plan (never silently ignored).

``route_point_unreachable`` for a station (no access cell in a scenario, no walk home) is only
known inside the job (pipeline.engine.traverse.RouteStopError): the job ends ``error`` with the
code and the stop in its message (server.engine.plan_job).
"""

from __future__ import annotations

import math

from pipeline.engine.config import load as load_config
from server.engine.defaults import stations
from server.engine.hashing import canonical_inputs
from server.settings import BackendConfig, settings

AUTO, ORDERED = "auto", "ordered"
CUT_STATION_MODES = ("set", "order")  # stations.mode values an ordered route conflicts with


class RouteError(ValueError):
    """A 422 on a route: ``code`` (openapi Error.stop codes), ``stop`` (index or None)."""

    def __init__(self, code: str, stop: int | None, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code, self.stop, self.detail = code, stop, detail


# ------------------------------------------------------------------------------ reading ----
def mode(plan_inputs: dict) -> str:
    """``auto`` or ``ordered`` (a missing route is auto)."""
    return (plan_inputs.get("route") or {}).get("mode", AUTO)


def is_free(stop: dict) -> bool:
    return "station" not in stop


def station_ids(plan_inputs: dict) -> list[str] | None:
    """The ordered route's station ids in visiting order (what build_plan's ``route`` takes), or
    None for auto. Raises ValueError for a route with free points (not planned yet)."""
    if mode(plan_inputs) != ORDERED:
        return None
    stops = plan_inputs["route"]["stops"]
    if any(is_free(s) for s in stops):
        raise ValueError("free points are not planned by this server yet (R4)")
    return [s["station"] for s in stops]


def stop_name(stops: list[dict], i: int) -> str:
    """How a detail names stop ``i``: its station id, or W<k> (its order among the free stops,
    contracts README) with its label if any."""
    s = stops[i]
    if not is_free(s):
        return s["station"]
    k = sum(is_free(t) for t in stops[:i + 1])
    return f"W{k} {s['label']!r}" if s.get("label") else f"W{k}"


def _say(stops: list[dict], i: int, what: str) -> str:
    return f"stop {i} ({stop_name(stops, i)}): {what}"


def _metres() -> str:
    return load_config("site")["crs"]["analysis_proj"]


def _xy(lon: float, lat: float) -> tuple[float, float]:
    from pipeline.engine.geo import xy_of_lonlat

    x, y = xy_of_lonlat(lon, lat, _metres())
    return float(x), float(y)


# ----------------------------------------------------------------------------- checking ----
def check(plan_inputs: dict, cfg: BackendConfig | None = None) -> None:
    """Raise RouteError for the first bad stop of an ordered route (module doc). ``plan_inputs``
    must already validate against plan_inputs.schema.json (canonical_inputs). Auto: no check."""
    route = plan_inputs.get("route")
    if not route or route.get("mode", AUTO) != ORDERED:
        return
    cfg = cfg or settings()
    lim = cfg.route
    c = canonical_inputs(plan_inputs, cfg)
    st = c["stations"]
    if st.get("mode") in CUT_STATION_MODES or st.get("custom"):
        what = (f"stations.mode {st['mode']!r}" if st.get("mode") in CUT_STATION_MODES
                else "stations.custom")
        raise RouteError("route_mode_conflict", None,
                         f"an ordered route sets the stops and their order; {what} cannot be "
                         "combined with it (stations.mode set/order and stations.custom are cut, "
                         "D69)")
    stops = route["stops"]
    if len(stops) > lim.max_stops:
        raise RouteError("route_too_many_stops", lim.max_stops,
                         _say(stops, lim.max_stops, f"a route has at most {lim.max_stops} stops "
                              f"(route.max_stops); this one has {len(stops)}"))
    free = [i for i, s in enumerate(stops) if is_free(s)]
    if len(free) > lim.max_free_points:
        i = free[lim.max_free_points]
        raise RouteError("route_too_many_free_points", i,
                         _say(stops, i, f"a route has at most {lim.max_free_points} free points "
                              f"(route.max_free_points); this one has {len(free)}"))

    known = {s["id"]: s for s in stations()}
    pad = c["pad"]
    pad_xy = _xy(pad["lon"], pad["lat"])
    seen: dict[str, int] = {}
    placed: list[tuple[int, tuple[float, float]]] = []
    for i, s in enumerate(stops):
        if is_free(s):
            label = s.get("label")
            if isinstance(label, str) and len(label) > cfg.limits.title_max_chars:
                raise RouteError("route_label_too_long", i, _say(
                    stops, i, f"the label has {len(label)} characters; at most "
                    f"{cfg.limits.title_max_chars} (limits.title_max_chars)"))
            xy = _xy(s["lon"], s["lat"])
        else:
            sid = s["station"]
            if sid not in known:
                raise RouteError("route_station_unknown", i, _say(
                    stops, i, f"unknown station (stations.json has {sorted(known)})"))
            if sid in seen:
                raise RouteError("route_station_duplicate", i, _say(
                    stops, i, f"station {sid} is already stop {seen[sid]}; a route visits each "
                    "station once"))
            seen[sid] = i
            xy = _xy(known[sid]["lon"], known[sid]["lat"])
        near = [("the pad", math.dist(xy, pad_xy))] + [
            (f"stop {j} ({stop_name(stops, j)})", math.dist(xy, q)) for j, q in placed]
        for other, d in near:
            if d < lim.min_stop_spacing_m:
                raise RouteError("route_stop_spacing", i, _say(
                    stops, i, f"{d:.1f} m from {other}; stops are at least "
                    f"{lim.min_stop_spacing_m:g} m apart (route.min_stop_spacing_m)"))
        placed.append((i, xy))


def unsupported_stop(plan_inputs: dict) -> RouteError | None:
    """The refusal (code ``unsupported_inputs``) of the first free point of an ordered route, or
    None. Free points pass ``check`` but are not planned yet (R4)."""
    if mode(plan_inputs) != ORDERED:
        return None
    stops = plan_inputs["route"]["stops"]
    for i, s in enumerate(stops):
        if is_free(s):
            return RouteError("unsupported_inputs", i, _say(
                stops, i, "free points ({lon, lat}) are not planned by this server yet; an "
                "ordered route takes station stops ({station}) only"))
    return None


def validate(plan_inputs: dict, cfg: BackendConfig | None = None) -> None:
    """``check`` then the free-point refusal: what POST /jobs and POST /plans/import run."""
    check(plan_inputs, cfg)
    err = unsupported_stop(plan_inputs)
    if err is not None:
        raise err


def record_inputs(plan_inputs: dict, canonical: dict) -> dict:
    """Run-record / ImportResult inputs: the canonical inputs (what was hashed) plus what the UI
    shows but the hash leaves out: the title and each free point's label, put back on its stop."""
    out = {**canonical}
    if "title" in plan_inputs:
        out["title"] = plan_inputs["title"]
    given = (plan_inputs.get("route") or {}).get("stops") or []
    if "route" in out and any(isinstance(s, dict) and "label" in s for s in given):
        stops = [dict(s) for s in out["route"]["stops"]]
        for s, g in zip(stops, given, strict=True):
            if "label" in g:
                s["label"] = g["label"]
        out["route"] = {**out["route"], "stops": stops}
    return out

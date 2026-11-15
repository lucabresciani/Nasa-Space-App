"""D97 waypoint block (WP2a): free route points ({lon, lat} stops) for the engine.

A free point is treated exactly like a station (D27 access-cell rule, D48 station fields, W4
sealed pockets): a synthetic station record ``{"id": "W?", "lon": lon, "lat": lat}`` goes
through ``padpick.station_cell`` / ``padpick.station_fields`` with the D27 access radius
(variants.yaml ``route.access_radius_m``, 50 m, via ``padpick.Settings``). No new rule and no new
constant: a point on a station's lon/lat gets that station's access cell and byte-identical
fields.

**Validity** (``point_validity``; openapi.yaml ``Error.stop`` codes, contracts/backend/README.md
"Route (v1.2.0, D97)"), checked in this order:

1. ``route_point_outside_grid``: the point's own cell is not in the routing grid (the pad rule,
   server/engine/pads.py ``outside_grid``: ``Grid.rc_of_xy`` refuses it; non-finite lon/lat too).
2. ``route_point_unassessed``: no cell within the access radius holds measured terrain (cell
   state known, i.e. assessed or blocked, with a finite elevation and cell slope; the pad tool's
   ``unknown_terrain`` notion and the hatched "unknown" cells of contracts/README.md cellstate).
3. ``route_point_not_walkable``: measured terrain is near, but no access-cell candidate (an
   assessed cell within the radius, ``padpick.access_cells``) is passable under the scenario's
   slope rule (``Grid.with_nogo(physio.Params.nogo_deg)``, D22 cell slope + step guard).
4. ``route_point_unreachable``: no candidate has a walk to the main terrain
   (``padpick.station_cell`` is None: every walkable cell within the radius sits in a sealed
   pocket, W4). The pad is on the main terrain, so this is "no path from the pad".

Checks 1-3 look only at the cells within the radius (cheap). Check 4 runs the station Dijkstra
pair(s) (``padpick.access_runs``), i.e. as much as the fields themselves: a caller that needs the
fields should call ``point_fields`` and catch ``PointError`` instead of calling both.

Validity depends on the scenario (its no-go slope): a point can be walkable at the nominal limit
(20 deg) and not at the conservative one (17 deg, D23).

**Spacing** (``stop_spacing_violations``): pairs of stops, or a stop and the pad, closer than a
minimum (the server passes config/backend.yaml ``route.min_stop_spacing_m``). Distance = the
great circle on the Mars sphere (``stations.bearing_dist``, site.yaml ``crs.mars_radius_m``),
as the engine's station bearings and distances.
"""

from __future__ import annotations

import math

import numpy as np

from . import padpick, physio
from .geo import xy_of_lonlat
from .graph import UNKNOWN, Grid, passable_mask
from .stations import bearing_dist

POINT_ID = "W?"  # the synthetic station record's id (the route names free points W1..Wn)
OUTSIDE_GRID = "route_point_outside_grid"
UNASSESSED = "route_point_unassessed"
NOT_WALKABLE = "route_point_not_walkable"
UNREACHABLE = "route_point_unreachable"
POINT_CODES = (OUTSIDE_GRID, UNASSESSED, NOT_WALKABLE, UNREACHABLE)  # validity order


class PointError(ValueError):
    """A free point that cannot be routed. ``code`` is one of ``POINT_CODES`` (openapi.yaml
    ``Error.stop``), ``message`` the reason, ``index`` the stop index when the caller knows it
    (None here). Same attributes as the route's ``traverse.RouteStopError(index, code,
    message)`` (WP1), so a route can re-raise it as ``RouteStopError(i, e.code, e.message)``."""

    def __init__(self, code: str, message: str, index: int | None = None):
        if code not in POINT_CODES:
            raise ValueError(f"not a free-point code: {code!r}")
        where = "" if index is None else f"route stop {index}: "
        super().__init__(f"{where}{code}: {message}")
        self.index, self.code, self.message = index, code, message


def _record(lon: float, lat: float) -> dict:
    return {"id": POINT_ID, "lon": float(lon), "lat": float(lat)}


def _params(scenario, settings: padpick.Settings, crew: dict | None = None) -> physio.Params:
    if isinstance(scenario, physio.Params):
        return scenario
    sid = settings.scenario if scenario is None else scenario
    return physio.scenario_params(sid, crew=crew)


def _check(grid: Grid, lon: float, lat: float, nogo_deg: float, radius_m: float,
           ) -> tuple[str, str] | None:  # fmt: skip
    """Checks 1-3 of the module doc: (code, message) or None. Reads only the cells within the
    radius (the window of ``padpick.access_cells``)."""
    try:
        if not (math.isfinite(lon) and math.isfinite(lat)):
            raise ValueError("non-finite lon/lat")
        x, y = (float(v) for v in xy_of_lonlat(lon, lat, grid.crs))
        r0, c0 = grid.rc_of_xy(x, y)
    except (ValueError, OverflowError):
        return OUTSIDE_GRID, (f"({lon}, {lat}) is outside the {grid.res_m:g} m routing grid")
    n = int(math.ceil(radius_m / grid.res_m)) + 1
    ra, rb = max(r0 - n, 0), min(r0 + n + 1, grid.shape[0])
    ca, cb = max(c0 - n, 0), min(c0 + n + 1, grid.shape[1])
    rr, cc = np.mgrid[ra:rb, ca:cb]
    cx, cy = grid.xy_of_rc(rr, cc)
    near = np.hypot(cx - x, cy - y) <= radius_m + 1e-9
    state = np.asarray(grid.cellstate[ra:rb, ca:cb])
    slope = np.asarray(grid.routing_slope[ra:rb, ca:cb])
    elev = np.asarray(grid.elev[ra:rb, ca:cb])
    known = near & (state != UNKNOWN) & np.isfinite(elev) & np.isfinite(slope)
    if not known.any():
        return UNASSESSED, f"no measured terrain within {radius_m:g} m of ({lon}, {lat})"
    cells = padpick.access_cells(grid, lon, lat, radius_m)
    if cells:
        r = np.array([c[1] for c in cells], dtype=np.int64)
        c = np.array([c[2] for c in cells], dtype=np.int64)
        sg = None if grid.stepguard is None else np.asarray(grid.stepguard)[r, c]
        ok = passable_mask(np.asarray(grid.cellstate)[r, c], np.asarray(grid.routing_slope)[r, c],
                           nogo_deg, np.asarray(grid.elev)[r, c], sg)  # fmt: skip
        if ok.any():
            return None
    return NOT_WALKABLE, (f"no assessed cell within {radius_m:g} m of ({lon}, {lat}) is walkable "
                          f"at the {nogo_deg:g} deg no-go slope")  # fmt: skip


def _unreachable(lon: float, lat: float, radius_m: float) -> str:
    return (f"no walkable cell within {radius_m:g} m of ({lon}, {lat}) has a walk to the main "
            "terrain (sealed pocket)")


def point_validity(grid: Grid, lon: float, lat: float, *, scenario=None,
                   settings: padpick.Settings | None = None) -> dict:  # fmt: skip
    """{"ok", "code", "access_cell", "access_dist_m"} for a free point (module doc).

    grid: the routing grid (WS1 / server data; passability is re-derived per scenario).
    scenario: a scenario id or physio.Params (default: the D21 scenario, variants.yaml
    d21.scenario). settings: padpick.Settings (access_radius_m; default from config).
    access_cell = (row, col) and access_dist_m = its distance from the point, exactly
    ``padpick.station_cell`` for a station at the point; None when not ok."""
    s = settings or padpick.settings_from_config()
    p = _params(scenario, s)
    bad = _check(grid, lon, lat, p.nogo_deg, s.access_radius_m)
    if bad is None:
        cell = padpick.station_cell(grid.with_nogo(p.nogo_deg), _record(lon, lat),
                                    s.access_radius_m, physio.grade_table(p))  # fmt: skip
        if cell is not None:
            return {"ok": True, "code": None, "access_cell": (int(cell[1]), int(cell[2])),
                    "access_dist_m": float(cell[0])}  # fmt: skip
        bad = (UNREACHABLE, "")
    return {"ok": False, "code": bad[0], "access_cell": None, "access_dist_m": None}


def point_precheck(grid: Grid, lon: float, lat: float, *, scenario=None,
                   settings: padpick.Settings | None = None) -> tuple[str, str] | None:  # fmt: skip
    """Checks 1-3 of the module doc only (outside_grid, unassessed, not_walkable): (code,
    message) or None. Reads only the cells within the access radius, no Dijkstra (the cheap
    422 pre-check; check 4, unreachable, needs ``point_validity`` / ``point_fields``).
    scenario / settings as ``point_validity``."""
    s = settings or padpick.settings_from_config()
    return _check(grid, lon, lat, _params(scenario, s).nogo_deg, s.access_radius_m)


def point_fields(grid: Grid, lon: float, lat: float, scenario="nom_104",
                 settings: padpick.Settings | None = None, *, crew: dict | None = None,
                 tmax_min: float | None = None):  # fmt: skip
    """(forward, reverse) dijkstra.Field for a free point: ``padpick.station_fields`` for the
    synthetic station record at lon/lat (same arguments, same result). Raises PointError with
    the validity code (module doc) for an invalid point; never runs a Dijkstra for codes 1-3."""
    s = settings or padpick.settings_from_config()
    p = _params(scenario, s, crew)
    bad = _check(grid, lon, lat, p.nogo_deg, s.access_radius_m)
    if bad is not None:
        raise PointError(*bad)
    try:
        return padpick.station_fields(grid, _record(lon, lat), p, s, tmax_min=tmax_min)
    except physio.MissingInput as e:  # station_fields: no access cell (station_cell is None)
        raise PointError(UNREACHABLE, _unreachable(lon, lat, s.access_radius_m)) from e


def stop_spacing_violations(points_lonlat, pad_lonlat, min_m: float) -> list[tuple[int, int]]:
    """Pairs (i, j) of route stops closer than min_m (strictly), j = -1 for the pad.

    points_lonlat: [(lon, lat)] of the stops in route order (stations and free points);
    pad_lonlat: (lon, lat) or None (no pad check). Order: by i, the pad pair (i, -1) first, then
    (i, j) for j > i ascending. Distance: ``stations.bearing_dist`` (module doc)."""
    pts = [(float(a), float(b)) for a, b in points_lonlat]
    out: list[tuple[int, int]] = []
    for i, (lon, lat) in enumerate(pts):
        if pad_lonlat is not None and bearing_dist(lon, lat, *map(float, pad_lonlat))[1] < min_m:
            out.append((i, -1))
        for j in range(i + 1, len(pts)):
            if bearing_dist(lon, lat, *pts[j])[1] < min_m:
                out.append((i, j))
    return out

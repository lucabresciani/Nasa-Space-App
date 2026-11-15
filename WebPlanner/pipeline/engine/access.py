"""Access-cell rule (user decision 2026-11-14 11:40, STATUS Decision log).

A station keeps its science coordinate (WS1 stations.json). For routing and T_home the engine
uses the station's **access cell**: the nearest walkable cell within
``variants.yaml route.access_radius_m`` of the science point, where walkable = WS1 cell state
assessed (0) **and** a finite T_home in the scenario (reachable). If the science point's own
cell is walkable, the access point is the science point itself (distance 0).

The walk-in leg from the access cell to the science point is NOT modelled (no time, no O2).
It is reported as a straight line: distance, rise, mean slope, the largest along-track slope
between samples one routing cell apart (bilinear on the routing elevation) and the largest WS1
max-slope of the routing cells it crosses. No cell within the radius -> null with a reason.
Nothing is snapped: the science lon/lat is never changed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .config import load
from .dijkstra import Field
from .geo import lonlat_of_xy, xy_of_lonlat
from .graph import ASSESSED, Grid

RULE = ("nearest cell with cell state assessed and a walk home in the scenario, within "
        "access_radius_m of the science point; walk-in leg not modelled")  # fmt: skip


def radius_m() -> float:
    return float(load("variants")["route"]["access_radius_m"])


@dataclass
class Access:
    rc: tuple[int, int] | None
    lon: float | None
    lat: float | None
    dist_m: float | None
    t_home_min: float | None
    o2_home_L: float | None  # noqa: N815 (unit suffix as in the contracts)
    reason: str | None
    walk_in: dict | None

    def to_json(self) -> dict:
        def rnd(v, n):
            return None if v is None else round(float(v), n)

        return {"lon": rnd(self.lon, 6), "lat": rnd(self.lat, 6), "dist_m": rnd(self.dist_m, 1),
                "t_home_min": rnd(self.t_home_min, 2), "o2_home_L": rnd(self.o2_home_L, 2),
                "reason": self.reason, "walk_in": self.walk_in}  # fmt: skip


def _null(reason: str) -> Access:
    return Access(None, None, None, None, None, None, reason, None)


def find(grid: Grid, field: Field, lon: float, lat: float, radius: float) -> Access:
    """Access cell for one station in one scenario (field = that scenario's return field)."""
    x, y = xy_of_lonlat(lon, lat, grid.crs)
    try:
        r0, c0 = grid.rc_of_xy(x, y)
    except ValueError:
        return _null("science point outside the routing grid")
    if grid.cellstate is None:
        raise ValueError("access rule needs the cell-state grid")
    t = field.t_min
    if grid.cellstate[r0, c0] == ASSESSED and np.isfinite(t[r0, c0]):
        return Access((r0, c0), float(lon), float(lat), 0.0, float(t[r0, c0]),
                      float(field.o2_l[r0, c0]), None, walk_in(grid, x, y, x, y))  # fmt: skip
    n = int(math.ceil(radius / grid.res_m)) + 1
    ra, rb = max(r0 - n, 0), min(r0 + n + 1, grid.shape[0])
    ca, cb = max(c0 - n, 0), min(c0 + n + 1, grid.shape[1])
    rr, cc = np.mgrid[ra:rb, ca:cb]
    cx, cy = grid.xy_of_rc(rr, cc)
    d = np.hypot(cx - x, cy - y)
    within = d <= radius + 1e-9
    assessed = within & (grid.cellstate[ra:rb, ca:cb] == ASSESSED)
    ok = assessed & np.isfinite(t[ra:rb, ca:cb])
    r_txt = f"{radius:g} m"
    if not ok.any():
        if not assessed.any():
            return _null(f"no assessed cell (cell state 0) within {r_txt}")
        return _null(f"{int(assessed.sum())} assessed cells within {r_txt}, none with a walk "
                     "home in this scenario")  # fmt: skip
    # nearest; ties: lower T_home, then row, col (deterministic)
    cand = np.flatnonzero(ok)
    key = np.lexsort((cc.ravel()[cand], rr.ravel()[cand], t[ra:rb, ca:cb].ravel()[cand],
                      np.round(d.ravel()[cand], 6)))  # fmt: skip
    k = cand[key[0]]
    r, c = int(rr.ravel()[k]), int(cc.ravel()[k])
    ax, ay = float(cx.ravel()[k]), float(cy.ravel()[k])
    alon, alat = lonlat_of_xy(ax, ay, grid.crs)
    return Access((r, c), float(alon), float(alat), float(d.ravel()[k]), float(t[r, c]),
                  float(field.o2_l[r, c]), None, walk_in(grid, ax, ay, x, y))  # fmt: skip


def _bilinear(grid: Grid, xs, ys) -> np.ndarray:
    from scipy.ndimage import map_coordinates

    cf = (np.asarray(xs) - grid.x0) / grid.res_m - 0.5
    rf = (grid.y0 - np.asarray(ys)) / grid.res_m - 0.5
    return map_coordinates(grid.elev, [rf, cf], order=1, mode="nearest", prefilter=False)


def walk_in(grid: Grid, xa: float, ya: float, xs: float, ys: float) -> dict:
    """Straight walk-in leg from the access point (xa, ya) to the science point (xs, ys)."""
    dist = float(math.hypot(xs - xa, ys - ya))
    base = {"dist_m": round(dist, 1), "modelled": False}
    if dist < 1e-9:
        return {**base, "dist_m": 0.0, "rise_m": 0.0, "mean_slope_deg": None,
                "max_slope_deg": None, "max_terrain_slope_deg": None}  # fmt: skip
    n = max(int(math.ceil(dist / grid.res_m)), 1) + 1
    f = np.linspace(0.0, 1.0, n)
    z = _bilinear(grid, xa + f * (xs - xa), ya + f * (ys - ya))
    if not np.all(np.isfinite(z)):
        return {**base, "rise_m": None, "mean_slope_deg": None, "max_slope_deg": None,
                "max_terrain_slope_deg": None}  # fmt: skip
    rise = float(z[-1] - z[0])
    step = dist / (n - 1)
    along = np.degrees(np.arctan(np.abs(np.diff(z)) / step))
    # every routing cell the segment crosses (sampled at a quarter cell)
    m = max(int(math.ceil(4 * dist / grid.res_m)), 1) + 1
    g = np.linspace(0.0, 1.0, m)
    cols = np.floor((xa + g * (xs - xa) - grid.x0) / grid.res_m).astype(int)
    rows = np.floor((grid.y0 - (ya + g * (ys - ya))) / grid.res_m).astype(int)
    ok = (rows >= 0) & (rows < grid.shape[0]) & (cols >= 0) & (cols < grid.shape[1])
    terrain = None
    if grid.maxslope is not None and ok.any():
        ms = grid.maxslope[rows[ok], cols[ok]]
        ms = ms[np.isfinite(ms)]
        terrain = round(float(ms.max()), 2) if ms.size else None
    return {**base, "rise_m": round(rise, 2),
            "mean_slope_deg": round(math.degrees(math.atan(abs(rise) / dist)), 2),
            "max_slope_deg": round(float(along.max()), 2),
            "max_terrain_slope_deg": terrain}  # fmt: skip


def resolve(grid: Grid, fields: dict[str, Field], stations: list[dict], radius: float,
            ) -> list[dict]:  # fmt: skip
    """Attach ``s["access"] = {scenario: Access}`` to every station (with lon/lat)."""
    for s in stations:
        s["access"] = {sid: find(grid, f, s["lon"], s["lat"], radius) for sid, f in fields.items()}
    return stations


def routing_stations(stations: list[dict], sid: str) -> tuple[list[dict], dict[str, str]]:
    """Station copies whose ``rc`` is the scenario's access cell, plus {id: reason} for the
    stations without one (left out of the route)."""
    out, none = [], {}
    for s in stations:
        a = s.get("access", {}).get(sid)
        if a is None or a.rc is None:
            none[s["id"]] = "no access cell" if a is None else a.reason
            continue
        out.append({**s, "rc": a.rc, "access_dist_m": round(float(a.dist_m), 1)})
    return out, none

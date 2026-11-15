"""Engine part of stations.json (F4, F7, F10): T_home per scenario at the station cell and the
partner-line flag.

Stations come from WS1 (``data/interim/terrain/stations.json``: the contract array, or an
object with a ``stations`` array). ``lon``/``lat`` stay the science coordinate. T_home is taken
at the station's access cell (access.py, user decision 2026-11-14 11:40) when
``access.resolve`` has run, else at the 3 m cell holding lon/lat. A station with no access cell
in a scenario gets ``null`` there (unknown stays unknown, AGENTS.md rule 7).

Extra properties (the stations contract allows them; reported to C):
``access_radius_m``; ``access`` = {scenario: {lon, lat, dist_m, t_home_min, o2_home_L, reason,
walk_in}}; and for the default scenario ``access_lon``, ``access_lat``, ``access_dist_m``,
``access_reason``.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from .config import load
from .dijkstra import Field
from .geo import xy_of_lonlat
from .graph import Grid


def load_ws1_stations(path: Path) -> tuple[list[dict], list[str]]:
    """(stations with a position, ids without one)."""
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = doc["stations"] if isinstance(doc, dict) else doc
    have, missing = [], []
    for s in rows:
        if s.get("lon") is None or s.get("lat") is None:
            missing.append(s["id"])
        else:
            have.append(dict(s))
    return have, missing


NAME_KEYS = ("name", "name_base", "name_suffix")


def name_fields(s: dict) -> dict:
    """The station-name fields of a WS1 station, in order: ``name``, plus ``name_base`` and
    ``name_suffix`` where WS1 has them (D44 same-name suffix)."""
    return {k: s[k] for k in NAME_KEYS if k == "name" or k in s}


def with_names(rec: dict, s: dict) -> dict:
    """``rec`` with its name fields replaced by WS1 station ``s``'s, placed where ``name`` was;
    every other key and its order unchanged."""
    out: dict = {}
    for k, v in rec.items():
        if k == "name":
            out.update(name_fields(s))
        elif k not in NAME_KEYS:
            out[k] = v
    return out


def attach_cells(grid: Grid, stations: list[dict]) -> list[dict]:
    for s in stations:
        s["rc"] = grid.rc_of_xy(*xy_of_lonlat(s["lon"], s["lat"], grid.crs))
    return stations


def bearing_dist(lon, lat, lon_to, lat_to) -> tuple[float, float]:
    """Great-circle initial bearing (deg from north) and distance (m) on the Mars sphere."""
    r = float(load("site")["crs"]["mars_radius_m"])
    p1, p2 = math.radians(lat), math.radians(lat_to)
    dl = math.radians(lon_to - lon)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    b = math.degrees(math.atan2(y, x)) % 360.0
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return b, 2 * r * math.asin(math.sqrt(h))


def _at(arr: np.ndarray, rc) -> float | None:
    v = float(arr[rc])
    return round(v, 2) if math.isfinite(v) else None


def station_records(stations: list[dict], fields: dict[str, Field],
                    partner_t: np.ndarray | None, partner_min: float,
                    default: str | None = None) -> list[dict]:  # fmt: skip
    """stations.json records (contract stations). objective/tasks pass through from WS1."""
    from .access import radius_m

    default = default or load("variants")["scenarios"]["default"]
    out = []
    for s in stations:
        acc = s.get("access")
        if acc is None:
            t_home = {sid: _at(f.t_min, s["rc"]) for sid, f in fields.items()}
            prc = s["rc"]
        else:
            t_home = {sid: (None if a.t_home_min is None else round(a.t_home_min, 2))
                      for sid, a in acc.items()}  # fmt: skip
            prc = acc[default].rc if default in acc else None
        in_partner = None
        if partner_t is not None and prc is not None:
            tp = float(partner_t[prc])
            in_partner = bool(math.isfinite(tp) and tp <= float(partner_min))
        extra = {}
        if acc is not None:
            d = acc.get(default)
            extra = {
                "access_radius_m": float(radius_m()),
                "access_lon": None if d is None or d.lon is None else round(d.lon, 6),
                "access_lat": None if d is None or d.lat is None else round(d.lat, 6),
                "access_dist_m": None if d is None or d.dist_m is None else round(d.dist_m, 1),
                "access_reason": None if d is None else d.reason,
                "access": {sid: a.to_json() for sid, a in acc.items()},
                # D26: a station no scenario can reach stays on the map with this label
                "reachable_on_foot": any(a.rc is not None for a in acc.values()),
                "reachability_label": None if any(a.rc is not None for a in acc.values())
                else load("stations")["placement"]["unreachable_label"],
            }
        out.append({
            "id": s["id"], **name_fields(s),
            "lon": round(float(s["lon"]), 6), "lat": round(float(s["lat"]), 6),
            "value": s.get("value"),
            "objective": s.get("objective", ""),
            "tasks": list(s.get("tasks", [])),
            "dwell_min": s.get("dwell_min", load("stations")["dwell_min"]),
            "t_home_min": t_home, "in_partner_line": in_partner,
            "card": s.get("card", f"cards/{s['id']}.json"),
            **extra,
        })  # fmt: skip
    return out

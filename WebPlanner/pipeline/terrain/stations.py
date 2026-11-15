"""Station placement filters and names (F7; SPEC 11 D26, D32). Pure functions; ``build.py
step_stations`` applies them to the scoring lattice.

* ``spacing_ok``: at least ``min_spacing_m`` (D32: 300 m) from every placed station.
* ``in_focus``: inside ``site.yaml aoi_focus`` (inclusive box).
* ``walkable_at``: the 3 m cell under the science point is assessed (state 0) in the D22 nominal
  cell states (``cellstate_3m.tif``); blocked, unknown and off-grid points are not walkable.
* ``finding_name``: a station found by the score is named by what the score found (D26), from
  its normalised components only, never by a geological claim.
* ``place_extras``: greedy, highest F7 value first, every filter and the spacing re-checked
  against all stations placed so far.
* ``add_compass_suffixes`` (D44, user 17:28): stations that share a name get the 8-point compass
  point of the bearing from the official pad (``official_pad``: ``engine/public/pad.json`` top-level
  ``pad``, else ``site.yaml pad_default``), e.g. "... (north-east)". If two of them still share a
  compass point, the next rule is the distance from the pad: "nearer"/"farther" for two, "nearest",
  "2nd nearest", ..., "farthest" for more (a distance tie falls back to the station id). Names and
  labels only; coordinates never move.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

ASSESSED = 0


def spacing_ok(x, y, placed_xy, min_m: float) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    ok = np.ones(x.shape, bool)
    for px, py in placed_xy:
        ok &= np.hypot(x - px, y - py) >= min_m
    return ok


def in_focus(lon, lat, focus: dict) -> np.ndarray:
    lon = np.asarray(lon)
    lat = np.asarray(lat)
    return ((lon >= focus["west"]) & (lon <= focus["east"]) & (lat >= focus["south"])
            & (lat <= focus["north"]))


def walkable_at(state3: np.ndarray, g3, x, y) -> np.ndarray:
    r, c = g3.rc_of_xy(x, y)
    r, c = np.atleast_1d(r), np.atleast_1d(c)
    inside = (r >= 0) & (r < state3.shape[0]) & (c >= 0) & (c < state3.shape[1])
    out = np.zeros(r.shape, bool)
    out[inside] = state3[r[inside], c[inside]] == ASSESSED
    return out


def finding_name(crism_norm: dict, ridge_norm: float, *, min_norm: float,
                 index_words: dict) -> tuple[str, str]:
    """(name, finding) from the normalised components. The CRISM part uses the index with the
    larger normalised value; a component is named when it is >= ``min_norm``; parts are ordered
    by their F7 contribution (equal weights 0.4/0.4, so by normalised value)."""
    idx = max(crism_norm, key=lambda k: (crism_norm[k], k))
    parts = []
    if crism_norm[idx] >= min_norm:
        parts.append((crism_norm[idx], f"high {idx} {index_words[idx]} signal"))
    if ridge_norm >= min_norm:
        parts.append((ridge_norm, "dense ridge network"))
    parts.sort(key=lambda p: -p[0])
    name = " + ".join(p[1] for p in parts) or "F7 score without a dominant component"
    finding = (", ".join(f"{k} {v:.2f}" for k, v in sorted(crism_norm.items()))
               + f" (CRISM, normalised p2-p98), ridge density {ridge_norm:.2f} (normalised by "
               f"p98); named components >= {min_norm:g}")
    return name, finding


def place_extras(x, y, value, eligible, placed_xy, n_max: int, min_m: float) -> list[int]:
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    v = np.where(np.asarray(eligible, bool) & np.isfinite(value), value, -np.inf)
    placed = list(placed_xy)
    out: list[int] = []
    for i in np.argsort(-v, kind="stable"):
        if len(out) >= n_max or not np.isfinite(v[i]):
            break
        if spacing_ok(x[i:i + 1], y[i:i + 1], placed, min_m)[0]:
            out.append(int(i))
            placed.append((float(x[i]), float(y[i])))
    return out


COMPASS8 = ("north", "north-east", "east", "south-east", "south", "south-west", "west",
            "north-west")


def compass8(bearing_deg: float) -> str:
    """8-point compass name; 45 deg sectors centred on the points, a boundary goes clockwise
    (22.5 -> north-east)."""
    return COMPASS8[int(math.floor((float(bearing_deg) + 22.5) / 45.0)) % 8]


def bearing_deg(pad_xy, x: float, y: float) -> float:
    """Bearing from the pad to (x, y), degrees clockwise from grid north, in [0, 360). The
    analysis CRS (eqc, lat_ts = -4.8) is true-scale and north-up at the site."""
    return math.degrees(math.atan2(x - pad_xy[0], y - pad_xy[1])) % 360.0


def official_pad(pad_json: Path, fallback: dict) -> tuple[float, float, str]:
    """(lon, lat, source) of the official pad: top-level ``pad`` of WS2's pad.json (rank 1,
    D42/D44); ``site.yaml pad_default`` only if that file is missing."""
    pad_json = Path(pad_json)
    if pad_json.exists():
        p = json.loads(pad_json.read_text())["pad"]
        return (float(p["lon"]), float(p["lat"]),
                f"{pad_json.name} pad ({p.get('id', 'rank1')})")
    return float(fallback["lon"]), float(fallback["lat"]), "site.yaml pad_default"


def _rank_words(n: int) -> list[str]:
    if n == 2:
        return ["nearer", "farther"]
    words = ["nearest"] + [f"{_ordinal(k)} nearest" for k in range(2, n)] + ["farthest"]
    return words


def _ordinal(k: int) -> str:
    return f"{k}{'th' if 10 <= k % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(k % 10, 'th')}"


def add_compass_suffixes(records: list[dict], pad_xy) -> list[dict]:
    """Copies of ``records`` where every name shared by two or more placed stations (``x``/``y``
    not None) gets " (<compass point>)", plus the distance rank when the compass point is shared
    too. Adds ``name_base`` and ``name_suffix`` to the renamed ones; nothing else changes."""
    out = [dict(r) for r in records]
    placed = [r for r in out if r.get("x") is not None and r.get("y") is not None]
    by_name: dict[str, list[dict]] = {}
    for r in placed:
        by_name.setdefault(r["name"], []).append(r)
    for name, group in by_name.items():
        if len(group) < 2:
            continue
        for r in group:
            b = bearing_deg(pad_xy, r["x"], r["y"])
            r["name_base"] = name
            r["name_suffix"] = {"compass": compass8(b), "bearing_deg": round(b, 1),
                                "distance_m": round(math.hypot(r["x"] - pad_xy[0],
                                                               r["y"] - pad_xy[1]), 1)}
        by_pt: dict[str, list[dict]] = {}
        for r in group:
            by_pt.setdefault(r["name_suffix"]["compass"], []).append(r)
        for pt, same in by_pt.items():
            if len(same) == 1:
                same[0]["name"] = f"{name} ({pt})"
                continue
            same.sort(key=lambda r: (r["name_suffix"]["distance_m"], r["id"]))
            for r, w in zip(same, _rank_words(len(same)), strict=True):
                r["name_suffix"]["distance_rank"] = w
                r["name"] = f"{name} ({pt}, {w})"
    return out

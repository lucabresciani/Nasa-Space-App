"""Pad validity and the instant preview (F24 steps 1 and 2; WS11 plan row 2.2, brief task 6).

Every rule and number comes from ``pipeline/engine`` (WS11 rule 1); this module only reads the
server data (``$HL_SERVER_DATA``, tools/make_serverdata.py) and calls the engine's own functions.

**validate** (POST /pads/validate, openapi PadCheck). The D21 rule (config/backend.yaml
``pads.rule_ref`` = site.siting; variants.yaml ``d21``) as ``padpick.candidates`` applies it:

- the pad's cell lies in the routing grid, else ``outside_grid``;
- the pad lies in a siting block that is a candidate of ``siting.blocks`` (block_m square, every
  cell assessed with a finite elevation, cell slope <= max_slope_deg). A refused block is
  ``unknown_terrain`` when it holds a cell without measured terrain (cell state unknown or no
  elevation / slope: "no 1 m terrain here", F24), else ``slope`` (a cell steeper than the limit,
  or blocked);
- the flat 30-min disc around the pad's cell lies inside the grid (``padpick.disc_in_grid`` with
  ``padpick.Settings.disc_radius_m``), else ``disc_off_grid``.
The reasons are checked in that order (spec F24: measured ground, slope, disc). An invalid pad gets
the nearest valid block: the representative cell of the nearest D21 candidate block (candidate
block whose disc lies in the grid, exactly ``padpick.candidates``' set), as lon/lat to 6 decimals
(as pad.json) and its distance from the pad in metres.

**screen** (POST /pads/screen, openapi PadScreen). The D21 screening (``padpick`` module doc,
step 2) for one pad, from the PRECOMPUTED station fields of the D21 scenario (variants.yaml
``d21.scenario``): pad -> station = the station's reverse field at the pad cell, station -> pad =
its forward field there, station -> station = the forward field at the other station's access cell
(``padpick.matrices``). No Dijkstra runs. ``feasible_evas`` = ``padpick.screen_counts`` (walk +
dwell <= the EVA budget, no margin check: the D21 screening count, pads/index.json
``screen_count``); ``best_route`` = ``orienteering.solve`` on the same matrices (F9 objective:
most station value, then least time) WITHOUT the route margin check (O2, daylight, EVA duration
per leg), which needs the leg paths and is only in the full plan. A station is reachable when both
of its times are finite. Only the pad may differ from the defaults (custom crew and route inputs
need fields the server data does not hold: tasks 10 and 11); other inputs are refused, never
ignored. An ordered route (D97) is refused too (422 unsupported_inputs naming ``route``): the
preview is the D21 screening of the engine's own station choice; a missing or auto route is the
default and screens as before.

The server data are loaded once per process (memory-mapped, read-only) and reloaded only when the
data manifest changes. Station fields are float32 minutes, as the D21 screening uses them.
"""

from __future__ import annotations

import json
import math
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml
from jsonschema import Draft202012Validator

from pipeline.engine import orienteering, padpick, siting
from pipeline.engine.config import load as load_config
from pipeline.engine.geo import lonlat_of_xy, xy_of_lonlat
from pipeline.engine.graph import ASSESSED, UNKNOWN, Grid
from pipeline.engine.stations import load_ws1_stations
from server.engine import version
from server.engine.hashing import canonical_inputs, official_inputs
from server.settings import settings

REPO = Path(__file__).resolve().parents[2]
OPENAPI = REPO / "contracts" / "backend" / "openapi.yaml"
STATIONS = "terrain/stations.json"  # make_serverdata's copy of WS1's stations
NOT_COMPARED = ("pad", "contract_version")  # blocks the preview takes as given
DECIMALS = 6  # lon/lat as pad.json and plan_inputs
T_DECIMALS = 2  # minutes, as stations.json t_home_min and the route files
D_DECIMALS = 1  # metres, as pad.json access_dist_m
PREVIEW_NOTE = ("D21 screening from the precomputed station fields: walk + dwell <= the EVA "
                "budget, no route margin check (O2, daylight, EVA duration per leg); the full "
                "plan checks the margin on every leg and may choose another route")


class ServerDataMissing(RuntimeError):
    """The server data folder (make serverdata) is absent or lacks what the pad tool needs."""


class UnsupportedInputs(ValueError):
    """plan_inputs blocks the preview cannot honour yet (refused, never ignored)."""

    def __init__(self, fields: list[str]):
        self.fields = fields
        why = (" (an ordered route, D97, is planned by the plan job: the preview screens the "
               "engine's own station choice only)" if "route" in fields else "")
        super().__init__("only the pad may differ from the defaults in a preview (custom crew "
                         "and route inputs: brief tasks 10-11); differs: " + ", ".join(fields)
                         + why)


class InvalidPad(ValueError):
    """The pad fails the D21 rule; ``check`` is its PadCheck."""

    def __init__(self, check: dict):
        self.check = check
        super().__init__(f"{check['reason']}: {check.get('detail', '')}".rstrip(": "))


# --------------------------------------------------------------------------- request shape ----
def _lonlat_validator() -> Draft202012Validator:
    api = yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))
    return Draft202012Validator(api["components"]["schemas"]["LonLat"])


_LONLAT = _lonlat_validator()


def lonlat_errors(body) -> list[str]:
    """Errors of a POST /pads/validate body against openapi LonLat (plus finite numbers)."""
    errs = [f"{'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}"
            for e in sorted(_LONLAT.iter_errors(body), key=lambda e: e.json_path)]
    if not errs:
        errs = [f"{k}: {body[k]!r} is not a finite number" for k in ("lon", "lat")
                if not math.isfinite(float(body[k]))]
    return errs


# ------------------------------------------------------------------------------ the world ----
@dataclass
class Field:
    forward: np.ndarray  # station access cell -> x, float32 min (memory map)
    reverse: np.ndarray  # x -> station access cell
    access_rc: tuple[int, int]


@dataclass
class World:
    key: tuple
    grid: Grid
    blocks: siting.Blocks
    block_m: float
    max_slope_deg: float
    disc_radius_m: float
    valid_ids: np.ndarray  # D21 candidate blocks (padpick.candidates' blocks)
    valid_xy: np.ndarray  # (n, 2) their representative cells, analysis-CRS metres
    scenario: str  # variants.yaml d21.scenario
    budget_min: float
    stations: list[dict]  # WS1 stations with a position, stations.json order
    fields: dict[str, Field]  # station id -> its D21-scenario fields (absent: no access cell)


_LOCK = threading.Lock()
_WORLD: World | None = None


def _key(root: Path) -> tuple:
    mf = root / version.SERVER_DATA_MANIFEST
    try:
        st = mf.stat()
    except OSError as e:
        raise ServerDataMissing(f"no server data manifest at {mf} (run `make serverdata`)") from e
    return str(root.resolve()), st.st_mtime_ns, st.st_size, st.st_ino


def _grid(root: Path, m: dict) -> Grid:
    g = m["grid"]
    arr = {k: np.load(root / v["path"], mmap_mode="r") for k, v in g["arrays"].items()}
    return Grid(elev=arr["elev"], passable=np.asarray(arr["cellstate"]) == ASSESSED,
                res_m=float(g["res_m"]), x0=float(g["x0"]), y0=float(g["y0"]), crs=g["crs"],
                cellstate=arr["cellstate"], maxslope=arr["maxslope"], slope=arr["slope"],
                stepguard=arr["stepguard"])


def open_grid(root: Path | None = None) -> Grid:
    """The server data routing grid as read-only memory maps (no siting, no station fields): what
    a job worker opens once (server.engine.warmup.worker_init)."""
    root = version.server_data_dir() if root is None else root
    _key(root)  # ServerDataMissing without a manifest
    try:
        m = json.loads((root / version.SERVER_DATA_MANIFEST).read_text(encoding="utf-8"))
        return _grid(root, m)
    except (KeyError, OSError, ValueError) as e:
        raise ServerDataMissing(f"server data grid at {root} incomplete: {e!r} "
                                "(run `make serverdata`)") from e


def _load(root: Path, key: tuple) -> World:
    m = json.loads((root / version.SERVER_DATA_MANIFEST).read_text(encoding="utf-8"))
    try:
        grid = _grid(root, m)
        st_list, _ = load_ws1_stations(root / STATIONS)
    except (KeyError, OSError, ValueError) as e:
        raise ServerDataMissing(f"server data at {root} incomplete for the pad tool: {e!r} "
                                "(run `make serverdata`)") from e
    rule = settings().pads.rule  # config/backend.yaml pads.rule_ref -> site.siting
    block_m, max_slope = float(rule["block_m"]), float(rule["max_slope_deg"])
    s = padpick.settings_from_config()
    b = siting.blocks(grid, block_m, max_slope)
    ids = [int(i) for i in np.flatnonzero(b.candidate)
           if padpick.disc_in_grid(grid.shape, tuple(b.rep[i]), s.disc_radius_m, grid.res_m)]
    ids_a = np.asarray(ids, dtype=np.int64)
    xs, ys = grid.xy_of_rc(b.rep[ids_a, 0], b.rep[ids_a, 1])
    fields = {}
    if s.scenario not in m.get("scenarios", []):
        raise ServerDataMissing(f"server data at {root} have no {s.scenario} station fields "
                                "(variants.yaml d21.scenario; run `make serverdata`)")
    for st in st_list:
        f = m.get("stations", {}).get(st["id"], {}).get("fields", {}).get(s.scenario)
        if f is None:
            continue  # no access cell in this scenario (manifest no_access): unreachable
        fields[st["id"]] = Field(np.load(root / f["forward"], mmap_mode="r"),
                                 np.load(root / f["reverse"], mmap_mode="r"),
                                 (int(f["access_rc"][0]), int(f["access_rc"][1])))
    return World(key, grid, b, block_m, max_slope, s.disc_radius_m, ids_a,
                 np.column_stack([xs, ys]).reshape(-1, 2), s.scenario, s.budget_min, st_list,
                 fields)


def world() -> World:
    """The server data of this process, loaded once (again only when the manifest changes)."""
    global _WORLD
    root = version.server_data_dir()
    key = _key(root)
    with _LOCK:
        if _WORLD is None or _WORLD.key != key:
            _WORLD = None  # drop the old maps before loading the new ones
            _WORLD = _load(root, key)
        return _WORLD


def preload() -> World:
    """Load the server data now (API start-up, server.engine.warmup.preload_server_data), so the
    first /pads request finds them loaded."""
    return world()


# -------------------------------------------------------------------------------- validate ----
def _lonlat(w: World, x: float, y: float) -> tuple[float, float]:
    lon, lat = lonlat_of_xy(float(x), float(y), w.grid.crs)
    return round(float(lon), DECIMALS), round(float(lat), DECIMALS)


def _nearest(w: World, x: float, y: float) -> dict | None:
    if not len(w.valid_ids) or not (math.isfinite(x) and math.isfinite(y)):
        return None
    d = np.hypot(w.valid_xy[:, 0] - x, w.valid_xy[:, 1] - y)
    k = int(np.argmin(d))  # ties: the lower block id
    lon, lat = _lonlat(w, *w.valid_xy[k])
    return {"lon": lon, "lat": lat, "distance_m": round(float(d[k]), D_DECIMALS)}


def _block_cells(w: World, rc: tuple[int, int]) -> tuple[slice, slice, np.ndarray]:
    """(row slice, col slice, mask) of the pad's siting block (the pad cell alone if it lies in
    the strip at the grid edge that no full block covers)."""
    r, c = rc
    k = int(math.ceil(w.block_m / w.grid.res_m)) + 1
    rs = slice(max(r - k, 0), min(r + k + 1, w.grid.shape[0]))
    cs = slice(max(c - k, 0), min(c + k + 1, w.grid.shape[1]))
    i = int(w.blocks.label[r, c])
    if i < 0:
        mask = np.zeros((rs.stop - rs.start, cs.stop - cs.start), bool)
        mask[r - rs.start, c - cs.start] = True
    else:
        mask = np.asarray(w.blocks.label[rs, cs]) == i
    return rs, cs, mask


def check_pad(lon: float, lat: float) -> dict:
    """openapi PadCheck for a pad at lon/lat (see the module doc)."""
    w = world()
    grid = w.grid
    x, y = (float(v) for v in xy_of_lonlat(lon, lat, grid.crs))
    try:
        rc = grid.rc_of_xy(x, y)
    except (ValueError, OverflowError):  # outside, or no finite projection
        return {"valid": False, "reason": "outside_grid",
                "detail": f"the pad is outside the {grid.res_m:g} m routing grid",
                "nearest_valid": _nearest(w, x, y)}
    i = int(w.blocks.label[rc])
    if i < 0 or not w.blocks.candidate[i]:
        rs, cs, mask = _block_cells(w, rc)
        cell = np.asarray(grid.cellstate[rs, cs])[mask]
        z = np.asarray(grid.elev[rs, cs])[mask]
        sl = np.asarray(grid.routing_slope[rs, cs])[mask]
        if (cell == UNKNOWN).any() or not np.isfinite(z).all() or not np.isfinite(sl).all():
            return {"valid": False, "reason": "unknown_terrain",
                    "detail": f"no 1 m terrain here: the {w.block_m:g} m siting block around the "
                              "pad holds cells without measured terrain",
                    "nearest_valid": _nearest(w, x, y)}
        if i >= 0:
            blocked = int(((cell != ASSESSED) & (sl <= w.max_slope_deg)).sum())
            return {"valid": False, "reason": "slope",
                    "detail": f"the {w.block_m:g} m siting block around the pad is steeper than "
                              f"{w.max_slope_deg:g} deg (steepest cell {float(sl.max()):.1f} deg)"
                              + (f"; {blocked} blocked cell(s)" if blocked else ""),
                    "nearest_valid": _nearest(w, x, y)}
    if not padpick.disc_in_grid(grid.shape, rc, w.disc_radius_m, grid.res_m):
        return {"valid": False, "reason": "disc_off_grid",
                "detail": f"the flat 30-min disc ({w.disc_radius_m:.0f} m) around the pad leaves "
                          "the routing grid",
                "nearest_valid": _nearest(w, x, y)}
    if i < 0:  # cannot happen while disc radius > block size; never report it valid
        raise RuntimeError(f"pad cell {rc} lies in no siting block but its disc is in the grid")
    return {"valid": True, "reason": None, "nearest_valid": None}


# ---------------------------------------------------------------------------------- screen ----
def unsupported(canonical: dict) -> list[str]:
    """Top-level plan_inputs blocks (other than the pad) that differ from the defaults."""
    d = canonical_inputs(official_inputs())
    return sorted(k for k in set(canonical) | set(d)
                  if k not in NOT_COMPARED and canonical.get(k) != d.get(k))


def _t(v: float) -> float | None:
    return round(float(v), T_DECIMALS) if math.isfinite(v) else None


@dataclass
class Matrices:
    """The D21 screening matrices of one pad (``padpick.matrices``' layout), minutes."""

    ids: list[str]
    t_from: np.ndarray  # (n,) pad -> station
    t_to: np.ndarray  # (n,) station -> pad
    t_leg: np.ndarray  # (n, n) station i -> station j
    dwell: list[float]
    budget_min: float


def matrices(lon: float, lat: float) -> Matrices:
    """Screening matrices at the pad's cell from the precomputed station fields (no Dijkstra).
    The pad must lie in the grid (check_pad first)."""
    w = world()
    rc = w.grid.rc_of_xy(*xy_of_lonlat(lon, lat, w.grid.crs))
    ids = [s["id"] for s in w.stations]
    n = len(ids)
    f = [w.fields.get(i) for i in ids]
    t_from = np.array([np.inf if x is None else float(x.reverse[rc]) for x in f])
    t_to = np.array([np.inf if x is None else float(x.forward[rc]) for x in f])
    t_leg = np.full((n, n), np.inf)
    for a in range(n):
        for b in range(n):
            if a != b and f[a] is not None and f[b] is not None:
                t_leg[a, b] = float(f[a].forward[f[b].access_rc])
    dwell0 = load_config("stations")["dwell_min"]  # the D21 screening's dwell (padpick.run)
    dwell = [float(s.get("dwell_min", dwell0)) for s in w.stations]
    return Matrices(ids, t_from, t_to, t_leg.reshape(n, n), dwell, w.budget_min)


def screen(plan_inputs: dict) -> dict:
    """openapi PadScreen for plan_inputs (raises hashing.InvalidPlanInputs, UnsupportedInputs,
    InvalidPad, ServerDataMissing)."""
    c = canonical_inputs(plan_inputs)
    bad = unsupported(c)
    if bad:
        raise UnsupportedInputs(bad)
    pad = c["pad"]
    check = check_pad(pad["lon"], pad["lat"])
    if not check["valid"]:
        raise InvalidPad(check)
    w = world()
    m = matrices(pad["lon"], pad["lat"])
    count = int(padpick.screen_counts(m.t_from[None], m.t_to[None], m.t_leg[None], m.dwell,
                                      m.budget_min)[0])  # fmt: skip
    values = [s.get("value") for s in w.stations]
    best = None
    if m.ids and all(v is not None for v in values):
        p = orienteering.solve(values, m.dwell, m.t_from, m.t_to, m.t_leg, m.budget_min)
        if p.order:
            best = {"order": [m.ids[k] for k in p.order],
                    "total_min": round(float(p.total_min), T_DECIMALS)}
    rows = [{"id": i, "t_out_min": _t(m.t_from[k]), "t_home_min": _t(m.t_to[k]),
             "reachable": bool(math.isfinite(m.t_from[k]) and math.isfinite(m.t_to[k]))}
            for k, i in enumerate(m.ids)]  # fmt: skip
    return {"pad": {"lon": pad["lon"], "lat": pad["lat"]}, "stations": rows,
            "feasible_evas": count, "best_route": best, "label": settings().labels.live,
            "scenario": w.scenario, "note": PREVIEW_NOTE}

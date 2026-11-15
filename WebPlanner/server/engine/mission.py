"""mission.json for the simulator from a result tree (D103, D110; WP9b).

``build_mission`` turns one plan's result tree (a live job's ``results/{hash}/`` or
``web/public/data/``: same file names and web contracts) into the simulator plan format
``contracts/bundle/mission.schema.json`` (bundle family v1.1.0; README "Mission file"). The
field semantics are the Mission Planer's ``buildMission`` / ``finalizeMission``
(``origin/waypoint-routing`` ``web/src/mission/export.ts``, author N0CEO), ported to the
engine's own files; nothing is recomputed, only copied, converted to the pad-local frame and
rounded:

- frame: tools/make_bundle.py ``Frame`` (analysis-projection metres minus the pad's; x east,
  y north, z up = areoid height - pad elev_m), with this plan's pad as the origin;
- waypoints: the stops in visit order: the ordered route's stops (inputs ``route.stops``;
  stations by id, free points W1.. with their label) or, for an auto plan, the stations of the
  route legs; planned arrive / leave, O2 at leave and the latest departure (turn-back) from
  ``timeline_{sid}.json``; T_home / O2_home from the WS2 fields when given (``rasters``);
- legs: one per ``route_{sid}.geojson`` LineString (``to`` = "pad" is the ``home`` leg);
  an infeasible ordered route has only the legs the engine planned (no home leg);
- path: one row per route vertex (the engine's 3 m grid, not resampled) with the engine's
  ``times_min``; O2 used is known at each leg's ends only (the engine writes O2 per leg), so
  inner vertices carry null; z and the fields come from ``rasters`` (null without them);
- timeline: the engine's timeline events (turn_back rows are latest departures, not planned
  states: they go to ``waypoints[].turn_back_t_min``), O2_home from the field at the event's
  position; null when a value is unknown (schema: every timeline cell is a number);
- summary: the Mission Planer's budget totals from the engine's legs and timeline; ``feasible``
  = the run record's ``feasibility.feasible`` for an ordered route, true for auto;
- constants: crew.yaml values through pipeline.engine.margin (the job's crew), the F18 amber
  threshold from config/hud.yaml; conditions: clock.json / rad.json / the manifest's route keys.

Unknown values are null. Deterministic: the same tree and arguments give the same bytes;
``mission_id`` = "m-" + 12 hex of the sha256 of the compact JSON with mission_id and created_utc
blank (export.ts finalizeMission; integral floats are written as integers so JSON.stringify
gives the same text). ``created_utc`` defaults to the newest manifest utc of the route and
timeline files, so it is part of the tree too.

The exporter (``export_mission``, registered as "mission" in server.engine.exporters, kind
"sim_plan") writes ``mission.json`` into every live result tree (ordered and auto plans).
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable
from functools import cache
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO / "contracts" / "bundle" / "mission.schema.json"
STATIC_DATA = REPO / "web" / "public" / "data"
SCHEMA_VERSION = "1.1.0"
FILE = "mission.json"
KIND = "sim_plan"
PATH_COLUMNS = ["leg", "s_m", "x_m", "y_m", "z_m", "t_eva_min", "o2_used_l", "t_home_min",
                "o2_home_l"]
PATH_UNITS = {"s_m": "m (horizontal arc length from the leg start)", "x_m": "m", "y_m": "m",
              "z_m": "m (pad-local)", "t_eva_min": "min since EVA start",
              "o2_used_l": "L since EVA start", "t_home_min": "min", "o2_home_l": "L"}
TIMELINE_COLUMNS = ["t_min", "phase", "wp", "o2_used_l", "t_home_min", "o2_home_l",
                    "tasks_left_l", "margin_min", "binding"]
PHASES = {"depart": "t = 0 at the pad", "walk": "a route vertex",
          "arrive": "at waypoint wp, stop starts", "stop": "inside a stop (dose candidate)",
          "leave": "stop over", "home": "inside the walk home (dose candidate)",
          "return": "back at the pad"}
TERMS = ("O2", "daylight", "dose", "EVA duration")
ENGINE = "pipeline.engine.plan.build_plan"

Lookup = Callable[[list[tuple[float, float]]], list[float | None]]


# ------------------------------------------------------------------------------ helpers ----
def _r(v, d: int):
    """export.ts r(): round to d decimals, null for unknown; integral values as int (so the
    compact JSON equals JSON.stringify's)."""
    if v is None or isinstance(v, bool) or not math.isfinite(float(v)):
        return None
    x = round(float(v), d)
    return int(x) if x == int(x) else x


def _num(v):
    """A number as JSON writes it in JS (integral -> int); other values unchanged."""
    if isinstance(v, float) and math.isfinite(v) and v == int(v):
        return int(v)
    return v


def _add(a, b):
    return None if a is None or b is None else a + b


def _load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def _first(*paths: Path) -> Path | None:
    return next((p for p in paths if p.is_file()), None)


@cache
def _config(name: str) -> dict:
    return yaml.safe_load((REPO / "config" / f"{name}.yaml").read_text(encoding="utf-8"))


def js_number(x) -> str:
    """JavaScript Number.prototype.toString (what JSON.stringify writes) for a finite number:
    the shortest round-trip digits (Python repr gives the same digits), placed by ECMA-262
    Number::toString (plain notation for 1e-7 < |x| < 1e21, else d.ddde+n)."""
    if isinstance(x, bool) or not math.isfinite(float(x)):
        raise ValueError(f"not a finite JSON number: {x!r}")
    if x == 0:
        return "0"
    from decimal import Decimal

    sign = "-" if x < 0 else ""
    t = Decimal(repr(abs(x)) if isinstance(x, float) else str(abs(int(x)))).normalize()
    digits = "".join(map(str, t.as_tuple().digits))
    k = len(digits)
    n = k + t.as_tuple().exponent
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        mant = digits if k == 1 else digits[0] + "." + digits[1:]
        out = f"{mant}e{'+' if e > 0 else '-'}{abs(e)}"
    return sign + out


def js_stringify(obj) -> str:
    """JSON.stringify(obj) (no indent): key order kept, ',' and ':' without spaces, non-ASCII
    kept, numbers by js_number."""
    if obj is None:
        return "null"
    if obj is True:
        return "true"
    if obj is False:
        return "false"
    if isinstance(obj, (int, float)):
        return js_number(obj)
    if isinstance(obj, str):
        return json.dumps(obj, ensure_ascii=False)
    if isinstance(obj, (list, tuple)):
        return "[" + ",".join(js_stringify(v) for v in obj) + "]"
    if isinstance(obj, dict):
        return "{" + ",".join(json.dumps(str(k), ensure_ascii=False) + ":" + js_stringify(v)
                              for k, v in obj.items()) + "}"
    raise TypeError(f"not JSON: {type(obj).__name__}")


def mission_id(doc: dict) -> str:
    """README / export.ts finalizeMission: 'm-' + the first 12 hex of the sha256 of
    JSON.stringify(doc with mission_id and created_utc = ''), computed as a browser does
    (js_stringify). For every document this module writes, the text equals
    tests/test_mission_contract.py's json.dumps(..., separators=(",", ":"), ensure_ascii=False)
    (integral numbers are ints, no number needs an exponent)."""
    blank = dict(doc, mission_id="", created_utc="")
    return "m-" + hashlib.sha256(js_stringify(blank).encode("utf-8")).hexdigest()[:12]


@cache
def _validator():
    from jsonschema import Draft202012Validator

    return Draft202012Validator(_load(SCHEMA_PATH))


def schema_errors(doc: dict) -> list[str]:
    return [f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}"
            for e in _validator().iter_errors(doc)]


def raster_lookup(path: Path) -> Lookup:
    """Nearest-cell values of a single-band GeoTIFF in the analysis CRS at projected (x, y);
    nodata / non-finite / outside -> None."""
    import rasterio

    def look(xy: list[tuple[float, float]]) -> list[float | None]:
        out: list[float | None] = []
        if not xy:
            return out
        with rasterio.open(path) as src:
            h, w = src.shape
            nd = src.nodata
            for (x, y), v in zip(xy, src.sample(xy, indexes=1), strict=True):
                r, c = src.index(x, y)
                val = float(v[0])
                ok = 0 <= r < h and 0 <= c < w and math.isfinite(val) and (nd is None or val != nd)
                out.append(val if ok else None)
        return out

    return look


def _raster_res(path: Path | None) -> float | None:
    if path is None:
        return None
    import rasterio

    with rasterio.open(path) as src:
        return float(src.res[0])


# --------------------------------------------------------------------------- tree reads ----
def _manifest(tree: Path) -> dict:
    p = tree / "manifest.json"
    return _load(p) if p.is_file() else {}


def _mvalue(man: dict, key: str):
    e = man.get(key)
    return e.get("value") if isinstance(e, dict) else None


def _created(man: dict, files: list[str]) -> str | None:
    utcs = sorted(str(e["utc"]) for e in man.values()
                  if isinstance(e, dict) and e.get("file") in files and e.get("utc"))
    if not utcs:
        return None
    u = utcs[-1].replace("+00:00", "Z")
    return u[:19] + "Z" if len(u) >= 19 else None


def _pad(tree: Path, inputs: dict) -> dict:
    """plan.json-style pad block: official (pad.json pad), a picker option or custom."""
    lon, lat = float(inputs["pad"]["lon"]), float(inputs["pad"]["lat"])
    padp = _first(tree / "pad.json", STATIC_DATA / "pad.json")
    if padp is not None:
        doc = _load(padp)
        p = doc.get("pad") or {}
        if (p.get("lon"), p.get("lat")) == (lon, lat):
            return {"kind": "official", "id": p.get("id") or "official", "lon": lon, "lat": lat,
                    "elev_m": p.get("elev_m"), "source": "pad.json pad (D21 official pad)"}
        for a in doc.get("alternatives") or []:
            if a.get("picker") and (a.get("lon"), a.get("lat")) == (lon, lat):
                return {"kind": "picker", "id": a.get("id"), "lon": lon, "lat": lat,
                        "elev_m": a.get("elev_m"),
                        "source": f"pad.json alternatives rank {a.get('rank')} (picker)"}
    return {"kind": "custom", "id": None, "lon": lon, "lat": lat, "elev_m": None,
            "source": "plan_inputs pad"}


def _scenario_row(tree: Path, scenario: str) -> dict:
    idx = _load(tree / "scenarios" / "index.json")
    row = next((s for s in idx["scenarios"] if s["id"] == scenario), None)
    if row is None:
        raise ValueError(f"scenario {scenario} not in {tree}/scenarios/index.json")
    return row


def _stations(tree: Path) -> dict[str, dict]:
    p = _first(tree / "stations.json", STATIC_DATA / "stations.json")
    if p is None:
        return {}
    doc = _load(p)
    rows = doc["stations"] if isinstance(doc, dict) else doc
    return {s["id"]: s for s in rows}


# ---------------------------------------------------------------------------- builder ----
def build_mission(tree: Path, *, inputs: dict, scenario: str, origin: str, origin_label: str,
                  planner: dict, created_utc: str | None = None,
                  feasibility: dict | None = None, rasters: dict[str, Path] | None = None,
                  conditions_dir: Path | None = None, title: str | None = None) -> dict:
    """The mission document (schema mission.schema.json v1.1.0) of ``scenario`` in ``tree``.

    inputs: the plan's plan_inputs (the run record's ``inputs``: canonical plus route labels and
    title). planner: the ``planner`` block (routing_grid_res_m, elevation_res_m, engine
    identity...); ``files`` defaults to the route and timeline file names. feasibility: the run
    record's ``feasibility`` (ordered routes); default = ``tree/run_record.json``'s. rasters:
    optional GeoTIFFs in the analysis CRS: ``elev`` (areoid m, for z and the pad's elev_m when
    pad.json has none), ``t_home`` / ``o2_home`` (WS2 fields of ``scenario``). conditions_dir:
    clock.json / rad.json (default ``tree/conditions``, else web/public/data/conditions).
    Pure: reads files, writes nothing."""
    from server.engine import route as route_mod
    from tools.make_bundle import Frame, storm_doc

    tree = Path(tree)
    rasters = {k: Path(v) for k, v in (rasters or {}).items() if v is not None}
    row = _scenario_row(tree, scenario)
    route_rel, tl_rel = f"route_{scenario}.geojson", f"timeline_{scenario}.json"
    route = _load(tree / route_rel)
    timeline = _load(tree / tl_rel)
    man = _manifest(tree)
    stations = _stations(tree)
    site = _config("site")["crs"]

    # --- frame
    pad = _pad(tree, inputs)
    elev = raster_lookup(rasters["elev"]) if "elev" in rasters else None
    frame = Frame(pad_id=str(pad["id"] or "custom"), lon=pad["lon"], lat=pad["lat"],
                  elev_m=0.0, proj=site["analysis_proj"], radius_m=float(site["mars_radius_m"]))
    px, py = frame.pad_xy
    if pad["elev_m"] is None and elev is not None:
        pad["elev_m"] = _r(elev([(px, py)])[0], 2)
    pad_elev = pad["elev_m"]

    def local(lon: float, lat: float) -> tuple[float, float]:
        return frame.local(lon, lat)

    def zs(pts: list[tuple[float, float]]) -> list[float | None]:
        if elev is None or pad_elev is None:
            return [None] * len(pts)
        return [None if h is None else h - pad_elev
                for h in elev([(x + px, y + py) for x, y in pts])]

    def home(pts: list[tuple[float, float]]) -> tuple[list, list]:
        th = rasters.get("t_home")
        oh = rasters.get("o2_home")
        proj = [(x + px, y + py) for x, y in pts]
        t = raster_lookup(th)(proj) if th else [None] * len(pts)
        o = raster_lookup(oh)(proj) if oh else [None] * len(pts)
        return t, o

    # --- engine legs and timeline
    legs = sorted((f for f in route["features"] if f["geometry"]["type"] == "LineString"),
                  key=lambda f: f["properties"]["leg"])
    events = [e for e in timeline if e.get("event") != "turn_back"]
    turn_back = {e["station"]: e["t_min"] for e in timeline
                 if e.get("event") == "turn_back" and e.get("station")}
    depart = next((e for e in events if e["event"] == "depart"), None)
    cap = None if depart is None else depart.get("o2_left_L")

    def used(e: dict | None):
        return None if e is None or cap is None or e.get("o2_left_L") is None \
            else cap - e["o2_left_L"]

    arrive = {e["station"]: e for e in events if e["event"] == "arrive"}
    leave = {e["station"]: e for e in events if e["event"] == "leave"}

    # --- waypoints in visit order
    mode = route_mod.mode(inputs)
    if mode == route_mod.ORDERED:
        stops = []
        k = 0
        for s in inputs["route"]["stops"]:
            if route_mod.is_free(s):
                k += 1
                stops.append({"key": f"W{k}", "station": None, "lon": float(s["lon"]),
                              "lat": float(s["lat"]), "label": s.get("label")})
            else:
                st = stations.get(s["station"]) or {}
                stops.append({"key": s["station"], "station": s["station"],
                              "lon": st.get("lon"), "lat": st.get("lat"), "label": None})
    else:
        stops = []
        for f in legs:
            to = f["properties"]["to"]
            if to != "pad":
                st = stations.get(to) or {}
                stops.append({"key": to, "station": to, "lon": st.get("lon"),
                              "lat": st.get("lat"), "label": None})
    index_of = {s["key"]: i + 1 for i, s in enumerate(stops)}
    n = len(stops)
    dwell = (inputs.get("stations") or {}).get("dwell_min") or {}

    def wp_name(key: str) -> str:
        return "pad" if key == "pad" else f"wp{index_of[key]}" if key in index_of else key

    # leg geometry -> path rows
    rows: list[list] = []
    legs_out: list[dict] = []
    leg_end_xy: dict[str, tuple[float, float]] = {}
    vertices: list[tuple[float, float, float]] = []  # (t, x, y) along the walked route
    o2_at = 0.0 if cap is not None else None
    walk_min = 0.0
    home_leg = None
    for f in legs:
        p = f["properties"]
        coords = f["geometry"]["coordinates"]
        xy = [local(c[0], c[1]) for c in coords]
        z = zs(xy)
        th, oh = home(xy)
        times = p.get("times_min") or [None] * len(xy)
        is_home = p["to"] == "pad"
        start_o2 = (used(leave.get(p["from"])) if p["from"] != "pad" else 0.0)
        if start_o2 is None:
            start_o2 = o2_at
        end_o2 = _add(start_o2, p.get("o2_L"))
        first = len(rows)
        s = 0.0
        for k, (x, y) in enumerate(xy):
            if k:
                s += math.hypot(x - xy[k - 1][0], y - xy[k - 1][1])
            o2 = start_o2 if k == 0 else end_o2 if k == len(xy) - 1 else None
            rows.append([p["leg"], _r(s, 2), _r(x, 2), _r(y, 2), _r(z[k], 2), _r(times[k], 3),
                         _r(o2, 3), _r(th[k], 2), _r(oh[k], 3)])
            if times[k] is not None:
                vertices.append((float(times[k]), x, y))
        leg_end_xy[p["to"]] = xy[-1]
        o2_at = end_o2
        entry = {"leg": p["leg"], "kind": "home" if is_home else "out",
                 "from": wp_name(p["from"]), "to": wp_name(p["to"]), "routed": True,
                 "length_m": _r(p.get("length_m"), 2), "time_min": _r(p.get("t_min"), 3),
                 "o2_l": _r(p.get("o2_L"), 3), "t_start_min": _r(p.get("t_start_min"), 3),
                 "t_end_min": _r(p.get("t_end_min"), 3), "first_row": first,
                 "n_rows": len(xy)}
        if p.get("to_access_dist_m") is not None:
            entry["to_access_dist_m"] = _r(p["to_access_dist_m"], 2)
        legs_out.append(entry)
        if is_home:
            home_leg = p
        elif p.get("t_min") is not None:
            walk_min += float(p["t_min"])

    # legs the engine did not plan (an infeasible ordered route stops before its failing leg):
    # present with routed false and null numbers, as the Mission Planer writes an unrouted leg
    n_out = sum(1 for lg in legs_out if lg["kind"] == "out")
    for i in range(n_out, n):
        prev = "pad" if i == 0 else stops[i - 1]["key"]
        t0 = 0.0 if i == 0 else (leave.get(prev) or {}).get("t_min") if i == n_out else None
        legs_out.append({"leg": len(legs_out) + 1, "kind": "out", "from": wp_name(prev),
                         "to": f"wp{i + 1}", "routed": False, "length_m": None,
                         "time_min": None, "o2_l": None, "t_start_min": _r(t0, 3),
                         "t_end_min": None, "first_row": None, "n_rows": 0})
    if n and home_leg is None:
        legs_out.append({"leg": len(legs_out) + 1, "kind": "home", "from": f"wp{n}",
                         "to": "pad", "routed": False, "length_m": None, "time_min": None,
                         "o2_l": None, "t_start_min": None, "t_end_min": None,
                         "first_row": None, "n_rows": 0})
    legs_known = all(lg["routed"] for lg in legs_out)

    # waypoints
    wps_out: list[dict] = []
    stop_total = 0.0
    wp_xy = [None if s["lon"] is None else local(s["lon"], s["lat"]) for s in stops]
    for i, s in enumerate(stops):
        a, lv = arrive.get(s["key"]), leave.get(s["key"])
        t_arr = None if a is None else a["t_min"]
        t_lv = None if lv is None else lv["t_min"]
        if t_arr is not None and t_lv is not None:
            stop_min = t_lv - t_arr
        else:
            stop_min = float(dwell.get(s["station"], 0.0)) if s["station"] else 0.0
        stop_total += stop_min  # planned time at every stop (budget.ts stopMin)
        xy = wp_xy[i]
        # the fields where the crew stands: the access cell the leg ends at, else the stop
        at = leg_end_xy.get(s["key"]) or xy
        th, oh = home([at]) if at is not None else ([None], [None])
        t_home = (a or {}).get("t_home_min")  # the engine's T_home there, else the field's
        st = (stations.get(s["station"]) or {}) if s["station"] else {}
        name = st.get("name") or st.get("objective") or ""
        note = s["label"] if s["label"] else (name if isinstance(name, str) else "")
        w = {"index": i + 1, "name": s["key"], "station": s["station"],
             "lonlat": [_num(s["lon"]), _num(s["lat"])] if s["lon"] is not None else None,
             "x_m": _r(xy[0], 2) if xy else None, "y_m": _r(xy[1], 2) if xy else None,
             "z_m": _r(zs([xy])[0], 2) if xy else None, "note": note,
             "tags": ["station"] if s["station"] else [], "stop_min": _r(stop_min, 3),
             "arrive_t_min": _r(t_arr, 3), "leave_t_min": _r(t_lv, 3),
             "o2_used_at_leave_l": _r(used(lv), 3),
             "t_home_min": _r(t_home if t_home is not None else th[0], 2),
             "o2_home_l": _r(oh[0], 3),
             "turn_back_t_min": _r(turn_back.get(s["key"]), 3)}
        if s["station"] is None:
            del w["station"]
        if a is not None and a.get("access_dist_m") is not None:
            w["access_dist_m"] = _r(a["access_dist_m"], 2)
        wps_out.append(w)

    # --- timeline (engine events; O2_home from the field at the event's position)
    def pos_at(t: float) -> tuple[float, float] | None:
        if not vertices:
            return None
        best = min(vertices, key=lambda v: abs(v[0] - t))
        return best[1], best[2]

    def phase_of(e: dict) -> tuple[str, int | None]:
        ev, t = e["event"], e["t_min"]
        if ev in ("depart", "return", "arrive", "leave"):
            return ev, (index_of.get(e.get("station")) if ev in ("arrive", "leave") else None)
        for key, a in arrive.items():
            lv = leave.get(key)
            if lv is not None and a["t_min"] < t < lv["t_min"]:
                return "stop", index_of.get(key)
        if home_leg is not None and t > home_leg["t_start_min"]:
            return "home", None
        return "walk", None

    terms = _mvalue(man, f"route.{scenario}.margin_terms")
    tl_rows = []
    ok = True
    for e in events:
        ph, wp = phase_of(e)
        if ph in ("depart", "return"):
            o2h = 0.0
        else:
            xy = (leg_end_xy.get(e.get("station")) if ph in ("arrive", "leave")
                  else pos_at(e["t_min"]))
            o2h = None if xy is None else home([xy])[1][0]
        vals = [e["t_min"], used(e), e.get("t_home_min"), o2h, e.get("o2_tasks_left_L"),
                e.get("margin_min")]
        if any(v is None for v in vals) or e.get("margin_binding") not in TERMS:
            ok = False
            break
        tl_rows.append([_r(vals[0], 3), ph, wp, _r(vals[1], 3), _r(vals[2], 2), _r(vals[3], 3),
                        _r(vals[4], 3), _r(vals[5], 2), e["margin_binding"]])
    tl = None  # README: an unrouted leg makes the timeline null
    if ok and tl_rows and legs_known:
        low = min(tl_rows, key=lambda r: r[7])
        tl = {"columns": TIMELINE_COLUMNS, "phases": PHASES,
              "terms": [t for t in TERMS if t in (terms or {r[8] for r in tl_rows})],
              "rows": tl_rows,
              "lowest": {"margin_min": low[7], "binding": low[8], "t_min": low[0]}}

    # --- constants (the job's crew), conditions
    from pipeline.engine import margin as margin_mod
    from pipeline.engine import physio
    from server.engine import crew as crew_mod

    params = physio.scenario_params(scenario, crew=crew_mod.overrides(inputs))
    effort = margin_mod.effort_rate_l_min(params)
    reserve = margin_mod.reserve_l(params)
    constants = {"o2_capacity_l": _r(margin_mod.o2_capacity_l(), 4),
                 "effort_rate_l_min": _r(effort, 5),
                 "station_rate_l_min": _r(margin_mod.station_task_rate_l_min(), 5),
                 "reserve_l": _r(reserve, 4), "eva_limit_min": _r(margin_mod.eva_budget_min(), 3),
                 "margin_amber_min": _num(_config("hud")["margin_amber_min"])}
    cdir = conditions_dir or (tree / "conditions" if (tree / "conditions").is_dir()
                              else STATIC_DATA / "conditions")
    clock = _load(cdir / "clock.json") if (cdir / "clock.json").is_file() else {}
    eva = clock.get("eva") or {}
    term_set = set(terms or [])
    t_star = _mvalue(man, f"route.{scenario}.dose.t_star_min")
    storm = "dose" in term_set and t_star is not None
    dose = None
    if storm and (cdir / "rad.json").is_file():
        rad = _load(cdir / "rad.json")
        sd = storm_doc(rad, float(t_star), "conditions/rad.json")
        series = [[_r(r0, 3), _r(r3, 6)] for r0, _, _, r3 in sd["rows"]
                  if r0 is not None and r3 is not None and r3 > 0]
        d_allow = (inputs.get("conditions") or {}).get("d_allow_mgy") or sd["d_allow_mgy"]
        if series and d_allow:
            dose = {"d_allow_mgy": _num(float(d_allow)), "series": series,
                    "source": "conditions.yaml storm_replay (D39) + rad.json"}
    conditions = {"eva_start_lmst": eva.get("start_lmst"),
                  "t_dark_min": _r(eva.get("t_dark_min"), 2) if "daylight" in term_set else None,
                  "storm_replay": storm, "t_star_min": _r(t_star, 3) if storm else None,
                  "eva_start_utc": eva.get("start_utc"), "msl_sol": eva.get("msl_sol"),
                  "dose": dose}

    # --- summary (mission/budget.ts MissionBudget from the engine's numbers)
    if feasibility is None and mode == route_mod.ORDERED:
        rr = tree / "run_record.json"
        feasibility = _load(rr).get("feasibility") if rr.is_file() else None
    if mode == route_mod.ORDERED:
        feasible = None if not isinstance(feasibility, dict) else feasibility.get("feasible")
    else:
        feasible = True
    last = stops[-1]["key"] if stops else None
    o2_used = used(leave.get(last)) if last is not None and legs_known else None
    t_home = None if home_leg is None else home_leg.get("t_min")
    o2_home = None if home_leg is None else home_leg.get("o2_L")
    ret = next((e for e in events if e["event"] == "return"), None)
    eva_min = ret["t_min"] if ret is not None and home_leg is not None else None
    o2_cap = margin_mod.o2_capacity_l()
    o2_need = _add(o2_home, reserve)
    o2_margin = None if o2_used is None or o2_need is None else o2_cap - o2_used - o2_need
    if not legs_known:  # budget.ts legsKnown false: every downstream number is null
        feasible = False
    summary = {"feasible": feasible, "walk_min": _r(walk_min if legs_known else None, 3),
               "stop_min": _r(stop_total, 3),
               "t_home_min": _r(t_home, 3), "eva_min": _r(eva_min, 3),
               "time_margin_min": _r(None if eva_min is None
                                     else margin_mod.eva_budget_min() - eva_min, 3),
               "o2_used_l": _r(o2_used, 3), "o2_home_l": _r(o2_home, 3),
               "o2_need_l": _r(o2_need, 3), "o2_margin_l": _r(o2_margin, 3),
               "o2_margin_min": _r(None if o2_margin is None else o2_margin / effort, 3),
               "route_mode": mode}
    if mode == route_mod.ORDERED:
        summary["feasibility"] = feasibility
        summary["legs_planned"] = sum(lg["kind"] == "out" and lg["routed"] for lg in legs_out)

    # --- planner, world, identity
    pl = dict(planner)
    pl.setdefault("app_commit", None)
    pl.setdefault("config_hash", None)
    if pl.get("elevation_res_m") is None:
        pl["elevation_res_m"] = _raster_res(rasters.get("elev")) or pl["routing_grid_res_m"]
    pl.setdefault("files", {"route": route_rel, "timeline": tl_rel})
    pl = {k: _num(v) for k, v in pl.items()}
    title = title or inputs.get("title") or (
        f"Mission · {n} waypoint{'' if n == 1 else 's'} · {scenario}")
    doc = {
        "schema_version": SCHEMA_VERSION, "kind": "homeline_mission", "mission_id": "",
        "title": title, "created_utc": "", "origin": origin, "origin_label": origin_label,
        "planner": pl,
        "frame": {"kind": "pad-local", "axes": {"x": "east", "y": "north", "z": "up"},
                  "projection": {"proj": frame.proj, "pad_xy_m": [_r(px, 4), _r(py, 4)]},
                  "pad": {k: _num(v) for k, v in pad.items()}},
        "scenario": {"id": scenario, "variant": row["variant"], "suit_kg": _num(row["suit_kg"])},
        "world": {"version": None,
                  "plan_bundle_id": f"{pad['id']}.{scenario}" if pad["kind"] == "official"
                  else None},
        "constants": constants, "conditions": conditions, "waypoints": wps_out,
        "legs": legs_out,
        "path": {"columns": PATH_COLUMNS, "units": PATH_UNITS, "rows": rows},
        "timeline": tl, "summary": summary,
        "label": _config("hud")["labels"]["simulated"],
        "dummy": False,
    }
    doc["mission_id"] = mission_id(doc)
    doc["created_utc"] = created_utc or _created(man, [route_rel, tl_rel]) \
        or "1970-01-01T00:00:00Z"
    return doc


def dump(doc: dict) -> bytes:
    return (json.dumps(doc, indent=1, ensure_ascii=False) + "\n").encode("utf-8")


def write_mission(tree: Path, out_path: Path, **kw) -> Path:
    """build_mission(tree, **kw), validated against mission.schema.json, written atomically."""
    doc = build_mission(tree, **kw)
    errs = schema_errors(doc)
    if errs:
        raise ValueError("mission.json invalid:\n  " + "\n  ".join(errs[:20]))
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(f".{out_path.name}.tmp")
    tmp.write_bytes(dump(doc))
    tmp.replace(out_path)
    return out_path


# --------------------------------------------------------------------------- exporter ----
def live_planner(context: dict) -> dict:
    """The planner block of a live job: engine identity and its routing grid."""
    from server.engine import version

    try:
        ident = version.code_identity()
    except Exception:  # noqa: BLE001 - identity unavailable: unknown, never guessed
        ident = {}
    return {"engine": ENGINE, "engine_tree": ident.get("engine_tree"),
            "engine_commit": ident.get("commit"), "app_commit": context.get("commit"),
            "config_hash": ident.get("config_hash"),
            "routing_grid_res_m": context["routing_grid_res_m"],
            "elevation_res_m": context.get("elevation_res_m")}


def export_mission(result_dir: Path, context: dict | None = None) -> list[dict]:
    """Exporter "mission" (kind sim_plan): mission.json of the default scenario into a live
    result tree. context (server.engine.plan_job): ``inputs`` (record inputs), ``feasibility``
    (ordered routes), ``rasters`` (elev, t_home, o2_home GeoTIFFs), ``routing_grid_res_m``,
    ``commit``. Without inputs (not a plan job) it writes nothing."""
    from pipeline.engine.config import load
    from server.settings import settings

    ctx = context or {}
    if "inputs" not in ctx:
        return []
    scenario = load("variants")["scenarios"]["default"]
    if not (result_dir / f"route_{scenario}.geojson").is_file():
        return []
    write_mission(result_dir, result_dir / FILE, inputs=ctx["inputs"], scenario=scenario,
                  origin="computed_live", origin_label=settings().labels.live,
                  planner=live_planner(ctx), feasibility=ctx.get("feasibility"),
                  rasters=ctx.get("rasters"), conditions_dir=ctx.get("conditions_dir"))
    return [{"path": FILE, "kind": KIND}]

"""D48: ``build_plan``, the one composition of the engine products for a pad.

The batch (``python -m pipeline.engine.scenarios``) and the plan server (WS11, WS14) both call
``build_plan``; neither copies its body, so they cannot diverge. Every input is explicit: the
grid, the pad, the scenarios, the stations, the margin inputs, the settings and the output
directories. Nothing here reads a module-level output path (ENGINE_DIR, PUBLIC); the only reads
are the explicit ``terrain_dir`` inputs (stations.json, ridge_index.tif) when the caller did not
pass them in memory.

Stages, in order (each one reports ``on_stage(name, files)`` with the files it wrote or
changed): return_fields, web_products, diagnostics, partner, stations, routes, trade, siting,
d21_picker, summary. A stage that does not apply (no stations, partner off ...) is skipped
without a callback, as in the batch. The D21 pad pick (padpick.run) stays a batch-only step
before build_plan; its result comes in as ``d21`` and its official pad as ``pad_lonlat``.
"""

from __future__ import annotations

import copy
import json
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np

from . import access, cards, haul, margin, physio, provenance, stations, traverse
from .config import load
from .graph import Grid
from .physio import MissingInput

StageCallback = Callable[[str, list[Path]], None]


class _FileWatch:
    """Files under the output dirs whose (mtime, size) changed since the last ``changed()``.
    Only active when the caller wants stage callbacks (the batch pays nothing)."""

    def __init__(self, dirs: list[Path], active: bool):
        self.dirs = []
        for d in dirs:  # a public dir inside out_dir is covered by out_dir
            if not any(d == e or e in d.parents for e in self.dirs):
                self.dirs.append(d)
        self.active = active
        self.state = self._scan() if active else {}

    def _scan(self) -> dict[Path, tuple[int, int]]:
        out = {}
        for d in self.dirs:
            if d.is_dir():
                for p in d.rglob("*"):
                    if p.is_file():
                        st = p.stat()
                        out[p] = (st.st_mtime_ns, st.st_size)
        return out

    def changed(self) -> list[Path]:
        if not self.active:
            return []
        now = self._scan()
        files = sorted(p for p, s in now.items() if self.state.get(p) != s)
        self.state = now
        return files


def build_plan(
    grid: Grid,
    *,
    pad_lonlat: tuple[float, float] | list[float] | None,
    scenario_ids: list[str],
    settings,
    out_dir: Path,
    public_dir: Path | None = None,
    terrain_dir: Path | None = None,
    stations_list: list[dict] | None = None,
    stations_missing: list[str] | None = None,
    ridge: np.ndarray | None = None,
    cond: dict | None = None,
    dose_fn=None,
    route_scenarios: list[str] | None = None,
    partner: bool = True,
    siting: bool = False,
    d21: dict | None = None,
    crew: dict | None = None,
    skipped: dict | None = None,
    rmse: float | None = None,
    manifest_dir: Path | None = None,
    on_stage: StageCallback | None = None,
    timing_cb: Callable[[str, float], None] | None = None,
    timing: dict | None = None,
    verbose: bool = True,
    route: list | None = None,
    route_min_spacing_m: float | None = None,
) -> dict:
    """Build every product of one plan; returns the run summary (also written to
    ``out_dir/summary.json``).

    grid: the WS1 routing grid (graph.load_ws1_grid). pad_lonlat: the pad (None = site.yaml
    pad_default). scenario_ids: runnable scenario ids (scenarios.runnable). settings:
    scenarios.Settings. out_dir: rasters + summary; public_dir: web files (default
    out_dir/public). terrain_dir: where stations.json / ridge_index.tif are read when
    ``stations_list`` / ``ridge`` are not given. stations_list: WS1 stations with a position
    (stations.load_ws1_stations; never mutated), None = read terrain_dir/stations.json if it
    exists (no station products otherwise). cond / dose_fn: margin inputs
    (scenarios.conditions_inputs / storm_timing). route_scenarios: scenarios to route (default:
    the default scenario). partner: partner line + haul fields. siting: F8 siting + pad.json.
    d21: padpick.run result (batch only) for pad.json and the picker. crew: F26 overrides
    (physio.CREW_KEYS) for the walker; siting and the D21 picker use the config crew.
    manifest_dir: manifest fragments go there instead of the shared manifest (server).
    on_stage(name, files): after each stage. timing_cb(name, seconds): after each stage.
    timing: dict the stage seconds are added to (the batch passes its own, so the summary keeps
    load_grid and the D21 stages). route (D97): None = the engine picks stations and order
    (auto); a list of station stops (``"S4"`` or ``{"station": "S4"}``) = an ordered route
    applied to every route scenario (traverse.plan). Unknown or repeated stations raise
    traverse.RouteStopError before any work; an infeasible order is a result: the summary
    gets ``route`` {mode, stops, scenario (the default scenario, whose feasibility the run
    record carries), feasibility {scenario id: block}} and ``routes.{sid}.feasibility``.
    Free points (D97 WP2b): a stop ``{lon, lat, label?}`` is planned as W1, W2, ... (in order
    among the free stops; traverse.resolve_route); its label is dropped from every output
    (summary ``route.stops`` included). route_min_spacing_m: two stops (stations at their
    science point) or a stop and the pad closer than this raise RouteStopError
    (``route_stop_spacing``, the later stop's index) before any stage; None = no check. A stop
    (station or free point) without an access cell in a route scenario other than the default
    one skips that scenario: no route/timeline files, no ``route.feasibility`` entry, summary
    ``route.skipped`` {sid: {stop, id, code}}; in the default scenario it raises.
    """
    with provenance.to_dir(manifest_dir):
        return _build(grid, pad_lonlat, list(scenario_ids), settings, Path(out_dir),
                      Path(public_dir) if public_dir is not None else Path(out_dir) / "public",
                      None if terrain_dir is None else Path(terrain_dir), stations_list,
                      stations_missing, ridge, cond or {}, dose_fn, route_scenarios, partner,
                      siting, d21, crew, skipped or {}, rmse, on_stage, timing_cb,
                      {} if timing is None else timing, verbose, route,
                      route_min_spacing_m)  # fmt: skip


def _build(grid, pad_lonlat, sids, settings, out, pub, terrain, st_in, missing_in, ridge, cond,
           dose_fn, route_scenarios, partner, siting, d21, crew, skipped, rmse, on_stage,
           timing_cb, timing, verbose, route=None, route_min_spacing_m=None,
           ) -> dict:  # fmt: skip
    from . import scenarios as sc

    say = print if verbose else (lambda *a, **k: None)
    watch = _FileWatch([out, pub], on_stage is not None)
    tick = time.perf_counter()

    def lap(name):
        nonlocal tick
        now = time.perf_counter()
        timing[name] = round(now - tick, 1)
        tick = now
        say(f"{name}: {timing[name]} s", flush=True)
        if timing_cb is not None:
            timing_cb(name, timing[name])
        if on_stage is not None:
            on_stage(name, watch.changed())

    if st_in is None and terrain is not None and (terrain / "stations.json").exists():
        st_in, missing_in = stations.load_ws1_stations(terrain / "stations.json")
    if route is not None:  # D97: unknown or repeated stations fail before any work
        route = list(route)
        stops = traverse.resolve_route(route, st_in or [])
    if partner and ridge is None and terrain is None:
        raise MissingInput("partner line needs ridge (or terrain_dir/ridge_index.tif)")
    if not partner:
        ridge = None

    pad = sc.pad_rc(grid, tuple(pad_lonlat) if pad_lonlat else None)
    if route is not None and route_min_spacing_m is not None:  # D97: before any stage
        traverse.check_spacing(stops, _pad_lonlat(grid, pad, pad_lonlat),
                               float(route_min_spacing_m))  # fmt: skip
    fields = sc.return_fields(grid, pad, sids, settings, out_dir=out, crew=crew)
    lap("return_fields")
    iso_info: dict = {}
    index = sc.web_products(grid, pad, fields, settings, public=pub, iso_info=iso_info)
    index["model_checks"] = sc.record_model_checks("scenarios/index.json", crew=crew)
    sc._write_web(pub, "scenarios/index.json", index, "scenarios_index.schema.json")
    lap("web_products")
    diag = sc.diagnostics(grid, pad, fields, settings)
    lap("diagnostics")

    partner_by_suit: dict[int, np.ndarray] = {}
    if partner:
        if ridge is None:
            ridge = sc.load_ridge(terrain, grid)
        for suit in sorted({physio.parse_scenario(s)[1] for s in sids if s.startswith("nom_")}):
            pf = sc.partner_fields(grid, pad, ridge, suit, settings, out_dir=out, crew=crew)
            sc.partner_product(grid, pf, suit, settings, public=pub)
            partner_by_suit[suit] = pf.get(("cart", float(haul.suited_casualty_kg(suit))))
        lap("partner")

    default = load("variants")["scenarios"]["default"]
    st, recs, missing = [], [], []
    if st_in is not None:
        partner_t = partner_by_suit.get(physio.parse_scenario(default)[1])
        st, recs, missing = sc.stations_product(grid, fields, partner_t, public=pub,
                                                station_list=st_in, missing=missing_in)
        lap("stations")

    route_skipped: dict = {}
    if route is not None and st:  # D97: a non-default scenario without a stop's access cell
        route_scenarios, route_skipped = _route_scenarios(
            grid, route, st, route_scenarios or [default], default, fields, crew, rmse)

    routes = {}
    for sid in route_scenarios or [default]:
        if sid not in fields or not st or any(s.get("value") is None for s in st):
            say(f"route {sid}: skipped (no field, no stations or a station without value)")
            continue
        suit = physio.parse_scenario(sid)[1]
        res, no_access = sc.plan_route(grid, pad, sid, fields[sid], st, cond, dose_fn,
                                       partner_by_suit.get(suit), rmse, crew=crew,
                                       route=route)  # fmt: skip
        traverse.write(res, sid, pub)
        rst, _ = access.routing_stations(st, sid)
        routes[sid] = sc.route_summary(res, no_access,
                                       {s["id"]: s["access_dist_m"] for s in rst})  # fmt: skip
        if route is not None:
            routes[sid]["feasibility"] = res.feasibility
        say(f"route {sid}: {res.order} {res.total_min:.1f} min; terms {res.margin_terms}; "
            f"lowest {routes[sid]['lowest_margin_min']} ({routes[sid]['lowest_margin_binding']})"
            f"; dose {res.dose}; no access cell: {no_access}")
        if sid == default:
            hcfg = load("haul")
            frags = cards.fragments(st, res, sid, partner_by_suit.get(suit),
                                    float(haul.suited_casualty_kg(suit)), "cart",
                                    float(hcfg["contour_min"]), access.radius_m())  # fmt: skip
            cards.write(frags, pub)
            routes[sid]["cards"] = sorted(frags)
    lap("routes")

    if st:
        sc.trade_product(grid, pad, fields, partner_by_suit, st, settings, public=pub)
        lap("trade")
    siting_info = None
    if siting and st and all(s.get("value") is not None for s in st):
        try:
            ssid = sc.siting_scenario()
            sst, s_none = access.routing_stations(st, ssid)
            say(f"siting: forward runs from the {ssid} access cells of {[s['id'] for s in sst]}"
                f"; no access cell: {s_none}")
            if not sst:
                raise MissingInput(f"no station has an access cell in {ssid}")
            siting_info = sc.run_siting(grid, sst, s_none, ssid, rmse, out, pub, pad_lonlat, d21)
        except MissingInput as e:
            say(f"siting skipped: {e}")
        lap("siting")
    d21_info = None
    if d21 is not None:
        from . import padpick

        st0 = stations.attach_cells(grid, copy.deepcopy(st_in or []))
        d21_info = padpick.write_products(grid, d21, st0, cond, dose_fn, settings, ridge, out,
                                          pub, routes.get(padpick.settings_from_config().scenario))
        lap("d21_picker")

    summary = {
        "note": "WS2 engine run summary (internal, not a web contract; sanity numbers only)",
        "scenarios_run": sids, "skipped": skipped, "stations_without_position": missing,
        "margin_inputs": {**cond, "dose_timing": getattr(dose_fn, "source", None)},
        "pad_rc": [int(pad[0]), int(pad[1])], "pad_lonlat": pad_lonlat,
        "model": {"alpha": physio.alpha_level(), "ist2_span_mars_kg": physio.ist2_span_mars_kg(),
                  "o2_budget_L": {k: margin.o2_budget_l(k) for k in ("primary_L", "secondary_L")},
                  "o2_energy_j_per_ml": margin.j_per_ml(),
                  "reserve_L": margin.reserve_l(physio.scenario_params(default, crew=crew)),
                  "ist2": physio.ist2_pass_rows()},
        "grid_shape": list(grid.shape),
        "res_m": grid.res_m, "timing_s": timing, "diagnostics": diag, "routes": routes,
        "isochrones": iso_info, "siting": siting_info,
        "d21": d21_info,
    }  # fmt: skip
    if route is not None:  # D97: only an ordered route adds the block (auto stays as it was)
        summary["route"] = {"mode": "ordered", "stops": [_unlabelled(x) for x in route],
                            "scenario": default,
                            "feasibility": {sid: r["feasibility"] for sid, r in routes.items()}}
        if route_skipped:  # D97 WP2b: scenarios where a free point has no access cell
            summary["route"]["skipped"] = route_skipped
    if crew:  # F26: only a custom crew adds the block (the batch summary stays as it was)
        summary["crew"] = physio.crew_values(crew)
    summ = out / "summary.json"
    summ.parent.mkdir(parents=True, exist_ok=True)
    summ.write_text(json.dumps(summary, indent=1, default=str), encoding="utf-8")
    say(f"wrote {summ}")
    if on_stage is not None:
        on_stage("summary", watch.changed())
    return summary


def _unlabelled(stop):
    """D97: a route stop as the engine records it (a free point's label dropped)."""
    if traverse.is_free_point(stop):
        return {k: v for k, v in stop.items() if k != "label"}
    return stop


def _pad_lonlat(grid: Grid, pad, pad_lonlat) -> tuple[float, float]:
    """The pad position for the D97 spacing check: the given lon/lat, else the pad cell's."""
    if pad_lonlat:
        return float(pad_lonlat[0]), float(pad_lonlat[1])
    from .geo import lonlat_of_xy

    lon, lat = lonlat_of_xy(*grid.xy_of_rc(*pad), grid.crs)
    return float(lon), float(lat)


def _route_scenarios(grid: Grid, route: list, st: list[dict], sids: list[str], default: str,
                     fields, crew, rmse) -> tuple[list[str], dict]:  # fmt: skip
    """D97: the route scenarios to plan and {sid: {stop, id, code}} for the skipped ones. A
    stop's access cell depends on the scenario (its slope rule, D23; e.g. S7 has none in
    con_104, D46). In a scenario other than the default one, a stop without one skips that
    scenario (the contract has no feasibility value for it): a station without an access cell
    in sid (access.routing_stations), or a free point that waypoints.point_validity refuses
    under sid's params. The default scenario is always planned (its stop errors raise
    RouteStopError from the routes stage, as before). The first such stop by index is
    recorded; stations are checked first (cheap), free points only below the first bad
    station. A free point costs one extra station Dijkstra pair per non-default route scenario
    (batch only: the server routes the default scenario)."""
    from . import waypoints

    wids = traverse.free_point_ids(route)
    keep, skipped = [], {}
    for sid in sids:
        if sid == default or sid not in fields:  # (the routes loop skips a sid without field)
            keep.append(sid)
            continue
        _, no_access = access.routing_stations(st, sid)
        bad = next(((i, traverse.stop_station_id(x, i)) for i, x in enumerate(route)
                    if wids[i] is None and traverse.stop_station_id(x, i) in no_access),
                   None)  # fmt: skip
        why = None if bad is None else {"stop": bad[0], "id": bad[1],
                                        "code": "route_point_unreachable"}  # fmt: skip
        p = physio.scenario_params(sid, v1_rmse_deg=rmse, crew=crew)
        for i, x in enumerate(route[: len(route) if bad is None else bad[0]]):
            if wids[i] is None:
                continue
            v = waypoints.point_validity(grid, float(x["lon"]), float(x["lat"]), scenario=p)
            if not v["ok"]:
                why = {"stop": i, "id": wids[i], "code": v["code"]}
                break
        if why is None:
            keep.append(sid)
        else:
            skipped[sid] = why
    if not keep:
        sid, why = next(iter(skipped.items()))
        raise traverse.RouteStopError(why["stop"], why["code"],
                                      f"{why['id']}: no access cell in any route scenario "
                                      f"({sid} ...)")  # fmt: skip
    return keep, skipped

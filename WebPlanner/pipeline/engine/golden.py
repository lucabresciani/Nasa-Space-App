"""D40 (user 2026-11-14 17:22): ``physio/golden.json``, the reference cases the simulator team's
C# port of the physiology, margin and alarm logic must pass.

    python -m pipeline.engine.golden            # -> data/interim/engine/public/physio/golden.json
    python -m pipeline.engine.golden --check F  # re-checks every case of F against this reference

Every expected value is computed here from the Python reference (physio.py, haul.py, margin.py,
traverse.py) with the config values in force; ``config`` in the file lists them. The file is
deterministic (no clock, no commit inside; the manifest carries both) and ``check`` re-evaluates
every case from its inputs, which the KAT runs on a freshly built document.

Conventions (D40): coordinates are pad-local metres, x = east, y = north, z = up, origin at the
pad. Grade angles in degrees (positive = uphill in the direction of travel); a segment's grade is
atan(dz / horizontal length) and its time is horizontal length / v*(grade) (as the router).
Times in minutes unless a key says otherwise, O2 in litres, VO2 in mL/kg/min.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from . import dijkstra, haul, margin, physio, provenance, traverse
from .config import ENGINE_DIR, load

SCRIPT = "pipeline/engine/golden.py"
VERSION = "1.0.0"
REL = "physio/golden.json"
NDIG = 9  # stored precision (decimals); far below every tolerance

GRADES_DEG = [-20.0, -10.0, 0.0, 10.0, 20.0]
VARIANTS = ["optimistic", "nominal", "conservative"]
TOL = {
    "physio": {"rel": 1e-6, "abs": 1e-9},
    "o2_leg": {"rel": 1e-6, "abs": 1e-9},
    "haul": {"rel": 1e-6, "abs": 1e-9},
    "margin": {"rel": 0.0, "abs": 1e-6},
    "turn_back": {"rel": 0.0, "abs": 1e-6},
    "dose_leash": {"rel": 1e-9, "abs": 1e-9},
    # route: the router interpolates a 0.01-deg pace/O2 table, so analytic segment sums agree
    # to ~1e-4 relative; timeline rows are rounded to 0.01 (contract) -> 0.011 abs
    "route_segments": {"rel": 1e-3, "abs": 1e-6},
    "route_rows": {"rel": 0.0, "abs": 0.011},
}


def _r(x):
    """Round floats (recursively) to NDIG decimals; keep None, bool, int, str."""
    if isinstance(x, np.ndarray):
        return _r(x.tolist())
    if isinstance(x, dict):
        return {k: _r(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_r(v) for v in x]
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        x = float(x)
        if not math.isfinite(x):
            return None
        return round(x, NDIG) + 0.0
    return x


# ------------------------------------------------------------------ config snapshot


def config_used() -> dict:
    crew, var, h = load("crew"), load("variants"), load("haul")
    p = physio.params("nominal")
    return {
        "crew": {k: crew[k] for k in ("body_mass_kg", "vo2max_ml_kg_min", "effort_cap_frac",
                                      "g_mars", "tools_kg", "suit_masses_kg", "default_suit_kg",
                                      "eva_h", "o2_energy_j_per_ml", "anchor", "v_safe_ms")},
        "variants": {v: {k: var["variants"][v][k] for k in ("eta", "V0", "a_mult", "nogo_deg")}
                     for v in VARIANTS},
        "derived": {
            "alpha_ml_kg_min_per_ms_per_kg": physio.alpha_level(),
            "ist2_span_mars_kg": physio.ist2_span_mars_kg(),
            "a_anchor_ml_kg_min_per_ms": p.a_anchor,
            "minetti_coef_c5_to_c0": list(physio.MINETTI_COEF),
            "downhill_clamp": list(physio.DOWNHILL_CLAMP),
            "o2_budget_L": margin.o2_capacity_l(),
            "o2_reserve_L": margin.reserve_l(p),
            "o2_reserve_label": margin.reserve_label(),
            "effort_rate_L_min": margin.effort_rate_l_min(p),
            "station_task_rate_L_min": margin.station_task_rate_l_min(),
            "planning_rate_L_min": margin.btu_h_to_l_min(
                load("crew")["o2_margin"]["planning_rate_btu_h"]),
            "eva_budget_min": margin.eva_budget_min(),
            "haul_min_speed_ms": haul._min_speed(),
        },
        "formulas": dict(var["formulas"]),
        "o2_margin": dict(crew["o2_margin"]),
        "haul": {k: h[k] for k in ("cases", "efficiency_eps", "rescuer_effort_frac", "boot_mu",
                                   "formulas", "contour_min")},
        "dose_leash": dict(load("conditions")["leash"]),
    }  # fmt: skip


# ------------------------------------------------------------------ cases


def physio_case(variant: str, suit_kg: float, grade_deg: float) -> dict:
    p = physio.params(variant, suit_kg=suit_kg)
    th = math.radians(grade_deg)
    v = float(physio.governor(p, th))
    vo2 = float(physio.vo2(p, v, th))
    passable = bool(abs(grade_deg) <= p.nogo_deg + 1e-9 and v > 0)
    return {
        "id": f"physio.{variant}.{int(suit_kg)}.{grade_deg:+.0f}deg",
        "inputs": {"variant": variant, "suit_kg": suit_kg, "carried_kg": p.carried_kg,
                   "grade_deg": grade_deg},
        "expected": {
            "a_M": physio.a_of_m(p), "k_uphill": float(physio.k_uphill(p, th)),
            "cost_slope": float(physio.cost_slope(p, th)), "v_safe_ms": float(physio.v_safe(p, th)),
            "v_star_ms": v, "vo2_at_v_star": vo2, "vo2_cap": p.cap,
            "passable": passable,
            "pace_s_per_m": 1.0 / v if passable else None,
            "o2_L_per_m": float(physio.o2_litres(p, vo2, 1.0 / v / 60.0)) if passable else None,
            "heat_W_at_v_star": float(physio.heat_w(p, vo2)),
        },
    }  # fmt: skip


LEG_VERTICES = [[0.0, 0.0, 0.0], [300.0, 0.0, 0.0], [300.0, 400.0, 35.0], [0.0, 400.0, 0.0],
                [0.0, 100.0, -40.0]]  # fmt: skip


def o2_leg_case(variant: str, suit_kg: float, vertices=LEG_VERTICES) -> dict:
    p = physio.params(variant, suit_kg=suit_kg)
    segs, t_tot, o2_tot = [], 0.0, 0.0
    for a, b in zip(vertices, vertices[1:], strict=False):
        dh = math.hypot(b[0] - a[0], b[1] - a[1])
        th = math.atan2(b[2] - a[2], dh)
        v = float(physio.governor(p, th))
        ok = abs(math.degrees(th)) <= p.nogo_deg + 1e-9 and v > 0
        t = dh / v / 60.0 if ok else None
        o2 = float(physio.o2_litres(p, physio.vo2(p, v, th), t)) if ok else None
        segs.append({"length_m": dh, "grade_deg": math.degrees(th), "v_star_ms": v,
                     "t_min": t, "o2_L": o2})  # fmt: skip
        t_tot = None if t is None or t_tot is None else t_tot + t
        o2_tot = None if o2 is None or o2_tot is None else o2_tot + o2
    return {"id": f"o2_leg.{variant}.{int(suit_kg)}",
            "inputs": {"variant": variant, "suit_kg": suit_kg, "vertices": vertices},
            "expected": {"segments": segs, "t_min": t_tot, "o2_L": o2_tot}}  # fmt: skip


def haul_case(case: str, casualty: str, grade_deg: float, suit_kg: float = 104) -> dict:
    p = physio.params("nominal", suit_kg=suit_kg)
    m_ic = haul.suited_casualty_kg(suit_kg) if casualty == "suited" else float(
        load("haul")["casualty_kg"]["bound"])
    c = haul.case(case, m_ic)
    th = math.radians(grade_deg)
    return {"id": f"haul.{case}.{casualty}.{grade_deg:+.0f}deg",
            "inputs": {"case": case, "rescuer_variant": "nominal", "rescuer_suit_kg": suit_kg,
                       "casualty_kg": m_ic, "mu": c.mu, "eps": c.eps,
                       "effort_frac": c.effort_frac, "grade_deg": grade_deg},
            "expected": {"force_N": float(haul.force(m_ic, c.mu, th, p.g)),
                         "traction_limit_N": float(c.boot_mu * (p.m_b + p.carried_kg) * p.g
                                                   * math.cos(th)),
                         "speed_ms": float(haul.speed(p, c, th)),
                         "feasible": haul.infeasible_reason(p, c, th) is None,
                         "reason": haul.infeasible_reason(p, c, th)}}  # fmt: skip


def _mi_json(mi: margin.MarginInputs) -> dict:
    return {"o2_capacity_L": mi.o2_capacity_l, "reserve_L": mi.reserve_l,
            "effort_rate_L_min": mi.o2_rate_l_min, "task_rate_L_min": mi.dwell_rate_l_min,
            "planning_rate_L_min": mi.planning_rate_l_min, "t_dark_min": mi.t_dark_min,
            "tau_dose_min": mi.tau_dose_min, "eva_budget_min": mi.eva_budget_min}  # fmt: skip


def _mi_from(d: dict) -> margin.MarginInputs:
    return margin.MarginInputs(o2_capacity_l=d["o2_capacity_L"], reserve_l=d["reserve_L"],
                               o2_rate_l_min=d["effort_rate_L_min"],
                               dwell_rate_l_min=d["task_rate_L_min"],
                               planning_rate_l_min=d["planning_rate_L_min"],
                               t_dark_min=d["t_dark_min"], tau_dose_min=d["tau_dose_min"],
                               eva_budget_min=d["eva_budget_min"])  # fmt: skip


def _terms(mi, t, used, th, oh, tasks) -> dict:
    out = {"O2": margin.o2_margin_min(mi, used, oh, tasks)}
    if mi.t_dark_min is not None:
        out["daylight"] = mi.t_dark_min - t - th
    if mi.tau_dose_min is not None:
        out["dose"] = mi.tau_dose_min - th
    if mi.eva_budget_min is not None:
        out[margin.EVA] = mi.eva_budget_min - t - th
    return out


# (id, t_min, o2_used_L, t_home_min, o2_home_L, tasks_left_L, t_dark, tau_dose): one binding term
MARGIN_POINTS = [
    ("depart", 0.0, 0.0, 0.0, 0.0, 0.0, 578.6, 113.7),
    ("arrive_station_with_tasks", 120.0, 150.0, 45.0, 40.0, 25.12, 578.6, 113.7),
    ("o2_binds", 200.0, 330.0, 50.0, 60.0, 0.0, 578.6, 300.0),
    ("daylight_binds", 250.0, 200.0, 60.0, 50.0, 0.0, 300.0, 300.0),
    ("dose_binds_negative", 100.0, 100.0, 60.0, 50.0, 0.0, 578.6, 50.0),
    ("eva_duration_binds", 330.0, 250.0, 50.0, 40.0, 0.0, 578.6, 300.0),
]  # fmt: skip


def margin_cases() -> list[dict]:
    p = physio.params("nominal")
    out = []
    for cid, t, u, th, oh, tasks, dark, tau in MARGIN_POINTS:
        mi = margin.inputs(p, t_dark_min=dark, tau_dose_min=tau, eva=True)
        m, b = margin.margin(mi, t, u, th, oh, tasks)
        out.append({"id": f"margin.{cid}",
                    "inputs": {"margin_inputs": _mi_json(mi), "t_min": t, "o2_used_L": u,
                               "t_home_min": th, "o2_home_L": oh, "tasks_left_L": tasks},
                    "expected": {"terms_min": _terms(mi, t, u, th, oh, tasks), "margin_min": m,
                                 "binding": b, "o2_left_L": mi.o2_capacity_l - u,
                                 "o2_margin_min_planning_rate": margin.o2_margin_min(
                                     mi, u, oh, tasks, rate_l_min=mi.planning_rate_l_min)}})
    return out  # fmt: skip


def _way_home(n: int, step_m: float, t_per_m: float, o2_per_m: float) -> dict:
    """A straight level way home of n segments: per vertex tau (min since leaving), O2 used on
    the way, T_home and O2_home at the vertex."""
    d = np.arange(n + 1) * step_m
    tot = n * step_m
    return {"tau": (d * t_per_m).tolist(), "o2": (d * o2_per_m).tolist(),
            "t_home": ((tot - d) * t_per_m).tolist(), "o2_home": ((tot - d) * o2_per_m).tolist()}


def turn_back_cases() -> list[dict]:
    """Latest departure from a station (the turn-back row, D28): the crew works at the task rate
    until it leaves, then walks the way home; m >= 0 at every vertex. Two cases: EVA duration
    binds (normal budget) and O2 binds (a small O2 budget)."""
    p = physio.params("nominal")
    pc = physio_case("nominal", 104, 0.0)["expected"]
    way = _way_home(10, 300.0, pc["pace_s_per_m"] / 60.0, pc["o2_L_per_m"])
    out = []
    for cid, t0, u0, cap in (("eva_duration_binds", 150.0, 200.0, None),
                             ("o2_binds", 150.0, 300.0, 380.0)):  # fmt: skip
        mi = margin.inputs(p, t_dark_min=578.6, tau_dose_min=300.0, eva=True)
        if cap is not None:
            from dataclasses import replace

            mi = replace(mi, o2_capacity_l=cap)
        terms = margin.latest_departure_terms(mi, t0, u0, mi.dwell_rate_l_min, way["tau"],
                                              way["o2"], way["t_home"], way["o2_home"])
        b = min(terms, key=terms.get)
        out.append({"id": f"turn_back.{cid}",
                    "inputs": {"margin_inputs": _mi_json(mi), "arrive_t_min": t0,
                               "o2_used_at_arrival_L": u0, "rate_while_waiting_L_min":
                               mi.dwell_rate_l_min, "way_home": way},
                    "expected": {"latest_departure_by_term_min": terms, "turn_back_min": terms[b],
                                 "binding": b}})  # fmt: skip
    return out


def dose_cases() -> list[dict]:
    """tau_dose = 60 D_allow / Ddot (conditions.yaml leash.formula); Ddot in mGy/h, from uGy/day
    as /1000/24 (WS4 rad.json units)."""
    lf = load("conditions")["leash"]["formula"].replace(" ", "")
    if lf != "tau_dose_min=60*D_allow/Ddot_mGy_per_h":
        raise ValueError(f"conditions.yaml leash.formula changed: {lf}")
    out = []
    for d_allow in (0.25, 0.5, 1.0):
        for ugy_day in (226.0, 3000.0, 6000.0, 24000.0):
            rate = ugy_day / 1000.0 / 24.0
            out.append({"id": f"dose.{d_allow:g}mGy.{ugy_day:g}uGy_day",
                        "inputs": {"D_allow_mGy": d_allow, "Ddot_uGy_per_day": ugy_day},
                        "expected": {"Ddot_mGy_per_h": rate,
                                     "tau_dose_min": 60.0 * d_allow / rate}})  # fmt: skip
    return out


ROUTE_PLANE = 0.03  # dz/dy: the synthetic plane rises 3 % to the north
ROUTE_STATIONS = [("A", (40, 100), 0.6), ("B", (200, 60), 0.5), ("C", (130, 220), 0.9)]


def route_case() -> dict:
    """One short synthetic route: a 3 m plane rising 3 % to the north (241 x 241 cells, pad at
    the centre), three stations (dwell 30 min), nominal 104 kg, t_dark 578.6 min, static
    tau_dose 113.7 min, EVA budget. The planner's route, per-vertex series and timeline rows."""
    from .synthetic import make_grid, plane

    res, n = 3.0, 241
    pad = (120, 120)
    g = make_grid(plane(n, res, ROUTE_PLANE), res)
    p = physio.params("nominal", suit_kg=104)
    tab = physio.grade_table(p)
    home = dijkstra.return_field(g, tab, pad)
    st = [{"id": sid, "rc": rc, "value": val, "dwell_min": 30.0} for sid, rc, val in ROUTE_STATIONS]
    mi = margin.inputs(p, t_dark_min=578.6, tau_dose_min=113.7, eva=True)
    r = traverse.plan(g, tab, home, pad, st, margin.eva_budget_min(),
                      float(load("variants")["route"]["o2_checkpoint_min"]), mi)  # fmt: skip
    z0 = float(g.elev[pad])

    def xyz(cells):
        return [[(c - pad[1]) * res, (pad[0] - rr) * res, float(g.elev[rr, c]) - z0]
                for rr, c in np.asarray(cells).tolist()]  # fmt: skip

    def series(d):
        return {"vertices": xyz(d["cells"]), "tau_min": d["tau"], "o2_L": d["o2"],
                "t_home_min": d["t_home"], "o2_home_L": d["o2_home"]}  # fmt: skip

    legs = [{"from": d["from"], "to": d["to"], "t_start_min": d["t_start"],
             "o2_used_at_start_L": d["u_start"], **series(d)} for d in r.leg_paths]
    track_t, track_u, track_th, track_oh = (np.asarray(x) for x in r.track)
    tasks_rate = mi.dwell_rate_l_min
    dw = {}
    for e in r.timeline:
        if e["event"] == "arrive":
            dw[e["station"]] = e["t_min"]
    rows = []
    for e in r.timeline:
        ev = e["event"]
        if ev in ("depart", "return"):
            th, oh = 0.0, 0.0
        elif ev in ("arrive", "leave", "turn_back"):
            b = r.back_paths[e["station"]]
            th, oh = b["t_home"][0], b["o2_home"][0]
        else:  # o2_checkpoint: the track sample at or before t, O2 used interpolated
            j = int(np.searchsorted(track_t, e["t_min"], side="right") - 1)
            th, oh = track_th[j], track_oh[j]
        rows.append({"event": ev, "station": e["station"],
                     "inputs": {"t_min": e["t_min"], "o2_used_L": mi.o2_capacity_l - e["o2_left_L"],
                                "t_home_min": th, "o2_home_L": oh,
                                "tasks_left_L": e["o2_tasks_left_L"]},
                     "expected": {k: e[k] for k in ("t_min", "o2_left_L", "t_home_min",
                                                    "margin_min", "margin_binding",
                                                    "o2_tasks_left_L")
                                  if k in e}})  # fmt: skip
    return {
        "id": "route.synthetic_plane",
        "inputs": {"grid": {"res_m": res, "shape": [n, n], "plane": f"z = {ROUTE_PLANE} * y "
                            "(rises to the north)", "pad_rc": list(pad),
                            "moves": "16-neighbour (8 + knight), no corner cutting"},
                   "variant": "nominal", "suit_kg": 104, "margin_inputs": _mi_json(mi),
                   "eva_budget_min": margin.eva_budget_min(),
                   "o2_checkpoint_min": float(load("variants")["route"]["o2_checkpoint_min"]),
                   "task_rate_L_min": tasks_rate,
                   "stations": [{"id": s["id"], "xyz": xyz([s["rc"]])[0], "value": s["value"],
                                 "dwell_min": s["dwell_min"]} for s in st],
                   "legs": legs,
                   "way_home": {k: series(v) for k, v in r.back_paths.items()}},
        "expected": {"order": r.order, "total_min": r.total_min, "value": r.value,
                     "n_feasible_subsets": r.n_feasible_subsets, "margin_terms": r.margin_terms,
                     "timeline": rows},
        "notes": ["The planner plans with O2 used before each leg bounded at the effort-cap "
                  "rate (1.35 L/min x elapsed time; user 2026-11-14 17:28); timeline rows show "
                  "the modelled O2.",
                  "Timeline values are rounded to 0.01 as in the timeline contract.",
                  "o2_checkpoint rows: T_home / O2_home of the last track vertex at or before "
                  "t; O2 used linearly interpolated between vertices."],
    }  # fmt: skip


def build() -> dict:
    suits = [float(x) for x in load("crew")["suit_masses_kg"]]
    cases = {
        "physio": [physio_case(v, m, g) for v in VARIANTS for m in suits for g in GRADES_DEG],
        "o2_leg": [o2_leg_case(v, 104.0) for v in VARIANTS],
        "haul": [haul_case("cart", cas, g) for cas in ("suited", "bound")
                 for g in (-10.0, 0.0, 5.0, 10.0, 15.0, 20.0)]
        + [haul_case("drag", "suited", 0.0)],
        "haul_drag_finding": [{"id": "haul.drag_flat.104", "inputs": {"suit_kg": 104.0},
                               "expected": haul.drag_flat(104.0)}],
        "margin": margin_cases(),
        "turn_back": turn_back_cases(),
        "dose_leash": dose_cases(),
        "route": [route_case()],
    }  # fmt: skip
    return _r({
        "version": VERSION,
        "kind": "homeline_physio_golden",
        "decision": "D40 (user 2026-11-14 17:22): the simulator's C# port of the physiology, "
                    "margin and alarm logic must pass these cases",
        "generator": SCRIPT,
        "coords": {"frame": "pad-local metres", "origin": "pad", "x": "east", "y": "north",
                   "z": "up"},
        "units": {"t": "min", "o2": "L", "vo2": "mL/kg/min", "speed": "m/s", "grade": "deg",
                  "force": "N", "dose_rate": "mGy/h (inputs uGy/day)"},
        "conventions": [
            "segment grade = atan(dz / horizontal length); time = horizontal length / v*(grade)",
            "VO2 = V0 + (a(M) + k) v uphill/level; V0 + a(M) v clamp(f(i)/f(0)) downhill",
            "v* = min(v_safe(|grade|), (effort_cap VO2max - V0) / cost_slope)",
            "a segment is impassable when |grade| > the variant's nogo_deg (or v* = 0)",
            "margin = min(O2 term, daylight, dose, EVA duration); O2 term = (O2_left - O2_home "
            "- tasks_left - reserve) / effort rate; binding = the smallest term (ties: order "
            "O2, daylight, dose, EVA duration)",
            "turn-back = latest departure from the station with m >= 0 at every vertex of the "
            "way home, O2 rising at the task rate while waiting",
            "null where a number is not finite (unbounded latest departure, impassable segment)",
        ],
        "tolerances": TOL,
        "config": config_used(),
        "cases": cases,
    })


# ------------------------------------------------------------------ check


def _close(a, b, tol) -> bool:
    if a is None or b is None or isinstance(a, (bool, str)) or isinstance(b, (bool, str)):
        return a == b
    if isinstance(a, dict):
        return isinstance(b, dict) and a.keys() == b.keys() and all(
            _close(a[k], b[k], tol) for k in a)
    if isinstance(a, list):
        return isinstance(b, list) and len(a) == len(b) and all(
            _close(x, y, tol) for x, y in zip(a, b, strict=True))
    return abs(float(a) - float(b)) <= tol["abs"] + tol["rel"] * abs(float(b))


def check(doc: dict) -> list[str]:
    """Re-evaluate every case from its inputs with the Python reference; return failures."""
    fails: list[str] = []
    tol = doc["tolerances"]
    c = doc["cases"]

    def cmp(cid, got, exp, t):
        if not _close(_r(got), exp, t):
            fails.append(f"{cid}: got {_r(got)} expected {exp}")

    for k in c["physio"]:
        i = k["inputs"]
        cmp(k["id"], physio_case(i["variant"], i["suit_kg"], i["grade_deg"])["expected"],
            k["expected"], tol["physio"])
    for k in c["o2_leg"]:
        i = k["inputs"]
        cmp(k["id"], o2_leg_case(i["variant"], i["suit_kg"], i["vertices"])["expected"],
            k["expected"], tol["o2_leg"])
    for k in c["haul"]:
        cas = "suited" if k["id"].split(".")[2] == "suited" else "bound"
        cmp(k["id"], haul_case(k["inputs"]["case"], cas, k["inputs"]["grade_deg"],
                               k["inputs"]["rescuer_suit_kg"])["expected"], k["expected"],
            tol["haul"])
    for k in c["haul_drag_finding"]:
        cmp(k["id"], haul.drag_flat(k["inputs"]["suit_kg"]), k["expected"], tol["haul"])
    for k in c["margin"]:
        i = k["inputs"]
        mi = _mi_from(i["margin_inputs"])
        args = (i["t_min"], i["o2_used_L"], i["t_home_min"], i["o2_home_L"], i["tasks_left_L"])
        m, b = margin.margin(mi, *args)
        cmp(k["id"], {"terms_min": _terms(mi, *args), "margin_min": m, "binding": b,
                      "o2_left_L": mi.o2_capacity_l - i["o2_used_L"],
                      "o2_margin_min_planning_rate": margin.o2_margin_min(
                          mi, i["o2_used_L"], i["o2_home_L"], i["tasks_left_L"],
                          rate_l_min=mi.planning_rate_l_min)}, k["expected"], tol["margin"])
    for k in c["turn_back"]:
        i = k["inputs"]
        w = i["way_home"]
        terms = margin.latest_departure_terms(_mi_from(i["margin_inputs"]), i["arrive_t_min"],
                                              i["o2_used_at_arrival_L"],
                                              i["rate_while_waiting_L_min"], w["tau"], w["o2"],
                                              w["t_home"], w["o2_home"])
        b = min(terms, key=terms.get)
        cmp(k["id"], {"latest_departure_by_term_min": terms, "turn_back_min": terms[b],
                      "binding": b}, k["expected"], tol["turn_back"])
    for k in c["dose_leash"]:
        i = k["inputs"]
        rate = i["Ddot_uGy_per_day"] / 1000.0 / 24.0
        cmp(k["id"], {"Ddot_mGy_per_h": rate, "tau_dose_min": 60.0 * i["D_allow_mGy"] / rate},
            k["expected"], tol["dose_leash"])
    for k in c["route"]:
        fails += _check_route(k, tol)
    return fails  # fmt: skip


def _check_route(k: dict, tol: dict) -> list[str]:
    fails = []
    i = k["inputs"]
    p = physio.params(i["variant"], suit_kg=i["suit_kg"])
    mi = _mi_from(i["margin_inputs"])
    # 1. every leg's times and O2 from its vertices (analytic physio vs the router's table)
    for lg in i["legs"] + list(i["way_home"].values()):
        v = np.asarray(lg["vertices"], float)
        dh = np.hypot(*np.diff(v[:, :2], axis=0).T)
        th = np.arctan2(np.diff(v[:, 2]), dh)
        spd = np.asarray(physio.governor(p, th), float)
        t = np.concatenate([[0.0], np.cumsum(dh / spd / 60.0)])
        o2 = np.concatenate([[0.0], np.cumsum(physio.o2_litres(p, physio.vo2(p, spd, th),
                                                               dh / spd / 60.0))])
        for name, got, exp in (("tau_min", t, lg["tau_min"]), ("o2_L", o2, lg["o2_L"])):
            if not _close(_r(got.tolist()), exp, tol["route_segments"]):
                fails.append(f"{k['id']} {lg.get('from')}->{lg.get('to')} {name}")
    # 2. every timeline row's margin from its inputs (turn-back rows: margin 0 at the binding
    # term, checked through the latest departure on the station's way home)
    for row in k["expected"]["timeline"]:
        x = row["inputs"]
        if row["event"] == "turn_back":
            w = i["way_home"][row["station"]]
            arr = next(r for r in k["expected"]["timeline"] if r["event"] == "arrive"
                       and r["station"] == row["station"])  # fmt: skip
            terms = margin.latest_departure_terms(
                mi, arr["inputs"]["t_min"], arr["inputs"]["o2_used_L"], mi.dwell_rate_l_min,
                w["tau_min"], w["o2_L"], w["t_home_min"], w["o2_home_L"])
            b = min(terms, key=terms.get)
            got = {"t_min": terms[b], "margin_binding": b}
            exp = {"t_min": row["expected"]["t_min"],
                   "margin_binding": row["expected"]["margin_binding"]}
        else:
            m, b = margin.margin(mi, x["t_min"], x["o2_used_L"], x["t_home_min"], x["o2_home_L"],
                                 x["tasks_left_L"])
            got = {"margin_min": m, "margin_binding": b}
            exp = {"margin_min": row["expected"]["margin_min"],
                   "margin_binding": row["expected"]["margin_binding"]}
        if not _close(_r(got), exp, tol["route_rows"]):
            fails.append(f"{k['id']} row {row['event']} {row['station']} @ {x['t_min']}: "
                         f"got {_r(got)} expected {exp}")  # fmt: skip
    # 3. the planner reproduces the case (order, totals, rows)
    again = route_case()
    if _r(again["expected"]) != k["expected"]:
        fails.append(f"{k['id']}: planner output changed")
    return fails


def write(path: Path | None = None) -> Path:
    from .geo import write_json

    doc = build()
    fails = check(doc)
    if fails:
        raise SystemExit("golden self-check failed:\n" + "\n".join(fails[:20]))
    path = path or ENGINE_DIR / "public" / REL
    write_json(path, doc, None)
    provenance.record_file(REL, path, SCRIPT)
    provenance.record("physio.golden.version", VERSION, None, REL, SCRIPT)
    provenance.record("physio.golden.n_cases", sum(len(v) for v in doc["cases"].values()), "1",
                      REL, SCRIPT)  # fmt: skip
    return path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", type=Path, default=None, help="re-check an existing golden.json")
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args(argv)
    if a.check:
        fails = check(json.loads(a.check.read_text(encoding="utf-8")))
        print("\n".join(fails) if fails else f"{a.check}: all cases pass")
        return 1 if fails else 0
    p = write(a.out)
    doc = json.loads(p.read_text(encoding="utf-8"))
    print(f"wrote {p} ({p.stat().st_size / 1e3:.1f} kB): "
          f"{ {k: len(v) for k, v in doc['cases'].items()} }")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

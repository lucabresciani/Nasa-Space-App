"""D48: the physiology, margin and alarm core, stdlib + numpy only (no config, no I/O).

Everything here takes its numbers as arguments: ``Params`` (built from config by
``physio.params``), ``MarginInputs`` (built by ``margin.inputs``) and plain values. physio.py
and margin.py import these functions and add the config-reading builders, so the batch, the plan
server and any port share one reference. ``physio/golden.json`` (golden.py) pins the behaviour.

Formulas (angles in radians, i = tan(theta)); see physio.py for the config keys:

    a(M)     = a_anchor * a_mult + alpha * (M - anchor_carried_kg)
    k        = (m_b + M) g sin(theta) / (eta m_b) * 60 / j_per_ml      # theta > 0, else 0
    VO2      = V0 + (a(M) + k) v                                        # theta >= 0
    VO2      = V0 + a(M) v clamp(f(i) / f(0), lo, hi)                   # theta < 0
    v*       = min(v_safe(|theta|), (effort_cap VO2max - V0) / cost_slope)
    O2 [L]   = VO2 m_b dt / 1000                                        # dt in minutes
    heat [W] = VO2 m_b / 60 * j_per_ml

    margin   = min(O2 term, t_dark - t - T_home, tau_dose(t) - T_home, EVA_budget - t - T_home)
    O2 term  = (O2_left - O2_home - O2_tasks_left - O2_reserve) / effort_rate

Alarm rules (SPEC F18, first match wins; mirrors web/src/hud/alarms.ts): 1 margin < 0 red
"TURN BACK NOW"; 2 tripwire fired and T_home >= tau_dose red "RADIATION: HEAD HOME"; 3 the
uncertainty circle crosses the homeline amber "POSITION UNCERTAIN: HEAD TOWARD ROVER"; 4 margin <
margin_amber_min (config/hud.yaml) amber "TURN-BACK IN N MIN"; 5 outside the partner line info
"Beyond partner-haul range". Unknown inputs (None) never fire a rule.

The only literals are unit conversions (60 s/min, 60 min/h, 1000 mL/L, 1000 uGy/mGy, 24 h/day).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SEC_PER_MIN = 60.0
ML_PER_L = 1000.0

# ------------------------------------------------------------------ walker


@dataclass(frozen=True)
class Params:
    variant: str
    eta: float
    V0: float
    a_mult: float
    nogo_deg: float
    m_b: float  # body mass, kg
    carried_kg: float  # M = suit + tools, kg
    g: float
    vo2max: float
    effort_cap: float
    anchor_vo2: float
    anchor_speed: float
    anchor_carried_kg: float
    alpha: float
    j_per_ml: float
    vsafe_max_deg: tuple[float, ...]
    vsafe_v: tuple[float, ...]
    minetti_coef: tuple[float, ...]  # c5..c0 of f(i)
    downhill_clamp: tuple[float, float]  # (lo, hi) of clamp(f(i) / f(0))

    @property
    def a_anchor(self) -> float:
        return (self.anchor_vo2 - self.V0) / self.anchor_speed

    @property
    def cap(self) -> float:
        """Effort-capped VO2, mL/kg/min."""
        return self.effort_cap * self.vo2max


def minetti_f(i, coef):
    """Minetti 2002 cost-of-transport shape f(i) with coefficients c5..c0 (shape only here)."""
    return np.polyval(coef, i)


def downhill_mult(i, coef, clamp):
    """clamp(f(i) / f(0), lo, hi) for i = tan(theta) < 0."""
    lo, hi = clamp
    return np.clip(minetti_f(i, coef) / minetti_f(0.0, coef), lo, hi)


def a_of_m(p: Params, m: float | None = None) -> float:
    """Level cost slope a(M), mL/kg/min per m/s."""
    m = p.carried_kg if m is None else m
    return p.a_anchor * p.a_mult + p.alpha * (m - p.anchor_carried_kg)


def k_uphill(p: Params, theta):
    """Uphill term k(theta, M), mL/kg/min per m/s; 0 for theta <= 0."""
    th = np.asarray(theta, dtype=float)
    k = (p.m_b + p.carried_kg) * p.g * np.sin(th) / (p.eta * p.m_b) * SEC_PER_MIN / p.j_per_ml
    out = np.where(th > 0, k, 0.0)
    return out if out.ndim else float(out)


def cost_slope(p: Params, theta):
    """d VO2 / d v at grade theta: a + k uphill, a * clamp(f/f0) downhill."""
    th = np.asarray(theta, dtype=float)
    a = a_of_m(p)
    dm = downhill_mult(np.tan(np.minimum(th, 0.0)), p.minetti_coef, p.downhill_clamp)
    out = np.where(th >= 0, a + k_uphill(p, th), a * dm)
    return out if out.ndim else float(out)


def vo2(p: Params, v, theta):
    """Oxygen uptake, mL/kg/min, at speed v (m/s) and grade angle theta (rad)."""
    out = p.V0 + cost_slope(p, theta) * np.asarray(v, dtype=float)
    return out if np.ndim(out) else float(out)


def v_safe(p: Params, theta):
    """Safety speed from the crew v_safe table by |theta|; 0 beyond the last row."""
    deg = np.abs(np.degrees(np.asarray(theta, dtype=float)))
    out = np.zeros_like(deg)
    for max_deg, v in zip(reversed(p.vsafe_max_deg), reversed(p.vsafe_v), strict=True):
        out = np.where(deg <= max_deg, v, out)
    return out if out.ndim else float(out)


def governor(p: Params, theta):
    """Governed speed v* (m/s) = min(v_safe, (cap - V0) / cost_slope)."""
    vs = v_safe(p, theta)
    v_cap = max(p.cap - p.V0, 0.0) / cost_slope(p, theta)
    out = np.minimum(vs, v_cap)
    return out if np.ndim(out) else float(out)


def o2_litres(p: Params, vo2_ml_kg_min, minutes):
    """O2 = VO2 * m_b * dt / 1000 (litres) for a constant VO2 over `minutes`."""
    return np.asarray(vo2_ml_kg_min) * p.m_b * np.asarray(minutes) / ML_PER_L


def heat_w(p: Params, vo2_ml_kg_min):
    """Metabolic heat (W) = VO2 * m_b / 60 * j_per_ml."""
    return np.asarray(vo2_ml_kg_min) * p.m_b / SEC_PER_MIN * p.j_per_ml


def effort_rate_l_min(p: Params) -> float:
    """O2 rate at the effort cap: effort_cap * VO2max * m_b / 1000 (L/min)."""
    return p.cap * p.m_b / ML_PER_L


def step(p: Params, theta, length_m):
    """One walked segment of horizontal length_m at grade theta: (v* m/s, minutes, O2 L, heat W);
    minutes and O2 are inf where impassable (|theta| > nogo_deg or v* = 0)."""
    th = np.asarray(theta, dtype=float)
    v = np.asarray(governor(p, th), dtype=float)
    ok = (np.abs(np.degrees(th)) <= p.nogo_deg + 1e-9) & (v > 0)
    vv = np.where(ok, v, 1.0)
    t = np.where(ok, np.asarray(length_m, dtype=float) / vv / SEC_PER_MIN, np.inf)
    q = vo2(p, vv, th)
    o2 = np.where(ok, o2_litres(p, q, np.where(ok, t, 0.0)), np.inf)
    out = (v, t, o2, np.asarray(heat_w(p, q)))
    return tuple(x if np.ndim(x) else float(x) for x in out)


# ------------------------------------------------------------------ router lookup table


@dataclass(frozen=True)
class GradeTable:
    """Per-metre time and O2 as a function of edge grade angle, for the router kernels.

    theta_deg is uniform from -90 to 90 deg; pace is inf where impassable
    (|theta| > nogo_deg or v* = 0). Kernels interpolate linearly.
    """

    theta_deg: np.ndarray
    pace_s_per_m: np.ndarray
    o2_l_per_m: np.ndarray
    step_deg: float


def grade_table(p: Params, step_deg: float) -> GradeTable:
    n = int(round(180.0 / step_deg)) + 1
    deg = np.linspace(-90.0, 90.0, n)
    th = np.radians(deg)
    v = governor(p, th)
    ok = (np.abs(deg) <= p.nogo_deg + 1e-9) & (v > 0)
    vv = np.where(ok, v, 1.0)
    pace = np.where(ok, 1.0 / vv, np.inf)
    o2 = np.where(ok, o2_litres(p, vo2(p, vv, th), 1.0 / vv / SEC_PER_MIN), np.inf)
    return GradeTable(deg, pace, o2, 180.0 / (n - 1))


# ------------------------------------------------------------------ margin

EVA = "EVA duration"  # D28 binding term name


@dataclass(frozen=True)
class DoseTiming:
    """Timed dose leash (D39). ``eva_min`` / ``rate_mgy_h``: the storm series (valid samples,
    sample midpoints) on the EVA clock; tau_dose(t) = 60 D_allow / Ddot(t), Ddot linear between
    sample midpoints (WS4 rad.json method), clamped to the first/last sample outside the series."""

    t_star_min: float  # EVA minute where the tripwire fires (route max T_home)
    eva_min: np.ndarray
    rate_mgy_h: np.ndarray
    d_allow_mgy: float
    tripwire_offset_min: float  # tripwire_utc - series time origin, for the record
    source: str = ""

    def rate(self, t_min):
        return np.interp(t_min, self.eva_min, self.rate_mgy_h)

    def tau_min(self, t_min):
        r = self.rate(t_min)
        return 60.0 * self.d_allow_mgy / r


def tau_dose_min(d_allow_mgy: float, rate_mgy_h):
    """Dose leash tau_dose = 60 D_allow / Ddot (min), Ddot in mGy/h."""
    return 60.0 * d_allow_mgy / np.asarray(rate_mgy_h, dtype=float)


@dataclass(frozen=True)
class MarginInputs:
    o2_capacity_l: float
    reserve_l: float  # fixed O2 reserve, L
    o2_rate_l_min: float  # converts the O2 term to minutes (effort cap)
    dwell_rate_l_min: float  # O2 use while working at a station
    planning_rate_l_min: float | None = None  # optional second O2 display rate
    reserve_frac: float = 0.0  # legacy (1 + r) factor; 0 in the current formula
    t_dark_min: float | None = None
    tau_dose_min: float | None = None  # static dose leash (used when dose_timing is None)
    eva_budget_min: float | None = None  # D28: EVA budget (crew.eva_h x 60)
    dose_timing: DoseTiming | None = None  # D39: timed dose leash (replaces tau_dose_min)

    @property
    def terms(self) -> list[str]:
        out = ["O2"]
        if self.t_dark_min is not None:
            out.append("daylight")
        if self.dose_timing is not None or self.tau_dose_min is not None:
            out.append("dose")
        if self.eva_budget_min is not None:
            out.append(EVA)
        return out

    def tau_dose_at(self, t_min):
        """Dose leash (min) at EVA minute(s) t: timed if dose_timing, else static, else None."""
        if self.dose_timing is not None:
            return self.dose_timing.tau_min(t_min)
        if self.tau_dose_min is not None:
            return np.full(np.shape(t_min), float(self.tau_dose_min)) if np.ndim(t_min) else \
                float(self.tau_dose_min)
        return None


def o2_slack_l(mi: MarginInputs, o2_used_l, o2_home_l, tasks_l=0.0):
    """O2_left - O2_return_route - O2_station_tasks - O2_reserve (L)."""
    return (mi.o2_capacity_l - o2_used_l - (1 + mi.reserve_frac) * o2_home_l - tasks_l
            - mi.reserve_l)  # fmt: skip


def o2_margin_min(mi: MarginInputs, o2_used_l, o2_home_l, tasks_l=0.0,
                  rate_l_min: float | None = None) -> float:  # fmt: skip
    """O2 term in minutes at ``rate_l_min`` (default: the effort cap)."""
    rate = mi.o2_rate_l_min if rate_l_min is None else rate_l_min
    return float(o2_slack_l(mi, o2_used_l, o2_home_l, tasks_l) / rate)


def margin(mi: MarginInputs, t_min, o2_used_l, t_home_min, o2_home_l, tasks_l=0.0):
    """(margin_min, binding) at absolute EVA time t with o2_used so far, at a point whose walk
    home takes t_home / o2_home, with tasks_l of station work still to do there. Scalars.
    Ties: the first term in the order O2, daylight, dose, EVA duration binds."""
    terms = {"O2": o2_margin_min(mi, o2_used_l, o2_home_l, tasks_l)}
    if mi.t_dark_min is not None:
        terms["daylight"] = mi.t_dark_min - t_min - t_home_min
    tau = mi.tau_dose_at(t_min)
    if tau is not None:
        terms["dose"] = float(tau) - t_home_min
    if mi.eva_budget_min is not None:
        terms[EVA] = mi.eva_budget_min - t_min - t_home_min
    binding = min(terms, key=terms.get)
    return float(terms[binding]), binding


def latest_departure(mi: MarginInputs, t0: float, u0: float, rate: float, tau_v, o2path_v,
                     t_home_v, o2_home_v) -> float:  # fmt: skip
    """Latest departure time t >= t0 on a leg so that m >= 0 at every sampled vertex v
    (min over ``latest_departure_terms``). Returns -inf if no departure time works."""
    terms = latest_departure_terms(mi, t0, u0, rate, tau_v, o2path_v, t_home_v, o2_home_v)
    return min(terms.values())


def latest_departure_terms(mi: MarginInputs, t0: float, u0: float, rate: float, tau_v, o2path_v,
                           t_home_v, o2_home_v, dose_step_min: float = 0.05,
                           ) -> dict[str, float]:  # fmt: skip
    """{term: latest departure} on a leg (m >= 0 at every vertex v), per margin term.

    O2 used at departure is u0 + rate (t - t0) (rate >= 0); at vertex v it adds o2path_v; the
    walker reaches v at t + tau_v. O2, daylight, EVA duration and the static dose term are
    non-increasing in t, so each feasible set is (-inf, latest]. The timed dose term (D39) is not
    monotone: its value is the first departure time t >= t0 (scanned in dose_step_min steps up
    to the other terms' latest) at which tau_dose(t + tau_v) - T_home(v) < 0 at some vertex, minus
    one step; inf if it never fails in that range, -inf if it already fails at t0.
    """
    tau_v, o2path_v = np.asarray(tau_v, float), np.asarray(o2path_v, float)
    t_home_v, o2_home_v = np.asarray(t_home_v, float), np.asarray(o2_home_v, float)
    if not (np.all(np.isfinite(t_home_v)) and np.all(np.isfinite(o2_home_v))):
        return {"O2": -np.inf}
    slack = o2_slack_l(mi, u0 + o2path_v, o2_home_v)
    out: dict[str, float] = {}
    if rate > 0:
        out["O2"] = t0 + float(np.min(slack)) / rate
    else:
        out["O2"] = np.inf if np.min(slack) >= 0 else -np.inf
    if mi.t_dark_min is not None:
        out["daylight"] = float(np.min(mi.t_dark_min - tau_v - t_home_v))
    if mi.eva_budget_min is not None:
        out[EVA] = float(np.min(mi.eva_budget_min - tau_v - t_home_v))
    if mi.dose_timing is None and mi.tau_dose_min is not None:
        out["dose"] = np.inf if np.max(t_home_v) <= mi.tau_dose_min else -np.inf
    elif mi.dose_timing is not None:
        hi = min(out.values())
        out["dose"] = _dose_latest(mi.dose_timing, t0, hi, tau_v, t_home_v, dose_step_min)
    return out


def _dose_latest(dt: DoseTiming, t0: float, hi: float, tau_v, t_home_v, step: float) -> float:
    if not np.isfinite(hi):
        hi = t0 + 24 * 60.0
    if hi < t0:
        hi = t0
    ts = np.arange(t0, hi + step, step)
    for k in range(0, len(ts), 256):  # chunks keep memory small
        tt = ts[k: k + 256]
        bad = np.any(dt.tau_min(tt[:, None] + tau_v[None, :]) - t_home_v[None, :] < 0, axis=1)
        if bad.any():
            j = k + int(np.argmax(bad))
            return -np.inf if j == 0 else float(ts[j - 1])
    return np.inf


def t_star(track_t, track_t_home) -> float:
    """D39 anchor: EVA minute of the route's largest T_home (first sample on a tie,
    conditions.yaml storm_replay.tie_break 'first')."""
    th = np.asarray(track_t_home, float)
    return float(np.asarray(track_t, float)[int(np.argmax(th))])


def dose_timing_from_ws4(t_star_min: float, rad: dict, storm_replay: dict) -> DoseTiming:
    """DoseTiming from WS4's rad.json (storm_2024.series at sample midpoints, tripwire_utc,
    leash.D_allow_mGy) and conditions.yaml storm_replay (D39). The series is shifted so the
    tripwire fires at EVA minute t*: eva_min(utc) = t* + (utc - tripwire_utc) / 1 min.
    Null samples are dropped (linear between valid midpoints)."""
    from datetime import datetime

    if storm_replay.get("tripwire_at") != "route_max_t_home":
        raise ValueError(f"storm_replay.tripwire_at {storm_replay.get('tripwire_at')!r} "
                         "not implemented (route_max_t_home only)")  # fmt: skip
    if storm_replay.get("anchor_event", "tripwire") != "tripwire":
        raise ValueError("storm_replay.anchor_event must be 'tripwire'")
    if storm_replay.get("tie_break", "first") != "first":
        raise ValueError("storm_replay.tie_break must be 'first'")

    def ts(u):
        return datetime.fromisoformat(u.replace("Z", "+00:00")).timestamp()

    st = rad["storm_2024"]
    trip = ts(st["tripwire_utc"])
    rows = [(ts(u), float(v)) for u, v in st["series"] if v is not None]
    eva = np.array([t_star_min + (t - trip) / 60.0 for t, _ in rows])
    rate = np.array([v / 1000.0 / 24.0 for _, v in rows])  # uGy/day -> mGy/h
    return DoseTiming(t_star_min=float(t_star_min), eva_min=eva, rate_mgy_h=rate,
                      d_allow_mgy=float(rad["leash"]["D_allow_mGy"]),
                      tripwire_offset_min=float((trip - rows[0][0]) / 60.0),
                      source="conditions.yaml storm_replay (D39) + rad.json")  # fmt: skip


# ------------------------------------------------------------------ alarms (SPEC F18)

ALARM_TEXT = {
    1: "TURN BACK NOW",
    2: "RADIATION: HEAD HOME",
    3: "POSITION UNCERTAIN: HEAD TOWARD ROVER",
    5: "Beyond partner-haul range",
}
ALARM_LEVEL = {1: "red", 2: "red", 3: "amber", 4: "amber", 5: "info"}


def turn_back_text(margin_min: float) -> str:
    """"TURN-BACK IN N MIN": N rounded down so the HUD never overstates the time left."""
    return f"TURN-BACK IN {max(0, int(np.floor(margin_min)))} MIN"


def evaluate_alarm(margin_amber_min: float, *, margin_min: float | None,
                   tripwire_fired: bool = False, t_home_min: float | None = None,
                   tau_dose_min: float | None = None, circle_crosses_homeline: bool = False,
                   outside_partner: bool | None = None) -> dict | None:  # fmt: skip
    """The first alarm rule that fires ({rule, level, text}) or None. Unknown inputs (None)
    never fire a rule."""
    rule, text = None, None
    if margin_min is not None and margin_min < 0:
        rule = 1
    elif tripwire_fired and t_home_min is not None and tau_dose_min is not None \
            and t_home_min >= tau_dose_min:  # fmt: skip
        rule = 2
    elif circle_crosses_homeline:
        rule = 3
    elif margin_min is not None and margin_min < margin_amber_min:
        rule, text = 4, turn_back_text(margin_min)
    elif outside_partner is True:
        rule = 5
    if rule is None:
        return None
    return {"rule": rule, "level": ALARM_LEVEL[rule], "text": text or ALARM_TEXT[rule]}


def margin_band(margin_min: float | None, margin_amber_min: float) -> str:
    """Band colour while playing (F18): green above the amber threshold, amber 0..threshold,
    red < 0, unknown when the margin is unknown."""
    if margin_min is None:
        return "unknown"
    if margin_min < 0:
        return "red"
    if margin_min <= margin_amber_min:
        return "amber"
    return "green"

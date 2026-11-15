"""Route margin (SPEC F4, F9; O2 term per S review 2026-11-14, crew.yaml o2_margin):

    m(t) = min( O2 term ,  t_dark - t - T_home ,  tau_dose(t) - T_home ,  EVA_budget - t - T_home )
    O2 term = (O2_left - O2_return_route - O2_station_tasks - O2_reserve) / effort_rate

* All O2 quantities in litres; the O2 term is converted to "minutes at maximum effort" at the
  effort-capped rate (effort_cap * VO2max * m_b / 1000 = 1.35 L/min).
* O2_left = crew.o2_budget[margin_uses] - O2 used so far. O2 used includes the walking and the
  station work at the task rate (1,000 BTU/hr at 21.0 J/mL = 0.837 L/min, D29), which replaces
  the resting V0. Every BTU/h -> O2 conversion uses crew.o2_energy_j_per_ml = 21.0 (D29).
* O2_return_route = O2_home(x) from the return field (no (1 + r) factor any more).
* O2_station_tasks = task O2 still to do at the station the crew is working at (0 while
  walking). Confirmed (decision log 2026-11-14 15:40).
* O2_reserve = reserve_min_at_effort_cap x effort rate = 30 x 1.35 = 40.5 L, derived (D24,
  "30 min at the effort cap (EMU precedent)"). crew.o2_reserve_frac (r) is NOT used.
* EVA duration (D28, user 16:20): EVA_budget - t - T_home with EVA_budget = crew.eva_h x 60.
* t_dark (min since EVA start) comes from WS4. The dose term (D39) is either static
  (tau_dose - T_home, a CLI value or the storm peak) or timed (``DoseTiming``): the 20 May 2024
  RAD storm series is shifted onto the EVA clock so its tripwire fires at the route minute t*
  where T_home is largest (conditions.yaml storm_replay), and tau_dose(t) = 60 D_allow /
  Ddot(t). A term that is missing is left out and ``terms`` says which were used.

Binding term names: "O2" | "daylight" | "dose" | "EVA duration" (D28).
"""

from __future__ import annotations

from . import physio_core as core
from .config import load
from .physio import ML_PER_L, SEC_PER_MIN, Params
from .physio_core import (  # noqa: F401  (re-exported: the engine's margin API, D48 core)
    EVA,
    DoseTiming,
    MarginInputs,
    _dose_latest,
    dose_timing_from_ws4,
    latest_departure,
    latest_departure_terms,
    margin,
    o2_margin_min,
    o2_slack_l,
    t_star,
)

_BUDGET_KEYS = {"primary_L": ("primary_design_eva_h", "primary_design_rate_btu_h"),
                "secondary_L": ("secondary_eva_h", "secondary_design_rate_btu_h")}


def _check(text: str, expected: str, key: str) -> None:
    if text.replace(" ", "") != expected.replace(" ", ""):
        raise ValueError(f"crew.yaml {key} changed: {text!r}; update margin.py")


def o2_budget_l(which: str = "primary_L") -> float:
    """crew.yaml o2_budget computed from config (D29, user 16:20): O2_L = hours x rate_btu_h x
    j_per_btu / o2_energy_j_per_ml / 1000. Primary: 8 h x 1,200 BTU/h = 482.31 L; secondary:
    1 h x 3,000 BTU/h = 150.72 L."""
    b = load("crew")["o2_budget"]
    _check(b["formula"], "O2_L = hours * rate_btu_h * j_per_btu / o2_energy_j_per_ml / 1000",
           "o2_budget.formula")  # fmt: skip
    h_key, r_key = _BUDGET_KEYS[which]
    return float(b[h_key]) * btu_h_to_l_min(float(b[r_key])) * 60.0


def o2_capacity_l() -> float:
    """O2 planned against (crew.o2_budget.margin_uses = primary_L), computed from config."""
    return o2_budget_l(load("crew")["o2_budget"]["margin_uses"])


def j_per_ml() -> float:
    """The one O2 energy equivalent (D29): crew.o2_energy_j_per_ml = 21.0 J per mL O2."""
    return float(load("crew")["o2_energy_j_per_ml"])


def btu_h_to_l_min(btu_h: float) -> float:
    """Metabolic rate (BTU/hr) -> O2 uptake (L/min) at o2_energy_j_per_ml (D29)."""
    jpb = float(load("crew")["o2_budget"]["j_per_btu"])
    return float(btu_h) * jpb / SEC_PER_MIN / j_per_ml() / ML_PER_L


def station_task_rate_l_min() -> float:
    """Station work O2 rate (L/min), derived from station_task_rate_btu_h (D29): 0.8373."""
    om = load("crew")["o2_margin"]
    _check(om["station_task_rate_formula"], "station_task_rate_btu_h * o2_budget.j_per_btu / "
           "60 / o2_energy_j_per_ml / 1000", "o2_margin.station_task_rate_formula")  # fmt: skip
    return btu_h_to_l_min(float(om["station_task_rate_btu_h"]))


def reserve_l(p: Params) -> float:
    """O2 reserve (D24): reserve_min_at_effort_cap x effort rate = 30 x 1.35 = 40.5 L."""
    om = load("crew")["o2_margin"]
    _check(om["reserve_L"], "reserve_min_at_effort_cap * effort_rate_L_min", "o2_margin.reserve_L")
    return float(om["reserve_min_at_effort_cap"]) * effort_rate_l_min(p)


def reserve_label() -> str:
    return str(load("crew")["o2_margin"]["reserve_label"])


def eva_budget_min() -> float:
    """D28 EVA budget: crew.eva_h x 60 (variants.yaml route.eva_term)."""
    _check(load("variants")["route"]["eva_term"], "crew.eva_h * 60 - t - T_home",
           "variants.route.eva_term")  # fmt: skip
    return float(load("crew")["eva_h"]) * 60.0


def effort_rate_l_min(p: Params) -> float:
    om = load("crew")["o2_margin"]
    if om["effort_rate_L_min"].replace(" ", "") != (
            "effort_cap_frac*vo2max_ml_kg_min*body_mass_kg/1000"):  # fmt: skip
        raise ValueError(f"cannot parse o2_margin.effort_rate_L_min {om['effort_rate_L_min']!r}")
    return core.effort_rate_l_min(p)


def inputs(p: Params, t_dark_min: float | None = None, tau_dose_min: float | None = None,
           eva: bool = True, dose_timing: DoseTiming | None = None) -> MarginInputs:  # fmt: skip
    """Margin inputs from config (crew.yaml o2_margin) for the walker p (variant + suit).
    eva: include the D28 EVA-duration term. dose_timing (D39) replaces the static tau_dose."""
    if load("variants")["route"]["o2_margin"] != "crew.o2_margin":
        raise ValueError("variants.route.o2_margin must point at crew.o2_margin")
    om = load("crew")["o2_margin"]
    rate = effort_rate_l_min(p)
    return MarginInputs(
        o2_capacity_l=o2_capacity_l(),
        reserve_l=reserve_l(p),
        o2_rate_l_min=rate,
        dwell_rate_l_min=station_task_rate_l_min(),
        planning_rate_l_min=btu_h_to_l_min(om["planning_rate_btu_h"]),
        t_dark_min=t_dark_min,
        tau_dose_min=None if dose_timing is not None else tau_dose_min,
        eva_budget_min=eva_budget_min() if eva else None,
        dose_timing=dose_timing,
    )


def legacy_inputs(p: Params, t_dark_min: float | None = None,
                  tau_dose_min: float | None = None) -> MarginInputs:  # fmt: skip
    """Session-1 formula (O2_left - (1 + r) O2_home) / 1.35 with dwell at V0. ONLY for the
    before/after comparison S asked for; never used for a product."""
    rate = effort_rate_l_min(p)
    return MarginInputs(o2_capacity_l=o2_capacity_l(), reserve_l=0.0, o2_rate_l_min=rate,
                        dwell_rate_l_min=p.V0 * p.m_b / ML_PER_L, planning_rate_l_min=None,
                        reserve_frac=float(load("crew")["o2_reserve_frac"]),
                        t_dark_min=t_dark_min, tau_dose_min=tau_dose_min)  # fmt: skip

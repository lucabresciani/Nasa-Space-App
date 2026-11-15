"""Route margin m(t) (SPEC F4, F9; O2 term per S review 2026-11-14) known answers by hand."""

import math

import numpy as np
import pytest

from pipeline.engine import margin, physio
from pipeline.engine.config import load

CREW = load("crew")
OM = CREW["o2_margin"]
P = physio.params("nominal", suit_kg=104)
RES = 30 * 1.35  # D24 reserve: 30 min at the effort cap = 40.5 L
# O2 budget (D29, user 16:20): 8 h x 1,200 BTU/h x 1055.056 J/BTU / 21.0 J/mL / 1000 = 482.31 L
CAP = 8 * 1200 * 1055.056 / 21.0 / 1000
TASK = 1000 * 1055.056 / 60 / 21.0 / 1000  # station task rate, 0.8373 L/min (D29)


def test_inputs_from_config():
    mi = margin.inputs(P)
    assert mi.o2_capacity_l == pytest.approx(CAP, rel=1e-12)  # margin_uses: primary_L
    assert round(mi.o2_capacity_l) == CREW["o2_budget"]["primary_L"] == 482
    cap = CREW["effort_cap_frac"] * CREW["vo2max_ml_kg_min"]
    assert mi.o2_rate_l_min == pytest.approx(cap * CREW["body_mass_kg"] / 1000)  # 1.35 L/min
    assert mi.o2_rate_l_min == pytest.approx(1.35)
    assert mi.reserve_l == pytest.approx(RES)
    assert mi.reserve_frac == 0.0  # r is replaced by the fixed reserve, never both
    assert mi.dwell_rate_l_min == pytest.approx(TASK)
    assert round(mi.dwell_rate_l_min, 2) == OM["station_task_rate_L_min"] == 0.84
    assert mi.terms == ["O2", "EVA duration"]  # D28: the EVA term is always on
    assert margin.inputs(P, eva=False).terms == ["O2"]


def test_d24_reserve_derived_and_labelled():
    assert margin.reserve_l(P) == pytest.approx(40.5)
    assert margin.reserve_label() == "30 min at the effort cap (EMU precedent)"


def test_d29_one_energy_equivalent():
    """D29: 21.0 J/mL for k, heat, haul and every BTU/h -> O2 conversion."""
    assert CREW["o2_energy_j_per_ml"] == 21.0 == margin.j_per_ml()
    assert P.j_per_ml == 21.0
    assert margin.btu_h_to_l_min(1000) == pytest.approx(TASK)
    assert margin.o2_budget_l("primary_L") == pytest.approx(482.31, abs=0.01)
    assert margin.o2_budget_l("secondary_L") == pytest.approx(150.72, abs=0.01)
    assert round(margin.o2_budget_l("secondary_L")) == CREW["o2_budget"]["secondary_L"]
    assert margin.inputs(P).planning_rate_l_min == pytest.approx(1200 * 1055.056 / 60 / 21000)


def test_margin_o2_term_by_hand():
    mi = margin.inputs(P, eva=False)
    # used 100 L, walk home costs 20 L: (481.99 - 100 - 20 - 40.5) / 1.35 = 237.84 min
    m, b = margin.margin(mi, 120.0, 100.0, 15.0, 20.0)
    assert b == "O2"
    assert m == pytest.approx((CAP - 100 - 20 - RES) / 1.35)
    # 15 min of station tasks still to do
    m2, _ = margin.margin(mi, 120.0, 100.0, 15.0, 20.0, tasks_l=15 * TASK)
    assert m2 == pytest.approx((CAP - 100 - 20 - 15 * TASK - RES) / 1.35)
    # same O2 slack at the 1,200 BTU/hr planning rate
    assert margin.o2_margin_min(mi, 100.0, 20.0, rate_l_min=mi.planning_rate_l_min) == (
        pytest.approx((CAP - 100 - 20 - RES) / mi.planning_rate_l_min))


def test_legacy_inputs_reproduce_session1_formula():
    """For the before/after comparison only: (O2_left - 1.2 O2_home) / 1.35, dwell at V0."""
    old = margin.legacy_inputs(P)
    m, _ = margin.margin(old, 120.0, 100.0, 15.0, 20.0)
    assert m == pytest.approx((CAP - 100 - 1.2 * 20) / 1.35)
    assert old.dwell_rate_l_min == pytest.approx(6 * 75 / 1000) and old.reserve_l == 0.0


def test_margin_daylight_and_dose_bind():
    mi = margin.inputs(P, t_dark_min=200.0, tau_dose_min=500.0)
    m, b = margin.margin(mi, 150.0, 50.0, 30.0, 40.0)
    assert (m, b) == (pytest.approx(20.0), "daylight")  # 200 - 150 - 30
    mi = margin.inputs(P, t_dark_min=1e4, tau_dose_min=25.0)
    m, b = margin.margin(mi, 150.0, 50.0, 30.0, 40.0)
    assert (m, b) == (pytest.approx(-5.0), "dose")
    assert mi.terms == ["O2", "daylight", "dose", "EVA duration"]


def test_d28_eva_duration_binds():
    """EVA budget 390 min: at t = 350 with T_home 30 the EVA term is 10 min."""
    mi = margin.inputs(P, t_dark_min=1e4)
    m, b = margin.margin(mi, 350.0, 50.0, 30.0, 40.0)
    assert (m, b) == (pytest.approx(10.0), "EVA duration")


def test_d28_turn_back_is_min_over_terms_incl_eva():
    """Home leg of 3 vertices (T_home 20 -> 0): EVA latest = 390 - 20 = 370 < daylight 380."""
    mi = margin.inputs(P, t_dark_min=400.0)
    tau = np.array([0.0, 10.0, 20.0])
    th = np.array([20.0, 10.0, 0.0])
    o2p = np.array([0.0, 1.0, 2.0])
    oh = np.array([2.0, 1.0, 0.0])
    terms = margin.latest_departure_terms(mi, 100.0, 50.0, TASK, tau, o2p, th, oh)
    assert terms["EVA duration"] == pytest.approx(370.0)
    assert terms["daylight"] == pytest.approx(380.0)
    assert terms["O2"] == pytest.approx(100.0 + (CAP - 50 - 2 - RES) / TASK)
    assert min(terms, key=terms.get) == "EVA duration"
    assert margin.latest_departure(mi, 100.0, 50.0, TASK, tau, o2p, th, oh) == pytest.approx(370)


def _timing(t_star):
    """Synthetic storm: 1 mGy/h baseline ... a 6 mGy/h step 10 min after the tripwire."""
    rad = {"storm_2024": {"tripwire_utc": "2024-05-20T06:00:00Z", "series": [
        ["2024-05-20T05:00:00Z", 24000.0], ["2024-05-20T06:00:00Z", 24000.0],
        ["2024-05-20T06:10:00Z", 144000.0], ["2024-05-20T06:20:00Z", None],
        ["2024-05-20T08:00:00Z", 144000.0]]}, "leash": {"D_allow_mGy": 0.5}}
    sr = {"tripwire_at": "route_max_t_home", "anchor_event": "tripwire", "tie_break": "first"}
    return margin.dose_timing_from_ws4(t_star, rad, sr)


def test_d39_dose_timing_by_hand():
    dt = _timing(100.0)
    # 24,000 uGy/day = 1 mGy/h -> tau = 60 * 0.5 / 1 = 30 min; 6 mGy/h -> 5 min
    assert dt.tau_min(100.0) == pytest.approx(30.0)  # tripwire at t* = 100
    assert dt.tau_min(40.0) == pytest.approx(30.0)  # one hour before
    assert dt.tau_min(110.0) == pytest.approx(5.0)  # 10 min after the tripwire
    assert dt.tau_min(105.0) == pytest.approx(60 * 0.5 / 3.5)  # linear rate between midpoints
    assert dt.tau_min(130.0) == pytest.approx(5.0)  # the null sample is skipped
    assert margin.t_star([0, 10, 20, 30], [0, 25, 25, 5]) == 10  # first maximum
    mi = margin.inputs(P, dose_timing=dt, tau_dose_min=999.0)  # the timed term replaces tau
    assert mi.tau_dose_min is None and "dose" in mi.terms
    m, b = margin.margin(mi, 110.0, 0.0, 3.0, 1.0)
    assert (m, b) == (pytest.approx(2.0), "dose")  # 5 - 3


def test_d39_timed_dose_latest_departure():
    dt = _timing(100.0)
    mi = margin.inputs(P, dose_timing=dt, eva=False)
    # one vertex with T_home 10: tau(t) - 10 < 0 once tau < 10, i.e. rate > 3 mGy/h:
    # rate = 1 + 5 (t - 100) / 10 > 3 -> t > 104
    t = margin.latest_departure_terms(mi, 50.0, 0.0, 0.0, [0.0], [0.0], [10.0], [0.0],
                                      dose_step_min=0.01)["dose"]
    assert t == pytest.approx(104.0, abs=0.02)
    # never fails before the storm if T_home < 5
    t2 = margin.latest_departure_terms(mi, 50.0, 0.0, 0.0, [0.0], [0.0], [4.0], [0.0])["dose"]
    assert t2 == math.inf


def test_latest_departure_solves_each_term():
    mi = margin.inputs(P, t_dark_min=300.0, eva=False)
    tau = np.array([0.0, 10.0, 20.0])
    o2p = np.array([0.0, 13.5, 27.0])
    th = np.array([20.0, 10.0, 0.0])
    oh = np.array([27.0, 13.5, 0.0])
    # daylight: 300 - tau - th = 280 at every vertex; O2 (u0 = 0, rate 1.35):
    # min(CAP - o2p - oh - 40.5) / 1.35 = (481.99 - 27 - 40.5) / 1.35 = 307.0 -> daylight binds
    t = margin.latest_departure(mi, 0.0, 0.0, mi.o2_rate_l_min, tau, o2p, th, oh)
    assert t == pytest.approx(280.0)
    for k in range(3):
        m, _ = margin.margin(mi, t + tau[k], 1.35 * t + o2p[k], th[k], oh[k])
        assert m >= -1e-9
    mi2 = margin.inputs(P, eva=False)
    t2 = margin.latest_departure(mi2, 0.0, 0.0, mi2.o2_rate_l_min, tau, o2p, th, oh)
    assert t2 == pytest.approx((CAP - 27 - RES) / 1.35)
    m, b = margin.margin(mi2, t2 + tau[2], 1.35 * t2 + o2p[2], th[2], oh[2])
    assert (m, b) == (pytest.approx(0.0, abs=1e-9), "O2")


def test_latest_departure_dose_and_unknown():
    mi = margin.inputs(P, tau_dose_min=15.0)
    assert margin.latest_departure(mi, 0, 0, 1.0, [0, 1], [0, 1], [20, 10], [5, 2]) == -math.inf
    mi = margin.inputs(P)
    assert margin.latest_departure(mi, 0, 0, 1.0, [0], [0], [np.inf], [1]) == -math.inf

"""Haul (partner line) known-answer tests (SPEC F10, §9; brief WS2 "Tests")."""

import math

import numpy as np
import pytest

from pipeline.engine import dijkstra, haul, physio
from pipeline.engine.config import load
from pipeline.engine.synthetic import make_grid

H = load("haul")
CREW = load("crew")
G = CREW["g_mars"]
G_MOON = H["g_moon"]  # haul.yaml (assumed: true), only for the Mars/Moon ratio KAT
P_NOM = physio.params("nominal", suit_kg=104)
BOUND = H["casualty_kg"]["bound"]
SUITED = CREW["body_mass_kg"] + 104
RES = 3.0


def _case(name, m_ic, mu=None):
    return haul.case(name, m_ic, mu=mu)


# ------------------------------------------------------------------ force


@pytest.mark.parametrize(
    ("mu", "deg", "expect"),
    [
        # hand calculation: 343 * 3.71 * (mu cos th + sin th), N
        (0.2, 0.0, 254.506),
        (0.2, 10.0, 471.616),
        (0.2, 20.0, 674.390),
        (0.6, 0.0, 763.518),
        (0.6, 10.0, 972.884),
        (0.6, 20.0, 1152.718),
    ],
)
def test_force_343kg_hand_calculation(mu, deg, expect):
    assert haul.force(BOUND, mu, math.radians(deg), G) == pytest.approx(expect, rel=1e-4)


def test_mars_moon_force_ratio():
    th = math.radians(10)
    ratio = haul.force(BOUND, 0.2, th, G) / haul.force(BOUND, 0.2, th, G_MOON)
    assert round(ratio, 2) == 2.29


def test_casualty_suited_mass():
    """haul.yaml: body_mass + suit_mass, 179 kg at the 104 kg suit."""
    assert haul.suited_casualty_kg(104) == 179


# ------------------------------------------------------------------ speed


def test_haul_speed_self_consistent():
    """v = eps * P(v) / F with P(v) = (effort * VO2max - VO2_walk(v)) * m_b * 21.0 / 60 (D29)."""
    c = _case("cart", SUITED)
    for deg in (0.0, 5.0, 12.0):
        th = math.radians(deg)
        v = haul.speed(P_NOM, c, th)
        F = haul.force(SUITED, c.mu, th, G)
        P = (c.effort_frac * P_NOM.vo2max - physio.vo2(P_NOM, v, th)) * P_NOM.m_b * 21.0 / 60
        if v < physio.v_safe(P_NOM, th):
            assert v == pytest.approx(c.eps * P / F, rel=1e-9)


@pytest.mark.parametrize("name", ["cart", "drag"])
@pytest.mark.parametrize("m_ic", [CREW["body_mass_kg"] + s for s in CREW["suit_masses_kg"]] + [343])
def test_haul_never_faster_than_walking(name, m_ic):
    lo, hi = H["cases"][name]["mu_range"]
    th = np.radians(np.linspace(-25, 25, 501))
    walk = physio.governor(P_NOM, th)
    for mu in (lo, H["cases"][name]["mu_nominal"], hi):
        v = haul.speed(P_NOM, _case(name, m_ic, mu), th)
        assert np.all(v <= walk + 1e-12)


def test_downhill_half_vsafe():
    th = math.radians(-15)
    v = haul.speed(P_NOM, _case("cart", SUITED, 0.1), th)
    assert v <= 0.5 * physio.v_safe(P_NOM, th) + 1e-12


def test_infeasible_rules():
    # traction: F > boot_mu (m_b + suit + tools) g cos th
    th = math.radians(10)
    c = _case("cart", BOUND)
    F = haul.force(BOUND, c.mu, th, G)
    assert F > H["boot_mu"] * (P_NOM.m_b + P_NOM.carried_kg) * G * math.cos(th)
    assert haul.speed(P_NOM, c, th) == 0.0
    # minimum speed 0.1 m/s
    v = haul.speed(P_NOM, c, np.radians(np.linspace(-25, 25, 101)))
    assert np.all((v == 0) | (v >= 0.1))


def test_drag_infeasible_on_level_with_boot_mu():
    """Model finding (reported to S): with boot_mu 0.5 < drag mu, a suited casualty heavier than
    the rescuer system cannot be dragged even on level ground."""
    for m in (SUITED, BOUND):
        assert haul.speed(P_NOM, _case("drag", m), 0.0) == 0.0


# ------------------------------------------------------------------ D20 drag finding


def test_drag_179kg_flat_infeasible_traction():
    """D20 (user 14:22): dragging the suited crewmate (179 kg at the 104 kg suit) is infeasible
    even on flat ground, and the cause is boot traction (F > boot_mu (m_b + suit + tools) g)."""
    c = _case("drag", SUITED)
    assert SUITED == 179
    assert haul.speed(P_NOM, c, 0.0) == 0.0
    assert haul.infeasible_reason(P_NOM, c, 0.0) == "traction"
    F = haul.force(SUITED, c.mu, 0.0, G)
    assert F > H["boot_mu"] * (P_NOM.m_b + P_NOM.carried_kg) * G
    # the cart case at the same mass on the same ground is feasible
    assert haul.infeasible_reason(P_NOM, _case("cart", SUITED), 0.0) is None
    assert haul.speed(P_NOM, _case("cart", SUITED), 0.0) > 0


def test_drag_flat_numbers_d20():
    """Flat-ground numbers the page cites (SPEC §11 D20), computed from config.
    Hand: 179 x 3.71 x 0.6 = 398.454 N; 0.5 x (75 + 104 + 10) x 3.71 = 350.595 N;
    max draggable = 0.5 x 189 / 0.6 = 157.5 kg."""
    d = haul.drag_flat(104)
    assert d["casualty_kg"] == 179 and d["rescuer_system_kg"] == 189
    assert d["mu"] == 0.6 and d["boot_mu"] == 0.5
    assert d["force_N"] == pytest.approx(398.454, abs=1e-3)
    assert d["traction_limit_N"] == pytest.approx(350.595, abs=1e-3)
    assert d["max_mass_kg"] == pytest.approx(157.5, abs=1e-9)
    assert d["feasible"] is False and d["reason"] == "traction"
    # every suit mass of crew.yaml: the suited casualty is above the draggable mass
    for s in CREW["suit_masses_kg"]:
        x = haul.drag_flat(s)
        assert x["casualty_kg"] > x["max_mass_kg"] and not x["feasible"]


def test_partner_cases_cart_only():
    """D20: the partner line and haul fields use haul.yaml partner_cases (cart only); the drag
    case stays in the config."""
    assert haul.partner_cases() == ["cart"]
    assert "drag" in H["cases"]


# ------------------------------------------------------------------ router


def test_masked_ridges_never_crossed():
    n = 121
    ridge_index = np.zeros((n, n))
    ridge_index[:, 60] = 1.0  # above the 0.75 m threshold
    g = make_grid(np.zeros((n, n)), RES)
    hg = haul.haul_grid(g, ridge_index)
    tab = haul.grade_table(P_NOM, _case("cart", SUITED))
    f = dijkstra.return_field(hg, tab, (60, 10))
    assert np.isinf(f.t_min[:, 61:]).all()
    assert np.isfinite(f.t_min[:, :59]).all()
    # walking (unmasked) still crosses
    fw = dijkstra.return_field(g, physio.grade_table(P_NOM), (60, 10))
    assert np.isfinite(fw.t_min[:, 61:]).all()


def test_haul_table_matches_speed():
    c = _case("cart", SUITED)
    tab = haul.grade_table(P_NOM, c)
    for deg in (-12.0, -3.0, 0.0, 4.0, 8.0):
        v = haul.speed(P_NOM, c, math.radians(deg))
        pace = np.interp(deg, tab.theta_deg, tab.pace_s_per_m)
        if v > 0:
            assert pace == pytest.approx(1 / v, rel=1e-3)
        else:
            assert np.isinf(pace)

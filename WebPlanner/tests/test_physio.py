"""Physiology known-answer tests (SPEC F3, §9; brief WS2 "Tests").

Every constant comes from config/crew.yaml and config/variants.yaml via pipeline.engine.physio.
"""

import math

import numpy as np
import pytest

from pipeline.engine import physio
from pipeline.engine.config import load

CREW = load("crew")
VAR = load("variants")
VARIANTS = ["optimistic", "nominal", "conservative"]
# The conservative no-go limit needs V1's RMSE (WS6); physiology tests do not depend on it.
RMSE_STUB = 1.0
GRID_DEG = np.linspace(-30.0, 30.0, 1201)


def _p(variant, carried_kg):
    return physio.params(variant, carried_kg=carried_kg, v1_rmse_deg=RMSE_STUB)


def _rad(deg):
    return np.radians(deg)


# ---------------------------------------------------------------- anchor


@pytest.mark.parametrize("variant", ["optimistic", "nominal"])
def test_anchor_level_cost(variant):
    """Level, 0.98 m/s, 120 kg carried, g 3.71 -> 19 +- 1 mL/kg/min (ICES-2026-127).

    The conservative variant raises a by 10 % on purpose (SPEC F3 "a +10%"), so it sits
    above the anchor: see test_conservative_anchor_offset.
    """
    a = CREW["anchor"]
    p = _p(variant, a["carried_kg"])
    assert p.g == 3.71
    vo2 = physio.vo2(p, a["speed_ms"], 0.0)
    assert vo2 == pytest.approx(19.0, abs=1.0)


def test_conservative_anchor_offset():
    """Conservative at the anchor: V0 + 1.1 * (19 - V0) = 7 + 1.1 * 12 = 20.2 mL/kg/min."""
    a = CREW["anchor"]
    p = _p("conservative", a["carried_kg"])
    assert physio.vo2(p, a["speed_ms"], 0.0) == pytest.approx(20.2)


def test_anchor_nominal_exact():
    """With a_mult = 1 the anchor is reproduced exactly (a_anchor definition)."""
    a = CREW["anchor"]
    p = _p("nominal", a["carried_kg"])
    assert physio.vo2(p, a["speed_ms"], 0.0) == pytest.approx(a["vo2_ml_kg_min"], rel=1e-12)


def test_alpha_weight_span_encoding_by_hand():
    """Decision 14 Nov 15:40: alpha uses the IST-2 weight span (gravity change 0.12 -> 0.32 g on
    121 + 80.7 kg), as carried mass at Mars g: 0.20 * 9.80665 * 201.7 / 3.71 = 106.63 kg.
    alpha = 1.9 / (106.63 * 0.98) = 0.018182 (was 1.9 / (60 * 0.98) = 0.032313)."""
    span = 0.20 * 9.80665 * (121 + 80.7) / 3.71
    assert span == pytest.approx(106.6308, abs=1e-3)
    assert physio.ist2_span_mars_kg() == pytest.approx(span, rel=1e-12)
    alpha = 1.9 / (span * 0.98)
    assert alpha == pytest.approx(0.0181821, abs=1e-6)
    assert physio.alpha_level() == pytest.approx(alpha, rel=1e-12)
    assert physio.params("nominal", suit_kg=104).alpha == pytest.approx(alpha, rel=1e-12)
    # the documented derived values in variants.yaml match the computation
    enc = VAR["ist2"]["alpha_encoding"]
    assert enc["span_mars_equiv_kg"] == pytest.approx(span, abs=0.05)
    assert enc["alpha"] == pytest.approx(alpha, abs=5e-6)
    assert "delta_mass_kg" not in VAR["ist2"] and VAR["ist2"]["level_span"] == "weight_span"


def test_alpha_and_a_formula():
    """a(M) = a_anchor * a_mult + alpha * (M - anchor.carried_kg); alpha only scales the mass
    term (a_mult multiplies a_anchor). Level VO2 at 0.98 m/s, nominal: 18.47 / 18.89 / 19.18
    at 80 / 104 / 120 kg suit."""
    a = CREW["anchor"]
    alpha = physio.alpha_level()
    p = _p("nominal", 114.0)
    a_anchor = (a["vo2_ml_kg_min"] - 6.0) / a["speed_ms"]
    assert physio.a_of_m(p) == pytest.approx(a_anchor + alpha * (114.0 - a["carried_kg"]))
    # Conservative multiplies a_anchor by 1.1
    pc = _p("conservative", 114.0)
    a_anchor_c = (a["vo2_ml_kg_min"] - 7.0) / a["speed_ms"]
    assert physio.a_of_m(pc) == pytest.approx(1.1 * a_anchor_c + alpha * (114.0 - 120.0))
    # level VO2 at the anchor speed, nominal suits 80 / 104 / 120 kg (+ 10 kg tools), by hand
    for suit, want in ((80, 18.4654), (104, 18.8931), (120, 19.1782)):
        hand = 6.0 + (a_anchor + alpha * (suit + 10 - 120)) * 0.98
        assert hand == pytest.approx(want, abs=1e-4)
        assert physio.vo2(physio.params("nominal", suit_kg=suit), 0.98, 0.0) == pytest.approx(hand)


def test_carried_mass_is_suit_plus_tools():
    p = physio.params("nominal", suit_kg=104)
    assert p.carried_kg == 104 + CREW["tools_kg"]
    assert p.m_b == CREW["body_mass_kg"]


def test_uphill_k_hand_calculation():
    """k = (m_b + M) g sin(theta) / (eta m_b) * 60 / 21.0 at 10 deg, nominal, 114 kg (D29)."""
    p = _p("nominal", 114.0)
    th = math.radians(10.0)
    k = (75 + 114) * 3.71 * math.sin(th) / (0.225 * 75) * 60 / 21.0
    assert physio.k_uphill(p, th) == pytest.approx(k)
    assert physio.k_uphill(p, -th) == 0.0


def test_minetti_coefficients_from_config():
    # f(0) = 2.5, f(-0.1) by hand from the polynomial text in variants.yaml
    assert physio.minetti_f(0.0) == pytest.approx(2.5)
    i = -0.1
    hand = 280.5 * i**5 - 58.7 * i**4 - 76.8 * i**3 + 51.9 * i**2 + 19.6 * i + 2.5
    assert physio.minetti_f(i) == pytest.approx(hand)
    assert physio.DOWNHILL_CLAMP == (0.4, 3.0)


# ------------------------------------------------------------ monotonicity


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("v", [0.3, 0.6, 0.98])
def test_monotonic_in_uphill_grade(variant, v):
    p = _p(variant, 114.0)
    th = _rad(np.linspace(0.0, 25.0, 501))
    vo2 = physio.vo2(p, v, th)
    assert np.all(np.diff(vo2) > 0)


@pytest.mark.parametrize("variant", VARIANTS)
def test_monotonic_in_downhill_grade_beyond_minimum(variant):
    """Steeper than the cost minimum, cost rises as the slope steepens (braking).

    Checked to -0.43 grade: the Minetti polynomial peaks at i = -0.434 (-23.4 deg) and falls
    beyond it (outside Minetti's tested range); reported to S for the optimistic 25 deg limit.
    """
    p = _p(variant, 114.0)
    grades = np.linspace(-0.43, -0.2, 231)
    vo2 = physio.vo2(p, 0.8, np.arctan(grades))
    assert np.all(np.diff(vo2) <= 1e-12)  # increasing |grade| (decreasing grade) -> higher cost


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("deg", [-20.0, -8.0, 0.0, 5.0, 15.0])
def test_monotonic_in_mass(variant, deg):
    masses = np.array([80.0, 90.0, 104.0, 114.0, 120.0, 130.0])
    vo2 = [physio.vo2(_p(variant, m), 0.7, math.radians(deg)) for m in masses]
    assert np.all(np.diff(vo2) > 0)
    vstar = [physio.governor(_p(variant, m), math.radians(deg)) for m in masses]
    assert np.all(np.diff(vstar) <= 1e-12)


def test_governor_non_increasing_uphill():
    p = _p("nominal", 114.0)
    v = physio.governor(p, _rad(np.linspace(0.0, 25.0, 501)))
    assert np.all(np.diff(v) <= 1e-12)


# ---------------------------------------------------------------- governor


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("carried", [90.0, 114.0, 130.0])
def test_vstar_le_vsafe_everywhere(variant, carried):
    p = _p(variant, carried)
    th = _rad(GRID_DEG)
    assert np.all(physio.governor(p, th) <= physio.v_safe(p, th) + 1e-12)


def test_vsafe_table():
    p = _p("nominal", 114.0)
    deg = np.array([0, 9.99, 10, 10.01, 17, 17.01, 25, 25.01, -10, -12, -24])
    v = physio.v_safe(p, _rad(deg))
    np.testing.assert_allclose(v, [1.0, 1.0, 1.0, 0.6, 0.6, 0.3, 0.3, 0.0, 1.0, 0.6, 0.3])


@pytest.mark.parametrize("variant", VARIANTS)
def test_governor_holds_effort_cap(variant):
    """Where the effort cap binds, VO2 at v* equals effort_cap * VO2max exactly."""
    p = _p(variant, 114.0)
    cap = CREW["effort_cap_frac"] * CREW["vo2max_ml_kg_min"]
    th = _rad(GRID_DEG)
    v = physio.governor(p, th)
    vo2 = physio.vo2(p, v, th)
    assert np.all(vo2 <= cap + 1e-9)
    binding = v < physio.v_safe(p, th) - 1e-12
    assert binding.any()
    np.testing.assert_allclose(vo2[binding], cap, rtol=1e-12)


def test_level_governor_value():
    """Level nominal 104 kg suit: v* = (0.5*36 - 6) / a(114) (cap binds below v_safe 1.0)."""
    p = physio.params("nominal", suit_kg=104)
    expect = (0.5 * 36 - 6) / physio.a_of_m(p)
    assert physio.governor(p, 0.0) == pytest.approx(expect)
    assert expect < 1.0


# ------------------------------------------------------------ downhill shape


@pytest.mark.parametrize("variant", VARIANTS)
def test_downhill_minimum_near_minus_10_to_15_pct(variant):
    p = _p(variant, 114.0)
    grades = np.round(np.arange(-0.40, 0.0001, 0.001), 3)
    vo2 = physio.vo2(p, 0.8, np.arctan(grades))
    mn = vo2.min()
    arg = grades[vo2 <= mn + 1e-9]
    # The clamp (0.4) makes the minimum a plateau; it must touch -10..-15 % and stay
    # inside -10..-20 %.
    assert np.any((arg >= -0.15) & (arg <= -0.10))
    assert arg.min() >= -0.20 and arg.max() <= -0.10
    assert mn < physio.vo2(p, 0.8, 0.0)


def test_continuous_at_level():
    p = _p("nominal", 114.0)
    eps = 1e-9
    assert physio.vo2(p, 0.9, eps) == pytest.approx(physio.vo2(p, 0.9, -eps), rel=1e-6)


# ------------------------------------------------------------ consumables


def test_o2_litres():
    """O2 = VO2 * m_b * t / 1000: 18 mL/kg/min, 75 kg, 10 min -> 13.5 L."""
    p = _p("nominal", 114.0)
    assert physio.o2_litres(p, 18.0, 10.0) == pytest.approx(13.5)


def test_heat_watts():
    """Heat = VO2 * m_b / 60 * 21.0 J/mL (D29): 18 mL/kg/min, 75 kg -> 472.5 W."""
    p = _p("nominal", 114.0)
    assert physio.heat_w(p, 18.0) == pytest.approx(18 * 75 / 60 * 21.0)


# ------------------------------------------------------------ variants / ids


def test_scenario_ids_parse():
    ids = VAR["scenarios"]["ids"]
    assert len(ids) == 9
    for sid in ids:
        variant, suit = physio.parse_scenario(sid)
        assert variant in VARIANTS and suit in CREW["suit_masses_kg"]
    assert physio.parse_scenario("nom_104") == ("nominal", 104)


def test_conservative_no_longer_needs_rmse_d23():
    """D23: the conservative no-go is 17 deg; V1's RMSE is ignored (a validation, not a margin).
    The old text form still parses (resolve_nogo) for the record."""
    assert physio.params("conservative", suit_kg=104).nogo_deg == 17.0
    assert physio.params("conservative", suit_kg=104, v1_rmse_deg=1.5).nogo_deg == 17.0
    assert physio.resolve_nogo("20 - v1_rmse_deg", 1.5) == pytest.approx(18.5)
    with pytest.raises(physio.MissingInput):
        physio.resolve_nogo("20 - v1_rmse_deg", None)


def test_nogo_from_variants():
    assert physio.params("optimistic", suit_kg=104).nogo_deg == 25
    assert physio.params("nominal", suit_kg=104).nogo_deg == 20


# ------------------------------------------------------------ grade table


@pytest.mark.parametrize("variant", VARIANTS)
def test_grade_table_matches_formulas(variant):
    p = _p(variant, 114.0)
    tab = physio.grade_table(p)
    deg = np.array([-16.8, -8.2, -0.5, 0.0, 3.3, 11.7, 16.9])  # within every no-go (con 17, D23)
    pace = np.interp(deg, tab.theta_deg, tab.pace_s_per_m)
    v = physio.governor(p, _rad(deg))
    np.testing.assert_allclose(pace, 1.0 / v, rtol=1e-4)
    o2 = np.interp(deg, tab.theta_deg, tab.o2_l_per_m)
    expect = physio.o2_litres(p, physio.vo2(p, v, _rad(deg)), 1.0 / v / 60.0)
    np.testing.assert_allclose(o2, expect, rtol=1e-4)


def test_grade_table_impassable_beyond_nogo():
    p = _p("nominal", 114.0)
    tab = physio.grade_table(p)
    beyond = np.abs(tab.theta_deg) > p.nogo_deg + 1e-9
    assert np.all(np.isinf(tab.pace_s_per_m[beyond]))
    assert np.all(np.isfinite(tab.pace_s_per_m[~beyond]))


def test_o2_budget_formula_recomputes():
    """D29 (user 16:20): the O2 budget converts energy at the one O2 energy equivalent
    21.0 J/mL: O2_L = h x BTU/h x 1055.056 / 21.0 / 1000. Primary 8 h x 1,200 BTU/h = 482.31 L
    (481.99 via ICES, 504 at 20.1); secondary 1 h x 3,000 BTU/h = 150.72 L."""
    from pipeline.engine import margin

    b = CREW["o2_budget"]
    prim = 8 * 1200 * 1055.056 / 21.0 / 1000
    sec = 1 * 3000 * 1055.056 / 21.0 / 1000
    assert prim == pytest.approx(482.31, abs=0.01) and sec == pytest.approx(150.72, abs=0.01)
    assert margin.o2_budget_l("primary_L") == pytest.approx(prim, rel=1e-12)
    assert margin.o2_budget_l("secondary_L") == pytest.approx(sec, rel=1e-12)
    assert margin.o2_capacity_l() == pytest.approx(prim, rel=1e-12)  # margin_uses: primary_L
    # the rounded values documented in crew.yaml (read by the web scorecard) match
    assert b["primary_L"] == round(prim) == 482 and b["secondary_L"] == round(sec) == 151


def test_one_o2_energy_equivalent_d29():
    """D29: one key, 21.0 J/mL, for k, heat, haul power and the O2 budget."""
    assert CREW["o2_energy_j_per_ml"] == 21.0
    assert physio.params("nominal", suit_kg=104).j_per_ml == 21.0


def test_conservative_nogo_17_d23():
    """D23: conservative no-go 17 deg, no V1 input needed."""
    assert physio.params("conservative", suit_kg=104).nogo_deg == 17.0
    assert physio.scenario_params("con_104").nogo_deg == 17.0


def test_level_to_grade_increment_not_validated():
    """The level -> 20/30 % increment k*v is reported, never compared with IST-2's 8.7 / 17.0
    (those are weight-span differences, S review 2026-11-14). No measured level -> grade
    reference is in hand, so it is labelled "not validated". Only sign and ordering here."""
    assert VAR["ist2"]["level_to_grade_validated"] is False
    p = physio.params("nominal", suit_kg=104)
    chk = physio.level_to_grade_increment(p, CREW["anchor"]["speed_ms"])
    assert chk["validated"] is False
    assert 0 < chk["grade_20pct"] < chk["grade_30pct"]


# ---------------------------------------------------------------- IST-2 weight span (S review)

W = VAR["ist2"]["weight_span"]
G0 = VAR["ist2"]["g_earth_ms2"]


def _span_by_hand(eta, grade_pct, v):
    """(VO2 at 0.32 g - VO2 at 0.12 g) per kg subject mass, same grade and speed, vertical term:
    (m_b + M) dg sin(theta) / (eta m_b) * 60 / 21.0 * v (D29)."""
    th = math.atan(grade_pct / 100)
    dg = (W["g_frac"][1] - W["g_frac"][0]) * G0
    m_b, m = W["subject_kg"], W["system_kg"]
    return (m_b + m) * dg * math.sin(th) / (eta * m_b) * 60 / 21.0 * v


def _level_by_hand(v):
    """Level term of the weight span: alpha * span_kg * v = 1.9 * v / 0.98 (alpha is defined on
    the IST-2 weight span, decision 14 Nov 15:40); the same in every variant."""
    return 1.9 / 0.98 * v


def test_ist2_weight_span_config():
    assert W["g_frac"] == [0.12, 0.32] and W["system_kg"] == 121 and W["subject_kg"] == 80.7
    assert W["speed_ms"] == [0.56, 0.97]
    # 0.20 g on the full 201.7 kg system ~ the 88 lb (391 N) TGAW span, within 1.5 %
    dw = 0.20 * G0 * (121 + 80.7)
    assert dw == pytest.approx(88 * 0.45359237 * G0, rel=0.015)


@pytest.mark.parametrize("variant", VARIANTS)
def test_ist2_weight_span_hand_calculation(variant):
    eta = VAR["variants"][variant]["eta"]
    span = physio.ist2_weight_span(variant)
    assert span["level_term_band"] == pytest.approx([_level_by_hand(0.56), _level_by_hand(0.97)])
    for g in (20, 30):
        lo, hi = span[f"grade_{g}pct"]["band"]
        assert lo == pytest.approx(_span_by_hand(eta, g, 0.56) + _level_by_hand(0.56), rel=1e-9)
        assert hi == pytest.approx(_span_by_hand(eta, g, 0.97) + _level_by_hand(0.97), rel=1e-9)
        klo, khi = span[f"grade_{g}pct"]["band_vertical_only"]
        assert klo == pytest.approx(_span_by_hand(eta, g, 0.56), rel=1e-9)
        assert khi == pytest.approx(_span_by_hand(eta, g, 0.97), rel=1e-9)


def test_ist2_weight_span_nominal_contains_reported():
    """S review pass rule: IST-2's 8.7 (20 %) and 17.0 (30 %) inside the band from the speed
    sweep 0.56-0.97 m/s. Nominal (eta 0.225, 21.0 J/mL since D29) with the level term:
    7.92-13.72 and 11.10-19.23 -> both inside (vertical term alone: 6.84-11.84, 10.02-17.35)."""
    span = physio.ist2_weight_span("nominal")
    assert span["grade_20pct"]["inside"] and span["grade_30pct"]["inside"]
    assert span["grade_20pct"]["band"] == pytest.approx([7.922, 13.722], abs=1e-3)
    assert span["grade_30pct"]["band"] == pytest.approx([11.103, 19.231], abs=1e-3)
    assert span["grade_20pct"]["reported"] == 8.7 and span["grade_30pct"]["reported"] == 17.0


def test_ist2_weight_span_by_variant_reported_honestly():
    """With the level term (alpha on the weight span), 21.0 J/mL (D29): optimistic (eta 0.25)
    30 % band 10.10-17.50 contains 17.0 (vertical only: 15.62, outside); conservative (eta 0.20)
    20 % band 8.78-15.20 does not contain 8.7 (vertical only: 7.69-13.32, inside). Reported,
    not tuned (D30)."""
    opt = physio.ist2_weight_span("optimistic")
    assert opt["grade_20pct"]["inside"] and opt["grade_30pct"]["inside"]
    assert not opt["grade_30pct"]["inside_vertical_only"]
    con = physio.ist2_weight_span("conservative")
    assert not con["grade_20pct"]["inside"] and con["grade_30pct"]["inside"]
    assert con["grade_20pct"]["inside_vertical_only"]
    assert con["grade_20pct"]["band"][0] == pytest.approx(8.777, abs=1e-3)


def test_ist2_manifest_rows_d30():
    """D30: pass/miss per variant and grade, as written to the manifest by the engine run."""
    rows = physio.ist2_pass_rows()
    assert rows["nominal"]["grade_20pct"]["pass"] and rows["nominal"]["grade_30pct"]["pass"]
    assert not rows["conservative"]["grade_20pct"]["pass"]
    assert rows["optimistic"]["grade_30pct"]["pass"]
    assert set(rows) == {"optimistic", "nominal", "conservative"}
    for v in rows.values():
        for g in ("grade_20pct", "grade_30pct"):
            assert set(v[g]) == {"pass", "band_lo", "band_hi", "reported"}

"""F9 KAT: the orienteering DP equals brute force on 8 stations (SPEC §9)."""

import numpy as np
import pytest

from pipeline.engine import orienteering as ori
from pipeline.engine.config import load

CREW = load("crew")
BUDGET = CREW["eva_h"] * 60
DWELL = load("stations")["dwell_min"]


def _instance(seed, n=8):
    rng = np.random.default_rng(seed)
    xy = rng.uniform(-2500, 2500, size=(n, 2))
    pad = np.zeros(2)
    v_out, v_back = rng.uniform(0.5, 0.9), rng.uniform(0.5, 0.9)  # asymmetric (slopes)
    d = np.linalg.norm(xy[:, None] - xy[None], axis=2)
    asym = rng.uniform(0.8, 1.25, size=(n, n))
    t_leg = d / 60 / 0.7 * asym
    np.fill_diagonal(t_leg, np.inf)
    dp = np.linalg.norm(xy - pad, axis=1)
    t_from = dp / 60 / v_out
    t_to = dp / 60 / v_back
    if seed % 3 == 0:
        t_leg[0, 1] = t_leg[1, 0] = np.inf  # an unreachable leg
    values = np.round(rng.uniform(0.2, 1.0, n), 3)
    return values, t_from, t_to, t_leg


@pytest.mark.parametrize("seed", range(6))
def test_dp_equals_brute_force_8(seed):
    values, t_from, t_to, t_leg = _instance(seed)
    dp = ori.solve(values, DWELL, t_from, t_to, t_leg, BUDGET)
    bf = ori.brute_force(values, DWELL, t_from, t_to, t_leg, BUDGET)
    assert dp.value == pytest.approx(bf.value)
    assert dp.total_min == pytest.approx(bf.total_min)
    assert ori.evaluate(dp.order, DWELL, t_from, t_to, t_leg, BUDGET) == pytest.approx(dp.total_min)


@pytest.mark.parametrize("seed", range(3))
def test_dp_equals_brute_force_with_margin_check(seed):
    """A monotone leg check (latest departure per destination) keeps the DP exact."""
    values, t_from, t_to, t_leg = _instance(seed + 10)
    rng = np.random.default_rng(seed)
    latest = rng.uniform(60, 300, size=8)

    def ok(frm, to, t):
        return to == ori.PAD or t <= latest[to]

    dp = ori.solve(values, DWELL, t_from, t_to, t_leg, BUDGET, ok)
    bf = ori.brute_force(values, DWELL, t_from, t_to, t_leg, BUDGET, ok)
    assert dp.value == pytest.approx(bf.value)
    assert dp.total_min == pytest.approx(bf.total_min)


def test_timeline_contract():
    from pipeline.engine.geo import validate

    values, t_from, t_to, t_leg = _instance(1, n=4)
    plan = ori.solve(values, DWELL, t_from, t_to, t_leg, BUDGET)
    o2 = lambda t: t * 1.35  # noqa: E731  (test stand-in for O2 per leg)
    tl = ori.timeline(plan, [f"S{i + 1}" for i in range(4)], DWELL, t_from, t_to, t_leg,
                      o2(t_from), o2(t_to), o2(t_leg), t_to, 30)  # fmt: skip
    validate(tl, "timeline.schema.json")
    assert tl[0]["event"] == "depart" and tl[-1]["event"] == "return"
    assert tl[-1]["t_min"] == pytest.approx(plan.total_min, abs=0.01)


# ---- D21: feasible-subset counter (KAT on a synthetic matrix) ----


def test_feasible_subsets_known_answer():
    """3 stations, dwell 30, budget 100: pad->A 10, A->pad 10; B 20/20; C 60/60 (C alone =
    150 > 100). A-B legs 10. Feasible: {A} 50, {B} 70, {A,B} 10+30+10+30+20 = 100. Count 3."""
    inf = np.inf
    t_from = [10, 20, 60]
    t_to = [10, 20, 60]
    t_leg = [[inf, 10, 50], [10, inf, 50], [50, 50, inf]]
    feas = ori.feasible_subsets(30, t_from, t_to, t_leg, 100)
    assert sorted(feas) == [0b001, 0b010, 0b011]
    # a leg check that forbids leaving A after minute 35: every route leaves A at >= 40, so
    # only {B} stays feasible
    def ok(frm, to, t):
        return not (frm == 0 and t > 35)
    assert sorted(ori.feasible_subsets(30, t_from, t_to, t_leg, 100, ok)) == [0b010]
    assert ori.feasible_subsets(30, t_from, t_to, t_leg, 100, ok) == \
        ori.feasible_subsets_brute(30, t_from, t_to, t_leg, 100, ok)


@pytest.mark.parametrize("seed", range(6))
def test_feasible_subsets_equals_brute_force(seed):
    _, t_from, t_to, t_leg = _instance(seed, n=6)
    for budget in (BUDGET, BUDGET / 2):
        dp = ori.feasible_subsets(DWELL, t_from, t_to, t_leg, budget)
        bf = ori.feasible_subsets_brute(DWELL, t_from, t_to, t_leg, budget)
        assert dp == bf


def test_feasible_subsets_with_monotone_leg_ok_equals_brute_force():
    _, t_from, t_to, t_leg = _instance(4, n=6)
    lat = np.random.default_rng(1).uniform(50, 300, size=(7, 7))

    def ok(frm, to, t):  # monotone: earlier is never worse
        return t <= lat[frm + 1, to + 1]

    dp = ori.feasible_subsets(DWELL, t_from, t_to, t_leg, BUDGET, ok)
    bf = ori.feasible_subsets_brute(DWELL, t_from, t_to, t_leg, BUDGET, ok)
    assert dp == bf
    assert len(dp) < len(ori.feasible_subsets(DWELL, t_from, t_to, t_leg, BUDGET))

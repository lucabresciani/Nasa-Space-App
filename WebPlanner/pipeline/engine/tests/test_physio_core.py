"""D48 physio_core KATs: stdlib + numpy only, identical to the physio/margin API it backs, the
alarm rules of SPEC F18 (as web/src/hud/alarms.ts) and the segment step."""

import ast
import json
import math
from pathlib import Path

import numpy as np
import pytest

from pipeline.engine import margin, physio, physio_core
from pipeline.engine.config import load

CORE = Path(physio_core.__file__)
GOLDEN = Path(__file__).resolve().parents[3] / "web/public/data/physio/golden.json"


def test_core_imports_only_stdlib_and_numpy():
    import sys

    mods = set()
    for node in ast.walk(ast.parse(CORE.read_text())):
        if isinstance(node, ast.Import):
            mods |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "physio_core must not import engine modules"
            mods.add(node.module.split(".")[0])
    third = {m for m in mods if m not in sys.stdlib_module_names and m != "__future__"}
    assert third == {"numpy"}


def test_physio_and_margin_reexport_the_core():
    for name in ("Params", "GradeTable", "vo2", "governor", "cost_slope", "k_uphill", "a_of_m",
                 "v_safe", "o2_litres", "heat_w"):  # fmt: skip
        assert getattr(physio, name) is getattr(physio_core, name)
    for name in ("MarginInputs", "DoseTiming", "margin", "o2_margin_min", "o2_slack_l",
                 "latest_departure", "latest_departure_terms", "t_star", "EVA"):  # fmt: skip
        assert getattr(margin, name) is getattr(physio_core, name)
    p = physio.params("nominal")
    assert p.minetti_coef == physio.MINETTI_COEF and p.downhill_clamp == physio.DOWNHILL_CLAMP
    assert margin.effort_rate_l_min(p) == physio_core.effort_rate_l_min(p) == pytest.approx(1.35)


def test_step_matches_golden_o2_leg():
    """step(): one segment's v*, minutes, O2 and heat, as the golden o2_leg / physio cases."""
    doc = json.loads(GOLDEN.read_text())
    for case in doc["cases"]["o2_leg"]:
        i = case["inputs"]
        p = physio.params(i["variant"], suit_kg=i["suit_kg"])
        for a, b, seg in zip(i["vertices"], i["vertices"][1:], case["expected"]["segments"],
                             strict=False):  # fmt: skip
            dh = math.hypot(b[0] - a[0], b[1] - a[1])
            v, t, o2, _ = physio_core.step(p, math.atan2(b[2] - a[2], dh), dh)
            assert v == pytest.approx(seg["v_star_ms"], rel=1e-9)
            if seg["t_min"] is None:
                assert math.isinf(t) and math.isinf(o2)
            else:
                assert t == pytest.approx(seg["t_min"], rel=1e-9)
                assert o2 == pytest.approx(seg["o2_L"], rel=1e-9)
    for case in doc["cases"]["physio"][:5]:
        i = case["inputs"]
        p = physio.params(i["variant"], suit_kg=i["suit_kg"])
        _, _, _, heat = physio_core.step(p, math.radians(i["grade_deg"]), 1.0)
        assert heat == pytest.approx(case["expected"]["heat_W_at_v_star"], rel=1e-9)


AMBER = load("hud")["margin_amber_min"]


@pytest.mark.parametrize("kw, rule, text", [
    ({"margin_min": -0.1, "tripwire_fired": True, "t_home_min": 50, "tau_dose_min": 10,
      "circle_crosses_homeline": True}, 1, "TURN BACK NOW"),
    ({"margin_min": 5, "tripwire_fired": True, "t_home_min": 50, "tau_dose_min": 50},
     2, "RADIATION: HEAD HOME"),
    ({"margin_min": 5, "tripwire_fired": True, "t_home_min": 49.9, "tau_dose_min": 50,
      "circle_crosses_homeline": True}, 3, "POSITION UNCERTAIN: HEAD TOWARD ROVER"),
    ({"margin_min": 9.9, "outside_partner": True}, 4, "TURN-BACK IN 9 MIN"),
    ({"margin_min": 0.0}, 4, "TURN-BACK IN 0 MIN"),
    ({"margin_min": AMBER, "outside_partner": True}, 5, "Beyond partner-haul range"),
    ({"margin_min": None, "tripwire_fired": True, "t_home_min": None, "tau_dose_min": 1,
      "outside_partner": None}, None, None),
    ({"margin_min": 30}, None, None),
])  # fmt: skip
def test_alarm_rules_first_match_wins(kw, rule, text):
    a = physio_core.evaluate_alarm(AMBER, **kw)
    if rule is None:
        assert a is None
    else:
        assert (a["rule"], a["text"]) == (rule, text)
        assert a["level"] == {1: "red", 2: "red", 3: "amber", 4: "amber", 5: "info"}[rule]


def test_margin_band():
    bands = [physio_core.margin_band(m, AMBER) for m in (None, -1e-9, 0.0, AMBER, AMBER + 0.01)]
    assert bands == ["unknown", "red", "amber", "amber", "green"]


def test_tau_dose_formula():
    assert physio_core.tau_dose_min(0.5, 6000 / 1000 / 24) == pytest.approx(120.0)
    assert np.allclose(physio_core.tau_dose_min(1.0, [1.0, 2.0]), [60.0, 30.0])

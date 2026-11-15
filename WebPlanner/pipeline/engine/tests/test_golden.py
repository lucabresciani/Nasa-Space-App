"""D40 KAT: physio/golden.json is deterministic, every case re-checks against the Python
reference, a perturbed value is caught, and the hand numbers of the spec hold."""

import copy
import json
import math

import pytest

from pipeline.engine import golden, provenance
from pipeline.engine.config import load


@pytest.fixture(autouse=True)
def manifest_dir(tmp_path, monkeypatch):
    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "manifest"))


@pytest.fixture(scope="module")
def doc():
    return golden.build()


def _case(doc, group, cid):
    return next(c for c in doc["cases"][group] if c["id"] == cid)


def test_deterministic_and_self_check(doc):
    assert json.dumps(golden.build()) == json.dumps(doc)
    assert golden.check(doc) == []
    assert doc["version"] == golden.VERSION
    assert doc["coords"] == {"frame": "pad-local metres", "origin": "pad", "x": "east",
                             "y": "north", "z": "up"}  # fmt: skip


def test_coverage_of_the_brief(doc):
    c = doc["cases"]
    # VO2 and v* at level, +-10, +-20 deg x 3 variants x 3 suit masses
    assert len(c["physio"]) == 5 * 3 * 3
    assert {k["inputs"]["grade_deg"] for k in c["physio"]} == {-20, -10, 0, 10, 20}
    assert {k["inputs"]["suit_kg"] for k in c["physio"]} == set(load("crew")["suit_masses_kg"])
    assert {k["inputs"]["variant"] for k in c["physio"]} == {"optimistic", "nominal",
                                                              "conservative"}  # fmt: skip
    assert len(c["o2_leg"]) == 3 and c["haul"] and c["haul_drag_finding"]
    assert {k["expected"]["binding"] for k in c["margin"]} == {"O2", "daylight", "dose",
                                                               "EVA duration"}  # fmt: skip
    assert {k["expected"]["binding"] for k in c["turn_back"]} == {"O2", "EVA duration"}
    assert c["dose_leash"] and len(c["route"]) == 1


@pytest.mark.parametrize("path", [
    ("physio", 0, "expected", "v_star_ms"),
    ("o2_leg", 1, "expected", "o2_L"),
    ("haul", 2, "expected", "force_N"),
    ("margin", 1, "expected", "margin_min"),
    ("turn_back", 0, "expected", "turn_back_min"),
    ("dose_leash", 3, "expected", "tau_dose_min"),
])  # fmt: skip
def test_perturbed_value_is_caught(doc, path):
    bad = copy.deepcopy(doc)
    group, i, a, b = path
    bad["cases"][group][i][a][b] *= 1.01
    fails = golden.check(bad)
    assert len(fails) == 1 and bad["cases"][group][i]["id"] in fails[0]


def test_route_row_perturbation_is_caught(doc):
    bad = copy.deepcopy(doc)
    row = next(r for r in bad["cases"]["route"][0]["expected"]["timeline"]
               if r["event"] == "arrive")  # fmt: skip
    row["expected"]["margin_min"] += 0.05
    assert any("row arrive" in f for f in golden.check(bad))


def test_hand_numbers(doc):
    crew, var = load("crew"), load("variants")
    d = doc["config"]["derived"]
    assert d["o2_reserve_L"] == pytest.approx(40.5)  # D24: 30 min x 1.35 L/min
    assert d["effort_rate_L_min"] == pytest.approx(1.35)
    assert d["station_task_rate_L_min"] == pytest.approx(0.8373, abs=1e-4)
    assert d["o2_budget_L"] == pytest.approx(482.31, abs=0.01)
    assert d["eva_budget_min"] == crew["eva_h"] * 60
    # level, nominal, 104 kg: VO2 = V0 + a(M) v at v* (hand formula)
    k = _case(doc, "physio", "physio.nominal.104.+0deg")
    v = var["variants"]["nominal"]
    a_anchor = (crew["anchor"]["vo2_ml_kg_min"] - v["V0"]) / crew["anchor"]["speed_ms"]
    a_m = a_anchor * v["a_mult"] + d["alpha_ml_kg_min_per_ms_per_kg"] * (
        104 + crew["tools_kg"] - crew["anchor"]["carried_kg"])
    e = k["expected"]
    assert e["a_M"] == pytest.approx(a_m)
    assert e["vo2_at_v_star"] == pytest.approx(v["V0"] + a_m * e["v_star_ms"])
    assert e["v_star_ms"] <= e["v_safe_ms"] + 1e-12
    assert e["o2_L_per_m"] == pytest.approx(e["vo2_at_v_star"] * crew["body_mass_kg"] / 1000
                                            / (60 * e["v_star_ms"]))  # fmt: skip
    # 20 deg: passable at the nominal no-go (20), not at the conservative one (17, D23)
    assert _case(doc, "physio", "physio.nominal.104.+20deg")["expected"]["passable"] is True
    con = _case(doc, "physio", "physio.conservative.104.+20deg")["expected"]
    assert con["passable"] is False and con["pace_s_per_m"] is None
    # uphill costs more than level; k = 0 downhill
    up = _case(doc, "physio", "physio.nominal.104.+10deg")["expected"]
    dn = _case(doc, "physio", "physio.nominal.104.-10deg")["expected"]
    assert up["k_uphill"] > 0 and dn["k_uphill"] == 0
    assert up["o2_L_per_m"] > e["o2_L_per_m"]
    # O2 over the fixed leg = sum of its segments
    leg = _case(doc, "o2_leg", "o2_leg.nominal.104")["expected"]
    assert leg["o2_L"] == pytest.approx(sum(s["o2_L"] for s in leg["segments"]))
    assert leg["segments"][0]["grade_deg"] == 0 and leg["segments"][0]["length_m"] == 300
    # D20 drag finding: 179 kg x 3.71 x 0.6 = 398 N > 0.5 x 189 x 3.71 = 351 N, max 157 kg
    dr = doc["cases"]["haul_drag_finding"][0]["expected"]
    assert dr["force_N"] == pytest.approx(398.5, abs=0.5)
    assert dr["traction_limit_N"] == pytest.approx(350.6, abs=0.5)
    assert dr["max_mass_kg"] == pytest.approx(157.5, abs=0.5) and dr["feasible"] is False
    flat = _case(doc, "haul", "haul.drag.suited.+0deg")["expected"]
    assert flat["feasible"] is False and flat["reason"] == "traction"
    assert _case(doc, "haul", "haul.cart.suited.+0deg")["expected"]["feasible"] is True
    # cart force = m g (mu cos + sin)
    c10 = _case(doc, "haul", "haul.cart.suited.+10deg")
    th = math.radians(10)
    assert c10["expected"]["force_N"] == pytest.approx(
        179 * crew["g_mars"] * (0.2 * math.cos(th) + math.sin(th)))
    # margin: EVA duration = 390 - 330 - 50 = 10 min
    m = _case(doc, "margin", "margin.eva_duration_binds")["expected"]
    assert m["binding"] == "EVA duration" and m["margin_min"] == pytest.approx(10.0)
    # O2 term = (O2_left - O2_home - tasks - reserve) / 1.35
    a = _case(doc, "margin", "margin.arrive_station_with_tasks")
    x = a["inputs"]
    assert a["expected"]["terms_min"]["O2"] == pytest.approx(
        (d["o2_budget_L"] - x["o2_used_L"] - x["o2_home_L"] - x["tasks_left_L"] - 40.5) / 1.35)
    # dose: 6000 uGy/day = 0.25 mGy/h; tau = 60 x 0.5 / 0.25 = 120 min
    dz = _case(doc, "dose_leash", "dose.0.5mGy.6000uGy_day")["expected"]
    assert dz["Ddot_mGy_per_h"] == pytest.approx(0.25) and dz["tau_dose_min"] == pytest.approx(120)
    # turn-back with EVA duration: 390 - T_home at the station
    tb = _case(doc, "turn_back", "turn_back.eva_duration_binds")
    th0 = tb["inputs"]["way_home"]["t_home"][0]
    assert tb["expected"]["turn_back_min"] == pytest.approx(390 - th0)


def test_route_case_frame(doc):
    r = doc["cases"]["route"][0]
    i = r["inputs"]
    assert i["legs"][0]["vertices"][0] == [0.0, 0.0, 0.0]  # pad-local origin
    for lg in i["legs"]:
        for _x, y, z in lg["vertices"]:
            assert z == pytest.approx(golden.ROUTE_PLANE * y, abs=1e-6)  # z up, y north
    assert sorted(r["expected"]["order"]) == ["A", "B", "C"]
    rows = r["expected"]["timeline"]
    assert rows[0]["event"] == "depart" and sum(x["event"] == "return" for x in rows) == 1
    assert all(x["expected"]["margin_min"] >= 0 for x in rows if x["event"] != "turn_back")


def test_write(tmp_path):
    p = golden.write(tmp_path / "physio" / "golden.json")
    assert golden.main(["--check", str(p)]) == 0
    keys = provenance.load_all()
    assert keys["physio.golden.version"]["value"] == golden.VERSION
    assert keys["file.physio/golden.json"]["file"] == "physio/golden.json"

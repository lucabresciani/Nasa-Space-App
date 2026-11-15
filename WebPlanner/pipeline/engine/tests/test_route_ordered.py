"""D97 known-answer tests: traverse.plan / build_plan with an ordered route of stations (R1).

Synthetic worlds only (fixtures, not data). route=None stays the auto plan byte for byte; an
ordered route is planned exactly as given (never reordered) with the auto path's legs and
margin checks; an order that breaks a limit is a result (feasibility), a stop that cannot be
routed raises traverse.RouteStopError naming the stop index.
"""

import hashlib
import json
from dataclasses import replace

import numpy as np
import pytest

from pipeline.engine import dijkstra, margin, physio, provenance, scenarios, traverse
from pipeline.engine.config import REPO
from pipeline.engine.geo import validate
from pipeline.engine.graph import load_ws1_grid
from pipeline.engine.physio_core import DoseTiming, latest_departure_terms
from pipeline.engine.plan import build_plan
from pipeline.engine.synthetic import make_grid, plane
from pipeline.engine.tests.test_plan import _terrain, _tree

BUDGET, CHECK = 390.0, 30.0
# sha256 of route_nom_104.geojson + timeline_nom_104.json written by traverse.plan/write on the
# plane world below, computed with the code BEFORE R1 (commit 487d28c, the R0 base). route=None
# must keep writing exactly these bytes.
AUTO_DIGEST = "d8f2bac67b83f2c8e398b5ac2453e92d91560091e415d0a84ecd38e438d6c6d9"


@pytest.fixture(autouse=True)
def manifest_dir(tmp_path, monkeypatch):
    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "manifest"))
    return tmp_path / "manifest"


@pytest.fixture(scope="module")
def world():
    """test_scenarios.plane_world: a 3 % plane, the pad in the middle, three stations."""
    g = make_grid(plane(241, 3.0, 0.03), 3.0)
    pad = (120, 120)
    p = physio.params("nominal", suit_kg=104)
    tab = physio.grade_table(p)
    home = dijkstra.return_field(g, tab, pad)
    st = [{"id": "S1", "rc": (40, 100), "value": 0.6, "dwell_min": 30},
          {"id": "S2", "rc": (200, 60), "value": 0.5, "dwell_min": 30},
          {"id": "S3", "rc": (130, 220), "value": 0.9, "dwell_min": 30}]  # fmt: skip
    return g, pad, p, tab, home, st


def _plan(world, mi=None, route=None, budget=BUDGET, st=None, **kw):
    g, pad, p, tab, home, st0 = world
    mi = margin.inputs(p) if mi is None else mi
    return traverse.plan(g, tab, home, pad, st0 if st is None else st, budget, CHECK, mi,
                         route=route, **kw)  # fmt: skip


def _written(res, tmp_path, name="w") -> bytes:
    d = tmp_path / name
    traverse.write(res, "nom_104", d)
    return (d / "route_nom_104.geojson").read_bytes() + (d / "timeline_nom_104.json").read_bytes()


def _same_plan(a: traverse.Result, b: traverse.Result):
    assert a.order == b.order and a.total_min == b.total_min and a.value == b.value
    assert a.timeline == b.timeline and a.legs == b.legs and a.route == b.route
    assert a.track_min_margin == b.track_min_margin and a.dose == b.dose
    assert a.margin_terms == b.margin_terms and a.t_star_min == b.t_star_min
    for x, y in zip(a.leg_paths, b.leg_paths, strict=True):
        assert x["from"] == y["from"] and x["to"] == y["to"] and x["t_start"] == y["t_start"]
        assert np.array_equal(x["cells"], y["cells"]) and np.array_equal(x["tau"], y["tau"])


def _storm(t_star, peak_mgy_h):
    """A DoseTiming whose rate jumps to peak_mgy_h around t* (tau = 60 x 0.5 / rate)."""
    t = np.array([-1000.0, t_star - 5.0, t_star, t_star + 120.0, 2000.0])
    r = np.array([0.01, 0.01, peak_mgy_h, peak_mgy_h, 0.01])
    return DoseTiming(t_star, t, r, 0.5, 0.0, "synthetic storm (test)")


# ------------------------------------------------------------------ (a) route=None unchanged


def test_route_none_is_byte_identical(world, tmp_path):
    """(a) route=None (and no kwarg) writes the bytes the pre-R1 code wrote."""
    g, pad, p, tab, home, st = world
    a = traverse.plan(g, tab, home, pad, st, BUDGET, CHECK, margin.inputs(p))
    b = _plan(world, route=None)
    _same_plan(a, b)
    assert a.feasibility is None and b.feasibility is None
    wa, wb = _written(a, tmp_path, "a"), _written(b, tmp_path, "b")
    assert wa == wb
    assert hashlib.sha256(wa).hexdigest() == AUTO_DIGEST


# ------------------------------------------------------------------ (b) the auto order


@pytest.mark.parametrize("dose", [False, True])
def test_auto_order_reproduces_the_auto_plan(world, tmp_path, dose):
    """(b) route = the auto plan's own order: same legs, timeline, margins, bytes."""
    kw = {"dose_fn": lambda ts: _storm(ts, 0.05)} if dose else {}
    auto = _plan(world, **kw)
    assert len(auto.order) == 3
    res = _plan(world, route=list(auto.order), **kw)
    assert res.feasibility == {"feasible": True}
    _same_plan(auto, res)
    assert _written(auto, tmp_path, "a") == _written(res, tmp_path, "b")
    if dose:
        assert res.dose is not None and not res.dose["violation"]


# ------------------------------------------------------------------ (c) order as given


def test_reversed_order_is_kept(world):
    """(c) the reversed order is planned as given: legs, arrivals and order follow the input."""
    auto = _plan(world)
    rev = list(reversed(auto.order))
    res = _plan(world, route=rev)
    assert res.order == rev and res.feasibility == {"feasible": True}
    assert [lg["from"] for lg in res.legs] == ["pad", *rev]
    assert [lg["to"] for lg in res.legs] == [*rev, "pad"]
    assert [e["station"] for e in res.timeline if e["event"] == "arrive"] == rev
    assert res.total_min >= auto.total_min - 1e-9  # the DP picked the fastest all-station order
    assert res.n_feasible_subsets is None
    validate(res.timeline, "timeline.schema.json")
    validate(res.route, "route.schema.json")
    # a sub-route with stop dicts (plan_inputs.route form) is also kept as given
    two = _plan(world, route=[{"station": "S3"}, {"station": "S1"}])
    assert two.order == ["S3", "S1"] and [lg["to"] for lg in two.legs] == ["S3", "S1", "pad"]
    assert two.value == pytest.approx(0.9 + 0.6)


# ------------------------------------------------------------------ (d) infeasible orders


def _legs_of(world, order):
    """Feasible walk of `order` without the binding limit: (departure t, LegPath) per leg."""
    res = _plan(world, route=order)
    assert res.feasibility == {"feasible": True}
    return [(x["t_start"], x) for x in res.leg_paths]


def _check_partial(res, tmp_path, n_legs):
    f = res.feasibility
    assert f["legs_planned"] == n_legs and len(res.legs) == n_legs
    assert len(res.route["features"]) == n_legs
    assert not any(e["event"] == "return" for e in res.timeline) or n_legs == 0
    validate(res.timeline, "timeline.schema.json")
    validate(res.route, "route.schema.json")
    traverse.write(res, "nom_104", tmp_path)
    rt = json.loads((tmp_path / "route_nom_104.geojson").read_text())
    assert [ft["properties"]["leg"] for ft in rt["features"]] == list(range(1, n_legs + 1))
    _valid_feasibility(f)
    assert set(f) == {"feasible", "leg", "from", "to", "limit", "shortfall_min", "legs_planned"}


def _valid_feasibility(f):
    """The block maps 1:1 onto contracts/backend/run_record.schema.json feasibility."""
    import jsonschema

    sch = json.loads((REPO / "contracts/backend/run_record.schema.json").read_text())
    jsonschema.validate(f, sch["properties"]["feasibility"])


def test_daylight_fails_on_the_second_leg(world, tmp_path):
    """(d) t_dark 10 min short of what leg 1 (S1 -> S2) needs: leg 1, daylight, 10 min."""
    g, pad, p, tab, home, st = world
    order = ["S1", "S2", "S3"]
    legs = _legs_of(world, order)
    t1, lp1 = legs[1]
    need1 = float(np.max(lp1["tau"] + lp1["t_home"]))  # latest daylight = t_dark - need1
    t_dark = t1 + need1 - 10.0
    t0, lp0 = legs[0]
    assert float(np.max(lp0["tau"] + lp0["t_home"])) <= t_dark  # leg 0 is fine
    res = _plan(world, mi=margin.inputs(p, t_dark_min=t_dark), route=order)
    assert res.feasibility == {"feasible": False, "leg": 1, "from": "S1", "to": "S2",
                               "limit": "daylight", "shortfall_min": pytest.approx(10.0, abs=0.01),
                               "legs_planned": 1}  # fmt: skip
    _check_partial(res, tmp_path, 1)
    assert res.order == ["S1"] and res.legs[0]["from"] == "pad" and res.legs[0]["to"] == "S1"
    # the leg written is the leg of the feasible walk
    assert res.leg_paths[0]["t_start"] == t0
    assert np.array_equal(res.leg_paths[0]["cells"], lp0["cells"])


def test_o2_fails_on_the_way_home(world, tmp_path):
    """(d) O2 capacity cut so only the way home fails: leg 3 (S3 -> pad), O2, shortfall =
    departure - latest departure at the effort-cap rate (D45)."""
    g, pad, p, tab, home, st = world
    order = ["S1", "S2", "S3"]
    legs = _legs_of(world, order)
    mi = margin.inputs(p)
    t3, lp3 = legs[3]
    lat3 = latest_departure_terms(mi, 0.0, 0.0, mi.o2_rate_l_min, lp3["tau"], lp3["o2"],
                                  lp3["t_home"], lp3["o2_home"])["O2"]  # fmt: skip
    cut = (lat3 - t3 + 7.0) * mi.o2_rate_l_min  # 7 min of O2 at the effort cap short on leg 3
    mi2 = replace(mi, o2_capacity_l=mi.o2_capacity_l - cut)
    for t, lp in legs[:3]:  # earlier legs still pass
        lat = latest_departure_terms(mi2, 0.0, 0.0, mi2.o2_rate_l_min, lp["tau"], lp["o2"],
                                     lp["t_home"], lp["o2_home"])  # fmt: skip
        assert t <= min(lat.values())
    res = _plan(world, mi=mi2, route=order)
    f = res.feasibility
    assert (f["leg"], f["from"], f["to"], f["limit"]) == (3, "S3", "pad", "O2")
    assert f["shortfall_min"] == pytest.approx(7.0, abs=0.01)
    _check_partial(res, tmp_path, 3)
    assert res.order == order  # every station reached, the way home is the failing leg
    assert [e["event"] for e in res.timeline if e["station"] == "S3"][:1] == ["arrive"]


def test_eva_duration_margin_and_budget(world, tmp_path):
    """(d) EVA duration: long dwells break the D28 term (argmin = EVA duration); with the term
    off, the DP budget (budget_min) is the limit: arrival + dwell - budget_min."""
    g, pad, p, tab, home, st = world
    long = [{**s, "dwell_min": 150} for s in st]
    big_o2 = replace(margin.inputs(p), o2_capacity_l=5000.0)  # O2 never binds here
    res = _plan(world, mi=big_o2, route=["S1", "S2", "S3"], st=long)
    f = res.feasibility
    assert f["feasible"] is False and f["limit"] == "EVA duration" and f["shortfall_min"] > 0
    # the answer by the documented rule: departure - min over the leg of (budget - tau - T_home)
    t, lp = _legs_of(world, ["S1", "S2", "S3"])[f["leg"]]
    dep = t + 120.0 * f["leg"]  # each earlier dwell is 120 min longer
    exp = dep - float(np.min(BUDGET - lp["tau"] - lp["t_home"]))
    assert f["shortfall_min"] == pytest.approx(exp, abs=0.01)
    _check_partial(res, tmp_path / "m", f["leg"])

    legs = _legs_of(world, ["S1", "S2"])
    end1 = legs[1][0] + legs[1][1]["tau"][-1] + 30.0  # arrival at S2 + its dwell
    mi = margin.inputs(p, eva=False)
    res = _plan(world, mi=mi, route=["S1", "S2"], budget=end1 - 5.0)
    # arrival + dwell at S2 is 5 min over the budget: the crew cannot leave S2 in time
    assert res.feasibility == {"feasible": False, "leg": 2, "from": "S2", "to": "pad",
                               "limit": "EVA duration",
                               "shortfall_min": pytest.approx(5.0, abs=0.01),
                               "legs_planned": 2}  # fmt: skip
    _check_partial(res, tmp_path / "b", 2)
    # the way home 5 min over the budget
    end2 = legs[2][0] + legs[2][1]["tau"][-1]
    res = _plan(world, mi=mi, route=["S1", "S2"], budget=end2 - 5.0)
    f = res.feasibility
    assert (f["leg"], f["from"], f["to"], f["limit"]) == (2, "S2", "pad", "EVA duration")
    assert f["shortfall_min"] == pytest.approx(5.0, abs=0.01)


def test_timed_dose_violation(world, tmp_path):
    """(d) D39: a storm strong enough that tau_dose < T_home on the route fails the leg of the
    first violating track point (t* placed on the full order, as the auto path); shortfall =
    the lowest dose margin on that leg (its dwell included)."""
    peak = 0.5 * 60.0 / 5.0  # 6 mGy/h: tau = 5 min during the storm
    order = list(_plan(world).order)
    auto = _plan(world, dose_fn=lambda ts: _storm(ts, peak))
    assert auto.order == order and auto.dose["violation"]  # auto reports, the route fails
    res = _plan(world, route=order, dose_fn=lambda ts: _storm(ts, peak))
    f = res.feasibility
    assert f["feasible"] is False and f["limit"] == "dose"
    # expected from the full walk of the same order with the same dose timing (= auto's walk)
    assert res.t_star_min == auto.t_star_min
    t, th = auto.track[0], auto.track[2]
    m = _storm(auto.t_star_min, peak).tau_min(t) - th
    tf = t[np.flatnonzero(m < 0)[0]]
    ends = [x["t_start"] + x["tau"][-1] for x in auto.leg_paths]
    leg = next(i for i, e in enumerate(ends) if tf <= e + 1e-9)
    lo = ends[leg - 1] if leg else -1.0
    on = (t > lo - 1e-9) & (t <= ends[leg] + 1e-9)
    assert f["leg"] == leg and f["legs_planned"] == leg
    assert f["shortfall_min"] == pytest.approx(-float(np.min(m[on])), abs=0.01)
    assert f["shortfall_min"] > 0
    _check_partial(res, tmp_path, leg)


# ------------------------------------------------------------------ (e) bad stops


def test_bad_stops_raise_with_the_index(world):
    with pytest.raises(traverse.RouteStopError) as e:
        _plan(world, route=["S1", "S9", "S2"])
    assert (e.value.index, e.value.code) == (1, "route_station_unknown")
    with pytest.raises(traverse.RouteStopError) as e:
        _plan(world, route=["S1", "S2", "S1"])
    assert (e.value.index, e.value.code) == (2, "route_station_duplicate")
    with pytest.raises(traverse.RouteStopError) as e:
        traverse.resolve_route(["S2", "S7"], world[5], {"S7": "no access cell"})
    assert (e.value.index, e.value.code) == (1, "route_point_unreachable")
    with pytest.raises(traverse.RouteStopError) as e:
        _plan(world, route=[])
    assert e.value.index == 0
    with pytest.raises(NotImplementedError):
        _plan(world, route=[{"lon": 137.4, "lat": -4.77}])


def test_unreachable_station_raises(world):
    """A station with no walk home (walled in) is route_point_unreachable at its index; the
    auto path leaves it out as before."""
    elev = plane(241, 3.0, 0.03)
    g = make_grid(elev, 3.0)
    walled = g.passable.copy()
    walled[10:21, 10] = walled[10:21, 20] = walled[10, 10:21] = walled[20, 10:21] = False
    g = replace(g, passable=walled)
    pad = (120, 120)
    p = physio.params("nominal", suit_kg=104)
    tab = physio.grade_table(p)
    home = dijkstra.return_field(g, tab, pad)
    st = [*world[5], {"id": "S4", "rc": (15, 15), "value": 1.0, "dwell_min": 30}]
    assert not np.isfinite(home.t_min[15, 15])
    auto = traverse.plan(g, tab, home, pad, st, BUDGET, CHECK, margin.inputs(p))
    assert "S4" in auto.unreachable
    with pytest.raises(traverse.RouteStopError) as e:
        traverse.plan(g, tab, home, pad, st, BUDGET, CHECK, margin.inputs(p),
                      route=["S1", "S4"])  # fmt: skip
    assert (e.value.index, e.value.code) == (1, "route_point_unreachable")


# ------------------------------------------------------------------ (f) determinism


def test_route_is_deterministic(world, tmp_path):
    a = _plan(world, route=["S3", "S1", "S2"])
    b = _plan(world, route=["S3", "S1", "S2"])
    assert _written(a, tmp_path, "a") == _written(b, tmp_path, "b")
    assert a.feasibility == b.feasibility


# ------------------------------------------------------------------ build_plan


def test_build_plan_route(tmp_path):
    """build_plan(route=...): the route scenario is planned in the given order, the summary
    carries route + feasibility; every file not tied to the route is the auto run's; bad
    stations fail before any work; route=None writes no route block."""
    terr = _terrain(tmp_path)
    grid = load_ws1_grid(terr)
    kw = dict(pad_lonlat=None, scenario_ids=["nom_104"],
              settings=scenarios.settings_from_config(None), terrain_dir=terr, cond={},
              partner=False, verbose=False)  # fmt: skip
    auto = build_plan(grid, out_dir=tmp_path / "auto", **kw)
    assert "route" not in auto and "feasibility" not in auto["routes"]["nom_104"]
    order = auto["routes"]["nom_104"]["order"]
    assert len(order) == 2
    rev = list(reversed(order))
    summ = build_plan(grid, out_dir=tmp_path / "ord", route=rev, **kw)
    assert summ["route"] == {"mode": "ordered", "stops": rev, "scenario": "nom_104",
                             "feasibility": {"nom_104": {"feasible": True}}}  # fmt: skip
    assert summ["routes"]["nom_104"]["order"] == rev
    assert summ["routes"]["nom_104"]["feasibility"] == {"feasible": True}
    ta, tb = _tree(tmp_path / "auto"), _tree(tmp_path / "ord")
    assert sorted(ta) == sorted(tb)
    route_files = {"public/route_nom_104.geojson", "public/timeline_nom_104.json",
                   "summary.json"}  # fmt: skip
    route_files |= {k for k in ta if k.startswith("public/cards/")}
    assert [k for k in ta if ta[k] != tb[k] and k not in route_files] == []
    # same order as auto: the whole tree equals the auto run (summary apart from route keys)
    same = build_plan(grid, out_dir=tmp_path / "same", route=order, **kw)
    tc = _tree(tmp_path / "same")
    assert [k for k in ta if ta[k] != tc[k] and k != "summary.json"] == []
    assert same["routes"]["nom_104"]["legs"] == auto["routes"]["nom_104"]["legs"]
    with pytest.raises(traverse.RouteStopError) as e:
        build_plan(grid, out_dir=tmp_path / "bad", route=[order[0], "S99"], **kw)
    assert (e.value.index, e.value.code) == (1, "route_station_unknown")
    assert not (tmp_path / "bad").exists()  # refused before any work

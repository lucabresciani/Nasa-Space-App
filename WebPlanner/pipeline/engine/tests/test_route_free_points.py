"""D97 WP2b known-answer tests: an ordered route with free points ({lon, lat, label?} stops).

Synthetic worlds only (docs/dummy.md, fixtures, not data). A free point is a synthetic station
W1, W2, ... (numbered among the free stops) with value 0, the default dwell and its access cell
in the scenario (waypoints.point_fields); on a station's lon/lat it is planned exactly as that
station. Invalid points, spacing violations and the scenario dependence of a point's access
cell raise traverse.RouteStopError naming the stop index; route=None stays byte-identical.
"""

import hashlib
import json

import numpy as np
import pytest

from pipeline.engine import access, dijkstra, margin, physio, provenance, scenarios, traverse
from pipeline.engine.config import load
from pipeline.engine.geo import lonlat_of_xy, validate
from pipeline.engine.graph import BLOCKED, UNKNOWN, load_ws1_grid
from pipeline.engine.plan import build_plan
from pipeline.engine.stations import bearing_dist, load_ws1_stations
from pipeline.engine.synthetic import dummy_world, make_grid, plane
from pipeline.engine.tests.test_plan import _terrain, _tree
from pipeline.engine.tests.test_route_ordered import AUTO_DIGEST

SID, CON = "nom_104", "con_104"
RADIUS = 50.0  # variants.yaml route.access_radius_m (D27)
DWELL = float(load("stations")["dwell_min"])

# dummy_world(3.0, half_m=700): 467 x 467 cells, pad at the centre (233, 233). Features as
# test_waypoints.py: SEALED pocket wider than the radius, CLIFF (all blocked), MID (18.5 deg:
# nominal 20 deg ok, conservative 17 deg not), HOLE (docs/dummy.md nodata hole: unknown).
SEALED, CLIFF, MID, HOLE = (380, 80), (100, 120), (60, 330), (351, 351)
S1, S2 = (153, 243), (293, 193)  # = test_plan._terrain's S1 / S2 (pad +- offsets)
A, B = (203, 323), (333, 293)  # open terrain, far from the stations and features


@pytest.fixture(autouse=True)
def manifest_dir(tmp_path, monkeypatch):
    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "manifest"))
    return tmp_path / "manifest"


def _ll(g, rc) -> tuple[float, float]:
    lon, lat = lonlat_of_xy(*g.xy_of_rc(*rc), g.crs)
    return float(lon), float(lat)


def _pt(g, rc, **kw) -> dict:
    lon, lat = _ll(g, rc)
    return {"lon": lon, "lat": lat, **kw}


def _features(g):
    """SEALED ring, CLIFF and MID discs on a grid (cell state and both slope arrays)."""
    g.cellstate = g.cellstate.copy()
    slopes = [a for a in ("maxslope", "slope") if getattr(g, a) is not None]
    for a in slopes:
        setattr(g, a, getattr(g, a).copy())
    rr, cc = np.mgrid[0 : g.shape[0], 0 : g.shape[1]]

    def d(c):
        return np.hypot(rr - c[0], cc - c[1])

    ring = (d(SEALED) >= 18.0) & (d(SEALED) < 20.0)
    cliff = d(CLIFF) <= 70.0 / 3.0
    mid = d(MID) <= 70.0 / 3.0
    g.cellstate[ring | cliff] = BLOCKED
    for a in slopes:
        getattr(g, a)[ring] = 60.0
        getattr(g, a)[cliff] = 40.0
        getattr(g, a)[mid] = 18.5
    assert g.cellstate[HOLE] == UNKNOWN
    return g


@pytest.fixture(scope="module")
def world():
    g, pad, _ = dummy_world(3.0, half_m=700.0)
    g = _features(g)
    p = physio.scenario_params(SID)
    home = dijkstra.return_field(g.with_nogo(p.nogo_deg), physio.grade_table(p), pad)
    st = []
    for sid, rc, val in (("S1", S1, 0.5), ("S2", S2, 0.6)):
        lon, lat = _ll(g, rc)
        st.append({"id": sid, "lon": lon, "lat": lat, "value": val, "dwell_min": DWELL})
    access.resolve(g, {SID: home}, st, RADIUS)
    assert all(s["access"][SID].dist_m == 0.0 for s in st)
    return g, pad, home, st


def _route(world, route, cond=None, **kw) -> traverse.Result:
    g, pad, home, st = world
    res, _ = scenarios.plan_route(g, pad, SID, home, st, cond or {}, None, route=route, **kw)
    return res


def _renamed(obj, a: str, b: str):
    """obj with the id a replaced by b (JSON round trip)."""
    return json.loads(json.dumps(obj).replace(f'"{a}"', f'"{b}"'))


def _written(res, tmp_path, name) -> bytes:
    d = tmp_path / name
    traverse.write(res, SID, d)
    return (d / f"route_{SID}.geojson").read_bytes() + (d / f"timeline_{SID}.json").read_bytes()


# ------------------------------------------------------------------ (1) a point on a station


def test_point_on_a_station_is_planned_as_that_station(world, tmp_path):
    """A free point exactly on S2's lon/lat gives S2's legs, timeline, margins, feasibility
    and track (ids aside): same access cell, same dwell (the config default), value 0."""
    g, _, _, st = world
    ref = _route(world, ["S1", "S2"])
    res = _route(world, ["S1", _pt(g, S2, label="my rock")])
    assert ref.feasibility == res.feasibility == {"feasible": True}
    assert res.order == ["S1", "W1"] and ref.order == ["S1", "S2"]
    assert res.legs == _renamed(ref.legs, "S2", "W1")
    assert res.timeline == _renamed(ref.timeline, "S2", "W1")
    assert res.route == _renamed(ref.route, "S2", "W1")
    assert res.total_min == ref.total_min and res.track_min_margin == ref.track_min_margin
    assert res.margin_terms == ref.margin_terms
    assert res.value == pytest.approx(0.5) and ref.value == pytest.approx(1.1)  # W1 scores 0
    for x, y in zip(res.leg_paths, ref.leg_paths, strict=True):
        assert np.array_equal(x["cells"], y["cells"]) and x["t_start"] == y["t_start"]
    a, b = _written(res, tmp_path, "w"), _written(ref, tmp_path, "s")
    assert a == b.replace(b'"S2"', b'"W1"')
    assert b"my rock" not in a  # labels never enter engine outputs
    # an infeasible order fails on the same leg with the same numbers
    t_dark = ref.leg_paths[1]["t_start"] + float(np.max(ref.leg_paths[1]["tau"]
                                                        + ref.leg_paths[1]["t_home"])) - 10.0
    fr = _route(world, ["S1", "S2"], cond={"t_dark_min": t_dark})
    fw = _route(world, ["S1", _pt(g, S2)], cond={"t_dark_min": t_dark})
    assert fr.feasibility["to"] == "S2" and fw.feasibility == _renamed(fr.feasibility, "S2", "W1")


# ------------------------------------------------------------------ (2) order and W ids


def test_mixed_route_in_order_with_w_ids(world):
    """[S1, W, S2] and [W, S1, W]: planned as given; W ids count free stops only."""
    g, _, _, _ = world
    res = _route(world, ["S1", _pt(g, A), {"station": "S2"}])
    assert res.feasibility == {"feasible": True}
    assert res.order == ["S1", "W1", "S2"]
    assert [lg["from"] for lg in res.legs] == ["pad", "S1", "W1", "S2"]
    assert [lg["to"] for lg in res.legs] == ["S1", "W1", "S2", "pad"]
    assert [e["station"] for e in res.timeline if e["event"] == "arrive"] == ["S1", "W1", "S2"]
    w1 = [e for e in res.timeline if e["station"] == "W1"]
    assert {e["event"] for e in w1} >= {"arrive", "leave", "turn_back"}
    arr = next(e["t_min"] for e in w1 if e["event"] == "arrive")
    assert next(e["t_min"] for e in w1 if e["event"] == "leave") == pytest.approx(arr + DWELL)
    assert res.value == pytest.approx(0.5 + 0.6)
    validate(res.timeline, "timeline.schema.json")
    validate(res.route, "route.schema.json")

    two = _route(world, [_pt(g, A), "S1", _pt(g, B, label="b")])
    assert two.order == ["W1", "S1", "W2"] and two.value == pytest.approx(0.5)
    assert [lg["to"] for lg in two.legs] == ["W1", "S1", "W2", "pad"]
    assert traverse.free_point_ids([_pt(g, A), "S1", {"station": "S2"}, _pt(g, B)]) == [
        "W1", None, None, "W2"]  # fmt: skip
    # the free point's access cell is its own cell (assessed, walkable): walk-in 0 m
    assert two.legs[0]["to_access_dist_m"] == 0.0


def test_free_point_access_cell_is_the_scenario_station_cell(world):
    """W's rc = padpick.station_cell under the scenario's slope rule (waypoints, D48)."""
    from pipeline.engine import padpick, waypoints

    g, _, _, _ = world
    p = physio.scenario_params(SID)
    make = scenarios.free_point_station(g, p)
    lon, lat = _ll(g, (S1[0] + 3, S1[1] + 40))
    w = make("W3", lon, lat)
    v = waypoints.point_validity(g, lon, lat, scenario=p)
    assert w["id"] == "W3" and w["rc"] == v["access_cell"]
    assert w["access_dist_m"] == round(v["access_dist_m"], 1)
    assert w["value"] == 0.0 and w["dwell_min"] == DWELL
    cell = padpick.station_cell(g.with_nogo(p.nogo_deg), {"lon": lon, "lat": lat}, RADIUS,
                                physio.grade_table(p))  # fmt: skip
    assert w["rc"] == cell[1:]


# ------------------------------------------------------------------ (3) invalid points


@pytest.mark.parametrize(("where", "code"), [
    ("outside", "route_point_outside_grid"), (HOLE, "route_point_unassessed"),
    (CLIFF, "route_point_not_walkable"), (SEALED, "route_point_unreachable")])  # fmt: skip
@pytest.mark.parametrize("index", [0, 1, 2])
def test_point_error_maps_to_route_stop_error(world, where, code, index):
    """Each waypoints.PointError code becomes RouteStopError(index of the stop, code)."""
    g, _, _, _ = world
    bad = {"lon": 120.0, "lat": 10.0} if where == "outside" else _pt(g, where)
    route = ["S1", _pt(g, A)]
    route.insert(index, bad)
    with pytest.raises(traverse.RouteStopError) as e:
        _route(world, route)
    assert (e.value.index, e.value.code) == (index, code)
    assert e.value.message.startswith("W2: " if index == 2 else "W1: ")


@pytest.mark.parametrize("scenario", [SID, CON])
def test_point_precheck_equals_validity_codes_1_to_3(world, scenario):
    """waypoints.point_precheck (WP4's cheap 422 check): checks 1-3 only, no Dijkstra; its
    code equals point_validity's for codes 1-3 and it is None for a valid point (and for a
    sealed pocket, code 4, which only point_validity finds)."""
    from pipeline.engine import waypoints

    g, _, _, _ = world
    cases = [({"lon": 120.0, "lat": 10.0}, "route_point_outside_grid"),
             ({"lon": float("nan"), "lat": 0.0}, "route_point_outside_grid"),
             (_pt(g, HOLE), "route_point_unassessed"), (_pt(g, CLIFF), "route_point_not_walkable"),
             (_pt(g, MID), None if scenario == SID else "route_point_not_walkable"),
             (_pt(g, A), None)]  # fmt: skip
    for pt, code in cases:
        pre = waypoints.point_precheck(g, pt["lon"], pt["lat"], scenario=scenario)
        v = waypoints.point_validity(g, pt["lon"], pt["lat"], scenario=scenario)
        assert v["code"] == code and (pre is None if code is None else pre[0] == code), pt
        assert pre is None or isinstance(pre[1], str) and pre[1]
    sealed = _pt(g, SEALED)
    assert waypoints.point_precheck(g, sealed["lon"], sealed["lat"], scenario=scenario) is None
    assert waypoints.point_validity(g, sealed["lon"], sealed["lat"],
                                    scenario=scenario)["code"] == "route_point_unreachable"


def test_resolve_route_without_resolver(world):
    """Without point_station a free point is only named (the cheap check before any work);
    traverse.plan needs the resolver; a malformed stop is route_station_unknown."""
    g, pad, home, st = world
    lon, lat = _ll(g, A)
    out = traverse.resolve_route(["S1", {"lon": lon, "lat": lat, "label": "x"}], st)
    assert out[0] is st[0] and out[1] == {"id": "W1", "lon": lon, "lat": lat}
    with pytest.raises(NotImplementedError):
        traverse.plan(g, physio.grade_table(physio.scenario_params(SID)), home, pad, [], 390.0,
                      30.0, margin.inputs(physio.scenario_params(SID)),
                      route=[{"lon": lon, "lat": lat}])  # fmt: skip
    for bad in ({"lon": "x", "lat": lat}, {"lon": lon}, {"lon": True, "lat": lat}):
        with pytest.raises(traverse.RouteStopError) as e:
            traverse.resolve_route(["S1", bad], st)
        assert (e.value.index, e.value.code) == (1, "route_station_unknown")


# ------------------------------------------------------------------ (4) spacing


def test_check_spacing_names_both_stops(world):
    g, pad, _, st = world
    near = (S1[0], S1[1] + 7)  # 21 m east of S1
    stops = traverse.resolve_route(["S1", "S2", _pt(g, near)], st)
    assert bearing_dist(*_ll(g, S1), *_ll(g, near))[1] == pytest.approx(21.0, abs=0.5)
    traverse.check_spacing(stops, _ll(g, pad), 20.0)  # 21 m >= 20 m: fine
    with pytest.raises(traverse.RouteStopError) as e:
        traverse.check_spacing(stops, _ll(g, pad), 50.0)
    assert (e.value.index, e.value.code) == (2, "route_stop_spacing")
    assert "W1" in e.value.message and "S1" in e.value.message and "50 m" in e.value.message
    stops = traverse.resolve_route([_pt(g, A), _pt(g, (pad[0] + 10, pad[1]))], st)
    with pytest.raises(traverse.RouteStopError) as e:
        traverse.check_spacing(stops, _ll(g, pad), 50.0)
    assert (e.value.index, e.value.code) == (1, "route_stop_spacing")
    assert "W2" in e.value.message and "the pad" in e.value.message
    # of several violations: the lowest reported (later-stop) index
    stops = traverse.resolve_route([_pt(g, A), "S1", _pt(g, (A[0] + 5, A[1])),
                                    _pt(g, (S1[0] + 5, S1[1]))], st)  # fmt: skip
    with pytest.raises(traverse.RouteStopError) as e:
        traverse.check_spacing(stops, None, 50.0)
    assert e.value.index == 2 and "W1" in e.value.message and "W2" in e.value.message


@pytest.mark.parametrize("case", ["two_stops", "two_points", "pad"])
def test_spacing_violation_raises_before_any_stage(tmp_path, case):
    terr = _terrain(tmp_path)
    grid = load_ws1_grid(terr)
    pad = scenarios.pad_rc(grid)
    route = {"two_stops": ["S1", "S2", _pt(grid, (S1[0], S1[1] + 7))],
             "two_points": ["S2", _pt(grid, A), _pt(grid, (A[0] + 10, A[1]))],
             "pad": ["S1", _pt(grid, (pad[0] + 10, pad[1]))]}[case]  # fmt: skip
    stages = []
    with pytest.raises(traverse.RouteStopError) as e:
        build_plan(grid, pad_lonlat=None, scenario_ids=[SID],
                   settings=scenarios.settings_from_config(None), terrain_dir=terr, cond={},
                   partner=False, verbose=False, out_dir=tmp_path / "bad", route=route,
                   route_min_spacing_m=50.0, on_stage=lambda n, f: stages.append(n))  # fmt: skip
    assert (e.value.index, e.value.code) == ({"two_stops": 2, "two_points": 2, "pad": 1}[case],
                                             "route_stop_spacing")  # fmt: skip
    assert stages == [] and not (tmp_path / "bad").exists()


# ------------------------------------------------------------------ (5) route=None unchanged


def test_route_none_is_byte_identical(tmp_path):
    """WP1's digest (pre-R1 bytes) on WP1's plane world, with this code."""
    g = make_grid(plane(241, 3.0, 0.03), 3.0)
    pad = (120, 120)
    p = physio.params("nominal", suit_kg=104)
    tab = physio.grade_table(p)
    home = dijkstra.return_field(g, tab, pad)
    st = [{"id": "S1", "rc": (40, 100), "value": 0.6, "dwell_min": 30},
          {"id": "S2", "rc": (200, 60), "value": 0.5, "dwell_min": 30},
          {"id": "S3", "rc": (130, 220), "value": 0.9, "dwell_min": 30}]  # fmt: skip
    res = traverse.plan(g, tab, home, pad, st, 390.0, 30.0, margin.inputs(p))
    assert res.feasibility is None
    assert hashlib.sha256(_written(res, tmp_path, "a")).hexdigest() == AUTO_DIGEST


# ------------------------------------------------------------------ (6) infeasible with W


def test_infeasible_order_names_w_ids(world, tmp_path):
    """Daylight cut 10 min short on leg 1 (S1 -> W1), then on the way home from W2."""
    g, _, _, _ = world
    route = ["S1", _pt(g, A), _pt(g, B)]
    ok = _route(world, route)
    assert ok.feasibility == {"feasible": True} and ok.order == ["S1", "W1", "W2"]

    def need(k):
        lp = ok.leg_paths[k]
        return lp["t_start"] + float(np.max(lp["tau"] + lp["t_home"]))

    res = _route(world, route, cond={"t_dark_min": need(1) - 10.0})
    assert need(0) <= need(1) - 10.0
    assert res.feasibility == {"feasible": False, "leg": 1, "from": "S1", "to": "W1",
                               "limit": "daylight", "shortfall_min": pytest.approx(10.0, abs=0.01),
                               "legs_planned": 1}  # fmt: skip
    assert res.order == ["S1"] and len(res.legs) == 1
    t_dark = need(3) - 5.0
    assert all(need(k) <= t_dark for k in range(3))
    res = _route(world, route, cond={"t_dark_min": t_dark})
    f = res.feasibility
    assert (f["leg"], f["from"], f["to"], f["limit"]) == (3, "W2", "pad", "daylight")
    assert f["shortfall_min"] == pytest.approx(5.0, abs=0.01) and f["legs_planned"] == 3
    assert [lg["to"] for lg in res.legs] == ["S1", "W1", "W2"]
    import jsonschema

    from pipeline.engine.config import REPO

    sch = json.loads((REPO / "contracts/backend/run_record.schema.json").read_text())
    jsonschema.validate(f, sch["properties"]["feasibility"])
    validate(res.timeline, "timeline.schema.json")
    validate(res.route, "route.schema.json")


# ------------------------------------------------------------------ (7) determinism


def test_free_point_route_is_deterministic(world, tmp_path):
    g, _, _, _ = world
    route = [_pt(g, B), "S2", _pt(g, A), "S1"]
    a, b = _route(world, route), _route(world, route)
    assert _written(a, tmp_path, "a") == _written(b, tmp_path, "b")
    assert a.feasibility == b.feasibility and a.order == ["W1", "S2", "W2", "S1"]


# ------------------------------------------------------------------ build_plan


def _build_kw(tmp_path, **kw):
    terr = _terrain(tmp_path)
    grid = _features(load_ws1_grid(terr))
    st, missing = load_ws1_stations(terr / "stations.json")
    base = dict(pad_lonlat=None, scenario_ids=[SID], settings=scenarios.settings_from_config(None),
                stations_list=st, stations_missing=missing, cond={}, partner=False,
                verbose=False)  # fmt: skip
    return grid, {**base, **kw}


def test_build_plan_with_free_points(tmp_path):
    """build_plan: W ids in the route files; no card, trade-table or other entry for a free
    point; the label dropped from the summary; deterministic tree."""
    grid, kw = _build_kw(tmp_path)
    route = ["S2", _pt(grid, A, label="look here"), "S1"]
    summ = build_plan(grid, out_dir=tmp_path / "a", route=route, route_min_spacing_m=50.0, **kw)
    lon, lat = _ll(grid, A)
    assert summ["route"] == {"mode": "ordered", "stops": ["S2", {"lon": lon, "lat": lat}, "S1"],
                             "scenario": SID, "feasibility": {SID: {"feasible": True}}}
    assert summ["routes"][SID]["order"] == ["S2", "W1", "S1"]
    tree = _tree(tmp_path / "a")
    with_w = sorted(k for k, v in tree.items() if b'"W1"' in v)
    assert with_w == ["public/route_nom_104.geojson", "public/timeline_nom_104.json",
                      "summary.json"]  # fmt: skip
    assert not any(b"look here" in v for v in tree.values())
    assert not any("W1" in k for k in tree)  # no card file for W1
    build_plan(grid, out_dir=tmp_path / "b", route=route, route_min_spacing_m=50.0, **kw)
    assert _tree(tmp_path / "b") == tree


def test_build_plan_free_point_scenario_dependence(tmp_path):
    """A point walkable at nominal (20 deg) but not at conservative (17 deg): the default
    scenario is planned, con_104 is skipped (summary route.skipped); in the default scenario
    an invalid point raises RouteStopError with its index."""
    grid, kw = _build_kw(tmp_path, scenario_ids=[SID, CON], route_scenarios=[SID, CON])
    route = ["S1", _pt(grid, MID)]
    summ = build_plan(grid, out_dir=tmp_path / "a", route=route, **kw)
    assert summ["route"]["skipped"] == {CON: {"stop": 1, "id": "W1",
                                              "code": "route_point_not_walkable"}}  # fmt: skip
    assert list(summ["route"]["feasibility"]) == [SID] and list(summ["routes"]) == [SID]
    assert summ["routes"][SID]["order"] == ["S1", "W1"]
    assert not (tmp_path / "a/public/route_con_104.geojson").exists()
    with pytest.raises(traverse.RouteStopError) as e:
        build_plan(grid, out_dir=tmp_path / "b", route=["S1", "S2", _pt(grid, CLIFF)], **kw)
    assert (e.value.index, e.value.code) == (2, "route_point_not_walkable")
    # only non-default route scenarios, all skipped: nothing to plan, the first one raises
    with pytest.raises(traverse.RouteStopError) as e:
        build_plan(grid, out_dir=tmp_path / "c", route=route, **{**kw, "route_scenarios": [CON]})
    assert (e.value.index, e.value.code) == (1, "route_point_not_walkable")


def test_build_plan_station_without_access_in_a_stricter_scenario(tmp_path, monkeypatch):
    """Orchestrator finding on WP1: a station with an access cell in the default scenario
    (nom_104) but none in con_104 (as S7, D46) skips con_104 (route.skipped, no feasibility
    entry, no route/timeline files) instead of failing the job; in the default scenario a
    station without an access cell still raises. route=None is not affected."""
    grid, kw = _build_kw(tmp_path, scenario_ids=[SID, CON], route_scenarios=[SID, CON])
    s3 = {**kw["stations_list"][0], "id": "S3", "card": "cards/S3.json"}
    s3["lon"], s3["lat"] = _ll(grid, MID)  # 18.5 deg disc wider than the access radius
    st = [*kw["stations_list"], s3]
    kw = {**kw, "stations_list": st}
    summ = build_plan(grid, out_dir=tmp_path / "a", route=["S1", "S3", _pt(grid, A)], **kw)
    assert summ["route"]["skipped"] == {CON: {"stop": 1, "id": "S3",
                                              "code": "route_point_unreachable"}}  # fmt: skip
    assert summ["route"]["feasibility"] == {SID: {"feasible": True}}
    assert summ["routes"][SID]["order"] == ["S1", "S3", "W1"] and CON not in summ["routes"]
    pub = tmp_path / "a/public"
    assert (pub / f"route_{SID}.geojson").exists() and (pub / f"timeline_{SID}.json").exists()
    assert not (pub / f"route_{CON}.geojson").exists()
    assert not (pub / f"timeline_{CON}.json").exists()
    # without S3 in the route con_104 is planned as before
    summ = build_plan(grid, out_dir=tmp_path / "b", route=["S1", _pt(grid, A)], **kw)
    assert "skipped" not in summ["route"] and set(summ["route"]["feasibility"]) == {SID, CON}
    # the auto plan runs both scenarios (S3 left out of con_104's stations as before)
    auto = build_plan(grid, out_dir=tmp_path / "c", **kw)
    assert "route" not in auto and set(auto["routes"]) == {SID, CON}
    assert "S3" in auto["routes"][CON]["no_access"]
    # default scenario con_104 (route_scenarios [CON] with CON the default): it raises
    kw2 = {**kw, "route_scenarios": [CON]}
    import pipeline.engine.plan as plan_mod

    real = plan_mod.load

    def load_con(name):
        cfg = real(name)
        if name == "variants":
            cfg = {**cfg, "scenarios": {**cfg["scenarios"], "default": CON}}
        return cfg

    monkeypatch.setattr(plan_mod, "load", load_con)
    with pytest.raises(traverse.RouteStopError) as e:
        build_plan(grid, out_dir=tmp_path / "d", route=["S1", "S3"], **kw2)
    assert (e.value.index, e.value.code) == (1, "route_point_unreachable")

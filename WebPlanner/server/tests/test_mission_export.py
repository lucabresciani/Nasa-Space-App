"""mission.json for the simulator from live jobs (WP9b; D103, D110; contracts/bundle/
mission.schema.json, README "Mission file").

Known answers (written before the code), on the synthetic world of the plan job tests:
- an ordered route job writes mission.json, lists it in manifest.json with kind "sim_plan" (the
  "mission" exporter), and it validates against the schema; origin computed_live with
  config/backend.yaml labels.live; the planner's routing grid is the engine's (3 m);
- the waypoints are the route's stops in route order, legs out ... out + one home leg, the
  path rows one per route vertex with the engine's times; the title and free-point labels of the
  record inputs are carried;
- feasible = the run record's feasibility for an ordered route, true for an auto plan; an
  infeasible route keeps only the planned legs (no home leg) and says feasible false;
- an auto plan also exports;
- frame: the pad is (0, 0) (first and last path row), a station's x/y equal tools/make_bundle
  Frame.local of its stations.json lon/lat, z = DEM height - pad elev_m;
- deterministic: the same tree gives the same bytes and mission_id (the id rule of
  tests/test_mission_contract.py);
- parity never compares it (parity_harness.server_files), and the run record lists it.
"""

from __future__ import annotations

import copy
import hashlib
import json
import shutil
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from pipeline.engine import provenance  # noqa: E402
from server.engine import exporters, jobs, mission, plan_job  # noqa: E402
from server.engine import route as route_mod  # noqa: E402
from server.engine.hashing import canonical_inputs  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests import parity_harness as H  # noqa: E402
from server.tests import test_plan_job as PJ  # noqa: E402
from server.tests.test_plan_job import Conn, custom_inputs  # noqa: E402

world = PJ.world  # the synthetic-world fixture of the plan job tests, by name
TITLE = "Ridge loop, my order"


def _id(doc: dict) -> str:
    """tests/test_mission_contract.py mission_id (export.ts finalizeMission)."""
    blank = dict(doc, mission_id="", created_utc="")
    text = json.dumps(blank, separators=(",", ":"), ensure_ascii=False)
    return "m-" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _run(world: Path, root: Path, raw: dict) -> dict:
    """run_plan_job in this process (as test_route_job does); returns tree, record bits."""
    inp = route_mod.record_inputs(raw, canonical_inputs(raw))
    out, pub = root / ".job-x", root / "public"
    out.mkdir(parents=True)
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("HL_SERVER_DATA", str(world))
        mp.setenv(provenance.FRAGMENT_DIR_ENV, str(root / "stray_manifest"))
        ctx = jobs.JobContext(Conn(pub), "j_mission", out, pub, plan_job.STAGES)
        extra = plan_job.run_plan_job(inp, ctx)
    return {"inputs": inp, "tree": pub, "extra": extra}


@pytest.fixture(scope="module")
def ordered(world, tmp_path_factory):
    raw = {**custom_inputs(world / "terrain"), "title": TITLE,
           "route": {"mode": "ordered", "stops": [{"station": "S2"}, {"station": "S1"}]}}
    return _run(world, tmp_path_factory.mktemp("ordered"), raw)


@pytest.fixture(scope="module")
def auto(world, tmp_path_factory):
    return _run(world, tmp_path_factory.mktemp("auto"), custom_inputs(world / "terrain"))


def _doc(run: dict) -> dict:
    return json.loads((run["tree"] / mission.FILE).read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------- registry ----
def test_mission_exporter_is_registered():
    assert exporters.EXPORTERS["mission"] is mission.export_mission
    assert mission.KIND == "sim_plan" and mission.FILE == "mission.json"


def test_exporter_without_a_plan_context_writes_nothing(tmp_path):
    assert mission.export_mission(tmp_path, {}) == []
    assert mission.export_mission(tmp_path) == []
    assert list(tmp_path.iterdir()) == []


def test_parity_never_compares_it():
    assert mission.FILE not in H.server_files()


# ------------------------------------------------------------------------ ordered job ----
def test_ordered_job_writes_a_valid_mission(ordered):
    doc = _doc(ordered)
    assert mission.schema_errors(doc) == []
    man = json.loads((ordered["tree"] / "manifest.json").read_text(encoding="utf-8"))
    e = man["export.mission.mission.json"]
    assert (e["kind"], e["file"], e["exporter"]) == ("sim_plan", "mission.json", "mission")
    assert doc["origin"] == "computed_live"
    assert doc["origin_label"] == settings().labels.live
    assert doc["planner"]["routing_grid_res_m"] == 3
    assert doc["planner"]["elevation_res_m"] == 3
    assert doc["planner"]["files"] == {"route": "route_nom_104.geojson",
                                       "timeline": "timeline_nom_104.json"}
    assert doc["scenario"] == {"id": "nom_104", "variant": "nominal", "suit_kg": 104}
    assert doc["frame"]["pad"]["kind"] == "custom"
    assert doc["world"]["plan_bundle_id"] is None  # no plan bundle for a custom pad yet


def test_waypoints_in_route_order_and_labels(ordered):
    doc = _doc(ordered)
    route = json.loads((ordered["tree"] / "route_nom_104.geojson").read_text())
    legs = sorted((f["properties"] for f in route["features"]
                   if f["geometry"]["type"] == "LineString"), key=lambda p: p["leg"])
    assert [w["station"] for w in doc["waypoints"]] == ["S2", "S1"]
    assert [w["index"] for w in doc["waypoints"]] == [1, 2]
    assert doc["title"] == TITLE
    feas = ordered["extra"]["feasibility"]
    assert doc["summary"]["feasible"] is feas["feasible"]
    assert doc["summary"]["feasibility"] == feas
    if feas["feasible"]:
        assert [lg["kind"] for lg in doc["legs"]] == ["out", "out", "home"]
        assert [(lg["from"], lg["to"]) for lg in doc["legs"]] == [
            ("pad", "wp1"), ("wp1", "wp2"), ("wp2", "pad")]
        assert doc["timeline"] is not None
        assert doc["timeline"]["rows"][0][1] == "depart"
        assert doc["timeline"]["rows"][-1][1] == "return"
    # one path row per route vertex, the engine's times
    rows = doc["path"]["rows"]
    assert len(rows) == sum(len(p["times_min"]) for p in legs)
    for lg, p in zip(doc["legs"], legs, strict=True):
        part = rows[lg["first_row"]:lg["first_row"] + lg["n_rows"]]
        assert [r[5] for r in part] == [round(t, 3) for t in p["times_min"]]
        assert lg["time_min"] == p["t_min"] and lg["o2_l"] == p["o2_L"]


def test_frame_pad_origin_and_station_positions(ordered):
    from tools.make_bundle import Frame

    doc = _doc(ordered)
    rows = doc["path"]["rows"]
    assert rows[0][2:4] == [0, 0]
    site = mission._config("site")["crs"]
    pad = doc["frame"]["pad"]
    frame = Frame(pad_id="x", lon=pad["lon"], lat=pad["lat"], elev_m=0.0,
                  proj=site["analysis_proj"], radius_m=float(site["mars_radius_m"]))
    assert doc["frame"]["projection"]["pad_xy_m"] == [round(v, 4) for v in frame.pad_xy]
    st_doc = json.loads((ordered["tree"] / "stations.json").read_text())
    stations = {s["id"]: s for s in (st_doc["stations"] if isinstance(st_doc, dict) else st_doc)}
    for w in doc["waypoints"]:
        st = stations[w["station"]]
        x, y = frame.local(st["lon"], st["lat"])
        assert (w["x_m"], w["y_m"]) == (round(x, 2), round(y, 2))
        assert w["lonlat"] == [st["lon"], st["lat"]]
    assert pad["elev_m"] is not None and rows[0][4] == 0  # z = DEM - pad elev at the pad
    # the job's DEM and WS2 fields (its scratch rasters) fill z, T_home and O2_home per row
    assert all(r[4] is not None and r[7] is not None and r[8] is not None for r in rows)
    assert rows[0][7:9] == [0, 0]  # T_home, O2_home at the pad
    assert all(w["o2_home_l"] is not None and w["t_home_min"] is not None
               for w in doc["waypoints"])
    if doc["legs"][-1]["kind"] == "home":
        assert rows[-1][2:4] == [0, 0]


def test_deterministic(ordered):
    tree = ordered["tree"]
    data = (tree / mission.FILE).read_bytes()
    doc = json.loads(data)
    assert doc["mission_id"] == _id(doc)
    kw = dict(inputs=ordered["inputs"], scenario="nom_104", origin="computed_live",
              origin_label=settings().labels.live, planner=doc["planner"],
              feasibility=ordered["extra"].get("feasibility"))
    a = mission.build_mission(tree, **kw)
    b = mission.build_mission(tree, **kw)
    assert mission.dump(a) == mission.dump(b)
    assert a["created_utc"] == doc["created_utc"]  # from the tree's manifest, not the clock
    # without the job's rasters the numbers that need them are null, the rest identical
    assert a["waypoints"][0]["x_m"] == doc["waypoints"][0]["x_m"]


def test_mission_id_is_the_browsers(ordered, auto):
    """README id rule as tests/test_mission_contract.py's helper computes it, and as
    JSON.stringify writes the text (js_stringify): equal for every exported document."""
    for run in (ordered, auto):
        doc = _doc(run)
        blank = dict(doc, mission_id="", created_utc="")
        assert mission.js_stringify(blank) == json.dumps(blank, separators=(",", ":"),
                                                          ensure_ascii=False)
        assert doc["mission_id"] == _id(doc) == mission.mission_id(doc)
    # the committed example's id was computed in the browser (export.ts finalizeMission)
    planer = json.loads((mission.REPO / "contracts/bundle/examples/mission.mission_planer.json")
                        .read_text(encoding="utf-8"))
    assert mission.mission_id(planer) == "m-f8efb70b3e02"


@pytest.mark.parametrize(("x", "js"), [
    (0, "0"), (0.0, "0"), (10.0, "10"), (-3, "-3"), (0.1, "0.1"), (482.3113, "482.3113"),
    (5e-05, "0.00005"), (1.2e-06, "0.0000012"), (1e-07, "1e-7"), (1.5e-07, "1.5e-7"),
    (1e21, "1e+21"), (1e20, "100000000000000000000"), (123456789.125, "123456789.125"),
    (-284518.5481, "-284518.5481"), (2.5e+25, "2.5e+25")])
def test_js_number_formatting(x, js):
    assert mission.js_number(x) == js


def test_js_stringify_known_answer():
    doc = {"b": [1.0, 0.5, None, True], "a": "Mission · 1 waypoint", "c": {"x": 5e-05}}
    assert mission.js_stringify(doc) == (
        '{"b":[1,0.5,null,true],"a":"Mission · 1 waypoint","c":{"x":0.00005}}')


def test_run_record_lists_it(ordered, tmp_path):
    from server.engine import results

    files = {f["path"] for f in results.tree_files(ordered["tree"])}
    assert mission.FILE in files


# ---------------------------------------------------------------------- infeasible ----
def test_infeasible_route_keeps_only_planned_legs(ordered, tmp_path):
    """The engine's infeasible answer: the legs before the failing one, no way home."""
    tree = tmp_path / "tree"
    shutil.copytree(ordered["tree"], tree)
    rp = tree / "route_nom_104.geojson"
    route = json.loads(rp.read_text())
    route["features"] = [f for f in route["features"]
                         if f["geometry"]["type"] != "LineString" or f["properties"]["leg"] == 1]
    rp.write_text(json.dumps(route))
    tp = tree / "timeline_nom_104.json"
    tl = json.loads(tp.read_text())
    t_end = next(e["t_min"] for e in tl if e["event"] == "leave")
    tp.write_text(json.dumps([e for e in tl if e["event"] != "return" and e["t_min"] <= t_end]))
    feas = {"feasible": False, "leg": 2, "from": "S2", "to": "S1", "limit": "O2",
            "shortfall_min": 12.4, "legs_planned": 1}
    out = mission.write_mission(
        tree, tree / "m.json", inputs=ordered["inputs"], scenario="nom_104",
        origin="computed_live", origin_label=settings().labels.live,
        planner={"routing_grid_res_m": 3}, feasibility=feas)
    doc = json.loads(out.read_text())
    assert mission.schema_errors(doc) == []
    assert doc["summary"]["feasible"] is False and doc["summary"]["legs_planned"] == 1
    # every planned stop is a waypoint; the legs after the failure are there, unrouted
    assert [w["station"] for w in doc["waypoints"]] == ["S2", "S1"]  # the user's plan
    assert doc["waypoints"][1]["arrive_t_min"] is None
    legs = doc["legs"]
    assert [(lg["leg"], lg["kind"], lg["from"], lg["to"], lg["routed"]) for lg in legs] == [
        (1, "out", "pad", "wp1", True), (2, "out", "wp1", "wp2", False),
        (3, "home", "wp2", "pad", False)]
    for lg in legs[1:]:
        assert (lg["length_m"], lg["time_min"], lg["o2_l"], lg["t_end_min"], lg["first_row"],
                lg["n_rows"]) == (None, None, None, None, None, 0)
    assert legs[1]["t_start_min"] == doc["waypoints"][0]["leave_t_min"]  # leaves wp1 then
    assert {r[0] for r in doc["path"]["rows"]} == {1}  # only the planned leg is walked
    assert doc["timeline"] is None  # README: an unrouted leg makes the timeline null
    sm = doc["summary"]
    assert sm["t_home_min"] is None and sm["eva_min"] is None and sm["walk_min"] is None
    assert sm["o2_used_l"] is None and sm["stop_min"] == 60  # both planned 30-min stops


def test_feasibility_falls_back_to_the_run_record(ordered, tmp_path):
    tree = tmp_path / "tree"
    shutil.copytree(ordered["tree"], tree)
    feas = {"feasible": False, "leg": 2, "from": "S2", "to": "S1", "limit": "EVA duration",
            "shortfall_min": 1.0, "legs_planned": 1}
    (tree / "run_record.json").write_text(json.dumps({"feasibility": feas}))
    doc = mission.build_mission(tree, inputs=ordered["inputs"], scenario="nom_104",
                                origin="computed_live", origin_label="x",
                                planner={"routing_grid_res_m": 3})
    assert doc["summary"]["feasible"] is False


def test_free_point_label_is_carried(ordered, tmp_path):
    """Free points (R4): W1.. in visit order, the record label as the note."""
    inputs = copy.deepcopy(ordered["inputs"])
    inputs["route"]["stops"].insert(1, {"lon": 137.39, "lat": -4.79, "label": "rock"})
    doc = mission.build_mission(ordered["tree"], inputs=inputs, scenario="nom_104",
                                origin="computed_live", origin_label="x",
                                planner={"routing_grid_res_m": 3}, feasibility={"feasible": True})
    w = doc["waypoints"]
    assert [x["name"] for x in w] == ["S2", "W1", "S1"]
    assert w[1]["note"] == "rock" and "station" not in w[1] and w[1]["tags"] == []
    assert mission.schema_errors(doc) == []


# ----------------------------------------------------------------------------- auto ----
def test_auto_plan_also_exports(auto):
    doc = _doc(auto)
    assert mission.schema_errors(doc) == []
    assert doc["summary"]["feasible"] is True and doc["summary"]["route_mode"] == "auto"
    route = json.loads((auto["tree"] / "route_nom_104.geojson").read_text())
    stops = [f["properties"]["to"] for f in sorted(
        (f for f in route["features"] if f["geometry"]["type"] == "LineString"),
        key=lambda f: f["properties"]["leg"]) if f["properties"]["to"] != "pad"]
    assert [w["station"] for w in doc["waypoints"]] == stops
    man = json.loads((auto["tree"] / "manifest.json").read_text())
    assert man["export.mission.mission.json"]["kind"] == "sim_plan"

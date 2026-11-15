"""contracts/bundle/mission.schema.json: the simulator plan format (D103, bundle family v1.1.1).

Known answers: the schema is valid draft 2020-12 and versioned 1.1.1 (D110: origin also
precomputed) while a mission file's schema_version stays 1.1.0 and every v1 bundle schema stays
1.0.0; the README states the same versions; the committed example (written by the
Mission Planer's export.ts from its known-answer input) validates and its mission_id follows the
id rule; a computed_live variant (WP9b) and a precomputed variant (WP9c, the official plan)
validate; required fields, wrong origins and broken fixed
blocks are refused; the D39 dose block and an unrouted mission validate. D76: no contracts/sim/,
route_package* or compiled_plan* files.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator

REPO = Path(__file__).resolve().parents[1]
B = REPO / "contracts" / "bundle"
SCHEMA_PATH = B / "mission.schema.json"
EXAMPLE = B / "examples" / "mission.mission_planer.json"
FAMILY_VERSION = "1.1.1"  # x-contract-version of the bundle family (D110)
DOC_VERSION = "1.1.0"  # schema_version inside a mission file: unchanged, so 1.1.0 files stay valid
V1_SCHEMAS = ["bundle", "config_snapshot", "plan", "points", "route_local", "storm", "sun"]


def _load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


SCHEMA = _load(SCHEMA_PATH)
VALIDATOR = Draft202012Validator(SCHEMA)


def errors(doc) -> list[str]:
    return [e.message for e in VALIDATOR.iter_errors(doc)]


def mission_id(doc: dict) -> str:
    """export.ts finalizeMission: 'm-' + 12 hex of sha256(JSON.stringify(doc, id and time = ''))."""
    blank = dict(doc, mission_id="", created_utc="")
    text = json.dumps(blank, separators=(",", ":"), ensure_ascii=False)
    return "m-" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


@pytest.fixture
def planer() -> dict:
    return _load(EXAMPLE)


def _labels() -> dict:
    backend = (REPO / "config" / "backend.yaml").read_text(encoding="utf-8")
    return yaml.safe_load(backend)["labels"]


def live_variant(doc: dict, origin: str = "computed_live", label: str = "live") -> dict:
    """The same mission as a live engine job (WP9b): engine grid, live label from config. With
    origin precomputed and label precomputed: the official plan's shape (WP9c, D110)."""
    d = copy.deepcopy(doc)
    d["origin"] = origin
    d["origin_label"] = _labels()[label]
    files = {"route": "route_nom_104.geojson", "timeline": "timeline_nom_104.json"}
    d["planner"].update(routing_grid_res_m=3, elevation_res_m=1, files=files)
    d["mission_id"] = mission_id(d)
    return d


# --- schema and versions -------------------------------------------------------------------------

def test_schema_valid_and_versioned():
    Draft202012Validator.check_schema(SCHEMA)
    assert SCHEMA["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert SCHEMA["$id"] == "homeline/contracts/bundle/mission.schema.json"
    assert SCHEMA["x-contract-version"] == FAMILY_VERSION
    assert SCHEMA["properties"]["schema_version"] == {"const": DOC_VERSION}
    for key in ("title", "description", "x-source", "x-status"):
        assert SCHEMA.get(key)
    assert "D103" in SCHEMA["description"] and "D103" in SCHEMA["x-status"]
    assert "D110" in SCHEMA["x-status"] and "precomputed" in SCHEMA["description"]


def test_origin_enum_is_the_three_origins():
    # D110: one additive value; the existing two stay
    assert SCHEMA["properties"]["origin"] == {
        "enum": ["mission_planer", "computed_live", "precomputed"],
        "description": SCHEMA["properties"]["origin"]["description"]}


@pytest.mark.parametrize("name", V1_SCHEMAS)
def test_v1_bundle_schemas_stay_1_0_0(name):
    s = _load(B / f"{name}.schema.json")
    Draft202012Validator.check_schema(s)
    assert s["x-contract-version"] == "1.0.0"


def test_family_is_the_v1_set_plus_mission():
    assert sorted(p.name.removesuffix(".schema.json") for p in B.glob("*.schema.json")) \
        == sorted(V1_SCHEMAS + ["mission"])


def test_readme_states_the_versions():
    text = (B / "README.md").read_text(encoding="utf-8")
    title = re.search(r"^# Simulator bundle contracts \(D41\) — v(\S+)$", text, re.M)
    assert title[1] == FAMILY_VERSION
    assert re.search(r"^## Mission file \(v(\S+), D103\)$", text, re.M)[1] == FAMILY_VERSION
    assert re.search(r"^\| 1\.1\.0 \| 2026-11-15 \| D103", text, re.M)
    v = re.escape(FAMILY_VERSION)
    assert re.search(rf"^\| {v} \| 2026-11-15 \| D110, additive", text, re.M)
    assert "superseded for routes" in text and "computed_live" in text
    row = r"^\| `precomputed` \|.*labels\.precomputed`: \"Precomputed · official plan\" \|$"
    assert re.search(row, text, re.M)


def test_mission_schema_stays_out_of_the_web_family():
    # tests/test_contracts.py requires every top-level contracts/*.schema.json to map to web data
    assert not (REPO / "contracts" / "mission.schema.json").exists()


def test_d76_forbidden_names_absent():
    assert not (REPO / "contracts" / "sim").exists()
    for pat in ("route_package*", "compiled_plan*"):
        assert not list((REPO / "contracts").rglob(pat))


# --- examples ------------------------------------------------------------------------------------

def test_mission_planer_example_validates(planer):
    assert errors(planer) == []
    assert planer["origin"] == "mission_planer"
    assert planer["schema_version"] == DOC_VERSION


def test_example_known_answers(planer):
    # export.test.ts input: 10 m leg due east of the pad on the 5 m grid, 5-min stop, home back
    assert planer["mission_id"] == mission_id(planer) == "m-f8efb70b3e02"
    assert planer["frame"]["axes"] == {"x": "east", "y": "north", "z": "up"}
    assert planer["path"]["rows"][0] == [1, 0, 0, 0, 0, 0, 0, 0, 0]
    assert planer["path"]["rows"][2] == [1, 10, 10, 0, 1, 0.2, 0.2, 0.2, 0.1]
    assert planer["path"]["rows"][-1][:6] == [2, 10, 0, 0, 0, 5.4]
    assert [leg["kind"] for leg in planer["legs"]] == ["out", "home"]
    assert planer["summary"]["feasible"] is True
    assert planer["label"] == "Simulated EVA · real terrain and data"


def test_computed_live_variant_validates(planer):
    live = live_variant(planer)
    assert errors(live) == []
    assert live["origin_label"] == "Computed live · not part of the validated scorecard"
    assert live["mission_id"] != planer["mission_id"]


def test_storm_dose_block_validates(planer):
    d = copy.deepcopy(planer)
    dose = {"d_allow_mgy": 0.5, "series": [[-30.0, 0.01], [0.2, 0.4]], "source": "rad.json"}
    d["conditions"].update(storm_replay=True, t_star_min=0.2, msl_sol=5074, dose=dose,
                           eva_start_utc="2026-11-14T10:51:18Z")
    assert errors(d) == []
    d["conditions"]["dose"]["series"].append([1.0, 0.0])  # dose rate must be > 0
    assert errors(d)


def test_unrouted_mission_validates(planer):
    d = copy.deepcopy(planer)
    d["legs"][0].update(routed=False, length_m=None, time_min=None, o2_l=None, t_end_min=None,
                        first_row=None, n_rows=0)
    d["timeline"] = None
    d["summary"]["feasible"] = False
    assert errors(d) == []


# --- refusals ------------------------------------------------------------------------------------

@pytest.mark.parametrize("key", SCHEMA["required"])
def test_required_top_level_field_refused_when_missing(planer, key):
    d = copy.deepcopy(planer)
    del d[key]
    assert errors(d)


@pytest.mark.parametrize("block,key", [
    ("frame", "pad"), ("frame", "axes"), ("planner", "routing_grid_res_m"), ("scenario", "suit_kg"),
    ("world", "plan_bundle_id"), ("constants", "margin_amber_min"), ("conditions", "t_star_min"),
    ("path", "rows"), ("summary", "feasible"),
])
def test_required_nested_field_refused_when_missing(planer, block, key):
    d = copy.deepcopy(planer)
    del d[block][key]
    assert errors(d)


@pytest.mark.parametrize("key", ["index", "x_m", "z_m", "t_home_min"])
def test_waypoint_field_refused_when_missing(planer, key):
    d = copy.deepcopy(planer)
    del d["waypoints"][0][key]
    assert errors(d)


def test_precomputed_variant_validates(planer):
    # D110 (WP9c): the official plan, origin precomputed with config labels.precomputed
    pre = live_variant(planer, "precomputed", "precomputed")
    assert errors(pre) == []
    assert pre["origin_label"] == "Precomputed · official plan"
    assert pre["schema_version"] == DOC_VERSION
    assert len({pre["mission_id"], live_variant(planer)["mission_id"], planer["mission_id"]}) == 3


@pytest.mark.parametrize("origin", ["Precomputed", "official", "Mission_Planer", "live", None])
def test_other_origins_refused(planer, origin):
    assert errors(dict(planer, origin=origin))


def test_wrong_version_and_kind_refused(planer):
    assert errors(dict(planer, schema_version="1.0.0"))
    assert errors(dict(planer, kind="homeline_plan"))


def test_fixed_blocks_refuse_unknown_keys(planer):
    d = copy.deepcopy(planer)
    d["frame"]["axes"]["w"] = "time"
    assert errors(d)
    d = copy.deepcopy(planer)
    d["path"]["units"]["speed_ms"] = "m/s"
    assert errors(d)
    d = copy.deepcopy(planer)
    d["timeline"]["phases"]["rest"] = "?"
    assert errors(d)


def test_rows_are_exactly_nine_columns(planer):
    d = copy.deepcopy(planer)
    d["path"]["rows"][0].append(0)
    assert errors(d)
    d = copy.deepcopy(planer)
    d["timeline"]["rows"][0] = d["timeline"]["rows"][0][:8]
    assert errors(d)
    d = copy.deepcopy(planer)
    d["timeline"]["rows"][0][1] = "rest"  # unknown phase
    assert errors(d)


def test_open_objects_accept_unknown_keys(planer):
    # README: objects are open so later minors stay additive; only the fixed blocks are exact
    d = copy.deepcopy(planer)
    d["future_block"] = {"a": 1}
    d["waypoints"][0]["photo"] = "x.jpg"
    assert errors(d) == []

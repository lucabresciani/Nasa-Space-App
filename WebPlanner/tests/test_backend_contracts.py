"""Backend contract family (contracts/backend/, v1.1.0, additive since P0; kit K1/K4, D50-D57).

Known answers: every schema is valid draft 2020-12 and versioned; every example validates against
its schema; the OpenAPI document covers every route of backend spec §5, its refs resolve, and it
passes the OpenAPI 3.1 meta-schema (openapi-spec-validator, skipped when not installed); the share
code is HL- + 6 Crockford base32 characters (D55); YAML 1.1 readers (PyYAML) see "on"/"off" as
strings, not booleans (v1.0.1); v1.1.0 adds POST /admin/heavy-jobs (team token) and the 503 on
importPlan, and the version agrees with config/backend.yaml contract_version.
"""

import json
import re
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

REPO = Path(__file__).resolve().parents[1]
B = REPO / "contracts" / "backend"
EX = B / "examples"
SCHEMAS = sorted(B.glob("*.schema.json"))
EXAMPLES = sorted(EX.glob("*.json"))
FAMILY = {"plan_inputs", "run_record", "job", "telemetry"}
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # D55 (kit K4)
# per-schema version: v1.2.0 (D97) changed plan_inputs (route) and run_record (feasibility) only
SCHEMA_VERSION = {"plan_inputs": "1.2.0", "run_record": "1.2.0", "job": "1.0.0",
                  "telemetry": "1.0.0"}


def _load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def _api() -> dict:
    return yaml.safe_load((B / "openapi.yaml").read_text(encoding="utf-8"))


def _registry() -> Registry:
    pairs = []
    for p in SCHEMAS:
        res = Resource.from_contents(_load(p))
        pairs += [(p.name, res), (_load(p)["$id"], res)]
    return Registry().with_resources(pairs)


def validator(name: str, pointer: str = "") -> Draft202012Validator:
    schema = _load(B / name)
    if pointer:
        schema = {"$ref": f"{schema['$id']}#{pointer}"}
    return Draft202012Validator(schema, registry=_registry())


def _stem(p: Path) -> str:
    return p.name.split(".", 1)[0]


# --- schemas -------------------------------------------------------------------------------------

def test_family_present():
    assert {p.name.removesuffix(".schema.json") for p in SCHEMAS} == FAMILY
    assert (B / "openapi.yaml").is_file() and (B / "README.md").is_file()


@pytest.mark.parametrize("path", SCHEMAS, ids=lambda p: p.name)
def test_schema_valid_and_versioned(path):
    s = _load(path)
    Draft202012Validator.check_schema(s)
    assert s["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert s["$id"] == f"homeline/contracts/backend/{path.name}"
    assert s["x-contract-version"] == SCHEMA_VERSION[_stem(path)]
    for key in ("title", "description", "x-source"):
        assert s.get(key)


def test_backend_schemas_stay_out_of_the_web_family():
    # tests/test_contracts.py requires every top-level contracts/*.schema.json to map to web data
    top = {p.name for p in (REPO / "contracts").glob("*.schema.json")}
    assert not top & {p.name for p in SCHEMAS}


# --- examples ------------------------------------------------------------------------------------

def test_every_schema_has_an_example():
    assert {_stem(p) for p in EXAMPLES} == FAMILY


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.name)
def test_example_validates(path):
    validator(f"{_stem(path)}.schema.json").validate(_load(path))


@pytest.mark.parametrize("case,pointer", [("batch", "/$defs/batch"),
                                          ("state_event", "/$defs/state_event")])
def test_telemetry_examples_match_their_part(case, pointer):
    doc = _load(EX / f"telemetry.{case}.json")
    validator("telemetry.schema.json", pointer).validate(doc)
    other = "/$defs/state_event" if case == "batch" else "/$defs/batch"
    assert not validator("telemetry.schema.json", other).is_valid(doc)


def test_example_official_pad_is_the_published_official_pad():
    idx = REPO / "web" / "public" / "data" / "scenarios" / "pads" / "index.json"
    if not idx.is_file():
        pytest.skip("no published pads index")
    official = [p for p in _load(idx)["pads"] if p.get("official")]
    pad = _load(EX / "plan_inputs.official.json")["pad"]
    assert len(official) == 1
    assert (pad["id"], pad["lon"], pad["lat"]) == (official[0]["id"], official[0]["lon"],
                                                   official[0]["lat"])


# --- plan_inputs ---------------------------------------------------------------------------------

PAD = {"lon": 137.4, "lat": -4.78}


def _inputs(**kw) -> dict:
    return {"contract_version": "1.0.0", "pad": dict(PAD), **kw}


def test_plan_inputs_minimal_and_required():
    v = validator("plan_inputs.schema.json")
    assert v.is_valid(_inputs())
    assert not v.is_valid({"pad": PAD})
    assert not v.is_valid({"contract_version": "1.0.0"})
    assert not v.is_valid(_inputs(contract_version="2.0.0"))
    assert not v.is_valid({"contract_version": "1.0.0", "pad": {"lon": 137.4}})


def test_plan_inputs_rejects_unknown_fields():
    v = validator("plan_inputs.schema.json")
    assert not v.is_valid(_inputs(extra=1))
    assert not v.is_valid(_inputs(crew={"suit_kg": 104, "colour": "red"}))
    assert not v.is_valid({"contract_version": "1.0.0", "pad": {**PAD, "alt": 0}})


def test_plan_inputs_station_modes():
    v = validator("plan_inputs.schema.json")
    assert v.is_valid(_inputs(stations={"mode": "best"}))
    assert not v.is_valid(_inputs(stations={"mode": "fastest"}))
    for mode in ("set", "order"):  # a fixed set or order needs its ids
        assert not v.is_valid(_inputs(stations={"mode": mode}))
        assert not v.is_valid(_inputs(stations={"mode": mode, "ids": []}))
        assert v.is_valid(_inputs(stations={"mode": mode, "ids": ["S1", "S3"]}))
    assert not v.is_valid(_inputs(stations={"mode": "order", "ids": ["S1", "S1"]}))
    assert not v.is_valid(_inputs(stations={"mode": "best", "dwell_min": {"X9": 10}}))


def test_plan_inputs_user_points_u1_to_u3():
    v = validator("plan_inputs.schema.json")
    pts = [{"id": f"U{i}", **PAD} for i in (1, 2, 3)]
    assert v.is_valid(_inputs(stations={"mode": "best", "custom": pts}))
    assert not v.is_valid(_inputs(stations={"mode": "best", "custom": pts + [dict(pts[0])]}))
    assert not v.is_valid(_inputs(stations={"mode": "best", "custom": [{"id": "U4", **PAD}]}))


def test_plan_inputs_storm_and_tripwire():
    v = validator("plan_inputs.schema.json")
    storm = {"storm": "2024-05-20"}
    assert v.is_valid(_inputs(conditions={**storm, "tripwire_at": "route_max_t_home"}))
    assert v.is_valid(_inputs(conditions={"storm": "2024-05-20", "tripwire_at": 120}))
    assert not v.is_valid(_inputs(conditions={"storm": "2024-05-21"}))
    assert not v.is_valid(_inputs(conditions={"tripwire_at": -1}))
    assert not v.is_valid(_inputs(conditions={"tripwire_at": "station_max"}))


def test_plan_inputs_route_v1_2_known_answers():
    """v1.2.0 (D97): route auto | ordered; stops are {station} or {lon, lat, label?}; additive."""
    v = validator("plan_inputs.schema.json")
    st, pt = {"station": "S4"}, {"lon": 137.3962, "lat": -4.7781}
    assert v.is_valid(_inputs())  # missing route = auto: every v1.1 document stays valid
    for ok in ({"mode": "auto"}, {"mode": "auto", "stops": []},
               {"mode": "ordered", "stops": [st]},
               {"mode": "ordered",
                "stops": [st, pt, {**pt, "label": "Dark sand"}, {"station": "S1"}]}):
        assert v.is_valid(_inputs(route=ok)), ok
    for bad in ({}, {"mode": "best"}, {"mode": "ordered"}, {"mode": "ordered", "stops": []},
                {"mode": "auto", "stops": [st]}, {"mode": "ordered", "stops": [{"station": "U1"}]},
                {"mode": "ordered", "stops": [{"station": "S4", "lon": 137.4, "lat": -4.78}]},
                {"mode": "ordered", "stops": [{"lon": 137.4}]},
                {"mode": "ordered", "stops": [{**pt, "name": "x"}]},
                {"mode": "ordered", "stops": [{**pt, "lat": -91}]},
                {"mode": "ordered", "stops": [st], "order": "fixed"}):
        assert not v.is_valid(_inputs(route=bad)), bad


def test_route_examples_are_the_ui_mocks():
    """The examples the design orchestrator mocks from (R5-R7): ordered stations, mixed free points,
    an infeasible answer naming the leg and the limit, and a feasible free-point run."""
    ordered = _load(EX / "plan_inputs.route_ordered.json")["route"]
    assert ordered["mode"] == "ordered" and all("station" in s for s in ordered["stops"])
    free = _load(EX / "plan_inputs.route_free.json")["route"]["stops"]
    assert any("station" in s for s in free) and any("lon" in s for s in free)
    inf = _load(EX / "run_record.route_infeasible.json")
    assert inf["route_mode"] == "ordered" and inf["status"] == "done"  # infeasible is a result
    f = inf["feasibility"]
    assert f["feasible"] is False and f["limit"] in ("O2", "daylight", "dose", "EVA duration")
    stops = ["pad", *(s["station"] for s in inf["inputs"]["route"]["stops"]), "pad"]
    assert (f["from"], f["to"]) == (stops[f["leg"]], stops[f["leg"] + 1])
    assert _load(EX / "run_record.route_free.json")["feasibility"] == {"feasible": True}


def test_run_record_feasibility_known_answers():
    v = validator("run_record.schema.json")
    rec = _load(EX / "run_record.live.json")
    assert "feasibility" not in rec and v.is_valid(rec)  # v1.1 records stay valid
    for ok in ({"feasible": True},
               {"feasible": False, "leg": 0, "from": "pad", "to": "W1", "limit": "daylight",
                "shortfall_min": 4.0},
               {"feasible": False, "leg": 3, "from": "S8", "to": "pad", "limit": "EVA duration",
                "shortfall_min": 0.5, "legs_planned": 3}):
        assert v.is_valid({**rec, "route_mode": "ordered", "feasibility": ok}), ok
    for bad in ({"feasible": True, "leg": 1}, {"feasible": False},
                {"feasible": False, "leg": 0, "from": "pad", "to": "S1", "limit": "speed",
                 "shortfall_min": 1},
                {"feasible": False, "leg": 0, "from": "pad", "to": "U1", "limit": "O2",
                 "shortfall_min": 1},
                {"feasible": False, "leg": 0, "from": "pad", "to": "S1", "limit": "O2",
                 "shortfall_min": -1}):
        assert not v.is_valid({**rec, "feasibility": bad}), bad
    assert not v.is_valid({**rec, "route_mode": "best"})


def test_route_422_names_the_stop():
    """v1.2.0: Error.stop indexes inputs.route.stops; the route error codes are documented."""
    err = _api()["components"]["schemas"]["Error"]
    stop = err["properties"]["stop"]
    assert stop["type"] == ["integer", "null"] and stop["minimum"] == 0
    for code in ("route_too_many_stops", "route_too_many_free_points", "route_stop_spacing",
                 "route_station_unknown", "route_point_outside_grid", "route_point_unreachable"):
        assert code in stop["description"], code
    assert "required" not in err or err["required"] == ["error"]  # additive: stop is optional


# --- run record, job, telemetry ------------------------------------------------------------------

def test_run_record_inputs_use_plan_inputs():
    v = validator("run_record.schema.json")
    rec = _load(EX / "run_record.live.json")
    assert v.is_valid(rec)
    rec["inputs"]["crew"]["colour"] = "red"
    assert not v.is_valid(rec)


def test_run_record_infeasible_leg():
    v = validator("run_record.schema.json")
    rec = _load(EX / "run_record.live.json")
    rec["infeasible"] = {"leg": 2, "from": "S1", "to": "S4", "margin_min": -3.5, "binding": "O2"}
    assert v.is_valid(rec)
    rec["infeasible"]["binding"] = "speed"
    assert not v.is_valid(rec)


@pytest.mark.parametrize("change", [{"hash": "0123456789ABCDEF"}, {"hash": "0123456789abcde"},
                                    {"origin": "live"}, {"terrain_hash": "0" * 64}])
def test_run_record_rejects(change):
    rec = {**_load(EX / "run_record.live.json"), **change}
    assert not validator("run_record.schema.json").is_valid(rec)


def test_job_status_values():
    v = validator("job.schema.json")
    job = _load(EX / "job.queued.json")
    for status in ("queued", "running", "done", "error", "timeout", "refused"):
        assert v.is_valid({**job, "status": status})
    assert not v.is_valid({**job, "status": "paused"})
    assert not v.is_valid({**job, "progress": 1.5})
    assert not v.is_valid({**job, "type": "export"})


def test_telemetry_sample_fields_are_spec_7():
    sample = _load(B / "telemetry.schema.json")["$defs"]["sample"]
    assert set(sample["required"]) == {"t_eva_s", "x_m", "y_m", "z_m", "speed_ms", "o2_left_L",
                                       "source"}
    v = validator("telemetry.schema.json", "/$defs/batch")
    assert not v.is_valid({"samples": []})
    s = _load(EX / "telemetry.batch.json")["samples"][0]
    assert not v.is_valid({"samples": [{**s, "heart_rate": 90}]})
    assert not v.is_valid({"samples": [{k: x for k, x in s.items() if k != "o2_left_L"}]})


# --- OpenAPI -------------------------------------------------------------------------------------

SPEC_5 = {  # backend spec §5: method and path, auth
    ("get", "/health"): "G", ("get", "/engine/version"): "G", ("get", "/defaults"): "G",
    ("post", "/pads/validate"): "G", ("post", "/pads/screen"): "G", ("post", "/jobs"): "G",
    ("get", "/jobs/{id}"): "G", ("get", "/results/{hash}/{path}"): "G",
    ("get", "/results/{hash}/provenance"): "G", ("post", "/plans/import"): "G",
    ("get", "/plans"): "U", ("post", "/plans"): "U", ("get", "/plans/{id}"): "U",
    ("patch", "/plans/{id}"): "U", ("delete", "/plans/{id}"): "U",
    ("get", "/plans/{id}/versions"): "U", ("get", "/plans/by-code/{code}"): "G",
    ("get", "/plans/{ref}/bundle"): "G", ("get", "/world/{version}/{path}"): "G",
    ("post", "/sessions"): "G", ("post", "/sessions/{id}/telemetry"): "K",
    ("get", "/sessions/{id}/stream"): "K", ("post", "/sessions/{id}/commands"): "K",
    ("post", "/sessions/{id}/end"): "K", ("get", "/runs/{id}"): "K",
    ("get", "/conditions/latest"): "G", ("delete", "/me"): "U", ("get", "/admin/status"): "T",
    ("post", "/admin/heavy-jobs"): "T",  # v1.1.0 (S1e): the WS12 kill-switch control (O3)
}
AUTH = {"U": "supabase", "K": "sessionKey", "T": "teamToken"}
METHODS = {"get", "put", "post", "delete", "patch"}


def test_openapi_covers_spec_5_exactly_with_auth():
    api = _api()
    assert api["openapi"].startswith("3.1")
    assert api["info"]["version"] == _config_contract_version()
    assert re.fullmatch(r"1\.\d+\.\d+", api["info"]["version"])  # still major 1: additive only
    assert api["servers"][0]["url"] == "/api/v1"
    ops = {(m, path): op for path, item in api["paths"].items()
           for m, op in item.items() if m in METHODS}
    assert set(ops) == set(SPEC_5)
    for key, auth in SPEC_5.items():
        names = {n for req in ops[key].get("security", []) for n in req}
        if auth == "G":
            assert ops[key].get("security") in (None, [{}], [{}, {"supabase": []}]), key
        else:
            assert names == {AUTH[auth]}, key
    ids = [op["operationId"] for op in ops.values()]
    assert len(ids) == len(set(ids))


def test_openapi_on_off_are_strings_under_yaml_1_1():
    # v1.0.1: PyYAML follows YAML 1.1, where a bare on/off/yes/no is a boolean.
    schemas = _api()["components"]["schemas"]
    assert schemas["Health"]["properties"]["heavy_jobs"]["enum"] == ["on", "off"]
    assert schemas["AdminStatus"]["properties"]["heavy_jobs"]["enum"] == ["on", "off"]


def _config_contract_version() -> str:
    """config/backend.yaml contract_version (the one place the family version is configured)."""
    cfg = yaml.safe_load((REPO / "config" / "backend.yaml").read_text(encoding="utf-8"))
    return cfg["contract_version"]


def test_contract_version_agrees_everywhere():
    v = _api()["info"]["version"]
    assert v == _config_contract_version()
    assert f"Backend contract family v{v} " in _api()["info"]["description"]
    readme = (B / "README.md").read_text(encoding="utf-8")
    assert readme.splitlines()[0].endswith(f"v{v}")
    assert f"\n- {v} (" in readme  # a changelog entry for the current version


def test_admin_heavy_jobs_known_answer():
    """v1.1.0: POST /admin/heavy-jobs as WS12 (O3) implements it (server/api/auth/admin.py)."""
    op = _api()["paths"]["/admin/heavy-jobs"]["post"]
    assert op["operationId"] == "setHeavyJobs" and op["security"] == [{"teamToken": []}]
    body = op["requestBody"]["content"]["application/json"]["schema"]
    assert body["required"] == ["heavy_jobs"] and body["additionalProperties"] is False
    assert body["properties"]["heavy_jobs"]["enum"] == ["on", "off"]  # strings under YAML 1.1
    r = op["responses"]
    assert r["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/AdminStatus"}
    assert r["403"] == r["422"] == {"$ref": "#/components/responses/Error"}
    v = Draft202012Validator(body)
    assert v.is_valid({"heavy_jobs": "off"}) and v.is_valid({"heavy_jobs": "on"})
    for bad in ({}, {"heavy_jobs": False}, {"heavy_jobs": "off", "x": 1}, {"heavy_jobs": "OFF"}):
        assert not v.is_valid(bad), bad


def test_import_plan_503_known_answer():
    """v1.1.0: importPlan answers 503 (Error) without an engine identity, as createJob does."""
    paths = _api()["paths"]
    imp = paths["/plans/import"]["post"]["responses"]
    assert set(imp) == {"200", "413", "422", "503"}
    assert imp["503"] == paths["/jobs"]["post"]["responses"]["503"] == {
        "$ref": "#/components/responses/Error"}


def _enums(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "enum":
                yield path, v
            yield from _enums(v, f"{path}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _enums(v, f"{path}/{i}")


def test_openapi_no_enum_holds_a_bool_under_yaml_1_1():
    found = list(_enums(_api()))
    assert found  # the walk reaches the enums
    bad = [(path, e) for path, e in found if any(isinstance(x, bool) for x in e)]
    assert not bad, bad


def _resolve_pointer(doc, pointer: str):
    node = doc
    for part in pointer.lstrip("/").split("/"):
        if part:
            node = node[part.replace("~1", "/").replace("~0", "~")]
    return node


def test_openapi_refs_and_examples_resolve():
    api = _api()
    refs, externals = [], []

    def walk(n):
        if isinstance(n, dict):
            if isinstance(n.get("$ref"), str):
                refs.append(n["$ref"])
            if isinstance(n.get("externalValue"), str):
                externals.append(n["externalValue"])
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)

    walk(api)
    assert refs and externals
    for r in refs:
        file, _, frag = r.partition("#")
        doc = api if not file else _load(B / file)
        _resolve_pointer(doc, frag)  # KeyError if the target is missing
    for e in externals:
        assert (B / e).is_file(), e


def test_openapi_examples_validate_against_their_schemas():
    api = _api()
    checked = 0
    for item in api["paths"].values():
        for m, op in item.items():
            if m not in METHODS:
                continue
            bodies = [op.get("requestBody", {})] + list(op.get("responses", {}).values())
            for body in bodies:
                media = body.get("content", {}).get("application/json", {})
                for ex in media.get("examples", {}).values():
                    ref = media["schema"]["$ref"]
                    target = _resolve_pointer(api, ref.partition("#")[2])["$ref"]
                    file, _, frag = target.partition("#")
                    validator(file, frag).validate(_load(B / ex["externalValue"]))
                    checked += 1
    assert checked >= 6


def test_openapi_passes_the_3_1_meta_schema():
    osv = pytest.importorskip("openapi_spec_validator")
    path = B / "openapi.yaml"
    osv.validate(_api(), base_uri=path.resolve().as_uri())


# --- share code (D55) ----------------------------------------------------------------------------

def test_share_code_known_answers():
    rx = re.compile(_api()["components"]["schemas"]["ShareCode"]["pattern"])
    assert len(CROCKFORD) == 32 and not set("ILOU") & set(CROCKFORD)
    assert rx.fullmatch("HL-7K2Q9M")  # spec F28 example
    assert all(rx.fullmatch("HL-" + c * 6) for c in CROCKFORD)
    for bad in ("HL-7K2Q9", "HL-7K2Q9MM", "hl-7K2Q9M", "HL-7k2q9m", "HL7K2Q9M", "XX-7K2Q9M"):
        assert not rx.fullmatch(bad), bad
    for c in "ILOU":
        assert not rx.fullmatch("HL-" + c + "00000"), c
    assert len("HL-7K2Q9M") == 9
    by_code = _api()["paths"]["/plans/by-code/{code}"]["get"]["parameters"][0]["schema"]
    assert by_code == {"$ref": "#/components/schemas/ShareCode"}


def test_share_code_matches_backend_config():
    cfg_path = REPO / "config" / "backend.yaml"
    if not cfg_path.is_file():
        pytest.skip("config/backend.yaml not on this branch yet (S2)")
    pytest.importorskip("pydantic")  # server dependency group: the loader resolves alphabet names
    from server import settings as st

    sc = st.load().plans.share_code  # backend.yaml names the alphabet; the loader resolves it
    assert sc.alphabet == CROCKFORD
    assert sc.prefix == "HL-" and sc.chars == 6

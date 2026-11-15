"""FastAPI meta routes (plan row 1.1, F23): /health, /engine/version, /defaults, CORS.

Known answers: /health reports engine_warm false until the injected warm-up has finished and true
after it (a failed warm-up keeps it false and sets ok false); heavy_jobs follows the kill switch;
/engine/version carries the git commit, the engine tree, tools.make_bundle.config_hash (D57) and
the contract versions; /defaults carries the F26 defaults, the official pad and the ranges of
config/backend.yaml. Every body validates against contracts/backend/openapi.yaml.
"""

import hashlib
import json
import re
import subprocess
import threading
import time
from pathlib import Path

import pytest
import yaml

pytest.importorskip("fastapi")  # server dependency group (uv sync --group server)
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402
from jsonschema import Draft202012Validator  # noqa: E402
from referencing import Registry, Resource  # noqa: E402
from referencing.jsonschema import DRAFT202012  # noqa: E402

from server.app import create_app  # noqa: E402
from server.settings import settings  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
B = REPO / "contracts" / "backend"
API_ID = "homeline/contracts/backend/openapi.yaml"


class Yaml12Loader(yaml.SafeLoader):
    """OpenAPI 3.1 documents are YAML 1.2: only true/false are booleans. PyYAML follows YAML 1.1,
    where the Health enum [on, off] would load as [True, False]."""


Yaml12Loader.yaml_implicit_resolvers = {
    k: [(tag, rx) for tag, rx in v if tag != "tag:yaml.org,2002:bool"]
    for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()}
Yaml12Loader.add_implicit_resolver("tag:yaml.org,2002:bool", re.compile(r"^(?:true|false)$"),
                                   list("tf"))
OPENAPI = yaml.load((B / "openapi.yaml").read_text(encoding="utf-8"), Loader=Yaml12Loader)
PREFIX = settings().api.prefix
WAIT_S = 10.0


# ------------------------------------------------------------------------------- helpers ----
def _registry() -> Registry:
    pairs = [(API_ID, Resource.from_contents(OPENAPI, default_specification=DRAFT202012))]
    for p in sorted(B.glob("*.schema.json")):
        doc = json.loads(p.read_text(encoding="utf-8"))
        pairs.append((doc["$id"], Resource.from_contents(doc)))
    return Registry().with_resources(pairs)


REGISTRY = _registry()


def response_schema(path: str, status: str = "200") -> dict:
    """The JSON schema openapi.yaml gives for GET {path} -> {status}."""
    resp = OPENAPI["paths"][path]["get"]["responses"][status]
    if "$ref" in resp:  # a shared response (#/components/responses/...)
        resp = OPENAPI["components"]["responses"][resp["$ref"].rsplit("/", 1)[1]]
    return resp["content"]["application/json"]["schema"]


def assert_valid(body: dict, path: str, status: str = "200") -> None:
    ref = response_schema(path, status)["$ref"]  # "#/components/schemas/..." in openapi.yaml
    assert ref.startswith("#/components/schemas/")
    schema = {"$ref": f"{API_ID}{ref}"}  # resolved inside openapi.yaml (and its relative refs)
    errors = sorted(Draft202012Validator(schema, registry=REGISTRY).iter_errors(body), key=str)
    assert not errors, [e.message for e in errors]


def wait_for(client: TestClient, pred, timeout_s: float = WAIT_S) -> dict:
    t0 = time.monotonic()
    while True:
        body = client.get(f"{PREFIX}/health").json()
        if pred(body) or time.monotonic() - t0 > timeout_s:
            return body
        time.sleep(0.01)


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=REPO, check=True, capture_output=True,
                          text=True).stdout.strip()


@pytest.fixture
def instant_client():
    """App with a warm-up that returns at once (no Numba compile)."""
    with TestClient(create_app(warmup=lambda: None)) as c:
        wait_for(c, lambda b: b["engine_warm"])
        yield c


# ------------------------------------------------------------------------- API prefix ----
def test_prefix_is_the_openapi_server_url():
    assert PREFIX == "/api/v1"  # S3's Makefile `serve` and the web client (F23)
    assert OPENAPI["servers"][0]["url"] == PREFIX


def test_the_validator_catches_a_wrong_body():
    with pytest.raises(AssertionError):
        assert_valid({"ok": True}, "/health")
    good = {"ok": True, "engine_warm": True, "queue_length": 0, "heavy_jobs": "on"}
    assert_valid(good, "/health")
    with pytest.raises(AssertionError):  # YAML 1.2: the enum is the strings on/off
        assert_valid({**good, "heavy_jobs": True}, "/health")


# ----------------------------------------------------------------------------- /health ----
def test_health_not_warm_until_the_warm_up_finishes_then_warm():
    release, started = threading.Event(), threading.Event()

    def slow_warmup():
        started.set()
        assert release.wait(WAIT_S)

    with TestClient(create_app(warmup=slow_warmup)) as c:
        assert started.wait(WAIT_S)
        r = c.get(f"{PREFIX}/health")
        assert r.status_code == 200
        assert_valid(r.json(), "/health")
        assert r.json()["engine_warm"] is False
        assert r.json()["ok"] is True
        release.set()
        body = wait_for(c, lambda b: b["engine_warm"])
        assert body["engine_warm"] is True and body["ok"] is True
        assert_valid(body, "/health")


def test_health_answers_while_the_warm_up_runs():
    # start-up must not wait for the warm-up (it runs in the background)
    release = threading.Event()
    t0 = time.monotonic()
    with TestClient(create_app(warmup=lambda: release.wait(WAIT_S))) as c:
        assert c.get(f"{PREFIX}/health").json()["engine_warm"] is False
        assert time.monotonic() - t0 < WAIT_S / 2
        release.set()


def test_health_failed_warm_up_is_not_warm_and_not_ok():
    def broken():
        raise RuntimeError("no kernels")

    with TestClient(create_app(warmup=broken)) as c:
        body = wait_for(c, lambda b: not b["ok"])
        assert body == {**body, "ok": False, "engine_warm": False}
        assert_valid(body, "/health")


def test_health_queue_and_heavy_jobs(instant_client, monkeypatch):
    kill = settings().deploy.kill_switch_env
    assert kill == "HL_HEAVY_JOBS_OFF"
    monkeypatch.delenv(kill, raising=False)
    body = instant_client.get(f"{PREFIX}/health").json()
    assert body["queue_length"] == 0  # no job runner yet (plan row 2.3)
    assert body["heavy_jobs"] == "on"
    monkeypatch.setenv(kill, "1")
    body = instant_client.get(f"{PREFIX}/health").json()
    assert body["heavy_jobs"] == "off"
    assert_valid(body, "/health")


# ---------------------------------------------------------------------- /engine/version ----
@pytest.fixture
def server_data(tmp_path, monkeypatch):
    monkeypatch.setenv("HL_SERVER_DATA", str(tmp_path))
    return tmp_path


def test_engine_version_known_answers(instant_client, server_data):
    from tools.make_bundle import CONTRACT_VERSION as BUNDLE_VERSION
    from tools.make_bundle import config_hash

    manifest = b'{"files": []}\n'
    (server_data / "manifest.json").write_bytes(manifest)
    r = instant_client.get(f"{PREFIX}/engine/version")
    assert r.status_code == 200, r.text
    v = r.json()
    assert_valid(v, "/engine/version")
    assert v["commit"] == git("rev-parse", "HEAD")
    assert v["engine_tree"] == git("rev-parse", "HEAD:pipeline")
    assert v["config_hash"] == config_hash()  # D57: backend.yaml left out
    assert v["terrain_hash"] == "sha256:" + hashlib.sha256(manifest).hexdigest()
    assert v["backend_contract_version"] == OPENAPI["info"]["version"]
    assert v["backend_contract_version"] == settings().contract_version
    assert v["bundle_contract_version"] == BUNDLE_VERSION
    # web family = the newest x-contract-version of contracts/*.schema.json, and it is the newest
    # entry of contracts/README.md "Changes"
    readme = (REPO / "contracts" / "README.md").read_text(encoding="utf-8")
    newest = max(re.findall(r"^### v(\d+\.\d+\.\d+)", readme, re.M),
                 key=lambda t: tuple(map(int, t.split("."))))
    assert v["web_contract_version"] == newest


def test_engine_version_terrain_hash_follows_the_manifest(instant_client, server_data):
    (server_data / "manifest.json").write_bytes(b"a")
    h1 = instant_client.get(f"{PREFIX}/engine/version").json()["terrain_hash"]
    (server_data / "manifest.json").write_bytes(b"b")
    h2 = instant_client.get(f"{PREFIX}/engine/version").json()["terrain_hash"]
    assert h1 == "sha256:" + hashlib.sha256(b"a").hexdigest()
    assert h2 != h1


def test_engine_version_without_server_data_is_an_error_not_a_made_up_hash(instant_client,
                                                                          server_data):
    r = instant_client.get(f"{PREFIX}/engine/version")
    assert r.status_code == 503
    assert r.json()["error"] == "server_data_missing"
    assert_valid(r.json(), "/jobs/{id}", "404")  # the shared Error schema


# ----------------------------------------------------------------------------- /defaults ----
def test_defaults_known_answers(instant_client):
    r = instant_client.get(f"{PREFIX}/defaults")
    assert r.status_code == 200
    d = r.json()
    assert_valid(d, "/defaults")
    inp = d["inputs"]
    assert "title" not in inp
    assert inp["contract_version"] == settings().contract_version == OPENAPI["info"]["version"]
    # F26 table (spec §3): 75 kg, 104 kg, 10 kg, 36 mL/kg/min, 50 %
    assert inp["crew"] == {"body_mass_kg": 75, "suit_kg": 104, "tools_kg": 10,
                           "vo2max_ml_kg_min": 36, "effort_cap_frac": 0.5}
    # official pad = the D21 rank-1 pad of scenarios/pads/index.json (contracts example)
    official = json.loads((B / "examples" / "plan_inputs.official.json").read_text())
    assert inp["pad"] == official["pad"] == {"id": "rank1", "lon": 137.401783, "lat": -4.77748}
    assert inp["stations"] == {"mode": "best"}
    assert inp["eva"] == {"duration_h": 6.5, "reserve_min": 30, "start_lmst_h": 9.0,
                          "walkback_budgets_min": [30, 60]}
    assert inp["conditions"] == {"storm": "2024-05-20", "tripwire_at": "route_max_t_home",
                                 "d_allow_mgy": 0.5}


def test_defaults_ranges_are_backend_yaml(instant_client):
    d = instant_client.get(f"{PREFIX}/defaults").json()
    cfg = settings().ranges
    for name, rng in cfg.items():
        assert d["ranges"][name]["min"] == rng.min and d["ranges"][name]["max"] == rng.max
    assert d["ranges"]["suit_kg"] == {"min": 60, "max": 180, "default": 104,
                                      "precomputed": [80, 104, 120]}
    assert d["ranges"]["user_points_max"] == cfg.user_points_max == 3
    # every default sits inside its range
    inp = d["inputs"]
    for k, v in inp["crew"].items():
        assert cfg[k].contains(v)
    assert all(cfg["walkback_budget_min"].contains(v) for v in inp["eva"]["walkback_budgets_min"])
    assert cfg["eva_duration_h"].contains(inp["eva"]["duration_h"])
    assert cfg["start_lmst_h"].contains(inp["eva"]["start_lmst_h"])
    assert cfg["d_allow_mgy"].contains(inp["conditions"]["d_allow_mgy"])


def test_defaults_stations_and_pads_are_the_published_files(instant_client):
    data = REPO / "web" / "public" / "data"
    d = instant_client.get(f"{PREFIX}/defaults").json()
    assert d["stations"] == json.loads((data / "stations.json").read_text(encoding="utf-8"))
    pads = json.loads((data / "scenarios" / "pads" / "index.json").read_text(encoding="utf-8"))
    want = [p for p in pads["pads"] if p.get("official") or p.get("picker")]
    assert d["pads"] == want
    assert [p["id"] for p in d["pads"] if p.get("official")] == [d["inputs"]["pad"]["id"]]


# ---------------------------------------------------------------------------------- CORS ----
def test_cors_allows_the_configured_origins_only(instant_client):
    for origin in settings().api.cors_origins:
        r = instant_client.get(f"{PREFIX}/health", headers={"Origin": origin})
        assert r.headers.get("access-control-allow-origin") == origin
        pre = instant_client.options(f"{PREFIX}/health", headers={
            "Origin": origin, "Access-Control-Request-Method": "GET"})
        assert pre.status_code == 200
    r = instant_client.get(f"{PREFIX}/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers


def test_no_auto_generated_api_description():
    # openapi.yaml is the source of truth (F35); FastAPI's own schema/docs would diverge from it
    with TestClient(create_app(warmup=lambda: None)) as c:
        assert c.get("/openapi.json").status_code == 404
        assert c.get("/docs").status_code == 404

"""API docs at api.docs_path (/api/docs) from the committed openapi.yaml (WS12 brief task 10; F35;
D69).

Known answers (written before the routes):
- /api/docs answers 200 with FastAPI's Swagger UI page, pointed at /api/openapi.json;
- /api/openapi.json is contracts/backend/openapi.yaml (the contract), so every openapi path appears;
- every relative $ref and externalValue of the contract resolves under /api/ (the backend schemas
  and examples), and nothing else of the repo is served there;
- every route the app implements under the API prefix is an openapi path, with no exception (the
  admin kill-switch control POST /admin/heavy-jobs joined the contract in v1.1.0, S1e);
- FastAPI's own generated description stays off (/openapi.json, /docs: 404).
"""

from __future__ import annotations

import json
import posixpath
import re

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.routing import APIRoute  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.app import create_app  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests.test_app import OPENAPI, B  # noqa: E402

DOCS = settings().api.docs_path
BASE = posixpath.dirname(DOCS)  # /api
SPEC_URL = f"{BASE}/openapi.json"
PREFIX = settings().api.prefix


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app(warmup=lambda: None)) as c:
        yield c


def refs(node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if k in ("$ref", "externalValue") and isinstance(v, str) and not v.startswith("#"):
                out.add(v.split("#", 1)[0])
            else:
                refs(v, out)
    elif isinstance(node, list):
        for v in node:
            refs(v, out)
    return out


def test_docs_path_is_the_config_value():
    assert DOCS == "/api/docs" and SPEC_URL == "/api/openapi.json"


def test_api_docs_page_answers_200_and_points_at_the_contract(client):
    r = client.get(DOCS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert "swagger-ui" in r.text.lower()
    assert f"'{SPEC_URL}'" in r.text or f'"{SPEC_URL}"' in r.text


def test_openapi_json_is_the_committed_contract_with_every_path(client):
    r = client.get(SPEC_URL)
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    doc = r.json()
    assert doc == json.loads(json.dumps(OPENAPI))  # YAML 1.2 load: "on"/"off" stay strings
    assert doc["info"]["version"] == OPENAPI["info"]["version"] == settings().contract_version
    assert set(doc["paths"]) == set(OPENAPI["paths"])
    for path in OPENAPI["paths"]:
        assert path in doc["paths"]
    assert doc["servers"] == [{"url": PREFIX}]
    health = doc["components"]["schemas"]["Health"]["properties"]
    assert health["heavy_jobs"]["enum"] == ["on", "off"]


def test_every_relative_ref_of_the_contract_is_served(client):
    found = refs(OPENAPI, set())
    for p in B.glob("*.schema.json"):
        refs(json.loads(p.read_text(encoding="utf-8")), found)
    assert "plan_inputs.schema.json" in found and "examples/job.queued.json" in found
    for rel in sorted(found):
        url = posixpath.normpath(posixpath.join(BASE, rel))
        r = client.get(url)
        assert r.status_code == 200, url
        assert r.json() == json.loads((B / rel).read_text(encoding="utf-8")), url


@pytest.mark.parametrize("path", [
    "README.md", "openapi.yaml", "../backend.yaml", "examples/README.md",
    "..%2Fconfig%2Fbackend.yaml", "examples/../../README.md", "nope.schema.json", ".hidden.json",
    "examples/..%2F..%2FREADME.json", "v1/health.schema.json"])
def test_nothing_else_is_served_under_the_docs_base(client, path):
    assert client.get(f"{BASE}/{path}").status_code == 404


def shape(path: str) -> str:
    """A path with its parameter names dropped: /jobs/{job_id} and /jobs/{id} are one path."""
    return re.sub(r"\{[^}]+\}", "{}", path)


def routes(app):
    """(path, methods) of every route (FastAPI >= 0.16x wraps included routers)."""
    from fastapi import routing
    if hasattr(routing, "iter_route_contexts"):
        return [(c.path, c.methods or set()) for c in routing.iter_route_contexts(app.routes)]
    return [(r.path, r.methods) for r in app.routes if isinstance(r, APIRoute)]


def test_every_implemented_route_is_an_openapi_path(client):
    implemented = set()
    for path, methods in routes(client.app):
        if path.startswith(PREFIX + "/"):
            implemented |= {(m, shape(path[len(PREFIX):])) for m in methods}
    assert ("POST", "/plans/import") in implemented and ("GET", "/admin/status") in implemented
    assert ("POST", "/admin/heavy-jobs") in implemented
    contract = {shape(p): ops for p, ops in OPENAPI["paths"].items()}
    for method, path in sorted(implemented):
        assert path in contract, path
        assert method.lower() in contract[path], (method, path)


def test_fastapi_generated_description_stays_off(client):
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/docs").status_code == 404

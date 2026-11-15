"""API documentation (F35 "API docs: OpenAPI at /api/docs (source openapi.yaml)"; WS12 brief task
10; D69).

- ``{api.docs_path}`` (/api/docs): FastAPI's Swagger UI page (fastapi.openapi.docs), pointed at
  the committed contract.
- ``/api/openapi.json``: contracts/backend/openapi.yaml as JSON. The contract is the description,
  so the documented paths are exactly the contract's (FastAPI's own generated schema stays off: it
  would describe only what is implemented, in its own words; server/app.py).
- ``/api/{name}.schema.json`` and ``/api/examples/{name}.json``: the backend schemas and examples
  the contract references by relative URL ($ref, externalValue), so the page resolves them. Only
  the files listed at start-up are served (no path from the request reaches the file system).

openapi.yaml is YAML 1.2 (OpenAPI 3.1): only true/false are booleans, so the Health enum
``["on", "off"]`` stays two strings (PyYAML's YAML 1.1 rules would load booleans).
"""

from __future__ import annotations

import json
import posixpath
import re
from functools import cache
from pathlib import Path

import yaml
from fastapi import APIRouter
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import HTMLResponse, Response

from server.settings import settings

REPO = Path(__file__).resolve().parents[3]
CONTRACT_DIR = REPO / "contracts" / "backend"
OPENAPI_FILE = CONTRACT_DIR / "openapi.yaml"
REVALIDATE = {"Cache-Control": "no-cache"}  # the contract can change with a deploy


class _Yaml12Loader(yaml.SafeLoader):
    """SafeLoader with YAML 1.2 booleans (true/false only)."""


_Yaml12Loader.yaml_implicit_resolvers = {
    k: [(tag, rx) for tag, rx in v if tag != "tag:yaml.org,2002:bool"]
    for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()}
_Yaml12Loader.add_implicit_resolver("tag:yaml.org,2002:bool", re.compile(r"^(?:true|false)$"),
                                    list("tf"))


@cache
def openapi_json() -> bytes:
    doc = yaml.load(OPENAPI_FILE.read_text(encoding="utf-8"), Loader=_Yaml12Loader)
    return json.dumps(doc, ensure_ascii=False).encode("utf-8")


@cache
def contract_files() -> dict[str, bytes]:
    """Relative URL -> bytes of every backend schema and example (validated as JSON)."""
    out = {}
    for p in [*CONTRACT_DIR.glob("*.schema.json"), *CONTRACT_DIR.glob("examples/*.json")]:
        rel = p.relative_to(CONTRACT_DIR).as_posix()
        if not any(part.startswith(".") for part in rel.split("/")):
            raw = p.read_bytes()
            json.loads(raw)
            out[rel] = raw
    return out


def build_router() -> APIRouter:
    docs_path = settings().api.docs_path
    base = posixpath.dirname(docs_path)  # /api
    spec_url = f"{base}/openapi.json"
    router = APIRouter(include_in_schema=False)

    @router.get(docs_path)
    def api_docs() -> HTMLResponse:
        return get_swagger_ui_html(openapi_url=spec_url, title="HOMELINE live API")

    @router.get(spec_url)
    def api_openapi() -> Response:
        return Response(openapi_json(), media_type="application/json", headers=REVALIDATE)

    def serve(rel: str) -> Response:
        raw = contract_files().get(rel)
        if raw is None:
            return Response(json.dumps({"error": "not_found", "detail": rel}),
                            status_code=404, media_type="application/json")
        return Response(raw, media_type="application/json", headers=REVALIDATE)

    @router.get(base + "/{name}.schema.json")
    def api_schema(name: str) -> Response:
        return serve(f"{name}.schema.json")

    @router.get(base + "/examples/{name}.json")
    def api_example(name: str) -> Response:
        return serve(f"examples/{name}.json")

    return router

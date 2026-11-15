"""POST /plans/import (openapi importPlan; WS12 plan row 2.5, brief task 6; F28; spec §8).

Checks, in order (the same order as the web client, web/src/live/planio.ts):
1. size: more than ``limits.upload_max_bytes`` → 413 ``too_large`` (by Content-Length when sent,
   and by the bytes actually read, so a missing or lying header changes nothing);
2. JSON (UTF-8) → 422 ``invalid_json``;
3. contracts/backend/plan_inputs.schema.json, unknown fields refused at every level → 422
   ``invalid_inputs`` with the error list as ``detail``;
4. ``title`` at most ``limits.title_max_chars`` characters → 422 ``title_too_long``;
5. the route (D97), exactly as POST /jobs checks it (server.engine.route.validate): a route code
   with ``Error.stop`` (the index of the stop the detail names), or ``unsupported_inputs`` with
   ``stop`` for a free point (not planned yet).

200 ImportResult: ``hash`` (the D57 result hash, the one POST /jobs takes for the same inputs),
``inputs`` (canonical inputs plus the title and free-point labels, as the run record keeps
them) and ``computed`` (a
complete result tree exists: the precomputed official tree or a done cache tree). An import never
starts a job; the client starts one when ``computed`` is false (U3).
Without an engine identity (no server data manifest, no git) the hash cannot be taken: 503 Error
(server_data_missing / engine_identity_unavailable), as POST /jobs answers.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from server.api.compute.results import Identity
from server.engine import jobs, version
from server.engine import route as route_mod
from server.engine.hashing import EngineIdentity, InvalidPlanInputs, canonical_inputs, result_hash
from server.settings import settings

NO_STORE = {"Cache-Control": "no-store"}

router = APIRouter(tags=["plans"])


def _error(status: int, code: str, detail, **extra) -> JSONResponse:
    return JSONResponse({"error": code, "detail": detail, **extra}, status_code=status,
                        headers=NO_STORE)


async def _read_capped(request: Request, cap: int) -> bytes | None:
    """The body, or None as soon as it is longer than ``cap`` bytes."""
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > cap:
                return None
        except ValueError:
            pass  # h11 refuses a malformed header before this; the byte count decides anyway
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > cap:
            return None
    return bytes(body)


def _parse(raw: bytes):
    """The JSON document; raises ValueError (also for non-UTF-8 and NaN/Infinity)."""
    def no_constants(name):
        raise ValueError(f"{name} is not JSON")

    return json.loads(raw.decode("utf-8"), parse_constant=no_constants)


@router.post("/plans/import", operation_id="importPlan")
async def import_plan(request: Request, identity: Identity) -> JSONResponse:
    lim = settings().limits
    raw = await _read_capped(request, lim.upload_max_bytes)
    if raw is None:
        return _error(413, "too_large",
                      f"a plan_inputs.json is at most {lim.upload_max_bytes} bytes "
                      "(limits.upload_max_bytes)")
    try:
        doc = _parse(raw)
    except ValueError as e:  # UnicodeDecodeError and JSONDecodeError are ValueErrors
        return _error(422, "invalid_json", f"the body is not JSON: {e}")
    if not isinstance(doc, dict):
        return _error(422, "invalid_inputs", ["(root): the body must be a plan_inputs object"])
    try:
        canonical = canonical_inputs(doc)
    except InvalidPlanInputs as e:
        return _error(422, "invalid_inputs", e.errors)
    title = doc.get("title")
    if isinstance(title, str) and len(title) > lim.title_max_chars:
        return _error(422, "title_too_long",
                      f"the title has {len(title)} characters; at most {lim.title_max_chars} "
                      "(limits.title_max_chars)")
    try:
        route_mod.validate(doc)
    except route_mod.RouteError as e:
        return _error(422, e.code, e.detail, stop=e.stop)
    try:
        ident = EngineIdentity(*identity())
    except version.Unavailable as e:
        msg = str(e)
        return _error(503, "server_data_missing" if "manifest" in msg
                      else "engine_identity_unavailable", msg)
    h = result_hash(doc, ident)
    inputs = route_mod.record_inputs(doc, canonical)
    computed = jobs.result_done(h, lambda: ident)
    return JSONResponse({"hash": h, "inputs": inputs, "computed": computed}, headers=NO_STORE)

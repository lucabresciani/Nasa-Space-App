"""GET /results/{hash}/provenance and GET /results/{hash}/{path} (openapi.yaml getProvenance,
getResultFile; F23, F35; WS11 plan row 1.3).

The web app loads a live result through ``dataUrl(path, mode, base)`` with
``base = ${server}/api/v1/results/${hash}`` (S6), so ``<base>/<path>`` serves every file of the
static data tree under the same relative path. Resolution and path safety: server.engine.results.

Responses:
- 200: the file, with its media type, ``Cache-Control: public, max-age=31536000, immutable``
  (spec §5: result trees are immutable) once the tree is complete (precomputed, or its
  run_record.json exists); ``no-store`` while a job is still publishing its stages; a strong
  content ETag (304 on a matching
  If-None-Match) and ``X-Content-Type-Options: nosniff``. ``run_record.json`` and ``provenance``
  of the official (precomputed) tree are the synthesised, validated run record.
- 404 (openapi Error): unknown or malformed hash, invalid path (traversal, hidden, backslash ...),
  missing file, directory, symlink out of the tree. Codes: unknown_result, invalid_path,
  file_not_found.
- 503 (Error, as /engine/version): the live identity is unavailable, so the official hash cannot be
  computed and the hash is not in the cache. Codes: server_data_missing (no
  $HL_SERVER_DATA/manifest.json), engine_identity_unavailable (no git).
Errors carry ``Cache-Control: no-store``: a result that is missing now can be written later.
"""

from __future__ import annotations

import hashlib
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from server.engine import results, version
from server.engine.hashing import engine_identity

IMMUTABLE = "public, max-age=31536000, immutable"
NO_STORE = "no-store"

router = APIRouter(tags=["results"])


def identity_provider() -> results.IdentityProvider:
    """The engine identity source (a FastAPI dependency, so tests can inject one)."""
    return engine_identity


Identity = Annotated[results.IdentityProvider, Depends(identity_provider)]


def _error(status: int, code: str, detail: str) -> JSONResponse:
    """openapi.yaml Error body."""
    return JSONResponse({"error": code, "detail": detail}, status_code=status,
                        headers={"Cache-Control": NO_STORE})


def _unavailable(e: version.Unavailable) -> JSONResponse:
    msg = str(e)
    code = "server_data_missing" if "manifest" in msg else "engine_identity_unavailable"
    return _error(503, code, msg)


def _headers(tag: str, complete: bool = True) -> dict[str, str]:
    return {"Cache-Control": IMMUTABLE if complete else NO_STORE, "ETag": tag,
            "X-Content-Type-Options": "nosniff"}


def complete(tree: results.ResultTree) -> bool:
    """A tree is immutable once it is complete: the precomputed tree, or a computed tree whose
    run_record.json exists (the job runner writes it last). Files of a tree still being written
    (a running plan job publishes stage by stage, D81) are served with no-store."""
    return tree.precomputed or (tree.root / results.RUN_RECORD).is_file()


def _not_modified(request: Request, tag: str) -> bool:
    given = request.headers.get("if-none-match")
    if not given:
        return False
    tags = {t.strip().removeprefix("W/") for t in given.split(",")}
    return "*" in tags or tag in tags


def _serve(request: Request, h: str, path: str, identity: results.IdentityProvider) -> Response:
    try:
        tree = results.resolve_tree(h, identity)
        if tree.precomputed and path == results.RUN_RECORD:
            body = results.precomputed_run_record(tree)
            tag = results.etag(hashlib.sha256(body).hexdigest())
            if _not_modified(request, tag):
                return Response(status_code=304, headers=_headers(tag))
            return Response(body, media_type="application/json", headers=_headers(tag))
        f = results.resolve_file(tree, path)
        tag = results.etag(results.file_sha256(f))
        done = complete(tree)
    except results.ResultNotFound as e:
        return _error(404, e.code, e.detail)
    except version.Unavailable as e:
        return _unavailable(e)
    if _not_modified(request, tag):
        return Response(status_code=304, headers=_headers(tag, done))
    return FileResponse(f, media_type=results.media_type(path), headers=_headers(tag, done))


@router.get("/results/{hash}/provenance", operation_id="getProvenance")
def get_provenance(hash: str, request: Request,
                   identity: Identity) -> Response:
    return _serve(request, hash, results.RUN_RECORD, identity)


@router.get("/results/{hash}/{path:path}", operation_id="getResultFile")
def get_result_file(hash: str, path: str, request: Request,
                    identity: Identity) -> Response:
    return _serve(request, hash, path, identity)

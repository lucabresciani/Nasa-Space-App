"""Team-only operations (WS12 plan row 2.5, brief tasks 4 and 7; F36): GET /admin/status
(openapi getAdminStatus, security teamToken) and the kill-switch control.

- **Team token.** The ``X-HL-Team`` header (openapi securitySchemes.teamToken) is compared in
  constant time (hmac.compare_digest) with ``$HL_TEAM_TOKEN``, read from the environment at each
  request (never from the repo, never logged, never echoed). Without a configured token, admin is
  disabled: every admin request is 403 ``admin_disabled``. A missing or wrong token is 403
  ``forbidden``.
- **Status.** openapi AdminStatus (``queue_length``, ``heavy_jobs``, ``cache_gb``) plus, as extra
  properties the schema allows: ``uptime_s``, ``workers``, ``workers_alive``,
  ``queue_max_waiting``, ``cache_max_gb``, ``pinned`` (server.api.plans.pinning) and ``engine``
  (/engine/version, or null with ``engine_error`` when the identity is unavailable). The job-time
  and error-rate fields (``running``, ``job_seconds_p50``, ``errors_last_h``) are left out: the job
  runner keeps no public history to take them from (O3 note).
- **Kill-switch control.** ``POST /admin/heavy-jobs`` with ``{"heavy_jobs": "on" | "off"}`` flips
  the runner's switch (server.engine.jobs.set_heavy_jobs_off, the deploy.kill_switch_env variable
  of this process) and answers the status. This route is NOT in the frozen contract
  (openapi.yaml v1.0.1 has only GET /admin/status); it is a team-only control asked for by the
  orchestrator (O3) and listed for C to add to the contract or drop.
"""

from __future__ import annotations

import hmac
import os
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from server.api.compute.results import Identity
from server.api.plans import pinning
from server.engine import jobs, version
from server.engine.hashing import EngineIdentity
from server.settings import settings

TEAM_TOKEN_ENV = "HL_TEAM_TOKEN"  # environment only (brief rule 3); .env.example lists the name
TEAM_HEADER = "X-HL-Team"  # openapi components.securitySchemes.teamToken
NO_STORE = {"Cache-Control": "no-store"}
STARTED = time.monotonic()  # import of the API module = process start (uvicorn server.app:app)

router = APIRouter(tags=["ops"])


def _error(status: int, code: str, detail) -> JSONResponse:
    return JSONResponse({"error": code, "detail": detail}, status_code=status, headers=NO_STORE)


def token_ok(given: str | None) -> bool:
    """Constant-time check of ``given`` against $HL_TEAM_TOKEN (False when none is configured)."""
    want = os.environ.get(TEAM_TOKEN_ENV, "")
    if not want:
        return False
    return hmac.compare_digest((given or "").encode("utf-8"), want.encode("utf-8"))


def _refused(request: Request) -> JSONResponse | None:
    if not os.environ.get(TEAM_TOKEN_ENV):
        return _error(403, "admin_disabled", f"admin is disabled: {TEAM_TOKEN_ENV} is not set")
    if not token_ok(request.headers.get(TEAM_HEADER)):
        return _error(403, "forbidden", f"a valid {TEAM_HEADER} team token is required")
    return None


def _status(request: Request, identity) -> dict:
    runner: jobs.JobRunner = request.app.state.jobs
    cfg = settings()
    out = {
        "queue_length": runner.queue_length,
        "heavy_jobs": "off" if jobs.heavy_jobs_off() else "on",
        "uptime_s": round(time.monotonic() - STARTED, 3),
        "workers": runner.workers,
        "workers_alive": sum(1 for p in runner.processes() if p.is_alive()),
        "queue_max_waiting": runner.queue_max_waiting,
        "cache_max_gb": cfg.cache.max_gb,
    }
    try:
        out["cache_gb"] = round(pinning.cache_bytes() / 1e9, 6)
    except version.Unavailable:  # no server data dir configured: nothing cached
        out["cache_gb"] = 0.0
    try:
        ident = EngineIdentity(*identity())
        code = version.code_identity()
        out["engine"] = {
            "engine_tree": ident.engine_tree, "commit": code["commit"],
            "config_hash": ident.config_hash, "terrain_hash": ident.terrain_hash,
            "web_contract_version": code["web_contract_version"],
            "backend_contract_version": code["backend_contract_version"],
            "bundle_contract_version": code.get("bundle_contract_version"),
        }
        out["pinned"] = pinning.pinned_hashes(ident)
    except version.Unavailable as e:
        out["engine"], out["engine_error"], out["pinned"] = None, str(e), []
    return out


@router.get("/admin/status", operation_id="getAdminStatus")
def get_admin_status(request: Request, identity: Identity) -> JSONResponse:
    refused = _refused(request)
    if refused is not None:
        return refused
    return JSONResponse(_status(request, identity), headers=NO_STORE)


@router.post("/admin/heavy-jobs", operation_id="setHeavyJobs", include_in_schema=False)
async def set_heavy_jobs(request: Request, identity: Identity) -> JSONResponse:
    refused = _refused(request)
    if refused is not None:
        return refused
    try:
        body = await request.json()
    except ValueError:
        return _error(422, "invalid_request", "the body is not JSON")
    if not isinstance(body, dict) or set(body) != {"heavy_jobs"} \
            or body["heavy_jobs"] not in ("on", "off"):
        return _error(422, "invalid_request", 'the body must be {"heavy_jobs": "on" | "off"}')
    jobs.set_heavy_jobs_off(body["heavy_jobs"] == "off")
    return JSONResponse(_status(request, identity), headers=NO_STORE)

"""POST /jobs and GET /jobs/{id} (openapi.yaml createJob, getJob; F23; WS11 plan row 2.3).

Submit answers at once and never waits on a job; the client polls GET /jobs/{id} (U1 polls with
backoff and honours retry_after_s). Runner, queue cap, timeout and de-duplication:
server.engine.jobs. Every body is contracts/backend/job.schema.json (202, 200) or the openapi Error
(4xx, 5xx), all with ``Cache-Control: no-store`` (a job changes while it runs).

Responses of POST /jobs:
- 202 Job: queued, attached to the queued or running job with the same result hash
  (``attached: true``), or ``done`` at once when the hash's result tree is complete.
- 422 Error: invalid_request (not a JobRequest object: unknown key, missing or unknown type,
  inputs not an object), invalid_inputs (plan_inputs schema; detail = the error list), a route
  code (D97, server.engine.route: route_too_many_stops, route_station_unknown, ...; ``stop`` = the
  index of the stop the detail names, null for the whole route) and unsupported_inputs with
  ``stop`` for a free point of an ordered route (not planned yet).
- 429 Error + Retry-After: queue_full (compute.queue_max_waiting), retry_after_s set.
- 503 Error: heavy_jobs_off (kill switch deploy.kill_switch_env), job_type_unavailable (a contract
  type with no handler on this server, e.g. siting before its package), server_data_missing /
  engine_identity_unavailable (the result hash cannot be taken).
GET /jobs/{id}: 200 Job, 404 Error unknown_job.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from server.api.compute.results import Identity
from server.engine import jobs, version
from server.engine import route as route_mod
from server.engine.hashing import EngineIdentity, InvalidPlanInputs, canonical_inputs, result_hash
from server.settings import settings

NO_STORE = {"Cache-Control": "no-store"}
REQUEST_KEYS = {"type", "inputs", "replan"}  # openapi JobRequest (additionalProperties: false)

router = APIRouter(tags=["compute"])


def _error(status: int, code: str, detail, retry_after_s: int | None = None,
           **extra) -> JSONResponse:
    body = {"error": code, "detail": detail, **extra}
    headers = dict(NO_STORE)
    if retry_after_s is not None:
        body["retry_after_s"] = retry_after_s
        headers["Retry-After"] = str(retry_after_s)
    return JSONResponse(body, status_code=status, headers=headers)


def _request_errors(body) -> list[str]:
    if not isinstance(body, dict):
        return ["the body must be a JobRequest object"]
    errs = [f"unknown key {k!r}" for k in sorted(set(body) - REQUEST_KEYS)]
    if body.get("type") not in jobs.JOB_TYPE_NAMES:
        errs.append(f"type must be one of {list(jobs.JOB_TYPE_NAMES)}")
    if not isinstance(body.get("inputs"), dict):
        errs.append("inputs (plan_inputs) is required and must be an object")
    if "replan" in body and not isinstance(body["replan"], dict):
        errs.append("replan must be an object")
    return errs


def _record_base(h: str, canonical: dict, ident: EngineIdentity, code: dict) -> dict:
    """The run_record.json fields known at submit time (the worker adds times, stages, files)."""
    cfg = settings()
    return {
        "contract_version": cfg.contract_version,
        "hash": h,
        "origin": "computed_live",
        "label": cfg.labels.live,
        "inputs": canonical,
        "engine": {
            "tree": ident.engine_tree,
            "commit": code["commit"],
            "config_hash": ident.config_hash,
            "web_contract_version": code["web_contract_version"],
            "backend_contract_version": code["backend_contract_version"],
        },
        "terrain_hash": ident.terrain_hash,
    }


@router.post("/jobs", operation_id="createJob")
async def create_job(request: Request, identity: Identity) -> JSONResponse:
    try:
        body = await request.json()
    except ValueError:
        return _error(422, "invalid_request", "the body is not JSON")
    errs = _request_errors(body)
    if errs:
        return _error(422, "invalid_request", errs)
    raw = body["inputs"]
    try:
        canonical = canonical_inputs(raw)
    except InvalidPlanInputs as e:
        return _error(422, "invalid_inputs", e.errors)
    try:
        route_mod.validate(raw)
    except route_mod.RouteError as e:
        return _error(422, e.code, e.detail, stop=e.stop)
    try:
        ident = EngineIdentity(*identity())
        code = version.code_identity()
    except version.Unavailable as e:
        msg = str(e)
        return _error(503, "server_data_missing" if "manifest" in msg
                      else "engine_identity_unavailable", msg)
    h = result_hash(raw, ident)
    # run record inputs: what was hashed, plus the title and free-point labels if any
    # (run_record.schema.json)
    job_inputs = route_mod.record_inputs(raw, canonical)
    runner: jobs.JobRunner = request.app.state.jobs
    try:
        job = runner.submit(body["type"], h, job_inputs, _record_base(h, job_inputs, ident, code),
                            done=lambda: jobs.result_done(h, lambda: ident))
    except jobs.UnknownJobType as e:
        return _error(503, "job_type_unavailable", str(e))
    except jobs.HeavyJobsOff as e:
        return _error(503, "heavy_jobs_off", f"heavy jobs are switched off ({e})")
    except jobs.QueueFull as e:
        return _error(429, "queue_full", str(e), retry_after_s=e.retry_after_s)
    return JSONResponse(job, status_code=202, headers=NO_STORE)


@router.get("/jobs/{job_id}", operation_id="getJob")
def get_job(job_id: str, request: Request) -> JSONResponse:
    job = request.app.state.jobs.status(job_id)
    if job is None:
        return _error(404, "unknown_job", f"no job {job_id!r} on this server")
    return JSONResponse(job, headers=NO_STORE)

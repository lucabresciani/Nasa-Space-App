"""HOMELINE live API (F23; WS11 plan rows 1.1, 1.3, 2.3): GET /health, /engine/version, /defaults,
/results/{hash}/... (server.api.compute.results), POST /jobs, GET /jobs/{id}
(server.api.compute.jobs).

Run: ``uv run --no-sync uvicorn server.app:app`` (``make serve``), then
http://localhost:8000/api/v1/health. Contract: contracts/backend/openapi.yaml (v1.0.0); prefix,
CORS origins and the kill-switch variable come from config/backend.yaml (server.settings).

/health answers at once; ``engine_warm`` turns true only after the start-up work, which the
lifespan runs in a background thread: the Numba warm-up of the engine kernels, then the preload of
the pad tool's server data (server.engine.warmup), so the first /pads request needs no load. The
lifespan also starts the job runner (server.engine.jobs: compute.workers processes, started once
the start-up work has finished; each worker runs ``warmup.worker_init`` first) and stops it at
shutdown.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from server.api.auth import HeavyJobLimiter, admin_router
from server.api.compute import jobs_router, results_router
from server.api.plans import build_docs_router, import_router
from server.api.plans.pinning import evict_after_new_job
from server.engine import defaults as engine_defaults
from server.engine import version as engine_version
from server.engine.jobs import JobRunner
from server.engine.warmup import EngineState, preload_server_data, warm_engine, worker_init
from server.settings import settings


def heavy_jobs() -> str:
    """'off' while the kill switch (config deploy.kill_switch_env) is set to a non-empty value."""
    return "off" if os.environ.get(settings().deploy.kill_switch_env) else "on"


def error(status: int, code: str, detail: str) -> JSONResponse:
    """openapi.yaml Error body."""
    return JSONResponse({"error": code, "detail": detail}, status_code=status)


meta = APIRouter(tags=["meta"])


@meta.get("/health", operation_id="getHealth")
def get_health(request: Request) -> dict:
    state: EngineState = request.app.state.engine
    return {"ok": state.ok, "engine_warm": state.warm,
            "queue_length": request.app.state.jobs.queue_length,
            "heavy_jobs": heavy_jobs()}


@meta.get("/engine/version", operation_id="getEngineVersion")
def get_engine_version():
    try:
        return engine_version.engine_version()
    except engine_version.Unavailable as e:
        msg = str(e)
        code = "server_data_missing" if "manifest" in msg else "engine_identity_unavailable"
        return error(503, code, msg)


@meta.get("/defaults", operation_id="getDefaults")
def get_defaults() -> dict:
    return engine_defaults.defaults()


def start_up(warmup: Callable[[], object],
             preload: Callable[[], object] | None) -> Callable[[], None]:
    """The start-up work /health waits for: the warm-up, then the preload."""
    def run() -> None:
        warmup()
        if preload is not None:
            preload()
    return run


def create_app(warmup: Callable[[], object] = warm_engine,
               jobs: JobRunner | None = None,
               preload: Callable[[], object] | None = preload_server_data,
               initializer: Callable[[], object] | None = worker_init) -> FastAPI:
    """The API app; ``warmup`` is injectable so tests need not wait for the Numba compiler,
    ``preload`` (run after it, before /health turns warm) so tests can count server data loads,
    and ``jobs`` so tests can run the runner with test job types and small limits (default: the
    config's compute limits, the registered job types and ``initializer`` in every worker)."""
    cfg = settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:  # fixed for the life of the process; a missing git is reported by /engine/version
            engine_version.code_identity()
        except engine_version.Unavailable:
            pass
        app.state.engine.start()  # background: /health answers while the kernels compile
        app.state.jobs.start(ready=app.state.engine.wait)  # workers start after the warm-up
        try:
            yield
        finally:
            app.state.jobs.stop()

    # openapi.yaml is the API description (F35); FastAPI's generated one would diverge from it
    app = FastAPI(title="HOMELINE live API", lifespan=lifespan,
                  openapi_url=None, docs_url=None, redoc_url=None)
    app.state.engine = EngineState(start_up(warmup, preload))
    app.state.jobs = (jobs if jobs is not None
                      else JobRunner.from_config(cfg, initializer=initializer))
    # WS12: per-IP heavy-job limit on POST /jobs; added before CORS so it runs inside it (a
    # browser can read the 429)
    app.add_middleware(HeavyJobLimiter, cfg=cfg, on_new_job=evict_after_new_job)
    app.add_middleware(CORSMiddleware, allow_origins=list(cfg.api.cors_origins),
                       allow_methods=["*"], allow_headers=["*"])
    app.include_router(meta, prefix=cfg.api.prefix)
    app.include_router(results_router, prefix=cfg.api.prefix)
    app.include_router(jobs_router, prefix=cfg.api.prefix)
    app.include_router(import_router, prefix=cfg.api.prefix)  # WS12: POST /plans/import
    app.include_router(admin_router, prefix=cfg.api.prefix)  # WS12: /admin (team token)
    app.include_router(build_docs_router())  # WS12: api.docs_path from openapi.yaml (F35)
    return app


app = create_app()

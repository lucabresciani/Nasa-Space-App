# syntax=docker/dockerfile:1
# HOMELINE live API image (WS12 O1; spec §3 F36, §9). Build context = the repo root, filtered by
# /.dockerignore. Build and run through server/ops/compose.yaml (see server/ops/README.md).
#
# One process: uvicorn server.app:app. The engine job pool lives inside the app (config/backend.yaml
# compute.workers), so the container must not run several uvicorn workers.
FROM python:3.11.18-slim-bookworm

# uv pinned to the version that wrote uv.lock on the build machine
COPY --from=ghcr.io/astral-sh/uv:0.11.21 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first (cached layer): runtime + server group only, no dev group (pytest, ruff).
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-default-groups --group server

# What the server reads at run time, largest and least volatile first:
# - web/public/data: the precomputed official tree (served by hash; /defaults reads pads, stations)
# - contracts: openapi.yaml, plan_inputs/run_record schemas, web contract versions
# - config: engine config (config hash, defaults) and backend.yaml (limits, CORS)
# - pipeline: the engine, imported, never copied into server/
# - tools: make_bundle (config_hash, CONTRACT_VERSION) and the modules it imports
COPY web/public/data web/public/data
COPY contracts contracts
COPY config config
COPY pipeline pipeline
COPY tools tools
COPY server server

# Code identity (D57; /engine/version and the result hash). The image has no .git and no git: these
# are baked at build time (server/ops/up.sh) and server/engine/version.py reads them from the
# environment (40-hex each). Empty or malformed -> 503 engine_identity_unavailable.
ARG HL_COMMIT=""
ARG HL_ENGINE_TREE=""
ENV HL_COMMIT=${HL_COMMIT} \
    HL_ENGINE_TREE=${HL_ENGINE_TREE}
LABEL org.opencontainers.image.title="homeline-api" \
      org.opencontainers.image.revision=${HL_COMMIT}
COPY server/ops/healthcheck.py /usr/local/lib/hl/healthcheck.py

RUN useradd --system --uid 10001 --no-create-home --home-dir /nonexistent hl
USER hl

ENV PATH=/app/.venv/bin:$PATH \
    HL_SERVER_DATA=/srv/hl-data \
    NUMBA_CACHE_DIR=/tmp/numba-cache

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=6s --start-period=120s --retries=3 \
    CMD ["python", "/usr/local/lib/hl/healthcheck.py", "http://127.0.0.1:8000/api/v1/health"]

# Proxy headers are trusted only from FORWARDED_ALLOW_IPS (uvicorn's --forwarded-allow-ips env; set
# by compose.yaml to Caddy's fixed address 172.31.212.10). Default: 127.0.0.1 only.
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", \
     "--no-server-header"]

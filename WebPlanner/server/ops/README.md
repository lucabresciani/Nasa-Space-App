# server/ops: local Docker stack (WS12 O1, O1b)

The HOMELINE live API in Docker, behind a local Caddy reverse proxy. **Localhost only (D69, D60):**
no VM, no HTTPS deploy, no public hostname, no Supabase.

| File | What it is |
| --- | --- |
| `Dockerfile` | API image: Python 3.11 + uv, `uv sync --locked --no-default-groups --group server` (no dev group), one `uvicorn server.app:app` process, non-root user `hl`, read-only root filesystem |
| `compose.yaml` | `api` + `caddy`, both published on **127.0.0.1 only** |
| `Caddyfile` | HTTP reverse proxy: body limit, 95 s upstream ceiling. No TLS, no CORS, no cache headers |
| `up.sh` | builds and starts the stack with the code identity baked in (refuses a dirty tree) and the proxy body cap from `config/backend.yaml` |
| `healthcheck.py` | container healthcheck: `/api/v1/health` has `ok` and `engine_warm` true |
| `.env.example` | names of the optional environment variables (names only, never values) |
| `/.dockerignore` | allow-list build context (repo root) |

**No `deploy.sh`.** The D69 cut removes the HTTPS/VM deploy (WS12 task 1 narrowed to "local Docker
stack"). The deadline guard and the parity-before-switch step of spec §9 return with a deploy, if one
is ever reinstated.

## Ports

| Port (host, 127.0.0.1) | Service | Variable |
| --- | --- | --- |
| **8012** | Caddy, the stack's front door | `HL_PROXY_PORT` |
| 8013 | API directly (**checks only**: bypasses Caddy; see "Client address") | `HL_API_PORT` |

Port 8000 (the `make serve` default) is taken on the build machine, so the stack does not use it.
Neither port is ever bound to 0.0.0.0. Inside the network, uvicorn listens on `0.0.0.0:8000` and
Caddy on `:8080`.

## Commands

Run from the repo root. The shell session predates the docker group, so every Docker command goes
through `sg docker -c`. Building and running the stack is heavy, so it takes the shared lock.

```sh
# server data: a read-only bind mount; default ~/hl-data/server (make serverdata). Must exist.
export HL_SERVER_DATA=~/hl-data/server

# build + start (bakes HL_COMMIT / HL_ENGINE_TREE; refuses uncommitted changes; exports
# HL_PROXY_MAX_BODY from config/backend.yaml, so the repo venv must exist: uv sync --group server)
flock /tmp/hl-heavy.lock sg docker -c "server/ops/up.sh"

# with the admin endpoints enabled for this run only (the token lives in this shell, nowhere else)
HL_TEAM_TOKEN=<token> flock /tmp/hl-heavy.lock sg docker -c "server/ops/up.sh"
curl -s -H "X-HL-Team: <token>" http://127.0.0.1:8012/api/v1/admin/status

# the same by hand (HL_PROXY_MAX_BODY then falls back to 2MB unless exported)
export HL_COMMIT=$(git rev-parse HEAD) HL_ENGINE_TREE=$(git rev-parse HEAD:pipeline)
flock /tmp/hl-heavy.lock sg docker -c "docker compose -f server/ops/compose.yaml up -d --build"

# checks
curl -s http://127.0.0.1:8012/api/v1/health          # through Caddy
curl -s http://127.0.0.1:8013/api/v1/health          # direct
curl -s http://127.0.0.1:8012/api/v1/engine/version  # commit = HEAD; 503 server_data_missing until make serverdata
sg docker -c "docker compose -f server/ops/compose.yaml ps"
sg docker -c "docker compose -f server/ops/compose.yaml logs -f api"
ss -ltn | grep -E ':801[23]\b'                         # 127.0.0.1 only

# stop and remove containers + network (the image stays)
sg docker -c "docker compose -f server/ops/compose.yaml down"
```

Under fish, use `set -x HL_SERVER_DATA ~/hl-data/server` and `(git rev-parse HEAD)` instead of the
`export` / `$(…)` forms.

`/health` answers at once; `engine_warm` turns true after the Numba warm-up (a few seconds). The
containers are healthy only once `ok` and `engine_warm` are both true, and Caddy starts only after
the API is healthy.

## Environment

All optional (defaults in `compose.yaml`); names in `.env.example`. A `server/ops/.env` is read by
Compose and is git-ignored. No secret value is allowed in any file: `HL_TEAM_TOKEN` comes from the
shell environment of the run only.

| Variable | Default | Effect |
| --- | --- | --- |
| `HL_SERVER_DATA` | `$HOME/hl-data/server` | host dir mounted read-only at `/srv/hl-data` (the container's `HL_SERVER_DATA`). A missing dir is an error; Docker never creates it |
| `HL_COMMIT`, `HL_ENGINE_TREE` | empty | build args: code identity (below) |
| `HL_PROXY_PORT`, `HL_API_PORT` | 8012, 8013 | host ports on 127.0.0.1 |
| `HL_PROXY_MAX_BODY` | `2MB` | Caddy request body limit (413 above it). `up.sh` always sets it to `config/backend.yaml limits.proxy_max_body_bytes` (2097152 bytes); `2MB` (Caddy units: 2,000,000 bytes) is only the fallback for runs without `up.sh` |
| `HL_HEAVY_JOBS_OFF` | empty | kill switch (`config/backend.yaml deploy.kill_switch_env`); non-empty = heavy jobs off |
| `HL_TEAM_TOKEN` | empty | team token for `/api/v1/admin/*` (header `X-HL-Team`, WS12 O3). Secret: export it in the shell for the run, never in a file. Empty = admin disabled, every admin request 403 `admin_disabled` (by design) |

## What the image contains

`pyproject.toml` + `uv.lock` (deps), `web/public/data/` (the precomputed official tree the API serves
by hash; `/defaults` reads pads and stations from it), `contracts/` (without `bundle/fixtures/`),
`config/`, `pipeline/`, `tools/` (without `discovery/`), `server/`. No tests, no `.git`, no
`node_modules`, no web sources, no `data/`.

## Code identity

`/engine/version` and the result hash (D57) need the commit and the git tree of `pipeline/`.
`server/engine/version.py` (WS11 E1b) takes them from `HL_COMMIT` / `HL_ENGINE_TREE` when either is
set (both required, each exactly 40 lower-case hex), and runs `git rev-parse` only when both are
unset. The image has no `.git` and no `git` (a worktree's `.git` is a file pointing outside the build
context), so:

- `HL_COMMIT` and `HL_ENGINE_TREE` are build args, baked into the image as ENV and as the
  `org.opencontainers.image.revision` label;
- an empty or malformed value (e.g. `HL_ALLOW_DIRTY=1`) makes the API answer 503
  `engine_identity_unavailable`; it never falls back to git or invents an identity;
- `up.sh` refuses to build from a tree with uncommitted or untracked changes in the image paths, so
  the baked commit describes the files in the image. `HL_ALLOW_DIRTY=1` builds without an identity.

## Proxy rules

- **CORS:** only in the app (FastAPI `CORSMiddleware`, `config/backend.yaml api.cors_origins`). Caddy
  adds none; an origin allowed in two places breaks the browser.
- **Caching:** `/api/v1/results/*` gets `Cache-Control: public, max-age=31536000, immutable`, and
  errors get `no-store`, from the app itself (WS11 E3, PR #19). Caddy passes them through and sets
  none of its own.
- **Body limit:** `HL_PROXY_MAX_BODY` = `config/backend.yaml limits.proxy_max_body_bytes`
  (2097152), exported by `up.sh` (Caddy cannot read YAML). It is a backstop above
  `limits.upload_max_bytes` (1 MB `plan_inputs.json` import), which the app enforces exactly; the
  headroom covers the request envelope.
- **Client address (rate limits, O3):** the heavy-job limit keys on the ASGI client address only.
  Caddy has no `trusted_proxies`, so it ignores any client-sent `X-Forwarded-For` and sets it to the
  TCP peer (overwrite, never append). Uvicorn believes forwarded headers only from Caddy's fixed
  address (`FORWARDED_ALLOW_IPS=172.31.212.10` = `--forwarded-allow-ips`, on the `172.31.212.0/28`
  stack network). Through **8012** each client therefore appears with its own peer address.
  Locally the peer of a loopback-published port is the Docker bridge gateway, so local clients still
  share one address; behind a real network listener they would not.
- **Direct port 8013 bypasses all of this:** uvicorn sees the Docker gateway as the peer and ignores
  any `X-Forwarded-For` (it does not come from Caddy), so **every client on 8013 shares one rate
  limit** and there is no proxy body cap. It is for checks only; clients use 8012.
- **Timeout:** 95 s upstream response ceiling (jobs are submit + poll).

# Backend implementation plan (WS11–WS14)

> Repo copy of the Notion page "Backend implementation plan (WS11–WS14)" with the recommended
> decisions applied (user, 2026-11-14 ~20:05 CET: "implement all recommended decisions, start
> immediately"). Spec: `docs/backend.md`. Contracts: `contracts/` (backend family). Config: `config/backend.yaml`.

## 1. Decisions (D50–D57)

| # | Decision | Replaces / settles |
| --- | --- | --- |
| **D50** | Backend code starts **Sat evening**, gates shifted (option A): P0 22:00, B0 Sun 00:00, B1 03:30, B2 07:00, B3 08:00 (with G2), hardening 08:00–12:00, freeze 12:00, last deploy 23:59. Backend contracts v1.0.0 frozen at P0. | The 17:34 entry "code after G2" (P1) |
| **D51** | Domain: a free dynamic-DNS subdomain unless a team member already owns a domain. **Still open (team lead):** server owner + backup and payer until end of February 2027 (O1), Unity liaison (O5). | O2 (P2) |
| **D52** | Two plan documents: `plan_inputs.schema.json` (user inputs: jobs, import/export, library) and the frozen bundle `plan.json` (resolved identity). | P4 |
| **D53** | WS14 does not rewrite done work: golden vectors stay `pipeline/engine/golden.py` (WS2), the bundle builder stays `tools/make_bundle.py` with the new `build_plan_bundle(result_dir) -> bytes` and `LayeredSources` (C). Fixture stays at `contracts/bundle/fixtures/official_pad_v1/`. WS14 tasks 1–3 dropped. | P5 |
| **D54** | Reviewer load: WS13 runs alongside WS15 (D); WS18 starts only after WS13 is idle or B1 has passed. | P6 |
| **D55** | Share code = `HL-` + 6 Crockford base32 characters (9 in total). | P8 |
| **D56** | Parity: CI runs batch-vs-server on the synthetic world (`make parity-synthetic`); real-data parity runs locally (`make parity`) before every merge touching `server/engine`, and in `deploy.sh`. | P7 |
| **D57** | Result hash = canonical inputs + engine tree (`git rev-parse HEAD:pipeline`) + engine config hash (all `config/*.yaml` except `backend.yaml`) + terrain hash; 16 hex. `tools/make_bundle.config_hash` excludes `backend.yaml` too (fixture unchanged). | Spec F23 hash ("engine commit" would invalidate the cache on every commit) |

## 2. State at P0 (2026-11-14 ~20:20 CET)

| Item | State |
| --- | --- |
| Core app and data | Published (main `d943f39`) |
| Bundle contracts v1.0.0, fixture, `physio/golden.json` | Done before P0 |
| `contracts/` backend family v1.0.0 (plan_inputs, run_record, job, telemetry, openapi.yaml) + tests | P0 step 3 (C, PR) |
| `config/backend.yaml` + `server/settings.py` loader + tests | P0 step 2 (C, PR) |
| Server dependency group (fastapi, uvicorn, pydantic, httpx, pyjwt, psycopg) in `pyproject.toml`; CI job `uv sync --group server` | P0 step 4 (C, PR) |
| Web loader base URL (`dataUrl(path, mode, base)`, `browserFetcher(mode, base)`) + test | P0 step 6 (C for WS5, PR) |
| `tools/make_bundle.build_plan_bundle` + `LayeredSources` + tests (empty result tree = fixture byte for byte) | P0 step 5 (C, PR) |
| Makefile: `serve`, `serverdata`, `parity`, `parity-synthetic`, `server-test` | P0 step 4 (C, PR) |
| `docs/backend.md`, this file, `docs/backend-agents.md`, `briefs/WS11–14.md` | P0 step 1 (C, PR) |
| WS2 support: `build_plan`, `station_fields`, determinism, crew as parameter, `physio_core`, timing | **In progress** (branch `ws2-backend-support`) |
| Docker, Compose, Supabase CLI, psql on the build machine | **Missing** — needs a human with sudo |
| VM, DNS name, Supabase project, secrets | **Missing** — needs a human (O1) |

## 3. Tools

| Tool | State | Action |
| --- | --- | --- |
| uv, Python 3.13 (CI 3.11), Node 24, npm, gh | ✅ | — |
| fastapi, uvicorn, pydantic, httpx, pyjwt, psycopg | group `server` (P0 step 4) | `uv sync --group server` |
| sse-starlette | not added | add at B2 if sessions are a go (FastAPI `StreamingResponse` may suffice) |
| Docker Engine + compose plugin | ❌ | human: install, add user to `docker` group |
| Supabase CLI | ❌ | human: install (needs Docker); fallback: RLS tests against the hosted project's test schema |
| psql | ❌ | human: install the PostgreSQL client |
| Caddy | container on the VM | — |
| Secrets | ❌ | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `HL_TEAM_TOKEN` in the environment; `server/ops/.env.example` lists names only |

## 4. Schedule (D50)

The backend agent kit (`docs/backend-agents.md`) names these gates B0′, B1′, B2′; where the two differ, the kit wins.

| Gate | When (CET) | Must be true |
| --- | --- | --- |
| P0 | Sat 22:00 | contracts, config, deps, loader base URL, bundle wrapper, docs; WS2 `build_plan` merged with zero diff |
| B0 | Sun 00:00 | API skeleton serves the official tree by hash; synthetic parity green in CI; Docker stack runs locally |
| B1 | Sun 03:30 | custom pad end to end on localhost (validate, preview, full plan); real-data parity green; permalinks; fallback drill; deployed if O1 settled |
| B2 | Sun 07:00 | route inputs, custom crew, bundle endpoint, login + library (if Supabase exists); Unity import confirmed |
| B3 | Sun 08:00 | stretch go/no-go (expected cuts: F29, F33, F34; F31/F32 only if B2 on time) |
| Hardening | Sun 08:00–12:00 | load test (10 guests), limits, fallback drill, privacy note, API docs |
| Freeze | Sun 12:00 | no new backend features |
| Deadline | Sun 23:59 | last deploy; restarts only afterwards |

## 5. Task list

The critical path: WS2 `build_plan` → WS11 plan job → real-data parity → custom pad → everything else.

### Phase 0 — prep (C, WS2, humans)

| # | Task | Owner | Status |
| --- | --- | --- | --- |
| 0.1 | docs/backend.md, docs/backend-plan.md, briefs/WS11–14.md | C | PR |
| 0.2 | config/backend.yaml + loader | C | PR |
| 0.3 | backend contracts v1.0.0 + OpenAPI | C | PR |
| 0.4 | server deps + Makefile targets | C | PR |
| 0.5 | `build_plan` + `station_fields`; `make engine && make web` zero diff | WS2 | in progress |
| 0.6 | determinism report | WS2 | in progress |
| 0.7 | `physio_core` + crew parameter (+ monotonic KAT); golden.json unchanged | WS2 | in progress |
| 0.8 | loader base URL | C (for WS5) | PR |
| 0.9 | `build_plan_bundle` wrapper | C | PR |
| 0.10 | branches + STATUS.md sections | C | PR |
| 0.11 | Docker, Supabase CLI, psql; VM, DNS, Supabase project, secrets | human | open |

### Phase 1 — B0

| # | Task | Owner | Done when |
| --- | --- | --- | --- |
| 1.1 | FastAPI app: `/health`, `/engine/version`, `/defaults`; grids memory-mapped; Numba warmed before healthy | WS11 | health reports warm only after warm-up (synthetic grids) |
| 1.2 | Canonical input hashing (D57) | WS11 | same inputs → one hash; changed engine tree → new hash |
| 1.3 | `/results/{hash}/…`; the official hash resolves to the precomputed tree | WS11 | file-for-file equal to `web/public/data/` |
| 1.4 | Parity harness (D56) | WS11 | CI job green on synthetic data |
| 1.5 | Dockerfile, compose (API + Caddy), Caddyfile (HTTPS, CORS, immutable `/results/`), `deploy.sh` skeleton | WS12 | `docker compose up` serves `/health` locally |
| 1.6 | SQL migrations for all tables + RLS | WS12 | apply to local Supabase |
| 1.7 | API client, health check, fallback banner, job polling; mocks from `openapi.yaml` | WS13 | with the API unreachable the banner shows and every static test passes |
| 1.8 | `docs/simulator.md` draft; bundle endpoint adapter over `build_plan_bundle` | WS14 | bundle for the official hash = fixture |

### Phase 2 — B1 (Live-MVP)

| # | Task | Owner | Done when |
| --- | --- | --- | --- |
| 2.1 | `tools/make_serverdata.py` | WS11 | data manifest written; stable hashes |
| 2.2 | `/pads/validate`, `/pads/screen` | WS11 | KATs: slope, unknown terrain, disc off the grid; preview within 1% of full plan |
| 2.3 | Job runner (2 processes, queue cap, timeout, de-dup, stages) | WS11 | timed-out job frees its worker; identical inputs attach |
| 2.4 | Job type `plan` via `build_plan`; staged; validated; run record | WS11 | **real-data parity green** |
| 2.5 | Rate limits, kill switch, `/plans/import`, provenance, `/admin/status`, pinning | WS12 | 7th guest job in 10 min refused with retry time; oversized upload refused |
| 2.6 | Deploy with HTTPS; uptime check | WS12 | `/health` reachable from Pages; deploy blocked by failing parity (tested) |
| 2.7 | Pad tool, preview card, staged map results, `#/plan/{hash}`, provenance view, JSON export/import, "Play this plan" | WS13 | official pad by hash renders the same numbers as the static console |

### Phase 3 — B2 (Live-Core)

| # | Task | Owner |
| --- | --- | --- |
| 3.1 | Route inputs F25 (infeasible leg + binding term) | WS11 |
| 3.2 | Custom crew F26 (ranges, flags, on-demand station fields) | WS11 |
| 3.3 | JWT check, `/plans` CRUD, versions, share codes, `/plans/by-code`, `DELETE /me`, `/api/docs` | WS12 |
| 3.4 | `GET /plans/{ref}/bundle`; world pack at `/world/{version}/` | WS14 |
| 3.5 | Route editor, crew panel, login, library, share, cuff card | WS13 |
| 3.6 | Unity imports a server-built bundle | WS14 + liaison |

### Phase 4 — B3 stretch (in cut-order priority)

F31 sessions + mission control → F32 replan → F25 user points → planned-vs-simulated → F34 fresh
conditions → F33 siting on demand → F29 compare. Unfinished features are removed from the UI.

### Phase 5 — hardening (Sun 08:00–12:00)

Load test with 10 parallel guests; fallback drill; privacy paragraph; final deploy.

## 6. Session launch (D54)

| Session | Starts | Reviewer |
| --- | --- | --- |
| WS2 support | P0 (running) | S, C |
| WS11 Engine service | P0 (skeleton on synthetic grids; plan job after WS2 0.5 merges) | N, S |
| WS12 Accounts and ops | P0 | G |
| WS13 Live UI | P0 on mocks | D |
| WS14 Sim services | after WS2 0.7 (`physio_core`) | R, C |

## 7. Risks added by this plan

| # | Risk | Mitigation |
| --- | --- | --- |
| A1 | WS2 refactor changes a published number | zero-diff on `web/public/data/` is the merge condition |
| A2 | `build_plan` cannot reproduce patch steps exactly | parity over the files the server produces; differences to S |
| A3 | Docker / Supabase not ready by B1 | guests, permalinks and compute need neither; F27 falls back to export only |
| A4 | Memory on an 8 GB VM | measure at 2.3; 2 workers; kill switch |
| A5 | Agent account limits | WS11 + WS12 first |
| A6 | **Full plan slower than the spec's 20–40 s** (batch `web_products` 564 s for 9 scenarios) | WS2 timing measurement; stage isochrones last; raise `compute.job_timeout_s` only with a reason |
| A7 | **World pack frame is the official pad's**; custom-pad bundles use their own pad frame | WS14 + C: tile index states the projected origin; bump bundle contract if needed |

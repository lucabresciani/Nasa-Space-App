# 🤖 Backend agent kit — start here

> Exported from Notion ("Backend agent kit — start here", last edited 2026-11-14 19:18 UTC) at the
> backend bootstrap (C, P0). Repo paths: spec `docs/backend.md`, implementation plan
> `docs/backend-plan.md`, briefs `briefs/WS11.md … WS14.md` (amendments below already applied),
> backend contracts in `contracts/` (backend family, see `contracts/README.md`).

> 📌 **What this is.** Everything a coding agent needs to build the backend (WS11–WS14, F23–F36):
> current status, what must be ready before the first session, bootstrap, launch order, the **one**
> set of gates, rules on top of the core agent kit, folder ownership, hand-offs and the corrections
> to the four briefs. The core rules in `AGENTS.md` still apply; this kit adds to them. Product:
> `docs/backend.md`. Task breakdown: `docs/backend-plan.md`. Decisions: SPEC §11 / STATUS.md
> decision log.
>
> **Where this kit and an older page disagree on time, gate or ownership, this kit wins.** The
> spec's gate times (B0 20:00, B1 23:30, B2 03:00) and the briefs' "To B0/B1/B2" headings are
> superseded by the gates below.

## Current status

> 🛠️ **Sat 20:16 — start ASAP decided (team lead).** This settles P1: backend code starts tonight on
> the shifted gates (implementation plan §4, option A), not after G2. Core is published (main
> `d943f39`, CI green, no agents running). Next: readiness group 1, then bootstrap. Target P0 at 22:00.
>
> **C replaces this callout at each milestone; it does not append.** Older entries go to the
> build-history archive.

| Workstream | Features | State | Reviewer | Branch |
| --- | --- | --- | --- | --- |
| WS2 support (D48) | `build_plan`, `station_fields`, determinism, `physio_core`, crew as a parameter | Not started | S (science), C (code) | `ws2-backend-support` |
| WS11 Engine service | F23–F26, F32, F33, F35 (run records) | Not started | N (code, parity), S (science) | `ws11-engine-service` |
| WS12 Accounts, plans, operations | F27, F28, F34, F35 (docs), F36 | Not started | G | `ws12-accounts-ops` |
| WS13 Live web UI | F23–F29 views, F31/F32 views | Not started | D | `ws13-live-ui` |
| WS14 Simulator services | F30, F31 | Not started | R (Unity liaison), C (contracts) | `ws14-sim-services` |

## Readiness checklist (before the first backend session)

> 🚦 Group 1 blocks the start. Groups 2 and 3 can be settled in the first hours, but each one costs
> a session if left to the agents. The recommended answers below are the defaults this kit uses; C
> or the team lead can overturn them, and the overturn goes into the decision log.

### 1. Needed before the first session

| # | Item | Default this kit uses | Owner | Output |
| --- | --- | --- | --- | --- |
| K1 | **P4 — two meanings of "plan.json"** | New contract `contracts/backend/plan_inputs.schema.json` v1.0.0 for user inputs (the spec §7 example). The frozen bundle `plan.json` is unchanged and is derived from inputs + result. API, import/export and the library use `plan_inputs` | C | Schema + decision-log row |
| K2 | **P5 — WS14's first three tasks already exist** | Dropped. WS14 imports `tools.make_bundle`; C adds `build_plan_bundle(result_dir) -> bytes`. Golden vectors stay in `pipeline/engine/golden.py`; the fixture stays in `contracts/bundle/fixtures/official_pad_v1/` | C | Folder table below; amended WS14 brief |
| K3 | **P7 — parity test cannot run in CI** (grids are git-ignored) | Two levels: CI runs batch-vs-server parity on the synthetic world (`pipeline/engine/synthetic.py`); real-data parity runs via `make parity` locally before every merge touching `server/engine`, and inside `deploy.sh` | C, WS6 | CI job + Makefile target |
| K4 | **P8 — share-code format** | `HL-` + 6 Crockford base32 characters (9 in total) | C | Into `plan_inputs` / plans contract and `config/backend.yaml` |
| K5 | **Server dependencies** | `uv add --group server fastapi "uvicorn[standard]" pydantic httpx pyjwt "psycopg[binary]"`; rate limiting in-process (no new dependency) | C | `uv sync --group server` green in CI |
| K6 | **Docker Engine + Compose** on the build machine (needs sudo) | Install now; add the user to the `docker` group | Human | `docker compose version` works |
| K7 | **Briefs exported with the amendments below** | `briefs/WS11.md … WS14.md` carry the new gates and the WS14 changes | C | Files on main |

### 2. Facts to pin down early

| # | Item | Why | Owner | By |
| --- | --- | --- | --- | --- |
| K8 | Exact list of files `build_plan` produces vs the static tree (what `headline_patch` and `stations_names_patch` add) | Parity is defined over that list (risk A2) | WS2 | first hour of WS2 support |
| K9 | Determinism report: does `build_plan` twice give identical bytes? | Any non-deterministic file needs an exception in the parity test | WS2 | P0 |
| K10 | Memory per worker on the real grid | 8 GB VM sizing (risk A4) | WS11 | B1′ |
| K11 | Pages origin for CORS (`https://luxkaiwalker.github.io` is assumed) | CORS allow-list | WS12 | B0′ |
| K12 | Unity WebGL origin, if any | CORS allow-list | WS14 + liaison | B2′ |

### 3. Coordination and logistics

| # | Item | Proposal | Owner | By |
| --- | --- | --- | --- | --- |
| K13 | **P2 — server owner, payer and domain** (O1, O2) | One named owner and one backup; free dynamic-DNS subdomain. Blocks deploys, not code: WS11/WS12 build on localhost until then | Team lead | Sat 21:00 (deploy needed for B1′) |
| K14 | **VM, Supabase project, secrets** | VM 4 vCPU / 8 GB / EU; Supabase EU with GitHub login and redirect URLs; `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `HL_TEAM_TOKEN` in the environment | Server owner | VM by B1′ (03:30), Supabase by B2′ (07:00) |
| K15 | **P3 — Unity liaison** (O5) | One named person before WS14 starts | Team lead | Before WS14 launch |
| K16 | **P6 — D's review load** | D reviews WS13 + WS15. WS18 interaction review goes to R, or WS18 waits until WS13 is idle / B1′ has passed | Team lead, D | Before WS13 launch |
| K17 | **C is the bottleneck tonight** | C runs both the design bootstrap (V0) and the backend bootstrap (P0) and is the only merger. Order: backend K1–K5 and WS2 kick-off first (critical path), then the design bootstrap, then the rest of backend phase 0. If C slips, P0 moves, not the merge rules | C, team lead | Now |
| K18 | **Agent account limits** (risk 9 / A5) | Tonight's concurrent sessions: WS2 support, WS11, WS12, plus design WS15, WS16, RR. WS13 and WS14 start only after B0′. Put WS11 (longest, critical path) on the account with most headroom | Team lead | Before launch |

## Bootstrap (C, phase 0, target Sat 22:00)

1. Check the readiness checklist: K1–K7 done or explicitly waived by the team lead.
2. Export the backend spec + SPEC §2.5/§6.3 to `docs/backend.md`, the implementation plan to `docs/backend-plan.md`, this kit to `docs/backend-agents.md`, the four briefs with the amendments below to `briefs/WS11.md … WS14.md`.
3. `config/backend.yaml` from implementation plan §5, plus a loader with validation (unknown key refused, `*_ref` keys resolve). WS12 owns it afterwards.
4. Contracts v1.0.0, frozen at P0: `plan_inputs.schema.json` (K1, K4), `run_record.schema.json`, `telemetry.schema.json` (sample + state event), `job.schema.json`, `contracts/backend/openapi.yaml` from spec §5. Every example validates; OpenAPI lints.
5. Dependencies (K5); Makefile targets `serve`, `serverdata`, `parity`, `server-test`; CI job for synthetic parity (K3).
6. Start **WS2 support** immediately (it is the critical path): tasks 0.5 → 0.6 → 0.7 of the implementation plan.
7. Loader base URL `dataUrl(path, mode, base?)` with WS5; static default unchanged (0.8).
8. `build_plan_bundle(result_dir) -> bytes` in `tools/make_bundle.py`; the fixture rebuilt through it equals the committed zip (0.9).
9. Create branches (table above) and the `STATUS.md` sections.
10. Launch sessions in the order below with the prompt template.

## Critical path

⚡ WS2 `build_plan` (zero diff in `web/public/data/`) → WS11 hashing and `/results/{hash}` → synthetic parity in CI → WS11 job type `plan` → **real-data parity green** → custom pad end to end (B1′) → everything else. Any delay on this line moves B1′; anything off it is cut first.

## Launch order

| Order | Session | Starts when | First deliverable |
| --- | --- | --- | --- |
| 1 | WS2 support | Now (bootstrap step 6) | `build_plan(grid, *, pad_lonlat, scenario_ids, settings, out_dir, public_dir, …)` with zero diff in `web/public/data/` |
| 2 | WS11 Engine service | After bootstrap steps 3–5; real work after WS2 0.5 is merged | `/health` warm only after Numba warm-up; canonical hash; `/results/{hash}` for the official pad |
| 2 | WS12 Accounts and ops | After bootstrap steps 3–5 | `docker compose up` serves `/health` locally; SQL migrations with RLS |
| 3 | WS13 Live UI | After B0′, on mocks (needs steps 4 and 7) | API client, health check, offline banner; every static test passes with the API down |
| 3 | WS14 Sim services | After B0′ and after WS2 0.7 and bootstrap step 8; liaison named (K15) | `docs/simulator.md` draft; bundle for the official hash equals the fixture |

At most two agent sessions per reviewer. Core gate G2 gets reviewer time first, then backend and design gates.

## Gates (the only valid backend schedule)

| Gate | When (CET) | Must be true | If not |
| --- | --- | --- | --- |
| P0 Prep | Sat 22:00 | Bootstrap done; contracts v1.0.0 frozen; dependencies in CI; branches exist; WS2 support 0.5 merged with zero diff (0.6, 0.7 may run on) | Launch WS11/WS12 anyway on synthetic grids; WS2 support keeps priority |
| B0′ | Sun 00:00 | API skeleton serves the official pad's precomputed tree by hash; synthetic parity green in CI; Docker stack runs locally; migrations apply | Slip at most 1 h; then drop F27 to "export only" |
| B1′ Live-MVP | Sun 03:30 | Custom pad end to end (validate, preview, full plan on the map); real-data parity green; permalinks; fallback drill passes; deployed over HTTPS if K13/K14 are done | Keep validate + instant preview only; continue |
| B2′ Live-Core | Sun 07:00 | Route inputs, custom crew, bundle endpoint, login and library (if Supabase exists), Unity import of a server-built bundle confirmed | Apply the cut order (spec §2) |
| B3 Stretch | Sun 08:00 (with G2) | Go/no-go per stretch feature. Expected: F29, F33, F34 cut; F31/F32 only if B2′ was on time | Unfinished features are removed from the UI |
| Hardening | Sun 08:00–12:00 | Load test (10 parallel guests), limits, fallback drill, privacy note on `/about`, API docs, final deploy | — |
| Freeze | Sun 12:00 | No new backend features | — |
| Deadline | Sun 23:59 | Last deploy done; afterwards restarts only; `/engine/version` shows the deployed commit | — |

**Never cut once started:** the static fallback, the parity test, the "Computed live" label, rate limits.

## Session prompt template

```txt
You are the coding agent for WS{n} ({name}) of HOMELINE's backend, NASA Space Apps 2026.
Read in this order: AGENTS.md, docs/backend-agents.md, briefs/WS{n}.md, the docs/backend.md
sections your brief cites, docs/backend-plan.md (your phase tables), config/backend.yaml,
config/*.yaml, contracts/ (plan_inputs, run_record, telemetry, job, openapi.yaml, bundle/).
Then follow your brief.
Rules: work only in the paths your brief owns; never copy engine code into server/ (import
pipeline/engine or ask WS2); take every limit, range and timeout from config/backend.yaml;
validate every result tree against contracts/ before reporting success; write the known-answer
tests in your brief first; run `make parity` before any PR touching server/engine; keep every
static test green with the API unreachable; secrets only from the environment; update
STATUS.md at each milestone; open small PRs to main for {reviewer}.
If something is missing or contradictory, stop that task, write it in STATUS.md under
"Blocked", tell {reviewer}, and continue with the next task.
Current time and gate: {time}, next gate {gate}.
```

## Rules for backend agents (on top of the core rules)

1. **No second engine.** Every number comes from calling `pipeline/engine`. A step that only exists inside a batch script is exposed by WS2 as a function; it is never copied.
2. **A live result is a data tree.** `results/{hash}/` has the same file names and schemas as `web/public/data/`, plus `run_record.json`, and is contract-validated before the job reports success.
3. **Parity before merge.** Synthetic parity in CI on every PR; `make parity` on real data before any merge touching `server/engine`; a failed parity test blocks a deploy.
4. **Static first.** The submitted app works fully with the server off. No static view imports from `web/src/live/`. With `/health` unreachable for 2 s, live controls hide behind the offline banner.
5. **Guests first.** Nothing a judge needs sits behind login. Permalinks and share codes work logged out.
6. **Label everything live.** "Computed live · not part of the validated scorecard" plus a provenance link on every live view; range flags on out-of-anchor inputs. The official headline never changes.
7. **One rendering path.** Live results load through the existing contract-checking loader with a different base URL. No second renderer.
8. **Config only.** Limits, ranges, timeouts and the share-code format live in `config/backend.yaml`; defaults already in other config files are referenced (`*_ref`), never copied.
9. **Contracts belong to C.** `plan_inputs`, `run_record`, `telemetry`, `job`, `openapi.yaml` and `bundle/` change only by C's PR with a version bump.
10. **Secrets in the environment only.** `.env.example` lists names, never values. CI checks for keys.
11. **Inputs, not results, are stored.** Plans store `plan_inputs`; results are fetched by hash and recomputed when the engine changed.
12. **Stretch is finished or removed.** A stretch feature that is not green at B3 is taken out of the UI, never shipped half-done.
13. **No code deploy after Sun 23:59.** `deploy.sh` refuses after `event.deadline_local`.

## Definition of done (per task)

- Known-answer tests from the brief pass in CI
- Result trees and requests validate against `contracts/`
- Synthetic parity green; real-data parity green if `server/engine` was touched (output pasted in the PR)
- Static web tests green with the API stopped (WS13 tasks, and any PR touching shared web code)
- `STATUS.md` updated; reviewer approved

## Folder ownership (backend)

| Path | Owner |
| --- | --- |
| `server/app.py`, `server/engine/`, `server/api/compute/`, `server/tests/test_parity*.py`, `tools/make_serverdata.py` | WS11 |
| `server/api/auth/`, `server/api/plans/`, `server/db/`, `server/ops/`, `config/backend.yaml` (after bootstrap), `server/tests/test_auth*.py`, `test_limits*.py` | WS12 |
| `web/src/live/` | WS13 |
| `server/api/sim/`, `server/bundle/` (thin layer over `tools.make_bundle`), `docs/simulator.md` | WS14 |
| `pipeline/engine/` (incl. `golden.py`, `synthetic.py`, new `build_plan`, `physio_core`) | WS2 |
| `contracts/` (incl. `contracts/bundle/fixtures/`), `tools/make_bundle.py`, `Makefile`, `pyproject.toml`, CI jobs | C |
| `web/src/env.ts` (loader base URL) | WS5 with C |

**Removed from WS14** (P5): `pipeline/export/simbundle.py`, `tools/physio_golden.py`, `fixtures/`. These do not get created. The core agent kit's folder table is corrected to match.

## Hand-offs

| From | To | What | When |
| --- | --- | --- | --- |
| C | All | Contracts v1.0.0, `config/backend.yaml` + loader, OpenAPI | P0 |
| WS2 | WS11 | `pipeline.engine.plan.build_plan(grid, *, pad_lonlat, scenario_ids, settings, out_dir, public_dir=None, terrain_dir=None, stations_list=None, stations_missing=None, ridge=None, cond=None, dose_fn=None, route_scenarios=None, partner=True, siting=False, d21=None, crew=None, skipped=None, rmse=None, manifest_dir=None, on_stage=None, timing_cb=None, timing=None, verbose=True) -> dict` (run summary), `pipeline.engine.padpick.station_fields(grid, station, scenario='nom_104', settings=None, *, crew=None, tmax_min=None) -> (forward, reverse)` (committed signatures stand, team lead 20:59; WS11 codes against `pipeline/engine`), file list (K8), determinism report (K9) | P0 (0.5), then 0.6 |
| WS2 | WS11, WS14 | `physio_core` and crew as a parameter (0.7) | Before WS11 task F26 and before WS14 sessions |
| C / WS5 | WS13 | Loader base URL `dataUrl(path, mode, base?)` | P0 |
| C | WS14 | `build_plan_bundle(result_dir)` | P0 |
| WS11 | WS12 | FastAPI app and image entry point for Compose; job-runner hooks for rate limits and kill switch | B0′ |
| WS11 | WS13, WS14 | Real API on localhost / VM (replaces mocks) | B1′ |
| WS12 | WS13 | Supabase project URL + anon key (public), login redirect URLs | B2′ |
| WS13 | WS18 (design) | Live API client (preview, jobs) | B1′ |
| WS14 | Unity team (via liaison) | Server-built bundle + `docs/simulator.md` | B2′ |

## Brief amendments (applied in `briefs/`)

**All four briefs:** read "To B0 (Sat 20:00)" as **To B0′ (Sun 00:00)**, "To B1 (Sat 23:30)" as **To B1′ (Sun 03:30)**, "To B2 (Sun 03:00)" as **To B2′ (Sun 07:00)**. B3 stays at Sun 08:00. Every reference to `plan.json` as user input means `plan_inputs.json` (K1).

| Brief | Change |
| --- | --- |
| WS11 — Engine service | Task 4 parity harness = synthetic in CI + `make parity` on real data (K3). Task 5 `make_serverdata` runs on the current grids (core re-run is merged). Task 8 calls `build_plan`; no batch-script logic in `server/`. Add task: measure memory per worker (K10) |
| WS12 — Accounts, plans and operations | Task 2 (`config/backend.yaml`) is done by C in bootstrap; WS12 takes ownership. Task 1: local Compose by B0′; HTTPS deploy only once K13/K14 are done (needed for B1′). Share codes use `HL-` + 6 Crockford base32 (K4) |
| WS13 — Live web UI | Task 2 (loader base URL) is done by C/WS5 in bootstrap. Starts after B0′ on mocks from `contracts/backend/openapi.yaml`. Reviewer load per K16 |
| WS14 — Simulator services | **Tasks 1–3 dropped** (K2). New first task: `docs/simulator.md` draft and a bundle from a result tree via `build_plan_bundle`, equal to the committed fixture. Ownership per the folder table above. Fixture path is `contracts/bundle/fixtures/official_pad_v1/` |

## `STATUS.md` section format (one per workstream)

```markdown
## WS{n} {name} — {state}  (updated {UTC time})
Done:        task numbers + PR links
Doing:       one line
Next:        next 1–2 tasks
Blocked:     question, who was asked, since when
Assumptions: config keys added with assumed: true
Parity:      last real-data `make parity` result + commit (WS11 only)
```

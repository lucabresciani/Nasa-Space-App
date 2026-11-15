# Waypoint block — specification and decisions (D97)

> Exported from Notion ("HOMELINE waypoint block — proposal and implementation plan", last edited
> 2026-11-15 11:04 UTC) by package WP0b, Sun 2026-11-15 ~12:10 CET. Sections 1–8 of the page, plus
> decisions D97 and D100–D109 from the decision log. Where the merged repo differs from the
> proposal, the repo wins and the spot is marked **[repo]**.

**What this is.** The third build block next to the design block (`docs/design.md`) and the backend
expansion (`docs/backend.md`): user-set waypoints (start point, stations, free points), a live route
job through them, and saving plans. Approved Sun 10:26 (D97), own orchestrator since 10:35, freeze
**Sun 17:00**. The live status (merged, running, blocked) is not copied here because it changes at
every merge: see the "Current status" callout on the [Notion page](https://app.notion.com/p/419961bcb61181e0a83ad0a92fa18761); decisions are in the
[decision log](https://app.notion.com/p/418961bcb61181029fc0cb3a54e426c3). Orchestrator state:
`/tmp/hl-way/state.md`; shared shapes: `/tmp/hl-way/interfaces.md` (build machine only).

**Names.** Packages are **WP0–WP10** (not R…, which the design orchestrator also uses). The early
names map as: R0 = WP0, R1 = WP1, R3 = WP3; design's R5 = WP5a/WP5b and R7 = WP7 (D101, D102).

## 1. Goal and demo story

"Put the rover where you want, choose where to go and in which order, add your own stops, and get
the plan home: computed live, checked against every limit, saved and shareable." Until now the
engine picked stations and order itself (D69 cut route editing, F25, and the plan library, F27).
This block adds them back on top of what exists: drag the rover and the plan-edit store with undo
(WS18), the live pad job, permalinks and JSON export/import (backend).

## 2. Scope

| In | Out |
| --- | --- |
| Start point: any valid pad (drag the rover, U15 spot rule, live validate) | Accounts and a server-side plan library (F27 stays cut) |
| Stops: any of the six stations (S1, S2, S4, S6, S7, S8) in a chosen order | Live recompute while dragging (H3 stays out, D85) |
| Free waypoints: up to 4 user points anywhere valid, mixed with stations | Editing leg geometry by hand (the engine always routes each leg) |
| Compute: one live job for the given order; infeasible orders reported with the leg and the limit | Automatic reordering of a user's order |
| Saving: "My plans" in the browser, permalinks and JSON export/import carrying the route | Changes to the official plan or the validated scorecard |

## 3. Behaviour

1. Plan mode gets an **Edit route** panel (live builds only, behind `VITE_LIVE`); static build unchanged.
2. **Start:** drag the rover; the pad is checked with field lookups while dragging and validated by `/pads/screen` on drop.
3. **Stops:** the six stations (checkbox + drag to reorder) and "Add waypoint" (click on the map).
   Each stop shows validity (inside the grid, assessed, walkable at 20°, reachable from the pad)
   from field lookups. Free waypoints can be dragged, renamed and deleted. Every edit goes through
   the plan-edit store, so undo works.
4. **Ghost route:** while editing, a ghost polyline and leg-time estimates from the fields, labelled "estimate" (design rule 5).
5. **Compute plan:** submits `plan_inputs` with the route; the map fills in stage by stage. The
   result is labelled "Computed live · your route" with provenance.
6. **Infeasible order:** the job finishes with an answer naming the first failing leg and limit (O₂
   at the effort-cap rule D45, daylight, EVA length D28, dose) and the time short. The panel
   highlights that leg. Nothing is reordered silently.
7. **Save:** "Save to My plans" stores route, title, hash and date in the browser (open, rename,
   delete, export). Permalinks and JSON export/import include the route.

## 4. Technical design

### 4.1 Contract (WP0, merged; `contracts/backend/README.md` "Route (v1.2.0, D97)")

- `plan_inputs.route = {mode: "auto" | "ordered", stops: [{station: "S4"} | {lon, lat, label?}]}`.
  Missing route = `auto` (old files stay valid). `ordered` = legs pad → stops[0] → … → pad exactly as given.
- **[repo]** Free points are named `W1`, `W2`, … in their order among the free stops; stations keep their ids (D100).
- `run_record.route_mode`; `run_record.feasibility` = `{feasible: true}` or
  `{feasible: false, leg, from, to, limit, shortfall_min, legs_planned?}`. **[repo]** Leg 0 = pad →
  stops[0], leg `len(stops)` = last stop → pad; `limit` is one of `O2`, `daylight`, `dose`,
  `EVA duration`; the legs planned before the failing one are in the tree. Infeasible = job
  `done`, never a 422. `infeasible` is kept for v1.1 readers. The run record carries the default
  scenario's feasibility; `summary.json` has it per scenario.
- A bad stop is a 422 whose `Error.stop` is its index in `route.stops` (`null` for the whole
  route); codes in `contracts/backend/openapi.yaml` `Error.stop`: `route_too_many_stops`,
  `route_too_many_free_points`, `route_stop_spacing`, `route_station_unknown`,
  `route_station_duplicate`, `route_point_outside_grid`, `route_point_unassessed`,
  `route_point_not_walkable`, `route_point_unreachable`, `route_label_too_long`, `route_mode_conflict`.
- **[repo] Hash:** a missing or `auto` route is removed before hashing, so every v1.1 hash stays;
  an ordered route is hashed with its stops in order and labels dropped (D57). The contract version
  is part of the hash (D80): 1.2.0 inputs get new hashes, cache misses only.
- Limits in `config/backend.yaml` `route:`, marked assumed: `max_stops: 8`, `max_free_points: 4`, `min_stop_spacing_m: 50` (= the D27 access radius).
- Mocks: `contracts/backend/examples/plan_inputs.route_ordered.json`, `plan_inputs.route_free.json`,
  `run_record.route_infeasible.json`, `run_record.route_free.json`. **[repo]** Front-end types are
  `RouteMode`, `RouteStop`, `Feasibility` in `web/src/live/types.ts` (the proposal's
  `web/src/edit/route/types.ts` was not created).

### 4.2 Engine (WS2: WP1, WP2a, WP2b)

- `build_plan(…, route=None)` and `traverse.plan(…, route=None)`. `route=None` keeps today's
  behaviour **byte-identical** (zero diff in `web/public/data/`, `make parity` and golden tests
  unchanged). This is the guard for the validated numbers.
- `route` = stops in visiting order: `"S4"`, `{"station": "S4"}` or `{lon, lat, label?}`. The
  station-selection search is skipped; legs are planned in the given order with the same leg
  search, margin checks (D45 O₂ before each leg, D28 turn-back as the earliest limit, dose) and writers.
- **[repo]** An unroutable stop raises `traverse.RouteStopError(index, code, message)` with a `route_*` code.
  `traverse.resolve_route` is the one place stops become station records.
- **[repo]** `pipeline/engine/waypoints.py` (WP2a):
  - `point_validity(grid, lon, lat, *, scenario=None, settings=None)` → `{ok, code, access_cell, access_dist_m}`;
    checks in order outside_grid → unassessed → not_walkable → unreachable (only the last runs a Dijkstra).
  - `point_fields(grid, lon, lat, scenario="nom_104", settings=None, *, crew=None, tmax_min=None)`
    → `(forward, reverse)`: `padpick.station_fields` with a synthetic station record (access radius
    50 m, D27). Invalid points raise `PointError` with the same `code`/`message`/`index` as `RouteStopError`.
  - `stop_spacing_violations(points_lonlat, pad_lonlat, min_m)` → pairs `(i, j)` closer than
    `min_m` (`j = -1` for the pad); great-circle distance on the Mars sphere.
  - Cost **[repo]**: about 6.7 s per free point on the real grid, not the ~40 s assumed.
- Infeasible: a result with `feasible: false`, the failing leg, limit and shortfall; files are
  written for the legs planned before it so the map can show them.
- **[in progress: WP2b, PR #124]** Free points in the route: `W1…Wn`, fields from `point_fields`,
  spacing checked in `build_plan`. A stop without an access cell is to raise only in the default
  scenario; other scenarios are recorded as skipped (S7 in the conservative scenario). Until #124
  merges, an ordered route through S7 fails the whole job.

### 4.3 Server (WS11: WP3, WP4)

- **[repo]** `server/engine/route.py` `validate(plan_inputs)` runs on `POST /jobs` and
  `POST /plans/import`, after the schema and before the hash. Order (first failure answers):
  `route_mode_conflict` (stop `null`) → `route_too_many_stops` → `route_too_many_free_points` → per
  stop in visiting order `route_label_too_long`, `route_station_unknown`, `route_station_duplicate`
  (stop = the repeat), `route_stop_spacing` (stop = the later one). Limits from `config/backend.yaml`.
- An ordered route goes to `build_plan(route=…)` for the nominal preview and the full call; staged
  publication stays (nominal band and route first). A `RouteStopError` inside the job ends it with
  `error` naming the code and the stop. `/pads/screen` refuses an ordered route.
- Free points: on main, WP3 refuses them with 422 `unsupported_inputs` naming the stop.
  **[in progress: WP4]** WP4 accepts them (grid checks, great-circle spacing as in the engine) and
  re-measures the job time.
- **[repo] Job time:** measured on the demo pad (rank 2): ordered S4, S1, S6, S7 done in 358 s;
  an infeasible order in 372 s (leg 3 S7 → S6, O₂, 25.34 min short); auto 356 s.
  `compute.job_timeout_s` 600 (assumed) leaves ~1.6× headroom. Rate limits and the kill switch are
  unchanged; a route job counts as one heavy job.

### 4.4 Web (WS18 with WS13: WP5a/b, WP6, WP7)

- `web/src/edit/route/`: route model and store (`model.ts`, `store.ts`), panel, stop list with
  reorder, undo through the plan-edit store. `web/src/edit/route/map/` (WP6): add, drag, rename,
  delete free points (max 4), validity from the field grid, ghost route with "estimate" labels.
- `web/src/live/`: submit with route, infeasible display, "My plans" in browser storage (try/catch;
  storage can be empty), permalink and export/import with route.
- Tokens only, Lucide icons, no new dependencies; static build byte-identical with `VITE_LIVE` off.
  Plan-mode PRs go to `design` and are merged by the design orchestrator (class V: render review).

### 4.5 Simulator plan format (D103, WP9a/WP9b)

**[repo]** `contracts/bundle/mission.schema.json` (v1.1.0, from the Mission Planer) is the plan the
simulator reads; it supersedes the bundle's `route.json` for routes (kept for v1 readers). `origin`
is `mission_planer` (5 m browser estimate) or `computed_live` (live engine job, 3 m grid). Bundle
terrain and field files, the frame rules and `plan_inputs.route` stay unchanged. See
`contracts/bundle/README.md` "Mission file". WP9b has live route jobs write `mission.json` through
the D76 exporter registry (kind `sim_plan`).

### 4.6 Reuse: the Mission Planer branch

`origin/waypoint-routing` (N0CEO, "Mission Planer", Sat 22:56–Sun 02:22) is the reference design
(team lead 11:40, D106). Modules are **ported** into the waypoint paths, the branch is never merged;
commits and PRs credit "ported from waypoint-routing (N0CEO)".

| Mission Planer file | Used for |
| --- | --- |
| `web/src/mission/router.ts` | A* leg router with the engine's move rules → WP6 ghost route and leg estimates |
| `web/src/mission/plan.ts` | ordered waypoints, leg cache (moving one stop re-routes 2 legs) → WP6 |
| `web/src/mission/margin.ts`, `budget.ts` | four-term margin and O₂ budget → optional ghost hint (estimate only) |
| `web/src/mission/data.ts` | 5 m field grid, walkable iff T_home known → WP6 validity (its `fp3d` imports were removed by D99; port only the helpers) |
| `web/src/mission/missionMap.ts` | numbered draggable markers, click to add → WP6 |
| `web/src/mission/share.ts` | compact plan link → optional for WP7 |
| `contracts/bundle/mission.schema.json`, `export.ts` | simulator plan format (D103) → WP9a/WP9b |
| `views/mission.tsx` | not reused: the UI is the Plan-mode route panel |

## 5. Orchestration and packages

One waypoint orchestrator (session coding-90, D102) runs the packages with state in `/tmp/hl-way/`,
next to the design orchestrator. Shared locks: `flock /tmp/hl-heavy.lock` for heavy jobs,
`flock /tmp/hl-merge.lock` for every merge. Up to 10 agents on its own count (D109). Waypoint
agents use API ports 8150–8199 and previews 4200–4299. Hand-off notes: `/tmp/hl-way/notes/WP*.md`.

### 5.1 Streams (disjoint files, so they run in parallel)

| Stream | Files | Packages |
| --- | --- | --- |
| C Contract | `contracts/backend/`, `config/backend.yaml` (route keys), mocks, `web/src/live/types.ts` | WP0 |
| E1 Engine route | `pipeline/engine/traverse.py`, `build_plan` | WP1 → WP2b |
| E2 Engine points | `pipeline/engine/waypoints.py`, its tests | WP2a |
| S Server | `server/engine/`, `server/api/compute/`, server tests | WP3 → WP4 |
| U1 Route panel | `web/src/edit/route/` store and panel | WP5a → WP5b |
| U2 Map waypoints | `web/src/edit/route/map/` | WP6 (after WP5a) |
| U3 Saving | `web/src/live/` (plans list, permalink, export/import) | WP7 |
| Q Check | `tests/e2e/route/`, `docs/hardening/route-demo.md` | WP8a → WP8b |
| M Simulator plan | `contracts/bundle/` (mission), live exporter | WP9a → WP9b |

### 5.2 Packages

Every package except WP0 could start on the draft contract; only merges wait for WP0.

| # | Package | Merge needs | Estimate |
| --- | --- | --- | --- |
| WP0 | Contract v1.2.0 (`plan_inputs`, `run_record`, openapi), config limits, mocks, front-end types | — | 45 min |
| WP0b | This document | — | 30 min |
| WP1 | Engine: ordered route over stations; `route=None` byte-identical; infeasible answer; KATs first | WP0 | 2–2.5 h |
| WP2a | Engine: `point_fields`, `point_validity`, spacing check; KATs on the synthetic world | WP0 | 1–1.5 h |
| WP2b | Engine: route accepts free points (WP2a inside WP1's planner) | WP1, WP2a | 1 h |
| WP3 | Server: route in the plan job, validation naming the stop, hash, staged publication | WP0; real parity after WP1 | 1.5–2 h |
| WP4 | Server: free points in validation and jobs; re-measure job time, set the timeout | WP2b, WP3 | 1 h |
| WP5a | Route store and actions on the plan-edit store (undo) | WP0 | 30–45 min |
| WP5b | Edit-route panel: stop list, reorder, Compute plan, staged result, infeasible display | WP5a | 2 h |
| WP6 | Waypoints on the map: add, drag, rename, delete (max 4), validity, ghost route, "estimate" labels | WP5a | 2 h |
| WP7 | Saving: "My plans" in browser storage, permalink and JSON export/import with route | WP0 | 1–1.5 h |
| WP8a | End-to-end harness and demo script against mocks | — | 1 h |
| WP8b | Final run on `localhost:5173` against the API on 8012, real-data parity, fallback drill, RR pass | all | 45 min |
| WP9a | `mission.json` schema, README section and tests on main (D103) | — | — |
| WP9b | Live route jobs write `mission.json` (`origin: computed_live`); after W2 (D107) | WP9a | — |
| WP10 | Mission Planer vision gap: per-stop stop time, notes, tags; after W2 (D107) | — | — |

Reviews: the waypoint orchestrator reviews every waypoint PR for the team lead, with the Mission
Planer branch as reference (D105, D106; replaces the S/N/D/C reviewer column of the proposal). It
merges to `main` once the review, CI, and for engine or server PRs real-data `make parity` and zero
diff in `web/public/data/` on the rebased head pass (D108). PRs to `design` stay with the design orchestrator.

**Critical path:** WP0 → WP1 → WP2b → WP4 → WP8b (planned WP1 ~13:15, W1 13:30, WP2b 14:30, WP4
15:30, W2 16:00, WP8b 16:45). Everything else runs in parallel and must not delay it.

## 6. Gates (Sunday)

| Gate | When | Must be true | If not |
| --- | --- | --- | --- |
| W0 | 10:45 | Orchestrator running; WP0 merged; WP1, WP2a, WP3, WP5a, WP7, WP8a running | Start everything on the draft contract; WP0 by 11:15 at the latest |
| W1 | 13:30 | Ordered route over stations end to end on localhost (WP1, WP3, WP5b merged; real parity green; official plan unchanged) | Stop the block; keep custom pad + full plan as the editing story |
| W2 | 16:00 | Free waypoints end to end (WP2b, WP4, WP6) and saving (WP7) merged | Ship ordered stations + saving only; free waypoints removed from the UI |
| W3 | 16:45 | WP8b done: e2e, parity, fallback drill, RR pass; promotion PR approved | Unfinished parts removed from the UI |
| Freeze | 17:00 | No new features | — |
| Capture | 17:00–19:00 | Video beats including "edit the route" | — |

## 7. Rules

1. **The official plan never changes.** `route=None` is byte-identical; zero diff in `web/public/data/` and real-data `make parity` green before every engine or server merge.
2. **No silent reordering.** The user's order is computed as given; infeasible is an answer, not an error.
3. **Honesty.** Ghost values are estimates and say so; computed results carry the "Computed live" label and provenance; out-of-range inputs carry range flags.
4. **Static first.** Everything is behind `VITE_LIVE`; the published static build is unchanged.
5. **Finished or removed.** Anything not green at its gate is taken out of the UI, never shipped half-done.
6. Questions go to the team lead; every decision goes into the decision log with the next free number (check first; never reuse one).

## 8. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Engine change moves validated numbers | Parity fails, block stops | Default path untouched; zero diff and parity on every merge |
| Reviewer not reachable for WP1 | W1 slips | Reviews delegated to the waypoint orchestrator (D105, D106) |
| Job time with free points | Timeouts, slow demo | Max 4 free points; staged publication; timeout re-measured in WP4 (a point measured 6.7 s, not 40 s) |
| Usage limits pause an orchestrator | Hours lost | Gates have fallbacks; state in `/tmp/hl-way/` so a restart resumes |
| Several orchestrators on one machine | Merge conflicts, port clashes | Disjoint files (5.1); shared locks; own port ranges |

## Decisions

Full text in the [decision log](https://app.notion.com/p/418961bcb61181029fc0cb3a54e426c3). Earlier
decisions this block builds on: D27 (50 m access radius), D28 (turn-back), D45 (O₂ at the effort
cap), D57 (hash drops titles/labels), D69 (route editing and plan library cut), D76 (simulator
hooks), D80 (contract version in the hash), D85 (no live drag recompute), D87 (no engine changes,
lifted for this block).

| # | Time (Sun) | Decision |
| --- | --- | --- |
| D97 | 10:12–10:35 | Full waypoint block: custom start, the six stations in any order, up to 4 free points, live route job with explicit infeasible answers, saving. Freeze 17:00, capture 17:00–19:00; D87 lifted under rule 1; D85 stays; limits 8 / 4 / 50 m assumed; own orchestrator, packages WP0–WP8, gates W0–W3 |
| D100 | 10:40 | Contract v1.2.0 (#105): missing = auto (v1.1 hashes kept); ordered hashed in order without labels; free points `W1…`; `feasibility` shape; bad stop = 422 with `Error.stop`, broken limit never a 422; `stations.mode`/`custom` stay cut; contract version in the hash |
| D101 | 10:57 | The waypoint orchestrator owns WP0–WP8; R0/R1/R3 renamed WP0/WP1/WP3 |
| D102 | 11:15 | Session coding-90 becomes the waypoint orchestrator; design's R5 (= WP5a/b) and R7 (= WP7) finish under design and are not duplicated |
| D103 | 11:35 | `mission.json` (Mission Planer) is the simulator plan format; settles D76's open format; supersedes `route_local` for routes; WP9a schema, WP9b live jobs write it |
| D104 | 11:42 | WP2b starts stacked on WP1 + WP2a as a draft; merges only after both are on main |
| D105 | 11:49 | The team lead reviews waypoint PRs in place of S, N and D; merge checks unchanged |
| D106 | 11:51 | Reviews delegated to the waypoint orchestrator, Mission Planer branch as reference; verdicts as PR comments |
| D107 | 12:01 | WP9b and WP10 start only after W2; slots go to the critical path and WP6; S reviews #117's route logic after merge |
| D108 | 12:05 | Auto-merge: the waypoint orchestrator merges passing waypoint PRs to `main` itself (review, CI, parity and zero diff for engine/server); `design` PRs stay with design |
| D109 | 12:08 | The waypoint orchestrator may run up to 10 agents on its own count; heavy lock still shared |

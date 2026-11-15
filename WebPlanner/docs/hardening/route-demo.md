# Route features end to end: harness and demo script (WP8a, D97)

Gates: **W1 13:30** (ordered stations end to end on localhost), **W2 16:00** (free waypoints + saving),
**W3 16:45** (WP8b = the final run of this harness against the real API). Capture 17:00–19:00.

The harness is `tests/e2e/route/`. It drives the real web app in a browser, in the style of the H5
driver (`docs/hardening/e2e-drive.mjs`). It uses Playwright from a worktree's `node_modules`
(not a dependency of this repo) and drives the **system** Chromium headless, because Playwright's
bundled browser does not start on NixOS. Web security stays on. Each scenario gets pass/fail criteria
and timings, screenshots, and one JSON result file.

| File | What |
|---|---|
| `tests/e2e/route/drive-route.mjs` | The driver: scenarios a–g, `--mock` or `--real <api>` |
| `tests/e2e/route/mock-api.mjs` | A tiny mock API built from `contracts/backend/examples`. It runs a staged job on a clock, has an infeasible variant and gives 422s naming the stop |
| `tests/e2e/route/serve-web.mjs` | Vite **dev** server (not a production build, so not heavy) with `VITE_LIVE=1`. Mock mode: `VITE_API_BASE` = the mock. Real mode: same-origin proxy to the API |

## How to run

Ports for this block: mock/API **8150–8199**, Vite **4200–4299**. Never use 8012 (the demo) or 8020–8099.
Check that the ports are free first: `ss -ltn | grep -E ':(8170|4230) '`. The defaults are 8170 and 4230,
because another package's uvicorn was on 8150 during WP8a. Change them with `--api-port` and `--web-port`.

### Mock mode (no engine, about 80 s)

```sh
# the UI under test: a checkout whose web/ has the route panel (R5) and My plans (R7)
node tests/e2e/route/drive-route.mjs --mock --web-dir /path/to/checkout/web --out /tmp/hl-way/wp8a/run
```
- The driver starts `mock-api.mjs` on 8170 and the web on 4230. It stops both at the end.
- `--stage-ms` sets the length of each mock stage (default 4000). The mock runs five stages: nominal,
  bands, partner, route, summary. That is 20 s per job.
- The mock on its own: `node tests/e2e/route/mock-api.mjs --port 8170`. Its placeholder feasibility
  model: `node tests/e2e/route/mock-api.mjs --explain S4,S1,S2,S7,S8`.
- What the mock serves:
  - A route job's result tree is the official static tree, gated by stage.
  - `route_nom_104.geojson` is **synthesized from the submitted stops in the given order**. This is how
    the harness checks "nothing reordered".
  - The run record is `run_record.route_infeasible.json` with the job's hash, inputs, `route_mode` and
    `feasibility`.
  - Placeholder feasibility: straight walk × 1.25 at 40 m/min, plus 30 min dwell per stop, against a
    360 min budget. With it, S4, S1, S2 is feasible, and S4, S1, S2, S7, S8 fails on leg 5, S7 → S8:
    "EVA duration", 30.0 min short.
  - The numbers are placeholders, not results. The mock's hash is not the server's D57 hash, so the
    hash-parity criterion runs only in real mode.

### Real mode (WP8b; read-only use of the API)

```sh
OFF=$(uv run --no-sync python -c "from server.engine.hashing import official_hash; print(official_hash())")
node tests/e2e/route/drive-route.mjs --real http://127.0.0.1:8012 --official-hash $OFF --out /tmp/hl-way/wp8b/run1
```
- The driver only submits normal plan jobs: the routes for a and b. For c, the driver rewrites the body
  in the browser so the API answers a 422, and no job is created. It never calls admin or plan-storage
  endpoints.
- The web runs on 4230 and proxies `/api/v1` to the API with the `Origin` header removed. The real API's
  CORS list (`config/backend.yaml api.cors_origins`) has only `localhost:5173` and the Pages origins.
  To test the cross-origin path the demo uses, pass `--web http://localhost:5173` (a running
  `VITE_LIVE=1 npm run dev`) instead.
- Each real job takes about 6 min (H5: 360–490 s). `--job-wait-s` defaults to 900.
- The S4, S1, S2 result is cached after the first run (same hash). The second run attaches at once, so
  "first stage before done" then reads `null` (cached), as in H5 step 4.
- If S4, S1, S2, S7, S8 turns out **feasible** on the real engine, b fails on `runRecordInfeasible`. Pick
  another order with `--infeasible S…` and use the same order in the demo script below.
- Server data on `/home/vincent/hl-data/server` is shared. A real job there runs only inside
  `flock /tmp/hl-heavy.lock` (common rules).

### Options
`--scenarios a,b,c,e,f,g`, `--ordered S4,S1,S2`, `--infeasible S4,S1,S2,S7,S8`, `--web <url>`,
`--web-port`, `--api-port`, `--wp6` (runs d), `--out`. Environment: `PW` (playwright/index.mjs, default
`~/coding/hl-h2/web/node_modules/playwright/index.mjs`), `CHROMIUM`.
The exit code is 0 when every scenario that ran passes, 1 when one fails, and 2 on a driver crash.
Output: `route-e2e-result.json` (criteria, timings, job polls, network log, console errors and warnings)
and the screenshots `a-*.png` … `g-*.png`.

## Scenarios and pass criteria

A criterion that is `null` is informational and is not judged.

| | Scenario | Pass criteria (keys in `route-e2e-result.json`) |
|---|---|---|
| a | Ordered stations: "My order", check S4, S1, S2 in that order, Compute plan | `listInPickOrder`, `submittedInOrder` (POST /jobs route = S4, S1, S2), `stagesInOrder` (job polls extend stages_done in order, nominal first), `firstStageBeforeDone` ("Nominal band and route · on the map" before the done poll; null if cached), `resultShown`, `labelComputedLive`, `provenanceLink` (= `#/plan/{job hash}/provenance`), `provenanceView` (origin computed_live), `runRecordOrdered` (route_mode ordered), `runRecordStopsInOrder`, `mapRouteInOrder` (the route file the map draws has legs pad→S4→S1→S2→pad), `listUnchangedAfter`, `panelHashEqualsJobHash` (real only: the D57 hash in the panel = the server's), `noUncaught` |
| b | Infeasible order S4, S1, S2, S7, S8 | `runRecordInfeasible`, `panelShowsInfeasible`, `namesFailingLeg` ("Leg n: from → to", data-leg = feasibility.leg), `namesLimit`, `namesMinutesShort` ("Short by x.x min" = shortfall_min), `legHighlightedInList` (`.hl-route__leg[data-state=failing]`), `legHighlightedOnMap` (null: judged on `b-infeasible.png`), `submittedInOrder`, `listNotReordered`, `mapRouteIsPlannedPrefix` (only the planned legs, in order), `noUncaught` |
| c | 422 on a bad stop (stop 2 rewritten to S99 in the browser) | `api422`, `errorStopGiven` (Error.stop integer), `panelShowsFailure` (`.hl-route__failed[data-status=422][data-code]`), `panelNamesStop` ("Stop {stop+1}"), `noJobCreated`, `noUncaught` |
| d | Free points (WP6): add two, drag one, rename, delete, validity, ghost route "estimate", compute | **skipped until WP6 lands** (`--wp6`). Written against requested selectors (see below) |
| e | Saving (R7): permalink in a fresh page, Save to My plans, reload, open, rename, export, import, delete | `permalinkRenders` (computed_live), `permalinkRouteOrdered`, `permalinkStopsInOrder`, `saved`, `listedAfterReload`, `renamed` (also after reload), `openedFromList`, `exportCarriesRoute`, `importSameHash` (import lands on `#/plan/{same hash}`), `deleted` (also after reload), `noUncaught` |
| f | Static first: every `/api/v1` request refused by the browser | `staticHeadline23`, `offlineBanner`, `noRouteControlsShown`, `computeDisabled`, `noUncaught` |
| g | Official permalink | `precomputedLabel`, `sameAsStatic` (first three numbers = the static console's: 23 / 30 / 15.2), `official23`, `noneWithheld`, `noUncaught` |

### Results

WP8b fills this table on the real API. The mock run is WP8a's, on the UI described in the next section.

| | Mock (WP8a run3 + run5) | Real (WP8b) | Key numbers (mock) |
|---|---|---|---|
| a | **PASS** | | first stage on the map 5.3 s, result 22.7 s after Compute (stage 4 s); picking three stations 2.2 s; stages nominal → bands → partner → route → summary; legs pad→S4→S1→S2→pad |
| b | **PASS** | | "Leg 5: S7 → S8 · Limit: EVA length (D28) · Short by 30.0 min"; leg row 4 `failing`, 5 `not-planned`; route file has the 4 planned legs |
| c | **PASS** | | 422 `route_station_unknown`, stop 1 → "Stop 2 (S1): not a station of this site", 0.3 s; no job |
| d | SKIP (WP6) | | |
| e | **PASS** | | permalink 0.8 s; save, reload, rename, open and delete all work; the export (403 B) carries `route` (ordered S4, S1, S2); import gives the same hash in 0.2 s |
| f | **FAIL** (one criterion) | | static headline 23 % unchanged; offline banner after 0.2 s; **the route panel stays visible with 11 controls (2 enabled), Compute disabled** (finding R5-A) |
| g | **PASS** | | "Precomputed · official plan", 23 / 15.2 / 28.7 %, the same as the static console |

## UI under test (mock run)

Evidence: `/tmp/hl-way/wp8a/run3/` and `/tmp/hl-way/wp8a/run5/` (screenshots and `route-e2e-result.json`), and
`/tmp/hl-way/wp8a-run{3,5}.log`.


- Scratch worktree `/tmp/hl-way/wt/wp8a-ui`: the PR heads, R5 #110 (ws18-direct-edit-R5 **63a0448**) merged
  with R7 #116 (ws15-design-system-R7 **b85e2e7**). The merge is clean. It is not pushed.
- run3 used R5 9a6b9db and run5 used 63a0448, which changes only CSS. Both give the same verdicts, and the
  key numbers in the table come from both runs.
- WP1 #117 (`traverse._route_order`) checked: its feasibility shape is the one the mock and the criteria
  use (`leg` 0-based, `legs_planned` = leg, `shortfall_min` rounded to 2 decimals; the panel shows 1).
- Selectors come from R5's `web/src/edit/route/panel.tsx` and `text.ts`, and from R7's
  `web/src/live/plans/view.tsx` and `planview.tsx` (`S` in the driver).
- The real-mode code path (Vite proxy) was smoke-tested against a second mock on 8151:
  - f, a, c and g ran.
  - a failed only on `panelHashEqualsJobHash`, as expected, because the mock hash is not D57.

## Findings (mock run)

- **R5-A (f, static first):**
  - What happens: with the API unreachable, the Edit-route panel (rail section "Stations and route")
    stays visible. Mode buttons, checkboxes, undo/redo and a disabled "Compute plan" show, with
    "Computing a route needs live planning. Live planning is offline · showing precomputed plans".
  - F23 and kit rule 4 say live controls hide behind the offline banner. R5's 9a6b9db chose to
    degrade in place instead.
  - Decision needed (team lead / D): hide the section when offline, or accept a disabled panel and
    relax criterion `noRouteControlsShown`.
- **R5-B (warning):**
  - What happens: following the panel's provenance link logs
    `edit route: static plan not restored: TypeError: Cannot read properties of undefined (reading 'setData')`
    (`restoreStatic` → `ConsoleMap.setScenarioData` on a map that is being torn down).
  - It is harmless for the user: a console warning, no uncaught error.
- **R5-C (demo):** the result box (infeasible message, provenance link) sits below the fold of the rail
  at 1900×1000. The presenter must scroll the rail. The EVA-time dock keeps showing the official
  plan's timeline (S7 S6 S1 S4) while a route result is on the map.
- **Mock-only:** the permalink of a mock route result shows the official headline (23 %), because the
  mock serves the static tree. Real results have their own numbers.

## Selector requests

These were not edited in their files; they are requests to the owners.
- **R5 (#110):**
  1. A readable hook for the failing-leg highlight on the map, e.g. `data-failing-leg="{leg}"` on the
     map container, or a `.hl-route__maplegend` text. Today it is only a MapLibre layer
     (`hl-route-failing-leg`), which a browser test cannot read.
  2. `data-state` on `.hl-route` (idle/running/done/failed/cancelled). The driver infers the state from
     child elements.
  3. `data-hash` on `.hl-route__result`.
- **R7:** `data-saved="true"` on `.live-plan-save` (today the "Saved in this browser." caption text).
- **WP6 (TODO selectors in the driver; d is skipped until they exist):**
  - `[data-route-action="add-point"]`
  - `.hl-route__stop[data-point="W{n}"]` (list row) with `[data-validity]`
  - `.hl-route-marker[data-point="W{n}"]` (draggable marker)
  - `input[name="label"]` in the row (rename)
  - `[data-route-action="delete-point"]`
  - `[data-route-ghost]` (ghost route summary, labelled "estimate")

## Demo script: "edit the route" in 60–90 s (capture 17:00–19:00)

Setup:
- `make serve` on 127.0.0.1:8012 and `cd web && VITE_LIVE=1 npm run dev` (http://localhost:5173).
- Window 1900×1000. Plan mode, `#/`.
- **Warm the cache first:** run both routes once before recording, e.g. with this harness in real mode.
  The recorded jobs then attach at once instead of taking about 6 min each.
  Use the same orders, because the result hash covers the order.

| t (s) | Click / action | Say |
|---|---|---|
| 0 | Plan mode, official plan on screen (23 %) | "This is the official plan: the engine chose the stations and their order." |
| 5 | Rail → **Stations and route** → **My order** | "Now I choose the stops and the order myself." |
| 10 | Check **S4**, then **S1**, then **S2** | "Sulfur field first, then the boxwork ridge, then the fracture network. The legs list shows pad → S4 → S1 → S2 → pad, exactly in my order." |
| 20 | **Compute plan** | "One live job for exactly this route. Nothing gets reordered." |
| 22–35 | Staged result: "Nominal band and route · on the map", then the other layers | "The nominal band and route come first, and the other variants follow." (cached: all at once) |
| 35 | Scroll the rail to the result: "Computed live · your route · Provenance {hash}" | "It is labelled as computed live, and it is not the validated scorecard. Provenance has the engine version and every stage." |
| 45 | Also check **S7** and **S8** (order S4, S1, S2, S7, S8), **Compute plan** | "Let's be greedy: two more stations." |
| 55–70 | Scroll to **"This order does not work"** | Read it out: "**Leg 5: S7 → S8 · Limit: EVA length (D28) · Short by 30.0 min**" (mock text; WP8b puts the real leg, limit and minutes here). "The failing leg is marked in red in the list and on the map. The engine did not reorder my stops. It tells me where my order breaks and by how much." |
| 75 | Uncheck **S8** (or drag S7 above S2), Compute again | "Change the order or drop a station, then compute again." |
| 85 | (optional) Open the provenance link → **Save to My plans** | "Saved in this browser only. The permalink and the exported plan_inputs.json carry the route." |

Fallback if the API is down during the capture: the static app is unchanged (scenario f, 23 %). Say
"live planning is offline; the precomputed plan stays". Do not show the panel, because of R5-A.

# Custom pad end to end on the demo configuration (H5, gate B1′)

Gate B1′: "custom pad end to end: validate, preview, full plan on the map; permalinks; all on localhost".
This is the real demo setup: `make serve` on 127.0.0.1:8012 and `VITE_LIVE=1 npm run dev` on
http://localhost:5173. That origin is in `api.cors_origins`, so the browser runs with web security on.

## Result: PARTIAL. Steps 1–3, 5, 6 and 7 (crew) pass. Step 4 fails one criterion: the map shows nothing live until the job is complete.

Steps 1–6 were first run on e75cb3d (run3 and run4). After U4 was merged, they were all run again on main cd2ae9a,
together with step 7 (run5-crew and run6-crew35). Both heads give the same verdicts.

| Step | What | Result | Key numbers |
|---|---|---|---|
| 1 | Load `#/`: live state ready, pad tool visible, static numbers unchanged | **PASS** | ready + pad tool + 23 % after 0.8–2.4 s; no offline banner |
| 2 | Invalid spot at the north edge: reason + nearest valid block | **PASS** | `disc_off_grid`, nearest valid block 360.6 m away, shown 7 ms after the pad position |
| 3 | Valid pad: instant preview flagged as estimates | **PASS** | preview card 54–71 ms after the click; 14/14 numbers flagged as estimates (`num-screen`) |
| 4 | Compute full plan: stages in order, nominal band + route on the map first, done, label + provenance, no uncaught errors | **FAIL** (one criterion) | done in 374.5 s (timeout 600 s); stages in order; label + provenance link present; 0 uncaught errors; **no band, route or headline before the job is complete (finding H5-1)** |
| 5 | Permalink in a fresh page; provenance; export + re-import | **PASS** | renders in 469 ms with 8 manifest-backed numbers and 0 withheld; origin `computed_live` with stage timings; re-import → same hash, opened in 99 ms (`computed: true`) |
| 6 | Official permalink | **PASS** | "Precomputed · official plan"; 23 % / 15.2 % / 28.7 % / 60-min 31.5 % (16.2–43.8 %), the same numbers as the static console |
| 7 | Crew job (+20 kg tools) on main with U4 (cd2ae9a) | **PASS**, but H5-1 again | tools 35 kg is flagged in the panel; tools 30 kg (+20) is sent with the job, which is done in 490.4 s under load; reach at 30 min **20.7 %** vs 21.2 % for the default crew; "No range flags"; steps 1–3, 5 and 6 pass again on the new head |

Peak memory of the API process tree (RSS summed, sampled every 1 s):
- During the step-4 job: **2.43 GiB** (2,550,112 KiB). The job worker peaked at **1.90 GiB** and the API server process at 0.44 GiB.
- During the second job (the rank-4 probe below): 2.47 GiB, with the job worker at 1.93 GiB.
- The server process alone peaked at 0.73 GiB at 02:01:26. That was the first `/pads/validate`, which loads the
  D21 siting world; it then settled at about 0.45 GiB.
- The idle tree used 0.42 GiB.

**Main moved after the run.** The branch was rebased onto cf24341 before the PR. That brings in E8b (#63):
the worker initializer and the pad data are now preloaded at API start. It changes neither `web/src/live/` nor
`server/engine/plan_job.py`, so H5-1 still holds on main. The 0.73 GiB server peak at the first validate (below) should
now happen at start-up instead.

## Setup

- Date: 2026-11-15, 01:58–02:25 local (CET). Worktree `hardening-h5` at origin/main e75cb3d.
- `/engine/version` reported commit `e75cb3d6…` = HEAD, engine_tree `49418a22…`, terrain `sha256:67fe3ced…`.
- Official hash at this HEAD: `c51b1b82b5269ce6` (`server.engine.hashing.official_hash()`).
- `ss -ltn | grep 8012` returned nothing before the start. Port 5173 was free too.
- Environment: `uv sync --frozen`, `cd web && npm ci`, and a gitignored `data -> ~/hl-data` symlink. The plan job reads
  `data/interim/conditions` (E8 note), as E6, E8 and E10 did.
- Browser: Playwright 1.65.1 from `~/coding/hl-h2/web/node_modules` (not a dependency of this repo) driving the
  system Chromium 157 headless, viewport 1900×1000, with **web security on**.

```
make serve HL_SERVER_DATA=/home/vincent/hl-data/server         # 127.0.0.1:8012 (uvicorn --reload)
cd web && VITE_LIVE=1 npm run dev                               # http://localhost:5173
memsample.sh <uvicorn reloader pid> /tmp/hl-orch/h5/mem.tsv     # RSS of the process tree, every 1 s
OUT=/tmp/hl-orch/h5/run3 node docs/hardening/e2e-drive.mjs http://localhost:5173   # the full job (fresh hash)
OUT=/tmp/hl-orch/h5/run4 node docs/hardening/e2e-drive.mjs http://localhost:5173   # rerun, same pad: cached
```
`memsample.sh` (scratch) walks `pgrep -P` from the reloader pid and sums `VmRSS`. The tree is the reloader,
the multiprocessing resource tracker, the server process and two spawned job workers.

Two runs carry the result:
- **run3** submitted the job for the custom pad, a fresh hash. It is the source for step 4 and its timings.
  The driver crashed after step 4 on a bug in its own network-log filter (fixed in the committed script), so
  steps 5–6 come from run4.
- **run4** ran the committed script end to end, with all six steps passing in its own terms. The same pad has the same hash,
  so its step 4 attached to the cached result: all stages arrived together after 0.7 s, which is why step 4
  passes there. Steps 1–3 and 5–6 of run4 are the reported results.

Evidence (screenshots, `e2e-result.json` with the network log and every job poll, and `plan_inputs.json`):
`/tmp/hl-orch/h5/run3/` and `/tmp/hl-orch/h5/run4/`. Logs: `/tmp/hl-orch/h5/{api,vite,run3,run4}.log`, `mem.tsv`,
`probe-rank4.log`.

## The pad

- **Invalid spot (step 2):** 137.401783, −4.771407, E8's pad near the north edge. The driver clicked 137.401747, −4.771397.
- **Custom pad (steps 3–5):** **rank 3, 137.393301, −4.776114**, a D21 block 40 m north of rank 2 in the same cluster.
  Rank 2's own location (137.393301, −4.776468) is covered by its `#2` HTML marker, so a click there never reaches the map.
  The driver therefore clicks an invalid slope spot about 100 m north of the cluster (137.393277, −4.774482).
  The pad tool offers "Nearest valid block: 137.393301°E −4.776114°N, 96.7 m away", and the driver takes it.
  The task allowed this ("or use the nearest valid block").
- **Plan hash:** `2e1344b6e489d6a1`, job `j_8d066e70665f5ac6`.

## Step details

### 1. Load — PASS
- `.live-status` reached `data-state=ready` and stayed hidden. The pad tool ("Live pad · Computed live · not part of the
  validated scorecard · provenance: engine version · Click the map to try a pad location.") was visible.
- The console headline was unchanged: "23% reachable of the assessed flat disc within 30 min. Range 15.2% (conservative) to
  28.7% (optimistic) … Within 60 min: 31.5% (16.2% to 43.8%)".
- Timings: 790 ms in run4 and 2.4 s in run3 (cold vite transform), measured from navigation.
- Screenshot: `run4/step1-console-ready.png`.

### 2. Invalid spot — PASS
- "The flat 30-min disc around this pad leaves the terrain grid (the flat 30-min disc (1764 m) around the pad leaves the
  routing grid)", `data-reason=disc_off_grid`.
- "Nearest valid block: 137.401783°E −4.777480°N, 360.6 m away", with the button "Use the nearest valid block". That block is the official pad.
- The reason appeared 7 ms after the pad position updated. Every `POST /pads/validate` answered in 3–6 ms.
- Screenshot: `run4/step2-invalid-pad.png`.

### 3. Valid pad, instant preview — PASS
- After "Use the nearest valid block": "Valid pad (D21 rule)" and the "Instant preview" card. The card appeared 54 ms
  (run4) or 71 ms (run3) after the click, well inside the 2 s target. `POST /pads/screen` took 63 ms.
- Card: feasible EVAs 51; S1/S2/S4/S6/S7/S8 all reachable; best route estimate pad → S6 → S1 → S2 → S8 → pad, 388.92 min.
- All 14 numbers carry `num-screen`, with the tooltip "instant preview (POST /pads/screen, station fields): an
  estimate with no manifest entry; compute the full plan for manifest-backed numbers". The card is also labelled "Computed live · not part of the validated scorecard".
- Screenshots: `run4/step3a-invalid-near-rank2.png`, `run4/step3-preview.png`.

### 4. Full plan — FAIL (map content only at the end)
- Job timings (run3), from the UI's polls of `GET /jobs/{id}` (one about every 5 s) and the run record:

| Stage | Seconds (run record) | Seen done in the UI (s after "Compute full plan") |
|---|---|---|
| nominal | 131.50 | 135.8 |
| bands | 198.45 | 331.2 |
| partner | 19.30 | 350.9 |
| route | 25.17 | 375.8 |
| summary | 0.05 | 375.8 |
| **total** | **374.48** | **376.5** (`done`) |

- A second job on rank 4 (137.387206, −4.781529, hash `aed58d507a7a7f53`, submitted with `probe_tree.py` through the API, not
  the UI) took nominal 111.11, bands 213.44, partner 19.76, route 25.73 and summary 0.06 s, **370.1 s** in total.
- Submit: `POST /jobs` returned 202 in 13 ms. The job was queued for under 1 s.
- The total is under the 600 s timeout, with 1.6× headroom. E8 measured 332 s for its pad and E10 386.6 s for a crew job.
- Passes:
  - The stages arrived in order: nominal → bands → partner → route → summary.
  - The panel showed "Running stage …" with a progress bar and Cancel, then "All stages done.".
  - The label read "Computed live · not part of the validated scorecard · provenance of plan 2e1344b6e489d6a1", linking to `#/plan/2e1344b6e489d6a1`.
  - When done, the headline read "Reachable within a 30-min walk home (nom_104): 21.2% (range 16.2% to 30.1%)".
  - 0 uncaught errors. There were 0 contract errors (`.live-errors`) when the same tree was reloaded in run4.
  - The only `console.error` entries are "Failed to load resource: 404", explained below.
- **Fail: the nominal band and route did not appear first (finding H5-1).** After each of the stages nominal, bands
  and partner, the pad tool fetched only `scenarios/index.json` and `manifest.json`, and both returned **404**.
  These are the six 404 console errors. It fetched nothing else, and the panel said "No scenario index yet." for
  6 minutes. The first band, route, isochrone, edge or partner fetch happened at 375.8 s, when the job was complete:

```
146.41 s 404 /results/2e1344b6e489d6a1/scenarios/index.json     (after nominal)
146.41 s 404 /results/2e1344b6e489d6a1/manifest.json
341.51 s 404 …/manifest.json, …/scenarios/index.json             (after bands)
361.52 s 404 …/manifest.json, …/scenarios/index.json             (after partner)
386.53 s 200 …/scenarios/index.json, manifest.json, route_nom_104.geojson, scenarios/bands_104.geojson,
             scenarios/nom_104/{isochrones,edges,partner}.geojson   (done)
```
  (The times are on the driver's clock: the click was at 10.8 s.)
- Screenshots: `run3/step4-stage1-nominal.png`, `run3/step4-stage2-bands.png`, `run3/step4-stage3-partner.png`,
  `run3/step4-stage5-summary.png`, `run3/fatal.png` (done; taken by the driver's error handler) and
  `run4/step4-done-zoomed-out.png`.

### 5. Permalink, provenance, export / re-import — PASS (run4)
- **Fresh page** `http://localhost:5173/#/plan/2e1344b6e489d6a1`:
  - Rendered in 469 ms.
  - Label: "Computed live · not part of the validated scorecard · provenance of plan 2e1344b6e489d6a1" (`data-origin=computed_live`).
  - Headline: 21.2 % within 30 min, range 16.2 % to 30.1 %, within 60 min 22.6 % (11.9 % to 38.7 %).
  - Route: Pad → S7 → S6 → S1 → S4 → Pad, total 326.49 min, tightest margin 47.29 min (radiation dose, leave S1).
  - 8 numbers are manifest-backed (`num-live`) and 0 are withheld.
  - Cross-check: `reachable_pct.nom_104.30` is in the result's manifest.json, and `scenarios/index.json` gives 21.2,
    which equals the number shown.
- **Provenance** (`#/plan/…/provenance`):
  - Origin `computed_live`, status done.
  - Engine tree 49418a22…, commit e75cb3d6…, config hash, terrain hash, contracts web 1.1.5 · backend 1.1.0 · run record 1.1.0.
  - 20 files, each with sha256 and contract.
  - Stage table: nominal 131.502, bands 198.45, partner 19.302, route 25.173, summary 0.05 s, with UTC start times
    01:05:07–01:11:21Z. `range_flags []`, error null.
- **Export / re-import:**
  - "Export plan_inputs.json" is a 661-byte canonical JSON file: default inputs, pad 137.393301, −4.776114.
  - Importing it on `#/plan` sent `POST /plans/import` → 200 `{"hash":"2e1344b6e489d6a1", …, "computed": true}`, the same hash.
  - The app opened `#/plan/2e1344b6e489d6a1` 99 ms after the file was set, from cache. No job was started.
- Screenshots: `run4/step5-permalink.png`, `run4/step5-provenance.png`, `run4/step5-reimport.png`.

### 6. Official permalink — PASS (run4)
- `#/plan/c51b1b82b5269ce6` in a fresh page: "Precomputed · official plan · provenance of plan c51b1b82b5269ce6", `data-origin=precomputed`.
- Headline: "23% … within 30 min. Range 15.2% (conservative) to 28.7% (optimistic) Within 60 min: 31.5% (16.2% to 43.8%)".
  These are the same numbers as the static console in step 1. 0 numbers are withheld. Time to the precomputed label: 2.1 s.
  H2's cosmetic finding 3 still applies: the label briefly reads "Computed live" while the page loads.
- Screenshot: `run4/step6-official.png`.

### 7. Crew job on main with U4 — PASS (H5-1 reproduced)
U4 was merged as cd2ae9a during the check (orchestrator message, about 02:20).

**Setup for the re-run:**
- I merged origin/main into the branch (HEAD 643b53a = cd2ae9a + this doc), ran `npm ci` again and restarted both servers.
  `make serve` now includes E8b's warm-up: `/health` reported `engine_warm: true` before the first request.
- `/engine/version`: commit 643b53a, engine_tree `6135328580…`. The engine tree changed only through `pipeline/export/*` tile code
  (P2), so the hashes changed but the planning code did not. The official hash is now `7d491d3e2dd6a60d`.
- The machine was loaded by other agents (load average 26–30 on 16 cores), so these timings are slower than run3's.

**Results:**
- **run5-crew** (`OFFICIAL_HASH=7d491d3e2dd6a60d CREW_PROBE=tools_kg=35 CREW_SET=tools_kg=30`; evidence in `/tmp/hl-orch/h5/run5-crew/`):
  - Steps 1–3 pass again: ready after 758 ms; `disc_off_grid` with the nearest block 360.9 m away; preview after 107 ms with 14/14 numbers flagged as estimates.
  - The crew panel ("Crew · Computed live …") shows the 4 inputs with "Validated range min to max, default d". Suit (104 kg) and O2 reserve (30 min) are marked "fixed tonight".
  - **Out of range:** "Carried tools" set to 35 gives `data-check=outside` and the flag "outside the validated range: result is an
    extrapolation" (range 0 to 30 kg). The compute button stays enabled (not clamped).
    Screenshot: `step7a-crew-out-of-range.png`.
  - **+20 kg:** tools set to 30 gives `data-check=changed` and no flag (`step7b-crew-set.png`).
    The job then runs on rank 3 with crew tools_kg 30: plan `de37fb2fe179f1e0`.
  - Run record stages: nominal 114.76, bands 265.74, partner 23.53, route 27.60, summary 58.74 s (the summary includes
    E10's station-field cache for the new crew), **490.4 s** in total. That is under the 600 s timeout, but with only 1.22× headroom on this loaded machine.
  - Headline: "Reachable within a 30-min walk home (nom_104): **20.7%** (range 16% to 29%)". The default crew on the same pad
    gave 21.2 % (16.2 to 30.1) → **smaller, as expected**. The 60-min figure is 21.7 % (11.5 to 36.7) vs 22.6 % (11.9 to 38.7).
  - Run-record flags: "No range flags: every input is inside its validated range." That is correct, because 30 is the range max.
  - **H5-1 again:** after nominal, bands, partner and route, only `scenarios/index.json` and `manifest.json` were fetched, and both returned 404 (115.5 s, 380.8 s, 405.8 s and 435.8 s).
    The map files came at 491 s, when the job was done.
  - Steps 5 and 6 pass again:
    - The permalink renders in 1770 ms, `computed_live`, with 8 manifest-backed numbers and 0 withheld; the shown value equals index.json.
    - Provenance shows the stage table.
    - The export contains `crew.tools_kg: 30`. Re-import gives the same hash and opens in 210 ms.
    - The official permalink `7d491d3e2dd6a60d` shows "Precomputed · official plan" with 23 / 15.2 / 28.7 %.
    - 0 uncaught errors; 9 `console.error` 404s (8 from H5-1, 1 favicon).
- **run6-crew35** (`CREW_SET=tools_kg=35`: an out-of-range crew sent with a job, to see the run-record flags):
  - The panel showed the out-of-range flag, and the job ran anyway (not clamped): plan `1366d2cbc482198b`.
  - Run record stages: nominal 118.20, bands 209.61, partner 18.83, route 25.92, summary 44.44 s, **417.0 s** in total.
  - When done, the live result shows **"Range flags (run record) · Inputs outside the validated range: result is an
    extrapolation. · crew.tools_kg = 35: outside the anchored range (ICES-2026-127, IST-2)"**.
    The API's run record has `range_flags [{"key": "crew.tools_kg", "value": 35.0, …}]`. **Range flags show. PASS.**
  - Headline: 20.5 % (15.9 to 28.7), which is below both the 30 kg result and the default crew's.
  - The driver, with its corrected criterion (map files before the first `done` poll), reports step 4 **FAIL** for H5-1:
    the map files were first fetched at 420.7 s, the same poll that said done. Steps 1–3, 5 and 6 pass. 0 uncaught errors.
- Memory on the new head (E8b preloads the job workers):
  - Idle tree: 0.83 GiB (server 0.37 GiB, plus 2 warm workers of about 0.21 GiB each).
  - Peak during the 30 kg crew job: 2.34 GiB, with the job worker at 1.78 GiB.
  - Peak during the 35 kg job: 2.06 GiB.

## Findings

**H5-1 (blocks "nominal band and route on the map first"; for the WS13/U2 and WS11/E8 owners).** The staged
results exist on the server, but the client cannot find them before the job ends.
- `web/src/live/stage.ts` `loadStage` reads `scenarios/index.json` first and finds every map file through
  `index.scenarios[…].files`. Without an index it tries nothing else.
- E8's plan job (`server/engine/plan_job.py`) writes `scenarios/index.json` and `manifest.json` only in the summary stage
  ("summary writes scenarios/index.json + manifest.json once").
- Result: on the real server, a custom-pad job shows no live map content and no headline for about 6 minutes, and then everything at once.
- The probe below confirms that the server *does* serve the nominal route and band right after the nominal stage
  (`probe-rank4.log`, a second job on rank 4).

```
probe_tree.py (POST /jobs for rank 4 = 137.387206, -4.781529, then GET of each file at every stage change)
    0.0s submit 202 j_98e82c3cba5f5e79 hash aed58d507a7a7f53
  112.1s stage bands, done ['nominal']: route_nom_104.geojson 200, scenarios/bands_104.geojson 200,
         scenarios/nom_104/{isochrones,edges,partner}.geojson 200, scenarios/index.json 404, manifest.json 404
```

- U2's mock (`mock/result.ts`) grows the manifest and index per stage, which is why the unit tests pass.
- Possible fixes, for the owners to choose (none applied here):
  - the job writes a partial index and manifest after each stage;
  - or `loadStage` falls back to the default scenario's conventional paths when the index is missing (which would draw files the manifest does not cover yet, so U2's rule 4 needs a decision).

**H5-2 (cosmetic, WS5/WS13).** The live aside's width follows its content, so the console map resizes when the
pad tool's text changes. At 1900 px the map was 1015 px wide with no pad or a valid pad, and 605 px wide while an
"invalid" reason was shown. Each resize moves the map under the cursor. The driver re-anchors after every click for that reason.

**H5-3 (cosmetic).** The D21 rank markers (`#2`, `#3`, `Pad`) are HTML elements that swallow map clicks, so a
presenter cannot click exactly on rank 2 or 3. Clicking next to a marker and using "Use the nearest valid block" works.

**H5-4 (info).** The first load logs one "Failed to load resource: 404" from the vite dev server (not an API call;
`/favicon.ico` returns 404 there). It is harmless.

**H5-5 (info, for the VM sizing).** One custom-pad job took the API process tree from 0.42 to 2.43 GiB. The job worker alone
peaked at 1.90 GiB. Two concurrent jobs would need about 4.4 GiB. With E8b on main, the idle tree is 0.83 GiB because the
workers are preloaded, and a crew job peaked at 2.34 GiB.

**H5-7 (timeout headroom, for the T1/D81 owner).** Measured job totals:
- custom pad, default crew: 374.5 s and 370.1 s;
- custom pad, crew 30 kg: 490.4 s (machine load 26–30);
- custom pad, crew 35 kg: 417.0 s.

A new-crew job pays about 45–60 s more in its summary stage for E10's station-field cache. Under load it took 82 % of
`compute.job_timeout_s` 600 s. During a live demo, keep other heavy work off the machine.

**H5-6 (info, static console; for the WS5/static-data owner, unverified).** During the first driver attempt
(run1, 02:03:14), the driver's map clicks went through to the static "Rover parking options" list and selected
"#3 rank 3". The vite log then shows 17 browser warnings `[provenance] mismatch: … from
scenarios/pads/rank3/{route_nom_104.geojson,timeline_nom_104.json} pads.rank3.route.leg.{1,5}.{t_min,length_m,o2_L},
pads.rank3.route.total_min, pads.rank3.timeline.K.{t_min,margin_min}`. This looks like the static rank-3 pad files
disagreeing with web/public/data/manifest.json. It has nothing to do with the live layer, and I did not investigate further.

## Re-running

1. Run `make serve …` and `VITE_LIVE=1 npm run dev` as above.
2. Run `node docs/hardening/e2e-drive.mjs http://localhost:5173` (env: `PW`, `CHROMIUM`, `OUT`, `API`, `OFFICIAL_HASH`, `PAD_CLICK`, `BAD`,
   `JOB_WAIT_S`; see the header of the script).
3. A pad whose hash is already cached attaches instantly. To time a full job again, use a pad that has not been computed yet
   (set `PAD_CLICK` to a spot whose nearest valid block is new), or clear that result from `$HL_SERVER_DATA/results/`.

The driver clicks map positions without any app hook. It clicks, reads the pad position the tool reports and
corrects the offset, with the scale taken from vertical clicks and Web Mercator. It re-measures the clickable area
before each click and refuses to click a spot covered by an HTML marker.

## Run after E8c (H5r): step 4 PASS, H5-1 fixed

E8c (#79) makes the plan job write a partial `scenarios/index.json` and `manifest.json` after every stage. This
re-run checks step 4 again in the browser on the demo configuration. It also re-runs steps 1–3, 5 and 6 with the same driver.

**Result: all six steps pass.** The nominal band and route are fetched and drawn **110.5 s after "Compute full plan"**, which is
250 s before the job ends. There are no 404s for `index.json` or `manifest.json`, and 0 uncaught errors.

### Setup
- Date: 2026-11-15, 05:27–05:34 local (CET). Worktree `hardening-h5r` at origin/main **8f2df5b** (E8c #79 + H1-1 #81).
- `/engine/version`: commit `8f2df5b0…` = HEAD, engine_tree `6135328580…`, terrain `sha256:67fe3ced…`. Official hash `7d491d3e2dd6a60d`.
- `ss -ltn` showed 8012 and 5173 free before the start. Both servers ran inside `flock /tmp/hl-heavy.lock`:
  `make serve HL_SERVER_DATA=/home/vincent/hl-data/server` and `cd web && VITE_LIVE=1 npm run dev`. Web security was on.
- Environment: `uv sync --frozen`, `cd web && npm ci`, and a gitignored `data -> ~/hl-data` symlink. Playwright 1.65.1 from
  `~/coding/hl-h2/web/node_modules` drove the system Chromium headless at 1900×1000 (as before).
- Command:
  `OUT=/tmp/hl-orch/h5r/run1 OFFICIAL_HASH=7d491d3e2dd6a60d PAD_CLICK=137.390,-4.786 node docs/hardening/e2e-drive.mjs http://localhost:5173`
- Driver change (this PR): step 4 now records the headline area each time it changes (`headlines`), takes a screenshot
  `step4-first-map.png` 1.5 s after the first result-tree band or route file returns 200 (`firstDrawn`), and counts the 404
  console errors after the click (`notFound404`). The pass criterion is unchanged.

### The pad
- **Rank 4, 137.387206, −4.781529** (D21 candidate). It is not rank 2 or 3, and not the rank-5 nearest-valid pad E8c used.
- Its hash at this engine identity, **`2e6b1ee139340286`**, was not in `$HL_SERVER_DATA/results/` before the run. I computed it with
  `server.engine.hashing.result_hash` on the default inputs; the same method gives E8c's `c39b2d277ede3668` for its pad.
  H5's earlier rank-4 probe (`aed58d507a7a7f53`) was computed on an older engine tree.
- How it was picked in the UI: the driver clicked the slope spot 137.38996, −4.785945 ("Nearest valid block: 137.387206°E −4.781529°N, 308.2 m away")
  and took "Use the nearest valid block". The `#4` marker covers the pad itself (H5-3).

### Step 4 timings (seconds after the click on "Compute full plan")

| Event | Seconds | Source |
|---|---|---|
| Job queued, then running stage nominal | 0.3–1.0 | panel text |
| **First map content**: `index.json`, `manifest.json`, `route_nom_104.geojson`, `scenarios/bands_104.geojson`, `nom_104/{isochrones,edges,partner}` all **200** | **110.5** | network log |
| "Stages on the map: nominal" and the headline shown | 111.1 / 111.6 | panel |
| Screenshot `step4-first-map.png` (the live nominal band has replaced the static one) | 113.1 | driver |
| **Bands stage**: index re-read (lists opt/con/nom_104), headline gains its range | **315.6** / 316.7 | network log / panel |
| Partner stage | 335.6 | network log |
| Route + summary; **job done** (first `done` poll) | **360.6** / 361.4 | job polls / panel |

- Run record stages: nominal 106.81, bands 205.20, partner 19.48, route 26.93, summary 0.05 s. The total is 358.5 s from the
  stage start (04:27:43.780Z to 04:33:42.278Z UTC). The UI polls every 5 s, which explains the small offset.
- The pad tool fetched the nominal files again after each later stage (all 200). It never requests the opt/con isochrone files
  (it draws `bands_104.geojson` and the nom_104 layers). So the "other variants" show up in the UI as the headline range at the bands
  stage, plus the re-fetched `bands_104.geojson`.
- Compared with H5 (run3), the first map content moved from 375.8 s (at the end of the job) to 110.5 s (just after nominal).
  The expected value was about 95 s; this nominal stage took 106.8 s on a machine shared with other agents.
- **Headline area during the nominal-only phase (111.6–316.7 s):** "Reachable within a 30-min walk home (nom_104): 22.1%".
  There is no range text, no "null" and no placeholder. `view.tsx` skips the range when both ends are null, so the
  `[null, null]` range from the partial index is simply left out. From the bands stage on it reads "… 22.1% (range 17.2% to 30.9%)".
  Reported only; nothing was changed. A presenter may want to say that the range follows with the other variants.
- Done: label "Computed live · not part of the validated scorecard · provenance of plan 2e6b1ee139340286", link `#/plan/2e6b1ee139340286`,
  "No range flags: every input is inside its validated range.", no contract errors.
- **Console:** 0 uncaught errors. After the click there were **0** `console.error` entries and 0 404s. The one 404 of the whole run is the vite
  favicon at page load (0.31 s, H5-4).
- `mapBeforeDone: true`: band and route returned 200 at 110.5 s and the job reported done at 360.6 s. Driver verdict: **step 4 PASS**.
- Screenshots (in `/tmp/hl-orch/h5r/run1/`): `step3-preview.png` (static official band, before the job),
  **`step4-first-map.png`** (the live rank-4 nominal band, while "Running stage bands"), `step4-stage2-bands.png`, `step4-stage3-partner.png`,
  `step4-stage5-summary.png`, `step4-done.png`, `step4-done-zoomed-out.png`. At this zoom the route line is hard to tell apart from the
  band in the screenshots; its file was fetched with 200 at 110.5 s.

### Other steps (same run, no regression)
1. **PASS:** ready after 1.5 s (3.0 s with the map settle), pad tool visible, no offline banner, console headline unchanged:
   **23 %**, range 15.2 % to 28.7 %, 60 min 31.5 % (16.2 % to 43.8 %).
2. **PASS:** `disc_off_grid`, nearest valid block 360.9 m (the official pad), reason 6 ms after the click.
3. **PASS:** preview 105 ms after "Use the nearest valid block", 14/14 numbers flagged as estimates; feasible EVAs (D21 score) 50.
5. **PASS:** the permalink renders in 477 ms, `computed_live`, 8 manifest-backed numbers and 0 withheld. The headline is 22.1 % (17.2 % to 30.9 %),
   60 min 17 % (10.4 % to 35.1 %), equal to index.json. The provenance shows the stage table. Export is 661 bytes; re-import gives the same hash in 170 ms.
6. **PASS:** official `7d491d3e2dd6a60d` "Precomputed · official plan", 23 / 15.2 / 28.7 %, the same as the static console.

Evidence: `/tmp/hl-orch/h5r/run1/` (screenshots, `e2e-result.json`, `plan_inputs.json`), `/tmp/hl-orch/h5r/run1.log`,
`/tmp/hl-orch/h5r/{api,vite,lock}.log`. Both servers were stopped afterwards, and 8012 and 5173 are free.

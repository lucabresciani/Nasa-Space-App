# Planning usability audit (L6, D111)

Package L6 of the plan "Planning UI — declutter and usability plan for one orchestrator (L0–L9)",
section 10. The team lead (12:35, D111) finds planning unintuitive and partly non-functional. This
audit runs the nine planning tasks T1–T9 with Playwright, records every failure as a defect, and
confirms or closes the seven known defects of section 10.2. It changes no product code.

Team lead corrections applied (12:40, **D114**):

- The I1 mouse mapping (right-drag pans, left interacts) stays as built. Known defect 3 is closed
  by decision; discoverability is noted as a hint only (L-17).
- The published site gets the live planner (hosted API). "Static build: dead controls" is
  therefore judged as **live build, API unreachable**. Controls must work against the API. Only
  when the API is unreachable may they hide behind the offline banner, and then with a "needs the
  live planner" note. No dead controls in either case.

## 1. Set-up

| Build | How | Port |
|---|---|---|
| Live, API reachable | `VITE_LIVE=1 VITE_LIVE_MOCK=1 vite` (no API answered on `localhost:8012`, so the contract mock stands in) | 4151 |
| Live, API unreachable | `VITE_LIVE=1 vite` with nothing on 8012 (the Pages-like build when the hosted API is down) | 4153 |
| Static | `vite` (VITE_LIVE off) | 4152 |

- Code: `design` at **753e807**, which includes the R7b re-land (#126: My plans, permalink and JSON
  export with the route). S1 (Send to simulator, mission.json) and WP6 (#130, free waypoints) are
  not on `design` yet.
- Browser: Chromium (`HL_CHROMIUM`), 1440 × 900 unless noted, `?intro=0` except for the intro
  check. The drivers were run through `/tmp/hl-design/webrun`.
- Screenshots: `docs/design/planning-usability/*.jpg` (1000 px wide, 11 files, < 1 MB).

**Mock caveat.** With the mock, job times are about 6 s instead of the measured 2–6 min (358 s for
S4, S1, S6, S7, docs/waypoints.md). The mock also returns fixture trees that do not match the route
asked for (the plan page lists "Pad → S1 → Pad" for an S2, S6 route, and an "Engine chooses" job
reports no feasibility). Those mismatches are not counted as defects. Everything about layout,
wording, controls and states is.

## 2. Results per task

| # | Task | Live, API up | Live, API down | Static | Defects |
|---|---|---|---|---|---|
| T1 | Understand the map in 30 s | Partly. Legend rows exist (slope classes, contours, hints), but the map is only 440 px wide between four panels | Partly (an empty 340 px column) | Partly | L-01, L-05 |
| T2 | Drag the rover to another pad; see validity and why not | **Fails.** The drag says "Live planning is offline" and only snaps. The readout covers the drop point. After one release the map collapses to about 80 px | Snap works (P2 verified); same readout problem | Snap works (P2 verified); the readout states the spot's validity and reason ("Valid rover pad spot", "Not a valid rover pad spot: too steep for the rover") | L-01, L-03, L-10 |
| T3 | Choose stations and their order; see the ghost route | Partly. Works after "My order", but ticking reorders rows under the pointer and there is no ghost route | Not offered, no note | Not offered (static) | L-05, L-06, L-08, L-09 |
| T4 | Add, move and delete a free waypoint | **Not yet available** (WP6 #130 in progress) | — | — | L-14 |
| T5 | Compute with one button; stages and expected time; map usable | Partly. "Compute plan" works and shows stages and a %. There are two compute buttons, no expected time, and the map is unusable once the details panel is open | Not offered | Not offered | L-01, L-04, L-07 |
| T6 | Feasible or infeasible, failing leg and limit, margin, "Computed live" | Partly. "Computed live · your route" and "Every leg keeps its margins." appear, but no margin number, and the headline still shows the official plan | — | — | L-11 |
| T7 | Undo/redo, visible and on Cmd/Ctrl-Z | Partly. The buttons work, and Ctrl-Z / Ctrl-Shift-Z work while focus is in the route panel. Elsewhere Ctrl-Z hits a different stack | — | Rover edit only | L-12 |
| T8 | Save to My plans, copy permalink, export JSON and mission.json | Partly (R7b). "Save to My plans" and "Export plan_inputs.json" work on `#/plan/{hash}`, reached through a small "Open this plan" link. No copy button; no mission.json (S1) | — | — | L-13 |
| T9 | A visible "Official plan" action | **Fails.** No such action exists in any build | Fails | Fails | L-02 |

## 3. Known defects (section 10.2): confirmed or closed

| # | Known defect | Verdict |
|---|---|---|
| 1 | Static build: planning controls do nothing, unexplained (reframed by D114) | **Partly open.** With the API up, the route controls work (compute, staged result, plan page). With the API down, the Edit-route section is removed from the rail with **no** "needs the live planner" note in its place, and the live aside stays as an empty 340 px column (L-05). The rover drag in the live build claims "Live planning is offline" even when it is up (L-03). The static build itself only shows the snap drag, which is honest there |
| 2 | Rover drag snaps only to the official pad and P2–P4; P5 is never a target; the refusal isn't shown | **Confirmed by code; browser check pending** (L-10). The reason for the dragged spot itself is shown ("Not a valid rover pad spot: too steep for the rover"); the reason a pad is refused as a target is not |
| 3 | Mouse mapping since I1 | **Closed by decision D114.** Right-drag pans the map in the static build (126 px measured); left-drag on empty map does nothing. The only mention is the shortcuts dialog (`Right drag`, ui/shell/keys.ts:98): hint L-17 |
| 4 | Rank markers swallow clicks; console-map resize/unmount race; 17 provenance warnings | **Mostly closed.** The X3 code is in place: covered `.pad-option` squares have `pointer-events: none` (consoleMap.ts:606); console-fixes.spec.ts covers it. **0** provenance warnings in all three builds. The unmount race did not show in the static build, but the live build logged one `pageerror: Cannot read properties of undefined (reading 'setData')` while switching Plan → Fly → Report → Plan → Evidence → Plan (L-18) |
| 5 | Long jobs give little feedback; preview estimate confusable with the computed result | **Confirmed** (L-07, L-11, L-04) |
| 6 | The intro's first click must skip the intro | **Closed.** One click on the map canvas removes `data-story-chrome="hide"` in all three builds. Side effect: in live builds the same click also places a live pad and opens a "Terrain spot: cannot be shown" card (L-15) |
| 7 | Live controls disabled instead of hidden when the API is down | **Partly closed.** The route panel and the pad tool are hidden, with the banner "Live planning is offline · showing precomputed plans". There is no note where they were, and their column stays empty (L-05) |

## 4. Defects

Severity is one of "blocks the task", "confusing" or "cosmetic". Owner is design (web/src/ui, map,
shell, story, hud, report, views) or waypoint (web/src/live/, web/src/edit/route/). Screenshots are
under `docs/design/planning-usability/`.

### L-01: In live builds the map shrinks to 440 px, then to about 80 px once the details panel opens
- **Severity:** blocks the task (T2, T5; T1 partly)
- **Owner:** design
- **Steps:**
  1. Open the live build at 1440 × 900 (`#/`). The Plan rail (320 px), headline and parking list (340 px), and crew plus live pad aside (340 px) leave a 440 px map.
  2. Drag the rover to P2 and release, or click any spot on the map. The details panel opens on the right and the map canvas shrinks to about 80 px. The rover and the pads are off-screen, a second drag is impossible, and a click on the zoom control times out.
  3. With the API down at 1024 × 768 the map is 288 px wide.
- **Files:** web/src/views/console.tsx (the `console-panel console-live` aside, line 63), web/src/ui/shell/ (details panel), web/src/ui/layout/ (L1 containers)
- **Screenshots:** 01-live-default-1440.jpg, 02-live-map-collapsed-after-drag.jpg, 03-api-down-1024.jpg
- **Note:** this is the core of L2/L3. Until they land, L7 should at least stop the details panel from opening on a rover release in live builds.

### L-02: No "Official plan" action anywhere (T9)
- **Severity:** blocks the task
- **Owner:** design
- **Steps:** move the rover and keep it (Enter), or compute a route, or open a `#/plan/{hash}`. Look for a way back to the official plan. None exists: only Escape on an uncommitted delta strip, the browser's back button, or a reload. `copy.json` has `shell.officialPlan: "Official plan"`, but no component uses it.
- **Files:** web/src/ui/copy.json:20 (unused key), web/src/ui/shell/ (top bar), web/src/edit/store.ts (reset to committed official)
- **Screenshot:** 07-route-result-feasible.jpg (no way back from a live route)

### L-03: Rover drag in the live build never uses live planning, says it is offline, and covers the drop point
- **Severity:** blocks the task (T2)
- **Owner:** design
- **Steps:**
  1. In the live build with the API up, drag the rover. The readout says "Live planning is offline: the rover snaps between the precomputed parking options". The live crew and pad panels next to it say "Computed live".
  2. "Feasible EVAs" and "Reachable area" stay "computing…" and never compute.
  3. On release the rover snaps to the nearest precomputed pad.
  4. A pad spot of your own needs a different gesture (click the map → "Live pad" in the aside), which nothing on the rover mentions.
  5. The drag readout is 484 × 314 px and sits over the map centre, clipped at the map's left edge, so the spot you are dropping on is hidden.
- **Files:** web/src/edit/ui.tsx:42–70 (`DragReadout`, `edit.snapStatic` with no live branch), web/src/edit/roverMap.ts:365 (readout placement), web/src/live/padtool.ts (the separate live pad)
- **Screenshot:** 04-live-rover-drag-readout.jpg

### L-04: Two compute buttons with separate jobs and results
- **Severity:** blocks the task (T5 "one button")
- **Owner:** waypoint
- **Steps:**
  1. In the live build, "Compute plan" sits in the rail (Stations and route).
  2. Click the map: the Live pad card shows "Instant preview" and "Compute full plan".
  3. Each button starts its own job with its own progress and result area. Nothing says which plan the map now shows.
- **Files:** web/src/edit/route/panel.tsx:264, web/src/live/view.tsx:94
- **Screenshots:** 06-route-running.jpg, 11-map-click-pad-and-card.jpg

### L-05: API unreachable: the route section vanishes without a note, and an empty 340 px column stays
- **Severity:** confusing (D114: no dead controls, and a "needs the live planner" note when hidden)
- **Owner:** waypoint (note, live/route/mount.tsx) + design (empty aside, views/console.tsx)
- **Steps:** run `VITE_LIVE=1` with no API. The top bar shows "Live planning is offline · showing precomputed plans". "Stations and route" is missing from the rail and nothing says it exists. The right-hand live aside is an empty dark column.
- **Files:** web/src/live/route/mount.tsx:179–196 (section unregistered on `!controls`), web/src/views/console.tsx:63
- **Screenshot:** 03-api-down-1024.jpg

### L-06: Ticking a station moves its row to the top under the pointer
- **Severity:** confusing (wrong stations get ticked without notice)
- **Owner:** waypoint
- **Steps:**
  1. Select "My order".
  2. Tick S6, then the row that was S1, then the row that was S4, by position.
  3. Each tick moves the checked row to the top of the list, so the later clicks land on other stations. The result was S2 and S6 ticked, with S1 and S4 unticked.
  4. The note above the list says "Nothing is reordered".
- **Files:** web/src/edit/route/panel.tsx:184–235, web/src/edit/route/model.ts (`routeRows`)
- **Screenshot:** 05-route-ordered-no-ghost.jpg

### L-07: Long jobs show no expected or elapsed time
- **Severity:** confusing
- **Owner:** waypoint
- **Steps:** compute a route. The panel shows "Staged result · Nominal band and route · waiting / on the map" and "queued · 0 %" → "bands · 33 %". Nothing says how long the job will take (measured 358 s) or how long it has run. The 5-stage `stepper` copy deck (copy.json:502) is not used.
- **Files:** web/src/edit/route/panel.tsx:60–83, web/src/live/jobs.ts
- **Screenshot:** 06-route-running.jpg

### L-08: No ghost route while choosing stations
- **Severity:** confusing
- **Owner:** waypoint (WP6)
- **Steps:** tick and reorder stations. Only a text list of legs updates ("Rover pad → S2, S2 → S6, …"). The map shows nothing until the job's first stage. `web/src/map/ghostRoute.ts` exists but is mounted nowhere.
- **Files:** web/src/edit/route/panel.tsx, web/src/map/ghostRoute.ts
- **Screenshot:** 05-route-ordered-no-ghost.jpg

### L-09: Station checkboxes are disabled in the default mode with no reason
- **Severity:** confusing
- **Owner:** waypoint
- **Steps:** open "Stations and route" (the last section of the rail, below eight layer toggles: 485 px down after scrolling). In "Engine chooses" all six checkboxes are disabled and have no title or description. A click does nothing; the user has to find "My order" first.
- **Files:** web/src/edit/route/panel.tsx:222
- **Screenshot:** 09-engine-chooses-disabled.jpg

### L-10: P5 is never a snap target, and the refusal is silent
- **Severity:** confusing
- **Owner:** design
- **Evidence:** code, plus the known report. Not re-verified in the browser: the pass-3 run (one fresh page per pad) was cancelled because the machine was overloaded (load 67, orchestrator 13:05). In passes 1–2 the details panel opened after the first release and moved the map (L-01), so the later drag targets were stale.
- **Steps:**
  1. Drag the rover onto P5 (`pad_default`).
  2. `snapTarget` (edit/drag.ts:124) only considers pads for which `padValid` (edit/rover.ts:51) holds, and that applies the browser block check (every cell of the 20 × 20 m block assessed, max slope ≤ 5°).
  3. P5 is the pre-D21 default pad. Its pads/index.json entry has `kind: pad_default` and `picker: true`, and it was not one of the screened 20 × 20 m blocks, so it can fail that check. In that case the rover lands on P2–P4 or the official pad.
  4. The snap line only names the pad it snaps to ("· #4"). Nothing says P5 is refused or why, and the parking list still offers P5.
- **Files:** web/src/edit/rover.ts:51, web/src/edit/drag.ts:124, web/src/edit/ui.tsx:66 (snap line)
- **Screenshot:** — (L7 should add a Playwright step: fresh page, drag onto the P5 marker, assert the target and a stated reason)

### L-11: A feasible route shows no margin, and the official headline stays beside a live result
- **Severity:** confusing (T6)
- **Owner:** waypoint
- **Steps:** compute a feasible ordered route. The panel says "Computed live · your route · Provenance … · Every leg keeps its margins." with no tightest-margin number. Only an infeasible route gets one ("Short by N min"). The headline (23 %), parking list, crew and margin readouts still show the official plan; the timeline is replaced by a one-line note. Also, the pad tool's "Instant preview" (an estimate) and the route's "Computed live" result use different panels and wording, and no shared Estimate / Computed badge tells them apart.
- **Files:** web/src/edit/route/panel.tsx:87–122, web/src/live/view.tsx:54–100
- **Screenshot:** 07-route-result-feasible.jpg

### L-12: Two undo stacks behind one shortcut
- **Severity:** confusing (T7)
- **Owner:** waypoint + design
- **Steps:** reorder stations, then press Ctrl-Z.
  - With focus in the route panel it undoes the reorder (verified: Ctrl-Z, then Ctrl-Shift-Z, restores it).
  - With focus elsewhere the route is unchanged and the shell's plan-edit undo runs instead.
  - The undo/redo buttons exist only for the route and give no reason when disabled.
- **Files:** web/src/edit/route/panel.tsx:136–143, web/src/ui/shell/keys.ts:59
- **Screenshot:** none (keyboard)

### L-13: Saving and sharing live only on the plan page; no copy button; no mission.json
- **Severity:** confusing (T8 is achievable with R7b)
- **Owner:** waypoint
- **Steps:** after a compute, the only way to save is the small "Open this plan" link at the bottom of the screen (in place of the timeline). On `#/plan/{hash}`, "Save to My plans" → "Saved in this browser." and "Export plan_inputs.json" both work. The permalink is a plain text link with no "Copy link" button. "My plans" is not listed in the Plan view. There is no mission.json export (S1 in progress). On the plan page the basemap is blank (cosmetic).
- **Files:** web/src/live/planview.tsx:162–180, web/src/live/plans/view.tsx, web/src/edit/route/panel.tsx
- **Screenshot:** 08-plan-page-saved.jpg

### L-14: Free waypoints not yet available (T4)
- **Severity:** blocks the task (expected; WP6 #130 in progress)
- **Owner:** waypoint
- **Steps:** there is no "Add waypoint" control in any build.
- **Files:** web/src/edit/route/ (WP6 `map/`)
- **Screenshot:** —

### L-15: A left click on the map moves the live pad, including the click that skips the intro
- **Severity:** confusing
- **Owner:** design (map click routing) + waypoint (pad tool)
- **Steps:** in the live build, click any spot to inspect it. The details panel opens a "Terrain spot" card, and at the same time the Live pad card places a pad there ("Valid pad (D21 rule)" or "Too steep …"). The first click that dismisses the intro does the same: the intro is skipped (defect 6 fixed), but the pad moves and a "Terrain spot: cannot be shown" card opens.
- **Files:** web/src/live/mapPort.ts:99 (map click → pad tool), web/src/map/select.ts, web/src/story/
- **Screenshots:** 10-intro-first-click.jpg, 11-map-click-pad-and-card.jpg

### L-16: Edit route is hard to find
- **Severity:** confusing
- **Owner:** design
- **Steps:** "Stations and route" is the last section of the Plan rail, below Contours, Slope classes, Rough footing, Sulfate, Clay, Ridges, Mineral and Blocked area. There is no "Edit route" button in view (spec section 3 requires one).
- **Files:** web/src/ui/shell/ rail, web/src/live/route/mount.tsx (section registration)
- **Screenshot:** 01-live-default-1440.jpg

### L-17: Right-drag pan is only listed in the shortcuts dialog (hint, D114)
- **Severity:** cosmetic
- **Owner:** design
- **Steps:** a first-time user left-drags the map and nothing happens. The mapping is documented only in the keyboard-shortcuts dialog.
- **Fix:** a one-time map hint ("Right-drag to pan"), or the empty-state line of the details panel.
- **Files:** web/src/map/input/index.ts, web/src/ui/shell/keys.ts:98
- **Screenshot:** —

### L-18: Live build: one pageerror while switching modes
- **Severity:** cosmetic (console only, no visible break)
- **Owner:** design (console map) to triage, then waypoint if a live caller is at fault
- **Steps:** in the live build, go Plan → Fly → Report → Plan → Evidence → Plan quickly while resizing between 1024 and 1224 px. One `pageerror: Cannot read properties of undefined (reading 'setData')`. `ConsoleMap.setScenarioData` and `setRoute` are guarded, so the caller is a live path (pad tool or route stage), probably a source that does not exist yet.
- **Files:** web/src/map/consoleMap.ts, web/src/live/route/map.ts:83, web/src/live/mapPort.ts
- **Screenshot:** —

### L-19: API down: the health poll floods the console
- **Severity:** cosmetic
- **Owner:** waypoint
- **Steps:** with the API down, 30 `net::ERR_CONNECTION_REFUSED` errors in about 3 minutes.
- **Files:** web/src/live/health.ts
- **Screenshot:** —

## 5. Top 10 (ranked)

This is the corrected list. The first list (12:50) had "No Save / My plans" as item 2. R7b (#126)
re-landed at 12:34 and the save flow works, so that item is now L-13 (confusing). L-01 enters as
the new first item.

| # | Severity | Owner | Defect |
|---|---|---|---|
| 1 | blocks the task | design | L-01: In live builds the map shrinks to 440 px, then to about 80 px once the details panel opens |
| 2 | blocks the task | design | L-02: No "Official plan" action anywhere |
| 3 | blocks the task | design | L-03: Rover drag in live never uses live planning, says "offline", and covers the drop point |
| 4 | blocks the task | waypoint | L-04: Two compute buttons ("Compute plan" and "Compute full plan") with separate jobs |
| 5 | confusing | waypoint | L-06: Ticking a station moves its row under the pointer, so the wrong stations get ticked |
| 6 | confusing | waypoint + design | L-05: API down: the route section vanishes without a note, and an empty 340 px column stays |
| 7 | confusing | waypoint | L-07: 2–6 min jobs show no expected or elapsed time |
| 8 | confusing | waypoint | L-08: No ghost route while choosing stations |
| 9 | confusing | waypoint | L-09: Station checkboxes disabled in "Engine chooses" with no reason |
| 10 | confusing | design | L-10: P5 is never a snap target, and the refusal is silent |

Next below the cut: L-11 (no margin number; the official headline stays beside a live result),
L-12 (two undo stacks), L-15 (a map click moves the live pad, including the intro click), L-16
(Edit route hard to find), L-13 (save only on the plan page; no copy button). L-14 (T4) is expected
until WP6 lands.

## 6. How to re-run

The drivers are scratch scripts, not part of the test suite. L7 turns each blocking step into a
Playwright test.

- **Pass 1:** all tasks, three builds.
- **Pass 2:** route, compute, plan page, rover drag, 1024 px.
- **Pass 3:** one fresh page per pad, dragged onto P2, P4 and P5. It was cancelled at 13:05 because
  the machine was overloaded, so L-10 rests on the code. Re-run it once load allows; it should
  fail on P5.

Start one dev server per build (ports as in section 1). Run each driver under
`/tmp/hl-design/webrun`, with `HL_CHROMIUM` set, against the base URL.

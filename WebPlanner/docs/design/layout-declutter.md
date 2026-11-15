# Layout declutter — inventory and baseline (L0, D111)

Package L0 of the plan "Planning UI — declutter and usability plan for one orchestrator (L0–L9)"
(Notion 419961bc…2ba8, team lead order 12:35, D111). Docs only: nothing in the app changes here.

What this file gives the later packages:

- §0 the compact mapping table (element | where now | intent | action), read against spec §3–4 as
  intent (team lead 12:44): "already fine", "gone", "move", "new";
- §1 every panel, layer, rail section, dock, card, overlay and tab in the four modes, static and live
  build, with its mounting file and function, its size and position today, and its target container
  (spec §4) or a proposed one where §4 does not list it;
- §2 the coverage baseline (screenshots + measured map coverage), the reference for the L5 test;
- §3 the mount points L2 and L3 change, file:function, and the overlap with the waypoint PR #130;
- §4 open questions for the team lead (the default each package uses meanwhile is stated).

**Primary layout = the published Pages build with the live layer on** (team lead correction 12:40,
D114: the live planner must work on the published site). The live containers (Edit-route Drawer and
its button, the pad MarkerCard on the rover, the crew Collapsible) are part of the default published
layout, and coverage is measured with the live layer on, API reachable and API unreachable. The
static build (`VITE_LIVE` off) is kept as a secondary row (fallback, `?legacy=1` checks, spec §6.6).
The I1 mouse mapping stays as built (D114); nothing here proposes a change to it.

Code state: `origin/design` at **753e807** (includes R5 Edit route and R7 My plans; spec §3–4 are read as intent, 12:44). The screenshots were taken on builds of 471e975: 753e807 adds only `web/src/live/plans/` and the `#/plan` pages, so the default views measured are the same. Builds measured, all opened with `?intro=0`:

- **live, API reachable**: `VITE_LIVE=1 VITE_LIVE_MOCK=1 vite build` (the contract mock answers
  `/health` ready; stands in for the hosted API);
- **live, API unreachable**: `VITE_LIVE=1 VITE_API_BASE=http://127.0.0.1:9 vite build` (nothing
  listens: offline banner, live controls hidden — kit rule 4);
- **static**: `vite build`.

Layout tokens today (`web/src/ui/tokens.json` → `layout`): top bar 48, left rail 320 (collapsed 56),
right sidebar 360, timeline dock 120 (collapsed 40). Breakpoints: tablet ≥ 768, desktop ≥ 1280, so
**1440 × 900 is "desktop"** (rail 320 open by default) and **1024 × 768 is "tablet"** (rail = 56 px
icon column; its toggle opens the full rail as a sheet over the map).

Container names below are the L1 set: **Drawer** (right), **BottomDrawer** (tabs), **MarkerCard**,
**Popover**, **Collapsible**, plus "headline strip", "corner chip" and "command palette" from spec §3/§4.

## 0. Mapping table (design head 753e807; primary layout = live Pages build, D114)

Coverage baseline (§2), live Plan default: **75.2 % at 1440 × 900, 78.0 % at 1024 × 768** (API down 76.3 % / 79.4 %; static 55.1 % / 49.6 %); targets 25 % / 35 %. Intent = spec §3–4 read as intent (12:44). Actions: **already fine** · **gone** · **move** · **new**. Questions Q1–Q7 in §4 of the doc.

| # | Element | Where it is now (file : function) | Intent | Proposed action |
|---|---|---|---|---|
| 1 | Map: field, bands, thread, stations, rover, labels | `map/consoleMap.ts : ConsoleMap` in `views/console.tsx : view` (flex:1 beside the asides) | always visible | **already fine** (gets full width once 5, 8 move) |
| 2 | Mode tabs P/Y/R/E | `ui/shell/Shell.tsx : TopBar / ModeTabs` | always visible | **already fine** |
| 3 | Headline (reach %, range, 60-min line, pad score) | top section of the console aside `views/console.tsx : ConsolePanel`, `Headline60`, `PadHeadline` | headline strip: 30-min, 60-min, tightest margin + trust chips | **move** into the empty top-bar slot `#hl-topbar-plan` (Shell `TopBar`); full text stays in Report |
| 4 | Timeline dock (120 px, open by default) | `Shell.tsx : Dock` + `ui/timeline/install.tsx : installTimelineDock` | slim scrubber, expands | **move**: BottomDrawer tab "Timeline", collapsed = one-line scrubber |
| 5 | Console aside, 340 px, full height (scenario, budget + slider, pad picker, planned route, layers, legend, rover pad, F8, stations table) | `views/console.tsx : view` (`.console-panel`) → `ConsolePanel` | off the map; key table one click away | **move** per section: route + stations → BottomDrawer tab "Plan table" (one-line summary); scenario/budget → chips in the headline strip (Popover); legend → corner chip; layer checkboxes → merged into the layer Popover; pad picker + rover pad → rover MarkerCard; full content in Report (Q2, Q3) |
| 6 | Left rail, 320 px open on desktop (56 on tablet) | `Shell.tsx : Rail` | navigation only | **move**: icon column (56) by default in Plan/Fly; sections leave (7, 9) |
| 7 | Layer manager (U7) | rail section `map/overlays/index.ts : installOverlays` → `LayerPanel` | icon Popover | **move** to a Layers icon Popover at the map edge |
| 8 | Live pad tool + crew panel: a **second 340 px aside** | `views/console.tsx : view` (`liveAside`) → `live/index.ts : padTool` → `live/padmount.tsx : mountPadTool` (`CrewPanel` + `PadToolPanel`) | pad: rover MarkerCard; crew: Collapsible in the Edit-route drawer | **move** (L3, mount only). Default published layout: rover card closed, crew collapsed. Today the aside stays as an **empty 340 px column while the API is down** (Q8) |
| 9 | Edit route (R5): stops, mode, compute, infeasible, export | rail section `live/route/mount.tsx : mountRoutePanel → section()` → `edit/route/panel.tsx : RoutePanel` | right Drawer + "Edit route" button | **move** to the right Drawer (use the existing `register` seam); **new** "Edit route" button at the map edge, shown only while /health is ready |
| 10 | My plans (R7) | full pages `#/plan`, `#/plan/{hash}`: `live/planmount.tsx : mountPlanRoute` → `live/plans/view.tsx` | in the Edit-route drawer | **move/new**: a "My plans" section in the Drawer reusing `live/plans/view.tsx` (mount only); the pages stay (Q6) |
| 11 | Send to simulator (A5s, flag) | `live/simslot.tsx` in `live/planview.tsx : PlanPage`; `ui/cards/simslot.tsx` in `ui/cards/cards.tsx : RouteSummaryCard` | in the drawer next to export | **move** (mount only) next to export |
| 12 | Station cards | right sidebar 360 on selection (`ui/cards/sidebar.tsx : installSelectionSidebar`); a map click also **navigates to the full page `#/station/:id`** (`views/console.tsx : view` callback) | MarkerCard or Drawer, one at a time | **move**: click selects only → card; full page via "Open station" (Q1) |
| 13 | Search / command palette (Ctrl-K, /) | `ui/search/button.tsx : SearchButton` → `palette.tsx` | palette only | **already fine** |
| 14 | Rover drag readout + delta strip | `edit/roverMap.ts : installRoverDrag` (readout marker; strip via `setSidebarContent` + `openSidebar`) | rover MarkerCard | **move** strip into the rover MarkerCard (same card as 8) |
| 15 | Map controls: zoom, scale, compass | `ConsoleMap` ctor, `MapFurniture` ctor | small | **already fine** |
| 16 | 2D/3D + exaggeration, Flat-vs-real toggle, flythrough, storm, cursor readout | `TerrainController`, `CollapseToggle` (`syncCollapse`), `FlythroughControl`, `installStorm`, `MapFurniture` | small, one click | **move**: 3D slider + collapse toggle into the layer Popover; flythrough/storm as icon buttons; readout as a one-line chip |
| 17 | Collapse headline overlay | `map/field/collapseUi.ts : CollapseHeadlineOverlay` | headline strip | **already fine** as an overlay; merge into the strip later (Q4) |
| 18 | Live status / offline banner | `live/index.ts : mountLive` | banner (kit rule 4) | **already fine** |
| 19 | Trade view (Plan rail view) | `views/trade.tsx`, `MODE_VIEWS.plan` | report content | **move** to Report mode (Q2) |
| 20 | "Details" (sidebar) toggle in top bar | `Shell.tsx : TopBar` | — | **gone** once the Drawer replaces the sidebar (opener = Edit route / card) (Q5) |
| 21 | §4 "Core report / planning **tab** in Plan" | there is no tab: it is the console aside (5) + the Trade view (19) | — | **gone** as a row; covered by 5 and 19 |
| 22 | Fly: HUD controls bar + drag bar | `hud/hud.ts` | L4: slim | **move** (L4, cut first) |
| 23 | Report (cuff), Evidence (scorecard, about) | `views/cuff.tsx`, `views/scorecard.tsx`, `views/about.tsx` | documents + headline strip | **already fine** (L4 adds the strip) |

Sections 1–3 give the full inventory behind this table.

## 1. Inventory

Legend for the last column: **§4** = placement given by the spec; **proposed** = not in §4, L0's
proposal; **keep** = core flow, stays visible (spec §3); **n/c** = no change.

### 1.1 Shell (all modes)

| # | Item | Mounted in (file : function) | Today (size / position) | Target |
|---|---|---|---|---|
| S1 | Top bar: wordmark, mode tabs (Plan/Fly/Report/Evidence, keys P/Y/R/E) | `ui/shell/Shell.tsx : TopBar`, `ModeTabs` (via `mountShell`) | full width × 48, top | keep (mode switcher, §3) |
| S2 | Top-bar plan slot `#hl-topbar-plan` | `ui/shell/Shell.tsx : TopBar` | flex:1, **empty today** | proposed: host of the **headline strip** (30-min reach, 60-min reach, tightest margin + trust chips) |
| S3 | Search button (opens palette, Ctrl-K and `/`) | `ui/search/button.tsx : SearchButton` | top bar, right, 32 px icon | §4 command palette (already a palette; keep the icon) |
| S4 | "Details" toggle (opens right sidebar) | `ui/shell/Shell.tsx : TopBar` (map modes only) | top bar, right icon | proposed: removed as a separate control once the right **Drawer** replaces the sidebar (opener = Edit route / station card) — QUESTION Q5 |
| S5 | Keyboard help button + help dialog | `Shell.tsx : TopBar`, `HelpDialog` | icon; modal dialog | n/c (modal, Esc closes) |
| S6 | Dev provenance badge (dev builds only) | `main.ts : setFrame` | top bar, right | n/c (dev only) |
| S7 | Dummy-data banner | `ui/shell/frame.ts : buildShellFrame` | full width strip under top bar, dummy builds only | n/c (rule: never hidden) |
| S8 | Left rail: mode title, collapse toggle, view list per mode (`MODE_VIEWS`) | `Shell.tsx : Rail`; views in `ui/shell/store.ts : MODE_VIEWS` | desktop 320 × full height, **open by default**; tablet 56 icon column | proposed: rail **collapsed to the 56 px icon column by default** in Plan and Fly at every size (view list as icons); sections move out (rows S9, P-L1, LV3) |
| S9 | Rail sections (registry `registerRailSection`) | `ui/shell/store.ts : registerRailSection`; rendered in `Shell.tsx : Rail` | under the view list, rail width | proposed: registry stays for Report/Evidence; Plan sections move to Popover / Drawer (rows P-L1, LV3) |
| S10 | Right sidebar (selection cards, rover delta strip) | `Shell.tsx : Sidebar`; content via `store.ts : setSidebarContent` | 360 × full height, right; **closed by default**, opens on selection | §4 right **Drawer** (station cards: MarkerCard or Drawer, one at a time) |
| S11 | Timeline dock (EVA time) | `Shell.tsx : Dock`; body `ui/timeline/install.tsx : installTimelineDock` (via `setDockContent`) | full width under the map × **120 open by default** (40 collapsed), map modes only | §4 **BottomDrawer** tab "Timeline", collapsed to the slim scrubber |
| S12 | Focus-mode exit button | `Shell.tsx : FocusExit` | overlay, only in focus mode | n/c |
| S13 | Skip link | `Shell.tsx : SkipLink` | off-screen until focused | n/c |

### 1.2 Plan mode — `#/` (view `views/console.tsx : view`)

The view builds `<div class="console"><div class="console-map"/><aside class="console-panel"/></div>`
inside the shell outlet: the map and a **340 px aside** sit side by side (flex), so the aside takes map
width rather than covering it.

**Map and map controls** (`map/consoleMap.ts : ConsoleMap` constructor and `initLayers`)

| # | Item | Mounted in | Today | Target |
|---|---|---|---|---|
| P-M1 | Map: basemap, field / margin, bands, edges, route thread, stations, pad/rover marker, U13 labels | `map/consoleMap.ts : ConsoleMap`, `MapFurniture` (`map/furniture/index.ts`), `LabelLayer` | flex:1 of the outlet | keep (the product) |
| P-M2 | Zoom buttons (MapLibre NavigationControl) | `ConsoleMap` constructor, `addControl(…, 'top-left')` | top-left, ~30 × 60 | n/c (small) |
| P-M3 | 2D/3D toggle + exaggeration slider (U1) | `map/terrain/index.ts : TerrainController` constructor → `controls.ts : TerrainControl` | top-left under zoom, ~180 × 70 | proposed: into the layer **Popover** (2D/3D stays as one icon button; key T) |
| P-M4 | Scale bar | `ConsoleMap` constructor, `MarsScaleControl` | bottom-left | n/c |
| P-M5 | Compass | `map/furniture/index.ts : MapFurniture` constructor (`addControl 'top-right'`) | top-right, ~56 px | n/c |
| P-M6 | Cursor readout | `MapFurniture` constructor (`addControl 'bottom-right'`) | bottom-right, a few rows | proposed: one-line chip, bottom-right |
| P-M7 | Flythrough button + speed | `map/flythrough/control.ts : FlythroughControl` (`initLayers`) | top-right | proposed: icon button in the map-edge toolbar; speed in a Popover |
| P-M8 | Storm switch | `map/storm/index.ts : installStorm` → `StormControl` | top-right | proposed: icon button in the map-edge toolbar |
| P-M9 | Storm mode overlay (while storm on) | `map/storm/mode.tsx` (container overlay) | over the map, only with storm on | n/c (state, not default) |
| P-M10 | Collapse "Flat vs real" toggle | `map/field/collapseUi.ts : CollapseToggle` (`ConsoleMap.syncCollapse`) | top-right (only with a pad on the grid) | proposed: into the layer Popover |
| P-M11 | Collapse headline overlay (counts up with k) | `collapseUi.ts : CollapseHeadlineOverlay` (`syncCollapse`) | in the map container | proposed: merged into the headline strip (same number, same manifest key) — QUESTION Q4 |
| P-M12 | Selection marker / camera | `map/select.ts : MapSelection`, `map/camera` | on the map | n/c |
| P-M13 | Rover drag readout (while dragging) | `edit/roverMap.ts : installRoverDrag` (Marker under the rover) | follows the rover, only while dragging | §4 rover **MarkerCard** (same card) |
| P-M14 | Rover delta strip (after a release) | `edit/roverMap.ts : installRoverDrag → mountStrip` → `setSidebarContent` + `openSidebar` | opens the 360 px sidebar | §4 rover **MarkerCard** (validity + estimate) |
| P-M15 | Story intro caption / cover | `story/stage.ts` (via `story/attach`) | over the map, first visit only | n/c (not default state; M10d) |

**Layer manager (U7)**

| # | Item | Mounted in | Today | Target |
|---|---|---|---|---|
| P-L1 | Layer manager: Terrain / Science / Evidence groups, toggles, opacity, legends | `map/overlays/index.ts : installOverlays` → `registerRailSection({id:'layers', modes:['plan']})` → `LayerPanel.tsx` | rail section, rail width (320), below the view list | §4 icon **Popover** at the map edge |

**Console aside** — `views/console.tsx : ConsolePanel` rendered into `.console-panel` (340 px, full height, right of the map, scrolls). This is the "core report / planning tab" of spec §1. Sections in order:

| # | Section | Function | Target |
|---|---|---|---|
| P-A0 | Dummy note / data problems | `ConsolePanel` (`DummyNote`, `DataProblem`) | proposed: Banner above the map (kit rule: never hidden) |
| P-A1 | Headline (reachable %, range, official pad score, 60-min line) or pad headline | `ConsolePanel` `section.headline`, `Headline60`, `PadHeadline` | §3 **headline strip** (30-min, 60-min, tightest margin + trust chips); full text in Report |
| P-A2 | Rover parking options (pad picker, D21) | `PadPicker` | §4 rover **MarkerCard** (pad choice = "move the rover") |
| P-A3 | Planned route (legs, turn-back table) | `RouteSection`, `RouteLegs`, `TurnBackTable` | §4 **BottomDrawer** tab "Plan table" (one-line summary when collapsed); full in Report |
| P-A4 | Scenario (variant + suit mass segments) | `ConsolePanel` `section` "Scenario" | proposed: compact selector chip in the headline strip → Popover — QUESTION Q2 |
| P-A5 | Walkback budget (30/60) + budget slider (isochrones) | `ConsolePanel` "Walkback budget", `BudgetSlider` | proposed: budget toggle in the headline strip; slider into the layer Popover (it is a layer) |
| P-A6 | Layers (checkbox list) | `ConsolePanel` "Layers" | proposed: merged into the U7 layer **Popover** (two layer managers today) — QUESTION Q3 |
| P-A7 | Legend | `Legend` (console.tsx) | §4 **corner chip** (bottom-left, opens a Popover) |
| P-A8 | Rover pad (pad in use text) | `ConsolePanel` "Rover pad", `PadInUseText` | proposed: rover **MarkerCard** |
| P-A9 | F8 heatmap (proposal) | `PadProposalSection` (only when the siting layer is on) | proposed: under the F8 row of the layer Popover |
| P-A10 | Stations table (walk-in, home) + access-cell caption | `ConsolePanel` "Stations" | proposed: **BottomDrawer** tab "Plan table" (the "key table"); a row opens the station MarkerCard |

**Station cards and views in Plan**

| # | Item | Mounted in | Today | Target |
|---|---|---|---|---|
| P-C1 | Selection card (station, pad, cell, route summary + SimSlot) | `ui/cards/sidebar.tsx : installSelectionSidebar` (lazy, from `mountShell`) → `SelectionPanel` | right sidebar 360, opens on selection; Esc clears | §4 **MarkerCard** (station) or right **Drawer**, one at a time |
| P-C2 | Station page `#/station/:id` (Navcam, panorama, timeline, tasks) | `views/station.tsx : view` (`VIEWS.station`) | **full outlet; replaces the map**. A map click on a station (`views/console.tsx : view`, ConsoleMap callback) selects it **and** navigates here | proposed: map click only selects (MarkerCard); the full page stays reachable from the card ("Open station") — QUESTION Q1 |
| P-V1 | Trade view `#/trade` (trade table) | `views/trade.tsx : view`; Plan rail view list (`MODE_VIEWS.plan`) | full outlet, replaces the map | proposed: moves to Report mode (it is document content) — QUESTION Q2 |
| P-K1 | Command palette | `ui/search/palette.tsx` (lazy, from `SearchButton`) | modal, closed | §4 (already) |

### 1.3 Plan mode, live layer (`VITE_LIVE=1`; part of the default published layout, D114)

| # | Item | Mounted in | Today | Target |
|---|---|---|---|---|
| LV1 | Live status line (offline / warming) | `live/index.ts : mountLive` (`anchor.after(line)`, from `main.ts : setFrame`) | full-width line under the top bar, hidden while ready | n/c (kit rule 4 banner) |
| LV2 | **Second 340 px aside** `.console-live`: Crew panel + Live pad tool (Instant preview, Full plan) | `views/console.tsx : view` (`liveAside()` + `m.padTool`) → `live/index.ts : padTool` → `live/padmount.tsx : mountPadTool` → `CrewPanel` (`live/crewview.tsx`) + `PadToolPanel` (`live/view.tsx`) | 340 × full height, right of the console aside (map loses 680 px) | §4: pad tool → rover **MarkerCard**; crew → **Collapsible** "Crew: default · Edit" in the Edit-route Drawer |
| LV3 | Edit-route panel (stops, mode, compute, infeasible, export) | `live/index.ts : padTool` → `live/route/mount.tsx : mountRoutePanel` → `section()` → `registerRailSection({id:'edit-route', modes:['plan']})` → `edit/route/panel.tsx : RoutePanel` | rail section (320 wide on desktop; tablet only in the rail sheet); registered only while /health is ready | §4 right **Drawer**, opened by the "Edit route" button |
| LV4 | Route dock note (result shown, link to it) | `live/route/mount.tsx : routeDock` (`setDockContent`) | replaces the timeline dock body while a route result is on the map | proposed: BottomDrawer "Timeline" tab body (same swap) |
| LV5 | "Edit route" button | — (does not exist; the rail section is the entry) | — | §3 keep: new button (map edge, top-right) opening LV3's Drawer |
| LV6 | My plans (R7: list, save, permalink, JSON export/import) | `live/planmount.tsx : mountPlanRoute` (`plansProps`) → `live/plans/view.tsx`; store `live/plans/store.ts` (browser storage) | on the full pages `#/plan` (list) and `#/plan/{hash}` (save, then the list) | §4 right Drawer, a "My plans" section under Edit route (mount the same view) — Q6 |
| LV7 | Send to simulator (A5s, `VITE_SIM_EXPORT`) | `live/simslot.tsx : SimSlot` in `live/planview.tsx : PlanPage`; `ui/cards/simslot.tsx : SimSlot` in `ui/cards/cards.tsx : RouteSummaryCard` | inside the plan page / route-summary card | §4 inside the Edit-route Drawer next to export |
| LV8 | Live plan pages `#/plan`, `#/plan/{hash}`, `/provenance`, `/play`, `#/plan/import` | `live/planmount.tsx : mountPlanRoute` (from `live/index.ts : mountLive → planRoute`) | full outlet pages | proposed: n/c (Report-type pages reached by permalink); QUESTION Q6 |

### 1.4 Fly mode — `#/hud` (default), `#/conditions`

| # | Item | Mounted in | Today | Target (L4) |
|---|---|---|---|---|
| F1 | HUD stage: own 2D map canvas, simulated label, "no route" note | `hud/hud.ts` (stage) via `views/slot.ts : slotView('hud')` | outlet | keep |
| F2 | HUD controls bar (play, speeds, scrubber, time, storm, drift, odometry, fix, fps) | `hud/hud.ts` (`controls`) | full-width bar under the stage | proposed: slim bar = the scrubber; toggles into a Popover |
| F3 | Drag-anywhere bar (hint, sigma, back) | `hud/hud.ts` (`dragBar`) | second bar | proposed: Popover / only while dragging |
| F4 | Helmet panel (minimal / expanded, ribbon, minimap) | `hud/panel.ts : createHudPanel` | overlay on the stage | n/c (it is the HUD; minimal by default, D14) |
| F5 | Rail (view list Fly: HUD, Conditions) | `Shell.tsx : Rail` | 320 desktop / 56 tablet | as S8 |
| F6 | Timeline dock | as S11 | 120 under the HUD | as S11 (BottomDrawer) — QUESTION Q7 (HUD has its own scrubber) |
| F7 | Conditions page | `views/conditions.tsx : view` | full outlet document | n/c |
| F8 | Live: "Play this plan" HUD | `live/planmount.tsx : playPlan` | full outlet | n/c |

### 1.5 Report mode — `#/cuff`

| # | Item | Mounted in | Today | Target |
|---|---|---|---|---|
| R1 | Cuff card (route card, timeline, O₂, turn-backs, one A6 card per station) | `views/cuff.tsx : view` | full outlet document, print CSS | n/c; receives the full console content (P-A1/A3) — spec "Report keeps the full content" |
| R2 | Rail (one view: Cuff card) | `Shell.tsx : Rail` | 320 / 56 | n/c (document mode); L4: headline strip on top |
| R3 | Report SimSlot export | `report/index.ts` re-exports `ui/cards/simslot.tsx : SimSlot` | not mounted by a view yet | n/c |

### 1.6 Evidence mode — `#/scorecard` (default), `#/about`

| # | Item | Mounted in | Today | Target |
|---|---|---|---|---|
| E1 | Scorecard (validation, assumptions, real/modelled/simulated, provenance) | `views/scorecard.tsx : view` | full outlet document | n/c; L4 headline strip |
| E2 | About (data, licences, SI-use) | `views/about.tsx : view` | full outlet document | n/c |
| E3 | Live privacy note (live builds) | `live/privacy.tsx` (dynamic import from `views/about.tsx`) | section in About | n/c |
| E4 | Rail | `Shell.tsx : Rail` | 320 / 56 | n/c |

**Count:** 13 shell items + 15 map items + 1 layer manager + 11 console-aside sections + 4 card/view
items + 8 live items + 8 Fly + 3 Report + 4 Evidence = **67 items**, grouped into the 23 rows of §0.

## 2. Coverage baseline (default state, measured)

**Method** (the L5 test should reuse it): Playwright + Chromium (SwiftShader), page `/?intro=0#/<view>`,
6 s settle (3.5 s for non-map views). **Work area** = the viewport below the top bar (the region the
map could fill). A grid of sample points every 8 px over the work area is hit-tested with
`document.elementFromPoint`; a point counts as **map** when the top element is a map canvas
(`.console-map` / the HUD stage) or a map marker / label, and as **covered** otherwise; covered
points are attributed to their container (rail, console aside, live aside, dock, MapLibre control
corners, HUD parts). Covered % = covered points / all points. This counts the side-by-side asides
(which shrink the map) the same as overlays (which sit on it): both take map area away. Limit:
elements with `pointer-events: none` are invisible to the hit test (none in the default Plan state).
Script: `shots.mjs` (kept in the L0 notes, `/tmp/hl-design/notes/L0-shots.mjs`).

Targets (spec §2): ≤ 25 % at 1440 × 900, ≤ 35 % at 1024 × 768.

| Mode | Build | Size | Map visible | **Covered** | Main covering parts (% of work area) | Screenshot |
|---|---|---|---|---|---|---|
| plan | live, API reachable | 1440x900 | 24.8 % | **75.2 %** | console aside(s) 40.5, rail 22.2, dock 11, map ctrls TR 0.9 | [png](layout-declutter/live-plan-1440x900.png) |
| plan | live, API reachable | 1024x768 | 22 % | **78 %** | console aside(s) 57.6, dock 12.6, rail 5.5, map ctrls TR 1.5 | [png](layout-declutter/live-plan-1024x768.png) |
| plan | live, API unreachable | 1440x900 | 23.7 % | **76.3 %** | console aside(s) 38.8, rail 21.4, dock 11, offline banner 3.8 | [png](layout-declutter/livedown-plan-1440x900.png) |
| plan | live, API unreachable | 1024x768 | 20.6 % | **79.4 %** | console aside(s) 54.6, dock 12.6, rail 5.2, offline banner 4.4 | [png](layout-declutter/livedown-plan-1024x768.png) |
| plan | static | 1440x900 | 44.9 % | **55.1 %** | rail 22.2, console aside(s) 20.5, dock 11, map ctrls TR 0.9 | [png](layout-declutter/static-plan-1440x900.png) |
| plan | static | 1024x768 | 50.4 % | **49.6 %** | console aside(s) 29.1, dock 12.6, rail 5.5, map ctrls TR 1.5 | [png](layout-declutter/static-plan-1024x768.png) |
| fly | live, API reachable | 1440x900 | 51.1 % | **48.9 %** | rail 22.2, HUD controls + panel 15.9, dock 11 | [png](layout-declutter/live-fly-1440x900.png) |
| fly | live, API reachable | 1024x768 | 56.3 % | **43.7 %** | HUD controls + panel 25.8, dock 12.6, rail 5.5 | [png](layout-declutter/live-fly-1024x768.png) |
| fly | live, API unreachable | 1440x900 | 48.2 % | **51.8 %** | rail 21.4, HUD controls + panel 15.9, dock 11, offline banner 3.8 | [png](layout-declutter/livedown-fly-1440x900.png) |
| fly | live, API unreachable | 1024x768 | 52.1 % | **47.9 %** | HUD controls + panel 25.7, dock 12.6, rail 5.2, offline banner 4.4 | [png](layout-declutter/livedown-fly-1024x768.png) |
| fly | static | 1440x900 | 51.1 % | **48.9 %** | rail 22.2, HUD controls + panel 15.9, dock 11 | [png](layout-declutter/static-fly-1440x900.png) |
| fly | static | 1024x768 | 56.3 % | **43.7 %** | HUD controls + panel 25.8, dock 12.6, rail 5.5 | [png](layout-declutter/static-fly-1024x768.png) |
| report | live, API reachable | 1440x900 | 0 % | **100 %** | document page 77.8, rail 22.2 | [png](layout-declutter/live-report-1440x900.png) |
| report | live, API reachable | 1024x768 | 0 % | **100 %** | document page 94.5, rail 5.5 | [png](layout-declutter/live-report-1024x768.png) |
| report | static | 1440x900 | 0 % | **100 %** | document page 77.8, rail 22.2 | [png](layout-declutter/static-report-1440x900.png) |
| report | static | 1024x768 | 0 % | **100 %** | document page 94.5, rail 5.5 | [png](layout-declutter/static-report-1024x768.png) |
| evidence | live, API reachable | 1440x900 | 0 % | **100 %** | document page 77.8, rail 22.2 | [png](layout-declutter/live-evidence-1440x900.png) |
| evidence | live, API reachable | 1024x768 | 0 % | **100 %** | document page 94.5, rail 5.5 | [png](layout-declutter/live-evidence-1024x768.png) |
| evidence | static | 1440x900 | 0 % | **100 %** | document page 77.8, rail 22.2 | [png](layout-declutter/static-evidence-1440x900.png) |
| evidence | static | 1024x768 | 0 % | **100 %** | document page 94.5, rail 5.5 | [png](layout-declutter/static-evidence-1024x768.png) |

**Reading.**

- **Primary layout (live Plan) is three times over budget: 75–76 % covered at 1440 × 900 (target
  ≤ 25 %) and 78–79 % at 1024 × 768 (target ≤ 35 %).** The two 340 px asides (console + live
  crew/pad tool) take 39–58 % of the work area; on a 1024 screen the map keeps a 288 px column.
- **API unreachable: the live aside stays as an empty 340 px column** (screenshot
  `livedown-plan-1440x900.png`, right of the console aside): `views/console.tsx : view` creates it
  before `/health` answers and never removes it; only its content hides. Kit rule 4 hides the controls but
  not their space. L3 fixes this by construction (MarkerCard / Drawer render nothing while offline);
  it is also an L6 defect candidate. The offline banner adds 3.8–4.4 % (a full-width line; fine).
- Rail: 22 % at 1440 (320 px open by default on desktop); 5.5 % at 1024 (56 px icon column).
- Timeline dock: 11–12.6 % (120 px open by default).
- MapLibre control corners: ≤ 2.4 % together; not the problem.
- Static Plan: 55 % / 50 %. Fly (HUD): 44–49 % (rail, HUD bars, dock), 48–52 % with the API down.
  Report and Evidence are documents (no map): 100 % by definition; the coverage test applies to
  Plan and Fly only.

**Projection after L2 + L3** (spec §4 default state: rail icon column 56, slim scrubber ≈ 40 px,
headline strip in the top bar, asides gone, all containers closed): at 1440 × 900 covered ≈
(56 × 852 + 1384 × 40) / (1440 × 852) ≈ 8 %; at 1024 × 768 ≈ (56 × 720 + 968 × 40) / (1024 × 720)
≈ 11 %, plus ≤ 3 % map controls and the "Edit route" button. Both well inside the targets; the
offline banner (≈ 4 %) keeps the API-down case inside too.


## 3. Mount points L2 and L3 change

L2 (Plan mode, `web/src/ui/`, `web/src/map/` mount points, shell):

| File : function | Change |
|---|---|
| `web/src/ui/shell/Shell.tsx : mountShell` | mount the L1 layout host (Drawer, BottomDrawer, Popover layer) next to the existing islands; `data-*` attributes for the new open state |
| `web/src/ui/shell/Shell.tsx : TopBar` | headline strip into `#hl-topbar-plan` (or a strip over the map); "Details" toggle replaced by the Drawer opener |
| `web/src/ui/shell/Shell.tsx : Rail` | default collapsed in Plan/Fly; sections not rendered for Plan once moved |
| `web/src/ui/shell/Shell.tsx : Sidebar` | becomes the right Drawer (or hosts it) |
| `web/src/ui/shell/Shell.tsx : Dock` | becomes the BottomDrawer (tabs "Plan table", "Timeline"; collapsed = slim scrubber) |
| `web/src/ui/shell/store.ts : setDockContent / setSidebarContent / registerRailSection / railCollapsed / dockCollapsed` | keep the signatures (live code calls them); add tab/drawer targets |
| `web/src/ui/timeline/install.tsx : installTimelineDock` | render the slim scrubber when collapsed |
| `web/src/ui/cards/sidebar.tsx : installSelectionSidebar` | station selection → MarkerCard / Drawer, one at a time |
| `web/src/views/console.tsx : view` | stop the side-by-side aside: map full width; mount the console sections into their containers |
| `web/src/views/console.tsx : ConsolePanel` | split into headline strip / table tab / legend chip / layer-popover parts (render only; no number logic) |
| `web/src/views/console.tsx : view` (ConsoleMap station callback) | Q1: select only, no navigation |
| `web/src/map/overlays/index.ts : installOverlays` | layer manager into the Popover instead of `registerRailSection` |
| `web/src/map/consoleMap.ts : ConsoleMap` constructor / `initLayers` / `syncCollapse` | control placement (terrain, flythrough, storm, collapse toggle) into the map-edge toolbar / Popover |
| `web/src/map/furniture/index.ts : MapFurniture` constructor | readout chip placement |
| `web/src/edit/roverMap.ts : installRoverDrag → mountStrip` | delta strip into the rover MarkerCard instead of the sidebar (static flow; not in `edit/route/`) |

L3 (live mounts only; no logic in `web/src/live/` or `web/src/edit/route/`):

| File : function | Change |
|---|---|
| `web/src/views/console.tsx : view` (`liveAside()`, `m.padTool(...)`) | no second aside: hand `padTool` the MarkerCard slot (pad tool) and the Drawer slot (crew) |
| `web/src/live/index.ts : padTool` | pass the Drawer slot to `mountRoutePanel`; split pad tool / crew targets |
| `web/src/live/padmount.tsx : mountPadTool` | render `CrewPanel` and `PadToolPanel` into two targets (MarkerCard, Collapsible) instead of one `panel` |
| `web/src/live/route/mount.tsx : mountRoutePanel → section()` | register into the right Drawer (`register` seam already exists) instead of `registerRailSection` |
| `web/src/live/route/mount.tsx : routeDock` | `setDockContent` → BottomDrawer "Timeline" tab (signature kept) |
| `web/src/live/planview.tsx : PlanPage` / `web/src/ui/cards/cards.tsx : RouteSummaryCard` | SimSlot placement next to export in the Drawer (mount only) |
| new: "Edit route" button | in the L1 layout host (L2 file), shown only while `onLiveState` says ready |

**Overlap with the waypoint PR #130** (WP6, branch `wp6-map-waypoints`): it edits
`web/src/live/route/mount.tsx` and `web/src/edit/route/panel.tsx` (plus `controller.ts`, `model.ts`,
`text.ts` and the new `edit/route/map/`). L3's change to `mountRoutePanel → section()` and anything
that touches `RoutePanel`'s props collide with it: **#130 merges first, L3 rebases** (spec §7). L3 must
not change `edit/route/panel.tsx` at all; the Collapsible for the crew goes into the Drawer host, not
into `RoutePanel`. Write the container API and these mount points into `/tmp/hl-way/interfaces.md`
before L3 starts.

## 4. Questions for the team lead

Each has a default the packages use until the team lead answers.

- **Q1 Station click leaves the map.** A click on a station marker selects it *and* navigates to the
  full page `#/station/:id` (`views/console.tsx : view`, ConsoleMap callback). Default: click selects
  only (card); the full page stays one click away ("Open station") and on the palette.
- **Q2 Trade view and scenario controls.** The Trade table (`#/trade`) is a Plan rail view that
  replaces the map; scenario (variant, suit mass) and budget sit in the console aside. Default: Trade
  moves to Report mode; scenario and budget become two compact chips in the headline strip (Popover).
- **Q3 Two layer managers.** The console aside has its own "Layers" checkbox list (LayerGroup:
  bands, edges, route, partner, siting, …) besides the U7 LayerPanel in the rail. Default: one layer
  Popover with the console groups as its first group; no toggle removed.
- **Q4 Collapse headline overlay vs headline strip.** The collapse overlay shows the same headline
  number on the map. Default: keep the overlay while the collapse plays; the strip is the resting place.
- **Q5 "Details" button.** With the sidebar replaced by the right Drawer, the top-bar "Details"
  toggle has no own content. Default: it stays as the opener of the last card/drawer (keyboard path).
- **Q6 My plans placement.** R7 shows My plans on the `#/plan` pages only. Default: also a section
  in the Edit-route Drawer (same view, mount only); the pages stay for permalinks.
- **Q7 Fly mode has two scrubbers.** The HUD controls bar has its own scrubber and the timeline dock
  sits under it. Default: in Fly the dock stays collapsed to the slim scrubber (L4).
- **Q8 Empty live aside with the API down (confirmed, §2).** The 340 px live aside stays as an
  empty column while `/health` is not ready. Default for L3: the rover MarkerCard and the crew
  Collapsible render nothing while offline, the "Edit route" button hides; passed to L6 as a defect.

> Exported from Notion on 2026-11-14 (design bootstrap D1). Notion is the source of truth; this copy may lag.

# 🎨 HOMELINE design block — specification and implementation plan

> 🎨 **What this is.** The full specification of HOMELINE's design block: the visual system, the interface structure, every interaction and visual feature, how each one is built, the data the pipeline must export for it, the workstreams that build it, gates, tests and risks. It is written in the same form as the project specification so it can be cut into tickets and agent briefs. It expands [UI refinement — design and engineering proposal (after app + backend)](https://app.notion.com/p/418961bcb61181459447d9ae40a439b4), which keeps the reasoning (diagnosis, the two outside reviews, take/adapt/reject tables).
>
> **Status: decided (D49, Sat 19:40): at least Tier A, probably everything.** The team lead reviews graphics. Still to settle at V0: palette, four modes, icon set (§12).
>
> **Assumption.** The static app (F1–F20, as built by 17:47: official pad, headline 23.0% (15.2–28.7), route pad → S7 → S6 → S1 → S4 → pad) and the backend's demo subset (D69: F23, F24, F26, F28 without share codes, F35, F36 locally) are finished and work. ✂️ Everything on this page that needs F25, F27 or F29–F34 is cut (D69) and marked so. The design block changes how they look and how they are operated. It changes **no validated number**.
>
> **Numbering.** Design features are **U0–U17**; design workstreams **WS15–WS18** plus the render-review lane **RR**; design gates **V0–V3**. These never collide with features (F), decisions (D), core gates (G) or backend gates (B).

> ⚠️ **Guardrails that hold for every item on this page.** (1) Validated values (headline, bands, scorecard, V1, V2, RAD checks) are restyled only; the manifest and parity tests stay green through every merge. (2) Real, modelled, simulated, live and visual content stay visibly distinct (trust chips, §3.6). (3) Unknown terrain is grey hatch, never a warning colour. (4) No NASA insignia, logotype or agency look-alike graphics. (5) Fonts, icons and models are open-licensed, self-hosted and listed on `/about`; no AI-generated imagery. (6) Everything works with the backend off, except features that are live by nature. (7) The video stays two beats. (8) Feature freeze Sun 12:00; no code deploy after Sun 23:59.

> **One sentence for the design:** "Make the homeline the spectacle: a living safety field on a 3D Mars you can touch, that shrinks as oxygen, daylight and dose run down."

# 1. Proposal

## 1.1 Problem

- **The interface grew view by view.** Ten agent sessions built the console, cards, trade table, conditions, scorecard, HUD, 3D view, navigation and live tools, each with its own styling. The result works and is consistent in data, but not in look or behaviour.
- **The strongest idea is drawn as static polygons.** The homeline is the product, yet it appears as filled GeoJSON with a slider. Nothing on screen shows that it is a live safety margin.
- **The map is flat while the argument is "Mars isn't flat".** Relief is visible only in the separate first-person view.
- **Time is hidden.** The EVA timeline is a table and a HUD countdown.
- **The map is not the interface.** Information sits in panels and lists; the map shows results but is not where the user asks questions.
- **The honesty work is invisible.** Provenance, ranges and the real/modelled/simulated split are behind links and on the scorecard.

(Diagnosis from the spec and build logs. D checks it against the real screens at V0; the render-review lane produces a baseline report first, §7.5.)

## 1.2 Who looks at it

| Audience | What they need from the design |
| --- | --- |
| Judges (Local, then expert, then NASA executives) | Understand the idea in 10 seconds; believe it in 60; find the evidence without searching |
| Intravehicular crewmember (primary user in the spec) | Read margins and turn-back times at a glance; plan and replan by touching the map |
| NASA suit and architecture teams (users today) | Compare scenarios; see what sets each edge; trust the numbers |
| The team at a live demo or stand | A loop that runs by itself (kiosk) and one that a visitor can grab (drag the rover) |
| Video capture | Deterministic, high-quality shots for the two beats |

## 1.3 The design in one paragraph

HOMELINE becomes one application with four modes (Plan, Fly, Report, Evidence) in a single dark, quiet shell after the VISCON reference: green-charcoal panels, one yellow selection colour, and safety colours that mean the same thing everywhere. The planning map tilts into 3D relief built from the same elevation data. The homeline is drawn by a small GPU program that evaluates the planner's own margin for every pixel, so it shrinks live as the mission clock runs or a budget changes, and can melt from NASA's flat circle into the true shape. A thin thread always runs from the crew to the rover along the best way home. The map is the interface: hover anywhere to see time home, click a station, ridge or mineral patch to get its card, drag the rover or a science target and watch the cost of getting home change, undo anything. A mission timeline at the bottom scrubs every view at once. A flythrough and a short descent intro make the first ten seconds memorable, and every number carries a small chip that says whether it is real, modelled, simulated, live or only visual.

## 1.4 Why it helps win

| Criterion (weight) | Design contribution |
| --- | --- |
| Presentation (20%), the weakest score in the simulated panel (6.9) | One coherent look; the collapse and the living homeline as hero moments; a clean two-beat video; a kiosk loop |
| Creativity (20%) | Touchable safety field and thread home: no surveyed repo shows a live return-feasibility field |
| Validity (20%) | Trust chips and the Evidence mode put the honesty work in front of the judges; nothing unmodelled is drawn as data |
| Relevance (25%) | The interaction answers the brief's question directly: where can the crew go and still get home |
| Impact (15%) | Planners can explore their own scenarios in seconds |

# 2. Features

Tiers: **A** changes how the app feels and is the target for this event; **B** adds time, motion and depth; **C** finishes. Effort in agent hours, estimated like the backend plan; a UI factor of 1.1–1.2 is already included (render review in place, §7.5).

## 2.1 Feature list

| ID | Feature | Tier | WS | Output artefact | Effort |
| --- | --- | --- | --- | --- | --- |
| U0 | Design system: tokens, type, components, shell with four modes, migration of every view | A | WS15 | `web/src/ui/`, `/styleguide` | 6–8 |
| U1 | 3D terrain in the planning map: elevation tiles, relief shading, tilt, exaggeration, sun-driven light | A | WS16 | `web/public/data/terrain/`, map style | 4–5 |
| U2 | Living homeline: GPU field layer (bands mode, margin mode) | A | WS16 | `web/src/map/field/` | 6–8 |
| U3 | The collapse animation and headline count | A | WS16 | `web/src/map/field/collapse.ts` | 1–2 |
| U4 | Thread home, route draw-on, markers, compass, cursor readout | A | WS16 | `web/src/map/thread.ts`, markers | 2–3 |
| U5 | Mission timeline dock, elevation profile, gauges | B | WS15 | `web/src/ui/timeline/` | 5–7 |
| U6 | Flythrough, director mode (storyboards), descent intro, kiosk loop, capture mode | B | WS16 | `web/src/story/`, `web/public/story/*.json` | 4–6 |
| U7 | Layer manager and science overlays | B | WS16 | `web/src/map/layers/`, overlay tiles | 4–6 |
| U8 | 3D scene upgrade: chase camera, crew pair, shadows, thread (✂️ terrain for any plan cut, D69) | B | WS17 | `web/src/fp3d/` additions | 5–7 |
| U9 | Storm mode and trust-mark polish | B | WS16 | storm visuals, chip popover | 2–3 |
| U10 | Mission report (screen and print) | C | WS15 | `/report` view, print CSS | 3–4 |
| U11 | Onboarding, staged-job stepper, empty, loading, error and offline states, wording pass | C | WS15 | components, copy file | 3 |
| U12 | Quality: visual regression, accessibility, performance budgets, tablet layout | A (tests) → C | All + G | CI jobs, reports | 4–5 |
| U13 | Geographic label system | A | WS16 | `labels.json`, symbol layers | 3–4 |
| U14 | Selection model and contextual sidebar | A | WS15 | `web/src/state/selection.ts`, cards | 4–6 |
| U15 | Direct manipulation: drag the rover, undo/redo (✂️ science points, ghost route, reorder cut, D69) | A (rover, undo) → B | WS18 | `web/src/edit/` | 6–9 |
| U16 | Camera presets, focus transitions, bookmarks, isolation, focus mode, minimap, history | B | WS16 | `web/src/map/camera.ts` | 3–4 |
| U17 | Search and command palette | B | WS15 | `web/src/ui/search/` | 2–3 |

**Totals.** Tier A ≈ 32–45 h; Tier B ≈ 25–36 h; Tier C ≈ 10–12 h; all ≈ 67–93 h. For comparison, the core build (WS1–WS8) was planned at ≈ 77 h.

**Shortlist** (if only a few hours are free): U0 colour tokens only + U2 + U3 + U4 + U13 ≈ 13–18 h of agent work, about 2–3 h of wall clock with parallel sessions. It touches no validated number and needs no migration.

**Not building:** dust storms, wind or temperature as hazards (nothing models them); battery or power gauges (no power model); region switching (one site); a React, chart or animation library; glassmorphism, neon, scan lines or fake data chatter; any NASA-styled branding; AI-generated imagery.

## 2.2 Feature specifications

### U0 — Design system and shell

**Purpose.** One look and one structure for every view, so later features land in a coherent frame.

**What the user sees.**

- A top bar with the wordmark, the four mode tabs (Plan · Fly · Report · Evidence), the current plan's identity and status chip, Share, and the Live indicator.
- A left rail (plan summary, crew and budgets, stations and route, layers), the map in the centre, a right sidebar that follows the selection (U14), and a timeline dock across the bottom (U5).
- Every panel, number, chart and control in the same tokens and components.

**Implementation.**

1. Tokens as CSS custom properties in `web/src/ui/tokens.css`, also exported as `tokens.json` for the map style, the field shader and the 3D scene (one source of colour).
2. Components in `web/src/ui/` as plain TypeScript with Preact islands where state is needed (§3.7 lists them with states).
3. A `/styleguide` route rendering every component in every state on both light-on-dark densities; it is also the visual regression target.
4. Shell in `web/src/ui/shell/`; existing routes map into modes (§4.2) and keep their URLs.
5. Migration order: console → HUD panel → station card → live tools (WS13) → conditions → trade → scorecard → about. Each migrated view keeps a revert switch (`?legacy=view`) until V2.
6. A lint rule rejects colour and font-size literals outside `tokens.css`.

**Acceptance.** All existing tests pass; every manifest-backed number is unchanged (snapshot of rendered values before and after); no literal colours outside tokens; contrast checks pass (§9); `/styleguide` matches its approved screenshots.

**Rule.** U0 is finished or reverted, never half-shipped: a partly migrated interface looks worse than today's.

### U1 — 3D terrain in the planning map

**Purpose.** Show that Mars isn't flat in the place where planning happens.

**What the user sees.** The planning map can be tilted and rotated. The HiRISE basemap, homeline, routes, stations and labels lie on real relief. Relief shading follows the sun at the plan's time. A slider sets exaggeration (1× to 3×) and always shows the factor. A 2D/3D toggle and "reset north" sit in the map controls.

**Implementation.**

1. **Engine:** the map library's built-in terrain (a raster elevation source plus the style's terrain setting). Existing layers drape automatically, so no second renderer is needed in Plan mode. A separate elevation source feeds the relief-shading layer, as the library's examples recommend.
2. **Mars scale factor.** Mars longitude and latitude are passed into an Earth-sized projection (D4), so horizontal distances on screen are stretched by Earth radius / Mars radius = 6,378.137 / 3,396.19 = **1.878**. Elevations are multiplied by the same factor when the tiles are written, so 1× on screen is true shape. The factor is recorded in the tile metadata and the manifest. Elevation readouts never come from these tiles; they come from the fields (true metres).
3. **Tiles** (new pipeline export, §6.1): 256 px PNG, Terrarium encoding, z10–15 over the planning extent, z16 over the focus area only; budget ≤ 25 MB.
4. **Light:** relief-shading direction = sun azimuth from the Mars clock at the plan's start; during playback it follows the clock (updated at most once per simulated minute).
5. **Controls:** drag to pan, right-drag or two-finger to tilt and rotate; keys in §4.4.
6. **Fallback:** without WebGL2, or below 30 fps for 3 s in 3D, the map returns to flat with relief shading and shows a one-line notice.

**Acceptance.** A reference ridge has the same height-to-width ratio on screen at 1× as in the 1 m model (±5%); all layers stay registered to the ground at every tilt; ≥ 30 fps on the integrated-GPU laptop at 60° tilt; cursor elevation equals the field value.

### U2 — Living homeline (GPU field layer)

**Purpose.** Turn the homeline from a polygon into a live safety field that answers "can both of us still get home?" for every point, at the current moment.

**What the user sees.**

- **Bands mode (default in Plan):** the validated 30/60-minute homeline with its optimistic, nominal and conservative variants, drawn crisply with smooth edges and the grey hatch on unknown cells. Same shape as the precomputed polygons.
- **Margin mode (default in Fly and when the clock runs):** a continuous field, green where the margin is comfortable, orange under 10 minutes, red below zero, with a crisp line where the margin crosses zero and a label naming the limit that binds there (O₂, daylight, dose or EVA duration). As the clock runs, the green area visibly contracts toward the rover. Moving a budget slider redraws it instantly.

**Margin per pixel** (the planner's own rule, SPEC F4 with D24 and D28; the O₂ term converted to minutes at the effort-cap rate, the same convention as the WS2 margin code, which the implementation imports or mirrors and tests against):

$$
m(x)=\min\Big(\tfrac{O_{2,left}-reserve-O_{2,home}(x)}{1.35\ \mathrm{L/min}},\; t_{dark}-t-T_{home}(x),\; \tau_{dose}-T_{home}(x),\; T_{EVA}-t-T_{home}(x)\Big)
$$

**Implementation.**

1. **Inputs.** Field PNGs that already exist (§6.1 of the spec, encoding `value = R·256 + G`, A = 0 unknown): `t_home` for the three variants of the current suit mass, `o2_home` nominal, and the cell-state grid. Live plans (F23) provide the same files.
2. **Decoding.** Textures use nearest sampling (linear filtering would mix the encoded bytes). The shader fetches the four neighbours, decodes each, and interpolates bilinearly; if any neighbour is unknown the pixel is unknown. Edges are therefore smooth and never blocky.
3. **Uniforms** (scalars from the mission state, §5.2): `u_t`, `u_o2Left`, `u_reserve`, `u_tDark`, `u_tauDose` (very large when no storm), `u_tEva`, `u_budget` (30 or 60), `u_variant`, `u_mode`, `u_k` (collapse, U3), `u_pad` (grid metres), field scales from `fields/index.json`. Thresholds from `config/hud.yaml` (`margin_amber_min` = 10).
4. **Colouring.** Tokens `safe`, `caution`, `limit` with 35–55% opacity; the zero-margin edge drawn with screen-space derivatives for a constant 1.5 px line; unknown cells get a diagonal hatch in screen space.
5. **Daylight term.** `t_dark` is the pad-level value from `sun.json`; per-cell horizon shading is not modelled in the shader, and the legend says so. Station cards keep their station-level daylight.
6. **Rendering path.** An off-screen WebGL2 canvas at field resolution is handed to the map as a canvas source with the four corner coordinates of the field grid, so it drapes on the 3D terrain. The canvas re-renders only when an input changes; during playback at most 30 times per second; above 1,024 px per side it renders at half resolution while the clock runs and at full resolution when paused.
7. **Early spike (first hour of WS16):** measure the per-frame cost of updating the canvas source on the integrated-GPU laptop. If it misses 30 fps, switch to a custom map layer that draws into the map's own context (flat map only) and keep the canvas path for 3D at a lower update rate.
8. **Fallback.** Without WebGL2 the existing polygons are drawn (they also remain the export format and the print source).

**Acceptance.** At every station and every 5 min along the route, the shader's margin equals `timeline_*.json` within 0.5 min; with the inputs of the precomputed bands, the shader's 30-minute edge lies within one field cell (5 m) of the contour; identical picture in 2D and 3D; 60 fps in 2D while scrubbing on the reference laptop; unknown cells are never coloured.

### U3 — The collapse

**Purpose.** The video's first beat as a live animation: NASA's flat circle becomes the real homeline.

**What the user sees.** A dashed circle of the flat 30-minute walk around the rover. Over three seconds it melts into the true homeline; hatched unknown cells fade in at the end; the headline counts up to its value with its range ("23.0% (15.2–28.7)" as of 17:47, always read from the manifest).

**Implementation.** One value `u_k` from 0 to 1 in the field shader: the threshold field is `mix(d(x) / 0.98 m/s / 60, T_home(x), k)`, where `d(x)` is the distance from the pad in grid metres (D25 flat speed). Ease in-out over 3 s. Triggers: the intro (U6), a "Flat vs real" toggle in Plan, and the capture storyboard. With reduced motion: a cross-fade between the two states.

**Acceptance.** At k = 0 the edge is a circle of 1,764 m radius within one cell; at k = 1 it equals the U2 band; the counted value equals the manifest value.

### U4 — Thread home, route, markers, map furniture

**Purpose.** Make "the way home" visible from any point at any time.

**What the user sees.**

- **Thread home:** a thin bright line from the current point (cursor, dragged marker, crew position in playback; ✂️ live session position cut, D69) to the rover, along the best way back. Its colour is the margin at its start; a slow dash flow runs toward the rover. Its tooltip: "Home in 18 min · margin 41 min (dose)".
- **Route:** draws itself along its length when a plan loads (1.5 s). Done legs solid, coming legs at 50% opacity; turn-back points as short ticks across the route.
- **Markers:** rover pad; stations with a ring whose thickness encodes science value and whose fill encodes state (on route, reachable, not reachable on foot); scored sites; user science points; tripwire point during storm mode. Only the next station on the route pulses once every 3 s.
- **Furniture:** compass with north arrow and sun direction; the Mars scale bar (exists); a cursor readout (longitude, latitude, elevation, slope, time home) in monospace.

**Implementation.** The thread uses the pointer follower that already exists in TypeScript (WS7) over the pointer field; cursor updates are throttled to 30 Hz; the result is a GeoJSON line source. Dash flow by stepping through a short sequence of dash patterns per frame (the library has no dash-offset animation). Markers are symbol layers with icons from the icon set (§3.5).

**Acceptance.** The thread's time equals `T_home` at its start within 0.5 min; it never crosses a blocked or unknown cell; the cursor readout equals the field values at that cell.

### U5 — Mission timeline, elevation profile, gauges

**Purpose.** Make time a first-class dimension and synchronise every view to one moment.

**What the user sees.** A dock across the bottom (120 px, collapsible to 40 px):

- An EVA time axis (0 to EVA length) with station dwells as blocks, turn-back markers, the daylight end, the storm window and tripwire, and O₂ checkpoints every 30 min.
- A margin curve over time, filled by the binding limit (O₂, daylight, dose, EVA duration) in the limit's colour.
- A scrubber; dragging it moves the crew marker, the living homeline, the HUD, the 3D camera and the thread together. Play, pause and speed (1×, 30×, 60×, 300×).
- Above the axis (expandable): the elevation profile of the route, coloured by slope class, with the same cursor.
- In the right sidebar during playback: gauges. O₂ as one bar split into used / needed to get home / reserve / spare; time home nominal and conservative; dose budget left; daylight left; metabolic rate against the 1,200 BTU/h design average.

**Implementation.** SVG built from the chart primitives in U0; data from `timeline_*.json`, the route samples and the fields; time is owned by the mission state (§5.2).

**Acceptance.** Every plotted value is from the timeline, the route or the manifest; the scrubber time and the HUD clock never differ; keyboard scrubbing works (§4.4).

### U6 — Flythrough, director mode, descent intro, kiosk, capture

**Purpose.** A memorable first ten seconds, a stand loop, and deterministic video shots.

**What the user sees.**

- **Flythrough** (button in Plan and Fly): the camera follows the route in 3D from behind and above, looking ahead, with speed control; the timeline scrubs it.
- **Descent intro** (first visit, about 20 s, skippable with any key or click): Gale crater from high above → Mount Sharp's flank → the boxwork and the rover → the collapse (U3) → controls fade in. Captions: "Gale crater · Mars", "NASA is considering a 30-minute walkback", "Mars isn't flat".
- **Kiosk loop** (`?demo=1`): intro, flythrough, storm replay, drag-the-rover demonstration, repeat; any input exits.
- **Capture mode** (`?capture=storyboard-id`): fixed 1920 × 1080, fixed frame step, no UI chrome unless the storyboard asks for it.

**Implementation.**

1. Storyboards as JSON (`web/public/story/*.json`, schema in §6.3): timed steps of camera keyframes, layer changes, clock positions, field mode and collapse value, captions.
2. Flythrough camera: smoothed route (centripetal Catmull-Rom over 20 m samples), camera 250 m behind and 120 m above the look-at point at 1× (scaled with exaggeration), look-ahead 150 m; the library computes the camera from a camera point and a look-at point.
   *Note (T1, 2026-11-15):* `config/design.yaml` `camera.flythrough.above_m` is now 175 m (pitch 55°, was 120 m ≈ 64°), because MapLibre 6.18 selects zero tiles above about 60° pitch at this zoom; the 3D tilt cap is `terrain_3d.max_pitch_deg: 60`.
3. Descent: low-zoom relief from the far-field elevation (CTX 20 m, MOLA–HRSC 200 m) exported as z6–10 tiles over Gale (§6.1).
4. Intro shown once per browser (stored setting, wrapped so it never fails), never under reduced motion.

**Acceptance.** Two capture runs of one storyboard give identical frames; any input cancels a camera move within one frame; the intro never blocks interaction for more than its skip delay (0 s).

### U7 — Layer manager and science overlays

**Purpose.** Show why the homeline has its shape, with layers that are already computed.

| Layer | Group | Source (exists) | Chip | Legend |
| --- | --- | --- | --- | --- |
| Relief shading | Terrain | Elevation tiles (U1) | Real | Sun direction |
| Contours, 10 m and 50 m index | Terrain | 1 m model, exported as vector lines | Real | Labels on index lines |
| Slope classes 0–10 / 10–17 / 17–20 / > 20° | Terrain | 3 m slope grid (D22) | Modelled | Four steps; > 20° in `limit` |
| Rough footing | Terrain | Max 1 m slope grid (D22 overlay) | Modelled | One colour |
| Ridges (boxwork) | Science | Ridge index | Modelled | Ridge outline |
| Mineral hint: sulfate, clay | Science | CRISM SINDEX2, D2300 at 18 m | Real (coarse) | "Orbital hint, not an identification" |
| Data quality | Evidence | Cell states, source mask | Real | Assessed / blocked / unknown |
| Siting heatmap | Planning | F8 / D21 output | Modelled | Score scale |
| Partner line | Planning | F10 (cart, D20) | Modelled | Dashed |
| Rover parking options | Planning | D21 picker | Modelled | Pad markers |
| Homeline edge causes | Planning | F4 edges | Modelled | Physiology / slope / data |

**Panel.** Groups, a toggle and opacity per layer, an always-correct legend, the chip, and a one-line "what am I looking at". At most two thematic overlays at once; turning on a third turns off the oldest, with a notice.

**Acceptance.** Every legend range equals its manifest range; with every overlay on, the homeline edge stays visible.

### U8 — 3D scene upgrade (Fly mode)

**Purpose.** Make the existing first-person view (F20) a place to watch the EVA, not only to check the horizon.

**What the user sees.** Three cameras: first-person (exists), chase (behind and above the crew), overhead. Two simple stylised suited figures walking the route, a ground ring under each in the margin colour, the thread home in the scene, real-time sun shadows from the terrain and the figures, the HUD (redesigned with U0). Labelled "Simulated EVA · real terrain and data"; figures, sky and haze carry the Visual chip.

**Implementation.** The existing Three.js scene (WS8); figures built from simple shapes in code with a procedural walk cycle (no external model, no markings); shadow map from the sun direction (Mars clock); the shipped chunks of the official route (✂️ world tiles for any plan cut, D69); the shared mission state drives the clock.

**Acceptance.** Existing F20 checks still pass (eye height 1.7 ± 0.1 m, skyline within 0.5°); ≥ 30 fps on the integrated-GPU laptop with shadows on (shadows switch off automatically below that); the automatic 2D fallback is unchanged.

### U9 — Storm mode and trust marks

**Purpose.** Give the one real environmental hazard its proper weight, and make honesty visible.

**Storm mode** (when the storm replay is on): the timeline shows the dose-rate curve and the tripwire; at the tripwire the alarm banner states the leash ("Radiation: head home within 86 min"); a dose ring (where home is still reachable within the dose budget) tightens on the map; the thread turns red once time home exceeds the leash; in 3D a faint sensor speckle (Visual chip). The note "hypothetical timing" (D39) is always shown with it.

**Trust marks**: the chip and one provenance popover for every number and layer group (§3.6).

**Acceptance.** Tripwire time and leash values equal `conditions/rad.json`; no storm visual without the timing note; every displayed number has a chip.

### U10 — Mission report

**What the user sees.** One page per plan (Report mode), also printable on A4:

1. Verdict line: "Feasible · tightest margin 41 min at S7 · bound by dose" (values from the plan).
2. Map snapshot with the homeline, route and stations.
3. Timeline and elevation profile.
4. O₂ budget bar and a per-leg table (distance, climb, time, O₂, lowest margin, binding limit).
5. Stations with objectives, tasks, dwell, arrival and turn-back.
6. Partner-line status, assumptions in force, run record and a QR code for the permalink (✂️ share code cut, D69).

**Implementation.** Reuses the cuff-card print path; map snapshot from the map canvas at print time.

### U11 — Onboarding, states, wording

- **Coach marks** after the intro: three steps (budget slider; click a station; "plan your own" when Live is up). Dismissed forever with one click.
- **Staged-job stepper** for live plans: Nominal band → Variants → HUD fields → Partner line → Horizon, each ticking as its stage arrives (F24 stages).
- **States**: designed empty, loading (skeletons, never spinners on the map), error (what happened, what still works), offline ("Live planning is offline · showing precomputed plans").
- **Wording**: one glossary (§3.8) applied everywhere.

### U12 — Quality

Visual regression, accessibility, performance and tablet layout; details in §9 (tests) and §5.4 (budgets). Visual regression starts with U0 (Tier A); the rest is Tier C.

### U13 — Geographic label system

**Identifiers** (short uppercase codes):

| Object | Code | Expanded label |
| --- | --- | --- |
| Official pad / alternatives | `PAD` / `P2`–`P4` | "Rover pad · 38 feasible EVAs" |
| Stations | `S1`, `S2`, `S4` | Station name |
| Scored sites | `S6`–`S8` | "Scored site A: sulfate signal" |
| User science points | `U1`–`U3` | User title, "user station · no science scoring" |
| Landmarks (from `config/landmarks.yaml`) | `MSH` Aeolis Mons (Mount Sharp), `GDV` Gediz Vallis, `RIM` Gale crater rim, `PCV` Peace Vallis, `APL` Aeolis Palus, `BOX` Boxwork unit (informal), `VRR` Vera Rubin Ridge (informal), `GRP` Greenheugh Pediment (informal) | Name, "official" or "informal", bearing and distance from the pad |

Only landmarks with verified coordinates appear (D33 rule).

**Look.** Yellow (`select`) monospace 11 px uppercase on a dark pill (black at 70%, 4 px radius, 4 × 2 px padding). On hover the pill expands to the full name plus distance, time home and chip. Selected labels have a 1 px yellow outline.

**Placement.**

1. Symbol layers with collision detection, a sort key for priority (selected → pad → route stations in order → other stations and sites → landmarks → overlay labels), variable anchors and padding.
2. The pill is a stretchable icon fitted to the text.
3. The selected object is drawn in its own layer that ignores collisions, so it never disappears.
4. Zoom ranges: landmarks from the widest zoom; stations from mid zoom; overlay labels only when zoomed in. Marker size steps with zoom.
5. Leader lines: when the view is tilted more than 30°, labels float above their point with a thin vertical line to the ground.
6. Off-screen and hidden landmarks: in 3D, a bearing tick on the compass edge, "below skyline" where the horizon hides them (D33).

**Data.** `labels.json` (§6.2) from the pipeline: code, name, kind, official/informal, position, priority, zoom range.

**Acceptance.** No overlapping labels at any zoom on the six key screens; route stations never hidden by landmarks; readable at 1× and 3× exaggeration and at every bearing.

### U14 — Selection model and contextual sidebar

**Purpose.** Make the map the interface: everything visible can be selected, and the sidebar answers questions about it.

**Selection store** (§5.2): selected object, hovered object, history of the last 10 selections.

**Selectable objects, highlight and card**:

| Object | Highlight | Card content | Actions |
| --- | --- | --- | --- |
| Rover pad | Yellow ring; its homeline at full strength | Feasible EVAs, reachable % with range, elevation, slope, chip | Move (U15), compare with alternatives |
| Station or scored site | Yellow ring; its legs; its access cell and offset | Objective, tasks, dwell, arrival and turn-back, time home, binding limit; Navcam photo with skyline and its error | Open in 3D, focus (✂️ add/remove from route and dwell cut, D69) |
| Route leg | Leg glows; others dim | Distance, climb, descent, time, O₂, lowest margin and its limit, slope profile | ✂️ — (insert a point cut, D69) |
| Any terrain cell | Yellow crosshair; thread home | Time home nominal and conservative, O₂ home, margin now, slope, cell state and data source | Set as pad (live) (✂️ add as science target cut, D69) |
| Ridge | Outline of the ridge | Relief height, length, "boxwork ridge (ridge index)" | ✂️ — (add as science target cut, D69) |
| Mineral-hint patch | Outline of the patch | Hint type and strength, "orbital hint, not an identification", resolution note | ✂️ — (add as science target cut, D69) |
| Blocked or rough area | Red outline | Why blocked (slope class or step guard), area | — |
| Homeline edge segment | Segment glows | Cause (physiology, slope or data) and what would move it | Show the nearest way around |
| Landmark | Label expands | Name, official or informal, bearing and distance | Focus |
| Nothing selected | — | Route configuration: stations in order, totals, feasibility, budgets | Edit route |

**Card structure** (always the same): title row (code, name, chip) → key numbers (2–4 readouts) → details → actions. No permanent extra panels.

**Highlight geometry** comes from precomputed polygons (ridges, mineral patches, blocked areas) exported once (§6.1); nothing is traced in the browser. Picking uses the map's feature queries for objects and field lookups for cells.

**Acceptance.** Every card number is manifest- or field-backed; selecting the same object from the map, the list or search shows the same card; Escape clears; back/forward walk the history.

### U15 — Direct manipulation

**Purpose.** Let the user plan by touching the terrain, and see at once what a change costs in getting home.

**Rule: what may be shown while dragging.** Only values that are exact from data already in the browser (field lookups at the dragged cell). Everything else appears as a ghost and is computed on release. No estimated route length during a drag.

| Gesture | Live while dragging (exact) | On release | With the backend off |
| --- | --- | --- | --- |
| **Drag the rover** (flagship) | Spot validity from the cell-state and slope fields (assessed, max slope ≤ 5° over 20 × 20 m, flat 30-min disc inside the grid), elevation, slope. With the backend: feasible-EVA count and reachable stations from the preview endpoint (under 1 s, at most 2 requests per second) | Full plan job (F24); stages appear via the stepper (U11); the living homeline cross-fades to the new pad | Snaps between the precomputed parking options; their homelines cross-fade |
| ✂️ **Drop or drag a science point** (cut, D69) | Time home and margin at the point, slope, nearest access cell (within 50 m, D27) and the offset, thread home | Ghost route (dashed yellow) while the route job runs; then a delta strip: "+14 min EVA · +11 L O₂ · tightest margin 41 → 29 min (dose)" | Not available; the card says why |
| ✂️ **Insert on a leg** (cut, D69) | Same as a science point | Same | — |
| ✂️ **Reorder stations** (cut, D69) | Ghost order | Route with fixed order (F25); infeasible legs in red with the binding limit | Only between precomputed routes |
| **Change dwell or a budget** | Living homeline and timeline update at once | — | Yes |

**Commit and undo.** Release shows the ghost and the delta strip; Enter or "Keep" commits, Escape discards. Every commit is a step in the plan history: Ctrl+Z / Ctrl+Shift+Z and buttons; kept for the session (✂️ saving with plan versions cut, D69: no accounts).

**Implementation.** Plan-edit store (§5.2) with draft, ghost and undo stack; all planning calls through the live API client (WS13); field lookups through the shared field decoder.

**Acceptance.** The live time home during a drag equals the field at that cell; never more than 2 requests per second; undo restores the exact previous plan hash; static mode never shows an option that needs the server.

### U16 — Camera and navigation

| Item | Behaviour |
| --- | --- |
| Presets (keys 1–5) | 1 overhead (north up, 0° tilt); 2 isometric (45°); 3 low altitude (70°, near the ground); 4 focus on selection; 5 follow the crew in playback |
| Focus transition | Selecting an object eases the camera to frame it and its legs (1.2–2.5 s, cancelled by any input) |
| Bookmarks | Save the current view (camera, layers, selection) with a name; stored in this browser (✂️ saving with the plan cut, D69) |
| Isolation | "Show only this": everything except the selected route or object dims to 20% |
| Focus mode (F) | Hides all panels; Escape returns |
| Minimap | The HUD minimap reused in Plan, with the view footprint; click to jump |
| Selection history | Back and forward through the last 10 selections |

### U17 — Search and command palette

One box (Ctrl+K or /). Searches stations, sites, landmarks (code or name), coordinates (decimal degrees, or planner metres `x, y`), layers ("slope", "mineral") and commands ("flythrough", "storm", "2D", "3D", "report"). Results show code, name, chip and distance from the pad; Enter selects and focuses. Fully client-side (✂️ share-code search cut, D69).

# 3. Design system

## 3.1 Colour tokens

The basemap is greyscale orbital imagery, so colour is reserved for meaning. Palette after the VISCON reference.

| Token | Value | Use | Never used for |
| --- | --- | --- | --- |
| `bg` | `#0C1211` | App background | — |
| `sidebar` | `#111A19` | Rails and sidebar | — |
| `card` | `#202A27`, border `#2C3834` | Cards and panels | — |
| `text` / `text-muted` / `text-faint` | `#E6EDF3` / `#9AA7A3` / `#6B7773` | Text hierarchy | — |
| `shadow` / `light` | `#263348` / `#FFF4E0` | Relief-shading shadow and lit side | UI elements |
| `select` | `#F5D900` (yellow) | Selection, focus ring, geographic labels, crosshair, ghost route | Any state or warning |
| `safe` | `#3DD68C` (green) | Comfortable margin, nominal homeline, verified route | Decoration |
| `caution` | `#FB923C` (orange) | Margin under 10 min | Selection |
| `limit` | `#F43F5E` (red) | Margin below zero, alarms, blocked slope | Missing data |
| `science` | `#60A5FA` (blue) | Science targets, mineral hints, objectives | Safety |
| `live` | `#A78BFA` (purple) | "Computed live" marks and controls | Validated content |
| `unknown` | `#6B7280` hatch | No 1 m terrain | Anything else |

- Every state has a second cue: nominal line solid, conservative denser fill, optimistic dashed; alarms with an icon; unknown with a hatch.
- Overlays on the map at 35–55% opacity; text never on a coloured fill without a pill.
- No separate brand colour: the wordmark is in `text`.

## 3.2 Typography

| Role | Font | Size / line height | Weight |
| --- | --- | --- | --- |
| Display (one per screen) | Inter | 40 / 44 | 600 |
| Heading | Inter | 20 / 28 | 600 |
| Body | Inter | 14 / 20 | 400 |
| Small, labels | Inter | 12 / 16 | 500, letter-spacing 0.02em |
| Readout (numbers) | JetBrains Mono | 20 / 24 and 28 / 32 | 500, tabular figures |
| Map labels | JetBrains Mono | 11 / 14 | 600, uppercase |

Both fonts are open-licensed (SIL OFL) and self-hosted as WOFF2 subsets (Latin, digits, °, ₂, µ, ±, →). No font service request.

## 3.3 Spacing, shape, depth

- 4 px grid; component padding 8 / 12 / 16; panel gaps 8.
- Radius 8 px for cards, 4 px for pills and inputs, 999 px for chips.
- No drop shadows on the map; panels separated by their 1 px border. One elevation level for overlays (dialogs, palette) with a 24 px soft shadow at 40%.
- Z-order: map \< map overlays \< rails and sidebar \< timeline \< popovers \< palette and dialogs \< alarm banner \< toasts.

## 3.4 Motion

| Kind | Duration | Easing | Rule |
| --- | --- | --- | --- |
| Panel and mode change | 180–240 ms | ease-out | Fade + 8 px slide |
| Hover and press | 80–120 ms | linear | Colour and outline only |
| Data change (gauges, numbers) | 300–600 ms | ease-in-out | Values tween; numbers count |
| Field update | per frame | — | No tween; the shader re-thresholds |
| Camera move | 1.2–2.5 s | ease-in-out | Any input cancels at once |
| Collapse | 3 s | ease-in-out | Once per trigger |
| Intro | ≈ 20 s | — | Once per browser, skippable |

With reduced motion: camera moves become cuts, tweens are off, the collapse cross-fades, no pulsing markers, no intro.

## 3.5 Icons

One outline set at 1.5 px stroke, open licence (for example Lucide, ISC licence; confirm at V0), plus custom marks drawn for HOMELINE: rover pad, station, scored site, user point, turn-back, tripwire, fix, thread home. All icons in one sprite; no emoji in the interface.

## 3.6 Trust chips

| Chip | Meaning | Applied to |
| --- | --- | --- |
| ● Real | Measured data | Terrain, imagery, CRISM, RAD series, Navcam photos, rover positions |
| ◐ Modelled | Computed from real data with a range | Homeline, margins, routes, slope classes, siting, partner line |
| ○ Simulated | Hypothetical | The crew, the EVA, storm timing, drift |
| ◆ Live | Computed on request by the same engine, not on the validated scorecard | Every result from the backend |
| ✦ Visual | Artistic | Sky colour, haze, figures, speckle, particles |

Clicking a chip opens the provenance popover: value, units, source file, script, commit, UTC time (from the manifest or the run record).

## 3.7 Components

| Component | States | Notes |
| --- | --- | --- |
| Shell (top bar, mode tabs, rails, sidebar, timeline dock) | Desktop, tablet, collapsed rails, focus mode | §4.3 |
| Card | Default, selected, dimmed, loading | Title row with code and chip |
| Readout | Value, range, unit, chip; stale; unknown | Tabular figures |
| Gauge | Normal, caution, limit, unknown | Bar with reserve zone |
| Chip | Five kinds | Clickable |
| Button | Primary, secondary, ghost, danger; hover, press, focus, disabled, busy | Primary is `text` on `card` with a yellow focus ring |
| Toggle, slider, segmented control | Default, focus, disabled | Slider shows its value and unit |
| Layer row | On, off, disabled, with legend | §U7 |
| Alarm banner | Turn back, radiation, position uncertain, turn-back soon, info | Same rules as the HUD (F18) |
| Stepper | Waiting, running, done, failed | §U11 |
| Timeline | Collapsed, expanded, playing, scrubbing | §U5 |
| Chart primitives | Line, area, bar, step | SVG |
| Tooltip, popover, dialog, sheet, toast | — | Keyboard reachable |
| Command palette | Empty, results, no results | §U17 |
| Map pill label | Collapsed, expanded, selected | §U13 |
| Empty, loading, error, offline states | — | §U11 |

## 3.8 Wording

| Term | Use | Do not use |
| --- | --- | --- |
| Homeline | The 30/60-minute return boundary | Envelope (in the interface), safe zone |
| Margin | Minutes left before a limit binds | Buffer, slack |
| Time home | Walking time back to the rover | ETA home |
| Turn-back | The latest time to start home | Abort |
| Rover pad | Where the rover parks | Base, habitat |
| Science target / station | Planned stop | Waypoint (except user points) |
| Computed live | Backend result | Real-time |
| Considering | NASA's walkback | Rule, requirement |

Numbers always with units; ranges as "23.0% (15.2–28.7)"; times as "41 min" or "02:30 EVA"; coordinates to 4 decimals in the interface, 6 in exports.

# 4. Information architecture

## 4.1 Modes

| Mode | Question | Main content |
| --- | --- | --- |
| **PLAN** | Where can we go and still get home? | Map (2D/3D), living homeline (bands), labels, layers, stations, pad and parking options (✂️ route editing cut, D69), crew and budgets, trade table |
| **FLY** | What will it be like, minute by minute? | Playback with margin field, thread, gauges, HUD; 3D chase and first-person; flythrough; storm mode (✂️ live sessions and mission control cut, D69) |
| **REPORT** | Is this plan safe, what does it cost? | Mission report, per-leg table, cuff card, share as permalink and JSON export (✂️ comparison cut, D69) |
| **EVIDENCE** | Why believe it? | Scorecard, V1, V2 with Navcam overlays, RAD checks, data and licences, provenance, about, privacy |

## 4.2 Routes

| Existing route | New place |
| --- | --- |
| `/` (console) | PLAN |
| `/station/:id` | PLAN with the station selected |
| `/trade` | PLAN, trade panel |
| `/conditions` | FLY, conditions panel; storm mode |
| `/hud`, `/hud3d` | FLY (2D, 3D) |
| `/nav` | EVIDENCE, "optional add-ons" (D19) |
| `/cuff` | REPORT, print |
| `/scorecard`, `/about` | EVIDENCE |
| `#/plan/{hash}` | Any mode with that plan loaded |
| New: `/report`, `/styleguide`, `?demo=1`, `?capture=…` | REPORT, internal, kiosk, capture |

Old URLs redirect; nothing breaks.

## 4.3 Layout

| Region | Desktop (≥ 1280 px) | Tablet (768–1279 px) | Phone (\< 768 px) |
| --- | --- | --- | --- |
| Top bar | 48 px | 48 px | 44 px, modes in a menu |
| Left rail | 320 px, collapsible to 56 px icons | Bottom sheet | Hidden |
| Right sidebar | 360 px, opens on selection | Bottom sheet (half height) | Full-screen sheet |
| Timeline dock | 120 px, collapsible to 40 px | 96 px | Hidden; report only |
| Map | Remaining space | Full width | Static snapshot in the report |

Phones get REPORT and EVIDENCE plus the cuff card; planning on a phone is out of scope.

## 4.4 Keyboard

| Key | Action |
| --- | --- |
| Ctrl+K or / | Search and commands |
| 1–5 | Camera presets |
| F | Focus mode |
| Space | Play / pause |
| ← / → (Shift for 10×) | Scrub 1 min (10 min) |
| Esc | Clear selection, cancel ghost, exit focus mode |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| \[ / \] | Previous / next selection |
| P, Y, R, E | Plan, Fly, Report, Evidence |
| T | 2D / 3D |
| ? | Shortcut help |

# 5. Architecture

## 5.1 Overview

```mermaid
flowchart TB
  subgraph Data["Data (static files or live result tree)"]
    FIELDS[Field PNGs + index]
    TERRAIN[Elevation tiles z6–16]
    OVER[Overlay tiles + highlight polygons]
    LABELS[labels.json]
    TL[route + timeline + stations + pad]
    MAN[manifest.json]
    STORY[storyboards]
  end
  subgraph State["State (one source of truth)"]
    MS[Mission state: plan, clock, position, budgets]
    SEL[Selection: selected, hovered, history]
    EDIT[Plan edit: draft, ghost, undo]
    UI[UI: mode, panels, settings]
  end
  subgraph Render["Rendering"]
    MAP[Map: terrain, basemap, symbol and line layers]
    FIELD[Field shader canvas]
    THREE[Three.js scene]
    PANELS[Shell, cards, timeline, report]
  end
  API[Live API client (WS13)]
  FIELDS --> FIELD
  TERRAIN --> MAP
  OVER --> MAP
  LABELS --> MAP
  TL --> MS
  MAN --> PANELS
  STORY --> MS
  MS --> FIELD
  MS --> MAP
  MS --> THREE
  MS --> PANELS
  SEL --> MAP
  SEL --> PANELS
  EDIT --> API
  API --> MS
  FIELD --> MAP
```

**Separation** (as the second review asks): data loading, planning (backend calls only), interaction (selection and edit stores), rendering (map, shader, 3D) and UI state are separate modules. Rendering code never computes routes or margins other than the per-pixel shader, which evaluates the documented formula and is tested against the timeline.

## 5.2 State

| Store | Fields | Writers | Readers |
| --- | --- | --- | --- |
| Mission state | plan (inputs, hash, result base URL), clock (EVA minute, speed, playing), position (lon, lat, σ, source), budgets (O₂ left, reserve, dose allowance, EVA length), conditions (t\_dark, τ\_dose, storm on/off) | Timeline, playback, sliders, plan loader (✂️ live session cut, D69) | Field shader, map, 3D, HUD, timeline, gauges, report |
| Selection | selected, hovered, history | Map clicks, lists, search, history keys | Map highlights, sidebar, camera |
| Plan edit | draft inputs, ghost result, delta, undo stack | U15 gestures | API client, map ghost layer, sidebar delta strip |
| UI | mode, panel sizes, layers on, exaggeration, 2D/3D, reduced motion, intro seen | Controls, settings | Shell, map |

Implementation: a small signal store (Preact signals if already a dependency; otherwise about 50 lines of hand-written code). No new framework.

## 5.3 Code layout

```javascript
web/src/
├── ui/                tokens.css, tokens.json, components/, shell/, timeline/, search/, charts/, styleguide/
├── state/             mission.ts, selection.ts, edit.ts, ui.ts
├── map/
│   ├── style.ts        terrain, basemap, relief, layer order
│   ├── field/          field.glsl, fieldLayer.ts, decode.ts, collapse.ts
│   ├── layers/         overlays, legend data
│   ├── labels.ts       symbol layers, leader lines
│   ├── thread.ts       thread home
│   ├── markers.ts
│   └── camera.ts       presets, focus, bookmarks, flythrough
├── edit/              drag pad, science points, reorder, ghost, undo
├── story/             director, storyboard loader, kiosk, capture
├── report/            mission report, print
├── hud/, fp3d/, live/ (existing; restyled; fp3d extended by U8)
pipeline/export/       terrain_tiles.py, relief_lowzoom.py, contours.py, overlays.py, highlights.py, labels.py
web/public/data/       terrain/, overlays/, highlights/, labels.json
web/public/story/      intro.json, flythrough.json, storm.json, kiosk.json, video_beat1.json
```

## 5.4 Performance budgets

| Item | Budget |
| --- | --- |
| First load, added JavaScript and CSS (compressed) | ≤ 150 kB over today |
| Fonts | ≤ 120 kB (two families, subsets) |
| Elevation tiles | ≤ 25 MB total, loaded on view |
| Low-zoom relief (intro) | ≤ 5 MB |
| Overlay tiles and highlight polygons | ≤ 15 MB |
| Field textures in memory | ≤ 64 MB GPU |
| Frame rate | 60 fps in 2D while scrubbing; ≥ 30 fps in 3D tilt and in the Three.js scene on the integrated-GPU laptop |
| Interaction | Hover readout ≤ 16 ms; selection to card ≤ 100 ms; pad preview ≤ 1 s (backend) |
| Lazy loading | 3D scene, shader, report, storyboards, overlays load on demand |

## 5.5 Dependencies

No new runtime library beyond what the app already uses (MapLibre, Three.js, Preact). Allowed additions: self-hosted fonts and one icon set (open licences); Playwright as a development dependency for screenshots. Not allowed: React, chart libraries, animation libraries, CSS frameworks.

# 6. Data contracts (pipeline → design)

Owned by C, versioned like the other contracts, frozen at V0. All files under `web/public/data/` and listed in the manifest.

## 6.1 New pipeline exports

| File | Content | Format | Source |
| --- | --- | --- | --- |
| `terrain/{z}/{x}/{y}.png`, `terrain/tiles.json` | Elevation × 1.878, z10–15 planning extent, z16 focus area | 256 px PNG, Terrarium encoding; metadata: factor, bounds, zooms, source hash | 1 m merged DEM, 20 m CTX at low zoom |
| `terrain_low/{z}/{x}/{y}.png` | Gale crater relief for the intro, z6–10 | Same | CTX 20 m, MOLA–HRSC 200 m |
| `overlays/contours.geojson` | 10 m contours, 50 m index flag | GeoJSON lines (focus area), simplified to 1 m | 1 m DEM |
| `overlays/slope_class/{z}/{x}/{y}.png` | Four slope classes | Indexed PNG tiles | 3 m slope grid (D22) |
| `overlays/rough/{z}/{x}/{y}.png` | Rough-footing mask | Same | Max-slope grid |
| `overlays/mineral_{sulfate,clay}.png`  • bounds | CRISM hint strength | Single georeferenced PNG each (18 m) | CRISM SINDEX2, D2300 |
| `highlights/ridges.geojson` | Connected ridge polygons with relief and length | GeoJSON | Ridge index |
| `highlights/mineral.geojson` | Patches above threshold with type and strength | GeoJSON | CRISM |
| `highlights/blocked.geojson` | Blocked areas with reason (slope class, step guard) and area | GeoJSON | Cell states |
| `labels.json` | Label objects (§6.2) | JSON | Stations, pads, landmarks config |

## 6.2 `labels.json`

```json
{"version": "1", "labels": [
  {"code": "PAD", "name": "Rover pad", "kind": "pad", "status": null,
   "lon": 137.4018, "lat": -4.7775, "priority": 1, "minzoom": 10, "ref": "pad.json"},
  {"code": "S7", "name": "Scored site …", "kind": "station", "status": null,
   "lon": 0, "lat": 0, "priority": 3, "minzoom": 13, "ref": "stations.json#S7"},
  {"code": "MSH", "name": "Aeolis Mons (Mount Sharp)", "kind": "landmark", "status": "official",
   "lon": 0, "lat": 0, "priority": 6, "minzoom": 6, "ref": "landmarks.yaml"}
]}
```

Coordinates are filled by the pipeline from the referenced files; zeros above are placeholders.

## 6.3 Storyboard schema

```json
{"id": "intro", "version": "1", "size": [1920, 1080], "fps": 60,
 "steps": [
  {"t": 0.0, "camera": {"lon": 137.4, "lat": -5.4, "alt_m": 180000, "bearing": 0, "pitch": 0}, "caption": "Gale crater · Mars"},
  {"t": 6.0, "camera": {"target": "PAD", "alt_m": 4000, "pitch": 55}, "layers": {"homeline": false}},
  {"t": 12.0, "field": {"mode": "bands", "collapse": 0}, "caption": "NASA is considering a 30-minute walkback"},
  {"t": 14.0, "field": {"collapse": 1, "duration_s": 3}, "caption": "Mars isn't flat"},
  {"t": 19.0, "ui": "reveal"}
 ]}
```

Steps may set camera (absolute or target code), layers, field mode, collapse value, clock, selection, caption and UI visibility. Interpolation between camera keyframes is eased; every value is deterministic.

## 6.4 Field shader interface

| Uniform | Unit | From |
| --- | --- | --- |
| `u_tHome[3]` (textures) | 0.1 min per count | `fields/{scenario}/t_home.png` for opt, nom, con |
| `u_o2Home` (texture) | 0.01 L per count | `o2_home.png` nominal |
| `u_state` (texture) | class | cell state |
| `u_t`, `u_tDark`, `u_tauDose`, `u_tEva` | min | Mission state |
| `u_o2Left`, `u_reserve` | L | Mission state |
| `u_o2Rate` | L/min | 1.35 (effort cap), from config |
| `u_budget` | min | 30 or 60 |
| `u_mode`, `u_variant`, `u_k` | — | UI and storyboard |
| `u_pad`, `u_cell`, `u_flatSpeed` | m, m, m/s | Pad position in grid metres, 5 m, 0.98 |
| `u_amber` | min | 10 (`hud.yaml`) |

# 7. Workstreams and work breakdown

## 7.1 Workstreams

| WS | Scope | Features | Agent hours | Reviewer |
| --- | --- | --- | --- | --- |
| **WS15 Design system and panels** | Tokens, components, shell, migration, timeline, report, onboarding, selection store and sidebar, search | U0, U5, U10, U11, U14, U17 | 23–31 | D |
| **WS16 Map visuals** | Pipeline exports (§6.1), terrain, field shader, collapse, thread and markers, flythrough and storyboards, overlays, storm mode, labels, camera | U1–U4, U6, U7, U9, U13, U16 | 30–42 | C (data), team lead (graphics) |
| **WS17 3D scene** | Chase camera, crew pair, shadows, thread in 3D (✂️ world tiles cut, D69) | U8 | 5–7 | R (code), team lead (graphics) |
| **WS18 Direct manipulation** | Drag the rover, undo (✂️ science points, ghost route, reorder cut, D69) | U15 | 6–9 | D (interaction), N (backend calls) |
| **RR Render review lane** | Claude in Chrome on the integrated-GPU laptop: baseline review, per-PR visual checks, GIFs, console | — | continuous | Reports to D (interface) and the team lead (graphics) |
| U12 quality | Visual regression in CI from U0; accessibility and performance checks; tablet | U12 | 4–5 | G |

Reviewer rule unchanged: at most two agent sessions per reviewer; core gates (G2, freeze) and backend gates (B) get reviewer time first.

## 7.2 WS15 tasks in order

1. Tokens (`tokens.css`, `tokens.json`), fonts, icon sprite, lint rule. **(Shortlist ends here for WS15.)**
2. Components in §3.7 with `/styleguide`; screenshot baseline.
3. Shell with modes, rails, sidebar, timeline dock placeholder; route mapping and redirects.
4. Migrate views in the U0 order, each behind `?legacy=` until V2.
5. Selection store and sidebar cards (U14) for pad, station, leg, cell; then ridge, mineral, blocked, edge, landmark.
6. Timeline dock, elevation profile, gauges (U5).
7. Search and palette (U17).
8. Onboarding, stepper, states, wording pass (U11).
9. Mission report and print (U10).

## 7.3 WS16 tasks in order

1. **Spike (≤ 1 h):** canvas-source field layer on the integrated-GPU laptop; decide the rendering path (§U2 step 7).
2. Field shader: decoding, bands mode, unknown hatch, polygon fallback; acceptance tests against the contour.
3. Margin mode; wiring to the mission state; acceptance against the timeline.
4. Collapse (U3).
5. Thread home, route draw-on, markers, compass, cursor readout (U4).
6. Labels (U13): pipeline `labels.json`, symbol layers, pill icon, priorities, selected layer. **(Shortlist ends here.)**
7. Pipeline exports: elevation tiles with the 1.878 factor, low-zoom relief.
8. 3D terrain in the planning map, relief shading with sun, exaggeration, fallback (U1); leader lines.
9. Camera presets, focus, flythrough (U16, U6 part 1).
10. Storyboards, intro, kiosk, capture (U6 part 2).
11. Overlays and highlight polygons; layer manager (U7).
12. Storm mode and chip popover (U9).
13. Bookmarks, isolation, focus mode, minimap, history (U16 rest).

## 7.4 WS17 and WS18 tasks in order

**WS17:** chase and overhead cameras → crew pair and walk cycle → ground rings and thread in 3D → shadows with automatic off-switch → ✂️ world tiles for any plan (cut, D69) → restyle with tokens.

**WS18:** plan-edit store and undo → drag the rover (static snapping, then backend preview and full plan). ✂️ Science points, ghost route and delta strip, insert on a leg and reorder are cut (D69).

## 7.5 Render review lane (RR)

One Claude in Chrome session on the integrated-GPU laptop with the preview open (local dev server or the deployed site). Only one lane, because the extension drives one browser.

1. **Baseline (before V0):** review the live site against §1.1 and the guardrails; list concrete issues with screenshots.
2. **Per design PR:** open the preview, run the checklist below, record GIFs of every animation touched, read the console, post a report on the PR.
3. **Before each gate:** full pass over the six key screens (§9) at 1440 × 900 and 1024 × 768.

**Checklist:** tokens only (no stray colours); contrast; labels overlap; legends match data; chips present on every number; unknown hatch grey; no console errors or failed requests; reduced motion respected; frame rate in 3D and while scrubbing; keyboard reach; offline banner with the API blocked; the guardrails at the top of this page.

# 8. Timeline and gates

This plan competes with the backend (B1–B3) for agent accounts, usage limits and reviewers. Two paths; the team picks one at V0.

| Gate | When | Path S (shortlist) | Path A (Tier A) |
| --- | --- | --- | --- |
| **V0** | Sat 20:30 | Decision row in SPEC §11; contracts §6 frozen; RR baseline done; spike started | Same |
| **V1** | Sun 01:00 | Tokens, field shader (bands + margin), collapse, thread, markers, labels merged; render review green | Same, plus components and `/styleguide` |
| **V2** | Sun 06:00 | Polish; video capture of the collapse | Shell and migration complete or reverted; 3D terrain; selection and sidebar; drag the rover; undo |
| **V3** | Sun 08:00 (with G2, B3) | Go/no-go for any Tier B item | Go/no-go per Tier B item (timeline, flythrough, overlays, storm, U8, search) |
| Hardening | Sun 08:00–12:00 | Visual regression, accessibility checks, performance | Same |
| Freeze | Sun 12:00 | No new design features; unfinished items removed, not half-shipped | Same |
| Capture | Sun 12:00–14:00 | Storyboard captures for the video | Same |

Wall-clock estimate with parallel sessions and the render review lane: Path S ≈ 1.5–2.5 h of build; Path A ≈ 4–6 h; everything ≈ 7–10 h, which does not fit next to the backend before the freeze. **After the backend demo cut (D69, Sat 21:16)** about 14–19 backend agent-hours are freed and the backend queue runs low from about 05:00; the design orchestrator may then borrow up to 2 idle slots (up to 6), which brings more Tier B items within reach at V3.

**Cut order** (first → last): U17 commands (keep search) → U16 bookmarks and history → U8 shadows → U10 → U8 crew figures → U7 beyond slope and contours → U6 director mode (keep the flythrough) → U9 speckle → U11 coach marks → U5 gauges (keep the timeline) → U6 intro → U1 (keep relief shading) → U15 drag the rover → U3 → U14 → U13 → U4 → U2.

# 9. Tests and validation

| Area | Test |
| --- | --- |
| Numbers unchanged | Rendered values of every manifest key before and after each design PR are identical |
| Tokens | Lint: no colour or font-size literal outside `tokens.css` |
| Contrast | Text ≥ 4.5:1, large text and UI parts ≥ 3:1, on every token pair used |
| Colour vision | `safe`, `caution`, `limit`, `select` distinguishable under simulated red-green and blue-yellow deficiency; second cue present |
| Field shader | Margin equals the timeline within 0.5 min at stations and every 5 min; 30-min edge within 5 m of the contour; unknown never coloured; 2D and 3D identical |
| Collapse | k = 0 circle radius 1,764 m within one cell; k = 1 equals the band; counted headline equals the manifest |
| Thread | Time equals `T_home` within 0.5 min; never crosses blocked or unknown cells |
| Terrain | Reference ridge ratio within 5% at 1×; layers registered at all tilts |
| Labels | No overlap on six key screens at five zooms; route stations always visible |
| Selection | Same card from map, list and search; every card number backed by manifest or field |
| Editing | Live drag values equal field values; ≤ 2 requests per second; undo restores the plan hash; static mode shows no server-only option |
| Storyboards | Two capture runs identical frame by frame |
| Storm | Tripwire and leash equal `rad.json`; timing note present |
| 3D | F20 checks still pass; ≥ 30 fps; fallback triggers |
| Visual regression | Six key screens and `/styleguide` at 1440 × 900 and 1024 × 768: Plan default; station selected; drag the rover with ghost; Fly with margin field and storm; Report; Evidence |
| Accessibility | Automated checks clean; keyboard reach for every control; visible focus; alarms announced to screen readers; a text summary of the map ("Homeline covers 23.0% …") |
| Performance | Budgets in §5.4 measured in CI (bundle) and by RR (frame rate) |
| Offline | With the API blocked, every static view works and the banner shows |

# 10. Demo, video and page

- **Video beat 1** (0–15 s): captured from `video_beat1.json`: the descent ends on the pad, the dashed flat circle, the collapse, unknown hatch, edge labels, the counted headline. Same words as SPEC §10.1.
- **Video beat 2** (15–26 s): unchanged: the skyline landing on Curiosity's Navcam photo (restyled card).
- **Optional 2–3 s** inside beat 1 or 2: the living homeline shrinking as the clock runs, or the rover being dragged. Never more than one extra shot.
- **Stand:** kiosk loop on a laptop; visitors can grab the rover.
- **Project page:** two stills (the collapse, the living homeline with the thread) and one GIF (drag the rover); captions with chips explained.

# 11. Risks

| # | Risk | L / I | Mitigation |
| --- | --- | --- | --- |
| 1 | Restyle breaks working views before the freeze | M / H | Presentation-only changes; value snapshot test; visual regression; revert switch per view; U0 finished or reverted |
| 2 | Looks outrun substance and cost Validity | M / H | Principle "homeline is the hero"; chips; Evidence one click away; nothing unmodelled drawn as data |
| 3 | Field shader too slow on weak laptops | M / H | Early spike; update only on change; half resolution while playing; custom-layer path; polygon fallback |
| 4 | Shader picture differs from validated polygons | L / H | Contour and timeline acceptance tests; polygons stay the export and fallback |
| 5 | Relief wrong because of the Earth-sized projection | M / M | 1.878 factor baked into tiles; ridge-ratio test; readouts from fields only |
| 6 | Terrain tiles too large for the site | M / M | z16 only over the focus area; 25 MB budget; tiles loaded on view |
| 7 | Reviewer overload (D) | H / M | RR lane takes the first pass; R reviews graphics; G runs quality checks; galleries instead of live sessions |
| 8 | Competition with the backend for agents and limits | H / H | Path choice at V0; Path S fits beside the backend; Path A replaces most backend stretch work |
| 9 | Licences or branding violated | L / H | Open fonts and icons, crew built in code, asset list on `/about`, no agency marks |
| 10 | Motion sickness, distraction | L / M | Reduced motion; cancellable camera moves; intro once and skippable |
| 11 | Label clutter in 3D | M / M | Priorities, zoom ranges, leader lines only above 30° tilt, at most two overlays |
| 12 | Live drag numbers read as exact route costs | M / M | Honesty rule: only field values live; ghost and "computing…" otherwise |

# 12. Decisions needed (log in SPEC §11)

| # | Decision | Recommendation | Decide by |
| --- | --- | --- | --- |
| 1 | Approve the design block | ✅ Decided (D49) | — |
| 2 | Path S or Path A | ✅ At least Path A (Tier A), probably everything (D49) | — |
| 3 | Palette and typefaces (§3.1, §3.2) | Accept; D adjusts on real screens at V1 | V0 |
| 4 | Four modes, or keep today's page structure | Four modes, only with a complete U0 (Path A) | V0 |
| 5 | Icon set | An open outline set (e.g. Lucide); confirm licence | V0 |
| 6 | Crew figures in code or an open model | In code | V3 |
| 7 | Intro on first load | On, skippable, off under reduced motion | V3 |
| 8 | Graphics reviewer | ✅ **Decided 2026-11-14 19:38: the user (team lead) reviews graphics** | — |
| 9 | Render review laptop and owner | The integrated-GPU laptop from the 3D check | V0 |

# 13. Before starting (V0 checklist)

- [ ] Decision row logged in SPEC §11 (approval, path, palette, reviewers)
- [ ] RR lane set up: Chrome with the extension on the integrated-GPU laptop, preview reachable; baseline review posted
- [ ] C freezes the contracts in §6 (labels, storyboards, exports, shader interface)
- [ ] Fonts and icon set downloaded, licences recorded for `/about`
- [ ] WS16 runs the field-layer spike and reports the rendering path
- [ ] Briefs WS15–WS18 exported to `briefs/` from this page (C)
- [ ] Value snapshot of every manifest key taken on `main` before the first design merge

# 14. Sources

- MapLibre style specification: terrain (elevation source, exaggeration): [https://maplibre.org/maplibre-style-spec/terrain/](https://maplibre.org/maplibre-style-spec/terrain/)
- MapLibre example: 3D terrain (separate sources for terrain and relief shading): [https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/](https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/)
- MapLibre example: three.js on terrain (custom layer): [https://maplibre.org/maplibre-gl-js/docs/examples/add-3d-model-with-terrain/](https://maplibre.org/maplibre-gl-js/docs/examples/add-3d-model-with-terrain/)
- MapLibre examples index (canvas source, custom style layer, contours): [https://www.maplibre.org/maplibre-gl-js/docs/examples](https://www.maplibre.org/maplibre-gl-js/docs/examples)
- MapTiler on MapLibre 2 (layers align with terrain): [https://www.maptiler.com/news/2022/05/maplibre-2/](https://www.maptiler.com/news/2022/05/maplibre-2/)
- NASA brand guidelines (insignia restrictions): [https://www.nasa.gov/nasa-brand-center/brand-guidelines](https://www.nasa.gov/nasa-brand-center/brand-guidelines)
- Outside reviews: first review (3D, safety boundary, astronaut, telemetry, overlays, flythrough), second review (VISCON reference, [viscon.evinu.de](http://viscon.evinu.de), not inspected for this plan)
- Internal: SPEC §1–§11 (F4, F10, F12, F18–F20, §2.5 backend, §6.1 field encoding), D4, D20–D28, D33, D39; config `hud.yaml`, `landmarks.yaml`; [UI refinement — design and engineering proposal (after app + backend)](https://app.notion.com/p/418961bcb61181459447d9ae40a439b4)

[UI refinement — design and engineering proposal (after app + backend)](https://app.notion.com/p/418961bcb61181459447d9ae40a439b4)

[Design agent kit — start here](https://app.notion.com/p/418961bcb6118151974cfa8b8313fc47)

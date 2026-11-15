# Mockups of the six key screens (R1)

> **DRAFT — provisional (D73), awaiting team lead + D.** These drafts are the visual target only after the team lead and D approve them; the approval is noted in `STATUS.md`. Until then WS15 and WS16 may use them provisionally (D73).

| # | Screen | PNG | Source |
| --- | --- | --- | --- |
| 1 | Plan default (desktop) | `01-plan-default.png` (1440 × 900) | `src/plan-default.html` |
| 1b | Plan default (tablet) | `01-plan-default-1024.png` (1024 × 768) | same page, tablet layout (DESIGN §4.3) |
| 2 | Station selected (sidebar card) | `02-station-selected.png` | `src/station-selected.html` |
| 3 | Drag the rover, ghost route, "computing…" | `03-drag-rover-ghost.png` | `src/drag-rover.html` |
| 4 | Fly with margin field and storm | `04-fly-margin-storm.png` | `src/fly-storm.html` |
| 5 | Report | `05-report.png` | `src/report.html` |
| 6 | Evidence | `06-evidence.png` | `src/evidence.html` |

## How they are made

- Static HTML and CSS. Every colour, size and font comes from the A1 tokens (`web/src/ui/tokens.css`, `fonts/`, `icons/sprite.svg`), loaded by relative path. Mixed colours use `color-mix()` of tokens at the overlay opacities from DESIGN §3.1.
- **Numbers.** Every number is read at render time from `web/public/data` (`manifest.json`, `pad.json`, `stations.json`, `cards/S7.json`, `timeline_nom_104.json`, `route_nom_104.geojson`, `conditions/rad.json`, `validation/v1.json`). `HL.m(key)` throws on a missing manifest key, so no number is typed in. Values not yet published show "—", or "placeholder".
- **Map.** No imagery and no copied art. The map is painted in a canvas from our own published field PNGs: `fields/shared/slope.png` as a quiet relief stand-in, `fields/{nom,con,opt}_104/t_home.png` for the bands, `terrain/cellstate.png` for the unknown hatch, `fields/nom_104/o2_home.png` for the Fly margin field. The thread home follows `fields/nom_104/pointer.png` (the same rule as `web/src/hud/wayhome.ts`). Route, stations and pad come from the route GeoJSON, `stations.json` and `pad.json`.
- **Rendering.** Headless Chromium through Playwright core. Nothing is added to the repo's dependencies:

```sh
npm i --prefix /tmp/hl-pw playwright-core@1.56.1
python3 -m http.server 8790 --bind 127.0.0.1 &        # from the repo root; the pages fetch web/public/data
NODE_PATH=/tmp/hl-pw/node_modules CHROMIUM=$(which chromium) node docs/design/mockups/src/render.cjs
```

## Colour meanings used (DESIGN §3.1)

Yellow `select` is used only for the selection, map labels, the crosshair and the ghost route. Green, orange and red mean margin only. Blue means science (station rings, dwell blocks). Purple means live (the Live status, the "computing…" pill, ◆ chips, the running stepper stage). The grey hatch means no 1 m terrain; this area has none (`terrain.cellstate.pct.unknown` = 0), so the hatch appears only in legends. Route lines are `text` (white) on a `bg` casing, so they stay readable over the green bands. Trust chips: ● real, ◐ modelled, ○ simulated, ◆ live, ✦ visual.

## Rationale per screen

**1 Plan default.** This answers "where can we go and still get home?" with nothing selected. The left rail holds the plan headline: reachable in 30 min 23.0% (15.2–28.7), 38 feasible EVAs and EVA 05:26. Below it sit budgets, the route in stop order with arrival time and margin, and the layers. The map shows the 30-min homeline as three cues. Conservative is the denser fill, nominal has a solid edge and optimistic a dashed edge. At the 30-min setting the 60-min line is a faint edge only, because filling it made the map mostly green. The hover shows the U4 tooltip with the timeline's own numbers at the t = 120 min checkpoint: home in 27 min, margin 83 min (dose). The thread home is traced from the pointer field. The right sidebar stays closed until something is selected. On the 1024 × 768 tablet layout the rail becomes a bottom sheet with two sections, and search collapses.

**2 Station selected.** S7 is the binding stop (tightest margin 41 min, dose), so selecting it tells the main story. The card follows U14: title row → four readouts (time home, margin with binding limit, arrival with dwell, turn-back with binding limit) → details → actions. The map dims the other stations and legs and keeps the legs to and from S7. The selected label expands with a yellow ring. The Navcam photo is NASA imagery and is not reproduced; a dashed placeholder marks its place. Objective and tasks are empty in `stations.json` and show "—".

**3 Drag the rover.** This shows the U15 rule: while dragging, show only exact values from the browser's fields (cell state, slope at the cell, maximum slope over 20 × 20 m, elevation of the published parking option). Everything else is a ghost. The old homeline stays at 45% until the new fields arrive. The ghost route is dashed yellow, with a purple "computing…" pill and stepper (live). Feasible EVAs and reachable % are dashed readouts with "—" and the previous value. The delta strip is empty until completion. Keep is disabled while the job runs. Escape (Discard) has the focus ring. The drop point is the published rank-2 parking option, so its elevation is real.

**4 Fly with margin field and storm.** The map switches from bands to the continuous margin field: green ≥ 10 min, orange under 10, red below zero, with a crisp zero edge. It is painted here with the DESIGN U2 formula from the published fields, with τ = 86 min (leash at peak, `rad.json`), O₂ left at t = 01:00 from the timeline, and EVA 6.5 h. The daylight term is omitted and the legend says so. The red alarm banner uses the U9 wording "Radiation: head home within 86 min" with the "hypothetical timing" note attached. The dock overlays the real May 2024 RAD dose-rate curve (log scale), shifted so that its tripwire falls at the playhead; that shift is the hypothetical part. The storm-adjusted margin at the crew is not published, so it shows "—" (placeholder). Done legs are solid and coming legs are at 50%.

**5 Report.** One page per plan, built for print. The display line is the verdict "Feasible · tightest margin 41 min at S7 · bound by dose". The left column has the map snapshot and timeline. The right column has the O₂ budget bar (walking, station tasks, left at return, reserve), the per-leg table, stations with partner-line status, and the run record with a QR placeholder. Climb per leg and the elevation profile are not published yet and show "—" or a note. The walking sum, the station-task O₂ and the total km are simple arithmetic on published values, done in the mockup. The real report should read them from the pipeline.

**6 Evidence.** This answers "why believe it?" with a scorecard of tiles. Each tile has a value, a chip and its caveat. The tiles are known-answer tests 1291/1294 (1 failed), V1 RMSE 5.45°, V2 near/mid skyline error, pad coverage, the RAD storm peak, the co-registration residual, the physiology golden cases and the terrain source. Next to them are the V1 scatter of all 290 drive ends from `v1.json` and a data and licences list. One provenance popover is shown open on V1 RMSE (value, file, script, commit, UTC from the manifest), which shows what clicking any chip does.

## Open questions for D

1. **Active mode tab.** It is currently a white underline. Yellow would break "yellow = selection only". Is white right?
2. **Plan default sidebar.** U14 says that with nothing selected the sidebar shows the route configuration, while §4.3 says the sidebar opens on selection. The draft keeps it closed, with the route list in the left rail. Which one?
3. **Route colour.** The route is white (`text`) with a dark casing, but §3.1 lists `safe` for "verified route". Green on green bands is unreadable. Can the route be `text`?
4. **60-min band at 30-min setting.** It is shown as an edge only, which keeps the map from being mostly green. Is that acceptable, or should it be a fill at 35%?
5. **Relief stand-in.** The drafts use the slope field as the background. The real Plan map has the HiRISE basemap plus relief shading. Should the slope texture be offered as an optional layer?
6. **Fly margin colours.** Large red areas dominate at storm time. Should red fill only the band near the zero edge and leave the far field hatched or neutral?
7. **Trust chips.** Is a glyph-only chip (● ◐ ○ ◆ ✦) at 16 px readable enough, or should the first chip in each card show its word ("Modelled")?
8. **Chip assignments.** Is arrival time ◐ modelled or ○ simulated (the EVA is simulated)? Is suit mass ○ simulated? Is elevation of a parking option ● real?
9. **Stamp and stepper wording.** The stepper stage names are placeholders until the copy deck (R4/D6) is approved.
10. **Tablet bottom sheet.** It shows the plan headline and budgets only. Should the route list be a second sheet tab?

## What RR should check

Compare these PNGs with the built shell once WS15/WS16 land. Headless Chromium renders the canvas map in software, so it is fine for layout and colour but says nothing about shader quality or motion. Motion, the collapse, the dash flow and 3D are not shown.

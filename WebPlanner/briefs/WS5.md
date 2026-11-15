# 🖥️ WS5 brief — Web app

**Mission:** the static web app on GitHub Pages: planning console, layers, slider, scenario picker, station cards, trade view, conditions view, scorecard, cuff card and about page. Mount points for the HUD (WS7), 3D (WS8) and navigation (WS9) views.

> 📌 **2026-11-14 (user):** (D20) label the partner layer "Partner line (cart haul, 60 min)" and show this note on the partner layer and the station cards: "One astronaut cannot drag a suited crewmate on Mars without a cart or sled: the pull needed exceeds boot grip even on flat ground." Its numbers (drag force, traction limit, max draggable mass) come from the manifest. (D19) The `/nav` view and any visual-odometry view are an **optional add-on**; label them so, and keep them out of the core path.

**Human owner / reviewer:** D · **Features:** F5 (UI), F6 (UI), F15, F17; HUD-on-card fallback · **SPEC:** §2.2 F5/F6/F15/F17, §4.1–4.3, §6, §10

## Owns

`web/` except `web/src/hud/`, `web/src/fp3d/`, `web/src/nav/`

## Stack (decided)

Vite + TypeScript + MapLibre GL JS; plain TS with small Preact components for cards and tables (D5). Mars lon/lat passed straight to MapLibre with a custom Mars scale bar (D4). Data from `data/` or `data-dummy/` by `VITE_DATA`.

## Produces

Routes `/`, `/station/:id`, `/trade`, `/conditions`, `/scorecard`, `/cuff`, `/about`; mount slots for `/hud`, `/hud3d`, `/nav`; GitHub Pages deploy workflow.

## Tasks (target time)

1. **H0–H1:** empty shell deployed to Pages (proves the pipeline end to end).
2. **H1–H4 (dummy data):** map with basemap placeholder, layer toggles, legend, Mars scale bar; bands, hatched unknowns, edge-cause labels; the "Simulated EVA" and "assumed" labelling components.
3. **H4–H8:** budget slider (MapLibre filter on `minutes`); scenario picker from `scenarios/index.json`.
4. **G1 (H10):** real band layer, route, RAD chart; deployed.
5. **H10–H20:** station cards (Navcam + overlay + panorama + timeline + margins + contingency), trade view, conditions view, cuff card print CSS, scorecard (reads `manifest.json`, `v1.json`, `v2.json`, coverage, KAT list), about page (data, licences, SI statement).
6. **G2:** all views on real data; if WS7 is not green, ship the HUD-on-card strip.
7. **Sun 12:00–16:00:** capture support for D's video.

## Tests

`tsc` clean; `vite build` under 5 MB without data; every view loads with dummy and real data; every displayed number has a manifest key (dev-mode warning if not); links work logged out.

## Don't

Fetch anything live at runtime; show dummy numbers in captures; put the partner line, the storm or the scorecard in the default view.

## Default view

HiRISE basemap, 30-min nominal band, edge causes, stations. Everything else behind toggles.

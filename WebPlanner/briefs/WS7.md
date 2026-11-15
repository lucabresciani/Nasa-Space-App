# 🪖 WS7 brief — Live HUD

**Mission:** the live 2D HUD: playback clock, walking marker, drag-anywhere mode, helmet-style panel with alarms, position input with uncertainty and worst-case margins. Also the field PNG export and the worst-case fields.

> ⏸️ **2026-11-14 (user, D19):** the core HUD uses F19's uncertainty circle with the flat drift rule, and fixes at the rover pad and surveyed stations only. WS9's F21 ellipse, the Odometry position line and any toggle for them are an **optional add-on**: keep them working where merged, never required. (D20) The partner status refers to the cart-haul line only; the drag note sits on the partner layer and station cards (WS5).

**Human owner / reviewers:** D (UI), C (data) · **Features:** F18, F19 (+ HUD-on-card strip with WS5) · **SPEC:** §2.3, §6.1, mockup image `homeline_hud_mockup.png`

## Owns

`web/src/hud/`, `pipeline/export/fields_png.py`, `pipeline/export/worstcase.py`, `config/hud.yaml`, `tests/test_fields_png.py`, `web/src/hud/*.test.ts`

## Reads

WS2 return fields (`t_home`, `o2_home`, `pointer`), WS1 slope, route + timeline, `stations.json`, `conditions/rad.json`, sun API output, `partner.geojson`; later WS9 ellipses and fixes.

## Produces

`fields/index.json` and field PNGs per §6.1 (5 m, RG-encoded, A = 0 unknown); `t_home_worst_{10,50,100}` and `o2_home_worst_{10,50,100}` (circular max filter, `nom_104`); the `/hud` view and the HUD panel component reused by WS8.

## Tasks (target time)

1. **H1–H2:** PNG encoder (Python) and decoder (TS, Canvas 2D) with an exact round-trip test.
2. **H2–H8 (dummy data):** panel components (minimal and expanded levels, D14), alarm rules 1–5, playback clock (speeds 1/30/60/300, default 60, D13), scrubber, route-following marker, minimap.
3. **H8–H12 (real fields after G1):** export real field PNGs; drag-anywhere mode with the way-home path from the pointer field; band colouring by margin.
4. **H12–H18:** position interface (`{lon, lat, sigma_m, source, t_eva_min, last_fix}`); worst-case fields; uncertainty circle; fallback drift (2%, D12) and fix resets; storm switch.
5. **H18–H23:** real route and timeline; integrate WS9 ellipses and fix events when they arrive (ellipse replaces the circle). _(2026-11-14, D19: optional add-on; the circle is core.)_
6. **G2:** F18 + F19 complete, or tell D to ship the HUD-on-card strip.

## Tests (write first)

- Field PNG encode/decode round trip exact to one count; unknown cells decode as unknown.
- HUD T_home = 0 at the pad; along the route equals the timeline ± 0.5 min.
- Alarms fire at the times the timeline predicts; rule order respected.
- Worst-case field ≥ point field everywhere.
- σ monotonic between fixes, reset at fixes; alarm 3 fires exactly when the circle crosses the band (synthetic).
- 60 fps on a mid-range laptop at 60× playback.

## Don't

Compute science in the browser (lookups only); show the HUD without the "Simulated EVA" label; change WS2 rasters.

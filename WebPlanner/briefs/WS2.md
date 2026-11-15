# ⚙️ WS2 brief — Engine

**Mission:** the science engine. Suited physiology, the directed router, the homeline bands and edge causes, isochrones, all scenarios, siting, the traverse, the partner line and the trade table.

> 🛒 **2026-11-14 14:24 (user, D20): the partner haul is cart only.** Haul fields and `partner.geojson` are built for the cart case only; no drag fields. Dragging is a finding, not a line: drag force 179 kg × 3.71 × 0.6 ≈ 398 N exceeds the boot traction limit 0.5 × 189 kg × 3.71 ≈ 351 N, so the maximum draggable mass is ≈ 157 kg. These three numbers go into the manifest (WS5 shows them with the drag note).

**Human owner / reviewer:** S (science), C (code) · **Features:** F3–F11 · **SPEC:** §2.2 F3–F11, §5.3, §6

## Owns

`pipeline/engine/`, `config/crew.yaml`, `config/variants.yaml`, `config/haul.yaml`, `tests/test_physio.py`, `tests/test_router.py`, `tests/test_haul.py`, `data/interim/engine/`

## Reads

WS1 routing grids (`elev_3m`, `maxslope_3m`, `cellstate_3m`, `ridge_index`), `stations.json`, `pad` from `site.yaml`, conditions leash and daylight from WS4 (for margins), all configs. Added 13 Nov: `crew.yaml → o2_budget` (O₂_left for margins), `variants.yaml → outputs` (isochrone range, step, simplification, size budget), `site.yaml → siting` (F8 rule), and the `pad.json` contract in SPEC §6.

## Produces

| File | Content |
| --- | --- |
| `engine/{scenario}/t_home.tif`, `o2_home.tif`, `pointer.tif` | 3 m return fields per scenario (9) |
| `scenarios/{scenario}/isochrones.geojson` | 1-min contours 1–60 (D2), 2 m simplification |
| `scenarios/bands_{suit}.geojson`, `scenarios/{scenario}/edges.geojson` | 30/60-min bands; edge causes |
| `scenarios/{scenario}/partner.geojson` | 60-min haul contour (dashed layer); haul fields per case _(cart only since 2026-11-14, D20)_ |
| `scenarios/index.json` | Per contract, with headline reachable % and range |
| `siting.tif`  • PNG, `pad.json` | F8 |
| `route_{scenario}.geojson`, `timeline_{scenario}.json` | F9 |
| `trade_table.json` | F11 |

## Tasks (target time)

1. **H1–H2 (synthetic grid):** `physio.py` exactly per `variants.yaml` formulas; KATs.
2. **H2–H4:** graph (16-neighbour directed, 3 m) + Numba heap Dijkstra (reverse and forward) (D6); router KATs on synthetic planes and walls.
3. **H4–H8 (real grid):** `nom_104` return field; bands at 30/60; edge causes; isochrones; headline. Hand `t_home`/`o2_home`/`pointer` to WS7 as soon as they exist.
4. **G1 (H10):** 104 kg nominal band and edges in the app (with WS5); a 3-station route.
5. **H10–H16:** forward runs from stations; siting heatmap and pad decision (report to S); orienteering DP; full route and timeline with O₂ checkpoints and margins (needs WS4 leash and daylight). **Scenario list frozen 23:00.**
6. **Overnight:** batch all 9 scenarios; haul fields (2 masses × cart/drag, nominal; _2026-11-14, D20: cart only, no drag fields_), ridge-masked; partner line; trade table.
7. **G2 (Sun 08:00):** everything validated against contracts; manifest entries written.

## Tests (write first)

- Physiology: anchor (level, 0.98 m/s, 120 kg, g 3.71) gives 19 ± 1 mL/kg/min; monotonic in grade and mass; v\* ≤ v_safe; downhill minimum near −10% to −15% grade.
- Router: flat plane T = d/v ± 1% and circular envelope; 10% plane reaches farther downhill; uphill speed equals the governor; wall > 20° never crossed; unknown cells never entered.
- DP equals brute force on 8 stations.
- Haul: force for 343 kg at 0/10/20° matches hand calculation; Mars/Moon force ratio 2.29; haul never faster than walking; masked ridges never crossed.
- Drag finding (2026-11-14, D20): drag force for 179 kg at μ 0.6 ≈ 398 N > boot traction 0.5 × 189 kg × 3.71 ≈ 351 N on flat ground; max draggable mass ≈ 157 kg; all three written to the manifest.
- Edge causes: on the dummy world, the wall edge is "slope", the hole edge is "data".

## Hand-offs

WS7: return fields (H8), worst-case inputs; WS5: bands, isochrones, routes, trade; WS9: route, timeline, return fields; WS8: route geometry for the camera path.

## Don't

Invent parameters (use config); use scipy as the primary router; draw the partner line solid or on by default; quote any number before it is computed and in the manifest.

## Fallback

If the Numba router is too slow on the full grid by H6: scipy `csgraph` on a 6 m grid for scenarios other than `nom_104`, labelled in the manifest.

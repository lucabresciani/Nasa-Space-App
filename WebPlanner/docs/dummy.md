# 🧪 Dummy data spec

> 🧪 **Owner: C.** A small generator `tools/make_dummy.py`, written at H0 (≤ 45 min), produces fake but contract-valid data in `web/public/data-dummy/`. It lets WS5, WS7, WS8 and WS9 build and test from H1–H2 without waiting for the real pipeline. Every index file carries `"dummy": true`, and CI fails if that flag ever appears in `web/public/data/`.

## Synthetic world

- **Extent:** 2 × 2 km centred on the default pad (lon 137.382, lat −4.806), in the analysis CRS from `config/site.yaml`.
- **Elevation (1 m):** a 5% plane rising to the south (towards "Mount Sharp") + one Gaussian hill (height 40 m, σ 150 m) 600 m north-east of the pad + one straight wall 300 m long, 8 m high, slope 35°, 400 m west of the pad + one nodata hole (circle, radius 80 m) 500 m south-east.
- **Source mask:** HiRISE everywhere except a 300 m strip along the east edge (CTX) and the nodata hole.
- **Ridges:** a 1.2 m sinusoidal ridge field (wavelength 20 m) in a 200 × 200 m patch 300 m north.

## Files (all in the real formats from SPEC §6, §6.1, §6.2)

| File | How it's made |
| --- | --- |
| `scenarios/index.json` | Three scenarios: `nom_104`, `opt_104`, `con_104`, `"dummy": true` |
| `scenarios/*/isochrones.geojson` | Circles of radius v·t with v = 0.9 / 1.0 / 0.8 m/s, cut by the wall and the hole; 1-min steps to 60 |
| `scenarios/bands_104.geojson`, `edges.geojson` | From those circles; edge causes: "slope" along the wall, "data" at the hole and the CTX strip, "physiology" elsewhere |
| `scenarios/*/partner.geojson` | Circle of 40% of the 60-min radius |
| `fields/index.json`  • PNGs | `t_home` = distance / speed (minutes), `o2_home` = 0.25 L per minute of `t_home`, `home_bearing` = bearing to the pad, `slope` from the synthetic DEM, worst-case fields by max filter, `fix_interval_medium` = 2 × distance to the 30-min edge; unknown cells A = 0 |
| `stations.json`  • `cards/S*.json` | Three stations at 600 m (N), 900 m (E), 1,400 m (S); cards with a grey placeholder image instead of a Navcam frame |
| `route_nom_104.geojson`  • `timeline_nom_104.json` | Pad → S1 → S2 → S3 → pad as straight legs at 0.9 m/s, 30 min dwell; margins computed from the dummy `t_home` |
| `trade_table.json` | 2 × 3 cells with plausible monotonic values |
| `conditions/rad.json` | Baseline 9 µGy/h; a storm with onset after 2 h, rising to 350 µGy/h over 3 h, decaying over 24 h; tripwire time computed by the real rule |
| `nav/montecarlo_medium.json`, `nav/fixes.json`, `nav/tracks_medium.geojson` _(2026-11-14, D19: serve an optional add-on)_ | Ellipses growing linearly at 2% of distance; fixes at the pad and each station; a sample estimated track offset sideways |
| `scenarios/pads/index.json`, `scenarios/pads/rank{2,3}/…` _(2026-11-14, contracts v1.1.4, D21 picker)_ | Official row = the dummy pad (`pad.json`); two parking options 380 m west (beside the wall) and 400 m south-east (beside the hole), ranked by the D21 order on the synthetic model (station subsets that fit the EVA, then reachable % at 30 min, then elevation); per option `summary.json`, nominal `bands_104`, `edges`, `partner`, straight-leg `route_nom_104` / `timeline_nom_104`; distances on the 10 m web grid; no isochrones |
| `fp3d/` | Height chunks and the far mesh from the synthetic DEM; a flat tan texture; horizon ring from a simple ray cast |
| `manifest.json` | Entries for every dummy number, script `tools/make_dummy.py` |

## Rules

- Deterministic (seed 20261114), runs in under a minute, no network access.
- Uses `config/*.yaml` for every format setting so the dummy files stay in sync with the contracts.
- The web app reads `data-dummy/` when started with `VITE_DATA=dummy`, otherwise `data/`.
- Dummy numbers never appear in captures, the video or the project page.

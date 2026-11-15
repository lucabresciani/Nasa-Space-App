# 🗺️ WS1 brief — Terrain

**Mission:** produce the terrain stack every other workstream stands on: the 1 m elevation model in the analysis CRS, the source mask and cell states, slope and ridge grids, co-registration to Curiosity, station scoring and the basemap. Own gate G0.

**Human owner / reviewer:** S · **Features:** F1, F2, F7 · **SPEC:** §1.4, §2.2 F1/F2/F7, §4.2, §5.1 items 1–3, 6–8

## Owns

`pipeline/terrain/`, `config/site.yaml`, `config/stations.yaml`, `tests/test_coverage.py`, `tests/test_coreg.py`, `data/interim/terrain/`, `web/public/data/tiles/basemap/`

## Reads

`docs/discovery.md` (URLs, CRS, field names), `config/site.yaml`, `config/stations.yaml`, MMGIS waypoints (cached by N)

## Produces (all GeoTIFF COG, analysis CRS, float32 unless stated)

| File | Content |
| --- | --- |
| `dem_1m.tif` | Merged DEM window over the planning extent (pad ± 3.7 km + 200 m) |
| `source_mask.tif` (uint8) | 1 HiRISE, 2 CTX, 3 HRSC/MOLA, 0 nodata |
| `slope_1m.tif`, `roughness_5m.tif`, `ridge_index.tif` | Per F2 |
| `elev_3m.tif`, `maxslope_3m.tif`, `cellstate_3m.tif` (uint8) | Routing grid; states 0 assessed, 1 blocked (nominal limit), 2 unknown |
| `coverage.json` | Assessed / unknown fractions of the flat 30- and 60-min discs around the pad; coverage map PNG |
| `coreg.json` | Best shift (dx, dy), residual median and MAD, per-drive-end residuals |
| `hirise_xcheck.json` | Merged DEM minus each HiRISE DTM: median, P90 |
| `crism_sindex2_18m.tif`, `crism_d2300_18m.tif` | Resampled CRISM indices |
| `stations.json` (values part) | S1–S5 positions and values per `stations.yaml` |
| Basemap tiles | XYZ PNG tiles of the HiRISE ortho, zoom levels for 0.25–10 m |

## Tasks (target time)

1. **H0–H1:** windowed read of the merged DEM over the planning extent via `/vsicurl/`; reproject to the analysis CRS at 1 m; start the HiRISE DTM, ortho and CRISM downloads in the background.
2. **H1:** source mask (D3: mosaic footprints if `discovery.md` found them, else STAC footprints of the HiRISE DTMs); coverage fractions and map.
3. **H1–H2:** co-registration grid search (±200 m, 2 m) against drive-end elevations; write `coreg.json`.
4. **G0 report by 11:00** (hard limit 13:00): coverage, shift, residuals, pad check (≥ 90% assessed in the 30-min disc, else apply the F8 pad rule with a flat-disc proxy and report). S signs off; post in `STATUS.md`.
5. **H2–H4:** slope (Horn 3×3; also 5 m for comparison), roughness, ridge index; 3 m routing grids and cell states. Hand to WS2 immediately.
6. **H4–H6:** HiRISE cross-check; CRISM resample; station positions and values per `stations.yaml` (S3, S5 picks by S before H2).
7. **H6–H8:** basemap tiles.
8. **After V1 (WS6):** write the conservative no-go limit (20° minus V1 RMSE) and regenerate `cellstate_3m_conservative.tif`.

## Tests (write first)

- Source-mask fractions over a window match a direct count within 1%.
- A synthetic shift applied to rover points is recovered within 2 m; shift on the merged DEM itself is ≈ 0.
- An unknown island in a synthetic grid is never assessed and is excluded from percentages.
- A cell within 20 m of a source boundary is flagged as a data edge.
- Slope of a synthetic 10% plane = 5.71° ± 0.05°.

## Hand-offs

WS2 (routing grids, cell states) at H4 at the latest; WS3 (dem_1m, coreg) at H2; WS8 (dem_1m window) at G0; WS6 (slope for V1) at H4.

## Don't

Route on the HiRISE DTMs; mosaic HiRISE DTMs into the primary terrain; fill nodata by interpolation; pick stations by eye except S3/S5 (S does those).

## Fallback

If the merged DEM can't be read by 13:00: use DTM `019698` alone, mark everything outside it unknown, move the pad by rule, and tell every workstream.

# Data contracts (pipeline → web)

**Contracts v1.1.5** (2026-11-14, additive; see "Changes" at the end). The simulator bundle family
(`plan.schema.json`, `bundle.schema.json`, D41) is versioned separately: `contracts/bundle/README.md`, v1.0.0. Only C changes a contract,
by PR with a version bump and a note to every consumer (AGENTS.md rule 4). A schema's
`x-contract-version` is the version that last changed it (1.0.0, 1.1.0 … 1.1.4). Every schema carries `"x-contract-version"` and `"x-source"` (the SPEC
section or brief it comes from).

Source of truth: SPEC.md §6, §6.1, §6.2. Schemas are JSON Schema draft 2020-12.
Validate with `uv run python tools/validate_contracts.py` (CI runs it on every PR; add
`--interim data/interim` for the pipeline-internal files).

Where SPEC fixes a structure, the schema follows it key for key. Where SPEC names a file but not
its structure, the schema is deliberately loose (`partner`, `route`, `coverage`,
`rems`, `clock`, and the open parts of `v1`, `v2`, `donki`, `fp3d_index`); the producing workstream
proposes the structure to C by PR, and C bumps the version.

## JSON / GeoJSON files

Paths are relative to both `web/public/data/` (real) and `web/public/data-dummy/` (dummy, see
`docs/dummy.md`). Coordinates are lon/lat, Mars 2000 planetocentric, 6 decimals.

| Data path pattern | Schema | Source |
| --- | --- | --- |
| `scenarios/index.json` (**index**) | `scenarios_index.schema.json` | §6 |
| `scenarios/{scenario}/isochrones.geojson` | `isochrones.schema.json` | §6 |
| `scenarios/bands_{suit}.geojson` | `bands.schema.json` | §6 |
| `scenarios/{scenario}/edges.geojson` | `edges.schema.json` | §6 |
| `scenarios/{scenario}/partner.geojson` | `partner.schema.json` | §6 (named in the index; no properties given) |
| `stations.json` | `stations.schema.json` | §6 |
| `cards/{station}.json` | `card.schema.json` | §6 |
| `route_{scenario}.geojson` | `route.schema.json` | §6 |
| `timeline_{scenario}.json` | `timeline.schema.json` | §6 |
| `trade_table.json` | `trade_table.schema.json` | §6 |
| `pad.json` (carries `dummy`) | `pad.schema.json` | §6 (F8, added 13 Nov); `pad` = the pad in use, F8 result in `proposal` (v1.1.2); since D21 the official pad, D21 extras (v1.1.4) |
| `conditions/rad.json` | `rad.schema.json` | §6 |
| `manifest.json` | `manifest.schema.json` | §6 |
| `fields/index.json` (**index**) | `fields_index.schema.json` | §6.1, §6.2 |
| `fp3d/index.json` (**index**) | `fp3d_index.schema.json` | §6.1 |
| `fp3d/horizon_ring.json` | `horizon_ring.schema.json` | §6.1 |
| `localisation/{image_id}.json` | `localisation.schema.json` | §6.1 |
| `nav/montecarlo_{set}.json` | `montecarlo.schema.json` | §6.2 |
| `nav/fixes.json` | `fixes.schema.json` | §6.2 |
| `nav/tracks_{set}.geojson` | `tracks.schema.json` | §6.2 |
| `nav/fix_interval_summary.json` | `fix_interval_summary.schema.json` | §6.2 |
| `vo/probe.json` | `vo_probe.schema.json` | §6.2 |
| `vo/drift.json` | `vo_drift.schema.json` | §6.2 |

### Beyond SPEC §6

These files are not in §6 but are named as outputs in SPEC §2 (feature table) or in a brief, and
other workstreams read them. Each schema says where it comes from.

| Data path pattern | Schema | Why |
| --- | --- | --- |
| `validation/v1.json` | `v1.schema.json` | SPEC §2 F13 output; brief WS6 lists its content; read by the WS5 scorecard |
| `validation/v2.json` | `v2.schema.json` | SPEC §2 F13 output; brief WS3 lists its content; read by the WS5 scorecard |
| `validation/coverage.json` | `coverage.schema.json` | brief WS1 output; scorecard shows coverage (SPEC §2 F16) |
| `validation/coreg.json` | `coreg.schema.json` | brief WS1 output; scorecard shows co-registration residuals |
| `conditions/rems.json` | `rems.schema.json` | SPEC §2 F14 (`conditions/*.json`); brief WS4 |
| `conditions/clock.json` | `clock.schema.json` | SPEC §2 F14; brief WS4 |
| `conditions/donki.json` | `donki.schema.json` | SPEC §2 F14; brief WS4 ("context only, not a trigger") |
| `validation/kats.json` | `kats.schema.json` | SPEC §2 F16 KAT pass list; WS6 `pipeline/provenance/kats.py` |
| `siting_png.json` (v1.1.0) | `siting_png.schema.json` | F8 siting heatmap `siting.png` placement (4 corners, MapLibre order); WS2 |
| `tiles/basemap/tilejson.json` (v1.1.0) | `tilejson.schema.json` | F17 basemap index (TileJSON 3.0.0 subset); written by `make web` |
| `terrain/cellstate.json` (v1.1.0) | `cellstate.schema.json` | F1 cell states for hatching unknown terrain; written by `make web` from WS1 |
| `terrain/cellstate_conservative.json` (v1.1.2) | `cellstate.schema.json` | the same at the conservative no-go (17°, D23; cell slope = 3 m plane fit + 30° step guard, D22); written by `make web` from WS1 |
| `scenarios/pads/index.json` (**index**, v1.1.4) | `pads_index.schema.json` | D21 rover parking options: ranking table incl. the official pad; WS2 |
| `scenarios/pads/{id}/summary.json` (v1.1.4) | `pad_summary.schema.json` | D21 parking option: pad, rank, score, tiebreaks, headline 30/60 min, route summary; WS2 |
| `scenarios/pads/{id}/bands_{suit}.geojson` (v1.1.4) | `bands.schema.json` | the option's bands (nominal suit only) |
| `scenarios/pads/{id}/edges.geojson` (v1.1.4) | `edges.schema.json` | its band edges |
| `scenarios/pads/{id}/partner.geojson` (v1.1.4) | `partner.schema.json` | its partner line (cart, D20) |
| `scenarios/pads/{id}/route_{scenario}.geojson` (v1.1.4) | `route.schema.json` | its route |
| `scenarios/pads/{id}/timeline_{scenario}.json` (v1.1.4) | `timeline.schema.json` | its timeline |
| `physio/golden.json` (v1.1.5) | `golden.schema.json` | D41 physiology / margin / alarm test vectors (WS2 `pipeline/engine/golden.py`); any port must reproduce them within the stated tolerances; also in every plan bundle |

The web paths `validation/coverage.json` and `validation/coreg.json` are B0's choice (WS1's
brief names the files, not their web path); `make web` copies them there.

### Pipeline-internal JSON (not web-facing)

Paths relative to `data/interim/`. Checked with `tools/validate_contracts.py --interim data/interim`.

| Path | Schema | Producer → readers |
| --- | --- | --- |
| `horizon/horizons/{observer_id}.json` | `horizon.schema.json` | WS3 → WS4, WS8, WS9 (SPEC §2 F12) |
| `horizon/navcam_frames.json` | `navcam_frames.schema.json` | WS3 → WS4, WS9, WS10 (brief WS3) |
| `terrain/coverage.json` | `coverage.schema.json` | WS1 |
| `terrain/coreg.json` | `coreg.schema.json` | WS1 |

The glob tables are `SCHEMA_MAP` and `INTERIM_SCHEMA_MAP` in `tools/validate_contracts.py`.
JSON files that match no pattern produce a warning, not a failure. First match wins and patterns
must not overlap (`tests/test_contracts.py` checks every pair). A few rules JSON Schema cannot
express in the keyword subset of the browser checker (`web/src/data/schema.ts`) are checked by
`SEMANTIC_CHECKS` in the same file (v1.1.4: the parking-option index and summaries).

### Dummy flag

Every **index** file (`scenarios/index.json`, `fields/index.json`, `fp3d/index.json`,
`scenarios/pads/index.json`) and `pad.json` has a required boolean `"dummy"`: `true` in `data-dummy/`, `false` in `data/`. Other
object-shaped files may carry an optional `"dummy"`. CI fails if any file under
`web/public/data/` has a top-level `"dummy": true`, or if an index file under `data-dummy/` lacks
`"dummy": true`.

## Non-JSON formats

### Field PNGs — `fields/{scenario}/{name}.png` (SPEC §6.1), `fields/fix_interval_{set}.png` (SPEC §6.2)

- One image per field over the planning extent at 5 m (`config/hud.yaml` `field_png.res_m`;
  ≈ 1,480 × 1,480 px).
- 8-bit RGBA PNG. Value in counts = `R·256 + G`; B = 0; A = 255 valid, A = 0 unknown. Physical
  value = counts × `scale` from `fields/index.json` (browser canvases drop 16-bit PNG precision).
- Units per count (`config/hud.yaml` `field_scales`):

| Field | Per count | Scenarios |
| --- | --- | --- |
| `t_home` | 0.1 min | all 9 return scenarios |
| `o2_home` | 0.01 L | all 9 |
| `home_bearing` | 0.01° | `nom_104` |
| `slope` | 0.01° | shared |
| `t_home_worst_{10,50,100}`, `o2_home_worst_{10,50,100}` | as above | `nom_104` |
| `fix_interval_{set}` (D_max) | 1 m | per nav set |

- Every field PNG is listed in `fields/index.json` (`bounds [w, s, e, n]`, `width`, `height`,
  `res_m`, `fields.{name}: {file, scale, units, scenario}`).
- **`pointer` uses its own grid (v1.1.1).** `fields/{scenario}/pointer.png` is WS2's way-home
  pointer (`engine/{scenario}/pointer.tif`) on WS2's native 3 m route grid (`grid.json route_3m`),
  not the 5 m fields grid: a move index cannot be resampled. Its entry carries its own `bounds`,
  `width`, `height`, `res_m` (3) and a `stencil` ([drow, dcol] per move, from WS2
  `pointer_offsets.json`); `scale` 1, `units` "move"; counts = move index k, next pixel =
  (row + drow[k], col + dcol[k]), rows north to south; A = 0 = no move (pad or unreached).
  Writer: WS7 `pipeline/export/fields_png.py --with-pointer`. An entry without its own grid keys
  uses the top-level grid.

### 3D files — `fp3d/` (SPEC §6.1, F20; brief WS8)

| File | Format |
| --- | --- |
| `fp3d/index.json` | Chunk grid, bounds, height scale (JSON, schema above) |
| `fp3d/near/{i}_{j}.f32.gz` | Near height chunk: 256 × 256 Float32 heights at 1 m, gzipped; corridor ≈ 300 m wide along the route |
| `fp3d/near_tex/{i}_{j}.jpg` | JPEG texture for the matching near chunk |
| `fp3d/far.f32.gz` | Far heights: Float32 at 8 m over the planning extent, gzipped |
| `fp3d/far_tex.jpg` (v1.1.2) | JPEG ortho texture (8 m) over the far mesh; placement in `fp3d/index.json` (WS8) |
| `fp3d/horizon_ring.json` | Far skyline ring (JSON, schema above) |

Byte order, row order and the height-scale/offset convention are not fixed by SPEC; WS8 records
them in `fp3d/index.json`. Total 3D download ≤ `config/hud.yaml` `performance.budget_3d_mb`.

### Station images — `cards/{station}/panorama.png`, `overlay.png`, `navcam.png` (brief WS3)

PNG. `panorama.png` is the predicted panorama strip; `overlay.png` is a transparent skyline overlay
on the Navcam frame (`navcam.png`). Paths are referenced from `cards/{station}.json`.

### Station cards — `cards/{station}.json` (v1.1.1, merged by `make web`)

C decision 2026-11-14 11:42: two producers, one file. WS3 writes
`horizon/public/cards/{S}.json` (`navcam`, `skyline_error_deg`, `panorama_png`, `landmarks`, plus
`observer`, `provisional`, `skyline_error_scope`, `landmarks_note`); WS2 writes
`engine/public/cards/{S}.timeline.json` (`timeline`, `margin_binding`, `contingency`, plus
`scenario`, `on_route`, `margin_min`, `t_home_min`, `o2_home_L`, `science`, `access`). `make web`
merges them key by key (nothing computed) and records the parts in `parts`. A station lacking
either part gets **no card** (reported missing under the absent part's owner; its images are not
copied). Parts that disagree (station id, a key set by both, science point, or WS3's observer not
at WS2's access cell) stop the run. The `*.timeline.json` parts never reach the web tree.

Access block (`access`, user decision 11:40, access-cell rule): `lon`/`lat` of the access cell
(null = none within `radius_m`), `dist_m` (= `access_dist_m`, science point to access cell),
`t_home_min`/`o2_home_L` from the access cell, `reason` when there is none, `walk_in` (straight
line, **not modelled**: `dist_m`, `rise_m`, `mean_slope_deg`, `max_slope_deg`,
`max_terrain_slope_deg`), `radius_m`, `rule`. `science` is the unmoved science point. A station
with no access cell or not on the route has null `timeline` times and `margin_binding: null`.

### Horizon ring — `fp3d/horizon_ring.json` (v1.1.1, WS3 layout)

One object: `observer` {`lon`, `lat`, `eye_height_m` required; `id`, `x`, `y`, `z_ground_m`,
`z_eye_m`, `source`}, `az_step_deg`, `max_range_m`, `az_deg[]`, `elev_deg[]` (required), and
optional parallel arrays `dist_m[]`, `z_m[]` (areoid height of the horizon point), `east_m[]`,
`north_m[]` (offsets from the observer, analysis CRS), `source[]` (band), plus `min_range_m`
(only terrain beyond it counts; the near mesh covers the rest), `crs`, `azimuth_convention`
(deg clockwise from grid north), `radius_m`, `notes`. Every array has one value per azimuth;
null = unknown. `elev_deg` includes the curvature drop d²/2R. The M0 dummy ring (no distances) is
the minimal form; WS8's `ring.ts` reads both.

### Basemap tiles — `tiles/basemap/{z}/{x}/{y}.webp` + `tiles/basemap/tilejson.json` (v1.1.0)

WS1 writes XYZ PNG tiles of the HiRISE colour ortho (`data/interim/terrain/tiles/basemap/`,
z13–18, 256 px). `make web` re-encodes them to WebP (`config/web.yaml web_export.basemap`: quality
80; if the tiles exceed `budget_mb` 50 the top zoom is dropped, z18 first) and writes
`tilejson.json` describing exactly the tiles written:

- `tiles`: URL template **relative to the data root** (`tiles/basemap/{z}/{x}/{y}.webp`); the app
  prefixes its data base URL. `scheme` `xyz`; Mars lon/lat pass straight through (D4).
- `minzoom`, `maxzoom`, `bounds` [w, s, e, n] (tile extent of the zooms that tile the whole
  window), `attribution`, `tileSize`.
- `zoom_bounds` {"17": [w, s, e, n], ...}: zooms tiled over a smaller area (WS1 tiles z17–18 over
  the focus area only). A client that wants no 404s uses one source for minzoom..(first
  zoom_bounds key − 1) with `bounds`, and one per partial zoom range with its `zoom_bounds`;
  otherwise MapLibre simply shows nothing where a z17/z18 tile is absent.

For WS5's `BasemapSource`: `tiles` (prefixed), `tileSize`, `minzoom`, `maxzoom`, `bounds`,
`attribution` map one to one.

### Cell states — `terrain/cellstate.png` + `terrain/cellstate.json` (v1.1.0)

The F1 routing-grid cell states, so the app can hatch unknown terrain (and show blocked cells).
`make web` writes them from WS1's `cellstate_3m.tif` (one PNG pixel per 3 m routing cell, rows
north to south; nothing resampled). Encoding as the field PNGs: 8-bit RGBA, counts = `R·256 + G`
= state for known cells (0 assessed, 1 blocked), B = 0, **A = 255 known, A = 0 unknown** (state 2:
non-HiRISE or no data). `cellstate.json` gives `image`, `bounds` [w, s, e, n] of the outer pixel
edges (lon/lat; the analysis CRS is equirectangular, so the grid is axis-aligned in lon/lat),
`width`, `height`, `res_m`, `variant` (`nominal` = 20° no-go; `conservative` once WS1 writes
`cellstate_3m_conservative.tif`), `codes`, and `pct` (share of the image in each state; manifest
keys `terrain.cellstate.pct.*`). WS5: hatch where A = 0, exactly as the field-alpha hatch, placed on
`bounds` as a MapLibre image source. The dummy tree has a 5 m version (`res_m` says which).

**Conservative (v1.1.2):** `terrain/cellstate_conservative.png` + `.json`, same encoding, grid and
schema, from WS1's `cellstate_3m_conservative.tif` (blocked iff the cell's max 1 m slope >
20° − V1 `rmse_deg` = 14.553°; unknown stays unknown). `variant: conservative` (from the file name);
manifest keys `terrain.cellstate_conservative.pct.*`. Display and checks only: WS2's con_* runs
re-derive passability from `maxslope_3m.tif` (same rule). Not in the dummy tree.

### Rover parking options — `scenarios/pads/` (v1.1.4, D21)

User decision D21 (16:14), C file layout 16:17. The official pad (`pad.json` `pad`, every main
scenario file, the HUD, the 3D view and the station cards) is the candidate with the most feasible
EVAs. The picker offers the next candidates (+ `pad_default` when not among them) at the default
scenario's suit (nominal, 104 kg) only:

- `scenarios/pads/index.json` (**index**, `dummy` required): `pads[]` rows {`id`, `lon`, `lat`, `elev_m`, `rank`, `score`
  (feasible-EVA count), `official`, `tiebreak` {name: value}; optional `kind`, `picker`,
  `summary`, `screen_score`, `screen_rank`, `label`, and on the official row `files` / `route`};
  optional top-level `official` (id), `scenario`, `score_kind`, `order`, `decision`, `screening`.
  **Exactly one row has `official: true`, and its id equals `official` when given** (checked by
  `validate_contracts.py`); a row with `picker: true` is not official and names its
  `summary` (`scenarios/pads/{id}/summary.json`). Ids are plain file names.
- `scenarios/pads/{id}/summary.json`: `id` (= folder), `pad` {lon, lat, elev_m}, `rank`, `score`,
  `headline` {"30": {`reachable_pct`, `range_pct` [con, opt], `budget_min`}, "60": …} (key =
  the budget; WS2 also writes `budget_min`, which must then equal the key; the 60-min % and either
  range end may be null), `route` {`stops`, `total_min`, …}
  or null; optional `kind`, `scenario`, `official`, `score_kind`, `tiebreak`, `files`, `note`.
- `bands_{suit}.geojson`, `edges.geojson`, `partner.geojson`, `route_{scenario}.geojson`,
  `timeline_{scenario}.json` next to it: the same contracts as the main files. **No isochrones
  and no field PNGs** for parking options; their rasters stay in `data/interim/`.
- Manifest keys `pads.{id}.*` (WS2 `padpick.py`; e.g. `pads.{id}.score`,
  `pads.{id}.headline.30.range_pct.low`, `pads.{id}.route.leg.{i}.t_min`,
  `pads.{id}.timeline.{i}.t_min`).

The dummy tree has a small set (`rank1` = the dummy pad, two options `rank2`, `rank3`; docs/dummy.md).

### Siting heatmap — `siting.png` + `siting_png.json` (v1.1.0)

Grey PNG of the F8 siting score (WS2 `pipeline/engine/siting.py`; white = `grey_max_score`).
`siting_png.json` `coordinates` are the 4 image corners as [lon, lat] in MapLibre image-source order
(top-left, top-right, bottom-right, bottom-left).

### Rasters — `data/interim/` (pipeline-internal; briefs WS1, WS2)

GeoTIFF COG in the analysis CRS (SPEC §4.2, `config/site.yaml`), float32 unless stated. See the
"Produces" tables in `briefs/WS1.md` and `briefs/WS2.md`. Not validated by
`tools/validate_contracts.py`.

## `make web` sources (tools/make_web.py `RULES`)

`make web` empties `web/public/data/` and fills it only from these producer paths (relative to
`data/interim/`); a source with top-level `"dummy": true` / `"synthetic": true`, or written before
H0, stops the run. Every expected output that is absent is listed as missing under its owner.
`make web-plan` prints the plan without writing; `--skip-owner WSn` leaves an owner out (e.g. while
its run is in progress), with its manifest entries.

| Owner | Source (`data/interim/…`) | Web path |
| --- | --- | --- |
| WS1 | `terrain/coverage.json`, `coverage.png`, `coreg.json` | `validation/…` |
| WS1 | `terrain/cellstate_3m.tif` | `terrain/cellstate.png` + `.json` (transform) |
| WS1 | `terrain/cellstate_3m_conservative.tif` | `terrain/cellstate_conservative.png` + `.json` (transform, v1.1.2) |
| WS1 | `terrain/tiles/basemap/{z}/{x}/{y}.png` | `tiles/basemap/{z}/{x}/{y}.webp` + `tilejson.json` (transform) |
| WS2 | `engine/public/**` (mirror of the web tree: `scenarios/`, `stations.json`, `route_*`, `timeline_*`, `trade_table.json`, `pad.json`, `siting.png`, `siting_png.json`) | same path |
| WS2 | `engine/public/scenarios/pads/{index.json, */summary.json, */bands_*.geojson, */edges.geojson, */partner.geojson, */route_*.geojson, */timeline_*.json}` (v1.1.4, D21) | same path; nothing else under `pads/` (no isochrones, no rasters) |
| WS2 | `engine/public/physio/golden.json` (v1.1.5, D41) | `physio/golden.json` |
| WS3 | `horizon/validation/v2.json` | `validation/v2.json` |
| WS3 + WS2 | `horizon/public/cards/{S}.json` + `engine/public/cards/{S}.timeline.json` | `cards/{S}.json` (merged, see "Station cards") |
| WS3 | `horizon/public/cards/{S}/*.png` (built cards only), `horizon/public/fp3d/horizon_ring.json` | same path |
| WS4 | `conditions/{rad,clock,rems,donki}.json` | `conditions/…` |
| WS6 | `validation/v1.json`, `v1.svg`, `kats.json` | `validation/…` |
| WS7 | `export/fields/index.json`, `export/fields/{scenario}/*.png` | `fields/…` |
| WS8 | `export/fp3d/{index.json, near/*.f32.gz, near_tex/*.jpg, far.f32.gz, far_tex.jpg}` | `fp3d/…` |
| WS9 | `navigation/{nav,localisation,fields}/…` (real run only) | same path |
| WS10 | `vo/probe.json`, `vo/drift.json` | `vo/…` |

**Withheld (`WITHHELD` in `tools/make_web.py`):** a web path a producer writes but that must not
be published yet is reported as `withheld: …` (not copied, not "missing"), and manifest entries
citing it are left out. Now: none (`pad.json` was withheld 14:58–15:30, C decision, until WS2
wrote the pad in use into `pad` and the F8 result into `proposal`).

`make web` also reports as DANGLING a parking-option `summary` named in `scenarios/pads/index.json`
or a file named in a summary's `files` that is not in the public tree (v1.1.4).

Manifest: every fragment in `data/interim/manifest/` is merged (WS6 `manifest.merge`); WS1's
`terrain/manifest_pending.json` is merged as WS1's fragment until WS1 records through
`pipeline.provenance.manifest.record` (WS1 has since 11:36Z, so the bridge is idle). Fragments made by the dummy generator are refused. An entry
whose `file` is a web path that this run does not write (a skipped owner, a missing output, a card
not built) is left out, as is a skipped owner's entry citing its `data/interim/` source; entries
citing other pipeline-internal `data/...` files stay.

### Size

No file in git may exceed 50 MB (AGENTS.md rule 9). `tools/validate_contracts.py` checks the two
data trees; CI also checks every tracked file.

## Backend family

The live API's contracts (F23–F36, kit K1/K4, D50–D57) are their own family, **v1.0.1, frozen at
backend gate P0**, in `contracts/backend/` (see its README): `plan_inputs.schema.json` (user
inputs, D52), `run_record.schema.json` (`results/{hash}/run_record.json`), `job.schema.json`,
`telemetry.schema.json` (telemetry sample batch + state event), `openapi.yaml` (API v1, spec §5) and
`examples/`. They sit in a subfolder, like `contracts/bundle/`, because every top-level
`*.schema.json` here maps to a web data path. They do not change this README's 1.1.x version.

- **Result hash (D57):** `sha256(canonical_inputs \0 engine_tree \0 engine_config_hash \0 terrain_hash)`,
  first 16 hex; canonical inputs = defaults filled, `title` removed. Full rule:
  `contracts/backend/README.md` "Result hash".
- **Share code (D55):** `HL-` + 6 Crockford base32 characters (`^HL-[0-9A-HJKMNP-TV-Z]{6}$`).
- **Result tree:** `results/{hash}/` = the web contracts above (same paths) + `run_record.json`.
- Tests: `tests/test_backend_contracts.py`.

## Changes

### v1.1.0 (2026-11-14, C) — additive; every new property is optional unless in a new schema

| Schema | Change | Consumers |
| --- | --- | --- |
| `partner.schema.json` | feature properties `case`, `casualty_kg`, `contour_min`, `style` (const `dashed`), `default_visible` (const `false`), `caption`, `feasible`, `area_km2` (WS2 `haul.py`) | WS5 |
| `route.schema.json` | leg properties `leg`, `from`, `to`, `t_min`, `o2_L`, `length_m`, `t_start_min`, `t_end_min`, `times_min[]` (one per vertex) (WS2 `traverse.py`) | WS5, WS8, WS9 |
| `timeline.schema.json` | row properties `margin_binding` (`O2`/`daylight`/`dose`/null), `in_partner_line`, `o2_tasks_left_L`, `o2_margin_min_planning_rate`; `event` values documented (`depart`, `arrive`, `leave`, `return`, `turn_back`, `o2_checkpoint`) | WS5, WS7, WS9 |
| `rad.schema.json` | `leash.tau_min_at_latest`, `formula`, `D_allow_note`, `table[]` ({`D_allow_mGy`, `tau_min_at_peak`, `tau_min_at_latest`}, one row per D9 slider step), `d_allow_range_mgy`, `d_allow_step_mgy` | WS5 (D9 slider) |
| `siting_png.schema.json` (new) | `siting_png.json` | WS5 |
| `tilejson.schema.json` (new) | `tiles/basemap/tilejson.json` | WS5 |
| `cellstate.schema.json` (new) | `terrain/cellstate.json` (+ PNG format above) | WS5 |

D9 slider: the range and step are config values (`config/conditions.yaml leash.d_allow_range_mgy`,
`leash.d_allow_step_mgy`), read at build time; `rad.json leash.table` carries τ for every step of
that range (its first and last `D_allow_mGy` are the range). There is no
`leash.d_allow_slider_mgy` key.

### v1.1.1 (2026-11-14, C) — additive; every new property is optional

| Schema | Change | Consumers |
| --- | --- | --- |
| `card.schema.json` | `margin_binding` may be **null** (no route or no access cell, e.g. S1); optional `station`, `scenario`, `on_route`, `margin_min`, `t_home_min`, `o2_home_L`, `science` {lon, lat}, `access` {lon, lat, dist_m, t_home_min, o2_home_L, reason, walk_in, radius_m, rule}, `observer`, `provisional`, `skyline_error_scope`, `landmarks_note`, `parts`, `dummy`; navcam `stop_id`, `dist_to_observer_m`, `credit`; landmark `kind`, `above_skyline`. Merged by `make web` (above) | WS5 (station card, cuff: render a null binding as "none"), WS7 |
| `stations.schema.json` | `access_radius_m`, `access_lon`, `access_lat`, `access_dist_m`, `access_reason` (default scenario), `access` {scenario: access record} (WS2 Q12). `lon`/`lat` stay the science point; `t_home_min` is from the access cell | WS5, WS8, WS9 |
| `timeline.schema.json` | station rows: `access_dist_m` | WS5, WS7, WS9 |
| `route.schema.json` | leg property `to_access_dist_m` | WS5, WS8, WS9 |
| `horizon_ring.schema.json` | WS3's layout (above); now an object only | WS8 |
| `fields_index.schema.json` | optional per-entry `bounds`, `width`, `height`, `res_m`, `stencil` (pointer on its own 3 m grid; WS7 proposal) | WS7, WS5 |

`SCHEMA_MAP` is unchanged (`cards/*.json` is safe: the `*.timeline.json` parts are never copied to
the web tree; one there would fail the card schema).

### v1.1.2 (2026-11-14, C) — additive; every new property is optional

| Schema / path | Change | Consumers |
| --- | --- | --- |
| `partner.schema.json` | D20 (user 14:22, cart only): feature properties `label`, `drag_note` (`caption` already there); top-level `drag_finding` {`case`, `theta_deg`, `suit_kg`, `casualty_kg`, `rescuer_system_kg`, `mu`, `boot_mu`, `g_ms2`, `force_N`, `traction_limit_N`, `max_mass_kg`, `feasible`, `reason`, `note`} (WS2 `haul.drag_flat`; manifest `haul.drag.flat.*`, file `scenarios/nom_104/partner.geojson`; per suit `haul.drag.flat.nom_{suit}.*`). Drag is text, never a line | WS5 |
| `card.schema.json` | `drag_note` (WS2 timeline part) | WS5 |
| `pad.schema.json` | C decision 14:58: `pad` is the pad in use (`config/site.yaml pad_default`, user 11:24), never the siting result; optional `pad.source`; optional `proposal` {`adopted` (const false), `note`, `pad` (required, same shape), `alternatives`, `hop_options`, `site_rule_version`} for the F8 result. Until WS2 writes it that way, `make web` withholds `pad.json` | WS2 (writer), WS5 (marker: pad from `pad`, never from `proposal`) |
| `cellstate.schema.json` + `SCHEMA_MAP` | new web path `terrain/cellstate_conservative.json` (+ `.png`), same schema; `variant: conservative`; keys `terrain.cellstate_conservative.pct.*` | WS5 (optional conservative hatch) |
| `fp3d/far_tex.jpg` (format table) | new non-JSON file, WS8 far-mesh texture; `make web` copies `data/interim/export/fp3d/far_tex.jpg` | WS8 |

### v1.1.3 (2026-11-14 16:26, C, for WS2 D28)

- `timeline.schema.json`, `card.schema.json`: `margin_binding` may be `"EVA duration"` (D28: turn-back = min over all constraints incl. EVA budget − T_home). Card: optional `turn_back_binding` (same enum). Consumers: WS5 (labels), WS7 (HUD binding text).

### v1.1.4 (2026-11-14, C, for D21 and D33) — additive; new schemas for new files only

| Schema / path | Change | Consumers |
| --- | --- | --- |
| `pads_index.schema.json` (new) + `SCHEMA_MAP` `scenarios/pads/index.json` | D21 ranking table (above); index file (`dummy` required); exactly one official row (semantic check) | WS5 (picker) |
| `pad_summary.schema.json` (new) + `SCHEMA_MAP` `scenarios/pads/*/summary.json` | D21 parking-option summary; `headline` entries carry `budget_min`, `range_pct` = [con, opt], the 60-min % may be null | WS5 |
| `SCHEMA_MAP` `scenarios/pads/*/{bands_*.geojson, edges.geojson, partner.geojson, route_*.geojson, timeline_*.json}` | reuse `bands`, `edges`, `partner`, `route`, `timeline` (four path segments: no overlap with the scenario rows) | WS5 |
| `pad.schema.json` | `pad` = the D21 official pad; optional `pad.id`, `pad.score_kind`, `pad.tiebreak`, `pad.f8_score`; `alternatives[]` `id`, `kind`, `score_basis`, `d21_rank`, `tiebreak`, `picker`, `f8_score`, `note`; top-level `d21` block (WS2 session 7) | WS5 (pad marker, F8 text) |
| `card.schema.json` | landmark `display`: `label` (above the computed skyline) or `bearing_tick` (below it, bearing-only compass tick; D33, WS3 session 5) | WS5 (station card compass) |
| `tools/make_web.py` | WS2 rules for `scenarios/pads/**` (the seven patterns only); DANGLING check for `summary` / `files` references | C |
| dummy tree | `scenarios/pads/` set (3 rows, 2 options), `make dummy` deterministic | WS5 |

### v1.1.5 (2026-11-14 ~18:15, C, for WS2 session 8 and D41/D43/D45 of set A) — additive; every new property is optional

| Schema / path | Change | Consumers |
| --- | --- | --- |
| `golden.schema.json` (new) + `SCHEMA_MAP` `physio/golden.json` + `make web` rule (WS2 `engine/public/physio/golden.json`) | D41 golden vectors: envelope only (`version`, `kind` = `homeline_physio_golden`, `tolerances.{group}` {rel, abs ≥ 0}, `cases.{group}[]` with `id`); the case layout is WS2's, documented in the file. Referenced from every plan bundle | simulator (C# port), WS5 if shown |
| `scenarios_index.schema.json` | optional per-scenario `headline_60` {`budget_min`, `reachable_pct`, `range_pct` (required), `basis` (e.g. `in_data`), `in_data_pct`, `label`} (D43: share over the in-data part of the 60-min circle, labelled with that part's size) | WS5 |
| `pads_index.schema.json` (rows), `pad_summary.schema.json` | optional `feasible` {`screen_count`, `full_run_count`, `excluded_by_effort_cap_rule` (all three required in the block), `note`} (D45) | WS5 (picker) |
| `trade_table.schema.json` | optional per-cell `in_data_pct` (60-min row, D43) | WS5 |

Checked against WS2 session 8's real interim files (`scenarios/index.json`, `scenarios/pads/**`,
`trade_table.json`, `physio/golden.json`): 0 errors.

## Design contracts v1 (DESIGN §6; D3)

A separate family for the design block (WS15–WS18), **v1.0.0, frozen at merge**: an additive change
is a minor bump (1.1.0, …); a breaking change is human-gated. Each schema carries its
`"x-contract-version"` (1.0.0, except `terrain_tiles.schema.json` 1.1.0: optional
`vertical_offset_m`, P2c) and says "Design contracts v1" in its description. Producers: WS16
(`pipeline/export/labels.py`, `terrain_tiles.py`, `relief_lowzoom.py`, `highlights.py`; storyboards
by hand). Tests: `tests/test_design_contracts.py`.

| Data path | Schema / doc | Source |
| --- | --- | --- |
| `labels.json` | `labels.schema.json` (`version` "1"; kinds from `config/design.yaml labels.priority`) | §6.2, U13 |
| `web/public/story/{id}.json` (not under the data root) | `storyboard.schema.json` (`version` "1"; camera absolute lon/lat or `target` code) | §6.3, U6 |
| `terrain/tiles.json`, `terrain_low/tiles.json` (+ `{z}/{x}/{y}.png`, Terrarium, elevation × 1.878) | `terrain_tiles.schema.json` | §6.1, U1 |
| `highlights/{ridges,mineral,blocked}.geojson` | `highlights.schema.json` (`preliminary` flag until R9) | §6.1, U7 |
| field layer (shader uniforms, texture decode, `fieldAt`) | `field_shader.md` | §6.4, U2, U3 |

Not yet in `SCHEMA_MAP` (C's `tools/validate_contracts.py` + `web/src/data/contracts.ts`): the
three data paths above need rows there once the producers write them; the storyboard path is
outside the data root and is checked by `tests/test_design_contracts.py`.

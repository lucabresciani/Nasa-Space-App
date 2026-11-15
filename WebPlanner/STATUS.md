# STATUS

One section per session (AGENTS.md "Repo rules"). Each session updates only its own section at every milestone. Timestamps in UTC (ISO 8601 with Z, `config/event.yaml`).

## B0 Bootstrap

Branch: `main`

### Done

- 2026-11-14T09:34Z: SPEC.md, AGENTS.md, briefs/, docs/ exported from Notion; config/*.yaml (11 files) copied verbatim.
- Scaffold: pyproject (uv, Python 3.11), Makefile stubs, pipeline/ tree (SPEC §4.3), web/ Vite + TS skeleton, LICENSE, `data` -> ~/hl-data symlink.
- 2026-11-14T09:34Z: pushed skeleton to origin/main.
- 2026-11-14T09:39Z: contracts v1.0.0 (32 schemas, contracts/README.md), tools/validate_contracts.py, tests/test_contracts.py.
- CI workflow `.github/workflows/ci.yml`: ruff, pytest, tsc --noEmit, vite build, contract validation, no-dummy-in-public, 50 MB size check; all steps green locally.

### Doing

- —

### Next

- WS6 adds the H0 provenance check (`pipeline/provenance/check_h0.py`) to CI.
- Producers propose structures for the loose schemas (partner, route, horizon_ring, coverage, rems, clock, fp3d_index details) to C.

### Blocked

- —

### Assumptions added

- Web paths `validation/coverage.json` and `validation/coreg.json` (brief WS1 names the files only).
- `fp3d/index.json` key names `bounds`, `chunk_grid`, `height_scale` (SPEC §6.1 gives the content only).
- `nav/fix_interval_summary.json` is one file with a `set` field, as SPEC §6.2 writes it.

## M0 Dummy data

Branch: `m0-dummy`

### Done

- 2026-11-14T09:49Z: `tools/make_dummy.py` per docs/dummy.md against contracts v1.0.0: deterministic (seed 20261114), offline, ~15 s; writes 135 files, 8.5 MiB to `web/public/data-dummy/` (fields 4.4 MiB, scenarios 3.7 MiB, fp3d 0.8 MiB). Every index file and every other object-shaped JSON file has `"dummy": true`.
- Files: `scenarios/index.json` (nom_104, opt_104, con_104), isochrones 1–60 min, `bands_104`, edges (physiology/slope/data), partner circles; `fields/index.json` + 17 PNGs (t_home, o2_home ×3 scenarios; home_bearing, 6 worst-case fields for nom_104; shared slope; `fix_interval_medium`); `stations.json`, `cards/S1–S3.json` + grey placeholder; `route_nom_104.geojson`, `timeline_nom_104.json`; `trade_table.json`; `pad.json`; `conditions/rad.json`; `nav/montecarlo_medium.json`, `nav/fixes.json`, `nav/tracks_medium.geojson`, `nav/fix_interval_summary.json`; `fp3d/index.json`, 45 near chunks + tan textures, `far.f32.gz`, `horizon_ring.json`; `manifest.json` (every dummy number, script `tools/make_dummy.py`).
- `make dummy` wired. `tests/test_make_dummy.py` (15 tests): determinism (two runs byte-identical), every file validates via `tools/validate_contracts.py` with no warnings, dummy tree fails as public data, size ≤ 10 MB, PNG encoding KATs (T_home = 0 at the pad, hole unknown, worst ≥ point), station T_home = field, RAD tripwire before peak + leash recomputes, nav r95 = 2% of distance, fp3d chunk sizes and 3D budget, committed tree = fresh run.
- ruff, pytest (86 passed), validate_contracts all green.

### Doing

- —

### Next

- Regenerate with `make dummy` if a contract or config format setting changes (the committed-tree test fails when the tree is stale).

### Blocked

- —

### Assumptions added

- Dummy-only constants (synthetic world, speeds 0.9/1.0/0.8 m/s, 0.25 L/min O2, storm shape) live at the top of `tools/make_dummy.py` with `DUMMY_` names; they are not in `config/` because they must never reach the real pipeline.
- Manifest `utc` is fixed at `2026-11-14T09:00:00Z` and `commit` is `"dummy"` so the output is byte-deterministic (after `h0_utc`, so the H0 check passes).
- Also generated `pad.json` and `nav/fix_interval_summary.json` (not listed in docs/dummy.md, but the contracts define them and pad.json requires `dummy`).
- Field index keys are `{scenario}/{name}`, `slope` (shared, `scenario: null`, file `fields/shared/slope.png`) and `fix_interval_medium` (`scenario: nom_104`).
- The synthetic terrain is defined over the whole planning extent (the 2 × 2 km tile places the features); the CTX strip runs N–S across the extent. Its cells keep valid T_home and are only labelled `data` at edges; the nodata hole and wall cells are unknown (A = 0).
- Timeline `o2_left_L` starts from `crew.yaml o2_budget.primary_L` (504 L); margin = EVA − reserve − t − T_home.
- Card landmarks are synthetic (`DUMMY synthetic hill`, `DUMMY synthetic wall`, `Pad`), since real ones need H0-verified coordinates.
- `fp3d/index.json` `chunk_grid` holds `cols`, `rows`, `chunk_px`, `res_m`, `origin_xy_m`, `crs`, `chunks[]`; the extra keys `height`, `far`, `horizon_ring` record byte order (little-endian float32), row order (north to south) and the pad-relative datum (WS8 may refine).

## D0 Discovery

Branch: `d0-discovery`

### Done

- —

### Doing

- —

### Next

- —

### Blocked

- —

### Assumptions added

- —

## C Integration

Branch: `c-integration` (merged to `main` by the orchestrator)

### Done

- 2026-11-14T10:35Z: **contracts v1.1.0** (additive; consumer notes in contracts/README.md "Changes"):
  - `partner` (WS2 Q7): feature properties `case`, `casualty_kg`, `contour_min`, `style` (const
    `dashed`), `default_visible` (const `false`), `caption`, `feasible`, `area_km2`; optional.
  - `route` (WS2 Q7): leg properties `leg`, `from`, `to`, `t_min`, `o2_L`, `length_m`,
    `t_start_min`, `t_end_min`, `times_min[]`; optional.
  - `timeline` (WS2 Q7): `margin_binding` (`O2`/`daylight`/`dose`/null), `in_partner_line`, plus
    `o2_tasks_left_L` and `o2_margin_min_planning_rate` (WS2's code writes them); `turn_back` and
    the other event names documented; optional.
  - `rad`: `leash.tau_min_at_latest`, `formula`, `D_allow_note`, `table[]`, `d_allow_range_mgy`,
    `d_allow_step_mgy`; optional.
  - New: `siting_png.schema.json` (`siting_png.json`, WS2), `tilejson.schema.json`
    (`tiles/basemap/tilejson.json`), `cellstate.schema.json` (`terrain/cellstate.json` +
    `terrain/cellstate.png`, F1 cell states: A = 0 unknown).
  - Checked against WS2's code: WS2's engine tests (origin/ws2-engine 4c54e5e) pass with v1.1.0;
    WS2's real run (10:30Z) and WS4's real `rad.json` validate.
  - `SCHEMA_MAP` rows mirrored in `web/src/data/contracts.ts`; version assertions in
    `tests/test_contracts.py` and `web/src/data/contracts.test.ts` accept 1.0.0/1.1.0;
    `web/src/data/loader.test.ts` uses another uncovered path (tilejson is now covered).
  - Dummy tree: `terrain/cellstate.{png,json}` added (5 m, `"dummy": true`); `make dummy`
    regenerated, every other file byte-identical.
- 2026-11-14T10:35Z: **`tools/make_web.py`, `make web`, `make web-plan`** (KATs
  `tests/test_make_web.py`, 17 pass): copies `data/interim/**` to the contract paths in
  `web/public/data/` (table in contracts/README.md "`make web` sources"); refuses `"dummy"` /
  `"synthetic": true`, sources in `data-dummy/`, sources written before H0 and dummy manifest
  fragments, before touching the public tree; keeps producer mtimes; merges the manifest
  (WS6 `merge`), runs `validate_contracts` and `check_h0`; lists missing outputs by owner, files
  named by an index but absent, and size per folder. `--skip-owner WSn` leaves an owner and its
  manifest entries out. WS6 Blocked 4 (make web runs merge + check_h0) done.
- 2026-11-14T10:35Z: **Basemap (WS1 Blocked "basemap size") decided by C:** WebP quality 80,
  z13–18 all kept: **2,760 tiles, 33.1 MB** (from 292 MB PNG). `config/web.yaml` (new, C):
  format, quality, maxzoom 18, budget 50 MB (above it make web drops the top zoom, z18 first).
  `tiles/basemap/tilejson.json`: bounds = z13–16 extent, `zoom_bounds` for z17/z18 (focus only).
- 2026-11-14T10:35Z: **Real web data committed (WS2 skipped):** `make web --skip-owner WS2`:
  2,773 files, **36.3 MB** (tiles 33.1, validation 2.4, terrain 0.6, manifest 0.1, conditions
  0.1, vo); all validate, no dummy flag, largest file 1.6 MB (`validation/v2.json`), H0 check OK, manifest 299 keys.
  Present: WS1 (coverage, coreg, cell states, basemap), WS3 `validation/v2.json`, WS4
  `conditions/{rad,clock,rems,donki}.json`, WS10 `vo/probe.json`.
  Missing: WS3 cards + `fp3d/horizon_ring.json`; WS6 `validation/{v1.json,v1.svg,kats.json}`;
  WS7 fields; WS8 fp3d; WS9 nav/localisation/fix-interval; WS10 `vo/drift.json`.

- 2026-11-14T11:20Z: **Station cards merged by `make web`** (C decision 11:42; KATs
  `tests/test_make_web.py`, 39 pass): `cards/{S}.json` = WS3 `horizon/public/cards/{S}.json` +
  WS2 `engine/public/cards/{S}.timeline.json`, key by key, nothing computed; `parts` records both
  sources. A station lacking a part gets no card and no images (missing under the absent owner);
  parts that disagree (station, a key set twice, science point, WS3 observer not at WS2's access
  cell) stop the run. The `*.timeline.json` parts never reach the web tree (`SCHEMA_MAP` unchanged).
  **Result: S1, S2, S4 built.** S1: no access cell, null times, `margin_binding` null; S2: dose
  14.89 min, access 27.6 m; S4: dose 25.97 min, access 2.1 m. Far skyline errors 4.24 / 3.18 /
  6.50 deg (near/mid null; D7 pending).
- 2026-11-14T11:20Z: `make web` manifest: an entry citing a web file that the run does not write
  (skipped owner, missing output, card not built) is left out; a skipped owner's entries citing
  its `data/interim/` source too (WS8's `data/interim/export/fp3d/index.json` keys leaked before).
- 2026-11-14T11:20Z: **contracts v1.1.1** (additive; contracts/README.md "Changes"):
  - `card`: `margin_binding` may be null; optional access block (`science`, `access` {lon, lat,
    dist_m = access_dist_m, t_home_min, o2_home_L, reason, walk_in (not modelled), radius_m,
    rule}), `scenario`, `on_route`, `margin_min`, `t_home_min`, `o2_home_L`, WS3 extras.
  - `stations` (WS2 Q12): `access_radius_m`, `access_lon/lat`, `access_dist_m`, `access_reason`,
    `access` {scenario: record}; `timeline` rows `access_dist_m`; `route` legs `to_access_dist_m`.
  - `horizon_ring`: WS3's layout (object; observer, az_step_deg, max_range_m, az_deg, elev_deg
    required; dist_m, z_m, east_m, north_m, source, min_range_m optional). Dummy ring validates
    unchanged (no `make dummy` needed).
  - `fields_index`: WS7's pointer proposal, per-entry `bounds`/`width`/`height`/`res_m` +
    `stencil` (pointer on WS2's 3 m grid; README notes the own grid).
  - Real WS2 stations/timeline/route and WS3 ring validate. Version assertions in
    `tests/test_contracts.py` and `web/src/data/contracts.test.ts` accept 1.1.1.
- 2026-11-14T11:30Z: **Real web data committed (WS8 skipped):** after merging main (WS7 cde10c1,
  WS9 2b976dc), `make web --skip-owner WS8`: 2,877 files, **147.9 MB** (scenarios 79.5, tiles
  33.1, fields 29.1, validation 2.4, cards 2.2, terrain 0.6, nav 0.5, rest < 0.3). All validate,
  no dummy flag, H0 check OK, no dangling reference, no `*.timeline.json`, largest file 9.95 MB
  (`scenarios/opt_80/isochrones.geojson`), manifest 846 keys (WS8's 6 keys left out).
  Present: WS1 all; WS2 scenarios, stations, route/timeline nom_104, trade table (+ card parts);
  WS3 v2, ring, cards S1/S2/S4 + images; WS4 all 4; WS7 fields (20 PNGs + index); WS9 nav
  (montecarlo/tracks low/medium/high, fixes, fix-interval summary + 3 PNGs, localisation);
  WS10 probe + drift. Missing: WS2 `pad.json`, `siting.png`, `siting_png.json` (F8 waits on V1);
  WS6 `validation/{v1.json,v1.svg,kats.json}`. Skipped: WS8 (running, unmerged).

- 2026-11-14T14:20Z (session 3): **contracts v1.1.2** (additive; contracts/README.md "Changes"):
  - `partner` (D20): feature `label`, `drag_note`; top-level `drag_finding` (WS2 `haul.drag_flat`;
    keys `haul.drag.flat.*`). `card`: `drag_note`.
  - `cellstate` + `SCHEMA_MAP`/`contracts.ts`: `terrain/cellstate_conservative.json` (+ `.png`).
  - `pad` (C 14:58): `pad` = pad in use; optional `pad.source`, `proposal` {adopted: false, note,
    pad, alternatives, hop_options, site_rule_version}. **WS2: write `pad_default` into `pad` and
    the F8 result into `proposal`; until then make web withholds `pad.json`.**
  - Format table: `fp3d/far_tex.jpg` (WS8).
- 2026-11-14T14:20Z: **make web rules**: WS1 `cellstate_3m_conservative.tif` ->
  `terrain/cellstate_conservative.{png,json}` (keys `terrain.cellstate_conservative.pct.*`); WS8
  `fp3d/far_tex.jpg`; `WITHHELD` paths (reported, not copied, manifest entries dropped):
  `pad.json`; dangling check covers `fp3d/index.json` (chunks, textures, far, far_tex, ring).
  **Fixes:** cell-state keys are now recorded before the tracked public tree is rewritten (they
  were always `-dirty`, WS6 audit 1); make_web's own fragment is re-staged through the
  "file not written" filter. KATs first (`tests/test_make_web.py`, `tests/test_contracts.py`).
- 2026-11-14T14:20Z: **Real web data committed (all owners, after WS8 session 2 merged):**
  2,981 files, **201.5 MB** (scenarios 108.4, fields 41.9, tiles 33.1, fp3d 11.0, validation 2.7,
  cards 2.2, terrain 1.3, nav 0.5, rest < 0.5). All validate, no dummy flag, H0 OK, no dangling
  reference, largest file 9.95 MB. Manifest **1,052 keys**. New: WS2 con_* + cart-only partner
  (drag_finding, 32 `haul.drag.flat.*` keys), siting.png/.json; WS1 conservative cell states
  (blocked 45.86 % of the grid) + web-path keys; WS6 v1/v1.svg/kats; WS8 fp3d (85 files incl.
  far_tex). Withheld: `pad.json` (5 `pad.*` siting keys left out). `FP3D_REAL_CHECK=1` F20 vitest
  on the public tree: 17/17 pass. Git dir 103 -> 140 MB over the two publishes.
  **Still `-dirty`: WS7 72 keys (`fields_png.py` 78cb57d), WS9 172 (7908eda).** WS8's 6
  `fp3d.*` keys cite `data/interim/export/fp3d/index.json` (should be `fp3d/index.json`).

- 2026-11-14T16:45Z (session 4): **contracts v1.1.4** (additive; contracts/README.md "Changes",
  section "Rover parking options"). KATs first (`tests/test_contracts.py` +44, `tests/test_make_web.py` +3).
  - New `pads_index.schema.json` (`scenarios/pads/index.json`, index: `dummy` and `pads`
    required; rows `id`, `lon`, `lat`, `elev_m`, `rank`, `score`, `official`, `tiebreak`
    required, a `picker: true` row is not official and names its `summary`; top-level `official`
    id optional) and `pad_summary.schema.json` (`scenarios/pads/*/summary.json`: `id`, `pad`,
    `rank`, `score`, `headline` "30"/"60" {`reachable_pct` (may be null), `range_pct` [con, opt],
    `budget_min` optional = key}, `route` (or null)). Written from WS2's real files; extra keys
    allowed; required = what WS5's parsers need (WS5's provisional fixture in `pads.test.ts`,
    without top-level `official` and `budget_min`, validates too).
  - "Exactly one official row (= `official`)", "summary id = folder" and "headline key =
    budget_min" are `SEMANTIC_CHECKS` in `tools/validate_contracts.py` (the browser checker's
    keyword subset has no `contains`; WS5's `parsePadsIndex` enforces the official count too).
  - `SCHEMA_MAP` (+ `web/src/data/contracts.ts`, same order): `scenarios/pads/index.json`,
    `scenarios/pads/*/summary.json`, `scenarios/pads/*/bands_*.geojson` -> bands,
    `*/edges.geojson` -> edges, `*/partner.geojson` -> partner, `*/route_*.geojson` -> route,
    `*/timeline_*.json` -> timeline. `make web-plan` picks up all 25 WS2 pads files (WS2: 63
    present, 0 missing). New pytest: no two patterns of either map overlap (glob
    intersection per segment); vitest: every `PAD_SCHEMA_PATTERNS` row is mapped to its shape.
  - `pad.schema.json`: `pad` = D21 official pad; optional WS2 extras (`pad.id/score_kind/
    tiebreak/f8_score`, alternatives `id/kind/score_basis/d21_rank/tiebreak/picker/f8_score/note`,
    top-level `d21`). `card.schema.json`: landmark `display` enum `label` / `bearing_tick` (D33).
  - `make web`: WS2 rules for the seven `scenarios/pads/**` patterns (nothing else under pads/);
    DANGLING check for index `summary` and summary `files` references.
  - Dummy: `scenarios/pads/` (rank1 = the dummy pad, options rank2 beside the wall and rank3
    beside the hole, ranked by the D21 order on the synthetic model; 13 files, 0.36 MB, manifest
    +123 `pads.*` keys); `make dummy` byte-stable (all other files unchanged), 11 s.
  - **WS2's real files validate** (index + 4 picker pads x 6 files + pad.json: 26 files, 0 errors,
    0 warnings); WS3's 48 card landmarks validate with `display`. Not published (`make web` is the
    orchestrator's, after WS7/WS8).
  - For WS5: the picker's real-tree KAT can run after the next publish; `parsePadsIndex` /
    `parsePadSummary` match the final shape (rows under `pads`, `official` on every row,
    headline object keyed "30"/"60" with `budget_min`).

- 2026-11-14T18:20Z (session 5): **simulator bundle contracts v1.0.0 (D41), frozen 20:00 CET**
  (`contracts/bundle/`, README there; versioned apart from the web 1.1.x line):
  - `plan.schema.json` (plan id, pad official/picker/custom, scenario variant + suit, station
    order, EVA start D31, storm replay D39 incl. t* and the storm UTC at EVA start, engine commit,
    config hash, contract version, created UTC, origin precomputed / computed_live + D40 label,
    world version) and `bundle.schema.json` (the zips' `index.json`, kind plan / world: frame,
    bounds, every file with media type, bytes, sha256, role, frame, units, contract, `.f32` grid
    header, source path + sha256 + transform, status). Derived-file schemas: `route_local`
    (1 m route), `points`, `sun`, `storm`, `config_snapshot`.
  - Frame: pad-local metres, origin at the official pad, x = E, y = N, z = up (z = areoid height -
    pad elev); projection + pad_xy in every index; Unity = (x, z, y). Grids: raw LE float32,
    row 0 = north, header in index.json (shape, NW-corner origin, cell, nodata -9999, units,
    z_to_frame_m for heights); nearest-cell sampling for fields. Entry point named `index.json`
    as on the handover page (validated by `bundle.schema.json`).
  - `tools/make_bundle.py` + `make bundle` / `bundle-fixture` / `bundle-check`: builds both zips
    from data/interim through make_web's rules (web/public/data fallback); deterministic
    (fixed zip time, sorted, index.json first); validates every file + the manifest and
    round-trips each zip. KATs first: `tests/test_make_bundle.py` (19).
  - **Fixture** `contracts/bundle/fixtures/official_pad_v1/` (main 70b1136 inputs: WS2 s8/s9
    golden + D44 names, WS8 s4 fp3d, WS1 s5): `plan_bundle.zip` 38.8 MB (52 entries, rank1 /
    nom_104, stations S7 S6 S1 S4, t* 44.39 min), `world_pack.zip` 19.0 MB (123 entries, full,
    not cropped, world-dcd8def207c7), `plan.json`, `fixture.json`. CI: round trip + schema
    validation + repack byte-identical (bytes compared when zlib matches 1.3.1); the full rebuild
    is byte-identical locally (skipped where data/interim is absent).
- 2026-11-14T17:15Z (session 5): **contracts v1.1.5** (additive): `golden.schema.json` +
  `SCHEMA_MAP` `physio/golden.json` (both validators) + make web rule (WS2); `scenarios_index`
  `headline_60`; `pads_index` rows / `pad_summary` `feasible`; `trade_table` cell `in_data_pct`.
  WS2's real interim files validate (0 errors besides the never-published card parts).

### Doing

- —

### Next

- Re-publish when WS2 writes `pad.json` per v1.1.2 (remove `pad.json` from `WITHHELD`), and when
  WS7/WS9 re-record from clean commits.
- WS5: without `pad.json` the console map marks `config/site.yaml pad_default` (label says
  "pad.json not available yet") and the HUD uses the route start; nothing else reads it.
- WS7: re-run `make fields --with-pointer`: v1.1.1 has the pointer entry, and WS7's
  `fields/index.json` (12:08 CET) predates WS9's `fields_index_nav.json` (12:16), so the published
  `fields/fix_interval_{set}.png` are not yet named in `fields/index.json` (HUD D_max).

### Blocked

- —

### Answers to questions for C

- WS2 Q10 (sizes): no further cuts (Decision log 12:20). Every engine file is < 50 MB (largest
  9.95 MB); the tree is 79.5 MB raw / 12.1 MB gz.
- WS2 Q11 (card merge): done in `make web` (above); card `margin_binding` may be null (v1.1.1).
- WS2 Q12 (stations/timeline/route extras): documented optional in v1.1.1.
- WS3 Blocked 2 (fragment vs card contract): solved by the merge. WS3 ring layout adopted (v1.1.1).
- **WS7 sun / time-to-dark (no `sun.json`):** WS4's `conditions/clock.json` already has them:
  `eva.sun_series` (columns `eva.sun_series_columns` = `t_eva_min`, `lmst_h`, `sun_azimuth_deg`,
  `sun_elevation_deg`; 79 rows at 5 min over the 390-min simulated EVA), `eva.t_dark_min` (578.63,
  flat horizon at the pad, definition in `eva.t_dark_definition`), `eva.t_dark_min_by_observer`
  (per WS3 stop horizon), `eva.start_utc`/`start_lmst`. WS7: read them from `clock.json`.
- WS7 fields scope: ship all scenarios of the contract table (Decision log 12:20).
- **For WS5 (C does not edit web/ outside contracts.ts):** `web/src/data/types.ts` `Card.margin_binding`
  should be `'O2' | 'daylight' | 'dose' | null`; station card and cuff should show null as
  "none (not on the route / no access cell)" and can show `access.dist_m` + the walk-in.
- WS2 Q6: WS2 writes the web `stations.json` (`data/interim/engine/public/stations.json`);
  make web copies it. Station cards: settled 11:42 (WS3 + WS2 parts, merged by make web).
- WS2 Q7: done in v1.1.0 (above). Siting: one grey PNG + `siting_png.json`, no tiles.
- WS2 Q8 (F11 partner area / reachable % choice) is a science choice: S.
- WS5 basemap: read `tiles/basemap/tilejson.json` (contract `tilejson.schema.json`; tile URLs are
  relative to the data root). Fields map one to one to `BasemapSource`.
- WS5 unknown terrain: hatch from `terrain/cellstate.png` (A = 0 unknown) placed on
  `terrain/cellstate.json bounds`; same decoder as the field alpha.
- WS5 D9 slider: there is no `leash.d_allow_slider_mgy`. Read `config/conditions.yaml`
  `leash.d_allow_range_mgy` ([min, max]) and `leash.d_allow_step_mgy` at build time (config.ts),
  and τ per step from `rad.json leash.table` (contract v1.1.0; its first/last rows are the range).
- WS5 / WS6 KAT list: `validation/kats.json` has a contract (`kats.schema.json`, mapped); make web
  copies `data/interim/validation/kats.json` once `make kats` has run.
- WS1 provenance: WS6's `manifest.record` is on main; please switch `pipeline/terrain/prov.py`
  to it. Until then make web merges `terrain/manifest_pending.json` as WS1's fragment
  (`pipeline__terrain__build.json`; once that fragment exists, the bridge stops).
- WS3: write card images to `data/interim/horizon/public/cards/{station}/{panorama,overlay}.png`
  and the 3D ring to `data/interim/horizon/public/fp3d/horizon_ring.json`.
- WS7/WS8: write web files under `data/interim/export/` mirroring the web tree
  (`export/fields/…`, `export/fp3d/…`). WS9: `data/interim/navigation/{nav,localisation,fields}/`
  as `pipeline/navigation/real.py` does now.

### Assumptions added

- `config/web.yaml` (new, C): `web_export.basemap` format webp, quality 80, method 4, maxzoom 18,
  budget_mb 50, tile_size_px 256, attribution; format/quality/method/budget `assumed`.
- Web paths `siting_png.json`, `tiles/basemap/tilejson.json`, `terrain/cellstate.{png,json}`.
- Cell states are published at the routing grid's own 3 m (no resampling); codes other than 0/1
  are drawn unknown.

## WS1 Terrain

Branch: `ws1-terrain`

### G0 report (DRAFT for S sign-off, 2026-11-14T09:58Z; session 2 update 11:40Z)

Session 2 changes to this report: D3 = A (decided), `pad_default` kept, and the pad check shows
**both readings**; the user decided the reading at 12:37 CET (cells with data), so it **passes**.

All numbers from today's fresh downloads (`data/raw/terrain/`, cache index `cache_index.json`) and
`data/interim/terrain/*.json`. Grids: analysis CRS (`site.yaml crs.analysis_proj`), pad = `pad_default`.

- **DEM:** merged DEM v3 rows 35993-44194 pulled once as 21 full-width row bands (722 MB on the
  wire), reprojected to `dem_1m.tif` (7,800 x 7,800 at 1 m, pad +/- 3,900 m), 100% valid.
  Pad elevation -3627.74 m (D0 nearest pixel: -3627.68 m).
- **Source mask (D3 = A, decided by the user 11:24 CET):** union of the STAC
  `mro_hirise_socet_dtms` footprint quads of the 4 pairs the merged DEM's Astropedia page lists
  (009149, 019698, 009650, 001488; 040770 is in STAC but not in the list). Quads cover 100% of the
  planning extent: HiRISE 100%, CTX/HRSC 0%, nodata 0%.
  - Evidence against over-trusting quads (quads are not valid-data outlines, D0 2.2): 1 m texture
    (RMS of 9 m high-pass over 25 m) inside the quads has median 0.111 m, p5 0.035 m; an upsampled
    CTX 20 m DEM has p95 0.055 m. **5.5% of the 30-min disc has texture below the CTX p95.** If
    those cells were called non-HiRISE (option C), assessed coverage would be 93.8% (30-min) and
    79.1% (60-min). Option B (all 5 STAC quads) = A (100%).
- **Coverage (3 m cell states, flat discs at 0.98 m/s):**
  | Disc | Radius | Assessed | Blocked (>20 deg) | Unknown |
  | --- | --- | --- | --- | --- |
  | 30 min | 1,764 m | 58.77% | 41.23% | 0.00% |
  | 60 min | 3,528 m | 68.64% | 31.36% | 0.00% |
- **Pad check (SPEC F1: "the pad's 30-min flat disc is >= 90 % assessed"). Both readings shown;
  decided reading (user, 12:37 CET) = `data_coverage` -> PASS:**
  | Reading of "assessed" | Cells counted | 30-min disc | >= 90 %? |
  | --- | --- | --- | --- |
  | `data_coverage` | cells with data (state 0 assessed + state 1 blocked) | **100.00 %** | yes |
  | `state0_only` | state 0 only (walkable under the 20 deg nominal limit) | **58.77 %** | no |

  `validation/coverage.json pad_check`: `readings.{data_coverage,state0_only}.{pct,pass,definition}`,
  `reading: "data_coverage"`, `pass: true` (`config/site.yaml coverage.pad_check_reading`). The
  blocked share (41.23 %) stays in `discs[].blocked_pct`. Manifest keys
  `validation.coverage.pad_check.{pass,reading,readings.*}`.
- **Blocked share is high:** 24.2% of 1 m HiRISE cells exceed 20 deg (Horn 3x3); the 5 m plane fit
  gives 23.7%, so it is not only 1 m noise. 17-20 deg ("beyond tested") is 9.1% of the 30-min disc.
  Ridge cells (> 0.75 m above the 15 m median): 1.4% of 1 m cells.
- **Co-registration** (grid search +/-200 m, 2 m, MAD, 537 MMGIS drive ends inside the window):
  best shift **dx = 0, dy = 0 m** (frame check passes); residual median -0.000 m, **MAD 0.037 m**,
  p5/p95 -0.128/+0.107 m. MAD rises to 0.13-0.15 m at +/-2 m, so the minimum is sharp.
  Inference (not verified): residuals this small suggest MMGIS `elev_geoid` is itself sampled from
  this DEM, so coreg is a frame check, not an independent accuracy check.
- **HiRISE cross-check (never used for routing):** merged - HiRISE median **-14.54 m** (009149,
  P90 |diff| 36.57 m) and **-9.43 m** (019698, P90 |diff| 15.34 m). Both HiRISE COGs also sit
  horizontally offset from the merged DEM (best shift 009149: +68/+34 m, MAD 3.57 m; 019698: -26/+32 m,
  MAD 1.41 m). D0 saw +11.6 m HiRISE - merged at the pad, same sign. The controlled HiRISE COGs are in
  a different frame from the merged DEM; the merged DEM agrees with the rover.
- **pad_default** (137.382, -4.806) is not reproduced by any centroid of the 176 drive ends with
  sol >= 4410 (approx. 2025-01-01): mean 174.8 m away, median 83.1 m, in-focus (148) mean 265.0 m,
  in-focus median 73.9 m. **Kept unchanged (user, 11:24 CET).**

### Done

- Started 09:47Z; KATs first (ported): `tests/test_coverage.py`, `tests/test_coreg.py`, 26 pass.
- dem_1m, source_mask, coverage.json/.png, coreg.json, drive_ends_coreg.json, grid.json.
- 3 m routing grids for **WS2**: `elev_3m.tif`, `maxslope_3m.tif`, `cellstate_3m.tif`,
  `dataedge_3m.tif` (all 0: no unknown cells), `ridge_3m.tif`; plus `slope_1m.tif`, `slope_5m.tif`,
  `roughness_5m.tif`, `ridge_index.tif` (WS6 V1 can use `slope_1m.tif`). 2,468 x 2,468 at 3 m.
- `hirise_xcheck.json`; `crism_d2300_18m.tif`, `crism_sindex2_18m.tif` (89.2% valid).
- `stations.json` (values part, `data/interim/terrain/`): S1 137.391523, -4.810007 (value 0.8683);
  S2 137.383058, -4.776687 (0.7443); S4 = MMGIS 107_2484, sol 4200, 137.408864, -4.785707 (0.4750);
  S3, S5 null until S picks. Scoring normalisation in `stations.yaml scoring_assumptions` (assumed).
- Far field for **WS3**: `mola_hrsc_200m.tif` (pad +/- 83.8 km, 200 m, 100% valid, fetched with
  GTIFF_DIRECT_IO, 2.3 MB) and `ctx_20m.tif` (pad +/- 33.7 km, 20 m; 3 geoid-adjusted CTX items,
  each levelled to MOLA-HRSC by its median; **70.8% of the 33.7 km disc valid**, NaN elsewhere: use
  MOLA-HRSC there). One item rejected by QA (P22_009505__P22_009571: median -55.3 m vs MOLA-HRSC).
  Details in `farfield.json`.
- Ortho for **WS8**: `ortho_lrgb_1m.tif` (Gale HiRISE LRGB COG, RGBA on the dem_1m grid);
  registration check vs DEM hillshade in 3 boxes: shifts <= 2 px (1 m).
- Basemap: `data/interim/terrain/tiles/basemap/{z}/{x}/{y}.png`, XYZ z13-z18 (10 m to 0.32 m/px on
  Mars lon/lat, D4); z13-16 from the 1 m LRGB over the DEM window, z17-18 from 0.25 m over the focus
  area. **2,760 tiles, 292 MB** (largest tile < 1 MB). `basemap.json` has per-zoom counts.
  Source is the LRGB colour mosaic (100% focus coverage), not `ESP_019698_1750_RED` (84.6%).
- Downloads total: **1,050 MB** (DEM 722, HiRISE DTMs 178, CTX 71, LRGB 47, CRISM 9, MOLA 2).
- KATs: 27 pass (`tests/test_coverage.py`, `tests/test_coreg.py`); ruff clean; interim contracts OK.

#### Session 2 (started 11:20Z)

- 2026-11-14T11:36Z: **Provenance switched to WS6 `manifest.record`** (`pipeline/terrain/prov.py`
  is now a thin wrapper; NaN/inf -> None). All 36 previous keys re-recorded with the same values
  (new `utc`, clean commit) into `data/interim/manifest/pipeline__terrain__build.json`, plus
  5 new pad-check keys (41 keys; last re-record 11:39Z at f70f3eb). Value changes: only
  `file.validation/coverage.json` (new hash); `validation.coverage.pad_check.pass` is true again
  after the 12:37 decision (it was null for a few minutes while the reading was open).
  **`data/interim/terrain/manifest_pending.json` is deleted. C: the make web bridge
  (`WS1_PENDING` in `tools/make_web.py`) is no longer needed** (it was already skipped because the
  fragment exists). Test merge of all fragments: 857 keys, no duplicates; `check_h0 --fragments` OK.
  `python -m pipeline.terrain.build manifest` re-records every WS1 key from the outputs on disk.
- 2026-11-14T11:36Z: **CTX band step investigated (WS3 Blocked 3); fix written as
  `data/interim/terrain/ctx_20m_v2.tif`** (+ `farfield_v2.json`). `ctx_20m.tif` is untouched.
  Numbers are medians on the 20 m lattice (dem_1m block-averaged to 20 m), ring around the pad:
  - Canonical `ctx_20m.tif` minus dem_1m: **+19.79 m** in the 1.5-3.9 km ring (MAD 8.07 m;
    WS3 measured +19.75 m), +21.6 m at 0-2 km. **0.57 deg** at the 2 km handover.
  - **The datum is not the problem:** MOLA-HRSC minus dem_1m = +1.3 m (1.5-3.9 km ring; +0.49 m
    on 200 m block means). dem_1m, MOLA and the rover (coreg MAD 0.04 m) agree vertically.
  - **Cause 1, horizontal misregistration of the CTX items:** the item that supplies 99 % of the
    overlap (P21_009149...K10_057108) sits (-100 m E, +70 m N) from dem_1m. Mount Sharp rises to
    the south, so the shift reads as height: raw item - dem_1m = +15.74 m (MAD 8.51 m); after the
    shift, +0.42 m (MAD 3.57 m). Other items: P22_009505...D03_028335 (-20, +50) m, +13.65 -> +6.41
    m; P15_006855 (-30, +20) m, +7.91 -> +3.42 m.
  - **Cause 2, one-median levelling to MOLA:** each item was levelled by its median vs MOLA over
    the whole 34 km disc (P21: -4.19 m, so it was raised 4.19 m). That median is dominated by the
    outer rings, where CTX lies below MOLA: canonical CTX - MOLA by ring is +20.9 (0-4 km), +13.7
    (4-8), +9.3 (8-16), +3.6 (16-24), -10.7 (24-30), -17.8 m (30-34 km). So 15.7 + 4.2 = +19.8 m.
  - **Fix (v2):** each accepted item is co-registered to dem_1m in the overlap: horizontal MAD grid
    search (+/-400 m, 10 m; same metric as the rover coreg), then the median offset
    (`site.yaml ctx_v2`, `pipeline/terrain/farfield.py`). Same 3 items and first-pick order.
  - **Result:** v2 - dem_1m = **+0.16 m** in the 1.5-3.9 km ring (MAD 3.27 m; rings 0-1/1-2/2-3/3-3.9
    km: +1.04/+0.55/+0.76/-0.61 m): **0.005 deg** at the 2 km handover (was 0.57 deg).
  - **Independent check against MOLA (not used in the fit):** v2 agrees better with MOLA-HRSC in
    every ring, MAD v1 -> v2: 13.6 -> 10.7 (0-4 km), 15.6 -> 11.8 (4-8), 16.7 -> 12.4 (8-16),
    14.6 -> 13.6 (16-24), 15.4 -> 14.6 (24-30), 26.1 -> 23.5 m (30-34). Medians v2 - MOLA: -0.8,
    -4.8, -4.0, -4.5, -15.2, -21.1 m. At the 30 km CTX -> MOLA handover that is about 0.03 deg (v1
    about 0.02 deg): negligible.
  - Alternative considered: level only (no shift) to dem_1m. It removes the median step too, but
    keeps the misregistration (P21 MAD stays 8.51 m; 120 m is about 2.3 deg of azimuth at 3 km).
  - Valid share of the 20 m grid: 59.6 % (v1 59.7 %; shifted edges lose a few cells, never filled).
  - **Recommendation: switch to `ctx_20m_v2.tif`.** C decides; WS3 then points
    `config/horizon.yaml bands.ctx_20m.path` at `data/interim/terrain/ctx_20m_v2.tif`. Until then
    `ctx_20m.tif` stays canonical and unchanged.
- 2026-11-14T11:35Z / 11:39Z: **Pad check shows both readings** (above); after the user's 12:37
  decision, `pass` follows `data_coverage`. `coverage.json` was written to
  `terrain/staged/` first and compared: `coverage.png` and `coreg.json` were byte-identical (not
  rewritten); `coverage.json` differs only in `pad_check` and the D3 status text, so only that file
  was swapped in (atomic rename; only `make web` reads it).
- D3 = A recorded in `site.yaml d3` (`decided: true`); `coverage.json d3.decided` is now true.
- `make terrain` also runs `build farfield_v2`; KATs added: pad-check readings (3), prov fragment,
  CTX shift/offset recovery, identical item, no-overlap fallback, block mean. WS1 KATs 35 pass; full
  suite passes; ruff clean; interim contracts OK.
- Files changed in `data/interim/terrain/` this session: **new** `ctx_20m_v2.tif`,
  `farfield_v2.json`; **replaced** `coverage.json` (pad_check + D3 text only); **deleted**
  `manifest_pending.json`. No raster that WS2/WS3/WS8/WS9 read was rewritten.

#### Session 3 (started 13:20Z)

- 2026-11-14T13:36Z: **`cellstate_3m_conservative.tif` (brief task 8, F1/F2)**, new file in
  `data/interim/terrain/` (+ summary `cellstate_3m_conservative.json`); `cellstate_3m.tif` and
  every other raster untouched. No-go = `site.yaml slope.nogo_deg.conservative` "20 - v1_rmse_deg"
  with WS6 `v1.json rmse_deg` 5.447021 -> **14.553 deg**. Rule (`routing.restate`): unknown stays
  unknown; a known 3 m cell is blocked iff its max 1 m slope (`maxslope_3m.tif`) > 14.553 deg.
  Same grid/CRS as `cellstate_3m.tif`, uint8, nodata 255, codes 0/1/2.
  | Disc | Nominal blocked (> 20 deg) | Conservative blocked (> 14.55 deg) | Newly blocked | Unknown |
  | --- | --- | --- | --- | --- |
  | 30 min (1,764 m) | 41.23 % | **58.75 %** | 17.52 % | 0 % |
  | 60 min (3,528 m) | 31.36 % | **46.31 %** | 14.95 % | 0 % |
  | Whole 3 m grid | 31.22 % | 45.86 % | | 0 % |
  Checked on the real rasters: conservative blocked is a superset of nominal blocked, and
  conservative assessed equals WS2's `passable_mask(cellstate_3m, maxslope_3m, 14.553...)` cell
  by cell.
  - **WS2: the path does not matter to you.** `pipeline/engine` never opens a conservative
    cellstate: `Grid.with_nogo` re-derives passability from `maxslope_3m.tif` with the variant's
    limit (`physio.resolve_nogo` + `v1.json`), using `cellstate_3m.tif` only for unknown cells.
    The new raster is the same rule, for display and checks; your con_* runs need nothing new.
  - C: `make web` publishes only `cellstate_3m.tif` (`terrain/cellstate.json variant: nominal`).
    If the app should hatch the conservative states, a second rule from
    `terrain/cellstate_3m_conservative.tif` works as is (`write_cellstate` already sets
    `variant: conservative` from the file name) but needs its own web path; your call.
  - `make terrain` now ends with `build conservative validation` (conservative is skipped with a
    message while `v1.json` is missing, so in `make clean all` V1 must run before it for con_*).
- 2026-11-14T13:36Z: **WS6 audit 1 fixed: every WS1 manifest key now cites a web path** (53 keys,
  all at clean commit bc1af57, 13:35:52Z; `data/interim/manifest/pipeline__terrain__build.json`).
  - `stations.{S1,S2,S4}.value` -> `stations.json` (WS2's `engine/public/stations.json`, which
    `make web` publishes; same values 0.8683 / 0.7443 / 0.475).
  - `terrain.xcheck.{009149,019698}.{median,p90_abs}` (4), `terrain.slope_compare.median_abs_diff`,
    `terrain.blocked_pct.{30,60}min` -> `validation/coverage.json`, which now carries these numbers
    in a new block **`terrain_checks`** (`hirise_xcheck`, `slope_compare`,
    `blocked_pct_of_known`, `conservative`). Nothing else in `coverage.json` changed (staged and
    compared; `coverage.png` and `coreg.json` byte-identical, not rewritten).
  - New keys (same file): `terrain.nogo_conservative_deg` 14.553, `terrain.conservative.v1_rmse_deg`
    5.447, `terrain.conservative.disc_{30,60}.{assessed,blocked,unknown,nominal_blocked,
    newly_blocked}_pct`.
  - KAT: every WS1 key's `file` is a web path and its value appears in that file. Trial merge of
    all fragments: 941 keys, no duplicates; `check_h0 --fragments` OK. Reaches the public tree
    at C's next `make web`. WS5: the scorecard can cite `terrain.conservative.*` by name.
- D19 (navigation): nothing in WS1 depends on navigation; no change.
- KATs first: 8 new (conservative formula, restate, superset/identity, WS2 agreement, disc
  summary, web-path keys). WS1 KATs 41 pass (test_coverage + test_coreg); full suite 730
  pass; ruff clean.

#### Session 4 (started 15:19Z): D22/D23 cell states + D26/D32 stations

**C / WS2: the files are ready** (`data/interim/terrain/`, all at clean commit 58d678b;
every raster written as `tmp_*` and swapped in only when all were complete). Same 3 m grid as
before (`grid.json route_3m`, 2,468 x 2,468, analysis CRS).

| File | dtype / nodata | Semantics |
| --- | --- | --- |
| `slope_3m.tif` | float32 / NaN | **D22 cell slope (deg)**: least-squares plane through the cell's nine 1 m elevations (`dem_1m.tif`). NaN = unknown cell |
| `stepguard_3m.tif` | uint8 / 255 | **D22 step guard**: 1 = some 1 m Horn slope (`slope_1m.tif`) inside the cell > 30 deg (`site.yaml slope.step_guard_deg`, assumed) -> blocked at every no-go; 0 = no; 255 = unknown cell |
| `cellstate_3m.tif` | uint8 / 255 | **Canonical = nominal 20 deg** (make web -> `terrain/cellstate`). 0 assessed, 1 blocked, 2 unknown |
| `cellstate_3m_conservative.tif` | uint8 / 255 | **Conservative 17 deg (D23)** (make web -> `terrain/cellstate_conservative`) |
| `cellstate_3m_optimistic.tif` | uint8 / 255 | Optimistic 25 deg (no make web rule yet; C's call. Note `make_web.cellstate_variant` would label it "nominal") |
| `maxslope_3m.tif` | float32 / NaN | **Unchanged** (byte-identical, verified against `slope_1m.tif`): max 1 m slope, now only the **"rough footing" overlay** |
| `cellstate_3m_variants.json` | | per-variant disc summary (table below); replaces `cellstate_3m_conservative.json` (deleted, it was the 20 - V1 RMSE basis) |

Rule (`pipeline/terrain/routing.py`): a cell is **known** iff all nine 1 m cells are HiRISE with a
finite elevation and 1 m slope (same unknown set as before: 0 cells). At no-go N a known cell is
**blocked iff `slope_3m > N` or `stepguard == 1`**; unknown stays unknown. **WS2 passability at any
no-go:** `cellstate_3m != 2 & stepguard_3m == 0 & slope_3m <= nogo` (`routing.passable`); at
25/20/17 this equals `cellstate_3m_{optimistic,(nominal),conservative} == 0` cell by cell
(checked on the real rasters). `pipeline/engine/graph.py passable_mask` still uses `maxslope_3m`:
WS2 switches it. Also unchanged: `elev_3m`, `dataedge_3m` (0 data-edge cells), `ridge_3m`.

**Blocked share (D22), % of all disc cells (unknown = 0 %, so = % of assessed cells, D25):**

| Variant (no-go) | Disc | (a) by 3 m slope | (b) step guard only | **Total blocked** | Old max-slope rule at the same no-go |
| --- | --- | --- | --- | --- | --- |
| optimistic 25 deg | 30 min (1,764 m) | 18.75 % | 3.12 % | **21.87 %** | 28.92 % |
| nominal 20 deg | 30 min | 28.19 % | 1.03 % | **29.22 %** | 41.23 % |
| conservative 17 deg | 30 min | 35.82 % | 0.48 % | **36.30 %** | 50.29 % (old con 14.55 deg: 58.75 %) |
| optimistic 25 deg | 60 min (3,528 m) | 15.31 % | 1.78 % | **17.09 %** | 21.81 % |
| nominal 20 deg | 60 min | 23.21 % | 0.55 % | **23.77 %** | 31.36 % |
| conservative 17 deg | 60 min | 29.73 % | 0.26 % | **29.99 %** | 38.79 % (old con 14.55 deg: 46.31 %) |

Step guard fires on 19.66 % (30 min) / 14.75 % (60 min) of disc cells; most of them are already
over the slope limit. Whole 3 m grid blocked: 17.72 / 24.41 / 30.50 % (opt / nom / con).
"Beyond tested" (plane slope 17-20 deg, no step guard): 7.08 % (30 min), 6.22 % (60 min).
`validation/coverage.json` `discs` now = D22 nominal (assessed 70.78 / 76.23 %, blocked 29.22 /
23.77 %); the pad check still passes (data coverage 100 %; state0_only 70.78 %).

**Manifest (86 WS1 keys, all commit 58d678b, 15:34Z; fragment rebuilt, so old keys are gone).**
- **Removed (12):** `terrain.nogo_conservative_deg`, `terrain.conservative.v1_rmse_deg`,
  `terrain.conservative.disc_{30,60}.{assessed,blocked,unknown,nominal_blocked,newly_blocked}_pct`.
- **Added (45), all citing `validation/coverage.json` (`terrain_checks.cell_states`):**
  `terrain.nogo_deg.{optimistic,nominal,conservative}` (25/20/17), `terrain.step_guard_deg` (30),
  `terrain.stepguard.disc_{30,60}.pct`, `terrain.cellstates.{optimistic,nominal,conservative}.disc_{30,60}.{assessed,blocked,unknown,blocked_slope,blocked_stepguard_only,maxslope_rule_blocked}_pct`
  (36), and `stations.{S6,S7,S8}.value` (cite `stations.json`).
- **Old -> new:** `terrain.nogo_conservative_deg` -> `terrain.nogo_deg.conservative`;
  `terrain.conservative.disc_B.X` -> `terrain.cellstates.conservative.disc_B.X`;
  `...nominal_blocked_pct` -> `terrain.cellstates.nominal.disc_B.blocked_pct`; `v1_rmse_deg` and
  `newly_blocked_pct` dropped (no D23 meaning).
- **Values changed, same key:** `coverage.disc_{30,60}.*`, `terrain.blocked_pct.{30,60}min`,
  `validation.coverage.pad_check.readings.state0_only.pct`, `stations.{S1,S2,S4}.value`, `file.*`.
- **WS5:** `web/src/views/scorecard.tsx` (V1 block) reads `terrain_checks.conservative` and the
  removed keys; it now finds nothing and omits that clause. Its text "20 - V1 RMSE" is pre-D23.
  New block: `terrain_checks.cell_states.variants.{v}.discs[]`.
- **For C (contracts, not WS1 paths):** `contracts/README.md` and `cellstate.schema.json` still
  describe "blocked = max 1 m slope > 20 - V1 RMSE"; D22/D23 text needed. `config/variants.yaml`
  (WS2) still has `conservative.nogo_deg: "20 - v1_rmse_deg"`, and WS6 `v1_tilt.py` reads it.

**D26/D32 stations** (`data/interim/terrain/stations.json`; science points only, WS2 computes
access cells and reachability; a station nobody reaches stays on the map as "not reachable on
foot", `stations.yaml placement.unreachable_label`). Order S4 -> S1 -> S2 -> extras; each point is
**walkable** (its 3 m cell is assessed in the D22 nominal `cellstate_3m.tif`), in the focus area,
and **>= 300 m** from every station placed before it (min pairwise distance: 602.1 m).

| id | lon, lat | name / finding (from the score) | value | 3 m cell (slope; opt/nom/con state) | How placed |
| --- | --- | --- | --- | --- | --- |
| S1 | 137.379249, -4.808320 | Boxwork ridge-hollow transect / dense ridge network + high D2300 clay signal | 0.8409 | 17.1 deg; 0/0/**1** | rule: max(ridge density + D2300) 25 m cell in focus area and pad_default 30-min disc, walkable, >= 300 m from S4. Old S1 cell is blocked under D22 (slope 53 deg, step guard) -> moved |
| S2 | 137.375440, -4.778796 | Fracture-network survey / dense ridge network + high D2300 clay signal | 0.7474 | 18.4 deg; 0/0/**1** | rule: max ridge density 25 m cell, same domain, walkable, >= 300 m from S4, S1. Old S2 cell blocked (30.2 deg, step guard) -> moved |
| S4 | 137.408931, -4.785832 | Gediz Vallis sulfur field / high SINDEX2 sulfate signal | 0.4744 | 7.9 deg; 0/0/0 | MMGIS drive end 107_2394 (sol 4197): nearest-to-sol-4200 drive end that is walkable; the sol-4200 end 107_2484 is on a blocked cell, 8.4 m away |
| S6 | 137.383481, -4.788919 | dense ridge network + high SINDEX2 sulfate signal | 0.7128 | 15.6 deg; 0/0/0 | D26 extra 1: highest F7 value 25 m cell (CRISM = max of normalised SINDEX2/D2300, manual 0), focus area, walkable, spaced |
| S7 | 137.373323, -4.789762 | dense ridge network + high SINDEX2 sulfate signal | 0.6986 | 11.6 deg; 0/0/0 | D26 extra 2 (same rule) |
| S8 | 137.386021, -4.770783 | dense ridge network + high D2300 clay signal | 0.6878 | 6.9 deg; 0/0/0 | D26 extra 3 (same rule) |

- **S3, S5 dropped** (D26, final per D44): listed under `dropped` in `stations.json`, not in
  `stations`.
- S1 and S2 are walkable at nominal and optimistic but **blocked at conservative 17 deg**: con
  scenarios need WS2's access cell (50 m, D27).
- S6 and S7 have the same finding; since session 5 (D44) their names carry a compass suffix.
- Names: a component (normalised) >= 0.5 is named, larger first: "high D2300 clay signal", "high
  SINDEX2 sulfate signal", "dense ridge network" (index words from SPEC F7). `finding_detail` has
  the numbers. No geological claim beyond SPEC F7's index-to-mineral wording.
- New record fields: `finding`, `finding_detail`, `placement`, `cell` (slope_3m_deg, stepguard,
  state per variant), `components.crism_norm_by_index`, S4 `moved_from`; top level `dropped`,
  `min_spacing_m`, `min_pairwise_m`, `placement`, `extras_rule`.
- The S1/S2 domain is still pad_default's 30-min disc (stations.yaml rule text). If D21 moves the
  pad, the S1/S2 rule is unchanged unless C says otherwise.

#### Session 5 (16:40Z): D44 final station list + compass suffix

- **D44 (user 17:28, set A): list final S1, S2, S4, S6, S7, S8**; S3/S5 dropped (no more 19:00
  wording in `stations.yaml` or `build.py`). Placement assumptions (walkable at 20 deg, extras
  manual priority 0, named after any part >= 0.5) kept `assumed: true` with D44 notes.
- **Same-name stations get the 8-point compass of the bearing from the official pad**:
  `data/interim/engine/public/pad.json` top-level `pad` (rank1, 137.401783, -4.77748); `site.yaml
  pad_default` only if that file is missing. Rule in `stations.yaml extras.same_name_suffix`.
- **Collision rule (WS1, assumed):** S6 and S7 are both south-west (237.9 and 246.6 deg), so the
  next rule is the distance from the pad: "nearer"/"farther" (3+: nearest, 2nd nearest, ...,
  farthest; a distance tie falls back to the id). No new on-screen number.
  - S6 = "dense ridge network + high SINDEX2 sulfate signal (south-west, nearer)" (1,276 m)
  - S7 = "dense ridge network + high SINDEX2 sulfate signal (south-west, farther)" (1,832 m)
  - S1, S2, S4, S8 unchanged (no duplicate name).
- `stations.json`: only `name` changed, plus `name_base`/`name_suffix` on S6/S7 and a top-level
  `same_name_suffix` (rule, pad used). Every coordinate, value and component is byte-identical
  to session 4. Manifest re-recorded from clean commit 63a5630.
- KATs first (30 new): compass sectors and boundaries x 20, bearing x 6, suffix only for duplicate
  names (input untouched), collision by distance (2, 3, tie), unplaced skipped, pad from pad.json
  with fallback, config D44.
- Downstream to re-run (C): WS2's `engine/public/stations.json` copy (names), WS3 station cards,
  WS5 (reads stations.json via `make web`).

KATs first: 42 new, 6 pre-D23 max-slope/conservative tests removed; WS1 KATs 77 pass (plane-fit exact plane x 20, = 3x3 plane fit at the centre, NaN, spike step
guard, strict 30 deg, unknown stays unknown in all variants, blocked iff rule x 3 variants incl.
WS2's `passable`, nesting, config D22/D23, summary split, manifest keys; station spacing, focus,
walkable, naming x 6, greedy extras, config D26/D32). Full suite 806 pass; ruff clean;
`validate_contracts --interim` OK; trial merge of all fragments 1,207 keys, no duplicates.
`make terrain`: `build all` runs `slope -> cells`; the `conservative` step is gone (no V1 dependency).

### Answers (WS1)

- WS6 Blocked 2 (coreg sign): confirmed. `coreg.json (dx_m, dy_m)` is **added** to the MMGIS
  positions (analysis-CRS x/y) to put them on the DEM (`pipeline/terrain/coreg.py` docstring).
  It is (0, 0) here. Paths confirmed: `data/interim/terrain/dem_1m.tif`, `coreg.json`.

### Doing

- Session 5 done (D44 names). WS2 copy, WS3 cards and WS5 need the new names (C re-runs).

### Next

- V1's RMSE no longer changes any WS1 output (D23).

### Blocked

- None.

### Assumptions added

- `site.yaml`: `ctx_qa` (reject |median vs MOLA-HRSC| > 50 m, level to MOLA) assumed.
- `stations.yaml`: `scoring_assumptions` (normalisation, per-station CRISM index, 25 m pick cells,
  S2 300 m separation and same domain as S1) assumed; S to confirm before D8.
- `site.yaml`: `raw_fetch_margin_m` 200, `raw_fetch_chunk_rows` 400, `download_budget_bytes` 3 GB,
  `texture_check` (D3 evidence only) - all `assumed: true`; `dem_window_buffer_m` 200 (brief).
- Non-HiRISE valid cells are coded 2 (CTX and HRSC are not separable without footprints); code 3
  is never assigned.
- Session 2: `site.yaml ctx_v2` (reference dem_1m, shift search +/-400 m at 10 m, 20,000 sampled
  overlap cells, min overlap 1,000 cells, else MOLA levelling) `assumed: true`;
  `site.yaml coverage.pad_check_reading: data_coverage` (decision log 12:37, not an assumption).
- Session 4: `site.yaml slope.step_guard_deg: 30` + `step_guard_assumed: true` (D22);
  `stations.yaml extras` (`manual_priority: 0` per SPEC F7 "hand picks", `name_min_norm: 0.5`,
  ids S6-S8) `assumed: true`; `placement.walkable` = nominal 20 deg cell states (assumed reading
  of D26 "walkable"); `scoring_weights_assumed: true` and `min_spacing_m: 300` (D32, decided).
- Session 5: D44 accepted the session 4 placement assumptions (still `assumed: true`, notes cite
  D44). New: `stations.yaml extras.same_name_suffix` (compass rule per D44; the distance
  tie-break is WS1's) `assumed: true`.

## WS2 Engine

Branch: `ws2-engine`

### Done

- 2026-11-14T09:47Z: F3 `physio.py` exactly per variants.yaml/crew.yaml (a(M), k, Minetti downhill clamp, governor, O2, heat, grade lookup table). KATs `tests/test_physio.py` 65/65 pass (anchor 19 +- 1, monotonic in grade and mass, v* <= v_safe, downhill minimum in -10..-15 %, O2 budget recomputes).
- 2026-11-14T09:49Z: F4/D6 16-neighbour directed graph (no corner cutting / knight jumps) + Numba heap Dijkstra, reverse (return field) and forward. KATs `tests/test_router.py` 32/32 pass (flat T = d/v +- 1 % on all 16 rays, circular envelope within the 16-neighbour lattice bound 1.0275, 10 % plane farther downhill, uphill speed = governor, > 20 deg wall never crossed, unknown never entered, forward/reverse duality). Speed: 2600 x 2600 grid (full 3.7 km planning disc at 3 m) ~7 s per field, so no scipy fallback needed.
- 2026-11-14T09:52Z: on synthetic grids (all KATs pass, 165 WS2 tests total, full suite 235 green):
  - F4/F5/F6 isochrones 1..60 min (2-min fallback above 1.5 MB gz), bands per suit x variant x 30/60, edge causes (dummy world: wall = slope, hole = data), headline on the assessed flat disc, `scenarios/index.json`; rasters `engine/{sid}/t_home.tif`, `o2_home.tif`, `pointer.tif` + `engine/pointer_offsets.json` (legend for WS7/WS9).
  - F10 haul (`tests/test_haul.py` 22/22: 343 kg force by hand, Mars/Moon 2.29, never faster than walking, masked ridges never crossed); partner.geojson dashed, off by default.
  - F8 siting per `site.yaml siting` -> `siting.tif`, `siting.png` + `siting_png.json`, `pad.json` (contract v1.0.0), rover-hop option.
  - F9 exact DP (= brute force on 8 stations) with the SPEC F4 margin check on every leg vertex; route legs with per-vertex `times_min`; timeline with depart/arrive/leave/return, O2 checkpoints every 30 min, turn-back rows, `o2_left_L`, `t_home_min`, `margin_min` + `margin_binding`.
  - F11 trade table. `make engine` = `python -m pipeline.engine.scenarios` (e2e test on WS1-shaped synthetic GeoTIFFs: every product passes `tools/validate_contracts.py`).

- 2026-11-14T10:05Z (session 2): provenance now goes through WS6 `pipeline.provenance.manifest.record` (fragments `data/interim/manifest/pipeline__engine__*.json`); `manifest_fragment.json` dropped. Pushed a5508f6.
- 2026-11-14T10:20Z: S review (docs/review/2026-11-14-ist2-and-o2-margin.md) implemented, KATs first. Pushed 4c54e5e.
  - **IST-2 weight-span check** (`physio.ist2_weight_span`, `tests/test_physio.py`): same grade, 0.12 g vs 0.32 g, 121 + 80.7 kg, per kg subject mass, speed sweep 0.56-0.97 m/s. Model is not retuned.
    | Variant (eta) | 20 % band | 8.7 inside? | 30 % band | 17.0 inside? |
    | --- | --- | --- | --- | --- |
    | optimistic (0.25) | 6.43-11.13 | yes | 9.42-16.31 | **no** (17.0 > 16.31) |
    | **nominal (0.225)** | 7.14-12.37 | **yes** | 10.47-18.13 | **yes** |
    | conservative (0.20) | 8.04-13.92 | yes | 11.77-20.39 | yes |
    Speeds that reproduce IST-2 exactly (nominal): 0.68 m/s at 20 %, 0.91 m/s at 30 %. Only k depends on g, so the band is the vertical-work term alone; IST-2's 30 % value sits near the top of the band (steep grades cost more than vertical work, as S noted).
  - **Level -> grade increment: "not validated"** (`variants.yaml ist2.level_to_grade_validated: false`, `physio.level_to_grade_increment`). Nominal 104 kg at 0.98 m/s: +23.8 / +34.9 mL/kg/min at 20 / 30 %. No measured reference found in the repo or config.
  - **O2 margin** (`margin.py`, `crew.yaml o2_margin`, all sourced): `margin_min = (O2_left - O2_return_route - O2_station_tasks - O2_reserve) / 1.35`, "minutes at maximum effort"; station work 0.84 L/min (1,000 BTU/hr); reserve 30 min x 1.35 = 40.5 L. Timeline rows add `o2_tasks_left_L` and `o2_margin_min_planning_rate` (O2 term at 1,200 BTU/hr = 1.004 L/min).
- 2026-11-14T10:30Z: **real run** `make engine` on WS1's grid (2,468 x 2,468 at 3 m), commit 4c54e5e, 13 min 18 s (return fields 26 s, isochrones/edges/bands 730 s). Scenarios opt_80/104/120, nom_80/104/120; con_* skipped (no `validation/v1.json`). Margins from WS4 `pipeline.conditions.margins`: t_dark 578.63 min (flat horizon, pad), **tau_dose 85.9 min = storm peak** (20 May 2024, D_allow 0.5 mGy). All public files pass `tools/validate_contracts.py` (0 errors). Outputs in `data/interim/engine/` (rasters for WS7/WS9: `{sid}/t_home.tif`, `o2_home.tif`, `pointer.tif`, `pointer_offsets.json`) and `data/interim/engine/public/`.
  - **Headline nom_104: reachable 12.4 % of the assessed 30-min flat disc (r 1,764 m), range [con pending V1, opt 17.5 %].** 60-min: 11.2 %. Other suits (30 min): nom_80 12.9, nom_120 12.1; opt 18.2 / 17.5 / 17.1.
  - Edge causes nom_104 (share of edge length): 30 min slope 99.4 %, physiology 0.6 %, data 0 % (117.5 km of edge); 60 min slope 97.8 %, physiology 2.2 %, data 0 %. No unknown cells and 100 % HiRISE, so no `data` edges.
  - Disc blocked share (nominal, > 20 deg): 41.2 % (30-min disc), 31.4 % (60-min). Reached cells 3.59 M; max finite T_home 296.7 min.
  - **Stations: S1, S2 and S4 all sit on blocked cells** (cell state 1; max slope 57.2, 40.5, 23.6 deg). Not snapped. T_home nominal = null for all three; optimistic (25 deg) reaches only S4: 52.2 / 55.6 / 58.0 min (80 / 104 / 120 kg). S4's 7x7 neighbourhood has a nominal T_home of 59.7 min; S1 and S2 have no passable cell within 3 cells (nominal). S3 and S5 have no position (S picks).
  - **Route nom_104: empty** (no reachable station), so the timeline is depart/return at t = 0 (margin 85.9 min, binding: dose). No route or binding margin to report for nom_104.
  - Partner line (nominal, 60 min, ridge-masked): nom_104 cart 179 kg 1.23 km2, drag 179 kg 0.0002 km2, cart 343 kg 0.93 km2, drag 343 kg infeasible. Trade table: reachable % filled, partner area filled, science_value null (needs con_* T_home).
  - Sizes: public tree 153 MB; isochrones fall back to 2-min steps and are still **2.6-3.4 MB gz** (19-24 MB raw) per scenario, over the 1.5 MB budget; bands 4.2-4.6 MB; edges 2.2-3.1 MB; partner 1.1-1.4 MB; `data/interim/engine/` 351 MB total. Cause: thousands of small blocked holes (nom_104 60-min contour has 6,355 holes).
- 2026-11-14T11:05Z (session 3): **access-cell rule** (user 11:40), KATs first (`pipeline/engine/tests/test_access.py`, 8 pass: wall station -> walkable cell at exactly 30 m; none within radius -> null + reason; assessed-but-sealed pocket -> null + reason; station on walkable cell -> access = science point, dist 0; nearest wins; card fragments match the timeline). `pipeline/engine/access.py`: access cell = nearest cell with WS1 state assessed (0) **and** finite T_home in the scenario, within `variants.yaml route.access_radius_m` 50 (assumed, flagged). Science lon/lat never moved. Walk-in leg **not modelled**; reported straight-line: dist, rise, mean slope, max along-track slope (3 m samples, bilinear on elev_3m), max WS1 max-slope of cells crossed. Per scenario, since the reachable set differs by variant.
- 2026-11-14T11:05Z: **isochrone display filter** (C 11:42): `variants.yaml outputs.display_min_hole_m2` 100 (assumed, note in config); holes are filled before simplification; routing, T_home, bands and edges unchanged. 1-min isochrones with the filter are 2.25-2.92 MB gz (> 1.5), so the **2-min fallback** is used: 1.15-1.49 MB gz (nom_104 1.18). The fallback now reuses the even-minute 1-min features (no second contouring; run 6 min instead of 13). **Edges**: one MultiLineString per (budget, cause), lossless (nom_104 2.31 -> 1.48 MB raw; KAT: same pieces).
- 2026-11-14T11:05Z: **card timeline part** (C 11:42): `data/interim/engine/public/cards/{S}.timeline.json` (`pipeline/engine/cards.py`): `timeline` {arrive, leave, turn_back}, `margin_binding`, `contingency` (cart haul time from the access cell, F10); extras `station`, `scenario`, `on_route`, `margin_min`, `t_home_min`, `o2_home_L`, `science` {lon, lat}, `access` {lon, lat, dist_m, reason, walk_in, radius_m, rule}. The card-owned keys are checked against the card schema's sub-schemas; manifest keys `card.{S}.*` (file `cards/{S}.json`).
- 2026-11-14T11:05Z: **real run** `make engine` (commit 3bad2dd, 6 min 7 s), opt/nom x 80/104/120; con_* skipped (no V1). WS4 margins: t_dark 578.63 min; **tau_dose 85.9 min (storm peak, default)**. All public files validate (0 errors; the card fragments are not web files). Engine manifest fragments were cleared before the run (old keys archived), so no stale keys.
  - Headline unchanged: nom_104 **12.4 %** of the assessed 30-min disc (range [con pending V1, opt 17.5 %]); 60-min 11.2 %. Edge causes nom_104 30 min: slope 99.4 %, physiology 0.6 %, data 0 %.
  - **Access cells (nom_104)**:
    | Station | Science lon, lat | Access lon, lat | access_dist_m | Walk-in rise / mean / max along / max terrain slope | T_home nom_104 | O2_home |
    | --- | --- | --- | --- | --- | --- | --- |
    | S1 | 137.391523, -4.810007 | null | null | - | null: "38 assessed cells within 50 m, none with a walk home in this scenario" (same in all 6 scenarios) | null |
    | S2 | 137.383058, -4.776687 | 137.382736, -4.777025 | 27.6 | +7.79 m / 15.8 / 22.0 / 43.4 deg | 71.01 min | 95.56 L |
    | S4 | 137.408864, -4.785707 | 137.408842, -4.785679 | 2.1 | +0.59 m / 15.9 / 15.9 / 23.7 deg | 59.93 min | 77.72 L |
    Optimistic: S2 access 24.1 m (T_home 55.6 / 60.7 / 64.2 min at 80 / 104 / 120 kg), S4 2.1 m. S3, S5: no position (S).
  - **G1 route `route_nom_104`: pad -> S4 -> S2 -> pad, 209.7 min** (walk 149.7 + 2 x 30 dwell), legs 2,357 / 1,741 / 2,122 m, 48.4 / 30.3 / 71.0 min. Only 2 stations: S1 has no access cell, S3/S5 unpositioned, so no 3-station route yet. Timeline: arrive S4 48.4, leave 78.4, arrive S2 108.7, leave 138.7, return 209.7; O2 left at return 267.7 L. **Binding margin: dose** everywhere (storm tau 85.9 - T_home): 25.97 min at S4, **14.89 min at S2 (lowest)**. With `--dose latest` (tau 3,771.6 min, scratch run, not published) the same route is chosen and **O2 binds**: 224.1 min at S4, 168.3 at S2. Turn-back (latest leave, O2 term): S4 438.6 min, S2 409.2 min, i.e. after the 6.5 h EVA budget (see question 13). Both stations are outside the 60-min partner line (cart haul from the access cell 99 / 108 min).
  - **Sizes** (public tree, 6 scenarios): **79.5 MB raw, 12.1 MB gz** (was 159.5 / 22.0). Isochrones 7.7-9.9 MB raw (1.15-1.49 gz); bands 4.2-4.6 raw (0.58-0.65 gz); edges 1.4-2.0 raw (0.26-0.36 gz); partner 1.1-1.4 raw; rest < 0.05. Largest file 9.95 MB (opt_80 isochrones). With con_* expect about 107 MB raw / 16 MB gz. Git stores blobs zlib-compressed, so repo growth is about the gz column (under 25 MB); the **raw** tree is over 25 MB and cannot get there losslessly (see question 10).

- 2026-11-14T13:45Z (session 4): **D20 cart-only partner line** (user 14:22), KATs first (`tests/test_haul.py`: drag 179 kg on flat ground -> infeasible, reason traction; flat-ground numbers; `partner_cases` cart only). `haul.yaml partner_cases: [cart]` (drag stays in `cases`), `partner_label`, `partner_caption`, `drag_note` (SPEC F10 Output text). Haul fields: cart x (suited, 343 kg), nominal, ridge-masked; **no drag fields** (old drag rasters deleted). `partner.geojson` features: `label` "Partner line (cart haul, 60 min)", `caption` (design question), `drag_note`; top-level member `drag_finding` (flat ground, from config via `haul.drag_flat`). Card fragments carry `drag_note`.
  - **For WS5, manifest keys of the drag finding** (file `scenarios/nom_104/partner.geojson`, default suit 104): `haul.drag.flat.force_N` **398.454 N**, `haul.drag.flat.traction_limit_N` **350.595 N**, `haul.drag.flat.max_mass_kg` **157.5 kg**, plus `.casualty_kg` 179, `.rescuer_system_kg` 189, `.mu` 0.6, `.boot_mu` 0.5, `.feasible` false. Per suit: `haul.drag.flat.nom_{80,104,120}.*` in each `nom_{suit}/partner.geojson` (80: 345.03 vs 306.075 N, max 137.5 kg; 120: 434.07 vs 380.275 N, max 170.833 kg). Infeasible at every suit.
- 2026-11-14T13:45Z: **manifest keys (WS6 audit)**: `route.{sid}.leg.{i}.{t_min,o2_L,length_m,t_start_min,t_end_min,to_access_dist_m}` (i = the leg's 1-based `leg` property, file `route_{sid}.geojson`; 17 keys for nom_104) and `timeline.{sid}.{S}.access_dist_m` (S4 2.1, S2 27.6 m). KAT `test_traverse_manifest_keys`.
- 2026-11-14T13:45Z: **F8 siting** starts its forward runs at the access cells of the rule's scenario (`site.yaml siting.score` variant at the default suit = **con_104**), not nom_104's (KAT). `make engine` now passes `--siting`.
- 2026-11-14T13:52Z: **real run** `make engine`, all 9 scenarios, from clean commit 054ced5 (7 min 13 s). V1 `rmse_deg` 5.447 -> conservative no-go 14.553 deg. WS4 margins unchanged (t_dark 578.63, storm tau 85.9 min). All public files validate (0 errors); every engine manifest key is at 054ced5 (no `-dirty`); old engine fragments archived in `data/interim/engine/manifest_archive/`.
  - **Headline nom_104: 12.4 % of the assessed 30-min disc, range [4.6, 17.5] %** (con_104 / opt_104). 60 min: 11.2 % [1.7, 20.0].
  - **con_***: 30 min con_80 / con_104 / con_120 = **4.8 / 4.6 / 4.5 %**; 60 min 1.9 / 1.7 / 1.7 %. Blocked share of the 30-min disc at 14.55 deg: 58.7 % (nominal 41.2 %). Edges 99.5 % slope.
  - Stations under con_*: S4 access cell 2.1 m, T_home 71.2 / 76.5 / 80.1 min (80/104/120); **S2 has no access cell** in con_* (191 assessed cells within 50 m, none with a walk home); S1 none (as before).
  - **Trade table science_value: 0.0 in all 6 cells** (no station has a conservative T_home <= 60 min: S4 >= 71 min, S1/S2 unreachable). reachable_pct and partner_area_km2 as before (partner 1.31 / 1.23 / 1.19 km2).
  - **F8 / pad.json**: only S4 has a con_104 access cell, so the score is S4's value (0.475) or 0. 742 candidate blocks (20 m, all cells assessed, max slope <= 5 deg); **5 score 0.475, all tied**; the tiebreak (lowest elevation) picks **137.402443, -4.769028, elev -3811.3 m, block max slope 3.95 deg**; alternatives rank 2 (137.405846, -4.764625, -3810.1 m) and 3 (137.393301, -4.776468, -3779.5 m), same score. `assessed_pct_30min` and `rule_passed` are **null**: the 1,764 m disc around the proposed pad leaves the 3 m grid (pad 1.5 km from the north edge). No rover-hop option (no second station to add). The default pad's block is not a candidate (fails the 5 deg / assessed rule). Reading: with one station the rule cannot discriminate; this is a proposal for S, **pad_default unchanged** (user 11:24). `siting.png` 30 KB, `siting_png.json`, `siting.tif` (interim).
  - Route nom_104 unchanged: pad -> S4 -> S2 -> pad, 209.7 min; binding dose, lowest 14.89 min at S2.
  - **Sizes** (public tree, 9 scenarios, excl. card fragments): **108.4 MB raw, 16.7 MB gz**; largest file 9.95 MB (opt_80 isochrones); con_* isochrones 8.0-8.6 MB raw (1.19-1.27 gz), con_* edges 0.6 MB; bands 4.9-5.4 MB raw (0.70-0.78 gz, now with con bands). opt_80 isochrones are 1.53 MB gz on the 2-min fallback (0.03 over the 1.5 budget; other 8 within). Every file < 50 MB.
- D19 (14:19): no engine change. Q13 (turn-back cap) stays open for S.
- 2026-11-14T14:24Z (session 5): **pad.json writer fixed** (C 14:58, contract pad v1.1.2), KATs first (`pipeline/engine/tests/test_siting_trade.py`: pad equals `pad_default`, proposal never adopted (and the contract refuses `adopted: true`), file validates, manifest keys; `test_scenarios.py` CLI e2e). Commit 9ae1ca7; full suite 763 pass.
  - **Shape:** `pad` = the pad **in use**: `pad_default` lon/lat exactly (137.382, -4.806), `source` "config/site.yaml pad_default (kept by the user, 14 Nov 11:24)", and the F8 rule evaluated there: elev -3627.8 m, **score 0.0** (no station within conservative 30 min: S4 is the only con_104 station), `checks` {assessed_pct_30min **100.0**, max_slope_deg **28.06** (steepest cell of the 21 m square centred on the pad, the F8 block test; the pad cell itself is 6.4 deg), rule_passed **false**}. Top-level `alternatives` and `hop_options` are `[]` (they belong to the proposal); `site_rule_version` = the rule text.
  - **`proposal`** {`adopted`: false, `note` "... pad_default is kept; S decides ...", `pad` 137.402443, -4.769028 (score 0.475, max slope 3.95, disc check null), `alternatives` ranks 1-3 (all 0.475), `hop_options` [], `site_rule_version`, `tie` {top_score 0.475, n_blocks_at_top_score 5, n_candidate_blocks 742, tiebreak, note}, `stations` ["S4"], `no_access` {S1, S2 reasons}, `checks_note` (the 1,764 m disc leaves the 3 m grid; the proposed pad is 1,510 m from the edge)}.
  - **Manifest keys** (all `file: pad.json`, script siting.py, commit 9ae1ca7): `pad.{lon,lat,elev_m,score}`, `pad.checks.{assessed_pct_30min,max_slope_deg,rule_passed}`; `pad.proposal.{lon,lat,elev_m,score}`, `pad.proposal.checks.max_slope_deg` (null checks unrecorded), `pad.proposal.alternatives.{rank}.{lon,lat,elev_m,score}`, `pad.proposal.tie.{top_score,n_blocks_at_top_score,n_candidate_blocks}`, `file.pad.json`.
  - **Re-run only F8 + pad:** new `python -m pipeline.engine.scenarios --siting-only` (con_104 return field in memory, access cells, siting; no other product touched; patches `summary.json` `siting`). Run from clean 9ae1ca7: `pad.json`, `siting.png`, `siting_png.json`, `siting.tif` rewritten (siting output unchanged).
  - **For C / WS5 (shape differs):** WS5's `web/src/map/pad.ts padProposal()` and `types.ts PadProposalBlock` read `proposal.lon/lat/score/checks/rule`; contract v1.1.2 (and this file) has `proposal.pad.{lon,lat,score,checks}` and `proposal.site_rule_version`. As is, `padProposal()` returns null (no proposal marker; the panel shows its fallback text). The manifest key names WS5 cites (`pad.proposal.{lon,lat,score}`, `pad.proposal.checks.{max_slope_deg,assessed_pct_30min}`, `pad.checks.*`) match. Fix belongs in WS5 (read `b.pad.*`, `b.site_rule_version`; optionally `checks_note`, `tie`).

- 2026-11-14T14:40Z (session 6): **S answers (decision log 15:40) implemented**, KATs first (`tests/test_physio.py`, `pipeline/engine/tests/test_margin.py`; full suite green). Commits 2afd6e5, 8b45ac9, 51e5e92.
  - **alpha on the IST-2 weight span.** `variants.yaml`: `ist2.delta_mass_kg` removed; `ist2.level_span: weight_span`; `formulas.ist2_span_kg` = (g_frac[1] - g_frac[0]) x g_earth x (system_kg + subject_kg) / crew.g_mars = 0.20 x 9.80665 x 201.7 / 3.71 = **106.63 kg**; `formulas.alpha` = level_increment / (span_kg x anchor.speed) = 1.9 / (106.63 x 0.98) = **0.018182** (was 0.032313). Derived values and the decision are written in `ist2.alpha_encoding` (KAT recomputes both). `physio.ist2_span_mars_kg()`, `physio.alpha_level()`.
  - **O2 budget via ICES-2026-127.** `crew.yaml o2_budget.formula` = hours x BTU/h / 3.96567 / (4.039 + 1.157 x 0.85) = 5.02245 kcal per L O2; `conversion: o2_margin.conversion`. **Primary 481.99 L (was 504), secondary 150.62 L (was 157)**; the engine computes it (`margin.o2_budget_l`), `primary_L: 482` / `secondary_L: 151` stay in the yaml as rounded documentation (KAT checks them; the web scorecard reads them). `make dummy` re-run (dummy timeline/manifest carry 481.99; C's tree, generated only).
  - **`O2_station_tasks` confirmed** (task O2 still to do at the current station, 0 while walking): note added in `margin.py` and `crew.yaml o2_margin.formula`; no "S to confirm" left.
  - **Casualty mass:** no change (haul.yaml 155 / 179 / 195 kg).
  - **20.1 J/mL still used (not changed, for S):** `crew.yaml o2_energy_j_per_ml` feeds (1) the uphill term k (`physio.k_uphill`, `variants.yaml formulas.uphill_k`, SPEC F3), (2) metabolic heat `physio.heat_w` (SPEC F3 "Heat ~ 20.1 J per mL O2"), (3) the haul power P_avail (`haul.py`, `haul.yaml p_avail_w`, K = m_b x 20.1 / 60). At 5.02245 kcal/L the review conversion is 21.01 J/mL (+4.5 %); if S wanted it in k, k would drop 4.3 %. Left at 20.1 per the decision.
  - **IST-2 weight-span check with the new alpha.** alpha is now defined per kg of carried mass at Mars g on the IST-2 weight span, so a weight change also moves the model's level term: + alpha x 106.63 kg x v = 1.9 x v / 0.98 = **+1.09 to +1.88** mL/kg/min over 0.56-0.97 m/s (the same in every variant; it equals 1.9 v / 0.98 by construction, so it does not depend on the alpha value). `band` now includes it (the model's prediction, pass rule); `band_vertical_only` is the session-2 band (k only, unchanged).
    | Variant (eta) | 20 % band (with level term) | 8.7 inside? | 30 % band | 17.0 inside? | vertical-only 20 % / 30 % (session 2) |
    | --- | --- | --- | --- | --- | --- |
    | optimistic (0.25) | 7.51-13.02 | yes | 10.50-18.20 | **yes** (was no) | 6.43-11.13 yes / 9.42-16.31 no |
    | **nominal (0.225)** | 8.23-14.25 | **yes** | 11.55-20.01 | **yes** | 7.14-12.37 yes / 10.47-18.13 yes |
    | conservative (0.20) | 9.12-15.80 | **no** (was yes; 8.7 < 9.12) | 12.86-22.27 | yes | 8.04-13.92 yes / 11.77-20.39 yes |
    Nominal passes either way. Reported, not tuned.
- 2026-11-14T14:46Z: **real run** `make engine` (all 9 scenarios + `--siting`) from clean commit **51e5e92**, 7 min 8 s. Engine manifest fragments archived first (`data/interim/engine/manifest_archive/20261114T1446Z/`); every new engine key is at 51e5e92 (no `-dirty`). WS4 margins unchanged (t_dark 578.63 min, storm tau 85.9 min). All public files validate except the card fragments (not web files, as before).
  | Quantity | Before (054ced5 / 9ae1ca7) | After (51e5e92) |
  | --- | --- | --- |
  | Headline nom_104, 30 min | 12.4 % [4.6, 17.5] (12.39; con 4.62, opt 17.53) | **12.4 % [4.6, 17.5]** (12.37; con 4.61, opt 17.50) |
  | 60 min nom_104 | 11.2 % [1.7, 20.0] | **11.1 % [1.7, 19.9]** (11.14; 1.73, 19.94) |
  | 30 min nom_80 / nom_120 | 12.9 / 12.1 % | 12.8 / 12.2 % (12.78 / 12.15) |
  | 60 min nom_80 / nom_120 | 12.6 / 10.3 % | 12.3 / 10.4 % (12.29 / 10.40) |
  | 30 min opt_80/104/120; con_80/104/120 | 18.2 / 17.5 / 17.1; 4.8 / 4.6 / 4.5 % | 18.0 / 17.5 / 17.2; 4.7 / 4.6 / 4.5 % |
  | a(M) nom 80 / 104 / 120 kg suit | 12.296 / 13.071 / 13.588 | 12.720 / 13.156 / 13.447 |
  | Level VO2 at 0.98 m/s, nom 80 / 104 / 120 | 18.05 / 18.81 / 19.32 | **18.47 / 18.89 / 19.18** mL/kg/min |
  | Level v*, nom 80 / 104 / 120 | 0.976 / 0.918 / 0.883 m/s | **0.943 / 0.912 / 0.892** m/s |
  | Route nom_104 | pad -> S4 -> S2 -> pad, 209.74 min; legs 2,357 / 1,741 / 2,122 m | **same stops, 210.10 min**; legs 2,357 / 1,751 / 2,122 m (48.54 / 30.31 / 71.25 min); legs 1-2 geometry moved slightly, leg 3 identical |
  | Binding / lowest margin nom_104 | dose everywhere; lowest 14.89 min at S2 | **dose everywhere; lowest 14.65 min at S2** (S4 25.78) |
  | O2 term at S2 arrival (not binding) | 168.3 min | 151.4 min |
  | O2 at depart / return | 504.0 / 267.65 L | **481.99 / 244.88 L** |
  | Turn-back (O2) S2 / S4 | 409.2 / 438.6 min | **382.2 / 411.9 min** (S2 now inside the 390-min EVA budget, S4 still after it; Q13) |
  | T_home S4 nom 80/104/120; con 80/104/120 | 55.93 / 59.93 / 62.66; 71.21 / 76.52 / 80.14 | **56.83 / 60.12 / 62.33; 72.37 / 76.77 / 79.73** min |
  | T_home S2 nom 80/104/120 (con: no access cell) | 64.75 / 71.01 / 75.23 | **65.89 / 71.25 / 74.83** min |
  | T_home S2 / S4 opt_104 | 60.73 / 55.55 | 60.93 / 55.72 min |
  | con_* reachable stations | S4 only (access 4.7 m); S2, S1 none | **unchanged: S4 only** |
  | Trade science_value | 0.0 in all 6 cells | **0.0 in all 6 cells** (S4 con >= 72.4 min > 60) |
  | Trade reachable % 30 min 80/104/120 | 12.9 / 12.4 / 12.1 | 12.8 / 12.4 / 12.2 |
  | Partner area 80/104/120 | 1.3135 / 1.2331 / 1.1933 km2 | 1.3053 / 1.2323 / 1.1948 km2 |
  | pad.json / F8 | pad_default score 0, proposal 137.402443, -4.769028 (0.475, 5 of 742 tied) | **unchanged** |
  | Access cells (S2 27.6 m, S4 2.1 m nom) | | **unchanged** (reachability does not depend on speed) |
  | Public tree | 108.4 MB raw / 16.7 MB gz; largest 9.95 MB | **108.0 MB raw / 16.6 MB gz**; largest 9.80 MB (opt_80 isochrones); all isochrones now <= 1.5 MB gz (opt_80 1.47) |
  - **Downstream (C to re-run):** WS7 `make fields` (t_home / o2_home / pointer rasters changed in all 9 scenarios; worst-case fields too) and the HUD timeline (O2 starts at 481.99 L); WS3 cards: access cells and observers unchanged, so the WS3 parts need **no** re-run, only `make web` to merge the new WS2 timeline parts (arrive/leave/turn_back changed); WS8: route legs 1-2 geometry moved (leg 3 identical), so re-run `terrain_chunks` (corridor) if it is built from the route; the 3D camera reads route/timeline at runtime; WS9 (suspended, D19): its published Monte Carlo used the old route/timeline and the old t_home (fix-interval map), now stale; re-run only if the add-on resumes, or label it as on the pre-15:40 route.

- 2026-11-14T15:20Z (session 7): **D21 official pad + pad picker, D22–D30, D39**, KATs first (`pipeline/engine/tests/test_padpick.py` new: tiebreak order, official = top-ranked, picker excludes the official pad and adds pad_default, picker with pad_default inside the next 3 or official, 30-min disc grid filter, screening matrices = per-candidate `access.find` runs on a sealed-pocket world, bounded tiebreak field = full field, D22 passability; `test_orienteering.py` feasible-subset counter = brute force (known answer, 6 random, monotone leg check); `test_margin.py` D24/D28/D29/D39; `test_physio.py` D23/D29/D30; `test_scenarios.py` timed dose on a plane, `--d21` end to end). Code commit cb164ae; full suite 858 pass, 1 fail (WS7 `test_fields_png::test_real_pointer...` compares WS7's stale real export with the new t_home: clears after `make fields`).
  - **D22:** `graph.passable_mask` = `cellstate != unknown & stepguard == 0 & slope_3m <= nogo` (`load_ws1_grid` requires `slope_3m.tif` + `stepguard_3m.tif`); the F8 block test and pad `max_slope_deg` use `slope_3m`; `maxslope_3m` is only used for the walk-in "rough footing" number. **D23:** `variants.yaml` conservative `nogo_deg: 17`; V1 is no longer read (`--v1-json` removed). **D24:** `crew.yaml o2_margin.reserve_L` (formula) + `reserve_label` "30 min at the effort cap (EMU precedent)" = 40.5 L. **D29:** one `o2_energy_j_per_ml: 21.0` for k, heat, haul and every BTU/h -> O2 conversion (`o2_budget.j_per_btu` 1055.056 added): budget **482.31 L** (was 481.99), task rate **0.8373 L/min** (derived; 0.84 kept as rounded doc), planning rate 1.0048 L/min. **D30:** `physio.ist2.{variant}.{20|30}.{pass,band_lo,band_hi,reported}` in the manifest (file `scenarios/index.json`, block `model_checks`): opt pass/pass, **nom pass/pass**, con **miss** (20 %: 8.7 < 8.78) / pass. **D27:** 50 m, still `assumed`. **D26:** stations from WS1 (S1, S2, S4, S6, S7, S8; S3/S5 dropped); `stations.json` adds `reachable_on_foot` + `reachability_label` (`stations.yaml placement.unreachable_label`) when no scenario reaches a station (none today; S7 has no con_* access cell).
  - **D28:** the margin has an EVA term `crew.eva_h x 60 - t - T_home` ("EVA duration", contracts v1.1.3) in the DP leg checks, the timeline and the turn-back (min over all terms; the turn_back row's `margin_binding` names the term that set it); cards get `turn_back_binding`.
  - **D39 (documented in `margin.py`):** `conditions.yaml storm_replay` + WS4 `rad.json`: the storm series (sample midpoints, nulls dropped, linear between) is shifted so the tripwire fires at t* = the route minute of the largest T_home (first max over every route vertex and dwell point); dose term = tau(t) - T_home with tau(t) = 60 x D_allow / Ddot(t). The tau(t) term is not monotone in time, so the DP plans with O2, daylight and EVA duration; t* comes from that route; the timeline, turn-backs and `route.dose` use the timed term (a negative dose margin would be reported as `violation`, not hidden). CLI `--tau-dose-min` or `--dose latest` keep a static tau.
  - **D21 (`pipeline/engine/padpick.py`, `make engine` = `scenarios --siting --d21`):** candidates = F8 blocks (20 m, all assessed, slope_3m <= 5 deg: **1,129**) + pad_default; **934 dropped** (30-min disc leaves the grid, 16:16) -> **196 screened**. Screening (nom_104): per station, access cells nearest first, one forward + one reverse Dijkstra per strongly connected component reached (S1, S4, S7, S8: 1 pair; S6: 7, S2: 27 pairs, sealed pockets inside 50 m, each a small run); every candidate got an access cell for all 6 stations. Count = subsets of the 6 stations with a route <= 390 min incl. dwell (max 63). Tiebreak 1 (30-min bounded field) for the 5 candidates at >= the 5th-best count; full runs (exact DP, margin >= 0 on every leg) for the top 5 (pad_default is screening rank 5, so no extra run). Times: candidates 1.6 s, station Dijkstras 45.7 s, counts 0.2 s, tiebreak 3.0 s, full runs 153.5 s (**screening total 204 s**); picker products 178.6 s; whole `make engine` 1,078 s (about 18 min; isochrones of 9 scenarios 564 s).
  - **Ranking (score = feasible-EVA count from the full run; screening count in brackets):**
    | Rank | id | lon, lat | elev m | Score (screen) | Tiebreak 1: reachable % 30 min | Role |
    | --- | --- | --- | --- | --- | --- | --- |
    | 1 | `rank1` | 137.401783, -4.777480 | -3742.4 | **38** (52) | **22.98** | **official pad** (`pad.json`) |
    | 2 | `rank2` | 137.393301, -4.776468 | -3779.5 | 38 (51) | 21.46 | picker |
    | 3 | `rank3` | 137.393301, -4.776114 | -3779.4 | 38 (51) | 21.19 | picker (39 m north of rank2) |
    | 4 | `rank4` | 137.387206, -4.781529 | -3778.5 | 37 (50) | 22.14 | picker |
    | 5 | `pad_default` | 137.382, -4.806 | -3627.8 | 31 (50) | 16.70 | picker |
    Ranks 1–3 tie on 38; tiebreak 1 decides (tiebreak 2 not needed). The margin check costs 12–19 subsets per pad against the time-only screening, because the DP bounds O2 used before each leg at the 1.35 L/min effort cap (assumption below). Screening histogram and the top 10 are in `summary.json d21` and `pad.json d21.screening_top`.
  - **pad.json** (contract v1.1.2 + extras for C): `pad` = rank1, `source` cites D21, `score` 38 with `score_kind` "d21_feasible_eva_count", `id`, `tiebreak`, `f8_score` 0.4744 (the F8 rule's score at the pad), checks: assessed 100.0 %, block max slope 4.86 deg, rule_passed true. `alternatives` = rank2, rank3, rank4, pad_default (rank 2–5) + `f8_proposal` (rank 6) with extras `id`, `kind`, `score_basis`, `d21_rank`, `tiebreak`, `picker`, `note`. The F8 rule on the D22 grid now proposes **137.378775, -4.769028** (score 1.4352, unique; its 30-min disc leaves the grid, so it is not a D21 candidate: score null). `proposal` block kept (adopted false, note "superseded by D21"); top-level `d21` block (decision, order, screening stats, assumptions). `site.yaml pad_default` unchanged.
  - **Picker files** (`scenarios/pads/{id}/`, ids `rank2`, `rank3`, `rank4`, `pad_default`: `rank{n}` = D21 rank in this run, pad_default keeps its name; the official pad is `rank1` in the index): `summary.json` (id, kind, scenario, pad {lon, lat, elev_m}, rank, official false, score, score_kind, tiebreak {reachable_pct_30, elev_m}, headline {"30"/"60": {budget_min, reachable_pct, range_pct [con, opt]}}, route {stops, total_min, n_feasible_subsets, unreachable, no_access, margin_terms, lowest_margin_min/binding, turn_back, dose}, files, note), `bands_104.geojson` (nominal only), `edges.geojson`, `partner.geojson` (cart, D20), `route_nom_104.geojson`, `timeline_nom_104.json`; `scenarios/pads/index.json` {dummy false, scenario, score_kind, order, official, decision, ids, pads [{id, kind, lon, lat, elev_m, rank, score, official, picker, tiebreak, screen_score, screen_rank, summary, (official: files note, route)}], screening}. No isochrones or fields on the web; rasters in `data/interim/engine/pads/{id}/nom_104/` and `.../haul/`. The headline range comes from the pad's con/opt return fields (in memory, 60-min bounded). Manifest (`pipeline__engine__padpick.json`, `traverse.json`, `scenarios.json`): `pads.{id}.{lon,lat,elev_m,rank,score}`, `pads.{id}.tiebreak.{reachable_pct_30,elev_m}`, `pads.{id}.headline.{30,60}.reachable_pct`, `.range_pct.{low,high}`, `pads.{id}.route.{total_min,lowest_margin_min,margin_terms,leg.{i}.*,dose.*}`, `pads.{id}.timeline.{i}.*`, `pads.{id}.haul.drag.flat.*`, files = web paths (picker keys cite `summary.json`; rank1/rank5-not-picked rows cite `scenarios/pads/index.json`). Sizes: **23.8 MB raw / 3.7 MB gz** for all 4 picker pads (largest 2.76 MB, pad_default bands).
    | Picker pad | Route (nom_104) | min | Lowest margin | 30-min % [con, opt] | 60-min % |
    | --- | --- | --- | --- | --- | --- |
    | rank2 | S7 -> S6 -> S1 -> S4 | 326.03 | 47.64 dose | 21.5 [16.4, 30.3] | null (disc off grid) |
    | rank3 | S7 -> S6 -> S1 -> S4 | 326.49 | 47.29 dose | 21.2 [16.2, 30.1] | null |
    | rank4 | S7 -> S6 -> S1 -> S4 | 320.66 | 53.23 dose | 22.1 [17.2, 30.9] | null |
    | pad_default | S4 -> S7 -> S6 -> S1 | 316.39 | 23.26 dose | 16.7 [13.0, 20.5] | 14.9 [10.2, 27.6] |
- 2026-11-14T15:43Z: **real run** `make engine` (D21 screening, all 9 scenarios + siting on the official pad, picker) from clean commit **30403d4** (main 3c0f1a8 + WS2; WS1's D22 grids and D26 stations and WS4's `storm_replay` were already on disk / in config). Engine fragments archived first (`data/interim/engine/manifest_archive/20261114T1543Z/`); **1,778 engine keys, all at 30403d4, 0 `-dirty`**. Afterwards merged main 08ec049: it changes no engine input (site.yaml slope text, stations.yaml placement text, WS6 `manifest.py`; the only code change since, reading the "not reachable on foot" label from `stations.yaml` instead of the same literal, changes no output). Public tree **137.2 MB raw / 21.7 MB gz** (picker incl.); every file < 50 MB; isochrones all on the 2-min fallback, <= 1.5 MB gz (opt_80 1.495, nom_104 1.337). All public files validate (picker summary/index have no schema yet).
  | Quantity | Before (session 6, pad_default, 51e5e92) | After (official pad rank1, 30403d4) |
  | --- | --- | --- |
  | Pad | pad_default 137.382, -4.806 (-3627.8 m) | **137.401783, -4.777480 (-3742.4 m)**, 38 feasible EVAs (pad_default 31) |
  | **Headline nom_104, 30 min** | 12.4 % [4.6, 17.5] | **23.0 % [15.2, 28.7]** (22.98; con 15.16, opt 28.66) |
  | 60 min nom_104 | 11.1 % [1.7, 19.9] | **null** (the 3,528 m disc leaves the grid: 75.8 % of it is inside; report-only in-grid share: nom 31.5, con 16.2, opt 43.8, nom_80 33.3, nom_120 30.2 %) |
  | 30 min nom_80 / nom_120 | 12.8 / 12.2 % | 24.5 / 22.1 % |
  | 30 min opt_80/104/120 | 18.0 / 17.5 / 17.2 % | 30.7 / 28.7 / 27.5 % |
  | **30 min con_80/104/120** | 4.7 / 4.6 / 4.5 % | **16.0 / 15.2 / 14.6 %** (D22 + D23 + new pad) |
  | Route nom_104 | pad -> S4 -> S2 -> pad, 210.10 min | **pad -> S7 -> S6 -> S1 -> S4 -> pad, 325.94 min** (value 2.7267); legs 44.39 / 54.10 / 43.45 / 52.65 / 11.36 min, 2,074 / 1,921 / 1,372 / 2,607 / 678 m; S2, S8 not visited (no 5-station route fits the margins) |
  | Lowest margin / binding | 14.65 min dose at S2 (dose binds everywhere, static tau 85.9) | **41.21 min dose** (leave S7, 74.39 min); dose binds at S7/S6, **O2 from S1 on** (S1 101.13, S4 62.50, return 62.50); track minima: O2 62.50, daylight 252.69, dose 41.21, EVA 64.06 |
  | D39 storm | static tau 85.9 min everywhere | t* = **44.39 min** (arrive S7, T_home 45.42), tau(t*) 113.68 min, smallest tau on the route 86.63 min (peak 22.75 min after t*, while working at S7); no violation |
  | Turn-back | S2 382.2, S4 411.9 min (O2, S4 beyond 390) | **S7 344.58, S1 347.71, S6 348.77, S4 378.64 min, all "EVA duration"** (D28) |
  | O2 depart / return | 481.99 / 244.88 L | 482.31 / 124.87 L |
  | T_home nom_104 | S2 71.25, S4 60.12 (S1 none) | S1 42.29, S2 68.07, S4 11.36, S6 41.23, S7 45.42, S8 47.06 |
  | T_home con_104 | S4 76.77 only | S1 44.94, S2 143.46, S4 11.55, S6 30.07, S7 **none** (512 assessed cells, none walks home), S8 127.32 |
  | Access distance nom_104 | S2 27.6, S4 2.1 m | S2 44.9, S6 15.5, others 0 m |
  | Trade science_value 30 / 60 (80/104/120) | 0 everywhere | 1.1872 / 0.4744 / 0.4744; 2.0281 x 3 |
  | Trade reachable % 30 / 60 | 12.8/12.4/12.2; 12.3/11.1/10.4 | 24.5/23.0/22.1; **null** (60-min disc off grid) |
  | Partner area 80/104/120 | 1.305 / 1.232 / 1.195 km2 | 2.994 / 2.666 / 2.527 km2 |
  | F8 proposal | 137.402443, -4.769028 (0.475, 5 of 742 tied) | 137.378775, -4.769028 (1.4352, unique of 1,129) |
  | Public tree | 108.0 MB / 16.6 MB gz | 137.2 MB / 21.7 MB gz |
  - Note: con_104 T_home at S6 (30.07) is below nom_104 (41.23): the conservative access cell (other side of a ridge within 50 m) is not the nominal one. It is the access-cell rule as decided (D27), reported, not changed.
  - **Downstream (C to re-run):** everything that reads the pad must take it from `pad.json` (or the engine outputs), not `site.yaml pad_default`: **WS3** pad horizon (`pipeline/horizon` reads pad_default) + station cards for the new stations (S1, S2, S4, S6, S7, S8 access cells all new); **WS7** `make fields` + worst-case (all 9 return fields changed, pad moved; HUD timeline O2 482.31 L, EVA-duration binding, D39 timing); **WS8** fp3d terrain chunks / corridor / camera start (route and pad moved); WS4 `clock.json t_dark` is computed at pad_default (flat horizon; 578.63 min used) — re-run at the official pad if it matters; WS9 (suspended) stale; `make web` (stations.json, cards timeline parts with `turn_back_binding`, pads tree). WS5: picker shapes above; differences from C's 16:5x note: summary has extra keys, `headline` entries carry `budget_min` and `range_pct` as `[low, high]` (con, opt), index rows carry extra `kind`, `picker`, `screen_*`, `summary`.

- 2026-11-14T16:44Z (session 8): **D41 60-min headline, user 17:28 excluded-combination counts, D40 golden.json.** D43's DP switch was **not** made (user 17:28 supersedes it: the route DP keeps the effort-cap bound; routes, timelines, cards, counts and the ranking are byte-identical to session 7, checked by diff). D44: official pad rank1 frozen, `pad.json` untouched. KATs first (`test_envelope_edges.py` D41 half-disc known answer + headline entry; `test_scenarios.py` headline_60 on the dummy world, `--d21` feasible blocks + `--headline-patch` reproduces the full-run files; `test_golden.py` 12 tests). Code commits c57ee3f, bbe8cf8; full suite green.
  - **D41 (`envelope.reachable_pct(in_data=True)`, `envelope.disc_in_data_pct`, `scenarios.headline_entry`; config `variants.yaml outputs.headline_in_data_budgets_min: [60]`):** at 60 min a disc that leaves the terrain data gives the share over its part inside the data (in = inside the 3 m grid and not unknown), shipped with that part's size; 30 min keeps the strict rule. Run: `scenarios --headline-patch` from clean c57ee3f (return fields recomputed in memory, bounded at 60 min, never written; the 30-min headline is recomputed and must equal the published one: it did). 0 `-dirty` keys (1,842 engine keys at 30403d4 / c57ee3f).
    | Where | 60 min (before: null) | Manifest keys |
    | --- | --- | --- |
    | `scenarios/index.json` new `headline_60` per scenario {budget_min, reachable_pct, range_pct [con, opt], basis "in_data", in_data_pct, label} | **nom_104 31.5 % (16.2–43.8)**, in data 75.8 %; nom_80 33.3, nom_120 30.2; con 17.3/16.2/15.4; opt 45.9/43.8/42.4 | `reachable_pct.{sid}.60`, `reachable_pct_range.{sid}.60.{low,high}`, **`headline.{sid}.disc_60.in_data_pct`** (75.8, label "75.8 % of the circle lies inside the terrain data") |
    | `trade_table.json` 60-min row (+ cell `in_data_pct`) | 33.3 / 31.5 / 30.2 % (80/104/120) | `trade.60.{m}.reachable_pct`, `trade.60.{m}.in_data_pct` |
    | Picker `summary.json` `headline["60"]` (+ basis, in_data_pct, label) | rank2 22.7 (12.0–38.8), in data 80.3 %; rank3 22.6 (11.9–38.7), 79.9 %; rank4 17.0 (10.4–35.1), 87.2 %; pad_default 14.9 (10.2–27.6), full disc (unchanged) | `pads.{id}.headline.60.{reachable_pct, range_pct.low/high, in_data_pct}` |
    The 30-min figure stays the headline (`headline`); `headline_60` is an extra key (scenarios_index schema is open; C to add it to the contract).
  - **User 17:28: combinations the effort-cap rule excludes** (`padpick.feasible_block`): `feasible` {screen_count, full_run_count, excluded_by_effort_cap_rule, note} on every `scenarios/pads/index.json` row and each picker `summary.json`; manifest `pads.{id}.feasible.excluded_by_effort_cap_rule` + `pads.{id}.feasible.screen_count` (file: the summary for picker pads, `scenarios/pads/index.json` for rank1).
    | Pad | Screening (time only) | Full run (margin, effort cap) | Excluded |
    | --- | --- | --- | --- |
    | rank1 (official) | 52 | 38 | **14** |
    | rank2 | 51 | 38 | 13 |
    | rank3 | 51 | 38 | 13 |
    | rank4 | 50 | 37 | 13 |
    | pad_default | 50 | 31 | 19 |
    Caveat in the note: the difference is screening − full run as C asked; besides the effort-cap O2 bound it also holds the daylight / EVA-duration leg checks and the access-cell tie-break difference (row/col vs T_home), so it is an upper bound on what the O2 bound alone removes.
  - **D40 `physio/golden.json`** (`pipeline/engine/golden.py`, `make engine` runs it; written to `data/interim/engine/public/physio/golden.json`, 74.6 kB, version 1.0.0, manifest `file.physio/golden.json`, `physio.golden.version`, `physio.golden.n_cases` = 83, commit bbe8cf8). Deterministic (no clock/commit inside); `golden.check(doc)` re-evaluates every case from its inputs (`python -m pipeline.engine.golden --check FILE`: all pass); a 1 % change to any expected value is caught (KAT). Contents: `coords` (pad-local metres, x E, y N, z up), `units`, `conventions`, `tolerances` per group, `config` snapshot (crew, variants, derived alpha/reserve 40.5 L/effort 1.35/task 0.8373/budget 482.31/EVA 390, formulas, o2_margin, haul, leash) and cases:
    - `physio` (45): 5 grades (-20, -10, 0, 10, 20 deg) x 3 variants x 3 suits: a(M), k, cost slope, v_safe, v*, VO2 at v*, passable, pace, O2 L/m, heat W.
    - `o2_leg` (3): a 4-segment leg (level 300 m, +5.0 deg over 400 m, -6.7 deg over 300 m, -7.6 deg over 300 m) per variant at 104 kg: per segment and total t, O2.
    - `haul` (13) + `haul_drag_finding` (1): cart, suited 179 kg and bound 343 kg at -10..20 deg (force, traction limit, speed, feasible, reason); drag flat = traction failure (398.5 N > 350.6 N, max 157.5 kg).
    - `margin` (6): depart, arrival with station tasks, O2 / daylight / dose (negative) / EVA-duration binding: every term, margin, binding, O2 left, planning-rate O2 term.
    - `turn_back` (2): latest departure on a straight way home, EVA duration binds (390 − T_home) and O2 binds (small budget).
    - `dose_leash` (12): tau = 60 D_allow / Ddot for D_allow 0.25/0.5/1.0 mGy x 226/3000/6000/24000 uGy/day.
    - `route` (1): 3 % plane, 3 stations, nominal 104 kg, t_dark 578.6, static tau 113.7: legs with per-vertex xyz / tau / O2 / T_home / O2_home, way-home series per station, expected order A -> C -> B (119.09 min, 7 feasible subsets) and 14 timeline rows with their inputs.
  - Before → after (session 7 → 8): everything identical except the files listed above (diff of the public tree: `scenarios/index.json`, `trade_table.json`, `scenarios/pads/index.json`, 4 picker summaries; new `physio/golden.json`).

- 2026-11-14 (session 9): **D44 names in the engine's public files, no recompute.** New `python -m pipeline.engine.scenarios --stations-only` (`scenarios.stations_names_patch`, needs no grid): copies WS1's `name`, plus `name_base` and `name_suffix` where WS1 has them (S6, S7), into every published file with a station-keyed `name`. It refuses (exit 3, writes nothing, says "do a full re-run") if the station ids, lon/lat (6 dp), `value` or `dwell_min` differ from `stations.json`, or a card's `science` point differs from WS1's. `station_records` (full run) now passes `name_base`/`name_suffix` through the same way. KATs first: `tests/test_station_names.py` (12 tests: other files byte-identical, non-name fields and key order equal, idempotent, cards with names renamed, refusal on lon/lat/ids/value/dwell/card point), plus an e2e no-op check after a full run in `test_main_on_synthetic_terrain`. Code commit acf85b1.
  - Run from clean acf85b1: **only `stations.json` changed** (sha256 of all 64 public files compared before and after). S6 = "dense ridge network + high SINDEX2 sulfate signal (south-west, nearer)", S7 = "… (south-west, farther)", S1/S2/S4/S8 unchanged. Every non-name field is equal. Manifest: `file.stations.json` re-recorded at acf85b1, and no engine key is `-dirty`. `validate_contracts --interim` OK.
  - Card timeline parts (`cards/{S}.timeline.json`), picker summaries, timelines and routes carry **no station names** (only ids), so they were not rewritten. WS1's top-level `same_name_suffix` block is not copied: the web `stations.json` is a contract array with no top level.
  - Downstream: `make web` (C) picks up the new names. WS3 cards and WS5 read the names from there.

- 2026-11-14T19:44Z (D48 backend support, branch `ws2-backend-support`, commit 5e41a3b; verified by a second session after the first one ended): tasks A, B and C.
  - **A. `build_plan` (pipeline/engine/plan.py) + `padpick.station_fields`.** Signature kept as committed (user decision 20:30): `build_plan(grid, *, pad_lonlat, scenario_ids, settings, out_dir, public_dir, terrain_dir, stations_list, ..., crew, manifest_dir, on_stage) -> summary`; `station_fields(grid, station, scenario | Params, settings) -> (forward, reverse)`. No module-level path is read inside them (inputs: arguments, plus `terrain_dir/stations.json` and `ridge_index.tif` only when not passed in memory). `scenarios.main` calls `build_plan`; the D21 pick (`padpick.run`, writes no files) stays batch-only and feeds `pad_lonlat` and `d21`. `--headline-patch` and `--stations-only` are not steps of `build_plan`: they patched already published files, and the full run reproduces both (`web_products` -> `headline_extra` = `headline_60` / `in_data_pct`; padpick `feasible_block`; `stations_product` reads WS1's current names). The parity run below proves it: `scenarios/index.json`, `trade_table.json`, every picker summary and `stations.json` are byte-identical.
  - **`make engine && make web` from 5e41a3b (17 min 46 s, exit 0), diff in `web/public/data/` vs main d943f39:** 3 files. `manifest.json`: 3,704 changed fields, all `utc` / `commit` except 2 values, `file.pad.json` and `file.scenarios/pads/index.json` (the sha256 of the next two files). `pad.json`: only `d21.screening.screening_s` 204.0 -> 190.5. `scenarios/pads/index.json`: only `screening.screening_s` 204.0 -> 190.5. Every other file, including `physio/golden.json`, is byte-identical. **Not zero: see Blocked (screening_s).** Baseline: `make web` on the unchanged interim tree before the run gave only `utc` / `commit` changes (6 + 6), so nothing else drifted.
  - **Files `build_plan` produces vs the static tree** (from run 2's `--out` tree; `padpick.run` writes nothing, so every file below comes from `build_plan`):
    - 63 public files. **55 byte-identical** to `web/public/data`: `route_nom_104.geojson`, `timeline_nom_104.json`, `stations.json`, `trade_table.json`, `siting.png`, `siting_png.json`, `scenarios/index.json`, `scenarios/bands_{80,104,120}.geojson`, `scenarios/{opt,nom,con}_{80,104,120}/{isochrones,edges}.geojson` (18), `scenarios/nom_{80,104,120}/partner.geojson`, `scenarios/pads/{rank2,rank3,rank4,pad_default}/{bands_104,edges,partner}.geojson`, `.../{route_nom_104.geojson,timeline_nom_104.json,summary.json}` (24). **2 differ** only in `screening_s`: `pad.json`, `scenarios/pads/index.json`. **6 not shipped as-is**: `cards/{S1,S2,S4,S6,S7,S8}.timeline.json`, merged by `make web` into `cards/{S}.json` (those 6 came out unchanged).
    - Internal only (not in the static tree): `summary.json`, `{opt,nom,con}_{80,104,120}/{t_home,o2_home,pointer}.tif`, `haul/nom_{80,104,120}_cart_{155|179|195,343}/t_haul.tif`, `pads/{rank2,rank3,rank4,pad_default}/nom_104/{t_home,o2_home,pointer}.tif` and `.../haul/nom_104_cart_{179,343}/t_haul.tif`, siting rasters; manifest fragments `pipeline__engine__{scenarios,traverse,cards,siting,padpick}.json`.
    - Static tree files **not** from `build_plan` (3,005): `physio/golden.json` (`golden.py`, separate `make engine` step), `manifest.json` (`make web`), `cards/*.json` merge, and other workstreams: `tiles/` 2,761, `fp3d/` 118, `fields/` 39, `localisation/` 35, `nav/` 8, `validation/` 7, `conditions/` 4, `terrain/` 4, `vo/` 2, `.gitkeep`.
  - **B. Determinism.** Two full runs on the same inputs at the same time (run 1 into `data/interim/engine`, run 2 into a scratch `--out` with `HOMELINE_MANIFEST_DIR` in scratch), byte compare of all 119 common files (every `.tif`, `.geojson`, `.json`, `.png`): **116 byte-identical**. Not identical, all wall-clock timings: `summary.json` (`timing_s.*`, `d21.screening.screening_s`; internal, not published), `public/pad.json` and `public/scenarios/pads/index.json` (`screening_s`, published). Manifest fragments: same 1,842 keys, same values except `file.pad.json` and `file.scenarios/pads/index.json` (hashes of those two files). Run 1 vs the 17:57 interim tree: the same 3 files, same reason. `physio/golden.json` identical to the pre-run copy.
  - **C. `physio_core.py`** (imports: `dataclasses`, `numpy` only; no config, no I/O): Params, VO2, governor, O2 and heat step, grade table, margin and turn-back rules, dose leash, alarm rules; `physio.py` / `margin.py` re-export and add the config builders. Crew as a parameter: `physio.params(..., crew=)` / `scenario_params(..., crew=)` override `body_mass_kg`, `tools_kg`, `vo2max_ml_kg_min`, `effort_cap_frac` (CREW_KEYS); without `crew` the config values are used (batch output unchanged, above). `params` still reads `crew.yaml` for defaults and the non-crew constants (`g_mars`, `anchor`, `v_safe_ms`): that is the config adapter; physio_core reads nothing. **`web/public/data/physio/golden.json` byte-identical** after `make engine`. Monotonic KAT `test_plan.py::test_heavier_suit_never_increases_reach` passes.
  - KATs: `pytest pipeline/engine` 137 passed; `ruff check pipeline/engine` clean (`ruff format --check` lists 18 files, none touched by 5e41a3b, pre-existing; CI runs `ruff check` only).
### Doing

- D48: PR `ws2-backend-support` -> main for S (science) and C (code); waiting on the screening_s decision (Blocked).

- Waiting for C: merge sessions 8 and 9; contracts for `physio/golden.json` (+ make_web rule), `headline_60` in scenarios_index, `feasible` in pads index/summary, trade cell `in_data_pct`.

### Next

- C (after merging session 7): WS3 pad horizon + cards, WS7 `make fields`, WS8 fp3d, `make web` (downstream list in the 15:43Z entry).
- ~~60-min number around the official pad~~: D41 shipped (session 8).
- C: `make web` copies `physio/golden.json`, picks up `headline_60`; WS5 labels `pads.{id}.feasible.excluded_by_effort_cap_rule` and shows `headline.nom_104.disc_60.in_data_pct` with the 60-min share.

### Blocked

- **D48 task A (S, C): `screening_s` is a wall-clock time in two published files**, so `make engine && make web` cannot give a zero diff on any run, from main or from this branch (main's `padpick.py` writes it too). Differing files: `web/public/data/pad.json` (`d21.screening.screening_s`), `web/public/data/scenarios/pads/index.json` (`screening.screening_s`), and in `manifest.json` the keys `file.pad.json` and `file.scenarios/pads/index.json`. Source: `pipeline/engine/padpick.py:453`. Not in any contract, `web/src`, or `tools/`. Proposed (not applied, needs S/C): keep `screening_s` in the internal `summary.json` (`timing_s`) and drop it from the two public files. That republishes those 2 files once, without the field; every number stays. Until then, the parity check (WS11 `make parity`) must ignore `screening_s` and those two file hashes.
- ~~3-station G1 route~~ (session 7: D26 stations, the official route visits S7, S6, S1, S4). ~~F8 pad~~ (D21). Old text kept for the record: **3-station G1 route (S/WS1):** with the access-cell rule only S2 and S4 are routable; S1's 38 assessed cells within 50 m are all sealed off (no walk home in any scenario). S to pick S3/S5 positions, or move S1, or widen the radius (assumed 50 m; not changed by WS2).
- **F8 pad (S):** with only S4 reachable under con_104 the rule ties 5 blocks at 0.475; proposed pad 137.402443, -4.769028 (not adopted; pad_default unchanged). The pad check is null because the 30-min disc leaves the grid there. Accept, keep the default, or wait for S3/S5?
- Questions for S (science):
  1. ~~alpha encoding~~: **switched** to the weight-span encoding (decision 15:40, session 6).
  2. ~~O2_station_tasks~~: **confirmed** (decision 15:40).
  3. **Margin change on the only real route** (opt_104 -> S4, 131.9 min, scratch run, not published). O2 term: start 373.3 -> 343.3 min (-30.0, the 40.5 L reserve); arrive S4 260.5 -> 230.8 (-29.7); return 271.2 -> 230.8 (-40.3). Latest turn-back at S4: 523 min (daylight) -> 447 min (O2). Each 30-min station now costs 11.7 L more (0.84 vs 0.45 L/min) = 8.7 min. On the nom_104 field (no route), the O2 term on the 30- / 60-min contours drops by a median 24.5 / 19.3 min. **The binding margin does not change.** With the storm tau (85.9 min) the dose term (85.9 - T_home) binds everywhere within 60 min; with `--dose latest` (3,771.6 min) the O2 term binds on the S4 route (230.8 min).
  4. ~~O2 conversion~~: **ICES-2026-127 adopted** for the budget (482 L, decision 15:40). Open for S: the physiology constant 20.1 J/mL is still used in k, heat and haul power (review conversion = 21.01 J/mL); kept per the decision.
  5. Earlier open: flat-disc speed (Q5). Drag (D20) and casualty mass (15:40, haul.yaml rule) are decided. Old Q1 and Q2 are answered by the review.
- Questions for C (code/contracts):
  6. Who writes the web `stations.json`? WS2 writes `data/interim/engine/public/stations.json` with `t_home_min` and `in_partner_line` from WS1's stations.
  7. Proposed for contracts v1.1 (loose schemas accept them now): `partner.geojson` properties `{case, casualty_kg, contour_min, style, default_visible, caption, feasible, area_km2}`; route leg properties `{leg, from, to, t_min, o2_L, length_m, t_start_min, t_end_min, times_min[]}`; timeline rows `margin_binding`, `o2_tasks_left_L`, `o2_margin_min_planning_rate`, optional `in_partner_line`, plus `turn_back` events. `siting_png.json` has no schema.
  8. F11 partner_area_km2 uses the 60-min cart line (suited casualty) in both rows; reachable_pct uses the nominal variant. OK?
  9. WS5 scorecard shows `crew.o2_reserve_frac` as "O2 reserve in the route margin". It is no longer used; the reserve is `crew.o2_margin.reserve_min_at_effort_cap` (30 min at 1.35 L/min = 40.5 L). Please ask WS5 to switch the row.
  10. **Sizes / coordinate precision.** Losslessly I merged edge pieces (MultiLineString). Two more cuts need a C decision: (a) 5 decimals (0.59 m on Mars, below the 2 m simplification) saves 9 % raw / 16 % gz (79.5 -> 72.5 MB raw, 12.0 -> 10.1 gz), but SPEC §6 and contracts/README say 6 decimals, so not applied; (b) the same < 100 m2 hole filter on `bands_*` cuts them 13.1 -> 5.8 MB raw (1.84 -> 0.9 gz), but bands are the main F4 layer and edges would still trace the dropped islands, so not applied.
  11. **Card merge.** WS2 writes `engine/public/cards/{S}.timeline.json`; `tools/make_web.py RULES` has no rule for it yet and no merge into `cards/{S}.json`. Note `SCHEMA_MAP` pattern `cards/*.json` also matches `*.timeline.json` if the fragments ever land in the web tree. The card contract's `margin_binding` enum has no null: S1 (no access cell) has null times and a null binding; please allow null (as the timeline schema does) or say what a card without a route should carry.
  12. **stations.json extras (stations schema is open):** `access_radius_m`, `access_lon`, `access_lat`, `access_dist_m`, `access_reason` (default scenario), `access` {scenario: {lon, lat, dist_m, t_home_min, o2_home_L, reason, walk_in {dist_m, rise_m, mean_slope_deg, max_slope_deg, max_terrain_slope_deg, modelled: false}}}. `lon`/`lat` stay the science point; `t_home_min` is at the access cell. Timeline station rows: `access_dist_m`; route legs: `to_access_dist_m`. Optional in a v1.2 note?
- Question for S: 13. **Turn-back beyond the EVA budget.** The SPEC F4 margin has no EVA-duration term, so the latest turn-back (O2 term) was 409-439 min; since session 6 (482 L) it is S2 382.2 min (inside the 6.5 h = 390 min budget) and S4 411.9 min (after it). Cap turn_back at `crew.eva_h` - T_home, or keep it as the physical limit?
- **For WS5 (answer to Q9, not editing web/):** `web/src/config.ts` line 94 still cites `crew.yaml o2_reserve_frac` (0.2) for the scorecard. The engine does not use it. The route margin's reserve is `crew.yaml o2_margin.reserve_min_at_effort_cap` = 30 min at the effort rate 1.35 L/min = **40.5 L** (S review). Please show that row instead.

### Assumptions added

- ~~60-min reachable % null~~ → D41 (session 8): `variants.yaml outputs.headline_in_data_budgets_min: [60]`; "inside the terrain data" = inside the 3 m routing grid and not unknown, as a share of the whole flat disc's cells.
- golden.json (D40): `golden.py` tolerances are WS2's choice (physio rel 1e-6; route segments rel 1e-3 because the router interpolates a 0.01-deg table; timeline rows abs 0.011 because the contract rounds to 0.01); version 1.0.0 until C freezes the contract.
- `variants.yaml d21` (D21 settings; `screening_order` and `elevation` assumed): tiebreak 1 is computed in the screening for every candidate at or above the 5th-best count (so the top 5 follow the full D21 order); tiebreak 2 = pad-cell (3 m) elevation; a block's pad = its representative cell (nearest the block centre). Screening access cells: equal distances broken by row/col (`access.find` breaks them by T_home; the full runs use `access.find`). Only the top 5 by screening order get full runs (D21), so a lower-screened candidate with a higher margin-checked count is not considered.
- The DP margin check bounds O2 used before each leg at the 1.35 L/min effort cap (unchanged since session 3). With 6 stations this is what removes 12–19 subsets per pad between screening and full run; the timeline reports the actual O2 (e.g. 124.87 L left at return).
- D39 modelling: the DP plans without the timed dose term (it depends on the route); t* and the dose margins are evaluated on the planned route; a turn-back with the timed term is found by scanning departures in 0.05-min steps.
- `crew.yaml o2_budget.j_per_btu` 1055.056 J (unit conversion, International Table BTU).

- `variants.yaml route.o2_checkpoint_min` 30 and `budget: crew.eva_h` (assumed; SPEC F9 text). `route.o2_margin_rate` and `dwell_vo2` were removed and replaced by `crew.yaml o2_margin` (sourced: S review, ICES-2026-127, NTRS 20140009556).
- **Reserve in use:** the margin uses the fixed `o2_margin.reserve_min_at_effort_cap` (40.5 L) only. `crew.o2_reserve_frac` (r = 0.2) is no longer used anywhere in the engine (`MarginInputs.reserve_frac` = 0; `margin.legacy_inputs` is kept only for the before/after comparison). `crew.reserve_min` (30) stays the EVA-time reserve of SPEC §1.4; the engine does not use it.
- `variants.yaml ist2.weight_span` and `g_earth_ms2` 9.80665 (sourced: Norcross et al. 2010; CGPM). `speed_sweep_n` 42 is numerical resolution only.
- `variants.yaml numerics.grade_table_step_deg` 0.01 (assumed: true; lookup resolution, KAT error < 1e-4).
- `haul.yaml g_moon` 1.62 m/s^2 (assumed; standard lunar g, only for the Mars/Moon KAT).
- The DP bounds O2 used before a departure by the effort-capped rate (station work at 0.84 is below 1.35 L/min, so the bound holds). The DP stays exact; the timeline reports the actual margins.
- Pre-H0 station snapping is not used: a station with no walk home gets null.
- `variants.yaml route.access_radius_m` 50 (assumed: user chose the access-cell rule 2026-11-14 11:40; radius assumed). Walkable = WS1 state assessed and reachable in the scenario. Walk-in leg not modelled.
- `variants.yaml outputs.display_min_hole_m2` 100 (C decision 11:42, display only).
- Card contingency uses the cart case with the suited casualty (the partner-line case), from the access cell.
- Engine CLI: `--dose storm|latest` (default storm, the SPEC storm replay) and `--no-conditions`. CLI `--t-dark-min` and `--tau-dose-min` override WS4.

## WS3 Horizon

Branch: `ws3-horizon`

### Done

- 2026-11-14T09:55Z: M1 horizon ray engine (`pipeline/horizon/rays.py`, Numba, 1,440 rays, sampling 1 m / 20 m / 200 m from `horizon.yaml`, curvature d²/2R, coarser-band fallback, NaN = unknown) and CAHV/CAHVOR/CAHVORE projection + rover→site attitude chain (`pipeline/horizon/cahvor.py`). Ported from the pre-H0 reference code, checked against contracts v1.0.0 and the fresh discovery.md. KATs: curvature drop 58.9 m at 20 km; 100 m wall at 1 km from 1.7 m = 5.61°; flat plane = −dip within 0.01°; projection round trip < 0.5 px; attitude chain round trip.
- 2026-11-14T10:01Z: Navcam cache (`pipeline/horizon/navcam.py`): raw-image API (full NAV_LEFT_B frames, `extended=full::sample_type::eq`), cache `data/raw/navcam/` with `index.json`; stop order = S4 by its stations.yaml rule (drive end nearest sol 4200 → 107_2484, as discovery 3.2) then farthest-point over the 290 focus-area drive ends at 30 m spacing (116 stops). **Real-frame KATs pass** on 3 fresh API frames from 2 drive ends (107_2484, 125_2490): A-vector az/el vs `mast_az/mast_el` and rover yaw/pitch/roll vs MMGIS within 1°; C height inside the discovery 3.4 range. A cached-frames variant checks 3 more stops.
- 2026-11-14T10:01Z: sky detector (`pipeline/horizon/sky.py`) = the `horizon.yaml` rule + 2 px border + σ 2 px pre-smoothing (evidence below).
- 2026-11-14T10:04Z: far-field bands (`pipeline/horizon/bands.py`): MOLA-HRSC 84 km window (GTIFF_DIRECT_IO) and a 3-item CTX `geoid_adjusted_dem` mosaic (34 km disc, 70.8 % footprint), all reprojected to the analysis CRS in `data/interim/horizon/bands/`. One CTX item (P22_009505…P22_009571) is 55 m below MOLA-HRSC and was rejected by the alignment check; the next-best item replaced it. Band offsets (coarse − fine, median): CTX − dem_1m **+15.6 m** (p5/p95 −4.6/+43.1), MOLA − dem_1m +0.5 m, CTX − MOLA +2.9 m.
- 2026-11-14T10:11Z: WS1 `dem_1m.tif` (7,800² at 1 m, coreg dx = dy = 0) is on disk, so I started the real stop horizons: `horizons/v{site}_{drive}.json` at Navcam height for every stop with candidate frames; frame selection now keeps a frame only where the DEM-predicted skyline is testable (below the detector's reference band, inside the frame) in ≥ 50 % of columns. **Result: 49 frames at 36 stops** (`navcam_frames.json`, validates).
- 2026-11-14T10:11Z: first **automatic V2** (`pipeline/validation/v2_skyline.py`, `validation/v2.json` validates, manifest keys `v2.*`): 49 frames tried, 35 ok at 27 stops, 14 failed (no clear sky at the top of the frame; reported, not dropped). Median |error| near 0.095° (n 2,016 columns), mid 0.196° (n 951), **far 4.30° (n 26,861, P90 7.89°)**. 49 check composites in `data/interim/horizon/validation/overlays/`. The far figure is not quotable yet: see Blocked 1.
- `make horizons` wired (bands → navcam fetch with stop horizons → V2). 58 WS3 KATs pass; full suite 197 pass; ruff clean. Downloads: Navcam cache 51.1 MB (API JSON + JPG, from `index.json`); MOLA window ≈ 2.2 MB (discovery's measurement for this window; not re-measured); CTX windows 25 MB on disk (network bytes not measured, other agents share the machine counter).

- 2026-11-14T10:50Z: **Canonical bands (C decision 11:15).** `horizon.yaml bands.{ctx_20m,mola_hrsc_200m}.path` now point at WS1's `data/interim/terrain/` bands; `python -m pipeline.horizon.bands` only reports their offsets (`--build` keeps my reference build, unused). Offsets on the canonical bands: CTX − dem_1m **+19.75 m** (p5/p95 −0.41/+47.2; mine was +15.6), CTX − MOLA −0.37 m (levelled). Stop horizons and frame selection rerun offline: the same 49 frames at 36 stops, 35 ok at 27 stops. **V2 median |error| before → after: near 0.095° → 0.095° (n 2,016), mid 0.196° → 0.196° (n 951), far 4.304° → 4.308° (P90 7.890° → 7.894°, n 26,861).** Near and mid use only dem_1m, so they cannot move; the far change is negligible. Pre-switch outputs are kept in `data/interim/horizon/runs/before_bandswitch/`.
- 2026-11-14T11:00Z: **Pad, stations, ring, cards** (`pipeline/horizon/cards.py`, in `make horizons` after V2):
  - Pad horizon `horizons/pad.json`, from WS1 `terrain/grid.json` pad (= `pad_default`, kept). The order is WS2 `pad.json` (none yet), then WS1 grid.json, then site.yaml.
  - Station horizons `horizons/{S}.json` at eye height 1.7 m under the **access-cell rule**, read from WS2's `engine/public/stations.json` (`access_lon/lat`, written 12:01 CET): **S2 and S4 final at their access cells** (27.6 m and 2.1 m from the science point). **S1 has no access cell** (WS2: "38 assessed cells within 50 m, none with a walk home"), so its horizon is at the science coordinate, labelled `science_coordinate_no_access` (not provisional). The cards follow WS2 automatically on rerun.
  - `public/fp3d/horizon_ring.json` for WS8: pad horizon counting terrain beyond `planning_radius_m` (3.7 km) only, 1,440 azimuths, with `elev_deg`, `dist_m`, `z_m`, `east_m`/`north_m`, `source`. A superset of the dummy ring's keys. I propose this structure for the (free) ring contract to C/WS8.
  - Landmarks: the 8 IAU features within 80 km, read from D0's gazetteer CSV (a KAT reproduces the discovery 3.5 table to 0.05 km / 0.05°). The landmarks.yaml rule applies (above the skyline, or ≤ 5 km). **From every station only Gediz Vallis (≤ 5 km) qualifies; the other 7 centres are below the computed skyline** (e.g. Aeolis Mons centre +6.1° vs skyline 9.7–13.6°: lower Mount Sharp's own flanks hide it). So S1 and S4 show 1 landmark and S2 shows 0, each with a `landmarks_note`. I did not pad the list.
  - Panoramas `public/cards/{S}/panorama.png`: 1,440 px wide, true scale, north at the left edge, landmark ticks.
  - Navcam per station: the nearest V2 frame with status ok and manual_ok not false, with no choice by error. The frame is copied as `navcam.png`, and `overlay.png` is the transparent skyline from that frame's stop horizon. **S1: NLB_826633404 (sol 4834, 523 m), S2: NLB_789347468 (sol 4414, 925 m), S4: NLB_767161116 (sol 4164, 128 m).** All three are north-facing far-fail frames, so the cards show far errors of 4.24° / 3.18° / 6.50°, with near/mid null (no near/mid columns). The fragment says the far class is pending D7. The frames change automatically if the manual check rejects them.
  - **Card fragments** `public/cards/{S}.json`: navcam, skyline_error_deg (median |error| per class on the card's frame), panorama_png, landmarks, plus observer, provisional, skyline_error_scope and landmarks_note. They validate against the card contract's fields. Manifest (`pipeline__horizon__cards.json`): `navcam_sol.{S}`, `skyline_error_deg.{S}.{class}`, `landmark.{S}.{name}.{bearing_deg,dist_km}`, file `cards/{S}.json`. The V2 fragment no longer writes `skyline_error_deg.*`.
  - **C request (WS9 F22): `navcam_frames.json` now tags each card frame**: `station` S1/S2/S4, plus `stations[]`, `station_dist_m`, `station_observer` (`station_source: card_frame`). The tags are rewritten on every cards run.
- 2026-11-14T11:05Z: **D7 manual-check sheet** in `data/interim/horizon/validation/manual_check/`: `manual_check.csv` (one row per frame with predicted vs detected per class and an empty `verdict`/`note`), a captioned composite per frame (`{image_id}.jpg`), `contact_01-04.jpg` and `HOW_TO.txt`.
  - **39 frames: 10 sampled (20 %), 21 far-fail (|far median| > 2°), 14 V2-failed** (sets overlap). Verdicts: ok / rim_not_visible / detector_wrong / model_wrong / unsure.
  - Run `python -m pipeline.validation.v2_skyline --import-manual <csv>` to write `manual_checks.json`. The next V2 run then leaves the rejected frames out of the summary.
  - Visibility-range diagnostic: the cut range (2/5/10/20/30 km) whose predicted skyline best matches the detector, drawn in green. **On 19 of the 21 far-fail frames the best match is terrain ≤ 2 km, and 12 of those match within ±0.3°.** The chain is right in the near field, and terrain beyond about 2 km (incl. the rim at 41–57 km) is not seen. Clear-sol frames facing the same way match the rim (e.g. NLB_803472163, az 5°, far error −0.08°). This is evidence for option (a); D7 is not decided.
- KATs: 14 new (canonical bands, access-cell rule incl. no-access, pad source order, landmark table vs discovery 3.5, landmark visibility, pick rule, panorama geometry, ring geometry, frame choice, fragment contract, station tags, manual-check rows/verdicts, cut-range engine). The full suite has 523 pass; ruff is clean.

#### Session 3 (2026-11-14, C decisions 12:35 and 14:13)

- 13:05Z **dem_1m to the edge of its coverage (C 12:35).** `horizon.yaml sampling[0].handover: band_edge`: on each ray dem_1m (1 m step) runs to max(2 km, the distance where the ray leaves dem_1m's valid extent), capped at 30 km; CTX samples start 20 m after that. Valid extent = bounding box of the band's valid pixel centres (dem_1m is 100 % valid, so pad ± 3.9 km: the handover is 3.9–5.5 km from the pad). No-data samples inside still fall back to the next coarser band. KATs first (5): config key, a 100 m wall at 3.5 km seen from dem_1m, CTX after the edge on its 20 m lattice, dem_1m wins over a 50 m higher CTX inside its coverage, observer outside dem_1m.
- 13:05Z **CTX v2 (C 14:13).** `bands.ctx_20m.path` = `data/interim/terrain/ctx_20m_v2.tif` (note in horizon.yaml). Band check on the canonical bands: CTX − dem_1m **−0.12 m** (p5/p95 −12.4/+8.4; was +19.75 m), MOLA − CTX +8.0 m.
- 13:20Z **Re-run** (bands → `navcam fetch` → V2 → cards). Previous outputs in `data/interim/horizon/runs/before_dem_edge/` (horizons, navcam_frames, v2, sheet, overlays, cards, ring, manifest fragments).
  - Frames: **50 frames at 36 stops** (was 49). The new horizons let a second frame at stop 117_492 pass the predicted-skyline test (NLB_804266963, 0.6 MB downloaded; `navcam rebuild` offline cannot fetch it). It fails V2 (no clear sky), so it is reported, not dropped. No other frame changed status.
  - **V2 median |error| before → after: near 0.095° → 0.094° (n 2,016 → 2,018), mid 0.196° → 0.197° (n 951 → 952), far 4.308° → 4.308° (P90 7.894° → 7.892°, n 26,861 → 26,858).** 27 stops, 35 ok frames, as before. The far class is the 41–57 km rim on the hazy far-fail frames (Blocked 1), which neither change touches.
  - Only 139 joined columns (one frame, NLB_743544164 at v102_2164, facing SE) have their skyline at 2–6 km. There it gets worse: median |error| 0.061° → 0.318° (signed −0.03° → +0.29°). The skyline points are 4.8–5.5 km out, **beyond dem_1m's east edge**, so this is CTX v2 alone: v2 is 18–47 m lower than v1 on that Mount Sharp flank (MOLA-HRSC is lower still). One frame, so not a verdict on v2. For WS1: worth a look at the v2 shift outside the dem_1m overlap.
  - **Horizon changes (1,440 az, after − before):**
    | Observer | az changed | > 0.1° | > 0.5° | mean | largest change |
    | --- | --- | --- | --- | --- | --- |
    | pad | 90 | 78 | 1 | −0.013° | −0.53° at az 166.5 (CTX 2.06 km → dem_1m 1.82 km) |
    | S2 | 191 | 121 | 22 | −0.028° | −0.86° at az 159.25 (CTX 2.02 km → dem_1m 2.45 km): the F20 ridge |
    | S4 | 71 | 69 | 1 | −0.020° | −0.50° at az 134 (CTX 3.94 → 4.08 km, v1 → v2) |
    | S1 | 256 | 98 | 0 | −0.019° | −0.50° at az 71.75 (CTX 13.8 → 10.0 km) |
    | ring (beyond 3.7 km) | | | | −0.075° | max 0.80°; 242 az now dem_1m |
  - Cards: the same card frames, skyline errors and landmarks; only the panoramas changed. The manual-check sheet has **40 frames** (+ the failed 117_492 frame); no verdicts were filled in yet.
- 13:33Z **F20 re-check (C 12:35; WS8's export not rebuilt).** `make fp3d-check` still compares against the horizons baked into WS8's `fp3d/index.json skyline_check` (12:13, before this run): pad 0.439°, S1 0.543°, **S2 0.866° FAIL**, S4 0.200°. Same geometry check (WS8's `renderedSkyline`/`compareSkylines` on WS8's export and my new ring), with the reference rebuilt from the new horizons by WS8's `skyline_reference` in a scratch root (it reproduces WS8's numbers exactly on WS8's own index):
  | Station | Before (WS8 index) | After (new horizons) | Pass (≤ 0.5°) |
  | --- | --- | --- | --- |
  | pad | 0.439° | **0.375°** | yes |
  | S2 | 0.866° | **0.288°** | yes |
  | S4 | 0.200° | **0.504°** at az 134 | no (by 0.004°) |
  | S1 (excluded, C 12:35) | 0.543° | 0.543° | (no) |
  - S4: WS8's far mesh is still built from `ctx_20m.tif` (v1; its `--far-source` default). With the reference recomputed on v1 + the dem_1m edge, S4 is 0.200°, pad 0.212° and S2 0.288°. So the S4 residual is the CTX version, not geometry: **WS8 needs to rebuild `make fp3d` with `ctx_20m_v2.tif` as the far source** (this also refreshes `skyline_check`). The GPU probe was not run (no rebuild).
- 13:35Z **D7 import hardened.** `--import-manual` was tested end to end on a synthetic filled sheet: `manual_checks.json` is written, and frames judged other than ok leave the V2 summary on the next build (reported, with `manual_ok: false`). It now also accepts spreadsheet re-saves (UTF-8 BOM, `;` or tab delimiter, `OK`/padded verdicts). An unknown verdict, two different verdicts for one frame, or a missing `verdict` column stops it with exit 2 and writes nothing. **Re-running V2 no longer wipes a filled sheet:** verdicts and notes carry over by image_id, and a filled sheet is first copied to `validation/manual_check_backups/manual_check_{UTC}.csv`. I did not fill the real sheet.
- KATs: 9 new (5 handover, canonical CTX v2 path, 4 D7 import/carry-over). Full suite 726 pass, 1 fail (`test_fields_png::test_real_index_valid_and_pad_zero`: WS7's `fix_interval_high.png` is not in this worktree's data; it fails without my changes too). ruff clean; `make validate` OK.

#### Session 4 (2026-11-14, D7 decided 15:01; C 14:58 pad correction)

- 14:25Z **D7 numbers in `validation/v2.json` (WS5 request), commit 16ed62f.** New optional block `far_note` (open v2 schema; validates; `make validate` OK), rule in `horizon.yaml d7_far_note`. Every number has a manifest key `v2.far_note.*` (file `validation/v2.json`):
  - `status` not_validated, `decision`, `reason` (no numbers in the text).
  - `n_far_fail` **21** (V2-ok frames with |far median| > `far_fail_abs_deg` 2°), `n_far_fail_north` **21** (frame centre az within `north_half_width_deg` 45° of north, assumed; all 21 are at 335–30°), `n_far_fail_az_unknown` 0.
  - `rim_dist_km_min`/`max` **41.4 / 53.6 km** (per far-fail frame, median predicted-skyline distance over its far columns; min/max over the 21). SPEC's "41–57 km" is not reproduced: 57 is not what today's data give.
  - `n_match_near_terrain` **17** of 21 (sheet best cut range ≤ `match_range_km` 2), `n_match_near_terrain_within_tol` **8** (also |detected − cut-predicted| ≤ `match_tol_deg` 0.3°, assumed), `best_cut_range_km_counts` {2: 17, 5: 2, 20: 2}, `n_best_cut_unknown` 0. **Correction:** the decision log's "19 of 21 within ~2 km" was the session-2 count; since session 3 (dem_1m to its edge) it is 17 within 2 km and 19 within 5 km. WS5: use the keys, not the log text.
  - New keys `v2.n_frames_tried` **50** and `v2.n_frames_ok` **35** (plus `v2.n_stops` 27). `write_v2` now validates before writing.
  - Near/mid/far summary unchanged (0.094° / 0.197° / 4.308°).
- **Card fragments:** `skyline_error_scope` no longer says "far class pending the D7 manual check"; it now reads "automatic sky detector, no manual review, D7; far class not validated: the far rim is hidden by haze in north-facing frames". Card frames, errors and landmarks unchanged (S1 NLB_826633404, S2 NLB_789347468, S4 NLB_767161116).
- The manual-check sheet stays as is (not required; it is still written because it computes the best-cut evidence the far note uses).
- **Pad correction (C 14:58), commits 2bb16cc and d5407d2.** WS2's pad.json (14:45 CET) carried the F8 siting proposal (137.402443, −4.769028) as its top-level pad, and the 15:18 CET cards run built the pad horizon and `horizon_ring.json` there. Fixed: the pad observer is `site.yaml pad_default`. WS2's top-level pad is used only if it equals pad_default (6 decimals) and is not marked as a proposal; its `proposal` block is never read. KAT added. Re-run at 15:24 CET: **pad observer lon/lat = 137.382, −4.806 = pad_default** (from WS2's fixed pad.json). `horizon_ring.json` is **identical** to the session-3 pad_default ring on main (elev, dist, z: max |diff| 0), so WS8's `skyline_check` needs no refresh. Pad users checked: only WS8's export (restored by WS8); `conditions/clock.json` (11:09) predates the wrong window.
- Tests: 4 new KATs (far note, far-note manifest keys, card scope per D7, pad observer vs proposal). Full suite **762 pass**; ruff clean; `make validate` OK.

#### Session 5 (2026-11-14, D33 + D21; started 15:39Z)

- 15:55Z **D33 hidden landmarks (user 16:20 CET), commits e73c098, 22cc043.** Rule in `horizon.yaml hidden_landmarks` (cites D33) + `panorama_hidden` (presentation, assumed). KATs first (4 new/rewritten).
  - **Card fragment `landmarks`:** visible landmarks (centre above the computed skyline; 3-6 nearest first) carry `display: "label"`. **Every** gazetteer landmark below the skyline (within 80 km of the pad, at any distance, so Gediz Vallis at 3.7 km too) follows, nearest first, as `{name, kind, bearing_deg, dist_km, above_skyline: false, display: "bearing_tick"}` (no elevation). `landmarks_note` when < 3 are visible: "0 landmark(s) rise above the computed skyline (fewer than 3); 8 below skyline are listed as bearing-only ticks (D33)". Manifest keys `landmark.{S}.{name}.{bearing_deg,dist_km}` now cover the hidden ones too.
  - **Card contract:** the fragment validates (landmark items are loose). **For C (optional, v1.1.x):** add `display` (enum `label`, `bearing_tick`) to the landmark item properties.
  - **Panorama:** hidden landmarks are bearing-only: a dashed line through the ground from the skyline down at the bearing, and a bottom band with a tick and "Name 31.3 km (below skyline)" (rows stacked, no overlap). Visible landmarks are still labelled ticks at their elevation.
  - **Navcam overlay:** ticks only for landmarks above the skyline seen from the photo's own stop (none today).
  - **For WS5:** draw the compass from `landmarks[]` with `display == "bearing_tick"` (marked "below skyline"). The station table's "(within 5 km, below the skyline)" suffix is now wrong for the 5-80 km hidden ones; use `display`/`above_skyline` instead.
  - Run on the session-4 stations (cards only, 15:49Z): S1, S2, S4 each 0 visible + 8 hidden; overlays without ticks. Superseded by the Part 2 re-run on the D26 stations.
- 15:55Z **D21 pad observer.** `pad_observer` now takes WS2 `pad.json`'s top-level pad as the official pad when its `source` cites D21 (word match, not "D210") and it is not marked as a proposal; a pre-D21 file still counts only when its pad is `pad_default`; the `proposal` block is never read; anything else falls back to `site.yaml pad_default` with a `source_note`. KAT rewritten.
- 16:15Z **Part 2 re-run at the D21 official pad and the D26 stations** (cards only, from clean commit 364a92a = main 706b6ee + ws3; WS1 session 4 on main, WS2 session 7 pushed 9c143fd, not merged; data read from WS2's `engine/public/pad.json` and `stations.json`, both 16:57-16:58 CET). Previous outputs in `data/interim/horizon/runs/before_d21_d26/`. Log `cards_d21_d26.log`.
  - **Pad observer = D21 official pad 137.401783, −4.77748** (WS2 `rank1`, source cites D21; ground −3,742.4 m). `horizons/pad.json` and `public/fp3d/horizon_ring.json` rebuilt there. Ring vs the pad_default ring: mean +0.36°, max |diff| 2.40° (different observer). **WS8: the ring moved, so `skyline_check` / `make fp3d-check` need a refresh at the official pad.**
  - **Stations (6, all at WS2 access cells):** S1 (137.379249, −4.80832), S2 (137.376083, −4.778391), S4 (137.408931, −4.785832), S6 (137.383549, −4.789172), S7 (137.373323, −4.789762), S8 (137.386021, −4.770783). S3/S5 not in stations.json (D26). S1 now has an access cell (was `science_coordinate_no_access`).
  - **Card Navcam frames** (same rule: nearest V2-ok frame; frame set unchanged, so V2 is unchanged and was not re-run): S1 NLB_811540240 (stop v118_3156, 64 m; was NLB_826633404), S2 NLB_789347468 (1,270 m), S4 NLB_767161116 (138 m), S6 NLB_800007980 (529 m), S7 NLB_803472163 (867 m), S8 NLB_743544164 (766 m). Card skyline error (median |error| on the card frame, near/mid/far °): S1 —/—/0.136, S2 —/—/3.183, S4 —/—/6.498, S6 —/—/0.043, S7 —/—/0.094, S8 0.333/0.183/0.134. S2 and S4 are north-facing far-fail frames (far class not validated, D7).
  - **Landmarks (D33):** from every station all 8 gazetteer landmarks are below the computed skyline, so each card has 0 labelled + 8 bearing-only ticks, and no overlay ticks.
  - Manifest `pipeline__horizon__cards.json`: 120 keys, all at commit 364a92a (no `-dirty`). `navcam_frames.json` station tags rewritten for S1-S8.

### Doing

- —

### Next

- WS5: read `validation/v2.json far_note` and the `v2.far_note.*`, `v2.n_frames_*` keys (session 4).
- WS8: rebuild `make fp3d` with `ctx_20m_v2.tif` (far mesh + `skyline_check` from the new horizons), then re-run `make fp3d-check` (expected from the geometry check: pad 0.38°, S2 0.29°, S4 ≤ 0.2°). The pad ring itself did not change in session 4.
- C: `make web` to pick up the new cards (S1, S2, S4, S6, S7, S8) and ring. Re-run `python -m pipeline.horizon.cards` if WS2 rewrites stations.json/pad.json again, or if S picks S3/S5 by 19:00.
- WS8: refresh `skyline_check` for the ring at the official pad.
- WS5: compass ticks from `display: bearing_tick` (D33).
- Hand to WS9 (optional add-on, D19): engine API, `sky.detect_skyline`, `navcam_frames.json` with station tags.

### Blocked

1. ~~D7 / V2 far class~~: decided by the user 15:01 (automatic only; far class not validated, haze). Done in session 4 (`far_note`).
2. ~~Card fragment vs card contract~~: resolved by C's card merge in `make web` (C session 2).
3. ~~Band step at 2 km~~: resolved (C 12:35 dem_1m to its edge; C 14:13 ctx_20m_v2, −0.12 m vs dem_1m). One observation for WS1 above (v102_2164: v2 18–47 m below v1 beyond dem_1m's east edge).
6. **F20 at S4 (WS8).** 0.504° vs 0.5° only because WS8's far mesh still uses `ctx_20m.tif` v1 (see Done, session 3). WS8 rebuilds with v2; I do not touch the export.
4. **Navcam height (C).** Unchanged: 1.9 m above DEM ground at stops (C height 1.88–1.93 m above the rover origin; the origin's height above ground is unknown).
5. ~~Landmarks rule yields < 3~~: decided by D33 (user 16:20): hidden landmarks as bearing-only ticks "below skyline". Done in session 5.

### Assumptions added

All in `config/horizon.yaml`, each with `assumed: true`:
- `band_fallback: coarser`: a sample with no data in its band falls back to the next coarser band.
- `navcam_selection`: NAV_LEFT_B full frames only; 30 m stop spacing; up to 4 frames per stop (widest azimuth spread); `stops_wanted` 36 (30 + 20 %); `max_stops_tried` 120 (all 116 stops); drive-end sol + 1; cache budget 150 MB. Geometric pre-test: top-centre pixel ≥ 0° and bottom-centre ≤ −5° in the site frame. It was 10° first, but that kept only 15 of 116 stops and most of those frames had no sky. Then `min_predicted_skyline_col_frac` 0.5 (DEM-predicted skyline testable in ≥ 50 % of columns).
- `sky_detector_params` (structured copy of the prose rule, 3× / top 10 %): `zero_median_guard` one DN; `border_px` 2 and `presmooth_sigma_px` 2.0. Evidence from fresh frames: row 0 is 235–254 DN, row 1 is ~20 DN above row 2, column 0 is ~25 DN darker and the last row is bright (12 frames). On 6 frames with visible sky, the rule as written (σ 0) fires on sky noise in 94–98 % of columns at about row 30. σ 2 traces the skyline on 4 of 6; on the other 2 the true skyline lies inside the reference band. Known failure: σ 2 can prefer a sharp near ridge over a faint hazy far rim (seen on 2 frames); σ 1 follows the rim but adds noise speckles.
- `v2_frame_fail.max_in_ref_band_frac` 0.5: a frame whose boundary sits in the reference band in > 50 % of columns is failed and reported.
- Session 3 (decisions, not assumptions): `sampling[0].handover: band_edge` (C 12:35) and `bands.ctx_20m.path: ctx_20m_v2.tif` (C 14:13). Implementation choice (not a constant): "edge of valid coverage" = bounding box of dem_1m's valid pixel centres along each ray.
- `bands`: CTX listing = D0's 500 STAC items at the pad; greedy footprint gain, max 3 items, ≥ 1 % gain; reject an item whose median offset to MOLA-HRSC is > 20 m; radii 34 km (CTX) and 84 km (MOLA-HRSC); 20 m and 200 m grids.
- `overlay`, `panorama`: colours and sizes (presentation only).
- Landmarks: the 8 IAU names verified by D0 (discovery 3.5). The informal names are dropped (no verified coordinate). Not used yet.
- Session 2 (`config/horizon.yaml`, `assumed: true`):
  - `landmark_rule` (structured copy of landmarks.yaml: 3–6, ≤ 5 km, nearest first; + `above_skyline_tol_deg` 0.05 for ray sampling; label point = gazetteer centre). `landmarks_source` cites discovery 3.5.
  - `horizon_ring` (pad, beyond `planning_radius_m`).
  - `card_frame` (nearest ok frame, manual_ok not false).
  - `manual_check_sheet` (far-fail > 2°, failed frames included, verdict list, cut ranges 2/5/10/20/30 km).
  - `panorama` `min_el_span_deg` 10, `label_band_px`, `font_px`.
- The card skyline error is the card frame's own median |error| per class (not the all-stops V2 median).
- Navcam frame published as PNG (`cards/{S}/navcam.png`, 0.6–0.8 MB each), because the make web rule copies only `cards/*/*.png`.

## WS4 Conditions

Branch: `ws4-conditions`

### Done

- 2026-11-14T10:00Z: Mars24 clock + sun API (`pipeline/conditions/marstime.py`, `sun.py`). KATs `tests/test_clock.py`: both GISS worked examples (A-1..D-6, incl. sun Z/A), Ls 2026-08-25 = 341.56 (brief 341.6 +/- 0.2), MY 39 / Ls 21.7 at H0, Navcam label LMST <= 10 s on 3 frames (sols 5041, 5069, 5073; error <= 1.5 s), MSL sol numbers, all D0 discovery frames within 10 s.
- 2026-11-14T10:10Z: RAD L2 cached via CDAS REST (`fetch.py`, cache index `data/raw/conditions/index.json`); CDAS parser, storm numbers, tripwire, leash (`rad.py`, `tripwire.py`). KATs `tests/test_rad.py` (synthetic analytic + real):
  - **Real storm (TOTAL_DOSE_E):** baseline 152.3 uGy/day (578 samples, 12-19 May); **peak 8377.9 uGy/day = 8.38 mGy/day** at 2024-05-20T06:19:52Z (sample midpoint); **excess 1.733 mGy** (onset 05:15:52Z, end = window end, rate still 160 > 152 on 22 May); dose equivalent 1.733 mSv at Q = 1; **tripwire 2024-05-20T05:57:07Z** (before the peak); **tau_dose at peak 85.9 min** (0.349 mGy/h, D_allow 0.5 mGy).
  - Latest RAD: 190.9 uGy/day at 2026-11-11T16:45:49Z, lag 2.7 days.
- 2026-11-14T10:15Z: `clock.json` (H0 record, weekend sols 5073-5075 with sunrise/sunset, Horizons light time 11.014 -> 10.873 min, simulated EVA block with sun series and t_dark), `donki.json` (CME 58, ENLIL 57, notifications 60, SEP 6, IPS 6; "context only, not a trigger"), `rems.json`, `make conditions` (+ `make conditions-fetch`). All outputs validate against contracts v1.0.0; every displayed number goes to the manifest (`data/interim/manifest/pipeline__conditions__*.json`).

- 2026-11-14T10:25Z: REMS climatology (`rems.py`): PDS `mslrem_1001` MODRDR, MY 36-38, Ls 10-35 (sols 3045-3098, 3714-3767, 4382-4435), 200 rows/sol by byte range; 162 sols fetched, 159 used. Medians (p10-p90) of daily extremes: air min -74.5 degC (-77.3 to -72.5), air max -19.5 degC (-27.4 to -13.9); pressure 792-862 Pa (daily min/max medians); UV A+B+C max 9.49 W/m2. Feed latest sol 4995 (2026-08-25) shown with label "stale since 25 Aug 2026".
- Downloads: WS4 cache 17.0 MB in 171 files (RAD 0.44 MB, REMS feed 1.7 MB, REMS PDS ~14.4 MB, DONKI 0.5 MB, Horizons 0.01 MB).
- 2026-11-14T15:35Z (session 2, user decisions 16:20): **D39** storm-timing key + `storm_replay.py` helper (KATs `pipeline/conditions/test_storm_replay.py`); **D34** E column label/status; **D35** midpoints (unchanged: already used) + derived tripwire half-width; **D36** lower-bound excess + end-of-window rate; **D37** REMS air temperature and pressure only (ground T and UV dropped, 777750c); **D31** EVA start decided. Manifest fragments are now reset on each write (no stale keys). `make conditions` re-run from clean commit e900d5a (no `-dirty` key). Storm numbers before -> after: onset 05:15:52Z, peak 8.38 mGy/day at 06:19:52Z, excess 1.733 mGy all **unchanged**; tripwire 05:57:07Z -> **05:57:07Z ± 9 min** (half-width 8.55 min = half the 17.1-min median sample); excess 1.733 -> **≥ 1.73 mGy (lower bound)**; new end-of-window rate **154.7 uGy/day at 2024-05-22T23:50:54Z = 1.016 × baseline 152.3 (+2.4 uGy/day)**. Latest RAD 190.9 uGy/day at 2026-11-11T16:45:49Z (lag 2.95 d at build).

- 2026-11-14T17:40Z (session 3, **D21**): the sun is computed at the official pad. `config/conditions.yaml clock.site` = `data/interim/engine/public/pad.json pad` (WS2 rank1, 137.401783, -4.77748); `clock.site_fallback` = `config/site.yaml pad_default`, used **only if pad.json is missing** and then flagged in `clock.json site.pad_fallback` / `site.pad_note` (+ a printed warning); a pad.json without `pad` raises. LMST, EVA start (09:00 LMST = 10:51:18Z) and sol numbers stay on the MSL label longitude 137.4085 E; the sun (sunrise/sunset, `t_dark_min`, sun series, h0 sun) uses the pad lat/lon (`site.sun_lon_east_deg`). Per-observer daylight now uses each observer's own lat/lon from the WS3 horizon `meta` (was the pad's). KATs first (5 new in `tests/test_clock.py`). Code 37f74f9; `make conditions` re-run from that clean commit (283 conditions manifest keys, all at 37f74f9). Before (pad_default lat -4.806, sun lon 137.4085) -> after (rank1):
  - `eva.t_dark_min` **578.63 -> 578.67 min**; flat sunset 20:29:56Z -> **20:29:59Z**; sol 5074 sunset 18:23:09 -> 18:23:11 LMST (sunrise unchanged 06:29:35).
  - Sun series (79 rows, 5 min): max |d az| 0.072 deg, max |d el| 0.030 deg; start az/el 74.789/36.696 -> 74.811/36.697, peak el 75.975 -> 76.003 deg (t = 210 min), end 288.007/44.610 -> 287.983/44.625.
  - `t_dark_min_by_observer` (WS3 horizons of 17:14, D21 pad + D26 stations): pad 560.48 -> **569.80**, S1 495.32 -> **491.91**, S2 568.91 -> **503.88** (WS3's new S2 horizon: 503.72 even at the old site), S4 570.10 -> **570.13**, S6 **569.95**, S7 **567.63**, S8 **569.08** (new); 90 V2 stop observers kept (WS7 local horizons), none null.
  - WS2: `margin_inputs()` -> `--t-dark-min 578.67 --tau-dose-min 85.9`. The daylight term (t_dark - t - T_home) stays 188.67 min above the EVA-duration term (390 - t - T_home), so it never binds; only the recorded value (`engine/summary.json` 578.63) is stale by +0.04 min until WS2's next run.
### For WS5 / WS6 (labels and keys, session 2)

- **D34:** show `TOTAL_DOSE_E` as **"dose in plastic (E)"**: `rad.json source.component_label`; status text `source.component_status` = "accepted because it reproduces the published storm peak and excess; dataset notes not yet read (G to check)" (unverified; show it). Manifest keys `rad.source.component_label`, `rad.source.component_status`.
- **D35:** time tag = observation start, unverified (`source.time_tag_status`, key `rad.source.time_tag_status`); series/peak/onset times are sample midpoints (`source.series_time`). Tripwire time carries **± 9 min**: `storm_2024.tripwire_halfwidth_label` ("± 9 min"), `storm_2024.tripwire_halfwidth_min` (8.55, min; derived = half the median sample duration, `config rad.tripwire_time_halfwidth`), rule text `storm_2024.tripwire_halfwidth_rule`. Note: the user wrote "± 8 min"; the derivation gives 8.55 min, which rounds to 9.
- **D36:** excess is a **lower bound**: `storm_2024.excess_is_lower_bound` (true), `storm_2024.excess_label` ("≥ 1.73 mGy (lower bound: the fixed storm window ends while the rate is still above baseline)"); end-of-window rate vs baseline: `storm_2024.end_of_window_utc`, `end_of_window_rate_uGy_day` (154.7), `end_of_window_rate_minus_baseline_uGy_day` (2.4), `end_of_window_rate_over_baseline_ratio` (1.016, units "1"). All under manifest prefix `rad.storm_2024.`.
- **D37 (C follow-up: "Air temperature and pressure only"):** `rems.json variables` is now **[0 air temperature, 1 pressure]** only. Ground temperature (old index 1) and UV A+B+C (old index 3) are gone; pressure moved from index 2 to **1**; manifest keys `rems.variables.0.*` / `rems.variables.1.*` only (no `.2`/`.3`). `latest_feed.values` has no `*_gts_*` fields and no `local_uv_irradiance_index`; `feed_crosscheck` is air temperature only. Config `rems.variables` [air_temperature, pressure], `rems.dropped` {ground_temperature, uv}. Schema `rems.schema.json` (loose) still validates. Re-run from clean commit 777750c.
- **D39:** `config/conditions.yaml storm_replay.*` (see "For WS2"); WS7 replaces "onset at switch-on" with the t* placement (`pipeline/conditions/storm_replay.py` documents the mapping; TS port is WS7's).

### Doing

- —

### Next

- Sun API hand-off to WS7/WS8 (documented below); per-station daylight once WS3 horizons land in `data/interim/horizon/horizons/` (`make conditions` picks them up; `eva.t_dark_min_by_observer`).
- G: read the RAD dataset notes (D34 column, D35 time tag) and confirm or correct.
- Re-run `make conditions` whenever WS2 moves the pad or WS3 re-runs horizons (done 17:40Z for D21 + D26).

### For WS2 (margins; SPEC F4)

- **D39 shared storm-timing key (WS2 + WS7): `config/conditions.yaml` → `storm_replay.tripwire_at` = `"route_max_t_home"`** (pushed 0338363; siblings `storm_replay.anchor_event` = `"tripwire"`, `storm_replay.eva_clock_units` = `"min"`, `storm_replay.tie_break` = `"first"`, assumed). Meaning: the 20 May 2024 storm series is shifted onto the EVA clock so that its tripwire (`rad.json storm_2024.tripwire_utc`) fires at t* = the EVA minute (since EVA start, 09:00 LMST, D31) where the route's T_home is largest (first sample on a tie). `storm_utc(eva_min) = tripwire_utc + (eva_min - t*) min`; storm onset sits at EVA minute `t* - (tripwire_utc - onset_utc)`. Helper: `pipeline/conditions/storm_replay.py` (8a6d960): `tripwire_target_min(eva_min, t_home_min)` -> t*, `storm_offset_utc(tripwire_utc, t*)` (storm UTC at EVA minute 0), `storm_utc_at`, `eva_min_of`, and `replay(rad_json, eva_min, t_home_min)` -> `{tripwire_eva_min, onset_eva_min, peak_eva_min, storm_utc_at_eva_start}`. Real numbers: onset 41.25 min before the tripwire, peak 22.75 min after it.
- One command: `uv run --no-sync python -m pipeline.conditions.margins --flags` prints `--t-dark-min 578.67 --tau-dose-min 85.9` (now; D21 pad). Options: `--observer S1` (daylight against that station's F12 horizon, once WS3 files exist), `--dose latest` (quiet-sun tau at the latest RAD rate, ~3772 min) instead of the storm-peak default. JSON without `--flags`; Python: `pipeline.conditions.margins.margin_inputs(observer, dose)`.
- Files: `data/interim/conditions/clock.json` `eva.t_dark_min` (minutes from the simulated EVA start, 09:00 LMST on sol 5074 = 2026-11-14T10:51:18Z, to sunset on a flat horizon at the D21 official pad, pad.json) and `eva.t_dark_min_by_observer[id]`; `data/interim/conditions/rad.json` `leash.tau_min_at_peak` / `leash.tau_min_at_latest`, plus `leash.table` (one row per 0.05 mGy slider step).
- Sun API: `from pipeline.conditions import sun`; `sun.sun_position(utc, lat, lon_e)`, `sun.sun_at_lmst(ref_utc, lmst_h, lat, lon_e)`, `sun.t_dark_min(eva_start, lat, lon_e, horizon_deg=0.0 | profile=<F12 horizon dict>)`, `sun.eva_start_utc()`.

### Blocked

- — (questions 1-4 answered by the user 16:20: D34 E column, D35 start tag + midpoints + ±, D36 fixed window + lower bound, D37 ground T dropped). Still unverified: G to read the RAD dataset notes for D34/D35.

### Assumptions added

- **`config/conditions.yaml clock.gale_lon_east_deg` 137.39 -> 137.4085** (docs/discovery.md §4.5: MSL label LMST matches Mars24 at 137.4085 E, median |error| 0.23 s; 137.39 gave a systematic +4.4 s). G to review. `site.yaml analysis_proj lon_0=137.39` is untouched (projection origin, not the clock).
- `rad.dose_variable` DOSIMETRY_TOTAL_f, `rad.dose_component` TOTAL_DOSE_E (decided D34, unverified), `rad.time_tag` start (decided D35, unverified; config `rad.unverified`), `rad.tripwire_time_halfwidth_display` "whole minutes, rounded half up" (assumed), `rad.sample_duration`, `rad.tripwire.fires_at` ("end of the last qualifying sample"), `rad.event_bounds`; `leash.d_allow_range_mgy` [0.25, 1.0] (D9), `leash.d_allow_step_mgy` 0.05 (assumed).
- `clock.eva_start_lmst_h` 9.0 (**decided D31**, no longer assumed) and `clock.eva_sol_ref_utc` = H0 (assumed); `storm_replay.tie_break` "first" (assumed), `clock.sun_horizon_elevation_deg` 0, `clock.sun_series_step_min` 5, `clock.mars_year_epoch_utc` 1955-04-11, `clock.msl_landing_utc` 2012-08-06T05:17:57Z; sun lat/lon = D21 official pad (`pad.json`), fallback `site.yaml pad_default` only if pad.json is missing.
- REMS: `pds_mars_years` [36, 37, 38], `pds_rows_per_sol` 200, `pds_min_lmst_coverage_h` 18; DONKI `window_utc` 12-23 May 2024 (+IPS endpoint); Horizons `step` 1 h.
- KAT notes: GISS example 2 prints LTST 0.00025 h and declination -13.42065, but its own formulas on its own inputs give 0.00020 h and -13.42040; tested with 1e-4 h / 5e-4 deg tolerance (example 1 matches to 2e-5). Ls KAT evaluated at 12:00 UTC on 2026-08-25 (the brief gives a date only).

## WS5 Web

Branch: `ws5-web`

### Done

- 2026-11-14T10:03Z: M1 web shell on contracts v1.0.0, developed on `VITE_DATA=dummy` (F5, F6, F15, F17). vitest wired (`npm test`): 179 tests in 16 files, all green; `tsc --noEmit` clean; `vite build` 1.8 MB without data (brief: < 5 MB).
  - Data layer: one loader validates every JSON file against its contract schema (browser checker mirrors `tools/validate_contracts.py` SCHEMA_MAP row by row; test fails if they drift or contracts use an unsupported keyword), refuses paths no contract covers, refuses `dummy: true` in real mode. Every dummy JSON file validates in the browser checker.
  - Provenance: every on-screen number goes through `<Num>` → manifest entry by named key, else by same file + same value; unbacked numbers are outlined and counted in a dev-mode badge. All views on dummy data: 0 unbacked numbers. Scorecard lists the manifest and flags entries before `h0_utc`.
  - Routes `/`, `/station/:id`, `/trade`, `/conditions`, `/scorecard`, `/cuff`, `/about`; mount slots `/hud` (web/src/hud/index.ts), `/hud3d` (web/src/fp3d/index.ts), `/nav` (web/src/nav/index.ts): export `mount(el, ctx)`; placeholder until the module exists.
  - Console: map (MapLibre, Mars lon/lat, offline style), Mars scale bar (R from site.yaml; KATs), layer toggles, legend, 30/60-min bands (conservative inner / optimistic outer, selected variant bold), edge-cause lines + labels, hatched unknowns (alpha of the shared slope field), stations + pad (pad.json, else site.yaml default), route and partner line behind toggles (partner off by default). Headline reachable % with range.
  - F5 budget slider: stops = `minutes` present in isochrones.geojson (1-min, D2), MapLibre filter on `minutes`. F6 scenario picker: variant × suit mass from scenarios/index.json; missing combos disabled.
  - Station card, trade table, conditions (RAD now + lag, storm chart with onset/tripwire, leash), cuff card (route card + A6 per station, print CSS), scorecard (V1, V2, coverage, coreg, RAD checks vs config ranges, assumptions from config, real/modelled/simulated, manifest), about page.
  - Real mode (empty `web/public/data/`): every view shows "not available yet", no errors.
  - `.github/workflows/pages.yml` written (see Blocked): deploys only after `ci` succeeds on a push to main, real data only, refuses dummy, checks no dummy flag in dist and < 5 MB without data.

- 2026-11-14T11:38Z (session 2): **G1 console on real data** (C's make web 3fe841a, contracts v1.1.1), smoke-tested in the browser on every view (`vite build` + preview): 0 unbacked numbers on `/`, `/conditions`, `/scorecard`, `/cuff`, `/trade`; no data problems; no console errors. vitest **310 pass** in 32 files (+8 real-tree KATs in `web/src/data/real.test.ts`, skipped when `web/public/data` is absent); `tsc` clean; build 2.0 MB without data. Commits 30a3fe5 + session-2 follow-up.
  - Basemap: real HiRISE WebP tiles from `tiles/basemap/tilejson.json` (one source z13–16 on `bounds`, one per partial zoom z17/z18 on `zoom_bounds`, no 404s; KATs). Credit from the tilejson.
  - Unknown hatch from `terrain/cellstate.png` (A = 0) on `cellstate.json bounds`; layer note shows `terrain.cellstate.pct.unknown` = 0 % (nothing to hatch: all HiRISE). Fallback: slope-field alpha.
  - Headline nom_104 **12.4 %**, range "conservative end pending V1" to 17.5 % (optimistic): the null low end is said, not shown as a number.
  - Isochrone slider: stops from the data (2–60 min, **2-min steps**, `isochrone_step_min.nom_104`), labelled as the size fallback.
  - Route section: pad → S4 → S2 → pad with depart/arrive/back times from the timeline; total **209.74 min** (`route.nom_104.total_min`); "show on map" toggle (route stays out of the default view).
  - Access-cell rule on the map: science point marker, open-circle access cell, dotted walk-in line; station table "Walk-in" column (S2 27.6 m, S4 2.1 m, S1 "no access cell" with WS2's reason); S1 marker dashed.
  - Station card: access block (access lon/lat, walk-in dist, rise, mean/max slope, steepest terrain, "not modelled", radius 50 m assumed); S1 "No access cell within 50 m: <reason>"; `margin_binding` null → "none: no route to this station"; margin_min; far skyline error tagged **pending D7**, near/mid null explained; skyline_error_scope caption; landmarks with WS3 keys and `landmarks_note` (S2: none, not padded); a card that fails its contract is reported on the page without hiding the rest.
  - D9 slider: range/step from `config/conditions.yaml leash.d_allow_range_mgy`/`d_allow_step_mgy`; τ at peak and latest from `rad.json leash.table` rows (manifest `rad.leash.table.{i}.*`); browser formula only for a step the table lacks (none now).
  - Scorecard: O₂ reserve row = `crew.o2_margin.reserve_min_at_effort_cap` 30 min (= 40.5 L at 1.35 L/min, computed and labelled) replacing `o2_reserve_frac`; station-task O₂ rate and access radius rows; **F22 finding** (station frames S1 788 m, S2 280 m, S4 966 m vs gate 10 m from nav.yaml `skyline_fix_gate.tolerance_from`: none pass → station fixes, fixes.json listed); **VO drift table** (rover analogue label, 5 drives); coverage, REMS and clock now proper tables (were generic leaf tables, now manifest-backed); KAT section reads `validation/kats.json` when WS6 publishes it.

- 2026-11-14T14:08Z (session 3, commit b318ef4): D19, D20, D7, V1/KATs, F8 proposal, route legs, smoke-tested on a scratch real tree (`make_web.run` from today's interim into the scratchpad, with WS2's proposal pad.json removed per C 14:58; `web/public/data` untouched). vitest **417 pass, 11 skipped** on main's committed tree (10 session-3 real-tree KATs skip until C publishes); **427 pass, 1 skipped** on the scratch tree; `tsc` clean; build 2.5 MB without data.
  - **D20 partner line**: layer label from `partner.geojson` `label` ("Partner line (cart haul, 60 min)"; fallback `config/haul.yaml partner_label`); drag-case features are never drawn (filter even on older trees). Drag note (card `drag_note` / `drag_finding.note` / `haul.yaml drag_note`) on the partner legend **and** the station card Contingency, with `haul.drag.flat.force_N` 398.454 N, `.traction_limit_N` 350.595 N, `.max_mass_kg` 157.5 kg via `<Num>` (per-suit keys `haul.drag.flat.nom_{suit}.*` for non-default files). No drag UI left.
  - **D19**: top nav "Navigation (optional)"; `/nav` slot gets the banner "Optional add-on (not part of the core plan)" (core: F19 drift circle + fixes at the pad and surveyed stations); scorecard F22 and X8 moved to a separate "Navigation and visual odometry — Optional add-on" section. KAT: console, map, pad, partner, route modules read no nav/VO/localisation file.
  - **D7 (user 15:01)**: "pending D7" removed. Station cards and scorecard quote near/mid V2 as measured; far class shown with its number via `<Num>` and labelled "not validated" with the D7 reason (haze hides the far rim in north-facing frames). The card scope string's "far class pending the D7 manual check" clause is dropped on display.
  - **Headline**: 12.4 % [4.6 conservative, 17.5 optimistic] at 30 min, both ends `<Num>`; "pending V1" removed.
  - **Scorecard V1**: n 290, bias +1.31°, RMSE 5.45°, r 0.50 (`<Num dp>`: display decimals, stored value kept in link/tooltip), both 2×2 confusion matrices (`v1.confusion.{t}.*`), `v1.svg`, sensitivities table (5 m, roll/pitch, all-in-DEM), conservative no-go 14.55° (`v1.conservative_nogo.nogo_deg`, 20° cited from site.yaml) with 58.75 % of the 30-min disc blocked (nominal 41.23 %, `terrain.conservative.*`). V2 is now a near/mid/far table on `v2.{class}.*`. **KATs**: summary keys + per-area table (counts labelled "counted in the browser") + every test in a collapsible list.
  - **Trade**: science value 0.0 in all 6 cells explained: a table of each station's conservative walk home per suit from `stations.json` (S4 71.21/76.52/80.14 min; S1, S2 "no access cell" with WS2's reason).
  - **F8 (C 14:58)**: the pad marker is the pad **in use**: `pad.json` when published (= pad_default), else `config/site.yaml pad_default`. The siting result is a proposal only: new layer "Pad siting proposal (F8)" (off by default) with `siting.png` on `siting_png.json` corners, a proposal marker only if `pad.json` gets an optional `proposal` block, and a panel text "pad_default is kept; S decides" + WS2's reasons (disc check null because the disc leaves the 3 m grid; top candidates tie). WS2's 137.4024, −4.7690 is not used anywhere. Scorecard pad line describes the pad in use.
  - **Route legs** (WS6 audit): console route section has a leg table (walk, distance, O₂, walk-in) on `route.{sid}.leg.{i}.*`; station value cites `stations.{S}.value`.
  - **Smoke test** (vite dev on the scratch tree, every route incl. /nav, /hud, /hud3d): **0 unbacked numbers on every view** (`/` 24 backed, S1 8, S2 32, S4 37, `/trade` 21, `/conditions` 50, `/scorecard` 123, `/cuff` 64, `/nav` 17), no data problems, no console errors; one console warning from WS7's HUD ("optional pad.json unavailable", expected while pad.json is unpublished).

- 2026-11-14T14:37Z (session 4, commit 423b45f): **pad.json v1.1.2** (WS2 session 5, C 15:31). vitest **434 pass, 3 skipped** on main's tree; **436 pass, 1 skipped** on a scratch real tree (`make_web.run` from today's interim into the scratchpad, incl. `pad.json`; make web OK, 1,121 keys, validate/H0 OK; `web/public/data` untouched); `tsc` clean; build 2.5 MB without data.
  - **Proposal shape**: `padProposal()` reads `proposal.pad.{lon,lat,elev_m,score,checks}` and `proposal.site_rule_version`; the session-3 assumed shape is not read (KAT). Panel shows the **tie** (5 of 742 candidate blocks at 0.475, `pad.proposal.tie.*`, tiebreak text), `checks_note` (disc leaves the 3 m grid: "not assessed", rule "not evaluated"), ranked alternatives table (`pad.proposal.alternatives.{rank}.{lon,lat,score}`), stations scored (S4) and `no_access` reasons. KATs use WS2's real pad.json verbatim (validates in the browser checker).
  - **Pad in use**: new "Rover pad" section on the console (always shown) and the scorecard pad line: F8 score 0 (`pad.score`; no station within a conservative 30-min walk home), **steepest slope in the 21 m pad block** 28.06° (`pad.checks.max_slope_deg`; rule ≤ 5° from `site.yaml siting.max_slope_deg`; caption: not the slope at the pad cell), disc 100 % → "**pad_default fails the F8 rule**"; S decides. The 21 m is derived in the browser (`DerivedNum`) from `siting.block_m` on `grids_m.route` as WS2 siting.py does. Old fallback wording (WS2 session-4 quote when the block was missing) removed.
  - **Smoke test** (vite dev on the scratch tree, every route): **0 unbacked numbers on every view** (`/` 27 backed, 44 with the siting layer on; S1 8, S2 32, S4 37, `/trade` 21, `/conditions` 50, `/scorecard` 126, `/cuff` 64, `/nav` 17), no data problems, no console errors or warnings (WS7's "optional pad.json unavailable" warning is gone).

- 2026-11-14T15:29Z (session 5): **D21 "Rover parking options" picker** (user 16:14, C layout 16:17), built against test fixtures (WS2's files and C's `scenarios/pads/` contract rows do not exist yet). vitest **459 pass, 2 skipped** on main's tree (+23 picker tests in `web/src/data/pads.test.ts`; 1 new real-tree KAT skips until `scenarios/pads/index.json` is published and covered); `tsc` clean; build 2.5 MB without data.
  - **Optional by construction**: `loadPadsIndex()` returns absent / no-contract / error / ok; only `ok` shows the picker. Before C adds the SCHEMA_MAP rows the loader refuses the path (no-contract) and the console is exactly as before. `createLoader(…, { schemaFor })` lets tests inject the future rows; the app always uses SCHEMA_MAP.
  - **Picker** (console, under the headline): table of every index row by rank (official first, the default): label (Official pad / #rank / pad_default), rank, tiebreak values, **feasible EVAs** (= score), elevation; radio + row click; parking-option markers on the map (click selects; selected outlined). Help text: switching changes bands, route, partner line, headline and feasible-EVA count (nominal variant, suit of the default scenario only); **the HUD, the 3D view and the station cards stay on the official pad**.
  - **A non-official option** loads `scenarios/pads/{id}/bands_{suit}.geojson`, `edges.geojson`, `partner.geojson`, `route_{sid}.geojson`, `timeline_{sid}.json`, `summary.json` (suit and sid from `scenarios/index.json` default, not hard-coded). Headline from summary.json at the selected 30/60-min budget + range + feasible EVAs; route section and leg table from the pad files; D20 drag note with `pads.{id}.haul.drag.flat.*`. No isochrones: the budget slider is replaced by a note; the variant/suit picker is locked to the default scenario; the stations table says walk-home times, access cells and cards are the official pad's.
  - **Manifest keys** (`<Num>` everywhere, file + value fallback citing the web paths): index `pads.{id}.{rank,score,elev_m}`, `pads.{id}.tiebreak.{name}`; summary `pads.{id}.score`, `pads.{id}.headline.{budget}.reachable_pct`, `.range_pct.low|high`; route `pads.{id}.route.leg.{i}.{t_min,length_m,o2_L,to_access_dist_m}`, `pads.{id}.route.total_min`; timeline `pads.{id}.timeline.{i}.t_min`; partner `pads.{id}.haul.drag.flat.{force_N,traction_limit_N,max_mass_kg}`.
  - **F8 heatmap**: the "Pad siting proposal (F8)" layer is now "F8 heatmap" (siting.png on siting_png.json); text says D21 picks the official pad by feasible EVAs, not by the F8 score. The pad.json `proposal` block (if still written) is shown as "top F8 score". Rover pad / scorecard pad text follows `pad.source` (pad_default vs the official pad) and states that HUD, 3D and cards use it.
  - **Route-legs table fixed**: units moved into the headers, header cells wrap, tighter padding: 292 px in the 292 px content box (was 313 px). Also fixed: the partner legend's drag note overflowed the panel by ~95 px (legend `li` is flex).
  - **Smoke test** (scratch vite config serving a fixture tree, SCHEMA_MAP rows added in memory by a scratch plugin only; no repo file changed): picker shown, official default, option #2 switches headline (30 and 60 min), feasible EVAs, route, partner + drag note; slider note and locked scenario picker; back to official restores slider. **0 unbacked numbers** (fixture manifest with `pads.*` keys), no console errors, panel has no horizontal scroll.

- 2026-11-14T18:22Z (session 6): **labels and scorecard rows for D21–D39 and set A of D40–D47**, against a scratch real tree (`make_web.run` of today's interim incl. WS2 session 9 names into the scratchpad: make web OK, 2,740 keys, validate/H0 OK; `web/public/data` untouched). Merged main 70b1136. vitest **526 pass, 14 skipped** on main's committed (pre-D21) tree; **539 pass, 1 skipped** on the scratch tree; `tsc` clean; build 2.6 MB without data.
  - **D21/D42 pad**: pad text follows `pad.json source` (cites D21 → "the official pad", **frozen (D42)**; `pad.score` = 38 feasible EVAs, F8 score from `pad.f8_score`, rule passed, block slope 4.86°); marker legend/title say official pad. Picker on WS2's real files (ranks 2–3, rank4, pad_default) with a new **Excl. ≤** column = `pads.{id}.feasible.excluded_by_effort_cap_rule` (14/13/13/13/19), labelled an upper bound for what the conservative O₂ planning rule excludes (D45); option headline shows it too.
  - **D43 60 min**: under the 30-min headline, "Within 60 min: 31.5 % (16.2 % to 43.8 %) of the part of the circle inside the terrain data. **75.8 % of the circle lies inside the terrain data**" (`reachable_pct.{sid}.60`, `reachable_pct_range.{sid}.60.*`, `headline.{sid}.disc_60.in_data_pct`); picker option at 60 min (`pads.{id}.headline.60.in_data_pct`); trade 60-min row (`trade.60.{kg}.in_data_pct`). 30 min stays the headline.
  - **D45** planning-rule note (route section and picker; 1.35 L/min derived from crew.yaml, labelled). **D47/D39**: route section shows the tightest margin (41.21 min, radiation dose, leave S7) with "hypothetical storm timing (tripwire placed where time home is largest)"; same note on the card margin when dose binds.
  - **D44/D26/D46**: names as written (S6/S7 "(south-west, nearer/farther)"), types for `name_base`/`name_suffix`; a null walk home shows "not reachable on foot" (config `stations.yaml placement.unreachable_label`) with WS2's reason on console, card, trade and cuff; trade always shows the conservative walk-home table ("shown as is, not adjusted", S7 not reachable, S2 143.46, S8 127.32 min).
  - **D22/D23/V1**: cell-slope note (3 m plane fit + 30° step guard, assumed; max-slope grid only a "rough footing" overlay) on the slope legend and scorecard; conservative no-go 17° cited from `site.yaml` (legend, trade, scorecard); scorecard V1 shows `role` and `nogo_context.text`, con 30-min disc blocked 36.3 % (nominal 29.22 %) and the old max-slope rule 50.29 % from `terrain.cellstates.*`; "20 − V1 RMSE" and 14.55 gone.
  - **D28**: "Turn back by … · bound by EVA duration" on cards (`turn_back_binding`), a turn-back table (station, t, bound by) in the route section, "Bound by" column in the card's route events, cuff card turn-back rows. **D33**: compass on each card (bearing ticks, dashed = below skyline); landmark suffix now "(below skyline)" from `display`.
  - **D34–D37**: "dose in plastic (E)" + status (G to check, unverified) + time-tag status; tripwire "± 9 min" (`rad.storm_2024.tripwire_halfwidth_label`); excess "≥ 1.73 mGy (lower bound …)" + end-of-window rate 154.7 µGy/day = 1.016 × baseline (+2.4); "Dose equivalent ≈ 1.7 mSv at ⟨Q⟩ ≈ 1"; REMS caption "air temperature and pressure only" (table reads indices 0/1). **D29/D30**: scorecard IST-2 table from `physio.ist2.*` (conservative 20 % = miss) and 21.0 J/mL from crew.yaml; assumptions table adds O₂ energy, conservative slope limit, step guard; access radius "decided (D27)".
  - **real.test.ts**: pre-D21 numbers removed (12.4 %, pad_default fails F8, 14.55°, S1 no access, science 0); new suite runs when `pad.json` cites D21 (12 KATs: official pad, picker + excluded counts, headline 30/60 + in-data keys, route + tightest margin, turn-back bindings, D44 ids/names, D46, D33 ticks, V1 role, IST-2, RAD/REMS, trade). It skips on main's committed tree until C publishes.
  - **Smoke test** (vite dev on the scratch tree): **0 unbacked numbers on every view** (`/` 81 backed, S1 48, S2 38, S4 48, S6 51, S7 45, S8 37, `/trade` 36, `/conditions` 44, `/scorecard` 154, `/cuff` 114); picker option #2 at 60 min 0 unbacked; no data problems, no console errors, console panel without horizontal scroll.

### Doing

- —

### Next

- Smoke-test again on C's next `make web` (the D21 real-tree suite switches on then).
- HUD-on-card strip if WS7 is not green at G2; about page licences/SI text (needs the team).

### Blocked

- Resolved (C v1.1.4): D21 SCHEMA_MAP rows; the picker runs on WS2's real files.
- (WS2 / user, wording) `config/variants.yaml route.access_radius_m` still says "still labelled assumed" after D27; the app now says "decided (D27)" per SPEC §11. Say if it should stay "assumed".

- Resolved 16:28 (C): GitHub Pages live, deploys after green CI on main.
- (C / WS6) `.github/workflows/ci.yml`: please add `npm test` (vitest) to the `web` job.
- (WS3) D7 wording: SPEC's "far rim (41–57 km) … in 21 north-facing frames" has no data field or manifest key, so the app says it without the numbers. Please add them to `validation/v2.json` (e.g. `far_note` or `far.rim_km`, `far.haze_frames`) with keys, and drop "far class pending the D7 manual check" from the card `skyline_error_scope`.
- (WS3) `validation/v2.json n_frames_ok` has no key; the scorecard counts `frames[]` in the browser instead.
- (S / WS2, content) Turn-back times (S4 438.55, S2 409.15 min) are after the 390-min EVA (`clock.eva.eva_min`); shown as written (WS2 question 13).
- Resolved this session: station value key (WS1), route-leg keys (WS2), V1 + KAT list (WS6), headline range low end (con_*).
- Resolved session 4: pad.json `proposal` shape (contract v1.1.2, WS2 session 5).

### Assumptions added

- Session 6: the "tightest margin" in the route section is the lowest `margin_min` over the timeline rows except `turn_back` rows (0 by definition), keyed `timeline.{sid}.{i}.margin_min`; WS2's `route.{sid}.dose.*` keys cite the timeline file but their values are not in it, so they are not shown. IST-2 grades (20, 30 %) are read from the key names. The compass draws only the card's bearings (no number printed).
- Session 5 (D21, provisional until C's contracts): index rows under `pads` (or `rows`), each `{id, lon, lat, elev_m, rank, score, official, tiebreak: {name: value}}`, exactly one `official: true` (or top-level `official: id`); summary `{id, pad: {lon, lat, elev_m}, rank, score, headline: {"30": {reachable_pct, range_pct}, "60": …}` (or `[{budget_min, …}]`), `route: {stops, total_min}}`. Ids must be plain file names. An elevation tiebreak equal to `elev_m` is not printed twice.

- Contract gaps (for C): no web artefact for cell states / source mask, so hatched unknowns use the alpha of the shared `slope` field (A = 0 = no terrain value); this does not mark non-HiRISE (CTX) cells as unknown. Loose schemas (coverage, rems, clock, v2 summary, v1 confusion, donki records) are shown as generic key/value tables until producers fix their structure.
- Manifest keys are not fixed by contracts v1.0; `<Num>` resolves a named key first, then an entry with the same file and value.
- Presentation-only constants (colours, line widths, legend bin step 10 min, label spacing) live in `web/src/theme.ts`, not config/ (WS5 owns no config file).
- D9 leash off the default allowance: τ is recomputed in the browser with `leash.formula` from config and the manifest-backed rate, labelled "computed in the browser"; at the default allowance the page shows rad.json's own value. KAT: recomputes 85.7 min at 0.5 mGy.
- Session 2: the console takes access points from the card's access block when present, else `stations.json access[scenario]`; access lon/lat cite `access.{S}.{scenario}.lon/lat` (stations.json) because the card fragment records no lon/lat keys. Walk-in line drawn only when `dist_m` > 0. Station dwell shown from `config/stations.yaml dwell_min` when it matches.
- Session 2: the F22 table uses each station card's Navcam frame (`navcam.image_id`) and `localisation/{id}.json error_m`; pass = error_m ≤ `skyline_fix.refine_grid_m` (nav.yaml gate, C 11:58).
- Session 3: `<Num dp signed>` rounds only the display (V1/V2 statistics); the manifest link and tooltip carry the stored value. KAT area counts and the V2 frame count are computed in the browser and labelled so (`DerivedNum`).
- Session 3: the D7 far-class text is a fixed string in `web/src/views/validation.ts` (no numbers) until WS3 puts the far note in the data.
- Session 4: the F8 pad block side (21 m) is computed in the browser from `site.yaml siting.block_m` and `grids_m.route` with WS2 siting.py's formula ((2·round(block/grid/2)+1) cells, Python rounding); no manifest key exists for it.

## WS6 Provenance

Branch: `ws6-provenance`

> **Manifest API for every workstream (F16, AGENTS.md rule 6).** Use it for every number the app
> shows:
>
> ```python
> from pipeline.provenance.manifest import record
> record("rad.storm_2024.peak_uGy_day", 8250.0, "uGy/day", "conditions/rad.json", __file__)
> #      key (dotted, unique, no spaces) value  units (None if not numeric)  web file  script
> ```
>
> - `record` adds `commit` (HEAD, `-dirty` if uncommitted code) and `utc` (ISO 8601 Z), validates
>   against `contracts/manifest.schema.json`, and writes a per-script fragment to
>   `data/interim/manifest/<script>.json`. Re-running your script overwrites your own keys.
> - Values: numpy is converted; NaN/inf are refused, so pass `None` for unknown.
> - `file`: the path under `web/public/data/` the number is shown from (e.g. `validation/v1.json`).
> - Prefix keys with your topic (`v1.`, `rad.`, `nav.`, `reachable_pct.` ...). Two scripts writing
>   the same key make the merge fail.
> - Merge (C / `make web`): `uv run python -m pipeline.provenance.manifest merge [--out PATH] [--dummy]`
>   writes `web/public/data/manifest.json`.
> - Tests: set `HOMELINE_MANIFEST_DIR` to a tmp dir (monkeypatch) so test records never land in
>   the shared `data/interim/manifest/`.
> - `record` refuses to write if the clock reads before H0. CI runs
>   `python -m pipeline.provenance.check_h0` (fails on any manifest `utc` or data mtime in
>   `web/public/data/` before H0 from `config/event.yaml`); add `--fragments data/interim/manifest`
>   to check the fragments locally.

### Done

- 2026-11-14T09:44Z: M1 manifest API (`pipeline/provenance/manifest.py`: `record`, `merge`, CLI) and
  `pipeline/provenance/check_h0.py` (H0 from `config/event.yaml`), H0 step in
  `.github/workflows/ci.yml`; 23 KATs pass (F16). Pushed 461c441.
- 2026-11-14T09:50Z: V1 tilt code (`pipeline/validation/v1_tilt.py`, F13): plane-fit DEM tilt over the
  footprint, bias/RMSE/r/confusion at 10/20 deg, MMGIS loader (negative `tilt` -> invalid,
  per discovery 3.1), WS1 coreg shift input, sensitivities (other footprint candidate, IMU from
  roll/pitch), manifest keys `v1.*`; `run_real` + CLI refuse to run while the footprint is open.
  KATs on synthetic data incl. the brief's 10% plane (bias 0).
- 2026-11-14T09:50Z: V1 scatter figure (`pipeline/validation/figures.py`, dependency-free SVG).
- 2026-11-14T09:50Z: KAT collector `python -m pipeline.provenance.kats` -> `data/interim/validation/kats.json`
  (one row per test: SPEC §9 area, features, outcome, reason; manifest keys `kats.summary.*`).
- Manifest records made under pytest go to a temp dir unless `HOMELINE_MANIFEST_DIR` is set, so
  no workstream's tests can leak into the shared `data/interim/manifest/`.
- `tests/test_provenance.py`: 51 KATs pass; full suite 122 pass; ruff clean.
- 2026-11-14T11:40Z (session 2): `config/validation.yaml v1.footprint_m: 3` (user 12:37 CET, for S);
  5 m kept as a sensitivity. KATs first: footprint decided, `conservative_nogo` known answer,
  all-in-DEM set ignores the focus filter. Commit 4c38616.
- 2026-11-14T13:14Z: **real V1** (F13), re-run after merging main 78cb57d (commit f9ffe96, clean;
  same numbers as the 11:40Z run). Inputs: `data/raw/discovery/mmgis_MSL_waypoints.json` (1,389 drive
  ends), WS1 `dem_1m.tif`, WS1 `coreg.json` shift (0, 0) m **added** to the MMGIS x/y (sign
  confirmed by WS1). Outputs `data/interim/validation/v1.json` (valid against `v1.schema.json`) +
  `v1.svg`; 56 manifest keys `v1.*` (file `validation/v1.json`).
  - **Primary (SPEC F13: focus area, 3 m footprint, MMGIS `tilt`): n = 290** (0 excluded: every
    focus drive end has a full 3 m DEM footprint, no invalid tilt). **bias +1.31°** (DEM − IMU),
    **RMSE 5.45°**, **r 0.50**.
    Confusion (DEM predicts, IMU is the reference; positive = tilt ≥ threshold):
    10°: TP 84, FP 55, FN 20, TN 131. 20°: TP 1, FP 15, FN 2, TN 272.
  - Sensitivity, 5 m footprint: n 290, bias +0.78°, RMSE 4.91°, r 0.52; 10°: 76/50/28/136;
    20°: 1/14/2/273 (TP/FP/FN/TN).
  - Sensitivity, IMU tilt from roll/pitch (acos(cos r · cos p)): n 290, bias +1.31°, RMSE 5.45°,
    r 0.50; matrices identical to the primary (MMGIS `tilt` is this quantity).
  - Sensitivity, every drive end on the DEM (no focus filter): 537 of 1,389 (852 off the DEM),
    bias +0.59°, RMSE 4.90°, r 0.58; 10°: 200/71/55/211; 20°: 3/27/9/498.
  - Reading: the 1 m DEM over 3 m is steeper and noisier than the rover's tilt (it cannot see the
    rover's wheelbase averaging); at 20° it raises 15 false alarms for 1 hit, so as a hazard flag it is
    conservative, not permissive. Caveat (SPEC F13): the rover chose gentle ground (3 of 290 ≥ 20°).
  - **For WS2 (con_*) and WS1 (`cellstate_3m_conservative.tif`): use the top-level `rmse_deg` of
    `data/interim/validation/v1.json` = 5.447021 deg → conservative no-go = 20 − 5.447 =
    14.553°** (`v1.json conservative_nogo`, manifest `v1.rmse_deg`, `v1.conservative_nogo.nogo_deg`).
    Not the 5 m or all-in-DEM values; those are sensitivities only. Both consumers already read
    exactly that field (`pipeline/engine/scenarios.py v1_from_file`, `pipeline/terrain/build.py
    step_conservative`).
- 2026-11-14T13:18Z: **KAT list** `data/interim/validation/kats.json` (valid against
  `contracts/kats.schema.json`), commit 70d6e11 (clean), runner pytest+vitest:
  **1,082 tests: 1,081 passed, 0 failed, 1 skipped** (pytest 721/721; vitest 360 passed, 1 skipped:
  `web/src/fp3d/skyline.test.ts` real-data F20 check, skipped by design until fp3d is in the public
  tree). `make kats` alone (pytest only): 721/721. Manifest `kats.summary.*` (4 keys).
  `tests/test_fp3d_export.py` now maps to 3D/F20 (KAT first); 404 rows stay "other" (contracts,
  config, make_web/make_dummy, WS5 views), not guessed.
  To include vitest: `cd web && npx vitest run --reporter=json --outputFile=<f>` then
  `python -m pipeline.provenance.kats --exit-zero --vitest-json <f>`.
- `tests/test_provenance.py`: 54 pass; ruff clean.
- 2026-11-14T15:51Z (session 3, **D23**): **V1 is a validation, not a margin.** `v1.json` no longer
  derives a conservative no-go: `conservative_nogo` removed; new `role` = "V1 = validation of the
  slope model, not a safety margin" (for the WS5 scorecard); new `nogo_context` = config citation
  `{conservative_nogo_deg: 17, source, decision: "D23", derived_from_v1: false, text:
  "conservative no-go = 17° (D23, config)", note}`. Reads `variants.yaml
  variants.conservative.nogo_deg` first, `site.yaml slope.nogo_deg.conservative` as fallback;
  a number or the legacy "20 - v1_rmse_deg" text is accepted and never evaluated; disagreeing
  numbers or no number give `null` with a note. Manifest key `v1.conservative_nogo.nogo_deg`
  **retired** (dropped from the v1_tilt fragment by the new `manifest.drop`, own fragment only);
  `nogo_context` gets no `v1.*` key (it is not a V1 output; WS5 cites config). KATs first (8 new /
  updated). V1 re-run from clean commit 2ed9594: same numbers (n 290, bias +1.31°, RMSE 5.45°,
  r 0.50; 10°: 84/55/20/131, 20°: 1/15/2/272); schema-valid.
- 2026-11-14T15:55Z: **KAT list** re-run at 2ed9594 (pytest+vitest): **1,294 tests: 1,291 passed,
  1 failed, 2 skipped**. The failure is WS7's real-data check
  `tests/test_fields_png.py::test_real_pointer_leads_home_downhill_in_t_home`: the shared
  `data/interim/export/fields/` (15:15) predates WS2's D21–D39 re-run of `data/interim/engine/`
  (16:47), so pointer and T_home masks differ; it fails identically without the WS6 change and
  clears when WS7 re-exports fields (C downstream). Skips: fp3d F20 real check, D21 pads index.
- **D30 (IST-2 pass/miss) and `kats.json`: not mapped, by design.** `kats.json` is one row per
  pytest/vitest test (contract `kats.schema.json`; `summary.failed` counts failing tests). WS2's
  `physio.ist2.{variant}.{grade}.pass` is a model-check finding under "no tuning" (D30), where an
  honest "miss" is a result, not a failing KAT; mapping it would count misses as failed tests.
  D30 puts them in the manifest; the WS5 scorecard reads `physio.ist2.*` from `manifest.json`
  directly (with `band_lo`/`band_hi`/`reported`).

### Audit 1 (2026-11-14T13:20Z): main's `web/public/data/` (C's make web 3fe841a, 846 keys)

Scope: manifest integrity (units, H0, commit, file), coverage (numeric leaves of every JSON file vs
manifest values for that file), CRS (every GeoJSON coordinate and every `bounds`), nodata
(sentinels/NaN in JSON, PNG alpha encoding). Tree-wide: H0 check passes; no NaN/Infinity or
sentinel (−9999, −32768, ±3.4e38, ≥ 1e15) anywhere; **all GeoJSON is lon/lat** (3.6 M coordinates,
0 outside the Gale box, no `crs` member) and every `bounds` is W<E, S<N in lon/lat. A trial merge
of today's 20 fragments in `data/interim/manifest/` gives 929 unique keys (no duplicates).

- **WS1** (36 keys): (a) **the station "value" does have keys** (`stations.S1/S2/S4.value` = 0.8683
  / 0.7443 / 0.475, units "1"), but they are recorded with `file: data/interim/terrain/stations.json`
  instead of the web path `stations.json`, so WS5's `<Num>` (named key, else same file + value)
  cannot match them. 10 keys use interim paths: `stations.*.value`, `terrain.blocked_pct.{30,60}min`
  (`cellstate_3m.tif`), `terrain.slope_compare.median_abs_diff` (`slope_5m.tif`),
  `terrain.xcheck.*` (`hirise_xcheck.json`). Fix: record the web path (`stations.json`;
  `validation/coverage.json` or another shown file for the rest), or WS5 resolves
  `stations.{S}.value` by name. Still so in WS1's current fragment (f70f3eb). (b) The public tree
  still has WS1's old `-dirty` keys (commit 4ff8b1b/fb7e979); WS1's clean re-record (f70f3eb)
  reaches it at the next `make web`. Units, CRS (pad.xy is analysis-CRS metres and labelled `xy`),
  nodata: OK (cell states 0 % unknown in the 3 m grid, consistent with `slope.png` having no A = 0).
- **WS2** (273 keys): **route legs have no keys** (`route_nom_104.geojson` legs `t_min`, `o2_L`,
  `length_m`, `t_start_min`, `t_end_min`; only `route.nom_104.{total_min,margin_terms}`), and
  `timeline_nom_104.json access_dist_m` (2.1, 27.6 m) is unkeyed; `views/route.ts` shows all of
  them. Partner area on /trade is keyed (`trade.30.{suit}.partner_area_km2`); the per-feature
  `area_km2` / `casualty_kg` in `partner.geojson` are not (fine while only the trade value is
  shown). Proposal: `route.nom_104.leg.{i}.{t_min,o2_L,length_m}`,
  `timeline.nom_104.{S}.access_dist_m`. Station value: see WS1 (not WS2). Isochrone `minutes`, band
  `budget` and `suit_kg` are labels from config, not measurements. All commits clean (3bad2dd).
  con_* now unblocked: rmse 5.447 → 14.553°.
- **WS3** (29 keys): clean commit; `fp3d/horizon_ring.json` has no keys (observer `eye_height_m` 1.7
  is config, `z_ground_m` −3627.74 not shown today); `validation/v2.json n_frames_tried/ok` unkeyed
  (shown only if the scorecard prints them). Public tree predates WS3 session 3 (109/119 frames).
- **WS4** (235 keys): clean; `rems.latest_feed.sol` has `units: null` (suggest "sol");
  `rad.json source.median_spacing_min` 17.1 unkeyed (shown with the data lag?). Units otherwise
  consistent with key suffixes.
- **WS7** (60 keys in public, clean edbcd3c): `fields/index.json` has no keys (scales are encoding
  constants; `radius_m_effective` 12/51/102 m is not read by the web app). Nodata OK: every field
  PNG has B = 0 and RGB = 0 under A = 0; unknown share 41.0 % (nom) / 28.7 % (opt) matches between
  `t_home` and `o2_home`; `home_bearing` is valid everywhere (bearing to the pad is defined
  everywhere, SPEC F18 compass). Note: WS7's current interim fragment (13:19Z) is `-dirty`
  (78cb57d-dirty, session running): re-record from a commit before C's next `make web`.
- **WS8**: not in the public tree yet (skipped owner). Interim fragment: 6 keys at 2806c39-dirty
  with `file: data/interim/export/fp3d/index.json` (interim path): record `fp3d/index.json` and
  re-run from a clean commit.
- **WS9** (172 keys): **every key is `-dirty`** (7908eda-dirty) in the public tree and in the
  current fragments (skylinefix, montecarlo, fixinterval): re-run from a committed tree.
  `nav/tracks_*.geojson` (500 runs) have no keys; the 11:58 decision covers per-row playback
  values by the Monte Carlo file's entry; `runs` (500, shown in nav/page) is keyed as
  `nav.montecarlo.{set}.runs` (cite that key by name). `fix_interval_summary.json limit_min`,
  `cells_inside` unkeyed (limit is config).
- **WS10** (38 keys): clean; `vo.drift.{i}.sol` has `units: null` (suggest "sol"). `vo/probe.json`
  and `vo/drift.json` carry many unkeyed per-drive counts (frames, pairs, steps); WS5's drift
  table shows 5 drives: check that every printed cell resolves to a key.
- **C** (3 keys): `terrain.cellstate.pct.*` recorded by `tools/make_web.py` at e3ed2d5-dirty.
- **WS6** (own): `validation/v1.json`, `v1.svg`, `kats.json` and their 60 keys are not in the public
  tree yet; they are ready in `data/interim/validation/` for the next `make web`.

### Doing

- —

### Next

- C: `make web` to publish the D23 `validation/v1.json` (+ `kats.json`). **Consumers to update
  (not WS6 paths):** WS5 `web/src/views/scorecard.tsx` V1 section still reads
  `v.conservative_nogo` (renders nothing once it is gone) → show `v.role` and
  `v.nogo_context.text` (cite 17° from config); WS5 `web/src/data/real.test.ts` "conservative
  no-go 14.55 deg" will fail on the new public v1.json → assert `role` / `nogo_context`
  instead. C: `contracts/README.md` line on `cellstate_conservative.json` still says
  "20° − V1 RMSE". WS2 `scenarios.py v1_from_file` docstring ("the slope RMSE that sets the
  conservative limit") is out of date.
- Audit 2 at about 17:20Z (after the next make web): re-run the audit on the public tree.
- Freeze: `make clean all` from a clean checkout, provenance audit, sign-off.

### Blocked

- — (footprint decided 12:37; coreg sign confirmed by WS1; kats contract and `make kats` / `make
  web` merge + H0 wiring done by C.)

### Assumptions added

- `config/validation.yaml` (new; no config file held V1 constants): `v1.confusion_thresholds_deg`
  [10, 20] (SPEC F13), `v1.footprint_m` 3 (decided 12:37), `v1.footprint_candidates_m` [3, 5],
  `v1.dem_method: plane_fit_square` with `dem_method_assumed: true` (least-squares plane over the
  DEM cells whose centres fall in a footprint-sized square; any nodata cell excludes the drive end).
- V1 IMU tilt = MMGIS `tilt` (deg); negative or missing values are invalid and counted, not fixed.
- V1 primary set = drive ends in `site.yaml aoi_focus` (SPEC F13 "every drive end in the focus
  area"); every drive end on the DEM is reported as a sensitivity.

## WS7 HUD

Branch: `ws7-hud`

### Done

- 2026-11-14T11:00Z: **Field PNG codec** `pipeline/export/fields_png.py` + TS decoder
  `web/src/hud/fields.ts` (contracts v1.1.0: counts = R·256 + G, A = 0 unknown, refuses values
  outside 0..65535 counts). Round trip exact for every count and every `hud.yaml field_scales`
  scale; the committed M0 dummy PNGs decode to the same values in Python and TS (mirrored KAT).
- 2026-11-14T11:00Z: **HUD on dummy data** (`/hud` slot, `web/src/hud/index.ts` `mount(el, ctx)`):
  two-level helmet panel (D14 minimal default), alarm rules 1–5 in order, playback clock
  1/30/60/300× (default 60×, D13), scrubber, route-following marker with dwell ring, band
  colouring by margin while playing, minimap, drag-anywhere ("From here: home in N min
  (conservative M), O₂ needed X L", σ slider 0–100 m), storm switch, fallback drift (2 %, D12)
  with fix resets, worst-case lookup (smallest radius ≥ σ), uncertainty circle and alarm 3.
  "Simulated EVA · real terrain and data" label always shown. Reusable for WS8:
  `loadHudData`, `computeReadout`, `createHudPanel`, `PlaybackClock` (exported from index.ts).
- 2026-11-14T11:05Z: **Real fields grid (C request) = WS1 `grid.json fields_5m`**: 1,480 × 1,480
  px at 5 m, north-up in the analysis CRS, pixel edges at pad ± 3,700 m (the pad is a pixel
  corner, NW corner xy (−4172.5345, −281174.1963)), bounds [137.319359, −4.868421, 137.444641,
  −4.743579]; values are for pixel centres. **WS9's `field_grid()` is identical** (KAT
  `test_ws1_and_ws9_field_grids_agree`), so WS9 changes nothing. `make fields` merges
  `data/interim/navigation/fields_index_nav.json` (`fix_interval_{set}` entries) into
  `fields/index.json` when its grid is exactly this one, and refuses (reports, adds nothing)
  otherwise. The dummy grid (1,481 px centred on the pad) stays as it is.
- 2026-11-14T11:08Z: **`make fields` on WS2's real rasters** (WS2 files of 10:55Z; opt/nom ×
  80/104/120; con_* wait on V1): 20 PNGs, **28.4 MB** in `data/interim/export/fields/` (largest
  `shared/slope.png` 4.1 MB; t_home 0.9 MB, o2_home 1.8–2.1 MB each). `fields/index.json` validates;
  manifest fragment `pipeline__export__fields_png.json` (60 keys: `fields.<key>.sha256`, `.max`,
  `.known_pct`; commit edbcd3c). nom_104: T_home max 296.7 min, known 58.95 % of the grid.
  Worst-case fields (nom_104, 10/50/100 m) computed on the native 3 m grid (radius 4/17/34 cells).
- 2026-11-14T11:10Z: **Real route KAT** (`web/src/hud/real.test.ts`, skipped without data/): on
  WS2's new `route_nom_104` (pad → S4 → S2 → pad, 209.7 min) the HUD's T_home = 0 at the pad and
  matches every timeline row (depart, arrive, leave, O₂ checkpoints, return) within ±0.5 min (max
  0.27 min); margins likewise; the tightest HUD margin along the walk equals the tightest row
  (14.9 min at S2, dose-bound), so alarms 1/4 do not fire on this plan.
- KATs: `tests/test_fields_png.py` 48 pass; `web/src/hud/*.test.ts` 65 pass (5 on real data).
- 2026-11-14T11:20Z: browser check of `/hud` on data-dummy: playback 300×, band shading,
  dwell ring, expanded panel + minimap, drag-anywhere readout; layout fixed to fit the outlet.

- 2026-11-14T11:35Z: **WS9 F21 in the HUD** (`web/src/hud/navhud.ts`, WS9's `navReading` /
  `navLine` / ellipse geometry): when `nav/montecarlo_{default_set}.json` exists the "Odometry"
  toggle replaces the 2 % fallback: σ = ellipse semi-major axis (worst case by the smallest radius
  ≥ it), the 95 % ellipse replaces the circle on map and minimap, alarm 3 fires when the ellipse
  reaches the homeline ("POSITION UNCERTAIN: TAKE A FIX OR HEAD TOWARD ROVER"), the position line
  reads "Odometry ±N m · next fix due in M m · last fix: type, K min ago" (D_max from
  `fields/fix_interval_{set}.png`), and "Take fix" jumps to the next fix event. KATs
  `navhud.test.ts` (6; exact ellipse/band crossing). Checked in the browser on data-dummy.

- 2026-11-14T13:20Z (session 2): **Way-home pointer is now part of the default `make fields`** (contracts
  v1.1.1; `--no-pointer` skips it). Every scenario's `fields/{sc}/pointer.png` sits on WS2's 3 m
  route grid (2,468²) with its own bounds/width/height/res_m and the `stencil` from
  `pointer_offsets.json`. Re-run on WS2's 11:55 rasters: **29 entries, 41.2 MB in
  `data/interim/export/fields/`** (6 pointers = 12.8 MB, 2.0–2.3 MB each: 16 move codes over 6.1 M
  px; compress level 9 or optimize gains 0 bytes) + WS9's 3 `fix_interval_*` PNGs 0.7 MB in
  navigation/ = **41.9 MB in the web tree**. Every file < 50 MB. `fields/index.json` now carries
  WS9's `fix_interval_{low,medium,high}` (the old index predated WS9's file). Index validates; the
  manifest fragment gets `fields.{sc}/pointer.{sha256,max,known_pct}`. KAT on the real export:
  a move exactly where WS2's T_home is finite and > 0; from 60 random reached cells the pointer
  ends on the single T_home = 0 cell and T_home never rises along the way.
- 2026-11-14T13:25Z: **Drag-anywhere draws the way-home path** (`wayhome.ts wayHomeView`): solid
  line from the dragged spot to the rover when it reaches the pad, dashed when it ends short,
  nothing on unreached ground ("no way home known from here"). The pad sits on a 3 m cell corner,
  so "at the pad" = within one pixel of it (WS2's pad cell is (1234, 1233), pixelOf(pad) may be a
  neighbour); the line ends on the pad itself. KATs: corner rule, view states, and every 10th
  vertex of `route_nom_104` leads to the pad on the real pointer. Browser check on real data (pointer
  copied into the web tree for the check, then restored): solid path, "way home drawn", no errors.
- 2026-11-14T13:30Z: **Sun / time-to-dark row** (C decision 12:20; `sun.ts`, expanded panel "SUN /
  DARK IN"): reads `conditions/clock.json` `eva.sun_series` (columns by name, linear, azimuth across
  north, never extrapolated), `eva.t_dark_min` (dark in = t_dark − EVA clock, minutes floored) and
  `eva.t_dark_min_by_observer` (range over the known WS3 horizons, nulls counted; the station's own
  horizon when the HUD dwells at a station WS4 has). Real: "dark in 578 min · sun el 36.7°, az 75° ·
  local horizons 523–571 min (52 stops)". Manifest keys on the row: `clock.eva.t_dark_min`,
  `clock.eva.sun_series`, `clock.eva.t_dark_min_by_observer.{ids shown}`. Hidden without clock.json
  (the dummy tree has none).
- 2026-11-14T13:30Z: **turn_back**: WS2's STATUS describes the rows as "Turn-back (latest leave, O2
  term)" = our reading, so they stay notes, not walk events. Whether to cap them at the EVA budget is
  WS2's open question 13 for S. **con_\***: no rasters in `data/interim/engine/` yet (V1), so none
  exported.
- KATs: `tests/test_fields_png.py` 51 pass; `web/src/hud/*.test.ts` 93 pass (incl. real-data KATs);
  whole web suite 388 pass, 1 skipped; `tsc --noEmit` clean.
- 2026-11-14T14:16Z: **Manifest re-recorded clean** (C audit: 72 keys at `78cb57d-dirty`): `make fields`
  re-run at 1dbbff8 -> 96 `fields.*` keys, all clean, all citing `fields/...`; the 26 previous PNGs are
  byte-identical, +9 `con_{80,104,120}` fields (WS2's con rasters now exist), index gains only those.

- 2026-11-14T15:45Z (session 4): **D39 storm placement** (`config/conditions.yaml storm_replay`):
  `storm.ts` is a TypeScript port of WS4's `pipeline/conditions/storm_replay.py`
  (`tripwireTargetMin`, `stormOffsetUtcMs`, `stormUtcAtMs`, `evaMinOf`, `stormReplay`;
  `parseStormReplayConfig` refuses any rule other than route_max_t_home / tripwire / min / first, as
  `check_config`). The tripwire fires at t* = the EVA minute of the route's largest T_home (samples:
  WS2's timeline rows along the walk, turn_back excluded, so the HUD's t* = WS2's; on the official-pad
  nom_104 **t* = 44.39 min, arrive S7** = WS2 session 7; a 5 m field lookup along route vertices gave
  44.28, one vertex early, so it was dropped); turning
  the switch on no longer moves the storm ("onset at switch-on" removed). The tripwire row reads
  "armed: fires T+h:mm:ss ± 9 min" / "FIRED …" with the label from `rad.json
  storm_2024.tripwire_halfwidth_label` (none shown if absent); its provenance cites
  `rad.storm_2024.tripwire_utc`, `.tripwire_halfwidth_label`, `rad.leash.tau_min_at_peak`,
  `fields.{sc}/t_home.sha256`. KATs `storm.test.ts` mirror all seven WS4 KATs (same inputs, same
  answers) + HUD placement, alarm 2 timing, ± label on the real rad.json.
- 2026-11-14T15:45Z: **D39 drift radius**: the core circle (D19) is max(`fallback_drift.sigma_floor_m`
  5 m, `pct_of_distance` 2 % of distance since the last fix), also at a fix (5 m at the rover pad;
  before: the fix's 2 m). The `sigma_floor_m: 5` key already existed; now cited as D39 in
  `config/hud.yaml`. The F21 ellipse is a separate optional toggle "Odometry (F21, set, optional)"
  shown only with WS9's files; "Drift" is always the D39 circle (before, WS9's files replaced it).
- 2026-11-14T15:45Z: **D28 turn-back binding** (contracts v1.1.3): BINDING row and the turn-back
  sub-line show the term incl. **"EVA duration"** ("bound by EVA duration"); during a dwell the
  station's WS2 `turn_back` row adds e.g. "S2 latest leave T+6:22:10 (O₂)" (pre-D28 timeline). Read from the
  timeline (`margin_binding` of the row in force and of the `turn_back` rows); the card's
  `turn_back_binding` carries the same term (the HUD loads no cards).
- 2026-11-14T16:21Z: **`make fields` on the D21 official pad** (WS2 session 7 rasters, all 9
  scenarios incl. **con_\***), from clean commit **8a1e249** (main + WS2 + WS3 s5): **38 index entries
  (35 PNGs + WS9's 3 `fix_interval_*`), 58.1 MB in `data/interim/export/fields/`** (pointers 9 × ≈ 2.2
  = 20.1 MB; con_\* 14.3 MB incl. their pointers; largest `shared/slope.png` 4.06 MB) + WS9 0.7 MB =
  **58.8 MB in the web tree**; every file < 50 MB. Manifest: 98 `fields.*` keys, all at 8a1e249 (0
  `-dirty`). nom_104 T_home max 199.6 min, known 66.8 % of the grid; con_104 max 264.8 min.
- **Fix (D21): `home_bearing` now aims at the pad in use** (`engine/public/pad.json` `pad`, projected
  with grid.json's crs; manifest `fields.nom_104/home_bearing.pad_lon/lat` = 137.401783 / −4.77748).
  Before, it aimed at `grid.json` pad = pad_default, 2 km off the official pad. KATs: projection round
  trip, synthetic pad shift, real bearing + WS2's T_home = 0 cell at the official pad.
- **Finding (C):** the pad is no longer the grid anchor, so no 5 m pixel centre falls on WS2's single
  T_home = 0 cell: the HUD reads **0.1 min (6 s) at the pad** (the 3 m cell under the pad pixel's
  centre). Data left as sampled (no special case); the KATs "T_home = 0 at the pad" now use the
  brief's ±0.5 min timeline tolerance (`real.test.ts`, `test_real_index_valid_and_pad_zero`). The
  real wayhome KAT read its pad from grid.json (test bug; the app uses pad.json): fixed.
- **WS8 (info):** `src/fp3d/fp3d.test.ts` "camera on the route … real route (nom_104)" fails on the
  new route until `make fp3d` is re-run on the official pad (not WS7's).
- KATs session 4: `web/src/hud/*.test.ts` **114 pass** (93 before; storm 18 incl. 2 real, drift D39,
  D28 4); `tests/test_fields_png.py` **54 pass** (incl. 3 real); whole web suite 479 pass, 1 fail
  (WS8 above), 2 skipped; `tsc --noEmit` clean; `vite build` OK.

### Doing

- —

### Next

- C: `make web` to publish the official-pad fields (58.8 MB incl. con_\*).
- C: `make web` to publish the pointers and the merged index (the HUD already runs on the real tree).
- 60 fps check at 60× on a real laptop (the automated browser here is throttled to ~15 fps even
  when the HUD is idle, so it measures nothing).

### Blocked

- — (fields size accepted by C 14:28, "≈ 56 MB with con_*"; actual with con_* on the official pad
  **58.8 MB** in the web tree, every file < 50 MB. If too much: `--no-pointer` + a nom_104-only
  pointer run, or pointers for the 104 kg suits only.)

### Assumptions added

- A-WS7-1: within a leg the marker follows the route's `times_min`; without them, uniform speed.
- ~~A-WS7-2~~ **Accepted (D39, user 16:20, "HUD no-route skip accepted"), no longer an assumption:**
  worst-case fields and the alarm-3 circle skip cells with no T_home (blocked > no-go,
  unreached): the crew cannot be there on the plan. Unknown only if no reachable cell is in the
  disc. (The M0 dummy used "any unknown → unknown".) Disc radius rounded up to whole 3 m cells
  (12 / 51 / 102 m).
- A-WS7-3: HUD margin = (timeline `margin_min` + `t_home_min`, interpolated in t) − T_home at the
  position (worst case within σ); turn-back countdown = that margin.
- A-WS7-4 (revised session 4; placement decided D39): the storm tripwire fires at t* per
  `conditions.yaml storm_replay` (no longer at switch-on). Assumed: the route T_home samples are
  WS2's timeline rows along the walk (turn_back excluded), as WS2 uses; the dose budget
  counts down from `leash.tau_min_at_peak` after the tripwire; alarm 2 when T_home ≥ budget left.
- A-WS7-6: the pad is "reached" when the pointer path stops within one 3 m pixel of the pad
  (pad on a cell corner). Sun row minutes are floored; outside WS4's series the sun position is
  unknown (not extrapolated).
- ~~A-WS7-5~~ **Decided (D39):** drift σ = max(5 m, 2 % of distance since the last fix), also at
  the fix (a fix σ above the floor would still hold; none is).
- 5 m sampling: each 5 m pixel takes the 3 m cell under its centre (no ties on these grids);
  slope = the 1 m `slope_5m` cell at the 5 m pixel centre; `home_bearing` = geometric bearing to
  the pad (grid.json), known everywhere.

## WS8 3D

Branch: `ws8-3d`

### Done

- 2026-11-14T11:05Z: **Scene shell on data-dummy** (`web/src/fp3d/`, `/hud3d` slot `mount(el, ctx)`):
  Three.js (lazy, WebGL2 checked first), chunk loader with loading screen (files, MB of total),
  camera at `hud.yaml eye_height_m` above the drawn mesh following the route (route v1.1.0
  `times_min` per vertex, else leg times / timeline), fps meter, fallback to the 2D HUD without
  WebGL2 or under `fps_3d_fallback_below` for `fallback.fps_window_s`, fixed caption "1 m terrain:
  ridges under ~3 m are not resolved", "Simulated EVA" label. Ported from the pre-H0 reference and
  checked against contracts v1.1.0 (index shape = the M0 dummy's `chunk_grid`).
- 2026-11-14T11:13Z: **Real export** `make fp3d` (`pipeline/export/{terrain_chunks,far_mesh,ortho_chunks}.py`
  → `data/interim/export/fp3d/`, the make-web source): corridor = WS2 `route_nom_104` + every
  station buffered 150 m → **41 near chunks** (256² at 1 m from WS1 `dem_1m.tif`, 0 nodata px),
  41 textures (WS1 `ortho_lrgb_1m.tif`, 256 px = its 1 m pixel; alpha-0 texels = ground colour),
  **far mesh 1,504² at 8 m** (pad ± 6,016 m: 948,676 cells dem_1m, 1,313,030 ctx_20m, 310 MOLA,
  0 filled). **Total 9.93 MB** (+ WS3 ring 87 kB; budget 30 MB). `fp3d/index.json` validates; manifest
  keys `fp3d.download_mb`, `.near_chunks`, `.near_res_m`, `.far_res_m`, `.far_extent_m`,
  `.corridor_half_width_m`.
- 2026-11-14T11:15Z: **Sun and sky**: sun direction = WS4's Mars24 series (`conditions/clock.json`
  `eva.sun_series`, from `pipeline/conditions/sun.py`), interpolated only; KAT: the committed series
  equals `sun.sun_position(sun.eva_start_utc() + t)` within 0.002°. Sky gradient, sun glow/disc,
  exp2 haze, curvature drop d²/2R in the vertex shader, WS3's far-skyline ring as a curtain. The
  dummy tree has no clock.json: labelled "placeholder sun".
- 2026-11-14T11:20Z: **F20 checks on real data** (`make fp3d-check`; GPU probe
  `web/src/fp3d/check/skyline_probe.mjs` in headless Chromium):
  - Eye height on `route_nom_104`: 7,987 points over 6,221 m, max |agl − 1.7 m| = 3 × 10⁻⁶ m.
  - Camera position = WS7's HUD playback position at every clock time (839 times, max 8 × 10⁻¹⁰ m).
  - **Rendered skyline vs WS3 horizons (tolerance 0.5°)**, geometry / GPU: **pad 0.44 / 0.45° PASS**,
    **S4 0.20 / 0.17° PASS**, **S2 0.87 / 0.89° FAIL**, **S1 0.54 / 0.58° FAIL** (Blocked 1, 2).
    Means 0.02–0.07°. Dummy: all 4 pass (max 0.35° geometry, 0.40° GPU).
- 2026-11-14T11:25Z: **WS7 HUD panel mounted over the 3D view** (WS7 public API only:
  `loadHudData`, `playbackPosition`, `hudFrame`, `createHudPanel`, `readoutSources`) and the view
  runs on **WS7's `PlaybackClock`** (same speeds, 0..eva_h·60 min). Checked in the browser on dummy.
- KATs: `tests/test_fp3d_export.py` 34 pass; `web/src/fp3d/*.test.ts` 50 pass + 1 data check
  (`FP3D_REAL_CHECK=1`); full suite 692 pytest, 328 vitest; ruff, tsc, contracts clean.

#### Session 2 (2026-11-14, C decisions 12:35 and 14:13; D19, D20)

- 13:52Z **Rebuilt `make fp3d` with the canonical bands** (commit a0d76ec, manifest keys clean):
  the far mesh now reads its sources after dem_1m from `config/horizon.yaml bands` (the same
  files WS3's engine reads; C 14:13 = `ctx_20m_v2.tif`, then `mola_hrsc_200m.tif`), no
  hard-coded paths. Far cells: 948,676 dem_1m, **1,312,957 ctx_20m_v2**, 383 MOLA, 0 filled.
  Same 41 near chunks / 41 textures. Reference horizons = WS3 session 3 (14:31 CET: dem_1m to
  its coverage edge + CTX v2), ring = WS3's 14:31 `horizon_ring.json`.
- **F20 re-check (`make fp3d-check`, then the GPU probe in headless Chromium/SwiftShader on a
  scratch build with the real fp3d tree), tolerance 0.5°, geometry / GPU:**
  | Station | Session 1 | Now (geometry) | Now (GPU) | Pass rule |
  | --- | --- | --- | --- | --- |
  | pad | 0.44° | **0.212°** (az 209) | **0.250°** | PASS |
  | S2 (access cell) | 0.87° | **0.288°** (az 220) | **0.345°** | PASS |
  | S4 (access cell) | 0.20° | **0.200°** (az 50) | **0.167°** | PASS |
  | S1 (no access cell) | 0.54° | 0.543° (az 142) | 0.582° | reported, excluded (C 12:35) |
  Means 0.018–0.069°. Eye height on `route_nom_104` (WS2 14:45 route): 7,987 points over
  6,221 m, max |agl − 1.7 m| 3 × 10⁻⁶ m; camera = WS7 playback position at 839 times (8 × 10⁻¹⁰ m).
  The S4 0.504° WS3 saw against my v1 mesh is gone (0.200°), as WS3 predicted.
- **Pass-rule scope in the data** (C 12:35): `skyline_check.stations[].pass_rule` (false for a
  station WS2 gives no access cell, i.e. `access_lon` null: S1) + `excluded_reason`;
  `make fp3d-check` and the GPU probe assert the tolerance on pass-rule stations only and print
  the others as REPORT.
- **Far-mesh texture `fp3d/far_tex.jpg`** (`ortho_chunks.export_far_texture_from_file`): WS1's
  `ortho_lrgb_1m.tif` over the whole 12,032 m far square at 4 m/texel (3,008², JPEG q82,
  **0.92 MB**); each texel is the area mean where the ortho covers it fully, else
  `panorama.ground_rgb` (5,555,614 texels = 61 % of the square lie outside the ortho: flat
  ground colour, nothing invented). The view loads it when `far.tex` is in the index (dummy tree:
  none, untextured as before); far-mesh UVs span the far square. Checked in the browser.
- **fp3d size: 10.85 MB** (10,847,716 B incl. far_tex; + WS3 ring 87 kB) of the 30 MB budget.
- **D19:** the 3D HUD already runs WS7's `hudFrame` with no WS9 nav (`null`) and no minimap:
  it shows F19's σ circle (position line "planned route · ±0 m") and station fixes, never the
  F21 ellipse or the Odometry line; a KAT now pins this. Nothing to hide.
- **D20:** the 3D HUD's partner row (WS7 panel, expanded level) is relabelled
  **"Partner line (cart haul, 60 min)"** in the 3D overlay only (case and minutes read from
  WS2's partner file: the `cart` features' `contour_min`; nothing is invented when there is no
  single cart contour). Checked in the browser DOM. WS7's files are untouched. The 3D scene
  draws no partner line.
- KATs: `tests/test_fp3d_export.py` +5 (far texture ×3, canonical far sources, pass-rule
  scope); `web/src/fp3d` +5 (far UVs, far.tex parsing, D20 label ×2, D19). Full suite
  738 pytest, 393 vitest (+1 data check); ruff, tsc, `make validate` clean.
- 2026-11-14T14:19Z: **Manifest fix** (C audit): the 6 `fp3d.*` keys now cite the web path `fp3d/index.json`
  (`record_manifest`, KAT first); re-recorded by `make fp3d` at clean 2b46c60. Export deterministic (84
  binaries byte-identical); only `index.json` `skyline_check` pad moved, because WS3's `horizons/pad.json`
  now uses WS2's withheld `pad.json` (137.402443, −4.769028 ≠ `pad_default`). Previous index restored; **C to decide**.


#### Session 4 (2026-11-14, D21 official pad, route pad → S7 → S6 → S1 → S4 → pad)

- **Pad = WS2 `pad.json` top-level pad (D21)** (`terrain_chunks.official_pad`, KATs first): `make fp3d`
  centres the chunk and far grids on rank1 (137.401783, −4.77748), never `pad_default`, an
  alternative or the proposal; refuses a missing/dummy/padless file; records `pad` in
  `fp3d/index.json`; refuses a WS3 `pad` horizon that is not at that pad (6 decimals).
- **Grid snapped to the dem_1m lattice** (`snap_grid_to_lattice`, < 0.5 m move): WS1's 1 m lattice
  was built on pad_default, so a grid centred on rank1 resampled every near chunk half a pixel off
  (bilinear smoothing; S7 az 306, a 5 m feature, was 0.65° low). KATs first.
- **Station far-skyline rings** (`station_rings` in `fp3d/index.json`; `ring.ts farCurtains`; view
  and skyline check draw the same curtains). WS3's ring holds the **pad's** far skyline; from
  stations 1–2 km away the 12–20 km Mount Sharp slopes (az 108–115, 138) and the 70 km rim
  (az 224–227) are hidden from the pad and were missing: first real run at rank1 gave S1 0.69°,
  S6 0.70°, S7 1.08°, S8 0.78°. Each station's own WS3 horizon points beyond the far square are now
  placed at their true position (z = z_eye + d tan(el) + d²/2R). **Caveat for the record:** beyond
  the 12 km far square, the skyline at a station is drawn from WS3's computed horizon (as the pad
  ring already was), so the F20 check there tests placement, not independent terrain. Station rings
  break at distance jumps > `ring.station_max_distance_ratio` 1.25 (new, assumed): joined, a
  12 km→8 km top edge hung in the air 0.36° above the pad's horizon (S1 az 141).
- **Stale chunks pruned** (`prune_stale_chunks`): make web copies `fp3d/near*/*` by glob; 70 files
  of the old grid removed.
- **`make fp3d` at clean 46b7e4f** (manifest keys at that commit): **57 near chunks** (route corridor
  + all 6 stations), 57 textures, far 1,504² at 8 m (948,676 dem_1m, 1,312,987 ctx_20m_v2, 353
  MOLA, 0 filled), far texture. **Size 12.66 MB** (12,659,877 B) + index.json 373 kB (station
  rings) + WS3 ring 87 kB = **13.12 MB of the 30 MB budget**.
- **F20 (`make fp3d-check` + GPU probe, headless Chromium/SwiftShader on a scratch build with the
  real fp3d tree), tolerance 0.5°; every station has an access cell, so all are in the pass rule:**
  | Station | Geometry | GPU | |
  | --- | --- | --- | --- |
  | pad | 0.168° (az 258) | 0.330° | PASS |
  | S1 | 0.089° (az 257) | 0.163° | PASS |
  | S2 | 0.262° (az 78) | 0.264° | PASS |
  | S4 | 0.251° (az 70) | 0.245° | PASS |
  | S6 | 0.089° (az 77) | 0.148° | PASS |
  | S7 | 0.321° (az 313) | 0.339° | PASS |
  | S8 | 0.163° (az 150) | 0.164° | PASS |
  Means 0.006–0.029° (geometry). Camera on the route: 11,080 points over 8,652 m, max |agl − 1.7 m|
  6 × 10⁻⁶ m; camera = WS7 playback position at 841 times (8 × 10⁻¹⁰ m). Camera start = route start
  = the official pad.
- KATs: pytest +9 (official pad ×5, prune, snap ×2, station rings); vitest +4 (station rings ×4).
  Full suite: **869 pytest pass, 1 fail** (`test_fields_png::test_real_index_valid_and_pad_zero`,
  WS7 real fields not yet re-exported at rank1); **461 vitest pass, 2 fail** (WS7 `hud/real.test.ts`
  T_home at pad, `hud/wayhome.test.ts` pointer: same stale WS7 fields). ruff, tsc clean.

### Doing

- —

### Next

- **C: add one `make web` rule** in `tools/make_web.py` RULES, after
  `Rule("WS8", "export", "fp3d/far.f32.gz")`: `Rule("WS8", "export", "fp3d/far_tex.jpg"),`.
  Then `make web` (WS8 no longer skipped). `fp3d/index.json` lists `far.tex`; without the rule
  the view requests a missing file and fails to load.
- Performance pass on a real GPU (≥ 30 fps; SwiftShader here gives ~1 fps): R on the reference
  laptop. Far-mesh LOD if needed.
- Re-run `make fp3d` + `make fp3d-check` whenever WS2 changes the route/stations/pad or WS3 the
  horizons (the `skyline_check` reference is baked at export time).
- Sun morning: one 2 s first-person capture for the video option.

### Blocked

1. ~~F20 at S2~~: resolved (C 12:35 + WS3 session 3): 0.288° / 0.345° GPU.
2. ~~F20 at S1~~: resolved by C 12:35 (excluded from the pass rule, reported: 0.543° / 0.582°).
3. Config: `config/fp3d.yaml` accepted by C 12:35 (all `assumed: true`); R to review.
4. ~~Pad source~~: resolved by D21 (16:14); session 4 reads pad.json's top-level pad.
   Old note: **Pad source (C / WS3, heads-up).** WS2 session 4 wrote `engine/public/pad.json` (F8 proposal:
   137.402443, −4.769028, ≈ 2.5 km NE of `pad_default`). WS3's pad order reads WS2's pad.json
   first, so the next `make horizons` would move the pad horizon there, while the 3D grid, the
   route and the decision log (11:24) keep `pad_default`. If the proposal is not accepted, WS3's
   order should skip it; if it is, everything downstream (route, horizons, fp3d) re-runs.

### Assumptions added

- `config/fp3d.yaml` (new): corridor 150 m half-width; texture 256 px/chunk (1 m) JPEG q82;
  height quantum 1/64 m; far mesh half-width 6 km (`far.half_extent_m`, index `far.origin_xy_m`);
  ring neighbours always joined (`max_distance_ratio: null`; breaking at distance jumps opened an
  8.8° hole at S2); view/sky/haze/light values (rendering only); fps window 5 s after 3 s warm-up;
  look-ahead 15 m; skyline check 1° azimuth step, GPU probe FOV 100°.
- Every station (visited or not) gets 1 m near chunks (the F20 rule is "at each station").
- `fp3d/index.json` adds to the dummy's keys: `far.origin_xy_m`, `far.cells_by_source`,
  `height.quantum_m`, per-chunk `bytes`/`tex_bytes`/`filled_px`/`tex_nodata_px`, `sources`,
  `download_bytes`, `skyline_check` (WS3 horizons at 1°). The schema is loose; WS8 is the only
  reader. C may fold the structure into the contract.
- `make fp3d` is not in `make all` (C's Makefile): run it after `engine` and `horizons`.
- Session 4: `fp3d.yaml ring.station_max_distance_ratio: 1.25` (rendering only); `fp3d/index.json`
  adds `pad` and `station_rings` (WS8 is the only reader); the chunk grid is the pad-centred grid
  moved < 0.5 m onto the dem_1m lattice.
- Session 2: `fp3d.yaml far.texture` (4 m/texel, JPEG q82; 3,008 px stays under 4,096, the
  WebGL2 minimum texture size); far-mesh sources = `horizon.yaml bands` (not repeated in
  fp3d.yaml); F20 pass rule "route stations" = stations with an access cell in WS2's
  stations.json (C 12:35 wording: S1 "not on the route (no access cell)").

## WS9 Navigation

**⏸️ Suspended (optional add-on), 2026-11-14 14:19, user:** F21/F22 out of core (SPEC §2.4, D19); no new jobs; merged work stays. Core: F19 drift rule + station fixes.

Branch: `ws9-nav`

### Done

- 2026-11-14T10:11Z: M1 F21 dead-reckoning error model (`pipeline/navigation/deadreckon.py`: step scale
  + per-step noise, psi0, gyro bias, heading random walk, slip above `slip_min_slope_deg`; fix events
  reset position to N(0, sigma) and heading to a new psi0) and Monte Carlo summaries
  (`pipeline/navigation/montecarlo.py`: 95% ellipses per minute, r95, r95(D) = a*D + b*D^2 NNLS fit,
  contract writers for `nav/montecarlo_{set}.json`, `nav/tracks_{set}.geojson`, `nav/fixes.json`,
  manifest keys `nav.r95_fit.*`, `nav.montecarlo.*`, `nav.fixes.*`). Ported from the pre-H0 reference
  code and checked against contracts v1.0.0. KATs on a synthetic straight route, full Monte Carlo from
  config (500 runs, seed 20261114): zero-error = truth; heading-bias-only lateral error = analytic within
  1%; 95% ellipse covers 95.6 / 94.8 / 95.0% of runs at 10 / 30 / 60 min; error resets at fixes; slip
  only above 10 deg; contracts validate.
- 2026-11-14T10:15Z: fix-interval map (`fixinterval.py`): margin radius, D_max = inverse r95 fit, 0
  outside the homeline, NaN where T_home is unknown; classes from `fix_interval.classes_m`;
  `nav/fix_interval_summary.json` (one file, `set` = nav.yaml `default_set`; other sets in the run
  report); `fields/fix_interval_{set}.png` (1 m per count) on the HUD field grid. KATs: D_max smaller near
  the edge and 0 outside; EDT radius = worst-field interpolation where both exist; PNG round trip.
- Real-route driver (`real.py`, `run.py`), `make nav` (= `run real`; `NAV_ARGS=--no-skyline` for the G2
  fallback). `run real --dry-run` lists inputs with owners. Writes to `data/interim/navigation/` (mirrors
  the web paths), refuses `web/public/`. End-to-end KAT on a tmp WS2/WS1-shaped tree.
- 2026-11-14T10:21Z: `/nav` view (`web/src/nav/`) on data-dummy: fix-interval classes, estimated track
  (truth behind "show truth"), 95% ellipses every 5 min, fix events, playback with the ellipse in force
  and the SPEC position line ("Odometry ±N m · next fix due in M m · last fix …"), headline from the
  summary, ellipse-size chart, method and parameter table from config. Exports for WS7's HUD:
  `navReading`, `navLine`, nav loader, D_max decoder, ellipse geometry. vitest 5 files / 33 nav tests;
  tsc + vite build clean.
- 2026-11-14T10:26Z: F22 skyline fix (`skylinefix.py`: coarse 50 m grid / 1 deg rays / far field >=
  500 m, refine 10 m around the best 3, far-weighted RMS, sigma from the 1.5 x min-RMS region) and
  `run skyline` (every WS3 frame tried, standalone 300 m prior, `skyline_report.json` +
  `localisation/{image_id}.json`); `run real` turns frames paired with a route station into skyline fixes
  (lowest RMS, never lowest error). KATs: synthetic DEM with a known observer recovered within one
  10 m grid step, every frame reported, contracts. Verified against `origin/ws3-horizon` (92d2f61) in a
  temp worktree: all 47 nav KATs pass there; on main the 4 engine KATs skip until WS3 merges.
- `tests/test_nav.py`: 44 pass + 4 skipped (WS3) before the main merge; full suite and ruff green.
- 2026-11-14T10:31Z: merged `origin/main` (WS3 now on main): all 48 nav KATs pass, none skipped
  (F22 synthetic-DEM KAT included); full pytest, ruff, tsc, vitest (212), validate_contracts green.

- 2026-11-14T11:20Z (session 2): **real run `make nav`** on WS2's `route_nom_104` (pad -> S4 -> S2 ->
  pad, 209.74 min, 6,215 m, slope known on 100 % of steps), 500 runs per set, seed 20261114, 2 min 14 s
  (F22 over 49 frames included). Fix events: rover at the pad (0, 209.74 min, sigma 2 m), station
  fixes at S4 (48.44 min) and S2 (108.73 min, sigma 5 m); no skyline fix passed the gate (below).
  Outputs in `data/interim/navigation/` at the contracts/README web paths; `validate_contracts --data
  data/interim/navigation` OK (0 errors); manifest fragments `pipeline__navigation__{montecarlo,
  fixinterval,skylinefix}.json`.
  - **r95(D) fit (NNLS, no intercept), b = 0 in all sets** (pure linear on this route): low a =
    0.0376, medium **a = 0.1323 (132 m per km since the last fix)**, high a = 0.3697; fit RMSE 5.0 /
    29.9 / 169.6 m.
  - **r95 along the route (medium)**: EVA t = 30 min (1,681 m since the pad fix) **187 m**; 60 min of
    walking after the S2 fix (t = 199 min, 1,718 m since it) **268 m**; largest just before the
    return fix (2,099 m since S2) 358 m. Low: 60 / 66 m; high: 392 / 889 m at the same points.
    At t = 60 min the crew is dwelling at S4 just after its fix (12.3 m in every set).
  - **Fix-interval headline (medium, nom_104, 30-min homeline; `nav/fix_interval_summary.json`)**:
    D_max median **50.7 m**, edge p10 **22.7 m**; area inside the homeline by class: < 100 m 76.9 %,
    100-300 m 20.1 %, 300-1,000 m 3.0 %, > 1,000 m 0 % (134,557 cells). Low: median 178.5 m, high:
    18.1 m (run report only). Reading: D_max = margin radius / a, so the median margin radius is
    ~6.7 m: the reachable set (12.4 % of the disc, slope-limited, thousands of blocked holes) leaves
    little room to the nearest over-limit cell. For N: "fix every ~50 m" is a property of the
    fragmented reachable set as much as of the drift model.
- 2026-11-14T11:20Z: **F22 on the real frames, station frames included** (C 11:58 gate, KAT
  tolerance = `skyline_fix.refine_grid_m` 10 m). All 49 frames tried: 35 ran, 14 failed WS3's
  clear-sky check ("no clear sky at the top of the frame"); error median **657 m** (p25-p75 452-815
  m), min 257 m, **0 within 10 m, 0 within 100 m**, 4 within 300 m. Station frames (WS3 tags):

  | Station | Frame | Frame to station | Error | RMS | sigma (score) | Gate |
  | --- | --- | --- | --- | --- | --- | --- |
  | S1 (not on route) | NLB_826633404 | 523 m | 788 m | 4.02 deg | 48.9 m | fail |
  | S2 | NLB_789347468 | 925 m | 280 m | 2.84 deg | 48.9 m | fail |
  | S4 | NLB_767161116 | 128 m | 966 m | 6.04 deg | 48.5 m | fail |

  **No skyline fix becomes a position fix**; S4 and S2 keep their surveyed station fixes (sigma 5 m);
  `run_report.json skyline.rejected` gives the reason per station. The score-surface sigma (~49 m)
  understates the real error by 6-20x, so sigma alone must not gate a fix. The far-field skyline
  barely constrains position here (lowest-RMS frames: 0.04 deg RMS at 401 m error). Even a passing
  frame would localise the rover's drive end, 128-925 m from the station, not the station.
  `localisation/{image_id}.json` for the 35 frames that ran (validation finding, not position fixes).
- 2026-11-14T11:20Z: F22 now reads the horizon engine's bands from horizon.yaml `bands.*.path` (WS1
  canonical `terrain/ctx_20m.tif`, `mola_hrsc_200m.tif`, C 11:15); nav.yaml `skyline_bands:
  horizon.yaml`.
- 2026-11-14T11:20Z: **nav.yaml `vo:` block** (WS10 request): `PENDING_VO_CONFIG` verbatim, `assumed:
  true`; `vo.load_vo_config()` now returns "config/nav.yaml vo" (KAT: every key equals the pending
  value). **`optional_sets.curiosity_vo_256`** (label "rover analogue: a rover is not an astronaut",
  status pending N): sigma_s 0.00638, sigma_b 1.248 deg/h of rover driving (WS10 `vo_report.json`),
  psi0 / psi_rw / slip null (not measured; `missing_terms_from: medium`). Not in `sets`, not the
  default, not run by `make nav`.
- Fields grid: WS7's canonical grid = WS1 `grid.json fields_5m` (1,480 x 1,480 at 5 m, pad +/- 3,700
  m) is identical to WS9's `field_grid()` (WS7 KAT); `fields_index_nav.json` written on it. Nothing to
  change.
- KATs: `tests/test_nav.py` 54 pass (6 new: gate tolerance, gate pass/reject, rejected frame keeps the
  station fix, canonical bands, vo keys, optional set); full pytest, ruff, tsc, vitest nav (33) green.

### Doing

- — (session 2 done; ws9-nav pushed for C)

### Next

- Hand WS7 the nav outputs for the HUD (ellipse, "next fix due in M m"); `/nav` on the real files once
  `make web` copies `data/interim/navigation/`.
- If N approves the Curiosity set: wire `optional_sets` into a run (needs a rule for the unmeasured
  terms). An all-sets fix-interval summary only after G1 (C 11:58).

### Blocked

- (N) Model review: `model_conventions`, `fix_interval_ws9.reserve_min` 0 (SPEC "budget minus
  reserve" has no reserve defined), and whether sigma_b per hour of rover driving transfers to a
  walker (WS10 Curiosity set).
- (C) F22 presentation: all three station frames fail the gate (280-966 m), so F22 is a validation
  finding only; the HUD/nav plan uses station fixes (per C 11:58). Nothing more for WS9 to do unless
  WS3's detector / V2 changes.

### Assumptions added

- `config/nav.yaml model_conventions` (assumed): how SPEC F21's prose model maps to code (psi0 redrawn
  at each fix, gyro bias per run, random walk per step, per-step noise summed, slip along-track,
  ellipse = chi-square 2-dof from the second moment, NNLS fit without intercept). For N to confirm.
- `config/nav.yaml tracks` (ellipse every 5 min from SPEC §6.2; 72 polygon vertices, presentation).
- `config/nav.yaml fix_interval_ws9` (assumed): budget = crew.yaml walkback_budgets_min[0]; reserve 0
  (SPEC says "budget minus reserve" but no reserve is defined for it; crew.yaml reserve_min = 30 is
  the EVA reserve and would zero the 30-min homeline): question to N; margin radius by exact
  distance transform (= the circular max-filter criterion, not capped at 100 m) with SPEC's
  worst-field interpolation kept as an option; unknown T_home counts as over the limit; edge figure
  = 10th percentile of D_max inside the homeline.
- `config/nav.yaml real_run_ws9` (assumed): timeline event -> fix type; a skyline fix replaces the
  station fix; frame pick = lowest RMS; standalone prior; unknown slope = no slip; field grid; DEM band
  paths for the horizon engine (WS1 dem_1m, WS3 `data/interim/horizon/bands/`).
- Synthetic walking speed = crew.yaml anchor 0.98 m/s.
- `config/nav.yaml real_run_ws9.skyline_fix_gate` (decided by C 11:58, tolerance from
  `skyline_fix.refine_grid_m`); `vo:` (WS10's constants, assumed); `optional_sets` (pending N).

## WS10 Visual odometry

**⏸️ Suspended (optional add-on), 2026-11-14 14:19, user:** X8/X9 out of core (SPEC §2.4, D19); no new jobs; merged VO results stay.

Branch: `ws10-vo`

### Done

- **X8 data probe (brief step 1), 10:13 UTC.** `pipeline/navigation/vo_probe.py` (ported from the pre-H0 reference code, re-run fresh), KATs in `tests/test_vo.py` (26 pass). Output `data/interim/vo/probe.json`, valid against `vo_probe.schema.json`; manifest keys `nav.vo_probe.*`. 8.3 MB downloaded to `data/raw/vo/` (raw-API metadata, MMGIS waypoints, 10 pairs of 256² frames per drive for a decode/feature check).
- The 5 most recent MMGIS drives, all site 125. "During" = `prev_end < drive < end` at the same site. Spacing = 3-D distance between consecutive pose `xyz` (site frame).

  | Sol | Drive (prev → end) | MMGIS m | 256² L/R pairs | Spacing median (max) | Longest run ≤ 2 m | CAHVOR + attitude | Full-res pairs | Mast az/el |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 5073 | 125_2274 → 125_2490 | 27.9 | 35 | 0.946 m (1.13) | 35 | all | 2 (1 pose) | 90° / −29° |
  | 5070 | 125_2082 → 125_2274 | 28.7 | 31 | 0.945 m (1.02) | 31 | all | 2 (1 pose) | 0° / −29° |
  | 5069 | 125_1326 → 125_2082 | 101.3 | 124 | 0.953 m (1.20) | 124 | all | 2 (1 pose) | 90° / −29° |
  | 5045 | 125_1194 → 125_1326 | 12.6 | 21 | 0.933 m (1.19) | 21 | all | 4 (2 poses) | 90° / −29° |
  | 5041 | 125_558 → 125_1194 | 83.9 | 106 (103 poses) | 0.985 m (1.29) | 103 | all | 2 (1 pose) | 90° / −29° |

  Contract `stereo_pairs` counts all non-thumbnail pairs (256² + full res: 37, 33, 126, 25, 108). Frames decode at 256 × 256; ORB (defaults) finds ~440 keypoints per left frame, median L/R fundamental inliers 151–234, frame-to-frame 34–112 (min 19): indicative only, not a VO result.
- **Go rule (`nav.yaml vo_probe.go_rule`), mechanical result: go**, met on 5/5 drives at 256² and 0/5 at full resolution. **D16 is N's decision**; WS10 stops here until N records it.
- **X8 stereo VO at 256² (brief step 2), 10:47 UTC, D16 = go at 256² only.** `pipeline/navigation/vo.py` (ported from the pre-H0 reference code, run fresh on this session's frames), 22 new KATs in `tests/test_vo.py` (48 pass): CAHV/CAHVOR triangulation, known baseline → depth = f·b/d, linearised pinhole exact for rays, same pose → zero motion, 1 m + 4° step with 30 % outliers, metric scale from stereo, rendered 256² textured-ground stereo (same pose; 0.95 m + 3° step), chain/endpoint metrics, bridged steps counted, drift table lists every drive incl. no-data, per-pose attitude comparison, stop rule. Output `data/interim/vo/drift.json` (valid against `vo_drift.schema.json`, every row labelled "rover analogue: a rover is not an astronaut") + `vo_report.json` (per-pose, onboard and calibrated-set detail); manifest keys `vo.drift.*`. 19.5 MB downloaded (all 256² TRAV pairs of the 5 drives; `data/raw/vo/` now 29 MB).
- Method: SIFT, mutual ratio-test L/R matching, midpoint triangulation on each frame's own CAHVOR (≤ 1 px reprojection, 0.5–25 m), frame-to-frame PnP + RANSAC on the linearised next-left camera + LM refinement; a failed step is bridged with the rover's onboard relative pose and counted. Start = MMGIS previous drive end (position + yaw/pitch/roll); compared with the MMGIS drive end and, per pose, with the API `attitude`/`xyz`.

  | Sol | Drive | MMGIS m | VO steps (failed) | Bridged m | End error m | Drift % | Heading drift ° | Per-pose heading vs attitude RMS / max ° | Onboard vs MMGIS m |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 5073 | 125_2274 → 2490 | 27.9 | 36/36 (0) | 0 | 0.241 | 0.86 | −0.98 | 0.58 / 1.09 | 0.153 |
  | 5070 | 125_2082 → 2274 | 28.7 | 31/32 (1: no end pair) | 0.90 | 0.199 | 0.69 | +0.29 | 0.19 / 0.38 | 0.264 |
  | 5069 | 125_1326 → 2082 | 101.3 | 125/125 (0) | 0 | 1.884 | 1.86 | −2.44 | 1.20 / 2.18 | 0.342 |
  | 5045 | 125_1194 → 1326 | 12.6 | 21/22 (1: 12 matches) | 1.19 | 0.099 | 0.79 | −0.76 | 0.50 / 0.74 | 0.004 |
  | 5041 | 125_558 → 1194 | 83.9 | 100/103 (3: 3 matches, RANSAC, no matches) | 1.14 | 0.566 | 0.68 | −0.88 | 0.80 / 1.39 | 0.413 |

  End error is horizontal; drift % = end error / MMGIS `dist_m`. 4 off-pointing pairs dropped on sol 5041. **Caveat: MMGIS drive ends are Curiosity's own localisation (onboard wheel + IMU + VO, ground-updated), not independent truth**; the onboard-vs-MMGIS column shows how close they are (0.0–0.4 m), so our VO error is close to that floor only on the short drives.
- **Stop rule (D16, deadline H8 = 17:00 CET): verdict plausible at 11:47 CET**, 5/5 drives pass (rule, assumed: ≥ `go_rule.min_drives` = 2 drives with drift ≤ 10 %, |heading drift| ≤ 10°, ≥ 80 % of steps by VO). X8 stays in.
- Curiosity-calibrated set (in `vo_report.json`, label "rover analogue: a rover is not an astronaut"): σ_s = 0.0064 (RMS along-track scale error, 5 drives), σ_b = 1.25 °/h of *rover driving* (RMS heading drift / drive duration); ψ₀ and slip are not measurable by VO → null, WS9 keeps its assumed values. Not yet handed to WS9 (brief: by H20; N to review first).

### Doing

- — (step 2 done; waiting for N's review of the drift table and the calibrated set)

### Next

- N reviews; then hand the calibrated set to WS9 (by H20). X9 only after G2, if green and N is free.

### Blocked

- VO constants are in `vo.py PENDING_VO_CONFIG` (all assumed: resolution, TRAV tag, pointing tolerance 5°, ratio 0.8, stereo reprojection 1 px, range 0.5–25 m, PnP 1.5 px / 2000 it / 0.999, min inliers 15, max step 3 m / 45°, plausibility 10 % / 10° / 0.8). WS9 owns `config/nav.yaml`: please add them as a `vo:` block with `assumed: true` (the code reads `nav.yaml vo` as soon as it exists). WS9 / C.
- N: confirm the stop-rule plausibility thresholds above (proposal) and whether σ_b per hour of rover driving is the right quantity for F21 (rover drives ~1 m/min; a walker ~1 m/s).

### Assumptions added

- Probe conventions (code, not config): a stereo pair = L and R with the same spacecraft clock, `subframe_rect` and `scale_factor`; API `sample_type: thumbnail` (64²) never counts; pairs at one (site, drive) are one pose; runs are counted within one resolution class; a step across a site change is unknown.
- Each drive's previous end is on an earlier sol, so only the end sol was queried; frames from intermediate sols would be missed (can only undercount).
- Caveat for step 2: 256² only (f ≈ 306 px); the mast looks right and down (az 90°, el −29°) on 4 drives and forward on sol 5070, so VO sees near-field ground.
- VO: a failed step or a missing drive-end pair is bridged with the onboard relative pose (reported as `bridged_m`, never hidden); at the start pose the last pair before driving is used, elsewhere the first pair at a pose.

## Backend (WS2 support, WS11–WS14), orchestrated — B1′ and B2′ met (02:45)  (updated 2026-11-15T01:50Z)
Source of truth: Notion decision log and the backend agent kit. Demo cut D69. Orchestrator state: /tmp/hl-orch/ on the build machine. Overnight (D71): Notion Overnight log.
Done:        setup S1–S9, S1b–S1e, S2b–S2d, S5b, T1 (contracts/backend v1.1.0; config; Makefile serve 127.0.0.1:8012, stack-up/down; server.yml; job timeout 600 s assumed); WS2 W1–W4; WS11 E1–E8, E10, E1b, E8b; WS12 O1, O3, O1b; WS13 U1–U4, U1b, U3b; SIM0 (docs/simulator-integration.md); H2 fallback drill (passes); H5 end-to-end check (docs/hardening/e2e-demo.md)
Doing:       E8c staged map arrival (partial index per stage, D81); hardening H1 load test, H3 privacy note (behind VITE_LIVE)
Next:        BACKEND DONE after hardening (D75), then watch mode
Blocked:     none
Assumptions: config/backend.yaml assumed: title/notes/message caps, ranges.start_lmst_h, ranges.reserve_min, limits.proxy_max_body_bytes, compute.job_timeout_s
Parity:      real-data make parity green on 9b8aebc (E8b): 29 passed, 98 files, 0 differ
Demo:        API `make serve` (127.0.0.1:8012, HL_SERVER_DATA=~/hl-data/server) + `cd web && VITE_LIVE=1 npm run dev` (localhost:5173); a custom pad takes about 6 min, a new crew about 6–8 min
Follow-up:   C rebuilds the Unity fixture (make bundle-fixture) before the deadline; the local bundle KAT is skipped until then

## Decision log (fresh run, recorded by C)

| Time (CET) | Item | Decision | By |
| --- | --- | --- | --- |
| 2026-11-14 11:00 | WS2 Q1–2 (IST-2 check, O₂ margin units) | Per docs/review/2026-11-14-ist2-and-o2-margin.md | S (via user) |
| 2026-11-14 11:15 | Canonical far-field bands | WS1's `terrain/ctx_20m.tif` + `mola_hrsc_200m.tif` (CTX levelled to MOLA); WS3 switches its path | C |
| 2026-11-14 11:24 | D3 Source mask origin | A: STAC footprint quads (SPEC §11) | User |
| 2026-11-14 11:24 | D16 X8 visual odometry | Go at 256² only; stop rule per SPEC §2.4 | User (for N) |
| 2026-11-14 11:24 | `pad_default` | Keep unchanged (drive-end centroids 74–265 m away, reported by WS1) | User |
| 2026-11-14 11:40 | Stations on blocked cells (S1 57°, S2 40°, S4 24° max slope) | **Access-cell rule**: keep each station's science coordinate; route to the nearest walkable cell within `access_radius_m` (50 m, assumed) and show both points plus the walk-in distance on the card; no snapping | User |
| 2026-11-14 11:42 | Isochrone display size (nom_104 2.7 MB gz vs 1.5 MB budget) | Display filter: drop holes < 100 m² (measured 1.19 MB gz); keep 1-min steps if within budget, else the 2-min fallback | C |
| 2026-11-14 11:42 | Station card producer | WS3 writes `horizon/public/cards/{S}.json` fragments (navcam, skyline error, panorama, landmarks); WS2 writes the timeline/margin part; `make web` (C) merges into `cards/{S}.json` | C |
| 2026-11-14 11:42 | Basemap | WebP q80, z13–18, 33.1 MB (`config/web.yaml`) | C |
| 2026-11-14 11:58 | F22 skyline fix presentation | Per SPEC §12 risk 15: report the result honestly (scratch trial: median 617 m, none within 100 m; the far-field skyline barely constrains position here) as a validation finding; the HUD/nav plan falls back to **station fixes**; no skyline fix is shown as a position fix unless a real frame passes the F22 KAT tolerance | C |
| 2026-11-14 11:58 | Frame↔station pairing for F22 | WS3 sets `station` in `navcam_frames.json` for each station's overlay frame | C |
| 2026-11-14 11:58 | Nav playback values provenance | Per-minute ellipse/r95/distance rows are covered by the Monte Carlo file's manifest entry (row-level keys not required); every static number keeps its own key | C |
| 2026-11-14 11:58 | Fix-interval summary sets | Keep contract v1.1 (one file, default set) for G1; an all-sets bump only if time after G1 | C |
| 2026-11-14 12:20 | WS2 Q10 web size | No further size cuts: keep 6 decimals (SPEC §6) and do not hole-filter the bands; every file < 50 MB (engine tree 79.5 MB raw / 12.1 MB gz) | C |
| 2026-11-14 12:20 | Way-home pointer field (WS7 proposal) | Accepted into `fields_index` v1.1.1: `fields/{sc}/pointer.png`, scale 1, units "move", own grid (per-entry bounds/width/height/res_m on WS2's 3 m grid) + `stencil`; optional properties | C |
| 2026-11-14 12:20 | Fields scope | Ship all scenarios of the contract table (≈ 37 MB with con_*; 28.4 MB now) | C |
| 2026-11-14 12:20 | HUD sun / time-to-dark | No `sun.json` contract: WS7 reads `conditions/clock.json eva.sun_series` and `eva.t_dark_min` (WS4) | C |
| 2026-11-14 12:20 | Station card nulls | `margin_binding: null` for a station with no route or no access cell (S1); the card still ships | C |
| 2026-11-14 12:35 | F20 at S2 (0.87° vs 0.5°) | WS3 uses the 1 m DEM out to the edge of its coverage before handing over to CTX (WS8 showed WS3's engine with dem_1m to 3.7 km agrees within 0.29° at S2). The 3D terrain is not lowered to CTX. WS3 session 3 implements; then re-run the F20 check | C |
| 2026-11-14 12:35 | F20 at S1 (0.54°) | S1 is not on the route (no access cell), so the camera never stands there: S1 is reported but excluded from the F20 pass rule; the pass rule covers the pad and route stations | C |
| 2026-11-14 12:35 | `make all` | Adds `fp3d` after `fields`; `config/fp3d.yaml` (all assumed) accepted for now, R to review | C |
| 2026-11-14 12:37 | V1 footprint | **3 m** (SPEC); 5 m reported as sensitivity. WS6 sets `config/validation.yaml v1.footprint_m: 3` | User (for S) |
| 2026-11-14 12:37 | G0 pad check reading | "Assessed" = cells with data (walkable or blocked), not unknown → passes at 100 %; blocked share (41.2 %) shown separately | User (for S/C) |
| 2026-11-14 12:37 | D7 sky detection | Automatic + manual check (SPEC default); the user reviews the 39-frame sheet in data/interim/horizon/validation/manual_check/; import with `python -m pipeline.validation.v2_skyline --import-manual <csv>` | User |
| 2026-11-14 12:42 | pages.yml review (WS5) | Approved by C: CI-gated, real-only, dist excludes data-dummy (verified), 150 MB dist; deploy blocked only on repo visibility/plan (user) | C |
| 2026-11-14 14:13 | Canonical CTX band | `terrain/ctx_20m_v2.tif` (each CTX item co-registered to dem_1m; v2 − dem_1m +0.16 m vs +19.79 m; better agreement with MOLA–HRSC in every ring). WS3 switches its CTX path; `ctx_20m.tif` kept for reference | C |
| 2026-11-14 14:19 | Odometry and position determination (WS10 X8/X9, WS9 F21/F22) | **Suspended softly → optional add-on** (SPEC §2.4, D19): no new jobs; merged work stays, labelled optional. Reasons: F22 median 657 m on 35 frames, S1/S2/S4 788/280/966 m, none passes the 10 m gate; F21 fix-interval median 50.7 m dominated by fragmented terrain, N's model review pending; X8 rover analogue only (256², MMGIS not independent, thresholds unconfirmed); X9 stretch. Core: F19 flat drift rule + uncertainty circle, fixes at the rover pad and surveyed stations only | User |
| 2026-11-14 14:22 | Partner haul case (F10) | **Cart only** (SPEC §11 D20); dragging is reported as a finding, not drawn as a line. With the config values dragging a suited crewmate always exceeds boot traction: drag force 179 kg × 3.71 × 0.6 ≈ 398 N vs traction limit 0.5 × 189 kg × 3.71 ≈ 351 N (maximum draggable mass ≈ 157 kg), so it is infeasible on every cell, even on flat ground. WS2 and WS5 implement | User |
| 2026-11-14 14:28 | HUD fields size | Accept 41.9 MB (pointer for every scenario, own 3 m grid; ≈ 56 MB with con_*); every file < 50 MB | C |
| 2026-11-14 14:58 | pad.json vs F8 siting proposal | `pad.json` describes the pad in use = `pad_default` (user 11:24). The F8 siting result is a **proposal** carried separately (siting files + an optional `proposal` block), never as the pad. WS2 fixes its writer; until then make web does not publish pad.json; WS3 keeps the pad_default horizon | C |
| 2026-11-14 15:01 | D7 sky detection (revised) | **No manual review.** Automatic detector only; near/mid V2 quoted (0.09° / 0.20°). Far class reported as "not validated: far rim hidden by haze in 21 north-facing frames" with WS3's evidence (counts and rim distances from `validation/v2.json far_note` keys, never typed: 17 of 21 match terrain within 2 km, rim 41.4–53.6 km as of WS3 session 4). The manual-check sheet stays available but is not required. Reason: localisation (F22) is an optional add-on (D19), so the far class carries no core claim | User |
| 2026-11-14 15:31 | pad.json release | Published again: WS2 session 5 writes pad = pad_default (in use) with the F8 result as `proposal` (adopted false). Finding for S: pad_default fails the F8 rule (score 0, no station within con 30 min) | C |
| 2026-11-14 15:35 | WS2 Q (α encoding, review C-note 1) | **Switch** α to the IST-2 weight-span encoding (span = gravity change 0.12→0.32 g on 121 + 80.7 kg ≈ 106.6 kg carried mass at Mars g, not `delta_mass_kg: 60`); WS2 implements, re-runs all scenarios and reports before/after | User (for S) |
| 2026-11-14 15:35 | `O2_station_tasks` reading | **Confirmed**: task O₂ still to do at the current station; 0 while walking | User (for S) |
| 2026-11-14 15:35 | O₂ energy conversion | **Use the review's** ICES-2026-127 conversion (≈ 5.02 kcal per L O₂ at RER 0.85) instead of 20.1 J/mL for the O₂ budget (primary ≈ 482 L instead of 504 L); WS2 implements | User (for S) |
| 2026-11-14 15:35 | Casualty mass | User delegated to C → **keep the `haul.yaml` rule** (body + suit: 155 / 179 / 195 kg; consistent with crew.yaml and already implemented); SPEC's 165–186 kg text aligned to it | C |
| 2026-11-14 16:14 | D21 official pad + pad picker | Official pad = most feasible EVAs (screening of all F8 candidate blocks + pad_default, top 5 exact-DP; tiebreaks reachable % then lower elevation); pad.json = winner, pad_default + F8 result as alternatives; all scenarios re-run on it; picker of next 3 (+ pad_default) at nominal 104 kg under scenarios/pads/{id}/ (SPEC §11 D21). Supersedes the 11:24 "keep pad_default" | User |
| 2026-11-14 16:17 | D21 picker file layout (C) | Per picker pad `scenarios/pads/{id}/`: `summary.json` (pad lon/lat/elev, rank, score = feasible-EVA count, tiebreak values, headline 30/60 min, route summary), `bands_104.geojson`, `edges.geojson`, `partner.geojson`, `route_nom_104.geojson`, `timeline_nom_104.json`; plus `scenarios/pads/index.json` (ranking table incl. the official pad, `dummy`); **no isochrones or fields for picker pads** (size); return-field rasters stay in data/interim only | C |
| 2026-11-14 16:16 | D22–D25 (+ D21 grid filter) | D22 3 m plane-fit cell slope + 30° step guard, max-slope grid = rough-footing overlay, cell states for 25/20/17°; D23 con no-go 17°; D24 reserve = 30 min × 1.35 L/min (derived, labelled EMU precedent); D25 flat-disc denominator = assessed cells within 1,764 / 3,528 m for all variants; D21 drops candidates whose 30-min disc leaves the DEM grid. ONE re-run: WS1 → WS2 → C downstream (SPEC §11) | User |
| 2026-11-14 16:20 | D26–D39 | Stations re-placed after D22 (+ up to 3 F7 stations, S3/S5 dropped unless S picks by 19:00), radius 50 m, turn-back incl. EVA duration, one o2_energy_j_per_ml = 21.0, IST-2 pass/miss in manifest, EVA start 09:00 LMST, spacing 300 m, hidden landmarks as bearing ticks, RAD E column/midpoints/± 8 min/lower-bound excess, REMS ground T dropped, fp3d.yaml accepted, shared storm-timing key + drift max(5 m, 2 %). Same single re-run (SPEC §11) | User |
| 16:28 | Deployment | GitHub Pages live at https://luxkaiwalker.github.io/home-line/ (private repo, owner has Pro). Earlier failures: Pages not yet configured (15:11 configure-pages 404) and a manual dispatch before CI finished (guard works). Deploys automatically after green CI on main | C |
| 16:36 | D35 tripwire label / D37 scope (C) | Tripwire uncertainty shown as the derived "± 9 min" (half of the 17.1 min median sample = 8.55 min, rounded up; user asked "± 8", one config line to change); REMS keeps air temperature and pressure only (UV dropped too, per the user's "air temperature and pressure only") | C |
| 17:20 | D38 fps | Human fps check of /hud3d passed (user: "works very nicely"); default quality preset kept | User |
| 2026-11-14 17:22 | D40–D47 | D40 Unity interface: planner formats only (JSON, LE float32 grids + JSON header, PNG/JPEG, zip bundles; pad-local metres x=E y=N z=up), C# port must pass physio/golden.json, plan/bundle contracts v1 frozen by ~20:00 + static official-pad bundle fixture (C); D41 60-min headline = in-data share 31.5 % (16.2–43.8), coverage 75.8 % labelled; D42 S3/S5 dropped unless S picks by 19:00; D43 route DP + EVA counts use modelled O₂ along the route (reserve kept); D44 official pad rank1 frozen, recount reported for picker pads; D45 conservative result shown as is; D46 direction suffix for same-name stations; D47 placement assumptions accepted (assumed) | User |
| 17:25 | HUD fields after D21 | Accept 58.8 MB (pointer + con_*; every file < 50 MB); T_home at the official pad samples to 0.1 min on the 5 m grid (pad not on a pixel corner) — kept as sampled, tests use the ±0.5 min tolerance | C |
| 17:34 | §11 conflict D40–D47 | Two sets were logged; the user chose **set A (17:16–17:28)**: D40 backend allowed (defaults FastAPI/VM/Supabase; server owner open), D41 Unity handover (plan/bundle contracts v1 by 20:00 + official-pad fixture + physio/golden.json), D42 official pad rank1 frozen (ranks 2–3 + pad_default in picker), D43 60-min in-data share 31.5 % (16.2–43.8) with 75.8 % coverage label, D44 stations final S1/S2/S4/S6/S7/S8 + compass suffix from the pad bearing, D45 keep the effort-cap O₂ planning rule + excluded-combination count, D46/D47 accepted. Set B (17:22) marked superseded. Backend: contracts + fixture tonight, code after G2 | User |
| 19:37 | Publish | Web data on the official pad with D21–D47 published (3,061 files, 252 MB, 2,747 keys, 0 dirty); WS9 nav re-run on the new route (plain re-run, D19 add-on); WS8 sun KAT fixed by C (sun longitude after WS4's move) | C |

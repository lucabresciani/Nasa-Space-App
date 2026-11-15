# Web app architecture (as built on `main`)

Readiness items R2 (repo map) and R6 (MapLibre capability check) of the design block (kit.md).
Describes the real code in `web/` at `main` = `e580f65` (2026-11-14). Paths in DESIGN §5.3 are the
*planned* layout; this file is what exists. Facts were read from the source and from
`web/node_modules` after `npm ci`; nothing here is from memory.

**Since then (design branch, R1):** the first-person 3D view (`/hud3d`, `web/src/fp3d/`) was removed
by D99 and the `/nav` add-on view by D98. The sections below keep the snapshot and say at each place
what is gone. The 3D *map* (MapLibre terrain, 2D/3D toggle, flythrough) is a different thing and stays.

## 1. Versions (installed, `web/node_modules/*/package.json`, lockfile `web/package-lock.json`)

| Package | Range in `web/package.json` | Installed | Kind |
| --- | --- | --- | --- |
| `maplibre-gl` | `^6.18.0` | **6.18.0** | runtime |
| `@maplibre/maplibre-gl-style-spec` | (dep of maplibre-gl) | 26.7.0 | runtime (types for style JSON) |
| `preact` | `^11.2.0` | **11.2.0** | runtime (`preact` + `preact/hooks`; JSX via `jsxImportSource: preact`) |
| `vite` | `^8.3.6` | 8.3.8 | dev |
| `vitest` | `^5.1.0` | 5.1.0 | dev |
| `typescript` | `~7.0.2` | 7.0.2 | dev |
| `yaml` | `^2.9.1` | 2.9.1 | dev (build-time YAML parsing only) |
| `@types/geojson`, `@types/node` | | | dev |

`three` and `@types/three` (0.187.0) were removed in R1c: since D99 nothing imports them; they
were only in the lazy `/hud3d` chunk.

**No signals or store library.** `@preact/signals` is not installed; no zustand / nanostores /
redux / mobx / jotai. State today (see §4.5) is Preact `useState` inside views, plain module-level
singletons (`prov/store.ts`, `data/loader.ts` cache) and class instances (`hud/clock.ts`
`PlaybackClock`). DESIGN §5.2 therefore means the ≈ 50-line hand-written signal store.
No Playwright, no icon set, no fonts are installed yet (body font is `system-ui`).

## 2. Entry, shell, routes

- `web/index.html` → `<div id="app">` + `src/main.ts`.
- `src/main.ts`: imports `style.css`; builds the shell DOM (`header.topbar` with `a.brand` and
  `nav.topnav` from `NAV_ITEMS`, `div.dummy-banner`, `main.outlet`); sets `body.is-dummy`,
  `body.is-dev`, `body[data-route]`, `.outlet[data-route]`. In dev it adds the
  "N numbers without manifest entry" badge (`prov/store.ts` `onUnbackedChange`).
  `render()` runs on every `hashchange`: calls the previous view's cleanup, `clearUnbacked()`,
  empties `.outlet`, awaits `VIEWS[route.name]()` (dynamic import), then `view(outlet, route)`;
  a sequence counter (`renderSeq`) drops stale renders. Errors render `div.page.error`.
- `src/router.ts`: hash router. `parseRoute(hash)` → `Route`, `href(route)` → hash, `NAV_ITEMS`
  (display order). A `?query` inside the hash is parsed (`URLSearchParams`), used only by
  `/scorecard?key=`. **No `?legacy=` handling exists yet** (DESIGN "migrated views keep
  `?legacy=view`" is new work).

| Hash | `Route.name` | View module (lazy) | Mount style |
| --- | --- | --- | --- |
| `#/` | `console` | `views/console.tsx` | custom `View`: MapLibre `ConsoleMap` + Preact `ConsolePanel` |
| `#/station/:id` | `station` | `views/station.tsx` | `preactView` |
| `#/trade` | `trade` | `views/trade.tsx` | `preactView` |
| `#/conditions` | `conditions` | `views/conditions.tsx` | `preactView` |
| `#/scorecard[?key=K]` | `scorecard` | `views/scorecard.tsx` | `preactView` (scrolls to manifest key K) |
| `#/cuff` | `cuff` | `views/cuff.tsx` | `preactView` |
| `#/about` | `about` | `views/about.tsx` | `preactView` |
| `#/hud` | `hud` | slot → `hud/index.ts` `mount` | slot (WS7) |
| `#/hud3d` | `hud3d` | slot → `fp3d/index.ts` `mount` | slot (WS8) |
| `#/nav` | `nav` | slot → `nav/index.ts` `mount` | slot (WS9, optional add-on banner, D19) |
| anything else | `notfound` | inline in `views/index.ts` | |

**Removed views (D98, D99).** The `hud3d` and `nav` routes no longer exist. `router.ts`
`REMOVED_PATHS` maps the old paths to a live view and the shell redirects: `#/hud3d` and `#/fly/3d`
go to `#/fly/hud`; `#/nav` and `#/evidence/nav` go to `#/evidence/scorecard` (`?legacy` is kept).
`views/slot.ts` now globs only `hud/`, and `state/ui.ts` `ROUTE_MODE` has no `hud3d`/`nav` keys.

**View contract** (`views/types.ts`): `type View = (el, route) => void | cleanup | Promise<…>`.
`views/page.tsx` `preactView(make)` awaits `ensureManifest()` then `render(make(route), host)`;
cleanup is `render(null, host)`. `views/slot.ts` `slotView(name)`: `import.meta.glob` of
`../{hud,fp3d,nav}/index.ts(x)`; the module exports `mount(el, ctx: ViewContext)` returning an
optional cleanup; `ctx = { dataUrl, dataMode, params: {} }`. Until a module exists a placeholder
shows.

## 3. Module map (`web/src/`)

Top level

| File | Role |
| --- | --- |
| `main.ts` | entry, shell DOM, hash render loop, dev provenance badge |
| `router.ts` | `Route` union, `parseRoute`, `href`, `NAV_ITEMS` |
| `env.ts` | `DATA_MODE` (`VITE_DATA=dummy` → `data-dummy/`), `dataDir`, `dataUrl(path, mode, base?)`, `IS_DEV` (owned by WS13 now; do not edit) |
| `config.ts` | build-time import of `config/*.yaml` (site, crew, variants, hud, haul, conditions, stations, horizon, event, nav); `cfg()`/`cfgOpt()` dotted lookup that throws on a missing key; `CONFIG` (typed constants) and `CITED` (value + `source` string for on-screen config numbers) |
| `theme.ts` | `THEME`: presentation constants for the console map (colours, opacities, line widths, iso ramp, hatch pattern, label limits). No science values |
| `style.css` | global CSS: `:root` custom properties + shell, console, page, table, num, legend classes |
| `vite-env.d.ts` | `*.yaml` module typing |

Folders

| Folder | Files and role |
| --- | --- |
| `views/` | `index.ts` route→lazy loader map; `types.ts` `View`; `page.tsx` `useLoad`, `Show`, `preactView`, `Page`; `common.ts` `ensureManifest()`; `slot.ts` mount slots; pages `console.tsx` (1,102 lines: map + side panel, scenario picker, budget slider, layer toggles, D21 pad options), `station.tsx`, `trade.tsx`, `conditions.tsx`, `scorecard.tsx` (862), `cuff.tsx`, `about.tsx`; helpers `decisions.ts` (D21–D47 labels), `route.ts` (route summary from route legs), `leash.ts` (dose leash), `o2.ts`, `f22.ts`, `validation.ts` |
| `map/` | `consoleMap.ts` `ConsoleMap` class (MapLibre map of `/`, layer groups, visibility, markers); `basemap.ts` (tilejson → raster source); `hatch.ts` (alpha mask → hatched data-URL image); `labels.ts` (edge-cause label placement); `legend.ts` (iso bins, step colour expression); `pad.ts` (pad marker / F8 info); `scale.ts` `MarsScaleControl` (Mars-metre scale bar, D4); `slider.ts` (budget slider stops) |
| `components/` | `Num.tsx` (`Num`, `CfgNum`, `DerivedNum`), `labels.tsx` (Simulated / assumed / real-modelled-simulated tags, `DataProblem`, `DummyNote`), `Loose.tsx` (key/value table for loose contracts), `DragNote.tsx` (D20), `PadInUse.tsx`, `DecisionNotes.tsx` |
| `data/` | `loader.ts` the one loader; `contracts.ts` path→schema table (mirrors `tools/validate_contracts.py` `SCHEMA_MAP`); `schema.ts` minimal JSON-Schema checker; `types.ts` file shapes; `fields.ts` (`unknownMaskField`), `access.ts` (station access cell), `pads.ts` (D21 pad options), `partner.ts` (D20) |
| `prov/` | `provenance.ts` (`resolveProvenance`, `normFile`, `formatValue`); `store.ts` (manifest singleton + unbacked-number registry) |
| `chart/` | `scale.ts` minimal SVG scales/polylines (null = gap). No chart library |
| `hud/` (WS7) | `index.ts` slot `mount` + public API re-exports (reused by fp3d); `hud.ts` `mountHud`/`loadHudData` (rAF loop); `clock.ts` `PlaybackClock`; `plan.ts` plan(t) from route + timeline; `readout.ts` `computeReadout` (margin etc.); `alarms.ts`; `panel.ts` helmet DOM panel; `map.ts` **Canvas 2D** minimap (not MapLibre); `fields.ts` field PNG decoder; `drift.ts` F19 circle; `storm.ts` D39 storm replay; `sun.ts`; `wayhome.ts` pointer field; `navhud.ts`; `provenance.ts` panel row sources; `config.ts` (`parseHudConfig` from hud/crew/conditions YAML); `types.ts`; `hud.css` |
| `fp3d/` (WS8) | `index.ts` slot `mount` (checks WebGL2 via `fallback.ts`, then `await import('./view')` = Three.js); `view.ts` Three.js scene (580 lines); pure modules `terrain.ts`, `format.ts` (fp3d index + `.f32.gz` chunks), `path.ts` (camera on rails), `ring.ts` (horizon ring), `skyline.ts`, `sun.ts`, `look.ts` (sky/haze shaders), `geo.ts` (eqc from PROJ string), `fps.ts`, `config.ts`, `hudOverlay.ts` (lazy, reuses WS7 panel); `check/*.mjs` headless-Chromium probes (CDP, no npm dep) |
| `nav/` (WS9, optional) | `index.ts` slot; `page.tsx`; `navmap.ts` (MapLibre); `chart.tsx`; `load.ts`, `series.ts`, `navstate.ts`, `fixclass.ts` (RG PNG decode), `geom.ts`, `config.ts`, `theme.ts`, `types.ts`, `nav.css` |
| `fp3d/`, `nav/` since D98/D99 | `fp3d/` is deleted except `testdata/skyline_check.dummy.json` (pytest `test_fp3d_export.py` checks it; the fp3d *data* export in `pipeline/export/` and `make fp3d` stay). `nav/` keeps only the pure modules the 2D HUD imports: `config.ts`, `load.ts`, `types.ts`, `geom.ts`, `series.ts`, `navstate.ts` (and their tests); the page, map, chart, theme, CSS and `fixclass.ts` are gone |
| `live/` (WS13, do not edit) | `client.ts` typed API client, `health.ts`, `jobs.ts`, `result.ts` (live result = `createLoader(browserFetcher(mode, base))`), `config.ts` (`VITE_LIVE`, `VITE_API_BASE`, `VITE_LIVE_MOCK`), `mock/`, `live.css`. **Not yet wired into `main.ts`** (only a commented `import('./live')` line in `live/index.ts`) |

Not present yet: `src/ui/` (tokens.css/tokens.json), `src/state/`, `src/edit/`, `src/story/`,
`src/report/`, `map/field/`, `map/style.ts`, `map/camera.ts`, `public/story/`.

## 4. How things are wired

### 4.1 Data loader (`data/loader.ts`, `env.ts`)

- Data trees: `web/public/data/` (real, written by `make web`) and `web/public/data-dummy/`.
  `DATA_MODE` = `'dummy'` iff `VITE_DATA=dummy` (`npm run dev:dummy`, `build:dummy`); the Vite
  plugin `pruneDataDirs` deletes the unused tree from `dist/`.
- `dataUrl(path, mode?, base?)` = `${import.meta.env.BASE_URL}${data|data-dummy}/${path}`; with
  `base` (a live result root) = `${base}/${path}`. `BASE_URL` is `./` (vite `base: './'`).
- `createLoader(fetchText, mode)` returns typed getters (`scenarios()`, `bands(s)`, `isochrones(s)`,
  `edges(s)`, `partner(s)`, `stations()`, `card(st)`, `route(sc)`, `timeline(sc)`, `trade()`,
  `pad()`, `rad()`, `rems()`, `clock()`, `donki()`, `manifest()`, `fieldsIndex()`, `v1()`, `v2()`,
  `cellstate()`, `tilejson()`, `geojson(path)`, … and `optional(fn)` (missing → `null`).
  `json(path)`: per-path promise cache; looks up the schema (`data/contracts.ts` `schemaFor`),
  refuses paths without a contract (`DataError 'no-contract'`), parses, validates
  (`schema.ts` `checkSchema`), refuses `dummy: true` in real mode. Vite's `index.html` 404
  fallback is detected and treated as missing. `data()` is the app-wide singleton.
- **Images are not loaded by the loader**: PNG fields, panoramas, tiles are referenced by URL
  (`dataUrl(...)`) and fetched by the consumer.
- A view gets a number: `const s = await data().stations()` → read `s[i].t_home_min.nom_104` →
  render `<Num v={…} file="stations.json" k="optional.manifest.key" units="min" />`.
  The HUD and fp3d do not use `data()`; they fetch through `ctx.dataUrl` with their own `getJson`
  (`hud/hud.ts`) and local types (`hud/types.ts`).

### 4.2 Number + provenance (`components/Num.tsx`, `prov/`)

- `views/common.ts` `ensureManifest()` loads `manifest.json` once (`data().manifest()`), stores it
  with `prov/store.ts` `setManifest`. Every `preactView` and the console await it before rendering.
- `<Num v file k? units? dp? signed? fmt? boolText?>` → `prov/store.ts` `lookup({key, file, value})`
  → `prov/provenance.ts` `resolveProvenance(manifest, q)`: (1) by key if the manifest has it
  (value must match → `ok`, else `mismatch`); (2) else by normalised file + equal value
  (`matched`); else `missing`/`no-manifest`. Backed → `<a class="num num-ok" href="#/scorecard?key=…"
  title="manifest/file/script/commit/utc">`; unbacked → `<span class="num num-unbacked">` and the
  dev badge counts it; `null` → `num-unknown`. Text via `formatValue(v, units, {dp, signed})`
  (unit labels km², µGy/day, °…). `CfgNum` (config value, `title="from config/…"`) and
  `DerivedNum` (browser-computed, `num-derived`) for non-manifest numbers.
- HUD rows use `hud/provenance.ts` `readoutSources()` (field lookups backed by
  `fields.<key>.sha256` manifest keys), not `<Num>`.

### 4.3 HUD (`hud/`, WS7)

`/hud` → `slot.ts` → `hud/index.ts` `mount(el, ctx)` → `mountHud(el, {dataUrl, config:
parseHudConfig(hud.yaml, crew.yaml, conditions.yaml)})`. `loadHudData()` fetches
`scenarios/index.json` (scenario = `scenarios.default` unless `opts.scenario`), route, timeline,
stations, pad, `fields/index.json`, the `t_home`/`o2_home` PNGs (decoded by `hud/fields.ts`),
pointer, cellstate, rad/clock. A `requestAnimationFrame` loop (`hud.ts` ~l.393) ticks the
`PlaybackClock`, computes `playbackPosition` → `computeReadout(pos, ctx)` → `panel.update(...)` and
redraws the Canvas 2D minimap (`hud/map.ts`). fp3d reuses the same exports
(`loadHudData`, `computeReadout`, `createHudPanel`, `PlaybackClock`) in `fp3d/hudOverlay.ts`.

**Since D99** `fp3d/hudOverlay.ts` is gone and the 2D HUD is the only consumer of these exports. The
position-uncertain alarm (alarm 3) lives in the HUD: `hud/alarms.ts` (alarm texts and
`evaluateAlarm`, F19 circle variant "POSITION UNCERTAIN: HEAD TOWARD ROVER"), `hud/drift.ts` (the F19
drift circle) and `hud/navhud.ts` (optional F21 ellipse variant, `NAV_ALARM3_TEXT`), which uses the
pure helpers kept in `nav/` (`geom.ts`, `navstate.ts`, `series.ts`, `types.ts`; `hud.ts` loads them
through `nav/load.ts` and `nav/config.ts`).

### 4.4 Clock, playback, current plan

- Clock: `hud/clock.ts` `PlaybackClock { t (EVA min), speed, playing, speeds, tMax }` with
  `play/pause/toggle/setSpeed/seek/tick(dtMs)`; speeds and default from `config/hud.yaml`
  (`playback_speeds [1,30,60,300]`, `default_speed 60`). One instance per mounted HUD / 3D view;
  `/nav` has its own playback in `nav/page.tsx`. Nothing is shared between routes. (Since D98/D99 the
  3D view and `nav/page.tsx` are gone; the HUD is the only `PlaybackClock` user here.)
- Current plan: **no global**. The console holds `scenarioId`, `budget`, `visible`, pad selection
  etc. in `useState` inside `ConsolePanel` (`views/console.tsx` l.67–86); the HUD picks
  `scenarios/index.json` `default`. Switching routes loses the console's choices (no URL state
  besides the route). The margin is computed only in `hud/readout.ts`:
  `H(t) = timeline margin_min + t_home_min` (interpolated), `margin = H(t) − T_home(position)`,
  band from `alarms.ts` `marginBand(margin, margin_amber_min=10)`.

### 4.5 Colours and theme

- `style.css` `:root`: `--bg #15110f`, `--panel #211a17`, `--panel-2 #2b221e`, `--ink #f1e7e1`,
  `--muted #b3a39a`, `--line #4a3b34`, `--accent #e8925a`, `--warn #e9b949`, `--bad #e5604d`,
  `--ok #7cc48a`; `color-scheme: dark`; font `system-ui`, 14 px. style.css still has 59
  literal hex values besides 77 `var(--…)` uses; `hud/hud.css` 13 hex / 43 vars (monospace
  helmet look); `nav/nav.css` 4 hex.
- Map colours are JS constants, not CSS: `theme.ts` `THEME` (variant colours
  optimistic `#f5c58f` / nominal `#ef8a4c` / conservative `#a8431f`, cause colours, iso ramp,
  route, station, pad, hatch), `nav/theme.ts`, `hud/map.ts` `BAND_RGB` (green/amber/red/unknown).
  There is no `tokens.json`; U0 must route these four places through tokens.

### 4.6 Lazy loading and 3D

- Every route module is a dynamic `import()` (`views/index.ts`), so MapLibre loads only with
  `/` (console) and `/nav`; the worker is set with `setWorkerUrl(workerUrl)` from
  `maplibre-gl/dist/maplibre-gl-worker.mjs?url` (`map/consoleMap.ts`).
- Three.js: `fp3d/index.ts` checks `hasWebGL2()` (`fp3d/fallback.ts`, no Three.js) and only then
  `await import('./view')`; `hudOverlay` is a second dynamic import. Low fps or no WebGL2 →
  2D HUD fallback.
- **Since D99** there is no Three.js code path: `fp3d/` is deleted, the Three.js chunk is no longer
  built, and `tests/perf/lazy.spec.ts` checks that no route loads fp3d or Three.js. Since D98
  MapLibre is loaded by the map views only (no `/nav` map).
- `src/live/` is never imported by the shell today.

## 5. Console map (`map/consoleMap.ts`) as built

- `new maplibregl.Map({ style: blankStyle(), bounds: CONFIG.aoiFocus, maxPitch: 0,
  dragRotate: false, renderWorldCopies: false, attributionControl: false,
  canvasContextAttributes: { preserveDrawingBuffer: true } })`, rotation disabled, default
  (Mercator) projection. **U1 must lift `maxPitch: 0` / `dragRotate: false`.**
- Offline style: no glyphs, no sprite, no remote source. Text labels are HTML `Marker`s
  (`map/labels.ts`), so **no symbol layers / no glyphs exist yet** — U13 label pills need a glyph
  source (self-hosted PBF glyphs) or keep HTML markers.
- Sources: geojson `bands, iso, edges, partner, route, walkin, access`; raster `basemap`
  (`tiles/basemap/{z}/{x}/{y}.webp`, z13–18, 256 px, from `tilejson.json`); image sources
  `unknown` (hatch data-URL on the cellstate/field bounds) and `siting` (F8 PNG). Layers: `background`,
  `iso-fill`, `band-opt`, `band-con`, `iso-lines`, `iso-current`, `band-lines`, `edges-line`,
  `route-line`, `partner-line`, `walkin-line`, `access-pts`, `unknown-hatch`, `siting-img`, basemap; grouped in `GROUP_LAYERS`.
- D4: Mars lon/lat are passed to MapLibre as if Earth lon/lat. `map/scale.ts` corrects the scale
  bar by `R_mars` (`config/site.yaml crs.mars_radius_m = 3396190`).

## 6. MapLibre 6.18.0 capability check (R6)

Verified in `web/node_modules/maplibre-gl/dist/maplibre-gl.d.ts` (18,398 lines) and
`@maplibre/maplibre-gl-style-spec/dist/index.d.ts` (26.7.0).

| Feature | Available | API | Gap / note |
| --- | --- | --- | --- |
| Canvas source, updated per frame | yes | source `{type:'canvas', canvas, coordinates, animate}` (`CanvasSourceSpecification`); `CanvasSource.play()/pause()/getCanvas()` | With `animate: true` the canvas is re-uploaded every frame (cost); for the field use a custom layer instead. Fine for a 2D-canvas overlay |
| Custom layer with WebGL2 | yes | `CustomLayerInterface {id, type:'custom', renderingMode?: '2d'\|'3d', onAdd(map, gl: WebGL2RenderingContext), render(gl, options: CustomRenderMethodInput), prerender?, onRemove}`; `options` has `modelViewProjectionMatrix`, `projectionMatrix`, `shaderData {variantName, …}` (projection-specific shader prelude), `defaultProjectionData` | Map context is WebGL2 only. Shader must use MapLibre's projection prelude (`shaderData`) to work under globe/custom projection; Mercator-only shaders can use `modelViewProjectionMatrix` with `MercatorCoordinate` |
| Custom layer draped on terrain | yes, **experimental** | `CustomLayerInterface.renderToTerrainTile?(gl, CustomTerrainRenderInput)` + `terrainTileRevision?: number` (bump to redraw tiles) | Lets the U2 field shader drape on 3D terrain (U1) without own terrain math. Experimental: RR must check |
| raster-dem terrain + exaggeration | yes | source `{type:'raster-dem', tiles\|url, tileSize, encoding}`; `map.setTerrain({source, exaggeration})`, `getTerrain()`, `queryTerrainElevation(lngLat)`; style `terrain` | Needs `maxPitch > 0` in `ConsoleMap` |
| Terrarium encoding | yes | `encoding: 'terrarium' \| 'mapbox' \| 'custom'`; custom has `redFactor`, `greenFactor`, `blueFactor`, `baseShift` | Terrarium = `R*256 + G + B/256 − 32768` m |
| Hillshade layer | yes | `type:'hillshade'`, paint `hillshade-method` (`standard`, `basic`, `combined`, `igor`, `multidirectional`), `hillshade-illumination-direction` / `-altitude` / `-anchor`, `hillshade-exaggeration`, `-shadow-color`, `-highlight-color`, `-accent-color` | |
| Color-relief layer | yes | `type:'color-relief'`, paint `color-relief-color` (expression on `["elevation"]`), `color-relief-opacity` | Needs a raster-dem source |
| Stretchable images (label pills) | yes | `map.addImage(id, image, {pixelRatio, sdf, stretchX, stretchY, content, textFitWidth, textFitHeight})`, `updateImage`; layout `icon-text-fit` | Needs symbol layers → needs a `glyphs` URL (self-hosted) in the style; none today |
| Globe / non-Mercator | yes | `projection: {type: 'mercator' \| 'globe' \| 'vertical-perspective'}`, `map.setProjection()`; **experimental** `addProjection(crs: CRS)` for a custom planar CRS with its own `tileMatrixSet` | See D4 caveats below |

**D4 caveats (Mars lon/lat in an Earth map).** MapLibre's Earth radius is 6,371,008.8 m
(`earthRadius` in `maplibre-gl-dev.mjs`); Mars is 3,396,190 m. Horizontal ground metres are thus
drawn ×1.876 too large while raster-dem heights are in true metres, so terrain at
`exaggeration: 1` looks **flattened by 0.533**. True shape needs
`exaggeration = 6371008.8 / 3396190 ≈ 1.876` (× any design exaggeration), or a custom encoding that
pre-scales heights (then `queryTerrainElevation` returns scaled metres; divide back). Hillshade
slopes are flattened the same way. Mercator distortion at lat −4.8° is < 0.4 %, so Mercator is
fine for the site; `globe` would render an Earth-sized sphere (wrong curvature for an intro
zoom-out unless the effect is only visual). `addProjection` (eqc on the Mars sphere) is possible
but experimental and would require re-cutting every tile source into its tile matrix set; not
recommended. Elevation tiles must be cut in Web-Mercator XYZ of the (Mars) lon/lat, like the
basemap tiles.

**Conclusion R6: no upgrade needed (M0 not required).** Everything U1, U2 and U13 need is in the
installed 6.18.0. Gaps are app-side: unlock pitch/rotation, add a raster-dem source and terrain
tiles, add self-hosted glyphs for symbol labels, apply the ×1.876 Mars exaggeration factor.

## 7. Landmarks (R10)

- `config/landmarks.yaml` holds **names only** ("never type coordinates by hand") plus the rule.
- Verified coordinates come from the IAU gazetteer CSV `data/raw/discovery/iau_mars.csv`
  (`config/horizon.yaml landmarks_source: {csv, max_dist_km: 80, approval: "Adopted by IAU"}`;
  git-ignored, present in `~/hl-data/raw/discovery/`). `pipeline/horizon/cards.py`
  `load_iau_landmarks()` reads `center_lon/center_lat` (0–360 → ±180). `docs/discovery.md` §3.5
  tables the 8 official names within 80 km (Gediz Vallis … Dulce Vallis); informal names
  (Boxwork, Vera Rubin Ridge, Greenheugh) are **not verified** and drop.
- Published today: `web/public/data/cards/{S}.json` `landmarks[]` = `{name, bearing_deg, dist_km,
  kind, above_skyline, display}` per station (manifest keys `landmark.{S}.{Name}.bearing_deg|dist_km`).
  **No published file carries landmark lon/lat.** Station lon/lat: `stations.json`; pad:
  `pad.json`. U13 needs the planned `labels.json` export (DESIGN §6.2) from
  `pipeline/export/labels.py` reading the same IAU CSV via `load_iau_landmarks`.

## 8. Field data for the shader (U2)

- `web/public/data/fields/index.json` (contract `contracts/fields_index.schema.json` v1.1.1):
  top-level grid `bounds [137.319359, −4.868421, 137.444641, −4.743579]` ([w,s,e,n], outer pixel
  edges, lon/lat), `width = height = 1480`, `res_m 5`; `fields.{key}: {file, scale, units,
  scenario, [bounds,width,height,res_m,stencil,radius_m_effective]}`.
- Keys: `{opt,nom,con}_{80,104,120}/t_home` (scale 0.1 min), `…/o2_home` (0.01 L),
  `…/pointer` (own 3 m grid 2468², scale 1 "move", stencil), `nom_104/home_bearing` (0.01°),
  `nom_104/{t_home,o2_home}_worst_{10,50,100}`, `slope` (shared, 0.01°),
  `fix_interval_{low,medium,high}` (1 m). Files under `fields/{scenario}/`, `fields/shared/`.
  57 MB total.
- **Encoding** (`contracts/README.md` "Field PNGs", `config/hud.yaml field_png/field_scales`):
  8-bit RGBA PNG, `counts = R·256 + G`, `B = 0`, `A = 255` valid / `A = 0` unknown,
  value = counts × scale; rows north→south. Reference decoder: `hud/fields.ts` `decodeRGBA` +
  `loadFieldRGBA` (`createImageBitmap(blob, {premultiplyAlpha:'none', colorSpaceConversion:'none'})`).
  For a GPU texture: `UNPACK_PREMULTIPLY_ALPHA_WEBGL=false`, `UNPACK_COLORSPACE_CONVERSION_WEBGL=NONE`,
  `NEAREST` filtering (never interpolate across A = 0 or between counts' high/low bytes),
  in GLSL `counts = floor(r*255.0+0.5)*256.0 + floor(g*255.0+0.5)` (exact in highp float).
- Cell state: `terrain/cellstate.png` + `.json` (and `_conservative`), **3 m grid 2468²**, bounds
  `[137.319325, −4.868455, 137.444675, −4.743545]` (differs from the 5 m field grid), same
  RGBA encoding, codes `0 assessed, 1 blocked`, `A = 0` unknown (state 2).
- Bands: `scenarios/bands_{80,104,120}.geojson` (`contracts/bands.schema.json` v1.0.0): Polygon /
  MultiPolygon, properties `{budget: 30|60, variant}`. Per-scenario `scenarios/{id}/`
  holds isochrones, edges, partner (paths in `scenarios/index.json` `files`).
- Margin: no margin raster is published. Inputs: timeline `margin_min` + `t_home_min` per event
  (`timeline_{scenario}.json`), the `t_home` field, `config/hud.yaml margin_amber_min: 10`;
  formula in `hud/readout.ts` (§4.4). Test vectors for any port: `physio/golden.json` (D41).

## 9. Tests, CI, build

- `npm test` = `vitest run`; config in `web/vite.config.ts` (`test.include src/**/*.test.ts(x)`,
  `environment: 'node'`, no jsdom). 49 test files, colocated (`*.test.ts` next to the module).
  Local run on this branch: **48 files passed, 1 skipped; 583 tests passed, 13 skipped (3.6 s)**.
  fp3d browser checks (`fp3d/check/*.mjs`) are manual, not in CI. (Removed with `fp3d/` by D99,
  together with the `make fp3d-check` target that ran them.)
- `npm run build` = `tsc && vite build`; `typecheck` = `tsc --noEmit`. Vite plugins:
  `homeline-yaml` (YAML → JSON module at build time), `homeline-prune-data`;
  `server.fs.allow ['..']` (config/ and contracts/ one level up); `chunkSizeWarningLimit 1200`.
- `.github/workflows/ci.yml` (PR + push main): job `python` (uv sync, ruff, pytest,
  `tools/validate_contracts.py`, `pipeline.provenance.check_h0`); job `web` (node 24, `npm ci`,
  `tsc --noEmit`, `npm test`, `vite build`); job `checks` (no `"dummy": true` in
  `web/public/data`, no tracked file > 50 MB). No screenshot / Playwright job, no value-snapshot
  job yet.
- `.github/workflows/pages.yml`: after a successful `ci` on a push to main (or manual dispatch with
  a green `ci` on that SHA): `VITE_DATA=real` fixed, validate contracts, `npm ci`, typecheck,
  tests, `npx vite build`, checks no `data-dummy/` and no dummy flag in `dist/data`, **app size
  without data < 5 MB (5,120 KiB)**, upload `web/dist`. Base path: vite `base: './'` (relative) +
  hash routing, so no repo-name base is configured; it works under any Pages project path.
- `.github/workflows/server.yml`: backend only (not the static site).

### Production build sizes (`flock /tmp/hl-heavy.lock npm run build`, real data)

vite 8.3.8, 149 modules, built in 1.68 s. `dist/` without data: **2,604 KiB** (Pages limit 5,120).
Sizes raw / gzip (kB):

| Chunk | Raw | Gzip | Loaded by |
| --- | --- | --- | --- |
| `index.html` | 0.39 | 0.27 | always |
| `index-*.js` (shell: main, router, env, prov store) | 10.45 | 4.36 | always |
| `index-*.css` (`style.css`) | 12.75 | 3.74 | always |
| `consoleMap-*.js` (MapLibre + `map/`) | 1,091.18 | 298.44 | `/`, `/nav` |
| `consoleMap-*.css` (`maplibre-gl.css`) | 71.33 | 10.25 | `/`, `/nav` |
| `maplibre-gl-worker-*.mjs` | 519.54 | (not reported) | `/`, `/nav` (worker) |
| `view-*.js` (Three.js scene, `fp3d/view.ts`) | 558.86 | 142.21 | `/hud3d` after the WebGL2 check |
| `fp3d-*.js` (`fp3d/index.ts`, pure modules) | 6.46 | 2.84 | `/hud3d` |
| `hudOverlay-*.js` | 1.90 | 1.09 | `/hud3d` |
| `loader-*.js` (loader + schemas) | 84.85 | 23.07 | every data view |
| `hud-*.js` / `hud-*.css` | 42.69 / 5.69 | 16.06 / 1.77 | `/hud`, `/hud3d` |
| `console-*.js` | 32.30 | 10.77 | `/` |
| `scorecard-*.js` | 25.78 | 7.99 | `/scorecard` |
| `nav-*.js` / `nav-*.css` | 20.84 / 1.29 | 8.19 / 0.62 | `/nav` |
| `common-*.js` (Preact + shared view helpers) | 15.57 | 6.56 | Preact views |
| `station-*.js`, `conditions-*.js`, `crew-*.js` (config YAML) | 12.81, 12.30, 11.81 | 4.22, 4.28, 5.46 | per route |
| others (`trade`, `cuff`, `about`, `decisions`, `DecisionNotes`, `load`, `validation`, small helpers) | 0.6–6.1 each | 0.3–2.6 each | per route |

Since D98/D99 the `view-*`, `fp3d-*`, `hudOverlay-*` and `nav-*` chunks are no longer built
(R1: dist JS+CSS 2,950,937 B → 2,355,348 B); the rows above are the snapshot.

First load of `/` (shell + console + MapLibre + loader + common, gzip, without the worker and data)
≈ 360 kB. DESIGN §5.4's "≤ 150 kB over today" is measured against these numbers.

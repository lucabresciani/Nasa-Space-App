# Simulator integration: Unity findings (SIM0, D76)

Written 2026-11-15 by package SIM0. **Read-only survey**: nothing was changed in the Unity
repository, in `contracts/bundle/` (v1.0.0, frozen) or in the frame rules. Unknown stays unknown.

| Side | What was read |
| --- | --- |
| Unity | `~/coding/Nasa-Space-App` at `d19e9bf` (2026-11-14 21:43 +0100, "HUD map: clamp the view to the HD terrain area…"). Paths below are relative to that repo. |
| Planner | `contracts/bundle/README.md` and schemas, `tools/make_bundle.py`, `contracts/bundle/fixtures/official_pad_v1/`, `web/public/data/physio/golden.json` (`pipeline/engine/golden.py`), `config/{site,crew,variants,conditions}.yaml`, `server/engine/results.py`, `contracts/manifest.schema.json`, decision log rows D41 and D76 |
| Compiled-plan branch | `git fetch origin` on 2026-11-15 found **no** branch about a compiled plan or route package (`git branch -r`; `git log --all --grep` for compiled / route package / sim_plan). The only D76 hit is the web slot on `origin/ws13-live-ui-u3` (`web/src/live/config.ts:80`, `web/src/live/mock/result.ts:90-100`). Its format is therefore unknown here. |

Large Unity data files (`Assets/Mars/Data/MountSharp/*.r16.gz`, `*_splat.png`) are Git LFS
pointers in this clone (132–133 bytes), so Unity's actual height values could not be compared with
the world pack.

## 1. What Unity reads today

No C# file in `Assets/` reads any planner bundle file. A search of `Assets/**/*.cs` for `.json`,
`zip`, `ZipArchive`, `File.Read*`, `Resources.Load`, `JsonUtility`, `Newtonsoft`, `BinaryReader`,
`.f32`, `plan`, `bundle` and `golden` finds no reader of `plan.json`, `index.json`, `route.json`,
`points.json`, `fields/*.f32`, `conditions/sun.json`, `conditions/storm.json`,
`physio/golden.json`, `config_snapshot.json` or either zip. There is no test assembly (no
`*.asmdef`, no `*Test*` file under `Assets/`).

What it does read:

| File | Format | C# class and method | When |
| --- | --- | --- | --- |
| `Assets/Mars/Data/MountSharp/MountSharp.json` | JSON (grid sizes, SW corner lat/lon, `eastScale`, `metersPerDegree`, spawn, summit) | `MarsTerrain.LoadInfo` (`Assets/Mars/Editor/MarsTerrain.cs:139-150`, `JsonUtility`) | Editor only (menu `Tools/Mars/Build Mars Landscape Scene`, `Tools/Mars/Apply Mount Sharp Terrain (Open Scene)`, `MountSharpTerrain.cs:224`). Baked into `TerrainData` assets and the scene |
| `play_height.r16.gz` (4097², ~1 m), `backdrop_height.r16.gz` (2049², ~32 m) | gzip, little-endian uint16, **row 0 = south**, column 0 = west, normalised to 0..1 over `[minElevation, maxElevation]` | `MarsTerrain.ReadHeights` (`MarsTerrain.cs:206-229`), `BuildData` (`:184-204`, `TerrainData.SetHeights`) | Editor only |
| `play_splat.png`, `backdrop_splat.png` | RGBA layer weights (dust, gravel, bedrock, dark sand) | `MarsTerrain.ReadSplat` (`MarsTerrain.cs:231-269`) | Editor only |
| `rocks_hirise.csv`, `craters.csv` | CSV `x,z,diameter,height` / `x,z,radius`, Unity-grid metres from the SW corner | `MarsTerrain.LoadRocks`, `LoadCraters`, `ReadCsv` (`MarsTerrain.cs:290-337`) | Editor only |
| `Assets/Mars/WeatherData/rems.json` | planner `conditions/rems.json` copy (`rems.schema.json`) | `MarsHistoricalClimate.ReadRems` (`Assets/Mars/Scripts/Weather/MarsHistoricalClimate.cs:93-100`, `JsonUtility`) via `MarsWeather.Climate` (`MarsWeather.cs:66-69,110-112`); the `TextAsset` is assigned by `MarsWeatherSetup.cs:63-65` | Runtime (lazy, first use of the historical weather mode) |
| `Assets/Mars/WeatherData/msl_tau_880.csv` | PDS CSV | `MarsHistoricalClimate` (`MarsHistoricalClimate.cs:120-155`) | Runtime |
| `Assets/Mars/Resources/MarsRockDatabase.json` | JSON `mars-rock-db/1` | `RockDatabase` (`Assets/Mars/Scripts/Science/RockDatabase.cs:21,63`, `Resources.Load` + Newtonsoft) | Runtime |
| `Assets/Mars/Resources/MarsSkyCatalog.txt` | text catalogue | `MarsNightSky` (`Assets/Mars/Scripts/Sky/MarsNightSky.cs:39,1156`) | Runtime |

Planner values that Unity uses are **hard-coded C# constants** with "HOMELINE" comments, not read
from `config_snapshot.json`: `SuitTelemetry.cs:47-59` (body 75 kg, carried 114 kg, η 0.225,
20.1 J/mL, V0 6, anchor 19 mL/kg/min at 0.98 m/s, VO2max 36), `:127-128` (O₂ 482 L, reserve
40.5 L), `:203-205` (dose rates), `:214-220` (planning extent 3,700 m, slope 17/20°, EVA 6.5 h);
`FirstPersonController.cs:25-33,190-191` (walk 1.4 m/s, sprint 3 m/s, safe-speed factors, no-go
20°); `MapScreen.cs:39-46` (partner haul, D20). The HUD label is the planner's
"Simulated EVA · real terrain and data" (`MissionCaption.cs:15`).

## 2. Frame and units as Unity uses them

| Item | Unity | Evidence |
| --- | --- | --- |
| Axes | +X east, +Y up, +Z north, metres | `MarsGeoReference.cs:42`, `MarsTerrain.cs:17`, `MarsSkyState.cs:11` |
| Handedness | Left-handed (Unity); the code states that the (east, up, north) triple is left-handed and keeps sky transforms as improper matrices | `MarsSkyState.cs:11-12`, `MarsEphemeris.cs:55-56` |
| Origin | The **spawn** (`MountSharp.json spawn`: x 2041.27, z 2047.707 from the play SW post; "HOMELINE pad - Curiosity boxwork (sol 4573)"); terrains are placed at `-spawn` | `MarsTerrain.cs:173-176`, `MountSharpTerrain.cs:160-164`, `Data/MountSharp/CREDITS.md` ("centroid of Curiosity's 2025-26 boxwork drive ends") |
| Origin in lon/lat | 4.802367°S, 137.384614°E (from `swLat`, `swLon`, spawn x/z, `metersPerDegree`, `eastScale` through `MarsGeoReference.ToMapCoordinates`, `:113-118`) | computed here |
| Horizontal mapping | Equirectangular: X = (lon − swLon)·59274.6975·0.996489 + playSw.x; Z = (lat − swLat)·59274.6975 + playSw.y | `MarsGeoReference.cs:131-136`, `MountSharp.json` |
| Heights | World Y = MOLA-areoid elevation − `datumElevation` − r²/(2R), r = horizontal distance from the spawn, R = 3,396,190 m (the planet's curvature drop is **baked into the terrain**); `datumElevation` = spawn elevation −3643.078 m | `MarsGeoReference.cs:42-44,99-106`, `MountSharpTerrain.cs:32`, `CREDITS.md` last line |
| Height encoding | uint16 over 839.06 m (play: −4092.97 … −3253.91 m) → 1.28 cm steps | `MountSharp.json play`, `MarsTerrain.cs:194,221-226` |
| Scale | 1:1 metres; play area 4081.62 × 4096 m at 4097² posts; backdrop 65.3 × 65.5 km at 2049² | `MountSharp.json`, `MarsTerrain.cs:13-15` |
| Bearings | Degrees clockwise from +Z (north), `Quaternion.Euler(0, b, 0)` | `MarsTerrain.cs:107`, `MountSharpTerrain.cs:164`, `SuitTelemetry.cs:401` |
| Home | World origin (the spawn) | `SuitTelemetry.cs:399-401,659` |
| Time | Sol fraction of **local true solar time** (LTST; 0.5 = sun on meridian); sol 0 = local sol whose true noon is nearest `startDateUtc` = 2026-11-14T12:00; default time 0.64; `solDuration` 1200 s per sol (≈ 74× real time); key N skips to the next dawn/noon/dusk/night | `DayNightCycle.cs:60-77,257-265`, `MapScreen.cs:36` ("LTST" clock) |
| Sun direction | Own ephemeris (JPL approximate Keplerian elements + IAU 2009 Mars rotation) at the spawn's lat/lon | `DayNightCycle.cs:322-331,517-533`, `MarsEphemeris.cs:369-370`, `DATA_SOURCES.md:132,137,139` (Mars24 used for verification only) |
| Physiology | Own model: LCDA walking equation (Looney 2019) scaled to Mars g and to the ICES anchor, heart rate, fan, CO₂, battery…, labelled SIM | `SuitTelemetry.cs:28-41,62-73` |
| Dose | Constant 0.027 mSv/h dose equivalent (Hassler 2014); caution 0.080, warning 0.27 mSv/h | `SuitTelemetry.cs:203-205,279` |

### Exact mapping planner → Unity

The planner frame (`contracts/bundle/README.md` "Coordinate frame", lines 46-57; `index.json
frame`) is pad-local metres, x east, y north, z up, right-handed, origin at the official pad
(`plan.json pad`: 4.77748°S, 137.401783°E, elev −3742.4 m), projection
`+proj=eqc +lat_ts=-4.8 +lon_0=137.39 +R=3396190`.

The contract's rule "Unity position = (x, z, y)" is correct **only for axes**. Because Unity's
origin, datum and heights differ, a planner point (x, y, z) lands in the current Unity scene at:

1. lon/lat: `lon = 137.39 + deg((x + pad_xy_m[0]) / (R·cos 4.8°))`, `lat = deg((y + pad_xy_m[1]) / R)`
   (`index.json frame.projection`; `make_bundle.Frame`, `tools/make_bundle.py:83-123`);
2. Unity X, Z = `MarsGeoReference.WorldXZ(lat, lon)` (`MarsGeoReference.cs:131-136`);
3. Unity Y = `MarsGeoReference.WorldY(worldXZ, z + pad elev_m)` = z − 99.322 − (X² + Z²)/(2R)
   (`MarsGeoReference.cs:106`; −3742.4 − (−3643.078) = −99.322 m).

Closed form (both projections are equirectangular, so it is a shift plus a tiny east scale):

| Unity | From planner (x, y, z) |
| --- | --- |
| X (east) | 0.999996·x + 1014.10 |
| Y (up) | z − 99.322 − (X² + Z²) / 6,792,380 |
| Z (north) | y + 1475.19 |

The 0.999996 is `eastScale / cos(4.8°)` = 0.996489 / 0.9964929 (Unity uses cos 4.8026°): −4 mm
per km. The curvature term is 0.47 m at the planner pad and at most ~1.2 m inside the play area.
Handedness needs no extra sign: swapping y and z is the reflection that turns the planner's
right-handed (E, N, U) into Unity's left-handed (E, U, N) with the same physical directions.
Bearings agree (clockwise from north, about +Y from +Z), and grid north equals true north in both
equirectangular grids.

Every planner point of the fixture lies inside Unity's 1 m play area: pad at Unity (1014, 1475);
stations S1 (−317, −353), S2 (−542, 1397), S4 (1436, 980), S6 (−67, 797), S7 (−667, 747),
S8 (83, 1872); all 8,659 rows of the fixture's `route.json` (x −1680 … 423 m, y −1839 … 0 m)
fall inside the play rectangle (−2041 … 2040, −2048 … 2048). Computed from
`contracts/bundle/fixtures/official_pad_v1/plan_bundle.zip` and `MountSharp.json`.

## 3. Mismatches with `contracts/bundle/` v1 and the frame rules

| # | Mismatch | Unity evidence | Contract / planner evidence |
| --- | --- | --- | --- |
| M1 | **Origin is a different point.** Unity's origin and "HOMELINE pad" is the MMGIS boxwork centroid (4.802367°S, 137.384614°E, −3643.078 m), not the official pad (D21/D42: 4.77748°S, 137.401783°E, −3742.4 m). Offset 1014.1 m east, 1475.2 m north, 99.3 m up (1.79 km). It is also ~265 m from `config/site.yaml pad_default` (same rule, different value) | `MountSharp.json spawn`; `MarsTerrain.cs:173-176`; `MountSharpTerrain.cs:164`; `CREDITS.md`; `DayNightCycle` fallback `DayNightCycle.cs:79` (−4.802, 137.385) | README lines 48-52 ("origin at the pad"); `plan.json pad`; D42 |
| M2 | **Heights carry the curvature drop.** Unity stores elevation − r²/2R; the contract keeps heights unscaled areoid metres | `MarsGeoReference.cs:42-44,100-106`; `CREDITS.md` | README line 51 ("z = height above the Mars areoid minus the pad elevation"), 72 (`z_to_frame_m`), 111-112 ("keeps heights unscaled") |
| M3 | **Vertical datum** is the spawn elevation (y = 0 at −3643.078 m), not the pad elevation | `MountSharpTerrain.cs:32`; `MarsTerrain.cs:173` | README line 51 |
| M4 | **Grid row order and encoding.** Unity heightmaps: uint16 normalised, row 0 = south; contract `.f32`: float32 metres, row 0 = north | `MarsTerrain.cs:206,221-226` | README lines 59-75 |
| M5 | **Terrain is not the world pack.** Unity bakes its own 4 km play + 65 km backdrop at edit time from its own preprocessed files; it never reads `terrain/near/*.f32`, `far.f32`, textures or `horizon_ring.json`. Same base DEM (USGS MSL Gale merged DEM 1 m v3), but whether the heights match is **unknown** (LFS objects absent; Unity's preprocessing is not in the repo) | `MarsTerrain.cs:13-15,153-182` (Editor assembly); `MountSharp.json credit` | README "World pack layout" lines 98-114; `config/site.yaml:37` |
| M6 | **Horizontal scale** uses cos 4.8026° (`eastScale` 0.996489) instead of the projection's `lat_ts = −4.8` (cos 0.9964929): −4 mm/km east-west. Negligible, but not the stated projection | `MountSharp.json eastScale`; `MarsGeoReference.cs:116,133` | README lines 49-50; `index.json frame.projection` |
| M7 | **No bundle reader and no version check.** `engine_commit`, `config_hash`, `contract_version` are never compared | grep of `Assets/` (section 1) | README "Version check" lines 116-122 |
| M8 | **Physiology is not the planner's port; no golden test.** `SuitTelemetry` is an independent LCDA model; there is no test assembly, so `physio/golden.json` is not run. D41: "the C# physiology port must pass `physio/golden.json`" | `SuitTelemetry.cs:28-41,62-73`; no `*.asmdef` / tests | README line 91; D41; `golden.json` tolerances (`physio` rel 1e-6) |
| M9 | **O₂ energy equivalent** 20.1 J/mL (comment "HOMELINE F3") vs 21.0 J/mL (D29). O₂ capacity 482 L and reserve 40.5 L match D29/D24 | `SuitTelemetry.cs:52,74,127-128` | `config/crew.yaml o2_energy_j_per_ml: 21.0`; `golden.json config.crew` |
| M10 | **Load model.** Carried mass fixed at 114 kg (104 suit + 10 tools); the planner's level cost uses a(M) with the anchor at 120 kg carried and per-variant η / V0 / a_mult | `SuitTelemetry.cs:47-48,57-58` | `config/crew.yaml anchor.carried_kg: 120`; `config/variants.yaml:2,30-32` |
| M11 | **Speeds.** Unity: level 1.4 m/s (sprint 3) × factor 1.0 / 0.6 / 0.3 on 0-10 / 10-17 / 17-20°, no-go 20°. Planner: absolute caps v_safe 1.0 / 0.6 / 0.3 m/s up to 10 / 17 / 25°, speed v* limited by the effort cap (e.g. 0.946 m/s on the level, optimistic 80 kg), no-go 25 / 20 / 17° by variant | `FirstPersonController.cs:25-33,190-191`; `MountSharpTerrain.cs:179-185` | `config/crew.yaml v_safe_ms`; `config/variants.yaml:30-32`; `golden.json physio` cases; `route.json speed_ms` |
| M12 | **Clock.** Unity runs LTST at ~74× with a skip key, sol chosen by nearest true noon to 2026-11-14T12:00; the planner's EVA starts 09:00 **LMST** = 2026-11-14T10:51:18Z (MSL sol 5074) and its timeline is in real EVA minutes. LMST − LTST (equation of time) for that sol is not computed here: **unknown** | `DayNightCycle.cs:60-77,257-265` | `plan.json eva_start`; `conditions/clock.json eva`; `config/conditions.yaml clock` (D31) |
| M13 | **Sun source and site.** Unity computes the sun with its own ephemeris at its spawn; the planner's `conditions/sun.json` is Mars24 at the official pad (LMST at 137.4085°E), every 5 min. Agreement between the two is **not quantified** | `DayNightCycle.cs:330-331,522-528`; `DATA_SOURCES.md:139` | README line 89; `config/conditions.yaml:54-59` |
| M14 | **Home, T_home, O₂_home.** Distance and bearing home are measured to Unity's origin; T_home / O₂_home are never looked up from `fields/*.f32` | `SuitTelemetry.cs:399-401,659` | README lines 76-77 ("always looked up, never recomputed", handover rule 1), 87 |
| M15 | **Dose units and storm.** Unity shows a constant dose-equivalent rate in mSv/h; the planner's storm replay is absorbed dose in plastic, mGy/h (`TOTAL_DOSE_E`, D34), allowance 0.5 mGy (D9), on the EVA clock (D39) | `SuitTelemetry.cs:203-205,279,317-320` | README line 90; `conditions/storm.json`; D9, D34, D39 |
| M16 | **Partner line** is a radial approximation (flat ground, v ≈ 0.45 m/s, ~1.6 km) instead of the planner's terrain field `local/partner.geojson` | `MapScreen.cs:39-46` | README line 88; D20 |
| M17 | **Stale planner copy.** `WeatherData/rems.json` is byte-identical to home-line commit `14a64c7` (sha256 `17cdb50e…`); current `web/public/data/conditions/rems.json` (`5bbd1ad6…`) dropped the ground-temperature and UV fields (D37). The air temperature and pressure fields Unity reads are unchanged | `WeatherData/README.md`; `MarsHistoricalClimate.cs:80-100` | `contracts/rems.schema.json`; D37 |

Consistent with the contract: axis directions (E, U, N), bearing convention, metres at 1:1, the
same base DEM, the same planet radius (3,396,190 m), and the label text (`MissionCaption.cs:15`).

## 4. Where a compiled plan would plug in (format-agnostic)

The compiled plan (one JSON per route, D76) has no agreed format and no branch was found, so this
section names **hooks only**; it defines no schema, field or file name.

**Planner side.**

- The result tree (`results/{hash}/`, `contracts/backend/README.md` "Result tree";
  `server/engine/results.py`) already serves any regular file in the tree by path
  (`resolve_file`, `results.py:126-150`); `.json` is served as `application/json`.
- An exporter registry next to `build_plan` (`pipeline/engine/plan.py:66`) would hold
  "(name, function(result_dir) → files)" entries. After `build_plan` writes a tree, each
  registered exporter writes its file(s) into the same tree and adds one entry per file to the
  tree's `manifest.json` with `kind: "sim_plan"` and `file` = its path in the tree.
  `contracts/manifest.schema.json` allows that extra key today (entries require `value`, `units`,
  `file`, `script`, `commit`, `utc` and do not forbid others), and the U3 mock already validates
  an entry of that shape (`origin/ws13-live-ui-u3:web/src/live/contract.test.ts:276-282`).
- The web "Send to simulator" slot (A5s, behind `VITE_SIM_EXPORT`, off) lists every manifest entry
  of kind `sim_plan` and offers it as a download, without parsing it (`briefs/WS15.md:5`).
- `build_plan_bundle` (`tools/make_bundle.py:1116`) is unaffected; the plan bundle stays the
  contract-v1 deliverable.

**Unity side.** There is no loader today (section 1). The natural seam is one runtime component
that (a) receives the file (download from `GET /results/{hash}/{path}`, or a local file), (b) hands
it to a parser chosen by the file's own version field, and (c) gives the scene a small internal
model (origin lon/lat/elevation, route, stations, start time) that the existing components use:
`MarsGeoReference.WorldXZ` / `WorldY` for positions, `SuitTelemetry` for home, `DayNightCycle`
for the clock. Keeping that internal model separate from the file format lets a new format arrive
without touching scene code (`PRODUCT.md` principle 4, "Data is swappable").

## 5. Proposals

### For the Unity team (read-only for us; they decide)

| # | Area | Proposal | Fixes |
| --- | --- | --- | --- |
| U1 | `MarsGeoReference`, scene origin | Convert planner points through lon/lat with `WorldXZ` + `WorldY` (section 2), or rebuild `MountSharp.json` with the spawn at the official pad (4.77748°S, 137.401783°E, −3742.4 m) so world origin = planner origin | M1, M3 |
| U2 | `MarsGeoReference.WorldY` callers | When placing planner z values, always go through `WorldY` (it adds the curvature drop); never use z directly as world Y | M2 |
| U3 | `MountSharp.json eastScale` | Use cos(4.8°) = 0.9964929 to match the planner projection, or read `index.json frame.projection` | M6 |
| U4 | Plan loader | One runtime loader for the plan bundle (or a later compiled plan) with the version check against `GET /api/v1/engine/version` | M7 |
| U5 | Physiology | Port `physio_core` to C# and add an EditMode test assembly that runs every `physio/golden.json` case within its tolerances; keep `SuitTelemetry` as the SIM visual layer on top | M8, M10 |
| U6 | `SuitTelemetry.JoulesPerMlO2` | 20.1 → 21.0 J/mL (D29) | M9 |
| U7 | Speeds | During a plan replay, drive the walker with the route's `speed_ms` (or the golden v*) instead of 1.4 m/s × factor | M11 |
| U8 | `DayNightCycle` | EVA mode: start at `plan.json eva_start.utc`, real time (or a stated multiple), show LMST; take the sun from `conditions/sun.json` or check the ephemeris against it | M12, M13 |
| U9 | `SuitTelemetry` home | Home = planner pad; T_home and O₂_home looked up (nearest cell) from `fields/*.f32` | M14 |
| U10 | Dose | Read `conditions/storm.json`, show mGy/h with the 0.5 mGy allowance | M15 |
| U11 | `MapScreen` partner | Draw `local/partner.geojson` instead of the radial approximation | M16 |
| U12 | Constants | Read crew / variant values from `config_snapshot.json` instead of hard-coded constants | M9-M11 drift |
| U13 | `WeatherData/rems.json` | Refresh from current main | M17 |

### Planner-side ideas (not scheduled tonight)

| # | Where | Idea | Why |
| --- | --- | --- | --- |
| P1 | next to `build_plan` (`pipeline/engine/plan.py`) | Exporter registry: registered exporters write into the result tree and add manifest entries with `kind: "sim_plan"` (D76), with a test that the manifest still validates | The hook for the compiled plan without fixing its format |
| P2 | `docs/` | Publish the planner → Unity mapping of section 2 with a known-answer table (pad, each station) for the Unity team | Lets them check U1/U2 without reading our code |
| P3 | `contracts/bundle/` (C only, version bump) | Optional, additive: a note that a simulator may keep its own origin and must convert through lon/lat and areoid heights (no change to the frame rules) | The current wording "(x, z, y)" reads as if Unity origin = pad |
| P4 | fixture (D80) | Rebuild the fixture once `data/interim` is settled and tell the Unity team the new sha256s | Unity has not consumed v1 yet, so a rebuild costs nothing now |
| P5 | `physio/golden.json` | Add a short "how to run in C#" paragraph (case loop, tolerance formula) next to the file | D41 acceptance is the golden test; Unity has no test assembly yet |

## 6. Open questions

1. Is the Unity spawn meant to be the planner's official pad (D42), or does the simulator keep its
   own origin and convert? (Unity team / team lead)
2. Should the simulator replace `SuitTelemetry` with the planner's port (D41), or keep its model
   for the visual vitals and use the port only for margins? (Unity team, S)
3. Unity heights vs world-pack heights at the stations: equal within what tolerance? Needs the LFS
   objects or a Unity export of a few sample heights. (Unity team)
4. Where does the compiled-plan branch live, and which format version will Unity read first?
   (route-package owner)
5. Should the EVA replay run in real time or compressed, and is the clock LMST (planner) or LTST
   (Unity)? (team lead)

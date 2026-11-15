# HOMELINE integration: handoff

For anyone (a person or an AI coding session, on any PC or account) who picks up this work.
Everything needed is in this branch; no chat history is required. State: Sunday 15 Nov 2026, 02:30 CET.

- Repository: `lucabresciani/Nasa-Space-App`, branch **`homeline-integration`**. Never commit to `main`.
- The planner repository (`LuxKaiwalker/home-line`) is **read-only**: never change it, never push to it.
- The plan and its status, in Italian: [PLAN.md](PLAN.md). What the app does, for its user: [USER_GUIDE.md](USER_GUIDE.md).
  The coding rules of the logic library: [`Tools/homeline-core/README.md`](../../Tools/homeline-core/README.md).
- Deadline: Sunday 15 Nov 2026, deliver by 20:30 CET. Nothing new after 15:00.

## What works today

One Windows `.exe` (`Builds/MARTIS/MARTIS.exe`), checked by its own unattended self-test (44 checks pass):

1. MARTIS title screen. **START SIMULATION** opens the **MISSION PLANNING** screen (a panel of the menu).
2. Planning: five plans precomputed by the planner engine (official pad and four alternative pads). Pick one, press
   **GENERATE WAYPOINTS FROM PLAN**: the table of waypoints and a north-up map of the route appear.
3. **START EVA · REPLAY** (the planned walk on rails, 1x to 300x) or **START EVA · FREE WALK**.
4. In the EVA: route ribbon and beacons on the terrain; the plan panel (EVA clock, next waypoint, O2, margin and the
   limit that binds); the helmet shows the planner's O2, mission time and HOME = the pad; the route is on the
   helmet's full-screen map (`G`) and dial; the sun follows the EVA clock.
5. Free walk burns O2 with the planner's own model (slope, carried mass, station work) and caps the walking speed
   at the planner's governed speed. The live margin exists on the official plan only.
6. Pause menu: **MISSION PLAN** reopens planning; **RESTART SIMULATION** goes back to the title.

Nothing is planned inside the app: it loads the engine's routes and timelines. The planner's engine service does
not run on Windows today, so a new plan cannot be computed on this PC.

## Not done

| Item | Note |
| --- | --- |
| Live margin: radiation-dose term | Replay shows the planner's value; free walk evaluates O2, daylight and EVA duration only, and says so on screen |
| Live margin on alternative pads | The planner provides no "way home" maps for them: the panel reads "n/a" |
| Computing a new plan | Hook ready: a folder `HomelineData/results/<hash>/` with `run_record.json`, `route_*.geojson` and `timeline_*.json` appears in the plan list as "Computed live". Tested with a synthetic folder only |
| Planner web app inside the exe | Dropped for this delivery |
| A human play-through | Only the self-test has driven the exe. Mouse look, keys, gamepad focus and a full free walk need a person |

## Set up a PC (about 30 minutes, mostly downloads)

1. Install Unity **6000.6.7f1**, Git with LFS, .NET SDK 10, Node 22 (the data script builds the planner's web
   app to get its data files). `git config --global core.autocrlf true`.
2. `git lfs install`, then `git clone -b homeline-integration https://github.com/lucabresciani/Nasa-Space-App.git`.
   Check that `Assets/Mars/Generated/Terrain/MarsTerrainData.asset` is about 62.6 MB (not a small pointer file).
3. Planner data (needs read access to the private planner repository):
   `powershell -ExecutionPolicy Bypass -File Tools\homeline-data\fetch.ps1`
   It fills `HomelineData/` (outside git) from planner commit `d943f39`. The app reads `HomelineData/web/data`
   (the five plans) and `HomelineData/bundle` (the official simulator bundle). Without access to the planner
   repository, copy the `HomelineData` folder of a delivered build into the project root instead.
4. `dotnet run --project Tools/homeline-core/tests` must end with `313 passed, 0 failed`.

## Build and check

```
"C:\Program Files\Unity\Hub\Editor\6000.6.7f1\Editor\Unity.exe" -batchmode -quit -projectPath "<clone>" -logFile build.log -executeMethod NasaSpaceApp.Homeline.EditorTools.HomelineBuild.Win64
Builds\MARTIS\MARTIS.exe -homelineSelfTest -screen-fullscreen 0 -screen-width 1920 -screen-height 1080
```

- The build writes `Builds/MARTIS/` (about 370 MB) with `HomelineData` and a `README.md` (the user guide) next to
  the exe. A warm build takes under a minute; the first import of the project takes much longer.
- The self-test takes about 100 seconds and writes `Builds/MARTIS/selftest/`: `result.txt` (first line `PASS` or
  `FAIL`, then one line per check), `hud_trace.csv` and eleven screenshots. Exit code 0 = pass.
- The build was made on a clone whose `Packages/manifest.json` had these unused packages removed **locally, not
  committed**: `com.coplaydev.unity-mcp`, `com.unity.ai.assistant`, `com.unity.ai.inference`, `com.unity.pipeline`,
  `com.unity.collab-proxy`. If a batch build fails on packages or on the network, do the same.
- The build script adds the two night-sky shaders (`Mars Stars`, `Mars Constellations`) to "Always Included
  Shaders" in `ProjectSettings/GraphicsSettings.asset`. That file is not committed on this branch. When this work
  is merged into `main`, the sky workstream should commit that setting, otherwise a plain build has no stars.

## Checks to run before every commit

| Check | Command | Needs Unity |
| --- | --- | --- |
| Logic tests | `dotnet run --project Tools/homeline-core/tests` | No |
| Would Unity compile it? | `python -I Tools/homeline-dev/unity_check.py --editor` | Only a project that was opened once (for its reference list) |
| Missing `.meta` files | `python -I Tools/homeline-dev/make_meta.py` | No |
| The exe | build, then `-homelineSelfTest` (above) | Yes |

## Git rules

- Small commits, explicit paths: `git add -- <paths>` then `git commit`. Never `git add -A`, stash, rebase or force-push.
- A `.cs` file and its `.meta` go in the same commit.
- `git pull --no-rebase` (merge) before pushing. One person merges `main` into the branch.
- Do not commit `ProjectSettings/`, `Packages/` or `Assets/Settings/`, and never save
  `Assets/Scenes/MarsLandscape.unity` from this branch: everything here starts from code, with no scene edits.

## Where things are

| Folder (under `Assets/Mars/Scripts/Homeline/`) | Content |
| --- | --- |
| `Core/` | Pure C#, also compiled and tested by `dotnet`: bundle and grid readers, `GeoRoute`, `PlanCatalog`, `WaypointPlan`, `MissionPlan`, `Timeline`, `Physio` and `HlConfig` (the planner's oxygen model), `LiveState` (free-walk oxygen), `PadFrame` (planner metres to Unity world) |
| `Flow/HomelineApp.cs` | Boot object (lives across scene loads), link to the MARTIS menu, plan catalog, start of a mission |
| `Sim/` | `EvaDriver` (replay, free walk, helmet feed, live margin), `SkySync`, `GroundSampler`, `HomelinePaths`, `SelfTest` |
| `Ui/` | `PlanningPanel` and `PlanMap` (planning screen), `PlanPanel` (read-out in the EVA), `MapRouteOverlay` (route on the helmet's maps) |
| `World/RouteWorldView.cs` | Ribbon and beacons on the terrain |

Two files of the helmet HUD workstream carry small additive hooks, in their own commit (`db2aa6d`), so they can be
reverted or re-applied alone: `Scripts/HUD/SuitTelemetry.cs` (`HomeXZ`, `AfterTick`, internal setters) and
`Scripts/HUD/MapView.cs` (HOME star at `HomeXZ`).

`MapRouteOverlay` finds HUD objects by name (`MapScreen/Frame/MapBox/MapView/Clip`, `Base`, `Marks`, `CompassDial`)
and copies two constants of the dial (inner radius 134, view radius 250 m). If the HUD workstream renames or
changes them, the overlay hides itself and must be updated.

## Facts worth knowing

- Official pad: lon 137.401783, lat -4.77748, which is Unity world X 1014.096, Z 1475.186.
- Plan `rank1.nom_104`: pad, S7, S6, S1, S4, pad; about 8.65 km; 325.94 min; O2 482.31 L at start, 124.87 L at the
  return; EVA starts 2026-11-14T10:51:18Z.
- Margin = min(O2, daylight, dose, EVA duration); O2 term = (O2 left - O2 home - tasks left - 40.5 L) / 1.35 L/min.
- The planner's oxygen and margin have no weather term. The helmet's weather, heart rate, CO2 and dose rate are
  the game's own simulation and are labelled SIM.
- This project enters Play without a domain reload: statics are reset at `SubsystemRegistration`.
- The EVA speed (1x to 300x) never uses `Time.timeScale`.

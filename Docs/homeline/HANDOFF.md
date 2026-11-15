# HOMELINE integration: handoff and work packages

For anyone (a person or an AI coding session, on any PC or account) who picks up part of this work.
Everything needed is in this branch; no chat history is required.

- Repository: `lucabresciani/Nasa-Space-App`, branch **`homeline-integration`**. Never commit to `main`.
- The planner repository (`LuxKaiwalker/home-line`) is **read-only**: never change it, never push to it.
- The plan, in Italian: [PLAN.md](PLAN.md). The coding rules: [`Tools/homeline-core/README.md`](../../Tools/homeline-core/README.md).
- Deadline: Sunday 15 Nov 2026, deliver by 20:30 CET. Nothing new after 15:00.

## What the app must do

One Windows `.exe` with a staged flow: MARTIS title screen, then a **mission planning** stage (the planner web app,
full-screen), then the **3D EVA** on Mars (replay of the planned route, or free walk), with the helmet judging live
whether the crew can still get home. Pause returns to the title screen.

## Set up a PC (about 30 minutes, mostly downloads)

1. Install Unity **6000.6.7f1**, Git with LFS, .NET SDK 10, Node 24, Chrome. `git config --global core.autocrlf true`.
2. `git lfs install`, then `git clone -b homeline-integration https://github.com/lucabresciani/Nasa-Space-App.git`.
   Check that `Assets/Mars/Generated/Terrain/MarsTerrainData.asset` is about 62.6 MB (not a small pointer file).
3. Planner data (needs read access to the private planner repository):
   `powershell -ExecutionPolicy Bypass -File Tools\homeline-data\fetch.ps1`
   It fills `HomelineData/` (outside git) from planner commit `d943f39`. Both PCs must use the same commit.
4. `dotnet run --project Tools/homeline-core/tests` must end with `0 failed`.
5. Only for Unity work: open the project in Unity (first import takes a while). Do not commit changes to
   `ProjectSettings/` or `Packages/`, and never save `Assets/Scenes/MarsLandscape.unity` from this branch.

## Checks to run before every commit

| Check | Command | Needs Unity |
| --- | --- | --- |
| Logic tests | `dotnet run --project Tools/homeline-core/tests` | No |
| Would Unity compile it? | `python -I Tools/homeline-dev/unity_check.py --editor` | Only a project that was opened once (for its reference list) |
| Missing `.meta` files | `python -I Tools/homeline-dev/make_meta.py` | No |

## Git rules

- Small commits, explicit paths: `git add -- <paths>` then `git commit`. Never `git add -A`, stash, rebase or force-push.
- A `.cs` file and its `.meta` go in the same commit.
- `git pull --no-rebase` (merge) before pushing. One person merges `main` into the branch.
- Stay in your package's files. If you need a change in someone else's file, ask; do not edit it.
- Do not create anything under `Assets/Mars/Scripts/HUD`, `Scripts/Sky`, `Scripts/Menu` or `Assets/Mars/UI`:
  those belong to other workstreams on `main` and reach this branch only through a merge.

## Work packages

Status legend: DONE (committed), ACTIVE (someone is on it), OPEN (free to take).
Update this table in the same commit that changes a status.

| # | Package | Needs Unity editor | Depends on | Status |
| --- | --- | --- | --- | --- |
| 0 | Foundations: bundle reader, grids, pad frame, data paths, ground height, menu link, build script, tooling | No | — | DONE |
| A | Plan data: `RouteTrack`, `Timeline`, `PlanPoints`, `EvaClock`, `PlanDeviation`, `WayHome` | No | 0 | ACTIVE (PC 1) |
| B | Physiology and margins: `HlConfig`, `Physio`, `Margin`, `StormTrack`, `SunTrack`, `Alarms`, 68 golden cases | No | 0 | ACTIVE (PC 1) |
| C | Local web host: `PlannerServer`, `BrowserProcess`, `Win32Window`, `bridge.js` | No | 0 | ACTIVE (PC 1) |
| D | EVA session and live state: load both bundles into one object; live O2 and margin from the actual state; the per-frame readout handed to the HUD | No | A, B | OPEN |
| E | EVA direction in Unity: load the session, replay on rails, free walk, speed cap, station arrival | Yes | D | OPEN |
| F | Flow: title, planning, EVA, pause (`MenuLink` + C) | Yes | C | OPEN |
| G | World markers and minimap: route ribbon on the terrain, station beacons, pad ring, top-down minimap | Yes | A | OPEN |
| H | Helmet HUD connection | Yes | D, HUD merged from `main`, the user's go-ahead | BLOCKED |
| I | **Build and acceptance on the second PC**: first import, first `.exe`, timings, clean-PC test | Yes | 0 | OPEN |
| J | Mission log and plan-adherence readout | No | D | OPEN |

### Package I: build and acceptance (good first job for a second PC or account)

No dependency on the other packages: it can start now, and it removes the biggest unknown (nobody has built this
project into an `.exe` yet).

1. Set up the PC as above. Note how long the first import takes.
2. Build without opening the editor window:
   ```
   "C:\Program Files\Unity\Hub\Editor\6000.6.7f1\Editor\Unity.exe" -batchmode -quit -projectPath "<clone>" -logFile build.log -executeMethod NasaSpaceApp.Homeline.EditorTools.HomelineBuild.Win64
   ```
   Output: `Builds/MARTIS/MARTIS.exe` with `HomelineData` copied next to it. Exit code 0 = success.
3. Report in `Docs/homeline/BUILD_LOG.md`: import time, build time, exe folder size, every error or warning that
   looks relevant, and whether the exe starts and the player can walk.
4. If the build fails because of the preview packages (`com.unity.ai.assistant`, `com.unity.ai.inference`,
   `com.coplaydev.unity-mcp`, `com.unity.pipeline`), remove them from `Packages/manifest.json` **locally**, rebuild,
   and report it. Do not commit the manifest change without agreement.
5. Later: repeat with each new commit that is announced as "ready to build"; test on a clean Windows user profile
   with the network off; zip the folder.

### Package D: EVA session and live state (pure C#, testable with `dotnet`)

- `EvaSession`: opens `plan_bundle.zip` and `world_pack.zip`, verifies them, and exposes the plan (route, timeline,
  points), the grids (T_home, O2_home, bearing, pointer, slope, worst cases), the conditions (sun, storm), the
  configuration and the pad frame. One call; everything read-only afterwards.
- `LiveState`: the crew's actual state in a free walk. O2 burned by the planner's physiology formula from the actual
  speed and grade, with the grade measured over at least 3 m of travel and no smoothing; station dwell at the task
  rate; assumptions named `Assumed...` (arrival within 5 m of the station access point, 30 min dwell, resting rate
  when standing off-station).
- `EvaReadout`: one immutable snapshot per frame for the HUD: T_home (nominal), margin and its four terms and the
  binding one, O2 left and needed, the active alarm, bearing and distance to the pad, next station and ETA, speed
  cap, time to dark, dose rate, plan adherence, labels. In replay the O2 comes from the timeline; in a free walk
  from `LiveState`.
- Known answer to assert: replaying the planned route through `EvaReadout` reproduces the timeline rows (margin
  within 0.3 min, same binding term on all 20 walk rows).

### Packages E, F, G (Unity)

- Start everything from code (`RuntimeInitializeOnLoadMethod`), like `HudBootstrap` does: **no scene edits**.
  This project enters Play without a domain reload: reset statics at `SubsystemRegistration` and release ports,
  threads and child processes when leaving Play.
- Never use `Time.timeScale` for the EVA speed (1/30/60/300x): the EVA clock runs on unscaled time and stops while
  the menu is open.
- Everything the planner places is put on the ground of **this** scene (`GroundSampler`), not at the planner's z.
- Outside the detailed terrain (it ends 573 m north of the pad) show "coarse terrain".

## Facts worth knowing

- Official pad: lon 137.401783, lat -4.77748, which is Unity world X 1014.096, Z 1475.186.
- Plan `rank1.nom_104`: pad, S7, S6, S1, S4, pad; about 8.65 km; 325.94 min; EVA starts 2026-11-14T10:51:18Z.
- Live margin = min(O2, daylight, dose, EVA duration); O2 term = (O2 left - O2 home - tasks left - 40.5 L) / 1.35 L/min.
- The planner's energy equivalent is 21.0 J/mL (some comments say 20.1: the code and the golden vectors use 21.0).
- Other workstreams on `main`: real sky (`Scripts/Sky`), helmet HUD (`Scripts/HUD`), MARTIS title screen
  (`Scripts/Menu`). The menu hooks are in `Flow/MenuLink.cs`.

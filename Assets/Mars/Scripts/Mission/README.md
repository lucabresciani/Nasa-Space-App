# Mission link (HOMELINE Mission Planer → simulator)

Plays a mission planned in the HOMELINE web app (`/mission`, repo `home-line`) in this simulator
and compares the walk with the plan. Contract: `contracts/bundle/mission.schema.json` (v1.1.0
draft) in home-line; the log back is `contracts/bundle/eva_log.schema.json`.

## Use it

1. Plan on the web, press **Download mission.json** (lands in `~/Downloads`).
2. Play `Assets/Scenes/MarsLandscape.unity`, press **F5** (newest `~/Downloads/mission*.json`),
   or **Tools ▸ Mars ▸ Load Mission JSON…**. Start-up also loads `-mission <path>` or
   `{persistentDataPath}/mission.json`. WebGL: `SendMessage("MissionLink", "LoadMission", json)`.
3. A fresh EVA starts on the mission pad: the player stands on it facing the first leg, HOME
   moves there, the suit is refilled and the mission clock restarts.
4. Walk. Top right: status, next waypoint, schedule and O₂ against the plan, live margin, advice;
   at a waypoint the stop counter with its tags and note. **G** opens the map: route, numbered
   waypoints, and the **Waypoints** tab (details, **Complete**, **Show on map**).
5. Back at the pad the EVA log is written to `~/Downloads/eva_log_*.json`
   (also **Tools ▸ Mars ▸ Export EVA Log**). **Tools ▸ Mars ▸ Clear Mission** ends it.

## Files

| File | Role |
| --- | --- |
| `MissionFile.cs` | parses and checks `mission.json`; the planner's eqc projection |
| `MissionPlan.cs` | the mission in world space (pad-local m → lat/lon → `MarsGeoReference.WorldXZ`), planned values per route point, timeline |
| `SceneMissionWorld.cs` | lat/lon → world with terrain height |
| `MissionLink.cs` | loading (F5, file, WebGL), `Current`, moves player and HOME (`HomeBase`) to the pad |
| `MissionTracker.cs` | live comparison: current leg, cross-track, stops, schedule / O₂ deltas, margin, status |
| `EvaLogger.cs` | track + events → `eva_log.json` |
| `../HUD/MissionPanel.cs`, `MissionRouteDrawer.cs`, `MapWaypointsTab.cs` | HUD panel, route on dial and map, Waypoints tab |
| `../../Editor/MissionMenu.cs`, `MissionSelfTest.cs` | Tools menu; self-test |

## Rules (what the numbers mean)

- **Never recomputed:** planned times, O₂, T_home and O₂_home come from the file. The live O₂ is
  the suit model (`SuitTelemetry`), so O₂ deviation shows how the walk differed from the plan.
- **Margin** = min of O₂ `(O₂ left − O₂_home − tasks left − reserve) / effort rate`, daylight
  `t_dark − t − T_home`, EVA duration `limit − t − T_home` (the planner's terms; dose is not in
  the file). Off route, T_home and O₂_home add the straight walk back to the route at the leg's pace.
- **Status:** RETURN NOW margin < 0 · TURN BACK margin < `margin_amber_min` (10) · REPLAN the rest
  of the plan no longer fits at the current delay · OFF ROUTE > 25 m · BEHIND > 5 min · else ON PLAN /
  HEADING HOME / EVA COMPLETE. Arrive within 10 m; a stop ends after its planned time, on leaving
  (> 20 m, "left early") or with Complete. The 25 m / 5 min / 10 m / 20 m values are assumed for
  the simulator (`MissionTracker` constants).

## Time and weather

Loading a mission puts the sky at the planned EVA start (`conditions.eva_start_utc`, else the instant
when LMST at the pad is `eva_start_lmst` on the scene's date; `Sky/MarsClock.cs`, Mars24) and runs
the sol in real time (88 775 s instead of the scene's 1 200 s), so EVA minute t is the plan's minute t
and the sun sets at the plan's `t_dark`. The weather snaps to Clear and stops evolving (the plan
assumes today's clear sky; M still changes it). With the web's storm switch on (D39) the file
carries the dose series: the suit's dose rate replays it (Gale background × rate / quiet rate) and the
live margin gets the dose term. Clear Mission restores the scene's clock speed and weather.

## Check it

**Tools ▸ Mars ▸ Mission Self-Test** (or batch:
`Unity -batchmode -nographics -projectPath . -executeMethod NasaSpaceApp.MarsGen.MissionSelfTest.RunBatch -missionTest <mission.json> -logFile -`)
places the mission on the terrain, compares the planner's elevations with Unity's, and walks the
plan exactly: it must stay ON PLAN, keep the live margin within 0.5 min of the plan (SPEC F18)
and end COMPLETE.

Play-mode smoke test (batch only; Unity must be closed):
`Unity -batchmode -projectPath . -executeMethod NasaSpaceApp.MarsGen.MissionPlaySmokeTest.Run -missionTest <mission.json> -logFile -`
starts the game, leaves the title menu, loads the mission, walks the route (completing stops from
the map's Waypoints tab), returns to the pad and fails on any logged error or exception. It writes
a real EVA log to `~/Downloads`.


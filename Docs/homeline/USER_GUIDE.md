# MARTIS with the HOMELINE mission plan: user guide

MARTIS is a first-person Mars EVA simulator on real terrain of lower Mount Sharp (Gale crater). This build adds the
mission plans of the HOMELINE planner: you choose a plan, generate its waypoints, and then walk it or watch it,
with the planner's oxygen and margin on the helmet.

Every view says **Simulated EVA · real terrain and data**: the terrain, the routes and the numbers come from real
data and from the planner; the crew, the EVA and the suit are simulated.

## Start

1. Unzip the folder and run `MARTIS.exe` (Windows 10 or 11, 64-bit). Windows may show "Windows protected your PC"
   because the app is not signed: choose **More info**, then **Run anyway**.
2. Keep the `HomelineData` folder next to the exe. Without it the app still runs, but without plans.

## Flow

| Step | What you do |
| --- | --- |
| Title | **START SIMULATION** opens the mission planning screen |
| Mission planning | Pick one of the plans, press **GENERATE WAYPOINTS FROM PLAN**, read the waypoint table |
| Start | **START EVA · REPLAY** (watch the planned walk) or **START EVA · FREE WALK** (walk it yourself) |
| Pause | `Esc` opens the menu; **MISSION PLAN** reopens the planning screen; **RESUME SIMULATION** continues |

The plans were computed by the HOMELINE planner engine before this build, for the nominal crew with a 104 kg
suit. Nothing is planned inside the app: it loads the engine's route and timeline. There are five plans: the
official pad and four alternative rover parking spots (two of them are 21 m apart).

**Waypoints.** The main waypoints are the planner's own: the rover (pad) and each science station, with the
planned arrival, departure, oxygen left and margin. The navigation points between them are the bends of the
planner's track, derived by the simulator (a bend is kept when dropping it would move the track by more than
30 m); they are not planner output.

## Moving a station by hand

On the official plan, after **GENERATE WAYPOINTS FROM PLAN**, drag a station (a diamond) on the map with the
mouse and release it. The caption reads the way home from the point under the mark; dark ground is outside the
planner's way-home map, and a station cannot be dropped there. On release the simulator re-routes the whole plan
through the new point (about half a second) and the table, the map and the EVA use the new plan. **RESET TO
PLANNER PLAN** undoes every move.

- The new route is the simulator's own computation with the planner's cost model on the planner's 3 m terrain
  grid, not output of the planner engine, and the screen says so. With no station moved it reproduces the
  planner's timeline within 0.6 min of margin and 0.05 L of oxygen.
- The order of the stations and the work time at each stay as planned; the engine would also re-optimise the order.
- The rover cannot be moved, and stations of the alternative pads cannot be moved: the way-home maps exist for
  the official pad only.
- Where the planner's data has no 1 m terrain, the re-routed leg times are about 2 % off.
- Dragging needs the mouse; there is no keyboard or gamepad equivalent yet.

## Keys during the EVA

| Key | Action |
| --- | --- |
| `W A S D`, mouse | Walk (free walk) and look |
| `V` | Switch between replay and free walk |
| `[` `]` | Replay speed: 1x, 30x, 60x, 300x |
| `T` | Pause or resume the replay |
| `G` | Full-screen EVA map |
| `E` | Scan the rock under the reticle |
| `Esc` | Menu |

In the 3D world the amber ribbon is the planned route, the tall beacons are the rover (white) and the stations
(cyan), the short amber posts are navigation points. The same route is on the helmet's maps: on the full-screen
map (`G`) as an amber line with the stations as labelled diamonds, the navigation points as beads and a ring around
HOME (the rover); on the bottom-left dial as an amber line with a ring for each station in range.

## Where each number comes from

| Read-out | Replay | Free walk |
| --- | --- | --- |
| EVA clock, next waypoint | Planner timeline | Your own clock, at real time |
| O2 left (plan panel and helmet) | Planner timeline | Planner oxygen model applied to the ground you walk: slope and carried mass, 0.84 L/min while working at a station, resting rate when standing |
| Walking speed | Planner route | Capped at the planner's governed speed for the slope (0.91 m/s on the level, 0.36 m/s at +10 degrees) |
| Margin | Planner timeline, interpolated between its rows | Official plan only: the planner's formula at your place and time. It is the smallest of the oxygen, daylight, radiation-dose and EVA-duration limits, from the planner's "time and oxygen to get home" maps and its replay of the solar storm |
| HOME on the helmet | The plan's pad | The plan's pad |
| "O2 minutes to reserve" on the helmet | (O2 left - 40.5 L) / 1.35 L/min: the oxygen limit only | Same |
| Sun and sky | The real sky for that minute of the plan (EVA start 2026-11-14 10:51:18 UTC, 09:00 local mean solar time) | Same |
| Heart rate, CO2, battery, cooling, signal, temperature, dose rate, weather | The game's own simulation (marked SIM) | Same |

The planner's oxygen model has no weather term: wind, cold and dust change the helmet's simulated vitals, never the
planner's oxygen or margin.

## Known differences from the planner

The planner's own review of this simulator lists these; they are still true in this build.

- The 3D terrain is this app's own model of the same NASA elevation data, not the planner's terrain files, and
  it includes the planet's curvature. Waypoints are placed on this app's ground.
- On alternative pads the planner provides no "way home" maps, so off the planned track the margin reads "n/a".
- In a replay the margin between two timeline rows is interpolated (the planner's own web HUD does the same); the
  free walk uses the planner's formula, so the two can differ by some minutes at the hand-over (at station S7,
  two minutes after arrival: 66 min interpolated, 61 min by the formula, both limited by the dose).
- The radiation read-out on the helmet is a constant background value, while the planner's margin uses the solar
  storm of 20 May 2024 replayed on the EVA clock.
- Station arrival within 5 m, the resting rate when standing still, and the 10 m distance over which the slope is
  measured are assumptions of this simulator, chosen so that walking the planned route reproduces the planner's
  oxygen within 1 %.
- The app does not check the bundle's engine version against a planner server.

## Unattended check

`MARTIS.exe -homelineSelfTest` runs the whole flow by itself and writes `selftest/result.txt` (first line `PASS`
or `FAIL`), a numeric trace and screenshots, then quits.

## Data

Plans, timelines and the simulator bundle: HOMELINE planner (`LuxKaiwalker/home-line`), computed from NASA and
USGS data (MSL Gale merged elevation model, HiRISE, Curiosity RAD and REMS). See `DATA_SOURCES.md` in the
repository for the terrain, sky and weather sources of the simulator itself.

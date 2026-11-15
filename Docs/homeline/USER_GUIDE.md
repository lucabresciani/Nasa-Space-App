# MARVIS: user guide

MARVIS is a first-person Mars EVA simulator on real terrain of lower Mount Sharp (Gale crater), with its mission
planner in the same window: you plan a route on the map, send it to the simulator, and walk it with the planned
oxygen and margin on the helmet.

Every view says **Simulated EVA · real terrain and data**: the terrain, the routes and the numbers come from real
data and from the planner; the crew, the EVA and the suit are simulated.

## Start

1. Unzip the folder and run `MARVIS.exe` (Windows 10 or 11, 64-bit). Windows may show "Windows protected your PC"
   because the app is not signed: choose **More info**, then **Run anyway**.
2. Keep the folders `MarvisWeb`, `MarvisPlanner` and `HomelineData` next to the exe.
3. Use a PC that is online. The planner is the web site `https://marvis.vxliu.com/`, shown inside the MARVIS window.
   Without a connection MARVIS shows a copy of the planner that is shipped in `MarvisPlanner`.

The planner window needs the Microsoft Edge WebView2 Runtime, which is part of Windows 11 and of an up-to-date
Windows 10. Without it **MISSION PLAN** opens the built-in planning screen described further down.

## Flow

| Step | What you do |
| --- | --- |
| Title | **MISSION PLAN** opens the planner. **START SIMULATION** goes straight to free exploration, without a plan |
| Planner | Click the map to add waypoints; the times, the oxygen and the margins of the route are estimated at once |
| Send | **Send to MARVIS** in the planner's right-hand panel: the planner closes and the EVA starts at the rover pad |
| EVA | Walk the route; the helmet shows the next waypoint, the schedule, the oxygen against the plan and the margin |
| Pause | `Esc` opens the menu; **MISSION PLAN** reopens the planner; **RESUME SIMULATION** continues |
| After the EVA | A few seconds after a completed EVA the planner comes back; **Last EVA**, top right, compares the walk with the plan |

In the planner:

- **Back to MARVIS menu**, top right, or the key `F10`, closes the planner and shows the MARVIS menu again.
- **Send to MARVIS** needs at least one waypoint. The rover pad is chosen at the top of the right-hand panel.
- **Download mission.json** saves the same plan as a file in your Downloads folder and does not start the EVA.
  A saved file can be loaded later from the EVA map (`G`, tab **Missions**) or with `F5`.
- The first time, the planner can take up to about half a minute to load its terrain data.
- When the planner site has a newer version, MARVIS loads it by itself; a route being drawn is then started again.

At the start point stand two models that mark it: a crew rover about 10 m away and a habitat about 28 m away.

## The built-in planning screen

When the planner cannot be shown (no WebView2 Runtime, or MARVIS started with `-noWebPlanner`), **MISSION PLAN**
opens a planning screen inside the simulator itself. The sections from here to "Planner alarms" describe that
screen and its plans.

| Step | What you do |
| --- | --- |
| Mission planning | Pick one of the plans, press **GENERATE WAYPOINTS FROM PLAN**, read the waypoint table |
| Start | **START EVA · REPLAY** (watch the planned walk) or **START EVA · FREE WALK** (walk it yourself) |

The plans were computed by the planner engine before this build, for the nominal crew with a 104 kg
suit. Nothing is planned on this screen: it loads the engine's route and timeline. There are five plans: the
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
- **Limits.** Every plan is checked before it can start, whoever made it: the margin (the smallest of the oxygen,
  daylight, dose and EVA-duration limits) must never fall below zero and the oxygen at the return must not be
  below the 40.5 L reserve. The screen states the result; for an edited plan it also states the oxygen margin
  alone. A plan that breaks a limit is shown, but **START EVA** and **SAVE ROUTE** are off until the station is
  moved back or the plan is reset.
- **Every plan can be edited**, also the alternative pads. For those the planner publishes no way-home map, so
  the simulator computes one for the pad with the same model (about four seconds, in the background; at the
  stations of the official pad it matches the planner's map within 0.15 min). On those pads the storm timing in
  a free walk is the official plan's.
- **SAVE ROUTE** keeps an edited plan. **MY ROUTES** (top right of the list) shows the saved routes, newest
  first; **PLANNER PLANS** goes back. A saved route stores the stations' points and is re-built when loaded.
  The files are in `%USERPROFILE%\AppData\LocalLow\<company>\<product>\HomelineRoutes`; delete a file to remove
  a route.
- The order of the stations and the work time at each stay as planned; the engine would also re-optimise the order.
- The rover cannot be moved.
- An edited route stays on the high-definition terrain of the scene: a station cannot be dropped outside it
  (dark on the map) and the re-routed legs are searched inside it only.
- Where the planner's data has no 1 m terrain, the re-routed leg times are about 2 % off.
- Dragging needs the mouse; there is no keyboard or gamepad equivalent yet.

## Station cards

Click a station on the plan map to read its card under the map: what is there (the planner's science target),
the landmarks around it with bearing and distance and, on the official unedited plan, what to do if the partner
goes down and the latest departure. The same card appears at the top left of the EVA while the crew is at the
station. The texts are the planner's own; a station moved by hand says so, because the science target stays at
the planner's point.

## Work planned at each station

Clicking a station also opens its work panel in place of the waypoint table (click empty ground on the map to get
the table back):

- **Labels**: Sample, Drill, Photo, Survey, Install, Inspect, Repair, Rest (the list of the web planner's Mission
  page). They describe the work and change no number.
- **Note**: free text; click the field, type, press Enter.
- **Stop time**: `-5 MIN` / `+5 MIN`, from 0 to 120 minutes. This is the only value that changes the plan: the
  oxygen for the stop is charged at the planner's work rate, every later time shifts, and the limits check runs
  again (a stop that is too long turns START off).

A plan with work set on it is an edited plan: it is re-computed by the simulator and can be saved to MY ROUTES
with its labels, notes and stop times. The station card, in the planning screen and in the EVA, shows the work.

## Satellite view

The plan map shows the HiRISE image of the play area (NASA/JPL/University of Arizona, about 1 m per pixel), the
same image as the EVA map's Satellite layer. The **RELIEF** button at the top left of the map switches to the
shaded relief of the simulator's terrain and back. Ground where a station cannot stand is veiled dark in both.

## Planner alarms

The plan panel shows the planner's HUD alarms as its first line: **WARNING TURN BACK NOW** when the margin is
below zero, **WARNING RADIATION: HEAD HOME** when the storm tripwire has fired and the way home is longer than
the dose leash, **CAUTION TURN-BACK IN N MIN** when the margin is under 10 minutes. The planner's two other rules
(position uncertainty, partner-haul range) are not evaluated. The helmet's RAD read-out follows the planner's
storm on the EVA clock: the helmet's quiet-time value multiplied by the storm's rate over its quiet rate.

## Missions from the planner

A mission sent with **Send to MARVIS**, or a `mission.json` saved with **Download mission.json** and loaded from
the EVA map (`G`, tab **Missions**) or with `F5`, runs through the Mission link (see
`Assets/Mars/Scripts/Mission/README.md` in the repository). It has its own HUD panel, a **Waypoints** tab with the
notes and tags written in the planner, a HiRISE satellite layer on the map and an EVA log. One mission runs at a
time: starting a plan from the built-in planning screen ends a planner mission, and loading a planner mission ends
the plan.

## Keys during the EVA

The keys `V`, `[`, `]`, `T` and `R` belong to an EVA started from the built-in planning screen.

| Key | Action |
| --- | --- |
| `W A S D`, mouse | Walk (free walk) and look |
| `V` | Switch between replay and free walk |
| `[` `]` | Replay speed: 1x, 30x, 60x, 300x |
| `T` | Pause or resume the replay |
| `R` | Route guidance in the world, on or off (off at the start) |
| `G` | Full-screen EVA map |
| `E` | Scan the rock under the reticle |
| `Esc` | Menu |

Route guidance in the 3D world is a simulator aid, so it is off at the start: the crew navigates with the helmet's
maps. `R` turns it on, and then only what is near is drawn: the stretch of the planned route within 45 m (a thin
amber line that fades out at both ends) and the posts within 70 m (white at the rover, cyan at a station, small
amber posts at navigation points). Nothing of it is visible from far away. The whole route is on the helmet's maps: on the full-screen
map (`G`) as an amber line with the stations as labelled diamonds, the navigation points as beads and a ring around
HOME (the rover); on the bottom-left dial as an amber line with a ring for each station in range.

## Where each number comes from

| Read-out | Replay | Free walk |
| --- | --- | --- |
| EVA clock, next waypoint | Planner timeline | Your own clock, at real time |
| O2 left (plan panel and helmet) | Planner timeline | Planner oxygen model applied to the ground you walk (slope and carried mass, 0.84 L/min while working at a station, resting rate when standing), plus what weather and stress add (SIM, see "Heart rate and oxygen") |
| Heart rate and VO2 on the helmet | The helmet's physiology model (SIM) fed with the planner's metabolic rate of the planned walk, on the EVA clock | The same model fed with the planner's rate of your own walk |
| Walking speed | Planner route | Capped at the planner's governed speed for the slope (0.91 m/s on the level, 0.36 m/s at +10 degrees) |
| Margin | Planner timeline, interpolated between its rows | Official plan only: the planner's formula at your place and time. It is the smallest of the oxygen, daylight, radiation-dose and EVA-duration limits, from the planner's "time and oxygen to get home" maps and its replay of the solar storm |
| HOME on the helmet | The plan's pad | The plan's pad |
| "O2 minutes to reserve" on the helmet | (O2 left - 40.5 L) / 1.35 L/min: the oxygen limit only | Same |
| Sun and sky | The real sky for that minute of the plan (EVA start 2026-11-14 10:51:18 UTC, 09:00 local mean solar time) | Same |
| CO2, battery, cooling, signal, temperature, dose rate, weather | The game's own simulation (marked SIM) | Same |

## Heart rate and oxygen

The helmet's heart rate comes from the game's physiology model (SIM), now driven by the mission:

| Input | What it does | Source |
| --- | --- | --- |
| The route | The oxygen uptake of walking this slope at this pace, of working at a station, of standing; heart rate follows it as the share of the heart-rate reserve equals the share of the VO2 reserve, with a rise time of about 30 s and a slower recovery, plus a slow drift during long effort | Planner oxygen model for the uptake; helmet model for the heart |
| The weather | Work against the wind, bracing against gusts, worse footing and visibility in dust, cold while resting: more uptake and a higher heart rate. Dust storms, dust devils and darkness also raise the heart rate as stress | Helmet model (SIM), modest by physics: Mars air is about 1.5 % as dense as Earth's |
| Stress from the mission | Up to +12 bpm as the margin falls from an hour to zero, +6 bpm when a limit is broken, up to +8 bpm in the last half hour of oxygen above the reserve; at most +22 bpm | Assumed values |
| Oxygen cost of stress | 0.03 mL/kg/min per bpm of stress (about a tenth of the standing uptake at +20 bpm): stress raises the heart rate much more than the oxygen uptake | Assumed value |

In a **free walk** the oxygen that weather and stress add is taken from the tank on top of the planner's model, and
the plan panel shows it (LOAD line). In a **replay** the tank follows the planner's timeline, which has no
weather or stress term; the heart rate and the uptake on the helmet still show what the conditions would cost.
In a replay faster than real time the physiology runs on the EVA clock.

## Known differences from the planner

The planner's own review of this simulator lists these; they are still true in this build.

- The 3D terrain is this app's own model of the same NASA elevation data, not the planner's terrain files, and
  it includes the planet's curvature. Waypoints are placed on this app's ground.
- On alternative pads the planner provides no "way home" maps, so off the planned track the margin reads "n/a".
- In a replay the margin between two timeline rows is interpolated (the planner's own web HUD does the same); the
  free walk uses the planner's formula, so the two can differ by some minutes at the hand-over (at station S7,
  two minutes after arrival: 66 min interpolated, 61 min by the formula, both limited by the dose).
- The radiation read-out on the helmet is a dose equivalent scaled with the planner's storm (the solar storm of
  20 May 2024 replayed on the EVA clock), while the planner works in absorbed dose: only the ratio to the quiet
  level is carried over.
- Station arrival within 5 m, the resting rate when standing still, and the 10 m distance over which the slope is
  measured are assumptions of this simulator, chosen so that walking the planned route reproduces the planner's
  oxygen within 1 %.
- The app does not check the bundle's engine version against a planner server.

## Unattended check

`MARVIS.exe -homelineSelfTest` runs the whole flow by itself and writes `selftest/result.txt` (first line `PASS`
or `FAIL`), a numeric trace and screenshots, then quits.

## Data

Plans, timelines and the simulator bundle: the MARVIS planner (repository `LuxKaiwalker/home-line`), computed from
NASA and USGS data (MSL Gale merged elevation model, HiRISE, Curiosity RAD and REMS). See `DATA_SOURCES.md` in the
repository for the terrain, sky and weather sources of the simulator itself.

Models at the start point: NASA Space Exploration Vehicle (credit NASA/LaRC/Advanced Concepts Lab) and NASA Habitat
Demonstration Unit, from NASA 3D Resources, used under the NASA Images and Media Usage Guidelines; NASA is
acknowledged as the source and no endorsement is implied.

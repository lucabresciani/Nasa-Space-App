using System;
using System.Collections;
using System.Globalization;
using System.IO;
using System.Text;
using NasaSpaceApp.Homeline.Flow;
using NasaSpaceApp.HUD;
using NasaSpaceApp.Menu;
using UnityEngine;

namespace NasaSpaceApp.Homeline.Sim
{
    /// <summary>
    /// Unattended check of the whole flow, for builds made when nobody is at the machine:
    ///   MARVIS.exe -homelineSelfTest [-homelineSelfTestDir DIR]
    /// The app opens the planning panel, generates the waypoints of the official plan, replays the EVA at 300x while
    /// comparing the plan read-out and the helmet HUD with the planner's timeline, then walks freely for a moment,
    /// loads an alternative plan, and quits. It writes result.txt (first line PASS or FAIL), hud_trace.csv and
    /// screenshots, and exits with 0 or 1. A watchdog quits with FAIL if anything takes too long.
    /// </summary>
    public sealed class SelfTest : MonoBehaviour
    {
        const float WatchdogSeconds = 360f;

        public static bool Requested
        {
            get { return Array.IndexOf(Environment.GetCommandLineArgs(), "-homelineSelfTest") >= 0; }
        }

        string dir;
        MissionPlan brokenPlan; // a plan that breaks the limits, for the alarm check
        bool expectMenu = true; // false once the first EVA has started: from then on an open menu is a lost focus
        readonly StringBuilder log = new StringBuilder();
        readonly StringBuilder trace = new StringBuilder();
        int failures;
        int shot;
        float startedAt;
        bool finished;
        double worstHudO2;

        IEnumerator Start()
        {
            startedAt = Time.realtimeSinceStartup;
            dir = Arg("-homelineSelfTestDir") ?? Path.Combine(Directory.GetParent(Application.dataPath).FullName, "selftest");
            Directory.CreateDirectory(dir);
            foreach (string old in Directory.GetFiles(dir, "*.png")) File.Delete(old);
            Note("self-test started, output " + dir);

            HomelineApp app = HomelineApp.Instance;
            Check(app != null, "app object exists");
            if (app != null) app.RoutesFolderOverride = Path.Combine(dir, "routes"); // never the user's own list
            if (app == null) { Finish(); yield break; }
            Check(app.Catalog.Plans.Count >= 5, "catalog has the 5 precomputed plans (" + app.Catalog.Plans.Count + ")");
            Check(app.Physio != null, "planner O2 model loaded from the official bundle");

            // The menu builds itself after the scene has loaded.
            float waitUntil = Time.realtimeSinceStartup + 40f;
            while ((MarvisMenu.Instance == null || !MarvisMenu.IsOpen) && Time.realtimeSinceStartup < waitUntil) yield return null;
            Check(MarvisMenu.Instance != null && MarvisMenu.IsOpen, "title screen is up");
            // No key may be bound to two commands (the list of the menu's Controls page).
            var seenKeys = new System.Collections.Generic.Dictionary<string, string>();
            string clashes = "";
            int keyRows = 0;
            foreach (KeybindCatalog.Group kg in KeybindCatalog.Read())
            {
                foreach (KeybindCatalog.Binding kb in kg.Rows)
                {
                    if (kb.Keys == null || kb.Keys.Length == 0) continue;
                    keyRows++;
                    // "SHIFT" + key is one combination; otherwise every key of the row counts on its own (W A S D, [ ]).
                    bool combo = kb.Keys.Length == 2 && kb.Keys[0] == "SHIFT";
                    string[] tokens = combo ? new[] { kb.Keys[0] + "+" + kb.Keys[1] } : kb.Keys;
                    foreach (string token in tokens)
                    {
                        string other;
                        if (seenKeys.TryGetValue(token, out other)) clashes += token + " (" + other + " / " + kb.Action + ") ";
                        else seenKeys[token] = kb.Action;
                    }
                }
            }
            Check(clashes.Length == 0 && keyRows >= 20, "no key is bound to two commands (" + keyRows + " commands, " + seenKeys.Count + " keys)" + (clashes.Length > 0 ? ": " + clashes : ""));
            System.Reflection.MethodInfo showControls = typeof(MarvisMenu).GetMethod("ShowControls",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
            if (showControls != null && MarvisMenu.Instance != null)
            {
                showControls.Invoke(MarvisMenu.Instance, null);
                yield return new WaitForSecondsRealtime(0.8f);
                yield return Shot("controls");
                MarvisMenu.Instance.Back();
                yield return new WaitForSecondsRealtime(0.4f);
            }
            Check(MarvisMenu.StartInterceptor == null && MarvisMenu.PlanRequested != null,
                  "START SIMULATION goes straight to free exploration; MISSION PLAN opens the planning");
            Check(EvaDriver.MissionStress(90, 200) == 0f && Math.Abs(EvaDriver.MissionStress(0, 200) - 12f) < 0.01f && EvaDriver.MissionStress(-5, 0) >= 22f,
                  "mission stress: none with a wide margin, +12 bpm at zero margin, capped at +22 bpm with a broken limit and no O2 above the reserve");
            yield return new WaitForSecondsRealtime(4f); // title intro animation
            yield return Shot("title");

            app.OpenPlanning();
            yield return new WaitForSecondsRealtime(1.2f);
            Check(app.Panel != null, "planning panel opened from the menu");
            yield return Shot("planning_empty");

            PlanEntry official = app.Catalog.Find("rank1");
            if (official == null && app.Catalog.Plans.Count > 0) official = app.Catalog.Plans[0];
            MissionPlan plan = null;
            if (app.Panel != null)
            {
                app.Panel.Generate(); // the official plan is preselected
                plan = app.Panel.Generated;
                yield return new WaitForSecondsRealtime(0.8f);
                yield return Shot("planning_generated");
            }
            if (plan == null && official != null) plan = app.Generate(official);
            Check(plan != null, "official plan loads");
            if (plan == null) { Finish(); yield break; }
            Check(plan.Entry.Id == "rank1", "the preselected plan is the official one (" + plan.Entry.Id + ")");
            Check(plan.Waypoints.StationCount == 4, "4 stations (" + plan.Waypoints.StationCount + ")");
            Check(plan.Waypoints.NavCount == 25, "25 navigation points (" + plan.Waypoints.NavCount + ")");
            Check(plan.HasReturnFields, "return fields attached to the official plan");
            string cardS7 = app.StationCardText(plan, "S7", 3);
            Check(app.Cards.Count >= 4 && cardS7 != null && cardS7.Contains("sulfate") && cardS7.Contains("Latest departure"),
                  "station cards read from the planner (" + app.Cards.Count + "); S7: " + (cardS7 != null ? cardS7.Split('\n')[0] : "none"));
            if (app.Panel != null) app.Panel.SelectStation("S7");
            Check(app.Panel == null || app.Panel.MapHasSatellite, "satellite image of the play area (HiRISE) on the plan map");

            // Move a station by hand (what dragging its mark on the map does): the simulator re-routes the plan,
            // the panel shows it, an impossible move is refused, RESET brings the planner's plan back.
            MissionPlan editedPlan = null;
            Waypoint s6 = null;
            foreach (Waypoint w in plan.Waypoints.Main) if (w.Id == "S6") s6 = w;
            Check(app.CanEdit(plan), "stations of the official plan can be moved (router data present)");
            if (s6 != null && app.Panel != null && app.CanEdit(plan))
            {
                float t0 = Time.realtimeSinceStartup;
                bool moved = app.Panel.MoveStation("S6", s6.X, s6.Y - 90);
                float ms = (Time.realtimeSinceStartup - t0) * 1000f;
                editedPlan = moved ? app.Panel.Generated : null;
                Check(moved && editedPlan != null && editedPlan.Edited, "S6 moved 90 m south: plan re-routed in " + F(ms) + " ms");
                if (editedPlan != null && editedPlan.Edited)
                {
                    Note("edited plan: " + F(editedPlan.EndMin) + " min (planner plan " + F(plan.EndMin) + "), smallest margin " +
                         F(editedPlan.EditData.MinMarginMin) + " min (" + editedPlan.EditData.MinMarginBinding + ") at " + editedPlan.EditData.MinMarginWhere);
                    Check(Math.Abs(editedPlan.EndMin - 323.31) < 0.5, "edited plan lasts 323.3 min, as the reference re-route (" + F(editedPlan.EndMin) + ")");
                    Check(editedPlan.EditData.Feasible, "edited plan keeps a positive margin");
                    Check(editedPlan.HasReturnFields && editedPlan.Storm != null, "edited plan keeps the way-home maps and carries its own storm timing");
                    yield return new WaitForSecondsRealtime(0.5f);
                    yield return Shot("planning_edited");
                    Check(!app.Panel.MoveStation("S6", s6.X + 4000, s6.Y), "a move onto unreachable ground is refused");
                    // The high-definition terrain bounds every edited route.
                    var hd = new GroundSampler();
                    float hx0, hz0, hx1, hz1;
                    if (hd.DetailedRect(out hx0, out hz0, out hx1, out hz1))
                    {
                        int outside = 0, vertices = 0;
                        foreach (RouteLeg leg in editedPlan.Track.Legs)
                        {
                            for (int i = 0; i < leg.X.Length; i++)
                            {
                                double vx, vz;
                                editedPlan.Frame.LocalToWorld(leg.X[i], leg.Y[i], out vx, out vz);
                                vertices++;
                                if (!hd.IsDetailed((float)vx, (float)vz)) outside++;
                            }
                        }
                        Check(outside == 0, "the edited route stays on the high-definition terrain (" + outside + " of " + vertices + " vertices outside)");
                        double ox, oy;
                        editedPlan.Frame.WorldToLocal(hx1 + 40f, 0.5f * (hz0 + hz1), out ox, out oy);
                        Check(app.ProbeStationPoint(editedPlan, ox, oy) == null && !app.Panel.MoveStation("S6", ox, oy),
                              "a station cannot be dropped off the high-definition terrain");
                    }
                    else Check(false, "the scene reports its high-definition terrain");
                    Check(app.Panel.Generated == editedPlan, "a refused move leaves the plan as it was");

                    // Work at a station: labels, a note and a longer stop. Only the stop time changes the plan.
                    double before = editedPlan.EndMin;
                    app.Panel.SelectStation("S6");
                    bool act = app.Panel.SetActivity("S6", 45, new[] { "Sample", "Photo" }, "core sample at the ridge");
                    Check(act && Math.Abs(app.Panel.Generated.EndMin - (before + 15.0)) < 0.2,
                          "15 min more work at S6 makes the plan 15 min longer (" + F(before) + " -> " + F(app.Panel.Generated.EndMin) + " min)");
                    editedPlan = app.Panel.Generated;
                    string cardS6 = app.StationCardText(editedPlan, "S6", 3);
                    Check(cardS6 != null && cardS6.Contains("Sample, Photo") && cardS6.Contains("core sample at the ridge") && cardS6.Contains("Moved 90"),
                          "the card of S6 shows its planned work, its note and that it was moved");
                    yield return new WaitForSecondsRealtime(0.4f);
                    yield return Shot("planning_activity");

                    // Limits: the edited plan respects them, so START and SAVE are offered; it is saved.
                    Check(app.Panel.StartAllowed, "START is offered for an edited plan that respects the limits");
                    Check(editedPlan.EditData.OxygenOk, "oxygen margin of the edited plan stays positive (" + F(editedPlan.EditData.MinO2MarginMin) + " min at " + editedPlan.EditData.MinO2MarginWhere + ")");
                    Check(app.Panel.SaveRoute(), "edited plan saved with SAVE ROUTE");
                    Check(app.SavedRoutes().Count == 1, "one saved route on disk (" + app.SavedRoutes().Count + ")");

                    // A station pushed too far breaks the limits: the plan is shown, START and SAVE are refused.
                    // A plan that breaks the limits whatever the terrain: the same route with half an hour more work at
                    // every station (longer than the EVA budget, and the O2 at the return falls below the reserve).
                    var longStops = editedPlan.StopsOf();
                    foreach (EditStop st in longStops) st.DwellMin += 30;
                    string whyLong;
                    MissionPlan tooLong = app.BuildEdited(editedPlan, longStops, out whyLong);
                    brokenPlan = tooLong;
                    if (tooLong != null) app.Panel.ShowEdited(tooLong);
                    if (tooLong != null && !app.Panel.Generated.EditData.Feasible)
                    {
                        MissionPlan broken = app.Panel.Generated;
                        Note("30 min more work at every station: " + F(broken.EndMin) + " min, margin " + F(broken.EditData.MinMarginMin) + " min (" +
                             broken.EditData.MinMarginBinding + "), oxygen margin " + F(broken.EditData.MinO2MarginMin) + " min, O2 at return " + F(broken.EditData.O2AtReturnL) + " L");
                        Check(!broken.EditData.Feasible, "a plan that is too long is found to break a limit (" + broken.EditData.MinMarginBinding + ")");
                        Check(!app.Panel.StartAllowed, "START is refused for a plan that breaks the limits");
                        Check(!app.Panel.SaveRoute(), "a plan that breaks the limits cannot be saved");
                        app.Panel.Begin(EvaMode.Replay);
                        yield return null;
                        Check(!app.Driver.Active && MarvisMenu.IsOpen, "pressing START on such a plan starts nothing");
                        yield return new WaitForSecondsRealtime(0.4f);
                        yield return Shot("planning_limits_broken");
                    }
                    else Check(false, "a plan that breaks the limits could be built for the limits check");

                    // MY ROUTES: the saved route is listed, re-builds to the same plan, and the planner list comes back.
                    app.Panel.ShowSavedRoutes(true);
                    Check(app.Panel.ItemCount == 1, "MY ROUTES lists the saved route (" + app.Panel.ItemCount + ")");
                    app.Panel.Generate();
                    MissionPlan reloaded = app.Panel.Generated;
                    Check(reloaded != null && reloaded.Edited && Math.Abs(reloaded.EndMin - editedPlan.EndMin) < 0.01,
                          "the saved route re-builds to the same plan (" + (reloaded != null ? F(reloaded.EndMin) : "null") + " min)");
                    EditStop kept = reloaded != null ? reloaded.ActivityOf("S6") : null;
                    Check(kept != null && kept.Tags.Length == 2 && kept.Note == "core sample at the ridge" && Math.Abs(kept.DwellMin - 45) < 0.01,
                          "the saved route keeps the work planned at S6 (labels, note, stop time)");
                    yield return new WaitForSecondsRealtime(0.4f);
                    yield return Shot("planning_my_routes");
                    app.Panel.ShowSavedRoutes(false);
                    app.Panel.Generate();
                    app.Panel.MoveStation("S6", s6.X, s6.Y - 90);
                    app.Panel.ResetEdit();
                    Check(app.Panel.Generated == plan, "RESET TO PLANNER PLAN restores the planner's plan");
                }
            }

            expectMenu = false;
            app.Begin(plan, EvaMode.Replay);
            waitUntil = Time.realtimeSinceStartup + 10f;
            while (!app.Driver.Active && Time.realtimeSinceStartup < waitUntil) yield return null;
            Check(app.Driver.Active && app.Driver.Mode == EvaMode.Replay, "replay started after START EVA");
            if (!app.Driver.Active) { Finish(); yield break; }

            // The pad of the official plan in this scene (Tools/homeline-core/tests/BundleTests.cs): checked at once,
            // before the replay has carried the crew away.
            Transform player = FindAnyObjectByType<FirstPersonController>().transform;
            Note("player at start " + V(player.position) + ", t = " + F(app.Driver.TMin) + " min");
            Check(Dist(player.position, 1014.1f, 1475.2f) < 15f, "player starts at the official pad");
            yield return new WaitForSecondsRealtime(1.5f); // menu dissolve
            yield return Shot("eva_start");
            CheckSun(app);

            app.Driver.SetSpeed(300);
            trace.Append("t_min,world_x,world_y,world_z,local_x,local_y,plan_o2_L,plan_margin_min,binding,hud_o2_L,hud_met_min,hud_home_m,detailed_terrain\n");
            double nextSample = 0;
            bool shotS7 = false, shotMid = false;
            float hrWalk = 0f, hrStation = 0f, radPeak = 0f;
            int frames = 0;
            float frameSum = 0f, frameWorst = 0f;
            bool alarmOnOfficial = false;
            waitUntil = Time.realtimeSinceStartup + 110f;
            while (!app.Driver.ReplayFinished && Time.realtimeSinceStartup < waitUntil)
            {
                double t = app.Driver.TMin;
                if (t >= nextSample)
                {
                    Sample(app, plan, player);
                    nextSample += 5;
                }
                // Heart rate of the helmet's model: walking toward S7, then late in the work at S7.
                if (hrWalk == 0f && t >= 38)
                {
                    SuitTelemetry th = Telemetry();
                    if (th != null) hrWalk = th.HeartRate;
                }
                alarmOnOfficial |= app.Driver.Alarm.Active;
                if (radPeak == 0f && t >= 66)
                {
                    SuitTelemetry th = Telemetry();
                    if (th != null) radPeak = th.DoseRateMsvH;
                }
                if (hrStation == 0f && t >= 72)
                {
                    SuitTelemetry th = Telemetry();
                    if (th != null) hrStation = th.HeartRate;
                }
                if (!shotS7 && t >= 50)
                {
                    shotS7 = true;
                    yield return Shot("eva_station_S7");
                }
                if (!shotMid && t >= 180)
                {
                    shotMid = true;
                    yield return Shot("eva_leg3");
                }
                frames++;
                frameSum += Time.unscaledDeltaTime;
                if (Time.unscaledDeltaTime > frameWorst) frameWorst = Time.unscaledDeltaTime;
                yield return null;
            }
            if (frames > 0) Note("frame time during the replay: average " + F(1000f * frameSum / frames) + " ms (" + F(frames / frameSum) + " fps), worst " + F(1000f * frameWorst) + " ms, " + frames + " frames");
            Check(app.Driver.ReplayFinished, "replay reached the planned return (t = " + F(app.Driver.TMin) + " min)");
            Note("heart rate in the replay: " + F(hrWalk) + " bpm walking to S7, " + F(hrStation) + " bpm working at S7 (rest " + F(SuitTelemetry.HeartRateRest) + ")");
            Check(radPeak > 1.0f, "helmet RAD follows the planner's storm (" + F(radPeak) + " mSv/h near its peak; quiet level " + F(SuitTelemetry.DoseRateGaleMsvH) + ")");
            Check(!alarmOnOfficial, "no planner alarm fires on the official plan");
            Check(hrWalk > 100f && hrWalk < 150f, "heart rate follows the planned walk in the replay (" + F(hrWalk) + " bpm on the way to S7)");
            Check(hrStation > 82f && hrStation < hrWalk - 8f, "heart rate comes down while working at a station (" + F(hrStation) + " bpm)");
            yield return null;
            Sample(app, plan, player);
            Check(Math.Abs(app.Driver.TMin - plan.EndMin) < 0.01, "EVA clock ends at the planned " + F(plan.EndMin) + " min");
            double? o2End = plan.O2LeftAt(app.Driver.TMin);
            Check(o2End.HasValue && Math.Abs(o2End.Value - 124.87) < 0.05, "O2 at return is the planner's 124.87 L (" + (o2End.HasValue ? F(o2End.Value) : "null") + ")");
            Check(Dist(player.position, 1014.1f, 1475.2f) < 3f, "player is back at the pad");

            SuitTelemetry tel = Telemetry();
            Check(tel != null, "helmet telemetry reachable");
            if (tel != null)
            {
                Check(worstHudO2 < 0.6, "helmet O2 followed the planner timeline through the replay (worst difference " + F(worstHudO2) + " L)");
                Check(Math.Abs(tel.O2LeftL - 124.87f) < 0.3f, "helmet O2 at return " + F(tel.O2LeftL) + " L");
                Check(Math.Abs(tel.MetSeconds / 60f - 325.94f) < 0.2f, "helmet mission time " + F(tel.MetSeconds / 60f) + " min");
                Check(tel.DistanceHomeM < 5f, "helmet home distance at the pad " + F(tel.DistanceHomeM) + " m");
            }
            yield return Shot("eva_return");

            // The helmet's full-screen map (G) with the planned route drawn on it.
            Ui.MapRouteOverlay overlay = app.GetComponent<Ui.MapRouteOverlay>();
            if (overlay != null && Ui.MapRouteOverlay.SetMapOpen(true))
            {
                HudContext hc = HelmetHud.Instance.Context;
                waitUntil = Time.realtimeSinceStartup + 15f;
                while ((hc.ElevationMap == null || !hc.ElevationMap.IsReady) && Time.realtimeSinceStartup < waitUntil) yield return null;
                yield return new WaitForSecondsRealtime(1.0f); // map fade
                yield return Shot("eva_map");
                Check(overlay.RoutePointCount > 0 && overlay.MapSegmentsDrawn > 0,
                      "planned route drawn on the helmet map (" + overlay.MapSegmentsDrawn + " segments, " + overlay.MapStationsShown + " stations in view)");
                Ui.MapRouteOverlay.SetMapOpen(false);
                yield return new WaitForSecondsRealtime(0.5f);
            }
            else Check(false, "helmet map opened for the route overlay");

            app.Driver.SetMode(EvaMode.FreeWalk);
            yield return new WaitForSecondsRealtime(2.5f);
            Check(app.Driver.Mode == EvaMode.FreeWalk, "switched to free walk");
            Check(app.Driver.Live != null, "free walk uses the planner O2 model");
            if (app.Driver.Live != null)
            {
                Check(Math.Abs(app.Driver.Live.O2LeftL - 124.87) < 0.5, "free walk inherits the plan's O2 (" + F(app.Driver.Live.O2LeftL) + " L)");
                Check(app.Driver.Live.RateLMin > 0.3 && app.Driver.Live.RateLMin < 0.6, "standing still burns the resting rate (" + F(app.Driver.Live.RateLMin) + " L/min)");
                Check(app.Driver.LiveMarginMin.HasValue, "live margin available on the official plan" +
                      (app.Driver.LiveMarginMin.HasValue ? " (" + F(app.Driver.LiveMarginMin.Value) + " min, limit " + app.Driver.LiveBinding + ")" : ""));
            }
            yield return Shot("eva_free_walk");

            // Hand-over at station S7, where the planner's margin is bound by the storm dose: the live margin must
            // name the same limit and stay close to the timeline (which is interpolated between its rows).
            app.Driver.SetMode(EvaMode.Replay);
            app.Driver.SetSpeed(1);
            app.Driver.Seek(46);
            yield return new WaitForSecondsRealtime(0.6f);
            double? planned = plan.MarginAt(app.Driver.TMin);
            string plannedLimit = plan.BindingAt(app.Driver.TMin);
            app.Driver.SetMode(EvaMode.FreeWalk);
            yield return new WaitForSecondsRealtime(1.0f);
            Note("hand-over at t = " + F(app.Driver.TMin) + " min: planner margin " + (planned.HasValue ? F(planned.Value) : "null") + " min (" + plannedLimit +
                 "), live margin " + (app.Driver.LiveMarginMin.HasValue ? F(app.Driver.LiveMarginMin.Value) : "null") + " min (" + app.Driver.LiveBinding + ")");
            Check(app.Driver.LiveMarginHasDose, "live margin includes the planner's dose term");
            Check(app.Driver.LiveBinding == "dose" && plannedLimit == "dose", "at S7 the live margin is bound by the dose, like the planner's");
            Check(planned.HasValue && app.Driver.LiveMarginMin.HasValue && Math.Abs(planned.Value - app.Driver.LiveMarginMin.Value) < 10.0,
                  "live margin at S7 within 10 min of the planner's interpolated timeline");

            // An alternative pad: same flow, different start, no return fields.
            PlanEntry alt = app.Catalog.Find("pad_default");
            MissionPlan altPlan = alt != null ? app.Generate(alt) : null;
            Check(altPlan != null, "alternative plan (first survey spot) loads");
            if (altPlan != null)
            {
                Check(!altPlan.HasReturnFields, "alternative plan has no planner way-home map");

                // Every plan can be edited, not only the official one: the simulator computes this pad's way-home map.
                float h0 = Time.realtimeSinceStartup;
                app.EnsureHomeMap(altPlan);
                waitUntil = Time.realtimeSinceStartup + 60f;
                while (!altPlan.HasReturnFields && Time.realtimeSinceStartup < waitUntil)
                {
                    app.PollHomeMap();
                    yield return null;
                }
                Check(altPlan.HasReturnFields && !altPlan.PlannerHomeMap, "way-home map of the alternative pad computed in " + F(Time.realtimeSinceStartup - h0) + " s");
                if (altPlan.HasReturnFields)
                {
                    Waypoint a0 = null;
                    foreach (Waypoint w in altPlan.Waypoints.Main) if (w.Kind == WaypointKind.Station && a0 == null) a0 = w;
                    string why;
                    MissionPlan altEdited = a0 != null ? app.MoveStation(altPlan, a0.Id, a0.X + 45, a0.Y + 30, out why) : null;
                    Check(altEdited != null && altEdited.Edited, "a station of the alternative plan can be moved (" + (a0 != null ? a0.Id : "?") + ")");
                    if (altEdited != null)
                        Note("alternative plan edited: " + F(altEdited.EndMin) + " min (planner plan " + F(altPlan.EndMin) + "), margin " + F(altEdited.EditData.MinMarginMin) +
                             " min (" + altEdited.EditData.MinMarginBinding + "), oxygen margin " + F(altEdited.EditData.MinO2MarginMin) + " min");
                }
                app.Begin(altPlan, EvaMode.Replay);
                yield return new WaitForSecondsRealtime(1.0f);
                Check(app.Driver.Active && app.Driver.Plan == altPlan, "alternative plan started");
                Check(Dist(player.position, -154.4f, -215.3f) < 80f, "player starts at the alternative pad " + V(player.position));
                app.Driver.SetSpeed(300);
                app.Driver.Seek(60);
                yield return new WaitForSecondsRealtime(1.5f);
                yield return Shot("eva_alternative_pad");
            }

            // The simulation runs the edited plan: at the planned arrival the crew stands on the moved station.
            if (editedPlan != null && editedPlan.Edited)
            {
                Waypoint e6 = null;
                foreach (Waypoint w in editedPlan.Waypoints.Main) if (w.Id == "S6") e6 = w;
                app.Begin(editedPlan, EvaMode.Replay);
                yield return new WaitForSecondsRealtime(1.0f);
                Check(app.Driver.Active && app.Driver.Plan == editedPlan, "edited plan started in the simulation");
                if (e6 != null)
                {
                    app.Driver.SetSpeed(1);
                    app.Driver.Seek(e6.ArriveMin + 1.0);
                    yield return new WaitForSecondsRealtime(1.0f);
                    double wx, wz;
                    editedPlan.Frame.LocalToWorld(e6.X, e6.Y, out wx, out wz);
                    float off = Dist(player.position, (float)wx, (float)wz);
                    Check(off < 5f, "replay of the edited plan stands on the moved S6 at its arrival (" + F(off) + " m off)");
                    double? o2 = editedPlan.O2LeftAt(app.Driver.TMin);
                    SuitTelemetry telE = Telemetry();
                    Check(o2.HasValue && telE != null && Math.Abs(telE.O2LeftL - o2.Value) < 1.0, "helmet O2 follows the edited plan (" +
                          (telE != null ? F(telE.O2LeftL) : "?") + " L)");
                    yield return Shot("eva_edited_plan_S6");
                }
            }

            // A plan that breaks the limits (it cannot be started from the planning screen): the planner's alarm.
            if (brokenPlan != null)
            {
                app.Begin(brokenPlan, EvaMode.Replay);
                yield return new WaitForSecondsRealtime(1.0f);
                app.Driver.SetSpeed(1);
                app.Driver.Seek(brokenPlan.EndMin - 20.0);
                yield return new WaitForSecondsRealtime(1.5f);
                HudAlarm al = app.Driver.Alarm;
                Check(al.Active && al.Rule == 1 && al.Text == "TURN BACK NOW", "planner alarm TURN BACK NOW while the margin is below zero (" + (al.Text ?? "none") + ")");
                Check(SuitTelemetry.MissionStressBpm >= 18f, "mission stress is high with a broken limit (+" + F(SuitTelemetry.MissionStressBpm) + " bpm)");
                yield return Shot("eva_alarm_turn_back");
            }

            // RESTART SIMULATION from the pause menu reloads the scene: the title must come back with no mission
            // running, and the whole flow must work again on the new scene objects, this time straight into free walk.
            MarvisMenu oldMenu = MarvisMenu.Instance;
            System.Reflection.MethodInfo restart = typeof(MarvisMenu).GetMethod("Restart",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
            Check(oldMenu != null && restart != null, "menu restart entry reachable");
            if (oldMenu != null && restart != null)
            {
                restart.Invoke(oldMenu, null);
                waitUntil = Time.realtimeSinceStartup + 30f;
                while ((MarvisMenu.Instance == null || MarvisMenu.Instance == oldMenu) && Time.realtimeSinceStartup < waitUntil) yield return null;
                yield return new WaitForSecondsRealtime(2.0f);
                Check(MarvisMenu.Instance != null && MarvisMenu.Instance != oldMenu && !MarvisMenu.IsOpen,
                      "RESTART SIMULATION reloads the scene into free exploration (no title, no planning screen)");
                Check(!app.Driver.Active, "no mission running after the restart");
                MissionPlan again = app.Generate(app.Catalog.Find("rank1"));
                Check(again != null, "official plan generates again after the restart");
                if (again != null)
                {
                    app.Begin(again, EvaMode.FreeWalk);
                    waitUntil = Time.realtimeSinceStartup + 10f;
                    while (!app.Driver.Active && Time.realtimeSinceStartup < waitUntil) yield return null;
                    yield return new WaitForSecondsRealtime(1.5f);
                    FirstPersonController fpc = FindAnyObjectByType<FirstPersonController>();
                    player = fpc != null ? fpc.transform : null;
                    Check(app.Driver.Active && app.Driver.Mode == EvaMode.FreeWalk, "free walk started from the planning screen");
                    Check(player != null && Dist(player.position, 1014.1f, 1475.2f) < 15f, "player at the official pad after the restart" + (player != null ? " " + V(player.position) : ""));
                    LiveState live = app.Driver.Live;
                    Check(live != null && live.O2LeftL > 480.0, "free walk starts with the full planner tank" + (live != null ? " (" + F(live.O2LeftL) + " L)" : ""));
                    CharacterController body = player != null ? player.GetComponent<CharacterController>() : null;
                    if (live != null && body != null)
                    {
                        // Walk for eight seconds at 0.8 m/s: the planner model must see the motion.
                        double before = live.O2LeftL;
                        Vector3 from = player.position;
                        Vector3 ahead = Vector3.ProjectOnPlane(player.forward, Vector3.up).normalized;
                        SuitTelemetry telW = Telemetry();
                        float hr0 = telW != null ? telW.HeartRate : 0f;
                        float until = Time.time + 8f;
                        double peakRate = 0;
                        while (Time.time < until)
                        {
                            body.Move((ahead * 0.8f + Vector3.down * 3f) * Time.deltaTime);
                            if (live.RateLMin > peakRate) peakRate = live.RateLMin;
                            yield return null;
                        }
                        float walked = Dist(player.position, from.x, from.z);
                        Note("walked " + F(walked) + " m; O2 " + F(before) + " -> " + F(live.O2LeftL) + " L; peak rate " + F(peakRate) + " L/min; slope " + F(live.GradeDeg) + " deg");
                        Check(walked > 3f, "the crew member can walk in free walk (" + F(walked) + " m in 8 s)");
                        Check(telW != null && telW.HeartRate > hr0 + 3f, "heart rate rises when the crew member starts walking (" + F(hr0) + " -> " +
                              (telW != null ? F(telW.HeartRate) : "?") + " bpm in 8 s)");
                        Check(peakRate > 0.55, "walking raises the planner O2 rate above resting (" + F(peakRate) + " L/min)");
                        Check(live.O2LeftL < before, "walking consumes planner O2");
                    }
                    SuitTelemetry tel2 = Telemetry();
                    Check(tel2 != null && tel2.DistanceHomeM < 15f, "helmet HOME is the pad after the restart" + (tel2 != null ? " (" + F(tel2.DistanceHomeM) + " m)" : ""));
                    yield return Shot("eva_free_walk_after_restart");
                    Check(!app.Driver.RouteVisible && app.Driver.GuidanceShownPoints == 0 && app.Driver.GuidanceShownPosts == 0,
                          "route guidance (line and posts) is off by default");
                    app.Driver.SetRouteVisible(true);
                    yield return new WaitForSecondsRealtime(0.4f);
                    Note("guidance on: " + app.Driver.GuidanceShownPoints + " of " + app.Driver.GuidanceTotalPoints + " route vertices, " +
                         app.Driver.GuidanceShownPosts + " of " + app.Driver.GuidanceTotalPosts + " posts drawn");
                    Check(app.Driver.RouteVisible && app.Driver.GuidanceShownPoints > 0 && app.Driver.GuidanceShownPoints * 10 < app.Driver.GuidanceTotalPoints,
                          "key R shows the route only near the crew");
                    Check(app.Driver.GuidanceShownPosts >= 1 && app.Driver.GuidanceShownPosts < app.Driver.GuidanceTotalPosts,
                          "only the posts near the crew are drawn");
                    yield return Shot("eva_guidance_near");
                    app.Driver.SetRouteVisible(false);
                }
            }

            Finish();
        }

        void Update()
        {
            // The window may lose focus while the test runs (someone is using the PC): the menu then opens its
            // pause screen and the EVA clock stops. The test never wants the pause screen during a mission.
            HomelineApp running = HomelineApp.Instance;
            if (!finished && !expectMenu && running != null && MarvisMenu.IsOpen) MarvisMenu.StartNow();
            if (!finished && Time.realtimeSinceStartup - startedAt > WatchdogSeconds)
            {
                Check(false, "watchdog: the self-test did not finish in " + WatchdogSeconds + " s");
                Finish();
            }
        }

        /// <summary>
        /// The scene's sun against the planner's (conditions/sun.json of the official bundle: azimuth 74.8 deg and
        /// elevation 36.7 deg at EVA start, rising about 0.23 deg per EVA minute).
        /// </summary>
        void CheckSun(HomelineApp app)
        {
            DayNightCycle cycle = FindAnyObjectByType<DayNightCycle>();
            Light sun = cycle != null ? cycle.GetComponent<Light>() : null;
            if (sun == null || !app.EvaStartUtc.HasValue)
            {
                Note("sun check skipped (no sun light or no EVA start instant)");
                return;
            }
            Vector3 toSun = -sun.transform.forward;
            float elevation = Mathf.Asin(Mathf.Clamp(toSun.y, -1f, 1f)) * Mathf.Rad2Deg;
            float azimuth = Mathf.Repeat(Mathf.Atan2(toSun.x, toSun.z) * Mathf.Rad2Deg, 360f);
            double t = app.Driver.TMin;
            double wantEl = 36.697 + 0.2338 * t, wantAz = 74.811 - 0.0696 * t;
            Note("sun at t = " + F(t) + " min: azimuth " + F(azimuth) + ", elevation " + F(elevation) +
                 " (planner about " + F(wantAz) + ", " + F(wantEl) + "); LTST " + F(MarsSkyState.LocalSolarTime * 24f) + " h");
            Check(Math.Abs(elevation - wantEl) < 2.0 && Math.Abs(Mathf.DeltaAngle(azimuth, (float)wantAz)) < 3.0,
                  "the scene's sun is the planner's sun for this minute of the EVA");
        }

        static SuitTelemetry Telemetry()
        {
            HelmetHud hud = HelmetHud.Instance;
            return hud != null && hud.Context != null ? hud.Context.Telemetry : null;
        }

        void Sample(HomelineApp app, MissionPlan plan, Transform player)
        {
            double t = app.Driver.TMin;
            double? o2 = plan.O2LeftAt(t), margin = plan.MarginAt(t);
            SuitTelemetry tel = Telemetry();
            Vector3 p = player.position;
            // The helmet shows the frame it was last fed in (at 300x a frame is up to a minute of EVA): compare its
            // O2 with the plan at the helmet's own mission time, not at this frame's.
            if (tel != null && t > 1)
            {
                double? atHud = plan.O2LeftAt(tel.MetSeconds / 60.0);
                if (atHud.HasValue) worstHudO2 = Math.Max(worstHudO2, Math.Abs(tel.O2LeftL - atHud.Value));
            }
            trace.Append(F(t)).Append(',').Append(F(p.x)).Append(',').Append(F(p.y)).Append(',').Append(F(p.z)).Append(',')
                 .Append(F(app.Driver.LocalX)).Append(',').Append(F(app.Driver.LocalY)).Append(',')
                 .Append(o2.HasValue ? F(o2.Value) : "").Append(',').Append(margin.HasValue ? F(margin.Value) : "").Append(',')
                 .Append(plan.BindingAt(t)).Append(',')
                 .Append(tel != null ? F(tel.O2LeftL) : "").Append(',').Append(tel != null ? F(tel.MetSeconds / 60f) : "").Append(',')
                 .Append(tel != null ? F(tel.DistanceHomeM) : "").Append(',')
                 .Append(app.Driver.OnDetailedTerrain ? "1" : "0").Append('\n');
        }

        IEnumerator Shot(string name)
        {
            yield return new WaitForEndOfFrame();
            shot++;
            string path = Path.Combine(dir, shot.ToString("00") + "_" + name + ".png");
            try
            {
                Texture2D tex = ScreenCapture.CaptureScreenshotAsTexture();
                File.WriteAllBytes(path, tex.EncodeToPNG());
                Destroy(tex);
                Note("screenshot " + Path.GetFileName(path));
            }
            catch (Exception e)
            {
                Note("screenshot " + name + " failed: " + e.Message);
            }
        }

        void Check(bool ok, string what)
        {
            if (!ok) failures++;
            Note((ok ? "ok    " : "FAIL  ") + what);
        }

        void Note(string line)
        {
            log.Append(line).Append('\n');
            Debug.Log("[HOMELINE self-test] " + line);
        }

        void Finish()
        {
            if (finished) return;
            finished = true;
            try
            {
                File.WriteAllText(Path.Combine(dir, "result.txt"), (failures == 0 ? "PASS" : "FAIL (" + failures + ")") + "\n" + log);
                File.WriteAllText(Path.Combine(dir, "hud_trace.csv"), trace.ToString());
            }
            catch (Exception e)
            {
                Debug.LogError("[HOMELINE self-test] could not write results: " + e.Message);
            }
            Application.Quit(failures == 0 ? 0 : 1);
        }

        static float Dist(Vector3 p, float x, float z)
        {
            return Mathf.Sqrt((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z));
        }

        static string F(double v)
        {
            return v.ToString("0.###", CultureInfo.InvariantCulture);
        }

        static string V(Vector3 v)
        {
            return "(" + F(v.x) + ", " + F(v.y) + ", " + F(v.z) + ")";
        }

        static string Arg(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++)
                if (args[i] == name) return args[i + 1];
            return null;
        }
    }
}

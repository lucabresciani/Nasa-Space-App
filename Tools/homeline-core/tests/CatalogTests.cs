using System;
using System.Collections.Generic;
using System.IO;

namespace NasaSpaceApp.Homeline.Tests
{
    /// <summary>
    /// The five plans the planner engine precomputed (official pad and four alternative pads), read from the
    /// planner's published web data, plus a synthetic engine-service result tree. Expected values are the planner's.
    /// </summary>
    public static class CatalogTests
    {
        public static void Run(string fixture)
        {
            string web = ResolveWebData();
            if (web == null)
            {
                T.True(false, "planner web data not found (set HOMELINE_WEB to the planner's web/dist, or run Tools/homeline-data/fetch.ps1)");
                return;
            }

            string results = Path.Combine(Path.GetTempPath(), "homeline-test-results-" + Guid.NewGuid().ToString("N"));
            try
            {
                MakeSyntheticResult(web, results);
                PlanCatalog cat = PlanCatalog.Scan(web, results);
                T.True(cat.Plans.Count == 6, "5 precomputed plans + 1 live result, got " + cat.Plans.Count + " (" + string.Join("; ", cat.Warnings) + ")");
                T.Eq(cat.ScenarioId, "nom_104", "scenario of the precomputed plans");
                T.True(cat.StationsPath != null, "stations.json found");

                PlanEntry official = cat.Find("rank1");
                T.True(official != null && official.Origin == PlanOrigin.Official, "rank1 is the official plan");
                if (official == null) return;
                T.Eq(official.OriginLabel, "Precomputed · official plan", "official label (planner config/backend.yaml)");
                PlanEntry rank3 = cat.Find("rank3");
                T.True(rank3 != null && rank3.Note != null && rank3.Note.EndsWith("of rank 2", StringComparison.Ordinal),
                    "rank3 is flagged as next to rank 2: " + (rank3 == null ? "missing" : rank3.Note));

                // One frame for every plan: the planner's projection, origin at the official pad.
                PadFrame frame = MissionPlan.FrameAt(official.PadLon, official.PadLat, official.PadElevM ?? 0, Program.Scene);
                Dictionary<string, string> names = MissionPlan.ReadStationNames(cat.StationsPath);
                T.Eq(names.ContainsKey("S4") ? names["S4"] : null, "Gediz Vallis sulfur field", "station name from stations.json");

                // id, planned minutes, O2 left at return (planner timeline), stops
                var want = new[]
                {
                    new { Id = "rank1", Min = 325.94, O2 = 124.87, Stops = "S7 S6 S1 S4" },
                    new { Id = "rank2", Min = 326.03, O2 = 125.61, Stops = "S7 S6 S1 S4" },
                    new { Id = "rank3", Min = 326.49, O2 = 124.99, Stops = "S7 S6 S1 S4" },
                    new { Id = "rank4", Min = 320.66, O2 = 132.03, Stops = "S7 S6 S1 S4" },
                    new { Id = "pad_default", Min = 316.39, O2 = 137.09, Stops = "S4 S7 S6 S1" },
                };

                using (BundleReader bundle = BundleReader.Open(Path.Combine(fixture, "plan_bundle.zip")))
                {
                    foreach (var w in want)
                    {
                        PlanEntry e = cat.Find(w.Id);
                        T.True(e != null, "plan " + w.Id + " is in the catalog");
                        if (e == null) continue;
                        MissionPlan plan = MissionPlan.Load(e, frame, names, bundle, WaypointPlan.AssumedNavToleranceM);

                        T.Near(plan.EndMin, w.Min, 0.011, w.Id + " planned duration");
                        T.Near(plan.O2AtReturnL, w.O2, 0.011, w.Id + " O2 left at return");
                        T.Eq(string.Join(" ", plan.Route.Stops), w.Stops, w.Id + " station order");
                        T.True(plan.Track.Legs.Count == 5, w.Id + " has 5 legs");

                        // The planner's own bookkeeping must close: capacity - walking O2 - dwell O2 = O2 at return.
                        double dwell = 0;
                        foreach (TimelineDwell d in plan.Timeline.Dwells)
                        {
                            double? a = plan.Timeline.O2LeftAt(d.ArriveMin), l = plan.Timeline.O2LeftAt(d.LeaveMin);
                            if (a.HasValue && l.HasValue) dwell += a.Value - l.Value;
                        }
                        double? start = plan.Timeline.O2LeftAt(0);
                        T.True(plan.Route.WalkO2L.HasValue && start.HasValue, w.Id + " states per-leg O2");
                        if (plan.Route.WalkO2L.HasValue && start.HasValue)
                            T.Near(start.Value - plan.Route.WalkO2L.Value - dwell, w.O2, 0.06, w.Id + " legs + dwells = timeline O2 at return");

                        // Waypoints: pad, 4 stations, return; navigation points in between.
                        WaypointPlan wp = plan.Waypoints;
                        T.True(wp.Main.Count == 6 && wp.StationCount == 4, w.Id + " main waypoints: pad, 4 stations, return");
                        T.True(wp.NavCount >= 15 && wp.NavCount <= 35, w.Id + " navigation points at 30 m: " + wp.NavCount);
                        T.True(wp.Main[0].Kind == WaypointKind.Pad && wp.Main[5].Kind == WaypointKind.Return, w.Id + " starts and ends at the pad");
                        T.Near(Dist(wp.Main[0], wp.Main[5]), 0, 0.5, w.Id + " returns to where it started");
                        bool ordered = true;
                        for (int i = 1; i < wp.All.Count; i++) if (wp.All[i].ArriveMin < wp.All[i - 1].ArriveMin - 1e-9) ordered = false;
                        T.True(ordered, w.Id + " waypoints are in time order");

                        // Every vertex inside the detailed 1 m terrain of the Unity scene.
                        bool inside = true;
                        foreach (RouteLeg leg in plan.Track.Legs)
                        {
                            for (int i = 0; i < leg.X.Length; i++)
                            {
                                double wx, wz;
                                frame.LocalToWorld(leg.X[i], leg.Y[i], out wx, out wz);
                                if (wx < -2041.27 || wx > 2040.35 || wz < -2047.70 || wz > 2048.29) inside = false;
                            }
                        }
                        T.True(inside, w.Id + " route lies inside the detailed terrain");
                        T.True(plan.HasReturnFields == (w.Id == "rank1"), w.Id + " return fields only on the official plan");

                        if (w.Id == "rank1") OfficialChecks(plan, bundle);
                    }

                    PlanEntry live = null;
                    foreach (PlanEntry e in cat.Plans) if (e.Origin == PlanOrigin.Live) live = e;
                    T.True(live != null, "the engine-service result tree is offered as a live plan");
                    if (live != null)
                    {
                        T.Eq(live.OriginLabel, "Computed live · not part of the validated scorecard", "live label comes from run_record.json");
                        T.Eq(live.Title, "Test pad", "live title from the inputs");
                        MissionPlan plan = MissionPlan.Load(live, frame, names, bundle, WaypointPlan.AssumedNavToleranceM);
                        T.Near(plan.EndMin, 326.03, 0.011, "live plan loads with the same reader");
                        T.True(!plan.HasReturnFields, "live plan has no return fields");
                    }
                }
            }
            finally
            {
                try { if (Directory.Exists(results)) Directory.Delete(results, true); } catch (IOException) { }
            }
        }

        /// <summary>The official plan: timeline rows, and agreement with the simulator bundle's 1 m route.</summary>
        static void OfficialChecks(MissionPlan plan, BundleReader bundle)
        {
            WaypointPlan wp = plan.Waypoints;
            T.Eq(wp.Main[1].Id, "S7", "first station");
            T.Near(wp.Main[1].ArriveMin, 44.39, 0.011, "arrive S7");
            T.Near(wp.Main[1].LeaveMin ?? -1, 74.39, 0.011, "leave S7");
            T.Near(wp.Main[1].O2LeftArriveL, 425.91, 0.011, "O2 left arriving at S7");
            T.Near(wp.Main[1].O2LeftLeaveL, 400.79, 0.011, "O2 left leaving S7");
            T.Near(wp.Main[1].MarginArriveMin, 68.26, 0.011, "margin arriving at S7");
            T.Eq(wp.Main[1].Binding, "dose", "binding term at S7");
            T.Near(wp.Main[1].TurnBackMin ?? -1, 344.58, 0.011, "turn-back at S7");
            T.Eq(wp.Main[4].Id, "S4", "last station");
            T.Near(wp.Main[0].O2LeftArriveL, 482.31, 0.011, "O2 at departure");
            T.True(wp.NavCount == 25, "25 navigation points on the official plan at 30 m, got " + wp.NavCount);

            // Same route, two files: the web geojson (engine vertices) and the bundle's route.json (1 m rows).
            RouteTrack dense = RouteTrack.FromBundle(bundle);
            double worst = 0;
            for (int k = 0; k <= 40; k++)
            {
                double t = plan.EndMin * k / 40.0;
                RoutePose a = plan.Track.PoseAt(t), b = dense.PoseAt(t);
                worst = Math.Max(worst, Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y)));
            }
            T.True(worst < 1.5, "geojson route and bundle route agree at 41 instants (worst " + T.N(worst) + " m)");

            // Return fields: the timeline's T_home at S7 is what the field says at S7's position.
            T.Near(plan.THomeAt(wp.Main[1].X, wp.Main[1].Y), 45.42, 0.5, "T_home at S7 from the return field");
            T.Near(plan.THomeAt(plan.Route.PadX, plan.Route.PadY), 0, 0.25, "T_home at the pad");

            Waypoint next = wp.NextAfter(50, true);
            T.Eq(next == null ? null : next.Id, "S6", "next main waypoint while dwelling at S7");
        }

        static double Dist(Waypoint a, Waypoint b)
        {
            return Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y));
        }

        static void MakeSyntheticResult(string web, string results)
        {
            string dir = Path.Combine(results, "0123456789abcdef");
            Directory.CreateDirectory(dir);
            string src = Path.Combine(web, "scenarios", "pads", "rank2");
            File.Copy(Path.Combine(src, "route_nom_104.geojson"), Path.Combine(dir, "route_nom_104.geojson"));
            File.Copy(Path.Combine(src, "timeline_nom_104.json"), Path.Combine(dir, "timeline_nom_104.json"));
            // Shape of contracts/backend/examples/run_record.live.json (planner repository).
            File.WriteAllText(Path.Combine(dir, "run_record.json"),
                "{\"contract_version\":\"1.0.0\",\"hash\":\"0123456789abcdef\",\"origin\":\"computed_live\"," +
                "\"label\":\"Computed live · not part of the validated scorecard\"," +
                "\"inputs\":{\"contract_version\":\"1.0.0\",\"title\":\"Test pad\",\"pad\":{\"lon\":137.393301,\"lat\":-4.776468}}," +
                "\"status\":\"done\",\"dummy\":false}");
            // An unfinished tree (no run_record.json) must be ignored.
            Directory.CreateDirectory(Path.Combine(results, "ffffffffffffffff"));
        }

        static string ResolveWebData()
        {
            var candidates = new List<string>();
            string env = Environment.GetEnvironmentVariable("HOMELINE_WEB");
            if (!string.IsNullOrEmpty(env)) candidates.Add(Path.Combine(env, "data"));
            string dir = AppContext.BaseDirectory;
            for (int up = 0; up < 10 && dir != null; up++)
            {
                candidates.Add(Path.Combine(dir, "HomelineData", "web", "data"));
                candidates.Add(Path.Combine(dir, "home-line", "web", "dist", "data"));
                dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            }
            foreach (string c in candidates)
                if (File.Exists(Path.Combine(c, "route_nom_104.geojson"))) return Path.GetFullPath(c);
            return null;
        }
    }
}

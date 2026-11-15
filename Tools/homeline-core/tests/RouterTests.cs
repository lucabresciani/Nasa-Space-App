using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

namespace NasaSpaceApp.Homeline.Tests
{
    /// <summary>
    /// The simulator's re-router against the planner: (1) each planned leg routed between the planner's own station
    /// points must take the planner's time and O2; (2) the plan re-built by the editor with no station moved must
    /// reproduce the planner's timeline (times, O2 left, margin, binding limit); (3) a moved station gives a plan.
    /// Needs HomelineData/router next to the bundle (Tools/homeline-data/make_router_grid.py); skipped without it.
    /// </summary>
    public static class RouterTests
    {
        public static void Run(string fixture)
        {
            T.Group("router");
            string dir = Path.Combine(Path.GetDirectoryName(fixture.TrimEnd('/', '\\')), "router");
            GridRouter router = GridRouter.Load(dir);
            if (router == null)
            {
                // The planner's fixture folder has no router data: use the project's own HomelineData.
                dir = Path.Combine(Directory.GetCurrentDirectory(), "HomelineData", "router");
                router = GridRouter.Load(dir);
            }
            if (router == null)
            {
                Console.WriteLine("  router: no data in " + dir + " (run Tools/homeline-data/make_router_grid.py); skipped");
                return;
            }
            using (BundleReader bundle = BundleReader.Open(Path.Combine(fixture, "plan_bundle.zip")))
            {
                HlConfig cfg = HlConfig.FromBundle(bundle);
                RouteTrack track = RouteTrack.FromBundle(bundle);
                Timeline timeline = Timeline.FromBundle(bundle);
                var frame = new PadFrame(bundle.Index.Frame, new SceneGeo(0, 0, 1, 1, 0, 0));

                // (1) the five planned legs, from the planner's first to last row of each leg.
                double[] wantMin = { 44.39, 54.10, 43.45, 52.65, 11.36 };
                double[] wantO2 = { 56.40, 68.61, 58.14, 62.04, 11.76 };
                var stops = new List<EditStop>();
                var sw = Stopwatch.StartNew();
                for (int i = 0; i < track.Legs.Count; i++)
                {
                    RouteLeg leg = track.Legs[i];
                    int n = leg.X.Length;
                    RoutedLeg r = router.Route(leg.X[0], leg.Y[0], leg.X[n - 1], leg.Y[n - 1]);
                    T.True(r != null, "leg " + (i + 1) + " routes");
                    if (r == null) continue;
                    T.Near(r.TimeMin, wantMin[i], 0.06, "leg " + (i + 1) + " time, min");
                    T.Near(r.O2TotalL, wantO2[i], 0.15, "leg " + (i + 1) + " O2, L");
                    if (i < track.Legs.Count - 1)
                        stops.Add(new EditStop { Id = leg.To, X = leg.X[n - 1], Y = leg.Y[n - 1], DwellMin = track.Legs[i + 1].StartMin - leg.EndMin });
                }
                Console.WriteLine("  router: 5 legs in " + sw.ElapsedMilliseconds + " ms");

                // (2) the editor with nothing moved against the planner's timeline.
                var ctx = new EditContext
                {
                    Router = router, Config = cfg, Storm = StormTrack.FromBundle(bundle),
                    TDarkMin = HlJson.NumOrNull(bundle.ReadJson("conditions/sun.json"), "t_dark_min"),
                    THome = bundle.ReadGrid("fields/t_home.f32"), O2Home = bundle.ReadGrid("fields/o2_home.f32"),
                    PadX = track.Legs[0].X[0], PadY = track.Legs[0].Y[0], Scenario = "nom_104",
                };
                EditedPlanData same = PlanEditor.Build(ctx, frame, stops);
                T.True(same != null, "the unedited plan re-builds");
                if (same == null) return;
                T.Near(same.EndMin, 325.94, 0.1, "re-built plan ends at the planner's minute");
                T.Near(same.O2AtReturnL, 124.87, 0.3, "re-built plan O2 at the return, L");
                T.Near(same.Storm.TStarMin, 44.39, 0.2, "storm tripwire re-timed to the same minute (the way home is longest just before S7)");
                Timeline rebuilt = Timeline.Parse(same.TimelineRows);
                int compared = 0;
                double worstMargin = 0, worstO2 = 0;
                foreach (TimelineRow want in timeline.Events)
                {
                    TimelineRow got = null;
                    foreach (TimelineRow g in rebuilt.Events)
                        if (g.Event == want.Event && g.Station == want.Station && Math.Abs(g.TMin - want.TMin) < 0.1) got = g;
                    T.True(got != null, "row " + want.Event + " " + want.Station + " at " + T.N(want.TMin) + " min exists in the re-built timeline");
                    if (got == null || !want.MarginMin.HasValue || !got.MarginMin.HasValue) continue;
                    compared++;
                    worstMargin = Math.Max(worstMargin, Math.Abs(got.MarginMin.Value - want.MarginMin.Value));
                    worstO2 = Math.Max(worstO2, Math.Abs(got.O2LeftL.Value - want.O2LeftL.Value));
                    T.Near(got.MarginMin.Value, want.MarginMin.Value, 1.0, "margin at " + T.N(want.TMin) + " min (" + want.Event + ")");
                    T.Eq(got.MarginBinding, want.MarginBinding, "binding limit at " + T.N(want.TMin) + " min");
                    T.Near(got.O2LeftL.Value, want.O2LeftL.Value, 0.3, "O2 left at " + T.N(want.TMin) + " min");
                }
                T.True(compared >= 18, "timeline rows compared (" + compared + ")");
                Console.WriteLine("  editor, nothing moved: " + compared + " rows, worst margin difference " + T.N(worstMargin) +
                                  " min, worst O2 difference " + T.N(worstO2) + " L");

                // (3) S6 moved 90 m south (prototype: S7->S6' 52.60 min, S6'->S1 42.29 min).
                stops[1].Y -= 90;
                sw.Restart();
                EditedPlanData moved = PlanEditor.Build(ctx, frame, stops);
                T.True(moved != null, "plan with S6 moved 90 m south re-builds");
                if (moved != null)
                {
                    Console.WriteLine("  editor, S6 moved 90 m south: " + sw.ElapsedMilliseconds + " ms; ends at " + T.N(moved.EndMin) + " min, O2 at return " +
                                      T.N(moved.O2AtReturnL) + " L, smallest margin " + T.N(moved.MinMarginMin) + " min (" + moved.MinMarginBinding +
                                      ") at " + moved.MinMarginWhere);
                    T.Near(moved.EndMin, 325.94 + (52.60 - 54.10) + (42.29 - 43.45), 0.3, "moved plan duration follows the two re-routed legs");
                    T.True(moved.Feasible, "moved plan keeps a positive margin");
                }
                stops[1].Y += 90;
                stops[1].X += 4000; // far outside the passable ground
                T.True(PlanEditor.Build(ctx, frame, stops) == null, "a station on impassable ground gives no plan");
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;

namespace NasaSpaceApp.Homeline.Tests
{
    /// <summary>
    /// The free-walk oxygen accounting, checked the only way it can be without a person: walk the planner's own
    /// planned route (the bundle's 1 m track, at the planned speeds, working the planned dwell at each station) and
    /// compare the oxygen left with the planner's timeline.
    /// </summary>
    public static class LiveStateTests
    {
        public static void Run(string fixture)
        {
            using (BundleReader bundle = BundleReader.Open(Path.Combine(fixture, "plan_bundle.zip")))
            {
                HlConfig cfg = HlConfig.FromBundle(bundle);
                var physio = new Physio(cfg);
                RouteTrack track = RouteTrack.FromBundle(bundle);
                Timeline timeline = Timeline.FromBundle(bundle);

                var stations = new List<LiveStation>();
                for (int i = 0; i < track.Legs.Count - 1; i++)
                {
                    RouteLeg leg = track.Legs[i];
                    int n = leg.X.Length;
                    stations.Add(new LiveStation
                    {
                        Id = leg.To, X = leg.X[n - 1], Y = leg.Y[n - 1],
                        DwellMin = track.Legs[i + 1].StartMin - leg.EndMin,
                    });
                }
                var live = new LiveState(physio, cfg.O2CapacityL, cfg.TaskRateLMin, stations);
                live.Reset(0, 0, null);

                double worstAtRow = 0;
                foreach (RouteLeg leg in track.Legs)
                {
                    // Walk the leg row by row at the planned times.
                    for (int i = 0; i < leg.X.Length; i++)
                    {
                        double z = leg.Z[i] ?? 0;
                        double dt = i == 0 ? 1e-3 : (leg.T[i] - leg.T[i - 1]) * 60.0;
                        if (dt <= 0) dt = 1e-3;
                        live.Step(dt, leg.X[i], leg.Y[i], z);
                    }
                    double? want = timeline.O2LeftAt(leg.EndMin);
                    if (want.HasValue) worstAtRow = Math.Max(worstAtRow, Math.Abs(live.O2LeftL - want.Value));

                    // Work the planned dwell, standing at the station.
                    int last = leg.X.Length - 1;
                    LiveStation here = null;
                    foreach (LiveStation st in stations) if (st.Id == leg.To) here = st;
                    if (here != null)
                    {
                        int seconds = (int)Math.Round(here.DwellMin * 60.0);
                        for (int k = 0; k < seconds; k++) live.Step(1.0, leg.X[last], leg.Y[last], leg.Z[last] ?? 0);
                        T.True(here.Done, "dwell at " + here.Id + " completes");
                        T.True(live.AtStation == null || live.AtStation.Id == here.Id, "working at " + here.Id);
                    }
                }

                T.True(live.StationsDone == 4, "4 stations worked (" + live.StationsDone + ")");
                T.Near(live.TMin, 325.94, 0.05, "EVA clock at the return");
                double? end = timeline.O2LeftAt(325.94);
                T.True(end.HasValue, "timeline has O2 at the return");
                if (end.HasValue)
                    T.Near(live.O2LeftL, end.Value, 2.5, "O2 left at the return, live model vs planner timeline (L)");
                T.True(worstAtRow < 2.5, "O2 left at every leg end within 2.5 L of the planner (worst " + T.N(worstAtRow) + " L)");
                Console.WriteLine("  live O2 at return " + T.N(Math.Round(live.O2LeftL, 2)) + " L, planner " + (end.HasValue ? T.N(end.Value) : "?") +
                                  " L; worst leg-end difference " + T.N(Math.Round(worstAtRow, 2)) + " L");

                // Standing away from any station burns the resting rate; the cap is the planner's governed speed.
                var idle = new LiveState(physio, cfg.O2CapacityL, cfg.TaskRateLMin, null);
                idle.Reset(0, 0, null);
                for (int k = 0; k < 600; k++) idle.Step(1.0, 100, 100, 0);
                T.Near(idle.O2UsedL, physio.RestO2RateLMin * 10.0, 1e-6, "10 minutes standing = 10 x the resting rate");
                T.Near(idle.SpeedCapMs ?? -1, 0.912, 0.002, "speed cap on level ground is the planner's governed speed");

                // Taking over from the replay: state is inherited, stations already left are not worked again.
                live.Reset(100, 150, st => st.Id == "S7");
                T.Near(live.O2LeftL, cfg.O2CapacityL - 150, 1e-9, "reset inherits the O2 used");
                T.True(live.StationsDone == 1, "reset marks the stations already left as done");
            }
        }
    }
}

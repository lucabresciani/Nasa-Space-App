using System;
using System.Collections.Generic;

namespace NasaSpaceApp.Homeline
{
    public enum WaypointKind
    {
        /// <summary>The rover parking spot: start of the EVA.</summary>
        Pad,
        /// <summary>A science station, at its access point (the end of the leg that reaches it).</summary>
        Station,
        /// <summary>A bend of the planned track, derived by the simulator. Not planner output.</summary>
        Nav,
        /// <summary>Back at the pad: end of the EVA.</summary>
        Return,
    }

    public sealed class Waypoint
    {
        public WaypointKind Kind;
        /// <summary>Position in the whole list, 0 = the pad at departure.</summary>
        public int Seq;
        /// <summary>"pad", a station id ("S7"), or "N3.2" (third leg, second navigation point).</summary>
        public string Id;
        public string Name;
        /// <summary>Index in <see cref="RouteTrack.Legs"/> of the leg that arrives here; -1 for the departure pad.</summary>
        public int LegIndex;
        /// <summary>Distance along that leg, metres.</summary>
        public double SLegM;
        /// <summary>Position in the frame's metres (x east, y north).</summary>
        public double X, Y;
        /// <summary>Planned arrival, EVA minutes.</summary>
        public double ArriveMin;
        /// <summary>Planned departure (stations and the pad); null for navigation points and the return.</summary>
        public double? LeaveMin;
        /// <summary>Planner timeline at arrival: O2 left (L), margin (min) and the term that binds it. Navigation points: interpolated.</summary>
        public double? O2LeftArriveL;
        public double? O2LeftLeaveL;
        public double? MarginArriveMin;
        public string Binding;
        /// <summary>Stations: the planner's latest departure that still keeps the margin non-negative, EVA minutes.</summary>
        public double? TurnBackMin;

        public bool IsMain { get { return Kind != WaypointKind.Nav; } }
    }

    /// <summary>
    /// The waypoints of a mission, generated from a planner route and its timeline.
    ///
    /// The planner has no "waypoint" object: a plan is a pad, an ordered list of stations and the routed track
    /// (pipeline/engine/traverse.py). The MAIN waypoints here are exactly those: the pad, each station at the end of
    /// the leg that reaches it, and the return, with the planner's own arrival and departure times, O2 left and margin
    /// (timeline rows). The NAVIGATION points in between are the bends of the planner's track, found by a
    /// Douglas-Peucker simplification of each leg: a derivation of the simulator, to be labelled as such
    /// ("derived by the simulator, not planner output"). Their time is the planner's time at that vertex; their O2 and
    /// margin are interpolated from the timeline.
    /// </summary>
    public sealed class WaypointPlan
    {
        /// <summary>
        /// ASSUMPTION of the simulator (the planner defines no navigation points): a bend is kept when dropping it
        /// would move the drawn track by more than this many metres.
        /// </summary>
        public const double AssumedNavToleranceM = 30.0;

        readonly List<Waypoint> all = new List<Waypoint>();
        readonly List<Waypoint> main = new List<Waypoint>();

        /// <summary>Every waypoint in the order it is reached.</summary>
        public IReadOnlyList<Waypoint> All { get { return all; } }
        /// <summary>Pad, stations and return only.</summary>
        public IReadOnlyList<Waypoint> Main { get { return main; } }
        public int StationCount { get; private set; }
        public int NavCount { get; private set; }
        public double NavToleranceM { get; private set; }

        public static WaypointPlan Build(RouteTrack track, Timeline timeline, Func<string, string> stationName, double navToleranceM)
        {
            var plan = new WaypointPlan();
            plan.NavToleranceM = navToleranceM;
            if (track.Legs.Count == 0) return plan;

            RouteLeg firstLeg = track.Legs[0];
            var pad = new Waypoint
            {
                Kind = WaypointKind.Pad, Id = "pad", Name = "Rover (pad)", LegIndex = -1, SLegM = 0,
                X = firstLeg.X[0], Y = firstLeg.Y[0], ArriveMin = firstLeg.StartMin, LeaveMin = firstLeg.StartMin,
            };
            Fill(pad, timeline, pad.ArriveMin);
            pad.O2LeftLeaveL = pad.O2LeftArriveL;
            plan.Add(pad);

            for (int li = 0; li < track.Legs.Count; li++)
            {
                RouteLeg leg = track.Legs[li];
                int n = leg.X.Length;
                bool[] keep = Simplify(leg.X, leg.Y, navToleranceM);
                int navInLeg = 0;
                for (int i = 1; i < n - 1; i++)
                {
                    if (!keep[i]) continue;
                    navInLeg++;
                    var nav = new Waypoint
                    {
                        Kind = WaypointKind.Nav, Id = "N" + leg.Number + "." + navInLeg, Name = "Navigation point",
                        LegIndex = li, SLegM = leg.S[i] - leg.S[0], X = leg.X[i], Y = leg.Y[i], ArriveMin = leg.T[i],
                    };
                    Fill(nav, timeline, nav.ArriveMin);
                    plan.Add(nav);
                    plan.NavCount++;
                }

                bool last = li == track.Legs.Count - 1;
                var end = new Waypoint
                {
                    LegIndex = li, SLegM = leg.S[n - 1] - leg.S[0], X = leg.X[n - 1], Y = leg.Y[n - 1], ArriveMin = leg.EndMin,
                };
                if (last || leg.To == "pad")
                {
                    end.Kind = WaypointKind.Return;
                    end.Id = "pad";
                    end.Name = "Rover (pad)";
                    Fill(end, timeline, end.ArriveMin);
                }
                else
                {
                    end.Kind = WaypointKind.Station;
                    end.Id = leg.To;
                    string name = stationName != null ? stationName(leg.To) : null;
                    end.Name = string.IsNullOrEmpty(name) ? leg.To : name;
                    end.LeaveMin = track.Legs[li + 1].StartMin;
                    Fill(end, timeline, end.ArriveMin);
                    if (timeline != null)
                    {
                        end.O2LeftLeaveL = timeline.O2LeftAt(end.LeaveMin.Value);
                        TimelineTurnBack tb = timeline.TurnBackFor(leg.To);
                        if (tb != null) end.TurnBackMin = tb.TMin;
                    }
                    plan.StationCount++;
                }
                plan.Add(end);
            }
            return plan;
        }

        /// <summary>The first waypoint planned to be reached strictly after EVA minute t; null at the end.</summary>
        public Waypoint NextAfter(double tEvaMin, bool mainOnly)
        {
            IReadOnlyList<Waypoint> list = mainOnly ? (IReadOnlyList<Waypoint>)main : all;
            for (int i = 0; i < list.Count; i++)
                if (list[i].ArriveMin > tEvaMin + 1e-9 && list[i].Kind != WaypointKind.Pad) return list[i];
            return null;
        }

        /// <summary>"4 stations + 25 navigation points."</summary>
        public string CountText()
        {
            return StationCount + (StationCount == 1 ? " station + " : " stations + ") + NavCount +
                   (NavCount == 1 ? " navigation point" : " navigation points");
        }

        void Add(Waypoint w)
        {
            w.Seq = all.Count;
            all.Add(w);
            if (w.IsMain) main.Add(w);
        }

        static void Fill(Waypoint w, Timeline timeline, double t)
        {
            if (timeline == null) return;
            w.O2LeftArriveL = timeline.O2LeftAt(t);
            w.MarginArriveMin = MarginAt(timeline, t);
            w.Binding = timeline.BindingAt(t);
        }

        /// <summary>
        /// The planner's margin at EVA minute t, interpolated between the timeline rows (the convention of the
        /// planner's own web HUD). Between rows it is an interpolation, not the engine formula: label it so.
        /// </summary>
        public static double? MarginAt(Timeline timeline, double tEvaMin)
        {
            if (timeline == null) return null;
            var ts = new List<double>();
            var vs = new List<double>();
            foreach (TimelineRow r in timeline.Events)
            {
                if (!r.MarginMin.HasValue) continue;
                ts.Add(r.TMin);
                vs.Add(r.MarginMin.Value);
            }
            if (ts.Count == 0) return null;
            return Timeline.InterpSeries(ts.ToArray(), vs.ToArray(), tEvaMin);
        }

        /// <summary>Douglas-Peucker: which vertices of the polyline survive at the given tolerance (ends always do).</summary>
        public static bool[] Simplify(double[] x, double[] y, double toleranceM)
        {
            int n = x.Length;
            var keep = new bool[n];
            if (n == 0) return keep;
            keep[0] = true;
            keep[n - 1] = true;
            if (n < 3) return keep;
            var stack = new Stack<int>();
            stack.Push(0);
            stack.Push(n - 1);
            while (stack.Count > 0)
            {
                int b = stack.Pop();
                int a = stack.Pop();
                double worst = -1;
                int at = -1;
                for (int i = a + 1; i < b; i++)
                {
                    double d = SegmentDistance(x[i], y[i], x[a], y[a], x[b], y[b]);
                    if (d > worst)
                    {
                        worst = d;
                        at = i;
                    }
                }
                if (at >= 0 && worst > toleranceM)
                {
                    keep[at] = true;
                    stack.Push(a);
                    stack.Push(at);
                    stack.Push(at);
                    stack.Push(b);
                }
            }
            return keep;
        }

        static double SegmentDistance(double px, double py, double ax, double ay, double bx, double by)
        {
            double dx = bx - ax, dy = by - ay;
            double len2 = dx * dx + dy * dy;
            double t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
            double cx = ax + t * dx, cy = ay + t * dy;
            return Math.Sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
        }
    }
}

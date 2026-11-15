using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// Where the planned EVA is at a given time, the phases of web/src/hud/plan.ts (PlanState.phase):
    /// Before = t at or before the first departure, Walk = on a leg (both ends included),
    /// Dwell = strictly between a leg's end and the next leg's start, After = past the last leg's end.
    /// </summary>
    public enum RoutePhase
    {
        Before,
        Walk,
        Dwell,
        After
    }

    /// <summary>
    /// One leg of route.json (contracts/bundle/route_local.schema.json): its legs[] entry plus its rows as column
    /// arrays. Rows are every 1 m of horizontal arc length along the engine's polyline, plus the leg's last vertex.
    /// </summary>
    public sealed class RouteLeg
    {
        /// <summary>Position of this leg in <see cref="RouteTrack.Legs"/>, 0-based.</summary>
        public int Index;
        /// <summary>The planner's leg number (legs[].leg, 1-based).</summary>
        public int Number;
        /// <summary>"pad" or a station id.</summary>
        public string From;
        public string To;
        public double StartMin;
        public double EndMin;
        /// <summary>The engine's length of the leg (legs[].length_m); null when the file does not state it.</summary>
        public double? StatedLengthM;
        /// <summary>Horizontal arc length of the rows (s_m of the last row): the scale of every s in this class.</summary>
        public double ArcLengthM;
        public int FirstRow;
        public int RowCount;
        /// <summary>
        /// True when the row times of the file could not be used (not non-decreasing) and <see cref="T"/> holds uniform
        /// speed between StartMin and EndMin instead: assumption A-WS7-1 of web/src/hud/plan.ts, the fallback of
        /// web/src/fp3d/path.ts. False for the official bundle.
        /// </summary>
        public bool AssumedUniformTimes;

        /// <summary>Metres along the leg (horizontal).</summary>
        public double[] S;
        /// <summary>Pad-local east, metres.</summary>
        public double[] X;
        /// <summary>Pad-local north, metres.</summary>
        public double[] Y;
        /// <summary>Pad-local up, metres; null where no terrain covers the point.</summary>
        public double?[] Z;
        /// <summary>Planned EVA minute at each row (non-decreasing).</summary>
        public double[] T;
        /// <summary>Planned speed to the next row, m/s; null on the last row.</summary>
        public double?[] SpeedMs;
        /// <summary>Route grade to the next row, degrees; null on the last row.</summary>
        public double?[] GradeDeg;
        /// <summary>Terrain slope of the 5 m field at the row, degrees.</summary>
        public double?[] SlopeDeg;

        /// <summary>The planner's length when stated, else the arc length of the rows.</summary>
        public double LengthM { get { return StatedLengthM.HasValue ? StatedLengthM.Value : ArcLengthM; } }
    }

    /// <summary>The planned state at one EVA time (PlanState of web/src/hud/plan.ts, Pose of web/src/fp3d/path.ts).</summary>
    public struct RoutePose
    {
        /// <summary>The EVA minute asked for.</summary>
        public double TEvaMin;
        /// <summary>Pad-local east, metres.</summary>
        public double X;
        /// <summary>Pad-local north, metres.</summary>
        public double Y;
        /// <summary>Pad-local up, metres; null = no terrain height in the route rows here.</summary>
        public double? Z;
        /// <summary>Bearing, degrees clockwise from north; null only when the leg has no extent.</summary>
        public double? HeadingDeg;
        public RoutePhase Phase;
        /// <summary>
        /// Index in <see cref="RouteTrack.Legs"/> of the leg this pose lies on: the leg walked (Walk), the leg just
        /// completed (Dwell), the first leg (Before), the last leg (After); -1 when the route has no legs.
        /// </summary>
        public int LegIndex;
        /// <summary>The planner's number of that leg (1-based); 0 when the route has no legs.</summary>
        public int LegNumber;
        /// <summary>Station id while dwelling, else null.</summary>
        public string Station;
        /// <summary>0..1 through the dwell; null outside a dwell.</summary>
        public double? DwellFraction;
        /// <summary>Metres along the leg (row s_m scale).</summary>
        public double SLegM;
        /// <summary>Metres along the route since the EVA start (row s_m scale).</summary>
        public double DistanceWalkedM;
        /// <summary>
        /// Planned walking speed, m/s: the row's speed_ms while walking (null where the file has none), 0 while
        /// dwelling (the plan keeps the crew at the station), null before the departure and after the return.
        /// </summary>
        public double? SpeedMs;
    }

    /// <summary>Points of one leg of route.json for drawing, decimated; see <see cref="RouteTrack.LegPolyline"/>.</summary>
    public sealed class RoutePolyline
    {
        public int LegIndex;
        /// <summary>Metres along the leg of each point.</summary>
        public double[] S;
        public double[] X;
        public double[] Y;
        /// <summary>null where the route rows have no terrain height.</summary>
        public double?[] Z;
        public int Count { get { return X.Length; } }
    }

    /// <summary>
    /// The planned route of a plan bundle as a function of EVA time: route.json (contracts/bundle/README.md,
    /// contracts/bundle/route_local.schema.json; columns leg, s_m, x_m, y_m, z_m, t_eva_min, speed_ms, grade_deg,
    /// slope_deg). Ports the planned-position logic of web/src/hud/plan.ts (stateAt: phases, dwell = the gap between a
    /// leg's end and the next leg's start, distance walked) and the camera heading of web/src/fp3d/path.ts (bearing to
    /// the point a look-ahead distance further along). Lookups and linear interpolation only: positions and times are
    /// the planner's rows, nothing is re-routed or re-timed.
    /// Difference from path.ts, on purpose: the look-ahead stays on the leg being walked (path.ts runs it on into the
    /// following leg). Within the last look-ahead distance of a leg the heading is the bearing of the chord that ends
    /// at the leg's end, so it does not jump on arrival and stays fixed through the dwell.
    /// </summary>
    public sealed class RouteTrack
    {
        /// <summary>
        /// Look-ahead used when the caller passes none. The planner's value is config_snapshot.json
        /// files["fp3d.yaml"].path.look_ahead_m (15 in the official bundle): read it with <see cref="LookAheadFromConfig"/>.
        /// </summary>
        public const double DefaultLookAheadM = 15.0;

        static readonly string[] ColumnNames = { "leg", "s_m", "x_m", "y_m", "z_m", "t_eva_min", "speed_ms", "grade_deg", "slope_deg" };

        readonly RouteLeg[] legs;
        readonly double[] arcBefore;

        public IReadOnlyList<RouteLeg> Legs { get { return legs; } }
        public string Scenario { get; private set; }
        /// <summary>Row spacing of the file, metres (step_m).</summary>
        public double StepM { get; private set; }
        /// <summary>Planned departure (first leg's start); 0 when the route has no legs.</summary>
        public double StartMin { get; private set; }
        /// <summary>Planned return to the pad (last leg's end); 0 when the route has no legs.</summary>
        public double EndMin { get; private set; }
        /// <summary>Sum of the leg lengths the planner states (<see cref="RouteLeg.LengthM"/>).</summary>
        public double TotalLengthM { get; private set; }
        /// <summary>Sum of the legs' row arc lengths: the value <see cref="RoutePose.DistanceWalkedM"/> ends at.</summary>
        public double TotalArcM { get; private set; }

        RouteTrack(RouteLeg[] legs)
        {
            this.legs = legs;
            arcBefore = new double[legs.Length + 1];
            double stated = 0;
            for (int i = 0; i < legs.Length; i++)
            {
                legs[i].Index = i;
                arcBefore[i + 1] = arcBefore[i] + legs[i].ArcLengthM;
                stated += legs[i].LengthM;
            }
            TotalArcM = arcBefore[legs.Length];
            TotalLengthM = stated;
            StartMin = legs.Length > 0 ? legs[0].StartMin : 0;
            EndMin = legs.Length > 0 ? legs[legs.Length - 1].EndMin : 0;
        }

        /// <summary>Reads route.json of a plan bundle.</summary>
        public static RouteTrack FromBundle(BundleReader plan)
        {
            return Parse(plan.ReadJson("route.json"));
        }

        /// <summary>Parses a route.json document (contracts/bundle/route_local.schema.json).</summary>
        public static RouteTrack Parse(JToken route)
        {
            if (route == null || route.Type != JTokenType.Object) throw new InvalidDataException("route.json is not an object");
            string frame = HlJson.Str(route, "frame");
            if (frame != "pad-local") throw new InvalidDataException("route.json frame is not pad-local: " + frame);
            JArray cols = route["columns"] as JArray;
            JArray rows = route["rows"] as JArray;
            JArray legArr = route["legs"] as JArray;
            if (cols == null || rows == null || legArr == null) throw new InvalidDataException("route.json needs columns, legs and rows");

            var at = new int[ColumnNames.Length];
            for (int c = 0; c < ColumnNames.Length; c++)
            {
                at[c] = -1;
                for (int k = 0; k < cols.Count; k++)
                    if (cols[k].Type == JTokenType.String && (string)cols[k] == ColumnNames[c]) at[c] = k;
                // z, speed, grade and slope may be null in any row; the others are needed to place and time the crew.
                if (at[c] < 0 && (c <= 3 || c == 5)) throw new InvalidDataException("route.json has no column " + ColumnNames[c]);
            }

            var list = new List<RouteLeg>();
            foreach (JToken lj in legArr)
            {
                var g = new RouteLeg();
                g.Number = (int)HlJson.Num(lj, "leg");
                g.From = HlJson.Str(lj, "from");
                g.To = HlJson.Str(lj, "to");
                g.StartMin = HlJson.Num(lj, "t_start_min");
                g.EndMin = HlJson.Num(lj, "t_end_min");
                g.StatedLengthM = HlJson.NumOrNull(lj, "length_m");
                g.FirstRow = (int)HlJson.Num(lj, "first_row");
                g.RowCount = (int)HlJson.Num(lj, "n_rows");
                if (g.RowCount < 1 || g.FirstRow < 0 || g.FirstRow + g.RowCount > rows.Count)
                    throw new InvalidDataException("route.json leg " + g.Number + " points outside the rows");
                if (!(g.EndMin >= g.StartMin)) throw new InvalidDataException("route.json leg " + g.Number + " ends before it starts");

                int n = g.RowCount;
                g.S = new double[n];
                g.X = new double[n];
                g.Y = new double[n];
                g.T = new double[n];
                g.Z = new double?[n];
                g.SpeedMs = new double?[n];
                g.GradeDeg = new double?[n];
                g.SlopeDeg = new double?[n];
                bool timesOk = true;
                for (int i = 0; i < n; i++)
                {
                    JArray r = rows[g.FirstRow + i] as JArray;
                    if (r == null || r.Count < cols.Count) throw new InvalidDataException("route.json row " + (g.FirstRow + i) + " is malformed");
                    if ((int)HlJson.ToDouble(r[at[0]]) != g.Number)
                        throw new InvalidDataException("route.json row " + (g.FirstRow + i) + " is not of leg " + g.Number);
                    g.S[i] = HlJson.ToDouble(r[at[1]]);
                    g.X[i] = HlJson.ToDouble(r[at[2]]);
                    g.Y[i] = HlJson.ToDouble(r[at[3]]);
                    g.Z[i] = at[4] < 0 ? null : HlJson.Nullable(r[at[4]]);
                    g.T[i] = HlJson.ToDouble(r[at[5]]);
                    g.SpeedMs[i] = at[6] < 0 ? null : HlJson.Nullable(r[at[6]]);
                    g.GradeDeg[i] = at[7] < 0 ? null : HlJson.Nullable(r[at[7]]);
                    g.SlopeDeg[i] = at[8] < 0 ? null : HlJson.Nullable(r[at[8]]);
                    if (i > 0 && !(g.S[i] > g.S[i - 1]))
                        throw new InvalidDataException("route.json leg " + g.Number + ": s_m does not grow at row " + (g.FirstRow + i));
                    if (i > 0 && !(g.T[i] >= g.T[i - 1])) timesOk = false;
                }
                g.ArcLengthM = g.S[n - 1] - g.S[0];
                if (!timesOk)
                {
                    // path.ts: times that are not non-decreasing are not used; the leg is walked at uniform speed.
                    g.AssumedUniformTimes = true;
                    for (int i = 0; i < n; i++)
                        g.T[i] = g.ArcLengthM > 0 ? g.StartMin + (g.EndMin - g.StartMin) * (g.S[i] - g.S[0]) / g.ArcLengthM : g.EndMin;
                }
                list.Add(g);
            }
            // plan.ts walks the legs in the order of their `leg` number (a stable sort).
            for (int i = 1; i < list.Count; i++)
            {
                RouteLeg g = list[i];
                int k = i - 1;
                while (k >= 0 && list[k].Number > g.Number)
                {
                    list[k + 1] = list[k];
                    k--;
                }
                list[k + 1] = g;
            }
            var track = new RouteTrack(list.ToArray());
            track.Scenario = HlJson.Str(route, "scenario");
            track.StepM = HlJson.NumOrNull(route, "step_m") ?? 1.0;
            return track;
        }

        /// <summary>
        /// The planner's camera look-ahead, config_snapshot.json files["fp3d.yaml"].path.look_ahead_m; null when the
        /// snapshot does not state it.
        /// </summary>
        public static double? LookAheadFromConfig(JToken configSnapshot)
        {
            JToken files = configSnapshot != null && configSnapshot.Type == JTokenType.Object ? configSnapshot["files"] : null;
            JToken fp3d = files != null && files.Type == JTokenType.Object ? files["fp3d.yaml"] : null;
            JToken path = fp3d != null && fp3d.Type == JTokenType.Object ? fp3d["path"] : null;
            return HlJson.NumOrNull(path, "look_ahead_m");
        }

        /// <summary>Row arc length walked before leg <paramref name="legIndex"/> starts (legIndex = Legs.Count gives the total).</summary>
        public double ArcBefore(int legIndex)
        {
            return arcBefore[legIndex];
        }

        /// <summary>
        /// Planned pose at EVA minute <paramref name="tEvaMin"/> (stateAt of plan.ts). The heading is the bearing to the
        /// point <paramref name="lookAheadM"/> further along the same leg (path.ts), see the class comment.
        /// </summary>
        public RoutePose PoseAt(double tEvaMin, double lookAheadM = DefaultLookAheadM)
        {
            var p = new RoutePose();
            p.TEvaMin = tEvaMin;
            if (legs.Length == 0)
            {
                // An empty route is a plan that stays at the pad, the origin of the frame (plan.ts).
                p.Phase = RoutePhase.Before;
                p.LegIndex = -1;
                return p;
            }
            RouteLeg first = legs[0];
            if (tEvaMin <= first.StartMin)
            {
                Fill(ref p, first, 0, 0.0, lookAheadM);
                p.Phase = RoutePhase.Before;
                p.SpeedMs = null;
                return p;
            }
            for (int i = 0; i < legs.Length; i++)
            {
                RouteLeg g = legs[i];
                if (tEvaMin >= g.StartMin && tEvaMin <= g.EndMin)
                {
                    int k;
                    double f;
                    IntervalAtTime(g, tEvaMin, out k, out f);
                    Fill(ref p, g, k, f, lookAheadM);
                    p.Phase = RoutePhase.Walk;
                    return p;
                }
                if (i + 1 < legs.Length && tEvaMin > g.EndMin && tEvaMin < legs[i + 1].StartMin)
                {
                    double gap = legs[i + 1].StartMin - g.EndMin;
                    Fill(ref p, g, g.RowCount - 1, 0.0, lookAheadM);
                    p.Phase = RoutePhase.Dwell;
                    p.Station = g.To;
                    p.DwellFraction = gap > 0 ? (tEvaMin - g.EndMin) / gap : (double?)null;
                    p.SpeedMs = 0.0;
                    return p;
                }
            }
            RouteLeg last = legs[legs.Length - 1];
            Fill(ref p, last, last.RowCount - 1, 0.0, lookAheadM);
            p.Phase = RoutePhase.After;
            p.SpeedMs = null;
            return p;
        }

        /// <summary>Metres along leg <paramref name="legIndex"/> at EVA minute t (clamped to the leg's rows).</summary>
        public double SAtTime(int legIndex, double tEvaMin)
        {
            RouteLeg g = legs[legIndex];
            int k;
            double f;
            IntervalAtTime(g, tEvaMin, out k, out f);
            return RelS(g, k, f);
        }

        /// <summary>Planned EVA minute at <paramref name="sLegM"/> metres along the leg (linear between rows, clamped).</summary>
        public double TimeAtS(int legIndex, double sLegM)
        {
            RouteLeg g = legs[legIndex];
            int k;
            double f;
            IntervalAtS(g, sLegM, out k, out f);
            return k + 1 < g.RowCount ? g.T[k] + f * (g.T[k + 1] - g.T[k]) : g.T[k];
        }

        /// <summary>Pad-local point at <paramref name="sLegM"/> metres along the leg (linear between rows, clamped).</summary>
        public void PointAtS(int legIndex, double sLegM, out double x, out double y)
        {
            RouteLeg g = legs[legIndex];
            int k;
            double f;
            IntervalAtS(g, sLegM, out k, out f);
            PointAt(g, k, f, out x, out y);
        }

        /// <summary>Pad-local height at <paramref name="sLegM"/> metres along the leg; null where the rows have none.</summary>
        public double? ZAtS(int legIndex, double sLegM)
        {
            RouteLeg g = legs[legIndex];
            int k;
            double f;
            IntervalAtS(g, sLegM, out k, out f);
            return ZAt(g, k, f);
        }

        /// <summary>
        /// Bearing (degrees clockwise from north) at <paramref name="sLegM"/> along the leg: towards the point
        /// <paramref name="lookAheadM"/> further along the SAME leg. Within the last look-ahead distance the chord slides
        /// to end at the leg's end (so the bearing is continuous and equals the arrival bearing held through the
        /// dwell). null = the leg has no extent.
        /// </summary>
        public double? HeadingAtS(int legIndex, double sLegM, double lookAheadM = DefaultLookAheadM)
        {
            RouteLeg g = legs[legIndex];
            double len = g.ArcLengthM;
            if (g.RowCount < 2 || !(len > 0)) return null;
            double s = Math.Min(Math.Max(sLegM, 0.0), len);
            double look = lookAheadM > 0 ? lookAheadM : 0.0;
            double a = s, b = s + look;
            if (b > len)
            {
                b = len;
                a = Math.Max(0.0, len - look);
            }
            double ax, ay, bx, by;
            PointAtS(legIndex, a, out ax, out ay);
            PointAtS(legIndex, b, out bx, out by);
            double dx = bx - ax, dy = by - ay;
            if (Math.Sqrt(dx * dx + dy * dy) < 1e-6)
            {
                // No look-ahead, or the chord closes on itself: the direction of the rows around s.
                int k;
                double f;
                IntervalAtS(g, s, out k, out f);
                if (!SegmentDirection(g, k, out dx, out dy)) return null;
            }
            double h = Math.Atan2(dx, dy) * 180.0 / Math.PI;
            return (h + 360.0) % 360.0;
        }

        /// <summary>
        /// The rows of one leg for drawing: the first row, then every row at least <paramref name="stepM"/> metres of
        /// arc after the last one kept, and always the leg's last row. A step at or below the row spacing returns
        /// every row.
        /// </summary>
        public RoutePolyline LegPolyline(int legIndex, double stepM)
        {
            RouteLeg g = legs[legIndex];
            var keep = new List<int>();
            keep.Add(0);
            double lastS = g.S[0];
            for (int i = 1; i < g.RowCount - 1; i++)
            {
                if (g.S[i] - lastS >= stepM - 1e-9)
                {
                    keep.Add(i);
                    lastS = g.S[i];
                }
            }
            if (g.RowCount > 1) keep.Add(g.RowCount - 1);
            var pl = new RoutePolyline();
            pl.LegIndex = legIndex;
            pl.S = new double[keep.Count];
            pl.X = new double[keep.Count];
            pl.Y = new double[keep.Count];
            pl.Z = new double?[keep.Count];
            for (int i = 0; i < keep.Count; i++)
            {
                int r = keep[i];
                pl.S[i] = g.S[r] - g.S[0];
                pl.X[i] = g.X[r];
                pl.Y[i] = g.Y[r];
                pl.Z[i] = g.Z[r];
            }
            return pl;
        }

        // ---- internals ------------------------------------------------------------------------------------------

        void Fill(ref RoutePose p, RouteLeg g, int k, double f, double lookAheadM)
        {
            PointAt(g, k, f, out p.X, out p.Y);
            p.Z = ZAt(g, k, f);
            p.LegIndex = g.Index;
            p.LegNumber = g.Number;
            p.SLegM = RelS(g, k, f);
            p.DistanceWalkedM = arcBefore[g.Index] + p.SLegM;
            p.HeadingDeg = HeadingAtS(g.Index, p.SLegM, lookAheadM);
            // speed_ms is the speed to the next row: the interval that holds the pose.
            p.SpeedMs = g.SpeedMs[k + 1 < g.RowCount ? k : Math.Max(0, g.RowCount - 2)];
        }

        static double RelS(RouteLeg g, int k, double f)
        {
            double s = k + 1 < g.RowCount ? g.S[k] + f * (g.S[k + 1] - g.S[k]) : g.S[k];
            return s - g.S[0];
        }

        static void PointAt(RouteLeg g, int k, double f, out double x, out double y)
        {
            if (k + 1 < g.RowCount)
            {
                x = g.X[k] + f * (g.X[k + 1] - g.X[k]);
                y = g.Y[k] + f * (g.Y[k + 1] - g.Y[k]);
            }
            else
            {
                x = g.X[k];
                y = g.Y[k];
            }
        }

        static double? ZAt(RouteLeg g, int k, double f)
        {
            if (k + 1 >= g.RowCount || f <= 0) return g.Z[k];
            if (f >= 1) return g.Z[k + 1];
            if (!g.Z[k].HasValue || !g.Z[k + 1].HasValue) return null;
            return g.Z[k].Value + f * (g.Z[k + 1].Value - g.Z[k].Value);
        }

        /// <summary>
        /// Row interval [k, k + 1] and fraction f that hold EVA minute t: arcAt of path.ts (the first row v >= 1 whose
        /// time is not before t), found by binary search. Clamped to the leg.
        /// </summary>
        static void IntervalAtTime(RouteLeg g, double t, out int k, out double f)
        {
            if (g.RowCount < 2)
            {
                k = 0;
                f = 0;
                return;
            }
            int v = FirstNotBelow(g.T, t);
            double dt = g.T[v] - g.T[v - 1];
            f = dt > 0 ? Math.Min(1.0, Math.Max(0.0, (t - g.T[v - 1]) / dt)) : 1.0;
            k = v - 1;
        }

        /// <summary>Row interval [k, k + 1] and fraction f that hold s metres along the leg (clamped).</summary>
        static void IntervalAtS(RouteLeg g, double sLegM, out int k, out double f)
        {
            if (g.RowCount < 2)
            {
                k = 0;
                f = 0;
                return;
            }
            double s = sLegM + g.S[0];
            int v = FirstNotBelow(g.S, s);
            double ds = g.S[v] - g.S[v - 1];
            f = ds > 0 ? Math.Min(1.0, Math.Max(0.0, (s - g.S[v - 1]) / ds)) : 0.0;
            k = v - 1;
        }

        /// <summary>Smallest v in [1, a.Length - 1] with a[v] >= value, else a.Length - 1 (a non-decreasing, length >= 2).</summary>
        static int FirstNotBelow(double[] a, double value)
        {
            int lo = 1, hi = a.Length - 1;
            while (lo < hi)
            {
                int mid = (lo + hi) / 2;
                if (a[mid] >= value) hi = mid;
                else lo = mid + 1;
            }
            return lo;
        }

        /// <summary>Direction of the row segment at interval k, or of the nearest segment that has a length.</summary>
        static bool SegmentDirection(RouteLeg g, int k, out double dx, out double dy)
        {
            int n = g.RowCount;
            for (int d = 0; d < n; d++)
            {
                for (int sign = 1; sign >= -1; sign -= 2)
                {
                    int i = k + sign * d;
                    if (i < 0 || i + 1 >= n) continue;
                    dx = g.X[i + 1] - g.X[i];
                    dy = g.Y[i + 1] - g.Y[i];
                    if (dx != 0 || dy != 0) return true;
                }
            }
            dx = 0;
            dy = 0;
            return false;
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

namespace NasaSpaceApp.Mission
{
    /// <summary>Turns a map position (degrees) into a Unity world position; y = ground height there.</summary>
    public interface IMissionWorld
    {
        Vector3 ToWorld(double lat, double lon);
    }

    /// <summary>One planned waypoint in world space (1-based <see cref="Index"/> = the number on the web map).</summary>
    public sealed class MissionWaypoint
    {
        public int Index;
        public string Note;
        public IReadOnlyList<string> Tags;
        public double Lat, Lon;
        public Vector3 World;
        public float StopMin;
        public float ArriveMin = float.NaN, LeaveMin = float.NaN;      // planned EVA minutes; NaN = unknown
        public float O2UsedAtLeaveL = float.NaN;
        public float THomeMin = float.NaN, O2HomeL = float.NaN;
    }

    /// <summary>One walked segment: "out" legs pad → #1 → … → #n, then one "home" leg #n → pad.</summary>
    public sealed class MissionLeg
    {
        public int Leg;
        public bool IsHome;
        public string From, To;
        public bool Routed;
        public float LengthM = float.NaN, TimeMin = float.NaN, O2L = float.NaN;
        public float StartMin = float.NaN, EndMin = float.NaN;
        public int FirstPoint = -1, PointCount;   // range in MissionPlan.Route
    }

    /// <summary>Phase of a timeline row (mission/margin.ts).</summary>
    public enum MissionPhase { Depart, Walk, Arrive, Stop, Leave, Home, Return }

    /// <summary>Planned state at one moment (values are linear in t between rows).</summary>
    public struct MissionTimelineRow
    {
        public float TMin;
        public MissionPhase Phase;
        public int Waypoint;          // 0 = none
        public float O2UsedL, THomeMin, O2HomeL, TasksLeftL, MarginMin;
        public string Binding;        // "O2" | "daylight" | "dose" | "EVA duration"
    }

    /// <summary>
    /// A loaded mission in Unity world space: pad, waypoints, the planned route (one point per planner grid vertex) with
    /// the planned EVA minute, O₂ used, T_home and O₂_home at each point, the legs, the planned margin timeline and the
    /// planner's totals. Built once from a <see cref="MissionFile"/>; read-only afterwards. Unknown numbers are NaN.
    ///
    /// Positions: every point goes pad-local metres → lat/lon (the planner's eqc projection) → scene world via
    /// <see cref="IMissionWorld"/> (<see cref="MarsGeoReference.WorldXZ(double,double)"/> + terrain height). The
    /// pad-local frame is never used as Unity metres directly: the scene's origin is its spawn, not the mission pad.
    /// </summary>
    public sealed class MissionPlan
    {
        private const float PadSpawnWarnM = 25f;
        private const double FrameMismatchWarnM = 1.0;

        public MissionFile Source { get; private set; }
        public string Id => Source.MissionId;
        public string Title { get; private set; }
        public string OriginLabel => Source.OriginLabel;
        public string ScenarioId => Source.Scenario != null ? Source.Scenario.Id : null;
        public bool Dummy => Source.Dummy;

        /// <summary>Mission pad (EVA start and end) in world space.</summary>
        public Vector3 PadWorld { get; private set; }

        /// <summary>Horizontal distance from the scene origin (spawn, the HUD's HOME) to the mission pad, m.</summary>
        public float PadOffsetFromSpawnM { get; private set; }

        public IReadOnlyList<MissionWaypoint> Waypoints => waypoints;
        public IReadOnlyList<MissionLeg> Legs => legs;
        public IReadOnlyList<MissionTimelineRow> Timeline => timeline;

        /// <summary>The planned walk, world space, in order (pad → … → pad). Consecutive legs share their joint point.</summary>
        public Vector3[] Route { get; private set; }
        /// <summary>Per route point: leg number (1-based, see <see cref="Legs"/>).</summary>
        public int[] RouteLeg { get; private set; }
        /// <summary>Per route point: horizontal distance along the whole walk from the pad, m (world metres).</summary>
        public float[] RouteS { get; private set; }
        /// <summary>Per route point: planned EVA minute, O₂ used (L), T_home (min), O₂_home (L). NaN = unknown.</summary>
        public float[] RouteT { get; private set; }
        public float[] RouteO2Used { get; private set; }
        public float[] RouteTHome { get; private set; }
        public float[] RouteO2Home { get; private set; }

        /// <summary>Total planned walking distance, m.</summary>
        public float RouteLengthM { get; private set; }

        /// <summary>World XZ bounds of pad, waypoints and route (x = east, y = north).</summary>
        public Rect BoundsXZ { get; private set; }

        // Planner totals (summary block).
        public bool? Feasible => Source.Summary.Feasible;
        public float WalkMin => F(Source.Summary.WalkMin);
        public float StopMin => (float)Source.Summary.StopMin;
        public float EvaMin => F(Source.Summary.EvaMin);
        public float TimeMarginMin => F(Source.Summary.TimeMarginMin);
        public float O2UsedL => F(Source.Summary.O2UsedL);
        public float O2MarginL => F(Source.Summary.O2MarginL);
        public float O2MarginMin => F(Source.Summary.O2MarginMin);
        /// <summary>Lowest planned margin over the EVA (min), its binding term and when; NaN / null without a timeline.</summary>
        public float LowestMarginMin => Source.Timeline?.Lowest != null ? (float)Source.Timeline.Lowest.MarginMin : float.NaN;
        public string LowestBinding => Source.Timeline?.Lowest?.Binding;
        public float LowestAtMin => Source.Timeline?.Lowest != null ? (float)Source.Timeline.Lowest.TMin : float.NaN;

        // Budget constants and conditions the plan was computed with.
        public MissionFile.ConstantsBlock Constants => Source.Constants;
        public float MarginAmberMin => (float)Source.Constants.MarginAmberMin;
        public float TDarkMin => Source.Conditions != null ? F(Source.Conditions.TDarkMin) : float.NaN;
        public bool StormReplay => Source.Conditions != null && Source.Conditions.StormReplay;

        /// <summary>EVA start as a UTC instant (conditions.eva_start_utc), null when the file does not carry it.</summary>
        public DateTime? EvaStartUtc { get; private set; }
        /// <summary>EVA start local mean solar time in hours (conditions.eva_start_lmst), NaN when unknown.</summary>
        public float EvaStartLmstHours { get; private set; } = float.NaN;
        /// <summary>D39 dose series on the EVA clock (storm switch on), null otherwise.</summary>
        public DoseSeries Dose { get; private set; }

        /// <summary>Things the user should know about this mission in this scene (shown/logged by the loader).</summary>
        public IReadOnlyList<string> Warnings => warnings;

        private readonly List<MissionWaypoint> waypoints = new List<MissionWaypoint>();
        private readonly List<MissionLeg> legs = new List<MissionLeg>();
        private readonly List<MissionTimelineRow> timeline = new List<MissionTimelineRow>();
        private readonly List<string> warnings = new List<string>();

        private MissionPlan() { }

        /// <summary>
        /// Builds the world-space plan. <paramref name="file"/> must come from <see cref="MissionFile.Parse"/> (checked).
        /// </summary>
        public static MissionPlan Build(MissionFile file, IMissionWorld world)
        {
            if (file == null) throw new ArgumentNullException(nameof(file));
            if (world == null) throw new ArgumentNullException(nameof(world));
            if (!Eqc.TryParse(file.Frame.Projection.Proj, out Eqc eqc, out string projError))
            {
                throw new ArgumentException("frame.projection.proj: " + projError);
            }

            var plan = new MissionPlan { Source = file };
            plan.Title = !string.IsNullOrEmpty(file.Title)
                ? file.Title
                : "Mission · " + file.Waypoints.Count.ToString(CultureInfo.InvariantCulture) + " waypoints";

            double padX = file.Frame.Projection.PadXyM[0], padY = file.Frame.Projection.PadXyM[1];
            MissionFile.PadBlock pad = file.Frame.Pad;
            plan.PadWorld = world.ToWorld(pad.Lat, pad.Lon);
            plan.PadOffsetFromSpawnM = new Vector2(plan.PadWorld.x, plan.PadWorld.z).magnitude;

            float minX = plan.PadWorld.x, maxX = minX, minZ = plan.PadWorld.z, maxZ = minZ;
            void Grow(Vector3 p)
            {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.z < minZ) minZ = p.z;
                if (p.z > maxZ) maxZ = p.z;
            }

            // Waypoints: lon/lat are exact; x_m/y_m must agree with them through the projection.
            double worstFrame = 0;
            int worstWp = 0;
            foreach (MissionFile.WaypointEntry w in file.Waypoints)
            {
                double lon = w.LonLat[0], lat = w.LonLat[1];
                eqc.ToXY(lon, lat, out double px, out double py);
                double miss = Math.Sqrt((px - padX - w.XM) * (px - padX - w.XM) + (py - padY - w.YM) * (py - padY - w.YM));
                if (miss > worstFrame)
                {
                    worstFrame = miss;
                    worstWp = w.Index;
                }
                var wp = new MissionWaypoint
                {
                    Index = w.Index,
                    Note = w.Note ?? string.Empty,
                    Tags = (IReadOnlyList<string>)w.Tags ?? Array.Empty<string>(),
                    Lat = lat,
                    Lon = lon,
                    World = world.ToWorld(lat, lon),
                    StopMin = (float)w.StopMin,
                    ArriveMin = F(w.ArriveTMin),
                    LeaveMin = F(w.LeaveTMin),
                    O2UsedAtLeaveL = F(w.O2UsedAtLeaveL),
                    THomeMin = F(w.THomeMin),
                    O2HomeL = F(w.O2HomeL),
                };
                plan.waypoints.Add(wp);
                Grow(wp.World);
            }
            if (worstFrame > FrameMismatchWarnM)
            {
                plan.warnings.Add(string.Format(CultureInfo.InvariantCulture,
                    "waypoint #{0}: lonlat and x_m/y_m disagree by {1:0.0} m (frame or projection mismatch)", worstWp, worstFrame));
            }

            // Route: pad-local metres → projected → lat/lon → world.
            List<double?[]> rows = file.Path.Rows;
            int n = rows.Count;
            plan.Route = new Vector3[n];
            plan.RouteLeg = new int[n];
            plan.RouteS = new float[n];
            plan.RouteT = new float[n];
            plan.RouteO2Used = new float[n];
            plan.RouteTHome = new float[n];
            plan.RouteO2Home = new float[n];
            float s = 0f;
            for (int i = 0; i < n; i++)
            {
                double?[] r = rows[i];
                eqc.ToLonLat(r[2].Value + padX, r[3].Value + padY, out double lon, out double lat);
                Vector3 p = world.ToWorld(lat, lon);
                if (i > 0)
                {
                    Vector3 q = plan.Route[i - 1];
                    float dx = p.x - q.x, dz = p.z - q.z;
                    s += Mathf.Sqrt(dx * dx + dz * dz);
                }
                plan.Route[i] = p;
                plan.RouteLeg[i] = (int)r[0].Value;
                plan.RouteS[i] = s;
                plan.RouteT[i] = F(r[5]);
                plan.RouteO2Used[i] = F(r[6]);
                plan.RouteTHome[i] = F(r[7]);
                plan.RouteO2Home[i] = F(r[8]);
                Grow(p);
            }
            plan.RouteLengthM = s;
            plan.BoundsXZ = Rect.MinMaxRect(minX, minZ, maxX, maxZ);

            int unrouted = 0;
            foreach (MissionFile.LegEntry l in file.Legs)
            {
                plan.legs.Add(new MissionLeg
                {
                    Leg = l.Leg,
                    IsHome = l.Kind == "home",
                    From = l.From,
                    To = l.To,
                    Routed = l.Routed,
                    LengthM = F(l.LengthM),
                    TimeMin = F(l.TimeMin),
                    O2L = F(l.O2L),
                    StartMin = F(l.TStartMin),
                    EndMin = F(l.TEndMin),
                    FirstPoint = l.FirstRow ?? -1,
                    PointCount = l.NRows,
                });
                if (!l.Routed) unrouted++;
            }

            if (file.Timeline != null)
            {
                foreach (Newtonsoft.Json.Linq.JArray r in file.Timeline.Rows)
                {
                    plan.timeline.Add(new MissionTimelineRow
                    {
                        TMin = Num(r[0]),
                        Phase = ParsePhase((string)r[1]),
                        Waypoint = r[2].Type == Newtonsoft.Json.Linq.JTokenType.Null ? 0 : (int)r[2],
                        O2UsedL = Num(r[3]),
                        THomeMin = Num(r[4]),
                        O2HomeL = Num(r[5]),
                        TasksLeftL = Num(r[6]),
                        MarginMin = Num(r[7]),
                        Binding = (string)r[8],
                    });
                }
            }

            // EVA clock: start instant, LMST, dose series.
            MissionFile.ConditionsBlock cond = file.Conditions;
            if (cond != null)
            {
                if (!string.IsNullOrEmpty(cond.EvaStartUtc)
                    && DateTime.TryParse(cond.EvaStartUtc, CultureInfo.InvariantCulture,
                                         DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTime start))
                {
                    plan.EvaStartUtc = start;
                }
                plan.EvaStartLmstHours = ParseHms(cond.EvaStartLmst);
                plan.Dose = DoseSeries.From(cond.Dose);
                if (cond.StormReplay && plan.Dose == null)
                {
                    plan.warnings.Add("storm replay was on in the planner, but the file has no dose series: the dose term is left out");
                }
            }

            // What the user should know.
            if (file.Dummy) plan.warnings.Add("DUMMY data: built from the web app's placeholder data, not real results");
            if (unrouted > 0) plan.warnings.Add(unrouted + " leg(s) could not be routed in the planner: the mission is not feasible as planned");
            else if (file.Summary.Feasible == false) plan.warnings.Add("the planner marked this mission NOT feasible");
            if (file.Timeline == null) plan.warnings.Add("no planned timeline (a leg or a field value is missing): schedule tracking is off");
            if (plan.PadOffsetFromSpawnM > PadSpawnWarnM)
            {
                plan.warnings.Add(string.Format(CultureInfo.InvariantCulture,
                    "mission pad ({0:0.0000}°{1}, {2:0.0000}°E) is {3:0} m from the scene spawn: the player and HOME move to the pad",
                    Math.Abs(pad.Lat), pad.Lat < 0 ? 'S' : 'N', pad.Lon, plan.PadOffsetFromSpawnM));
            }
            if (file.World == null || file.World.Version == null)
            {
                plan.warnings.Add("world.version unknown: using this scene's terrain");
            }
            return plan;
        }

        /// <summary>
        /// Planned state at EVA minute <paramref name="tMin"/>, linear between timeline rows (clamped to the first/last
        /// row). False when the mission has no timeline.
        /// </summary>
        public bool TryPlannedAt(float tMin, out MissionTimelineRow state)
        {
            state = default;
            int n = timeline.Count;
            if (n == 0 || float.IsNaN(tMin))
            {
                return false;
            }
            if (tMin <= timeline[0].TMin)
            {
                state = timeline[0];
                return true;
            }
            if (tMin >= timeline[n - 1].TMin)
            {
                state = timeline[n - 1];
                return true;
            }
            int lo = 0, hi = n - 1;   // timeline[lo].TMin <= t < timeline[hi].TMin
            while (hi - lo > 1)
            {
                int mid = (lo + hi) >> 1;
                if (timeline[mid].TMin <= tMin) lo = mid; else hi = mid;
            }
            MissionTimelineRow a = timeline[lo], b = timeline[hi];
            float span = b.TMin - a.TMin;
            float u = span > 1e-6f ? (tMin - a.TMin) / span : 0f;
            state = a;
            state.TMin = tMin;
            state.O2UsedL = Mathf.Lerp(a.O2UsedL, b.O2UsedL, u);
            state.THomeMin = Mathf.Lerp(a.THomeMin, b.THomeMin, u);
            state.O2HomeL = Mathf.Lerp(a.O2HomeL, b.O2HomeL, u);
            state.TasksLeftL = Mathf.Lerp(a.TasksLeftL, b.TasksLeftL, u);
            state.MarginMin = Mathf.Lerp(a.MarginMin, b.MarginMin, u);
            return true;
        }

        /// <summary>One-line description for logs and the HUD.</summary>
        public override string ToString()
        {
            return string.Format(CultureInfo.InvariantCulture,
                "{0} [{1}] · {2} waypoints · {3:0} m · EVA {4} min · {5}",
                Title, Id, waypoints.Count, RouteLengthM,
                float.IsNaN(EvaMin) ? "?" : EvaMin.ToString("0", CultureInfo.InvariantCulture),
                Feasible == true ? "feasible" : Feasible == false ? "NOT feasible" : "feasibility unknown");
        }

        private static float F(double? v) => v.HasValue ? (float)v.Value : float.NaN;

        // "HH:MM:SS" → hours; NaN when missing or malformed.
        private static float ParseHms(string s)
        {
            if (string.IsNullOrEmpty(s)) return float.NaN;
            string[] p = s.Split(':');
            if (p.Length < 2) return float.NaN;
            if (!int.TryParse(p[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out int h)
                || !int.TryParse(p[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out int m))
            {
                return float.NaN;
            }
            float sec = 0f;
            if (p.Length > 2) float.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out sec);
            return h + m / 60f + sec / 3600f;
        }

        private static float Num(Newtonsoft.Json.Linq.JToken t) =>
            t == null || t.Type == Newtonsoft.Json.Linq.JTokenType.Null ? float.NaN : (float)t;

        private static MissionPhase ParsePhase(string s)
        {
            switch (s)
            {
                case "depart": return MissionPhase.Depart;
                case "arrive": return MissionPhase.Arrive;
                case "stop": return MissionPhase.Stop;
                case "leave": return MissionPhase.Leave;
                case "home": return MissionPhase.Home;
                case "return": return MissionPhase.Return;
                default: return MissionPhase.Walk;
            }
        }
    }

    /// <summary>
    /// The D39 storm dose rate on the EVA clock (mission/margin.ts DoseTiming): linear between knots, clamped outside
    /// (numpy.interp). tau_dose(t) = 60 · D_allow / rate(t) minutes, the dose leash of the margin's dose term.
    /// </summary>
    public sealed class DoseSeries
    {
        public float DAllowMgy { get; private set; }
        public float[] EvaMin { get; private set; }
        public float[] RateMgyH { get; private set; }
        /// <summary>Lowest rate in the series: the quiet background before the storm.</summary>
        public float QuietRateMgyH { get; private set; }
        public string Source { get; private set; }

        public static DoseSeries From(MissionFile.DoseBlock b)
        {
            if (b == null || b.Series == null || !(b.DAllowMgy > 0)) return null;
            var t = new List<float>(b.Series.Count);
            var r = new List<float>(b.Series.Count);
            foreach (double[] k in b.Series)
            {
                if (k == null || k.Length < 2 || double.IsNaN(k[0]) || !(k[1] > 0)) continue;
                t.Add((float)k[0]);
                r.Add((float)k[1]);
            }
            if (t.Count == 0) return null;
            float quiet = float.MaxValue;
            foreach (float v in r) quiet = Mathf.Min(quiet, v);
            return new DoseSeries { DAllowMgy = (float)b.DAllowMgy, EvaMin = t.ToArray(), RateMgyH = r.ToArray(), QuietRateMgyH = quiet, Source = b.Source };
        }

        /// <summary>Dose rate (mGy/h) at EVA minute <paramref name="tMin"/>.</summary>
        public float RateAt(float tMin)
        {
            float[] xs = EvaMin, ys = RateMgyH;
            int n = xs.Length;
            if (tMin <= xs[0]) return ys[0];
            if (tMin >= xs[n - 1]) return ys[n - 1];
            int lo = 0, hi = n - 1;
            while (hi - lo > 1)
            {
                int mid = (lo + hi) >> 1;
                if (xs[mid] <= tMin) lo = mid; else hi = mid;
            }
            float u = (tMin - xs[lo]) / (xs[hi] - xs[lo]);
            return ys[lo] + u * (ys[hi] - ys[lo]);
        }

        /// <summary>Minutes until D_allow at the rate of EVA minute <paramref name="tMin"/> (the dose leash).</summary>
        public float TauDoseMin(float tMin) => 60f * DAllowMgy / RateAt(tMin);
    }
}

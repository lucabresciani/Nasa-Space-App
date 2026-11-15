using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// A plan chosen on the mission planning screen, loaded and ready for the simulator: the planner's route and
    /// timeline, the waypoints generated from them, and the texts that say where each number comes from.
    /// Everything is in the metres of ONE frame (x east, y north), anchored at the official pad, so plans from
    /// different pads share the same coordinates.
    ///
    /// What the planner provides and what it does not:
    ///   route, leg times, per-leg O2, timeline (O2 left, margin, binding term)   every plan
    ///   return fields (time and O2 to get home from ANY point)                    the official plan only
    /// So off the planned track, time-to-home and margin are known on the official plan only; elsewhere they are
    /// unknown (null), never guessed.
    /// </summary>
    public sealed class MissionPlan
    {
        /// <summary>Mandatory on every view (the planner's config/hud.yaml labels.simulated).</summary>
        public const string LabelSimulated = "Simulated EVA · real terrain and data";
        public const string LabelRoute = "Route, timings, O₂: planner engine (precomputed; no new plan computed).";
        public const string LabelNav = "Navigation points: derived by the simulator, not planner output.";
        public const string LabelO2Timeline = "O₂ · planner timeline";
        public const string LabelMarginTimeline = "margin · timeline, interpolated";
        public const string LabelNoReturnField = "n/a · no return field for this pad";

        /// <summary>The planner's analysis projection (config/site.yaml crs.analysis_proj), used when no bundle states it.</summary>
        public const double PlannerLatTsDeg = -4.8, PlannerLon0Deg = 137.39, PlannerRadiusM = 3396190.0;

        public PlanEntry Entry { get; private set; }
        public PadFrame Frame { get; private set; }
        public GeoRoute Route { get; private set; }
        public RouteTrack Track { get { return Route.Track; } }
        public Timeline Timeline { get; private set; }
        public WaypointPlan Waypoints { get; private set; }
        /// <summary>Time to get home (min) and O2 to get home (L) from any point: official plan only, else null.</summary>
        public GridF32 THome { get; private set; }
        public GridF32 O2Home { get; private set; }
        public bool HasReturnFields { get { return THome != null && O2Home != null; } }
        /// <summary>Planned end of the EVA: the return to the pad, EVA minutes.</summary>
        public double EndMin { get { return Track.EndMin; } }

        /// <summary>
        /// A frame in the planner's projection with its origin at the given pad. Use the official pad for every plan.
        /// </summary>
        public static PadFrame FrameAt(double padLon, double padLat, double padElevM, SceneGeo scene)
        {
            var f = new BundleFrame();
            f.PadId = "frame";
            f.PadLon = padLon;
            f.PadLat = padLat;
            f.PadElevM = padElevM;
            f.LatTsDeg = PlannerLatTsDeg;
            f.Lon0Deg = PlannerLon0Deg;
            f.RadiusM = PlannerRadiusM;
            f.Proj = "+proj=eqc +lat_ts=-4.8 +lat_0=0 +lon_0=137.39 +x_0=0 +y_0=0 +R=3396190 +units=m +no_defs";
            const double d2r = Math.PI / 180.0;
            f.PadProjX = PlannerRadiusM * (padLon - PlannerLon0Deg) * d2r * Math.Cos(PlannerLatTsDeg * d2r);
            f.PadProjY = PlannerRadiusM * padLat * d2r;
            return new PadFrame(f, scene);
        }

        /// <summary>Station id to display name, from the planner's stations.json; empty when the file is missing.</summary>
        public static Dictionary<string, string> ReadStationNames(string stationsJsonPath)
        {
            var names = new Dictionary<string, string>(StringComparer.Ordinal);
            if (string.IsNullOrEmpty(stationsJsonPath) || !File.Exists(stationsJsonPath)) return names;
            JToken doc = HlJson.Parse(File.ReadAllText(stationsJsonPath));
            JArray list = doc as JArray;
            if (list == null && doc.Type == JTokenType.Object) list = doc["stations"] as JArray;
            if (list == null) return names;
            foreach (JToken s in list)
            {
                string id = HlJson.Str(s, "id");
                string name = HlJson.Str(s, "name");
                if (!string.IsNullOrEmpty(id) && !string.IsNullOrEmpty(name)) names[id] = name;
            }
            return names;
        }

        /// <summary>
        /// Loads the plan and generates its waypoints. <paramref name="officialBundle"/> (the planner's simulator
        /// bundle for the official plan) supplies the return fields; they are attached only when the entry IS the
        /// official plan and the bundle's pad is the frame's origin.
        /// </summary>
        public static MissionPlan Load(PlanEntry entry, PadFrame frame, IDictionary<string, string> stationNames,
                                       BundleReader officialBundle, double navToleranceM)
        {
            var plan = new MissionPlan();
            plan.Entry = entry;
            plan.Frame = frame;
            plan.Route = GeoRoute.Load(entry.RoutePath, frame, entry.ScenarioId);
            plan.Timeline = Timeline.Parse(HlJson.Parse(File.ReadAllText(entry.TimelinePath)));
            if (entry.Stops == null || entry.Stops.Length == 0) entry.Stops = plan.Route.Stops;
            if (!entry.TotalMin.HasValue) entry.TotalMin = plan.Track.EndMin;

            Func<string, string> nameOf = id =>
            {
                string n;
                return stationNames != null && stationNames.TryGetValue(id, out n) ? n : null;
            };
            plan.Waypoints = WaypointPlan.Build(plan.Track, plan.Timeline, nameOf, navToleranceM);

            if (entry.Origin == PlanOrigin.Official && officialBundle != null && officialBundle.Index.Kind == "plan")
            {
                BundleFrame bf = officialBundle.Index.Frame;
                double bx, by;
                frame.LonLatToLocal(bf.PadLon, bf.PadLat, out bx, out by);
                // The bundle grids are in the bundle's pad-local metres: usable as they are only if that pad is our origin.
                if (Math.Abs(bx) < 0.01 && Math.Abs(by) < 0.01 &&
                    officialBundle.Has("fields/t_home.f32") && officialBundle.Has("fields/o2_home.f32"))
                {
                    plan.THome = officialBundle.ReadGrid("fields/t_home.f32");
                    plan.O2Home = officialBundle.ReadGrid("fields/o2_home.f32");
                }
            }
            return plan;
        }

        public double? O2LeftAt(double tEvaMin)
        {
            return Timeline.O2LeftAt(tEvaMin);
        }

        /// <summary>The planner's margin at t, interpolated between timeline rows (see <see cref="LabelMarginTimeline"/>).</summary>
        public double? MarginAt(double tEvaMin)
        {
            return WaypointPlan.MarginAt(Timeline, tEvaMin);
        }

        public string BindingAt(double tEvaMin)
        {
            return Timeline.BindingAt(tEvaMin);
        }

        /// <summary>O2 left at the planned return to the pad, litres.</summary>
        public double? O2AtReturnL
        {
            get { return Timeline.ReturnRow != null ? Timeline.ReturnRow.O2LeftL : Timeline.O2LeftAt(EndMin); }
        }

        /// <summary>Time to get home from a point of the frame, minutes; null where the planner gives no value.</summary>
        public double? THomeAt(double x, double y)
        {
            return THome != null ? THome.ValueAt(x, y) : null;
        }

        public double? O2HomeAt(double x, double y)
        {
            return O2Home != null ? O2Home.ValueAt(x, y) : null;
        }

        /// <summary>"4 stations + 25 navigation points. Route, timings, O2: planner engine (...). Navigation points: derived ..."</summary>
        public string GenerationText()
        {
            return Waypoints.CountText() + ". " + LabelRoute + " " + LabelNav;
        }
    }
}

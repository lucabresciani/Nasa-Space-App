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
        public Func<double, double, double?> THomeFn { get; private set; }
        public Func<double, double, double?> O2HomeFn { get; private set; }
        public bool HasReturnFields { get { return THomeFn != null && O2HomeFn != null; } }
        /// <summary>True when the way-home map is the planner's own; false when the simulator computed it.</summary>
        public bool PlannerHomeMap { get; private set; }
        /// <summary>The storm timed for THIS route (edited plans only); null = use the official plan's.</summary>
        public StormTrack Storm { get; private set; }
        /// <summary>True when stations were moved by hand and the plan was re-routed by the simulator.</summary>
        public bool Edited { get { return Entry.Origin == PlanOrigin.Edited; } }
        /// <summary>The plan this one was edited from (itself when not edited).</summary>
        public MissionPlan BasePlan { get; private set; }
        /// <summary>Smallest margin of an edited plan's timeline and where it occurs; null when not edited.</summary>
        public EditedPlanData EditData { get; private set; }
        IDictionary<string, string> stationNames;
        Dictionary<string, EditStop> activities;

        /// <summary>The planned work at a station of an edited plan (labels, note, stop time); null when none was set.</summary>
        public EditStop ActivityOf(string stationId)
        {
            EditStop a;
            return activities != null && stationId != null && activities.TryGetValue(stationId, out a) ? a : null;
        }
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
            plan.BasePlan = plan;
            plan.stationNames = stationNames;
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
                    GridF32 th = officialBundle.ReadGrid("fields/t_home.f32"), oh = officialBundle.ReadGrid("fields/o2_home.f32");
                    plan.THomeFn = th.ValueAt;
                    plan.O2HomeFn = oh.ValueAt;
                    plan.PlannerHomeMap = true;
                }
            }
            return plan;
        }

        /// <summary>
        /// The plan re-built by <see cref="PlanEditor"/> after stations of <paramref name="basePlan"/> were moved.
        /// Same pad, same frame, same way-home maps; the route and the timeline are the editor's.
        /// </summary>
        public static MissionPlan FromEdited(MissionPlan basePlan, EditedPlanData data, double navToleranceM)
        {
            MissionPlan root = basePlan.BasePlan;
            var entry = new PlanEntry();
            entry.Id = root.Entry.Id + "+edit";
            entry.Title = root.Entry.Title + " (edited)";
            entry.Origin = PlanOrigin.Edited;
            entry.OriginLabel = PlanCatalog.LabelEdited;
            entry.ScenarioId = root.Entry.ScenarioId;
            entry.PadLon = root.Entry.PadLon;
            entry.PadLat = root.Entry.PadLat;
            entry.PadElevM = root.Entry.PadElevM;
            var plan = new MissionPlan();
            plan.Entry = entry;
            plan.Frame = root.Frame;
            plan.BasePlan = root;
            plan.stationNames = root.stationNames;
            plan.Route = GeoRoute.Parse(data.RouteGeoJson, root.Frame, root.Entry.ScenarioId);
            plan.Timeline = Timeline.Parse(data.TimelineRows);
            entry.Stops = plan.Route.Stops;
            entry.TotalMin = plan.Track.EndMin;
            IDictionary<string, string> names = root.stationNames;
            Func<string, string> nameOf = id =>
            {
                string n;
                return names != null && names.TryGetValue(id, out n) ? n : null;
            };
            plan.Waypoints = WaypointPlan.Build(plan.Track, plan.Timeline, nameOf, navToleranceM);
            plan.THomeFn = root.THomeFn;
            plan.O2HomeFn = root.O2HomeFn;
            plan.PlannerHomeMap = root.PlannerHomeMap;
            plan.Storm = data.Storm;
            plan.EditData = data;
            plan.activities = new Dictionary<string, EditStop>(StringComparer.Ordinal);
            foreach (EditStop s in data.Stops) plan.activities[s.Id] = s;
            return plan;
        }

        /// <summary>
        /// Gives a plan without planner way-home maps (alternative pads) a map computed by the simulator's router
        /// for its pad, so that its stations can be moved and its margin evaluated off the track.
        /// </summary>
        public void AttachHomeField(HomeField field)
        {
            if (field == null || HasReturnFields) return;
            THomeFn = field.TAt;
            O2HomeFn = field.O2At;
            PlannerHomeMap = false;
        }

        /// <summary>The stations of this plan in visit order, with their points and work times (for editing and saving).</summary>
        public List<EditStop> StopsOf()
        {
            var stops = new List<EditStop>();
            for (int i = 0; i < Track.Legs.Count - 1; i++)
            {
                RouteLeg leg = Track.Legs[i];
                int n = leg.X.Length;
                var stop = new EditStop { Id = leg.To, X = leg.X[n - 1], Y = leg.Y[n - 1], DwellMin = Track.Legs[i + 1].StartMin - leg.EndMin };
                EditStop a = ActivityOf(leg.To);
                if (a != null)
                {
                    stop.Tags = a.Tags != null ? (string[])a.Tags.Clone() : new string[0];
                    stop.Note = a.Note ?? "";
                }
                stops.Add(stop);
            }
            return stops;
        }

        /// <summary>
        /// The check every plan must pass before an EVA starts, whoever made it: the margin of its timeline (the
        /// smallest of the oxygen, daylight, dose and EVA-duration limits) never below zero, and the O2 at the
        /// return not below the reserve. Returns false with the first reason found.
        /// </summary>
        public bool LimitsOk(double o2ReserveL, out double minMarginMin, out string binding, out double atMin, out double? o2AtReturnL)
        {
            minMarginMin = double.PositiveInfinity;
            binding = null;
            atMin = 0;
            foreach (TimelineRow row in Timeline.Events)
            {
                if (!row.MarginMin.HasValue || row.MarginMin.Value >= minMarginMin) continue;
                minMarginMin = row.MarginMin.Value;
                binding = row.MarginBinding;
                atMin = row.TMin;
            }
            o2AtReturnL = O2AtReturnL;
            bool marginOk = double.IsPositiveInfinity(minMarginMin) || minMarginMin >= 0;
            bool reserveOk = !o2AtReturnL.HasValue || o2AtReturnL.Value >= o2ReserveL;
            return marginOk && reserveOk;
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
            return THomeFn != null ? THomeFn(x, y) : null;
        }

        public double? O2HomeAt(double x, double y)
        {
            return O2HomeFn != null ? O2HomeFn(x, y) : null;
        }

        /// <summary>"4 stations + 25 navigation points. Route, timings, O2: planner engine (...). Navigation points: derived ..."</summary>
        public string GenerationText()
        {
            return Waypoints.CountText() + ". " + (Edited ? PlanEditor.LabelRerouted : LabelRoute) + " " + LabelNav;
        }
    }
}

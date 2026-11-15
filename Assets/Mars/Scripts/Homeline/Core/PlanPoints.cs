using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// One named point of points.json (contracts/bundle/points.schema.json): the pad, a station's science point or
    /// its access cell, in pad-local metres (x east, y north, z up).
    /// </summary>
    public sealed class PlanPoint
    {
        /// <summary>"pad", "S7", "S7.access", ...</summary>
        public string Id;
        /// <summary>"pad", "station" or "access".</summary>
        public string Kind;
        public string Station;
        public string Name;
        public double Lon;
        public double Lat;
        public double X;
        public double Y;
        /// <summary>Terrain under the point minus the pad elevation; null when no terrain covers it.</summary>
        public double? Z;
        /// <summary>on_route of the file; null when the file does not state it.</summary>
        public bool? OnRoute;
    }

    /// <summary>
    /// A science station of the plan: its points from points.json joined with its record in planner/stations.json
    /// (contracts/stations.schema.json: name, tasks, dwell_min, value, objective) and its place in plan.json "stations".
    /// </summary>
    public sealed class PlanStation
    {
        public string Id;
        public string Name;
        /// <summary>The science point (the station's own lon/lat).</summary>
        public PlanPoint Science;
        /// <summary>
        /// The access cell of the plan's scenario: where the route arrives and where the planner's T_home of the station
        /// is taken. null = the planner found no access cell for this scenario.
        /// </summary>
        public PlanPoint Access;
        /// <summary>Planned stay, minutes (stations.json dwell_min); null when stations.json has no record of it.</summary>
        public double? DwellMin;
        /// <summary>Task texts of stations.json (empty in the official bundle).</summary>
        public string[] Tasks = new string[0];
        /// <summary>F7 science value; null = not stated.</summary>
        public double? Value;
        public string Objective;
        /// <summary>The plan stops here: on_route of points.json, else membership of plan.json "stations".</summary>
        public bool OnRoute;
        /// <summary>1-based position in plan.json "stations" (1 = first stop); null = the plan does not stop here.</summary>
        public int? VisitOrder;
        /// <summary>stations.json in_partner_line; null = not stated.</summary>
        public bool? InPartnerLine;
        /// <summary>Science point to access cell in the plan's scenario, metres (stations.json access[scenario].dist_m); null = not stated.</summary>
        public double? AccessDistM;
    }

    /// <summary>
    /// The pad and the stations of a plan bundle: points.json (contracts/bundle/points.schema.json, written by
    /// tools/make_bundle.py: pad, science points and the access cells of the plan's scenario, pad-local metres) joined
    /// with planner/stations.json and with the visit order of plan.json "stations" (contracts/bundle/plan.schema.json:
    /// route legs pad, stations[0], ..., pad). Nothing is recomputed.
    /// </summary>
    public sealed class PlanPoints
    {
        readonly List<PlanStation> stations = new List<PlanStation>();
        readonly List<PlanStation> visits = new List<PlanStation>();
        readonly List<PlanPoint> points = new List<PlanPoint>();

        /// <summary>The rover parking spot: the origin of the pad-local frame.</summary>
        public PlanPoint Pad { get; private set; }
        /// <summary>Every station of points.json, in file order (those the plan does not stop at included).</summary>
        public IReadOnlyList<PlanStation> Stations { get { return stations; } }
        /// <summary>The stations the plan stops at, in visit order.</summary>
        public IReadOnlyList<PlanStation> Visits { get { return visits; } }
        /// <summary>Every point of points.json as written.</summary>
        public IReadOnlyList<PlanPoint> Points { get { return points; } }
        /// <summary>Scenario id of the plan (plan.json scenario.id), e.g. "nom_104".</summary>
        public string ScenarioId { get; private set; }

        PlanPoints()
        {
        }

        /// <summary>Reads points.json, planner/stations.json and plan.json of a plan bundle.</summary>
        public static PlanPoints FromBundle(BundleReader plan)
        {
            JToken stationsJson = plan.Has("planner/stations.json") ? plan.ReadJson("planner/stations.json") : null;
            return Parse(plan.ReadJson("points.json"), stationsJson, plan.ReadJson("plan.json"));
        }

        /// <summary>
        /// Joins the three documents. <paramref name="stationsJson"/> and <paramref name="planJson"/> may be null: the
        /// fields they supply then stay null (unknown).
        /// </summary>
        public static PlanPoints Parse(JToken pointsJson, JToken stationsJson, JToken planJson)
        {
            if (pointsJson == null || pointsJson.Type != JTokenType.Object) throw new InvalidDataException("points.json is not an object");
            string frame = HlJson.Str(pointsJson, "frame");
            if (frame != "pad-local") throw new InvalidDataException("points.json frame is not pad-local: " + frame);
            JArray arr = pointsJson["points"] as JArray;
            if (arr == null) throw new InvalidDataException("points.json has no points");

            var pp = new PlanPoints();
            JToken scenario = planJson != null && planJson.Type == JTokenType.Object ? planJson["scenario"] : null;
            pp.ScenarioId = HlJson.Str(scenario, "id");

            var order = new List<string>();
            JArray visitArr = planJson != null && planJson.Type == JTokenType.Object ? planJson["stations"] as JArray : null;
            if (visitArr != null)
                foreach (JToken v in visitArr) order.Add((string)v);

            var byId = new Dictionary<string, PlanStation>(StringComparer.Ordinal);
            foreach (JToken j in arr)
            {
                var p = new PlanPoint();
                p.Id = HlJson.Str(j, "id");
                p.Kind = HlJson.Str(j, "kind");
                p.Station = HlJson.Str(j, "station");
                p.Name = HlJson.Str(j, "name");
                p.Lon = HlJson.Num(j, "lon");
                p.Lat = HlJson.Num(j, "lat");
                p.X = HlJson.Num(j, "x_m");
                p.Y = HlJson.Num(j, "y_m");
                p.Z = HlJson.NumOrNull(j, "z_m");
                JToken onRoute = j.Type == JTokenType.Object ? j["on_route"] : null;
                p.OnRoute = HlJson.IsNull(onRoute) ? (bool?)null : (bool)onRoute;
                pp.points.Add(p);

                if (p.Kind == "pad")
                {
                    pp.Pad = p;
                    continue;
                }
                if (p.Kind != "station" && p.Kind != "access") continue;
                string sid = p.Station ?? p.Id;
                PlanStation st;
                if (!byId.TryGetValue(sid, out st))
                {
                    st = new PlanStation();
                    st.Id = sid;
                    byId[sid] = st;
                    pp.stations.Add(st);
                }
                if (p.Kind == "station") st.Science = p;
                else st.Access = p;
                if (st.Name == null) st.Name = p.Name;
            }
            if (pp.Pad == null) throw new InvalidDataException("points.json has no pad");

            if (stationsJson is JArray)
            {
                foreach (JToken s in (JArray)stationsJson)
                {
                    PlanStation st;
                    string id = HlJson.Str(s, "id");
                    if (id == null || !byId.TryGetValue(id, out st)) continue;
                    string name = HlJson.Str(s, "name");
                    if (name != null) st.Name = name;
                    st.DwellMin = HlJson.NumOrNull(s, "dwell_min");
                    st.Value = HlJson.NumOrNull(s, "value");
                    st.Objective = HlJson.Str(s, "objective");
                    JArray tasks = s["tasks"] as JArray;
                    if (tasks != null)
                    {
                        st.Tasks = new string[tasks.Count];
                        for (int i = 0; i < tasks.Count; i++)
                            st.Tasks[i] = tasks[i].Type == JTokenType.String ? (string)tasks[i] : tasks[i].ToString();
                    }
                    JToken ipl = s["in_partner_line"];
                    st.InPartnerLine = HlJson.IsNull(ipl) ? (bool?)null : (bool)ipl;
                    JToken access = s["access"];
                    JToken acc = access != null && access.Type == JTokenType.Object && pp.ScenarioId != null ? access[pp.ScenarioId] : null;
                    st.AccessDistM = HlJson.NumOrNull(acc, "dist_m");
                }
            }

            foreach (PlanStation st in pp.stations)
            {
                int at = order.IndexOf(st.Id);
                st.VisitOrder = at >= 0 ? (int?)(at + 1) : null;
                PlanPoint any = st.Science ?? st.Access;
                st.OnRoute = any != null && any.OnRoute.HasValue ? any.OnRoute.Value : at >= 0;
            }
            foreach (string id in order)
            {
                PlanStation st;
                if (byId.TryGetValue(id, out st)) pp.visits.Add(st);
            }
            return pp;
        }

        /// <summary>The station with this id; null when points.json has none.</summary>
        public PlanStation Station(string id)
        {
            foreach (PlanStation st in stations)
                if (st.Id == id) return st;
            return null;
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    public enum PlanOrigin
    {
        /// <summary>The planner's official plan (decision D21/D42), part of its validated scorecard.</summary>
        Official,
        /// <summary>A plan the planner engine precomputed for another rover parking spot (its pad picker).</summary>
        Alternative,
        /// <summary>A result tree written by the planner's engine service for a custom pad.</summary>
        Live,
    }

    /// <summary>One plan the user can choose on the mission planning screen.</summary>
    public sealed class PlanEntry
    {
        public string Id;
        public string Title;
        public PlanOrigin Origin;
        /// <summary>Provenance text that must be shown with the plan.</summary>
        public string OriginLabel;
        public string ScenarioId;
        public string RoutePath;
        public string TimelinePath;
        public double PadLon, PadLat;
        public double? PadElevM;
        /// <summary>Stations in visit order, as the planner states them (may be empty until the route is read).</summary>
        public string[] Stops = new string[0];
        /// <summary>Planned duration of the EVA walk and dwells, minutes.</summary>
        public double? TotalMin;
        /// <summary>The planner's ranking of the pad (1 = official); null for live plans.</summary>
        public int? Rank;
        /// <summary>Extra line for the list, e.g. "21 m N of rank 2".</summary>
        public string Note;
    }

    /// <summary>
    /// The plans available to the simulator, all computed by the HOMELINE planner engine; none is computed here.
    ///
    ///   official      {webData}/route_{scenario}.geojson, timeline_{scenario}.json
    ///   alternative   {webData}/scenarios/pads/{id}/route_{scenario}.geojson, timeline_{scenario}.json
    ///                 (listed in scenarios/pads/index.json; contracts/pads_index.schema.json)
    ///   live          {results}/{hash}/run_record.json + route_*.geojson + timeline_*.json at the tree root
    ///                 (contracts/backend/run_record.schema.json): what the planner's engine service writes for a
    ///                 custom pad. Copying such a tree into the results folder is all it takes to offer it here.
    ///
    /// The provenance labels are the planner's own (config/backend.yaml labels.precomputed and labels.live).
    /// </summary>
    public sealed class PlanCatalog
    {
        public const string LabelOfficial = "Precomputed · official plan";
        public const string LabelAlternative = "Precomputed by the planner engine · alternative pad · not the official plan";
        public const string LabelLive = "Computed live · not part of the validated scorecard";
        public const string DefaultScenario = "nom_104";

        readonly List<PlanEntry> plans = new List<PlanEntry>();
        readonly List<string> warnings = new List<string>();

        public IReadOnlyList<PlanEntry> Plans { get { return plans; } }
        public IReadOnlyList<string> Warnings { get { return warnings; } }
        /// <summary>The scenario the precomputed plans were made for (variant and suit mass), e.g. "nom_104".</summary>
        public string ScenarioId { get; private set; }
        /// <summary>{webData}/stations.json when present (station names), else null.</summary>
        public string StationsPath { get; private set; }

        /// <param name="webDataDir">The planner's published data folder (web/dist/data), or null.</param>
        /// <param name="resultsDir">Folder holding engine-service result trees, or null.</param>
        public static PlanCatalog Scan(string webDataDir, string resultsDir)
        {
            var cat = new PlanCatalog();
            cat.ScenarioId = DefaultScenario;
            if (!string.IsNullOrEmpty(webDataDir) && Directory.Exists(webDataDir)) cat.ScanWeb(webDataDir);
            else cat.warnings.Add("planner data folder not found: " + webDataDir);
            if (!string.IsNullOrEmpty(resultsDir) && Directory.Exists(resultsDir)) cat.ScanResults(resultsDir);
            cat.AddNearNotes();
            return cat;
        }

        public PlanEntry Find(string id)
        {
            foreach (PlanEntry e in plans)
                if (string.Equals(e.Id, id, StringComparison.Ordinal)) return e;
            return null;
        }

        void ScanWeb(string web)
        {
            string stations = Path.Combine(web, "stations.json");
            if (File.Exists(stations)) StationsPath = stations;

            string indexPath = Path.Combine(web, "scenarios", "pads", "index.json");
            if (!File.Exists(indexPath))
            {
                // No pad picker data: the official plan alone, if its files are there.
                var only = new PlanEntry { Id = "official", Title = "Official pad", Origin = PlanOrigin.Official, OriginLabel = LabelOfficial, Rank = 1 };
                if (Attach(only, web, ScenarioId)) plans.Add(only);
                else warnings.Add("no plan files in " + web);
                return;
            }

            JToken index = HlJson.Parse(File.ReadAllText(indexPath));
            if (HlJson.Bool(index, "dummy", false))
            {
                warnings.Add("pads index is flagged dummy: ignored");
                return;
            }
            string scenario = HlJson.Str(index, "scenario");
            if (!string.IsNullOrEmpty(scenario)) ScenarioId = scenario;

            JArray pads = index["pads"] as JArray;
            if (pads == null) return;
            foreach (JToken p in pads)
            {
                var e = new PlanEntry();
                e.Id = HlJson.Str(p, "id");
                bool official = HlJson.Bool(p, "official", false);
                e.Origin = official ? PlanOrigin.Official : PlanOrigin.Alternative;
                e.OriginLabel = official ? LabelOfficial : LabelAlternative;
                e.PadLon = HlJson.Num(p, "lon");
                e.PadLat = HlJson.Num(p, "lat");
                e.PadElevM = HlJson.NumOrNull(p, "elev_m");
                double? rank = HlJson.NumOrNull(p, "rank");
                e.Rank = rank.HasValue ? (int?)(int)rank.Value : null;
                e.Title = official ? "Official pad" : (e.Rank.HasValue ? "Alternative pad · rank " + e.Rank.Value : "Alternative pad · " + e.Id);
                if (e.Id == "pad_default") e.Title = "Alternative pad · first survey spot";
                JToken route = p["route"];
                if (!HlJson.IsNull(route))
                {
                    e.TotalMin = HlJson.NumOrNull(route, "total_min");
                    JArray stops = route["stops"] as JArray;
                    if (stops != null)
                    {
                        e.Stops = new string[stops.Count];
                        for (int i = 0; i < stops.Count; i++) e.Stops[i] = (string)stops[i];
                    }
                }
                string dir = official ? web : Path.Combine(web, "scenarios", "pads", e.Id);
                if (Attach(e, dir, ScenarioId)) plans.Add(e);
                else warnings.Add("plan " + e.Id + ": route or timeline file missing in " + dir);
            }
        }

        void ScanResults(string results)
        {
            string[] dirs = Directory.GetDirectories(results);
            Array.Sort(dirs, StringComparer.Ordinal);
            foreach (string dir in dirs)
            {
                string recordPath = Path.Combine(dir, "run_record.json");
                // run_record.json is written last by the engine service: without it the tree is not complete.
                if (!File.Exists(recordPath)) continue;
                try
                {
                    JToken rec = HlJson.Parse(File.ReadAllText(recordPath));
                    if (HlJson.Bool(rec, "dummy", false)) continue;
                    string status = HlJson.Str(rec, "status");
                    if (status == "error" || status == "timeout") continue;

                    var e = new PlanEntry();
                    string hash = HlJson.Str(rec, "hash") ?? Path.GetFileName(dir);
                    e.Id = "live-" + hash;
                    e.Origin = PlanOrigin.Live;
                    e.OriginLabel = HlJson.Str(rec, "label") ?? LabelLive;
                    JToken inputs = rec["inputs"];
                    JToken pad = HlJson.IsNull(inputs) ? null : inputs["pad"];
                    if (HlJson.IsNull(pad))
                    {
                        warnings.Add("live plan " + hash + ": no pad in run_record.json");
                        continue;
                    }
                    e.PadLon = HlJson.Num(pad, "lon");
                    e.PadLat = HlJson.Num(pad, "lat");
                    string title = HlJson.Str(inputs, "title");
                    e.Title = string.IsNullOrEmpty(title) ? "Custom pad · " + Short(hash) : title;

                    // The engine routes the nominal scenario; take it, else whatever route file is there.
                    string scenario = null;
                    if (File.Exists(Path.Combine(dir, "route_" + DefaultScenario + ".geojson"))) scenario = DefaultScenario;
                    else
                    {
                        string[] routes = Directory.GetFiles(dir, "route_*.geojson");
                        Array.Sort(routes, StringComparer.Ordinal);
                        if (routes.Length > 0)
                        {
                            string name = Path.GetFileNameWithoutExtension(routes[0]);
                            scenario = name.Substring("route_".Length);
                        }
                    }
                    if (scenario == null || !Attach(e, dir, scenario))
                    {
                        warnings.Add("live plan " + hash + ": no route and timeline pair in the result tree");
                        continue;
                    }
                    plans.Add(e);
                }
                catch (Exception ex)
                {
                    warnings.Add("live plan in " + Path.GetFileName(dir) + " unreadable: " + ex.Message);
                }
            }
        }

        static bool Attach(PlanEntry e, string dir, string scenario)
        {
            string route = Path.Combine(dir, "route_" + scenario + ".geojson");
            string timeline = Path.Combine(dir, "timeline_" + scenario + ".json");
            if (!File.Exists(route) || !File.Exists(timeline)) return false;
            e.RoutePath = route;
            e.TimelinePath = timeline;
            e.ScenarioId = scenario;
            return true;
        }

        /// <summary>Two pads a few metres apart are nearly the same choice: say so in the list.</summary>
        void AddNearNotes()
        {
            const double metresPerDegree = 59274.6975; // Mars sphere R = 3,396,190 m
            for (int i = 0; i < plans.Count; i++)
            {
                for (int k = 0; k < i; k++)
                {
                    double north = (plans[i].PadLat - plans[k].PadLat) * metresPerDegree;
                    double east = (plans[i].PadLon - plans[k].PadLon) * metresPerDegree * Math.Cos(plans[k].PadLat * Math.PI / 180.0);
                    double d = Math.Sqrt(north * north + east * east);
                    if (d < 0.5 || d > 50) continue;
                    string[] wind = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" };
                    double bearing = Math.Atan2(east, north) * 180.0 / Math.PI;
                    if (bearing < 0) bearing += 360;
                    string dir = wind[(int)Math.Floor((bearing + 22.5) / 45.0) % 8];
                    string other = plans[k].Rank.HasValue ? "rank " + plans[k].Rank.Value : plans[k].Title;
                    plans[i].Note = Math.Round(d).ToString("F0", CultureInfo.InvariantCulture) + " m " + dir + " of " + other;
                    break;
                }
            }
        }

        static string Short(string hash)
        {
            return hash.Length > 8 ? hash.Substring(0, 8) : hash;
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>A route the user made by moving stations, as saved on disk: the base plan and where each station stands.</summary>
    public sealed class SavedRoute
    {
        public string FilePath;
        public string Name;
        /// <summary>Id of the planner plan it was edited from (PlanEntry.Id).</summary>
        public string BasePlanId;
        public string CreatedUtc;
        public List<EditStop> Stops = new List<EditStop>();
        /// <summary>Numbers at the time of saving, for the list; the plan is re-built from the stops when loaded.</summary>
        public double EndMin, O2AtReturnL, MinMarginMin;
    }

    /// <summary>
    /// The user's saved routes: one small JSON file per route in a folder. Only the base plan id and the station
    /// points are stored; route, timings and O2 are re-computed when a route is loaded, so a saved route always
    /// shows what the current data gives.
    /// </summary>
    public static class RouteStore
    {
        public const string FilePrefix = "route_";

        /// <summary>Saved routes, newest first. Unreadable files are skipped.</summary>
        public static List<SavedRoute> List(string folder)
        {
            var list = new List<SavedRoute>();
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return list;
            foreach (string path in Directory.GetFiles(folder, FilePrefix + "*.json"))
            {
                try
                {
                    JToken j = HlJson.Parse(File.ReadAllText(path));
                    var r = new SavedRoute();
                    r.FilePath = path;
                    r.Name = HlJson.Str(j, "name");
                    r.BasePlanId = HlJson.Str(j, "base_plan_id");
                    r.CreatedUtc = HlJson.Str(j, "created_utc");
                    r.EndMin = HlJson.NumOrNull(j, "end_min") ?? 0;
                    r.O2AtReturnL = HlJson.NumOrNull(j, "o2_at_return_L") ?? 0;
                    r.MinMarginMin = HlJson.NumOrNull(j, "min_margin_min") ?? 0;
                    JArray stops = j["stops"] as JArray;
                    if (stops == null || string.IsNullOrEmpty(r.BasePlanId)) continue;
                    foreach (JToken s in stops)
                    {
                        var stop = new EditStop { Id = HlJson.Str(s, "id"), X = HlJson.Num(s, "x_m"), Y = HlJson.Num(s, "y_m"), DwellMin = HlJson.Num(s, "dwell_min") };
                        JArray tags = s["tags"] as JArray;
                        if (tags != null)
                        {
                            var names = new List<string>();
                            foreach (JToken t in tags) names.Add((string)t);
                            stop.Tags = names.ToArray();
                        }
                        stop.Note = HlJson.Str(s, "note") ?? "";
                        r.Stops.Add(stop);
                    }
                    if (r.Stops.Count > 0) list.Add(r);
                }
                catch (Exception)
                {
                    // A damaged file must not hide the other routes.
                }
            }
            list.Sort((a, b) => string.CompareOrdinal(b.CreatedUtc ?? "", a.CreatedUtc ?? ""));
            return list;
        }

        /// <summary>Writes a route and returns it. <paramref name="nowUtc"/> names the file and orders the list.</summary>
        public static SavedRoute Save(string folder, string name, string basePlanId, IList<EditStop> stops, EditedPlanData data, DateTime nowUtc)
        {
            Directory.CreateDirectory(folder);
            var r = new SavedRoute();
            r.Name = name;
            r.BasePlanId = basePlanId;
            r.CreatedUtc = nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
            r.EndMin = data.EndMin;
            r.O2AtReturnL = data.O2AtReturnL;
            r.MinMarginMin = data.MinMarginMin;
            var arr = new JArray();
            foreach (EditStop s in stops)
            {
                r.Stops.Add(s.Copy());
                var o = new JObject();
                o["id"] = s.Id;
                o["x_m"] = s.X;
                o["y_m"] = s.Y;
                o["dwell_min"] = s.DwellMin;
                o["tags"] = new JArray(s.Tags ?? new string[0]);
                o["note"] = s.Note ?? "";
                arr.Add(o);
            }
            var doc = new JObject();
            doc["name"] = name;
            doc["base_plan_id"] = basePlanId;
            doc["created_utc"] = r.CreatedUtc;
            doc["frame"] = "metres east and north of the official pad (planner projection)";
            doc["stops"] = arr;
            doc["end_min"] = data.EndMin;
            doc["o2_at_return_L"] = data.O2AtReturnL;
            doc["min_margin_min"] = data.MinMarginMin;
            doc["note"] = "Edited in the simulator; re-routed with the planner's cost model; not planner engine output.";
            string path = Path.Combine(folder, FilePrefix + nowUtc.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture) + ".json");
            for (int n = 2; File.Exists(path); n++)
                path = Path.Combine(folder, FilePrefix + nowUtc.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture) + "_" + n + ".json");
            File.WriteAllText(path, doc.ToString());
            r.FilePath = path;
            return r;
        }
    }
}

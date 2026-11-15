using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>One leg of a planner route file, with the values the planner states for it.</summary>
    public sealed class GeoRouteLeg
    {
        public int Number;
        public string From;
        public string To;
        public double StartMin;
        public double EndMin;
        /// <summary>O2 the planner charges for walking this leg, litres (slope and mass included); null if not stated.</summary>
        public double? O2L;
        public double? LengthM;
        /// <summary>Distance from the access cell (leg end) to the science point, metres; the walk-in is not modelled by the planner.</summary>
        public double? ToAccessDistM;
    }

    /// <summary>
    /// A route as the planner engine publishes it for the web app and for live results: route_{scenario}.geojson
    /// (contracts/route.schema.json; pipeline/engine/traverse.py). One LineString per leg in lon/lat, the engine's own
    /// vertices, with per-vertex times_min (EVA minutes) and per-leg from, to, t_start_min, t_end_min, length_m, o2_L.
    /// The same format is used by the official plan, by the precomputed alternative pads
    /// (scenarios/pads/{id}/) and by a backend result tree (results/{hash}/), so this one reader covers all of them.
    ///
    /// The route is converted to the metres of ONE frame (the caller's <see cref="PadFrame"/>, normally the official
    /// pad's): positions of every plan are then comparable and the official plan's return fields can be looked up
    /// directly. Nothing is re-routed or re-timed: vertices and times are the engine's.
    /// </summary>
    public sealed class GeoRoute
    {
        readonly List<GeoRouteLeg> legs = new List<GeoRouteLeg>();

        /// <summary>The route as a function of EVA time, in the frame's metres. Heights are not in the file: Z is null.</summary>
        public RouteTrack Track { get; private set; }
        public IReadOnlyList<GeoRouteLeg> Legs { get { return legs; } }
        /// <summary>Where the route starts and ends: the plan's pad.</summary>
        public double PadLon { get; private set; }
        public double PadLat { get; private set; }
        /// <summary>The pad in the frame's metres.</summary>
        public double PadX { get; private set; }
        public double PadY { get; private set; }
        /// <summary>Stations in visit order (the `to` of every leg but the last).</summary>
        public string[] Stops { get; private set; }
        /// <summary>Sum of the planner's per-leg walking O2, litres; null if a leg does not state it.</summary>
        public double? WalkO2L { get; private set; }

        public static GeoRoute Load(string path, PadFrame frame, string scenario)
        {
            return Parse(HlJson.Parse(File.ReadAllText(path)), frame, scenario);
        }

        public static GeoRoute Parse(JToken geojson, PadFrame frame, string scenario)
        {
            JArray features = geojson == null ? null : geojson["features"] as JArray;
            if (features == null || features.Count == 0) throw new InvalidDataException("route geojson has no features");

            var route = new GeoRoute();
            var rows = new JArray();
            var legArr = new JArray();
            double walkO2 = 0;
            bool allO2 = true;
            bool first = true;

            foreach (JToken f in features)
            {
                JToken geom = f["geometry"];
                JToken props = f["properties"];
                if (HlJson.IsNull(geom) || HlJson.Str(geom, "type") != "LineString") continue; // station points etc. are not legs
                JArray coords = geom["coordinates"] as JArray;
                if (coords == null || coords.Count < 2) continue;

                var leg = new GeoRouteLeg();
                leg.Number = (int)HlJson.Num(props, "leg");
                leg.From = HlJson.Str(props, "from");
                leg.To = HlJson.Str(props, "to");
                leg.StartMin = HlJson.Num(props, "t_start_min");
                leg.EndMin = HlJson.Num(props, "t_end_min");
                leg.O2L = HlJson.NumOrNull(props, "o2_L");
                leg.LengthM = HlJson.NumOrNull(props, "length_m");
                leg.ToAccessDistM = HlJson.NumOrNull(props, "to_access_dist_m");
                if (leg.O2L.HasValue) walkO2 += leg.O2L.Value;
                else allO2 = false;

                double[] times = HlJson.Doubles(props["times_min"]);
                bool hasTimes = times != null && times.Length == coords.Count;

                int firstRow = rows.Count;
                double s = 0, px = 0, py = 0;
                int kept = 0;
                for (int i = 0; i < coords.Count; i++)
                {
                    var c = (JArray)coords[i];
                    double lon = HlJson.ToDouble(c[0]), lat = HlJson.ToDouble(c[1]);
                    double x, y;
                    frame.LonLatToLocal(lon, lat, out x, out y);
                    if (first)
                    {
                        route.PadLon = lon;
                        route.PadLat = lat;
                        route.PadX = x;
                        route.PadY = y;
                        first = false;
                    }
                    if (kept > 0)
                    {
                        double d = Math.Sqrt((x - px) * (x - px) + (y - py) * (y - py));
                        // A repeated vertex carries no distance: RouteTrack needs s to grow strictly.
                        if (d < 1e-6 && i < coords.Count - 1) continue;
                        if (d < 1e-6) d = 1e-6;
                        s += d;
                    }
                    double t = hasTimes
                        ? times[i]
                        : leg.StartMin + (leg.EndMin - leg.StartMin) * i / (coords.Count - 1.0);
                    var row = new JArray();
                    row.Add(leg.Number);
                    row.Add(s);
                    row.Add(x);
                    row.Add(y);
                    row.Add(JValue.CreateNull());
                    row.Add(t);
                    row.Add(JValue.CreateNull());
                    row.Add(JValue.CreateNull());
                    row.Add(JValue.CreateNull());
                    rows.Add(row);
                    px = x;
                    py = y;
                    kept++;
                }

                var lj = new JObject();
                lj["leg"] = leg.Number;
                lj["from"] = leg.From;
                lj["to"] = leg.To;
                lj["t_start_min"] = leg.StartMin;
                lj["t_end_min"] = leg.EndMin;
                if (leg.LengthM.HasValue) lj["length_m"] = leg.LengthM.Value;
                lj["first_row"] = firstRow;
                lj["n_rows"] = kept;
                legArr.Add(lj);
                route.legs.Add(leg);
            }
            if (route.legs.Count == 0) throw new InvalidDataException("route geojson has no LineString legs");

            var doc = new JObject();
            doc["frame"] = "pad-local";
            doc["scenario"] = scenario;
            doc["step_m"] = 3.0;
            doc["columns"] = new JArray("leg", "s_m", "x_m", "y_m", "z_m", "t_eva_min", "speed_ms", "grade_deg", "slope_deg");
            doc["legs"] = legArr;
            doc["rows"] = rows;
            route.Track = RouteTrack.Parse(doc);

            route.legs.Sort((a, b) => a.Number.CompareTo(b.Number));
            var stops = new List<string>();
            for (int i = 0; i < route.legs.Count - 1; i++) stops.Add(route.legs[i].To);
            route.Stops = stops.ToArray();
            route.WalkO2L = allO2 ? (double?)walkO2 : null;
            return route;
        }
    }
}

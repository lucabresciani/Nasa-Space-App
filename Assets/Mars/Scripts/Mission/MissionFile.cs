using System;
using System.Collections.Generic;
using System.Globalization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Mission
{
    /// <summary>
    /// mission.json as the HOMELINE web Mission Planer (/mission) exports it: contract
    /// <c>contracts/bundle/mission.schema.json</c> v1.1.0 in the home-line repo. Plain data, field names as in the file;
    /// <see cref="MissionPlan"/> turns it into world positions. Unknown values are null in the file and stay null here.
    /// Parse with <see cref="Parse"/>, which also checks the parts the simulator relies on.
    /// </summary>
    public sealed class MissionFile
    {
        public const string Kind = "homeline_mission";
        public const int SupportedMajor = 1;
        public const int MinMinor = 1;   // 1.1.0 introduced mission.json

        public static readonly string[] PathColumns =
            { "leg", "s_m", "x_m", "y_m", "z_m", "t_eva_min", "o2_used_l", "t_home_min", "o2_home_l" };
        public static readonly string[] TimelineColumns =
            { "t_min", "phase", "wp", "o2_used_l", "t_home_min", "o2_home_l", "tasks_left_l", "margin_min", "binding" };

        [JsonProperty("schema_version")] public string SchemaVersion;
        [JsonProperty("kind")] public string FileKind;
        [JsonProperty("mission_id")] public string MissionId;
        [JsonProperty("title")] public string Title;
        [JsonProperty("created_utc")] public string CreatedUtc;
        [JsonProperty("origin")] public string Origin;
        [JsonProperty("origin_label")] public string OriginLabel;
        [JsonProperty("planner")] public PlannerBlock Planner;
        [JsonProperty("frame")] public FrameBlock Frame;
        [JsonProperty("scenario")] public ScenarioBlock Scenario;
        [JsonProperty("world")] public WorldBlock World;
        [JsonProperty("constants")] public ConstantsBlock Constants;
        [JsonProperty("conditions")] public ConditionsBlock Conditions;
        [JsonProperty("waypoints")] public List<WaypointEntry> Waypoints;
        [JsonProperty("legs")] public List<LegEntry> Legs;
        [JsonProperty("path")] public PathBlock Path;
        [JsonProperty("timeline")] public TimelineBlock Timeline;   // null when a leg is missing
        [JsonProperty("summary")] public SummaryBlock Summary;
        [JsonProperty("label")] public string Label;
        [JsonProperty("dummy")] public bool Dummy;

        public sealed class PlannerBlock
        {
            [JsonProperty("app_commit")] public string AppCommit;
            [JsonProperty("config_hash")] public string ConfigHash;
            [JsonProperty("routing_grid_res_m")] public double RoutingGridResM;
            [JsonProperty("elevation_res_m")] public double ElevationResM;
        }

        public sealed class FrameBlock
        {
            [JsonProperty("kind")] public string Kind;
            [JsonProperty("projection")] public ProjectionBlock Projection;
            [JsonProperty("pad")] public PadBlock Pad;
        }

        public sealed class ProjectionBlock
        {
            [JsonProperty("proj")] public string Proj;
            [JsonProperty("pad_xy_m")] public double[] PadXyM;
        }

        public sealed class PadBlock
        {
            [JsonProperty("kind")] public string Kind;
            [JsonProperty("id")] public string Id;
            [JsonProperty("lon")] public double Lon;
            [JsonProperty("lat")] public double Lat;
            [JsonProperty("elev_m")] public double? ElevM;
            [JsonProperty("source")] public string Source;
        }

        public sealed class ScenarioBlock
        {
            [JsonProperty("id")] public string Id;
            [JsonProperty("variant")] public string Variant;
            [JsonProperty("suit_kg")] public double SuitKg;
        }

        public sealed class WorldBlock
        {
            [JsonProperty("version")] public string Version;
            [JsonProperty("plan_bundle_id")] public string PlanBundleId;
        }

        public sealed class ConstantsBlock
        {
            [JsonProperty("o2_capacity_l")] public double O2CapacityL;
            [JsonProperty("effort_rate_l_min")] public double EffortRateLMin;
            [JsonProperty("station_rate_l_min")] public double StationRateLMin;
            [JsonProperty("reserve_l")] public double ReserveL;
            [JsonProperty("eva_limit_min")] public double EvaLimitMin;
            [JsonProperty("margin_amber_min")] public double MarginAmberMin;
        }

        public sealed class ConditionsBlock
        {
            [JsonProperty("eva_start_lmst")] public string EvaStartLmst;
            [JsonProperty("t_dark_min")] public double? TDarkMin;
            [JsonProperty("storm_replay")] public bool StormReplay;
            [JsonProperty("t_star_min")] public double? TStarMin;
        }

        public sealed class WaypointEntry
        {
            [JsonProperty("index")] public int Index;
            [JsonProperty("id")] public int? Id;
            [JsonProperty("lonlat")] public double[] LonLat;
            [JsonProperty("x_m")] public double XM;
            [JsonProperty("y_m")] public double YM;
            [JsonProperty("z_m")] public double? ZM;
            [JsonProperty("note")] public string Note;
            [JsonProperty("tags")] public List<string> Tags;
            [JsonProperty("stop_min")] public double StopMin;
            [JsonProperty("arrive_t_min")] public double? ArriveTMin;
            [JsonProperty("leave_t_min")] public double? LeaveTMin;
            [JsonProperty("o2_used_at_leave_l")] public double? O2UsedAtLeaveL;
            [JsonProperty("t_home_min")] public double? THomeMin;
            [JsonProperty("o2_home_l")] public double? O2HomeL;
        }

        public sealed class LegEntry
        {
            [JsonProperty("leg")] public int Leg;
            [JsonProperty("kind")] public string Kind;   // "out" | "home"
            [JsonProperty("from")] public string From;
            [JsonProperty("to")] public string To;
            [JsonProperty("routed")] public bool Routed;
            [JsonProperty("length_m")] public double? LengthM;
            [JsonProperty("time_min")] public double? TimeMin;
            [JsonProperty("o2_l")] public double? O2L;
            [JsonProperty("t_start_min")] public double? TStartMin;
            [JsonProperty("t_end_min")] public double? TEndMin;
            [JsonProperty("first_row")] public int? FirstRow;
            [JsonProperty("n_rows")] public int NRows;
        }

        public sealed class PathBlock
        {
            [JsonProperty("columns")] public string[] Columns;
            [JsonProperty("rows")] public List<double?[]> Rows;
        }

        public sealed class TimelineBlock
        {
            [JsonProperty("columns")] public string[] Columns;
            [JsonProperty("terms")] public List<string> Terms;
            [JsonProperty("rows")] public List<JArray> Rows;   // mixed types: number, phase string, wp int|null, ..., binding string
            [JsonProperty("lowest")] public LowestBlock Lowest;
        }

        public sealed class LowestBlock
        {
            [JsonProperty("margin_min")] public double MarginMin;
            [JsonProperty("binding")] public string Binding;
            [JsonProperty("t_min")] public double TMin;
        }

        public sealed class SummaryBlock
        {
            [JsonProperty("feasible")] public bool? Feasible;
            [JsonProperty("walk_min")] public double? WalkMin;
            [JsonProperty("stop_min")] public double StopMin;
            [JsonProperty("t_home_min")] public double? THomeMin;
            [JsonProperty("eva_min")] public double? EvaMin;
            [JsonProperty("time_margin_min")] public double? TimeMarginMin;
            [JsonProperty("o2_used_l")] public double? O2UsedL;
            [JsonProperty("o2_home_l")] public double? O2HomeL;
            [JsonProperty("o2_need_l")] public double? O2NeedL;
            [JsonProperty("o2_margin_l")] public double? O2MarginL;
            [JsonProperty("o2_margin_min")] public double? O2MarginMin;
        }

        /// <summary>
        /// Parses and checks a mission.json text. Returns null and a reason when the file is not a mission the simulator
        /// can use (wrong kind, unsupported schema version, missing frame/path, malformed rows). Extra fields are ignored.
        /// </summary>
        public static MissionFile Parse(string json, out string error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(json))
            {
                error = "empty file";
                return null;
            }
            MissionFile f;
            try
            {
                var settings = new JsonSerializerSettings
                {
                    MissingMemberHandling = MissingMemberHandling.Ignore,
                    FloatParseHandling = FloatParseHandling.Double,
                    Culture = CultureInfo.InvariantCulture,
                };
                f = JsonConvert.DeserializeObject<MissionFile>(json, settings);
            }
            catch (Exception e)
            {
                error = "not valid JSON: " + e.Message;
                return null;
            }
            if (f == null)
            {
                error = "empty document";
                return null;
            }
            error = f.Check();
            return error == null ? f : null;
        }

        // The checks the loader depends on; the full contract is validated on the web side.
        private string Check()
        {
            if (FileKind != Kind)
            {
                return "kind is '" + (FileKind ?? "null") + "', expected '" + Kind + "' (is this a mission.json from the Mission Planer?)";
            }
            if (!TryVersion(SchemaVersion, out int major, out int minor) || major != SupportedMajor || minor < MinMinor)
            {
                return "schema_version " + (SchemaVersion ?? "null") + " is not supported (need " + SupportedMajor + "." + MinMinor + ".x)";
            }
            if (Frame == null || Frame.Kind != "pad-local" || Frame.Pad == null || Frame.Projection == null)
            {
                return "frame block missing or not pad-local";
            }
            if (Frame.Projection.PadXyM == null || Frame.Projection.PadXyM.Length != 2)
            {
                return "frame.projection.pad_xy_m missing";
            }
            if (!Eqc.TryParse(Frame.Projection.Proj, out _, out string projError))
            {
                return "frame.projection.proj: " + projError;
            }
            if (Waypoints == null || Legs == null || Path == null || Path.Rows == null || Summary == null || Constants == null)
            {
                return "waypoints, legs, path, summary or constants missing";
            }
            if (!SameColumns(Path.Columns, PathColumns))
            {
                return "path.columns differ from " + string.Join(",", PathColumns);
            }
            for (int i = 0; i < Path.Rows.Count; i++)
            {
                double?[] r = Path.Rows[i];
                if (r == null || r.Length != PathColumns.Length || !r[0].HasValue || !r[1].HasValue || !r[2].HasValue || !r[3].HasValue)
                {
                    return "path.rows[" + i + "] malformed (need 9 values; leg, s_m, x_m, y_m never null)";
                }
            }
            for (int i = 0; i < Waypoints.Count; i++)
            {
                WaypointEntry w = Waypoints[i];
                if (w == null || w.LonLat == null || w.LonLat.Length != 2)
                {
                    return "waypoints[" + i + "].lonlat missing";
                }
            }
            for (int i = 0; i < Legs.Count; i++)
            {
                LegEntry l = Legs[i];
                if (l == null)
                {
                    return "legs[" + i + "] is null";
                }
                if (l.FirstRow.HasValue && (l.FirstRow.Value < 0 || l.FirstRow.Value + l.NRows > Path.Rows.Count))
                {
                    return "legs[" + i + "] rows " + l.FirstRow + "+" + l.NRows + " outside path.rows";
                }
            }
            if (Timeline != null)
            {
                if (!SameColumns(Timeline.Columns, TimelineColumns))
                {
                    return "timeline.columns differ from " + string.Join(",", TimelineColumns);
                }
                if (Timeline.Rows == null)
                {
                    return "timeline.rows missing";
                }
                for (int i = 0; i < Timeline.Rows.Count; i++)
                {
                    if (Timeline.Rows[i] == null || Timeline.Rows[i].Count != TimelineColumns.Length)
                    {
                        return "timeline.rows[" + i + "] malformed (need 9 values)";
                    }
                }
            }
            return null;
        }

        private static bool SameColumns(string[] a, string[] b)
        {
            if (a == null || a.Length != b.Length)
            {
                return false;
            }
            for (int i = 0; i < a.Length; i++)
            {
                if (a[i] != b[i])
                {
                    return false;
                }
            }
            return true;
        }

        private static bool TryVersion(string v, out int major, out int minor)
        {
            major = minor = -1;
            if (string.IsNullOrEmpty(v))
            {
                return false;
            }
            string[] p = v.Split('.');
            return p.Length >= 2
                && int.TryParse(p[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out major)
                && int.TryParse(p[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out minor);
        }
    }

    /// <summary>
    /// The planner's equirectangular projection (PROJ "+proj=eqc ... +R=..."), enough to turn pad-local metres back into
    /// latitude/longitude: x = x_0 + R·(lon − lon_0)·cos(lat_ts), y = y_0 + R·(lat − lat_0), angles in radians.
    /// Same formulas as web/src/fp3d/geo.ts (parseEqc, xyToLonLat).
    /// </summary>
    public readonly struct Eqc
    {
        public readonly double R, LatTsDeg, Lon0Deg, Lat0Deg, X0, Y0;

        public Eqc(double r, double latTsDeg, double lon0Deg, double lat0Deg, double x0, double y0)
        {
            R = r;
            LatTsDeg = latTsDeg;
            Lon0Deg = lon0Deg;
            Lat0Deg = lat0Deg;
            X0 = x0;
            Y0 = y0;
        }

        private const double Deg = Math.PI / 180.0;

        /// <summary>Projected metres → (lon, lat) in degrees.</summary>
        public void ToLonLat(double x, double y, out double lon, out double lat)
        {
            lon = Lon0Deg + (x - X0) / (R * Math.Cos(LatTsDeg * Deg)) / Deg;
            lat = Lat0Deg + (y - Y0) / R / Deg;
        }

        /// <summary>(lon, lat) in degrees → projected metres.</summary>
        public void ToXY(double lon, double lat, out double x, out double y)
        {
            x = X0 + R * (lon - Lon0Deg) * Deg * Math.Cos(LatTsDeg * Deg);
            y = Y0 + R * (lat - Lat0Deg) * Deg;
        }

        public static bool TryParse(string proj, out Eqc eqc, out string error)
        {
            eqc = default;
            error = null;
            if (string.IsNullOrWhiteSpace(proj))
            {
                error = "empty";
                return false;
            }
            var kv = new Dictionary<string, string>();
            foreach (string tok in proj.Split((char[])null, StringSplitOptions.RemoveEmptyEntries))
            {
                if (!tok.StartsWith("+", StringComparison.Ordinal))
                {
                    continue;
                }
                int eq = tok.IndexOf('=');
                string key = eq < 0 ? tok.Substring(1) : tok.Substring(1, eq - 1);
                kv[key] = eq < 0 ? string.Empty : tok.Substring(eq + 1);
            }
            if (!kv.TryGetValue("proj", out string p) || p != "eqc")
            {
                error = "not an eqc projection: " + proj;
                return false;
            }
            if (kv.TryGetValue("units", out string units) && units != "m")
            {
                error = "units must be m: " + proj;
                return false;
            }
            if (!Num(kv, "R", double.NaN, out double r) || !(r > 0))
            {
                error = "needs +R: " + proj;
                return false;
            }
            if (!Num(kv, "lat_ts", 0, out double latTs) || !Num(kv, "lon_0", 0, out double lon0) || !Num(kv, "lat_0", 0, out double lat0)
                || !Num(kv, "x_0", 0, out double x0) || !Num(kv, "y_0", 0, out double y0))
            {
                error = "bad number in " + proj;
                return false;
            }
            eqc = new Eqc(r, latTs, lon0, lat0, x0, y0);
            return true;
        }

        private static bool Num(Dictionary<string, string> kv, string key, double fallback, out double value)
        {
            if (!kv.TryGetValue(key, out string s))
            {
                value = fallback;
                return true;
            }
            return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out value) && !double.IsNaN(value) && !double.IsInfinity(value);
        }
    }
}

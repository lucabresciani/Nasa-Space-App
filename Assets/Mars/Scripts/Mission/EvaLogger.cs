using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace NasaSpaceApp.Mission
{
    /// <summary>
    /// Records a mission EVA for replay on the web: a track sample every <see cref="SampleEveryMin"/> of EVA time (map
    /// position, cross-track, schedule and O₂ against the plan, live margin, status) plus events (start, arrive, done,
    /// skip, status change, complete), and writes <c>eva_log_{mission_id}_{utc}.json</c> (kind <c>homeline_eva_log</c>,
    /// draft contract <c>contracts/bundle/eva_log.schema.json</c> in home-line) to ~/Downloads, else persistentDataPath.
    /// Written automatically when the EVA completes; an interrupted EVA (new mission, Clear, scene end) is written as
    /// incomplete if it lasted at least <see cref="MinUsefulMin"/>. Tools ▸ Mars ▸ Export EVA Log writes it on demand.
    /// </summary>
    public sealed class EvaLogger
    {
        public const string SchemaVersion = "1.1.0";
        public const string Kind = "homeline_eva_log";
        public const float SampleEveryMin = 5f / 60f;
        public const float MinUsefulMin = 0.5f;

        /// <summary>The logger of the running HUD (null without one).</summary>
        public static EvaLogger Active { get; private set; }

        /// <summary>Write the file automatically on completion / interruption (tests outside Unity turn it off).</summary>
        public static bool AutoWrite = true;

        /// <summary>Path of the last written log (null before the first).</summary>
        public static string LastWrittenPath { get; private set; }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            Active = null;
            LastWrittenPath = null;
            AutoWrite = true;
        }

        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        private MissionTracker tracker;
        private MissionPlan plan;
        private DateTime startUtc;
        private readonly List<object[]> rows = new List<object[]>(1024);
        private readonly List<JObject> events = new List<JObject>(64);
        private float nextSampleMin;
        private bool written;
        private float lowestMargin = float.NaN;
        private string lowestBinding;
        private float maxCross, maxBehind;

        public EvaLogger()
        {
            Active = this;
        }

        public bool HasData => plan != null && rows.Count > 0;

        /// <summary>Starts a new log for <paramref name="t"/>'s plan (call right after <see cref="MissionTracker.Begin"/>).</summary>
        public void Begin(MissionTracker t)
        {
            Detach();
            tracker = t;
            plan = t.Plan;
            rows.Clear();
            events.Clear();
            nextSampleMin = 0f;
            written = false;
            lowestMargin = float.NaN;
            lowestBinding = null;
            maxCross = maxBehind = 0f;
            startUtc = DateTime.UtcNow;
            if (plan == null)
            {
                return;
            }
            t.WaypointArrived += OnArrived;
            t.WaypointDone += OnDone;
            t.WaypointSkipped += OnSkipped;
            t.StatusChanged += OnStatus;
            t.MissionComplete += OnComplete;
            Event(0f, "start", -1, plan.Title);
        }

        /// <summary>Writes an unfinished log (if worth it) and stops recording.</summary>
        public void End(string reason)
        {
            if (plan != null && !written && tracker != null && tracker.EvaMin >= MinUsefulMin)
            {
                Event(tracker.EvaMin, "end", -1, reason);
                if (AutoWrite) Write();
            }
            Detach();
            plan = null;
        }

        private void Detach()
        {
            if (tracker != null)
            {
                tracker.WaypointArrived -= OnArrived;
                tracker.WaypointDone -= OnDone;
                tracker.WaypointSkipped -= OnSkipped;
                tracker.StatusChanged -= OnStatus;
                tracker.MissionComplete -= OnComplete;
            }
            tracker = null;
        }

        /// <summary>Call after each tracker tick.</summary>
        public void Sample()
        {
            if (plan == null || tracker == null || tracker.Plan != plan)
            {
                return;
            }
            float t = tracker.EvaMin;
            if (!float.IsNaN(tracker.MarginMin) && (float.IsNaN(lowestMargin) || tracker.MarginMin < lowestMargin))
            {
                lowestMargin = tracker.MarginMin;
                lowestBinding = tracker.Binding;
            }
            if (!float.IsNaN(tracker.CrossTrackM)) maxCross = Mathf.Max(maxCross, tracker.CrossTrackM);
            if (!float.IsNaN(tracker.ScheduleDeltaMin)) maxBehind = Mathf.Max(maxBehind, tracker.ScheduleDeltaMin);
            if (t + 1e-6f < nextSampleMin)
            {
                return;
            }
            nextSampleMin += SampleEveryMin;           // fixed 5 s grid
            if (nextSampleMin <= t)
            {
                nextSampleMin = t + SampleEveryMin;    // a long pause: restart the grid
            }
            MarsGeoReference geo = MarsGeoReference.Instance;
            double lat = double.NaN, lon = double.NaN;
            float elev = float.NaN;
            if (geo != null)
            {
                MarsCoordinates c = geo.ToMapCoordinates(tracker.Position);
                lat = c.Latitude;
                lon = c.Longitude;
                elev = c.Elevation;
            }
            rows.Add(new object[]
            {
                R(t, 3), R(lon, 7), R(lat, 7), R(elev, 1), R(tracker.CrossTrackM, 1), R(tracker.ScheduleDeltaMin, 2),
                R(tracker.O2UsedL, 2), R(tracker.O2DeltaL, 2), R(tracker.MarginMin, 1), MissionTracker.StatusLabel(tracker.Status),
            });
        }

        private void OnArrived(int i) => Event(tracker.EvaMin, "arrive", i, null);
        private void OnSkipped(int i) => Event(tracker.EvaMin, "skip", i, null);
        private void OnDone(int i) => Event(tracker.EvaMin, "done", i, tracker.LeftEarly[i] ? "left early" : null);
        private void OnStatus(MissionStatus s) => Event(tracker.EvaMin, "status", -1, MissionTracker.StatusLabel(s));

        private void OnComplete()
        {
            Sample();
            Event(tracker.EvaMin, "complete", -1, null);
            if (AutoWrite) Write();
        }

        private void Event(float t, string kind, int wpIndex, string detail)
        {
            var e = new JObject
            {
                ["t_min"] = R(t, 3),
                ["kind"] = kind,
                ["wp"] = wpIndex >= 0 && plan != null ? (JToken)plan.Waypoints[wpIndex].Index : JValue.CreateNull(),
            };
            if (detail != null) e["detail"] = detail;
            events.Add(e);
        }

        /// <summary>Builds the log document (also used by tests).</summary>
        public JObject Build()
        {
            var wps = new JArray();
            int done = 0, skipped = 0, early = 0;
            for (int i = 0; i < plan.Waypoints.Count; i++)
            {
                MissionWaypoint w = plan.Waypoints[i];
                WaypointState st = tracker != null && i < tracker.States.Length ? tracker.States[i] : WaypointState.Upcoming;
                bool le = tracker != null && i < tracker.LeftEarly.Length && tracker.LeftEarly[i];
                if (st == WaypointState.Done) done++;
                if (st == WaypointState.Skipped) skipped++;
                if (le) early++;
                wps.Add(new JObject
                {
                    ["index"] = w.Index,
                    ["state"] = st.ToString().ToLowerInvariant(),
                    ["planned_arrive_min"] = R(w.ArriveMin, 3),
                    ["planned_leave_min"] = R(w.LeaveMin, 3),
                    ["arrived_min"] = R(tracker != null ? tracker.ArrivedAtMin[i] : float.NaN, 3),
                    ["done_min"] = R(tracker != null ? tracker.DoneAtMin[i] : float.NaN, 3),
                    ["left_early"] = le,
                });
            }
            bool complete = tracker != null && tracker.Complete;
            var doc = new JObject
            {
                ["schema_version"] = SchemaVersion,
                ["kind"] = Kind,
                ["mission_id"] = plan.Id,
                ["title"] = plan.Title,
                ["created_utc"] = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", Inv),
                ["started_utc"] = startUtc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", Inv),
                ["origin"] = "unity_simulator",
                ["origin_label"] = "Simulated EVA in the Unity simulator, compared with a Mission Planer plan",
                ["label"] = "Simulated EVA · real terrain and data",
                ["dummy"] = plan.Dummy,
                ["o2_model"] = "simulator suit model (SuitTelemetry), not the planner's budget rates",
                ["pad"] = new JObject { ["lon"] = plan.Source.Frame.Pad.Lon, ["lat"] = plan.Source.Frame.Pad.Lat },
                ["summary"] = new JObject
                {
                    ["complete"] = complete,
                    ["eva_min"] = R(tracker != null ? (complete ? tracker.CompleteAtMin : tracker.EvaMin) : float.NaN, 3),
                    ["planned_eva_min"] = R(plan.EvaMin, 3),
                    ["final_status"] = tracker != null ? MissionTracker.StatusLabel(tracker.Status) : null,
                    ["waypoints_done"] = done,
                    ["waypoints_skipped"] = skipped,
                    ["stops_left_early"] = early,
                    ["lowest_margin_min"] = R(lowestMargin, 2),
                    ["lowest_binding"] = lowestBinding,
                    ["max_cross_track_m"] = R(maxCross, 1),
                    ["max_behind_min"] = R(maxBehind, 2),
                    ["o2_used_l"] = R(tracker != null ? tracker.O2UsedL : float.NaN, 2),
                    ["planned_o2_used_l"] = R(plan.O2UsedL, 2),
                },
                ["waypoints"] = wps,
                ["events"] = new JArray(events),
                ["track"] = new JObject
                {
                    ["columns"] = new JArray("t_min", "lon", "lat", "elev_m", "cross_track_m", "schedule_delta_min",
                                             "o2_used_l", "o2_delta_l", "margin_min", "status"),
                    ["sample_every_min"] = R(SampleEveryMin, 4),
                    ["rows"] = JArray.FromObject(rows),
                },
            };
            return doc;
        }

        /// <summary>Writes the log now; returns the path, or null when there is nothing to write.</summary>
        public string Write()
        {
            if (plan == null)
            {
                return null;
            }
            string json = Build().ToString(Formatting.None);
            written = true;
#if UNITY_WEBGL && !UNITY_EDITOR
            Debug.Log("[Mission] EVA log ready (" + json.Length + " chars); WebGL has no file system to write it to");
            return null;
#else
            string stamp = DateTime.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'", Inv);
            string name = "eva_log_" + (plan.Id ?? "mission") + "_" + stamp + ".json";
            string dir = OutputDir();
            try
            {
                Directory.CreateDirectory(dir);
                string path = Path.Combine(dir, name);
                File.WriteAllText(path, json);
                LastWrittenPath = path;
                Debug.Log("[Mission] EVA log written: " + path);
                return path;
            }
            catch (Exception e)
            {
                Debug.LogWarning("[Mission] EVA log not written: " + e.Message);
                return null;
            }
#endif
        }

        private static string OutputDir()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string downloads = string.IsNullOrEmpty(home) ? null : Path.Combine(home, "Downloads");
            return downloads != null && Directory.Exists(downloads) ? downloads : Path.Combine(Application.persistentDataPath, "eva_logs");
        }

        private static JToken R(double v, int digits)
        {
            return double.IsNaN(v) || double.IsInfinity(v) ? JValue.CreateNull() : (JToken)Math.Round(v, digits);
        }
    }
}

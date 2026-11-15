using System;
using System.Globalization;
using System.IO;
using System.Text;
using NasaSpaceApp.Mission;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Checks a web mission.json against the real scene, without play mode: the mission is placed on the Mars terrain
    /// (every waypoint and route point on the HD play terrain), the planner's elevations agree with Unity's terrain
    /// (pad, waypoints), and a walk exactly on the plan keeps the tracker ON PLAN with the live margin within 0.5 min of
    /// the plan's timeline (SPEC F18 acceptance) and ends COMPLETE.
    /// Menu: Tools ▸ Mars ▸ Mission Self-Test (newest ~/Downloads/mission*.json). Batch:
    /// <c>Unity -batchmode -nographics -projectPath … -executeMethod NasaSpaceApp.MarsGen.MissionSelfTest.RunBatch
    /// [-missionTest path/to/mission.json] -logFile -</c> (exit code 0 = pass).
    /// </summary>
    public static class MissionSelfTest
    {
        private const string ScenePath = "Assets/Scenes/MarsLandscape.unity";
        private const float ElevWarnM = 5f, ElevFailM = 25f;   // planner DEM (8 m far grid) vs Unity terrain
        private const float MarginTolMin = 0.5f;
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        [MenuItem("Tools/Mars/Mission Self-Test (newest mission.json)")]
        private static void RunMenu()
        {
            if (EditorApplication.isPlaying)
            {
                EditorUtility.DisplayDialog("Mission Self-Test", "Leave play mode first.", "OK");
                return;
            }
            int fails = Run(out string report);
            EditorUtility.DisplayDialog("Mission Self-Test", (fails == 0 ? "PASS\n\n" : fails + " check(s) FAILED\n\n") + report, "OK");
        }

        /// <summary>Batch entry point; exits Unity with 0 (pass) or 1.</summary>
        public static void RunBatch()
        {
            int fails;
            try
            {
                fails = Run(out _);
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                fails = 1;
            }
            EditorApplication.Exit(fails == 0 ? 0 : 1);
        }

        private static int Run(out string report)
        {
            var sb = new StringBuilder();
            int fails = 0;
            void Check(bool ok, string what)
            {
                sb.AppendLine((ok ? "PASS " : "FAIL ") + what);
                if (!ok) fails++;
            }
            void Note(string what) => sb.AppendLine("     " + what);

            string path = ArgAfter("-missionTest") ?? MissionLink.NewestCandidate();
            if (path == null || !File.Exists(path))
            {
                report = "No mission file (pass -missionTest <path> or download one to ~/Downloads).";
                Debug.LogError("[MissionSelfTest] " + report);
                return 1;
            }
            Note("mission: " + path);

            if (MarsGeoReference.Instance == null)
            {
                EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
            }
            MarsGeoReference geo = MarsGeoReference.Instance;
            if (geo == null)
            {
                report = "No MarsGeoReference in " + ScenePath;
                Debug.LogError("[MissionSelfTest] " + report);
                return 1;
            }

            MissionFile file = MissionFile.Parse(File.ReadAllText(path), out string error);
            Check(file != null, "parse mission.json " + (error ?? string.Empty));
            if (file == null)
            {
                report = sb.ToString();
                Debug.LogError("[MissionSelfTest]\n" + report);
                return fails;
            }
            var world = new SceneMissionWorld(geo);
            MissionPlan plan = MissionPlan.Build(file, world);
            Note(plan.ToString());
            foreach (string w in plan.Warnings) Note("warning: " + w);

            // 1. Placement: every point on the HD play terrain.
            Terrain hd = world.FinestTerrain();
            int off = 0;
            foreach (Vector3 p in plan.Route) if (world.TerrainAt(p) != hd) off++;
            foreach (MissionWaypoint w in plan.Waypoints) if (world.TerrainAt(w.World) != hd) off++;
            if (world.TerrainAt(plan.PadWorld) != hd) off++;
            Check(hd != null && off == 0, "pad, waypoints and route lie on the HD play terrain (" + off + " outside)");

            // 2. Elevations: planner (pad elev_m + z_m) vs Unity terrain (MOLA).
            double? padElev = file.Frame.Pad.ElevM;
            if (padElev.HasValue)
            {
                float padDiff = geo.ElevationMOLA(plan.PadWorld) - (float)padElev.Value;
                float worst = Mathf.Abs(padDiff);
                int worstWp = 0;
                for (int i = 0; i < plan.Waypoints.Count; i++)
                {
                    double? z = file.Waypoints[i].ZM;
                    if (!z.HasValue) continue;
                    float d = geo.ElevationMOLA(plan.Waypoints[i].World) - (float)(padElev.Value + z.Value);
                    if (Mathf.Abs(d) > worst)
                    {
                        worst = Mathf.Abs(d);
                        worstWp = plan.Waypoints[i].Index;
                    }
                }
                Note(string.Format(Inv, "elevation: pad Unity − planner = {0:+0.0;-0.0} m; worst |Δ| {1:0.0} m{2}", padDiff, worst,
                                   worstWp > 0 ? " at #" + worstWp : " at the pad"));
                Check(worst < ElevFailM, string.Format(Inv, "planner and Unity terrain agree within {0:0} m (worst {1:0.0} m)", ElevFailM, worst));
                if (worst >= ElevWarnM) Note(string.Format(Inv, "note: more than {0:0} m apart somewhere: the planner uses the 8 m far grid", ElevWarnM));
            }
            else
            {
                Note("elevation: pad elev_m unknown in the file, skipped");
            }

            // 3. Tracker on an exact on-plan walk (suit O₂ = capacity − planned use).
            var tr = new MissionTracker();
            tr.Begin(plan);
            float cap = (float)plan.Constants.O2CapacityL;
            float worstMargin = 0f, worstDelta = 0f;
            int offPlan = 0;
            float end = float.IsNaN(plan.EvaMin) ? 0f : plan.EvaMin + 0.5f;
            for (float t = 0f; t <= end && !tr.Complete; t += 0.02f)
            {
                At(plan, t, out Vector3 pos, out float used);
                tr.Tick(pos, t, cap - used);
                if (!float.IsNaN(tr.ScheduleDeltaMin)) worstDelta = Mathf.Max(worstDelta, Mathf.Abs(tr.ScheduleDeltaMin));
                if (tr.Status != MissionStatus.OnPlan && tr.Status != MissionStatus.HeadingHome && tr.Status != MissionStatus.Complete) offPlan++;
                if (NearStopEdge(plan, t) || t < 0.3f || t > plan.EvaMin - 0.5f) continue;
                if (plan.TryPlannedAt(t, out MissionTimelineRow st) && !float.IsNaN(tr.MarginMin))
                {
                    worstMargin = Mathf.Max(worstMargin, Mathf.Abs(tr.MarginMin - st.MarginMin));
                }
            }
            Check(offPlan == 0, "on-plan walk stays ON PLAN / HEADING HOME (" + offPlan + " ticks off)");
            Check(worstDelta < 1f, string.Format(Inv, "on-plan walk: |schedule delta| ≤ {0:0.00} min", worstDelta));
            if (plan.Timeline.Count > 0)
            {
                Check(worstMargin < MarginTolMin, string.Format(Inv, "live margin within {0} min of the plan timeline (worst {1:0.000})", MarginTolMin, worstMargin));
            }
            Check(tr.Complete, "on-plan walk ends EVA COMPLETE at the pad");

            report = sb.ToString();
            if (fails == 0) Debug.Log("[MissionSelfTest] PASS\n" + report);
            else Debug.LogError("[MissionSelfTest] " + fails + " FAILED\n" + report);
            return fails;
        }

        // Position and planned O₂ used on the plan at EVA minute t (on the route while walking, at the waypoint in a stop).
        private static void At(MissionPlan pl, float t, out Vector3 pos, out float used)
        {
            Vector3[] r = pl.Route;
            float[] ts = pl.RouteT;
            for (int i = 0; i + 1 < r.Length; i++)
            {
                if (ts[i] <= t && t <= ts[i + 1] && ts[i + 1] > ts[i])
                {
                    float u = (t - ts[i]) / (ts[i + 1] - ts[i]);
                    pos = Vector3.Lerp(r[i], r[i + 1], u);
                    used = Mathf.Lerp(pl.RouteO2Used[i], pl.RouteO2Used[i + 1], u);
                    return;
                }
            }
            foreach (MissionWaypoint w in pl.Waypoints)
            {
                if (t >= w.ArriveMin && t <= w.LeaveMin)
                {
                    pos = w.World;
                    used = w.O2UsedAtLeaveL - (w.LeaveMin - t) * (float)pl.Constants.StationRateLMin;
                    return;
                }
            }
            pos = pl.PadWorld;
            used = pl.O2UsedL;
        }

        // The tracker opens a stop on entering the 10 m arrival circle, slightly before the planned minute.
        private static bool NearStopEdge(MissionPlan pl, float t)
        {
            foreach (MissionWaypoint w in pl.Waypoints)
            {
                if (Mathf.Abs(t - w.ArriveMin) < 0.6f || Mathf.Abs(t - w.LeaveMin) < 0.6f) return true;
            }
            return false;
        }

        private static string ArgAfter(string flag)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++)
            {
                if (args[i] == flag) return args[i + 1];
            }
            return null;
        }
    }
}

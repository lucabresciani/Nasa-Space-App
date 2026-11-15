using System;
using System.Collections;
using System.Globalization;
using System.IO;
using System.Text;
using NasaSpaceApp.Homeline.Flow;
using NasaSpaceApp.HUD;
using NasaSpaceApp.Menu;
using UnityEngine;

namespace NasaSpaceApp.Homeline.Sim
{
    /// <summary>
    /// Unattended check of the whole flow, for builds made when nobody is at the machine:
    ///   MARTIS.exe -homelineSelfTest [-homelineSelfTestDir DIR]
    /// The app opens the planning panel, generates the waypoints of the official plan, replays the EVA at 300x while
    /// comparing the plan read-out and the helmet HUD with the planner's timeline, then walks freely for a moment,
    /// loads an alternative plan, and quits. It writes result.txt (first line PASS or FAIL), hud_trace.csv and
    /// screenshots, and exits with 0 or 1. A watchdog quits with FAIL if anything takes too long.
    /// </summary>
    public sealed class SelfTest : MonoBehaviour
    {
        const float WatchdogSeconds = 190f;

        public static bool Requested
        {
            get { return Array.IndexOf(Environment.GetCommandLineArgs(), "-homelineSelfTest") >= 0; }
        }

        string dir;
        readonly StringBuilder log = new StringBuilder();
        readonly StringBuilder trace = new StringBuilder();
        int failures;
        int shot;
        float startedAt;
        bool finished;
        double worstHudO2;

        IEnumerator Start()
        {
            startedAt = Time.realtimeSinceStartup;
            dir = Arg("-homelineSelfTestDir") ?? Path.Combine(Directory.GetParent(Application.dataPath).FullName, "selftest");
            Directory.CreateDirectory(dir);
            foreach (string old in Directory.GetFiles(dir, "*.png")) File.Delete(old);
            Note("self-test started, output " + dir);

            HomelineApp app = HomelineApp.Instance;
            Check(app != null, "app object exists");
            if (app == null) { Finish(); yield break; }
            Check(app.Catalog.Plans.Count >= 5, "catalog has the 5 precomputed plans (" + app.Catalog.Plans.Count + ")");
            Check(app.Physio != null, "planner O2 model loaded from the official bundle");

            // The menu builds itself after the scene has loaded.
            float waitUntil = Time.realtimeSinceStartup + 40f;
            while ((MartisMenu.Instance == null || !MartisMenu.IsOpen) && Time.realtimeSinceStartup < waitUntil) yield return null;
            Check(MartisMenu.Instance != null && MartisMenu.IsOpen, "title screen is up");
            yield return new WaitForSecondsRealtime(4f); // title intro animation
            yield return Shot("title");

            app.OpenPlanning();
            yield return new WaitForSecondsRealtime(1.2f);
            Check(app.Panel != null, "planning panel opened from the menu");
            yield return Shot("planning_empty");

            PlanEntry official = app.Catalog.Find("rank1");
            if (official == null && app.Catalog.Plans.Count > 0) official = app.Catalog.Plans[0];
            MissionPlan plan = null;
            if (app.Panel != null)
            {
                app.Panel.Generate(); // the official plan is preselected
                plan = app.Panel.Generated;
                yield return new WaitForSecondsRealtime(0.8f);
                yield return Shot("planning_generated");
            }
            if (plan == null && official != null) plan = app.Generate(official);
            Check(plan != null, "official plan loads");
            if (plan == null) { Finish(); yield break; }
            Check(plan.Entry.Id == "rank1", "the preselected plan is the official one (" + plan.Entry.Id + ")");
            Check(plan.Waypoints.StationCount == 4, "4 stations (" + plan.Waypoints.StationCount + ")");
            Check(plan.Waypoints.NavCount == 25, "25 navigation points (" + plan.Waypoints.NavCount + ")");
            Check(plan.HasReturnFields, "return fields attached to the official plan");

            app.Begin(plan, EvaMode.Replay);
            waitUntil = Time.realtimeSinceStartup + 10f;
            while (!app.Driver.Active && Time.realtimeSinceStartup < waitUntil) yield return null;
            Check(app.Driver.Active && app.Driver.Mode == EvaMode.Replay, "replay started after START EVA");
            if (!app.Driver.Active) { Finish(); yield break; }

            // The pad of the official plan in this scene (Tools/homeline-core/tests/BundleTests.cs): checked at once,
            // before the replay has carried the crew away.
            Transform player = FindAnyObjectByType<FirstPersonController>().transform;
            Note("player at start " + V(player.position) + ", t = " + F(app.Driver.TMin) + " min");
            Check(Dist(player.position, 1014.1f, 1475.2f) < 15f, "player starts at the official pad");
            yield return new WaitForSecondsRealtime(1.5f); // menu dissolve
            yield return Shot("eva_start");
            CheckSun(app);

            app.Driver.SetSpeed(300);
            trace.Append("t_min,world_x,world_y,world_z,local_x,local_y,plan_o2_L,plan_margin_min,binding,hud_o2_L,hud_met_min,hud_home_m,detailed_terrain\n");
            double nextSample = 0;
            bool shotS7 = false, shotMid = false;
            waitUntil = Time.realtimeSinceStartup + 110f;
            while (!app.Driver.ReplayFinished && Time.realtimeSinceStartup < waitUntil)
            {
                double t = app.Driver.TMin;
                if (t >= nextSample)
                {
                    Sample(app, plan, player);
                    nextSample += 5;
                }
                if (!shotS7 && t >= 50)
                {
                    shotS7 = true;
                    yield return Shot("eva_station_S7");
                }
                if (!shotMid && t >= 180)
                {
                    shotMid = true;
                    yield return Shot("eva_leg3");
                }
                yield return null;
            }
            Check(app.Driver.ReplayFinished, "replay reached the planned return (t = " + F(app.Driver.TMin) + " min)");
            yield return null;
            Sample(app, plan, player);
            Check(Math.Abs(app.Driver.TMin - plan.EndMin) < 0.01, "EVA clock ends at the planned " + F(plan.EndMin) + " min");
            double? o2End = plan.O2LeftAt(app.Driver.TMin);
            Check(o2End.HasValue && Math.Abs(o2End.Value - 124.87) < 0.05, "O2 at return is the planner's 124.87 L (" + (o2End.HasValue ? F(o2End.Value) : "null") + ")");
            Check(Dist(player.position, 1014.1f, 1475.2f) < 3f, "player is back at the pad");

            SuitTelemetry tel = Telemetry();
            Check(tel != null, "helmet telemetry reachable");
            if (tel != null)
            {
                Check(worstHudO2 < 0.6, "helmet O2 followed the planner timeline through the replay (worst difference " + F(worstHudO2) + " L)");
                Check(Math.Abs(tel.O2LeftL - 124.87f) < 0.3f, "helmet O2 at return " + F(tel.O2LeftL) + " L");
                Check(Math.Abs(tel.MetSeconds / 60f - 325.94f) < 0.2f, "helmet mission time " + F(tel.MetSeconds / 60f) + " min");
                Check(tel.DistanceHomeM < 5f, "helmet home distance at the pad " + F(tel.DistanceHomeM) + " m");
            }
            yield return Shot("eva_return");

            // The helmet's full-screen map (G) with the planned route drawn on it.
            Ui.MapRouteOverlay overlay = app.GetComponent<Ui.MapRouteOverlay>();
            if (overlay != null && Ui.MapRouteOverlay.SetMapOpen(true))
            {
                HudContext hc = HelmetHud.Instance.Context;
                waitUntil = Time.realtimeSinceStartup + 15f;
                while ((hc.ElevationMap == null || !hc.ElevationMap.IsReady) && Time.realtimeSinceStartup < waitUntil) yield return null;
                yield return new WaitForSecondsRealtime(1.0f); // map fade
                yield return Shot("eva_map");
                Check(overlay.RoutePointCount > 0 && overlay.MapSegmentsDrawn > 0,
                      "planned route drawn on the helmet map (" + overlay.MapSegmentsDrawn + " segments, " + overlay.MapStationsShown + " stations in view)");
                Ui.MapRouteOverlay.SetMapOpen(false);
                yield return new WaitForSecondsRealtime(0.5f);
            }
            else Check(false, "helmet map opened for the route overlay");

            app.Driver.SetMode(EvaMode.FreeWalk);
            yield return new WaitForSecondsRealtime(2.5f);
            Check(app.Driver.Mode == EvaMode.FreeWalk, "switched to free walk");
            Check(app.Driver.Live != null, "free walk uses the planner O2 model");
            if (app.Driver.Live != null)
            {
                Check(Math.Abs(app.Driver.Live.O2LeftL - 124.87) < 0.5, "free walk inherits the plan's O2 (" + F(app.Driver.Live.O2LeftL) + " L)");
                Check(app.Driver.Live.RateLMin > 0.3 && app.Driver.Live.RateLMin < 0.6, "standing still burns the resting rate (" + F(app.Driver.Live.RateLMin) + " L/min)");
                Check(app.Driver.LiveMarginMin.HasValue, "live margin available on the official plan" +
                      (app.Driver.LiveMarginMin.HasValue ? " (" + F(app.Driver.LiveMarginMin.Value) + " min, limit " + app.Driver.LiveBinding + ")" : ""));
            }
            yield return Shot("eva_free_walk");

            // An alternative pad: same flow, different start, no return fields.
            PlanEntry alt = app.Catalog.Find("pad_default");
            MissionPlan altPlan = alt != null ? app.Generate(alt) : null;
            Check(altPlan != null, "alternative plan (first survey spot) loads");
            if (altPlan != null)
            {
                Check(!altPlan.HasReturnFields, "alternative plan has no return fields");
                app.Begin(altPlan, EvaMode.Replay);
                yield return new WaitForSecondsRealtime(1.0f);
                Check(app.Driver.Active && app.Driver.Plan == altPlan, "alternative plan started");
                Check(Dist(player.position, -154.4f, -215.3f) < 80f, "player starts at the alternative pad " + V(player.position));
                app.Driver.SetSpeed(300);
                app.Driver.Seek(60);
                yield return new WaitForSecondsRealtime(1.5f);
                yield return Shot("eva_alternative_pad");
            }

            Finish();
        }

        void Update()
        {
            if (!finished && Time.realtimeSinceStartup - startedAt > WatchdogSeconds)
            {
                Check(false, "watchdog: the self-test did not finish in " + WatchdogSeconds + " s");
                Finish();
            }
        }

        /// <summary>
        /// The scene's sun against the planner's (conditions/sun.json of the official bundle: azimuth 74.8 deg and
        /// elevation 36.7 deg at EVA start, rising about 0.23 deg per EVA minute).
        /// </summary>
        void CheckSun(HomelineApp app)
        {
            DayNightCycle cycle = FindAnyObjectByType<DayNightCycle>();
            Light sun = cycle != null ? cycle.GetComponent<Light>() : null;
            if (sun == null || !app.EvaStartUtc.HasValue)
            {
                Note("sun check skipped (no sun light or no EVA start instant)");
                return;
            }
            Vector3 toSun = -sun.transform.forward;
            float elevation = Mathf.Asin(Mathf.Clamp(toSun.y, -1f, 1f)) * Mathf.Rad2Deg;
            float azimuth = Mathf.Repeat(Mathf.Atan2(toSun.x, toSun.z) * Mathf.Rad2Deg, 360f);
            double t = app.Driver.TMin;
            double wantEl = 36.697 + 0.2338 * t, wantAz = 74.811 - 0.0696 * t;
            Note("sun at t = " + F(t) + " min: azimuth " + F(azimuth) + ", elevation " + F(elevation) +
                 " (planner about " + F(wantAz) + ", " + F(wantEl) + "); LTST " + F(MarsSkyState.LocalSolarTime * 24f) + " h");
            Check(Math.Abs(elevation - wantEl) < 2.0 && Math.Abs(Mathf.DeltaAngle(azimuth, (float)wantAz)) < 3.0,
                  "the scene's sun is the planner's sun for this minute of the EVA");
        }

        static SuitTelemetry Telemetry()
        {
            HelmetHud hud = HelmetHud.Instance;
            return hud != null && hud.Context != null ? hud.Context.Telemetry : null;
        }

        void Sample(HomelineApp app, MissionPlan plan, Transform player)
        {
            double t = app.Driver.TMin;
            double? o2 = plan.O2LeftAt(t), margin = plan.MarginAt(t);
            SuitTelemetry tel = Telemetry();
            Vector3 p = player.position;
            // The helmet shows the frame it was last fed in (at 300x a frame is up to a minute of EVA): compare its
            // O2 with the plan at the helmet's own mission time, not at this frame's.
            if (tel != null && t > 1)
            {
                double? atHud = plan.O2LeftAt(tel.MetSeconds / 60.0);
                if (atHud.HasValue) worstHudO2 = Math.Max(worstHudO2, Math.Abs(tel.O2LeftL - atHud.Value));
            }
            trace.Append(F(t)).Append(',').Append(F(p.x)).Append(',').Append(F(p.y)).Append(',').Append(F(p.z)).Append(',')
                 .Append(F(app.Driver.LocalX)).Append(',').Append(F(app.Driver.LocalY)).Append(',')
                 .Append(o2.HasValue ? F(o2.Value) : "").Append(',').Append(margin.HasValue ? F(margin.Value) : "").Append(',')
                 .Append(plan.BindingAt(t)).Append(',')
                 .Append(tel != null ? F(tel.O2LeftL) : "").Append(',').Append(tel != null ? F(tel.MetSeconds / 60f) : "").Append(',')
                 .Append(tel != null ? F(tel.DistanceHomeM) : "").Append(',')
                 .Append(app.Driver.OnDetailedTerrain ? "1" : "0").Append('\n');
        }

        IEnumerator Shot(string name)
        {
            yield return new WaitForEndOfFrame();
            shot++;
            string path = Path.Combine(dir, shot.ToString("00") + "_" + name + ".png");
            try
            {
                Texture2D tex = ScreenCapture.CaptureScreenshotAsTexture();
                File.WriteAllBytes(path, tex.EncodeToPNG());
                Destroy(tex);
                Note("screenshot " + Path.GetFileName(path));
            }
            catch (Exception e)
            {
                Note("screenshot " + name + " failed: " + e.Message);
            }
        }

        void Check(bool ok, string what)
        {
            if (!ok) failures++;
            Note((ok ? "ok    " : "FAIL  ") + what);
        }

        void Note(string line)
        {
            log.Append(line).Append('\n');
            Debug.Log("[HOMELINE self-test] " + line);
        }

        void Finish()
        {
            if (finished) return;
            finished = true;
            try
            {
                File.WriteAllText(Path.Combine(dir, "result.txt"), (failures == 0 ? "PASS" : "FAIL (" + failures + ")") + "\n" + log);
                File.WriteAllText(Path.Combine(dir, "hud_trace.csv"), trace.ToString());
            }
            catch (Exception e)
            {
                Debug.LogError("[HOMELINE self-test] could not write results: " + e.Message);
            }
            Application.Quit(failures == 0 ? 0 : 1);
        }

        static float Dist(Vector3 p, float x, float z)
        {
            return Mathf.Sqrt((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z));
        }

        static string F(double v)
        {
            return v.ToString("0.###", CultureInfo.InvariantCulture);
        }

        static string V(Vector3 v)
        {
            return "(" + F(v.x) + ", " + F(v.y) + ", " + F(v.z) + ")";
        }

        static string Arg(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++)
                if (args[i] == name) return args[i + 1];
            return null;
        }
    }
}

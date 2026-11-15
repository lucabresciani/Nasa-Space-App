using System;
using System.IO;
using System.Reflection;
using NasaSpaceApp.HUD;
using NasaSpaceApp.Mission;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Play-mode smoke test of the mission HUD, for batch runs:
    /// <c>Unity -batchmode -projectPath … -executeMethod NasaSpaceApp.MarsGen.MissionPlaySmokeTest.Run
    /// [-missionTest mission.json] -logFile -</c>. Enters play mode in the Mars scene, loads the mission, walks the
    /// player along the planned route (stopping at a waypoint, leaving one early), opens the map screen on its
    /// Waypoints tab, completes a waypoint, returns to the pad, and exits with 1 if anything logged an error or exception
    /// or the HUD did not follow (no tracker, no EVA log). It checks that the code runs, not how it looks.
    /// </summary>
    public static class MissionPlaySmokeTest
    {
        private const string ScenePath = "Assets/Scenes/MarsLandscape.unity";
        private const int TimeoutFrames = 20000;

        private static string missionPath;
        private static int frame, errors, phaseFrame;
        private static int phase;
        private static float tPlan;
        private static MissionPlan plan;
        private static string firstError;

        public static void Run()
        {
            missionPath = ArgAfter("-missionTest") ?? MissionLink.NewestCandidate();
            if (missionPath == null || !File.Exists(missionPath))
            {
                Debug.LogError("[MissionSmoke] no mission file");
                EditorApplication.Exit(1);
                return;
            }
            EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
            frame = errors = phase = phaseFrame = 0;
            tPlan = 0f;
            firstError = null;
            Application.logMessageReceived += OnLog;
            EditorApplication.update += Step;
            EditorApplication.EnterPlaymode();
        }

        private static void OnLog(string message, string stack, LogType type)
        {
            if (type == LogType.Exception || type == LogType.Error || type == LogType.Assert)
            {
                if (message.StartsWith("[MissionSmoke]", StringComparison.Ordinal)) return;
                errors++;
                if (firstError == null) firstError = message + "\n" + stack;
            }
        }

        private static void Step()
        {
            frame++;
            if (frame > TimeoutFrames)
            {
                Finish("timeout in phase " + phase);
                return;
            }
            if (!EditorApplication.isPlaying)
            {
                return;
            }
            phaseFrame++;
            HelmetHud hud = HelmetHud.Instance;
            switch (phase)
            {
                case 0:   // let the scene and the HUD start; leave the title menu (it pauses the HUD)
                    if (phaseFrame == 30 && NasaSpaceApp.Menu.MartisMenu.IsOpen)
                    {
                        NasaSpaceApp.Menu.MartisMenu.StartNow();
                    }
                    if (phaseFrame > 60 && hud != null && MissionLink.Instance != null && !NasaSpaceApp.Menu.MartisMenu.IsOpen)
                    {
                        if (!MissionLink.Instance.LoadFile(missionPath))
                        {
                            Finish("load failed: " + MissionLink.LastError);
                            return;
                        }
                        plan = MissionLink.Current;
                        Next();
                    }
                    break;
                case 1:   // walk the plan (0.2 planned min per frame); open the map halfway through a stop
                {
                    MissionTracker tr = hud != null ? hud.Context.Mission : null;
                    if (tr == null || !tr.Active)
                    {
                        if (phaseFrame > 30) Finish("tracker not active 30 frames after load");
                        return;   // the HUD picks the mission up in its next LateUpdate
                    }
                    tPlan += 0.2f;
                    Place(At(plan, tPlan));
                    if (tr.StopWaypoint >= 0 && phaseFrame % 50 == 0)
                    {
                        OpenMapOnWaypoints(hud);
                        tr.CompleteWaypoint(tr.StopWaypoint);   // the Complete button's action
                        Debug.Log("[MissionSmoke] stop completed from the map at planned t=" + tPlan.ToString("0.0"));
                    }
                    if (tPlan > plan.EvaMin + 1f || tr.Complete)
                    {
                        Debug.Log("[MissionSmoke] walk done: status " + MissionTracker.StatusLabel(tr.Status) + ", complete " + tr.Complete);
                        Next();
                    }
                    break;
                }
                case 2:   // stand on the pad a moment, close the map, then clear
                    Place(plan.PadWorld);
                    if (phaseFrame == 30) CallHud(hud, "CloseMap");
                    if (phaseFrame > 90)
                    {
                        MissionTracker tr = hud.Context.Mission;
                        bool logged = EvaLogger.LastWrittenPath != null || EvaLogger.Active != null && EvaLogger.Active.HasData;
                        Debug.Log("[MissionSmoke] tracker complete=" + tr.Complete + " status=" + MissionTracker.StatusLabel(tr.Status)
                                  + " eva log=" + (EvaLogger.LastWrittenPath ?? "(in memory)"));
                        MissionLink.Instance.Clear();
                        Finish(logged ? null : "no EVA log data");
                    }
                    break;
            }
        }

        private static void Next()
        {
            phase++;
            phaseFrame = 0;
        }

        private static void Place(Vector3 world)
        {
            FirstPersonController p = UnityEngine.Object.FindAnyObjectByType<FirstPersonController>();
            if (p != null)
            {
                p.PlaceAt(world, p.transform.eulerAngles.y, false);
            }
        }

        private static void OpenMapOnWaypoints(HelmetHud hud)
        {
            CallHud(hud, "OpenMap");
            object screen = typeof(HelmetHud).GetField("mapScreen", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(hud);
            object tab = screen?.GetType().GetField("waypointsTab", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(screen);
            tab?.GetType().GetMethod("SetTab", BindingFlags.NonPublic | BindingFlags.Instance)?.Invoke(tab, new object[] { true });
            tab?.GetType().GetMethod("Refresh")?.Invoke(tab, null);
        }

        private static void CallHud(HelmetHud hud, string method)
        {
            typeof(HelmetHud).GetMethod(method, BindingFlags.NonPublic | BindingFlags.Instance)?.Invoke(hud, null);
        }

        private static Vector3 At(MissionPlan pl, float t)
        {
            Vector3[] r = pl.Route;
            float[] ts = pl.RouteT;
            for (int i = 0; i + 1 < r.Length; i++)
            {
                if (ts[i] <= t && t <= ts[i + 1] && ts[i + 1] > ts[i])
                {
                    return Vector3.Lerp(r[i], r[i + 1], (t - ts[i]) / (ts[i + 1] - ts[i]));
                }
            }
            foreach (MissionWaypoint w in pl.Waypoints)
            {
                if (t >= w.ArriveMin && t <= w.LeaveMin) return w.World;
            }
            return pl.PadWorld;
        }

        private static void Finish(string failure)
        {
            EditorApplication.update -= Step;
            Application.logMessageReceived -= OnLog;
            bool ok = failure == null && errors == 0;
            if (ok)
            {
                Debug.Log("[MissionSmoke] PASS (" + frame + " editor frames)");
            }
            else
            {
                Debug.LogError("[MissionSmoke] FAIL: " + (failure ?? errors + " error(s) logged") + (firstError != null ? "\nfirst: " + firstError : string.Empty));
            }
            if (EditorApplication.isPlaying)
            {
                EditorApplication.ExitPlaymode();
            }
            EditorApplication.Exit(ok ? 0 : 1);
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

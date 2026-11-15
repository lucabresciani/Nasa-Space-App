#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
using System;
using System.Collections;
using System.Globalization;
using System.IO;
using NasaSpaceApp.Homeline.Sim;
using NasaSpaceApp.Menu;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.EventSystems;
using EvaLogger = global::NasaSpaceApp.Mission.EvaLogger;
using MissionLink = global::NasaSpaceApp.Mission.MissionLink;
using WebMission = global::NasaSpaceApp.Mission.MissionPlan;

namespace NasaSpaceApp.Homeline.Web
{
    /// <summary>
    /// The HOMELINE web planner inside MARVIS. A loopback HTTP server (<see cref="WebServer"/>) serves the built web
    /// app and a small JSON API; a helper window owned by the game window (<see cref="ViewerProcess"/>, MarvisWeb.exe)
    /// shows the page over the menu. MISSION PLAN opens it; the page posts the planned mission, which is loaded
    /// through <see cref="MissionLink"/> and started; when the EVA log is written the page shows the debrief.
    ///
    /// Started from code once per run, survives scene reloads. Without the web app or the viewer next to the exe it
    /// stays off and MISSION PLAN keeps opening the built-in planning panel. See README.md in this folder.
    /// </summary>
    public sealed class WebPlanner : MonoBehaviour
    {
        public const string WebEnvVar = "MARVIS_WEB", ViewerEnvVar = "MARVIS_WEBVIEW";
        public const string WebFolderName = "HomelineWeb", ViewerFolderName = "MarvisWeb", ViewerExeName = "MarvisWeb.exe";
        /// <summary>Where the viewer is built, relative to the project (editor, and the build step's source).</summary>
        public const string ViewerDevFolder = "Tools/marvis-web/viewer/dist";
        /// <summary>The file at the root of a web build that says "this build contains the MARVIS bridge".</summary>
        public const string BridgeMarkerFile = "marvis-bridge.json";

        const string MissionSource = "web planner";
        const string ViewerBackground = "#07060B";   // MenuTokens.Void: what shows until the page has painted
        const float OwnerWindowWait = 15f;           // seconds given to the game window to appear
        const float ViewerLoadWait = 20f;            // seconds given to a started viewer to load the page
        const float AutoReturnDelay = 6f;

        public static WebPlanner Instance { get; private set; }

        /// <summary>
        /// True exactly while MISSION PLAN opens the web planner in place of the built-in planning panel. False when
        /// the web planner is off (-noWebPlanner, -homelineSelfTest, batch mode, no web app, no viewer, no free port)
        /// and after it fell back to the built-in panel. The Controls list leaves the built-in plan's keys out while true.
        /// </summary>
        public static bool ReplacesPlanningPanel { get { return Instance != null && Instance.Available; } }

        /// <summary>The server's port; 0 when the web planner is off.</summary>
        public int Port { get { return server != null ? server.Port : 0; } }
        /// <summary>
        /// The server is up, the viewer is running and its page has loaded or still has the time to: MISSION PLAN opens
        /// the web planner. A page that loads after that time makes it available again.
        /// </summary>
        public bool Available
        {
            get { return server != null && viewer != null && !viewerDown && viewer.Alive && (viewer.Loaded || !viewerLate); }
        }
        public bool PlannerVisible { get { return plannerVisible; } }
        internal ViewerProcess Viewer { get { return viewer; } }
        internal IntPtr OwnerWindow { get { return ownerWindow; } }

        WebServer server;
        ViewerProcess viewer;
        string viewerExe, userDataFolder;
        uint mainThreadId;
        IntPtr ownerWindow;
        float viewerDeadline;       // the viewer is to be started; give up looking for the game window at this time; 0 = no
        float viewerStartedAt;      // Time.realtimeSinceStartup when the current viewer process was started
        bool viewerDown;            // the viewer process stopped
        bool viewerLate;            // the viewer had not loaded the page ViewerLoadWait after its start
        bool restartTried;

        Action wrapper, previous;   // ours in MarvisMenu.PlanRequested, and the one it replaced (the built-in panel)
        bool plannerVisible;
        Coroutine startEva, autoReturn;

        // The state document of the API.
        int seq, evaLogSeq;
        string eva = "idle", missionId, lastError;
        DateTime missionSinceUtc;
        string lastLogPath;

        // Domain reload is off in this project: drop the previous play session's instance.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            Instance = null;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot()
        {
            if (Instance != null) return;
            string[] args = Environment.GetCommandLineArgs();
            if (Array.IndexOf(args, "-noWebPlanner") >= 0 || Array.IndexOf(args, "-homelineSelfTest") >= 0 || Application.isBatchMode)
            {
                Debug.Log("[WebPlanner] off (-noWebPlanner, -homelineSelfTest or batch mode)");
                return;
            }
            var go = new GameObject("WebPlanner");
            DontDestroyOnLoad(go);
            Instance = go.AddComponent<WebPlanner>();
            if (WebPlannerTest.Requested) go.AddComponent<WebPlannerTest>();
        }

        void Awake()
        {
            // Application paths and the thread id are main-thread only: read them once, here.
            mainThreadId = Win32.GetCurrentThreadId();
            string appRoot = Directory.GetParent(Application.dataPath).FullName;
            userDataFolder = Path.Combine(Application.persistentDataPath, "WebView2");

            string webRoot = ResolveWebRoot(appRoot);
            viewerExe = ResolveViewer(appRoot);
            if (webRoot == null || viewerExe == null)
            {
                Debug.Log("[WebPlanner] not available: " +
                          (webRoot == null
                              ? "no web app with the MARVIS bridge (" + WebFolderName + " next to the exe: index.html, assets/ and " + BridgeMarkerFile + ")"
                              : ViewerExeName + " not found") +
                          ". MISSION PLAN keeps the built-in panel.");
                return;
            }

            var web = new WebServer
            {
                HelloJson = new JObject { ["app"] = "MARVIS", ["bridge"] = 1, ["version"] = Application.version }.ToString(Formatting.None),
            };
            if (!web.Start(webRoot))
            {
                Debug.LogWarning("[WebPlanner] not available: no free port in " + WebServer.FirstPort + ".." + WebServer.LastPort +
                                 ". MISSION PLAN keeps the built-in panel.");
                return;
            }
            server = web;
            Debug.Log("[WebPlanner] serving " + webRoot + " on http://127.0.0.1:" + server.Port + "/");

            // The viewer has the keyboard while the planner is up: the game must keep running to answer the page.
            Application.runInBackground = true;
            viewerDeadline = Time.realtimeSinceStartup + OwnerWindowWait;
            lastLogPath = EvaLogger.LastWrittenPath;
            MissionLink.Changed += OnMissionChanged;
            OnMissionChanged(MissionLink.Current);   // publishes the first state document
            wrapper = OnPlanRequested;
            Wrap();
        }

        void Update()
        {
            if (server == null) return;
            server.Pump(HandleApi);
            Wrap();

            if (viewer == null && viewerDeadline > 0f) StartViewer();
            if (viewer != null && !viewerDown && !viewer.Alive)
            {
                viewerDown = true;
                Debug.LogWarning("[WebPlanner] the viewer stopped (" + viewer.Status + "): MISSION PLAN falls back to the built-in panel");
            }
            // A viewer that runs but never loads the page would be an empty window over the game with no way back.
            // A slow start (the game loads its scene at the same time) only makes it late: it is used once the page is there.
            if (viewer != null && !viewerDown && !viewerLate && !viewer.Loaded &&
                Time.realtimeSinceStartup > viewerStartedAt + ViewerLoadWait)
            {
                viewerLate = true;
                Debug.LogWarning("[WebPlanner] the viewer has not loaded the page after " + ViewerLoadWait +
                                 " s: MISSION PLAN opens the built-in panel until it has");
            }
            if (plannerVisible && (!MarvisMenu.IsOpen || !Available)) HidePlanner();   // never left over a running simulation

            string logPath = EvaLogger.LastWrittenPath;
            if (logPath != lastLogPath)
            {
                lastLogPath = logPath;
                if (logPath != null) ReadEvaLog(logPath);
            }
        }

        void OnApplicationFocus(bool focus)
        {
            // The user came back with Alt-Tab and the game window got the keyboard: hand it to the page again.
            if (focus && plannerVisible && Available && !Application.isEditor) viewer.Focus();
        }

        void OnApplicationQuit()
        {
            Shutdown();
        }

        void OnDestroy()
        {
            Shutdown();
            if (Instance == this) Instance = null;
        }

        void Shutdown()
        {
            if (server == null) return;
            MissionLink.Changed -= OnMissionChanged;
            MenuNavigation(true);
            if (MarvisMenu.PlanRequested == wrapper) MarvisMenu.PlanRequested = previous;
            if (viewer != null) viewer.Quit();
            viewer = null;
            server.Stop();
            server = null;
            Debug.Log("[WebPlanner] stopped");
        }

        // ---------------------------------------------------------------- where the web app and the viewer are

        /// <summary>
        /// A folder is a usable web root when it has index.html, an assets folder and the marker file
        /// marvis-bridge.json (a build of the web app without the MARVIS bridge does not have it).
        /// </summary>
        public static bool IsValidWebRoot(string dir)
        {
            try
            {
                return !string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, "index.html")) &&
                       Directory.Exists(Path.Combine(dir, "assets")) && File.Exists(Path.Combine(dir, BridgeMarkerFile));
            }
            catch (Exception)
            {
                return false;
            }
        }

        // MARVIS_WEB, else HomelineWeb next to the exe, else (editor, development) the web folder of the planner data.
        static string ResolveWebRoot(string appRoot)
        {
            string env = Environment.GetEnvironmentVariable(WebEnvVar);
            if (IsValidWebRoot(env)) return env;
            string beside = Path.Combine(appRoot, WebFolderName);
            if (IsValidWebRoot(beside)) return beside;
            string data = HomelinePaths.Resolve().WebData;   // {data root}/web/data
            string dev = data != null ? Path.GetDirectoryName(data) : null;
            return IsValidWebRoot(dev) ? dev : null;
        }

        // MARVIS_WEBVIEW, else MarvisWeb/MarvisWeb.exe next to the exe, else (editor) where the viewer is built.
        static string ResolveViewer(string appRoot)
        {
            string env = Environment.GetEnvironmentVariable(ViewerEnvVar);
            if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
            string beside = Path.Combine(appRoot, ViewerFolderName, ViewerExeName);
            if (File.Exists(beside)) return beside;
            string dev = Path.Combine(appRoot, ViewerDevFolder, ViewerExeName);
            return Application.isEditor && File.Exists(dev) ? dev : null;
        }

        // ---------------------------------------------------------------- viewer

        // Starts the viewer hidden once the game window exists; the page loads at once, so the first show is warm.
        void StartViewer()
        {
            ownerWindow = ViewerProcess.FindOwnerWindow(mainThreadId, Application.isEditor);
            if (ownerWindow == IntPtr.Zero)
            {
                if (Time.realtimeSinceStartup < viewerDeadline) return;   // not there yet: next frame
                viewerDeadline = 0f;
                Debug.LogWarning("[WebPlanner] the game window was not found: MISSION PLAN keeps the built-in panel");
                return;
            }
            string bounds = null;
            if (Application.isEditor && ViewerProcess.EditorBounds(ownerWindow, out int x, out int y, out int w, out int h))
                bounds = x + "," + y + "," + w + "," + h;
            string url = "http://127.0.0.1:" + server.Port + "/index.html#/mission";
            var v = new ViewerProcess();
            viewerDeadline = 0f;   // one attempt
            if (!v.Start(viewerExe, ownerWindow, url, userDataFolder, ViewerBackground, bounds, Debug.isDebugBuild))
            {
                Debug.LogWarning("[WebPlanner] MISSION PLAN keeps the built-in panel");
                return;
            }
            viewer = v;
            viewerStartedAt = Time.realtimeSinceStartup;
            Debug.Log("[WebPlanner] viewer started on " + url);
        }

        // HomelineApp assigns PlanRequested at boot and may do it after us: put ours in whenever it is not there.
        void Wrap()
        {
            if (MarvisMenu.PlanRequested == wrapper) return;
            previous = MarvisMenu.PlanRequested;
            MarvisMenu.PlanRequested = wrapper;
        }

        // MISSION PLAN: the web planner when it is available, else whatever was there before (the built-in panel).
        void OnPlanRequested()
        {
            if (ShowPlanner()) return;
            if ((viewerDown || viewerLate && !viewer.Loaded) && !restartTried && !viewer.NoRuntime)
            {
                // One more chance for a viewer that died or still has no page; this request is served by the built-in
                // panel meanwhile.
                restartTried = true;
                Debug.Log("[WebPlanner] starting the viewer again (once)");
                viewer.Quit();
                viewer = null;
                viewerDown = viewerLate = false;
                viewerDeadline = Time.realtimeSinceStartup + OwnerWindowWait;
            }
            if (previous != null) previous();
            else Debug.Log("[WebPlanner] the planner is not available");
        }

        /// <summary>Shows the web planner over the menu. False when it is not available or the menu is closed.</summary>
        public bool ShowPlanner()
        {
            if (!Available || !MarvisMenu.IsOpen) return false;
            if (Application.isEditor && ViewerProcess.EditorBounds(ownerWindow, out int x, out int y, out int w, out int h))
                viewer.SetBounds(x, y, w, h);
            if (!viewer.Show()) return false;
            MenuNavigation(false);
            if (!plannerVisible)
            {
                plannerVisible = true;
                Publish();
            }
            return true;
        }

        /// <summary>Hides the web planner; the menu underneath is visible again.</summary>
        public void HidePlanner()
        {
            MenuNavigation(true);
            bool was = plannerVisible;
            plannerVisible = false;   // before the hide: the focus coming back must not be handed to the viewer again
            if (viewer != null && viewer.Alive) viewer.Hide();
            if (was) Publish();
        }

        // The game keeps running behind the page (runInBackground), so a controller would still move and press the
        // entries of the menu hidden underneath: uGUI navigation is off while the page is up. Mouse and keyboard go
        // to the viewer anyway. An EventSystem made by a scene reload starts with navigation on.
        static void MenuNavigation(bool on)
        {
            EventSystem es = EventSystem.current;
            if (es != null) es.sendNavigationEvents = on;
        }

        // ---------------------------------------------------------------- API (main thread, from WebServer.Pump)

        ApiReply HandleApi(string name, string body)
        {
            if (name == "close")
            {
                HidePlanner();
                return new ApiReply(200, "{\"ok\":true}");
            }
            return PostMission(body);
        }

        ApiReply PostMission(string json)
        {
            MissionLink link = MissionLink.Instance;
            if (link == null) return Error(503, "the simulator scene is not ready (no MissionLink in this scene)");
            if (!link.LoadJson(json, MissionSource))
            {
                lastError = MissionLink.LastError ?? "the mission could not be loaded";
                Publish();
                Debug.Log("[WebPlanner] mission refused: " + lastError);
                return Error(422, lastError);
            }
            if (lastError != null)
            {
                lastError = null;
                Publish();
            }
            string id = MissionLink.Current != null ? MissionLink.Current.Id : null;
            Debug.Log("[WebPlanner] mission " + id + " received: starting the EVA");
            if (startEva != null) StopCoroutine(startEva);
            startEva = StartCoroutine(StartEva());
            return new ApiReply(200, new JObject { ["ok"] = true, ["mission_id"] = id }.ToString(Formatting.None));
        }

        static ApiReply Error(int status, string message)
        {
            return new ApiReply(status, new JObject { ["ok"] = false, ["error"] = message }.ToString(Formatting.None));
        }

        // Unscaled time throughout: the open menu holds Time.timeScale at 0.
        IEnumerator StartEva()
        {
            yield return null;   // let the answer to the page leave first
            HidePlanner();
            float until = Time.unscaledTime + 2f;
            while (!Application.isFocused && Time.unscaledTime < until) yield return null;
            MarvisMenu.StartNow();
            yield return new WaitForSecondsRealtime(1f);
            if (MarvisMenu.IsOpen) MarvisMenu.StartNow();
            startEva = null;
        }

        // ---------------------------------------------------------------- mission and EVA result

        void OnMissionChanged(WebMission plan)
        {
            if (autoReturn != null) StopCoroutine(autoReturn);
            autoReturn = null;
            missionId = plan != null ? plan.Id : null;
            missionSinceUtc = DateTime.UtcNow;
            eva = plan != null ? "running" : "idle";
            Publish();
        }

        // A new EVA log file: keep its text for GET eva-log and tell the page how the EVA of the current mission ended.
        void ReadEvaLog(string path)
        {
            string text;
            JObject doc;
            try
            {
                text = File.ReadAllText(path);
                doc = JsonConvert.DeserializeObject<JObject>(text, new JsonSerializerSettings { DateParseHandling = DateParseHandling.None });
            }
            catch (Exception e)
            {
                Debug.LogWarning("[WebPlanner] EVA log not readable: " + e.Message);
                return;
            }
            bool complete = (bool?)doc.SelectToken("summary.complete") ?? false;
            server.EvaLogJson = text;
            evaLogSeq++;
            if (IsOfCurrentMission(doc)) eva = complete ? "complete" : "ended";
            Publish();
            Debug.Log("[WebPlanner] EVA log " + evaLogSeq + " (" + (complete ? "complete" : "not complete") + "): eva " + eva);

            if (complete && !MarvisMenu.IsOpen && Available)
            {
                if (autoReturn != null) StopCoroutine(autoReturn);
                autoReturn = StartCoroutine(AutoReturn());
            }
        }

        // An EVA interrupted by the next mission is logged after that mission was loaded: same id maybe, but started earlier.
        bool IsOfCurrentMission(JObject doc)
        {
            if (missionId == null || (string)doc["mission_id"] != missionId) return false;
            DateTime started;   // written in whole seconds
            return !DateTime.TryParse((string)doc["started_utc"], CultureInfo.InvariantCulture,
                                      DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out started)
                   || started >= missionSinceUtc.AddSeconds(-1.5);
        }

        // EVA complete: a moment to read the HUD, then the pause menu with the planner over it (the page shows the debrief).
        IEnumerator AutoReturn()
        {
            yield return new WaitForSecondsRealtime(AutoReturnDelay);
            autoReturn = null;
            if (MarvisMenu.IsOpen || !Available) yield break;
            MarvisMenu.OpenNow();
            float until = Time.unscaledTime + 3f;
            while (!MarvisMenu.IsOpen && Time.unscaledTime < until) yield return null;
            // The debrief is on the Mission Planer page; the user may have left the app on another one.
            if (Available) viewer.Eval("if (!location.hash.startsWith('#/mission')) location.hash = '#/mission'");
            if (ShowPlanner()) Debug.Log("[WebPlanner] EVA complete: planner shown for the debrief");
        }

        // The state document of GET /marvis/api/state; seq grows with every change.
        void Publish()
        {
            if (server == null) return;
            seq++;
            server.StateJson = new JObject
            {
                ["seq"] = seq,
                ["planner_visible"] = plannerVisible,
                ["eva"] = eva,
                ["mission_id"] = missionId != null ? (JToken)missionId : JValue.CreateNull(),
                ["eva_log_seq"] = evaLogSeq,
                ["last_error"] = lastError != null ? (JToken)lastError : JValue.CreateNull(),
            }.ToString(Formatting.None);
        }
    }
}
#endif

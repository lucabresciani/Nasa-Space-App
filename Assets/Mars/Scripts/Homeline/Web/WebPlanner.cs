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
    /// The web planner inside MARVIS. A helper window owned by the game window (<see cref="ViewerProcess"/>,
    /// MarvisWeb.exe) shows the planner over the menu: the live planner site first, so that an update of the site
    /// needs no rebuild here, and the copy shipped with the game when the site cannot be reached. The copy is served
    /// by a loopback HTTP server (<see cref="WebServer"/>) with a small JSON API.
    /// MISSION PLAN opens the planner. The site hands the mission over as a downloaded file (its "Send to simulator"
    /// button, caught by the viewer), the local copy posts it to the API; either way it is loaded through
    /// <see cref="MissionLink"/> and the EVA starts. When the EVA log is written the page shows the debrief.
    ///
    /// Started from code once per run, survives scene reloads. Without the viewer, or with neither a site nor a local
    /// copy, it stays off and MISSION PLAN keeps opening the built-in planning panel. See README.md in this folder.
    /// </summary>
    public sealed class WebPlanner : MonoBehaviour
    {
        public const string WebEnvVar = "MARVIS_WEB", ViewerEnvVar = "MARVIS_WEBVIEW";
        public const string WebFolderName = "MarvisPlanner", ViewerFolderName = "MarvisWeb", ViewerExeName = "MarvisWeb.exe";
        /// <summary>Where the viewer is built, relative to the project (editor, and the build step's source).</summary>
        public const string ViewerDevFolder = "Tools/marvis-web/viewer/dist";
        /// <summary>The file at the root of a web build that says "this build contains the MARVIS bridge".</summary>
        public const string BridgeMarkerFile = "marvis-bridge.json";

        /// <summary>The planner address: the switch, else the environment variable, else the file, else the default.</summary>
        public const string PlannerUrlArg = "-plannerUrl", PlannerUrlEnvVar = "MARVIS_PLANNER_URL";
        public const string PlannerUrlFileName = "planner-url.txt", DefaultPlannerUrl = "https://homeline.vxliu.com/";
        /// <summary>The script the viewer runs in every page: the MARVIS menu button, the debrief, the toasts.</summary>
        public const string InjectFileName = "marvis-inject.js";
        /// <summary>Where those two files are kept, relative to the project (editor, and the build step's source).</summary>
        public const string LiveDevFolder = "Tools/marvis-web/live";

        const string MissionSource = "web planner";
        const string ViewerBackground = "#07060B";   // MenuTokens.Void: what shows until the page has painted
        const string CheckUpdateMessage = "{\"type\":\"check-update\"}";
        const float OwnerWindowWait = 15f;           // seconds given to the game window to appear
        const float ViewerLoadWait = 20f;            // seconds given to a started viewer to load the page
        const float AutoReturnDelay = 6f;
        const float LiveRetryInterval = 30f;         // on the local copy: seconds between two tries of the planner site

        public static WebPlanner Instance { get; private set; }

        /// <summary>
        /// True exactly while MISSION PLAN opens the web planner in place of the built-in planning panel. False when
        /// the web planner is off (-noWebPlanner, -homelineSelfTest, batch mode, no viewer, neither a planner site nor
        /// a local copy) and after it fell back to the built-in panel. The Controls list leaves the built-in plan's
        /// keys out while true.
        /// </summary>
        public static bool ReplacesPlanningPanel { get { return Instance != null && Instance.Available; } }

        /// <summary>The port of the local copy's server; 0 when no local copy is served.</summary>
        public int Port { get { return server != null ? server.Port : 0; } }
        /// <summary>
        /// The viewer is running and its page has loaded or still has the time to: MISSION PLAN opens the web planner.
        /// A page that loads after that time makes it available again.
        /// </summary>
        public bool Available
        {
            get { return running && viewer != null && !viewerDown && viewer.Alive && (viewer.Loaded || !viewerLate); }
        }
        public bool PlannerVisible { get { return plannerVisible; } }
        internal ViewerProcess Viewer { get { return viewer; } }
        internal IntPtr OwnerWindow { get { return ownerWindow; } }

        /// <summary>The web planner was started (a viewer and a planner site or a local copy were found).</summary>
        internal bool Running { get { return running; } }
        /// <summary>The address of the planner site; null when only the local copy is used.</summary>
        internal string LiveUrl { get { return liveUrl; } }
        /// <summary>The address of the page the viewer loaded last; null before the first one.</summary>
        internal string PageUrl { get { return pageUrl; } }
        /// <summary>The page in the viewer is on the planner site.</summary>
        internal bool PageIsLive { get { return pageLive; } }
        /// <summary>
        /// The page in the viewer is the planner site, without the game's own controls: missions come as downloads and
        /// the EVA log is handed to the page script.
        /// </summary>
        internal bool OnLiveSite { get { return pageLive && !liveIsBridge; } }
        /// <summary>How many documents' page scripts have said hello, and the address of the last one.</summary>
        internal int HelloCount { get { return helloCount; } }
        internal string HelloUrl { get { return helloUrl; } }
        /// <summary>The page said it loads itself again (an update of the site) and the new one has not said hello yet.</summary>
        internal bool PageReloading { get { return pageReloading; } }
        /// <summary>Missions loaded and refused since the start (both ways in), and the reason of the last refusal.</summary>
        internal int MissionsAccepted { get { return missionsAccepted; } }
        internal int MissionsRefused { get { return missionsRefused; } }
        internal string LastRefusal { get { return lastRefusal; } }

        WebServer server;           // serves the local copy; null when there is none
        ViewerProcess viewer;
        bool running;               // Awake found what is needed
        string viewerExe, userDataFolder, injectFile;
        string liveUrl, liveOrigin; // the planner site and its scheme and host; null = only the local copy
        string localUrl;            // the page of the local copy; null when it is not served
        uint mainThreadId;
        IntPtr ownerWindow;
        float viewerDeadline;       // the viewer is to be started; give up looking for the game window at this time; 0 = no
        float viewerStartedAt;      // Time.realtimeSinceStartup when the current viewer process was started
        bool viewerDown;            // the viewer process stopped
        bool viewerLate;            // the viewer had not loaded the page ViewerLoadWait after its start
        bool restartTried;

        // The page in the current viewer, from its events.
        string pageUrl;             // address of the last page loaded
        bool pageLive;              // it is on the planner site
        bool liveIsBridge;          // the page script found the game's own API there: the "site" is a local copy
        bool liveLoaded;            // the planner site has loaded in this viewer
        bool tryingLive;            // the viewer was sent to the planner site and has not answered yet
        bool onFallback;            // the planner site could not be reached: the viewer shows the local copy
        float lastLiveTry;          // Time.realtimeSinceStartup of the last try (or failure) of the planner site
        bool pageReloading;
        int helloCount;
        string helloUrl;

        Action wrapper, previous;   // ours in MarvisMenu.PlanRequested, and the one it replaced (the built-in panel)
        bool plannerVisible;
        Coroutine startEva, autoReturn;

        // The state document of the API.
        int seq, evaLogSeq;
        string eva = "idle", missionId, lastError;
        DateTime missionSinceUtc;
        string lastLogPath;
        string evaLogMessage;       // the eva-log message of the current mission's EVA, for the planner site's page
        int missionsAccepted, missionsRefused;
        string lastRefusal;

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

            viewerExe = ResolveViewer(appRoot);
            if (viewerExe == null)
            {
                Debug.Log("[WebPlanner] not available: " + ViewerExeName + " not found. MISSION PLAN keeps the built-in panel.");
                return;
            }
            string viewerDir = Path.GetDirectoryName(viewerExe);

            // The planner site, and the page script without which its page has no way back to the menu.
            injectFile = ResolveLiveFile(viewerDir, appRoot, InjectFileName);
            liveUrl = ResolvePlannerUrl(viewerDir, appRoot);
            if (liveUrl != null && injectFile == null)
            {
                Debug.LogWarning("[WebPlanner] " + InjectFileName + " not found next to " + ViewerExeName +
                                 ": the planner site is not used, only the copy shipped with the game");
                liveUrl = null;
            }
            if (liveUrl != null)
            {
                liveOrigin = new Uri(liveUrl).GetLeftPart(UriPartial.Authority);
                Debug.Log("[WebPlanner] planner site " + liveUrl + ", page script " + injectFile);
            }

            // The local copy: the fallback, or the only planner when there is no site.
            string webRoot = ResolveWebRoot(appRoot);
            if (webRoot == null)
            {
                Debug.Log("[WebPlanner] no local copy of the planner (" + WebFolderName + " next to the exe: index.html, assets/ and " +
                          BridgeMarkerFile + ")");
            }
            else
            {
                var web = new WebServer
                {
                    HelloJson = new JObject { ["app"] = "MARVIS", ["bridge"] = 1, ["version"] = Application.version }.ToString(Formatting.None),
                };
                if (web.Start(webRoot))
                {
                    server = web;
                    localUrl = "http://127.0.0.1:" + server.Port + "/index.html#/mission";
                    Debug.Log("[WebPlanner] serving " + webRoot + " on http://127.0.0.1:" + server.Port + "/");
                }
                else
                {
                    Debug.LogWarning("[WebPlanner] no free port in " + WebServer.FirstPort + ".." + WebServer.LastPort +
                                     ": the local copy of the planner is not served");
                }
            }
            if (liveUrl == null && server == null)
            {
                Debug.Log("[WebPlanner] not available: no planner site and no local copy. MISSION PLAN keeps the built-in panel.");
                return;
            }
            if (server == null) Debug.Log("[WebPlanner] no local copy: when the planner site cannot be reached MISSION PLAN opens the built-in panel");

            running = true;
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
            if (!running) return;
            if (server != null) server.Pump(HandleApi);
            Wrap();

            if (viewer == null && viewerDeadline > 0f) StartViewer();
            if (viewer != null) ReadViewerEvents();
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
            if (!running) return;
            running = false;
            MissionLink.Changed -= OnMissionChanged;
            MenuNavigation(true);
            if (MarvisMenu.PlanRequested == wrapper) MarvisMenu.PlanRequested = previous;
            if (viewer != null) viewer.Quit();
            viewer = null;
            if (server != null) server.Stop();
            server = null;
            Debug.Log("[WebPlanner] stopped");
        }

        // ---------------------------------------------------------------- where the planner and the viewer are

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

        // MARVIS_WEB, else MarvisPlanner next to the exe, else (editor, development) the web folder of the planner data.
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

        // planner-url.txt or marvis-inject.js: next to the viewer exe, else (editor) Tools/marvis-web/live of the project.
        static string ResolveLiveFile(string viewerDir, string appRoot, string name)
        {
            try
            {
                string beside = Path.Combine(viewerDir, name);
                if (File.Exists(beside)) return Path.GetFullPath(beside);
                string dev = Path.Combine(appRoot, LiveDevFolder, name);
                return Application.isEditor && File.Exists(dev) ? Path.GetFullPath(dev) : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // The address of the planner site, or null for "use only the local copy": -plannerUrl, else MARVIS_PLANNER_URL,
        // else planner-url.txt, else the public site. "local" and anything that is not an http(s) address give null.
        static string ResolvePlannerUrl(string viewerDir, string appRoot)
        {
            string from = PlannerUrlArg;
            string value = CommandLineValue(PlannerUrlArg);
            if (string.IsNullOrWhiteSpace(value))
            {
                from = PlannerUrlEnvVar;
                value = Environment.GetEnvironmentVariable(PlannerUrlEnvVar);
            }
            if (string.IsNullOrWhiteSpace(value))
            {
                from = PlannerUrlFileName;
                value = ReadPlannerUrlFile(ResolveLiveFile(viewerDir, appRoot, PlannerUrlFileName));
            }
            if (string.IsNullOrWhiteSpace(value))
            {
                from = "default";
                value = DefaultPlannerUrl;
            }
            value = value.Trim();
            if (string.Equals(value, "local", StringComparison.OrdinalIgnoreCase))
            {
                Debug.Log("[WebPlanner] planner address 'local' (" + from + "): only the copy shipped with the game is used");
                return null;
            }
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            {
                Debug.LogWarning("[WebPlanner] planner address '" + value + "' (" + from +
                                 ") is not an http or https address: only the copy shipped with the game is used");
                return null;
            }
            Debug.Log("[WebPlanner] planner address from " + from);
            return value;
        }

        // Lines starting with # are comments; the first other line that is not empty is the address.
        static string ReadPlannerUrlFile(string path)
        {
            if (path == null) return null;
            try
            {
                foreach (string raw in File.ReadAllLines(path))
                {
                    string line = raw.Trim();
                    if (line.Length > 0 && line[0] != '#') return line;
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning("[WebPlanner] " + path + " not readable: " + e.Message);
            }
            return null;
        }

        static string CommandLineValue(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++)
                if (args[i] == name) return args[i + 1];
            return null;
        }

        // The address is a page of the local copy.
        bool IsLocalUrl(string url)
        {
            return server != null && !string.IsNullOrEmpty(url) &&
                   url.StartsWith("http://127.0.0.1:" + server.Port + "/", StringComparison.OrdinalIgnoreCase);
        }

        // Scheme and host (and port) are those of the planner site.
        bool IsLiveUrl(string url)
        {
            if (liveOrigin == null || string.IsNullOrEmpty(url) || !url.StartsWith(liveOrigin, StringComparison.OrdinalIgnoreCase))
                return false;
            if (url.Length == liveOrigin.Length) return true;
            char next = url[liveOrigin.Length];
            return next == '/' || next == '?' || next == '#';
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
            string url = liveUrl ?? localUrl;   // the planner site first
            var v = new ViewerProcess();
            viewerDeadline = 0f;   // one attempt
            if (!v.Start(viewerExe, ownerWindow, url, userDataFolder, ViewerBackground, bounds, Debug.isDebugBuild, injectFile))
            {
                Debug.LogWarning("[WebPlanner] MISSION PLAN keeps the built-in panel");
                return;
            }
            viewer = v;
            viewerStartedAt = Time.realtimeSinceStartup;
            pageUrl = null;
            pageLive = liveIsBridge = liveLoaded = onFallback = pageReloading = false;
            tryingLive = liveUrl != null;
            lastLiveTry = viewerStartedAt;
            Debug.Log("[WebPlanner] viewer started on " + url);
        }

        // The viewer's events that need the main thread, in the order they came.
        void ReadViewerEvents()
        {
            string name, detail;
            while (viewer != null && viewer.TryTakeEvent(out name, out detail))
            {
                switch (name)
                {
                    case "loaded":
                        OnPageLoaded(detail);
                        break;
                    case "loadfail":
                        OnLoadFailed(detail);
                        break;
                    case "mission":
                        OnMissionFile(detail);
                        break;
                    case "message":
                        OnPageMessage(detail);
                        break;
                    case "saved":
                        Debug.Log("[WebPlanner] download saved to the user's Downloads folder: " + detail);
                        break;
                    case "blocked":
                        Debug.Log("[WebPlanner] link to another site not opened: " + detail);
                        break;
                    case "downloadfail":
                        Debug.LogWarning("[WebPlanner] download failed: " + detail);
                        break;
                    case "warn":
                        Debug.LogWarning("[WebPlanner] viewer: " + detail);
                        break;
                }
            }
        }

        void OnPageLoaded(string url)
        {
            pageUrl = url;
            pageLive = IsLiveUrl(url);
            if (!pageLive) return;
            tryingLive = false;
            if (!liveLoaded)
            {
                liveLoaded = true;
                Debug.Log("[WebPlanner] the planner site is shown: " + url);
            }
            if (onFallback)
            {
                onFallback = false;
                Debug.Log("[WebPlanner] the planner site can be reached again: the copy shipped with the game is no longer used");
            }
        }

        // The planner site did not load (at the start, or at a later try from the local copy): the local copy takes over.
        // The same when the site was shown and a later load of it fails (its reload for an update): the browser's error
        // page must not stay up.
        void OnLoadFailed(string status)
        {
            if (liveUrl == null) return;
            // Not for the statuses the viewer also prints while the page is still there.
            if (liveLoaded && pageLive && !status.StartsWith("process-failed", StringComparison.Ordinal) &&
                status != "OperationCanceled" && status != "ConnectionAborted")
            {
                liveLoaded = pageLive = false;
                tryingLive = true;
            }
            if (liveLoaded || !tryingLive) return;
            tryingLive = false;
            lastLiveTry = Time.realtimeSinceStartup;
            if (localUrl != null)
            {
                Debug.LogWarning("[WebPlanner] the planner site could not be reached (" + status +
                                 "): using the copy shipped with the game");
                onFallback = true;
                viewer.Navigate(localUrl);
            }
            else if (!viewer.Loaded && !viewerLate)
            {
                // Nothing to show: the rule of the late viewer, without its wait (an error page must not come up).
                viewerLate = true;
                Debug.LogWarning("[WebPlanner] the planner site could not be reached (" + status +
                                 ") and there is no local copy: MISSION PLAN opens the built-in panel");
            }
        }

        // On the local copy because the site failed, and the planner is out of sight: ask for the site again. A new
        // failure brings the copy back (OnLoadFailed).
        void RetryLiveSite()
        {
            if (!onFallback || viewer == null || !viewer.Alive) return;
            float now = Time.realtimeSinceStartup;
            if (now < lastLiveTry + LiveRetryInterval) return;
            lastLiveTry = now;
            if (!viewer.Navigate(liveUrl)) return;
            tryingLive = true;
            Debug.Log("[WebPlanner] trying the planner site again: " + liveUrl);
        }

        // window.chrome.webview.postMessage(object) of the page script. Anything else is ignored.
        void OnPageMessage(string json)
        {
            JObject o;
            try
            {
                o = JObject.Parse(json);
            }
            catch (Exception)
            {
                return;
            }
            switch (Text(o, "type"))
            {
                case "close":   // the MARVIS menu button, or F10 in the viewer
                    HidePlanner();
                    break;
                case "hello":
                {
                    JToken b = o["bridge"];
                    bool bridge = b != null && b.Type == JTokenType.Boolean && (bool)b;
                    helloCount++;
                    helloUrl = Text(o, "url");
                    pageReloading = false;
                    bool live = IsLiveUrl(helloUrl);
                    liveIsBridge = live && bridge;
                    Debug.Log("[WebPlanner] page script ready on " + helloUrl + (bridge ? " (the game's own copy)" : ""));
                    // The script answering from the planner's page means the page is there. The viewer's "loaded"
                    // (the page's load event) is not waited for: the site can hold it back while the window is hidden.
                    if (live || IsLocalUrl(helloUrl))
                    {
                        viewer.MarkLoaded();
                        OnPageLoaded(helloUrl);
                    }
                    // A page of the site loaded after the EVA ended (an update of the site, the site reached again)
                    // gets the log too.
                    if (live && !bridge && evaLogMessage != null) viewer.Post(evaLogMessage);
                    break;
                }
                case "reloading":
                    pageReloading = true;
                    Debug.Log("[WebPlanner] the page loads itself again (" + (Text(o, "reason") ?? "no reason given") + ")");
                    break;
            }
        }

        static string Text(JObject o, string key)
        {
            JToken t = o[key];
            return t != null && t.Type == JTokenType.String ? (string)t : null;
        }

        void PostToPage(JObject message)
        {
            if (viewer != null && viewer.Alive) viewer.Post(message.ToString(Formatting.None));
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
                if (onFallback && tryingLive)
                {
                    // A try of the planner site is still under way: the user is not left waiting for it, the copy
                    // comes back now and the site is tried again later.
                    tryingLive = false;
                    viewer.Navigate(localUrl);
                }
                else if (OnLiveSite) viewer.Post(CheckUpdateMessage);   // a newer version of the site is taken now
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
            // The planner site is not tried again here: a session that fell back stays on the local copy, so a route
            // being drawn there is not dropped. The next start of the game tries the site first again.
        }

        // The game keeps running behind the page (runInBackground), so a controller would still move and press the
        // entries of the menu hidden underneath: uGUI navigation is off while the page is up. Mouse and keyboard go
        // to the viewer anyway. An EventSystem made by a scene reload starts with navigation on.
        static void MenuNavigation(bool on)
        {
            EventSystem es = EventSystem.current;
            if (es != null) es.sendNavigationEvents = on;
        }

        // ---------------------------------------------------------------- missions in

        // API of the local copy (main thread, from WebServer.Pump).
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
            string error = LoadMission(json, out int status);
            if (error != null) return Error(status, error);
            string id = MissionLink.Current != null ? MissionLink.Current.Id : null;
            return new ApiReply(200, new JObject { ["ok"] = true, ["mission_id"] = id }.ToString(Formatting.None));
        }

        static ApiReply Error(int status, string message)
        {
            return new ApiReply(status, new JObject { ["ok"] = false, ["error"] = message }.ToString(Formatting.None));
        }

        // The planner site's "Send to simulator": the viewer caught the download of a mission file. The file is ours to delete.
        void OnMissionFile(string path)
        {
            string json = null;
            try
            {
                json = File.ReadAllText(path, System.Text.Encoding.UTF8);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[WebPlanner] mission file " + path + " not readable: " + e.Message);
            }
            try
            {
                File.Delete(path);
            }
            catch (Exception)
            {
            }
            string error = json != null ? LoadMission(json, out _) : "the mission file could not be read";
            if (error != null) PostToPage(new JObject { ["type"] = "mission-error", ["error"] = error });
        }

        // A mission from the planner, either way in: loads it and starts the EVA. Returns null, or why it was refused
        // (status: the HTTP status the API answers with).
        string LoadMission(string json, out int status)
        {
            MissionLink link = MissionLink.Instance;
            if (link == null)
            {
                status = 503;
                missionsRefused++;
                lastRefusal = "the simulator scene is not ready (no MissionLink in this scene)";
                Debug.Log("[WebPlanner] mission refused: " + lastRefusal);
                return lastRefusal;
            }
            if (!link.LoadJson(json, MissionSource))
            {
                status = 422;
                missionsRefused++;
                lastRefusal = lastError = MissionLink.LastError ?? "the mission could not be loaded";
                Publish();
                Debug.Log("[WebPlanner] mission refused: " + lastError);
                return lastError;
            }
            status = 200;
            missionsAccepted++;
            if (lastError != null)
            {
                lastError = null;
                Publish();
            }
            string id = MissionLink.Current != null ? MissionLink.Current.Id : null;
            Debug.Log("[WebPlanner] mission " + id + " received: starting the EVA");
            if (startEva != null) StopCoroutine(startEva);
            startEva = StartCoroutine(StartEva());
            return null;
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
            evaLogMessage = null;
            Publish();
        }

        // A new EVA log file: tell the page how the EVA of the current mission ended. The local copy asks the API
        // (GET eva-log), the planner site's page gets the log as a message.
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
            if (server != null) server.EvaLogJson = text;
            evaLogSeq++;
            bool current = IsOfCurrentMission(doc);
            if (current) eva = complete ? "complete" : "ended";
            Publish();
            Debug.Log("[WebPlanner] EVA log " + evaLogSeq + " (" + (complete ? "complete" : "not complete") + "): eva " + eva);
            if (current)
            {
                evaLogMessage = new JObject { ["type"] = "eva-log", ["eva"] = eva, ["log"] = doc }.ToString(Formatting.None);
                if (OnLiveSite && viewer != null && viewer.Alive) viewer.Post(evaLogMessage);
            }

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
            // The local copy's debrief is on its Mission Planer page; the user may have left the app on another one.
            // The planner site's page shows the debrief wherever it is.
            if (Available && !OnLiveSite) viewer.Eval("if (!location.hash.startsWith('#/mission')) location.hash = '#/mission'");
            if (ShowPlanner()) Debug.Log("[WebPlanner] EVA complete: planner shown for the debrief");
        }

        // The state document of GET /marvis/api/state (local copy); seq grows with every change.
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

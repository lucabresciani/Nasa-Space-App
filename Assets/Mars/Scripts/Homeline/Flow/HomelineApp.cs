using System;
using System.Collections.Generic;
using NasaSpaceApp.Homeline.Sim;
using NasaSpaceApp.Homeline.Ui;
using NasaSpaceApp.Menu;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace NasaSpaceApp.Homeline.Flow
{
    public enum EvaMode
    {
        None,
        /// <summary>The crew is carried along the planned route at the planned times.</summary>
        Replay,
        /// <summary>The player walks freely from the pad.</summary>
        FreeWalk,
    }

    /// <summary>
    /// Entry point of the HOMELINE integration. Started from code (no scene edits), it survives scene reloads and
    /// puts a mission planning stage between the MARTIS title screen and the EVA:
    ///
    ///   START SIMULATION  ->  MISSION PLANNING (a panel of the menu)  ->  START EVA  ->  the 3D simulation
    ///   pause (Esc)       ->  MISSION PLAN reopens the planning panel
    ///
    /// The plans come from the HOMELINE planner engine (precomputed; see <see cref="PlanCatalog"/>). Without planner
    /// data the hooks are not installed and the app behaves exactly as before.
    /// </summary>
    [DefaultExecutionOrder(-50)]
    public sealed class HomelineApp : MonoBehaviour
    {
        public static HomelineApp Instance { get; private set; }

        public HomelinePaths Paths { get; private set; }
        public PlanCatalog Catalog { get; private set; }
        public EvaDriver Driver { get; private set; }
        /// <summary>The plan chosen on the planning screen; null until one is generated.</summary>
        public MissionPlan Mission { get; private set; }

        /// <summary>
        /// The planner's constants and oxygen model for the scenario of the precomputed plans (nominal, 104 kg suit),
        /// read from the official simulator bundle. Null without the bundle: the free walk then keeps the game's O2.
        /// </summary>
        public HlConfig Config { get; private set; }
        public Physio Physio { get; private set; }
        /// <summary>Minutes from EVA start to dark at the pad (planner conditions/sun.json); null if unknown.</summary>
        public double? TDarkMin { get; private set; }
        /// <summary>The solar storm of the official plan on the EVA clock (planner conditions/storm.json); null if unknown.</summary>
        public StormTrack Storm { get; private set; }
        /// <summary>The planner's station cards (what is at each science station), by station id; may be empty.</summary>
        public Dictionary<string, StationCard> Cards { get; private set; } = new Dictionary<string, StationCard>();

        /// <summary>
        /// The card of a station of a plan as text: the science target, the landmarks around it and, on the
        /// official unedited plan, what to do if the partner goes down and the latest departure. Says when the
        /// station was moved by hand. Null when the planner has no card for it.
        /// </summary>
        public string StationCardText(MissionPlan plan, string stationId, int maxLandmarks)
        {
            StationCard c;
            if (plan == null || stationId == null || Cards == null || !Cards.TryGetValue(stationId, out c)) return null;
            double moved = 0;
            Waypoint now = null, planned = null;
            foreach (Waypoint w in plan.Waypoints.Main) if (w.Kind == WaypointKind.Station && w.Id == stationId) now = w;
            foreach (Waypoint w in plan.BasePlan.Waypoints.Main) if (w.Kind == WaypointKind.Station && w.Id == stationId) planned = w;
            if (now != null && planned != null) moved = Math.Sqrt((now.X - planned.X) * (now.X - planned.X) + (now.Y - planned.Y) * (now.Y - planned.Y));
            bool official = plan.BasePlan.Entry.Origin == PlanOrigin.Official && !plan.Edited;
            return StationCards.Text(c, official, moved, maxLandmarks);
        }
        /// <summary>The real instant the planned EVA starts (plan.json eva_start.utc: 09:00 local mean solar time); null if unknown.</summary>
        public DateTime? EvaStartUtc { get; private set; }
        /// <summary>The planning panel currently hosted by the menu; null until it has been opened.</summary>
        public PlanningPanel Panel { get { return panel; } }

        PadFrame frame;
        Dictionary<string, string> stationNames;
        PlanningPanel panel;
        MartisMenu panelOwner;
        bool pendingStart;
        EvaMode pendingMode;

        // Domain reload is off in this project: drop the previous play session's instance.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            Instance = null;
        }

        // BeforeSceneLoad: the menu reads StartInterceptor / PlanRequested when it builds its entries (AfterSceneLoad).
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void Boot()
        {
            if (Instance != null) return;
            var go = new GameObject("HOMELINE");
            DontDestroyOnLoad(go);
            Instance = go.AddComponent<HomelineApp>();
        }

        void Awake()
        {
            // The simulation must keep running when another window has the focus (self-test, capture tools).
            Application.runInBackground = true;

            Paths = HomelinePaths.Resolve();
            Debug.Log("[HOMELINE] " + Paths.Description);
            Catalog = PlanCatalog.Scan(Paths.WebData, Paths.ResultsDir);
            foreach (string w in Catalog.Warnings) Debug.LogWarning("[HOMELINE] " + w);
            Debug.Log("[HOMELINE] " + Catalog.Plans.Count + " plan(s) available");
            LoadPlannerModel();

            Driver = gameObject.AddComponent<EvaDriver>();
            gameObject.AddComponent<PlanPanel>();
            gameObject.AddComponent<MapRouteOverlay>();

            if (Catalog.Plans.Count > 0)
            {
                // START SIMULATION goes straight to free exploration; MISSION PLAN (title and pause) opens the planning.
                MartisMenu.PlanRequested = OpenPlanning;
                MartisMenu.Closed += OnMenuClosed;
            }
            SceneManager.sceneLoaded += OnSceneLoaded;
            global::NasaSpaceApp.Mission.MissionLink.Changed += OnWebMissionChanged;
            if (SelfTest.Requested) gameObject.AddComponent<SelfTest>();
        }

        void OnDestroy()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
            global::NasaSpaceApp.Mission.MissionLink.Changed -= OnWebMissionChanged;
            MartisMenu.Closed -= OnMenuClosed;
            if (Driver != null) Driver.StopMission();
            if (Instance == this) Instance = null;
        }

        void LoadPlannerModel()
        {
            if (Paths.PlanBundle == null) return;
            try
            {
                using (BundleReader bundle = BundleReader.Open(Paths.PlanBundle))
                {
                    Config = HlConfig.FromBundle(bundle);
                    Physio = new Physio(Config);
                    if (bundle.Has("conditions/sun.json"))
                        TDarkMin = HlJson.NumOrNull(bundle.ReadJson("conditions/sun.json"), "t_dark_min");
                    try
                    {
                        Cards = StationCards.FromBundle(bundle);
                    }
                    catch (Exception e)
                    {
                        Debug.LogWarning("[HOMELINE] station cards not usable: " + e.Message);
                    }
                    try
                    {
                        Storm = StormTrack.FromBundle(bundle);
                    }
                    catch (Exception e)
                    {
                        // Without the storm the live margin simply has no dose term, and the plan panel says so.
                        Debug.LogWarning("[HOMELINE] storm series not usable: " + e.Message);
                    }
                    if (bundle.Has("plan.json"))
                    {
                        string utc = HlJson.Str(bundle.ReadJson("plan.json")["eva_start"], "utc");
                        DateTime parsed;
                        if (utc != null && DateTime.TryParse(utc, System.Globalization.CultureInfo.InvariantCulture,
                                System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out parsed))
                            EvaStartUtc = parsed;
                    }
                }
                Debug.Log("[HOMELINE] planner O2 model loaded: capacity " + HlJson.F(Config.O2CapacityL, 2) + " L, reserve " +
                          HlJson.F(Config.O2ReserveL, 1) + " L, level speed " + HlJson.F(Physio.Governor(0), 3) + " m/s");
            }
            catch (Exception e)
            {
                Config = null;
                Physio = null;
                Debug.LogWarning("[HOMELINE] planner O2 model not available (" + e.Message + "): free walk keeps the game's O2");
            }
        }

        /// <summary>
        /// A mission loaded from a web mission.json (the Mission link, map tab Missions or F5) takes over: the plan
        /// started from the planning screen stops, so that only one mission sets HOME, the route and the sky.
        /// </summary>
        void OnWebMissionChanged(global::NasaSpaceApp.Mission.MissionPlan webPlan)
        {
            if (webPlan == null || Driver == null || !Driver.Active) return;
            Debug.Log("[HOMELINE] a web mission was loaded: the planning screen's plan stops");
            pendingStart = false;
            Driver.StopMission();
        }

        void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            // RESTART SIMULATION reloads the scene: the player, the terrain and the menu are new objects.
            frame = null;
            boundsSet = false;
            planCache.Clear();
            panel = null;
            panelOwner = null;
            pendingStart = false;
            Mission = null;
            Driver.StopMission();
        }

        /// <summary>The one frame every plan is expressed in: the planner's projection, origin at the official pad.</summary>
        public PadFrame Frame
        {
            get
            {
                if (frame != null) return frame;
                MarsGeoReference geo = MarsGeoReference.Instance;
                if (geo == null) return null;
                var scene = new SceneGeo(geo.SwLat, geo.SwLon, geo.MetersPerDegree, geo.EastScale, geo.PlaySwWorld.x, geo.PlaySwWorld.y);
                PlanEntry origin = null;
                foreach (PlanEntry e in Catalog.Plans)
                    if (e.Origin == PlanOrigin.Official) origin = e;
                if (origin == null && Catalog.Plans.Count > 0) origin = Catalog.Plans[0];
                if (origin == null) return null;
                frame = MissionPlan.FrameAt(origin.PadLon, origin.PadLat, origin.PadElevM ?? 0, scene);
                return frame;
            }
        }

        public IDictionary<string, string> StationNames
        {
            get
            {
                if (stationNames == null) stationNames = MissionPlan.ReadStationNames(Catalog.StationsPath);
                return stationNames;
            }
        }

        /// <summary>
        /// Loads a plan and generates its waypoints (the GENERATE WAYPOINTS FROM PLAN button). Returns null and logs
        /// when the plan cannot be read.
        /// </summary>
        public MissionPlan Generate(PlanEntry entry)
        {
            PadFrame f = Frame;
            if (f == null || entry == null) return null;
            MissionPlan cached;
            if (planCache.TryGetValue(entry.Id, out cached)) return cached; // one object per plan: its way-home map is attached once
            BundleReader bundle = null;
            try
            {
                if (entry.Origin == PlanOrigin.Official && Paths.PlanBundle != null) bundle = BundleReader.Open(Paths.PlanBundle);
                MissionPlan plan = MissionPlan.Load(entry, f, StationNames, bundle, WaypointPlan.AssumedNavToleranceM);
                planCache[entry.Id] = plan;
                Debug.Log("[HOMELINE] plan " + entry.Id + ": " + plan.Waypoints.CountText() + ", " +
                          HlJson.F(plan.EndMin, 2) + " min, return fields " + (plan.HasReturnFields ? "yes" : "no"));
                return plan;
            }
            catch (Exception e)
            {
                Debug.LogError("[HOMELINE] plan " + entry.Id + " could not be loaded: " + e.Message);
                return null;
            }
            finally
            {
                if (bundle != null) bundle.Dispose();
            }
        }

        readonly Dictionary<string, MissionPlan> planCache = new Dictionary<string, MissionPlan>(StringComparer.Ordinal);
        readonly Dictionary<string, RoutedLeg> legCache = new Dictionary<string, RoutedLeg>(StringComparer.Ordinal);
        GridRouter router;
        bool routerTried;
        bool boundsSet;

        /// <summary>Metres kept between an edited route and the edge of the detailed terrain.</summary>
        public const double DetailedTerrainInsetM = 6.0;

        /// <summary>
        /// Keeps edited routes on the scene's high-definition terrain: the router may only use the box of that
        /// terrain, and a station cannot be dropped outside it. Done once per scene.
        /// </summary>
        void EnsureRouterBounds(MissionPlan plan)
        {
            if (boundsSet || plan == null || Router == null) return;
            float minX, minZ, maxX, maxZ;
            if (!new GroundSampler().DetailedRect(out minX, out minZ, out maxX, out maxZ)) return;
            double x0, y0, x1, y1, x2, y2, x3, y3;
            plan.Frame.WorldToLocal(minX, minZ, out x0, out y0);
            plan.Frame.WorldToLocal(maxX, minZ, out x1, out y1);
            plan.Frame.WorldToLocal(minX, maxZ, out x2, out y2);
            plan.Frame.WorldToLocal(maxX, maxZ, out x3, out y3);
            double d = DetailedTerrainInsetM;
            Router.SetAllowedRect(Math.Max(x0, x2) + d, Math.Max(y0, y1) + d, Math.Min(x1, x3) - d, Math.Min(y2, y3) - d);
            boundsSet = true;
            legCache.Clear();
            Debug.Log("[HOMELINE] edited routes kept on the detailed terrain: x " + HlJson.F(Math.Max(x0, x2) + d, 0) + ".." + HlJson.F(Math.Min(x1, x3) - d, 0) +
                      " m, y " + HlJson.F(Math.Max(y0, y1) + d, 0) + ".." + HlJson.F(Math.Min(y2, y3) - d, 0) + " m of the pad");
        }

        /// <summary>True where a station may stand: reachable in the plan's way-home map and on the detailed terrain.</summary>
        public bool CanPlaceStation(MissionPlan plan, double x, double y)
        {
            if (plan == null || !plan.THomeAt(x, y).HasValue) return false;
            EnsureRouterBounds(plan);
            return Router == null || Router.InAllowed(x, y);
        }

        /// <summary>The simulator's re-router (HomelineData/router); null when its data is not there.</summary>
        public GridRouter Router
        {
            get
            {
                if (routerTried) return router;
                routerTried = true;
                try
                {
                    if (Paths.PlanBundle != null)
                        router = GridRouter.Load(System.IO.Path.Combine(System.IO.Directory.GetParent(System.IO.Path.GetDirectoryName(Paths.PlanBundle)).FullName, "router"));
                }
                catch (Exception e)
                {
                    Debug.LogWarning("[HOMELINE] router data not usable: " + e.Message);
                }
                Debug.Log("[HOMELINE] re-router " + (router != null ? "ready (" + router.Rows + " x " + router.Cols + " cells of " + HlJson.F(router.CellM, 0) + " m)" : "not available"));
                return router;
            }
        }

        /// <summary>
        /// True when the stations of a plan can be moved by hand: the plan needs a way-home map (the planner's on the
        /// official pad, else one computed here, see <see cref="EnsureHomeMap"/>), the planner's numbers and the router data.
        /// </summary>
        public bool CanEdit(MissionPlan plan)
        {
            return plan != null && plan.HasReturnFields && Config != null && Router != null;
        }

        /// <summary>"way home 41 min, 52 L O2" for a point where a station may stand; null where it may not.</summary>
        public string ProbeStationPoint(MissionPlan plan, double x, double y)
        {
            if (!CanEdit(plan)) return null;
            EnsureRouterBounds(plan);
            int r, c;
            if (!Router.NearestPassable(x, y, StationSnapM, out r, out c)) return null;
            Router.CentreOf(r, c, out x, out y);
            if (!Router.InAllowed(x, y)) return null;
            double? th = plan.THomeAt(x, y), o2 = plan.O2HomeAt(x, y);
            if (!th.HasValue || !o2.HasValue) return null;
            return "way home " + HlJson.F(th.Value, 0) + "\u00a0min, " + HlJson.F(o2.Value, 0) + "\u00a0L O2";
        }

        /// <summary>A dropped station snaps to walkable ground within this distance, metres (assumption of the simulator).</summary>
        public const double StationSnapM = 15.0;

        /// <summary>
        /// The plan with one station moved to a point of the frame and every leg re-routed by the simulator
        /// (<see cref="PlanEditor"/>). Station order and work times stay as planned. Null, with the reason, when
        /// the point is not walkable, lies outside the planner's way-home map, or cannot be reached.
        /// </summary>
        public MissionPlan MoveStation(MissionPlan plan, string stationId, double x, double y, out string problem)
        {
            problem = null;
            if (!CanEdit(plan))
            {
                problem = "this plan has no way-home map yet.";
                return null;
            }
            int r, c;
            if (!Router.NearestPassable(x, y, StationSnapM, out r, out c))
            {
                problem = "no walkable ground within " + HlJson.F(StationSnapM, 0) + " m of that point.";
                return null;
            }
            Router.CentreOf(r, c, out x, out y);
            EnsureRouterBounds(plan);
            if (!Router.InAllowed(x, y))
            {
                problem = "that point is off the high-definition terrain.";
                return null;
            }
            if (!plan.THomeAt(x, y).HasValue)
            {
                problem = "that point cannot be reached from the rover (outside the way-home map).";
                return null;
            }
            List<EditStop> stops = plan.StopsOf();
            bool found = false;
            foreach (EditStop s in stops)
            {
                if (s.Id != stationId) continue;
                s.X = x;
                s.Y = y;
                found = true;
            }
            if (!found)
            {
                problem = "the plan has no station " + stationId + ".";
                return null;
            }
            return BuildEdited(plan, stops, out problem);
        }

        /// <summary>The plan re-routed through the given stations (the pad, the frame and the way-home map are the plan's).</summary>
        public MissionPlan BuildEdited(MissionPlan plan, List<EditStop> stops, out string problem)
        {
            problem = null;
            if (!CanEdit(plan))
            {
                problem = "this plan has no way-home map yet.";
                return null;
            }
            EnsureRouterBounds(plan);
            try
            {
                var ctx = new EditContext
                {
                    Router = Router, Config = Config, TDarkMin = TDarkMin, Storm = Storm, THome = plan.THomeAt, O2Home = plan.O2HomeAt,
                    PadX = plan.Route.PadX, PadY = plan.Route.PadY, Scenario = plan.Entry.ScenarioId, LegCache = legCache,
                };
                float t0 = Time.realtimeSinceStartup;
                EditedPlanData data = PlanEditor.Build(ctx, plan.Frame, stops);
                if (data == null)
                {
                    problem = "no walkable route on the high-definition terrain reaches that point.";
                    return null;
                }
                MissionPlan edited = MissionPlan.FromEdited(plan, data, WaypointPlan.AssumedNavToleranceM);
                Debug.Log("[HOMELINE] plan re-routed in " + HlJson.F((Time.realtimeSinceStartup - t0) * 1000f, 0) + " ms: " +
                          HlJson.F(edited.EndMin, 2) + " min, smallest margin " + HlJson.F(data.MinMarginMin, 1) + " min (" + data.MinMarginBinding +
                          "), O2 margin " + HlJson.F(data.MinO2MarginMin, 1) + " min");
                return edited;
            }
            catch (Exception e)
            {
                Debug.LogError("[HOMELINE] re-route failed: " + e);
                problem = "the plan could not be re-routed.";
                return null;
            }
        }

        // ---- way-home maps for pads that have none from the planner (computed on a worker thread)

        /// <summary>Search limits of a computed way-home map: minutes from the pad, and metres around it.</summary>
        public const double HomeMapMaxMin = 160.0, HomeMapWindowM = 3000.0;

        System.Threading.Tasks.Task<HomeField> homeTask;
        MissionPlan homeTaskPlan;
        HomeField homeCache;
        string homeCacheId;

        public bool HomeMapPending(MissionPlan plan)
        {
            return plan != null && homeTask != null && ReferenceEquals(homeTaskPlan, plan.BasePlan);
        }

        /// <summary>
        /// Makes sure the plan's pad gets a way-home map: the planner's when it has one, else one computed here in
        /// the background (a few seconds). Cheap to call every frame; <see cref="PollHomeMap"/> reports the arrival.
        /// </summary>
        public void EnsureHomeMap(MissionPlan plan)
        {
            if (plan == null) return;
            MissionPlan root = plan.BasePlan;
            if (root.HasReturnFields || Config == null || Router == null || homeTask != null) return;
            if (homeCache != null && homeCacheId == root.Entry.Id)
            {
                root.AttachHomeField(homeCache);
                return;
            }
            GridRouter r = Router;
            double px = root.Route.PadX, py = root.Route.PadY;
            homeTaskPlan = root;
            homeTask = System.Threading.Tasks.Task.Run(() => r.HomeFieldOf(px, py, HomeMapMaxMin, HomeMapWindowM));
        }

        /// <summary>True in the frame a background way-home map has finished (attached, or failed and logged).</summary>
        public bool PollHomeMap()
        {
            if (homeTask == null || !homeTask.IsCompleted) return false;
            System.Threading.Tasks.Task<HomeField> t = homeTask;
            MissionPlan root = homeTaskPlan;
            homeTask = null;
            homeTaskPlan = null;
            if (t.IsFaulted || t.Result == null)
            {
                Debug.LogWarning("[HOMELINE] way-home map of " + root.Entry.Id + " could not be computed" + (t.Exception != null ? ": " + t.Exception.Message : ""));
                return true;
            }
            homeCache = t.Result;
            homeCacheId = root.Entry.Id;
            root.AttachHomeField(t.Result);
            Debug.Log("[HOMELINE] way-home map of " + root.Entry.Id + " computed by the simulator");
            return true;
        }

        void HomeMapNow(MissionPlan root)
        {
            if (root.HasReturnFields || Config == null || Router == null) return;
            if (homeCache == null || homeCacheId != root.Entry.Id)
            {
                homeCache = Router.HomeFieldOf(root.Route.PadX, root.Route.PadY, HomeMapMaxMin, HomeMapWindowM);
                homeCacheId = root.Entry.Id;
            }
            root.AttachHomeField(homeCache);
        }

        // ---- the user's saved routes

        /// <summary>Set to keep saved routes somewhere else than the user's data folder (the self-test does).</summary>
        public string RoutesFolderOverride;

        public string RoutesFolder
        {
            get { return !string.IsNullOrEmpty(RoutesFolderOverride) ? RoutesFolderOverride : System.IO.Path.Combine(Application.persistentDataPath, "HomelineRoutes"); }
        }

        public List<SavedRoute> SavedRoutes()
        {
            try
            {
                return RouteStore.List(RoutesFolder);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[HOMELINE] saved routes not readable: " + e.Message);
                return new List<SavedRoute>();
            }
        }

        /// <summary>Saves an edited plan as a route of the user's list; null with the reason when it cannot.</summary>
        public SavedRoute SaveRoute(MissionPlan plan, out string problem)
        {
            problem = null;
            if (plan == null || !plan.Edited || plan.EditData == null)
            {
                problem = "only an edited plan can be saved.";
                return null;
            }
            try
            {
                int number = SavedRoutes().Count + 1;
                string name = "Route " + number + " · " + plan.BasePlan.Entry.Title;
                SavedRoute r = RouteStore.Save(RoutesFolder, name, plan.BasePlan.Entry.Id, plan.StopsOf(), plan.EditData, DateTime.UtcNow);
                Debug.Log("[HOMELINE] route saved: " + r.FilePath);
                return r;
            }
            catch (Exception e)
            {
                Debug.LogError("[HOMELINE] route not saved: " + e);
                problem = "the file could not be written (" + e.Message + ").";
                return null;
            }
        }

        /// <summary>Re-builds a saved route from its base plan and its saved stations; null with the reason when it cannot.</summary>
        public MissionPlan LoadSaved(SavedRoute route, out string problem)
        {
            problem = null;
            PlanEntry entry = route != null ? Catalog.Find(route.BasePlanId) : null;
            MissionPlan root = entry != null ? Generate(entry) : null;
            if (root == null)
            {
                problem = "its base plan (" + (route != null ? route.BasePlanId : "?") + ") is not available.";
                return null;
            }
            HomeMapNow(root);
            var stops = new List<EditStop>();
            foreach (EditStop s in route.Stops) stops.Add(new EditStop { Id = s.Id, X = s.X, Y = s.Y, DwellMin = s.DwellMin });
            MissionPlan plan = BuildEdited(root, stops, out problem);
            if (plan != null) plan.Entry.Title = route.Name;
            return plan;
        }

        /// <summary>START EVA: leaves the menu and starts the mission when the menu has actually closed.</summary>
        public void Begin(MissionPlan plan, EvaMode mode)
        {
            if (plan == null) return;
            Mission = plan;
            pendingMode = mode;
            pendingStart = true;
            MartisMenu menu = MartisMenu.Instance;
            if (menu != null && MartisMenu.IsOpen)
            {
                menu.Back();
                MartisMenu.StartNow();
            }
            else
            {
                OnMenuClosed();
            }
        }

        bool OnStartRequested()
        {
            // true = "handled, StartNow() follows later": the title stays up under the planning panel.
            return OpenPlanningPanel();
        }

        /// <summary>Opens the planning panel (MISSION PLAN entry of the pause menu).</summary>
        public void OpenPlanning()
        {
            OpenPlanningPanel();
        }

        bool OpenPlanningPanel()
        {
            MartisMenu menu = MartisMenu.Instance;
            if (menu == null || Catalog.Plans.Count == 0 || Frame == null) return false;
            if (panel == null || panelOwner != menu)
            {
                panel = new PlanningPanel(this);
                panelOwner = menu;
            }
            menu.ShowPanel(panel);
            return true;
        }

        void OnMenuClosed()
        {
            if (!pendingStart) return;
            pendingStart = false;
            Driver.StartMission(Mission, pendingMode);
        }
    }
}

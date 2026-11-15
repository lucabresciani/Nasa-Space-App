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
                MartisMenu.StartInterceptor = OnStartRequested;
                MartisMenu.PlanRequested = OpenPlanning;
                MartisMenu.Closed += OnMenuClosed;
            }
            SceneManager.sceneLoaded += OnSceneLoaded;
            if (SelfTest.Requested) gameObject.AddComponent<SelfTest>();
        }

        void OnDestroy()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
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

        void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            // RESTART SIMULATION reloads the scene: the player, the terrain and the menu are new objects.
            frame = null;
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
            BundleReader bundle = null;
            try
            {
                if (entry.Origin == PlanOrigin.Official && Paths.PlanBundle != null) bundle = BundleReader.Open(Paths.PlanBundle);
                MissionPlan plan = MissionPlan.Load(entry, f, StationNames, bundle, WaypointPlan.AssumedNavToleranceM);
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

        GridRouter router;
        bool routerTried;

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
        /// True when the stations of a plan can be moved by hand: the plan needs the planner's way-home maps (the
        /// official pad), the planner's numbers and the router data.
        /// </summary>
        public bool CanEdit(MissionPlan plan)
        {
            return plan != null && plan.HasReturnFields && Config != null && Router != null;
        }

        /// <summary>"way home 41 min, 52 L O2" for a point where a station may stand; null where it may not.</summary>
        public string ProbeStationPoint(MissionPlan plan, double x, double y)
        {
            if (!CanEdit(plan)) return null;
            int r, c;
            if (!Router.NearestPassable(x, y, StationSnapM, out r, out c)) return null;
            Router.CentreOf(r, c, out x, out y);
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
                problem = "stations can be moved on the official plan only.";
                return null;
            }
            int r, c;
            if (!Router.NearestPassable(x, y, StationSnapM, out r, out c))
            {
                problem = "no walkable ground within " + HlJson.F(StationSnapM, 0) + " m of that point.";
                return null;
            }
            Router.CentreOf(r, c, out x, out y);
            if (!plan.THomeAt(x, y).HasValue)
            {
                problem = "that point is outside the planner's way-home map.";
                return null;
            }
            var stops = new List<EditStop>();
            RouteTrack track = plan.Track;
            bool found = false;
            for (int i = 0; i < track.Legs.Count - 1; i++)
            {
                RouteLeg leg = track.Legs[i];
                int n = leg.X.Length;
                var stop = new EditStop { Id = leg.To, X = leg.X[n - 1], Y = leg.Y[n - 1], DwellMin = track.Legs[i + 1].StartMin - leg.EndMin };
                if (stop.Id == stationId)
                {
                    stop.X = x;
                    stop.Y = y;
                    found = true;
                }
                stops.Add(stop);
            }
            if (!found)
            {
                problem = "the plan has no station " + stationId + ".";
                return null;
            }
            try
            {
                var ctx = new EditContext
                {
                    Router = Router, Config = Config, TDarkMin = TDarkMin, Storm = Storm, THome = plan.THome, O2Home = plan.O2Home,
                    PadX = plan.Route.PadX, PadY = plan.Route.PadY, Scenario = plan.Entry.ScenarioId,
                };
                float t0 = Time.realtimeSinceStartup;
                EditedPlanData data = PlanEditor.Build(ctx, plan.Frame, stops);
                if (data == null)
                {
                    problem = "no walkable route reaches that point.";
                    return null;
                }
                MissionPlan edited = MissionPlan.FromEdited(plan, data, WaypointPlan.AssumedNavToleranceM);
                Debug.Log("[HOMELINE] " + stationId + " moved, plan re-routed in " + HlJson.F((Time.realtimeSinceStartup - t0) * 1000f, 0) + " ms: " +
                          HlJson.F(edited.EndMin, 2) + " min, smallest margin " + HlJson.F(data.MinMarginMin, 1) + " min (" + data.MinMarginBinding + ")");
                return edited;
            }
            catch (Exception e)
            {
                Debug.LogError("[HOMELINE] re-route failed: " + e);
                problem = "the plan could not be re-routed.";
                return null;
            }
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

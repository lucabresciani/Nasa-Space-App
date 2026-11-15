using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;

namespace NasaSpaceApp.Mission
{
    /// <summary>
    /// Receives a mission from the HOMELINE web Mission Planer and holds it for the HUD: <see cref="Current"/> plus the
    /// <see cref="Changed"/> event. Created automatically in every scene that has a <see cref="MarsGeoReference"/>, on a
    /// GameObject named <see cref="ObjectName"/>, so a WebGL page can call
    /// <c>unityInstance.SendMessage("MissionLink", "LoadMission", json)</c>.
    ///
    /// Ways in:
    /// <list type="bullet">
    /// <item>Start-up: <c>-mission &lt;path&gt;</c> on the command line, else <c>{persistentDataPath}/mission.json</c>.</item>
    /// <item>F5 in play: loads the newest <c>mission*.json</c> from ~/Downloads (the web page's download) or persistentDataPath.</item>
    /// <item>Editor: Tools ▸ Mars ▸ Load Mission JSON… (file picker, play mode).</item>
    /// <item>Code / WebGL: <see cref="LoadMission"/> (JSON text) or <see cref="LoadFile"/>.</item>
    /// </list>
    /// A mission survives scene reloads (re-built against the new scene). Nothing is recomputed: the plan's numbers are
    /// the planner's.
    ///
    /// Loading a mission starts its EVA at the pad: <see cref="HomeBase"/> moves to the mission pad (HOME distance and
    /// bearing, HOME markers, radio base) and the player is placed on the pad facing the first leg; falling off the
    /// world respawns there too. <see cref="Clear"/> puts HOME and the respawn point back to the scene spawn.
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-50)]
    public sealed class MissionLink : MonoBehaviour
    {
        public const string ObjectName = "MissionLink";
        public const string DefaultFileName = "mission.json";
        public const string DownloadPattern = "mission*.json";   // web: mission_{mission_id}.json

        private static MissionLink instance;
        private static MissionFile lastFile;      // kept across scene loads
        private static string lastSource;
        private static int version;

        private bool sceneSpawnSaved;             // the scene's own respawn point, restored by Clear
        private Vector3 sceneSpawnPos;
        private Quaternion sceneSpawnRot;

        /// <summary>The scene's link (null before the first scene with a geo-reference).</summary>
        public static MissionLink Instance => instance;

        /// <summary>The loaded mission, in this scene's world space; null when none.</summary>
        public static MissionPlan Current { get; private set; }

        /// <summary>Where <see cref="Current"/> came from (file path or "WebGL" / "code").</summary>
        public static string CurrentSource => Current != null ? lastSource : null;

        /// <summary>Last load error (null after a successful load).</summary>
        public static string LastError { get; private set; }

        /// <summary>Raised after a mission was loaded, rebuilt for a new scene, or cleared (argument null).</summary>
        public static event Action<MissionPlan> Changed;

        /// <summary>Incremented whenever <see cref="Current"/> changes; HUD widgets compare it to know when to redraw.</summary>
        public static int Version => version;

        private InputAction reloadAction;

        // Domain reload is off: reset statics each play session.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
            instance = null;
            lastFile = null;
            lastSource = null;
            Current = null;
            LastError = null;
            Changed = null;
            version = 0;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Boot()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
            SceneManager.sceneLoaded += OnSceneLoaded;
            EnsureInScene();
        }

        private static void OnSceneLoaded(Scene scene, LoadSceneMode mode) => EnsureInScene();

        private static void EnsureInScene()
        {
            if (instance != null || MarsGeoReference.Instance == null)
            {
                return;
            }
            new GameObject(ObjectName).AddComponent<MissionLink>();
        }

        private void Awake()
        {
            if (instance != null && instance != this)
            {
                Destroy(gameObject);
                return;
            }
            instance = this;
            gameObject.name = ObjectName;
            reloadAction = new InputAction("MissionReload", InputActionType.Button, "<Keyboard>/f5");
            reloadAction.Enable();
        }

        private void Start()
        {
            if (lastFile != null)
            {
                Apply(lastFile, lastSource);   // a mission from the previous scene: rebuild it here
                return;
            }
            string path = StartupPath();
            if (path != null)
            {
                LoadFile(path);
            }
        }

        private void Update()
        {
            if (reloadAction != null && reloadAction.WasPressedThisFrame())
            {
                string path = NewestCandidate();
                if (path != null)
                {
                    LoadFile(path);
                }
                else
                {
                    Fail("no mission*.json in " + string.Join(" or ", SearchFolders()), null);
                }
            }
        }

        private void OnDestroy()
        {
            reloadAction?.Dispose();
            reloadAction = null;
            if (instance == this)
            {
                instance = null;
                Current = null;   // world positions belong to this scene
                version++;
                HomeBase.Reset();
            }
        }

        /// <summary>Loads a mission from JSON text (WebGL SendMessage target). Logs and keeps the old one on error.</summary>
        public void LoadMission(string json) => LoadJson(json, "WebGL / code");

        /// <summary>Loads a mission from JSON text; <paramref name="source"/> is shown in logs.</summary>
        public bool LoadJson(string json, string source)
        {
            MissionFile file = MissionFile.Parse(json, out string error);
            if (file == null)
            {
                Fail(error, source);
                return false;
            }
            return Apply(file, source);
        }

        /// <summary>Loads a mission file. Logs and keeps the old mission on error.</summary>
        public bool LoadFile(string path)
        {
            string json;
            try
            {
                json = File.ReadAllText(path);
            }
            catch (Exception e)
            {
                Fail("cannot read file: " + e.Message, path);
                return false;
            }
            return LoadJson(json, path);
        }

        /// <summary>Drops the current mission.</summary>
        public void Clear()
        {
            lastFile = null;
            lastSource = null;
            Current = null;
            LastError = null;
            version++;
            HomeBase.Reset();
            FirstPersonController player = FindAnyObjectByType<FirstPersonController>();
            if (player != null && sceneSpawnSaved)
            {
                player.SetSpawn(sceneSpawnPos, sceneSpawnRot);
            }
            Debug.Log("[Mission] cleared: HOME is the scene spawn again");
            Changed?.Invoke(null);
        }

        private bool Apply(MissionFile file, string source)
        {
            MarsGeoReference geo = MarsGeoReference.Instance;
            if (geo == null)
            {
                Fail("this scene has no MarsGeoReference (no map coordinates)", source);
                return false;
            }
            MissionPlan plan;
            try
            {
                plan = MissionPlan.Build(file, new SceneWorld(geo));
            }
            catch (Exception e)
            {
                Fail("cannot place the mission in the scene: " + e.Message, source);
                return false;
            }
            lastFile = file;
            lastSource = source;
            Current = plan;
            LastError = null;
            version++;
            StartAtPad(plan);
            Debug.Log("[Mission] loaded " + plan + (source != null ? "\n  from " + source : string.Empty)
                      + "\n  " + plan.OriginLabel);
            foreach (string w in plan.Warnings)
            {
                Debug.LogWarning("[Mission] " + w);
            }
            Changed?.Invoke(plan);
            return true;
        }

        // HOME → mission pad; player → on the pad, facing the first leg.
        private void StartAtPad(MissionPlan plan)
        {
            Vector3 pad = plan.PadWorld;
            if (GroundAt(pad, out float y))
            {
                pad.y = y;
            }
            HomeBase.Set(pad);

            FirstPersonController player = FindAnyObjectByType<FirstPersonController>();
            if (player == null)
            {
                Debug.LogWarning("[Mission] no FirstPersonController in the scene: player not moved to the pad");
                return;
            }
            if (!sceneSpawnSaved)
            {
                sceneSpawnSaved = true;
                sceneSpawnPos = player.SpawnPosition;
                sceneSpawnRot = player.SpawnRotation;
            }
            player.PlaceAt(pad, FirstLegYaw(plan), true);
            Debug.Log(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "[Mission] player placed on the mission pad at world ({0:0}, {1:0}, {2:0}); HOME = pad", pad.x, pad.y, pad.z));
        }

        // Bearing (deg clockwise from north) from the pad to the first route point at least 3 m away; 0 if none.
        private static float FirstLegYaw(MissionPlan plan)
        {
            Vector3 pad = plan.PadWorld;
            Vector3[] r = plan.Route;
            for (int i = 0; i < r.Length; i++)
            {
                float dx = r[i].x - pad.x, dz = r[i].z - pad.z;
                if (dx * dx + dz * dz >= 9f)
                {
                    return Mathf.Repeat(Mathf.Atan2(dx, dz) * Mathf.Rad2Deg, 360f);
                }
            }
            return 0f;
        }

        // Top of whatever is solid under a point (terrain or a boulder); false when nothing is hit.
        private static bool GroundAt(Vector3 p, out float y)
        {
            const float Top = 20000f;
            RaycastHit[] hits = Physics.RaycastAll(new Vector3(p.x, Top, p.z), Vector3.down, 2f * Top,
                                                   Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore);
            y = float.NegativeInfinity;
            foreach (RaycastHit h in hits)
            {
                if (h.collider.GetComponentInParent<FirstPersonController>() != null)
                {
                    continue;   // not the player itself
                }
                if (h.point.y > y)
                {
                    y = h.point.y;
                }
            }
            return !float.IsNegativeInfinity(y);
        }

        private static void Fail(string error, string source)
        {
            LastError = error;
            Debug.LogWarning("[Mission] not loaded: " + error + (source != null ? "\n  (" + source + ")" : string.Empty));
        }

        // ---- files

        private static string StartupPath()
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++)
            {
                if (args[i] == "-mission")
                {
                    return args[i + 1];
                }
            }
#if !UNITY_WEBGL || UNITY_EDITOR
            string p = Path.Combine(Application.persistentDataPath, DefaultFileName);
            if (File.Exists(p))
            {
                return p;
            }
#endif
            return null;
        }

        private static IEnumerable<string> SearchFolders()
        {
#if !UNITY_WEBGL || UNITY_EDITOR
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(home))
            {
                yield return Path.Combine(home, "Downloads");
            }
            yield return Application.persistentDataPath;
#else
            yield break;
#endif
        }

        /// <summary>Newest mission*.json in ~/Downloads or persistentDataPath; null when there is none.</summary>
        public static string NewestCandidate()
        {
            string best = null;
            DateTime bestTime = DateTime.MinValue;
            foreach (string dir in SearchFolders())
            {
                string[] files;
                try
                {
                    if (!Directory.Exists(dir)) continue;
                    files = Directory.GetFiles(dir, DownloadPattern, SearchOption.TopDirectoryOnly);
                }
                catch (Exception)
                {
                    continue;   // no permission, etc.
                }
                foreach (string f in files)
                {
                    DateTime t = File.GetLastWriteTimeUtc(f);
                    if (t > bestTime)
                    {
                        bestTime = t;
                        best = f;
                    }
                }
            }
            return best;
        }

        // ---- scene mapping

        /// <summary>Lat/lon → world via the scene's geo-reference; y = height of the finest terrain under the point.</summary>
        private sealed class SceneWorld : IMissionWorld
        {
            private readonly MarsGeoReference geo;
            private readonly Terrain[] terrains;

            public SceneWorld(MarsGeoReference geo)
            {
                this.geo = geo;
                terrains = Terrain.activeTerrains;
            }

            public Vector3 ToWorld(double lat, double lon)
            {
                Vector3 p = geo.WorldXZ(lat, lon);
                Terrain best = null;
                float bestArea = float.MaxValue;
                foreach (Terrain t in terrains)
                {
                    if (t == null || t.terrainData == null) continue;
                    Vector3 o = t.GetPosition(), size = t.terrainData.size;
                    if (p.x < o.x || p.z < o.z || p.x > o.x + size.x || p.z > o.z + size.z) continue;
                    float area = size.x * size.z;
                    if (area < bestArea)
                    {
                        bestArea = area;
                        best = t;
                    }
                }
                if (best != null)
                {
                    p.y = best.SampleHeight(p) + best.GetPosition().y;
                }
                return p;
            }
        }
    }
}

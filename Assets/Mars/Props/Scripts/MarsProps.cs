using System;
using System.Collections.Generic;
using System.Globalization;
using NasaSpaceApp.Science;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace NasaSpaceApp.Props
{
    /// <summary>One prop standing in the scene: its GameObject name, where it is and how big it is.</summary>
    public sealed class PlacedProp
    {
        /// <summary>Unique, stable GameObject name (e.g. <c>Prop_CrewRover</c>).</summary>
        public string Name;
        public Transform Transform;
        /// <summary>Width (x), height (y) and length (z) in metres.</summary>
        public Vector3 SizeM;
        public Vector3 Position { get { return Transform != null ? Transform.position : Vector3.zero; } }
        public float YawDeg { get { return Transform != null ? Transform.eulerAngles.y : 0f; } }
    }

    /// <summary>
    /// Marks the simulation's start point with 3D models, at run time and without touching the scene file: the
    /// crew rover and the habitat stand next to HOME (<see cref="HomeBase"/>) and follow it when a mission moves
    /// HOME to the pad. Models come from <c>Resources/Props</c>; a missing model is skipped. They are scenery:
    /// they bind no key, change no mission value and carry no science data.
    ///
    /// This is the small version of the props layer (the full one, with a rover at each science station, dust,
    /// wheel tracks and lights, lives on the branch <c>mars-props</c>).
    ///
    /// Command line: <c>-noProps</c> turns the layer off. It also stays off during the unattended tests
    /// (<c>-homelineSelfTest</c>, <c>-marvisWebTest</c>), which walk the crew through the scene on their own.
    /// <c>-propsInTests</c> keeps it on in those tests.
    /// </summary>
    public sealed class MarsProps : MonoBehaviour
    {
        // ---- what to place ---------------------------------------------------------------------------------------

        /// <summary>A science station of the plan (east longitude, latitude in degrees): the props keep out of their way.</summary>
        readonly struct Station
        {
            public readonly string Id;
            public readonly double Lon, Lat;
            public Station(string id, double lon, double lat) { Id = id; Lon = lon; Lat = lat; }
        }

        // Copied from the planner's published data, HomelineData/web/data/stations.json (fields id, lon, lat).
        static readonly Station[] Stations =
        {
            new Station("S1", 137.379249, -4.808320), // Boxwork ridge-hollow transect
            new Station("S2", 137.375440, -4.778796), // Fracture-network survey
            new Station("S4", 137.408931, -4.785832), // Gediz Vallis sulfur field
            new Station("S6", 137.383481, -4.788919), // dense ridge network, sulfate signal (nearer)
            new Station("S7", 137.373323, -4.789762), // dense ridge network, sulfate signal (farther)
            new Station("S8", 137.386021, -4.770783), // dense ridge network, clay signal
        };

        /// <summary>A prop that stands next to HOME.</summary>
        readonly struct HomeProp
        {
            public readonly string Name, Resource;
            /// <summary>Clear ground kept between HOME and the prop's edge (m).</summary>
            public readonly float GapM;
            /// <summary>Bearing offset from the "away from the stations" direction (degrees, clockwise).</summary>
            public readonly float BearingOffsetDeg;
            /// <summary>True for things that stand vertical on any ground (a person, a building on levelling feet).</summary>
            public readonly bool Upright;
            public HomeProp(string name, string resource, float gapM, float bearingOffsetDeg, bool upright)
            { Name = name; Resource = resource; GapM = gapM; BearingOffsetDeg = bearingOffsetDeg; Upright = upright; }
        }

        // In placing order: each one keeps clear of those before it.
        static readonly HomeProp[] HomeProps =
        {
            new HomeProp("Prop_CrewRover", "Props/CrewRover", 7f, 0f, false),
            // A backdrop: low-detail model, meant to be seen from 40 m or more.
            new HomeProp("Prop_Habitat", "Props/Habitat", 22f, 70f, true),
        };

        const string RootName = "MarsProps";

        // Placement limits.
        const float HomeMaxSlopeDeg = 9f;
        const float SinkM = 0.02f;                // wheels pressed a little into the regolith

        // ---- state -----------------------------------------------------------------------------------------------

        public static MarsProps Instance { get; private set; }

        readonly List<PlacedProp> placed = new List<PlacedProp>();
        readonly List<Transform> homeProps = new List<Transform>();
        readonly List<GameObject> hiddenRocks = new List<GameObject>();
        Ground ground;
        RockInfo[] rocks = new RockInfo[0];
        int homeVersion = int.MinValue;

        /// <summary>Every prop standing in the scene.</summary>
        public IReadOnlyList<PlacedProp> Placed { get { return placed; } }

        /// <summary>The prop with this GameObject name, or null.</summary>
        public PlacedProp Find(string name)
        {
            for (int i = 0; i < placed.Count; i++)
                if (placed[i].Name == name) return placed[i];
            return null;
        }

        // Domain reload is off in this project: clear the statics each play session.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            Instance = null;
            SceneManager.sceneLoaded -= OnSceneLoaded;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot()
        {
            if (!EnabledByCommandLine()) return;
            SceneManager.sceneLoaded -= OnSceneLoaded;
            SceneManager.sceneLoaded += OnSceneLoaded;
            Build(false);
        }

        static void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            if (mode == LoadSceneMode.Single) Build(false);
        }

        static bool EnabledByCommandLine()
        {
            string[] args = Environment.GetCommandLineArgs();
            bool inTest = false, wantedInTests = false;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "-noProps") return false;
                if (a == "-homelineSelfTest" || a == "-marvisWebTest") inTest = true;
                if (a == "-propsInTests") wantedInTests = true;
            }
            return !inTest || wantedInTests;
        }

        /// <summary>
        /// Places the props in the open scene and returns the layer, or null when the scene is not a Mars terrain
        /// scene. <paramref name="dontSave"/> keeps the objects out of the scene file (used by editor previews).
        /// </summary>
        public static MarsProps Build(bool dontSave)
        {
            try
            {
                if (Instance != null) DestroyNow(Instance.gameObject);
                Instance = null;
                if (Terrain.activeTerrains == null || Terrain.activeTerrains.Length == 0) return null;

                var go = new GameObject(RootName);
                if (dontSave) go.hideFlags = HideFlags.DontSave;
                MarsProps props = go.AddComponent<MarsProps>();
                Instance = props;
                props.PlaceAll();
                return props;
            }
            catch (Exception e)
            {
                // Scenery must never stop the app.
                Debug.LogWarning("[Props] not placed: " + e);
                return Instance;
            }
        }

        static void DestroyNow(GameObject go)
        {
            if (go == null) return;
            if (Application.isPlaying) Destroy(go); else DestroyImmediate(go);
        }

        void OnDestroy()
        {
            RestoreHiddenRocks();
            if (Instance == this) Instance = null;
        }

        void Update()
        {
            if (HomeBase.Version != homeVersion) PlaceHomeProps();
        }

        // ---- placement -------------------------------------------------------------------------------------------

        void PlaceAll()
        {
            ground = new Ground();
            rocks = RockInfo.Collect();
            PlaceHomeProps();
        }

        void PlaceHomeProps()
        {
            homeVersion = HomeBase.Version;
            RestoreHiddenRocks();
            for (int i = 0; i < homeProps.Count; i++)
            {
                if (homeProps[i] == null) continue;
                placed.RemoveAll(p => p.Transform == homeProps[i]);
                DestroyNow(homeProps[i].gameObject);
            }
            homeProps.Clear();
            if (ground == null) return;

            var home = new Vector2(HomeBase.Position.x, HomeBase.Position.z);
            if (!ground.TryHeight(home.x, home.y, out _, out _)) return;
            float away = BearingAwayFromStations(home);
            var taken = new List<Vector3>(); // x, z, radius of the props already standing at HOME

            for (int i = 0; i < HomeProps.Length; i++)
            {
                HomeProp def = HomeProps[i];
                GameObject model = Resources.Load<GameObject>(def.Resource);
                if (model == null) continue;

                PlacedProp prop = Spawn(def.Name, model);
                float halfLen = prop.SizeM.z * 0.5f, halfWid = prop.SizeM.x * 0.5f;
                float radius = Mathf.Sqrt(halfLen * halfLen + halfWid * halfWid);

                float bestCost = float.MaxValue;
                Vector3 bestPos = Vector3.zero;
                Quaternion bestRot = Quaternion.identity;
                Vector2 bestCentre = home;
                for (int ring = 0; ring < 3; ring++)
                {
                    float dist = def.GapM + radius + ring * 5f;
                    for (int k = 0; k < 9; k++)
                    {
                        float bearing = away + def.BearingOffsetDeg + (k % 2 == 0 ? 1 : -1) * ((k + 1) / 2) * 20f;
                        Vector2 centre = home + Dir(bearing) * dist;
                        if (Overlaps(taken, centre, radius + 2f)) continue;
                        float yaw = bearing + 180f; // front towards HOME
                        if (!TryPose(centre, yaw, halfLen, halfWid, out Vector3 p, out Quaternion r, out float slope, out bool detailed)) continue;
                        // An upright prop hardly cares about the slope under it: it stays where it was meant to stand.
                        float cost = slope * (def.Upright ? 0.1f : 1f) + (detailed ? 0f : 30f) + ring * 1.5f
                                     + ((k + 1) / 2) * 0.6f + RocksInside(centre, radius, 0.6f) * 6f;
                        if (cost < bestCost) { bestCost = cost; bestPos = p; bestRot = r; bestCentre = centre; }
                    }
                }

                if (bestCost == float.MaxValue)
                {
                    placed.Remove(prop);
                    DestroyNow(prop.Transform.gameObject);
                    Debug.Log("[Props] " + def.Name + " skipped: no ground for it near HOME");
                    continue;
                }

                // Upright things, and a slope the prop cannot follow: vertical rather than tilted with the hillside.
                if (def.Upright || Vector3.Angle(bestRot * Vector3.up, Vector3.up) > HomeMaxSlopeDeg)
                    bestRot = Quaternion.Euler(0f, bestRot.eulerAngles.y, 0f);
                // A wide upright thing rests on the lowest ground under it, so no corner hangs in the air.
                if (def.Upright && radius > 2f)
                    bestPos.y = LowestGround(bestCentre, bestRot.eulerAngles.y, halfLen, halfWid, bestPos.y) - SinkM;
                prop.Transform.SetPositionAndRotation(bestPos, bestRot);
                homeProps.Add(prop.Transform);
                taken.Add(new Vector3(bestCentre.x, bestCentre.y, radius));
                HideRocksUnder(bestCentre, radius * 0.9f);
                Report(prop, HomeBase.IsMissionPad ? "at the mission pad" : "at the scene spawn");
            }
        }

        /// <summary>Compass bearing from HOME that points away from the science stations, so the props stay off the route.</summary>
        float BearingAwayFromStations(Vector2 home)
        {
            MarsGeoReference geo = MarsGeoReference.Instance;
            if (geo == null) return 45f;
            Vector2 sum = Vector2.zero;
            for (int i = 0; i < Stations.Length; i++)
            {
                Vector3 w = geo.WorldXZ(Stations[i].Lat, Stations[i].Lon);
                Vector2 d = new Vector2(w.x, w.z) - home;
                if (d.sqrMagnitude > 1f) sum += d.normalized;
            }
            if (sum.sqrMagnitude < 0.01f) return 45f;
            return Mathf.Atan2(-sum.x, -sum.y) * Mathf.Rad2Deg;
        }

        // ---- helpers ---------------------------------------------------------------------------------------------

        /// <summary>Instantiates a model under a named holder whose origin is the model's ground-contact centre.</summary>
        PlacedProp Spawn(string name, GameObject model)
        {
            var holder = new GameObject(name);
            holder.hideFlags = gameObject.hideFlags;
            holder.transform.SetParent(transform, false);

            GameObject body = Instantiate(model, holder.transform);
            body.name = model.name;
            body.hideFlags = gameObject.hideFlags;
            body.transform.localPosition = Vector3.zero;
            body.transform.localRotation = Quaternion.identity;

            Bounds b = LocalBounds(holder.transform);
            body.transform.localPosition = new Vector3(-b.center.x, -b.min.y, -b.center.z);

            foreach (Renderer r in holder.GetComponentsInChildren<Renderer>(true))
            {
                r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
                r.receiveShadows = true;
            }

            // One box the crew cannot walk through.
            var box = holder.AddComponent<BoxCollider>();
            box.center = new Vector3(0f, b.size.y * 0.5f, 0f);
            box.size = new Vector3(b.size.x * 0.9f, b.size.y, b.size.z * 0.9f);

            var prop = new PlacedProp { Name = name, Transform = holder.transform, SizeM = b.size };
            placed.Add(prop);
            return prop;
        }

        /// <summary>Bounds of all meshes under <paramref name="root"/>, in the root's own space.</summary>
        static Bounds LocalBounds(Transform root)
        {
            bool any = false;
            var bounds = new Bounds(Vector3.zero, Vector3.zero);
            Matrix4x4 toRoot = root.worldToLocalMatrix;
            foreach (Renderer r in root.GetComponentsInChildren<Renderer>(true))
            {
                Bounds mb;
                if (r is SkinnedMeshRenderer skinned) mb = skinned.localBounds;
                else
                {
                    MeshFilter f = r.GetComponent<MeshFilter>();
                    if (f == null || f.sharedMesh == null) continue;
                    mb = f.sharedMesh.bounds;
                }
                Matrix4x4 m = toRoot * r.transform.localToWorldMatrix;
                for (int i = 0; i < 8; i++)
                {
                    var corner = new Vector3((i & 1) == 0 ? -1f : 1f, (i & 2) == 0 ? -1f : 1f, (i & 4) == 0 ? -1f : 1f);
                    Vector3 p = m.MultiplyPoint3x4(mb.center + Vector3.Scale(mb.extents, corner));
                    if (!any) { bounds = new Bounds(p, Vector3.zero); any = true; }
                    else bounds.Encapsulate(p);
                }
            }
            return bounds;
        }

        /// <summary>
        /// Position and rotation of a prop standing on the ground at <paramref name="centre"/>, following the slope
        /// under its footprint. False off every terrain.
        /// </summary>
        bool TryPose(Vector2 centre, float yawDeg, float halfLen, float halfWid, out Vector3 pos, out Quaternion rot, out float slopeDeg, out bool detailed)
        {
            pos = Vector3.zero;
            rot = Quaternion.identity;
            slopeDeg = 0f;
            Vector2 f = Dir(yawDeg), r = Dir(yawDeg + 90f);
            detailed = true;
            if (!Sample(centre + f * halfLen, out Vector3 front, ref detailed) ||
                !Sample(centre - f * halfLen, out Vector3 back, ref detailed) ||
                !Sample(centre + r * halfWid, out Vector3 right, ref detailed) ||
                !Sample(centre - r * halfWid, out Vector3 left, ref detailed)) return false;

            Vector3 forward = (front - back).normalized;
            Vector3 up = Vector3.Cross(forward, (right - left).normalized).normalized;
            if (up.y < 0f) up = -up;
            rot = Quaternion.LookRotation(forward, up);
            slopeDeg = Vector3.Angle(up, Vector3.up);
            pos = new Vector3(centre.x, (front.y + back.y + right.y + left.y) * 0.25f - SinkM, centre.y);
            return true;
        }

        /// <summary>The lowest ground height under a footprint (corners, edge midpoints and centre).</summary>
        float LowestGround(Vector2 centre, float yawDeg, float halfLen, float halfWid, float fallback)
        {
            Vector2 f = Dir(yawDeg) * halfLen, r = Dir(yawDeg + 90f) * halfWid;
            float lowest = float.MaxValue;
            for (int i = -1; i <= 1; i++)
                for (int k = -1; k <= 1; k++)
                {
                    Vector2 p = centre + f * i + r * k;
                    if (ground.TryHeight(p.x, p.y, out float y, out _)) lowest = Mathf.Min(lowest, y);
                }
            return lowest == float.MaxValue ? fallback : lowest;
        }

        bool Sample(Vector2 xz, out Vector3 point, ref bool detailed)
        {
            bool ok = ground.TryHeight(xz.x, xz.y, out float y, out bool fine);
            if (!fine) detailed = false;
            point = new Vector3(xz.x, y, xz.y);
            return ok;
        }

        int RocksInside(Vector2 centre, float radius, float minHeight)
        {
            int n = 0;
            for (int i = 0; i < rocks.Length; i++)
                if (rocks[i].Height >= minHeight && (rocks[i].Xz - centre).magnitude < radius + rocks[i].Radius) n++;
            return n;
        }

        static bool Overlaps(List<Vector3> taken, Vector2 centre, float radius)
        {
            for (int i = 0; i < taken.Count; i++)
                if ((new Vector2(taken[i].x, taken[i].y) - centre).magnitude < taken[i].z + radius) return true;
            return false;
        }

        /// <summary>Rocks under a HOME prop are switched off while it stands there (the pad was cleared).</summary>
        void HideRocksUnder(Vector2 centre, float radius)
        {
            for (int i = 0; i < rocks.Length; i++)
            {
                RockInfo rock = rocks[i];
                if (rock.Sample == null || (rock.Xz - centre).magnitude > radius) continue;
                GameObject go = rock.Sample.gameObject;
                if (!go.activeSelf) continue;
                go.SetActive(false);
                hiddenRocks.Add(go);
            }
        }

        void RestoreHiddenRocks()
        {
            for (int i = 0; i < hiddenRocks.Count; i++)
                if (hiddenRocks[i] != null) hiddenRocks[i].SetActive(true);
            hiddenRocks.Clear();
        }

        /// <summary>Unit vector on the ground for a compass bearing: x = east, y = north.</summary>
        static Vector2 Dir(float bearingDeg)
        {
            float a = bearingDeg * Mathf.Deg2Rad;
            return new Vector2(Mathf.Sin(a), Mathf.Cos(a));
        }

        static void Report(PlacedProp p, string note)
        {
            Vector3 pos = p.Position;
            Debug.Log(string.Format(CultureInfo.InvariantCulture,
                "[Props] {0} pos=({1:0.0}, {2:0.0}, {3:0.0}) yaw={4:0} size=({5:0.0} x {6:0.0} x {7:0.0} m) {8}",
                p.Name, pos.x, pos.y, pos.z, p.YawDeg, p.SizeM.x, p.SizeM.y, p.SizeM.z, note));
        }

        // ---- scene data ------------------------------------------------------------------------------------------

        /// <summary>A rock of the scene, reduced to what placement needs.</summary>
        struct RockInfo
        {
            public RockSample Sample;
            public string FieldId;
            public Vector2 Xz;
            public float Radius, Height;

            public static RockInfo[] Collect()
            {
                RockSample[] samples = FindObjectsByType<RockSample>(FindObjectsInactive.Exclude);
                var list = new RockInfo[samples.Length];
                for (int i = 0; i < samples.Length; i++)
                {
                    RockSample s = samples[i];
                    Vector3 p = s.transform.position;
                    float radius, height;
                    Renderer r = s.GetComponentInChildren<Renderer>();
                    if (r != null)
                    {
                        Bounds b = r.bounds;
                        p = b.center;
                        radius = Mathf.Max(b.extents.x, b.extents.z);
                        height = b.size.y;
                    }
                    else
                    {
                        Vector3 size = s.SizeM;
                        radius = Mathf.Max(size.x, size.z) * 0.5f;
                        height = size.y;
                    }
                    list[i] = new RockInfo
                    {
                        Sample = s, FieldId = s.FieldId,
                        Xz = new Vector2(p.x, p.z), Radius = radius, Height = height,
                    };
                }
                return list;
            }
        }

        /// <summary>Ground height from the scene's terrains: the finest terrain covering a point wins.</summary>
        sealed class Ground
        {
            struct Patch
            {
                public Terrain Terrain;
                public float MinX, MinZ, MaxX, MaxZ, PostSpacing;
            }

            readonly Patch[] patches;

            public Ground()
            {
                Terrain[] terrains = Terrain.activeTerrains;
                var list = new List<Patch>();
                for (int i = 0; i < terrains.Length; i++)
                {
                    Terrain t = terrains[i];
                    if (t == null || t.terrainData == null) continue;
                    Vector3 origin = t.GetPosition();
                    Vector3 size = t.terrainData.size;
                    int posts = Mathf.Max(2, t.terrainData.heightmapResolution);
                    list.Add(new Patch
                    {
                        Terrain = t,
                        MinX = origin.x,
                        MinZ = origin.z,
                        MaxX = origin.x + size.x,
                        MaxZ = origin.z + size.z,
                        PostSpacing = size.x / (posts - 1),
                    });
                }
                list.Sort((a, b) => a.PostSpacing.CompareTo(b.PostSpacing));
                patches = list.ToArray();
            }

            /// <summary>Ground height at world X/Z; <paramref name="detailed"/> is true on the finest terrain.</summary>
            public bool TryHeight(float x, float z, out float y, out bool detailed)
            {
                for (int i = 0; i < patches.Length; i++)
                {
                    Patch p = patches[i];
                    if (p.Terrain == null || x < p.MinX || x > p.MaxX || z < p.MinZ || z > p.MaxZ) continue;
                    y = p.Terrain.SampleHeight(new Vector3(x, 0f, z)) + p.Terrain.GetPosition().y;
                    detailed = i == 0;
                    return true;
                }
                y = 0f;
                detailed = false;
                return false;
            }
        }
    }
}

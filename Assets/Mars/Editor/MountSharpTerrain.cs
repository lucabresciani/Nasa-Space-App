using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Scene side of the real Mount Sharp terrain: the play and backdrop Terrains, boulders (real HiRISE boulders plus
    /// procedural pebbles), player placement, and Tools > Mars > Apply Mount Sharp Terrain (Open Scene), which swaps
    /// the terrain of the open scene without rebuilding anything else.
    /// </summary>
    static class MountSharpTerrain
    {
        public const string PlayName = "Mars Terrain", BackdropName = "Mars Backdrop";
        const string Root = "Assets/Mars/Generated";
        const int TextureSize = 1024;           // same as MarsSceneBuilder
        const float CameraFarClip = 150000f;    // the summit of Mount Sharp is ~48 km away
        const float RespawnBelowY = -1000f;     // play area spans about -60..+450 m around the spawn

        // ------------------------------------------------------------------ terrains

        /// <summary>Creates "Mars Terrain" (play, with <see cref="MarsGeoReference"/>) then "Mars Backdrop"; returns the play terrain.</summary>
        public static Terrain CreateTerrains(Transform environment, MarsTerrain.Result r, Material material)
        {
            // Pixel error 1: keep the 1 m DEM's full vertical detail (1-2 m boxwork ridges) instead of letting LOD flatten it.
            Terrain play = CreateTerrain(environment, PlayName, r.play, r.playPosition, material, 1f, 600f);
            MarsTerrain.Info i = r.info;
            play.gameObject.AddComponent<MarsGeoReference>()
                .Configure(i.spawn.elevation, i.planetRadius, i.play.swLat, i.play.swLon, i.metersPerDegree, i.eastScale, r.playSwWorld);

            Terrain backdrop = CreateTerrain(environment, BackdropName, r.backdrop, r.backdropPosition, material, 8f, 3000f);
            backdrop.allowAutoConnect = false; // different size: never stitch it to the play terrain
            backdrop.groupingID = 1;
            return play;
        }

        static Terrain CreateTerrain(Transform parent, string name, TerrainData data, Vector3 position, Material material, float pixelError, float basemapDistance)
        {
            GameObject go = Terrain.CreateTerrainGameObject(data);
            go.name = name;
            go.transform.SetParent(parent, false);
            go.transform.position = position;
            var terrain = go.GetComponent<Terrain>();
            terrain.materialTemplate = material;
            terrain.heightmapPixelError = pixelError;
            terrain.basemapDistance = basemapDistance;
            terrain.drawInstanced = true;
            terrain.drawTreesAndFoliage = false;
            terrain.shadowCastingMode = ShadowCastingMode.On;
            return terrain;
        }

        // ------------------------------------------------------------------ rocks

        /// <summary>
        /// Real boulders from the HiRISE map, plus small procedural rocks around the spawn (none on dark sand).
        /// Without a boulder map, procedural big rocks stand in for them.
        /// </summary>
        public static int ScatterRocks(Terrain terrain, MarsTerrain.Result r, Mesh[] meshes, Material[] mats, Transform parent, int seed)
        {
            var rng = new System.Random(seed + 42);
            float R() => (float)rng.NextDouble();
            Vector2 InDisc(float radius)
            {
                float a = R() * Mathf.PI * 2f, d = Mathf.Sqrt(R()) * radius;
                return new Vector2(Mathf.Cos(a) * d, Mathf.Sin(a) * d);
            }

            TerrainData data = terrain.terrainData;
            Vector3 origin = terrain.transform.position;
            Rect area = r.PlayRectWorld;
            int count = 0;

            bool Inside(Vector2 p, float margin) =>
                p.x > area.xMin + margin && p.x < area.xMax - margin && p.y > area.yMin + margin && p.y < area.yMax - margin;

            void Make(Vector2 p, Mesh mesh, Vector3 scale, float bury, float cull, bool collider)
            {
                Bounds b = mesh.bounds;
                var world = new Vector3(p.x, 0f, p.y);
                float ground = terrain.SampleHeight(world) + origin.y;
                Vector3 normal = data.GetInterpolatedNormal((p.x - origin.x) / data.size.x, (p.y - origin.z) / data.size.z);
                Quaternion rot = Quaternion.FromToRotation(Vector3.up, Vector3.Slerp(Vector3.up, normal, 0.7f))
                               * Quaternion.Euler(Mathf.Lerp(-10f, 10f, R()), R() * 360f, Mathf.Lerp(-10f, 10f, R()));
                world.y = ground - b.min.y * scale.y - b.size.y * scale.y * bury;

                var go = new GameObject("Rock");
                go.transform.SetParent(parent, false);
                go.transform.SetPositionAndRotation(world, rot);
                go.transform.localScale = scale;
                go.AddComponent<MeshFilter>().sharedMesh = mesh;
                var renderer = go.AddComponent<MeshRenderer>();
                renderer.sharedMaterial = mats[rng.Next(mats.Length)];
                if (collider) go.AddComponent<MeshCollider>().sharedMesh = mesh;

                var lod = go.AddComponent<LODGroup>();
                lod.SetLODs(new[] { new LOD(cull, new Renderer[] { renderer }) });
                lod.RecalculateBounds();
                count++;
            }

            void Place(Vector2 p, float size, float bury)
            {
                if (!Inside(p, 20f) || p.magnitude < size + 2.5f) return; // keep the spawn point clear
                if (r.DarkSandWeight(p) > 0.5f) return;                   // loose rocks sink out of sight in Bagnold sand
                Mesh mesh = meshes[rng.Next(meshes.Length)];
                var scale = new Vector3(size * Mathf.Lerp(0.85f, 1.15f, R()), size * Mathf.Lerp(0.8f, 1.2f, R()), size * Mathf.Lerp(0.85f, 1.15f, R()));
                // Only rocks you could actually stub a toe on get colliders; small ones cull once a few pixels tall.
                bool collider = mesh.bounds.size.y * scale.y * (1f - bury) > 0.3f;
                Make(p, mesh, scale, bury, size < 0.5f ? 0.015f : size < 2f ? 0.006f : 0.002f, collider);
            }

            // Real boulders, measured on HiRISE: diameter and height in metres.
            foreach (MarsTerrain.RealRock rock in r.rocks)
            {
                float d = Mathf.Max(0.2f, rock.diameter);
                float h = rock.height > 0f ? rock.height : d * 0.6f;
                if (!Inside(rock.position, 0.5f) || rock.position.magnitude < d + 2.5f) continue;
                Mesh mesh = meshes[rng.Next(meshes.Length)];
                Vector3 bs = mesh.bounds.size;
                Make(rock.position, mesh, new Vector3(d / bs.x, h / bs.y, d / bs.z), 0.15f, 0.002f, true);
            }

            // Pebble clusters and loose rocks near the spawn.
            for (int i = 0; i < 220; i++) Place(InDisc(45f), Mathf.Lerp(0.08f, 0.45f, R() * R()), 0.3f);
            for (int c = 0; c < 50; c++)
            {
                Vector2 center = InDisc(220f);
                int n = 5 + rng.Next(12);
                for (int k = 0; k < n; k++) Place(center + InDisc(7f), Mathf.Lerp(0.12f, 0.5f, R() * R()), 0.3f);
            }
            for (int i = 0; i < 350; i++) Place(InDisc(300f), Mathf.Lerp(0.15f, 0.7f, R() * R()), 0.25f);
            if (r.rocks.Count == 0)
            {
                // No boulder map: bigger procedural stuff further out.
                for (int i = 0; i < 220; i++) Place(InDisc(550f), Mathf.Lerp(0.7f, 1.8f, Mathf.Pow(R(), 1.5f)), 0.25f);
                for (int i = 0; i < 45; i++) Place(InDisc(650f), Mathf.Lerp(2f, 5.5f, Mathf.Pow(R(), 1.5f)), 0.3f);
            }

            // Ejecta blocks thrown out around the larger craters.
            foreach (MarsTerrain.Crater crater in r.craters)
            {
                if (crater.radius < 15f || crater.center.magnitude > 600f) continue;
                int n = Mathf.RoundToInt(crater.radius * 0.35f);
                for (int k = 0; k < n; k++)
                {
                    float a = R() * Mathf.PI * 2f, d = crater.radius * Mathf.Lerp(0.95f, 1.9f, R());
                    Vector2 p = crater.center + new Vector2(Mathf.Cos(a), Mathf.Sin(a)) * d;
                    Place(p, Mathf.Lerp(0.3f, Mathf.Min(2.5f, crater.radius * 0.05f), R() * R()), 0.3f);
                }
            }
            return count;
        }

        // ------------------------------------------------------------------ player and weather

        /// <summary>Puts the player on the ground at the spawn (world origin), facing Mount Sharp; long camera range.</summary>
        public static void PlacePlayer(GameObject player, Terrain terrain, MarsTerrain.Result r)
        {
            float groundY = terrain.SampleHeight(Vector3.zero) + terrain.transform.position.y;
            player.transform.SetPositionAndRotation(new Vector3(0f, groundY + 0.05f, 0f), Quaternion.Euler(0f, r.spawnYaw, 0f));

            Camera cam = player.GetComponentInChildren<Camera>(true);
            if (cam != null) cam.farClipPlane = CameraFarClip;

            var fps = player.GetComponent<FirstPersonController>();
            if (fps == null) return;
            var so = new SerializedObject(fps);
            void Set(string name, float value)
            {
                SerializedProperty p = so.FindProperty(name);
                if (p != null) p.floatValue = value;
            }
            Set("respawnBelowY", RespawnBelowY);
            // HOMELINE spec F3: suited walking 0.98 m/s, slope-governed, no-go above 20°. Scenes built earlier still
            // hold the old arcade values (4 / 8 m/s, 1.5 m jump), so overwrite them here.
            Set("walkSpeed", FirstPersonController.SpecWalkSpeed);
            Set("sprintSpeed", FirstPersonController.SpecBriskSpeed);
            Set("acceleration", 6f);
            Set("jumpHeight", 0.3f);
            Set("noGoSlope", 20f);
            so.ApplyModifiedPropertiesWithoutUndo();
        }

        /// <summary>Points every DustDevilField's 'terrain' at the play terrain (looked up by type name). Returns how many.</summary>
        public static int PointDustDevilsAt(Terrain terrain)
        {
            int n = 0;
            foreach (MonoBehaviour behaviour in Object.FindObjectsByType<MonoBehaviour>(FindObjectsInactive.Include))
            {
                if (behaviour == null || behaviour.GetType().Name != "DustDevilField") continue;
                var so = new SerializedObject(behaviour);
                SerializedProperty field = so.FindProperty("terrain");
                if (field == null) continue;
                field.objectReferenceValue = terrain;
                so.ApplyModifiedPropertiesWithoutUndo();
                n++;
            }
            return n;
        }

        /// <summary>
        /// Clear-weather fog baseline that keeps the summit (~48 km) visible. DayNightCycle (weather session) owns the
        /// value and rewrites RenderSettings every frame; scenes built before it changed still hold 0.0009.
        /// </summary>
        static void SetClearFog()
        {
            foreach (MonoBehaviour behaviour in Object.FindObjectsByType<MonoBehaviour>(FindObjectsInactive.Include))
            {
                if (behaviour == null || behaviour.GetType().Name != "DayNightCycle") continue;
                var so = new SerializedObject(behaviour);
                SerializedProperty fog = so.FindProperty("fogDensity");
                if (fog == null) continue;
                fog.floatValue = 0.000021f;
                so.ApplyModifiedPropertiesWithoutUndo();
            }
        }

        // ------------------------------------------------------------------ menu

        [MenuItem("Tools/Mars/Apply Mount Sharp Terrain (Open Scene)")]
        static void ApplyToOpenScene()
        {
            if (!File.Exists(Path.GetFullPath(MarsTerrain.JsonPath)))
            {
                Debug.LogError($"[Mars] {MarsTerrain.JsonPath} not found: copy the Mount Sharp data (MountSharp.json, *.r16.gz, *_splat.png, *.csv) into {MarsTerrain.DataFolder} first.");
                return;
            }
            Scene scene = SceneManager.GetActiveScene();
            try
            {
                string texFolder = EnsureFolder($"{Root}/Textures");
                string matFolder = EnsureFolder($"{Root}/Materials");
                string rockFolder = EnsureFolder($"{Root}/Rocks");
                string terrainFolder = EnsureFolder($"{Root}/Terrain");

                EditorUtility.DisplayProgressBar("Mars", "Baking terrain layers…", 0.05f);
                TerrainLayer[] layers = MarsTextures.CreateTerrainLayers(texFolder, TextureSize, MarsSceneBuilder.Seed);
                MarsTerrain.Result result = MarsTerrain.Generate(terrainFolder, layers);

                EditorUtility.DisplayProgressBar("Mars", "Replacing terrains…", 0.7f);
                Transform environment = FindOrCreateRoot(scene, "Environment");
                foreach (string name in new[] { PlayName, BackdropName })
                {
                    Transform old;
                    while ((old = environment.Find(name)) != null) Object.DestroyImmediate(old.gameObject);
                }
                Terrain play = CreateTerrains(environment, result, MarsSceneBuilder.CreateTerrainMaterial(matFolder));

                EditorUtility.DisplayProgressBar("Mars", "Placing boulders…", 0.8f);
                Transform rocks = environment.Find("Rocks");
                if (rocks == null)
                {
                    rocks = new GameObject("Rocks").transform;
                    rocks.SetParent(environment, false);
                }
                for (int i = rocks.childCount - 1; i >= 0; i--) Object.DestroyImmediate(rocks.GetChild(i).gameObject);
                Mesh[] meshes = LoadNumbered<Mesh>(rockFolder, "MarsRock_", ".asset", 6)
                                ?? MarsSceneBuilder.CreateRockMeshes(rockFolder, 6);
                Material[] mats = LoadNumbered<Material>(matFolder, "MarsRock_", ".mat", 3)
                                  ?? MarsSceneBuilder.CreateRockMaterials(matFolder, MarsTextures.CreateRockTextures(texFolder, TextureSize, MarsSceneBuilder.Seed));
                int rockCount = ScatterRocks(play, result, meshes, mats, rocks, MarsSceneBuilder.Seed);
                MarsRockScience.Result science = MarsRockScience.Apply(rocks, result.craters, MarsSceneBuilder.Seed, undo: false);

                GameObject player = GameObject.FindWithTag("Player");
                if (player != null) PlacePlayer(player, play, result);
                else
                {
                    Debug.LogWarning("[Mars] No object tagged Player in the open scene: player not moved.");
                    if (Camera.main != null) Camera.main.farClipPlane = CameraFarClip;
                }
                int devils = PointDustDevilsAt(play);
                SetClearFog();

                EditorSceneManager.MarkSceneDirty(scene);
                AssetDatabase.SaveAssets();
                Debug.Log($"[Mars] Applied to '{scene.name}' (scene not saved): {result.Describe()}; {rockCount} rocks placed, {devils} dust devil field(s) re-pointed.");
                Debug.Log(MarsRockScience.Describe(science));
            }
            catch (IOException e)
            {
                Debug.LogError(e.Message);
            }
            catch (InvalidDataException e)
            {
                Debug.LogError(e.Message);
            }
            finally
            {
                EditorUtility.ClearProgressBar();
            }
        }

        // ------------------------------------------------------------------ helpers

        static Transform FindOrCreateRoot(Scene scene, string name)
        {
            foreach (GameObject go in scene.GetRootGameObjects())
                if (go.name == name) return go.transform;
            var created = new GameObject(name);
            SceneManager.MoveGameObjectToScene(created, scene);
            return created.transform;
        }

        /// <summary>Loads {folder}/{prefix}0..count-1{ext}; null if any is missing.</summary>
        static T[] LoadNumbered<T>(string folder, string prefix, string ext, int count) where T : Object
        {
            var items = new T[count];
            for (int i = 0; i < count; i++)
                if ((items[i] = AssetDatabase.LoadAssetAtPath<T>($"{folder}/{prefix}{i}{ext}")) == null) return null;
            return items;
        }

        static string EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return path;
            int slash = path.LastIndexOf('/');
            string parent = EnsureFolder(path.Substring(0, slash));
            AssetDatabase.CreateFolder(parent, path.Substring(slash + 1));
            return path;
        }
    }
}

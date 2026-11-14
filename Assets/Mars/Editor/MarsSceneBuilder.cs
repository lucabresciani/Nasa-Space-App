using System.Collections.Generic;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem.UI;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Tools > Mars > Build Mars Landscape Scene.
    /// Generates every asset under Assets/Mars/Generated and (re)creates Assets/Scenes/MarsLandscape.unity
    /// with terrain, boulders, sky, lighting, post-processing, an FPS player and an EventSystem ready for UI.
    /// Deterministic for a given seed; re-running updates the generated assets in place.
    /// </summary>
    public static class MarsSceneBuilder
    {
        public const string ScenePath = "Assets/Scenes/MarsLandscape.unity";
        const string Root = "Assets/Mars/Generated";
        internal const int Seed = 1977;
        const int TextureSize = 1024;

        // Starting values only: once in the scene, DayNightCycle drives the sun, fog and ambient light.
        static readonly Color Horizon = new Color(0.74f, 0.55f, 0.41f); // also the fog colour
        static readonly Quaternion SunRotation = Quaternion.Euler(32f, 110f, 0f); // low sun from the left

        [MenuItem("Tools/Mars/Build Mars Landscape Scene")]
        static void BuildFromMenu()
        {
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            Build();
        }

        public static void Build()
        {
            try
            {
                string texFolder = EnsureFolder($"{Root}/Textures");
                string matFolder = EnsureFolder($"{Root}/Materials");
                string rockFolder = EnsureFolder($"{Root}/Rocks");
                string terrainFolder = EnsureFolder($"{Root}/Terrain");
                string settingsFolder = EnsureFolder($"{Root}/Settings");

                Progress("Baking surface textures…", 0.05f);
                TerrainLayer[] layers = MarsTextures.CreateTerrainLayers(texFolder, TextureSize, Seed);
                MarsTextures.TextureSet boulderTex = MarsTextures.CreateRockTextures(texFolder, TextureSize, Seed);
                Texture2D softDot = MarsTextures.CreateSoftDot(texFolder, 64);
                Material sky = MarsTextures.CreateSkyMaterial(texFolder);

                Progress("Generating terrain…", 0.25f);
                MarsTerrain.Result terrainResult = MarsTerrain.Generate($"{terrainFolder}/MarsTerrainData.asset", layers, Seed);

                Progress("Carving boulders…", 0.65f);
                Mesh[] rockMeshes = CreateRockMeshes(rockFolder, 6);
                Material[] rockMats = CreateRockMaterials(matFolder, boulderTex);
                Material terrainMat = CreateTerrainMaterial(matFolder);
                Material dustMat = CreateDustMaterial(matFolder, softDot);
                VolumeProfile profile = CreateVolumeProfile($"{settingsFolder}/MarsPostProcessing.asset");
                LightingSettings lighting = CreateLightingSettings($"{settingsFolder}/MarsLighting.lighting");

                Progress("Assembling scene…", 0.8f);
                var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                Lightmapping.lightingSettings = lighting;

                var environment = new GameObject("Environment").transform;
                Light sun = CreateSun(environment);
                ConfigureRenderSettings(sky, sun);
                Terrain terrain = CreateTerrain(environment, terrainResult, terrainMat);
                var rocks = new GameObject("Rocks").transform;
                rocks.SetParent(environment, false);
                int rockCount = ScatterRocks(terrain, terrainResult.craters, rockMeshes, rockMats, rocks);
                MarsRockScience.Result science = MarsRockScience.Apply(rocks, terrainResult.craters, Seed, undo: false);
                CreateVolume(environment, profile);

                GameObject player = CreatePlayer(terrain, dustMat);
                MarsRockScience.SetupScanner(player, undo: false);
                CreateDayNightCycle(sun, player);
                CreateWeather(environment, player);
                CreateEventSystem();

                EditorSceneManager.SaveScene(scene, ScenePath);
                // GI is off, so this only bakes the environment reflection from the Mars sky (~2 s).
                // Without it, every surface reflects Unity's default blue sky.
                Progress("Baking sky reflection…", 0.95f);
                Lightmapping.Bake();
                EditorSceneManager.SaveScene(scene);
                AddToBuildSettings(ScenePath);
                AssetDatabase.SaveAssets();

                Selection.activeGameObject = player;
                SceneView.lastActiveSceneView?.AlignViewToObject(player.GetComponentInChildren<Camera>().transform);
                Debug.Log($"[Mars] Built {ScenePath}: 2 km terrain, {terrainResult.craters.Count} craters, {rockCount} rocks. Press Play to walk around; N skips to the next time of day.");
                Debug.Log(MarsRockScience.Describe(science));
            }
            finally
            {
                EditorUtility.ClearProgressBar();
            }
        }

        // ------------------------------------------------------------------ assets

        static Mesh[] CreateRockMeshes(string folder, int count)
        {
            var meshes = new Mesh[count];
            for (int i = 0; i < count; i++)
            {
                Mesh generated = MarsRocks.Build(Seed + i * 7919);
                string path = $"{folder}/MarsRock_{i}.asset";
                var existing = AssetDatabase.LoadAssetAtPath<Mesh>(path);
                if (existing == null)
                {
                    AssetDatabase.CreateAsset(generated, path);
                    meshes[i] = generated;
                }
                else
                {
                    EditorUtility.CopySerialized(generated, existing);
                    Object.DestroyImmediate(generated);
                    meshes[i] = existing;
                }
            }
            return meshes;
        }

        static Material[] CreateRockMaterials(string folder, MarsTextures.TextureSet tex)
        {
            Color[] tints = { Color.white, new Color(0.82f, 0.76f, 0.74f), new Color(1f, 0.93f, 0.86f) };
            var mats = new Material[tints.Length];
            for (int i = 0; i < tints.Length; i++)
            {
                var mat = MarsTextures.LoadOrCreateMaterial($"{folder}/MarsRock_{i}.mat", "Universal Render Pipeline/Lit");
                mat.SetTexture("_BaseMap", tex.albedo);
                mat.SetColor("_BaseColor", tints[i]);
                mat.SetTexture("_BumpMap", tex.normal);
                mat.SetFloat("_BumpScale", 1f);
                mat.EnableKeyword("_NORMALMAP");
                mat.SetTexture("_OcclusionMap", tex.mask); // mask G channel = occlusion
                mat.SetFloat("_OcclusionStrength", 1f);
                mat.EnableKeyword("_OCCLUSIONMAP");
                mat.SetFloat("_Metallic", 0f);
                mat.SetFloat("_Smoothness", 0.22f);
                mat.enableInstancing = true;
                EditorUtility.SetDirty(mat);
                mats[i] = mat;
            }
            return mats;
        }

        static Material CreateTerrainMaterial(string folder)
        {
            var mat = MarsTextures.LoadOrCreateMaterial($"{folder}/MarsTerrain.mat", "Universal Render Pipeline/Terrain/Lit");
            // Same keywords TerrainLitShaderGUI.SetupMaterialKeywords would set from the inspector.
            mat.SetFloat("_EnableHeightBlend", 1f);
            mat.SetFloat("_HeightTransition", 0.25f);
            mat.EnableKeyword("_TERRAIN_BLEND_HEIGHT");
            mat.SetFloat("_EnableInstancedPerPixelNormal", 1f);
            mat.EnableKeyword("_TERRAIN_INSTANCED_PERPIXEL_NORMAL");
            EditorUtility.SetDirty(mat);
            return mat;
        }

        static Material CreateDustMaterial(string folder, Texture2D softDot)
        {
            string path = $"{folder}/MarsDust.mat";
            Material template = GraphicsSettings.currentRenderPipeline != null
                ? GraphicsSettings.currentRenderPipeline.defaultParticleMaterial
                : null;
            Material mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (template != null)
            {
                if (mat == null)
                {
                    mat = new Material(template);
                    AssetDatabase.CreateAsset(mat, path);
                }
                else
                {
                    EditorUtility.CopySerialized(template, mat);
                }
            }
            else
            {
                // Fallback: configure URP's unlit particle shader as alpha-blended by hand.
                mat = MarsTextures.LoadOrCreateMaterial(path, "Universal Render Pipeline/Particles/Unlit");
                mat.SetFloat("_Surface", 1f);
                mat.SetFloat("_Blend", 0f);
                mat.SetFloat("_SrcBlend", (float)BlendMode.SrcAlpha);
                mat.SetFloat("_DstBlend", (float)BlendMode.OneMinusSrcAlpha);
                mat.SetFloat("_ZWrite", 0f);
                mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                mat.renderQueue = (int)RenderQueue.Transparent;
            }
            mat.name = "MarsDust";
            mat.SetTexture("_BaseMap", softDot);
            mat.SetColor("_BaseColor", Color.white);
            EditorUtility.SetDirty(mat);
            return mat;
        }

        static VolumeProfile CreateVolumeProfile(string path)
        {
            var profile = AssetDatabase.LoadAssetAtPath<VolumeProfile>(path);
            if (profile == null)
            {
                profile = ScriptableObject.CreateInstance<VolumeProfile>();
                AssetDatabase.CreateAsset(profile, path);
            }

            // Neutral rather than ACES: ACES bleaches sunlit orange slopes toward white ("snowy" mountains).
            Component<Tonemapping>(profile).mode.Override(TonemappingMode.Neutral);

            var color = Component<ColorAdjustments>(profile);
            color.postExposure.Override(0.25f);
            color.contrast.Override(14f);
            color.saturation.Override(4f);

            var bloom = Component<Bloom>(profile);
            bloom.intensity.Override(0.3f);
            bloom.threshold.Override(1f);
            bloom.scatter.Override(0.65f);

            var vignette = Component<Vignette>(profile);
            vignette.intensity.Override(0.2f);
            vignette.smoothness.Override(0.4f);

            Component<WhiteBalance>(profile).temperature.Override(5f);

            EditorUtility.SetDirty(profile);
            return profile;
        }

        static T Component<T>(VolumeProfile profile) where T : VolumeComponent
        {
            if (!profile.TryGet(out T component))
            {
                component = profile.Add<T>();
                component.hideFlags = HideFlags.HideInInspector | HideFlags.HideInHierarchy;
                AssetDatabase.AddObjectToAsset(component, profile);
            }
            component.active = true;
            EditorUtility.SetDirty(component);
            return component;
        }

        static LightingSettings CreateLightingSettings(string path)
        {
            var settings = AssetDatabase.LoadAssetAtPath<LightingSettings>(path);
            if (settings == null)
            {
                settings = new LightingSettings { name = "MarsLighting" };
                AssetDatabase.CreateAsset(settings, path);
            }
            // Everything is realtime: nothing to bake, and no accidental 2 km lightmap bakes.
            settings.bakedGI = false;
            settings.realtimeGI = false;
            EditorUtility.SetDirty(settings);
            return settings;
        }

        // ------------------------------------------------------------------ scene objects

        static Light CreateSun(Transform parent)
        {
            var go = new GameObject("Sun");
            go.transform.SetParent(parent, false);
            go.transform.rotation = SunRotation;
            var light = go.AddComponent<Light>();
            light.type = LightType.Directional;
            light.color = new Color(1f, 0.92f, 0.80f);
            light.intensity = 1.5f;
            light.shadows = LightShadows.Soft;
            light.shadowStrength = 0.92f;
            return light;
        }

        static void ConfigureRenderSettings(Material sky, Light sun)
        {
            RenderSettings.skybox = sky;
            RenderSettings.sun = sun;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.52f, 0.42f, 0.36f);
            RenderSettings.ambientEquatorColor = new Color(0.46f, 0.36f, 0.29f);
            RenderSettings.ambientGroundColor = new Color(0.20f, 0.13f, 0.09f);
            RenderSettings.defaultReflectionMode = DefaultReflectionMode.Skybox;
            // Dusty haze; colour matches the sky's horizon so distant terrain melts into it.
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            RenderSettings.fogDensity = 0.0009f;
            RenderSettings.fogColor = Horizon;
        }

        static Terrain CreateTerrain(Transform parent, MarsTerrain.Result result, Material material)
        {
            GameObject go = Terrain.CreateTerrainGameObject(result.data);
            go.name = "Mars Terrain";
            go.transform.SetParent(parent, false);
            go.transform.position = new Vector3(-MarsTerrain.Size * 0.5f, result.minHeight, -MarsTerrain.Size * 0.5f);
            var terrain = go.GetComponent<Terrain>();
            terrain.materialTemplate = material;
            terrain.heightmapPixelError = 3f;
            terrain.basemapDistance = 600f;
            terrain.drawInstanced = true;
            terrain.drawTreesAndFoliage = false;
            terrain.shadowCastingMode = ShadowCastingMode.On;
            return terrain;
        }

        static int ScatterRocks(Terrain terrain, List<MarsTerrain.Crater> craters, Mesh[] meshes, Material[] mats, Transform parent)
        {
            var rng = new System.Random(Seed + 42);
            float R() => (float)rng.NextDouble();
            Vector2 InDisc(float radius)
            {
                float a = R() * Mathf.PI * 2f, d = Mathf.Sqrt(R()) * radius;
                return new Vector2(Mathf.Cos(a) * d, Mathf.Sin(a) * d);
            }

            TerrainData data = terrain.terrainData;
            Vector3 origin = terrain.transform.position;
            float limit = MarsTerrain.Size * 0.5f - 20f;
            int count = 0;

            void Place(Vector2 p, float size, float bury)
            {
                if (Mathf.Abs(p.x) > limit || Mathf.Abs(p.y) > limit) return;
                if (p.magnitude < size + 2.5f) return; // keep the spawn point clear

                Mesh mesh = meshes[rng.Next(meshes.Length)];
                Bounds b = mesh.bounds;
                var scale = new Vector3(size * Mathf.Lerp(0.85f, 1.15f, R()), size * Mathf.Lerp(0.8f, 1.2f, R()), size * Mathf.Lerp(0.85f, 1.15f, R()));

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

                // Only rocks you could actually stub a toe on get colliders.
                if (b.size.y * scale.y * (1f - bury) > 0.3f) go.AddComponent<MeshCollider>().sharedMesh = mesh;

                // Cull small rocks once they are a few pixels tall.
                float cull = size < 0.5f ? 0.015f : size < 2f ? 0.006f : 0.002f;
                var lod = go.AddComponent<LODGroup>();
                lod.SetLODs(new[] { new LOD(cull, new Renderer[] { renderer }) });
                lod.RecalculateBounds();
                count++;
            }

            // Pebble clusters and loose rocks near the spawn, bigger stuff further out.
            for (int i = 0; i < 220; i++) Place(InDisc(45f), Mathf.Lerp(0.08f, 0.45f, R() * R()), 0.3f);
            for (int c = 0; c < 50; c++)
            {
                Vector2 center = InDisc(220f);
                int n = 5 + rng.Next(12);
                for (int k = 0; k < n; k++) Place(center + InDisc(7f), Mathf.Lerp(0.12f, 0.5f, R() * R()), 0.3f);
            }
            for (int i = 0; i < 350; i++) Place(InDisc(300f), Mathf.Lerp(0.15f, 0.7f, R() * R()), 0.25f);
            for (int i = 0; i < 220; i++) Place(InDisc(550f), Mathf.Lerp(0.7f, 1.8f, Mathf.Pow(R(), 1.5f)), 0.25f);
            for (int i = 0; i < 45; i++) Place(InDisc(650f), Mathf.Lerp(2f, 5.5f, Mathf.Pow(R(), 1.5f)), 0.3f);

            // Ejecta blocks thrown out around the larger craters.
            foreach (MarsTerrain.Crater crater in craters)
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

        static void CreateVolume(Transform parent, VolumeProfile profile)
        {
            var go = new GameObject("Post Processing");
            go.transform.SetParent(parent, false);
            var volume = go.AddComponent<Volume>();
            volume.isGlobal = true;
            volume.priority = 1f;
            volume.sharedProfile = profile;
        }

        static GameObject CreatePlayer(Terrain terrain, Material dustMat)
        {
            float groundY = terrain.SampleHeight(Vector3.zero) + terrain.transform.position.y;
            var player = new GameObject("Player") { tag = "Player" };
            player.transform.position = new Vector3(0f, groundY + 0.05f, 0f);

            var controller = player.AddComponent<CharacterController>();
            controller.height = 1.8f;
            controller.radius = 0.35f;
            controller.center = new Vector3(0f, 0.9f, 0f);
            controller.slopeLimit = 45f;
            controller.stepOffset = 0.45f;
            controller.skinWidth = 0.05f;
            controller.minMoveDistance = 0f;

            var camGo = new GameObject("PlayerCamera") { tag = "MainCamera" };
            camGo.transform.SetParent(player.transform, false);
            camGo.transform.localPosition = new Vector3(0f, 1.65f, 0f);
            var cam = camGo.AddComponent<Camera>();
            cam.fieldOfView = 65f;
            cam.nearClipPlane = 0.05f;
            cam.farClipPlane = 4000f;
            camGo.AddComponent<AudioListener>();
            var camData = camGo.AddComponent<UniversalAdditionalCameraData>();
            camData.renderPostProcessing = true;
            camData.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            camData.antialiasingQuality = AntialiasingQuality.High;

            var fps = player.AddComponent<FirstPersonController>();
            var so = new SerializedObject(fps);
            so.FindProperty("cameraTransform").objectReferenceValue = camGo.transform;
            so.ApplyModifiedPropertiesWithoutUndo();

            CreateDustMotes(player.transform, dustMat);
            return player;
        }

        static void CreateDustMotes(Transform player, Material material)
        {
            var go = new GameObject("Dust Motes");
            go.transform.SetParent(player, false);
            go.transform.localPosition = new Vector3(0f, 2f, 0f);
            var ps = go.AddComponent<ParticleSystem>();

            var main = ps.main;
            main.loop = true;
            main.prewarm = true;
            main.duration = 10f;
            main.startLifetime = new ParticleSystem.MinMaxCurve(6f, 10f);
            main.startSpeed = 0f;
            main.startSize = new ParticleSystem.MinMaxCurve(0.015f, 0.05f);
            main.startColor = new Color(0.86f, 0.66f, 0.50f, 0.55f);
            main.maxParticles = 800;
            main.simulationSpace = ParticleSystemSimulationSpace.World;

            var emission = ps.emission;
            emission.rateOverTime = 70f;

            var shape = ps.shape;
            shape.shapeType = ParticleSystemShapeType.Box;
            shape.scale = new Vector3(30f, 5f, 30f);

            // Light wind roughly across the dunes.
            var velocity = ps.velocityOverLifetime;
            velocity.enabled = true;
            velocity.space = ParticleSystemSimulationSpace.World;
            velocity.x = new ParticleSystem.MinMaxCurve(0.5f, 1.3f);
            velocity.y = new ParticleSystem.MinMaxCurve(-0.05f, 0.12f);
            velocity.z = new ParticleSystem.MinMaxCurve(0.15f, 0.5f);

            var noise = ps.noise;
            noise.enabled = true;
            noise.strength = 0.25f;
            noise.frequency = 0.25f;
            noise.scrollSpeed = 0.2f;

            var fade = new Gradient();
            fade.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(1f, 0.2f), new GradientAlphaKey(1f, 0.8f), new GradientAlphaKey(0f, 1f) });
            var colorOverLifetime = ps.colorOverLifetime;
            colorOverLifetime.enabled = true;
            colorOverLifetime.color = fade;

            var renderer = go.GetComponent<ParticleSystemRenderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;
        }

        static void CreateDayNightCycle(Light sun, GameObject player)
        {
            var cycle = sun.gameObject.AddComponent<DayNightCycle>();
            var so = new SerializedObject(cycle);
            so.FindProperty("sun").objectReferenceValue = sun;
            // The dust motes use an unlit material; without this they would glow at night.
            SerializedProperty unlit = so.FindProperty("unlitRenderers");
            unlit.arraySize = 1;
            unlit.GetArrayElementAtIndex(0).objectReferenceValue = player.GetComponentInChildren<ParticleSystemRenderer>();
            so.ApplyModifiedPropertiesWithoutUndo();
            cycle.Refresh(); // the sky needs its sun and colours before the reflection bake
        }

        // Weather under Environment/Weather, forced to Clear: Clear changes nothing, so the reflection bake below still sees today's sky.
        static void CreateWeather(Transform environment, GameObject player) =>
            MarsWeatherSetup.Create(environment, player, undo: false, forceClear: true);

        static void CreateEventSystem()
        {
            // Ready for the UI that comes next: uGUI canvases will pick this up automatically.
            var go = new GameObject("EventSystem");
            go.AddComponent<EventSystem>();
            go.AddComponent<InputSystemUIInputModule>();
        }

        // ------------------------------------------------------------------ helpers

        static void AddToBuildSettings(string path)
        {
            var scenes = new List<EditorBuildSettingsScene>(EditorBuildSettings.scenes);
            if (scenes.Exists(s => s.path == path)) return;
            scenes.Add(new EditorBuildSettingsScene(path, true));
            EditorBuildSettings.scenes = scenes.ToArray();
        }

        static string EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return path;
            int slash = path.LastIndexOf('/');
            string parent = EnsureFolder(path.Substring(0, slash));
            AssetDatabase.CreateFolder(parent, path.Substring(slash + 1));
            return path;
        }

        static void Progress(string message, float t) => EditorUtility.DisplayProgressBar("Building Mars", message, t);
    }
}

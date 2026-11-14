using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Creates or updates the weather under Environment/Weather: the <see cref="MarsWeather"/> brain, its near dust and
    /// dust devils (authored by <see cref="MarsWeatherEffectsSetup"/>), the storm grading Volume and the wind audio.
    /// Idempotent: everything is found by name and updated in place, so the scene builder and the menu item on an
    /// already-saved scene run the same code, as often as needed.
    ///
    /// Weather objects sit on the Ignore Raycast layer and nothing gets a collider: the rock scanner raycasts from the
    /// camera (triggers included) and must never hit the weather. Nothing is added under Player; its Dust Motes are
    /// only referenced.
    /// </summary>
    public static class MarsWeatherSetup
    {
        /// <summary>Generated weather assets (materials, the dust-devil mesh, the storm profile).</summary>
        public const string AssetFolder = "Assets/Mars/Generated/Weather";
        public const string StormProfilePath = AssetFolder + "/MarsWeatherStorm.asset";

        const string MenuPath = "Tools/Mars/Weather/Add Or Update Weather (Open Scene)";
        const string UndoName = "Add Or Update Mars Weather";
        const string RootName = "Weather";
        const string StormGradingName = "Storm Grading";
        const string WindAudioName = "Wind Audio";
        const string MotesName = "Dust Motes";
        const int IgnoreRaycastLayer = 2;

        /// <summary>
        /// Creates or updates Environment/Weather and returns it. <paramref name="forceClear"/> sets the start state
        /// to Clear (the builder needs it, so the reflection bake that follows sees today's sky); otherwise the
        /// scene's start state is kept. With <paramref name="undo"/> every change is recorded for Undo.
        /// </summary>
        public static GameObject Create(Transform environment, GameObject player, bool undo, bool forceClear)
        {
            if (environment == null) throw new System.ArgumentNullException(nameof(environment));
            EnsureFolder(AssetFolder);

            Transform root = FindOrCreateChild(environment, RootName, undo);
            MarsWeather weather = GetOrAdd<MarsWeather>(root.gameObject, undo);

            Volume storm = CreateStormGrading(root, BaseGradeLayer(environment), undo);
            CreateWindAudio(root, undo);

            ParticleSystem motes = FindMotes(player);
            if (motes == null)
                Debug.LogWarning($"[Mars] No '{MotesName}' particle system under the player: the near dust is created, but the existing motes won't follow the wind.");
            Terrain terrain = environment.GetComponentInChildren<Terrain>(true);
            if (terrain == null) terrain = Terrain.activeTerrain;
            MarsWeatherEffectsSetup.CreateNearDust(root, motes, AssetFolder, undo);
            MarsWeatherEffectsSetup.CreateDustDevils(root, terrain, AssetFolder, undo);

            // Only references and, when asked, the start state: the presets and timings a user tuned are kept.
            var so = new SerializedObject(weather);
            Property(so, "stormVolume").objectReferenceValue = storm;
            if (forceClear) Property(so, "startState").intValue = (int)WeatherKind.Clear;
            if (undo) so.ApplyModifiedProperties();
            else so.ApplyModifiedPropertiesWithoutUndo();

            SetLayers(root, undo);
            WarnAboutOtherWeather(weather);
            Republish(weather, environment);
            SaveGeneratedAssets();
            return root.gameObject;
        }

        // ------------------------------------------------------------------ menu

        [MenuItem(MenuPath)]
        static void AddOrUpdateFromMenu()
        {
            // Adds the weather to the saved MarsLandscape scene without a rebuild (which would regenerate the rocks).
            // No re-bake is needed: Clear changes nothing, and other start states only preview in edit mode.
            Scene scene = SceneManager.GetActiveScene();
            GameObject environment = FindRoot(scene, "Environment");
            DayNightCycle cycle = environment != null ? environment.GetComponentInChildren<DayNightCycle>(true) : null;
            if (cycle == null) cycle = FindInScene<DayNightCycle>(scene);
            if (environment == null || cycle == null)
            {
                EditorUtility.DisplayDialog("Mars Weather",
                    "The open scene needs a root object named 'Environment' and a DayNightCycle.\n\nBuild it first with Tools > Mars > Build Mars Landscape Scene.",
                    "OK");
                return;
            }

            GameObject player = FindRoot(scene, "Player");
            if (player == null)
            {
                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    if (root.CompareTag("Player")) { player = root; break; }
                }
            }

            Undo.IncrementCurrentGroup();
            int group = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName(UndoName);
            GameObject weather;
            try
            {
                weather = Create(environment.transform, player, undo: true, forceClear: false);
            }
            finally
            {
                Undo.CollapseUndoOperations(group); // one Ctrl+Z removes everything, even after an exception
            }

            // Dirty but not saved: the user reviews and saves (keep startState Clear when committing).
            EditorSceneManager.MarkSceneDirty(scene);
            Selection.activeGameObject = weather;
            Debug.Log("[Mars] Weather added/updated under Environment/Weather. Save the scene to keep it; in Play mode M cycles the weather, Shift+M goes back.", weather);
        }

        [MenuItem(MenuPath, true)]
        static bool CanAddOrUpdate() => !EditorApplication.isPlayingOrWillChangePlaymode;

        // ------------------------------------------------------------------ parts

        static Volume CreateStormGrading(Transform root, int layer, bool undo)
        {
            VolumeProfile profile = CreateStormProfile(StormProfilePath);

            Transform t = FindOrCreateChild(root, StormGradingName, undo);
            GameObject go = t.gameObject;
            if (go.layer != layer)
            {
                Record(go, undo);
                go.layer = layer;
            }

            // Global, above the base grade (priority 1). MarsWeather writes only the weight, at the storm amount, and
            // Volume blending lerps every overridden value from the base toward this profile by that weight.
            Volume volume = GetOrAdd<Volume>(go, undo);
            Record(volume, undo);
            volume.isGlobal = true;
            volume.priority = 2f;
            volume.weight = 0f;
            volume.sharedProfile = profile;
            return volume;
        }

        /// <summary>
        /// Storm grade, as absolute targets at weight 1 (base profile values in brackets). Not a phenomenon: it stands
        /// in for the eye adapting, because URP has no auto-exposure. Tuned, not measured. The compensation is only
        /// partial on purpose: Opportunity's daily solar energy fell to a few percent of normal in the 2018 storm (JPL
        /// status reports, June 2018), so a storm must still read darker. At the Dust Storm preset (tau 3, a regional
        /// storm like Jezero in January 2022) the weight is about 0.74, i.e. about +1 EV.
        /// </summary>
        static VolumeProfile CreateStormProfile(string path)
        {
            var profile = AssetDatabase.LoadAssetAtPath<VolumeProfile>(path);
            if (profile == null)
            {
                profile = ScriptableObject.CreateInstance<VolumeProfile>();
                AssetDatabase.CreateAsset(profile, path);
            }

            var color = Override<ColorAdjustments>(profile);
            color.postExposure.Override(1.55f); // (0.25) +1.3 EV of partial compensation
            color.contrast.Override(2f);        // (14) diffuse light, no hard shadows: a flat, low-contrast scene
            color.saturation.Override(-6f);     // (4)  dust mutes the colours

            Override<WhiteBalance>(profile).temperature.Override(14f); // (5) warmer: the light is filtered by red dust
            Override<Vignette>(profile).intensity.Override(0.3f);      // (0.2) a closed-in feel; the HUD is not affected

            EditorUtility.SetDirty(profile);
            return profile;
        }

        // Same pattern as MarsSceneBuilder: components live as hidden sub-assets of the profile.
        static T Override<T>(VolumeProfile profile) where T : VolumeComponent
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

        static void CreateWindAudio(Transform root, bool undo)
        {
            Transform t = FindOrCreateChild(root, WindAudioName, undo);
            AudioSource source = GetOrAdd<AudioSource>(t.gameObject, undo);
            Record(source, undo);
            source.clip = null;         // MarsWindAudio synthesises the wind itself
            source.playOnAwake = true;
            source.loop = true;
            source.spatialBlend = 0f;   // 2D: the wind surrounds the listener
            source.volume = 1f;         // loudness lives in MarsWindAudio.masterVolume
            GetOrAdd<MarsWindAudio>(t.gameObject, undo);
        }

        // The storm Volume must share the base grade's layer, not Ignore Raycast: URP cameras only blend Volumes on
        // their volume layer mask (Default only in this scene), so on layer 2 it would never apply. It has no
        // collider, so the scanner's ray can't hit it on any layer.
        static int BaseGradeLayer(Transform environment)
        {
            foreach (Volume v in environment.GetComponentsInChildren<Volume>(true))
            {
                if (v.gameObject.name != StormGradingName) return v.gameObject.layer; // the builder's "Post Processing"
            }
            return 0; // Default
        }

        // OnEnable snaps to startState and publishes with the fields wired above, and DayNightCycle folds that in at
        // once: a reflection bake right after (the builder's) sees exactly the state the scene opens in.
        static void Republish(MarsWeather weather, Transform environment)
        {
            if (weather.isActiveAndEnabled)
            {
                weather.enabled = false;
                weather.enabled = true;
            }
            DayNightCycle cycle = environment.GetComponentInChildren<DayNightCycle>(true);
            if (cycle != null && cycle.isActiveAndEnabled) cycle.Refresh();
        }

        // MarsAtmosphere ignores a second publisher, so a stray MarsWeather would make this one silently inert.
        static void WarnAboutOtherWeather(MarsWeather keep)
        {
            foreach (GameObject root in keep.gameObject.scene.GetRootGameObjects())
            {
                foreach (MarsWeather other in root.GetComponentsInChildren<MarsWeather>(true))
                {
                    if (other != keep)
                        Debug.LogWarning($"[Mars] Another MarsWeather is on '{other.name}'. Only one can drive the atmosphere; remove it and keep Environment/Weather.", other);
                }
            }
        }

        // Saves only this folder's assets: the editor is shared, and SaveAssets would also write other work in progress.
        static void SaveGeneratedAssets()
        {
            foreach (string guid in AssetDatabase.FindAssets(string.Empty, new[] { AssetFolder }))
            {
                AssetDatabase.SaveAssetIfDirty(new GUID(guid));
            }
        }

        // ------------------------------------------------------------------ helpers

        static Transform FindOrCreateChild(Transform parent, string name, bool undo)
        {
            Transform child = parent.Find(name);
            if (child != null) return child;
            var go = new GameObject(name) { layer = IgnoreRaycastLayer };
            go.transform.SetParent(parent, false);
            if (undo) Undo.RegisterCreatedObjectUndo(go, UndoName);
            return go.transform;
        }

        static T GetOrAdd<T>(GameObject go, bool undo) where T : Component
        {
            T component = go.GetComponent<T>();
            if (component != null) return component;
            return undo ? Undo.AddComponent<T>(go) : go.AddComponent<T>();
        }

        static void Record(Object target, bool undo)
        {
            if (undo) Undo.RecordObject(target, UndoName);
        }

        // Every weather object goes on Ignore Raycast, Volumes excepted (see BaseGradeLayer). Includes inactive children
        // such as the dust-devil template, and whatever MarsWeatherEffectsSetup created.
        static void SetLayers(Transform t, bool undo)
        {
            GameObject go = t.gameObject;
            if (go.layer != IgnoreRaycastLayer && go.GetComponent<Volume>() == null)
            {
                Record(go, undo);
                go.layer = IgnoreRaycastLayer;
            }
            foreach (Transform child in t) SetLayers(child, undo);
        }

        static SerializedProperty Property(SerializedObject so, string name) =>
            so.FindProperty(name) ?? throw new System.InvalidOperationException($"{so.targetObject.GetType().Name} has no serialized field '{name}'.");

        static ParticleSystem FindMotes(GameObject player)
        {
            if (player == null) return null;
            Transform t = FindDeep(player.transform, MotesName);
            return t != null ? t.GetComponent<ParticleSystem>() : null;
        }

        static Transform FindDeep(Transform t, string name)
        {
            if (t.name == name) return t;
            foreach (Transform child in t)
            {
                Transform hit = FindDeep(child, name);
                if (hit != null) return hit;
            }
            return null;
        }

        static GameObject FindRoot(Scene scene, string name)
        {
            foreach (GameObject root in scene.GetRootGameObjects())
            {
                if (root.name == name) return root;
            }
            return null;
        }

        static T FindInScene<T>(Scene scene) where T : Component
        {
            foreach (GameObject root in scene.GetRootGameObjects())
            {
                T found = root.GetComponentInChildren<T>(true);
                if (found != null) return found;
            }
            return null;
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

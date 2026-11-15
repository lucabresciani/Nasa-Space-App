using System.Reflection;
using NasaSpaceApp.HUD;
using UnityEngine;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Player settings of the MARTIS menu, stored in PlayerPrefs ("martis.settings.&lt;name&gt;"; reduced motion uses
    /// <see cref="HudTokens.ReducedMotionPrefKey"/>). A setting without a stored key keeps its default: a fixed value for
    /// volume and reduced motion, otherwise what the scene / engine had before the menu touched it. Property setters save
    /// the key and apply only their own setting; call <see cref="Save"/> to flush PlayerPrefs to disk.
    /// </summary>
    public static class MenuSettings
    {
        private const string Prefix = "martis.settings.";
        private const string KeyVolume = Prefix + "MasterVolume";
        private const string KeySensitivity = Prefix + "MouseSensitivity";
        private const string KeyInvertY = Prefix + "InvertY";
        private const string KeyFov = Prefix + "FieldOfView";
        private const string KeyQuality = Prefix + "QualityLevel";
        private const string KeyFullscreen = Prefix + "Fullscreen";
        private const string KeyVSync = Prefix + "VSync";

        /// <summary>Master volume default (0..1).</summary>
        public const float VolumeDefault = 0.8f;

        /// <summary>Mouse sensitivity range, degrees per pixel.</summary>
        public const float SensitivityMin = 0.02f, SensitivityMax = 0.30f;

        /// <summary>Vertical field of view range, degrees.</summary>
        public const float FovMin = 50f, FovMax = 90f;

        private const float SensitivityFallback = 0.1f, FovFallback = 60f;

        private static float s_Volume = VolumeDefault;
        private static float s_Sensitivity = SensitivityFallback;
        private static bool s_InvertY;
        private static float s_Fov = FovFallback;
        private static int s_Quality;
        private static bool s_Fullscreen;
        private static bool s_VSync;
        private static bool s_ReducedMotion;

        // Defaults: engine-wide ones once per session, scene ones once per player / camera instance (= per scene load).
        private static bool s_EngineDefaultsCaptured;
        private static int s_QualityDefault;
        private static bool s_FullscreenDefault, s_VSyncDefault;
        private static float s_SensitivityDefault = SensitivityFallback, s_FovDefault = FovFallback;
        private static bool s_InvertYDefault;

        private static FirstPersonController s_Player, s_DefaultsPlayer;
        private static Camera s_Camera, s_DefaultsCamera;
        private static FieldInfo s_SensitivityField, s_InvertYField;
        private static bool s_FieldsLooked;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            s_Volume = VolumeDefault;
            s_Sensitivity = SensitivityFallback;
            s_InvertY = false;
            s_Fov = FovFallback;
            s_Quality = 0;
            s_Fullscreen = false;
            s_VSync = false;
            s_ReducedMotion = false;
            s_EngineDefaultsCaptured = false;
            s_QualityDefault = 0;
            s_FullscreenDefault = false;
            s_VSyncDefault = false;
            s_SensitivityDefault = SensitivityFallback;
            s_FovDefault = FovFallback;
            s_InvertYDefault = false;
            s_Player = null;
            s_DefaultsPlayer = null;
            s_Camera = null;
            s_DefaultsCamera = null;
            s_SensitivityField = null;
            s_InvertYField = null;
            s_FieldsLooked = false;
        }

        // ---------------------------------------------------------------- availability

        /// <summary>True when a player with the mouse-look fields was found (sensitivity and invert rows).</summary>
        public static bool MouseLookAvailable =>
            s_Player != null && s_SensitivityField != null && s_InvertYField != null;

        /// <summary>True when a gameplay camera was found.</summary>
        public static bool FieldOfViewAvailable => s_Camera != null;

        /// <summary>True when there is more than one quality level to choose from.</summary>
        public static bool QualityAvailable => QualitySettings.names.Length > 1;

        /// <summary>False in the editor, where the game view cannot go fullscreen.</summary>
        public static bool FullscreenAvailable => !Application.isEditor;

        // ---------------------------------------------------------------- values

        /// <summary>Master volume 0..1 (AudioListener.volume).</summary>
        public static float MasterVolume
        {
            get => s_Volume;
            set
            {
                s_Volume = Mathf.Clamp01(value);
                PlayerPrefs.SetFloat(KeyVolume, s_Volume);
                ApplyVolume();
            }
        }

        /// <summary>Mouse-look sensitivity, degrees per pixel (<see cref="SensitivityMin"/>..<see cref="SensitivityMax"/>).</summary>
        public static float MouseSensitivity
        {
            get => s_Sensitivity;
            set
            {
                s_Sensitivity = Mathf.Clamp(value, SensitivityMin, SensitivityMax);
                PlayerPrefs.SetFloat(KeySensitivity, s_Sensitivity);
                ApplyLook(true);
            }
        }

        /// <summary>Inverted vertical mouse / stick look.</summary>
        public static bool InvertY
        {
            get => s_InvertY;
            set
            {
                s_InvertY = value;
                PlayerPrefs.SetInt(KeyInvertY, value ? 1 : 0);
                ApplyLook(true);
            }
        }

        /// <summary>Vertical field of view of the gameplay camera, degrees (<see cref="FovMin"/>..<see cref="FovMax"/>).</summary>
        public static float FieldOfView
        {
            get => s_Fov;
            set
            {
                s_Fov = Mathf.Clamp(value, FovMin, FovMax);
                PlayerPrefs.SetFloat(KeyFov, s_Fov);
                ApplyFov(true);
            }
        }

        /// <summary>Index into QualitySettings.names.</summary>
        public static int QualityLevel
        {
            get => s_Quality;
            set
            {
                s_Quality = ClampQuality(value);
                PlayerPrefs.SetInt(KeyQuality, s_Quality);
                ApplyQuality(true);
            }
        }

        /// <summary>Fullscreen window (ignored in the editor).</summary>
        public static bool Fullscreen
        {
            get => s_Fullscreen;
            set
            {
                s_Fullscreen = value;
                PlayerPrefs.SetInt(KeyFullscreen, value ? 1 : 0);
                ApplyFullscreen(true);
            }
        }

        /// <summary>Vertical sync (QualitySettings.vSyncCount 1 / 0).</summary>
        public static bool VSync
        {
            get => s_VSync;
            set
            {
                s_VSync = value;
                PlayerPrefs.SetInt(KeyVSync, value ? 1 : 0);
                ApplyVSync(true);
            }
        }

        /// <summary>Reduced motion for the menu and the helmet HUD (HudTokens.ReducedMotion).</summary>
        public static bool ReducedMotion
        {
            get => s_ReducedMotion;
            set
            {
                s_ReducedMotion = value;
                PlayerPrefs.SetInt(HudTokens.ReducedMotionPrefKey, value ? 1 : 0);
                HudTokens.ReducedMotion = value;
            }
        }

        // ---------------------------------------------------------------- load, apply, reset

        /// <summary>
        /// Captures the defaults it has not seen yet (engine ones once per session, player / camera ones per instance)
        /// and reads PlayerPrefs into the properties. Applies nothing.
        /// </summary>
        public static void Load()
        {
            CaptureEngineDefaults();
            ResolveTargets();

            s_Volume = Mathf.Clamp01(PlayerPrefs.GetFloat(KeyVolume, VolumeDefault));
            s_Sensitivity = Mathf.Clamp(PlayerPrefs.GetFloat(KeySensitivity, s_SensitivityDefault), SensitivityMin, SensitivityMax);
            s_InvertY = GetBool(KeyInvertY, s_InvertYDefault);
            s_Fov = Mathf.Clamp(PlayerPrefs.GetFloat(KeyFov, s_FovDefault), FovMin, FovMax);
            s_Quality = ClampQuality(PlayerPrefs.GetInt(KeyQuality, s_QualityDefault));
            s_Fullscreen = GetBool(KeyFullscreen, s_FullscreenDefault);
            s_VSync = GetBool(KeyVSync, s_VSyncDefault);
            s_ReducedMotion = GetBool(HudTokens.ReducedMotionPrefKey, false);
        }

        /// <summary>Pushes every setting to the engine and the scene. Settings without a stored key are left alone.</summary>
        public static void ApplyAll()
        {
            ResolveTargets();
            ApplyVolume();
            ApplyLook(false);
            ApplyFov(false);
            ApplyQuality(false);   // before vsync: a quality level change overwrites vSyncCount
            ApplyFullscreen(false);
            HudTokens.ReducedMotion = s_ReducedMotion;
        }

        /// <summary>
        /// Finds the player and the gameplay camera again (e.g. after a scene load); a new instance gets its defaults
        /// captured and the stored settings applied. Returns true when a target changed.
        /// </summary>
        public static bool Refresh()
        {
            if (!ResolveTargets())
            {
                return false;
            }
            ApplyLook(false);
            ApplyFov(false);
            return true;
        }

        /// <summary>Deletes every stored key and re-applies the defaults.</summary>
        public static void ResetToDefaults()
        {
            PlayerPrefs.DeleteKey(KeyVolume);
            PlayerPrefs.DeleteKey(KeySensitivity);
            PlayerPrefs.DeleteKey(KeyInvertY);
            PlayerPrefs.DeleteKey(KeyFov);
            PlayerPrefs.DeleteKey(KeyQuality);
            PlayerPrefs.DeleteKey(KeyFullscreen);
            PlayerPrefs.DeleteKey(KeyVSync);
            PlayerPrefs.DeleteKey(HudTokens.ReducedMotionPrefKey);

            ResolveTargets();
            s_Volume = VolumeDefault;
            s_Sensitivity = Mathf.Clamp(s_SensitivityDefault, SensitivityMin, SensitivityMax);
            s_InvertY = s_InvertYDefault;
            s_Fov = Mathf.Clamp(s_FovDefault, FovMin, FovMax);
            s_Quality = ClampQuality(s_QualityDefault);
            s_Fullscreen = s_FullscreenDefault;
            s_ReducedMotion = false;

            ApplyVolume();
            ApplyLook(true);
            ApplyFov(true);
            ApplyQuality(true);          // without a vsync key this reads the level's vsync back; set the default after
            s_VSync = s_VSyncDefault;
            ApplyVSync(true);
            ApplyFullscreen(true);
            HudTokens.ReducedMotion = false;
        }

        /// <summary>Writes PlayerPrefs to disk (the settings panel calls it when it hides).</summary>
        public static void Save()
        {
            PlayerPrefs.Save();
        }

        // ---------------------------------------------------------------- internals

        private static void CaptureEngineDefaults()
        {
            if (s_EngineDefaultsCaptured)
            {
                return;
            }
            s_EngineDefaultsCaptured = true;
            s_QualityDefault = QualitySettings.GetQualityLevel();
            s_FullscreenDefault = Screen.fullScreen;
            s_VSyncDefault = QualitySettings.vSyncCount > 0;
        }

        // Returns true when the player or the camera is a new instance (its defaults were captured just now).
        private static bool ResolveTargets()
        {
            LookUpFields();
            bool changed = false;

            if (s_Player == null)
            {
                s_Player = Object.FindAnyObjectByType<FirstPersonController>();
            }
            if (s_Player != null && s_Player != s_DefaultsPlayer)
            {
                s_DefaultsPlayer = s_Player;
                changed = true;
                if (s_SensitivityField != null)
                {
                    s_SensitivityDefault = (float)s_SensitivityField.GetValue(s_Player);
                }
                if (s_InvertYField != null)
                {
                    s_InvertYDefault = (bool)s_InvertYField.GetValue(s_Player);
                }
                if (!PlayerPrefs.HasKey(KeySensitivity))
                {
                    s_Sensitivity = Mathf.Clamp(s_SensitivityDefault, SensitivityMin, SensitivityMax);
                }
                if (!PlayerPrefs.HasKey(KeyInvertY))
                {
                    s_InvertY = s_InvertYDefault;
                }
            }

            Camera cam = null;
            if (s_Player != null && s_Player.CameraTransform != null)
            {
                cam = s_Player.CameraTransform.GetComponent<Camera>();
            }
            if (cam == null)
            {
                cam = Camera.main;
            }
            s_Camera = cam;
            if (s_Camera != null && s_Camera != s_DefaultsCamera)
            {
                s_DefaultsCamera = s_Camera;
                changed = true;
                s_FovDefault = s_Camera.fieldOfView;
                if (!PlayerPrefs.HasKey(KeyFov))
                {
                    s_Fov = Mathf.Clamp(s_FovDefault, FovMin, FovMax);
                }
            }
            return changed;
        }

        private static void LookUpFields()
        {
            if (s_FieldsLooked)
            {
                return;
            }
            s_FieldsLooked = true;
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
            s_SensitivityField = typeof(FirstPersonController).GetField("mouseSensitivity", flags);
            if (s_SensitivityField != null && s_SensitivityField.FieldType != typeof(float))
            {
                s_SensitivityField = null;
            }
            s_InvertYField = typeof(FirstPersonController).GetField("invertY", flags);
            if (s_InvertYField != null && s_InvertYField.FieldType != typeof(bool))
            {
                s_InvertYField = null;
            }
            if (s_SensitivityField == null || s_InvertYField == null)
            {
                Debug.LogWarning("[Menu] FirstPersonController look fields not found; mouse-look settings disabled");
            }
        }

        private static void ApplyVolume()
        {
            AudioListener.volume = s_Volume;
        }

        private static void ApplyLook(bool force)
        {
            if (s_Player == null)
            {
                return;
            }
            if (s_SensitivityField != null && (force || PlayerPrefs.HasKey(KeySensitivity)))
            {
                s_SensitivityField.SetValue(s_Player, s_Sensitivity);
            }
            if (s_InvertYField != null && (force || PlayerPrefs.HasKey(KeyInvertY)))
            {
                s_InvertYField.SetValue(s_Player, s_InvertY);
            }
        }

        private static void ApplyFov(bool force)
        {
            if (s_Camera != null && (force || PlayerPrefs.HasKey(KeyFov)))
            {
                s_Camera.fieldOfView = s_Fov;
            }
        }

        private static void ApplyQuality(bool force)
        {
            if ((force || PlayerPrefs.HasKey(KeyQuality)) && QualitySettings.GetQualityLevel() != s_Quality)
            {
                QualitySettings.SetQualityLevel(s_Quality, true);
            }
            if (PlayerPrefs.HasKey(KeyVSync))
            {
                ApplyVSync(true);
            }
            else
            {
                s_VSync = QualitySettings.vSyncCount > 0;
            }
        }

        private static void ApplyVSync(bool force)
        {
            if (force || PlayerPrefs.HasKey(KeyVSync))
            {
                QualitySettings.vSyncCount = s_VSync ? 1 : 0;
            }
        }

        private static void ApplyFullscreen(bool force)
        {
            if (FullscreenAvailable && (force || PlayerPrefs.HasKey(KeyFullscreen)) && Screen.fullScreen != s_Fullscreen)
            {
                Screen.fullScreen = s_Fullscreen;
            }
        }

        private static int ClampQuality(int index)
        {
            int count = QualitySettings.names.Length;
            return count > 0 ? Mathf.Clamp(index, 0, count - 1) : 0;
        }

        private static bool GetBool(string key, bool fallback)
        {
            return PlayerPrefs.HasKey(key) ? PlayerPrefs.GetInt(key, 0) != 0 : fallback;
        }
    }
}

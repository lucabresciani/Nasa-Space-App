using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Sprites and fonts of the helmet HUD (Assets/Mars/UI/Resources/HudSkin.asset). <see cref="Load"/> never returns
    /// null: a missing asset or field falls back (editor: path table, fonts: OS/builtin chain, sprites: HudFactory).
    /// </summary>
    [CreateAssetMenu(menuName = "HOMELINE/HUD Skin", fileName = "HudSkin")]
    public sealed class HudSkin : ScriptableObject
    {
        public const string ResourcePath = "HudSkin";             // Assets/Mars/UI/Resources/HudSkin.asset

        public Sprite panelFill, panelOutline, frameCorners;
        public Sprite discSolid, ringTicks60, ringHairline, ringThin;
        public Sprite compassPointer, offscreenArrow;
        public Sprite iconBattery, iconClock, iconCo2, iconFan, iconHeart, iconHelmet, iconOxygen, iconPower,
                      iconPressure, iconRadiation, iconSignal, iconTemperature, iconWarning, iconWater, iconWaypoint;
        public Font monoRegular, monoMedium, monoSemiBold, monoFallback;

        /// <summary>Resolved fonts, never null after <see cref="Load"/>.</summary>
        [System.NonSerialized] public Font Regular, Medium, SemiBold;

        private static readonly string[] OsFontNames = { "IBM Plex Mono", "JetBrains Mono", "Cascadia Mono", "Consolas", "Courier New" };
        private static Font s_OsFont;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            s_OsFont = null;
        }

        /// <summary>Loads the skin from Resources (or a fallback instance) and resolves the font chain. Never null.</summary>
        public static HudSkin Load()
        {
            HudSkin s = Resources.Load<HudSkin>(ResourcePath);
            if (s == null)
            {
                s = CreateInstance<HudSkin>();
                s.hideFlags = HideFlags.DontSave;
                Debug.LogWarning("[HUD] HudSkin missing, using fallbacks");
            }

#if UNITY_EDITOR
            if (s.HasMissingField())
            {
                // Fill a copy from the path table; never mutate the asset itself.
                if (UnityEditor.EditorUtility.IsPersistent(s))
                {
                    s = Instantiate(s);
                    s.hideFlags = HideFlags.DontSave;
                }
                s.EditorFill(false);
            }
#endif

            s.ResolveFonts();
            return s;
        }

        private void ResolveFonts()
        {
            Font regular = monoRegular;
            if (regular == null)
            {
                regular = monoFallback;
            }
            if (regular == null)
            {
                regular = OsFont();
            }
            if (regular == null)
            {
                regular = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            }
            Regular = regular;

            Font medium = monoMedium;
            if (medium == null)
            {
                medium = Regular;
            }
            Medium = medium;

            Font semiBold = monoSemiBold;
            if (semiBold == null)
            {
                semiBold = Medium;
            }
            SemiBold = semiBold;
        }

        private static Font OsFont()
        {
            if (s_OsFont == null)
            {
                s_OsFont = Font.CreateDynamicFontFromOSFont(OsFontNames, 16);
            }
            return s_OsFont;
        }

#if UNITY_EDITOR
        private const string UiRoot = "Assets/Mars/UI/";

        private bool HasMissingField()
        {
            return panelFill == null || panelOutline == null || frameCorners == null
                || discSolid == null || ringTicks60 == null || ringHairline == null || ringThin == null
                || compassPointer == null || offscreenArrow == null
                || iconBattery == null || iconClock == null || iconCo2 == null || iconFan == null || iconHeart == null
                || iconHelmet == null || iconOxygen == null || iconPower == null || iconPressure == null
                || iconRadiation == null || iconSignal == null || iconTemperature == null || iconWarning == null
                || iconWater == null || iconWaypoint == null
                || monoRegular == null || monoMedium == null || monoSemiBold == null || monoFallback == null;
        }

        /// <summary>
        /// Editor only: assigns every field from the path table (Assets/Mars/UI/...). Without <paramref name="overwrite"/>
        /// only null fields are filled. A path that does not resolve leaves the field unchanged.
        /// </summary>
        public void EditorFill(bool overwrite)
        {
            FillSprite(ref panelFill, "Panels/panel_rounded_fill.png", overwrite);
            FillSprite(ref panelOutline, "Panels/panel_rounded_outline.png", overwrite);
            FillSprite(ref frameCorners, "Panels/frame_corners.png", overwrite);
            FillSprite(ref discSolid, "Rings/disc_solid.png", overwrite);
            FillSprite(ref ringTicks60, "Rings/ring_ticks_60.png", overwrite);
            FillSprite(ref ringHairline, "Rings/ring_hairline.png", overwrite);
            FillSprite(ref ringThin, "Rings/ring_thin.png", overwrite);
            FillSprite(ref compassPointer, "Widgets/compass_pointer.png", overwrite);
            FillSprite(ref offscreenArrow, "Widgets/offscreen_arrow.png", overwrite);
            FillSprite(ref iconBattery, "Icons/icon_battery.png", overwrite);
            FillSprite(ref iconClock, "Icons/icon_clock.png", overwrite);
            FillSprite(ref iconCo2, "Icons/icon_co2.png", overwrite);
            FillSprite(ref iconFan, "Icons/icon_fan.png", overwrite);
            FillSprite(ref iconHeart, "Icons/icon_heart.png", overwrite);
            FillSprite(ref iconHelmet, "Icons/icon_helmet.png", overwrite);
            FillSprite(ref iconOxygen, "Icons/icon_oxygen.png", overwrite);
            FillSprite(ref iconPower, "Icons/icon_power.png", overwrite);
            FillSprite(ref iconPressure, "Icons/icon_pressure.png", overwrite);
            FillSprite(ref iconRadiation, "Icons/icon_radiation.png", overwrite);
            FillSprite(ref iconSignal, "Icons/icon_signal.png", overwrite);
            FillSprite(ref iconTemperature, "Icons/icon_temperature.png", overwrite);
            FillSprite(ref iconWarning, "Icons/icon_warning.png", overwrite);
            FillSprite(ref iconWater, "Icons/icon_water.png", overwrite);
            FillSprite(ref iconWaypoint, "Icons/icon_waypoint.png", overwrite);
            FillFont(ref monoRegular, "Fonts/IBMPlexMono/IBMPlexMono-Regular.ttf", overwrite);
            FillFont(ref monoMedium, "Fonts/IBMPlexMono/IBMPlexMono-Medium.ttf", overwrite);
            FillFont(ref monoSemiBold, "Fonts/IBMPlexMono/IBMPlexMono-SemiBold.ttf", overwrite);
            FillFont(ref monoFallback, "Fonts/JetBrainsMono/JetBrainsMono-Regular.ttf", overwrite);
        }

        private static void FillSprite(ref Sprite field, string path, bool overwrite)
        {
            if (!overwrite && field != null)
            {
                return;
            }
            Sprite asset = UnityEditor.AssetDatabase.LoadAssetAtPath<Sprite>(UiRoot + path);
            if (asset != null)
            {
                field = asset;
            }
        }

        private static void FillFont(ref Font field, string path, bool overwrite)
        {
            if (!overwrite && field != null)
            {
                return;
            }
            Font asset = UnityEditor.AssetDatabase.LoadAssetAtPath<Font>(UiRoot + path);
            if (asset != null)
            {
                field = asset;
            }
        }
#endif
    }
}

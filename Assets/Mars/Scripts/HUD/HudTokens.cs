using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Design tokens of the helmet HUD: canvas, color, type, stroke, spacing, motion and rock-card constants.
    /// Colors are final values for <see cref="UnityEngine.UI.Graphic.color"/>; translucent ones are converted once from a
    /// perceptual alpha so they read the same in linear and gamma color space.
    /// </summary>
    public static class HudTokens
    {
        // ---- canvas
        public const float RefWidth = 1920f, RefHeight = 1080f;
        public const float MatchWidthOrHeight = 1f;          // match height: sizes follow vertical FOV
        public const float ReferencePixelsPerUnit = 100f;
        public const int SortingOrder = 50;

        // ---- color (hex, perceptual alpha)
        public static readonly Color InkPrimary = Hex(0xECEEEF, 1f);       // values, IDs, titles, self triangle, caret
        public static readonly Color InkSecondary = Hex(0xB4BBC1, 1f);     // labels, units, icons at rest
        public static readonly Color InkTertiary = Light(0xB4BBC1, 0.60f); // footers, captions, "--", countdown
        public static readonly Color StrokeHair = Light(0xFFFFFF, 0.35f);  // dividers, value underlines, dial bezel
        public static readonly Color StrokeMark = Light(0xFFFFFF, 0.85f);  // leaders, brackets, dial ticks, anchor dot
        public static readonly Color Halo = Dark(0x0B0E11, 0.55f);         // keyline under every bare stroke/text
        public static readonly Color Scrim = Dark(0x0B0E11, 0.68f);        // every card, pill, dial lens
        public static readonly Color HoverFill = Light(0xFFFFFF, 0.18f);
        public static readonly Color PressFill = Light(0xFFFFFF, 0.28f);
        public static readonly Color Accent = Hex(0x6FD3EE, 1f);           // ONLY focused rock (leader, dot, pip), scan-hold ring
        public static readonly Color AccentRing = Light(0x6FD3EE, 0.45f);  // focused card outline
        public static readonly Color Caution = Hex(0xFFB020, 1f);          // amber text/icon on scrim; amber tag fill
        public static readonly Color CautionInk = Hex(0x14110A, 1f);       // text on amber tag
        public static readonly Color WarningFill = Hex(0xC8322A, 0.95f);   // red tag fill (white text on it)
        public static readonly Color WarningText = Hex(0xFF7A70, 1f);      // red text, >= 15 px Medium, on scrim only
        public static readonly Color KeycapFill = Hex(0xB4BBC1, 1f);       // key hint chip, text = KeycapInk
        public static readonly Color KeycapInk = Hex(0x0B0E11, 1f);
        public static readonly Color TimerBar = Light(0xECEEEF, 0.70f);
        public static readonly Color TimerBarPaused = Light(0xECEEEF, 0.30f);
        public static readonly Color WaveBar = Light(0xECEEEF, 0.90f);
        public const float NightGroupAlpha = 0.82f;   // root CanvasGroup alpha at full darkness (dims ink and scrim together)
        public const float SprintDimAlpha = 0.45f;    // rock cards while sprinting

        /// <summary>Color from 0xRRGGBB with an alpha that is used as is (opaque colors, or alpha that is the meaning).</summary>
        public static Color Hex(int rgb, float a)
        {
            return new Color(((rgb >> 16) & 0xFF) / 255f, ((rgb >> 8) & 0xFF) / 255f, (rgb & 0xFF) / 255f, a);
        }

        /// <summary>Light color over a darker ground: perceptual alpha p becomes p^2.2 in linear color space.</summary>
        public static Color Light(int rgb, float perceptualAlpha)
        {
            float p = Mathf.Clamp01(perceptualAlpha);
            return Hex(rgb, IsLinear() ? Mathf.Pow(p, 2.2f) : p);
        }

        /// <summary>Dark color over a lighter ground: perceptual alpha p becomes 1-(1-p)^2.2 in linear color space.</summary>
        public static Color Dark(int rgb, float perceptualAlpha)
        {
            float p = Mathf.Clamp01(perceptualAlpha);
            return Hex(rgb, IsLinear() ? 1f - Mathf.Pow(1f - p, 2.2f) : p);
        }

        /// <summary>Returns <paramref name="c"/> with its alpha multiplied.</summary>
        public static Color Alpha(Color c, float multiplier)
        {
            c.a *= multiplier;
            return c;
        }

        /// <summary>Severity color: Caution, WarningText, InkSecondary for Info, else <paramref name="nominal"/>.</summary>
        public static Color Severity(HudSeverity s, Color nominal)
        {
            switch (s)
            {
                case HudSeverity.Caution: return Caution;
                case HudSeverity.Warning: return WarningText;
                case HudSeverity.Info: return InkSecondary;
                default: return nominal;
            }
        }

        private static bool IsLinear()
        {
            return QualitySettings.activeColorSpace == ColorSpace.Linear;
        }

        // ---- type (px at 1080p; legacy Text, dynamic TTF; IBM Plex Mono, fallback JetBrains Mono)
        public const int SizeValueLarge = 22;  // vitals values (mockup 22)
        public const int SizeValue = 18;       // rock card values
        public const int SizeLabel = 15;       // labels, IDs, units, heading digits, alert message
        public const int SizeMicro = 14;       // class line, section label, hints, locator labels, tooltip line 1, alert tag
        public const int SizeFoot = 14;        // footers, caption, countdown, keycap letters, tooltip line 2
        // 14 px is the legibility floor at the 1080p reference (v1 used 12/13 px, which read as blurry and low-res).

        /// <summary>Monospace advance in px (Unity rounds advances at 1080p): 14->8 15->9 18->11 22->13.</summary>
        public static int Advance(int size) => Mathf.RoundToInt(size * 0.6f);
        // Weights: Regular = values/body; Medium = labels, IDs, caps; SemiBold = alert tag only. Never Text.fontStyle.

        // ---- strokes, radii (px)
        public const float Hairline = 1f, LeaderWidth = 2f, LeaderHaloWidth = 4f;
        public const float AnchorDot = 6f, AnchorDotHalo = 10f, PipSize = 7f, PipHalo = 9f;
        public const float RadiusCard = 16f, RadiusSmall = 12f, RadiusButton = 8f, RadiusTag = 6f, RadiusKeycap = 4f; // pills: h/2
        public const float PanelSpriteRadius = 20f;  // panel_rounded_* imported with border 20 = source rx

        /// <summary>Image.pixelsPerUnitMultiplier that draws the panel sprite's corners at <paramref name="radius"/> px.</summary>
        public static float PanelMultiplier(float radius) => PanelSpriteRadius / Mathf.Max(1f, radius);
        public const float BracketMultiplier = 2.86f;     // frame_corners (border 40): arm 14 px, stroke 1.4 px
        public const float BracketHaloMultiplier = 2.0f;  // halo copy: stroke 2 px, drawn under, 1 px larger each side

        // ---- spacing (4-pt grid)
        public const float S1 = 4f, S2 = 8f, S3 = 12f, S4 = 16f, S6 = 24f, S8 = 32f;
        public const float ScreenMargin = 32f;   // compass, vitals, caption and tooltip sit 32 px from the canvas edges
        public const float StackGap = 16f;       // vertical/horizontal gap in the vitals stack
        public const float SafeInset = 24f;      // cards and locators never closer to the canvas edge
        public const float NightToastWidth = 420f, NightToastHeight = 120f; // top-left corner kept free for the night-sky toast

        // ---- motion (seconds; unscaled time; ease-out for enter AND exit, never ease-in)
        public const float DurCardEnter = 0.18f, DurCardExit = 0.14f, DurCardExitKey = 0.09f;
        public const float DurLeaderDraw = 0.12f, DelayLeaderDraw = 0.06f, DurLeaderRetract = 0.10f;
        public const float DurBracketLock = 0.15f, BracketLockScale = 1.12f;
        public const float RelayoutSmoothTime = 0.18f;   // SmoothDamp
        public const float DurDim = 0.16f, DurAlertIn = 0.12f, DurAlertOut = 0.20f, DurTooltip = 0.10f;
        public const float TooltipDelay = 0.40f, TooltipInstantWindow = 1.0f;
        public const float CardEnterScale = 0.97f, ButtonPressScale = 0.94f, DurButton = 0.08f;
        public const float CautionPulseHz = 2f; public const int CautionPulseCount = 2;
        public const float WarningBlinkHz = 2f, WarningBlinkMaxS = 10f;  // AC 25-11B: 0.8-4 Hz, steady after ~10 s
        public const float DurReduced = 0.10f;
        public const float DayNightSmoothS = 2f;

        /// <summary>1-(1-t)^5 on clamped t; approximates cubic-bezier(0.23, 1, 0.32, 1).</summary>
        public static float EaseOut(float t)
        {
            float u = 1f - Mathf.Clamp01(t);
            return 1f - u * u * u * u * u;
        }

        /// <summary>1-(1-t)^3 on clamped t.</summary>
        public static float EaseOutCubic(float t)
        {
            float u = 1f - Mathf.Clamp01(t);
            return 1f - u * u * u;
        }

        /// <summary>Duration <paramref name="d"/>, capped at <see cref="DurReduced"/> when reduced motion is on.</summary>
        public static float Dur(float d) => ReducedMotion ? Mathf.Min(d, DurReduced) : d;

        // ---- reduced motion (PlayerPrefs int 0/1, read by HelmetHud.Create; default 0)
        public const string ReducedMotionPrefKey = "homeline.hud.reducedMotion";

        /// <summary>True: fades only (&lt;= 100 ms), no scale/slide, relayout snaps, pulse strip frozen, blink -> steady.</summary>
        public static bool ReducedMotion;

        // ---- rock cards
        public const float CardWidth = 240f, CardPad = 16f, CardRowPitch = 24f;
        public const float CardTimeout = 30f, CardTimeoutNoData = 8f, CardMaxDistance = 60f;
        public const int CardMax = 3;
        public const float CountdownVisibleBelow = 10f;  // numeric seconds shown only in the last 10 s
    }
}

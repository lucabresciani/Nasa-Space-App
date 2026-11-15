using NasaSpaceApp.HUD;
using UnityEngine;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Design tokens of the MARVIS title / pause screen: canvas, color, type, layout and motion. Sizes are px on a
    /// 1080-high reference canvas (the canvas matches height, so the width grows with the aspect ratio). Colors are
    /// final values for <see cref="UnityEngine.UI.Graphic.color"/>; translucent ones go through the HUD's perceptual
    /// alpha helpers so they read the same in linear and gamma color space. Values were measured on the approved
    /// mockup (Assets/FINAL TITLE - PAUSE SCREEN.png).
    /// </summary>
    public static class MenuTokens
    {
        // ---- canvas
        public const float RefWidth = 1920f, RefHeight = 1080f;
        public const float MatchWidthOrHeight = 1f;       // match height
        public const int SortingOrder = 200;              // above the helmet HUD (50)

        // ---- color
        public static readonly Color Void = HudTokens.Hex(0x07060B, 1f);            // deep sky, fade overlay
        public static readonly Color Bronze = HudTokens.Hex(0xAC8057, 1f);          // brand: logo, labels at rest, fills
        public static readonly Color BronzeBright = HudTokens.Hex(0xE6BC8A, 1f);    // focused / hovered label, slider knob
        public static readonly Color Sand = HudTokens.Hex(0xEAD8BE, 1f);            // body text, values
        public static readonly Color SandDim = HudTokens.Hex(0xB8A892, 1f);         // secondary text
        public static readonly Color SandFaint = HudTokens.Light(0xB8A892, 0.62f);  // hints, fine print
        public static readonly Color Slab = HudTokens.Hex(0x0B0C11, 1f);            // dark slab behind the logo helmet
        public static readonly Color Scrim = HudTokens.Dark(0x141014, 0.62f);       // label pill at rest
        public static readonly Color ScrimFocus = HudTokens.Dark(0x141014, 0.88f);  // label pill focused
        public static readonly Color ScrimPanel = HudTokens.Dark(0x100D11, 0.82f);  // settings / credits panel
        public static readonly Color RowFocus = HudTokens.Light(0xEAD8BE, 0.10f);   // focused settings row
        public static readonly Color Hairline = HudTokens.Light(0xAC8057, 0.40f);   // dividers, slider track, switch outline
        public static readonly Color KeycapFill = HudTokens.Light(0xEAD8BE, 0.16f); // key chip
        public static readonly Color Alert = HudTokens.Hex(0xEE7B55, 1f);           // "confirm?" labels
        public const float DisabledAlpha = 0.38f;                                   // disabled label / control

        // ---- type (px; legacy Text, dynamic TTF). Sans = Open Sauce Sans, Mono = the HUD's IBM Plex Mono.
        public const int SizeMenuItem = 32;    // Bold, main menu labels and the Back button
        public const int SizePanelTitle = 30;  // Bold, panel header
        public const int SizeTab = 16;         // Bold caps, tab labels and small buttons
        public const int SizeSection = 13;     // Bold caps, Bronze, group headers inside panels
        public const int SizeBody = 18;        // Medium, row labels and credits body
        public const int SizeValue = 16;       // Mono, numeric readouts
        public const int SizeSmall = 14;       // Regular, descriptions and credits fine print
        public const int SizeHint = 13;        // footer hints (Regular) and keycap letters (Mono Medium)
        public const int SizeFine = 12;        // attribution line

        // ---- layout (px, measured from the mockup at 1080 reference height)
        public const float MarginLeft = 98f;                 // logo and panel left edge
        public const float LogoCapTop = 86f;                 // top of the logo letters, from the canvas top
        public const float LogoCapHeight = 115f;             // height of the logo letters (the helmet overshoots)
        public const float MenuCenterX = 508f;               // menu labels are centered on this x (logo center)
        public static readonly float[] MenuItemY = { 346f, 449f, 713f, 821f, 930f }; // label centers from the top
        public const float MenuItemHeight = 46f;             // pill height
        public const float MenuItemHitHeight = 64f;          // pointer target height (transparent padding)
        public const float MenuItemPadX = 22f;               // pill padding left/right of the text
        public const float MenuItemFocusGrow = 14f;          // pill grows by this much on each side when focused
        public const float MarkerSize = 7f, MarkerGap = 16f; // focus diamonds left/right of the pill

        public const float PlanetCenterFromRight = 439f;     // planet center, px left of the right canvas edge
        public const float PlanetCenterBelowMiddle = 170f;   // planet center, px below the canvas middle
        public const float PlanetDiameter = 1142f;           // lit disc diameter
        public const float PlanetDiscFraction = 0.8f;        // disc diameter / quad size (the rest is the halo)

        public const float PanelTop = 250f, PanelWidth = 800f, PanelHeight = 750f;   // panel box, left = MarginLeft
        public const float PanelRadius = 20f, PanelPad = 32f, PanelHeaderHeight = 88f;
        public const float ContentWidth = 736f, ContentHeight = 560f;                // MenuPanel content rect
        public const float RowHeight = 44f, RowRadius = 10f;
        public const float FooterBottom = 28f;               // footer hints baseline box, from the canvas bottom

        public const float KeycapHeight = 24f, KeycapPadX = 7f, KeycapRadius = 5f, KeycapGap = 6f;

        // ---- motion (seconds, unscaled time; ease-out for enter and exit, never ease-in)
        public const float DurIntroBackdrop = 0.9f;          // boot: fade from black
        public const float DurIntroPlanet = 1.6f, IntroPlanetSlide = 40f, IntroPlanetScale = 1.04f;
        public const float IntroLogoDelay = 0.25f, DurIntroLetter = 0.55f, StaggerLetter = 0.07f, IntroLetterRise = 18f;
        public const float IntroItemsDelay = 0.75f, DurIntroItem = 0.32f, StaggerItem = 0.05f, IntroItemRise = 12f;
        public const float DurOpenPause = 0.18f;             // pause menu fade-in (frequent: no stagger, no slide)
        public const float DurClose = 0.16f;                 // resume fade-out
        public const float DurStartFade = 0.70f;             // START SIMULATION: the menu dissolves into the world
        public const float DurPanelOut = 0.12f, DurPanelIn = 0.20f, PanelSlide = 16f;
        public const float DurFocus = 0.16f, DurPress = 0.10f, PressScale = 0.97f;
        public const float PlanetRevolutionSeconds = 300f;   // one full spin of the title planet
        public const float BackdropLoopSeconds = 2400f;      // one full wrap of the star strip
        public const float GlintPeriod = 7.5f, GlintDuration = 0.9f, GlintBoost = 0.35f; // brightness wave over the logo
        public const float ConfirmWindow = 3f;               // seconds a "confirm?" label waits for the second press

        /// <summary>1-(1-t)^5 on clamped t (strong ease-out).</summary>
        public static float EaseOut(float t) => HudTokens.EaseOut(t);

        /// <summary>1-(1-t)^3 on clamped t.</summary>
        public static float EaseOutCubic(float t) => HudTokens.EaseOutCubic(t);

        /// <summary>Symmetric cubic ease for things that move while staying on screen.</summary>
        public static float EaseInOut(float t)
        {
            t = Mathf.Clamp01(t);
            return t < 0.5f ? 4f * t * t * t : 1f - Mathf.Pow(-2f * t + 2f, 3f) * 0.5f;
        }

        /// <summary>True: fades only (at most 100 ms), no slides or scales, no glint, star drift frozen.</summary>
        public static bool ReducedMotion => HudTokens.ReducedMotion;

        /// <summary>Duration <paramref name="d"/>, capped at 100 ms when reduced motion is on.</summary>
        public static float Dur(float d) => HudTokens.Dur(d);

        /// <summary>Returns <paramref name="c"/> with its alpha multiplied.</summary>
        public static Color Alpha(Color c, float multiplier) => HudTokens.Alpha(c, multiplier);
    }
}

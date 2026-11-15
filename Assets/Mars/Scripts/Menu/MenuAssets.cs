using System;
using System.Collections.Generic;
using System.Globalization;
using NasaSpaceApp.HUD;
using UnityEngine;

namespace NasaSpaceApp.Menu
{
    /// <summary>One piece of the MARVIS logotype: a white-on-alpha sprite and its place in the logo box.</summary>
    public struct LogoGlyph
    {
        /// <summary>m, a, r, t_slab, t_helmet, i or s.</summary>
        public string Key;

        public Sprite Sprite;

        /// <summary>Position and size in layout px; origin at the bottom-left of the logo box, y up.</summary>
        public Rect Rect;
    }

    /// <summary>
    /// Assets of the title / pause screen, loaded from Assets/Mars/UI/Resources/Title. <see cref="Load"/> never returns
    /// null and never throws: fonts fall back to the HUD faces, everything else may be null and the menu degrades
    /// (no planet, flat backdrop, text logo).
    /// </summary>
    public sealed class MenuAssets
    {
        /// <summary>Resources folder of the menu (trailing slash).</summary>
        public const string Root = "Title/";

        /// <summary>Open Sauce Sans; never null after <see cref="Load"/>.</summary>
        public Font Bold, Medium, Regular;

        /// <summary>The HUD's IBM Plex Mono (keycaps, numeric values); never null after <see cref="Load"/>.</summary>
        public Font Mono, MonoMedium;

        /// <summary>Equirectangular Mars maps (longitude -180..180 left to right, north up) and the star strip. May be null.</summary>
        public Texture2D MarsColor, MarsNormal, StarStrip;

        /// <summary>UI shaders "Marvis/TitlePlanet" and "Marvis/TitleBackdrop". May be null.</summary>
        public Shader PlanetShader, BackdropShader;

        /// <summary>White chevron pointing right. May be null.</summary>
        public Sprite Chevron;

        /// <summary>Credits text (see CreditsPanel for the format). May be null.</summary>
        public TextAsset Credits;

        /// <summary>Logo pieces in draw order; empty when the sprites or the layout are missing.</summary>
        public LogoGlyph[] Logo = Array.Empty<LogoGlyph>();

        /// <summary>Size of the logo box in layout px.</summary>
        public Vector2 LogoBox;

        /// <summary>Baseline and top of the logo letters in layout px (the helmet overshoots both).</summary>
        public float LogoCapBottom, LogoCapTop;

        /// <summary>True when the sprite logotype can be drawn.</summary>
        public bool HasLogo => Logo.Length > 0 && LogoCapTop > LogoCapBottom;

        /// <summary>Loads everything. <paramref name="skin"/> supplies the fallback fonts and may be null.</summary>
        public static MenuAssets Load(HudSkin skin)
        {
            var a = new MenuAssets();

            Font fallback = skin != null ? skin.Regular : null;
            if (fallback == null)
            {
                fallback = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            }
            a.Regular = LoadFont("Fonts/OpenSauceSans-Regular", fallback);
            a.Medium = LoadFont("Fonts/OpenSauceSans-Medium", skin != null && skin.Medium != null ? skin.Medium : a.Regular);
            a.Bold = LoadFont("Fonts/OpenSauceSans-Bold", skin != null && skin.SemiBold != null ? skin.SemiBold : a.Medium);
            a.Mono = skin != null && skin.Regular != null ? skin.Regular : fallback;
            a.MonoMedium = skin != null && skin.Medium != null ? skin.Medium : a.Mono;

            a.MarsColor = Resources.Load<Texture2D>(Root + "mars_color");
            a.MarsNormal = Resources.Load<Texture2D>(Root + "mars_normal");
            a.StarStrip = Resources.Load<Texture2D>(Root + "stars_strip");
            a.PlanetShader = Resources.Load<Shader>(Root + "MarvisPlanet");
            a.BackdropShader = Resources.Load<Shader>(Root + "MarvisBackdrop");
            a.Chevron = Resources.Load<Sprite>(Root + "icon_chevron");
            a.Credits = Resources.Load<TextAsset>(Root + "credits");

            try
            {
                a.LoadLogo(Resources.Load<TextAsset>(Root + "logo_layout"));
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                a.Logo = Array.Empty<LogoGlyph>();
            }
            return a;
        }

        private static Font LoadFont(string name, Font fallback)
        {
            Font f = Resources.Load<Font>(Root + name);
            return f != null ? f : fallback;
        }

        // Layout file (logo_layout.txt), one record per line, '#' starts a comment:
        //   box <width> <height>
        //   cap <bottom> <top>
        //   glyph <key> <x> <y> <width> <height>     sprite = Title/logo_<key>, origin bottom-left, y up
        private void LoadLogo(TextAsset layout)
        {
            if (layout == null)
            {
                return;
            }
            var glyphs = new List<LogoGlyph>();
            string[] lines = layout.text.Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.Length == 0 || line[0] == '#')
                {
                    continue;
                }
                string[] p = line.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
                if (p[0] == "box" && p.Length >= 3)
                {
                    LogoBox = new Vector2(Num(p[1]), Num(p[2]));
                }
                else if (p[0] == "cap" && p.Length >= 3)
                {
                    LogoCapBottom = Num(p[1]);
                    LogoCapTop = Num(p[2]);
                }
                else if (p[0] == "glyph" && p.Length >= 6)
                {
                    Sprite sprite = Resources.Load<Sprite>(Root + "logo_" + p[1]);
                    if (sprite == null)
                    {
                        // One missing piece would leave a hole in the word: use the text fallback instead.
                        Logo = Array.Empty<LogoGlyph>();
                        return;
                    }
                    glyphs.Add(new LogoGlyph
                    {
                        Key = p[1],
                        Sprite = sprite,
                        Rect = new Rect(Num(p[2]), Num(p[3]), Num(p[4]), Num(p[5])),
                    });
                }
            }
            if (LogoBox.x > 0f && LogoBox.y > 0f)
            {
                Logo = glyphs.ToArray();
            }
        }

        private static float Num(string s)
        {
            return float.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture);
        }
    }

    /// <summary>
    /// Property names of the two title shaders (the contract between the shaders and MenuBackdrop). Neither shader
    /// reads _Time: the menu runs at Time.timeScale 0, so time comes in through <see cref="UnscaledTime"/>.
    /// </summary>
    public static class MenuShader
    {
        // ---- Marvis/TitlePlanet (square quad; the lit disc has diameter = quad size * DiscFraction)
        public static readonly int MainTex = Shader.PropertyToID("_MainTex");                // equirect color, sRGB
        public static readonly int NormalTex = Shader.PropertyToID("_NormalTex");            // equirect normal (east, north, up), linear
        public static readonly int RotX = Shader.PropertyToID("_RotX");                      // rows of the view -> planet rotation
        public static readonly int RotY = Shader.PropertyToID("_RotY");
        public static readonly int RotZ = Shader.PropertyToID("_RotZ");
        public static readonly int SunDir = Shader.PropertyToID("_SunDir");                  // view space, normalized (+x right, +y up, +z to viewer)
        public static readonly int DiscFraction = Shader.PropertyToID("_DiscFraction");
        public static readonly int Exposure = Shader.PropertyToID("_Exposure");
        public static readonly int NormalStrength = Shader.PropertyToID("_NormalStrength");
        public static readonly int Night = Shader.PropertyToID("_Night");
        public static readonly int AtmoColor = Shader.PropertyToID("_AtmoColor");
        public static readonly int AtmoStrength = Shader.PropertyToID("_AtmoStrength");
        public static readonly int HaloStrength = Shader.PropertyToID("_HaloStrength");
        public static readonly int HaloWidth = Shader.PropertyToID("_HaloWidth");

        // ---- Marvis/TitleBackdrop (full-screen quad)
        public static readonly int Aspect = Shader.PropertyToID("_Aspect");                  // quad width / height
        public static readonly int Zoom = Shader.PropertyToID("_Zoom");                      // strip height fraction covered by the quad height
        public static readonly int Tilt = Shader.PropertyToID("_Tilt");                      // radians
        public static readonly int Scroll = Shader.PropertyToID("_Scroll");                  // u offset, 0..1, wraps
        public static readonly int VCenter = Shader.PropertyToID("_VCenter");                // strip v at the quad center
        public static readonly int Twinkle = Shader.PropertyToID("_Twinkle");
        public static readonly int Vignette = Shader.PropertyToID("_Vignette");
        public static readonly int UnscaledTime = Shader.PropertyToID("_UnscaledTime");      // seconds
    }
}

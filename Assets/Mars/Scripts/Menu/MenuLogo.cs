using System.Collections.Generic;
using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// The MARVIS logotype: one Image per <see cref="LogoGlyph"/> (or the word in Bold as a fallback), placed so the
    /// logo box's left edge is at <see cref="MenuTokens.MarginLeft"/> and the cap top at
    /// <see cref="MenuTokens.LogoCapTop"/>. Boot intro: the pieces rise in one after the other, the "T" (slab + helmet)
    /// last. Idle: a brightness wave runs over the bronze pieces every <see cref="MenuTokens.GlintPeriod"/> seconds.
    /// </summary>
    public sealed class MenuLogo
    {
        private const string SlabKey = "t_slab";
        private const string HelmetKey = "t_helmet";
        private const int FallbackSize = 150;
        private const float FallbackCapOffset = 0.2f;   // legacy Text puts the cap top about 0.2 em below the box top
        private const float GlintHalfWidth = 0.3f;      // half width of the wave, in logo widths

        private readonly Graphic[] graphics;
        private readonly RectTransform[] rects;
        private readonly Vector2[] basePos;
        private readonly int[] piece;          // piece index per graphic (intro order)
        private readonly float[] glintU;       // 0..1 across the logo per graphic; < 0 = never glints (the slab)
        private readonly Color[] baseColor;
        private readonly int pieceCount;

        private float introT = float.MaxValue;
        private bool introDone = true;
        private float glintClock = MenuTokens.GlintDuration;   // first wave one period after landing
        private bool glintActive;

        /// <summary>Root rect of the logo (top-left anchored).</summary>
        public RectTransform Root { get; }

        /// <summary>Builds the logo under <paramref name="parent"/>, at rest (fully visible).</summary>
        public MenuLogo(MenuContext ctx, Transform parent)
        {
            MenuAssets a = ctx.Assets;
            var topLeft = new Vector2(0f, 1f);
            var center = new Vector2(0.5f, 0.5f);

            if (a.HasLogo)
            {
                float s = MenuTokens.LogoCapHeight / (a.LogoCapTop - a.LogoCapBottom);
                Vector2 box = a.LogoBox * s;
                float boxTop = -MenuTokens.LogoCapTop + (a.LogoBox.y - a.LogoCapTop) * s;
                Root = HudFactory.CreateRect("Logo", parent, topLeft, topLeft, new Vector2(MenuTokens.MarginLeft, boxTop), box);

                LogoGlyph[] glyphs = a.Logo;
                int n = glyphs.Length;
                graphics = new Graphic[n];
                rects = new RectTransform[n];
                basePos = new Vector2[n];
                piece = new int[n];
                glintU = new float[n];
                baseColor = new Color[n];

                // Intro order: the letters left to right, then the T (slab and helmet together) as the last piece.
                var letters = new List<int>(n);
                for (int i = 0; i < n; i++)
                {
                    if (!IsT(glyphs[i].Key))
                    {
                        letters.Add(i);
                    }
                }
                letters.Sort((x, y) => glyphs[x].Rect.xMin.CompareTo(glyphs[y].Rect.xMin));
                for (int k = 0; k < letters.Count; k++)
                {
                    piece[letters[k]] = k;
                }
                pieceCount = letters.Count;
                bool hasT = false;
                for (int i = 0; i < n; i++)
                {
                    if (IsT(glyphs[i].Key))
                    {
                        piece[i] = letters.Count;
                        hasT = true;
                    }
                }
                if (hasT)
                {
                    pieceCount++;
                }

                for (int i = 0; i < n; i++)
                {
                    LogoGlyph g = glyphs[i];
                    bool slab = g.Key == SlabKey;
                    Color c = slab ? MenuTokens.Slab : MenuTokens.Bronze;
                    Vector2 pos = new Vector2(g.Rect.center.x * s, g.Rect.center.y * s);
                    Image img = HudFactory.CreateImage("Glyph_" + g.Key, Root, g.Sprite, c, Vector2.zero, center, pos,
                                                       new Vector2(g.Rect.width * s, g.Rect.height * s));
                    graphics[i] = img;
                    rects[i] = img.rectTransform;
                    basePos[i] = pos;
                    baseColor[i] = c;
                    glintU[i] = slab ? -1f : Mathf.Clamp01(g.Rect.center.x / Mathf.Max(1f, a.LogoBox.x));
                }
            }
            else
            {
                float top = -MenuTokens.LogoCapTop + FallbackSize * FallbackCapOffset;
                Root = HudFactory.CreateRect("Logo", parent, topLeft, topLeft, new Vector2(MenuTokens.MarginLeft, top),
                                             new Vector2(FallbackSize * 4f, FallbackSize * 1.3f));
                Text word = MenuUi.Label("Word", Root, a.Bold, FallbackSize, MenuTokens.Bronze, TextAnchor.UpperLeft,
                                         topLeft, topLeft, Vector2.zero, Root.sizeDelta, "MARVIS");
                graphics = new Graphic[] { word };
                rects = new[] { word.rectTransform };
                basePos = new[] { Vector2.zero };
                piece = new[] { 0 };
                glintU = new[] { 0.5f };
                baseColor = new[] { MenuTokens.Bronze };
                pieceCount = 1;
            }
            Apply();
        }

        private static bool IsT(string key)
        {
            return key == SlabKey || key == HelmetKey;
        }

        /// <summary>True while the intro is still running.</summary>
        public bool IntroRunning => !introDone;

        /// <summary>Time from <see cref="BeginIntro"/> until the last piece has landed, seconds.</summary>
        public float IntroLength => MenuTokens.IntroLogoDelay + Mathf.Max(0, pieceCount - 1) * MenuTokens.StaggerLetter
                                  + MenuTokens.Dur(MenuTokens.DurIntroLetter);

        /// <summary>Hides every piece and starts the boot intro.</summary>
        public void BeginIntro()
        {
            introT = 0f;
            introDone = false;
            glintActive = false;
            glintClock = MenuTokens.GlintDuration;
            Apply();
        }

        /// <summary>Jumps the intro to its end state.</summary>
        public void FinishIntro()
        {
            if (introDone)
            {
                return;
            }
            introT = float.MaxValue;
            Apply();
        }

        /// <summary>Advances the intro and the idle glint. Allocation-free.</summary>
        public void Tick(float dt)
        {
            if (!introDone)
            {
                introT += dt;
                Apply();
                return;
            }

            if (MenuTokens.ReducedMotion)
            {
                if (glintActive)
                {
                    glintActive = false;
                    Apply();
                }
                return;
            }

            glintClock += dt;
            if (glintClock >= MenuTokens.GlintPeriod)
            {
                glintClock -= MenuTokens.GlintPeriod;
            }
            bool active = glintClock < MenuTokens.GlintDuration;
            if (active || glintActive)
            {
                glintActive = active;
                Apply();
            }
        }

        private void Apply()
        {
            bool reduced = MenuTokens.ReducedMotion;
            float dur = MenuTokens.Dur(MenuTokens.DurIntroLetter);
            bool allLanded = true;

            // Wave centre runs from just left of the logo to just right of it over GlintDuration.
            float wave = glintActive ? glintClock / MenuTokens.GlintDuration : -1f;
            float waveCenter = Mathf.Lerp(-GlintHalfWidth, 1f + GlintHalfWidth, wave);

            for (int i = 0; i < graphics.Length; i++)
            {
                float e = 1f;
                if (!introDone)
                {
                    float start = MenuTokens.IntroLogoDelay + piece[i] * MenuTokens.StaggerLetter;
                    float t = dur > 0f ? Mathf.Clamp01((introT - start) / dur) : 1f;
                    e = MenuTokens.EaseOut(t);
                    if (t < 1f)
                    {
                        allLanded = false;
                    }
                }

                Color c = baseColor[i];
                if (glintActive && glintU[i] >= 0f)
                {
                    float d = Mathf.Abs(glintU[i] - waveCenter) / GlintHalfWidth;
                    float w = d < 1f ? Mathf.SmoothStep(1f, 0f, d) : 0f;
                    c = Color.Lerp(c, MenuTokens.BronzeBright, MenuTokens.GlintBoost * w);
                }
                c.a *= e;
                graphics[i].color = c;

                float rise = reduced ? 0f : (1f - e) * MenuTokens.IntroLetterRise;
                rects[i].anchoredPosition = basePos[i] - new Vector2(0f, rise);
            }

            if (!introDone && allLanded)
            {
                introDone = true;
                glintClock = MenuTokens.GlintDuration;
            }
        }
    }
}

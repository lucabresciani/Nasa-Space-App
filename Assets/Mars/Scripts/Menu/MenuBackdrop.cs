using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// The two bottom layers of the menu: the slowly drifting star strip (full screen) and the spinning Mars globe on
    /// the right. Both are RawImages with their own material instances, animated from <see cref="Tick"/> in unscaled
    /// time. Missing shader or texture: a flat <see cref="MenuTokens.Void"/> backdrop, and no planet.
    /// </summary>
    public sealed class MenuBackdrop
    {
        // ---- tunables (the lead tunes these against the mockup)
        // Star window (Marvis/TitleBackdrop).
        private const float StarZoom = 0.62f;          // strip height fraction covered by the screen height
        private const float StarTilt = -0.14f;         // window rotation, radians
        private const float StarVCenter = 0.47f;       // strip v at the screen centre
        private const float StarTwinkle = 0.3f;        // 0 under reduced motion
        private const float StarVignette = 0.35f;
        private const float StarInitialScroll = 0f;    // u at the screen centre when the menu is built
        // Planet orientation: q = Euler(0, 0, lean) * Euler(tilt, 0, 0) * AngleAxis(spin, up) maps planet -> view.
        private const float PlanetTilt = 18f;          // degrees, + = north pole toward the viewer
        private const float PlanetLean = -14f;         // degrees of roll in the screen plane
        private const float PlanetInitialSpin = 70f;   // degrees; 70 puts Valles Marineris (~70 W) near the disc centre
        private const float ReducedSpinFactor = 0.5f;  // spin speed multiplier under reduced motion
        private static readonly Vector3 SunDirection = new Vector3(0.45f, 0.38f, 0.81f).normalized; // view space

        private const float TimeWrap = 3600f;

        private readonly RectTransform canvasRect;
        private readonly RawImage stars;
        private readonly Material starMaterial;
        private readonly RawImage planet;
        private readonly Material planetMaterial;
        private readonly RectTransform planetRect;
        private readonly Vector2 planetPos;

        private float scroll = StarInitialScroll;
        private float spin = PlanetInitialSpin;
        private float lastAspect = -1f;
        private float planetIntroT = float.MaxValue;
        private bool planetIntroDone = true;

        /// <summary>True when the planet layer exists (shader and colour map present).</summary>
        public bool HasPlanet => planet != null;

        /// <summary>Builds the star layer and then the planet layer as the next two children of <paramref name="parent"/>.</summary>
        public MenuBackdrop(MenuContext ctx, Transform parent)
        {
            canvasRect = ctx.CanvasRect;
            MenuAssets a = ctx.Assets;

            // 1. Stars.
            if (a.BackdropShader != null && a.StarStrip != null)
            {
                RectTransform rt = HudFactory.CreateStretch("Backdrop", parent);
                stars = rt.gameObject.AddComponent<RawImage>();
                stars.raycastTarget = false;
                stars.texture = a.StarStrip;
                starMaterial = new Material(a.BackdropShader) { name = "MarvisBackdrop (menu)", hideFlags = HideFlags.DontSave };
                starMaterial.SetFloat(MenuShader.Zoom, StarZoom);
                starMaterial.SetFloat(MenuShader.Tilt, StarTilt);
                starMaterial.SetFloat(MenuShader.VCenter, StarVCenter);
                starMaterial.SetFloat(MenuShader.Vignette, StarVignette);
                stars.material = starMaterial;
            }
            else
            {
                RectTransform rt = HudFactory.CreateStretch("Backdrop", parent);
                Image flat = rt.gameObject.AddComponent<Image>();
                flat.color = MenuTokens.Void;
                flat.raycastTarget = false;
            }

            // 2. Planet.
            if (a.PlanetShader != null && a.MarsColor != null)
            {
                float size = MenuTokens.PlanetDiameter / MenuTokens.PlanetDiscFraction;
                planetPos = new Vector2(-MenuTokens.PlanetCenterFromRight, -MenuTokens.PlanetCenterBelowMiddle);
                planetRect = HudFactory.CreateRect("Planet", parent, new Vector2(1f, 0.5f), new Vector2(0.5f, 0.5f),
                                                   planetPos, new Vector2(size, size));
                planet = planetRect.gameObject.AddComponent<RawImage>();
                planet.raycastTarget = false;
                planet.texture = a.MarsColor;
                planetMaterial = new Material(a.PlanetShader) { name = "MarvisPlanet (menu)", hideFlags = HideFlags.DontSave };
                if (a.MarsNormal != null)
                {
                    planetMaterial.SetTexture(MenuShader.NormalTex, a.MarsNormal);
                }
                else
                {
                    planetMaterial.SetFloat(MenuShader.NormalStrength, 0f);
                }
                planetMaterial.SetFloat(MenuShader.DiscFraction, MenuTokens.PlanetDiscFraction);
                planetMaterial.SetVector(MenuShader.SunDir, SunDirection);
                planet.material = planetMaterial;
                ApplyRotation();
            }

            Tick(0f);
        }

        /// <summary>Starts the planet's boot intro (fade, slide in from the right, scale down to 1).</summary>
        public void BeginIntro()
        {
            if (planet == null)
            {
                return;
            }
            planetIntroT = 0f;
            planetIntroDone = false;
            ApplyPlanetIntro();
        }

        /// <summary>Jumps the planet intro to its end state.</summary>
        public void FinishIntro()
        {
            if (planetIntroDone)
            {
                return;
            }
            planetIntroT = float.MaxValue;
            ApplyPlanetIntro();
        }

        /// <summary>Advances drift, twinkle time, spin and the planet intro. Allocation-free.</summary>
        public void Tick(float dt)
        {
            bool reduced = MenuTokens.ReducedMotion;

            if (starMaterial != null)
            {
                Rect r = canvasRect.rect;
                float aspect = r.height > 1f ? r.width / r.height : MenuTokens.RefWidth / MenuTokens.RefHeight;
                if (aspect != lastAspect)
                {
                    lastAspect = aspect;
                    starMaterial.SetFloat(MenuShader.Aspect, aspect);
                }
                if (!reduced)
                {
                    scroll += dt / MenuTokens.BackdropLoopSeconds;
                    if (scroll >= 1f)
                    {
                        scroll -= 1f;
                    }
                }
                starMaterial.SetFloat(MenuShader.Scroll, scroll);
                starMaterial.SetFloat(MenuShader.UnscaledTime, Time.unscaledTime % TimeWrap);
                starMaterial.SetFloat(MenuShader.Twinkle, reduced ? 0f : StarTwinkle);
            }

            if (planetMaterial != null)
            {
                float speed = 360f / MenuTokens.PlanetRevolutionSeconds * (reduced ? ReducedSpinFactor : 1f);
                spin += speed * dt;
                if (spin >= 360f)
                {
                    spin -= 360f;
                }
                ApplyRotation();

                if (!planetIntroDone)
                {
                    planetIntroT += dt;
                    ApplyPlanetIntro();
                }
            }
        }

        private void ApplyRotation()
        {
            Quaternion q = Quaternion.Euler(0f, 0f, PlanetLean) * Quaternion.Euler(PlanetTilt, 0f, 0f)
                         * Quaternion.AngleAxis(spin, Vector3.up);
            Matrix4x4 m = Matrix4x4.Rotate(Quaternion.Inverse(q));
            planetMaterial.SetVector(MenuShader.RotX, m.GetRow(0));
            planetMaterial.SetVector(MenuShader.RotY, m.GetRow(1));
            planetMaterial.SetVector(MenuShader.RotZ, m.GetRow(2));
        }

        private void ApplyPlanetIntro()
        {
            float dur = MenuTokens.Dur(MenuTokens.DurIntroPlanet);
            float t = dur > 0f ? Mathf.Clamp01(planetIntroT / dur) : 1f;
            float e = MenuTokens.EaseOut(t);
            planet.color = new Color(1f, 1f, 1f, e);
            if (MenuTokens.ReducedMotion)
            {
                planetRect.anchoredPosition = planetPos;
                planetRect.localScale = Vector3.one;
            }
            else
            {
                planetRect.anchoredPosition = planetPos + new Vector2((1f - e) * MenuTokens.IntroPlanetSlide, 0f);
                float s = Mathf.Lerp(MenuTokens.IntroPlanetScale, 1f, e);
                planetRect.localScale = new Vector3(s, s, 1f);
            }
            if (t >= 1f)
            {
                planetIntroDone = true;
            }
        }

        /// <summary>Destroys the material instances.</summary>
        public void Dispose()
        {
            if (starMaterial != null)
            {
                Object.Destroy(starMaterial);
            }
            if (planetMaterial != null)
            {
                Object.Destroy(planetMaterial);
            }
        }
    }
}

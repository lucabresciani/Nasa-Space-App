using System;
using UnityEngine;
using UnityEngine.InputSystem;

namespace NasaSpaceApp
{
    /// <summary>
    /// Day/night cycle for the Mars scene. Moves the sun along its daily arc and derives everything else
    /// from the sun's elevation: the sky (NasaSpaceApp/Mars Sky shader), ambient light, fog, reflections
    /// and the tint of unlit effects. Martian twilight is long, and the sky around a setting sun turns blue.
    ///
    /// Press <see cref="skipKey"/> (N) to glide forward to the next moment: dawn, noon, dusk, night.
    /// The glide runs on two critically damped springs in series, so it starts and lands softly and
    /// a press mid-glide extends it without a jolt. Time also flows on its own (<see cref="solDuration"/>),
    /// and in edit mode the Time Of Day slider previews any moment.
    ///
    /// Weather never writes the sun, fog or sky itself: it publishes <see cref="AtmosphereModifiers"/> through
    /// <see cref="MarsAtmosphere"/> and this component folds them in, so there is a single writer and values are
    /// always derived from serialized baselines, never read back (no compounding in edit mode). Without weather
    /// the modifiers are the identity and the output is bit-identical to clear weather.
    /// </summary>
    [ExecuteAlways, DisallowMultipleComponent]
    public class DayNightCycle : MonoBehaviour
    {
        [Serializable]
        public struct SkyLook
        {
            [Tooltip("Sky colour at the horizon. Also the fog colour, so distant terrain melts into the sky.")]
            public Color horizon;
            public Color zenith;
            public Color ambientSky;
            public Color ambientEquator;
            public Color ambientGround;
            [Tooltip("Multiplies unlit effects (e.g. the dust motes) so they don't glow in the dark.")]
            public Color unlitTint;
            [Range(0f, 1f)] public float reflections;

            public static SkyLook Lerp(SkyLook a, SkyLook b, float t) => new SkyLook
            {
                horizon = Color.Lerp(a.horizon, b.horizon, t),
                zenith = Color.Lerp(a.zenith, b.zenith, t),
                ambientSky = Color.Lerp(a.ambientSky, b.ambientSky, t),
                ambientEquator = Color.Lerp(a.ambientEquator, b.ambientEquator, t),
                ambientGround = Color.Lerp(a.ambientGround, b.ambientGround, t),
                unlitTint = Color.Lerp(a.unlitTint, b.unlitTint, t),
                reflections = Mathf.Lerp(a.reflections, b.reflections, t),
            };
        }

        [Header("Time")]
        [SerializeField, Range(0f, 1f), Tooltip("Fraction of the sol: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset.")]
        float timeOfDay = 0.64f;
        [SerializeField, Min(0f), Tooltip("Real seconds for a full sol. 0 stops the clock (the skip key still works).")]
        float solDuration = 1200f;

        [Header("Skip To The Next Moment")]
        [SerializeField, Tooltip("Glides to the next moment of the sol: dawn, noon, dusk, night.")]
        Key skipKey = Key.N;
        [SerializeField, Min(0.2f), Tooltip("Roughly how long the glide takes, in seconds.")]
        float transitionDuration = 3f;

        [Header("Sun")]
        [SerializeField] Light sun;
        [SerializeField, Tooltip("Compass heading (degrees) where the sun rises; it sets on the opposite side.")]
        float sunriseAzimuth = 133f;
        [SerializeField, Range(5f, 85f), Tooltip("Sun elevation at noon (90 minus the latitude).")]
        float noonElevation = 58f;
        [SerializeField, Min(0f)] float sunIntensity = 1.5f;
        [SerializeField] Color sunColor = new Color(1f, 0.92f, 0.80f);
        [SerializeField, Tooltip("Sun colour when it touches the horizon.")]
        Color horizonSunColor = new Color(1f, 0.62f, 0.38f);

        [Header("Night Light")]
        [SerializeField, Min(0f), Tooltip("At night the sun light becomes a faint light from the opposite side of the sky, so the terrain keeps its shape.")]
        float nightLightIntensity = 0.35f;
        [SerializeField] Color nightLightColor = new Color(0.62f, 0.72f, 1f);

        // Baselines, not live values: weather scales these, and RenderSettings/the light are never read back.
        [Header("Clear-Weather Baseline")]
        // Clear Martian air sees tens of km: 2.1e-5 (exp²) leaves Mount Sharp's summit, ~48 km away, at ~36% contrast.
        [SerializeField, Min(0f), Tooltip("Exponential-squared fog density in clear weather. 2.1e-5 keeps ~36% contrast at 48 km (Mount Sharp). Dust raises it (MarsWeather fog floor).")]
        float fogDensity = 0.000021f;
        [SerializeField, Range(0f, 1f), Tooltip("Sun shadow strength in clear weather. Dust softens the shadows by scaling it.")]
        float shadowStrength = 0.92f;

        [Header("Look, Blended By Sun Elevation")]
        [SerializeField] SkyLook day = new SkyLook
        {
            horizon = new Color(0.74f, 0.55f, 0.41f),
            zenith = new Color(0.47f, 0.34f, 0.26f),
            ambientSky = new Color(0.52f, 0.42f, 0.36f),
            ambientEquator = new Color(0.46f, 0.36f, 0.29f),
            ambientGround = new Color(0.20f, 0.13f, 0.09f),
            unlitTint = Color.white,
            reflections = 1f,
        };
        [SerializeField] SkyLook twilight = new SkyLook
        {
            horizon = new Color(0.42f, 0.33f, 0.29f),
            zenith = new Color(0.18f, 0.16f, 0.18f),
            ambientSky = new Color(0.30f, 0.28f, 0.31f),
            ambientEquator = new Color(0.28f, 0.24f, 0.22f),
            ambientGround = new Color(0.10f, 0.08f, 0.07f),
            unlitTint = new Color(0.60f, 0.55f, 0.55f),
            reflections = 0.5f,
        };
        [SerializeField] SkyLook night = new SkyLook
        {
            horizon = new Color(0.075f, 0.07f, 0.08f),
            zenith = new Color(0.012f, 0.013f, 0.022f),
            ambientSky = new Color(0.19f, 0.21f, 0.29f),
            ambientEquator = new Color(0.14f, 0.15f, 0.20f),
            ambientGround = new Color(0.06f, 0.06f, 0.07f),
            unlitTint = new Color(0.16f, 0.16f, 0.20f),
            reflections = 0.08f,
        };

        [Header("Unlit Effects")]
        [SerializeField, Tooltip("Renderers whose unlit material colour (_BaseColor) follows the light level.")]
        Renderer[] unlitRenderers = Array.Empty<Renderer>();

        /// <summary>Current time as a fraction of the sol (0 midnight, 0.5 noon).</summary>
        public float TimeOfDay => Mathf.Repeat(current, 1f);

        /// <summary>True while gliding toward a moment picked with the skip key.</summary>
        public bool IsGliding => Mathf.Abs(target - current) > 1e-4f;

        // Sun elevation at the dawn and dusk moments: low and golden, with long shadows.
        const float GoldenHourElevation = 5f;

        static readonly int SunDirId = Shader.PropertyToID("_MarsSunDir");
        static readonly int HorizonId = Shader.PropertyToID("_MarsSkyHorizon");
        static readonly int ZenithId = Shader.PropertyToID("_MarsSkyZenith");
        static readonly int StarsId = Shader.PropertyToID("_MarsStars");
        static readonly int CelestialId = Shader.PropertyToID("_MarsCelestial");
        static readonly int AmbientId = Shader.PropertyToID("_MarsAmbient");
        static readonly int BaseColorId = Shader.PropertyToID("_BaseColor");

        // Time in sols, not wrapped. 'follow' chases 'target' and 'current' chases 'follow'.
        float target, follow, current;
        float followVelocity, currentVelocity;
        bool snapPending;
        int appliedVersion; // the MarsAtmosphere.Version the last Apply used
        MaterialPropertyBlock block;

        void Reset() => sun = GetComponent<Light>();

        void OnEnable()
        {
            SnapTo(timeOfDay);
            Apply();
        }

        void OnValidate()
        {
            // Applied from Update: lights can't be switched on or off from inside OnValidate.
            // In play mode only a moved slider jumps; other edits must not cut a glide short.
            snapPending = !Application.isPlaying || !Mathf.Approximately(timeOfDay, TimeOfDay);
#if UNITY_EDITOR
            if (!Application.isPlaying) UnityEditor.EditorApplication.QueuePlayerLoopUpdate();
#endif
        }

        void Update()
        {
            bool snapped = snapPending;
            if (snapPending)
            {
                snapPending = false;
                SnapTo(timeOfDay);
            }

            if (Application.isPlaying)
            {
                Tick(Time.deltaTime);
                Apply();
            }
            else if (snapped || appliedVersion != MarsAtmosphere.Version)
            {
                Apply(); // edit mode: only on a slider snap or when the weather publishes something new
            }
        }

        /// <summary>Glides to the next moment of the sol after the one already being headed for.</summary>
        public void SkipToNextMoment()
        {
            float golden = GoldenHourOffset();
            float from = target + 0.01f; // a moment less than ~15 minutes away counts as reached
            float sol = Mathf.Floor(from);
            float next = float.MaxValue;
            foreach (float moment in new[] { 0f, 0.25f + golden, 0.5f, 0.75f - golden })
            {
                float t = sol + moment;
                if (t <= from) t += 1f;
                next = Mathf.Min(next, t);
            }
            if (next - current <= 1f) target = next; // mashing the key never queues more than a sol
        }

        /// <summary>Re-applies the current time to the sun, sky, ambient light and fog.</summary>
        public void Refresh() => Apply();

        void Tick(float dt)
        {
            Keyboard keyboard = Keyboard.current;
            if (keyboard != null && skipKey != Key.None && keyboard[skipKey].wasPressedThisFrame) SkipToNextMoment();

            float flow = solDuration > 0f ? dt / solDuration : 0f;
            target += flow;
            follow += flow;
            current += flow;

            // Two critically damped springs in series settle (~99%) in about transitionDuration.
            float smoothTime = transitionDuration / 5f;
            follow = Mathf.SmoothDamp(follow, target, ref followVelocity, smoothTime, Mathf.Infinity, dt);
            current = Mathf.SmoothDamp(current, follow, ref currentVelocity, smoothTime, Mathf.Infinity, dt);

            if (current >= 1f) // keep the numbers small; all three shift together
            {
                float whole = Mathf.Floor(current);
                target -= whole;
                follow -= whole;
                current -= whole;
            }
            timeOfDay = current;
        }

        void SnapTo(float time)
        {
            target = follow = current = Mathf.Repeat(time, 1f);
            followVelocity = currentVelocity = 0f;
        }

        // Fraction of a sol between sunrise and the sun standing GoldenHourElevation above the horizon.
        float GoldenHourOffset()
        {
            float s = Mathf.Sin(GoldenHourElevation * Mathf.Deg2Rad) / Mathf.Sin(noonElevation * Mathf.Deg2Rad);
            return Mathf.Asin(Mathf.Clamp01(s)) / (2f * Mathf.PI);
        }

        void Apply()
        {
            AtmosphereModifiers m = MarsAtmosphere.Modifiers;
            appliedVersion = MarsAtmosphere.Version;

            // The sky turns about the celestial pole: north, raised by the latitude above the horizon.
            float latitude = (90f - noonElevation) * Mathf.Deg2Rad;
            Vector3 sunrise = Quaternion.Euler(0f, sunriseAzimuth, 0f) * Vector3.forward;
            Vector3 north = Quaternion.Euler(0f, sunriseAzimuth - 90f, 0f) * Vector3.forward;
            Vector3 pole = north * Mathf.Cos(latitude) + Vector3.up * Mathf.Sin(latitude);
            Quaternion skyTurn = Quaternion.AngleAxis((TimeOfDay - 0.25f) * 360f, pole);
            Vector3 towardSun = skyTurn * sunrise;
            float h = towardSun.y; // sine of the sun's elevation

            if (sun != null)
            {
                // By night the same light shines from the opposite side of the sky, like a full moon.
                // Both are dark just after sunset, so the light swaps direction with no visible jump.
                bool isSun = h > -0.04f;
                float intensity = isSun
                    ? sunIntensity * Smooth(-0.03f, 0.2f, h)
                    : nightLightIntensity * Smooth(0.05f, 0.3f, -h);
                // Beer-Lambert (physics): the direct beam crosses 1/sin(elevation) air masses, so the extra dust
                // dims it by exp(-dtau / sin(elevation)); rovers measure tau this way, imaging the sun (Lemmon et al.
                // 2015, Icarus). The flat-layer air mass is capped at 20 near the horizon, where it would diverge.
                // The night light is dimmed the same way, so storm nights are darker too.
                intensity *= Mathf.Exp(-m.extraDustDepth / Mathf.Max(Mathf.Abs(h), 0.05f));
                sun.transform.rotation = Quaternion.LookRotation(isSun ? -towardSun : towardSun, Vector3.up);
                sun.color = isSun ? Color.Lerp(horizonSunColor, sunColor, Smooth(0.02f, 0.4f, h)) : nightLightColor;
                sun.intensity = intensity;
                sun.shadowStrength = shadowStrength * m.shadowScale;
                bool lit = intensity > 0.001f; // a switched-off light also skips its shadow pass
                if (sun.enabled != lit) sun.enabled = lit;
            }

            // Night until the sun is ~17° below the horizon, twilight at sunset, full day ~20° above it.
            SkyLook look = SkyLook.Lerp(night, twilight, Smooth(-0.30f, -0.02f, h));
            look = SkyLook.Lerp(look, day, Smooth(0f, 0.35f, h));
            look = ApplyWeather(look, m);

            RenderSettings.ambientSkyColor = look.ambientSky;
            RenderSettings.ambientEquatorColor = look.ambientEquator;
            RenderSettings.ambientGroundColor = look.ambientGround;
            RenderSettings.fogColor = look.horizon;
            RenderSettings.fogDensity = Mathf.Max(fogDensity * m.fogScale, m.fogFloor);
            RenderSettings.reflectionIntensity = look.reflections; // the baked reflection is a daytime sky

            // Sky colours go as raw vectors (gamma space): the shader blends them like the old baked sky did.
            Shader.SetGlobalVector(SunDirId, towardSun);
            Shader.SetGlobalVector(HorizonId, (Vector4)look.horizon);
            Shader.SetGlobalVector(ZenithId, (Vector4)look.zenith);
            // Dust dims the stars too. Derived estimate, not a measurement: a typical star ~30° up crosses about
            // two air masses, hence exp(-2 tau).
            Shader.SetGlobalFloat(StarsId, (1f - Smooth(-0.25f, -0.02f, h)) * Mathf.Exp(-2f * m.extraDustDepth));
            Shader.SetGlobalMatrix(CelestialId, Matrix4x4.Rotate(Quaternion.Inverse(skyTurn)));
            // Linear on purpose (SetGlobalVector does no colour-space conversion): dust particles light themselves
            // with it instead of SampleSH, which renderers with light probes off may not get.
            Shader.SetGlobalVector(AmbientId, (Vector4)((look.ambientSky + look.ambientEquator) * 0.5f).linear);

            if (unlitRenderers != null && unlitRenderers.Length > 0)
            {
                block ??= new MaterialPropertyBlock();
                foreach (Renderer r in unlitRenderers)
                {
                    if (r == null) continue;
                    r.GetPropertyBlock(block);
                    block.SetColor(BaseColorId, look.unlitTint);
                    r.SetPropertyBlock(block);
                }
            }

            // Weather effects (dust devils, sky clouds) follow the same sun without finding this component.
            MarsAtmosphere.SunHeight = h;
            MarsAtmosphere.SunDirection = towardSun;
        }

        /// <summary>
        /// Folds the weather into a look. Pure, so it can be tested on its own. At
        /// <see cref="AtmosphereModifiers.Identity"/> every step is x1, +0 or Lerp(..., 0): the look is unchanged, bit for bit.
        /// The flattening and scaling coefficients come from MarsWeather and are derived estimates, not measurements.
        /// </summary>
        internal static SkyLook ApplyWeather(SkyLook look, in AtmosphereModifiers m)
        {
            // Dust scatters light all over the sky: the dome turns uniform and ochre, so the zenith goes toward the
            // (already tinted) horizon. fogColor stays equal to the horizon, so the terrain still melts into the sky.
            look.horizon = Tint(look.horizon, m.hazeTint);
            look.zenith = Color.Lerp(Tint(look.zenith, m.hazeTint), look.horizon, m.skyFlatten);

            // Diffuse light comes from every direction alike, so the trilight flattens toward its mean.
            Color mean = (look.ambientSky + look.ambientEquator + look.ambientGround) / 3f;
            look.ambientSky = FlattenAmbient(look.ambientSky, mean, m);
            look.ambientEquator = FlattenAmbient(look.ambientEquator, mean, m);
            look.ambientGround = FlattenAmbient(look.ambientGround, mean, m);

            look.reflections *= m.reflectionScale;
            look.unlitTint = Scale(look.unlitTint, m.unlitScale); // Color * float would scale alpha and fade the motes
            return look;
        }

        static Color FlattenAmbient(Color c, Color mean, in AtmosphereModifiers m) =>
            Scale(Tint(Color.Lerp(c, mean, m.ambientFlatten), m.hazeTint), m.ambientScale);

        // rgb only: alpha is not a colour here and must not drift with the weather.
        static Color Tint(Color c, Color tint) => new Color(c.r * tint.r, c.g * tint.g, c.b * tint.b, c.a);
        static Color Scale(Color c, float s) => new Color(c.r * s, c.g * s, c.b * s, c.a);

        static float Smooth(float from, float to, float x) => Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(from, to, x));
    }
}

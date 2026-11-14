using System;
using System.Globalization;
using UnityEngine;
using UnityEngine.InputSystem;

namespace NasaSpaceApp
{
    /// <summary>
    /// Day/night cycle for the Mars scene. Moves the sun along its daily arc and derives everything else
    /// from the sun's elevation: the sky (NasaSpaceApp/Mars Sky shader), ambient light, fog, reflections
    /// and the tint of unlit effects. Martian twilight is long, and the sky around a setting sun turns blue.
    ///
    /// With <see cref="realSky"/> on (the default) the sky is the real one over the scene's map coordinates
    /// (<see cref="MarsGeoReference"/>: Gale crater, the HOMELINE pad). Sol 0 is the local sol containing <see cref="startDateUtc"/>,
    /// Time Of Day is local true solar time (0.5 = the sun on the meridian), and <see cref="MarsEphemeris"/> gives the
    /// sun's direction and the orientation of the star field for that instant, so the sun rises and sets where and when
    /// it really does in that season. With it off, the sun follows the artistic path set by <see cref="sunriseAzimuth"/>
    /// and <see cref="noonElevation"/>, and the real star field turns with it, the sun at its true right ascension
    /// among the stars. Either way the clock and the sky's orientation go out through <see cref="MarsSkyState"/> and the
    /// shader global _MarsCelestial, for the night sky (stars, planets, moons) to read.
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
        [SerializeField, Range(0f, 1f), Tooltip("Fraction of the sol: 0 midnight, 0.5 noon. Real Sky: local true solar time (0.5 = the sun on the meridian), so sunrise and sunset are only about 0.25 and 0.75: they follow the season. Artistic: 0.25 sunrise, 0.75 sunset.")]
        float timeOfDay = 0.64f;
        [SerializeField, Min(0f), Tooltip("Real seconds for a full sol. 0 stops the clock (the skip key still works).")]
        float solDuration = 1200f;

        [Header("Skip To The Next Moment")]
        [SerializeField, Tooltip("Glides to the next moment of the sol: dawn, noon, dusk, night.")]
        Key skipKey = Key.N;
        [SerializeField, Min(0.2f), Tooltip("Roughly how long the glide takes, in seconds.")]
        float transitionDuration = 3f;

        [Header("Real Sky")]
        [SerializeField, Tooltip("Sun, stars, planets and moons from real ephemerides at the scene's map coordinates (MarsGeoReference). Off: the artistic sun path below, with the real star field turning around it.")]
        bool realSky = true;
        // Delayed: parsed when the field is committed (Enter or focus lost), not on every keystroke.
        [SerializeField, Delayed, Tooltip("Earth date (UTC) of sol 0: yyyy-MM-dd or yyyy-MM-ddTHH:mm. Sol 0 is the local sol whose true noon is nearest this instant: 12:00 UTC on 14 Nov 2026 is mid-morning at Gale, so sol 0 is that Earth day (00:00 UTC would be ~22:00 local and pick the 13th). Default: the HOMELINE event weekend, Ls ≈ 22, inside the REMS season window (Ls 10-35) the historical weather uses.")]
        string startDateUtc = "2026-11-14T12:00";
        [SerializeField, Tooltip("Observer latitude (x, degrees, south negative) and east longitude (y). Used only when the scene has no MarsGeoReference.")]
        Vector2 fallbackLatLon = new Vector2(-4.802f, 137.385f);

        [Header("Sun")]
        [SerializeField] Light sun;
        [SerializeField, Tooltip("Compass heading (degrees) where the sun rises; it sets on the opposite side. Artistic mode only (Real Sky off).")]
        float sunriseAzimuth = 133f;
        [SerializeField, Range(5f, 85f), Tooltip("Sun elevation at noon (90 minus the latitude). Artistic mode only (Real Sky off).")]
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

        /// <summary>Current time as a fraction of the sol (0 midnight, 0.5 noon; local true solar time with Real Sky on).</summary>
        public float TimeOfDay => Mathf.Repeat(current, 1f);

        /// <summary>True while gliding toward a moment picked with the skip key.</summary>
        public bool IsGliding => Mathf.Abs(target - current) > 1e-4f;

        // Sun elevation at the dawn and dusk moments: low and golden, with long shadows.
        const float GoldenHourElevation = 5f;

        const double DegToRad = Math.PI / 180.0;

        // Observer radius without a MarsGeoReference: the maps' 3396.19 km sphere plus the HOMELINE pad's MOLA
        // elevation, -3643 m (MarsLandscape's geo-reference datum).
        const double FallbackRadiusKm = 3392.5;

        // Used when startDateUtc does not parse. The HOMELINE event weekend; Mars is at Ls ~22 then.
        static readonly DateTime DefaultStartDate = new DateTime(2026, 11, 14, 12, 0, 0, DateTimeKind.Utc);

        static readonly int SunDirId = Shader.PropertyToID("_MarsSunDir");
        static readonly int HorizonId = Shader.PropertyToID("_MarsSkyHorizon");
        static readonly int ZenithId = Shader.PropertyToID("_MarsSkyZenith");
        static readonly int StarsId = Shader.PropertyToID("_MarsStars");
        static readonly int SkyDarkId = Shader.PropertyToID("_MarsSkyDark");
        static readonly int CelestialId = Shader.PropertyToID("_MarsCelestial");
        static readonly int AmbientId = Shader.PropertyToID("_MarsAmbient");
        static readonly int BaseColorId = Shader.PropertyToID("_BaseColor");

        // Time in sols, not wrapped. 'follow' chases 'target' and 'current' chases 'follow'.
        float target, follow, current;
        float followVelocity, currentVelocity;
        bool snapPending;
        int appliedVersion; // the MarsAtmosphere.Version the last Apply used
        MaterialPropertyBlock block;

        // Whole sols since the start date. Runtime only: enabling starts again at sol 0, and the slider (SnapTo) moves
        // within the sol without changing it; only the clock running past midnight (Tick's wrap) advances it.
        int sol;

        // The observing site (the world origin, i.e. the spawn): latitude and east longitude in degrees, distance from
        // Mars's centre in km. From MarsGeoReference, else fallbackLatLon.
        bool siteResolved;
        double siteLatitude, siteLongitude, siteRadiusKm;

        // startDateUtc as parsed, redone only when the text changes, so a bad date warns once.
        string parsedStartText;
        DateTime startDate = DefaultStartDate;

        // True noon of sol 0 and of the current sol, and the sun's declination at the latter. LocalTrueNoon iterates the
        // ephemeris, so these are recomputed only when their key (start date, longitude, sol) changes.
        bool firstNoonValid, noonValid;
        DateTime noonKeyStart;
        double noonKeyLongitude;
        int noonKeySol;
        double firstNoonDays, noonDays, noonDeclination;

        void Reset() => sun = GetComponent<Light>();

        void OnEnable()
        {
            sol = 0;
            siteResolved = false;
            SnapTo(timeOfDay);
            Apply();
        }

        void OnValidate()
        {
            // Applied from Update: lights can't be switched on or off from inside OnValidate.
            // In play mode only a moved slider jumps; other edits must not cut a glide short.
            snapPending = !Application.isPlaying || !Mathf.Approximately(timeOfDay, TimeOfDay);
            siteResolved = false; // the fallback coordinates may have changed
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
            float golden = GoldenHalfArc();
            float from = target + 0.01f; // a moment less than ~15 minutes away counts as reached
            float solFloor = Mathf.Floor(from);
            float next = float.MaxValue;
            // Midnight, dawn (the sun 5° up in the morning), true noon, dusk (5° up in the evening).
            foreach (float moment in new[] { 0f, 0.5f - golden, 0.5f, 0.5f + golden })
            {
                float t = solFloor + moment;
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
                sol += (int)whole; // past midnight: the sky's date moves on with it
            }
            timeOfDay = current;
        }

        void SnapTo(float time)
        {
            target = follow = current = Mathf.Repeat(time, 1f);
            followVelocity = currentVelocity = 0f;
        }

        // Fraction of a sol between true noon and the sun standing GoldenHourElevation above the horizon: the hour angle
        // of an elevation h, cos H = (sin h - sin(lat) sin(dec)) / (cos(lat) cos(dec)), as a fraction of a turn.
        // Real sky: the site's latitude and the sun's declination at this sol's noon (it moves < 0.5° a sol).
        // Artistic: the sun stays on the celestial equator (dec 0) at latitude 90 - noonElevation, which gives the old
        // moments exactly: 0.5 -/+ acos(x) / 2 pi = 0.25 + asin(x) / 2 pi and 0.75 - asin(x) / 2 pi, x = sin 5° / sin noonElevation.
        // Clamped: where the sun never reaches 5° (or never drops below it) dawn and dusk merge with noon (or midnight).
        float GoldenHalfArc()
        {
            double latitude, declination;
            if (realSky)
            {
                EnsureSite();
                NoonDays();
                latitude = siteLatitude;
                declination = noonDeclination;
            }
            else
            {
                latitude = 90.0 - noonElevation;
                declination = 0.0;
            }
            double lat = latitude * DegToRad, dec = declination * DegToRad;
            double cosH = (Math.Sin(GoldenHourElevation * DegToRad) - Math.Sin(lat) * Math.Sin(dec))
                / Math.Max(Math.Cos(lat) * Math.Cos(dec), 1e-9); // the floor only matters at a pole
            return (float)(Math.Acos(Math.Clamp(cosH, -1.0, 1.0)) / (2.0 * Math.PI));
        }

        void Apply()
        {
            AtmosphereModifiers m = MarsAtmosphere.Modifiers;
            appliedVersion = MarsAtmosphere.Version;

            EnsureSite();
            double days = InstantDays();
            Vector3 towardSun;
            // ICRF -> world. Improper (determinant -1, see MarsSkyState), so a matrix and never a Quaternion.
            Matrix4x4 celestialToWorld;
            if (realSky)
            {
                // The real sky over the site: the ephemeris turns ICRF into the local east/up/north frame (IAU rotation
                // model of Mars), and the sun and the stars go through the same matrix, so they can never drift apart.
                DMat3 icrfToUnity = MarsEphemeris.IcrfToUnity(days, siteLatitude, siteLongitude);
                DVec3 sunDir = icrfToUnity * MarsEphemeris.MarsCentricIcrf(SkyBody.Sun, days).Normalized;
                towardSun = new Vector3((float)sunDir.X, (float)sunDir.Y, (float)sunDir.Z);
                celestialToWorld = ToMatrix(icrfToUnity);
            }
            else
            {
                // The sky turns about the celestial pole: north, raised by the latitude above the horizon.
                float latitude = (90f - noonElevation) * Mathf.Deg2Rad;
                Vector3 sunrise = Quaternion.Euler(0f, sunriseAzimuth, 0f) * Vector3.forward;
                Vector3 north = Quaternion.Euler(0f, sunriseAzimuth - 90f, 0f) * Vector3.forward;
                Vector3 pole = north * Mathf.Cos(latitude) + Vector3.up * Mathf.Sin(latitude);
                Quaternion skyTurn = Quaternion.AngleAxis((TimeOfDay - 0.25f) * 360f, pole);
                towardSun = skyTurn * sunrise;
                // The real stars ride the same turn: set as they stand at this sol's sunrise, then carried with the sun.
                celestialToWorld = Matrix4x4.Rotate(skyTurn) * ArtisticSunriseSky(days, sunrise, pole);
            }
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
                // The real sun can pass within a hair of the zenith at Gale (its declination spans +/-25°, the site is at
                // 4.8° S), where an up hint of Vector3.up would be parallel to the beam; any up serves a directional light.
                // The artistic sun never climbs above 85°, so it always takes the Vector3.up branch.
                Vector3 beam = isSun ? -towardSun : towardSun;
                sun.transform.rotation = Quaternion.LookRotation(beam, Mathf.Abs(beam.y) < 0.9999f ? Vector3.up : Vector3.forward);
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
            // How dark the sky is from the sun's elevation alone: 0 by day, 1 once the sun is ~14° down. Artistic ramp.
            float darkness = 1f - Smooth(-0.25f, -0.02f, h);
            // Dust dims the stars too. Derived estimate, not a measurement: a typical star ~30° up crosses about
            // two air masses, hence exp(-2 tau). (The sky shader's Milky Way glow uses this.)
            Shader.SetGlobalFloat(StarsId, darkness * Mathf.Exp(-2f * m.extraDustDepth));
            // The same darkness without the dust term, for the star and planet sprites: they dim each point by its own
            // air mass (MarsExtinction, Beer-Lambert), so a dust factor here would count the dust twice.
            Shader.SetGlobalFloat(SkyDarkId, darkness);
            // World -> ICRF. The transpose is the inverse: the matrix is orthogonal, improper or not.
            Shader.SetGlobalMatrix(CelestialId, celestialToWorld.transpose);
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
            // The night sky (stars, planets, moons, labels) reads the clock and the orientation the same way.
            MarsSkyState.Publish(realSky, days, celestialToWorld, siteLatitude, siteLongitude, siteRadiusKm,
                sol, TimeOfDay, darkness, StartDate());
        }

        /// <summary>
        /// ICRF -> world for the artistic sky at its sunrise (Time Of Day 0.25, before skyTurn): Mars's north pole p goes
        /// to the artistic celestial pole and the sun's direction s, projected on Mars's equator, to the sunrise point,
        /// so the sun keeps its true right ascension among the stars (its declination is not kept: the artistic sun
        /// stays on the celestial equator). B = F E^T with orthonormal columns E = (e1, e2 = p x e1, p) in ICRF
        /// (right-handed) and F = (sunrise, f2, pole) in world, f2 = Vector3.Cross(sunrise, pole): the physical
        /// pole x sunrise, since Unity's (east, up, north) frame is left-handed. So B, like the real map, has
        /// determinant -1 and the constellations are not mirrored.
        /// </summary>
        static Matrix4x4 ArtisticSunriseSky(double days, Vector3 sunrise, Vector3 pole)
        {
            DVec3 p = MarsEphemeris.MarsPoleIcrf(days);
            DVec3 s = MarsEphemeris.MarsCentricIcrf(SkyBody.Sun, days).Normalized;
            DVec3 e1 = (s - p * DVec3.Dot(s, p)).Normalized; // never degenerate: the sun stays within ~25° of the equator
            DVec3 e2 = DVec3.Cross(p, e1);
            Vector3 f2 = Vector3.Cross(sunrise, pole);
            // Row i of F E^T = sum over k of F[i, k] * (column k of E)^T.
            return ToMatrix(DMat3.FromRows(
                e1 * sunrise.x + e2 * f2.x + p * pole.x,
                e1 * sunrise.y + e2 * f2.y + p * pole.y,
                e1 * sunrise.z + e2 * f2.z + p * pole.z));
        }

        // DMat3 (row-major, double) as a float Matrix4x4 without translation; mRC is row R, column C in both.
        static Matrix4x4 ToMatrix(in DMat3 d)
        {
            Matrix4x4 r = Matrix4x4.identity;
            r.m00 = (float)d.M00; r.m01 = (float)d.M01; r.m02 = (float)d.M02;
            r.m10 = (float)d.M10; r.m11 = (float)d.M11; r.m12 = (float)d.M12;
            r.m20 = (float)d.M20; r.m21 = (float)d.M21; r.m22 = (float)d.M22;
            return r;
        }

        // The instant shown, in days since J2000 TT, such that Time Of Day is local true solar time: the sun's hour angle
        // is (TimeOfDay - 0.5) * 360°. First guess: this sol's true noon plus the offset at the mean sol length. That is
        // exact at noon, but true sols run up to ~45 s longer or shorter than the mean one (the equation of time drifts),
        // so on its own it would make the sky hop by up to ~0.18° at every midnight wrap (~3 px at 1080p). A Newton
        // step on the hour angle (which turns at 360° a sol to within 0.05%) removes that: both sides of midnight then
        // solve for the same instant (hour angle 180°) and the wrap is seamless.
        double InstantDays()
        {
            double hourAngle = (TimeOfDay - 0.5) * 360.0;
            double days = NoonDays() + hourAngle / 360.0 * MarsEphemeris.SolDays;
            for (int i = 0; i < 3; i++)
            {
                double error = MarsEphemeris.SunHourAngleDeg(days, siteLongitude) - hourAngle;
                error -= 360.0 * Math.Floor((error + 180.0) / 360.0); // to [-180, 180): -180 and +180 are both midnight
                if (Math.Abs(error) < 1e-7) break; // two steps get there from anywhere in the sol
                days -= error / 360.0 * MarsEphemeris.SolDays;
            }
            return days;
        }

        // True noon of the current sol (days since J2000 TT); also refreshes noonDeclination.
        double NoonDays()
        {
            DateTime start = StartDate();
            if (!firstNoonValid || start != noonKeyStart || siteLongitude != noonKeyLongitude)
            {
                noonKeyStart = start;
                noonKeyLongitude = siteLongitude;
                // Sol 0's noon is the one nearest the start instant: sol 0 is the local sol (midnight to midnight, true
                // solar time at the site) that contains it. At Gale, 2026-11-14 00:00 UTC is about 22:00 local time.
                firstNoonDays = MarsEphemeris.LocalTrueNoon(MarsEphemeris.DaysTT(MarsEphemeris.JulianDateUtc(start)), siteLongitude);
                firstNoonValid = true;
                noonValid = false;
            }
            if (!noonValid || sol != noonKeySol)
            {
                noonKeySol = sol;
                // Searched from sol 0's noon rather than chained sol to sol, so no error builds up over a long session.
                noonDays = sol == 0
                    ? firstNoonDays
                    : MarsEphemeris.LocalTrueNoon(firstNoonDays + sol * MarsEphemeris.SolDays, siteLongitude);
                noonDeclination = MarsEphemeris.SunDeclinationDeg(noonDays);
                noonValid = true;
            }
            return noonDays;
        }

        DateTime StartDate()
        {
            if (startDateUtc == parsedStartText) return startDate;
            parsedStartText = startDateUtc;
            if (!DateTime.TryParse(startDateUtc, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out startDate))
            {
                startDate = DefaultStartDate;
                Debug.LogWarning($"DayNightCycle: Start Date Utc '{startDateUtc}' is not a date (yyyy-MM-dd or yyyy-MM-ddTHH:mm); using 2026-11-14.", this);
            }
            return startDate;
        }

        void EnsureSite()
        {
            // In edit mode the terrain tools can add or reconfigure the geo-reference at any time, and Apply is rare there.
            if (siteResolved && Application.isPlaying) return;
            siteResolved = true;
            MarsGeoReference geo = MarsGeoReference.Instance;
            if (geo != null)
            {
                // The observer stands at the world origin (the spawn): its map coordinates and its MOLA elevation.
                Vector2 latLon = geo.LatLon(Vector3.zero);
                siteLatitude = latLon.x;
                siteLongitude = latLon.y;
                siteRadiusKm = ((double)geo.PlanetRadius + geo.ElevationMOLA(Vector3.zero)) / 1000.0;
            }
            else
            {
                siteLatitude = fallbackLatLon.x;
                siteLongitude = fallbackLatLon.y;
                siteRadiusKm = FallbackRadiusKm;
            }
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

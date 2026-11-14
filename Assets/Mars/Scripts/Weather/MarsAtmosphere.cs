using UnityEngine;

namespace NasaSpaceApp
{
    /// <summary>The weather presets, in the order the M key cycles through them.</summary>
    public enum WeatherKind { Clear, IceClouds, DustDevils, DustyHaze, DustStorm }

    /// <summary>
    /// How the weather bends the look that <see cref="DayNightCycle"/> computes. DayNightCycle stays the only
    /// writer of the sun, ambient light, fog and sky globals and folds these in, so the two never fight.
    /// Every field has a neutral value (<see cref="Identity"/>) at which the output is bit-identical to clear weather.
    /// Note that <c>default</c> is NOT neutral (fogScale 0 would remove the fog): start from Identity.
    /// </summary>
    public struct AtmosphereModifiers
    {
        /// <summary>Dust optical depth above the clear-sky baseline (>= 0). Dims the direct sun by Beer-Lambert.</summary>
        public float extraDustDepth;
        /// <summary>Multiplies the clear-weather fog density (>= 1, so no state is clearer than today).</summary>
        public float fogScale;
        /// <summary>0..1: pulls the zenith colour toward the horizon colour (a flat, uniform dome).</summary>
        public float skyFlatten;
        /// <summary>Multiplies the sky and ambient colours (rgb only; alpha is ignored).</summary>
        public Color hazeTint;
        /// <summary>Multiplies the ambient trilight.</summary>
        public float ambientScale;
        /// <summary>0..1: pulls the three ambient colours toward their mean (diffuse light from every side).</summary>
        public float ambientFlatten;
        /// <summary>Multiplies the clear-weather sun shadow strength.</summary>
        public float shadowScale;
        /// <summary>Multiplies the reflection intensity (the baked reflection is a clear sky).</summary>
        public float reflectionScale;
        /// <summary>Multiplies the rgb of the unlit tint (alpha is kept, or the motes would fade out).</summary>
        public float unlitScale;

        /// <summary>No change: every operation becomes x1, +0 or Lerp(..., 0), which IEEE floats compute exactly.</summary>
        public static readonly AtmosphereModifiers Identity = new AtmosphereModifiers
        {
            extraDustDepth = 0f,
            fogScale = 1f,
            skyFlatten = 0f,
            hazeTint = Color.white,
            ambientScale = 1f,
            ambientFlatten = 0f,
            shadowScale = 1f,
            reflectionScale = 1f,
            unlitScale = 1f,
        };
    }

    /// <summary>
    /// The weather's current state for effects (particles, dust devils, sky, audio). Values are the sprung
    /// channels, already smooth; readers must not add their own jumps. <c>default</c> means calm and clear.
    /// </summary>
    public struct WeatherFrame
    {
        /// <summary>Total column dust optical depth tau. Rover sites outside storms see about 0.3-0.9 (Lemmon et al. 2015, Icarus).</summary>
        public float opticalDepth;
        /// <summary>tau above the clear baseline (>= 0): what makes the look differ from today's.</summary>
        public float extraDepth;
        /// <summary>0..1, how much this is a storm (drives the storm grading).</summary>
        public float stormAmount;
        /// <summary>Wind velocity in m/s on world X/Z (the direction the air moves toward), gusts included.</summary>
        public Vector2 wind;
        /// <summary>|wind| in m/s.</summary>
        public float windSpeed;
        /// <summary>0..1 gustiness.</summary>
        public float gust;
        /// <summary>0..1 dust lifted around the observer.</summary>
        public float localDust;
        /// <summary>0..1 distant rolling dust sheets.</summary>
        public float dustSheets;
        /// <summary>0..1 dust-devil activity. NOT gated by the sun: effects multiply by their own sun factor.</summary>
        public float devilActivity;
        /// <summary>0..1 water-ice cloud cover.</summary>
        public float iceClouds;
        /// <summary>Integrated cloud drift in km on world X/Z. Never wrapped, so a change of drift speed never jumps.</summary>
        public Vector2 cloudOffsetKm;
        /// <summary>Cloud layer altitude in km.</summary>
        public float cloudAltitudeKm;
        /// <summary>Weather clock in seconds (unwrapped; stops with Time.timeScale 0).</summary>
        public float clock;
        /// <summary>Seed for <see cref="MarsAtmosphere.Hash"/>, so the same seed gives the same weather.</summary>
        public uint seed;
    }

    /// <summary>
    /// Static hub between the weather and everything that renders it. MarsWeather publishes, DayNightCycle
    /// folds <see cref="Modifiers"/> into the lighting, effects read <see cref="Frame"/>.
    ///
    /// Readers poll <see cref="Version"/> instead of subscribing to an event: domain reload is disabled
    /// (Enter Play Mode Options), so statics and event subscriptions survive play sessions and would leak.
    /// <see cref="ResetStatics"/> returns everything to clear when play mode starts.
    /// </summary>
    public static class MarsAtmosphere
    {
        static readonly int DustId = Shader.PropertyToID("_MarsDust");
        static readonly int WindId = Shader.PropertyToID("_MarsWind");
        static readonly int CloudId = Shader.PropertyToID("_MarsCloud");

        static bool warnedSecondOwner;

        /// <summary>What DayNightCycle applies. <see cref="AtmosphereModifiers.Identity"/> without weather.</summary>
        public static AtmosphereModifiers Modifiers { get; private set; } = AtmosphereModifiers.Identity;

        /// <summary>The latest weather state; calm and clear without weather.</summary>
        public static WeatherFrame Frame { get; private set; }

        /// <summary>Changes whenever the published data changes (or is cleared). Poll it to know when to re-apply.</summary>
        public static int Version { get; private set; }

        /// <summary>The component allowed to publish. A second publisher is ignored while this one is alive and enabled.</summary>
        public static Object Owner { get; private set; }

        /// <summary>Sine of the sun's elevation (negative at night). Written by DayNightCycle every time it applies.</summary>
        public static float SunHeight = 0.5f;

        /// <summary>Unit vector toward the sun (below the horizon at night). Written by DayNightCycle.</summary>
        public static Vector3 SunDirection = new Vector3(0f, 0.5f, 0.8660254f);

        /// <summary>
        /// Publishes the weather. Ignored (with a one-time warning) while a different owner is alive and enabled.
        /// Also sets the shader globals, 0 meaning clear:
        /// _MarsDust = (extraDepth, stormAmount, localDust, gust), _MarsWind = (wind.x, wind.y, windSpeed, clock),
        /// _MarsCloud = (cloudOffsetKm.x, cloudOffsetKm.y, iceClouds, cloudAltitudeKm).
        /// </summary>
        public static void Publish(Object owner, in AtmosphereModifiers m, in WeatherFrame f)
        {
            if (!MayWrite(owner, true)) return;

            // Version moves only on real changes: an edit-mode publisher calling this every Update would
            // otherwise keep re-queueing the player loop and DayNightCycle would re-apply forever.
            bool changed = owner != Owner || !Same(m, Modifiers) || !Same(f, Frame);
            Owner = owner;
            Modifiers = m;
            Frame = f;
            SetGlobals(f);
            if (changed) Bump();
        }

        /// <summary>Back to clear (identity modifiers, calm frame, zeroed globals) and releases ownership.
        /// Ignored when a different owner is alive and enabled, so a rejected second publisher can't wipe the first.</summary>
        public static void Clear(Object owner)
        {
            if (!MayWrite(owner, false)) return;
            ResetState();
        }

        /// <summary>Deterministic, stateless 32-bit hash (no shared RNG state, identical on every runtime).
        /// Streams: 1 scheduler pick, 2 dwell, 3 devil spawn (index = serial * 8 + field), 4 gust noise, 5 heading wobble.</summary>
        public static uint Hash(uint seed, uint stream, uint index)
        {
            unchecked
            {
                uint x = seed ^ stream * 0x9E3779B9u ^ index * 0x85EBCA6Bu;
                x ^= x >> 16;
                x *= 0x7FEB352Du;
                x ^= x >> 15;
                x *= 0x846CA68Bu;
                x ^= x >> 16;
                return x;
            }
        }

        /// <summary><see cref="Hash"/> as a float in [0, 1), from its top 24 bits (exact in a float).</summary>
        public static float Hash01(uint seed, uint stream, uint index) => (Hash(seed, stream, index) >> 8) * (1f / 16777216f);

        // Domain reload is off, so the last session's weather, owner and globals would otherwise carry over.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            warnedSecondOwner = false;
            ResetState();
        }

        static void ResetState()
        {
            Owner = null;
            Modifiers = AtmosphereModifiers.Identity;
            Frame = default;
            SetGlobals(default);
            Bump();
        }

        static bool MayWrite(Object owner, bool warn)
        {
            if (owner == Owner || !IsAlive(Owner)) return true;
            if (warn && !warnedSecondOwner)
            {
                warnedSecondOwner = true;
                Debug.LogWarning($"MarsAtmosphere: '{(owner != null ? owner.name : "null")}' tried to publish weather while '{Owner.name}' owns it; ignored. Keep a single active MarsWeather.", owner);
            }
            return false;
        }

        // Unity's == also catches destroyed objects; a disabled owner gives way so another can take over.
        static bool IsAlive(Object o) => o != null && (!(o is Behaviour b) || b.isActiveAndEnabled);

        static void SetGlobals(in WeatherFrame f)
        {
            Shader.SetGlobalVector(DustId, new Vector4(f.extraDepth, f.stormAmount, f.localDust, f.gust));
            Shader.SetGlobalVector(WindId, new Vector4(f.wind.x, f.wind.y, f.windSpeed, f.clock));
            Shader.SetGlobalVector(CloudId, new Vector4(f.cloudOffsetKm.x, f.cloudOffsetKm.y, f.iceClouds, f.cloudAltitudeKm));
        }

        static void Bump()
        {
            unchecked { Version++; }
#if UNITY_EDITOR
            // Edit mode only runs the player loop on demand: make DayNightCycle pick the change up now.
            if (!Application.isPlaying) UnityEditor.EditorApplication.QueuePlayerLoopUpdate();
#endif
        }

        // Exact comparisons on purpose: Color and Vector2 == are approximate and would swallow slow glides.
        static bool Same(in AtmosphereModifiers a, in AtmosphereModifiers b) =>
            a.extraDustDepth == b.extraDustDepth && a.fogScale == b.fogScale && a.skyFlatten == b.skyFlatten
            && a.hazeTint.r == b.hazeTint.r && a.hazeTint.g == b.hazeTint.g && a.hazeTint.b == b.hazeTint.b && a.hazeTint.a == b.hazeTint.a
            && a.ambientScale == b.ambientScale && a.ambientFlatten == b.ambientFlatten && a.shadowScale == b.shadowScale
            && a.reflectionScale == b.reflectionScale && a.unlitScale == b.unlitScale;

        static bool Same(in WeatherFrame a, in WeatherFrame b) =>
            a.opticalDepth == b.opticalDepth && a.extraDepth == b.extraDepth && a.stormAmount == b.stormAmount
            && a.wind.x == b.wind.x && a.wind.y == b.wind.y && a.windSpeed == b.windSpeed && a.gust == b.gust
            && a.localDust == b.localDust && a.dustSheets == b.dustSheets && a.devilActivity == b.devilActivity
            && a.iceClouds == b.iceClouds && a.cloudOffsetKm.x == b.cloudOffsetKm.x && a.cloudOffsetKm.y == b.cloudOffsetKm.y
            && a.cloudAltitudeKm == b.cloudAltitudeKm && a.clock == b.clock && a.seed == b.seed;
    }
}

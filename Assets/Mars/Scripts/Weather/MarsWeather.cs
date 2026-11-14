using System;
using Unity.Profiling;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.Rendering;

namespace NasaSpaceApp
{
    /// <summary>
    /// The weather brain. Glides between five presets (<see cref="WeatherKind"/>) and publishes the result through
    /// <see cref="MarsAtmosphere"/>: lighting modifiers that <see cref="DayNightCycle"/> folds into the sun, sky,
    /// ambient light and fog, plus a <see cref="WeatherFrame"/> that the particles, dust devils and sky read.
    /// It never writes RenderSettings or the sun itself; besides the hub it only sets its own storm Volume's weight.
    ///
    /// One physical variable, the dust optical depth tau, drives the whole look (<see cref="FromDust"/>).
    /// Press <see cref="cycleKey"/> (M) for the next state after the one already being headed for, Shift+M for the
    /// previous one. Every value runs through two critically damped springs in series, the same as DayNightCycle's
    /// N key: it starts and lands softly, and a press mid-glide bends the curve instead of restarting it.
    /// With <see cref="autoEvolve"/> the weather also changes on its own, deterministically from <see cref="seed"/>.
    ///
    /// In edit mode the component only previews <see cref="startState"/> (a snap, like DayNightCycle's Time Of Day
    /// slider): no clock, key or scheduler, so the saved scene never drifts.
    /// </summary>
    [ExecuteAlways, DisallowMultipleComponent, DefaultExecutionOrder(-20)]
    public class MarsWeather : MonoBehaviour
    {
        [Header("State")]
        [SerializeField, Tooltip("The weather when the scene starts, previewed instantly in edit mode. Keep Clear when saving the scene: Clear changes nothing, so the baked reflection matches. Changing it in play mode glides there.")]
        WeatherKind startState = WeatherKind.Clear;

        [Header("Weather Key")]
        [SerializeField, Tooltip("Glides to the next weather after the one already being headed for. Hold Shift for the previous one. None disables the key.")]
        Key cycleKey = Key.M;
        [SerializeField, Min(0.5f), Tooltip("Roughly how long a key press takes to settle, in seconds (99% after this long).")]
        float transitionDuration = 6f;

        [Header("Automatic Evolution")]
        [SerializeField, Tooltip("Changes the weather on its own every few minutes. A key press holds the chosen weather for a full dwell.")]
        bool autoEvolve = true;
        [SerializeField, Min(10f), Tooltip("Mean seconds between automatic changes (each one lasts 0.6-1.4 times this). One sol is 1200 s. Gameplay pacing: real weather lasts sols.")]
        float meanDwell = 300f;
        [SerializeField, Min(0.5f), Tooltip("How long an automatic change takes to settle, in seconds. Slower than a key press: storms build slowly.")]
        float autoTransitionDuration = 45f;
        [SerializeField, Tooltip("Same seed and same key presses give the same weather and dust-devil sequence. Matches the scene builder's seed.")]
        int seed = 1977;

        [Header("Atmosphere")]
        [SerializeField, Min(0.05f), Tooltip("Dust optical depth of today's clear look. At or below it every lighting modifier is the identity.")]
        float clearOpticalDepth = 0.5f;

        [Header("Ice Clouds")]
        [SerializeField, Min(1f), Tooltip("Height of the water-ice cloud layer in km (Curiosity's twilight clouds: about 50 km).")]
        float cloudAltitudeKm = 50f;
        [SerializeField, Min(0f), Tooltip("Apparent cloud drift in km/s along the wind. Time-compressed like the sol, not a real cloud speed.")]
        float cloudDriftKmPerSecond = 0.4f;

        [Header("Storm Grading")]
        [SerializeField, Tooltip("Global Volume whose weight follows the storm amount (partial exposure compensation, since URP has no auto-exposure). Only its weight is ever written.")]
        Volume stormVolume;

        [Header("Historical Mode (Measured Gale Data)")]
        [SerializeField, Tooltip("Dust optical depth from Curiosity's measurements instead of the presets (same season as the REMS statistics). Wind, devils and clouds still follow the selected state: they are not measured.")]
        bool historical;
        [SerializeField, Tooltip("Toggles historical mode. None disables the key.")]
        Key historicalKey = Key.H;
        [SerializeField, Tooltip("REMS seasonal statistics in HOMELINE's format (conditions/rems.json, contract rems.schema.json).")]
        TextAsset remsData;
        [SerializeField, Tooltip("PDS msl_tau_880.csv: Mastcam solar-imaging optical depth at 880 nm (Lemmon et al., doi:10.17189/fjh0-2978).")]
        TextAsset tauData;
        [SerializeField, Min(0f), Tooltip("0: the season's median tau (REMS window). Otherwise a mission sol: the nearest Mastcam measurement in the whole record (33-3953). Try 2086: the 2018 global dust storm, tau 8.6.")]
        float historicalSol;
        [SerializeField, Tooltip("Briefly shows the new weather on screen when M or H is pressed.")]
        bool showChangeLabel = true;

        [Header("Presets (Indexed By WeatherKind)")]
        [SerializeField, Tooltip("Clear, IceClouds, DustDevils, DustyHaze, DustStorm. Edits made in play mode glide in.")]
        WeatherPreset[] presets = WeatherPreset.CreateDefaults();

        /// <summary>Raised whenever the weather being headed for changes (key, API or automatic), before the blend
        /// is visible, so a HUD can acknowledge it at once.</summary>
        public event Action<WeatherKind> TargetChanged;

        /// <summary>The weather being headed for (or already reached).</summary>
        public WeatherKind Target => targetKind;

        /// <summary>Historical mode: the dust (tau) comes from Curiosity's measurements, see <see cref="Climate"/>.
        /// Turning it on pauses automatic evolution, so the measured sky is not replaced by a random state.</summary>
        public bool Historical
        {
            get => historical;
            set
            {
                if (historical == value) return;
                historical = value;
                if (value) autoEvolve = false;
                activeDuration = transitionDuration; // glide like a key press
            }
        }

        /// <summary>Measured season (REMS air temperature and pressure, Mastcam tau), or null without readable data files.
        /// Each value carries its provenance (<see cref="MarsHistoricalClimate.RemsProvenance"/>, <see cref="MarsHistoricalClimate.TauSource"/>).</summary>
        public MarsHistoricalClimate Climate
        {
            get
            {
                if (!climateLoaded)
                {
                    climateLoaded = true;
                    climate = null;
                    if (remsData != null && tauData != null)
                    {
                        try { climate = MarsHistoricalClimate.Load(remsData.text, tauData.text); }
                        catch (Exception e) { Debug.LogWarning($"[MarsWeather] Historical data unusable: {e.Message}", this); }
                    }
                }
                return climate;
            }
        }

        /// <summary>The preset closest to what is on screen now, in normalised channel space (for a HUD label mid-blend).</summary>
        public WeatherKind Nearest => FindNearest();

        /// <summary>True until every channel has settled on the target.</summary>
        public bool IsTransitioning
        {
            get
            {
                for (int i = 0; i < ChannelCount; i++)
                {
                    if (Mathf.Abs(target[i] - current[i]) > SettledEpsilon || Mathf.Abs(target[i] - follow[i]) > SettledEpsilon) return true;
                }
                return false;
            }
        }

        /// <summary>Total column dust optical depth tau now (rover sites outside storms: about 0.3-0.9).</summary>
        public float OpticalDepth => frame.opticalDepth;

        /// <summary>Wind velocity now in m/s on world X/Z (where the air goes), gusts included.</summary>
        public Vector2 Wind => frame.wind;

        /// <summary>Wind speed now in m/s, gusts included.</summary>
        public float WindSpeed => frame.windSpeed;

        /// <summary>Whether the weather changes on its own. Pausing keeps the time left until the next change.</summary>
        public bool AutoEvolve
        {
            get => autoEvolve;
            set => autoEvolve = value;
        }

        // Channels: springs run in perceptual spaces. ln tau because perceived light goes as exp(-tau), so equal
        // steps look even. Wind as a vector, not an angle: no 359 -> 0 wrap, and a reversal passes through a lull.
        const int LnTau = 0, WindX = 1, WindZ = 2, Gust = 3, LocalDust = 4, DustSheets = 5, Devils = 6, IceClouds = 7;
        const int FirstUnitChannel = Gust; // channels from here on are 0..1 amounts
        const int ChannelCount = 8;
        const int KindCount = 5;

        const float MinOpticalDepth = 0.05f;   // keeps ln tau finite and tau / tau0 sane
        const float ExtraDepthSnap = 1e-4f;    // below this dtau is exactly 0, so Clear is bit-identical to today
        const float SettledEpsilon = 1e-3f;
        const float VolumeEpsilon = 1e-4f;     // smaller weight changes are not written (keeps the scene clean)
        const float MinDuration = 0.05f;

        // MarsAtmosphere.Hash streams (3 is the dust-devil spawner's).
        const uint SchedulerStream = 1, DwellStream = 2, GustStream = 4, WobbleStream = 5;

        // Gusts: speed x (1 + 0.35 gust n), heading +/- 8 deg x gust. Tuned for the look, not measured: the gust
        // spectrum at the site is unknown. The 2 octaves (4 s and 1.1 s periods) make the motes surge rather than
        // flicker; the heading wobble is slower (20 s and 6 s), so the dust veers instead of shaking.
        const float GustStrength = 0.35f;
        const float GustLowHz = 0.25f, GustHighHz = 0.9f;
        const float HeadingWobbleDeg = 8f;
        const float WobbleLowHz = 0.05f, WobbleHighHz = 0.17f;

        static readonly ProfilerMarker TickMarker = new ProfilerMarker("MarsWeather.Tick");

        // Stands in for elements missing from a shortened serialized array, so a state never indexes out of range.
        static readonly WeatherPreset[] FallbackPresets = WeatherPreset.CreateDefaults();

        // Spring state, one slot per channel, allocated once: no garbage per frame.
        // 'follow' chases 'target' and 'current' chases 'follow'; 'current' is what gets published.
        readonly float[] target = new float[ChannelCount];
        readonly float[] follow = new float[ChannelCount];
        readonly float[] current = new float[ChannelCount];
        readonly float[] followVelocity = new float[ChannelCount];
        readonly float[] currentVelocity = new float[ChannelCount];
        readonly float[] presetScratch = new float[KindCount * ChannelCount]; // for Nearest

        WeatherKind targetKind;
        WeatherKind appliedStartState; // the startState already acted on (play-mode inspector edits)
        float activeDuration = 6f;     // D of the glide in progress: manual or automatic
        MarsHistoricalClimate climate; // parsed once from remsData + tauData
        bool climateLoaded;
        double clock;                  // weather seconds, unwrapped; double so noise and clouds stay precise for hours
        double cloudX, cloudZ;         // integrated cloud drift in km, never wrapped
        uint epoch;                    // automatic changes so far: indexes the scheduler's hashes
        float autoRemaining;           // seconds until the next automatic change
        bool snapPending;
        WeatherFrame frame;            // last published

        uint Seed => unchecked((uint)seed);

        void OnEnable()
        {
            // Everything is re-derived from serialized inputs (never read back), so domain-reload-free play
            // sessions and edit/play switches always start from the same state.
            activeDuration = transitionDuration;
            epoch = 0;
            autoRemaining = Dwell(0);
            appliedStartState = startState;
            snapPending = false;
            SnapInternal(Valid(startState));
            PublishNow(); // before DayNightCycle's first Apply (execution order -20): no first-frame flash
        }

        void OnDisable()
        {
            MarsAtmosphere.Clear(this);
            if (stormVolume != null) stormVolume.weight = 0f;
        }

        void OnValidate()
        {
            // Applied from Update: OnValidate also runs during deserialisation, before OnEnable.
            snapPending = true;
            climateLoaded = false; // the data files may have changed
#if UNITY_EDITOR
            if (!Application.isPlaying) UnityEditor.EditorApplication.QueuePlayerLoopUpdate();
#endif
        }

        void Update()
        {
            if (!Application.isPlaying)
            {
                // Edit mode: a preview of startState only. No clock, key or scheduler, so nothing drifts.
                if (snapPending)
                {
                    snapPending = false;
                    SnapInternal(Valid(startState));
                    PublishNow();
                }
                return;
            }

            using (TickMarker.Auto())
            {
                if (snapPending)
                {
                    snapPending = false;
                    // Only a changed startState acts; other edits (presets, durations) are picked up continuously.
                    if (startState != appliedStartState)
                    {
                        appliedStartState = startState;
                        SetWeather(startState);
                    }
                }

                ReadKey();
                float dt = Time.deltaTime;
                // timeScale 0 freezes the weather, as it does DayNightCycle. SmoothDamp would also return NaN for
                // a settled spring at dt 0 (it divides by deltaTime), so the step is skipped, not run with 0.
                if (dt > 0f) Tick(dt);
                PublishNow();
            }
        }

        /// <summary>Glides to the next weather after the one already being headed for (mashing never queues).</summary>
        public void CycleNext() => SetWeather((WeatherKind)(((int)targetKind + 1) % KindCount));

        /// <summary>Glides to the previous weather before the one already being headed for.</summary>
        public void CyclePrevious() => SetWeather((WeatherKind)(((int)targetKind + KindCount - 1) % KindCount));

        /// <summary>
        /// Glides to <paramref name="kind"/> over <paramref name="duration"/> seconds (negative: the key's
        /// transition duration; 0: instant). Velocities are kept, so retargeting mid-glide stays smooth.
        /// Counts as a manual choice: automatic evolution holds it for a full dwell. In edit mode it snaps.
        /// </summary>
        public void SetWeather(WeatherKind kind, float duration = -1f)
        {
            kind = Valid(kind);
            if (duration == 0f || !Application.isPlaying)
            {
                SnapTo(kind);
                return;
            }
            Retarget(kind, duration < 0f ? transitionDuration : duration, manual: true);
        }

        /// <summary>Jumps to <paramref name="kind"/> at once (no glide) and publishes it. Counts as a manual choice.</summary>
        public void SnapTo(WeatherKind kind)
        {
            kind = Valid(kind);
            bool changed = kind != targetKind;
            autoRemaining = meanDwell;
            SnapInternal(kind);
            if (isActiveAndEnabled) PublishNow(); // a disabled component must not own the hub
            if (changed) NotifyTargetChanged(kind);
        }

        /// <summary>
        /// The lighting modifiers for a dust optical depth <paramref name="tau"/> over a clear baseline
        /// <paramref name="tau0"/>. At or below the baseline (dtau &lt; 1e-4) it returns exactly
        /// <see cref="AtmosphereModifiers.Identity"/>, so Clear reproduces today's look bit for bit.
        ///
        /// Physics: DayNightCycle dims the direct sun by Beer-Lambert, exp(-dtau / sin(elevation)), the same
        /// extinction rovers use to measure tau by imaging the sun (Lemmon et al. 2015, Icarus).
        /// Derived estimates, tuned against the existing look (not measurements):
        /// - D = 1 - exp(-0.6 dtau), the share of daylight that dust turns diffuse. It drives the flatter, ochre sky
        ///   and ambient light and the softer shadows (shadows soften as dust thickens, as in Spirit's Marsdial
        ///   sequence during a storm; qualitative).
        /// - Ambient = exp(-0.3 dtau)(1 + 2.5 D): the diffuse sky takes over from the lost direct beam, so the ground
        ///   stays lit by a bright dome instead of going black. Anchor: Opportunity's 2018 storm still kept about
        ///   74% of the clear-day energy at tau 2.1 (345 vs 468 Wh); the 2.5 is tuned so storm ground reads as dim, not dark.
        /// - Fog = clear density x tau / tau0, never below 1. The clear 2.2 km fog is already a stage set (real clear
        ///   air would give tens of km), so this is an art anchor: about 850 m at tau 1.3, 370 m at tau 3.
        /// At tau 3 (Dust Storm): noon sun x0.05, shadows x0.34, ambient x1.39, sky flatten 0.66, reflections x0.46.
        /// </summary>
        public static AtmosphereModifiers FromDust(float tau, float tau0)
        {
            tau0 = Mathf.Max(tau0, MinOpticalDepth);
            float extra = ExtraDepth(tau, tau0);
            if (extra <= 0f) return AtmosphereModifiers.Identity;

            float diffuse = 1f - Mathf.Exp(-0.6f * extra);
            float light = Mathf.Exp(-0.3f * extra) * (1f + 2.5f * diffuse);

            AtmosphereModifiers m = AtmosphereModifiers.Identity;
            m.extraDustDepth = extra;
            m.fogScale = Mathf.Max(1f, tau / tau0); // never clearer than the clear baseline
            // Dust near the ground sets its own visibility whatever the (long-range) clear baseline is. Art anchor, exp²:
            // nothing up to 0.3 of extra tau (Gale's measured background, tau 0.6-0.8, still shows the crater rim and
            // Mount Sharp), then ~1.8 km in Dusty Haze (tau 1.3) and ~410 m in Dust Storm (tau 3).
            m.fogFloor = 0.0022f * Mathf.Max(0f, extra - 0.3f);
            m.skyFlatten = 0.85f * diffuse;
            m.hazeTint = Color.Lerp(Color.white, new Color(1f, 0.86f, 0.72f), diffuse);
            m.ambientScale = light;
            m.ambientFlatten = 0.8f * diffuse;
            m.shadowScale = 1f - 0.85f * diffuse;
            m.reflectionScale = 1f - 0.7f * diffuse; // the baked reflection is a clear sky
            m.unlitScale = light;
            return m;
        }

        // tau above the clear baseline, exactly 0 below the snap so tiny float noise never leaves the identity.
        static float ExtraDepth(float tau, float tau0)
        {
            float extra = tau - tau0;
            return extra < ExtraDepthSnap ? 0f : extra;
        }

        // How much of a storm this is (storm grading weight). Derived: 0 up to dtau 0.5, full at dtau 3.5.
        static float StormAmount(float extraDepth) => Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(0.5f, 3.5f, extraDepth));

        void ReadKey()
        {
            Keyboard keyboard = Keyboard.current;
            if (keyboard == null) return;
            if (historicalKey != Key.None && keyboard[historicalKey].wasPressedThisFrame)
            {
                Historical = !historical;
                ShowLabel();
            }
            if (cycleKey == Key.None || !keyboard[cycleKey].wasPressedThisFrame) return;
            if (keyboard.shiftKey.isPressed) CyclePrevious();
            else CycleNext();
            ShowLabel();
        }

        void Tick(float dt)
        {
            clock += dt;

            if (autoEvolve)
            {
                autoRemaining -= dt;
                if (autoRemaining <= 0f) AutoAdvance();
            }

            // Re-read every frame so preset edits made in the inspector glide in like any other change.
            LoadTarget(targetKind);

            // Two critically damped springs in series (Erlang-4 step response): zero velocity and acceleration at
            // both ends, no overshoot, 50% at 0.37 D and about 99% at D. Retargeting keeps both velocities, so a
            // press mid-glide (or a switch from the automatic to the manual duration) stays C1-smooth.
            float smoothTime = activeDuration / 5f;
            for (int i = 0; i < ChannelCount; i++)
            {
                follow[i] = Mathf.SmoothDamp(follow[i], target[i], ref followVelocity[i], smoothTime, Mathf.Infinity, dt);
                current[i] = Mathf.SmoothDamp(current[i], follow[i], ref currentVelocity[i], smoothTime, Mathf.Infinity, dt);
            }

            // Clouds drift along the mean wind at a fixed apparent speed, slowing linearly below 1 m/s so the
            // direction can never flip abruptly. Integrated (never recomputed from time), so a change of drift
            // speed or direction moves the clouds on smoothly instead of jumping them.
            double windX = current[WindX], windZ = current[WindZ];
            double perMetre = cloudDriftKmPerSecond * (double)dt / Math.Max(Math.Sqrt(windX * windX + windZ * windZ), 1.0);
            cloudX += windX * perMetre;
            cloudZ += windZ * perMetre;
        }

        // Each epoch lasts meanDwell x 0.6-1.4. Stateless hashes of (seed, stream, epoch), not UnityEngine.Random
        // (shared global state) or System.Random (allocates, differs between runtimes): reproducible everywhere.
        void AutoAdvance()
        {
            WeatherKind next = PickNext(epoch);
            epoch++;
            autoRemaining += Dwell(epoch);
            if (next != targetKind) Retarget(next, autoTransitionDuration, manual: false);
        }

        float Dwell(uint index) => meanDwell * Mathf.Lerp(0.6f, 1.4f, MarsAtmosphere.Hash01(Seed, DwellStream, index));

        // A weighted pick by autoWeight, excluding the current target.
        WeatherKind PickNext(uint index)
        {
            // Storms decay through haze: dust settles over sols, it never vanishes straight into a clear sky
            // (Opportunity's tau took months to fall after 2018).
            if (targetKind == WeatherKind.DustStorm) return WeatherKind.DustyHaze;

            float total = 0f;
            for (int k = 0; k < KindCount; k++)
            {
                if (k != (int)targetKind) total += Mathf.Max(0f, Preset((WeatherKind)k).autoWeight);
            }
            if (total <= 0f) return targetKind;

            float r = MarsAtmosphere.Hash01(Seed, SchedulerStream, index) * total;
            WeatherKind picked = targetKind;
            for (int k = 0; k < KindCount; k++)
            {
                if (k == (int)targetKind) continue;
                float weight = Mathf.Max(0f, Preset((WeatherKind)k).autoWeight);
                if (weight <= 0f) continue;
                picked = (WeatherKind)k;
                if (r < weight) break;
                r -= weight;
            }
            return picked; // the last eligible state if rounding ran past the end
        }

        void Retarget(WeatherKind kind, float duration, bool manual)
        {
            if (manual) autoRemaining = meanDwell; // the player's choice holds for a full dwell
            activeDuration = Mathf.Max(duration, MinDuration);
            if (kind == targetKind) return;
            targetKind = kind;
            LoadTarget(kind);
            NotifyTargetChanged(kind);
        }

        void SnapInternal(WeatherKind kind)
        {
            targetKind = kind;
            LoadTarget(kind);
            for (int i = 0; i < ChannelCount; i++)
            {
                follow[i] = current[i] = target[i];
                followVelocity[i] = currentVelocity[i] = 0f;
            }
        }

        void NotifyTargetChanged(WeatherKind kind)
        {
            // A throwing listener (e.g. a HUD) must not cost the weather a frame.
            try { TargetChanged?.Invoke(kind); }
            catch (Exception e) { Debug.LogException(e, this); }
        }

        void PublishNow()
        {
            float tau0 = Mathf.Max(clearOpticalDepth, MinOpticalDepth);
            float tau = Mathf.Exp(current[LnTau]);
            float extra = ExtraDepth(tau, tau0);
            AtmosphereModifiers modifiers = FromDust(tau, tau0);

            // 0..1 channels are clamped after the spring: an interrupted spring can overshoot slightly.
            float gust = Mathf.Clamp01(current[Gust]);
            Vector2 wind = GustedWind(new Vector2(current[WindX], current[WindZ]), gust, clock, Seed);

            frame = new WeatherFrame
            {
                opticalDepth = tau,
                extraDepth = extra,
                stormAmount = StormAmount(extra),
                wind = wind,
                windSpeed = wind.magnitude,
                gust = gust,
                localDust = Mathf.Clamp01(current[LocalDust]),
                dustSheets = Mathf.Clamp01(current[DustSheets]),
                devilActivity = Mathf.Clamp01(current[Devils]),
                iceClouds = Mathf.Clamp01(current[IceClouds]),
                cloudOffsetKm = new Vector2((float)cloudX, (float)cloudZ),
                cloudAltitudeKm = cloudAltitudeKm,
                clock = (float)clock,
                seed = Seed,
            };
            MarsAtmosphere.Publish(this, in modifiers, in frame);
            SetStormWeight(frame.stormAmount);
        }

        void SetStormWeight(float weight)
        {
            if (stormVolume == null) return;
            float old = stormVolume.weight;
            // Skip tiny changes so edit mode doesn't dirty the scene, but always land exactly on 0 and 1.
            bool endpoint = weight <= 0f || weight >= 1f;
            if (Mathf.Abs(old - weight) > VolumeEpsilon || (endpoint && old != weight)) stormVolume.weight = weight;
        }

        static Vector2 GustedWind(Vector2 mean, float gust, double t, uint seed)
        {
            if (gust <= 0f) return mean;
            float speedScale = 1f + GustStrength * gust * Fbm(seed, GustStream, t, GustLowHz, GustHighHz);
            float veer = HeadingWobbleDeg * Mathf.Deg2Rad * gust * Fbm(seed, WobbleStream, t, WobbleLowHz, WobbleHighHz);
            float c = Mathf.Cos(veer), s = Mathf.Sin(veer);
            return new Vector2(mean.x * c - mean.y * s, mean.x * s + mean.y * c) * speedScale;
        }

        // Two octaves of value noise in [-1, 1], deterministic in (seed, stream, t).
        static float Fbm(uint seed, uint stream, double t, float lowHz, float highHz) =>
            (ValueNoise(seed, stream, 0u, t * lowHz) + 0.5f * ValueNoise(seed, stream, 1u, t * highHz)) * (1f / 1.5f);

        // 1D value noise in [-1, 1]: hashed values on integer lattice points, blended with the quintic fade, which
        // is continuous up to acceleration, so the wind never jerks. Octaves interleave their lattice indices.
        static float ValueNoise(uint seed, uint stream, uint octave, double x)
        {
            double cell = Math.Floor(x);
            float f = (float)(x - cell);
            uint i = unchecked((uint)(long)cell);
            float a = MarsAtmosphere.Hash01(seed, stream, unchecked(i * 2u + octave));
            float b = MarsAtmosphere.Hash01(seed, stream, unchecked((i + 1u) * 2u + octave));
            float u = f * f * f * (f * (f * 6f - 15f) + 10f);
            return (a + (b - a) * u) * 2f - 1f;
        }

        WeatherKind FindNearest()
        {
            for (int k = 0; k < KindCount; k++) LoadChannels(Preset((WeatherKind)k), presetScratch, k * ChannelCount);

            // Each channel is normalised by its spread across the presets, so ln tau, m/s and 0..1 amounts weigh
            // alike; a channel on which all presets agree tells them apart by nothing and is skipped.
            float best = float.MaxValue;
            WeatherKind nearest = targetKind;
            for (int k = 0; k < KindCount; k++)
            {
                float distance = 0f;
                for (int i = 0; i < ChannelCount; i++)
                {
                    float min = float.MaxValue, max = float.MinValue;
                    for (int j = 0; j < KindCount; j++)
                    {
                        float v = presetScratch[j * ChannelCount + i];
                        min = Mathf.Min(min, v);
                        max = Mathf.Max(max, v);
                    }
                    float span = max - min;
                    if (span < 1e-4f) continue;
                    float value = i >= FirstUnitChannel ? Mathf.Clamp01(current[i]) : current[i];
                    float d = (value - presetScratch[k * ChannelCount + i]) / span;
                    distance += d * d;
                }
                if (distance < best)
                {
                    best = distance;
                    nearest = (WeatherKind)k;
                }
            }
            return nearest;
        }

        WeatherPreset Preset(WeatherKind kind)
        {
            int i = (int)kind;
            return presets != null && i < presets.Length ? presets[i] : FallbackPresets[i];
        }

        // A state's channels as the glide target; in historical mode the dust is the measured tau instead of the preset's.
        void LoadTarget(WeatherKind kind)
        {
            MarsHistoricalClimate measured = historical ? Climate : null;
            if (measured == null)
            {
                LoadChannels(Preset(kind), target, 0);
                return;
            }
            // Only tau is measured. Wind, dust sheets and devils (not measured) come from the dust state closest to it,
            // so a historical storm also looks like one; the selected state is ignored meanwhile.
            float tau = Mathf.Max(measured.TauFor(historicalSol), MinOpticalDepth);
            LoadChannels(Preset(ClosestDustState(tau)), target, 0);
            target[LnTau] = Mathf.Log(tau);
        }

        WeatherKind ClosestDustState(float tau)
        {
            WeatherKind best = WeatherKind.Clear;
            foreach (WeatherKind k in new[] { WeatherKind.Clear, WeatherKind.DustyHaze, WeatherKind.DustStorm })
                if (Mathf.Abs(Mathf.Log(tau / Mathf.Max(Preset(k).opticalDepth, MinOpticalDepth)))
                    < Mathf.Abs(Mathf.Log(tau / Mathf.Max(Preset(best).opticalDepth, MinOpticalDepth))))
                    best = k;
            return best;
        }

        // ------------------------------------------------------------------ on-screen feedback

        string label;
        float labelUntil;
        GUIStyle labelStyle;

        void ShowLabel()
        {
            if (!showChangeLabel || !Application.isPlaying) return;
            MarsHistoricalClimate measured = historical ? Climate : null;
            if (historical && measured == null) label = "Historical weather: data files missing (see Environment/Weather)";
            else if (historical && historicalSol > 0f)
            {
                MarsHistoricalClimate.TauSample s = measured.NearestSample(historicalSol);
                label = $"Historical weather: Gale, sol {s.sol:0} (Ls {s.ls:0}, MY {s.marsYear}), tau {s.tau:0.00} - Mastcam 880 nm";
            }
            else if (historical)
                label = $"Historical weather: Gale, Ls {measured.LsWindowDeg.x:0}-{measured.LsWindowDeg.y:0}, tau {measured.Tau.median:0.00} (median of {measured.Tau.count}, Mastcam 880 nm)";
            else label = $"Weather: {targetKind}";
            labelUntil = Time.unscaledTime + 4f;
        }

        void OnGUI()
        {
            if (label == null || !Application.isPlaying) return;
            float alpha = Mathf.Clamp01(labelUntil - Time.unscaledTime); // fades out over the last second
            if (alpha <= 0f) return;
            labelStyle ??= new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperCenter, fontSize = 18 };
            Color previous = GUI.color;
            GUI.color = new Color(1f, 1f, 1f, alpha);
            GUI.Label(new Rect(0f, 24f, Screen.width, 32f), label, labelStyle);
            GUI.color = previous;
        }

        static void LoadChannels(in WeatherPreset p, float[] into, int offset)
        {
            Vector2 wind = p.WindVelocity;
            into[offset + LnTau] = Mathf.Log(Mathf.Max(p.opticalDepth, MinOpticalDepth));
            into[offset + WindX] = wind.x;
            into[offset + WindZ] = wind.y;
            into[offset + Gust] = Mathf.Clamp01(p.gust);
            into[offset + LocalDust] = Mathf.Clamp01(p.localDust);
            into[offset + DustSheets] = Mathf.Clamp01(p.dustSheets);
            into[offset + Devils] = Mathf.Clamp01(p.devilActivity);
            into[offset + IceClouds] = Mathf.Clamp01(p.iceClouds);
        }

        static WeatherKind Valid(WeatherKind kind) => (uint)kind < KindCount ? kind : WeatherKind.Clear;
    }
}

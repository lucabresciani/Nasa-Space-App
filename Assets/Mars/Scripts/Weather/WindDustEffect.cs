using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace NasaSpaceApp
{
    /// <summary>
    /// Wind-blown dust around the observer, driven by the weather (<see cref="MarsAtmosphere.Frame"/>): fine grains
    /// streaking past, soft dust sheets rolling by 25-70 m away, sand streamers skimming the ground in strong wind,
    /// and the existing Player/Dust Motes drifting with the wind.
    ///
    /// Thin air (~600 Pa) still carries fine dust fast, but it pushes on almost nothing: a 60 mph Martian wind feels
    /// like ~6 mph on Earth (Michael Smith, NASA Goddard, via Space.com 2015). So the dust moves fast and nothing violent
    /// happens: no camera shake, no flying debris, no force on the player.
    ///
    /// Play mode only. Every rate, velocity and offset is a function of the weather's sprung channels, so dust thickens
    /// and thins smoothly. The systems keep playing with an authored rate of 0 and are never started or stopped, so
    /// nothing pops; new particles fade in and old ones fade out over their own lifetimes. The emitters sit upwind of
    /// the eye so the dust streams past instead of thinning out downwind. All writes go through the particle module
    /// structs: no garbage per frame, and the motes' asset and material are never touched.
    /// </summary>
    [DisallowMultipleComponent, DefaultExecutionOrder(20)]
    public class WindDustEffect : MonoBehaviour
    {
        [SerializeField, Tooltip("What the dust gathers around (the eye). Empty: Camera.main.")]
        Transform follow;
        [SerializeField, Tooltip("Fine grains streaking past (stretched billboards). Authored emission 0.")]
        ParticleSystem windDust;
        [SerializeField, Tooltip("Large soft dust sheets rolling past 25-70 m away (vertical billboards). Authored emission 0.")]
        ParticleSystem dustSheets;
        [SerializeField, Tooltip("Sand streamers skimming the ground in strong wind. Authored emission 0.")]
        ParticleSystem saltation;
        [SerializeField, Tooltip("The existing Player/Dust Motes. Only their velocity and emission change, at runtime.")]
        ParticleSystem ambientMotes;

        // Rates, boxes and offsets come from the weather design. They are tuned for the look, not measured.
        const float StreakRatePerDust = 250f;  // per second at localDust 1, up to 5 m/s; more in stronger wind
        const float StreakRateCap = 666f;      // 1500 particles / ~2.25 s mean lifetime
        const float StreakUpwindPerSpeed = 1.1f, StreakUpwindMax = 20f;
        const float StreakHeight = 0.3f;       // box centre above the eye: the 6 m box spans the ground to ~5 m up

        const float SheetRatePerAmount = 4f;   // per second at dustSheets 1 (48 sheets / ~11.5 s)
        // A modest shift: the ring is 24.5-70 m wide, so more than ~15 m would spawn sheets inside the 10 m collapse.
        const float SheetUpwindPerSpeed = 1f, SheetUpwindMax = 15f;
        const float SheetHeight = 2f;          // ring centre above the eye

        // Sand starts to move in strong gusts. The threshold is tuned, not measured: the real surface threshold is
        // unsure, and once moving, saltation may continue at much lower winds (Kok 2010, GRL). Sand motion itself is
        // observed today across Mars (Bridges et al. 2012, Nature).
        const float SaltationFrom = 9f, SaltationFull = 16f; // m/s
        const float SaltationRate = 300f, SaltationRateCap = 333f; // 400 particles / 1.2 s mean lifetime
        const float SaltationUpwindPerSpeed = 0.4f, SaltationUpwindMax = 8f;
        const float SaltationHeight = -1.45f;  // foot level: the eye is 1.65 m up, so 0.2 m above the ground

        // The motes drift at wind x [0.18, 0.46]: with the Clear wind (3 m/s toward ENE) that is today's authored
        // 0.5-1.3 m/s on X and ~0.2-0.5 m/s on Z, so Clear looks the way the scene always did.
        const float MotesWindMin = 0.18f, MotesWindMax = 0.46f;
        const float MotesRateCap = 100f;       // 800 particles / 8 s mean lifetime
        const float DevilDustBoost = 0.8f;     // extra local dust at the centre of a passing dust devil

        // Fades the effects in or out (~3 s) if the weather appears or goes away mid-play, instead of snapping.
        const float PresenceSmoothTime = 0.6f;

        static readonly int SoftFadeId = Shader.PropertyToID("_SoftFade");

        Transform cachedEye;
        float presence, presenceVelocity;
        WeatherFrame lastFrame; // the last frame a live weather published; kept while fading out
        int qualityLevel = -1;
        bool lowQuality;
        int windDustMaxParticles;
        MaterialPropertyBlock block;

        // The motes' authored values, restored when the weather is absent.
        bool motesCached;
        float motesRate;
        ParticleSystem.MinMaxCurve motesVelocityX, motesVelocityY, motesVelocityZ;
        Vector2 motesRangeX, motesRangeY, motesRangeZ;

        /// <summary>
        /// True when the camera depth texture exists (PC_RPAsset). Without it (Mobile_RPAsset, the Low quality level)
        /// soft particles can't work, so the effects switch to their no-depth path and lighter budgets.
        /// </summary>
        internal static bool SceneDepthAvailable() =>
            GraphicsSettings.currentRenderPipeline is UniversalRenderPipelineAsset urp && urp.supportsCameraDepthTexture;

        void Start()
        {
            if (ambientMotes != null)
            {
                motesCached = true;
                motesRate = ambientMotes.emission.rateOverTimeMultiplier;
                ParticleSystem.VelocityOverLifetimeModule velocity = ambientMotes.velocityOverLifetime;
                motesVelocityX = velocity.x;
                motesVelocityY = velocity.y;
                motesVelocityZ = velocity.z;
                motesRangeX = Range(motesVelocityX);
                motesRangeY = Range(motesVelocityY);
                motesRangeZ = Range(motesVelocityZ);
            }
            if (windDust != null) windDustMaxParticles = windDust.main.maxParticles;

            // Weather that is already there at start is there at full strength: no fade-in on the first frames.
            bool live = MarsAtmosphere.Owner != null;
            presence = live ? 1f : 0f;
            lastFrame = MarsAtmosphere.Frame;
        }

        void OnDisable()
        {
            // Particles already in the air live out their lifetime, so switching this off pops nothing.
            SetRate(windDust, 0f);
            SetRate(dustSheets, 0f);
            SetRate(saltation, 0f);
            if (motesCached && ambientMotes != null)
            {
                ParticleSystem.EmissionModule emission = ambientMotes.emission;
                emission.rateOverTimeMultiplier = motesRate;
                ParticleSystem.VelocityOverLifetimeModule velocity = ambientMotes.velocityOverLifetime;
                velocity.x = motesVelocityX;
                velocity.y = motesVelocityY;
                velocity.z = motesVelocityZ;
            }
        }

        void Update()
        {
            Transform eye = Eye();
            if (eye == null) return;
            float dt = Time.deltaTime;

            // World-aligned on purpose: the player yaws, but the wind is a world direction.
            transform.SetPositionAndRotation(eye.position, Quaternion.identity);
            CheckQuality();

            bool live = MarsAtmosphere.Owner != null;
            if (live) lastFrame = MarsAtmosphere.Frame;
            presence = Mathf.SmoothDamp(presence, live ? 1f : 0f, ref presenceVelocity, PresenceSmoothTime, Mathf.Infinity, dt);
            if (!live && presence < 1e-3f) presence = 0f;

            WeatherFrame f = lastFrame;
            Vector2 wind = f.wind;
            float speed = f.windSpeed;
            Vector2 downwind = speed > 1e-3f ? wind / speed : Vector2.zero;
            float localDust = Mathf.Clamp01(f.localDust + DevilDustBoost * DustDevilField.ClosePass);

            if (windDust != null)
            {
                float cap = lowQuality ? StreakRateCap * 0.5f : StreakRateCap;
                SetRate(windDust, Mathf.Min(localDust * StreakRatePerDust * Mathf.Max(1f, speed / 5f), cap) * presence);
                SetWindVelocity(windDust, wind, 0.85f, 1.15f, -0.15f, 0.35f);
                SetUpwindOffset(windDust, downwind, Mathf.Min(speed * StreakUpwindPerSpeed, StreakUpwindMax), StreakHeight);
            }

            if (dustSheets != null)
            {
                // Sheets need the soft depth fade to meet the ground; without a depth texture they stay off.
                SetRate(dustSheets, lowQuality ? 0f : f.dustSheets * SheetRatePerAmount * presence);
                SetWindVelocity(dustSheets, wind, 0.9f, 1.1f, 0f, 0.4f);
                SetUpwindOffset(dustSheets, downwind, Mathf.Min(speed * SheetUpwindPerSpeed, SheetUpwindMax), SheetHeight);
            }

            if (saltation != null)
            {
                float rate = Mathf.Min(Smooth(SaltationFrom, SaltationFull, speed) * SaltationRate, SaltationRateCap);
                SetRate(saltation, lowQuality ? 0f : rate * presence);
                // Grains hop slower than the wind that carries them (derived estimate: 0.5-0.8 x wind).
                SetWindVelocity(saltation, wind, 0.5f, 0.8f, -0.1f, 0.2f);
                SetUpwindOffset(saltation, downwind, Mathf.Min(speed * SaltationUpwindPerSpeed, SaltationUpwindMax), SaltationHeight);
            }

            if (motesCached && ambientMotes != null)
            {
                float cap = Mathf.Max(MotesRateCap, motesRate);
                float rate = Mathf.Min(motesRate * (1f + 2f * localDust) * Mathf.Max(1f, speed / 4f), cap);
                SetRate(ambientMotes, Mathf.Lerp(motesRate, rate, presence));

                // Velocity changes move the motes already in the air too; that is safe because the wind is sprung.
                ParticleSystem.VelocityOverLifetimeModule velocity = ambientMotes.velocityOverLifetime;
                velocity.x = new ParticleSystem.MinMaxCurve(
                    Mathf.Lerp(motesRangeX.x, wind.x * MotesWindMin, presence),
                    Mathf.Lerp(motesRangeX.y, wind.x * MotesWindMax, presence));
                // Unity needs all three axes in the same curve mode; y keeps its authored range.
                velocity.y = new ParticleSystem.MinMaxCurve(motesRangeY.x, motesRangeY.y);
                velocity.z = new ParticleSystem.MinMaxCurve(
                    Mathf.Lerp(motesRangeZ.x, wind.y * MotesWindMin, presence),
                    Mathf.Lerp(motesRangeZ.y, wind.y * MotesWindMax, presence));
            }
        }

        Transform Eye()
        {
            if (follow != null) return follow;
            if (cachedEye == null)
            {
                Camera main = Camera.main;
                if (main != null) cachedEye = main.transform;
            }
            return cachedEye;
        }

        // Re-checked only when the quality level changes: budgets and the soft-fade switch follow the render asset.
        void CheckQuality()
        {
            int level = QualitySettings.GetQualityLevel();
            if (level == qualityLevel) return;
            qualityLevel = level;
            lowQuality = !SceneDepthAvailable();

            if (windDust != null && windDustMaxParticles > 0)
            {
                ParticleSystem.MainModule main = windDust.main;
                main.maxParticles = lowQuality ? windDustMaxParticles / 2 : windDustMaxParticles;
            }
            OverrideSoftFade(windDust);
            OverrideSoftFade(dustSheets);
            OverrideSoftFade(saltation);
        }

        // _SoftFade 0 is the shader's no-depth path. A property block, not a material edit: assets stay untouched.
        void OverrideSoftFade(ParticleSystem system)
        {
            if (system == null) return;
            var renderer = system.GetComponent<ParticleSystemRenderer>();
            if (renderer == null) return;
            block ??= new MaterialPropertyBlock();
            block.Clear();
            if (lowQuality) block.SetFloat(SoftFadeId, 0f);
            renderer.SetPropertyBlock(block);
        }

        static void SetRate(ParticleSystem system, float rate)
        {
            if (system == null) return;
            ParticleSystem.EmissionModule emission = system.emission;
            emission.rateOverTimeMultiplier = rate;
        }

        // Wind on X/Z with a spread of [min, max] x wind, plus a little lift or settling on Y.
        static void SetWindVelocity(ParticleSystem system, Vector2 wind, float min, float max, float upMin, float upMax)
        {
            ParticleSystem.VelocityOverLifetimeModule velocity = system.velocityOverLifetime;
            velocity.x = new ParticleSystem.MinMaxCurve(wind.x * min, wind.x * max);
            velocity.y = new ParticleSystem.MinMaxCurve(upMin, upMax);
            velocity.z = new ParticleSystem.MinMaxCurve(wind.y * min, wind.y * max);
        }

        // Emitter shapes are local to this world-aligned object, so local X/Z are world X/Z.
        static void SetUpwindOffset(ParticleSystem system, Vector2 downwind, float distance, float height)
        {
            ParticleSystem.ShapeModule shape = system.shape;
            shape.position = new Vector3(-downwind.x * distance, height, -downwind.y * distance);
        }

        static Vector2 Range(ParticleSystem.MinMaxCurve curve) => curve.mode == ParticleSystemCurveMode.TwoConstants
            ? new Vector2(curve.constantMin, curve.constantMax)
            : new Vector2(curve.constant, curve.constant);

        static float Smooth(float from, float to, float x) => Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(from, to, x));
    }
}

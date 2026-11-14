using UnityEngine;

namespace NasaSpaceApp
{
    /// <summary>
    /// Dust devils (convective vortices) crossing the plain around the player, driven by the weather's devil activity
    /// (<see cref="WeatherFrame.devilActivity"/>) and the sun (<see cref="MarsAtmosphere.SunHeight"/>).
    ///
    /// Science: Spirit counted 533 active dust devils at Gusev, 2-276 m across (most 10-20 m), drifting at under 1 to
    /// 21 m/s, between 09:30 and 16:30 local time with a peak near 13:00 (Greeley et al. 2006/2010, JGR). Perseverance's
    /// MEDA at Jezero sees 2-3 devils per km² per sol, 5-135 m across (mean ~20 m), peaking at noon to 13:00
    /// (Hueso et al. 2023, JGR Planets). One passed over the rover: 25 m wide, at least 118 m tall, wall winds
    /// ~40 km/h (Murdoch et al. 2022, Nat. Commun.). They need sunlight, so there are none at night.
    ///
    /// A small pool of devils (clones of an inactive template, made in Start, play mode only, never saved) is reused.
    /// Each spawn draws its size, life, place and spin from <see cref="MarsAtmosphere.Hash01"/> (stream 3, index =
    /// serial * 8 + field), so a seed always gives the same sequence of devils. Devils fade in and out over 8 s (no
    /// pops), appear at least 120 m from the player, mostly upwind, drift with the wind and stand on the terrain.
    /// </summary>
    [DisallowMultipleComponent, DefaultExecutionOrder(20)]
    public class DustDevilField : MonoBehaviour
    {
        [SerializeField, Tooltip("Who watches the devils (the eye). Empty: Camera.main.")]
        Transform follow;
        [SerializeField, Tooltip("Inactive template: MeshRenderer with the Mars Dust Devil material, and a child 'Skirt' ParticleSystem.")]
        GameObject devilTemplate;
        [SerializeField, Min(0), Tooltip("Pool size, fixed at Start. Up to 3 devils show at once; the spare one fades in while another fades out.")]
        int maxDevils = 4;
        [SerializeField, Tooltip("Ground the devils stand on. Empty: Terrain.activeTerrain.")]
        Terrain terrain;

        /// <summary>
        /// 0..1: how close the eye is to a visible devil's axis (1 inside about one radius, 0 beyond 2.5 radii),
        /// times that devil's opacity. Raises the local dust during a close pass, while the column itself fades out.
        /// </summary>
        public static float ClosePass { get; private set; }

        // Activity: target count = round(devilActivity x sun gate x 3). Sun gate: none with the sun below ~15 deg,
        // full above ~44 deg (sin 0.25 .. 0.7), a stand-in for surface heating (derived, matches the midday peak).
        const int MaxVisible = 3;
        const float SunGateFrom = 0.25f, SunGateFull = 0.7f;

        const float FadeSeconds = 8f;
        // Lifetimes are unsure (rover movies follow devils for minutes); 1-3 minutes is an artistic choice.
        const float LifeMin = 60f, LifeMax = 180f;
        const float SpawnGapMin = 8f, SpawnGapMax = 25f;

        // Spawn mostly upwind (they then drift toward and past the player), never closer than 120 m.
        const float SpawnDistanceMin = 150f, SpawnDistanceMax = 900f, MinSpawnDistance = 120f;
        const float UpwindSpreadDegrees = 100f;
        const float DespawnDistance = 1500f; // well inside the fog by then
        const float TerrainMargin = 40f;

        // Diameter: log-normal with median 22 m and sigma 0.6, clamped to 6-135 m. A derived fit to the Jezero and
        // Gusev ranges above, not a published distribution.
        const float MedianDiameter = 22f, LogSigma = 0.6f, DiameterMin = 6f, DiameterMax = 135f;
        // Height: 3-10 diameters, 60-800 m. Derived estimate: Murdoch 2022 (25 m wide, >= 118 m tall); Perseverance's
        // Thorofare Ridge devil (2023, ~60 m wide, ~2 km tall estimated from its shadow) is taller than we show.
        const float HeightPerDiameterMin = 3f, HeightPerDiameterMax = 10f, HeightMin = 60f, HeightMax = 800f;

        // Drift with the wind (Greeley 2006: under 1 to 21 m/s), plus a slow 1 m/s sideways meander (artistic).
        const float DriftMin = 0.8f, DriftMax = 1.1f;
        const float WanderSpeed = 1f, WanderPeriod = 30f;

        // Wall wind 15 m/s (contract value; Murdoch 2022 measured ~11 m/s). Spin direction 50/50: Coriolis is
        // negligible at this scale; whether Mars shows a preference is unsure.
        const float TangentialWind = 15f;
        const float SkirtSpinShare = 0.5f; // the debris cloud turns slower than the wall (artistic)
        const float SkirtRate = 40f;       // 120 particles / 3 s lifetime
        const float SkirtSizeMin = 3f, SkirtSizeMax = 8f, SkirtReferenceRadius = 11f;

        const float BaseSink = 2f;   // the base sits this far into the ground; the 2 m soft fade hides the seam
        const float EyeHeight = 1.65f;
        const uint SpawnStream = 3u;

        static readonly int DevilParamsId = Shader.PropertyToID("_DevilParams");
        static readonly int DevilRadiusId = Shader.PropertyToID("_DevilRadius");
        static readonly int SoftFadeId = Shader.PropertyToID("_SoftFade");

        struct Devil
        {
            public GameObject root;
            public Transform transform;
            public Renderer renderer;
            public ParticleSystem skirt;
            public Transform skirtTransform;
            public Renderer skirtRenderer;

            public bool active, retiring;
            public float age, life;      // s
            public Vector2 position;     // world X/Z
            public float radius, height; // m
            public float spin;           // rev/s, signed
            public float drift;          // x wind
            public float wanderPhase;    // rad
            public float seed01;
        }

        Devil[] pool;
        uint serial;
        float clock, nextSpawn;
        Transform cachedEye;
        MaterialPropertyBlock block;
        int qualityLevel = -1;
        bool lowQuality;

        // Domain reload is off (Enter Play Mode Options): statics would otherwise carry over between play sessions.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics() => ClosePass = 0f;

        void Start()
        {
            if (devilTemplate == null)
            {
                Debug.LogWarning("DustDevilField: no devil template assigned, so there will be no dust devils.", this);
                return;
            }

            block = new MaterialPropertyBlock();
            pool = new Devil[Mathf.Max(0, maxDevils)];
            for (int i = 0; i < pool.Length; i++)
            {
                GameObject clone = Instantiate(devilTemplate, transform);
                clone.name = $"{devilTemplate.name} {i + 1}";
                clone.SetActive(false);
                // Play-mode only and never saved, even if something tried to save the scene with them in it.
                foreach (Transform t in clone.GetComponentsInChildren<Transform>(true)) t.gameObject.hideFlags = HideFlags.DontSave;

                ref Devil d = ref pool[i];
                d.root = clone;
                d.transform = clone.transform;
                d.renderer = clone.GetComponent<Renderer>();
                d.skirt = clone.GetComponentInChildren<ParticleSystem>(true);
                d.skirtTransform = d.skirt != null ? d.skirt.transform : null;
                d.skirtRenderer = d.skirt != null ? d.skirt.GetComponent<ParticleSystemRenderer>() : null;
            }
        }

        void OnDisable() => ClosePass = 0f;

        void OnDestroy()
        {
            // DontSave objects are ours to destroy.
            if (pool == null) return;
            for (int i = 0; i < pool.Length; i++)
            {
                if (pool[i].root != null) Destroy(pool[i].root);
            }
        }

        void Update()
        {
            if (pool == null) return;
            Transform eye = Eye();
            if (eye == null) return;

            float dt = Time.deltaTime;
            clock += dt;
            CheckQuality();

            WeatherFrame f = MarsAtmosphere.Frame;
            Vector3 eyePosition = eye.position;
            Vector2 eyeXZ = new Vector2(eyePosition.x, eyePosition.z);
            Terrain ground = terrain != null ? terrain : Terrain.activeTerrain;

            // Convection needs a sunlit ground: the activity follows the sun, which already moves smoothly.
            float sunGate = Smooth(SunGateFrom, SunGateFull, MarsAtmosphere.SunHeight);
            int wanted = Mathf.Min(Mathf.RoundToInt(f.devilActivity * sunGate * MaxVisible), pool.Length);

            int alive = 0;
            int shortest = -1;
            for (int i = 0; i < pool.Length; i++)
            {
                if (!pool[i].active || pool[i].retiring) continue;
                alive++;
                if (shortest < 0 || pool[i].life - pool[i].age < pool[shortest].life - pool[shortest].age) shortest = i;
            }
            if (alive > wanted) Retire(ref pool[shortest]);
            else if (alive < wanted && clock >= nextSpawn) TrySpawn(f, eyeXZ, ground);

            float close = 0f;
            for (int i = 0; i < pool.Length; i++)
            {
                if (pool[i].active) Step(ref pool[i], f, eyeXZ, eyePosition.y, ground, dt, ref close);
            }
            ClosePass = close;
        }

        void TrySpawn(in WeatherFrame f, Vector2 eyeXZ, Terrain ground)
        {
            int slot = -1;
            for (int i = 0; i < pool.Length; i++)
            {
                if (!pool[i].active) { slot = i; break; }
            }
            if (slot < 0) return;

            // Eight hashed fields per devil; the serial advances even if the spot is rejected, so the sequence of
            // devils for a seed never depends on where the player happens to stand.
            uint seed = f.seed;
            uint index = serial * 8u;
            serial++;
            nextSpawn = clock + Mathf.Lerp(SpawnGapMin, SpawnGapMax, Random01(seed, index, 7));

            // Box-Muller from two hashes: a standard normal for the log-normal diameter.
            float u1 = Mathf.Max(Random01(seed, index, 0), 1e-7f);
            float u2 = Random01(seed, index, 1);
            float normal = Mathf.Sqrt(-2f * Mathf.Log(u1)) * Mathf.Cos(2f * Mathf.PI * u2);
            float diameter = Mathf.Clamp(MedianDiameter * Mathf.Exp(LogSigma * normal), DiameterMin, DiameterMax);
            float height = Mathf.Clamp(diameter * Mathf.Lerp(HeightPerDiameterMin, HeightPerDiameterMax, Random01(seed, index, 2)), HeightMin, HeightMax);

            // Upwind of the player, +/- 100 deg; anywhere around in a calm.
            float angle = f.windSpeed > 0.5f
                ? Mathf.Atan2(-f.wind.y, -f.wind.x) + (Random01(seed, index, 5) * 2f - 1f) * UpwindSpreadDegrees * Mathf.Deg2Rad
                : Random01(seed, index, 5) * 2f * Mathf.PI;
            float distance = Mathf.Lerp(SpawnDistanceMin, SpawnDistanceMax, Mathf.Sqrt(Random01(seed, index, 4)));
            Vector2 position = eyeXZ + new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * distance;
            position = ClampToGround(ground, position);
            if ((position - eyeXZ).sqrMagnitude < MinSpawnDistance * MinSpawnDistance) return; // player at the map edge

            ref Devil d = ref pool[slot];
            d.active = true;
            d.retiring = false;
            d.age = 0f;
            d.life = Mathf.Lerp(LifeMin, LifeMax, Random01(seed, index, 3));
            d.position = position;
            d.radius = diameter * 0.5f;
            d.height = height;
            float spinSign = (MarsAtmosphere.Hash(seed, SpawnStream, index + 6u) & 1u) == 0u ? 1f : -1f;
            d.spin = spinSign * TangentialWind / (2f * Mathf.PI * d.radius);
            d.drift = Mathf.Lerp(DriftMin, DriftMax, Random01(seed, index, 6));
            // Spare low bits of two hashes: independent enough for a phase and a noise seed.
            d.wanderPhase = (MarsAtmosphere.Hash(seed, SpawnStream, index + 3u) & 0xFFu) / 256f * 2f * Mathf.PI;
            d.seed01 = (MarsAtmosphere.Hash(seed, SpawnStream, index + 2u) & 0xFFu) / 256f;

            // The mesh is unit height with radius 0.5 at the base, so this scale makes the base radius d.radius.
            // The skirt is counter-scaled so its particles and shape stay in metres.
            d.transform.rotation = Quaternion.identity;
            d.transform.localScale = new Vector3(diameter, height, diameter);
            if (d.skirt != null)
            {
                d.skirtTransform.localScale = new Vector3(1f / diameter, 1f / height, 1f / diameter);
                float size = Mathf.Clamp(d.radius / SkirtReferenceRadius, 0.6f, 2.5f);
                ParticleSystem.MainModule main = d.skirt.main;
                main.startSize = new ParticleSystem.MinMaxCurve(SkirtSizeMin * size, SkirtSizeMax * size);
                ParticleSystem.ShapeModule shape = d.skirt.shape;
                shape.radius = d.radius * 0.9f;
                ParticleSystem.VelocityOverLifetimeModule velocity = d.skirt.velocityOverLifetime;
                velocity.orbitalY = new ParticleSystem.MinMaxCurve(spinSign * TangentialWind * SkirtSpinShare / d.radius);
                SetSkirtRate(d, 0f);
            }
            if (d.renderer != null) d.renderer.enabled = false; // opacity starts at 0
            d.root.SetActive(true);
            // The skirt plays on awake; this only guards a reused clone. It emits nothing until the fade-in raises
            // its rate, so starting it shows nothing.
            if (d.skirt != null && !d.skirt.isPlaying) d.skirt.Play(true);
        }

        void Step(ref Devil d, in WeatherFrame f, Vector2 eyeXZ, float eyeY, Terrain ground, float dt, ref float close)
        {
            d.age += dt;
            if (d.age >= d.life)
            {
                // Faded out: park it once the last skirt particles are gone.
                SetSkirtRate(d, 0f);
                if (d.renderer != null && d.renderer.enabled) d.renderer.enabled = false;
                if (d.skirt == null || d.skirt.particleCount == 0)
                {
                    d.root.SetActive(false);
                    d.active = false;
                }
                return;
            }

            if (!d.retiring && (!InsideGround(ground, d.position, TerrainMargin) || (d.position - eyeXZ).sqrMagnitude > DespawnDistance * DespawnDistance))
            {
                Retire(ref d);
            }

            // Drift with the (sprung, gusty) wind and meander sideways.
            Vector2 downwind = f.windSpeed > 1e-3f ? f.wind / f.windSpeed : Vector2.right;
            Vector2 side = new Vector2(-downwind.y, downwind.x);
            float wander = WanderSpeed * Mathf.Sin(d.age * (2f * Mathf.PI / WanderPeriod) + d.wanderPhase);
            d.position += (f.wind * d.drift + side * wander) * dt;

            float groundY = ground != null
                ? ground.SampleHeight(new Vector3(d.position.x, 0f, d.position.y)) + ground.GetPosition().y
                : eyeY - EyeHeight;
            d.transform.position = new Vector3(d.position.x, groundY - BaseSink, d.position.y);

            float opacity = Smooth01(d.age / FadeSeconds) * Smooth01((d.life - d.age) / FadeSeconds);
            if (d.renderer != null)
            {
                bool visible = opacity > 1e-3f; // switching off a renderer this faint is invisible
                if (d.renderer.enabled != visible) d.renderer.enabled = visible;
                block.Clear();
                block.SetVector(DevilParamsId, new Vector4(opacity, d.spin, d.height, d.seed01));
                block.SetFloat(DevilRadiusId, d.radius);
                if (lowQuality) block.SetFloat(SoftFadeId, 0f); // no depth texture: the shader's no-depth path
                d.renderer.SetPropertyBlock(block);
            }
            SetSkirtRate(d, SkirtRate * opacity);

            float axisDistance = (d.position - eyeXZ).magnitude;
            close = Mathf.Max(close, (1f - Smooth(1f, 2.5f, axisDistance / d.radius)) * opacity);
        }

        // Starts the fade-out now (or keeps the one already under way): never a pop.
        static void Retire(ref Devil d)
        {
            d.life = Mathf.Min(d.life, d.age + FadeSeconds);
            d.retiring = true;
        }

        static void SetSkirtRate(in Devil d, float rate)
        {
            if (d.skirt == null) return;
            ParticleSystem.EmissionModule emission = d.skirt.emission;
            emission.rateOverTimeMultiplier = rate;
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

        void CheckQuality()
        {
            int level = QualitySettings.GetQualityLevel();
            if (level == qualityLevel) return;
            qualityLevel = level;
            lowQuality = !WindDustEffect.SceneDepthAvailable();

            // The skirts use the particle shader: same no-depth switch, through a property block (assets untouched).
            // The columns get theirs every frame with the rest of their block.
            block.Clear();
            if (lowQuality) block.SetFloat(SoftFadeId, 0f);
            for (int i = 0; i < pool.Length; i++)
            {
                if (pool[i].skirtRenderer != null) pool[i].skirtRenderer.SetPropertyBlock(block);
            }
        }

        static bool InsideGround(Terrain ground, Vector2 p, float margin)
        {
            if (ground == null || ground.terrainData == null) return true;
            Vector3 origin = ground.GetPosition();
            Vector3 size = ground.terrainData.size;
            return p.x > origin.x + margin && p.x < origin.x + size.x - margin
                && p.y > origin.z + margin && p.y < origin.z + size.z - margin;
        }

        static Vector2 ClampToGround(Terrain ground, Vector2 p)
        {
            if (ground == null || ground.terrainData == null) return p;
            Vector3 origin = ground.GetPosition();
            Vector3 size = ground.terrainData.size;
            float margin = TerrainMargin * 2f;
            return new Vector2(
                Mathf.Clamp(p.x, origin.x + margin, origin.x + size.x - margin),
                Mathf.Clamp(p.y, origin.z + margin, origin.z + size.z - margin));
        }

        static float Random01(uint seed, uint index, uint field) => MarsAtmosphere.Hash01(seed, SpawnStream, index + field);

        static float Smooth(float from, float to, float x) => Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(from, to, x));

        static float Smooth01(float x)
        {
            x = Mathf.Clamp01(x);
            return x * x * (3f - 2f * x);
        }
    }
}

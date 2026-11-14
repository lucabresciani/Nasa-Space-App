using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Authors the weather's visual effects in the open scene, plus their assets (materials and the DustDevilColumn
    /// mesh) under the given folder:
    ///   weatherRoot/Near Dust [WindDustEffect] with Wind Dust, Dust Sheets, Saltation (ParticleSystems);
    ///   weatherRoot/Dust Devils [DustDevilField] with the inactive template 'Dust Devil' (MeshFilter + MeshRenderer)
    ///   and its child 'Skirt' (ParticleSystem).
    ///
    /// Idempotent: children are found by name and updated in place, so it can run on an already saved scene as often
    /// as needed. With undo, scene changes go through Undo. Every object goes on layer 2 (Ignore Raycast) and nothing
    /// gets a collider or a Collision/Trigger module: the rock scanner raycasts from the camera with triggers on.
    /// Particle systems are authored with emission 0 and keep playing; the components set the rates at runtime.
    /// Colours are authored in sRGB like the rest of the project; material tints are linear multipliers.
    /// </summary>
    public static class MarsWeatherEffectsSetup
    {
        public const string DustParticleShader = "NasaSpaceApp/Mars Dust Particle";
        public const string DustDevilShader = "NasaSpaceApp/Mars Dust Devil";

        const string SoftDotFolder = "Assets/Mars/Generated/Textures";
        const string SoftDotPath = SoftDotFolder + "/SoftDot.png";
        const int IgnoreRaycastLayer = 2;
        const string UndoName = "Mars Weather Effects";

        // Mars dust scatters strongly forward: asymmetry g ~ 0.6-0.7 in the visible (Tomasko et al. 1999, Pathfinder).
        const float ForwardScattering = 0.6f;

        // Brightness gains on top of the lighting (linear multipliers). Artistic: the scene's ambient colour is darker
        // than its sky, and dust that matches the sky reads better than dust that looks like smoke.
        const float StreakGain = 1.4f, SheetGain = 1.6f, SaltationGain = 1.3f, SkirtGain = 1.6f, DevilGain = 1.6f;
        static readonly Color DevilDust = new Color(0.92f, 0.74f, 0.58f); // sRGB, bright ochre: Mars dust scatters far more than it absorbs in the red
        const float DevilOpacity = 0.35f; // peak opacity; raw contrast in rover movies is low (they are enhanced)

        // Must match the TEXCOORD packing documented in MarsDustParticle.shader.
        static readonly List<ParticleSystemVertexStream> DustStreams = new List<ParticleSystemVertexStream>
        {
            ParticleSystemVertexStream.Position,
            ParticleSystemVertexStream.Color,
            ParticleSystemVertexStream.UV,
            ParticleSystemVertexStream.Center,
        };

        /// <summary>
        /// Creates or updates weatherRoot/"Near Dust" (WindDustEffect) with its three particle systems and wires the
        /// component. ambientMotes is the existing Player/Dust Motes: only referenced, never modified.
        /// </summary>
        public static WindDustEffect CreateNearDust(Transform weatherRoot, ParticleSystem ambientMotes, string assetFolder, bool undo)
        {
            if (weatherRoot == null) throw new System.ArgumentNullException(nameof(weatherRoot));
            EnsureFolder(assetFolder);
            Texture2D softDot = SoftDot();
            Material streakMaterial = DustMaterial($"{assetFolder}/MarsWindStreak.mat", softDot, StreakGain, nearFade: new Vector2(0.3f, 1f), softFade: 0.25f);
            Material sheetMaterial = DustMaterial($"{assetFolder}/MarsDustParticle.mat", softDot, SheetGain, nearFade: new Vector2(10f, 25f), softFade: 2f);
            Material saltationMaterial = DustMaterial($"{assetFolder}/MarsSaltation.mat", softDot, SaltationGain, nearFade: new Vector2(0.5f, 2f), softFade: 0.4f);

            GameObject root = Child(weatherRoot, "Near Dust", undo);
            WindDustEffect effect = GetOrAdd<WindDustEffect>(root, undo);
            ParticleSystem windDust = SetupWindDust(Child(root.transform, "Wind Dust", undo), streakMaterial, undo);
            ParticleSystem sheets = SetupDustSheets(Child(root.transform, "Dust Sheets", undo), sheetMaterial, undo);
            ParticleSystem saltation = SetupSaltation(Child(root.transform, "Saltation", undo), saltationMaterial, undo);

            var so = new SerializedObject(effect);
            Transform eye = FindEye(ambientMotes != null ? ambientMotes.transform : null);
            if (eye != null) Set(so, "follow", eye);
            Set(so, "windDust", windDust);
            Set(so, "dustSheets", sheets);
            Set(so, "saltation", saltation);
            if (ambientMotes != null) Set(so, "ambientMotes", ambientMotes);
            Apply(so, undo);
            return effect;
        }

        /// <summary>
        /// Creates or updates weatherRoot/"Dust Devils" (DustDevilField) with its inactive "Dust Devil" template
        /// (column mesh + child "Skirt" particles), the DustDevilColumn mesh and the devil materials.
        /// </summary>
        public static DustDevilField CreateDustDevils(Transform weatherRoot, Terrain terrain, string assetFolder, bool undo)
        {
            if (weatherRoot == null) throw new System.ArgumentNullException(nameof(weatherRoot));
            EnsureFolder(assetFolder);
            Texture2D softDot = SoftDot();
            Mesh column = ColumnMesh(assetFolder);
            Material devilMaterial = DevilMaterial($"{assetFolder}/MarsDustDevil.mat");
            Material skirtMaterial = DustMaterial($"{assetFolder}/MarsDustSkirt.mat", softDot, SkirtGain, nearFade: new Vector2(2f, 6f), softFade: 1.5f);

            GameObject root = Child(weatherRoot, "Dust Devils", undo);
            DustDevilField field = GetOrAdd<DustDevilField>(root, undo);

            GameObject template = Child(root.transform, "Dust Devil", undo);
            MeshFilter filter = GetOrAdd<MeshFilter>(template, undo);
            filter.sharedMesh = column;
            MeshRenderer meshRenderer = GetOrAdd<MeshRenderer>(template, undo);
            meshRenderer.sharedMaterial = devilMaterial;
            meshRenderer.shadowCastingMode = ShadowCastingMode.Off;
            meshRenderer.receiveShadows = false;
            meshRenderer.lightProbeUsage = LightProbeUsage.Off;
            meshRenderer.reflectionProbeUsage = ReflectionProbeUsage.Off;
            meshRenderer.motionVectorGenerationMode = MotionVectorGenerationMode.ForceNoMotion;
            SetupSkirt(Child(template.transform, "Skirt", undo), skirtMaterial, undo);
            template.SetActive(false); // only DustDevilField's play-mode clones are ever shown

            var so = new SerializedObject(field);
            Transform eye = FindEye(null);
            if (eye != null) Set(so, "follow", eye);
            Set(so, "devilTemplate", template);
            Terrain ground = terrain;
            if (ground == null)
            {
                GameObject playable = GameObject.Find("Environment/Mars Terrain"); // not the backdrop terrain
                ground = playable != null ? playable.GetComponent<Terrain>() : Terrain.activeTerrain;
            }
            if (ground != null) Set(so, "terrain", ground);
            Apply(so, undo); // maxDevils keeps its value (default 4), so a tuned scene stays tuned
            return field;
        }

        // ------------------------------------------------------------------ particle systems

        static ParticleSystem SetupWindDust(GameObject go, Material material, bool undo)
        {
            ParticleSystem ps = Prepare(go, undo, out ParticleSystemRenderer renderer);
            ParticleSystem.MainModule main = Main(ps, 1500, new ParticleSystem.MinMaxCurve(1.5f, 3f), ParticleSystemSimulationSpace.World);
            main.startSize = new ParticleSystem.MinMaxCurve(0.02f, 0.06f);
            main.startColor = new ParticleSystem.MinMaxGradient(new Color(0.86f, 0.70f, 0.55f, 0.35f), new Color(0.96f, 0.82f, 0.66f, 0.65f));

            // 40 x 6 x 40 m around the eye; WindDustEffect slides it upwind as the wind rises.
            ParticleSystem.ShapeModule shape = Shape(ps, ParticleSystemShapeType.Box);
            shape.scale = new Vector3(40f, 6f, 40f);
            shape.position = new Vector3(0f, 0.3f, 0f);

            Velocity(ps, ParticleSystemSimulationSpace.World, -0.15f, 0.35f);
            Noise(ps, strength: 0.4f, frequency: 0.5f, scrollSpeed: 0.6f);
            ColorOverLifetime(ps, Fade(0.1f, 1f, 0.75f, 1f));

            // Streaks: ~0.8 m long at 20 m/s (velocityScale 0.04), round dots in a calm.
            ConfigureRenderer(renderer, material, ParticleSystemRenderMode.Stretch, ParticleSystemSortMode.None, sortingFudge: -10f, maxParticleSize: 0.5f);
            renderer.lengthScale = 1f;
            renderer.velocityScale = 0.04f;
            return ps;
        }

        static ParticleSystem SetupDustSheets(GameObject go, Material material, bool undo)
        {
            ParticleSystem ps = Prepare(go, undo, out ParticleSystemRenderer renderer);
            ParticleSystem.MainModule main = Main(ps, 48, new ParticleSystem.MinMaxCurve(9f, 14f), ParticleSystemSimulationSpace.World);
            // Wide, low sheets: 8-16 m across, about half as tall.
            main.startSize3D = true;
            main.startSizeX = new ParticleSystem.MinMaxCurve(8f, 16f);
            main.startSizeY = new ParticleSystem.MinMaxCurve(3.5f, 7f);
            main.startSizeZ = 1f;
            main.startColor = new ParticleSystem.MinMaxGradient(new Color(0.88f, 0.70f, 0.54f, 0.10f), new Color(0.95f, 0.79f, 0.63f, 0.18f));

            // A flat ring 24.5-70 m from the eye (radius 70, thickness 0.65), shifted upwind at runtime.
            ParticleSystem.ShapeModule shape = Shape(ps, ParticleSystemShapeType.Circle);
            shape.radius = 70f;
            shape.radiusThickness = 0.65f;
            shape.arc = 360f;
            shape.arcMode = ParticleSystemShapeMultiModeValue.Random;
            shape.rotation = new Vector3(90f, 0f, 0f); // the circle lies in local XY: turn it flat onto XZ
            shape.position = new Vector3(0f, 2f, 0f);
            shape.randomPositionAmount = 1.5f;

            Velocity(ps, ParticleSystemSimulationSpace.World, 0f, 0.4f);
            Noise(ps, strength: 0.6f, frequency: 0.05f, scrollSpeed: 0.1f);
            SizeOverLifetime(ps, 0.75f, 1.2f); // billowing as they roll
            ColorOverLifetime(ps, Fade(0.2f, 1f, 0.7f, 1f));

            // Drawn before the small dust (higher fudge) and sorted among themselves. maxParticleSize is only a
            // safety cap: sheets closer than 10 m are collapsed by the shader long before they could reach it.
            ConfigureRenderer(renderer, material, ParticleSystemRenderMode.VerticalBillboard, ParticleSystemSortMode.Distance, sortingFudge: 40f, maxParticleSize: 0.8f);
            return ps;
        }

        static ParticleSystem SetupSaltation(GameObject go, Material material, bool undo)
        {
            ParticleSystem ps = Prepare(go, undo, out ParticleSystemRenderer renderer);
            ParticleSystem.MainModule main = Main(ps, 400, new ParticleSystem.MinMaxCurve(0.8f, 1.6f), ParticleSystemSimulationSpace.World);
            main.startSize = new ParticleSystem.MinMaxCurve(0.4f, 1.2f);
            // Darker than the airborne dust: sand, with basaltic grains in it (Gale's Bagnold dunes are dark sand).
            main.startColor = new ParticleSystem.MinMaxGradient(new Color(0.56f, 0.41f, 0.31f, 0.18f), new Color(0.68f, 0.51f, 0.38f, 0.32f));

            // A thin 50 x 0.4 x 50 m slab at foot level (WindDustEffect keeps it 1.45 m below the eye).
            ParticleSystem.ShapeModule shape = Shape(ps, ParticleSystemShapeType.Box);
            shape.scale = new Vector3(50f, 0.4f, 50f);
            shape.position = new Vector3(0f, -1.45f, 0f);

            Velocity(ps, ParticleSystemSimulationSpace.World, -0.1f, 0.2f);
            ColorOverLifetime(ps, Fade(0.15f, 1f, 0.6f, 1f));

            ConfigureRenderer(renderer, material, ParticleSystemRenderMode.Stretch, ParticleSystemSortMode.None, sortingFudge: 0f, maxParticleSize: 0.5f);
            renderer.lengthScale = 1f;
            renderer.velocityScale = 0.06f;
            return ps;
        }

        // Debris cloud at the base of a dust devil. Local space, so it travels with the devil; DustDevilField
        // counter-scales it (the devil's transform carries the column size) and sets radius, size and spin per devil.
        static void SetupSkirt(GameObject go, Material material, bool undo)
        {
            ParticleSystem ps = Prepare(go, undo, out ParticleSystemRenderer renderer);
            ParticleSystem.MainModule main = Main(ps, 120, new ParticleSystem.MinMaxCurve(2.5f, 3.5f), ParticleSystemSimulationSpace.Local);
            main.startSize = new ParticleSystem.MinMaxCurve(3f, 8f);
            main.startColor = new ParticleSystem.MinMaxGradient(new Color(0.86f, 0.68f, 0.52f, 0.12f), new Color(0.95f, 0.78f, 0.62f, 0.22f));

            ParticleSystem.ShapeModule shape = Shape(ps, ParticleSystemShapeType.Circle);
            shape.radius = 10f;
            shape.radiusThickness = 0.6f;
            shape.arc = 360f;
            shape.arcMode = ParticleSystemShapeMultiModeValue.Random;
            shape.rotation = new Vector3(90f, 0f, 0f);

            ParticleSystem.VelocityOverLifetimeModule velocity = Velocity(ps, ParticleSystemSimulationSpace.Local, 0.5f, 2f);
            velocity.orbitalY = 1f; // rad/s, replaced per devil
            velocity.radial = 0.4f;
            Noise(ps, strength: 0.8f, frequency: 0.3f, scrollSpeed: 0.3f);
            SizeOverLifetime(ps, 0.6f, 1.4f);
            ColorOverLifetime(ps, Fade(0.25f, 1f, 0.7f, 0.6f));

            ConfigureRenderer(renderer, material, ParticleSystemRenderMode.Billboard, ParticleSystemSortMode.Distance, sortingFudge: 0f, maxParticleSize: 0.8f);
        }

        static ParticleSystem Prepare(GameObject go, bool undo, out ParticleSystemRenderer renderer)
        {
            ParticleSystem ps = GetOrAdd<ParticleSystem>(go, undo);
            renderer = go.GetComponent<ParticleSystemRenderer>();
            if (undo) Undo.RecordObject(renderer, UndoName);
            DisableModules(ps);
            return ps;
        }

        static ParticleSystem.MainModule Main(ParticleSystem ps, int maxParticles, ParticleSystem.MinMaxCurve lifetime, ParticleSystemSimulationSpace space)
        {
            ParticleSystem.MainModule main = ps.main;
            main.loop = true;
            main.prewarm = false;
            main.playOnAwake = true; // always playing; an authored rate of 0 means idle, so nothing ever pops
            main.startDelay = 0f;
            main.startLifetime = lifetime;
            main.startSpeed = 0f;    // all motion comes from Velocity over Lifetime (the wind)
            main.startSize3D = false;
            main.startRotation3D = false;
            main.startRotation = 0f;
            main.flipRotation = 0f;
            main.gravityModifier = 0f;
            main.simulationSpace = space;
            main.simulationSpeed = 1f;
            main.useUnscaledTime = false;
            main.scalingMode = ParticleSystemScalingMode.Hierarchy;
            main.maxParticles = maxParticles;
            main.emitterVelocityMode = ParticleSystemEmitterVelocityMode.Transform;
            main.cullingMode = ParticleSystemCullingMode.AlwaysSimulate;
            main.ringBufferMode = ParticleSystemRingBufferMode.Disabled;
            main.stopAction = ParticleSystemStopAction.None;

            ParticleSystem.EmissionModule emission = ps.emission;
            emission.enabled = true;
            emission.rateOverTime = 0f;
            emission.rateOverDistance = 0f;
            emission.burstCount = 0;
            return main;
        }

        // Everything off, especially Collision and Trigger (nothing may interact with the scanner ray);
        // each system then switches on only what it uses.
        static void DisableModules(ParticleSystem ps)
        {
            ParticleSystem.CollisionModule collision = ps.collision; collision.enabled = false;
            ParticleSystem.TriggerModule trigger = ps.trigger; trigger.enabled = false;
            ParticleSystem.ExternalForcesModule external = ps.externalForces; external.enabled = false;
            ParticleSystem.InheritVelocityModule inherit = ps.inheritVelocity; inherit.enabled = false;
            ParticleSystem.LimitVelocityOverLifetimeModule limit = ps.limitVelocityOverLifetime; limit.enabled = false;
            ParticleSystem.ForceOverLifetimeModule force = ps.forceOverLifetime; force.enabled = false;
            ParticleSystem.ColorBySpeedModule colorBySpeed = ps.colorBySpeed; colorBySpeed.enabled = false;
            ParticleSystem.SizeBySpeedModule sizeBySpeed = ps.sizeBySpeed; sizeBySpeed.enabled = false;
            ParticleSystem.SizeOverLifetimeModule size = ps.sizeOverLifetime; size.enabled = false;
            ParticleSystem.RotationOverLifetimeModule rotation = ps.rotationOverLifetime; rotation.enabled = false;
            ParticleSystem.RotationBySpeedModule rotationBySpeed = ps.rotationBySpeed; rotationBySpeed.enabled = false;
            ParticleSystem.NoiseModule noise = ps.noise; noise.enabled = false;
            ParticleSystem.TextureSheetAnimationModule sheet = ps.textureSheetAnimation; sheet.enabled = false;
            ParticleSystem.LightsModule lights = ps.lights; lights.enabled = false;
            ParticleSystem.TrailModule trails = ps.trails; trails.enabled = false;
            ParticleSystem.SubEmittersModule subEmitters = ps.subEmitters; subEmitters.enabled = false;
            ParticleSystem.CustomDataModule customData = ps.customData; customData.enabled = false;
            ParticleSystem.LifetimeByEmitterSpeedModule lifetimeBySpeed = ps.lifetimeByEmitterSpeed; lifetimeBySpeed.enabled = false;
        }

        static ParticleSystem.ShapeModule Shape(ParticleSystem ps, ParticleSystemShapeType type)
        {
            ParticleSystem.ShapeModule shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = type;
            shape.position = Vector3.zero;
            shape.rotation = Vector3.zero;
            shape.scale = Vector3.one;
            shape.alignToDirection = false;
            shape.randomDirectionAmount = 0f;
            shape.sphericalDirectionAmount = 0f;
            shape.randomPositionAmount = 0f;
            return shape;
        }

        // All three axes as TwoConstants: Unity needs them in one mode, and the runtime writes TwoConstants.
        static ParticleSystem.VelocityOverLifetimeModule Velocity(ParticleSystem ps, ParticleSystemSimulationSpace space, float upMin, float upMax)
        {
            ParticleSystem.VelocityOverLifetimeModule velocity = ps.velocityOverLifetime;
            velocity.enabled = true;
            velocity.space = space;
            velocity.x = new ParticleSystem.MinMaxCurve(0f, 0f);
            velocity.y = new ParticleSystem.MinMaxCurve(upMin, upMax);
            velocity.z = new ParticleSystem.MinMaxCurve(0f, 0f);
            velocity.orbitalX = 0f;
            velocity.orbitalY = 0f;
            velocity.orbitalZ = 0f;
            velocity.orbitalOffsetX = 0f;
            velocity.orbitalOffsetY = 0f;
            velocity.orbitalOffsetZ = 0f;
            velocity.radial = 0f;
            velocity.speedModifier = 1f;
            return velocity;
        }

        static void Noise(ParticleSystem ps, float strength, float frequency, float scrollSpeed)
        {
            ParticleSystem.NoiseModule noise = ps.noise;
            noise.enabled = true;
            noise.separateAxes = false;
            noise.strength = strength;
            noise.frequency = frequency;
            noise.scrollSpeed = scrollSpeed;
            noise.damping = true;
            noise.octaveCount = 1;
            noise.quality = ParticleSystemNoiseQuality.Low; // cheap 1D noise is plenty for grain flutter
            noise.positionAmount = 1f;
            noise.rotationAmount = 0f;
            noise.sizeAmount = 0f;
        }

        static void SizeOverLifetime(ParticleSystem ps, float from, float to)
        {
            ParticleSystem.SizeOverLifetimeModule size = ps.sizeOverLifetime;
            size.enabled = true;
            size.separateAxes = false;
            size.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, from, 1f, to));
        }

        static void ColorOverLifetime(ParticleSystem ps, Gradient gradient)
        {
            ParticleSystem.ColorOverLifetimeModule color = ps.colorOverLifetime;
            color.enabled = true;
            color.color = new ParticleSystem.MinMaxGradient(gradient);
        }

        // Alpha 0 at birth, 1 by 'fadeInEnd', 'hold' at 'fadeOutStart', 0 at death: no particle ever pops in or out.
        static Gradient Fade(float fadeInEnd, float peak, float fadeOutStart, float hold)
        {
            var gradient = new Gradient();
            gradient.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(peak, fadeInEnd), new GradientAlphaKey(hold, fadeOutStart), new GradientAlphaKey(0f, 1f) });
            return gradient;
        }

        static void ConfigureRenderer(ParticleSystemRenderer renderer, Material material, ParticleSystemRenderMode mode, ParticleSystemSortMode sortMode, float sortingFudge, float maxParticleSize)
        {
            renderer.enabled = true;
            renderer.renderMode = mode;
            renderer.sharedMaterial = material;
            renderer.trailMaterial = null;
            renderer.sortMode = sortMode;
            renderer.sortingFudge = sortingFudge; // higher draws earlier (further back)
            renderer.minParticleSize = 0f;
            renderer.maxParticleSize = maxParticleSize;
            renderer.alignment = ParticleSystemRenderSpace.View;
            renderer.allowRoll = true;
            renderer.lengthScale = 1f;
            renderer.velocityScale = 0f;
            renderer.cameraVelocityScale = 0f; // walking or sprinting must not stretch the dust
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;
            renderer.lightProbeUsage = LightProbeUsage.Off; // lit by _MarsAmbient instead (see MarsDustLighting.hlsl)
            renderer.reflectionProbeUsage = ReflectionProbeUsage.Off;
            renderer.motionVectorGenerationMode = MotionVectorGenerationMode.ForceNoMotion;
            renderer.SetActiveVertexStreams(DustStreams);
        }

        // ------------------------------------------------------------------ assets

        static Material DustMaterial(string path, Texture2D softDot, float gain, Vector2 nearFade, float softFade)
        {
            Material material = MarsTextures.LoadOrCreateMaterial(path, DustParticleShader);
            material.SetTexture("_BaseMap", softDot);
            material.SetColor("_BaseColor", LinearMultiplier(Color.white, gain, 1f));
            material.SetVector("_NearFade", new Vector4(nearFade.x, nearFade.y, 0f, 0f));
            material.SetFloat("_SoftFade", softFade);
            material.SetFloat("_Phase", ForwardScattering);
            material.renderQueue = (int)RenderQueue.Transparent;
            material.enableInstancing = false;
            EditorUtility.SetDirty(material);
            return material;
        }

        static Material DevilMaterial(string path)
        {
            Material material = MarsTextures.LoadOrCreateMaterial(path, DustDevilShader);
            material.SetColor("_BaseColor", LinearMultiplier(DevilDust.linear, DevilGain, DevilOpacity));
            material.SetVector("_NoiseScale", new Vector4(6f, 9f, 0f, 0f));
            material.SetFloat("_SoftFade", 2f); // the column melts into the ground over its last 2 m
            material.SetFloat("_Phase", ForwardScattering);
            material.renderQueue = (int)RenderQueue.Transparent;
            material.enableInstancing = false;
            EditorUtility.SetDirty(material);
            return material;
        }

        // The project is in linear colour space, where Unity converts material colours from sRGB to linear on upload.
        // Encoding the wanted linear value back to sRGB first makes the shader receive exactly linear x gain.
        static Color LinearMultiplier(Color linear, float gain, float alpha)
        {
            var c = new Color(linear.r * gain, linear.g * gain, linear.b * gain, 1f).gamma;
            c.a = alpha;
            return c;
        }

        static Texture2D SoftDot()
        {
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(SoftDotPath);
            return texture != null ? texture : MarsTextures.CreateSoftDot(EnsureFolder(SoftDotFolder), 64);
        }

        static Mesh ColumnMesh(string folder)
        {
            Mesh generated = BuildColumn();
            string path = $"{folder}/DustDevilColumn.asset";
            var existing = AssetDatabase.LoadAssetAtPath<Mesh>(path);
            if (existing == null)
            {
                AssetDatabase.CreateAsset(generated, path);
                return generated;
            }
            EditorUtility.CopySerialized(generated, existing);
            Object.DestroyImmediate(generated);
            return existing;
        }

        /// <summary>
        /// Open funnel, unit height: radius 0.5 at the base flaring to 1.0 at the top (r = 0.5 + 0.5 v^2, so it stays a
        /// column most of the way up). 24 segments x 12 rings; u = angle / 2pi with a duplicated seam, v = height;
        /// outward normals of the surface of revolution. The transform scales it to (diameter, height, diameter).
        /// </summary>
        static Mesh BuildColumn()
        {
            const int Segments = 24, Rings = 12;
            int columns = Segments + 1;
            var vertices = new Vector3[columns * (Rings + 1)];
            var normals = new Vector3[vertices.Length];
            var uvs = new Vector2[vertices.Length];
            for (int ring = 0; ring <= Rings; ring++)
            {
                float v = ring / (float)Rings;
                float radius = 0.5f + 0.5f * v * v;
                float slope = v; // dr/dv
                for (int s = 0; s <= Segments; s++)
                {
                    float u = s / (float)Segments;
                    float angle = u * 2f * Mathf.PI;
                    float cos = Mathf.Cos(angle), sin = Mathf.Sin(angle);
                    int i = ring * columns + s;
                    vertices[i] = new Vector3(cos * radius, v, sin * radius);
                    normals[i] = new Vector3(cos, -slope, sin).normalized;
                    uvs[i] = new Vector2(u, v);
                }
            }

            // Clockwise seen from outside (Unity's front faces); the shader draws both sides anyway.
            var triangles = new int[Segments * Rings * 6];
            int t = 0;
            for (int ring = 0; ring < Rings; ring++)
            {
                for (int s = 0; s < Segments; s++)
                {
                    int i0 = ring * columns + s, i1 = i0 + 1, i2 = i0 + columns, i3 = i2 + 1;
                    triangles[t++] = i0; triangles[t++] = i2; triangles[t++] = i1;
                    triangles[t++] = i1; triangles[t++] = i2; triangles[t++] = i3;
                }
            }

            var mesh = new Mesh { name = "DustDevilColumn" };
            mesh.vertices = vertices;
            mesh.normals = normals;
            mesh.uv = uvs;
            mesh.triangles = triangles;
            // Room for the shader's downwind lean and sway (up to ~0.35 diameters at the top), so the column is never
            // frustum-culled while its leaning top is still on screen.
            mesh.bounds = new Bounds(new Vector3(0f, 0.5f, 0f), new Vector3(3f, 1.2f, 3f));
            return mesh;
        }

        // ------------------------------------------------------------------ scene helpers

        // Finds or creates a direct child, on the Ignore Raycast layer, with an identity local transform.
        static GameObject Child(Transform parent, string name, bool undo)
        {
            Transform existing = parent.Find(name);
            GameObject go;
            if (existing == null)
            {
                go = new GameObject(name);
                go.transform.SetParent(parent, false);
                if (undo) Undo.RegisterCreatedObjectUndo(go, UndoName);
            }
            else
            {
                go = existing.gameObject;
                if (undo)
                {
                    Undo.RecordObject(go, UndoName);
                    Undo.RecordObject(go.transform, UndoName);
                }
            }
            go.layer = IgnoreRaycastLayer;
            go.transform.localPosition = Vector3.zero;
            go.transform.localRotation = Quaternion.identity;
            go.transform.localScale = Vector3.one;
            return go;
        }

        static T GetOrAdd<T>(GameObject go, bool undo) where T : Component
        {
            T component = go.GetComponent<T>();
            if (component == null) return undo ? Undo.AddComponent<T>(go) : go.AddComponent<T>();
            if (undo) Undo.RecordObject(component, UndoName);
            return component;
        }

        // The eye the effects follow: the player's camera if we can find it, else the main camera.
        static Transform FindEye(Transform hint)
        {
            if (hint != null)
            {
                var controller = hint.GetComponentInParent<FirstPersonController>();
                if (controller != null && controller.CameraTransform != null) return controller.CameraTransform;
                var camera = hint.root.GetComponentInChildren<Camera>(true);
                if (camera != null) return camera.transform;
            }
            Camera main = Camera.main;
            return main != null ? main.transform : null;
        }

        static void Set(SerializedObject so, string field, Object value)
        {
            SerializedProperty property = so.FindProperty(field);
            if (property == null) throw new System.InvalidOperationException($"{so.targetObject.GetType().Name} has no serialized field '{field}'.");
            property.objectReferenceValue = value;
        }

        static void Apply(SerializedObject so, bool undo)
        {
            if (undo) so.ApplyModifiedProperties();
            else so.ApplyModifiedPropertiesWithoutUndo();
        }

        static string EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return path;
            int slash = path.LastIndexOf('/');
            string parent = EnsureFolder(path.Substring(0, slash));
            AssetDatabase.CreateFolder(parent, path.Substring(slash + 1));
            return path;
        }
    }
}

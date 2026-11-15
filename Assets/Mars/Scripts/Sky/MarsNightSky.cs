using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace NasaSpaceApp
{
    /// <summary>
    /// The night sky you would really see from the scene's map coordinates (<see cref="MarsGeoReference"/>, Gale
    /// crater): the catalogue's ~5000 stars down to magnitude 6, the planets, the Earth and its Moon, Phobos and
    /// Deimos, each where it is at the instant <see cref="DayNightCycle"/> shows. The cycle publishes that instant and
    /// the sky's orientation through <see cref="MarsSkyState"/>; this component only reads it, so it never needs to
    /// find the cycle. The Sun and the Milky Way glow stay with the sky shader (NasaSpaceApp/Mars Sky).
    ///
    /// Stars and bodies are point sprites (NasaSpaceApp/Mars Stars) at infinity, submitted to every game and scene
    /// camera right before it renders. Sizes are in pixels, not degrees: at a modest resolution a real star image
    /// (far below a pixel) would vanish or shimmer, so brightness shows as size and intensity, like a planetarium
    /// projector (artistic). Which points show at all (twilight, air mass, dust, ice clouds) the shader decides per
    /// vertex from the same globals the sky uses, so the stars come out together with the sky darkening.
    ///
    /// Overlays, off by default and toggled in play mode: star names (<see cref="starNamesKey"/>, J; L is the head lamp), constellation
    /// lines and names (<see cref="constellationsKey"/>, K), planet and moon names (<see cref="planetsKey"/>, P).
    /// Each press shows a small legend with the keys and the sky's clock (sol, Ls, local true solar time, site, UTC);
    /// it also shows once, by itself, the first time night falls in a session.
    ///
    /// No scene edit is needed: when play starts in a scene with a DayNightCycle and no MarsNightSky, one is added to
    /// the cycle's GameObject (<see cref="Bootstrap"/>). Added by hand, it also previews in edit mode and keeps its
    /// settings.
    /// </summary>
    [ExecuteAlways, DisallowMultipleComponent]
    public class MarsNightSky : MonoBehaviour
    {
        const string CatalogueResource = "MarsSkyCatalog";
        const string StarShaderName = "NasaSpaceApp/Mars Stars";
        const string LineShaderName = "NasaSpaceApp/Mars Constellation Lines";

        [Header("Catalogue")]
        [SerializeField, Range(3f, 6f), Tooltip("Faintest stars built into the sky (visual magnitude). 6 is the naked-eye limit under a dark sky: the catalogue holds 5044 stars down to 6.0, 519 down to 4. Lower values only drop the faint ones; the rest keep their size and brightness.")]
        float limitingMagnitude = 6f;

        [Header("Look")]
        [SerializeField, Min(0.5f), Tooltip("Radius in pixels of the faintest stars. Larger than a real star's image on purpose: a 1-pixel star vanishes or flickers at modest resolutions. Artistic.")]
        float minStarSizePx = 1.4f;
        [SerializeField, Min(0.5f), Tooltip("Radius in pixels of the brightest stars (Sirius) and of anything brighter. Artistic.")]
        float maxStarSizePx = 4.5f;
        [SerializeField, Min(0f), Tooltip("Peak brightness (HDR) of a star at full night, before air mass, dust and clouds. The few objects brighter than magnitude -1.5 get up to 35% more, so they catch the bloom. Artistic.")]
        float starBrightness = 1.6f;
        [SerializeField, Tooltip("NasaSpaceApp/Mars Stars. Filled in with Shader.Find when empty. In a build Shader.Find only finds shaders the build includes: keep this component saved in the scene with this reference (the automatic runtime copy has none), or add the shader to Always Included Shaders.")]
        Shader starShader;
        [SerializeField, Tooltip("NasaSpaceApp/Mars Constellation Lines. Filled in with Shader.Find when empty; the same build caveat as the star shader applies.")]
        Shader lineShader;

        [Header("Overlays")]
        [SerializeField, Tooltip("Names of the brightest stars (see Star Name Magnitude).")]
        bool showStarNames;
        [SerializeField, Tooltip("Constellation lines and names, like a planetarium's overlay: they are not dimmed by clouds or dust.")]
        bool showConstellations;
        [SerializeField, Tooltip("Names of the planets, the Earth and its Moon, Phobos and Deimos, each with a thin ring. The bodies themselves are always drawn.")]
        bool showPlanets;
        [SerializeField, Tooltip("Toggles star names in play mode. None disables the key.")]
        Key starNamesKey = Key.J;
        [SerializeField, Tooltip("Toggles constellation lines and names in play mode. None disables the key.")]
        Key constellationsKey = Key.K;
        [SerializeField, Tooltip("Toggles planet and moon names in play mode. None disables the key.")]
        Key planetsKey = Key.P;
        [SerializeField, Range(-1.5f, 3.5f), Tooltip("Only stars at least this bright get a name: keeps the sky readable at low resolution. 2.0 allows the ~50 brightest stars of the whole sky (about half of them are up at once); the catalogue names stars down to 3.5.")]
        float starNameMagnitude = 2.0f;
        [SerializeField, Tooltip("Hides a label when the terrain (or any collider) stands between the camera and its object: Mount Sharp hides the stars behind it. One raycast per visible label, spread over frames.")]
        bool hideLabelsBehindTerrain = true;

        /// <summary>Star names overlay (the key toggles it in play mode; in play mode it fades in and out).</summary>
        public bool ShowStarNames { get => showStarNames; set => showStarNames = value; }

        /// <summary>Constellation lines and names overlay.</summary>
        public bool ShowConstellations { get => showConstellations; set => showConstellations = value; }

        /// <summary>Planet and moon names overlay (the bodies themselves are always drawn).</summary>
        public bool ShowPlanets { get => showPlanets; set => showPlanets = value; }

        // ------------------------------------------------------------------ constants

        // The bodies drawn here, in mesh order. The Sun is the sky shader's own disk.
        static readonly SkyBody[] Bodies =
        {
            SkyBody.Mercury, SkyBody.Venus, SkyBody.Earth, SkyBody.Moon, SkyBody.Jupiter,
            SkyBody.Saturn, SkyBody.Uranus, SkyBody.Neptune, SkyBody.Phobos, SkyBody.Deimos,
        };

        // Linear tints, artistic: each body's familiar hue, kept pale because at these magnitudes the eye sees little
        // colour. Phobos and Deimos are dark carbonaceous-looking rock (albedo ~0.07), hence their grey-brown.
        static readonly Color[] BodyTints =
        {
            new Color(0.80f, 0.76f, 0.72f), // Mercury
            new Color(1.00f, 0.96f, 0.86f), // Venus
            new Color(0.62f, 0.78f, 1.00f), // Earth
            new Color(0.85f, 0.84f, 0.82f), // Moon
            new Color(1.00f, 0.93f, 0.80f), // Jupiter
            new Color(1.00f, 0.88f, 0.66f), // Saturn
            new Color(0.72f, 0.92f, 0.95f), // Uranus
            new Color(0.55f, 0.68f, 1.00f), // Neptune
            new Color(0.52f, 0.48f, 0.45f), // Phobos
            new Color(0.70f, 0.66f, 0.62f), // Deimos
        };

        // A moon inside Mars's shadow keeps only a trace of light (Mars's twilight ring, the penumbra). Artistic
        // estimate, not a photometric eclipse model. Phobos crosses the shadow on most orbits near the equinoxes.
        const float EclipseDimming = 0.03f;

        // TEXCOORD0.w of the Mars Stars shader: 0 star, 1 point body, 2 disk body (resolved, with its phase).
        const float KindStar = 0f, KindPoint = 1f, KindDisk = 2f;
        const float HiddenMagnitude = 99f; // the shader's visibility test turns this into a zero-area quad

        // Quad corners in the order the indices expect: (0, 1, 2) and (0, 2, 3).
        static readonly Vector2[] Corners = { new Vector2(-1f, -1f), new Vector2(-1f, 1f), new Vector2(1f, 1f), new Vector2(1f, -1f) };

        // The Mars Stars vertex layout (SPEC 5.4). One interleaved stream, attributes in Unity's required order.
        static readonly VertexAttributeDescriptor[] PointLayout =
        {
            new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.Float32, 3),
            new VertexAttributeDescriptor(VertexAttribute.Color, VertexAttributeFormat.Float32, 4),
            new VertexAttributeDescriptor(VertexAttribute.TexCoord0, VertexAttributeFormat.Float32, 4),
            new VertexAttributeDescriptor(VertexAttribute.TexCoord1, VertexAttributeFormat.Float32, 4),
        };

        static readonly VertexAttributeDescriptor[] LineLayout =
        {
            new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.Float32, 3),
            new VertexAttributeDescriptor(VertexAttribute.Color, VertexAttributeFormat.Float32, 4),
        };

        [StructLayout(LayoutKind.Sequential)]
        struct PointVertex
        {
            public Vector3 Direction; // POSITION: ICRF unit direction
            public Vector4 Tint;      // COLOR: linear rgb, a unused
            public Vector4 Shape;     // TEXCOORD0: corner x, corner y, magnitude, kind
            public Vector4 Disk;      // TEXCOORD1: Sun direction from Mars (ICRF), angular radius (rad); kind 2 only

            public PointVertex(Vector3 direction, Vector4 tint, Vector4 shape, Vector4 disk)
            {
                Direction = direction;
                Tint = tint;
                Shape = shape;
                Disk = disk;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct LineVertex
        {
            public Vector3 Direction; // POSITION: ICRF unit direction
            public Vector4 Tint;      // COLOR: white; the material sets the colour
        }

        // Rebuilt every frame in play mode (the clock moves): no validation, no bounds, the indices never change.
        const MeshUpdateFlags QuietUpdate = MeshUpdateFlags.DontValidateIndices | MeshUpdateFlags.DontRecalculateBounds
                                            | MeshUpdateFlags.DontNotifyMeshUsers | MeshUpdateFlags.DontResetBoneBounds;

        // Everything sits at infinity (the shader puts it on the far plane), so the bounds only have to never cull.
        static readonly Bounds HugeBounds = new Bounds(Vector3.zero, Vector3.one * 2e7f);

        static readonly int MinSizeId = Shader.PropertyToID("_MinSizePx");
        static readonly int MaxSizeId = Shader.PropertyToID("_MaxSizePx");
        static readonly int BrightnessId = Shader.PropertyToID("_Brightness");
        static readonly int LimitMagId = Shader.PropertyToID("_LimitMag");
        static readonly int CloudScaleId = Shader.PropertyToID("_CloudScale");
        static readonly int OpacityId = Shader.PropertyToID("_Opacity");
        const float DefaultCloudScale = 0.06f; // MarsSky.shader's default, used when the skybox is another material
        const float DefaultLimitMag = 6f;      // Mars Stars' _LimitMag default (naked-eye limit at full night)

        // Labels: typography from the HUD pass (Operate mode: legibility over decoration). One family, the IMGUI default.
        const int MinFontPx = 12, MaxFontPx = 20;
        const float FontDivisor = 70f;          // base size = screen height / 70: 12 px at 720p and below, 15 px at 1080p
        const float LabelOffsetPx = 6f;         // gap between a point (or ring) and its label
        const float LabelGapPx = 2f;            // labels closer than this count as overlapping (outline + 1 px of air)
        const float OutlineAlpha = 0.6f;
        const float RingScale = 1.1f, RingStrokePx = 1.5f, RingAlpha = 0.7f;
        static readonly Color PlanetColor = new Color(1.00f, 0.78f, 0.45f, 1f);        // primary: warm amber, bold
        static readonly Color StarNameColor = new Color(0.80f, 0.92f, 1.00f, 0.95f);   // secondary: pale cyan-white
        static readonly Color ConstellationColor = new Color(0.55f, 0.68f, 0.95f, 0.85f); // ambient: muted blue, caps
        static readonly Color LegendColor = new Color(0.80f, 0.92f, 1.00f, 0.9f);      // metadata
        // Outline: the text drawn four times, one pixel off each way, in translucent black (no glow).
        static readonly Vector2[] OutlineOffsets = { new Vector2(1f, 0f), new Vector2(-1f, 0f), new Vector2(0f, 1f), new Vector2(0f, -1f) };

        const float HorizonCut = -0.01f;          // sine of the elevation below which a label is not drawn
        const float ProjectionDistance = 1000f;   // any distance well inside the far plane works: only the direction matters
        const float TerrainRayLength = 200000f;   // 200 km: past Gale's rim and Mount Sharp, the farthest terrain there is
        // Raycast budget: a terrain ray over 200 km can cost tens of microseconds, and a full sky of names is a few
        // hundred labels. Only labels that are on screen and would be placed are tested, each at most every few
        // repaints, and no more than this many per repaint; a label waits hidden until its first test.
        const int MaxRaycastsPerRepaint = 48;
        const int RecheckRepaints = 6;
        const int ExpireRepaints = 30;

        const float OverlayFadeSeconds = 0.25f;
        const float ToggleLegendSeconds = 4f, FirstNightLegendSeconds = 6f, LegendFadeSeconds = 0.5f;
        const float LegendRefreshSeconds = 1f;    // the clock line changes every Mars minute (~0.8 real s at 1200 s per sol)
        const float FirstNightDarkness = 0.6f;
        // Top-left, 48 px from both edges at 1080p (scaled with the screen height): the helmet HUD keeps that corner
        // free (about 420 x 120 px) and puts its compass dial bottom-left and the vitals bottom-right.
        const float LegendEdgePx1080 = 48f, LegendPaddingPx = 8f, LegendBackdropAlpha = 0.45f;
        const string Separator = "  ·  ";
        const string GroupGap = "     ";

        static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;

        static bool firstNightLegendShown; // once per play session (reset below: domain reload is off)
        static bool warnedShader;

        // ------------------------------------------------------------------ state

        Catalogue catalogue;
        Material starMaterial, lineMaterial;
        Mesh starMesh, bodyMesh, lineMesh;
        int starQuads;
        float starMeshLimit = float.NaN;
        bool shadersSearched;
        Action<ScriptableRenderContext, Camera> onBeginCamera;

        // Bodies: recomputed when MarsSkyState publishes a new instant, uploaded to the mesh when it changed.
        readonly PointVertex[] bodyVertices = new PointVertex[Bodies.Length * 4];
        readonly SkyLabel[] bodyLabels = new SkyLabel[Bodies.Length];
        readonly int[] bodyOrder = new int[Bodies.Length]; // brightest first: the label priority
        bool bodiesValid;
        int bodiesVersion, bodiesSerial, bodyMeshSerial = -1;
        double bodiesDays = double.NaN;

        // Labels.
        SkyLabel[] starLabels = Array.Empty<SkyLabel>();          // brightest first
        SkyLabel[] constellationLabels = Array.Empty<SkyLabel>(); // most prominent (rank 1) first
        Catalogue labelledCatalogue;
        readonly List<Rect> placed = new List<Rect>(256);
        [NonSerialized] GUIStyle planetStyle, starStyle, constellationStyle, legendStyle;
        [NonSerialized] int styledSize = -1;
        [NonSerialized] int labelsSizedFor = -1;
        Texture2D ringTexture;
        int ringDiameter;
        int repaintStamp, raycastBudget;
        Camera labelCamera;
        Vector3 labelEye;
        Matrix4x4 labelToWorld;

        // Overlay fades, 0..1, animated in play mode only (edit mode shows or hides at once).
        float starNamesFade, constellationsFade, planetsFade;

        // Legend toast.
        readonly GUIContent legendKeys = new GUIContent();
        readonly GUIContent legendClock = new GUIContent();
        readonly StringBuilder legendText = new StringBuilder(160);
        Vector2 legendKeysSize, legendClockSize;
        bool legendSized;
        float legendUntil = float.NegativeInfinity, legendRefreshAt;

        struct SkyLabel
        {
            public Vector3 Icrf;
            public float Magnitude; // stars and bodies; constellations keep their rank here
            public GUIContent Content;
            public Vector2 Size;    // at the current font size
            public int CheckedAt;   // repaint stamp of the last terrain raycast, -1 = never
            public bool Behind;     // that raycast hit something

            public SkyLabel(Vector3 icrf, float magnitude, string text)
            {
                Icrf = icrf;
                Magnitude = magnitude;
                Content = new GUIContent(text);
                Size = Vector2.zero;
                CheckedAt = -1;
                Behind = false;
            }
        }

        // ------------------------------------------------------------------ lifecycle

        // No scene edit needed: the night sky follows any DayNightCycle. One the scene already has (even disabled or
        // on an inactive object) wins, so a hand-placed, configured component is never doubled.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Bootstrap()
        {
            if (FindAnyObjectByType<MarsNightSky>(FindObjectsInactive.Include) != null) return;
            DayNightCycle cycle = FindAnyObjectByType<DayNightCycle>();
            if (cycle != null) cycle.gameObject.AddComponent<MarsNightSky>();
        }

        // Domain reload is off (Enter Play Mode Options): statics would otherwise carry over between play sessions.
        // The parsed catalogue is immutable data and is kept on purpose.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics() => firstNightLegendShown = false;

        void Reset() => FillShaders();

        void OnValidate()
        {
            FillShaders();
            shadersSearched = false; // a newly assigned shader is picked up on the next draw
#if UNITY_EDITOR
            if (!Application.isPlaying) UnityEditor.EditorApplication.QueuePlayerLoopUpdate();
#endif
        }

        void OnEnable()
        {
            useGUILayout = false; // labels use absolute rects only: no layout pass and none of its allocations
            catalogue = Catalogue.LoadShared();
            BuildCatalogueLabels();
            InitBodyLabels();
            bodiesValid = false;
            bodyMeshSerial = -1;
            shadersSearched = false;
            starNamesFade = showStarNames ? 1f : 0f;
            constellationsFade = showConstellations ? 1f : 0f;
            planetsFade = showPlanets ? 1f : 0f;
            onBeginCamera ??= OnBeginCamera;
            RenderPipelineManager.beginCameraRendering += onBeginCamera;
        }

        void OnDisable()
        {
            if (onBeginCamera != null) RenderPipelineManager.beginCameraRendering -= onBeginCamera;
            Release(ref starMesh);
            Release(ref bodyMesh);
            Release(ref lineMesh);
            Release(ref starMaterial);
            Release(ref lineMaterial);
            Release(ref ringTexture);
            starMeshLimit = float.NaN;
            bodyMeshSerial = -1;
            styledSize = -1; // the ring texture is rebuilt with the styles
        }

        void Update()
        {
            if (!Application.isPlaying) return; // edit mode: no keys, the overlays show or hide at once

            ReadKeys();
            float step = Time.unscaledDeltaTime / OverlayFadeSeconds;
            starNamesFade = Mathf.MoveTowards(starNamesFade, showStarNames ? 1f : 0f, step);
            constellationsFade = Mathf.MoveTowards(constellationsFade, showConstellations ? 1f : 0f, step);
            planetsFade = Mathf.MoveTowards(planetsFade, showPlanets ? 1f : 0f, step);

            // Discoverability: the first time night falls, say once that the sky can be labelled.
            if (!firstNightLegendShown && MarsSkyState.Darkness > FirstNightDarkness)
            {
                firstNightLegendShown = true;
                ShowLegend(FirstNightLegendSeconds);
            }
        }

        void ReadKeys()
        {
            Keyboard keyboard = Keyboard.current;
            if (keyboard == null) return;
            bool pressed = false;
            if (WasPressed(keyboard, starNamesKey)) { showStarNames = !showStarNames; pressed = true; }
            if (WasPressed(keyboard, constellationsKey)) { showConstellations = !showConstellations; pressed = true; }
            if (WasPressed(keyboard, planetsKey)) { showPlanets = !showPlanets; pressed = true; }
            if (pressed) ShowLegend(ToggleLegendSeconds);
        }

        static bool WasPressed(Keyboard keyboard, Key key) => key != Key.None && keyboard[key].wasPressedThisFrame;

        // Play mode eases the fade (smoothstep over 0.25 s); edit mode follows the toggle at once.
        static float OverlayAlpha(float fade, bool on)
        {
            if (!Application.isPlaying) return on ? 1f : 0f;
            return fade * fade * (3f - 2f * fade);
        }

        void FillShaders()
        {
            if (starShader == null) starShader = Shader.Find(StarShaderName);
            if (lineShader == null) lineShader = Shader.Find(LineShaderName);
        }

        static void Release<T>(ref T obj) where T : UnityEngine.Object
        {
            if (obj != null)
            {
                if (Application.isPlaying) Destroy(obj);
                else DestroyImmediate(obj);
            }
            obj = null;
        }

        // ------------------------------------------------------------------ drawing

        // Submitted per camera right before it renders, so the points exist only for game and scene cameras (no
        // reflection probes or previews) and nothing is added to the scene.
        void OnBeginCamera(ScriptableRenderContext context, Camera cam)
        {
            CameraType type = cam.cameraType;
            if (type != CameraType.Game && type != CameraType.SceneView) return;
            // An overlay camera stacked on the main one (a HUD) would add the stars a second time.
            if (type == CameraType.Game && cam.TryGetComponent(out UniversalAdditionalCameraData extra)
                && extra.renderType == CameraRenderType.Overlay) return;
            if (!Prepare()) return;

            var rp = new RenderParams(starMaterial)
            {
                camera = cam,
                layer = gameObject.layer,
                worldBounds = new Bounds(cam.transform.position, Vector3.one * 1e7f),
                shadowCastingMode = ShadowCastingMode.Off,
                receiveShadows = false,
                lightProbeUsage = LightProbeUsage.Off,
                reflectionProbeUsage = ReflectionProbeUsage.Off,
            };
            if (starQuads > 0) Graphics.RenderMesh(rp, starMesh, 0, Matrix4x4.identity);
            if (bodiesValid) Graphics.RenderMesh(rp, bodyMesh, 0, Matrix4x4.identity);

            float lines = OverlayAlpha(constellationsFade, showConstellations);
            if (lines > 0f && lineMaterial != null && lineMesh != null && catalogue.LineEnds.Length > 0)
            {
                lineMaterial.SetFloat(OpacityId, lines);
                rp.material = lineMaterial;
                Graphics.RenderMesh(rp, lineMesh, 0, Matrix4x4.identity);
            }
        }

        // Makes sure materials and meshes exist and are current. Cheap when nothing changed, so every camera calls it.
        bool Prepare()
        {
            // Version 0: nothing was ever published, and _MarsCelestial would still be unset.
            if (catalogue == null || MarsSkyState.Version == 0 || !EnsureMaterials()) return false;

            if (starMesh == null || starMeshLimit != limitingMagnitude) BuildStarMesh();
            if (lineMesh == null) BuildLineMesh();
            if (bodyMesh == null) CreateBodyMesh();
            RefreshBodiesIfStale();
            if (bodiesValid && bodyMeshSerial != bodiesSerial)
            {
                bodyMesh.SetVertexBufferData(bodyVertices, 0, 0, bodyVertices.Length, 0, QuietUpdate);
                bodyMeshSerial = bodiesSerial;
            }

            // The points sit behind the sky's ice clouds, so they use the sky material's cloud cell size.
            Material sky = RenderSettings.skybox;
            float cloudScale = sky != null && sky.HasProperty(CloudScaleId) ? sky.GetFloat(CloudScaleId) : DefaultCloudScale;
            starMaterial.SetFloat(CloudScaleId, cloudScale);
            starMaterial.SetFloat(MinSizeId, minStarSizePx);
            starMaterial.SetFloat(MaxSizeId, Mathf.Max(maxStarSizePx, minStarSizePx));
            starMaterial.SetFloat(BrightnessId, starBrightness);
            // _LimitMag stays at the shader's 6 (the eye's limit at full night) whatever limitingMagnitude is: that
            // setting only drops faint stars, it must not resize or dim the ones kept.
            return true;
        }

        bool EnsureMaterials()
        {
            if (!shadersSearched)
            {
                shadersSearched = true; // Shader.Find is a name lookup: once per enable or edit, not per frame
                FillShaders();
                if ((starShader == null || lineShader == null) && !warnedShader)
                {
                    warnedShader = true;
                    Debug.LogWarning($"MarsNightSky: shader '{(starShader == null ? StarShaderName : LineShaderName)}' not found. " +
                                     "In a build Shader.Find only finds included shaders: keep a MarsNightSky saved in the scene " +
                                     "with its shader references, or add the shaders to Always Included Shaders.", this);
                }
            }
            if (starShader == null) return false;

            if (starMaterial == null) starMaterial = NewMaterial(starShader, "Mars Night Sky Points");
            else if (starMaterial.shader != starShader) starMaterial.shader = starShader;

            if (lineShader == null) Release(ref lineMaterial);
            else if (lineMaterial == null) lineMaterial = NewMaterial(lineShader, "Mars Night Sky Constellation Lines");
            else if (lineMaterial.shader != lineShader) lineMaterial.shader = lineShader;
            return true;
        }

        static Material NewMaterial(Shader shader, string name) =>
            new Material(shader) { name = name, hideFlags = HideFlags.HideAndDontSave };

        static Mesh NewMesh(string name) => new Mesh { name = name, hideFlags = HideFlags.HideAndDontSave };

        // Static: rebuilt only when the limiting magnitude changes. Four vertices per star, all carrying the star's
        // direction; the shader opens the quad in pixels around it.
        void BuildStarMesh()
        {
            Release(ref starMesh);
            Catalogue.Star[] stars = catalogue.Stars;
            int count = 0;
            for (int i = 0; i < stars.Length; i++)
                if (stars[i].Magnitude <= limitingMagnitude) count++;

            var vertices = new PointVertex[count * 4];
            int v = 0;
            for (int i = 0; i < stars.Length; i++)
            {
                Catalogue.Star star = stars[i];
                if (star.Magnitude > limitingMagnitude) continue;
                Vector4 tint = StarColor(star.ColorIndex);
                for (int c = 0; c < 4; c++)
                    vertices[v++] = new PointVertex(star.Icrf, tint, new Vector4(Corners[c].x, Corners[c].y, star.Magnitude, KindStar), Vector4.zero);
            }

            starMesh = NewMesh("Mars Night Sky Stars");
            starMesh.SetVertexBufferParams(vertices.Length, PointLayout);
            starMesh.SetVertexBufferData(vertices, 0, 0, vertices.Length, 0, MeshUpdateFlags.DontRecalculateBounds);
            SetQuadIndices(starMesh, count);
            starMesh.UploadMeshData(true); // never read back: free the CPU copy
            starQuads = count;
            starMeshLimit = limitingMagnitude;
        }

        // Static: one segment per catalogue line, white (the material holds the colour and the fade).
        void BuildLineMesh()
        {
            Vector3[] ends = catalogue.LineEnds;
            var vertices = new LineVertex[ends.Length];
            for (int i = 0; i < ends.Length; i++) vertices[i] = new LineVertex { Direction = ends[i], Tint = Vector4.one };

            lineMesh = NewMesh("Mars Night Sky Constellation Lines");
            lineMesh.SetVertexBufferParams(vertices.Length, LineLayout);
            lineMesh.SetVertexBufferData(vertices, 0, 0, vertices.Length, 0, MeshUpdateFlags.DontRecalculateBounds);
            if (vertices.Length <= 65536)
            {
                var indices = new ushort[vertices.Length];
                for (int i = 0; i < indices.Length; i++) indices[i] = (ushort)i;
                lineMesh.SetIndexBufferParams(indices.Length, IndexFormat.UInt16);
                lineMesh.SetIndexBufferData(indices, 0, 0, indices.Length, MeshUpdateFlags.DontRecalculateBounds);
            }
            else
            {
                var indices = new int[vertices.Length];
                for (int i = 0; i < indices.Length; i++) indices[i] = i;
                lineMesh.SetIndexBufferParams(indices.Length, IndexFormat.UInt32);
                lineMesh.SetIndexBufferData(indices, 0, 0, indices.Length, MeshUpdateFlags.DontRecalculateBounds);
            }
            lineMesh.subMeshCount = 1;
            lineMesh.SetSubMesh(0, new SubMeshDescriptor(0, vertices.Length, MeshTopology.Lines), MeshUpdateFlags.DontRecalculateBounds);
            lineMesh.bounds = HugeBounds;
            lineMesh.UploadMeshData(true);
        }

        // Dynamic: ten quads whose vertices are rewritten whenever the instant changes; the indices never do.
        void CreateBodyMesh()
        {
            bodyMesh = NewMesh("Mars Night Sky Bodies");
            bodyMesh.MarkDynamic();
            bodyMesh.SetVertexBufferParams(bodyVertices.Length, PointLayout);
            SetQuadIndices(bodyMesh, Bodies.Length);
            bodyMeshSerial = -1;
        }

        static void SetQuadIndices(Mesh mesh, int quads)
        {
            int indexCount = quads * 6;
            if (quads * 4 <= 65536) // 16-bit indices reach vertex 65535: 16384 quads, three times the catalogue
            {
                var indices = new ushort[indexCount];
                for (int q = 0; q < quads; q++)
                {
                    int i = q * 6, v = q * 4;
                    indices[i] = (ushort)v;
                    indices[i + 1] = (ushort)(v + 1);
                    indices[i + 2] = (ushort)(v + 2);
                    indices[i + 3] = (ushort)v;
                    indices[i + 4] = (ushort)(v + 2);
                    indices[i + 5] = (ushort)(v + 3);
                }
                mesh.SetIndexBufferParams(indexCount, IndexFormat.UInt16);
                mesh.SetIndexBufferData(indices, 0, 0, indexCount, MeshUpdateFlags.DontRecalculateBounds);
            }
            else
            {
                var indices = new int[indexCount];
                for (int q = 0; q < quads; q++)
                {
                    int i = q * 6, v = q * 4;
                    indices[i] = v;
                    indices[i + 1] = v + 1;
                    indices[i + 2] = v + 2;
                    indices[i + 3] = v;
                    indices[i + 4] = v + 2;
                    indices[i + 5] = v + 3;
                }
                mesh.SetIndexBufferParams(indexCount, IndexFormat.UInt32);
                mesh.SetIndexBufferData(indices, 0, 0, indexCount, MeshUpdateFlags.DontRecalculateBounds);
            }
            mesh.subMeshCount = 1;
            mesh.SetSubMesh(0, new SubMeshDescriptor(0, indexCount, MeshTopology.Triangles), MeshUpdateFlags.DontRecalculateBounds);
            mesh.bounds = HugeBounds;
        }

        // Planets and moons at the published instant: direction from the observer (topocentric: Phobos shifts by up
        // to ~21 degrees between Mars's centre and the surface), magnitude, phase lighting for Phobos's disk, and the
        // shadow test. Recomputed only when MarsSkyState publishes (every frame in play mode, as the clock runs).
        void RefreshBodiesIfStale()
        {
            int version = MarsSkyState.Version;
            double d = MarsSkyState.DaysTT;
            if (bodiesValid && version == bodiesVersion && d == bodiesDays) return;

            DVec3 observer = MarsEphemeris.ObserverIcrfKm(d, MarsSkyState.Latitude, MarsSkyState.Longitude, MarsSkyState.ObserverRadiusKm);
            Vector3 sun = ToUnit(MarsEphemeris.MarsCentricIcrf(SkyBody.Sun, d));
            for (int i = 0; i < Bodies.Length; i++)
            {
                SkyBody body = Bodies[i];
                Vector3 direction = ToUnit(MarsEphemeris.TopocentricIcrf(body, d, observer));
                float magnitude = (float)MarsEphemeris.ApparentMagnitude(body, d, observer, out _, out double angularRadius);
                if (direction == Vector3.zero || float.IsNaN(magnitude) || float.IsInfinity(magnitude)) magnitude = HiddenMagnitude;

                Color tint = BodyTints[i];
                if (MarsEphemeris.InMarsShadow(body, d)) tint *= EclipseDimming; // false for all but Phobos and Deimos
                float kind = body == SkyBody.Phobos ? KindDisk : KindPoint;
                var disk = new Vector4(sun.x, sun.y, sun.z, (float)angularRadius);
                for (int c = 0; c < 4; c++)
                    bodyVertices[i * 4 + c] = new PointVertex(direction, tint, new Vector4(Corners[c].x, Corners[c].y, magnitude, kind), disk);

                bodyLabels[i].Icrf = direction;
                bodyLabels[i].Magnitude = magnitude;
                bodyOrder[i] = i;
            }

            // Brightest first (insertion sort: ten entries, no allocation).
            for (int i = 1; i < bodyOrder.Length; i++)
            {
                int k = bodyOrder[i], j = i - 1;
                while (j >= 0 && bodyLabels[bodyOrder[j]].Magnitude > bodyLabels[k].Magnitude)
                {
                    bodyOrder[j + 1] = bodyOrder[j];
                    j--;
                }
                bodyOrder[j + 1] = k;
            }

            bodiesVersion = version;
            bodiesDays = d;
            bodiesValid = true;
            bodiesSerial++;
        }

        static Vector3 ToUnit(DVec3 v)
        {
            double length = v.Length;
            if (!(length > 0.0) || double.IsInfinity(length)) return Vector3.zero;
            return new Vector3((float)(v.X / length), (float)(v.Y / length), (float)(v.Z / length));
        }

        /// <summary>
        /// Linear tint of a star from its B-V colour index. Temperature: T = 4600 K (1/(0.92 bv + 1.7) + 1/(0.92 bv + 0.62))
        /// (Ballesteros 2012, EPL 97, 34008, a black body fitted to B-V); black body to sRGB with Tanner Helland's curve
        /// fit (2012), brightest channel normalised to 1, then half-way to white, because the eye sees stars almost
        /// colourless (only the strongest hues, Antares or Rigel, read as tinted). The white blend is artistic.
        /// </summary>
        public static Color StarColor(float bv)
        {
            // The formula's poles sit at bv = -0.67 and -1.85. Most stars span about -0.4 (O/B) to 2 (late M); the few
            // redder ones (carbon stars) are clamped.
            float b = Mathf.Clamp(bv, -0.4f, 2f);
            float kelvin = 4600f * (1f / (0.92f * b + 1.7f) + 1f / (0.92f * b + 0.62f));
            Color c = BlackbodySrgb(kelvin);
            float max = Mathf.Max(c.r, Mathf.Max(c.g, c.b));
            if (max > 0f)
            {
                c.r /= max;
                c.g /= max;
                c.b /= max;
            }
            c = Color.Lerp(c, Color.white, 0.5f);
            c.a = 1f;
            return c.linear;
        }

        // Tanner Helland's 2012 curve fit of black-body colours to sRGB (0..1 here), valid from about 1000 to 40000 K.
        // An approximation good to a few percent, plenty for a tint that is then half-blended to white.
        static Color BlackbodySrgb(float kelvin)
        {
            float t = kelvin / 100f;
            float r, g, b;
            if (t <= 66f)
            {
                r = 255f;
                g = 99.4708025861f * Mathf.Log(t) - 161.1195681661f;
            }
            else
            {
                r = 329.698727446f * Mathf.Pow(t - 60f, -0.1332047592f);
                g = 288.1221695283f * Mathf.Pow(t - 60f, -0.0755148492f);
            }
            if (t >= 66f) b = 255f;
            else if (t <= 19f) b = 0f;
            else b = 138.5177312231f * Mathf.Log(t - 10f) - 305.0447927307f;
            return new Color(Mathf.Clamp(r, 0f, 255f) / 255f, Mathf.Clamp(g, 0f, 255f) / 255f, Mathf.Clamp(b, 0f, 255f) / 255f, 1f);
        }

        // ------------------------------------------------------------------ labels

        void InitBodyLabels()
        {
            if (bodyLabels[0].Content != null) return;
            for (int i = 0; i < Bodies.Length; i++)
                bodyLabels[i] = new SkyLabel(Vector3.zero, HiddenMagnitude, MarsEphemeris.DisplayName(Bodies[i]));
        }

        void BuildCatalogueLabels()
        {
            if (catalogue == labelledCatalogue) return;
            labelledCatalogue = catalogue;
            if (catalogue == null)
            {
                starLabels = Array.Empty<SkyLabel>();
                constellationLabels = Array.Empty<SkyLabel>();
                return;
            }

            Catalogue.Label[] names = catalogue.StarNames;
            starLabels = new SkyLabel[names.Length];
            for (int i = 0; i < names.Length; i++)
                starLabels[i] = new SkyLabel(names[i].Icrf, names[i].Value, names[i].Name);

            Catalogue.Label[] constellations = catalogue.ConstellationNames;
            constellationLabels = new SkyLabel[constellations.Length];
            for (int i = 0; i < constellations.Length; i++)
                constellationLabels[i] = new SkyLabel(constellations[i].Icrf, constellations[i].Value, constellations[i].Name.ToUpperInvariant());
            labelsSizedFor = -1;
        }

        void OnGUI()
        {
            if (NasaSpaceApp.Menu.MartisMenu.IsOpen) return; // the title / pause screen covers the view
            if (Event.current.type != EventType.Repaint) return;

            float now = Time.unscaledTime;
            float legendAlpha = Application.isPlaying ? LegendAlpha(now) : 0f;
            float planets = OverlayAlpha(planetsFade, showPlanets);
            float names = OverlayAlpha(starNamesFade, showStarNames);
            float constellations = OverlayAlpha(constellationsFade, showConstellations);
            bool labels = (planets > 0f || names > 0f || constellations > 0f) && MarsSkyState.Version != 0;
            if (!labels && legendAlpha <= 0f) return;

            EnsureStyles();
            int size = Mathf.Clamp(Mathf.RoundToInt(Screen.height / FontDivisor), MinFontPx, MaxFontPx);
            if (size != styledSize) ApplySize(size);
            if (labelsSizedFor != styledSize) SizeLabels();

            Color oldColor = GUI.color, oldContent = GUI.contentColor;
            GUI.color = Color.white;
            GUI.contentColor = Color.white;
            placed.Clear();

            // The legend claims its corner first, so no label is ever drawn under it.
            Rect legend = default;
            if (legendAlpha > 0f)
            {
                if (now >= legendRefreshAt) RefreshLegend(now);
                if (!legendSized) SizeLegend();
                float width = Mathf.Max(legendKeysSize.x, legendClockSize.x) + 2f * LegendPaddingPx;
                float height = legendKeysSize.y + legendClockSize.y + 2f * LegendPaddingPx;
                float edge = LegendEdgePx1080 * Screen.height / 1080f;
                legend = new Rect(edge, edge, width, height);
                placed.Add(legend);
            }

            if (labels) DrawLabels(planets, names, constellations);
            if (legendAlpha > 0f) DrawLegend(legend, legendAlpha);

            GUI.color = oldColor;
            GUI.contentColor = oldContent;
        }

        // Greedy placement in priority order (planets and moons, star names by magnitude, constellation names by rank):
        // a label whose rect touches one already placed is skipped, so labels never overlap.
        void DrawLabels(float planets, float names, float constellations)
        {
            Camera cam = Camera.main;
            if (cam == null) return;
            labelCamera = cam;
            labelEye = cam.transform.position;
            labelToWorld = MarsSkyState.CelestialToWorld;
            repaintStamp++;
            raycastBudget = MaxRaycastsPerRepaint;

            if (planets > 0f)
            {
                RefreshBodiesIfStale();
                float ringSize = ringTexture != null ? ringTexture.width : 0f;
                float ringRadius = ringDiameter * 0.5f;
                for (int k = 0; k < bodyOrder.Length; k++)
                {
                    ref SkyLabel label = ref bodyLabels[bodyOrder[k]];
                    if (label.Magnitude >= HiddenMagnitude || !Project(label.Icrf, out Vector3 direction, out Vector2 point)) continue;
                    Rect text = RightOf(point, ringRadius, label.Size);
                    var ring = new Rect(Mathf.Round(point.x - ringSize * 0.5f), Mathf.Round(point.y - ringSize * 0.5f), ringSize, ringSize);
                    Rect claim = Rect.MinMaxRect(Mathf.Min(text.xMin, ring.xMin), Mathf.Min(text.yMin, ring.yMin),
                                                 Mathf.Max(text.xMax, ring.xMax), Mathf.Max(text.yMax, ring.yMax));
                    if (!Claim(claim, ref label, direction)) continue;
                    if (ringTexture != null)
                    {
                        GUI.color = new Color(PlanetColor.r, PlanetColor.g, PlanetColor.b, RingAlpha * planets);
                        GUI.DrawTexture(ring, ringTexture);
                        GUI.color = Color.white;
                    }
                    DrawOutlined(text, label.Content, planetStyle, PlanetColor, planets);
                }
            }

            if (names > 0f)
            {
                float limit = Mathf.Min(starNameMagnitude, limitingMagnitude); // never name a star that is not drawn
                float limitMag = starMaterial != null && starMaterial.HasProperty(LimitMagId) ? starMaterial.GetFloat(LimitMagId) : DefaultLimitMag;
                for (int i = 0; i < starLabels.Length; i++)
                {
                    ref SkyLabel label = ref starLabels[i];
                    if (label.Magnitude > limit) break; // sorted brightest first
                    if (!Project(label.Icrf, out Vector3 direction, out Vector2 point)) continue;
                    Rect text = RightOf(point, StarRadiusPx(label.Magnitude, limitMag), label.Size);
                    if (!Claim(text, ref label, direction)) continue;
                    DrawOutlined(text, label.Content, starStyle, StarNameColor, names);
                }
            }

            if (constellations > 0f)
            {
                for (int i = 0; i < constellationLabels.Length; i++)
                {
                    ref SkyLabel label = ref constellationLabels[i];
                    if (!Project(label.Icrf, out Vector3 direction, out Vector2 point)) continue;
                    var text = new Rect(Mathf.Round(point.x - label.Size.x * 0.5f), Mathf.Round(point.y - label.Size.y * 0.5f), label.Size.x, label.Size.y);
                    if (!Claim(text, ref label, direction)) continue;
                    DrawOutlined(text, label.Content, constellationStyle, ConstellationColor, constellations);
                }
            }
            labelCamera = null; // no reference kept past the repaint
        }

        // ICRF direction -> GUI point (y down). False below the horizon, behind the camera or off screen.
        bool Project(Vector3 icrf, out Vector3 direction, out Vector2 point)
        {
            direction = labelToWorld.MultiplyVector(icrf).normalized;
            point = default;
            if (direction.y < HorizonCut) return false;
            Vector3 screen = labelCamera.WorldToScreenPoint(labelEye + direction * ProjectionDistance);
            if (screen.z <= 0f || screen.x < 0f || screen.y < 0f || screen.x > Screen.width || screen.y > Screen.height) return false;
            point = new Vector2(screen.x, Screen.height - screen.y);
            return true;
        }

        // Places a label if its rect is free and its object is not behind the terrain. The overlap test comes first
        // because it is free; the raycast only runs for labels that would otherwise be drawn.
        bool Claim(Rect rect, ref SkyLabel label, Vector3 direction)
        {
            var test = new Rect(rect.x - LabelGapPx, rect.y - LabelGapPx, rect.width + 2f * LabelGapPx, rect.height + 2f * LabelGapPx);
            for (int i = 0; i < placed.Count; i++)
                if (placed[i].Overlaps(test)) return false;
            if (hideLabelsBehindTerrain && BehindTerrain(ref label, direction)) return false;
            placed.Add(rect);
            return true;
        }

        // Occlusion changes slowly (the sky turns ~0.3 degrees per real second at 1200 s per sol; the eye walks), so
        // each label keeps its last result for a few repaints and the rays per repaint are capped.
        bool BehindTerrain(ref SkyLabel label, Vector3 direction)
        {
            int age = label.CheckedAt < 0 ? int.MaxValue : repaintStamp - label.CheckedAt;
            if (age >= RecheckRepaints && raycastBudget > 0)
            {
                raycastBudget--;
                label.Behind = Physics.Raycast(labelEye, direction, TerrainRayLength, Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore);
                label.CheckedAt = repaintStamp;
                age = 0;
            }
            // Never tested, or not for too long: hidden rather than drawn on a mountain; it gets its ray soon.
            return age > ExpireRepaints || label.Behind;
        }

        // To the right of the point, clear of its glow or ring, vertically centred; whole pixels keep the text crisp.
        static Rect RightOf(Vector2 point, float radius, Vector2 size) =>
            new Rect(Mathf.Round(point.x + radius + LabelOffsetPx), Mathf.Round(point.y - size.y * 0.5f), size.x, size.y);

        // The star's drawn radius, as the Mars Stars shader computes it from the magnitude.
        float StarRadiusPx(float magnitude, float limitMag)
        {
            float w = Mathf.Clamp01((limitMag + 0.5f - magnitude) / (limitMag + 2f));
            return Mathf.Lerp(minStarSizePx, Mathf.Max(maxStarSizePx, minStarSizePx), w * w);
        }

        // A functional outline for legibility over bright twilight and dust: four one-pixel offsets in translucent
        // black, then the text.
        static void DrawOutlined(Rect rect, GUIContent content, GUIStyle style, Color color, float alpha)
        {
            GUIStyleState state = style.normal;
            state.textColor = new Color(0f, 0f, 0f, OutlineAlpha * alpha);
            for (int i = 0; i < OutlineOffsets.Length; i++)
                GUI.Label(new Rect(rect.x + OutlineOffsets[i].x, rect.y + OutlineOffsets[i].y, rect.width, rect.height), content, style);
            color.a *= alpha;
            state.textColor = color;
            GUI.Label(rect, content, style);
        }

        void EnsureStyles()
        {
            if (planetStyle != null) return;
            planetStyle = NewStyle(FontStyle.Bold, TextAnchor.MiddleLeft);
            starStyle = NewStyle(FontStyle.Normal, TextAnchor.MiddleLeft);
            constellationStyle = NewStyle(FontStyle.Normal, TextAnchor.MiddleCenter);
            legendStyle = NewStyle(FontStyle.Normal, TextAnchor.UpperLeft);
            styledSize = -1;
        }

        static GUIStyle NewStyle(FontStyle fontStyle, TextAnchor alignment)
        {
            var style = new GUIStyle(GUI.skin.label)
            {
                fontStyle = fontStyle,
                alignment = alignment,
                wordWrap = false,
                richText = false,
                clipping = TextClipping.Overflow,
                padding = new RectOffset(),
                margin = new RectOffset(),
                overflow = new RectOffset(),
                contentOffset = Vector2.zero,
                fixedWidth = 0f,
                fixedHeight = 0f,
            };
            style.normal.textColor = Color.white;
            return style;
        }

        void ApplySize(int size)
        {
            int small = Mathf.Max(size - 1, MinFontPx);
            planetStyle.fontSize = size;
            starStyle.fontSize = size;
            constellationStyle.fontSize = small;
            legendStyle.fontSize = small;
            int diameter = Mathf.RoundToInt(size * RingScale);
            if (ringTexture == null || diameter != ringDiameter)
            {
                ringDiameter = diameter;
                BuildRing();
            }
            styledSize = size;
            labelsSizedFor = -1;
            legendSized = false;
        }

        // Text sizes only change with the font size, so they are measured once per size, not per repaint.
        void SizeLabels()
        {
            for (int i = 0; i < bodyLabels.Length; i++)
                if (bodyLabels[i].Content != null) bodyLabels[i].Size = planetStyle.CalcSize(bodyLabels[i].Content);
            for (int i = 0; i < starLabels.Length; i++) starLabels[i].Size = starStyle.CalcSize(starLabels[i].Content);
            for (int i = 0; i < constellationLabels.Length; i++)
                constellationLabels[i].Size = constellationStyle.CalcSize(constellationLabels[i].Content);
            labelsSizedFor = styledSize;
        }

        // The planet marker: a 1.5 px anti-aliased ring (no glyph as an icon), white with coverage in alpha so
        // GUI.color tints it. Built for the exact pixel diameter and drawn 1:1, plus a pixel of margin for the outer
        // edge's anti-aliasing. 8 x 8 samples per pixel.
        void BuildRing()
        {
            Release(ref ringTexture);
            int size = ringDiameter + 2;
            var pixels = new Color32[size * size];
            float centre = size * 0.5f;
            float halfStroke = RingStrokePx * 0.5f;
            float middle = ringDiameter * 0.5f - halfStroke; // the stroke's outer edge is the ring's diameter
            const int Samples = 8;
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    int hits = 0;
                    for (int sy = 0; sy < Samples; sy++)
                    {
                        float dy = y + (sy + 0.5f) / Samples - centre;
                        for (int sx = 0; sx < Samples; sx++)
                        {
                            float dx = x + (sx + 0.5f) / Samples - centre;
                            if (Mathf.Abs(Mathf.Sqrt(dx * dx + dy * dy) - middle) <= halfStroke) hits++;
                        }
                    }
                    pixels[y * size + x] = new Color32(255, 255, 255, (byte)((hits * 255 + Samples * Samples / 2) / (Samples * Samples)));
                }
            }
            ringTexture = new Texture2D(size, size, TextureFormat.RGBA32, false)
            {
                name = "Mars Night Sky Ring",
                hideFlags = HideFlags.HideAndDontSave,
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
            };
            ringTexture.SetPixels32(pixels);
            ringTexture.Apply(false, true);
        }

        // ------------------------------------------------------------------ legend

        void ShowLegend(float seconds)
        {
            float now = Time.unscaledTime;
            legendUntil = Mathf.Max(legendUntil, now + seconds);
            RefreshLegend(now);
        }

        // Full until the last half second, then an ease-out fade (1 - easeOutCubic): it starts leaving at once and
        // settles softly.
        float LegendAlpha(float now)
        {
            float left = legendUntil - now;
            if (left <= 0f) return 0f;
            if (left >= LegendFadeSeconds) return 1f;
            float x = left / LegendFadeSeconds;
            return x * x * x;
        }

        // Rebuilt at most once a second while shown (and on each key press): two strings, never per frame.
        void RefreshLegend(float now)
        {
            legendRefreshAt = now + LegendRefreshSeconds;
            Keyboard keyboard = Keyboard.current;
            StringBuilder b = legendText.Clear();
            AppendToggle(b, keyboard, starNamesKey, "Star names", showStarNames).Append(GroupGap);
            AppendToggle(b, keyboard, constellationsKey, "Constellations", showConstellations).Append(GroupGap);
            AppendToggle(b, keyboard, planetsKey, "Planets", showPlanets);
            legendKeys.text = b.ToString();

            // Sol 3  ·  Ls 22.8°  ·  21:37 LTST  ·  4.80°S 137.38°E  ·  2026-11-17 UTC
            double d = MarsSkyState.DaysTT;
            b.Clear().Append("Sol ").Append(MarsSkyState.Sol);
            b.Append(Separator).Append("Ls ").Append(MarsEphemeris.SolarLongitudeDeg(d).ToString("0.0", Invariant)).Append('°');
            // Local true solar time on the Mars 24-hour clock (each "hour" is 1/24 sol).
            int minutes = Mathf.Min(Mathf.FloorToInt(Mathf.Repeat(MarsSkyState.LocalSolarTime, 1f) * 1440f), 1439);
            b.Append(Separator);
            AppendTwoDigits(b, minutes / 60).Append(':');
            AppendTwoDigits(b, minutes % 60).Append(" LTST");
            double latitude = MarsSkyState.Latitude;
            double longitude = MarsSkyState.Longitude % 360.0;
            if (longitude < 0.0) longitude += 360.0;
            b.Append(Separator).Append(Math.Abs(latitude).ToString("0.00", Invariant)).Append(latitude < 0.0 ? "°S " : "°N ")
             .Append(longitude.ToString("0.00", Invariant)).Append("°E");
            b.Append(Separator).Append(MarsEphemeris.UtcFromDaysTT(d).ToString("yyyy-MM-dd", Invariant)).Append(" UTC");
            if (!MarsSkyState.RealSky) b.Append(Separator).Append("artistic sun");
            legendClock.text = b.ToString();
            legendSized = false;
        }

        static StringBuilder AppendToggle(StringBuilder b, Keyboard keyboard, Key key, string name, bool on)
        {
            string keyName = KeyName(keyboard, key);
            if (keyName != null) b.Append(keyName).Append("  ");
            return b.Append(name).Append("  ").Append(on ? "on" : "off");
        }

        // The key's label on the player's keyboard layout (Key values are US positions), else the enum name.
        static string KeyName(Keyboard keyboard, Key key)
        {
            if (key == Key.None) return null;
            string name = null;
            if (keyboard != null)
            {
                KeyControl control = keyboard[key];
                if (control != null) name = control.displayName;
            }
            if (string.IsNullOrEmpty(name)) name = key.ToString();
            return name.Length == 1 ? name.ToUpperInvariant() : name;
        }

        static StringBuilder AppendTwoDigits(StringBuilder b, int value)
        {
            if (value < 10) b.Append('0');
            return b.Append(value);
        }

        void SizeLegend()
        {
            legendKeysSize = legendStyle.CalcSize(legendKeys);
            legendClockSize = legendStyle.CalcSize(legendClock);
            legendSized = true;
        }

        // Top-left toast: flat translucent black (no blur), two lines of metadata text.
        void DrawLegend(Rect rect, float alpha)
        {
            GUI.color = new Color(0f, 0f, 0f, LegendBackdropAlpha * alpha);
            GUI.DrawTexture(rect, Texture2D.whiteTexture);
            GUI.color = Color.white;
            Color text = LegendColor;
            text.a *= alpha;
            legendStyle.normal.textColor = text;
            float x = rect.x + LegendPaddingPx, y = rect.y + LegendPaddingPx;
            GUI.Label(new Rect(x, y, legendKeysSize.x, legendKeysSize.y), legendKeys, legendStyle);
            GUI.Label(new Rect(x, y + legendKeysSize.y, legendClockSize.x, legendClockSize.y), legendClock, legendStyle);
        }

        // ------------------------------------------------------------------ catalogue

        /// <summary>
        /// Resources/MarsSkyCatalog.txt, parsed once per domain and shared (read only) by every MarsNightSky. Built by
        /// Tools/sky/build_sky_catalog.py from d3-celestial (O. Frohn, BSD-3-Clause; stars from XHIP / Hipparcos),
        /// J2000 positions without proper motion. Records, one per line, space separated, invariant culture,
        /// '#' starts a comment, the name field last:
        /// <c>S ra dec mag bv</c> stars; <c>N ra dec mag name</c> proper names; <c>C ra dec rank name</c> constellation
        /// label anchors; <c>L ra1 dec1 ra2 dec2</c> constellation line segments. RA and Dec in degrees (ICRF).
        /// </summary>
        public sealed class Catalogue
        {
            public struct Star
            {
                public Vector3 Icrf;     // unit direction
                public float Magnitude;  // V
                public float ColorIndex; // B-V
            }

            public struct Label
            {
                public Vector3 Icrf;
                public float Value; // magnitude for star names, rank (1 = most prominent) for constellations
                public string Name;
            }

            const float MissingColorIndex = 0.65f; // a Sun-like default (the builder writes it too when B-V is missing)

            /// <summary>Stars in file order (brightest first as built).</summary>
            public readonly Star[] Stars;
            /// <summary>Proper names, brightest first.</summary>
            public readonly Label[] StarNames;
            /// <summary>Constellation label anchors, rank 1 first (file order within a rank).</summary>
            public readonly Label[] ConstellationNames;
            /// <summary>Line segments as consecutive pairs of unit directions.</summary>
            public readonly Vector3[] LineEnds;
            /// <summary>Non-comment lines that could not be read (and were skipped), and the first one's number.</summary>
            public readonly int SkippedLines, FirstSkippedLine;

            static Catalogue shared;
            static bool warnedMissing;
            static readonly char[] Separators = { ' ', '\t' };

            Catalogue(Star[] stars, Label[] starNames, Label[] constellationNames, Vector3[] lineEnds, int skipped, int firstSkipped)
            {
                Stars = stars;
                StarNames = starNames;
                ConstellationNames = constellationNames;
                LineEnds = lineEnds;
                SkippedLines = skipped;
                FirstSkippedLine = firstSkipped;
            }

            /// <summary>The shared catalogue, or null (warned once) when the resource is missing; retried on the next call.</summary>
            public static Catalogue LoadShared()
            {
                if (shared != null) return shared;
                var asset = Resources.Load<TextAsset>(CatalogueResource);
                if (asset == null)
                {
                    if (!warnedMissing)
                    {
                        warnedMissing = true;
                        Debug.LogWarning($"MarsNightSky: Resources/{CatalogueResource}.txt not found, so the night sky stays empty. " +
                                         "Build it with Tools/sky/build_sky_catalog.py.");
                    }
                    return null;
                }

                Catalogue parsed = Parse(asset.text);
                if (parsed.SkippedLines > 0)
                    Debug.LogWarning($"MarsNightSky: skipped {parsed.SkippedLines} unreadable line(s) of {CatalogueResource}.txt (first: line {parsed.FirstSkippedLine}).");
                if (parsed.Stars.Length == 0)
                    Debug.LogWarning($"MarsNightSky: {CatalogueResource}.txt holds no stars.");
                shared = parsed;
                return shared;
            }

            /// <summary>Parses the catalogue text. Tolerant: blank lines, comments ('#' to the end of the line), CR LF,
            /// a BOM, tabs or repeated spaces, and unknown or malformed records (counted in <see cref="SkippedLines"/>).</summary>
            public static Catalogue Parse(string text)
            {
                var stars = new List<Star>(5200);
                var names = new List<Label>(256);
                var constellations = new List<Label>(96);
                var lineEnds = new List<Vector3>(1600);
                int skipped = 0, firstSkipped = 0, lineNumber = 0;

                text ??= string.Empty;
                int start = text.Length > 0 && text[0] == '﻿' ? 1 : 0;
                while (start < text.Length)
                {
                    int end = text.IndexOf('\n', start);
                    if (end < 0) end = text.Length;
                    lineNumber++;
                    string line = text.Substring(start, end - start);
                    start = end + 1;

                    int comment = line.IndexOf('#');
                    if (comment >= 0) line = line.Substring(0, comment);
                    line = line.Trim();
                    if (line.Length == 0) continue;

                    string[] fields = line.Split(Separators, StringSplitOptions.RemoveEmptyEntries);
                    if (ReadRecord(fields, stars, names, constellations, lineEnds)) continue;
                    if (skipped++ == 0) firstSkipped = lineNumber;
                }

                Label[] nameArray = names.ToArray();
                Label[] constellationArray = constellations.ToArray();
                SortStable(nameArray);
                SortStable(constellationArray);
                return new Catalogue(stars.ToArray(), nameArray, constellationArray, lineEnds.ToArray(), skipped, firstSkipped);
            }

            static bool ReadRecord(string[] f, List<Star> stars, List<Label> names, List<Label> constellations, List<Vector3> lineEnds)
            {
                if (f.Length < 4) return false;
                switch (f[0])
                {
                    case "S":
                    {
                        if (!Number(f[1], out double ra) || !Number(f[2], out double dec) || !Number(f[3], out double mag)) return false;
                        double bv = f.Length > 4 && Number(f[4], out double colour) ? colour : MissingColorIndex;
                        stars.Add(new Star { Icrf = Direction(ra, dec), Magnitude = (float)mag, ColorIndex = (float)bv });
                        return true;
                    }
                    case "N":
                    case "C":
                    {
                        if (f.Length < 5 || !Number(f[1], out double ra) || !Number(f[2], out double dec) || !Number(f[3], out double value)) return false;
                        string name = f.Length == 5 ? f[4] : string.Join(" ", f, 4, f.Length - 4);
                        (f[0] == "N" ? names : constellations).Add(new Label { Icrf = Direction(ra, dec), Value = (float)value, Name = name });
                        return true;
                    }
                    case "L":
                    {
                        if (f.Length < 5 || !Number(f[1], out double ra1) || !Number(f[2], out double dec1)
                            || !Number(f[3], out double ra2) || !Number(f[4], out double dec2)) return false;
                        lineEnds.Add(Direction(ra1, dec1));
                        lineEnds.Add(Direction(ra2, dec2));
                        return true;
                    }
                    default:
                        return false;
                }
            }

            static bool Number(string s, out double value) =>
                double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out value) && !double.IsNaN(value) && !double.IsInfinity(value);

            /// <summary>Unit vector (ICRF: x toward the March equinox, z toward the north celestial pole) of a right
            /// ascension and declination in degrees.</summary>
            public static Vector3 Direction(double raDeg, double decDeg)
            {
                double ra = raDeg * (Math.PI / 180.0);
                double dec = Math.Max(-90.0, Math.Min(90.0, decDeg)) * (Math.PI / 180.0);
                double c = Math.Cos(dec);
                return new Vector3((float)(c * Math.Cos(ra)), (float)(c * Math.Sin(ra)), (float)Math.Sin(dec));
            }

            // Insertion sort by Value, stable (ties keep the file order); a few hundred entries, once.
            static void SortStable(Label[] labels)
            {
                for (int i = 1; i < labels.Length; i++)
                {
                    Label item = labels[i];
                    int j = i - 1;
                    while (j >= 0 && labels[j].Value > item.Value)
                    {
                        labels[j + 1] = labels[j];
                        j--;
                    }
                    labels[j + 1] = item;
                }
            }
        }
    }
}

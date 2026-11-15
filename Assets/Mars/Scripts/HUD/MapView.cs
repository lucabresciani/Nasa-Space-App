using System;
using System.Collections.Generic;
using System.Globalization;
using NasaSpaceApp.Mission;
using NasaSpaceApp.Science;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>Toggleable layers of the map screen (bottom toggles, in this order).</summary>
    public enum MapLayer { Terrain, Topology, Mineral, Weather, Satellite }

    /// <summary>Glyph the map legend draws for an entry.</summary>
    public enum MapLegendShape { Swatch, Star, Dot, Arrow, Line }

    /// <summary>One map legend row: label, colour (opaque, as on the map) and glyph.</summary>
    public readonly struct MapLegendEntry
    {
        public readonly string Label;
        public readonly Color Color;
        public readonly MapLegendShape Shape;

        public MapLegendEntry(string label, Color color, MapLegendShape shape)
        {
            Label = label;
            Color = color;
            Shape = shape;
        }
    }

    /// <summary>
    /// Colours and short labels of the map layers, shared by the overlay build (<see cref="MarsElevationMap"/>) and the
    /// map screen legend. Slope classes follow HOMELINE F2/F3; rock classes / units are keyed by RockDatabase class id.
    /// The cyan accent stays reserved for the focused rock; amber and red mean caution and no-go, as everywhere in the HUD.
    /// </summary>
    public static class MapPalette
    {
        /// <summary>Legend labels of the slope classes (0..3).</summary>
        public static readonly string[] SlopeLabels = { "0–10°", "10–17°", "17–20°", ">20° no-go" };

        private static readonly int[] SlopeRgb = { 0x6BBF8A, 0xE3D46A, 0xFFB020, 0xE0443A };
        private static readonly float[] SlopeAlpha = { 0.30f, 0.45f, 0.55f, 0.70f };   // perceptual, over the dark map

        /// <summary>Perceptual alpha of a regional unit: at the weakest dominance share and where one class is alone.</summary>
        public const float UnitAlphaMin = 0.35f, UnitAlphaMax = 0.60f;

        /// <summary>Contour ink of the topology layer (MarsElevationMap contour colour).</summary>
        public static readonly Color ContourColor = new Color(226f / 255f, 214f / 255f, 196f / 255f, 1f);

        private static readonly int[] FallbackRgb = { 0x8FBF6A, 0xD9906A, 0xA0A0E0, 0xC0C070 };

        public static Color SlopeColor(int k) => HudTokens.Hex(SlopeRgb[Mathf.Clamp(k, 0, SlopeRgb.Length - 1)], 1f);

        public static float SlopeOverlayAlpha(int k) => SlopeAlpha[Mathf.Clamp(k, 0, SlopeAlpha.Length - 1)];

        /// <summary>Perceptual alpha to the stored alpha (linear colour space: p^2.2, like <see cref="HudTokens.Light"/>).</summary>
        public static float LinearAlpha(float perceptual)
        {
            float p = Mathf.Clamp01(perceptual);
            return QualitySettings.activeColorSpace == ColorSpace.Linear ? Mathf.Pow(p, 2.2f) : p;
        }

        /// <summary>Map colour of a rock class / geologic unit (scanned-rock dots and unit tint use the same one).</summary>
        public static Color ClassColor(string classId)
        {
            switch (classId)
            {
                case "murray-mudstone": return HudTokens.Hex(0x8FA6BF, 1f);    // slate
                case "vera-rubin-ridge": return HudTokens.Hex(0xB8705E, 1f);   // hematite brick
                case "glen-torridon-clay": return HudTokens.Hex(0x5E93D9, 1f); // clay blue
                case "mirador-sulfate": return HudTokens.Hex(0xB394E6, 1f);    // sulfate lavender
                case "amapari-iron": return HudTokens.Hex(0xE07FB8, 1f);       // iron-rich bed, pink
                case "stimson-sandstone": return HudTokens.Hex(0xD9B77E, 1f);  // sand
                case "silica-alteration": return HudTokens.Hex(0xA6E0C8, 1f);  // mint
                case "iron-meteorite": return HudTokens.Hex(0xB5D65A, 1f);     // lime: steel grey read as mudstone / unclassified
                case null: return HudTokens.InkSecondary;
            }
            int h = 0;
            for (int i = 0; i < classId.Length; i++)
            {
                h = h * 31 + classId[i];
            }
            return HudTokens.Hex(FallbackRgb[(h & 0x7FFFFFFF) % FallbackRgb.Length], 1f);
        }

        /// <summary>Short legend label (at most 12 characters): unit symbol and rock type.</summary>
        public static string ClassLabel(RockClass c)
        {
            if (c == null)
            {
                return "Unclassified";
            }
            switch (c.Id)
            {
                case "murray-mudstone": return "Mm mudstone";
                case "vera-rubin-ridge": return "Mvr hematite";
                case "glen-torridon-clay": return "Cs clay";
                case "mirador-sulfate": return "Msu sulfate";
                case "amapari-iron": return "Ma Fe bed";
                case "stimson-sandstone": return "Ss sandstone";
                case "silica-alteration": return "Si silica";
                case "iron-meteorite": return "Fe meteorite";
            }
            if (!string.IsNullOrEmpty(c.UnitSymbol))
            {
                return c.UnitSymbol;
            }
            return HudStrings.Truncate(!string.IsNullOrEmpty(c.Name) ? c.Name : (c.Id ?? "Rock"), 12);
        }
    }

    /// <summary>
    /// Detailed north-up map for the map screen: fills its parent (the map box), clipped by a RectMask2D, under its own
    /// nested canvas so per-frame mesh changes rebuild only this canvas.
    ///
    /// Raster: stacked RawImages over the shared <see cref="MarsElevationMap"/> build (published by the compass dial in
    /// <see cref="HudContext.ElevationMap"/>): grey hillshade base, or the topology map (hypsometric tint + contours, the
    /// dial's look) when Topology is on; then the Terrain (slope classes) and Mineral overlays. The Mineral layer is the
    /// regional unit map MarsElevationMap derives from the field rock distribution, a stand-in for an orbital mineral /
    /// unit map: it shows regional units, never an individual unscanned rock's data. Pan and zoom only rewrite the uvRects.
    ///
    /// Field of view: always inside the high-definition play terrain (<see cref="MarsElevationMap.PlayBounds"/>). Farthest
    /// zoom = that area covers the box (the limiting axis fits exactly, no margin beyond it); the centre is clamped so the
    /// visible window stays inside the area at every zoom, after pan, zoom about the cursor and recentre alike.
    ///
    /// Vector (<see cref="HudLineMesh"/>, redrawn only on change): graticule ticks and lat/lon labels on the edges, scale
    /// bar, north arrow (frame); HOME star at the world origin, scanned rocks as class-coloured dots, the player arrow
    /// (marks); wind arrows on a sparse screen grid and active dust devils as rings (weather).
    ///
    /// Input (only while shown and the cursor is free; pointer over the map): wheel = zoom about the cursor (from the HD
    /// area filling the box down to 0.5 m per px), left-drag = pan. Hover readout top-left: lat/lon and MOLA elevation under the cursor.
    /// No per-frame allocations; readout strings are rebuilt at most 10 Hz (hover) / 2 Hz (weather) and only on change.
    /// </summary>
    public sealed class MapView
    {
        private const float MinMpu = 0.5f;              // closest zoom: 0.5 m per canvas unit (px at 1080p)
        private const float StartMpu = 2f;              // first view: one map texel per unit, centred on the player
        private const float ZoomStep = 1.25f;
        private const float GratMinSpacing = 110f;      // graticule spacing at least this (units)
        private const float TickLen = 8f;
        private const float Edge = 12f;                 // inset of the corner readouts
        private const float ScaleBarMax = 140f;
        private const float ScaleZone = 196f;           // bottom-right width kept free of longitude labels
        private const float WindSpacing = 132f;
        private const float HoverInterval = 0.1f;
        private const float WeatherInterval = 0.5f;
        private const float LookupInterval = 5f;
        private const int MaxGratLabels = 24;
        private const int MaxGratLines = 64;
        private const int MaxDevils = 8;
        private const int LayerCount = 5;

        private static readonly double[] GratSteps = { 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0 };
        private static readonly float[] ScaleSteps = { 1f, 2f, 5f, 10f, 20f, 50f, 100f, 200f, 500f, 1000f, 2000f, 5000f };
        private static readonly string[] DecimalFormats = { "0", "0.0", "0.00", "0.000", "0.0000", "0.00000" };
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        private static readonly Color DevilColor = HudTokens.Hex(0xEDEDED, 1f);   // neutral white: distinct from every class colour
        private static readonly Color WindColor = HudTokens.InkSecondary;

        // Player chevron (as on the dial, 1.25x) and 4-point HOME star, local glyph space (y = ahead / north).
        private static readonly Vector2[] ChevronOuter = { new Vector2(-7.5f, -8.75f), new Vector2(0f, 10f), new Vector2(7.5f, -8.75f) };
        private static readonly Vector2[] ChevronNotch = { new Vector2(-7.5f, -8.75f), new Vector2(0f, -3.75f), new Vector2(7.5f, -8.75f) };

        private readonly HudContext ctx;
        private readonly RectTransform clip;
        private readonly RawImage baseImage, satImage, topoImage, slopeImage, unitImage;
        private readonly HudLineMesh weatherMesh, frameMesh, marksMesh;
        private readonly Text homeLabel, scaleLabel, northLabel, status;
        private readonly Text[] lonLabels = new Text[MaxGratLabels];
        private readonly Text[] latLabels = new Text[MaxGratLabels];
        private readonly GameObject hoverPanel, weatherPanel;
        private readonly Text hoverText, weatherText;

        private readonly bool[] layers = { false, true, false, false, false };   // Terrain, Topology, Mineral, Weather, Satellite

        // Satellite: HiRISE image of the HD play terrain (Resources/MarsPlayOrtho.jpg, Tools/ortho/build_play_ortho.py), the
        // Mission Planer's basemap. Loaded on first use; its world rect comes from the lat/lon bounds in MarsPlayOrtho_meta.
        private const float TopoOverSatelliteAlpha = 0.35f;   // contours and tint stay faintly visible over the image
        private Texture2D satTexture;
        private Rect satBounds;
        private bool satLoaded, satFailed;

        private readonly List<MapLegendEntry> legend = new List<MapLegendEntry>(24);
        private readonly List<MapLegendEntry> scannedLegend = new List<MapLegendEntry>(8);
        private readonly List<string> scannedClassIds = new List<string>(8);
        private readonly List<MapLegendEntry> unitLegend = new List<MapLegendEntry>(8);
        private readonly List<Vector2> dotPos = new List<Vector2>(64);
        private readonly List<Color32> dotCol = new List<Color32>(64);
        private readonly Dictionary<long, string> gratCache = new Dictionary<long, string>(128);
        private readonly Dictionary<int, string> scaleCache = new Dictionary<int, string>(16);
        private readonly Dictionary<int, string> elevationCache = new Dictionary<int, string>(256);
        private readonly Vector2[] glyph = new Vector2[9];
        private readonly Vector2[] devilPos = new Vector2[MaxDevils];
        private readonly float[] devilRadius = new float[MaxDevils];
        private readonly Vector3Int[] devilKey = new Vector3Int[MaxDevils];

        private MarsElevationMap map;
        private MarsGeoReference geo;
        private DustDevilField devilField;
        private float nextGeoLookup, nextDevilLookup;
        private bool mapReady, noMap;
        private int progress = -1;
        private Rect worldBounds, overlayBounds, hdBounds;   // texture grids; HD play area (the view limit)
        private string contourLabel;

        private bool visible = true, wasShown;
        private Vector2 boxSize;
        private Vector2 center;          // world XZ at the box centre
        private float mpu = StartMpu;    // metres per canvas unit
        private float maxMpu = 1e4f;
        private bool viewInit;
        private bool viewDirty = true, marksDirty = true, weatherDirty = true, frameDirty = true, legendDirty = true;

        private bool dragging;
        private Vector2 dragLast;
        private bool hoverOn, hoverValid;
        private float hoverTimer;
        private Vector2 hoverWorld;

        private Vector3 lastPlayer = new Vector3(float.NaN, 0f, float.NaN);
        private float lastHeading = float.NaN;
        private int scanCount;

        private int windSpeedQ = -1, windDirQ = -1;   // 0.5 m/s, 2 deg
        private int devilCount;
        private float weatherTimer;
        private bool readoutValid;
        private int readTau = int.MinValue, readSpeed = int.MinValue, readDir = int.MinValue;

        private int legendVersion;

        // Web mission (MissionLink.Current): route, numbered waypoints; HOME follows HomeBase.
        private readonly MissionRouteDrawer routeDrawer = new MissionRouteDrawer();
        private readonly List<Text> wpLabels = new List<Text>(16);
        private readonly List<string> wpNumbers = new List<string>(16);
        private Font wpFont;
        private int missionVersion = -1, homeVersion = -1, trackerVersion = -1;

        /// <summary>Builds the view as a full-stretch child of <paramref name="parent"/> (the map box).</summary>
        public MapView(HudContext ctx, RectTransform parent)
        {
            this.ctx = ctx;
            HudSkin skin = ctx != null ? ctx.Skin : null;
            Font regular = skin != null ? skin.Regular : null;
            Font medium = skin != null ? skin.Medium : null;

            Root = HudFactory.CreateStretch("MapView", parent);
            HudFactory.AddNestedCanvas(Root.gameObject, false);
            clip = HudFactory.CreateStretch("Clip", Root);
            clip.gameObject.AddComponent<RectMask2D>();

            // Sibling order = draw order.
            baseImage = CreateRaw("Base");
            satImage = CreateRaw("Satellite");
            topoImage = CreateRaw("Topology");
            slopeImage = CreateRaw("Terrain");
            unitImage = CreateRaw("Mineral");
            weatherMesh = CreateMesh("Weather");
            frameMesh = CreateMesh("Frame");
            marksMesh = CreateMesh("Marks");

            Vector2 mid = new Vector2(0.5f, 0.5f), leftMid = new Vector2(0f, 0.5f);
            for (int i = 0; i < MaxGratLabels; i++)
            {
                lonLabels[i] = CreateLabel("Lon" + i, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleCenter, mid);
                latLabels[i] = CreateLabel("Lat" + i, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleLeft, leftMid);
            }
            wpFont = medium;
            homeLabel = CreateLabel("HomeLabel", medium, HudTokens.SizeMicro, HudTokens.InkPrimary, TextAnchor.MiddleLeft, leftMid);
            homeLabel.text = "HOME";
            scaleLabel = CreateLabel("ScaleLabel", regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleCenter, mid);
            northLabel = CreateLabel("North", medium, HudTokens.SizeLabel, HudTokens.InkPrimary, TextAnchor.MiddleCenter, mid);
            northLabel.text = "N";

            // Readouts: hover (top-left), weather (top-centre, Weather layer only).
            Image hp = HudFactory.CreatePanel("Hover", clip, skin, HudTokens.Scrim, HudTokens.RadiusSmall, new Vector2(0f, 1f),
                                              new Vector2(0f, 1f), new Vector2(Edge, -Edge), new Vector2(340f, 28f));
            hoverText = HudFactory.CreateText("HoverText", hp.rectTransform, regular, HudTokens.SizeLabel, HudTokens.InkPrimary,
                                              TextAnchor.MiddleLeft, leftMid, leftMid, new Vector2(10f, 0f), new Vector2(320f, 20f));
            hoverPanel = hp.gameObject;
            hoverPanel.SetActive(false);

            Image wp = HudFactory.CreatePanel("WeatherReadout", clip, skin, HudTokens.Scrim, HudTokens.RadiusSmall, new Vector2(0.5f, 1f),
                                              new Vector2(0.5f, 1f), new Vector2(0f, -Edge), new Vector2(300f, 28f));
            weatherText = HudFactory.CreateText("WeatherText", wp.rectTransform, regular, HudTokens.SizeLabel, HudTokens.InkPrimary,
                                                TextAnchor.MiddleCenter, mid, mid, Vector2.zero, new Vector2(290f, 20f));
            weatherPanel = wp.gameObject;
            weatherPanel.SetActive(false);

            status = HudFactory.CreateText("MapStatus", clip, medium, HudTokens.SizeLabel, HudTokens.InkTertiary, TextAnchor.MiddleCenter,
                                           mid, mid, Vector2.zero, new Vector2(200f, 20f));
            status.text = "MAP …";

            ApplyLayers();
            RebuildLegend();
        }

        /// <summary>The view's root (full stretch inside the parent map box).</summary>
        public RectTransform Root { get; }

        /// <summary>Incremented whenever the legend content changes.</summary>
        public int LegendVersion => legendVersion;

        public int LegendCount => legend.Count;

        /// <summary>Legend entry <paramref name="index"/> (default when out of range).</summary>
        public MapLegendEntry GetLegend(int index)
        {
            return (uint)index < (uint)legend.Count ? legend[index] : default;
        }

        public bool GetLayer(MapLayer layer)
        {
            int i = (int)layer;
            return (uint)i < LayerCount && layers[i];
        }

        public void SetLayer(MapLayer layer, bool on)
        {
            int i = (int)layer;
            if ((uint)i >= LayerCount || layers[i] == on)
            {
                return;
            }
            layers[i] = on;
            ApplyLayers();
            if (layer == MapLayer.Weather)
            {
                weatherDirty = true;
                readoutValid = false;
                weatherTimer = 0f;
                windSpeedQ = windDirQ = -1;
            }
            RebuildLegend();
        }

        /// <summary>Shows or hides the view (its root GameObject). Input and redraws run only while shown.</summary>
        public void SetVisible(bool show)
        {
            visible = show;
            if (Root != null && Root.gameObject.activeSelf != show)
            {
                Root.gameObject.SetActive(show);
            }
            if (!show)
            {
                dragging = false;
                SetHover(false);
            }
        }

        /// <summary>Centres the view on the player (zoom kept).</summary>
        public void Recenter()
        {
            if (!mapReady)
            {
                viewInit = false;   // the first view is centred on the player anyway
                return;
            }
            Vector3 p = PlayerPosition();
            center = new Vector2(p.x, p.z);
            ClampCenter();
            viewDirty = true;
        }

        /// <summary>Centres the view on a world position (zoom kept, clamped to the HD area).</summary>
        public void CenterOn(Vector3 world)
        {
            if (!mapReady)
            {
                return;
            }
            center = new Vector2(world.x, world.z);
            ClampCenter();
            viewDirty = true;
        }

        /// <summary>Per frame (unscaled dt): binds the map when built, tracks scans, then input and redraws while shown.</summary>
        public void Tick(float dt)
        {
            if (ctx == null || Root == null)
            {
                return;
            }
            BindMap();
            UpdateScans();
            if (legendDirty)
            {
                RebuildLegend();
            }

            bool shown = visible && Root.gameObject.activeInHierarchy;
            if (!shown)
            {
                wasShown = false;
                dragging = false;
                return;
            }
            if (!wasShown)
            {
                wasShown = true;
                viewDirty = true;
                SetHover(false);
            }

            Vector2 size = clip.rect.size;
            if (size != boxSize)
            {
                boxSize = size;
                UpdateZoomLimits();
                viewDirty = true;
            }
            if (boxSize.x < 1f || boxSize.y < 1f)
            {
                return;
            }
            if (mapReady && !viewInit)
            {
                InitView();
            }
            if (geo == null && ctx.UnscaledTime >= nextGeoLookup)
            {
                geo = MarsGeoReference.Instance;
                nextGeoLookup = ctx.UnscaledTime + LookupInterval;
                frameDirty |= geo != null;
            }

            HandlePointer(dt);
            TrackPlayer();
            TrackMission();
            if (layers[(int)MapLayer.Weather])
            {
                TrackWeather(dt);
            }

            if (viewDirty)
            {
                viewDirty = false;
                ApplyUv();
                frameDirty = marksDirty = weatherDirty = true;
            }
            if (frameDirty)
            {
                frameDirty = false;
                RedrawFrame();
            }
            if (marksDirty)
            {
                marksDirty = false;
                RedrawMarks();
            }
            if (weatherDirty)
            {
                weatherDirty = false;
                RedrawWeather();
            }
        }

        // ---- build

        private RawImage CreateRaw(string name)
        {
            RectTransform rt = HudFactory.CreateStretch(name, clip);
            var img = rt.gameObject.AddComponent<RawImage>();
            img.raycastTarget = false;
            img.color = Color.white;
            img.enabled = false;
            return img;
        }

        private HudLineMesh CreateMesh(string name)
        {
            RectTransform rt = HudFactory.CreateStretch(name, clip);   // pivot centre: local origin = box centre
            var mesh = rt.gameObject.AddComponent<HudLineMesh>();
            mesh.raycastTarget = false;
            return mesh;
        }

        private Text CreateLabel(string name, Font font, int size, Color color, TextAnchor align, Vector2 pivot)
        {
            Vector2 mid = new Vector2(0.5f, 0.5f);
            Text t = HudFactory.CreateText(name, clip, font, size, color, align, mid, pivot, Vector2.zero, new Vector2(120f, 20f));
            HudFactory.AddHalo(t);
            t.enabled = false;
            return t;
        }

        // ---- map binding and layers

        private void BindMap()
        {
            if (mapReady || noMap)
            {
                return;
            }
            if (map == null)
            {
                map = ctx.ElevationMap;
                if (map == null)
                {
                    return;
                }
            }
            if (map.IsReady)
            {
                mapReady = true;
                baseImage.texture = map.BaseTexture;
                topoImage.texture = map.Texture;
                slopeImage.texture = map.SlopeTexture;
                unitImage.texture = map.UnitTexture;
                worldBounds = map.WorldBounds;
                overlayBounds = map.OverlayWorldBounds;
                hdBounds = map.PlayBounds;
                if (!(hdBounds.width > 0f) || !(hdBounds.height > 0f))
                {
                    hdBounds = worldBounds;
                }
                contourLabel = "Contour " + Mathf.RoundToInt(map.ContourInterval).ToString(Inv) + " m";
                BuildUnitLegend();
                status.enabled = false;
                ApplyLayers();
                UpdateZoomLimits();
                legendDirty = true;
                viewDirty = true;
            }
            else if (map.State == MarsElevationMap.MapState.NoTerrain)
            {
                noMap = true;
                status.text = "NO MAP";
                frameDirty = true;
            }
            else
            {
                int p = Mathf.FloorToInt(map.Progress * 100f);
                if (p != progress)
                {
                    progress = p;
                    frameDirty = true;
                }
            }
        }

        // One swatch per class actually drawn in the unit map (database order), coloured like the scanned-rock dots.
        private void BuildUnitLegend()
        {
            unitLegend.Clear();
            RockDatabase db = map.UnitCount > 0 ? RockDatabase.Default : null;
            for (int u = 0; u < map.UnitCount; u++)
            {
                if (map.UnitTexels(u) <= 0)
                {
                    continue;
                }
                string id = map.UnitClassId(u);
                RockClass cls = db != null ? db.GetClass(id) : null;
                string label = cls != null ? MapPalette.ClassLabel(cls) : HudStrings.Truncate(id, 12);
                unitLegend.Add(new MapLegendEntry(label, MapPalette.ClassColor(id), MapLegendShape.Swatch));
            }
        }

        private void ApplyLayers()
        {
            bool topo = layers[(int)MapLayer.Topology];
            bool sat = layers[(int)MapLayer.Satellite] && EnsureSatellite();
            SetEnabled(satImage, mapReady && sat);
            SetEnabled(baseImage, mapReady && !topo && !sat && baseImage.texture != null);
            SetEnabled(topoImage, mapReady && topo && topoImage.texture != null);
            Color topoTint = new Color(1f, 1f, 1f, sat ? TopoOverSatelliteAlpha : 1f);
            if (topoImage.color != topoTint)
            {
                topoImage.color = topoTint;
            }
            SetEnabled(slopeImage, mapReady && layers[(int)MapLayer.Terrain] && slopeImage.texture != null);
            SetEnabled(unitImage, mapReady && layers[(int)MapLayer.Mineral] && unitImage.texture != null);
            bool weather = layers[(int)MapLayer.Weather];
            if (weatherMesh.enabled != weather)
            {
                weatherMesh.enabled = weather;
            }
            if (weatherPanel.activeSelf != weather)
            {
                weatherPanel.SetActive(weather);
            }
        }

        // Loads the satellite image and its world rect once; false when it is missing (the layer then shows nothing).
        private bool EnsureSatellite()
        {
            if (satLoaded || satFailed)
            {
                return satLoaded;
            }
            MarsGeoReference g = geo != null ? geo : MarsGeoReference.Instance;
            if (g == null)
            {
                return false;   // try again once the geo-reference is found
            }
            TextAsset metaText = Resources.Load<TextAsset>("MarsPlayOrtho_meta");
            satTexture = Resources.Load<Texture2D>("MarsPlayOrtho");
            if (metaText == null || satTexture == null)
            {
                satFailed = true;
                Debug.LogWarning("[HUD] Satellite layer: Resources/MarsPlayOrtho(.jpg / _meta.json) missing; run Tools/ortho/build_play_ortho.py");
                return false;
            }
            try
            {
                var b = Newtonsoft.Json.Linq.JObject.Parse(metaText.text)["bounds"];
                Vector3 sw = g.WorldXZ((double)b["lat_south"], (double)b["lon_west"]);
                Vector3 ne = g.WorldXZ((double)b["lat_north"], (double)b["lon_east"]);
                satBounds = Rect.MinMaxRect(sw.x, sw.z, ne.x, ne.z);
            }
            catch (Exception e)
            {
                satFailed = true;
                Debug.LogException(e);
                return false;
            }
            satImage.texture = satTexture;
            satLoaded = true;
            viewDirty = true;
            legendDirty = true;
            return true;
        }

        private static void SetEnabled(Behaviour b, bool on)
        {
            if (b.enabled != on)
            {
                b.enabled = on;
            }
        }

        private void RebuildLegend()
        {
            legendDirty = false;
            legend.Clear();
            legend.Add(new MapLegendEntry("Home", HudTokens.InkPrimary, MapLegendShape.Star));
            legend.Add(new MapLegendEntry("You", HudTokens.InkPrimary, MapLegendShape.Arrow));
            if (layers[(int)MapLayer.Satellite] && satLoaded)
            {
                legend.Add(new MapLegendEntry("HiRISE image (NASA/JPL/UArizona)", HudTokens.Hex(0xB07A55, 1f), MapLegendShape.Swatch));
            }
            if (MissionLink.Current != null)
            {
                legend.Add(new MapLegendEntry("Planned route", MissionRouteStyle.Route, MapLegendShape.Line));
                legend.Add(new MapLegendEntry("Way home", MissionRouteStyle.RouteHome, MapLegendShape.Line));
                legend.Add(new MapLegendEntry("Walked / closed", MissionRouteStyle.Done, MapLegendShape.Line));
                legend.Add(new MapLegendEntry("Waypoint", MissionRouteStyle.Route, MapLegendShape.Dot));
            }
            for (int i = 0; i < scannedLegend.Count; i++)
            {
                legend.Add(scannedLegend[i]);
            }
            if (layers[(int)MapLayer.Terrain])
            {
                for (int k = 0; k < MarsElevationMap.SlopeClassCount; k++)
                {
                    legend.Add(new MapLegendEntry(MapPalette.SlopeLabels[k], MapPalette.SlopeColor(k), MapLegendShape.Swatch));
                }
            }
            if (layers[(int)MapLayer.Topology] && contourLabel != null)
            {
                legend.Add(new MapLegendEntry(contourLabel, MapPalette.ContourColor, MapLegendShape.Line));
            }
            if (layers[(int)MapLayer.Mineral])
            {
                for (int i = 0; i < unitLegend.Count; i++)
                {
                    legend.Add(unitLegend[i]);
                }
            }
            if (layers[(int)MapLayer.Weather])
            {
                legend.Add(new MapLegendEntry("Wind", WindColor, MapLegendShape.Arrow));
                legend.Add(new MapLegendEntry("Dust devil", DevilColor, MapLegendShape.Dot));
            }
            legendVersion++;
        }

        // ---- view

        private void InitView()
        {
            Vector3 p = PlayerPosition();
            center = new Vector2(p.x, p.z);
            mpu = Mathf.Clamp(StartMpu, ZoomFloor, maxMpu);
            ClampCenter();
            viewInit = true;
            viewDirty = true;
        }

        // Closest zoom; only a box larger than the whole HD area at MinMpu (never in practice) raises it.
        private float ZoomFloor => Mathf.Min(MinMpu, maxMpu);

        // Farthest zoom: the HD area covers the box, its limiting axis fitting exactly (cover, so never an empty margin).
        private void UpdateZoomLimits()
        {
            if (!mapReady || boxSize.x < 1f || boxSize.y < 1f)
            {
                maxMpu = 1e4f;
                return;
            }
            maxMpu = Mathf.Min(hdBounds.width / boxSize.x, hdBounds.height / boxSize.y);
            mpu = Mathf.Clamp(mpu, ZoomFloor, maxMpu);
            ClampCenter();
        }

        // The visible window (box x mpu) stays inside the HD area; an axis it spans exactly stays centred.
        private void ClampCenter()
        {
            if (!mapReady)
            {
                return;
            }
            float hw = 0.5f * boxSize.x * mpu, hh = 0.5f * boxSize.y * mpu;
            center.x = ClampAxis(center.x, hdBounds.xMin + hw, hdBounds.xMax - hw);
            center.y = ClampAxis(center.y, hdBounds.yMin + hh, hdBounds.yMax - hh);
        }

        private static float ClampAxis(float v, float lo, float hi)
        {
            return lo <= hi ? Mathf.Clamp(v, lo, hi) : 0.5f * (lo + hi);
        }

        private void ApplyUv()
        {
            if (!mapReady)
            {
                return;
            }
            float w = boxSize.x * mpu, h = boxSize.y * mpu;
            float xMin = center.x - 0.5f * w, zMin = center.y - 0.5f * h;
            Rect main = new Rect((xMin - worldBounds.x) / worldBounds.width, (zMin - worldBounds.y) / worldBounds.height,
                                 w / worldBounds.width, h / worldBounds.height);
            Rect over = new Rect((xMin - overlayBounds.x) / overlayBounds.width, (zMin - overlayBounds.y) / overlayBounds.height,
                                 w / overlayBounds.width, h / overlayBounds.height);
            baseImage.uvRect = main;
            topoImage.uvRect = main;
            slopeImage.uvRect = over;
            unitImage.uvRect = over;
            if (satLoaded)
            {
                satImage.uvRect = new Rect((xMin - satBounds.x) / satBounds.width, (zMin - satBounds.y) / satBounds.height,
                                           w / satBounds.width, h / satBounds.height);
            }
        }

        // World XZ to box-local units (origin at the box centre, north up).
        private Vector2 ToLocal(float x, float z)
        {
            float inv = 1f / mpu;
            return new Vector2((x - center.x) * inv, (z - center.y) * inv);
        }

        private Vector3 PlayerPosition()
        {
            return ctx.Player != null ? ctx.Player.transform.position : ctx.CameraPosition;
        }

        // ---- input

        private void HandlePointer(float dt)
        {
            Mouse mouse = Mouse.current;
            if (!mapReady || mouse == null || !ctx.CursorFree)
            {
                dragging = false;
                SetHover(false);
                return;
            }

            Canvas root = ctx.Canvas;
            Camera eventCamera = root != null && root.renderMode != RenderMode.ScreenSpaceOverlay ? root.worldCamera : null;
            Vector2 screen = mouse.position.ReadValue();
            bool inside = false;
            if (RectTransformUtility.ScreenPointToLocalPointInRectangle(clip, screen, eventCamera, out Vector2 local))
            {
                inside = Mathf.Abs(local.x) <= 0.5f * boxSize.x && Mathf.Abs(local.y) <= 0.5f * boxSize.y;
            }

            float wheel = mouse.scroll.ReadValue().y;
            if (inside && wheel != 0f)
            {
                ZoomAt(local, wheel > 0f ? 1f / ZoomStep : ZoomStep);
            }

            if (inside && mouse.leftButton.wasPressedThisFrame)
            {
                dragging = true;
                dragLast = local;
            }
            if (dragging)
            {
                if (!mouse.leftButton.isPressed)
                {
                    dragging = false;
                }
                else if (local != dragLast)
                {
                    center -= (local - dragLast) * mpu;
                    dragLast = local;
                    ClampCenter();
                    viewDirty = true;
                }
            }

            UpdateHover(inside, local, dt);
        }

        // Zoom keeping the world point under the cursor fixed, then the HD-area clamp (wins near the edges).
        private void ZoomAt(Vector2 local, float factor)
        {
            float next = Mathf.Clamp(mpu * factor, ZoomFloor, maxMpu);
            if (next == mpu)
            {
                return;
            }
            Vector2 world = center + local * mpu;
            center = world - local * next;
            mpu = next;
            ClampCenter();
            viewDirty = true;
        }

        private void SetHover(bool on)
        {
            if (hoverOn == on)
            {
                return;
            }
            hoverOn = on;
            hoverPanel.SetActive(on);
            hoverValid = false;
            hoverTimer = 0f;
        }

        private void UpdateHover(bool inside, Vector2 local, float dt)
        {
            if (!inside)
            {
                SetHover(false);
                return;
            }
            SetHover(true);
            hoverTimer -= dt;
            if (hoverTimer > 0f)
            {
                return;
            }
            Vector2 world = center + local * mpu;
            if (hoverValid && (world - hoverWorld).sqrMagnitude < 0.04f)
            {
                return;   // moved less than 0.2 m
            }
            hoverTimer = HoverInterval;
            hoverWorld = world;
            hoverValid = true;
            hoverText.text = HoverString(world);
        }

        private string HoverString(Vector2 w)
        {
            string elev = map != null && map.TryGetElevation(w.x, w.y, out float e) ? ElevationText(Mathf.RoundToInt(e)) : "--";
            if (geo != null)
            {
                MarsCoordinates c = geo.ToMapCoordinates(new Vector3(w.x, 0f, w.y));
                return Degrees(c.Latitude, 5, true) + "  " + Degrees(c.Longitude, 5, false) + "  " + elev;
            }
            return "E " + HudStrings.SignedInt(Mathf.RoundToInt(w.x)) + "  N " + HudStrings.SignedInt(Mathf.RoundToInt(w.y)) + "  " + elev;
        }

        private static string Degrees(double v, int decimals, bool lat)
        {
            string hemi = lat ? (v >= 0.0 ? "N" : "S") : (v >= 0.0 ? "E" : "W");
            return Math.Abs(v).ToString(DecimalFormats[decimals], Inv) + "°" + hemi;
        }

        // "−3 642 m": U+2212 minus, space as thousands separator; cached per metre.
        private string ElevationText(int m)
        {
            if (elevationCache.TryGetValue(m, out string s))
            {
                return s;
            }
            int a = m < 0 ? -m : m;
            string digits = a >= 1000 ? (a / 1000).ToString(Inv) + " " + (a % 1000).ToString("000", Inv) : a.ToString(Inv);
            s = (m < 0 ? HudStrings.Minus.ToString() : string.Empty) + digits + " m";
            elevationCache[m] = s;
            return s;
        }

        // ---- tracked state

        // A new/cleared mission or a moved HOME redraws the marks and the legend.
        private void TrackMission()
        {
            int tv = ctx.Mission != null ? ctx.Mission.Version : 0;
            if (MissionLink.Version != missionVersion || HomeBase.Version != homeVersion)
            {
                missionVersion = MissionLink.Version;
                homeVersion = HomeBase.Version;
                marksDirty = true;
                legendDirty = true;
            }
            if (tv != trackerVersion)
            {
                trackerVersion = tv;
                marksDirty = true;   // waypoint closed, leg changed
            }
        }

        private void TrackPlayer()
        {
            Vector3 p = PlayerPosition();
            float h = ctx.HeadingDeg;
            if (float.IsNaN(lastPlayer.x) || Mathf.Abs(p.x - lastPlayer.x) >= 0.1f || Mathf.Abs(p.z - lastPlayer.z) >= 0.1f
                || float.IsNaN(lastHeading) || Mathf.Abs(Mathf.DeltaAngle(h, lastHeading)) >= 0.5f)
            {
                lastPlayer = p;
                lastHeading = h;
                marksDirty = true;
            }
        }

        // First scans of each rock become dots; each new class adds a legend row. The log only grows.
        private void UpdateScans()
        {
            RockScanner scanner = ctx.Scanner;
            if (scanner == null)
            {
                return;
            }
            IReadOnlyList<RockScanResult> log = scanner.ScanLog;
            int n = log != null ? log.Count : 0;
            if (n < scanCount)
            {
                scanCount = 0;
                dotPos.Clear();
                dotCol.Clear();
                scannedClassIds.Clear();
                scannedLegend.Clear();
                legendDirty = true;
                marksDirty = true;
            }
            for (; scanCount < n; scanCount++)
            {
                RockScanResult r = log[scanCount];
                if (r == null || !r.IsFirstScan)
                {
                    continue;
                }
                RockClass cls = r.Reading != null ? r.Reading.Class : null;
                string id = cls != null && cls.Id != null ? cls.Id : string.Empty;
                Color col = cls != null ? MapPalette.ClassColor(cls.Id) : HudTokens.InkSecondary;
                Vector3 pt = r.Point;
                dotPos.Add(new Vector2(pt.x, pt.z));
                dotCol.Add(col);
                marksDirty = true;
                if (!scannedClassIds.Contains(id))
                {
                    scannedClassIds.Add(id);
                    scannedLegend.Add(new MapLegendEntry(MapPalette.ClassLabel(cls), col, MapLegendShape.Dot));
                    legendDirty = true;
                }
            }
        }

        private void TrackWeather(float dt)
        {
            bool has = ReadWeather(out Vector2 wind, out float speed, out float tau);
            float bearing = Mathf.Repeat(Mathf.Atan2(wind.x, wind.y) * Mathf.Rad2Deg, 360f);
            int sq = has ? Mathf.RoundToInt(speed * 2f) : 0;
            int dq = Mathf.RoundToInt(bearing * 0.5f) % 180;
            if (sq != windSpeedQ || (sq > 0 && dq != windDirQ))
            {
                windSpeedQ = sq;
                windDirQ = dq;
                weatherDirty = true;
            }
            TrackDevils();

            weatherTimer -= dt;
            if (weatherTimer > 0f && readoutValid)
            {
                return;
            }
            weatherTimer = WeatherInterval;
            int t = has && tau > 0f ? Mathf.RoundToInt(tau * 100f) : -1;
            int s = has ? Mathf.RoundToInt(speed) : -1;
            int d = Mathf.RoundToInt(bearing) % 360;
            if (readoutValid && t == readTau && s == readSpeed && (s < 1 || d == readDir))
            {
                return;
            }
            readoutValid = true;
            readTau = t;
            readSpeed = s;
            readDir = d;
            string tauText = t >= 0 ? (t / 100f).ToString("0.00", Inv) : "--";
            string windText = s < 0 ? "--" : (s < 1 ? "calm" : s.ToString(Inv) + " m/s → " + HudStrings.Heading(d));
            weatherText.text = "τ " + tauText + " · wind " + windText;
        }

        // Weather now: the published frame (MarsAtmosphere hub), else the MarsWeather component. Wind = where the air goes.
        private bool ReadWeather(out Vector2 wind, out float speed, out float tau)
        {
            wind = Vector2.zero;
            speed = 0f;
            tau = 0f;
            if (MarsAtmosphere.Owner != null)
            {
                WeatherFrame f = MarsAtmosphere.Frame;
                wind = f.wind;
                speed = f.windSpeed;
                tau = f.opticalDepth;
            }
            else if (ctx.Weather != null)
            {
                wind = ctx.Weather.Wind;
                speed = ctx.Weather.WindSpeed;
                tau = ctx.Weather.OpticalDepth;
            }
            else
            {
                return false;
            }
            if (!Finite(wind.x) || !Finite(wind.y))
            {
                wind = Vector2.zero;
            }
            if (!Finite(speed) || speed < 0f)
            {
                speed = wind.magnitude;
            }
            if (!Finite(tau))
            {
                tau = 0f;
            }
            return true;
        }

        private static bool Finite(float v)
        {
            return !float.IsNaN(v) && !float.IsInfinity(v);
        }

        // Active devils: the DustDevilField's active pooled children (position, localScale.x = diameter).
        private void TrackDevils()
        {
            if (devilField == null && ctx.UnscaledTime >= nextDevilLookup)
            {
                devilField = UnityEngine.Object.FindAnyObjectByType<DustDevilField>();
                nextDevilLookup = ctx.UnscaledTime + LookupInterval;
            }
            int n = 0;
            if (devilField != null && mapReady)
            {
                Transform ft = devilField.transform;
                int children = ft.childCount;
                for (int i = 0; i < children && n < MaxDevils; i++)
                {
                    Transform c = ft.GetChild(i);
                    if (!c.gameObject.activeSelf)
                    {
                        continue;
                    }
                    Vector3 p = c.position;
                    Vector2 l = ToLocal(p.x, p.z);
                    float r = Mathf.Max(5f, 0.5f * Mathf.Abs(c.localScale.x) / mpu);
                    var key = new Vector3Int(Mathf.RoundToInt(l.x), Mathf.RoundToInt(l.y), Mathf.RoundToInt(r));
                    if (key != devilKey[n])
                    {
                        devilKey[n] = key;
                        weatherDirty = true;
                    }
                    devilPos[n] = l;
                    devilRadius[n] = r;
                    n++;
                }
            }
            if (n != devilCount)
            {
                devilCount = n;
                weatherDirty = true;
            }
        }

        // ---- drawing

        private void RedrawFrame()
        {
            frameMesh.Clear();
            float hw = 0.5f * boxSize.x, hh = 0.5f * boxSize.y;
            int lonUsed = 0, latUsed = 0;
            if (mapReady)
            {
                DrawGraticule(hw, hh, ref lonUsed, ref latUsed);
                DrawScaleBar(hw, hh);
            }
            else
            {
                Hide(scaleLabel);
                if (!noMap && progress > 0)
                {
                    // Build progress under "MAP …".
                    Vector2 a = new Vector2(-80f, -18f);
                    frameMesh.Line(a, a + new Vector2(160f, 0f), HudTokens.Hairline, HudTokens.StrokeHair);
                    frameMesh.Line(a, a + new Vector2(1.6f * progress, 0f), 2f, HudTokens.InkTertiary);
                }
            }
            DrawNorth(hw, hh);
            for (int i = lonUsed; i < MaxGratLabels; i++)
            {
                Hide(lonLabels[i]);
            }
            for (int i = latUsed; i < MaxGratLabels; i++)
            {
                Hide(latLabels[i]);
            }
            frameMesh.Commit();
        }

        // Lat/lon ticks on all four edges, longitude labels along the bottom, latitude labels along the left edge. The map
        // is the equirectangular grid (scaled east-west), so meridians and parallels are straight and axis-aligned.
        private void DrawGraticule(float hw, float hh, ref int lonUsed, ref int latUsed)
        {
            if (geo == null)
            {
                return;
            }
            double mpdLat = geo.MetersPerDegree, mpdLon = geo.MetersPerDegree * geo.EastScale;
            if (!(mpdLat > 0.0) || !(mpdLon > 0.0))
            {
                return;
            }
            double stepLat = PickStep(mpdLat / mpu), stepLon = PickStep(mpdLon / mpu);
            int decLat = Decimals(stepLat), decLon = Decimals(stepLon);
            float xMin = center.x - hw * mpu, xMax = center.x + hw * mpu;
            float zMin = center.y - hh * mpu, zMax = center.y + hh * mpu;
            MarsCoordinates sw = geo.ToMapCoordinates(new Vector3(xMin, 0f, zMin));
            MarsCoordinates ne = geo.ToMapCoordinates(new Vector3(xMax, 0f, zMax));

            for (int pass = 0; pass < 2; pass++)
            {
                bool halo = pass == 0;
                long k0 = (long)Math.Ceiling(sw.Longitude / stepLon), k1 = (long)Math.Floor(ne.Longitude / stepLon);
                k1 = Math.Min(k1, k0 + MaxGratLines);
                for (long k = k0; k <= k1; k++)
                {
                    double lon = k * stepLon;
                    float x = (geo.WorldXZ(sw.Latitude, lon).x - center.x) / mpu;
                    Stroke(frameMesh, new Vector2(x, -hh), new Vector2(x, -hh + TickLen), halo);
                    Stroke(frameMesh, new Vector2(x, hh), new Vector2(x, hh - TickLen), halo);
                    if (!halo && lonUsed < MaxGratLabels && x > -hw + 100f && x < hw - ScaleZone)
                    {
                        Place(lonLabels[lonUsed++], GratText(lon, decLon, false), new Vector2(x, -hh + TickLen + 10f));
                    }
                }
                k0 = (long)Math.Ceiling(sw.Latitude / stepLat);
                k1 = Math.Min((long)Math.Floor(ne.Latitude / stepLat), k0 + MaxGratLines);
                for (long k = k0; k <= k1; k++)
                {
                    double lat = k * stepLat;
                    float y = (geo.WorldXZ(lat, sw.Longitude).z - center.y) / mpu;
                    Stroke(frameMesh, new Vector2(-hw, y), new Vector2(-hw + TickLen, y), halo);
                    Stroke(frameMesh, new Vector2(hw, y), new Vector2(hw - TickLen, y), halo);
                    if (!halo && latUsed < MaxGratLabels && y < hh - 56f && y > -hh + 40f)
                    {
                        Place(latLabels[latUsed++], GratText(lat, decLat, true), new Vector2(-hw + TickLen + 4f, y));
                    }
                }
            }
        }

        private static double PickStep(double unitsPerDegree)
        {
            for (int i = 0; i < GratSteps.Length; i++)
            {
                if (GratSteps[i] * unitsPerDegree >= GratMinSpacing)
                {
                    return GratSteps[i];
                }
            }
            return GratSteps[GratSteps.Length - 1];
        }

        private static int Decimals(double step)
        {
            return step >= 0.1 ? 1 : (step >= 0.01 ? 2 : (step >= 0.001 ? 3 : 4));
        }

        private string GratText(double v, int decimals, bool lat)
        {
            long key = (((long)Math.Round(v * 1e5)) * 8 + decimals) * 2 + (lat ? 1 : 0);
            if (!gratCache.TryGetValue(key, out string s))
            {
                s = Degrees(v, decimals, lat);
                gratCache[key] = s;
            }
            return s;
        }

        // Bottom-right: the longest 1-2-5 distance up to ScaleBarMax units, end ticks, a half tick and the label above.
        private void DrawScaleBar(float hw, float hh)
        {
            float best = ScaleSteps[0];
            for (int i = 0; i < ScaleSteps.Length && ScaleSteps[i] / mpu <= ScaleBarMax; i++)
            {
                best = ScaleSteps[i];
            }
            float len = best / mpu;
            float xr = hw - 20f, xl = xr - len, xc = 0.5f * (xl + xr), y = -hh + 22f;
            for (int pass = 0; pass < 2; pass++)
            {
                bool halo = pass == 0;
                Stroke(frameMesh, new Vector2(xl, y), new Vector2(xr, y), halo);
                Stroke(frameMesh, new Vector2(xl, y), new Vector2(xl, y + 6f), halo);
                Stroke(frameMesh, new Vector2(xr, y), new Vector2(xr, y + 6f), halo);
                Stroke(frameMesh, new Vector2(xc, y), new Vector2(xc, y + 3f), halo);
            }
            Place(scaleLabel, ScaleText(Mathf.RoundToInt(best)), new Vector2(xc, y + 16f));
        }

        private string ScaleText(int m)
        {
            if (!scaleCache.TryGetValue(m, out string s))
            {
                s = m >= 1000 ? (m / 1000).ToString(Inv) + " km" : m.ToString(Inv) + " m";
                scaleCache[m] = s;
            }
            return s;
        }

        // Top-right north arrow (the map is north-up, so it only follows the box size).
        private void DrawNorth(float hw, float hh)
        {
            Vector2 tip = new Vector2(hw - 28f, hh - 42f), tail = new Vector2(hw - 28f, hh - 72f);
            Vector2 l = tip + new Vector2(-5f, -8f), r = tip + new Vector2(5f, -8f);
            frameMesh.Line(tail, tip, 3.5f, HudTokens.Halo);
            frameMesh.Line(l, tip, 3.5f, HudTokens.Halo);
            frameMesh.Line(r, tip, 3.5f, HudTokens.Halo);
            frameMesh.Line(tail, tip, 1.5f, HudTokens.InkPrimary);
            frameMesh.Line(l, tip, 1.5f, HudTokens.InkPrimary);
            frameMesh.Line(r, tip, 1.5f, HudTokens.InkPrimary);
            Place(northLabel, "N", new Vector2(hw - 28f, hh - 26f));
        }

        private void RedrawMarks()
        {
            marksMesh.Clear();
            if (mapReady)
            {
                float hw = 0.5f * boxSize.x + 12f, hh = 0.5f * boxSize.y + 12f;   // cull with a margin

                // HOME: 4-point star at HomeBase (scene spawn, or the mission pad), labelled.
                Vector2 home = ToLocal(HomeBase.Position.x, HomeBase.Position.z);
                bool homeIn = Mathf.Abs(home.x) <= hw && Mathf.Abs(home.y) <= hh;
                if (homeIn)
                {
                    for (int k = 0; k <= 8; k++)
                    {
                        int idx = (k + 1) & 7;   // start and end on an inner vertex
                        float a = idx * 45f * Mathf.Deg2Rad;
                        float rad = (idx & 1) == 0 ? 10f : 3.5f;
                        glyph[k] = home + new Vector2(Mathf.Cos(a) * rad, Mathf.Sin(a) * rad);
                    }
                    marksMesh.Polyline(glyph, 9, 3.5f, HudTokens.Halo);
                    marksMesh.Polyline(glyph, 9, 1.5f, HudTokens.InkPrimary);
                    Place(homeLabel, "HOME", home + new Vector2(14f, 0f));
                }
                else
                {
                    Hide(homeLabel);
                }

                // Scanned rocks: class-coloured dots over dark halos.
                for (int i = 0; i < dotPos.Count; i++)
                {
                    Vector2 c = ToLocal(dotPos[i].x, dotPos[i].y);
                    if (Mathf.Abs(c.x) > hw || Mathf.Abs(c.y) > hh)
                    {
                        continue;
                    }
                    marksMesh.Ring(c, 2.75f, 5.5f, HudTokens.Halo, 16);
                    marksMesh.Ring(c, 2f, 4f, dotCol[i], 16);
                }

                DrawMission(hw, hh);

                // Player: chevron pointing along the camera heading (clockwise from north).
                Vector2 pos = ToLocal(lastPlayer.x, lastPlayer.z);
                float th = (float.IsNaN(lastHeading) ? 0f : lastHeading) * Mathf.Deg2Rad;
                Vector2 fwd = new Vector2(Mathf.Sin(th), Mathf.Cos(th)), right = new Vector2(fwd.y, -fwd.x);
                DrawGlyph(ChevronOuter, pos, right, fwd);
                DrawGlyph(ChevronNotch, pos, right, fwd);
            }
            else
            {
                Hide(homeLabel);
                HideWaypointLabels(0);
            }
            marksMesh.Commit();
        }

        // Planned route (outbound solid, way home dimmer) and numbered waypoint rings, culled to the box.
        private void DrawMission(float hw, float hh)
        {
            MissionPlan plan = MissionLink.Current;
            if (plan == null)
            {
                HideWaypointLabels(0);
                return;
            }
            float inv = 1f / mpu;
            Vector2 ax = new Vector2(inv, 0f), ay = new Vector2(0f, inv);
            Vector2 extent = new Vector2(hw, hh);
            MissionTracker tr = ctx.Mission != null && ctx.Mission.Plan == plan ? ctx.Mission : null;
            routeDrawer.DrawRoute(marksMesh, plan, center, ax, ay, MissionRouteDrawer.ClipShape.Rect, extent,
                                  tr != null ? tr.DoneBeforePoint : 0);
            MissionRouteDrawer.DrawWaypoints(marksMesh, plan, center, ax, ay, MissionRouteDrawer.ClipShape.Rect, extent,
                                             MissionRouteStyle.WaypointRadius, tr != null ? tr.States : null,
                                             tr != null ? tr.NextWaypoint : -1);
            int shown = 0;
            for (int i = 0; i < plan.Waypoints.Count; i++)
            {
                MissionWaypoint w = plan.Waypoints[i];
                Vector2 c = ToLocal(w.World.x, w.World.z);
                if (Mathf.Abs(c.x) > hw || Mathf.Abs(c.y) > hh)
                {
                    continue;
                }
                Text label = WaypointLabel(shown);
                Place(label, WaypointNumber(w.Index), c + new Vector2(MissionRouteStyle.WaypointRadius + 4f, 8f));
                bool closed = tr != null && i < tr.States.Length
                              && (tr.States[i] == WaypointState.Done || tr.States[i] == WaypointState.Skipped);
                Color want = closed ? MissionRouteStyle.Done : MissionRouteStyle.Route;
                if (label.color != want)
                {
                    label.color = want;
                }
                shown++;
            }
            HideWaypointLabels(shown);
        }

        private Text WaypointLabel(int i)
        {
            while (wpLabels.Count <= i)
            {
                Text t = CreateLabel("Waypoint" + wpLabels.Count, wpFont, HudTokens.SizeMicro, MissionRouteStyle.Route,
                                     TextAnchor.MiddleLeft, new Vector2(0f, 0.5f));
                t.rectTransform.sizeDelta = new Vector2(40f, 20f);
                wpLabels.Add(t);
            }
            return wpLabels[i];
        }

        private string WaypointNumber(int index)
        {
            while (wpNumbers.Count <= index)
            {
                wpNumbers.Add(wpNumbers.Count.ToString(CultureInfo.InvariantCulture));
            }
            return wpNumbers[index];
        }

        private void HideWaypointLabels(int from)
        {
            for (int i = from; i < wpLabels.Count; i++)
            {
                Hide(wpLabels[i]);
            }
        }

        private void DrawGlyph(Vector2[] shape, Vector2 pos, Vector2 right, Vector2 fwd)
        {
            int n = shape.Length;
            for (int i = 0; i < n; i++)
            {
                glyph[i] = pos + right * shape[i].x + fwd * shape[i].y;
            }
            marksMesh.Polyline(glyph, n, 3.5f, HudTokens.Halo);
            marksMesh.Polyline(glyph, n, 1.5f, HudTokens.InkPrimary);
        }

        private void RedrawWeather()
        {
            weatherMesh.Clear();
            if (layers[(int)MapLayer.Weather] && mapReady)
            {
                if (windSpeedQ > 0)
                {
                    DrawWind();
                }
                for (int i = 0; i < devilCount; i++)
                {
                    int seg = Mathf.Clamp(Mathf.CeilToInt(devilRadius[i] * 0.8f), 24, 96);
                    weatherMesh.Ring(devilPos[i], devilRadius[i], 3.5f, HudTokens.Halo, seg);
                    weatherMesh.Ring(devilPos[i], devilRadius[i], 1.5f, DevilColor, seg);
                }
            }
            weatherMesh.Commit();
        }

        // Uniform wind on a sparse, screen-fixed grid: arrows point where the air moves; length grows with speed.
        private void DrawWind()
        {
            float b = windDirQ * 2f * Mathf.Deg2Rad;
            Vector2 dir = new Vector2(Mathf.Sin(b), Mathf.Cos(b));
            float len = Mathf.Clamp(14f + 2.5f * (windSpeedQ * 0.5f), 16f, 48f);
            Vector2 half = dir * (0.5f * len);
            Vector2 back = -dir * 7f, side = new Vector2(dir.y, -dir.x) * 4f;
            int nx = Mathf.Max(1, Mathf.RoundToInt(boxSize.x / WindSpacing));
            int ny = Mathf.Max(1, Mathf.RoundToInt(boxSize.y / WindSpacing));
            float sx = boxSize.x / nx, sy = boxSize.y / ny;
            float x0 = -0.5f * boxSize.x, y0 = -0.5f * boxSize.y;
            for (int pass = 0; pass < 2; pass++)
            {
                float w = pass == 0 ? 3.5f : 1.5f;
                Color32 col = pass == 0 ? (Color32)HudTokens.Halo : (Color32)WindColor;
                for (int a = 0; a < nx; a++)
                {
                    for (int c = 0; c < ny; c++)
                    {
                        Vector2 m = new Vector2(x0 + (a + 0.5f) * sx, y0 + (c + 0.5f) * sy);
                        Vector2 tip = m + half;
                        weatherMesh.Line(m - half, tip, w, col);
                        weatherMesh.Line(tip + back + side, tip, w, col);
                        weatherMesh.Line(tip + back - side, tip, w, col);
                    }
                }
            }
        }

        private static void Stroke(HudLineMesh mesh, Vector2 a, Vector2 b, bool halo)
        {
            if (halo)
            {
                mesh.Line(a, b, 3f, HudTokens.Halo);
            }
            else
            {
                mesh.Line(a, b, HudTokens.Hairline, HudTokens.StrokeMark);
            }
        }

        private static void Place(Text t, string s, Vector2 pos)
        {
            if (!t.enabled)
            {
                t.enabled = true;
            }
            if (!ReferenceEquals(t.text, s))
            {
                t.text = s;
            }
            RectTransform rt = t.rectTransform;
            if (rt.anchoredPosition != pos)
            {
                rt.anchoredPosition = pos;
            }
        }

        private static void Hide(Text t)
        {
            if (t.enabled)
            {
                t.enabled = false;
            }
        }
    }
}

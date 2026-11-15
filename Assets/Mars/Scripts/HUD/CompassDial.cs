using System.Collections.Generic;
using System.Globalization;
using NasaSpaceApp.Mission;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Bottom-left moving map, heading-up: a circular window (about 250 m radius) on the real elevation map of the terrain
    /// (<see cref="MarsElevationMap"/>: hypsometric tint, hillshade, contours), centred on the player and rotated with the
    /// camera yaw so ahead is up (world +Z = north). Over it, all vector (<see cref="HudLineMesh"/>, no raster rings): a dark
    /// rim with 5-degree ticks and the north mark that turn with the heading, the "N" letter, a fixed lubber mark, the
    /// self chevron, the HOME diamond (on the map when within range, else on the rim at its bearing) and the open rock-card
    /// pips. A scrim panel on the right holds HOME distance/bearing, the player's MOLA elevation, the contour interval and
    /// a 100 m scale bar (4 Hz, text set only on change). While the map builds the dial shows a faint "MAP …" and a
    /// progress arc. No per-frame allocations once the map is built.
    /// </summary>
    public sealed class CompassDial
    {
        private const float R = 150f;                    // bezel radius (dial diameter 300)
        private const float RimWidth = 16f;              // dark tick band inside the bezel
        private const float Inner = R - RimWidth;        // radius of the clear map window
        private const float RimMid = R - RimWidth * 0.5f;
        private const float ViewRadiusM = 250f;          // ground metres at the inner rim
        private const float MetersPerUnit = ViewRadiusM / Inner;
        private const float ScaleBarM = 100f;
        private const float MapAlpha = 0.94f;
        private const float PipMinRadius = 14f;          // keeps near rocks off the self chevron
        private const float MarkMargin = 8f;             // markers stay this far inside the inner rim
        private const float NorthLabelInset = 12f;
        private const float PanelGap = 12f, PanelW = 156f, PanelH = 132f, Pad = 12f;
        private const float ReadoutInterval = 0.25f;     // 4 Hz
        private const float GeoLookupInterval = 5f;
        private const int PipCount = 3;
        private const int TickStep = 5;
        private const int TickCount = 360 / TickStep;
        private const int DiscSegments = 128;

        private static readonly Color TickMinor = HudTokens.Light(0xFFFFFF, 0.45f);
        private static readonly Color TickTen = HudTokens.Light(0xFFFFFF, 0.65f);
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        private static float[] s_TickSin, s_TickCos;

        private readonly HudContext ctx;
        private readonly MarsElevationMap map = new MarsElevationMap();
        private readonly Vector2 center = new Vector2(R, R);
        private readonly HudMapDisc disc;
        private readonly HudLineMesh marks;
        private readonly HudLineMesh route;                               // web mission route + waypoints (under the rim)
        private readonly MissionRouteDrawer routeDrawer = new MissionRouteDrawer();
        private int routeVersion = -1;
        private int trackerVersion = -1;
        private readonly Text north;
        private readonly Text status;
        private readonly Text homeDistance;
        private readonly Text homeBearing;
        private readonly Text elevation;
        private readonly Text contour;

        private readonly Vector2[] pipPos = new Vector2[PipCount];
        private readonly bool[] pipShown = new bool[PipCount];
        private readonly bool[] pipFocused = new bool[PipCount];
        private readonly Dictionary<int, string> elevationCache = new Dictionary<int, string>(64);

        private bool textureHanded;
        private bool mapShown;
        private bool noMapShown;
        private int lastProgress = -1;
        private float lastHeading = float.NaN;
        private float lastCamX = float.NaN, lastCamZ = float.NaN;
        private Vector2 lastHome = new Vector2(float.NaN, float.NaN);

        private float readoutTimer;
        private string distanceText, bearingText, elevationText;
        private MarsGeoReference geo;
        private float nextGeoLookup;

        /// <summary>Builds the dial and its readout panel under <see cref="HudContext.DialLayer"/>.</summary>
        public CompassDial(HudContext ctx)
        {
            this.ctx = ctx;
            ctx.ElevationMap = map;   // the map screen reads the same build (base, overlays, elevations)
            HudSkin skin = ctx.Skin;
            Font regular = skin != null ? skin.Regular : null;
            Font medium = skin != null ? skin.Medium : null;
            Vector2 mid = new Vector2(0.5f, 0.5f);
            Vector2 meshSize = new Vector2(2f * R + 24f, 2f * R + 24f);
            BuildTickTable();

            // Root: dial + panel, ScreenMargin from the left and bottom canvas edges.
            RectTransform root = HudFactory.CreateRect("CompassDial", ctx.DialLayer, Vector2.zero, Vector2.zero,
                                                       new Vector2(HudTokens.ScreenMargin, HudTokens.ScreenMargin),
                                                       new Vector2(2f * R + PanelGap + PanelW, 2f * R));

            // Lens: scrim disc (shows through where the map has no data, and while it builds).
            HudLineMesh lens = HudFactory.CreateLineMesh("Lens", root, Vector2.zero, mid, center, meshSize);
            lens.Ring(Vector2.zero, 0.5f * R, R, HudTokens.Scrim, DiscSegments);
            lens.Commit();

            // Map window (disabled until the map is ready).
            RectTransform mapRect = HudFactory.CreateRect("Map", root, Vector2.zero, mid, center, new Vector2(2f * R, 2f * R));
            disc = mapRect.gameObject.AddComponent<HudMapDisc>();
            disc.raycastTarget = false;
            disc.color = new Color(1f, 1f, 1f, MapAlpha);
            disc.SetRadius(R - 0.5f);
            disc.enabled = false;

            // Mission route (MissionLink.Current), clipped to the map window; the rim is drawn over it.
            route = HudFactory.CreateLineMesh("Route", root, Vector2.zero, mid, center, meshSize);

            // Static frame: rim band, inner and outer hairlines.
            HudLineMesh frame = HudFactory.CreateLineMesh("Frame", root, Vector2.zero, mid, center, meshSize);
            frame.Ring(Vector2.zero, RimMid, RimWidth, HudTokens.Halo, DiscSegments);
            frame.Ring(Vector2.zero, Inner, HudTokens.Hairline, HudTokens.StrokeHair, DiscSegments);
            frame.Ring(Vector2.zero, R - 0.5f, HudTokens.Hairline, HudTokens.StrokeHair, DiscSegments);
            frame.Commit();

            // Moving marks: ticks, north, home, pips, build progress.
            marks = HudFactory.CreateLineMesh("Marks", root, Vector2.zero, mid, center, meshSize);

            north = HudFactory.CreateText("North", root, medium, HudTokens.SizeLabel, HudTokens.InkPrimary, TextAnchor.MiddleCenter,
                                          Vector2.zero, mid, center + new Vector2(0f, Inner - NorthLabelInset), new Vector2(20f, 20f));
            north.text = "N";
            HudFactory.AddHalo(north);

            // Fixed self chevron (points up = ahead) and lubber mark above the bezel.
            HudLineMesh self = HudFactory.CreateLineMesh("Self", root, Vector2.zero, mid, center, meshSize);
            var outer = new[] { new Vector2(-6f, -7f), new Vector2(0f, 8f), new Vector2(6f, -7f) };
            var notch = new[] { new Vector2(-6f, -7f), new Vector2(0f, -3f), new Vector2(6f, -7f) };
            var lubber = new[] { new Vector2(-5f, R + 9f), new Vector2(0f, R + 3f), new Vector2(5f, R + 9f) };
            self.Polyline(outer, 3, 3.5f, HudTokens.Halo);
            self.Polyline(notch, 3, 3.5f, HudTokens.Halo);
            self.Polyline(lubber, 3, 3.5f, HudTokens.Halo);
            self.Polyline(outer, 3, 1.5f, HudTokens.InkPrimary);
            self.Polyline(notch, 3, 1.5f, HudTokens.InkPrimary);
            self.Polyline(lubber, 3, 1.5f, HudTokens.InkPrimary);
            self.Commit();

            status = HudFactory.CreateText("MapStatus", root, medium, HudTokens.SizeMicro, HudTokens.InkTertiary, TextAnchor.MiddleCenter,
                                           Vector2.zero, mid, center + new Vector2(0f, -30f), new Vector2(120f, 20f));
            status.text = "MAP …";

            // Readout panel, bottom-aligned with the dial.
            Image panel = HudFactory.CreatePanel("MapPanel", root, skin, HudTokens.Scrim, HudTokens.RadiusSmall, Vector2.zero,
                                                 Vector2.zero, new Vector2(2f * R + PanelGap, 0f), new Vector2(PanelW, PanelH));
            RectTransform p = panel.rectTransform;
            Vector2 left = new Vector2(0f, 0.5f), right = new Vector2(1f, 0.5f);
            float wide = PanelW - 2f * Pad;

            Text homeLabel = HudFactory.CreateText("HomeLabel", p, medium, HudTokens.SizeMicro, HudTokens.InkTertiary, TextAnchor.MiddleLeft,
                                                   Vector2.zero, left, new Vector2(Pad, 112f), new Vector2(64f, 20f));
            homeLabel.text = "HOME";
            homeBearing = HudFactory.CreateText("HomeBearing", p, regular, HudTokens.SizeLabel, HudTokens.InkSecondary, TextAnchor.MiddleRight,
                                                Vector2.zero, right, new Vector2(PanelW - Pad, 112f), new Vector2(72f, 20f));
            homeDistance = HudFactory.CreateText("HomeDistance", p, regular, HudTokens.SizeLabel, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                                 Vector2.zero, left, new Vector2(Pad, 92f), new Vector2(wide, 20f));
            HudFactory.CreateImage("Divider", p, null, HudTokens.StrokeHair, Vector2.zero, left, new Vector2(Pad, 77.5f), new Vector2(wide, 1f));

            Text elevLabel = HudFactory.CreateText("ElevLabel", p, medium, HudTokens.SizeMicro, HudTokens.InkTertiary, TextAnchor.MiddleLeft,
                                                   Vector2.zero, left, new Vector2(Pad, 62f), new Vector2(64f, 20f));
            elevLabel.text = "ELEV";
            contour = HudFactory.CreateText("Contour", p, regular, HudTokens.SizeMicro, HudTokens.InkTertiary, TextAnchor.MiddleRight,
                                            Vector2.zero, right, new Vector2(PanelW - Pad, 62f), new Vector2(80f, 20f));
            contour.text = "CI --";
            elevation = HudFactory.CreateText("Elevation", p, regular, HudTokens.SizeLabel, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                              Vector2.zero, left, new Vector2(Pad, 42f), new Vector2(wide, 20f));

            // Scale bar: ScaleBarM at the map scale, end ticks and a half tick.
            float barLen = ScaleBarM / MetersPerUnit;
            const float BarY = 16.5f;
            HudLineMesh bar = HudFactory.CreateLineMesh("ScaleBar", p, Vector2.zero, Vector2.zero, Vector2.zero, new Vector2(PanelW, 32f));
            bar.Line(new Vector2(Pad, BarY), new Vector2(Pad + barLen, BarY), HudTokens.Hairline, HudTokens.StrokeMark);
            bar.Line(new Vector2(Pad + 0.5f, BarY), new Vector2(Pad + 0.5f, BarY + 5f), HudTokens.Hairline, HudTokens.StrokeMark);
            bar.Line(new Vector2(Pad + barLen - 0.5f, BarY), new Vector2(Pad + barLen - 0.5f, BarY + 5f), HudTokens.Hairline, HudTokens.StrokeMark);
            bar.Line(new Vector2(Pad + 0.5f * barLen, BarY), new Vector2(Pad + 0.5f * barLen, BarY + 3f), HudTokens.Hairline, HudTokens.StrokeMark);
            bar.Commit();
            Text barLabel = HudFactory.CreateText("ScaleLabel", p, regular, HudTokens.SizeMicro, HudTokens.InkTertiary, TextAnchor.MiddleLeft,
                                                  Vector2.zero, left, new Vector2(Pad + barLen + 8f, 19f), new Vector2(56f, 20f));
            barLabel.text = "100 m";

            ctx.ReserveZone(root);
            geo = MarsGeoReference.Instance;
            nextGeoLookup = GeoLookupInterval;
            RefreshReadout();
        }

        /// <summary>
        /// Per frame: advances the map build; pans/rotates the map window with the camera (no smoothing); redraws the
        /// ticks, north, home and pips only when the heading, position, pips or build progress changed.
        /// </summary>
        public void Tick(float dt)
        {
            Vector3 cam = ctx.CameraPosition;
            bool dirty = false;

            // 1. Map build, then hand-over to the disc.
            if (!mapShown && !noMapShown)
            {
                map.Tick(cam, dt);
                if (!textureHanded && map.Texture != null)
                {
                    disc.SetTexture(map.Texture, true);   // the disc owns (and destroys) the texture
                    textureHanded = true;
                }
                if (map.IsReady)
                {
                    mapShown = true;
                    disc.enabled = true;
                    status.enabled = false;
                    contour.text = "CI " + Mathf.RoundToInt(map.ContourInterval).ToString(Inv) + " m";
                    lastHeading = float.NaN;   // force the first mapping
                    dirty = true;
                }
                else if (map.State == MarsElevationMap.MapState.NoTerrain)
                {
                    noMapShown = true;
                    status.text = "NO MAP";
                    dirty = true;
                }
                else
                {
                    int progress = Mathf.FloorToInt(map.Progress * 100f);
                    if (progress != lastProgress)
                    {
                        lastProgress = progress;
                        dirty = true;
                    }
                }
            }

            // 2. Heading and position.
            float heading = ctx.HeadingDeg;
            float th = heading * Mathf.Deg2Rad;
            float cosH = Mathf.Cos(th), sinH = Mathf.Sin(th);
            bool turned = heading != lastHeading;
            bool moved = cam.x != lastCamX || cam.z != lastCamZ;
            if (turned || moved)
            {
                lastHeading = heading;
                lastCamX = cam.x;
                lastCamZ = cam.z;
                dirty = true;
            }
            if (turned)
            {
                SetPos(north.rectTransform, center + new Vector2(-sinH, cosH) * (Inner - NorthLabelInset));
            }
            if (mapShown)
            {
                Rect wb = map.WorldBounds;
                float ax = MetersPerUnit / wb.width, az = MetersPerUnit / wb.height;
                disc.SetMapping(map.WorldToUV(cam), new Vector2(cosH * ax, -sinH * az), new Vector2(sinH * ax, cosH * az));
            }

            // 3. Home and pips (screen offsets from the dial centre).
            Vector2 home = ToScreen(HomeOffset(cam), cosH, sinH);
            if (home != lastHome)
            {
                lastHome = home;
                dirty = true;
            }
            dirty |= UpdatePips(cam, cosH, sinH);

            MissionTracker tracker = ctx.Mission;
            int tv = tracker != null ? tracker.Version : 0;
            bool routeChanged = MissionLink.Version != routeVersion || tv != trackerVersion;
            if (routeChanged || turned || moved)
            {
                routeVersion = MissionLink.Version;
                trackerVersion = tv;
                RedrawRoute(cam, cosH, sinH);
            }

            if (dirty)
            {
                RedrawMarks(cosH, sinH);
            }

            readoutTimer -= dt;
            if (readoutTimer <= 0f)
            {
                readoutTimer += ReadoutInterval;
                if (readoutTimer <= 0f)
                {
                    readoutTimer = ReadoutInterval;
                }
                RefreshReadout();
            }
        }

        private bool UpdatePips(Vector3 cam, float cosH, float sinH)
        {
            bool changed = false;
            RockCardSystem cards = ctx.Cards;
            int count = cards != null ? Mathf.Min(cards.CardCount, PipCount) : 0;
            for (int i = 0; i < PipCount; i++)
            {
                bool shown = false, focused = false;
                Vector2 pos = pipPos[i];
                if (i < count && cards.TryGetCard(i, out Vector3 anchor, out focused))
                {
                    shown = true;
                    // True bearing; true distance at the map scale, kept off the chevron and inside the rim.
                    float dx = anchor.x - cam.x, dz = anchor.z - cam.z;
                    float d = Mathf.Sqrt(dx * dx + dz * dz);
                    if (d > 1e-4f)
                    {
                        float r = Mathf.Clamp(d / MetersPerUnit, PipMinRadius, Inner - MarkMargin);
                        pos = ToScreen(new Vector2(dx / d * r, dz / d * r), cosH, sinH) * MetersPerUnit;
                    }
                    else
                    {
                        pos = new Vector2(0f, PipMinRadius);
                    }
                }
                if (shown != pipShown[i] || (shown && (focused != pipFocused[i] || pos != pipPos[i])))
                {
                    pipShown[i] = shown;
                    pipFocused[i] = focused;
                    pipPos[i] = pos;
                    changed = true;
                }
            }
            return changed;
        }

        // Route and waypoint rings, heading-up like the map (same transform as ToScreen), clipped at the inner rim.
        private void RedrawRoute(Vector3 cam, float cosH, float sinH)
        {
            route.Clear();
            MissionPlan plan = MissionLink.Current;
            if (plan != null)
            {
                const float inv = 1f / MetersPerUnit;
                Vector2 origin = new Vector2(cam.x, cam.z);
                Vector2 ax = new Vector2(cosH, sinH) * inv, ay = new Vector2(-sinH, cosH) * inv;
                Vector2 clip = new Vector2(Inner - 1f, 0f);
                MissionTracker tr = ctx.Mission != null && ctx.Mission.Plan == plan ? ctx.Mission : null;
                int doneBefore = tr != null ? tr.DoneBeforePoint : 0;
                int next = tr != null ? tr.NextWaypoint : -1;
                routeDrawer.DrawRoute(route, plan, origin, ax, ay, MissionRouteDrawer.ClipShape.Circle, clip, doneBefore);
                MissionRouteDrawer.DrawWaypoints(route, plan, origin, ax, ay, MissionRouteDrawer.ClipShape.Circle,
                                                 new Vector2(Inner - MarkMargin, 0f), MissionRouteStyle.DialWaypointRadius,
                                                 tr != null ? tr.States : null, next);

                // Next waypoint beyond the window: a violet ring on the window's edge at its bearing.
                if (next >= 0)
                {
                    Vector2 c = MissionRouteDrawer.Local(plan.Waypoints[next].World, origin, ax, ay);
                    float edge = Inner - MarkMargin;
                    float r = c.magnitude;
                    if (r > edge && r > 1e-3f)
                    {
                        c = c / r * edge;
                        route.Ring(c, MissionRouteStyle.DialWaypointRadius, 3.5f, HudTokens.Halo, 20);
                        route.Ring(c, MissionRouteStyle.DialWaypointRadius, 2f, MissionRouteStyle.Route, 20);
                        route.Ring(c, MissionRouteStyle.DialWaypointRadius + 3f, 1.5f, HudTokens.InkPrimary, 24);
                    }
                }
            }
            route.Commit();
        }

        private void RedrawMarks(float cosH, float sinH)
        {
            marks.Clear();

            // Ticks every 5 deg on the rim: 10 deg longer, 30 deg major, cardinals longest, north in primary ink.
            for (int k = 0; k < TickCount; k++)
            {
                int b = k * TickStep;
                Vector2 dir = new Vector2(s_TickSin[k] * cosH - s_TickCos[k] * sinH, s_TickSin[k] * sinH + s_TickCos[k] * cosH);
                float len, w;
                Color col;
                if (b == 0)
                {
                    len = 13f; w = 2f; col = HudTokens.InkPrimary;
                }
                else if (b % 90 == 0)
                {
                    len = 11f; w = 1.5f; col = HudTokens.StrokeMark;
                }
                else if (b % 30 == 0)
                {
                    len = 9f; w = 1.25f; col = HudTokens.StrokeMark;
                }
                else if (b % 10 == 0)
                {
                    len = 6f; w = 1f; col = TickTen;
                }
                else
                {
                    len = 4f; w = 1f; col = TickMinor;
                }
                marks.Line(dir * (R - 1.5f), dir * (R - 1.5f - len), w, col);
            }

            // Build progress on the rim.
            if (!mapShown && !noMapShown && lastProgress > 0)
            {
                float p = lastProgress / 100f;
                marks.Arc(Vector2.zero, RimMid, 90f, 90f - 360f * p, 2f, HudTokens.InkTertiary, Mathf.Max(1, Mathf.CeilToInt(96f * p)));
            }

            // HOME diamond: on the map when within the window, else on the rim at its bearing.
            Vector2 home = lastHome;
            float hr = home.magnitude;
            if (!float.IsNaN(hr))
            {
                if (hr > Inner - MarkMargin)
                {
                    home = home / hr * RimMid;
                }
                marks.Ring(home, 5.5f, 3.5f, HudTokens.Halo, 4);
                marks.Ring(home, 5.5f, 1.5f, HudTokens.InkPrimary, 4);
            }

            // Rock pips: 7x7 squares over 9x9 halos (square = rock, diamond = waypoint).
            for (int i = 0; i < PipCount; i++)
            {
                if (!pipShown[i])
                {
                    continue;
                }
                Vector2 c = pipPos[i];
                float hh = 0.5f * HudTokens.PipHalo, hp = 0.5f * HudTokens.PipSize;
                marks.Rect(new Rect(c.x - hh, c.y - hh, HudTokens.PipHalo, HudTokens.PipHalo), HudTokens.Halo);
                marks.Rect(new Rect(c.x - hp, c.y - hp, HudTokens.PipSize, HudTokens.PipSize),
                           pipFocused[i] ? HudTokens.Accent : HudTokens.InkPrimary);
            }

            marks.Commit();
        }

        private void RefreshReadout()
        {
            string dist = HudStrings.Distance(HomeDistance());
            if (!ReferenceEquals(dist, distanceText))
            {
                distanceText = dist;
                homeDistance.text = dist;
            }
            string bearing = HudStrings.Heading((int)HomeBearing());
            if (!ReferenceEquals(bearing, bearingText))
            {
                bearingText = bearing;
                homeBearing.text = bearing;
            }

            if (geo == null && ctx.UnscaledTime >= nextGeoLookup)
            {
                geo = MarsGeoReference.Instance;
                nextGeoLookup = ctx.UnscaledTime + GeoLookupInterval;
            }
            string elev = "--";
            if (geo != null)
            {
                Vector3 feet = ctx.Player != null ? ctx.Player.transform.position : ctx.CameraPosition;
                elev = ElevationText(Mathf.RoundToInt(geo.ElevationMOLA(feet)));
            }
            if (!ReferenceEquals(elev, elevationText))
            {
                elevationText = elev;
                elevation.text = elev;
            }
        }

        // "−4 418 m": U+2212 minus, space as thousands separator; cached per metre.
        private string ElevationText(int m)
        {
            if (elevationCache.TryGetValue(m, out string s))
            {
                return s;
            }
            int a = m < 0 ? -m : m;
            string digits = a >= 1000
                ? (a / 1000).ToString(Inv) + " " + (a % 1000).ToString("000", Inv)
                : a.ToString(Inv);
            s = (m < 0 ? HudStrings.Minus.ToString() : string.Empty) + digits + " m";
            elevationCache[m] = s;
            return s;
        }

        // World (east, north) offset to dial units, heading-up: ahead = +y.
        private static Vector2 ToScreen(Vector2 world, float cosH, float sinH)
        {
            return new Vector2(world.x * cosH - world.y * sinH, world.x * sinH + world.y * cosH) / MetersPerUnit;
        }

        // Home = HomeBase (spawn, or the mission pad). Telemetry owns the numbers; the local formula is only a null fallback.
        private Vector2 HomeOffset(Vector3 cam)
        {
            if (ctx.Telemetry != null)
            {
                float b = ctx.Telemetry.BearingHomeDeg * Mathf.Deg2Rad;
                float d = ctx.Telemetry.DistanceHomeM;
                return new Vector2(Mathf.Sin(b) * d, Mathf.Cos(b) * d);
            }
            return HomeBase.OffsetFrom(cam);
        }

        private float HomeBearing()
        {
            if (ctx.Telemetry != null)
            {
                return ctx.Telemetry.BearingHomeDeg;
            }
            Vector2 o = HomeBase.OffsetFrom(ctx.CameraPosition);
            return Mathf.Repeat(Mathf.Atan2(o.x, o.y) * Mathf.Rad2Deg, 360f);
        }

        private float HomeDistance()
        {
            if (ctx.Telemetry != null)
            {
                return ctx.Telemetry.DistanceHomeM;
            }
            return HomeBase.OffsetFrom(ctx.CameraPosition).magnitude;
        }

        private static void BuildTickTable()
        {
            if (s_TickSin != null)
            {
                return;
            }
            s_TickSin = new float[TickCount];
            s_TickCos = new float[TickCount];
            for (int k = 0; k < TickCount; k++)
            {
                float b = k * TickStep * Mathf.Deg2Rad;
                s_TickSin[k] = Mathf.Sin(b);
                s_TickCos[k] = Mathf.Cos(b);
            }
        }

        private static void SetPos(RectTransform rt, Vector2 pos)
        {
            if (rt.anchoredPosition != pos)
            {
                rt.anchoredPosition = pos;
            }
        }
    }
}

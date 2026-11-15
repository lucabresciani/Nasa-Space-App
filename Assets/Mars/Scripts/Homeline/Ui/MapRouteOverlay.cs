using System;
using System.Collections.Generic;
using System.Reflection;
using NasaSpaceApp.Homeline.Flow;
using NasaSpaceApp.Homeline.Sim;
using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Homeline.Ui
{
    /// <summary>
    /// The planned EVA route and its waypoints on the helmet HUD's own maps, without touching the HUD code:
    ///   full-screen EVA map (G)   route line, navigation points (small beads), stations (diamonds with their id),
    ///                             a ring around the pad (the map's own HOME star stays on top of it);
    ///   bottom-left dial          route line cut at the dial window and stations as small rings.
    ///
    /// HOW THE MAP COORDINATES ARE OBTAINED (MapView keeps centre and scale private). No reflection: the view is read
    /// back from public, observable state every frame. MapView writes its pan/zoom into the uvRect of its "Base"
    /// RawImage, as a window on the texture that covers <see cref="MarsElevationMap.WorldBounds"/> (public, through
    /// HelmetHud.Instance.Context.ElevationMap). So
    ///   metres shown   = uvRect.size * WorldBounds.size            metres per unit = metres shown / Clip rect size
    ///   world centre   = WorldBounds.min + (uvRect.min + uvRect.size / 2) * WorldBounds.size
    ///   map-local      = (world XZ - world centre) / metres per unit      (origin at the box centre, north up)
    /// which is MapView.ToLocal. The map is always north-up, so there is no rotation. The view is rejected (overlay
    /// hidden) when the two axes disagree on the scale by more than 2 %: that is the sign of a uvRect that is not the
    /// map's view (not applied yet, or MapView changed its meaning).
    /// The dial has no such observable state: its transform is CompassDial.ToScreen re-stated here (camera position
    /// and heading from the public HudContext) with the dial's two constants copied (see <see cref="DialInner"/>).
    ///
    /// HIERARCHY. The HUD is rebuilt per scene while this component lives on the DontDestroyOnLoad HOMELINE object,
    /// so the map objects are found lazily by name and found again when Unity reports them destroyed. Under the map's
    /// "Clip" (its RectMask2D clips the overlay like the map's own marks): "HomelineRoute" is inserted just UNDER the
    /// map's "Marks" (above the rasters, the weather and the frame), so the HOME star, the scanned rocks and the
    /// player arrow stay readable on top of the route; "HomelineRouteLabels" just above "Marks". MapView and MapScreen
    /// hold references to their children and never address them by index, so the two extra siblings are harmless.
    ///
    /// Runs after HelmetHud (execution order 100), so the map has applied this frame's pan and zoom. The route is
    /// simplified once per plan (Douglas-Peucker, 1 m); redraws happen only when the view or the plan changed and
    /// reuse their buffers.
    /// </summary>
    [DefaultExecutionOrder(200)]
    [DisallowMultipleComponent]
    public sealed class MapRouteOverlay : MonoBehaviour
    {
        const string MapClipPath = "MapScreen/Frame/MapBox/MapView/Clip";   // under the HelmetHUD root
        const double SimplifyToleranceM = 1.0;
        const float FindInterval = 0.5f;
        const float CullMargin = 16f;
        const float RouteWidth = 2.5f, RouteHaloWidth = 5f;
        const float PadRingRadius = 13f;      // outside the HOME star (tips at 10), inside its "HOME" label (from 14)
        const float LabelOffset = 15f;
        const float MaxAxisMismatch = 0.02f;

        /// <summary>
        /// COPIES of CompassDial's private constants: Inner (radius of the clear map window, R - RimWidth = 150 - 16)
        /// and MetersPerUnit (ViewRadiusM / Inner = 250 / 134). If the HUD changes them, change these.
        /// </summary>
        const float DialInner = 134f;
        const float DialMetersPerUnit = 250f / DialInner;

        /// <summary>Amber of the 3D route ribbon (RouteWorldView.RouteColor: 1.00, 0.74, 0.22).</summary>
        static readonly Color32 RouteColor = new Color32(255, 189, 56, 255);
        static readonly Vector2 Mid = new Vector2(0.5f, 0.5f), LeftMid = new Vector2(0f, 0.5f);

        /// <summary>Set to false to keep the route off the bottom-left dial (the full-screen map is not affected).</summary>
        public static bool ShowOnDial = true;

        /// <summary>Vertices of the simplified route of the current plan (0 = no plan built).</summary>
        public int RoutePointCount { get { return ptCount; } }
        /// <summary>Route segments stroked in the last redraw of the full-screen map.</summary>
        public int MapSegmentsDrawn { get; private set; }
        /// <summary>Station marks inside the box in the last redraw of the full-screen map.</summary>
        public int MapStationsShown { get; private set; }

        // ---- plan data, rebuilt when the plan object changes
        MissionPlan builtPlan;
        int dataVersion;
        Vector2[] routeXZ = new Vector2[256];   // route vertices, world XZ
        bool[] runStart = new bool[256];        // true = no segment from the previous vertex (first vertex of a leg)
        Vector2[] local = new Vector2[256];     // scratch: the vertices in map or dial units
        Vector2[] run = new Vector2[256];       // scratch: one run of visible segments
        int ptCount;
        Vector2[] wpXZ = new Vector2[32];
        WaypointKind[] wpKind = new WaypointKind[32];
        string[] wpId = new string[32];
        int wpCount;

        // ---- full-screen map
        RectTransform clip, labelRoot;
        RawImage baseImage;
        HudLineMesh mapMesh;
        Font labelFont;
        readonly List<Text> labels = new List<Text>(8);
        Rect drawnUv;
        Vector2 drawnSize;
        int drawnVersion = -1;
        float nextMapFind;

        // ---- dial
        HudLineMesh dialMesh;
        float nextDialFind;
        float dialCamX = float.NaN, dialCamZ = float.NaN, dialHeading = float.NaN;
        int dialVersion = -1;

        float retryAt;
        bool reported;

        /// <summary>
        /// Opens or closes the HUD's full-screen map exactly as the G key does, for self-tests: HelmetHud's private
        /// OpenMap() / CloseMap(), by reflection (the HUD has no public entry). Like the key, opening frees the cursor
        /// and freezes the player's input until it is closed. Returns true when the map ends up in the requested state.
        /// </summary>
        public static bool SetMapOpen(bool open)
        {
            HelmetHud hud = HelmetHud.Instance;
            HudContext ctx = hud != null ? hud.Context : null;
            if (ctx == null) return false;
            if (ctx.MapScreenOpen != open)
            {
                MethodInfo m = typeof(HelmetHud).GetMethod(open ? "OpenMap" : "CloseMap", BindingFlags.Instance | BindingFlags.NonPublic);
                if (m == null || m.GetParameters().Length != 0) return false;
                m.Invoke(hud, null);
            }
            return ctx.MapScreenOpen == open;
        }

        void LateUpdate()
        {
            if (Time.unscaledTime < retryAt) return;
            try
            {
                Step();
            }
            catch (Exception e)
            {
                // Never take the frame down for a map decoration: report once, try again in a while.
                retryAt = Time.unscaledTime + 5f;
                if (!reported)
                {
                    reported = true;
                    Debug.LogException(e);
                }
            }
        }

        void Step()
        {
            HomelineApp app = HomelineApp.Instance;
            EvaDriver driver = app != null ? app.Driver : null;
            MissionPlan plan = driver != null && driver.Active ? driver.Plan : null;
            HelmetHud hud = HelmetHud.Instance;
            HudContext ctx = hud != null ? hud.Context : null;
            if (plan == null || ctx == null)
            {
                // No mission (or no HUD in this scene): nothing of the overlay stays on the maps.
                SetActive(mapMesh, false);
                SetActive(labelRoot, false);
                SetActive(dialMesh, false);
                drawnVersion = dialVersion = -1;
                return;
            }
            if (ctx.Canvas != null && !ctx.Canvas.enabled) return;   // HUD hidden under the title / pause menu
            if (!ReferenceEquals(plan, builtPlan)) BuildPlan(plan);
            UpdateMap(hud, ctx);
            UpdateDial(ctx);
        }

        // ------------------------------------------------------------------------------------------------ plan data

        void BuildPlan(MissionPlan plan)
        {
            builtPlan = plan;
            dataVersion++;
            ptCount = 0;
            wpCount = 0;
            PadFrame frame = plan.Frame;
            if (frame == null) return;

            RouteTrack track = plan.Route != null ? plan.Route.Track : null;
            IReadOnlyList<RouteLeg> legs = track != null ? track.Legs : null;
            for (int li = 0; legs != null && li < legs.Count; li++)
            {
                RouteLeg leg = legs[li];
                if (leg == null || leg.X == null || leg.Y == null || leg.X.Length != leg.Y.Length || leg.X.Length < 2) continue;
                // The rows are 1 m apart: keep the vertices that matter at any zoom of the map (ends always kept).
                bool[] keep = WaypointPlan.Simplify(leg.X, leg.Y, SimplifyToleranceM);
                bool first = true;
                for (int i = 0; i < leg.X.Length; i++)
                {
                    if (!keep[i]) continue;
                    if (ptCount == routeXZ.Length)
                    {
                        Array.Resize(ref routeXZ, ptCount * 2);
                        Array.Resize(ref runStart, ptCount * 2);
                    }
                    routeXZ[ptCount] = ToWorld(frame, leg.X[i], leg.Y[i]);
                    runStart[ptCount] = first;
                    ptCount++;
                    first = false;
                }
            }
            if (local.Length < routeXZ.Length)
            {
                local = new Vector2[routeXZ.Length];
                run = new Vector2[routeXZ.Length];
            }

            // The pad first, at the point the HUD calls HOME (EvaDriver sets SuitTelemetry.HomeXZ from Route.PadX/PadY),
            // so the ring is concentric with the map's HOME star.
            bool hasPad = plan.Route != null;
            Vector2 pad = hasPad ? ToWorld(frame, plan.Route.PadX, plan.Route.PadY) : Vector2.zero;
            if (hasPad) AddWaypoint(pad, WaypointKind.Pad, null);
            IReadOnlyList<Waypoint> all = plan.Waypoints != null ? plan.Waypoints.All : null;
            for (int i = 0; all != null && i < all.Count; i++)
            {
                Waypoint w = all[i];
                if (w == null) continue;
                Vector2 p = ToWorld(frame, w.X, w.Y);
                if (w.Kind == WaypointKind.Pad || w.Kind == WaypointKind.Return)
                {
                    if (hasPad && (p - pad).sqrMagnitude < 25f) continue;   // the pad again (departure, return)
                    AddWaypoint(p, WaypointKind.Pad, null);
                }
                else
                {
                    AddWaypoint(p, w.Kind, w.Id);
                }
            }
        }

        static Vector2 ToWorld(PadFrame frame, double x, double y)
        {
            double wx, wz;
            frame.LocalToWorld(x, y, out wx, out wz);
            return new Vector2((float)wx, (float)wz);
        }

        void AddWaypoint(Vector2 xz, WaypointKind kind, string id)
        {
            if (wpCount == wpXZ.Length)
            {
                Array.Resize(ref wpXZ, wpCount * 2);
                Array.Resize(ref wpKind, wpCount * 2);
                Array.Resize(ref wpId, wpCount * 2);
            }
            wpXZ[wpCount] = xz;
            wpKind[wpCount] = kind;
            wpId[wpCount] = id;
            wpCount++;
        }

        // ------------------------------------------------------------------------------------------------ full-screen map

        void UpdateMap(HelmetHud hud, HudContext ctx)
        {
            if (clip == null || baseImage == null)
            {
                if (Time.unscaledTime < nextMapFind) return;
                nextMapFind = Time.unscaledTime + FindInterval;
                Transform t = hud.transform.Find(MapClipPath);   // Find also returns inactive children (map closed)
                if (t == null)
                {
                    Transform view = FindDeep(hud.transform, "MapView");
                    t = view != null ? view.Find("Clip") : null;
                }
                clip = t as RectTransform;
                Transform b = clip != null ? clip.Find("Base") : null;
                baseImage = b != null ? b.GetComponent<RawImage>() : null;
                if (clip == null || baseImage == null)
                {
                    clip = null;
                    baseImage = null;
                    return;
                }
            }
            if (!clip.gameObject.activeInHierarchy) return;   // map closed: nothing to build, nothing to draw
            if (mapMesh == null || labelRoot == null) BuildMapObjects(ctx);

            // The map's view, read back from the base raster (see the class comment).
            MarsElevationMap map = ctx.ElevationMap;
            Rect uv = baseImage.uvRect;
            Vector2 size = clip.rect.size;
            float cx = 0f, cz = 0f, kx = 0f, kz = 0f;
            bool ok = map != null && map.IsReady && size.x >= 1f && size.y >= 1f;
            if (ok)
            {
                Rect wb = map.WorldBounds;
                float w = uv.width * wb.width, h = uv.height * wb.height;   // metres across the box
                ok = w > 0f && h > 0f;
                if (ok)
                {
                    float mx = w / size.x, mz = h / size.y;                 // metres per unit, the same on both axes
                    ok = Mathf.Abs(mx - mz) <= MaxAxisMismatch * Mathf.Max(mx, mz);
                    cx = wb.x + (uv.x + 0.5f * uv.width) * wb.width;
                    cz = wb.y + (uv.y + 0.5f * uv.height) * wb.height;
                    kx = 1f / mx;
                    kz = 1f / mz;
                }
            }
            SetActive(mapMesh, ok);
            SetActive(labelRoot, ok);
            if (!ok)
            {
                drawnVersion = -1;
                return;
            }
            if (drawnVersion == dataVersion && uv == drawnUv && size == drawnSize) return;
            drawnVersion = dataVersion;
            drawnUv = uv;
            drawnSize = size;
            RedrawMap(cx, cz, kx, kz, size);
        }

        void BuildMapObjects(HudContext ctx)
        {
            Transform marks = clip.Find("Marks");
            if (mapMesh == null)
            {
                RectTransform rt = HudFactory.CreateStretch("HomelineRoute", clip);   // pivot centre: origin = box centre
                mapMesh = rt.gameObject.AddComponent<HudLineMesh>();
                mapMesh.raycastTarget = false;
                if (marks != null) rt.SetSiblingIndex(marks.GetSiblingIndex());       // just under the map's marks
            }
            if (labelRoot == null)
            {
                labelRoot = HudFactory.CreateStretch("HomelineRouteLabels", clip);
                if (marks != null) labelRoot.SetSiblingIndex(marks.GetSiblingIndex() + 1);
                labels.Clear();
            }
            HudSkin skin = ctx.Skin;
            labelFont = skin != null ? skin.Medium : null;   // as MapView's own HOME label
            if (labelFont == null) labelFont = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            drawnVersion = -1;
        }

        void RedrawMap(float cx, float cz, float kx, float kz, Vector2 size)
        {
            float hw = 0.5f * size.x + CullMargin, hh = 0.5f * size.y + CullMargin;
            for (int i = 0; i < ptCount; i++)
                local[i] = new Vector2((routeXZ[i].x - cx) * kx, (routeXZ[i].y - cz) * kz);

            mapMesh.Clear();
            EmitRoute(mapMesh, hw, hh, 0f, RouteHaloWidth, HudTokens.Halo);
            MapSegmentsDrawn = EmitRoute(mapMesh, hw, hh, 0f, RouteWidth, RouteColor);

            // Navigation points first, so a station or the pad draws over a bead next to it.
            for (int i = 0; i < wpCount; i++)
            {
                if (wpKind[i] != WaypointKind.Nav) continue;
                Vector2 p = new Vector2((wpXZ[i].x - cx) * kx, (wpXZ[i].y - cz) * kz);
                if (Mathf.Abs(p.x) > hw || Mathf.Abs(p.y) > hh) continue;
                mapMesh.Ring(p, 2.25f, 4.5f, HudTokens.Halo, 12);   // discs: Ring(centre, R / 2, R)
                mapMesh.Ring(p, 1.5f, 3f, RouteColor, 12);
            }

            int station = 0, shown = 0;
            for (int i = 0; i < wpCount; i++)
            {
                if (wpKind[i] == WaypointKind.Nav) continue;
                Vector2 p = new Vector2((wpXZ[i].x - cx) * kx, (wpXZ[i].y - cz) * kz);
                bool inside = Mathf.Abs(p.x) <= hw && Mathf.Abs(p.y) <= hh;
                if (wpKind[i] == WaypointKind.Station)
                {
                    Text label = Label(station++);
                    if (inside && !string.IsNullOrEmpty(wpId[i])) Place(label, wpId[i], p + new Vector2(LabelOffset, 0f));
                    else if (label.enabled) label.enabled = false;
                    if (!inside) continue;
                    shown++;
                    // Diamond (a 4-segment ring): dark body, light outline, amber centre. A shape of its own next to
                    // the beads, the HOME star and the rock dots.
                    mapMesh.Ring(p, 9f, 5f, HudTokens.Halo, 4);
                    mapMesh.Ring(p, 4.5f, 6.4f, HudTokens.KeycapInk, 4);
                    mapMesh.Ring(p, 9f, 2f, HudTokens.InkPrimary, 4);
                    mapMesh.Ring(p, 1.5f, 3f, RouteColor, 12);
                }
                else if (inside)
                {
                    // Pad: an open ring around the map's HOME star, which is drawn above this mesh.
                    mapMesh.Ring(p, PadRingRadius, 4f, HudTokens.Halo, 40);
                    mapMesh.Ring(p, PadRingRadius, 1.5f, RouteColor, 40);
                }
            }
            for (int i = station; i < labels.Count; i++)
            {
                if (labels[i] != null && labels[i].enabled) labels[i].enabled = false;
            }
            MapStationsShown = shown;
            mapMesh.Commit();
        }

        Text Label(int index)
        {
            while (labels.Count <= index)
            {
                Text t = HudFactory.CreateText("Wp" + labels.Count, labelRoot, labelFont, HudTokens.SizeMicro, HudTokens.InkPrimary,
                                               TextAnchor.MiddleLeft, Mid, LeftMid, Vector2.zero, new Vector2(80f, 20f));
                HudFactory.AddHalo(t);
                t.enabled = false;
                labels.Add(t);
            }
            return labels[index];
        }

        static void Place(Text t, string s, Vector2 pos)
        {
            if (!t.enabled) t.enabled = true;
            if (!ReferenceEquals(t.text, s)) t.text = s;
            RectTransform rt = t.rectTransform;
            if (rt.anchoredPosition != pos) rt.anchoredPosition = pos;
        }

        // ------------------------------------------------------------------------------------------------ dial

        void UpdateDial(HudContext ctx)
        {
            if (!ShowOnDial)
            {
                SetActive(dialMesh, false);
                dialVersion = -1;
                return;
            }
            if (dialMesh == null)
            {
                if (Time.unscaledTime < nextDialFind) return;
                nextDialFind = Time.unscaledTime + FindInterval;
                RectTransform root = ctx.DialLayer != null ? ctx.DialLayer.Find("CompassDial") as RectTransform : null;
                RectTransform marks = root != null ? root.Find("Marks") as RectTransform : null;
                Transform frame = root != null ? root.Find("Frame") : null;
                if (marks == null || frame == null || !root.gameObject.activeInHierarchy) return;
                // Same rect as the dial's own marks (origin = dial centre); above the map disc, under the rim, the
                // ticks, the HOME diamond and the self chevron.
                dialMesh = HudFactory.CreateLineMesh("HomelineRoute", root, marks.anchorMin, marks.pivot, marks.anchoredPosition, marks.sizeDelta);
                dialMesh.transform.SetSiblingIndex(frame.GetSiblingIndex());
                dialVersion = -1;
            }
            SetActive(dialMesh, true);

            Vector3 cam = ctx.CameraPosition;
            float heading = ctx.HeadingDeg;
            if (dialVersion == dataVersion && cam.x == dialCamX && cam.z == dialCamZ && heading == dialHeading) return;
            dialVersion = dataVersion;
            dialCamX = cam.x;
            dialCamZ = cam.z;
            dialHeading = heading;

            // CompassDial.ToScreen: heading-up, ahead = +y, centred on the camera.
            float th = heading * Mathf.Deg2Rad, cos = Mathf.Cos(th), sin = Mathf.Sin(th), k = 1f / DialMetersPerUnit;
            for (int i = 0; i < ptCount; i++)
            {
                float dx = routeXZ[i].x - cam.x, dz = routeXZ[i].y - cam.z;
                local[i] = new Vector2((dx * cos - dz * sin) * k, (dx * sin + dz * cos) * k);
            }
            dialMesh.Clear();
            EmitRoute(dialMesh, 0f, 0f, DialInner, 4f, HudTokens.Halo);
            EmitRoute(dialMesh, 0f, 0f, DialInner, 2f, RouteColor);
            float limit = (DialInner - 8f) * (DialInner - 8f);
            for (int i = 0; i < wpCount; i++)
            {
                if (wpKind[i] != WaypointKind.Station) continue;
                float dx = wpXZ[i].x - cam.x, dz = wpXZ[i].y - cam.z;
                Vector2 p = new Vector2((dx * cos - dz * sin) * k, (dx * sin + dz * cos) * k);
                if (p.sqrMagnitude > limit) continue;
                dialMesh.Ring(p, 4.5f, 3.5f, HudTokens.Halo, 16);   // ring = station (the dial's diamond is HOME, its squares are rocks)
                dialMesh.Ring(p, 4.5f, 1.5f, RouteColor, 16);
            }
            dialMesh.Commit();
        }

        // ------------------------------------------------------------------------------------------------ shared

        /// <summary>
        /// Strokes the transformed route (<see cref="local"/>) as runs of consecutive visible segments and returns how
        /// many segments it drew. radius > 0: the segments are cut at the circle of that radius about the origin (the
        /// dial window, which no mask clips). Otherwise they are only culled against the box of half size hw x hh: the
        /// map's RectMask2D does the exact clipping.
        /// </summary>
        int EmitRoute(HudLineMesh mesh, float hw, float hh, float radius, float width, Color32 color)
        {
            int len = 0, drawn = 0;
            float r2 = radius * radius;
            for (int i = 1; i < ptCount; i++)
            {
                Vector2 a = local[i - 1], b = local[i];
                bool visible = !runStart[i], cutA = false, cutB = false;
                if (visible && radius > 0f)
                {
                    // |a + t d|^2 = r^2 on t in [0, 1]
                    Vector2 d = b - a;
                    float qa = d.sqrMagnitude, qb = Vector2.Dot(a, d), qc = a.sqrMagnitude - r2;
                    float disc = qb * qb - qa * qc;
                    visible = qa > 1e-8f && disc > 0f;
                    if (visible)
                    {
                        float s = Mathf.Sqrt(disc);
                        float t0 = Mathf.Max(0f, (-qb - s) / qa), t1 = Mathf.Min(1f, (-qb + s) / qa);
                        visible = t0 < t1;
                        cutA = t0 > 0f;
                        cutB = t1 < 1f;
                        b = a + d * t1;
                        a = a + d * t0;
                    }
                }
                else if (visible)
                {
                    visible = Mathf.Max(a.x, b.x) >= -hw && Mathf.Min(a.x, b.x) <= hw
                           && Mathf.Max(a.y, b.y) >= -hh && Mathf.Min(a.y, b.y) <= hh;
                }

                if ((!visible || cutA) && len > 0)
                {
                    mesh.Polyline(run, len, width, color);
                    len = 0;
                }
                if (!visible) continue;
                if (len == 0) run[len++] = a;
                run[len++] = b;
                drawn++;
                if (cutB)
                {
                    mesh.Polyline(run, len, width, color);
                    len = 0;
                }
            }
            if (len > 0) mesh.Polyline(run, len, width, color);
            return drawn;
        }

        static void SetActive(Component c, bool on)
        {
            if (c != null && c.gameObject.activeSelf != on) c.gameObject.SetActive(on);
        }

        static Transform FindDeep(Transform root, string name)
        {
            for (int i = 0; i < root.childCount; i++)
            {
                Transform c = root.GetChild(i);
                if (c.name == name) return c;
                Transform hit = FindDeep(c, name);
                if (hit != null) return hit;
            }
            return null;
        }
    }
}

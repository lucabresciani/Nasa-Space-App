using System;
using System.Collections.Generic;
using NasaSpaceApp.Homeline.Sim;
using NasaSpaceApp.HUD;
using NasaSpaceApp.Menu;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace NasaSpaceApp.Homeline.Ui
{
    /// <summary>
    /// North-up map of a generated plan for the mission planning screen: shaded relief of the scene's own terrain
    /// under the route, the planner's route, the rover and the stations with their ids, and the navigation points.
    /// Shapes carry the meaning, not colour alone: square = rover, diamond = station, small dot = navigation point.
    ///
    /// EDITING (when <see cref="Editable"/>): a station is dragged with the mouse. The mark follows the pointer from
    /// the press, keeping the offset of the grab; a hollow mark stays at the old place; the caption reads the way
    /// home from the point under the mark (<see cref="Probe"/>), or says that it is not reachable, in which case the
    /// mark carries a cross. On release over reachable ground <see cref="StationMoved"/> fires and the owner shows
    /// the re-routed plan; otherwise the mark goes back. Ground outside the planner's way-home map is drawn dark.
    /// The view is kept while the same base plan is being edited, so the map does not jump under the pointer.
    /// </summary>
    public sealed class PlanMap
    {
        const int ReliefSize = 176;              // relief texture, pixels per side
        const float Pad = 14f;
        const float MarginFraction = 0.10f, EditMarginFraction = 0.22f;
        const float MinHalfExtentM = 350f;
        const float GrabRadius = 18f;            // map units around a station mark that start a drag

        static readonly Color32 RouteColor = new Color32(255, 189, 56, 255);
        static readonly Color32 StationColor = new Color32(96, 235, 255, 255);
        static readonly Color32 PadColor = new Color32(255, 255, 255, 255);
        static readonly Color32 NavColor = new Color32(255, 189, 56, 255);
        static readonly Color32 InkColor = new Color32(234, 216, 190, 255);
        static readonly Color32 GhostColor = new Color32(96, 235, 255, 110);
        static readonly Color32 InvalidColor = new Color32(255, 120, 96, 255);
        static readonly Color ReliefLow = new Color(0.085f, 0.060f, 0.055f, 1f);
        static readonly Color ReliefHigh = new Color(0.60f, 0.43f, 0.31f, 1f);
        const float UnreachableShade = 0.42f;

        /// <summary>A station was dropped on reachable ground: id, frame x and y (metres).</summary>
        public Action<string, double, double> StationMoved;
        /// <summary>Read-out for a point of the frame ("way home 41 min, 52 L O2"); null = a station cannot stand there.</summary>
        public Func<double, double, string> Probe;
        /// <summary>True when stations of the shown plan may be dragged.</summary>
        public bool Editable;

        readonly RectTransform root;
        readonly RawImage relief;
        readonly HudLineMesh lines;
        readonly List<Text> labels = new List<Text>();
        readonly Text caption;
        readonly Font font;
        readonly float size;
        Texture2D texture;
        Vector2[] buffer = new Vector2[512];

        MissionPlan plan;
        MissionPlan viewBase;
        bool viewEditable;
        double cx, cz, half;
        float scale;

        string dragId;
        Vector2 dragPos, dragFrom, grabOffset;
        bool dragValid;
        string dragReadout;

        public PlanMap(MenuContext ctx, RectTransform parent, Vector2 topLeftPosition, float boxSize)
        {
            var topLeft = new Vector2(0f, 1f);
            size = boxSize - 2f * Pad;
            font = ctx.Assets != null ? ctx.Assets.Mono : null;
            Image box = MenuUi.Pill("PlanMap", parent, ctx, MenuTokens.ScrimPanel, MenuTokens.PanelRadius, topLeft, topLeft,
                                    topLeftPosition, new Vector2(boxSize, boxSize + 40f));
            root = box.rectTransform;

            var center = new Vector2(0.5f, 0.5f);
            var go = new GameObject("Relief", typeof(RectTransform));
            go.transform.SetParent(root, false);
            var rt = (RectTransform)go.transform;
            rt.anchorMin = rt.anchorMax = topLeft;
            rt.pivot = center;
            rt.anchoredPosition = new Vector2(boxSize * 0.5f, -(Pad + size * 0.5f));
            rt.sizeDelta = new Vector2(size, size);
            relief = go.AddComponent<RawImage>();
            relief.raycastTarget = true; // the pointer events of the map
            go.AddComponent<PlanMapInput>().Map = this;

            lines = HudFactory.CreateLineMesh("Lines", root, topLeft, center, rt.anchoredPosition, new Vector2(size, size));
            caption = MenuUi.Paragraph("Caption", root, ctx.Assets != null ? ctx.Assets.Regular : null, MenuTokens.SizeFine, MenuTokens.SandDim,
                                       TextAnchor.UpperLeft, topLeft, topLeft, new Vector2(Pad, -(Pad + size + 6f)), new Vector2(size, 34f), "");
            root.gameObject.SetActive(false);
        }

        public bool Dragging { get { return dragId != null; } }

        public void Hide()
        {
            dragId = null;
            if (root != null) root.gameObject.SetActive(false);
        }

        public void Show(MissionPlan shown)
        {
            if (root == null || shown == null) return;
            root.gameObject.SetActive(true);
            plan = shown;
            dragId = null;

            // Square world window around the route, north up; kept while the same base plan is edited.
            if (!ReferenceEquals(viewBase, plan.BasePlan) || viewEditable != Editable)
            {
                viewBase = plan.BasePlan;
                viewEditable = Editable;
                double minX = double.MaxValue, maxX = double.MinValue, minZ = double.MaxValue, maxZ = double.MinValue;
                foreach (RouteLeg leg in plan.Track.Legs)
                {
                    for (int i = 0; i < leg.X.Length; i++)
                    {
                        double wx, wz;
                        plan.Frame.LocalToWorld(leg.X[i], leg.Y[i], out wx, out wz);
                        if (wx < minX) minX = wx;
                        if (wx > maxX) maxX = wx;
                        if (wz < minZ) minZ = wz;
                        if (wz > maxZ) maxZ = wz;
                    }
                }
                cx = 0.5 * (minX + maxX);
                cz = 0.5 * (minZ + maxZ);
                half = 0.5 * Math.Max(maxX - minX, maxZ - minZ) * (1.0 + 2.0 * (Editable ? EditMarginFraction : MarginFraction));
                if (half < MinHalfExtentM) half = MinHalfExtentM;
                scale = (float)(size * 0.5 / half); // map units per metre
                DrawRelief();
            }
            Redraw();
        }

        void Redraw()
        {
            lines.Clear();
            foreach (RouteLeg leg in plan.Track.Legs)
            {
                int n = leg.X.Length;
                if (buffer.Length < n) buffer = new Vector2[n + 256];
                for (int i = 0; i < n; i++) buffer[i] = ToMap(leg.X[i], leg.Y[i]);
                lines.Polyline(buffer, n, 2.2f, RouteColor);
            }

            int used = 0;
            foreach (Waypoint w in plan.Waypoints.All)
            {
                if (w.Kind == WaypointKind.Return) continue;
                Vector2 p = ToMap(w.X, w.Y);
                if (w.Kind == WaypointKind.Nav)
                {
                    lines.Ring(p, 2.2f, 2.2f, NavColor, 8);
                }
                else if (w.Kind == WaypointKind.Pad)
                {
                    lines.Rect(new Rect(p.x - 6f, p.y - 6f, 12f, 12f), PadColor);
                    Label(used++, "ROVER", p + new Vector2(10f, 0f), PadColor);
                }
                else if (w.Id == dragId)
                {
                    // The old place stays as a hollow mark, joined to the mark under the pointer.
                    Diamond(p, 8f, 1.4f, GhostColor);
                    lines.Line(p, dragPos, 1.4f, GhostColor);
                    Color32 c = dragValid ? PadColor : InvalidColor;
                    Diamond(dragPos, 11f, 2.8f, c);
                    if (!dragValid)
                    {
                        lines.Line(dragPos + new Vector2(-6f, -6f), dragPos + new Vector2(6f, 6f), 2.4f, c);
                        lines.Line(dragPos + new Vector2(-6f, 6f), dragPos + new Vector2(6f, -6f), 2.4f, c);
                    }
                    Label(used++, w.Id, dragPos + new Vector2(15f, 0f), c);
                }
                else
                {
                    Diamond(p, 8f, 2.4f, StationColor);
                    // A filled centre says "this can be picked up".
                    if (Editable) lines.Ring(p, 1.5f, 3f, StationColor, 10);
                    Label(used++, w.Id, p + new Vector2(12f, 0f), StationColor);
                }
            }
            for (int i = used; i < labels.Count; i++) labels[i].gameObject.SetActive(false);

            // North arrow (top-right) and a scale bar (bottom-left) of a round length.
            float h = size * 0.5f;
            Vector2 tip = new Vector2(h - 18f, h - 12f);
            lines.Line(tip + new Vector2(0f, -26f), tip, 2f, InkColor);
            lines.Line(tip, tip + new Vector2(-6f, -9f), 2f, InkColor);
            lines.Line(tip, tip + new Vector2(6f, -9f), 2f, InkColor);
            float barM = half > 1200 ? 500f : (half > 500 ? 250f : 100f);
            Vector2 b0 = new Vector2(-h + 14f, -h + 16f);
            lines.Line(b0, b0 + new Vector2(barM * scale, 0f), 2f, InkColor);
            lines.Line(b0 + new Vector2(0f, -4f), b0 + new Vector2(0f, 4f), 2f, InkColor);
            lines.Line(b0 + new Vector2(barM * scale, -4f), b0 + new Vector2(barM * scale, 4f), 2f, InkColor);
            lines.Commit();

            if (dragId != null)
                caption.text = dragValid
                    ? "Moving " + dragId + ": " + dragReadout + "\nRelease to re-route the plan through this point."
                    : "Moving " + dragId + ": a station cannot stand here (not walkable, or outside the planner's way-home map).\nRelease to put it back.";
            else if (Editable)
                caption.text = "North up · scale bar " + HlJson.F(barM, 0) + " m · square: rover, diamond: station, dot: navigation point\n" +
                               "Drag a station with the mouse to move it. Dark ground is outside the planner's way-home map.";
            else
                caption.text = "North up · scale bar " + HlJson.F(barM, 0) + " m · terrain relief: this simulator\n" +
                               "Square: rover · diamond: station · dot: navigation point";
        }

        void Diamond(Vector2 p, float r, float width, Color32 color)
        {
            Vector2 a = p + new Vector2(0f, r), b = p + new Vector2(r, 0f), c = p + new Vector2(0f, -r), d = p + new Vector2(-r, 0f);
            lines.Line(a, b, width, color);
            lines.Line(b, c, width, color);
            lines.Line(c, d, width, color);
            lines.Line(d, a, width, color);
        }

        // ---------------------------------------------------------------------------------------------- pointer

        internal void PointerDown(PointerEventData e)
        {
            if (!Editable || plan == null || e.button != PointerEventData.InputButton.Left) return;
            Vector2 p;
            if (!ToMapPoint(e, out p)) return;
            Waypoint best = null;
            float bestD = GrabRadius;
            foreach (Waypoint w in plan.Waypoints.Main)
            {
                if (w.Kind != WaypointKind.Station) continue;
                float d = Vector2.Distance(ToMap(w.X, w.Y), p);
                if (d <= bestD)
                {
                    bestD = d;
                    best = w;
                }
            }
            if (best == null) return;
            dragId = best.Id;
            dragFrom = ToMap(best.X, best.Y);
            grabOffset = dragFrom - p; // the mark keeps the place where it was grabbed under the pointer
            MoveDrag(p);
        }

        internal void PointerDrag(PointerEventData e)
        {
            Vector2 p;
            if (dragId == null || !ToMapPoint(e, out p)) return;
            MoveDrag(p);
        }

        internal void PointerUp(PointerEventData e)
        {
            if (dragId == null) return;
            string id = dragId;
            bool moved = dragValid && Vector2.Distance(dragPos, dragFrom) > 2f;
            Vector2 at = dragPos;
            dragId = null;
            if (moved && StationMoved != null)
            {
                double x, y;
                ToFrame(at, out x, out y);
                StationMoved(id, x, y); // the owner calls Show with the re-routed plan
            }
            if (dragId == null && plan != null) Redraw();
        }

        void MoveDrag(Vector2 pointer)
        {
            float h = size * 0.5f - 6f;
            dragPos = pointer + grabOffset;
            dragPos.x = Mathf.Clamp(dragPos.x, -h, h);
            dragPos.y = Mathf.Clamp(dragPos.y, -h, h);
            double x, y;
            ToFrame(dragPos, out x, out y);
            dragReadout = Probe != null ? Probe(x, y) : "";
            dragValid = dragReadout != null;
            Redraw();
        }

        bool ToMapPoint(PointerEventData e, out Vector2 p)
        {
            return RectTransformUtility.ScreenPointToLocalPointInRectangle(lines.rectTransform, e.position, e.pressEventCamera, out p);
        }

        // ---------------------------------------------------------------------------------------------- geometry

        Vector2 ToMap(double localX, double localY)
        {
            double wx, wz;
            plan.Frame.LocalToWorld(localX, localY, out wx, out wz);
            return new Vector2((float)(wx - cx) * scale, (float)(wz - cz) * scale);
        }

        void ToFrame(Vector2 mapPos, out double x, out double y)
        {
            plan.Frame.WorldToLocal(cx + mapPos.x / scale, cz + mapPos.y / scale, out x, out y);
        }

        void Label(int index, string text, Vector2 mapPos, Color32 color)
        {
            while (labels.Count <= index)
            {
                var center = new Vector2(0.5f, 0.5f);
                Text t = MenuUi.Label("Label" + labels.Count, lines.rectTransform, font, MenuTokens.SizeHint, MenuTokens.Sand,
                                      TextAnchor.MiddleLeft, center, new Vector2(0f, 0.5f), Vector2.zero, new Vector2(80f, 18f), "");
                // Dark edge: a label often sits on the route line or on bright relief.
                Outline edge = t.gameObject.AddComponent<Outline>();
                edge.effectColor = new Color(0f, 0f, 0f, 0.85f);
                edge.effectDistance = new Vector2(1.2f, -1.2f);
                labels.Add(t);
            }
            Text label = labels[index];
            label.gameObject.SetActive(true);
            label.text = text;
            label.color = color;
            // Keep the text inside the map square: near the right edge it goes to the left of its mark.
            float h = size * 0.5f;
            bool flip = mapPos.x + 9f * text.Length + 4f > h; // about 9 units per character at this size
            label.alignment = flip ? TextAnchor.MiddleRight : TextAnchor.MiddleLeft;
            label.rectTransform.pivot = new Vector2(flip ? 1f : 0f, 0.5f);
            if (flip) mapPos.x -= 24f;
            label.rectTransform.anchoredPosition = mapPos;
        }

        /// <summary>
        /// Shaded relief of the scene's terrain (light from the north-west), as a small texture. On a plan with the
        /// planner's way-home map, ground outside that map (not reachable, or not assessed) is drawn dark.
        /// </summary>
        void DrawRelief()
        {
            var ground = new GroundSampler();
            int n = ReliefSize;
            var heights = new float[(n + 1) * (n + 1)];
            double step = 2.0 * half / n;
            for (int j = 0; j <= n; j++)
            {
                for (int i = 0; i <= n; i++)
                {
                    float y;
                    bool detailed;
                    ground.TryHeight((float)(cx - half + i * step), (float)(cz - half + j * step), out y, out detailed);
                    heights[j * (n + 1) + i] = y;
                }
            }
            bool mask = plan.HasReturnFields;
            var pixels = new Color32[n * n];
            float k = 2.2f / (float)step;
            for (int j = 0; j < n; j++)
            {
                for (int i = 0; i < n; i++)
                {
                    float dzdx = heights[j * (n + 1) + i + 1] - heights[j * (n + 1) + i];
                    float dzdy = heights[(j + 1) * (n + 1) + i] - heights[j * (n + 1) + i];
                    // Lit from the north-west: slopes facing north-west are bright.
                    float shade = Mathf.Clamp01(0.42f + k * (-dzdx + dzdy) * 0.35f);
                    Color c = Color.Lerp(ReliefLow, ReliefHigh, shade);
                    if (mask)
                    {
                        double x, y;
                        plan.Frame.WorldToLocal(cx - half + (i + 0.5) * step, cz - half + (j + 0.5) * step, out x, out y);
                        if (!plan.THomeAt(x, y).HasValue) c = new Color(c.r * UnreachableShade, c.g * UnreachableShade, c.b * UnreachableShade, 1f);
                    }
                    pixels[j * n + i] = c;
                }
            }
            if (texture == null)
            {
                texture = new Texture2D(n, n, TextureFormat.RGBA32, false);
                texture.wrapMode = TextureWrapMode.Clamp;
                texture.filterMode = FilterMode.Bilinear;
                texture.name = "HOMELINE plan map relief";
                relief.texture = texture;
            }
            texture.SetPixels32(pixels);
            texture.Apply(false);
        }
    }

    /// <summary>Forwards the pointer events of the map square to its <see cref="PlanMap"/>.</summary>
    sealed class PlanMapInput : MonoBehaviour, IPointerDownHandler, IDragHandler, IPointerUpHandler
    {
        public PlanMap Map;

        public void OnPointerDown(PointerEventData e)
        {
            if (Map != null) Map.PointerDown(e);
        }

        public void OnDrag(PointerEventData e)
        {
            if (Map != null) Map.PointerDrag(e);
        }

        public void OnPointerUp(PointerEventData e)
        {
            if (Map != null) Map.PointerUp(e);
        }
    }
}

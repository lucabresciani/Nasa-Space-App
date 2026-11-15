using System.Collections.Generic;
using NasaSpaceApp.Homeline.Sim;
using NasaSpaceApp.HUD;
using NasaSpaceApp.Menu;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Homeline.Ui
{
    /// <summary>
    /// North-up map of a generated plan for the mission planning screen: shaded relief of the scene's own terrain
    /// under the route, the planner's route, the rover and the stations with their ids, and the navigation points.
    /// Shapes carry the meaning, not colour alone: square = rover, diamond = station, small dot = navigation point.
    /// Built once; <see cref="Show"/> redraws it for a plan.
    /// </summary>
    public sealed class PlanMap
    {
        const int ReliefSize = 176;              // relief texture, pixels per side
        const float Pad = 14f;
        const float MarginFraction = 0.10f;
        const float MinHalfExtentM = 350f;

        static readonly Color32 RouteColor = new Color32(255, 189, 56, 255);
        static readonly Color32 StationColor = new Color32(96, 235, 255, 255);
        static readonly Color32 PadColor = new Color32(255, 255, 255, 255);
        static readonly Color32 NavColor = new Color32(255, 189, 56, 255);
        static readonly Color32 InkColor = new Color32(234, 216, 190, 255);
        static readonly Color ReliefLow = new Color(0.085f, 0.060f, 0.055f, 1f);
        static readonly Color ReliefHigh = new Color(0.60f, 0.43f, 0.31f, 1f);

        readonly RectTransform root;
        readonly RawImage relief;
        readonly HudLineMesh lines;
        readonly List<Text> labels = new List<Text>();
        readonly Text caption;
        readonly Font font;
        readonly float size;
        Texture2D texture;
        Vector2[] buffer = new Vector2[512];

        public PlanMap(MenuContext ctx, RectTransform parent, Vector2 topLeftPosition, float boxSize)
        {
            var topLeft = new Vector2(0f, 1f);
            size = boxSize - 2f * Pad;
            font = ctx.Assets != null ? ctx.Assets.Mono : null;
            Image box = MenuUi.Pill("PlanMap", parent, ctx, MenuTokens.ScrimPanel, MenuTokens.PanelRadius, topLeft, topLeft,
                                    topLeftPosition, new Vector2(boxSize, boxSize + 30f));
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
            relief.raycastTarget = false;

            lines = HudFactory.CreateLineMesh("Lines", root, topLeft, center, rt.anchoredPosition, new Vector2(size, size));
            caption = MenuUi.Label("Caption", root, ctx.Assets != null ? ctx.Assets.Regular : null, MenuTokens.SizeFine, MenuTokens.SandDim,
                                   TextAnchor.MiddleLeft, topLeft, topLeft, new Vector2(Pad, -(Pad + size + 6f)), new Vector2(size, 20f), "");
            root.gameObject.SetActive(false);
        }

        public void Hide()
        {
            if (root != null) root.gameObject.SetActive(false);
        }

        public void Show(MissionPlan plan)
        {
            if (root == null || plan == null) return;
            root.gameObject.SetActive(true);

            // Square world window around the route, north up.
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
            double cx = 0.5 * (minX + maxX), cz = 0.5 * (minZ + maxZ);
            double half = 0.5 * System.Math.Max(maxX - minX, maxZ - minZ) * (1.0 + 2.0 * MarginFraction);
            if (half < MinHalfExtentM) half = MinHalfExtentM;
            float scale = (float)(size * 0.5 / half); // map units per metre

            DrawRelief(cx, cz, half);

            lines.Clear();
            foreach (RouteLeg leg in plan.Track.Legs)
            {
                int n = leg.X.Length;
                if (buffer.Length < n) buffer = new Vector2[n + 256];
                for (int i = 0; i < n; i++) buffer[i] = ToMap(plan, leg.X[i], leg.Y[i], cx, cz, scale);
                lines.Polyline(buffer, n, 2.2f, RouteColor);
            }

            int used = 0;
            foreach (Waypoint w in plan.Waypoints.All)
            {
                if (w.Kind == WaypointKind.Return) continue;
                Vector2 p = ToMap(plan, w.X, w.Y, cx, cz, scale);
                if (w.Kind == WaypointKind.Nav)
                {
                    lines.Ring(p, 2.2f, 2.2f, NavColor, 8);
                }
                else if (w.Kind == WaypointKind.Pad)
                {
                    lines.Rect(new Rect(p.x - 6f, p.y - 6f, 12f, 12f), PadColor);
                    Label(used++, "ROVER", p + new Vector2(10f, 0f), PadColor);
                }
                else
                {
                    // Diamond: four strokes around the station's access point.
                    const float r = 8f;
                    Vector2 a = p + new Vector2(0f, r), b = p + new Vector2(r, 0f), c = p + new Vector2(0f, -r), d = p + new Vector2(-r, 0f);
                    lines.Line(a, b, 2.4f, StationColor);
                    lines.Line(b, c, 2.4f, StationColor);
                    lines.Line(c, d, 2.4f, StationColor);
                    lines.Line(d, a, 2.4f, StationColor);
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

            caption.text = "N up · bar " + HlJson.F(barM, 0) + " m · square rover, diamond station, dot navigation point · terrain: this simulator";
        }

        Vector2 ToMap(MissionPlan plan, double localX, double localY, double cx, double cz, float scale)
        {
            double wx, wz;
            plan.Frame.LocalToWorld(localX, localY, out wx, out wz);
            return new Vector2((float)(wx - cx) * scale, (float)(wz - cz) * scale);
        }

        void Label(int index, string text, Vector2 mapPos, Color32 color)
        {
            while (labels.Count <= index)
            {
                var center = new Vector2(0.5f, 0.5f);
                Text t = MenuUi.Label("Label" + labels.Count, lines.rectTransform, font, MenuTokens.SizeHint, MenuTokens.Sand,
                                      TextAnchor.MiddleLeft, center, new Vector2(0f, 0.5f), Vector2.zero, new Vector2(80f, 18f), "");
                labels.Add(t);
            }
            Text label = labels[index];
            label.gameObject.SetActive(true);
            label.text = text;
            label.color = color;
            // Keep the text inside the map square: near the right edge it goes to the left of its mark.
            float h = size * 0.5f;
            bool flip = mapPos.x > h - 64f;
            label.alignment = flip ? TextAnchor.MiddleRight : TextAnchor.MiddleLeft;
            label.rectTransform.pivot = new Vector2(flip ? 1f : 0f, 0.5f);
            if (flip) mapPos.x -= 24f;
            label.rectTransform.anchoredPosition = mapPos;
        }

        /// <summary>Shaded relief of the scene's terrain (light from the north-west), as a small texture.</summary>
        void DrawRelief(double cx, double cz, double half)
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
                    pixels[j * n + i] = Color.Lerp(ReliefLow, ReliefHigh, shade);
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
}

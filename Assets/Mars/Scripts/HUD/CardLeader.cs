using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Leader polyline (anchor -> elbow -> landing, 2 px over a 4 px halo), anchor dot, and the off-screen edge locator
    /// (chevron + ID + distance) of one rock card (spec §5.4). Pooled; driven per frame by <see cref="RockCardSystem"/>.
    /// The path is an anti-aliased, mitered <see cref="HudLineMesh"/> stroke (rotated Image quads were jagged on the
    /// diagonal). Writes to uGUI only when a value changes.
    /// </summary>
    public sealed class CardLeader
    {
        private const float LocatorInset = 40f;    // locator clamp inset (edge detection)
        private const float LabelInward = 26f;     // label distance from the locator, toward the screen center
        private const float LabelGap = 8f;
        private const float LabelMargin = 8f;
        private const float ArrowSize = 18f, ArrowHaloSize = 22f;
        private const float LabelBoxHeight = 18f;

        private enum Mode { Hidden, OnScreen, OffScreen }

        private readonly HudContext ctx;
        private readonly HudLineMesh pathHalo, pathStroke;
        private readonly Vector2[] pathPoints = new Vector2[3];
        private Color32 strokeColor, haloColor;
        private Vector2 shownA, shownE, shownL;
        private float shownDraw = -1f;
        private bool pathDirty = true;
        private readonly Image dot, dotHalo;
        private readonly Image arrow, arrowHalo;
        private readonly Text idLabel, distanceLabel;
        private readonly bool hasArrow;
        private readonly int advance;

        private Mode mode = Mode.OnScreen;   // forces the first Hide() to disable everything
        private bool shownFocused;
        private float shownAlpha = -1f;
        private float shownAngle = float.NaN;
        private string shownId, shownDistance;

        /// <summary>Builds the pooled graphics in LeaderLayer (path, dot) and LocatorLayer (chevron, labels).</summary>
        public CardLeader(HudContext ctx, int index)
        {
            this.ctx = ctx;
            HudSkin skin = ctx.Skin;
            Sprite disc = skin != null ? skin.discSolid : null;
            Sprite chevron = skin != null ? skin.offscreenArrow : null;
            Font regular = skin != null ? skin.Regular : null;
            Font medium = skin != null ? skin.Medium : null;
            Vector2 center = new Vector2(0.5f, 0.5f);

            RectTransform group = HudFactory.CreateStretch("Leader" + index, ctx.LeaderLayer);
            // Draw order: halo path, dot halo, stroke path, dot. Path meshes have their origin at the canvas bottom-left,
            // so they draw directly in canvas coordinates.
            pathHalo = HudFactory.CreateLineMesh("PathHalo", group, Vector2.zero, Vector2.zero, Vector2.zero, Vector2.zero);
            dotHalo = HudFactory.CreateImage("DotHalo", group, disc, HudTokens.Halo, Vector2.zero, center, Vector2.zero,
                                             new Vector2(HudTokens.AnchorDotHalo, HudTokens.AnchorDotHalo));
            pathStroke = HudFactory.CreateLineMesh("Path", group, Vector2.zero, Vector2.zero, Vector2.zero, Vector2.zero);
            dot = HudFactory.CreateImage("Dot", group, disc, HudTokens.StrokeMark, Vector2.zero, center, Vector2.zero,
                                         new Vector2(HudTokens.AnchorDot, HudTokens.AnchorDot));

            RectTransform locator = HudFactory.CreateStretch("Locator" + index, ctx.LocatorLayer);
            arrowHalo = HudFactory.CreateIcon("ArrowHalo", locator, chevron, HudTokens.Halo, ArrowHaloSize, Vector2.zero, center, Vector2.zero);
            arrow = HudFactory.CreateIcon("Arrow", locator, chevron, HudTokens.StrokeMark, ArrowSize, Vector2.zero, center, Vector2.zero);
            hasArrow = chevron != null;

            Vector2 left = new Vector2(0f, 0.5f);
            idLabel = HudFactory.CreateText("Id", locator, medium, HudTokens.SizeMicro, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                            Vector2.zero, left, Vector2.zero, new Vector2(120f, LabelBoxHeight));
            distanceLabel = HudFactory.CreateText("Distance", locator, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                                  Vector2.zero, left, Vector2.zero, new Vector2(80f, LabelBoxHeight));
            HudFactory.AddHalo(idLabel);
            HudFactory.AddHalo(distanceLabel);
            advance = HudTokens.Advance(HudTokens.SizeMicro);

            Hide();
        }

        /// <summary>Anchor on screen: dot at the anchor, path anchor -> elbow -> landing revealed to <paramref name="draw01"/>.</summary>
        public void SetOnScreen(Vector2 anchor, Vector2 elbow, Vector2 landing, bool focused, float draw01, float alpha)
        {
            SetMode(Mode.OnScreen);
            ApplyColors(focused, alpha);
            LayoutPath(anchor, elbow, landing, draw01);
            SetPosition(dot.rectTransform, anchor);
            SetPosition(dotHalo.rectTransform, anchor);
        }

        /// <summary>
        /// Anchor off screen or behind: chevron at <paramref name="locator"/> rotated to <paramref name="angleDeg"/>, ID and
        /// distance placed inward, path locator -> elbow -> landing.
        /// </summary>
        public void SetOffScreen(Vector2 locator, float angleDeg, Vector2 elbow, Vector2 landing, string id, string distance,
                                 bool focused, float draw01, float alpha)
        {
            SetMode(Mode.OffScreen);
            ApplyColors(focused, alpha);
            LayoutPath(locator, elbow, landing, draw01);

            SetPosition(arrow.rectTransform, locator);
            SetPosition(arrowHalo.rectTransform, locator);
            if (angleDeg != shownAngle)
            {
                shownAngle = angleDeg;
                Quaternion rot = Quaternion.Euler(0f, 0f, angleDeg);
                arrow.rectTransform.localRotation = rot;
                arrowHalo.rectTransform.localRotation = rot;
            }

            if (!ReferenceEquals(id, shownId))
            {
                shownId = id;
                idLabel.text = id;
            }
            if (!ReferenceEquals(distance, shownDistance))
            {
                shownDistance = distance;
                distanceLabel.text = distance;
            }
            LayoutLabels(locator);
        }

        /// <summary>Hides every graphic of this leader and locator.</summary>
        public void Hide()
        {
            SetMode(Mode.Hidden);
        }

        // ---- internals

        private void SetMode(Mode next)
        {
            if (next == mode)
            {
                return;
            }
            mode = next;
            bool path = next != Mode.Hidden;
            bool on = next == Mode.OnScreen;
            bool off = next == Mode.OffScreen;
            pathHalo.enabled = path;
            pathStroke.enabled = path;
            dot.enabled = on;
            dotHalo.enabled = on;
            arrow.enabled = off && hasArrow;
            arrowHalo.enabled = off && hasArrow;
            idLabel.enabled = off;
            distanceLabel.enabled = off;
        }

        private void ApplyColors(bool focused, float alpha)
        {
            alpha = Mathf.Clamp01(alpha);
            if (focused == shownFocused && alpha == shownAlpha)
            {
                return;
            }
            shownFocused = focused;
            shownAlpha = alpha;
            Color stroke = HudTokens.Alpha(focused ? HudTokens.Accent : HudTokens.StrokeMark, alpha);
            Color halo = HudTokens.Alpha(HudTokens.Halo, alpha);
            strokeColor = stroke;
            haloColor = halo;
            pathDirty = true;
            dot.color = stroke;
            dotHalo.color = halo;
            arrow.color = stroke;
            arrowHalo.color = halo;
            idLabel.color = HudTokens.Alpha(HudTokens.InkPrimary, alpha);
            distanceLabel.color = HudTokens.Alpha(HudTokens.InkSecondary, alpha);
        }

        // Reveals the polyline by length from its start; mitered at the elbow. Rebuilt only when geometry or color changed.
        private void LayoutPath(Vector2 a, Vector2 e, Vector2 l, float draw01)
        {
            if (!pathDirty && a == shownA && e == shownE && l == shownL && draw01 == shownDraw)
            {
                return;
            }
            pathDirty = false;
            shownA = a;
            shownE = e;
            shownL = l;
            shownDraw = draw01;

            float len1 = Vector2.Distance(a, e);
            float len2 = Vector2.Distance(e, l);
            float reveal = Mathf.Clamp01(draw01) * (len1 + len2);

            float r1 = Mathf.Min(reveal, len1);
            Vector2 end1 = len1 > 1e-4f ? a + (e - a) * (r1 / len1) : a;
            float r2 = Mathf.Clamp(reveal - len1, 0f, len2);
            Vector2 end2 = len2 > 1e-4f ? e + (l - e) * (r2 / len2) : e;

            pathHalo.Clear();
            pathStroke.Clear();
            if (reveal >= 0.5f)
            {
                int n = 0;
                pathPoints[n++] = a;
                if (r1 > 1e-3f)
                {
                    pathPoints[n++] = end1;
                }
                if (r2 > 1e-3f)
                {
                    pathPoints[n++] = end2;
                }
                if (n >= 2)
                {
                    pathHalo.Polyline(pathPoints, n, HudTokens.LeaderHaloWidth, haloColor);
                    pathStroke.Polyline(pathPoints, n, HudTokens.LeaderWidth, strokeColor);
                }
            }
            pathHalo.Commit();
            pathStroke.Commit();
        }

        // Left edge: label right of the chevron; right edge: left of it; top/bottom: centered, inward.
        private void LayoutLabels(Vector2 locator)
        {
            Vector2 size = ctx.CanvasSize;
            int idLen = shownId != null ? shownId.Length : 0;
            int distLen = shownDistance != null ? shownDistance.Length : 0;
            float idW = advance * idLen;
            float total = idW + LabelGap + advance * distLen;

            float startX, y;
            if (locator.x <= LocatorInset + 0.5f)
            {
                startX = locator.x + LabelInward;
                y = locator.y;
            }
            else if (locator.x >= size.x - LocatorInset - 0.5f)
            {
                startX = locator.x - LabelInward - total;
                y = locator.y;
            }
            else
            {
                startX = locator.x - total * 0.5f;
                y = locator.y >= size.y * 0.5f ? locator.y - LabelInward : locator.y + LabelInward;
            }
            startX = Mathf.Clamp(startX, LabelMargin, Mathf.Max(LabelMargin, size.x - total - LabelMargin));

            SetPosition(idLabel.rectTransform, new Vector2(startX, y));
            SetPosition(distanceLabel.rectTransform, new Vector2(startX + idW + LabelGap, y));
        }

        private static void SetPosition(RectTransform rt, Vector2 p)
        {
            if (rt.anchoredPosition != p)
            {
                rt.anchoredPosition = p;
            }
        }
    }
}

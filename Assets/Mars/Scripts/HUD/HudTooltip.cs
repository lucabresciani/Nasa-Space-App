using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Hover tooltip for the vitals and suit-status icons (cursor free only): up to three lines (name and value, limits,
    /// trend or time remaining). Sits above the hovered element, right-aligned to it and kept inside the screen margins.
    /// Appears after <see cref="HudTokens.TooltipDelay"/> with a short fade, or at once when another tooltip closed less
    /// than <see cref="HudTokens.TooltipInstantWindow"/> ago. <see cref="Refresh"/> updates the text of the open tooltip
    /// without restarting it (live values). Never a raycast target.
    /// </summary>
    public sealed class HudTooltip
    {
        private const float Width = 360f;
        private const float PadX = 14f, PadTop = 10f, LineH = 20f, PadBottom = 8f;
        private const float Gap = 8f;           // above the hovered rect
        private const int MaxLines = 3;

        private enum Phase { Hidden, Waiting, Fading, Shown }

        private readonly HudContext ctx;
        private readonly RectTransform layer;
        private readonly RectTransform panel;
        private readonly CanvasGroup group;
        private readonly Text[] lines = new Text[MaxLines];
        private readonly int maxChars;
        private readonly Vector3[] corners = new Vector3[4];

        private RectTransform target;
        private Phase phase;
        private float phaseTime;
        private float now;
        private float lastCloseTime = float.NegativeInfinity;
        private int lineCount = -1;

        public HudTooltip(HudContext ctx)
        {
            this.ctx = ctx;
            HudSkin skin = ctx.Skin != null ? ctx.Skin : HudSkin.Load();
            layer = ctx.TooltipLayer != null ? ctx.TooltipLayer : ctx.CanvasRect;

            // Placed in layer coordinates from its bottom-left corner (pivot bottom-right of the panel).
            Vector2 origin = Vector2.zero;
            Image bg = HudFactory.CreatePanel("Tooltip", layer, skin, HudTokens.Scrim, HudTokens.RadiusSmall,
                                              origin, new Vector2(1f, 0f), Vector2.zero, new Vector2(Width, Height(2)));
            panel = bg.rectTransform;
            group = HudFactory.AddGroup(bg.gameObject, 0f, false);
            group.interactable = false;

            Vector2 topLeft = new Vector2(0f, 1f);
            Vector2 midLeft = new Vector2(0f, 0.5f);
            float boxW = Width - 2f * PadX;
            for (int i = 0; i < MaxLines; i++)
            {
                bool first = i == 0;
                lines[i] = HudFactory.CreateText("Line" + (i + 1), panel, first ? skin.Medium : skin.Regular,
                                                 first ? HudTokens.SizeMicro : HudTokens.SizeFoot,
                                                 first ? HudTokens.InkPrimary : HudTokens.InkSecondary,
                                                 TextAnchor.MiddleLeft, topLeft, midLeft,
                                                 new Vector2(PadX, -(PadTop + LineH * (i + 0.5f))), new Vector2(boxW, LineH));
            }
            maxChars = Mathf.FloorToInt(boxW / HudTokens.Advance(HudTokens.SizeMicro));
        }

        /// <summary>Two-line form of <see cref="Show(RectTransform, string, string, string)"/>.</summary>
        public void Show(RectTransform target, string line1, string line2)
        {
            Show(target, line1, line2, null);
        }

        /// <summary>
        /// Shows the lines above <paramref name="target"/> (a null or empty third line hides it). Event-time only (may
        /// allocate).
        /// </summary>
        public void Show(RectTransform target, string line1, string line2, string line3)
        {
            if (target == null)
            {
                return;
            }

            bool visible = phase == Phase.Fading || phase == Phase.Shown;
            bool instant = visible || now - lastCloseTime < HudTokens.TooltipInstantWindow;
            this.target = target;
            SetLines(line1, line2, line3);
            Place(target);

            if (instant)
            {
                SetPhase(Phase.Shown);
                group.alpha = 1f;
            }
            else
            {
                SetPhase(Phase.Waiting);
                group.alpha = 0f;
            }
        }

        /// <summary>Updates the text while <paramref name="target"/> is the open tooltip's target; otherwise ignored.</summary>
        public void Refresh(RectTransform target, string line1, string line2, string line3)
        {
            if (target == null || target != this.target || phase == Phase.Hidden)
            {
                return;
            }
            SetLines(line1, line2, line3);
            Place(target);
        }

        /// <summary>True while <paramref name="target"/> owns the tooltip (waiting, fading in or shown).</summary>
        public bool IsShowing(RectTransform target)
        {
            return target != null && target == this.target && phase != Phase.Hidden;
        }

        /// <summary>Hides the tooltip if <paramref name="target"/> is the one showing; otherwise ignored.</summary>
        public void Hide(RectTransform target)
        {
            if (target == null || target != this.target)
            {
                return;
            }
            Close();
        }

        /// <summary>Runs the delay and fade (unscaled <paramref name="dt"/>); hides when the cursor relocks.</summary>
        public void Tick(float dt)
        {
            now += dt;
            if (phase == Phase.Hidden)
            {
                return;
            }
            if (target == null || !ctx.CursorFree || !target.gameObject.activeInHierarchy)
            {
                Close();   // cursor relocked, or the target was disabled or destroyed
                return;
            }

            phaseTime += dt;
            if (phase == Phase.Waiting && phaseTime >= HudTokens.TooltipDelay)
            {
                SetPhase(Phase.Fading);
            }
            if (phase == Phase.Fading)
            {
                float dur = HudTokens.Dur(HudTokens.DurTooltip);
                float t = dur > 0f ? phaseTime / dur : 1f;
                group.alpha = HudTokens.EaseOut(t);
                if (t >= 1f)
                {
                    SetPhase(Phase.Shown);
                }
            }
        }

        private void SetLines(string line1, string line2, string line3)
        {
            Assign(lines[0], HudStrings.Truncate(line1, maxChars));
            Assign(lines[1], HudStrings.Truncate(line2, maxChars));
            bool third = !string.IsNullOrEmpty(line3);
            Assign(lines[2], third ? HudStrings.Truncate(line3, maxChars) : string.Empty);
            int count = third ? 3 : 2;
            if (count != lineCount)
            {
                lineCount = count;
                lines[2].enabled = third;
                panel.sizeDelta = new Vector2(Width, Height(count));
            }
        }

        private static void Assign(Text text, string value)
        {
            if (text.text != value)
            {
                text.text = value;
            }
        }

        private static float Height(int count)
        {
            return PadTop + LineH * count + PadBottom;
        }

        private void Close()
        {
            if (phase == Phase.Fading || phase == Phase.Shown)
            {
                lastCloseTime = now;
            }
            target = null;
            SetPhase(Phase.Hidden);
            group.alpha = 0f;
        }

        private void SetPhase(Phase p)
        {
            phase = p;
            phaseTime = 0f;
        }

        // Bottom edge = hovered rect top + Gap; right edge = hovered rect right, kept inside the screen margins (layer
        // coordinates from its bottom-left, works for any canvas scale).
        private void Place(RectTransform t)
        {
            t.GetWorldCorners(corners);
            Vector3 topLeft = layer.InverseTransformPoint(corners[1]);
            Vector3 topRight = layer.InverseTransformPoint(corners[2]);
            Rect r = layer.rect;
            float h = panel.sizeDelta.y;
            float margin = HudTokens.ScreenMargin;

            float right = Mathf.Clamp(topRight.x - r.xMin, Width + margin, r.width - margin);
            float bottom = topLeft.y - r.yMin + Gap;
            bottom = Mathf.Clamp(bottom, margin, r.height - h - margin);
            panel.anchoredPosition = new Vector2(right, bottom);
        }
    }
}

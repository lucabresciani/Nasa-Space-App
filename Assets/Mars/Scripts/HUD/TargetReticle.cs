using System;
using NasaSpaceApp.Science;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Center reticle: dot, scan-hold ring, corner brackets fitted to the targeted rock with an ID/distance micro label
    /// and an "E Scan" hint, plus the lock cue on a scan. Hidden while <see cref="Visible"/> is false (debug overlay on)
    /// or the camera is missing. Brackets, dot and hold ring are anti-aliased <see cref="HudLineMesh"/> strokes (the v1
    /// sliced/filled sprites were drawn at a fractional 1.4 px stroke and heavily down-scaled, which read as blurry).
    /// </summary>
    public sealed class TargetReticle : IDisposable
    {
        private const float FallbackBox = 120f, MinBox = 36f, MaxBox = 260f;
        private const float RingSize = 30f, Dot = 4f, DotHalo = 7f;
        private const float RingWidth = 2f;
        private const float BracketArm = 14f, BracketStroke = 1.5f, BracketHaloStroke = 3.5f;
        private const float RestAlpha = 0.6f;                      // brackets without an open card
        private const float LabelOffsetX = 6f, LabelOffsetY = 4f;  // outside the top-right corner
        private const float HintGap = 8f, KeycapSize = 18f;
        private const float LineHeight = 18f;
        private const string ScanLabel = "Scan", RescanLabel = "Rescan";

        private readonly HudContext ctx;
        private readonly RockScanner scanner;
        private readonly CanvasGroup rootGroup;
        private readonly CanvasGroup targetGroup;
        private readonly HudLineMesh ring;
        private readonly RectTransform bracketRoot;
        private readonly HudLineMesh brackets;
        private readonly Vector2[] corner = new Vector2[3];
        private Color32 bracketColor;
        private Vector2 bracketSize = new Vector2(-1f, -1f);
        private readonly RectTransform label;
        private readonly Text idText;
        private readonly RectTransform distRect;
        private readonly Text distText;
        private readonly RectTransform hint;
        private readonly Text hintText;
        private readonly int microAdvance;

        private bool visible = true;
        private bool rootShown = true;
        private bool targetShown = true;
        private bool ringShown = true;
        private float ringFill = -1f;
        private RockSample target;
        private Renderer targetRenderer;
        private string distString;
        private int scannedState = -1;   // -1 unknown, 0 not scanned, 1 scanned
        private float lockTime = -1f;    // < 0: no lock cue running
        private float bracketScale = -1f;
        private Vector2 lastCenter = new Vector2(float.NaN, float.NaN);
        private Vector2 lastSize = new Vector2(float.NaN, float.NaN);

        /// <summary>Builds the reticle in <see cref="HudContext.ReticleLayer"/> and subscribes to scans (lock cue).</summary>
        public TargetReticle(HudContext ctx)
        {
            this.ctx = ctx;
            scanner = ctx.Scanner;
            HudSkin skin = ctx.Skin;
            Vector2 zero = Vector2.zero;
            Vector2 center = new Vector2(0.5f, 0.5f);
            microAdvance = HudTokens.Advance(HudTokens.SizeMicro);

            RectTransform root = HudFactory.CreateStretch("TargetReticle", ctx.ReticleLayer);
            rootGroup = HudFactory.AddGroup(root.gameObject, 1f, false);

            // Target group (brackets, label, hint) in canvas coordinates (anchor (0,0)).
            RectTransform targetRoot = HudFactory.CreateStretch("Target", root);
            targetGroup = HudFactory.AddGroup(targetRoot.gameObject, 1f, false);

            bracketRoot = HudFactory.CreateRect("Brackets", targetRoot, zero, center, zero, new Vector2(FallbackBox, FallbackBox));
            // Origin at the box center (pivot 0.5): corners are drawn at +-size/2.
            brackets = HudFactory.CreateLineMesh("Corners", bracketRoot, center, center, zero, zero);
            bracketColor = HudTokens.Alpha(HudTokens.StrokeMark, RestAlpha);

            label = HudFactory.CreateRect("Label", targetRoot, zero, zero, zero, new Vector2(160f, LineHeight));
            idText = HudFactory.CreateText("Id", label, skin.Medium, HudTokens.SizeMicro, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                           zero, zero, zero, new Vector2(96f, LineHeight));
            HudFactory.AddHalo(idText);
            distText = HudFactory.CreateText("Distance", label, skin.Regular, HudTokens.SizeMicro, HudTokens.InkSecondary,
                                             TextAnchor.MiddleLeft, zero, zero, zero, new Vector2(64f, LineHeight));
            HudFactory.AddHalo(distText);
            distRect = distText.rectTransform;

            hint = HudFactory.CreateRect("Hint", targetRoot, zero, new Vector2(0.5f, 1f), zero, new Vector2(64f, KeycapSize));
            Vector2 left = new Vector2(0f, 0.5f);
            HudFactory.CreateKeycap("Key", hint, skin, skin.Medium, "E", left, left, zero);
            hintText = HudFactory.CreateText("Action", hint, skin.Medium, HudTokens.SizeMicro, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                             left, left, new Vector2(KeycapSize + HudTokens.S2, 0f), new Vector2(64f, LineHeight));
            HudFactory.AddHalo(hintText);

            // Center dot over its halo: filled discs (ring of width R around radius R/2).
            HudLineMesh dot = HudFactory.CreateLineMesh("Dot", root, center, center, zero, zero);
            dot.Ring(zero, DotHalo * 0.25f, DotHalo * 0.5f, HudTokens.Halo, 20);
            dot.Ring(zero, Dot * 0.25f, Dot * 0.5f, HudTokens.InkPrimary, 16);
            dot.Commit();

            // Scan-hold ring: arc from the top, clockwise, redrawn when the hold progress changes.
            ring = HudFactory.CreateLineMesh("HoldRing", root, center, center, zero, zero);
            ring.enabled = false;

            SetRing(0f);
            SetTargetShown(false);

            if (scanner != null)
            {
                scanner.Scanned += OnScanned;
            }
        }

        /// <summary>False while the debug overlay is on: the whole reticle hides.</summary>
        public bool Visible
        {
            get => visible;
            set
            {
                visible = value;
                if (!value)
                {
                    SetRootShown(false);
                }
            }
        }

        /// <summary>Per frame: hold ring, bracket fit, label, hint and lock cue.</summary>
        public void Tick(float dt)
        {
            Camera cam = ctx.Camera;
            bool show = visible && cam != null && scanner != null;
            SetRootShown(show);
            if (!show)
            {
                return;
            }

            float hold = scanner.ScanHoldProgress;
            SetRing(hold);

            RockSample current = scanner.Target;
            if (current != target)
            {
                OnTargetChanged(current);
            }
            if (target == null || !ComputeBox(cam, out Vector2 center, out Vector2 size))
            {
                SetTargetShown(false);
                return;
            }
            SetTargetShown(true);

            // Lock cue: 1.12 -> 1.0 scale (EaseOut) and alpha to 1; reduced motion keeps the alpha only.
            float scale = 1f;
            float alpha;
            if (lockTime >= 0f)
            {
                lockTime += dt;
                float u = Mathf.Clamp01(lockTime / HudTokens.Dur(HudTokens.DurBracketLock));
                float e = HudTokens.EaseOut(u);
                if (!HudTokens.ReducedMotion)
                {
                    scale = Mathf.LerpUnclamped(HudTokens.BracketLockScale, 1f, e);
                }
                alpha = Mathf.Lerp(RestAlpha, 1f, e);
                if (u >= 1f)
                {
                    lockTime = -1f;
                }
            }
            else
            {
                RockCardSystem cards = ctx.Cards;
                alpha = cards != null && cards.HasOpenCard(target) ? 1f : RestAlpha;
            }

            Color32 color = hold > 0f ? HudTokens.Accent : HudTokens.Alpha(HudTokens.StrokeMark, alpha);
            if (color.r != bracketColor.r || color.g != bracketColor.g || color.b != bracketColor.b || color.a != bracketColor.a)
            {
                bracketColor = color;
                bracketSize = new Vector2(-1f, -1f);   // forces a redraw below
            }
            if (scale != bracketScale)
            {
                bracketScale = scale;
                bracketRoot.localScale = new Vector3(scale, scale, 1f);
            }

            if (center != lastCenter || size != lastSize)
            {
                lastCenter = center;
                lastSize = size;
                bracketRoot.anchoredPosition = center;
                bracketRoot.sizeDelta = size;
                label.anchoredPosition = new Vector2(center.x + size.x * 0.5f + LabelOffsetX, center.y + size.y * 0.5f + LabelOffsetY);
                hint.anchoredPosition = new Vector2(center.x, center.y - size.y * 0.5f - HintGap);
            }

            if (size != bracketSize)
            {
                bracketSize = size;
                DrawBrackets(size);
            }

            string dist = HudStrings.Distance(scanner.TargetHit.distance);
            if (!ReferenceEquals(dist, distString))
            {
                distString = dist;
                distText.text = dist;
            }
        }

        /// <summary>Unsubscribes from the scanner.</summary>
        public void Dispose()
        {
            if (!ReferenceEquals(scanner, null))
            {
                scanner.Scanned -= OnScanned;
            }
        }

        // Four L corners (arm 14 px) over a dark halo, mitered at the corner.
        private void DrawBrackets(Vector2 size)
        {
            brackets.Clear();
            float hx = size.x * 0.5f, hy = size.y * 0.5f;
            float arm = Mathf.Min(BracketArm, Mathf.Min(hx, hy));
            Color32 halo = HudTokens.Halo;
            for (int pass = 0; pass < 2; pass++)
            {
                float width = pass == 0 ? BracketHaloStroke : BracketStroke;
                Color32 col = pass == 0 ? halo : bracketColor;
                for (int c = 0; c < 4; c++)
                {
                    float sx = (c & 1) == 0 ? -1f : 1f;
                    float sy = (c & 2) == 0 ? -1f : 1f;
                    corner[0] = new Vector2(sx * hx, sy * (hy - arm));
                    corner[1] = new Vector2(sx * hx, sy * hy);
                    corner[2] = new Vector2(sx * (hx - arm), sy * hy);
                    brackets.Polyline(corner, 3, width, col);
                }
            }
            brackets.Commit();
        }

        // Event-time only (target change): cache the renderer, set the ID and the hint.
        private void OnTargetChanged(RockSample current)
        {
            target = current;
            lockTime = -1f;
            distString = null;
            scannedState = -1;
            if (current == null)
            {
                targetRenderer = null;
                return;
            }
            targetRenderer = current.GetComponentInChildren<Renderer>();

            string id = current.FieldId;
            if (string.IsNullOrEmpty(id))
            {
                id = "--";
            }
            idText.text = id;
            distRect.anchoredPosition = new Vector2((id.Length + 1) * microAdvance, 0f);
            RefreshScanned();
        }

        private void RefreshScanned()
        {
            int state = target != null && scanner.HasScanned(target) ? 1 : 0;
            if (state == scannedState)
            {
                return;
            }
            scannedState = state;
            string text = state == 1 ? RescanLabel : ScanLabel;
            hintText.text = text;
            Vector2 size = hint.sizeDelta;
            size.x = KeycapSize + HudTokens.S2 + text.Length * microAdvance;
            hint.sizeDelta = size;
        }

        private void OnScanned(RockScanResult result)
        {
            if (result == null || target == null || result.Rock != target)
            {
                return;
            }
            lockTime = 0f;
            RefreshScanned();
        }

        // Screen box of the rock's renderer bounds in canvas units; 120 px around the hit point when a corner is behind
        // the camera, the box is larger than 260 px or there is no renderer. Sides clamped to [36, 260].
        private bool ComputeBox(Camera cam, out Vector2 center, out Vector2 size)
        {
            float k = ctx.Canvas != null ? ctx.Canvas.scaleFactor : 1f;
            if (k <= 0f)
            {
                k = 1f;
            }

            if (targetRenderer != null)
            {
                Bounds b = targetRenderer.bounds;
                Vector3 c = b.center;
                Vector3 e = b.extents;
                float minX = float.MaxValue, minY = float.MaxValue, maxX = float.MinValue, maxY = float.MinValue;
                bool behind = false;
                for (int i = 0; i < 8; i++)
                {
                    Vector3 corner = new Vector3((i & 1) == 0 ? c.x - e.x : c.x + e.x,
                                                 (i & 2) == 0 ? c.y - e.y : c.y + e.y,
                                                 (i & 4) == 0 ? c.z - e.z : c.z + e.z);
                    Vector3 sp = cam.WorldToScreenPoint(corner);
                    if (sp.z <= 0f)
                    {
                        behind = true;
                        break;
                    }
                    minX = Mathf.Min(minX, sp.x);
                    maxX = Mathf.Max(maxX, sp.x);
                    minY = Mathf.Min(minY, sp.y);
                    maxY = Mathf.Max(maxY, sp.y);
                }
                if (!behind)
                {
                    float w = (maxX - minX) / k;
                    float h = (maxY - minY) / k;
                    if (w <= MaxBox && h <= MaxBox)
                    {
                        center = new Vector2((minX + maxX) * 0.5f / k, (minY + maxY) * 0.5f / k);
                        size = new Vector2(Mathf.Max(w, MinBox), Mathf.Max(h, MinBox));
                        return true;
                    }
                }
            }

            Vector3 hit = cam.WorldToScreenPoint(scanner.TargetHit.point);
            if (hit.z <= 0f)
            {
                center = Vector2.zero;
                size = Vector2.zero;
                return false;
            }
            center = new Vector2(hit.x / k, hit.y / k);
            size = new Vector2(FallbackBox, FallbackBox);
            return true;
        }

        private void SetRootShown(bool shown)
        {
            if (shown == rootShown)
            {
                return;
            }
            rootShown = shown;
            rootGroup.alpha = shown ? 1f : 0f;
        }

        private void SetTargetShown(bool shown)
        {
            if (shown == targetShown)
            {
                return;
            }
            targetShown = shown;
            targetGroup.alpha = shown ? 1f : 0f;
        }

        private void SetRing(float progress)
        {
            bool shown = progress > 0f;
            if (shown != ringShown)
            {
                ringShown = shown;
                ring.enabled = shown;
            }
            if (shown && progress != ringFill)
            {
                ringFill = progress;
                float p = Mathf.Clamp01(progress);
                ring.Clear();
                ring.Arc(Vector2.zero, (RingSize - RingWidth) * 0.5f, 90f, 90f - 360f * p, RingWidth, HudTokens.Accent,
                         Mathf.Max(2, Mathf.CeilToInt(64f * p)));
                ring.Commit();
            }
        }
    }
}

using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Top-center heading tape: crisp vertical ticks that scroll with the camera heading (world +Z = north = 0 deg), minor
    /// every 5 deg, taller every 10 deg, labelled every 30 deg ("N", "030", "060", "E" ...), +-60 deg visible, ticks and
    /// labels fading out toward both ends. A fixed double chevron under the tape marks the lubber line and a boxed readout
    /// on top shows the heading ("045°", updated only when the integer changes). Bearing markers ride on the tape: HOME
    /// (hollow diamond = waypoint) and every open rock card (small filled diamond, the focused one in Accent); a marker
    /// beyond the tape is clamped to its end with an outward arrow.
    ///
    /// All strokes are one <see cref="HudLineMesh"/> whose vertices are snapped to the screen pixel grid (odd widths on
    /// pixel centers, even widths and box edges on pixel edges, stroke ends on pixel centers), so ticks stay 1-2 px sharp
    /// at any position. Labels are a pool of five legacy Text objects keyed by tick (a label keeps its object while it
    /// scrolls), strings prebuilt, alpha through CanvasRenderer (no mesh rebuild). The mesh is redrawn only when the
    /// heading, a marker or the pixel grid changed. Registers its root as a reserved zone for the rock-card layout.
    /// </summary>
    public sealed class HeadingCaret
    {
        // Root: anchor and pivot top-center, 24 px below the top edge, 640 x 56 (the alert banner sits below at ~96 px).
        private const float Width = 640f, Height = 56f, TopOffset = 24f;
        private const float HalfRangeDeg = 60f;                        // visible +-60 deg
        private const float PxPerDeg = Width * 0.5f / HalfRangeDeg;    // 5.33 px per degree
        private const float FadeStartDeg = 34f;                        // ticks and labels fade from here to the tape end

        // Local layout: origin at the tape center, y up (top edge +28, bottom edge -28).
        private const float BoxW = 60f, BoxH = 24f, BoxTop = Height * 0.5f;    // boxed readout, top-center
        private const float LabelY = 15f, LabelW = 40f, LabelH = 18f;
        private const float TickBase = -10f, TickMinor = 5f, TickMajor = 8f, TickLabelled = 11f;
        private const float MarkerY = -5f, HomeRadius = 6f, RockRadius = 4.5f, MarkerStroke = 1.5f;
        private const float ClampDeg = 54f, ArrowGap = 9f;
        private const float ChevronTip = -15f, ChevronStep = 5f, ChevronHalfW = 5f, ChevronDrop = 4f, ChevronStroke = 1.5f;
        private const float HomeMinDistanceM = 2f;     // at the pad the home bearing is meaningless
        private const float RockMinDistanceM = 0.5f;
        private const int LabelPool = 5;               // at most 5 labels (every 30 deg) inside +-60 deg
        private const int MaxRocks = 8;

        private static readonly string[] s_Labels = { "N", "030", "060", "E", "120", "150", "S", "210", "240", "W", "300", "330" };

        private readonly HudContext ctx;
        private readonly HudLineMesh mesh;
        private readonly RectTransform meshRect;
        private readonly Text readout;
        private readonly Text[] labels = new Text[LabelPool];
        private readonly RectTransform[] labelRects = new RectTransform[LabelPool];
        private readonly int[] labelIndex = new int[LabelPool];
        private readonly float[] labelAlpha = new float[LabelPool];
        private readonly bool[] labelUsed = new bool[LabelPool];
        private readonly Vector2[] poly = new Vector2[3];

        private readonly Color32 ink, mark, halo, scrim, accent;

        // Marker state (redraw only when it changes).
        private readonly float[] rockBearing = new float[MaxRocks];
        private readonly bool[] rockFocused = new bool[MaxRocks];
        private int rockCount;
        private bool homeShown;
        private float homeBearing;

        private float lastHeading = float.NaN, lastPx = -1f, lastOx = float.NaN, lastOy = float.NaN;
        private int lastReadout = int.MinValue;

        // Pixel grid of the current redraw: one screen pixel in local units and the screen position of the local origin.
        private bool snap;
        private float px = 1f, ox, oy;

        /// <summary>Builds the tape in a "Caret" layer inserted right after <see cref="HudContext.DialLayer"/>.</summary>
        public HeadingCaret(HudContext ctx)
        {
            this.ctx = ctx;
            HudSkin skin = ctx.Skin;
            Font medium = skin != null ? skin.Medium : null;

            ink = HudTokens.InkPrimary;
            mark = HudTokens.StrokeMark;
            halo = HudTokens.Halo;
            scrim = HudTokens.Scrim;
            accent = HudTokens.Accent;

            // Own layer in the Dynamic canvas right after Dial (draw order); the canvas root when there is no dial layer.
            RectTransform dial = ctx.DialLayer;
            Transform parent = dial != null ? dial.parent : ctx.CanvasRect;
            RectTransform layer = HudFactory.CreateStretch("Caret", parent);
            if (dial != null)
            {
                layer.SetSiblingIndex(dial.GetSiblingIndex() + 1);
            }

            Vector2 top = new Vector2(0.5f, 1f);
            Vector2 center = new Vector2(0.5f, 0.5f);
            RectTransform root = HudFactory.CreateRect("HeadingTape", layer, top, top, new Vector2(0f, -TopOffset), new Vector2(Width, Height));

            // Sibling order = draw order: strokes (ticks, markers, chevrons, readout box), then labels, then the digits.
            mesh = HudFactory.CreateLineMesh("Strokes", root, center, center, Vector2.zero, new Vector2(Width, Height));
            meshRect = mesh.rectTransform;

            for (int i = 0; i < LabelPool; i++)
            {
                Text t = HudFactory.CreateText("Label" + i, root, medium, HudTokens.SizeMicro, HudTokens.InkSecondary,
                                               TextAnchor.MiddleCenter, center, center, new Vector2(0f, LabelY),
                                               new Vector2(LabelW, LabelH));
                HudFactory.AddHalo(t);
                t.canvasRenderer.SetAlpha(0f);
                labels[i] = t;
                labelRects[i] = t.rectTransform;
                labelIndex[i] = -1;
            }

            readout = HudFactory.CreateText("Heading", root, medium, HudTokens.SizeValue, HudTokens.InkPrimary, TextAnchor.MiddleCenter,
                                            center, center, new Vector2(0f, BoxTop - BoxH * 0.5f), new Vector2(BoxW, BoxH));

            ctx.ReserveZone(root);
            Tick(0f);
        }

        /// <summary>Per frame: readout on integer change; tape redrawn when heading, markers or pixel grid changed.</summary>
        public void Tick(float dt)
        {
            if (mesh == null)
            {
                return;
            }
            float heading = ctx.HeadingDeg;
            if (float.IsNaN(heading) || float.IsInfinity(heading))
            {
                heading = 0f;
            }

            int shown = Mathf.RoundToInt(heading);   // matches the tape center; Heading() wraps 360 to "000°"
            if (shown != lastReadout)
            {
                lastReadout = shown;
                readout.text = HudStrings.Heading(shown);
            }

            bool dirty = SampleMarkers();
            ReadGrid();
            if (heading != lastHeading || px != lastPx || ox != lastOx || oy != lastOy)
            {
                dirty = true;
            }
            if (!dirty)
            {
                return;
            }
            lastHeading = heading;
            lastPx = px;
            lastOx = ox;
            lastOy = oy;
            Redraw(heading);
        }

        // ---- markers

        // Samples home and rock bearings; true when anything visible changed.
        private bool SampleMarkers()
        {
            bool dirty = false;
            Vector3 cam = ctx.CameraPosition;

            // Home = world origin (pad). Telemetry owns the numbers; the local formula is only a null fallback.
            float dist, bearing;
            SuitTelemetry telemetry = ctx.Telemetry;
            if (telemetry != null)
            {
                dist = telemetry.DistanceHomeM;
                bearing = telemetry.BearingHomeDeg;
            }
            else
            {
                dist = Mathf.Sqrt(cam.x * cam.x + cam.z * cam.z);
                bearing = Mathf.Atan2(-cam.x, -cam.z) * Mathf.Rad2Deg;
            }
            bool home = dist >= HomeMinDistanceM && Finite(bearing);
            if (home != homeShown || (home && Mathf.Abs(Mathf.DeltaAngle(bearing, homeBearing)) > 0.01f))
            {
                dirty = true;
                homeShown = home;
                homeBearing = home ? bearing : 0f;
            }

            int n = 0;
            RockCardSystem cards = ctx.Cards;
            if (cards != null)
            {
                int count = Mathf.Min(cards.CardCount, MaxRocks);
                for (int i = 0; i < count; i++)
                {
                    if (!cards.TryGetCard(i, out Vector3 anchor, out bool focused))
                    {
                        break;
                    }
                    float dx = anchor.x - cam.x;
                    float dz = anchor.z - cam.z;
                    if (dx * dx + dz * dz < RockMinDistanceM * RockMinDistanceM)
                    {
                        continue;
                    }
                    float b = Mathf.Atan2(dx, dz) * Mathf.Rad2Deg;
                    if (!Finite(b))
                    {
                        continue;
                    }
                    if (n >= rockCount || focused != rockFocused[n] || Mathf.Abs(Mathf.DeltaAngle(b, rockBearing[n])) > 0.01f)
                    {
                        dirty = true;
                        rockBearing[n] = b;
                        rockFocused[n] = focused;
                    }
                    n++;
                }
            }
            if (n != rockCount)
            {
                dirty = true;
                rockCount = n;
            }
            return dirty;
        }

        // ---- drawing

        private void Redraw(float heading)
        {
            float scale = 1f / px;                                          // screen px per local unit
            int minorPx = Mathf.Max(1, Mathf.RoundToInt(scale));            // 1 px at 1080p
            int majorPx = Mathf.Max(1, Mathf.RoundToInt(1.5f * scale));     // 2 px at 1080p

            mesh.Clear();

            // 1. Ticks. All keylines first, then all ink, so no keyline cuts a neighbouring tick.
            int first = Mathf.CeilToInt((heading - HalfRangeDeg) / 5f);
            int last = Mathf.FloorToInt((heading + HalfRangeDeg) / 5f);
            float yBase = SnapY(TickBase, true);
            for (int pass = 0; pass < 2; pass++)
            {
                for (int k = first; k <= last; k++)
                {
                    float delta = k * 5f - heading;
                    float fade = EdgeFade(delta);
                    if (fade < 0.01f)
                    {
                        continue;
                    }
                    int deg = Wrap(k * 5, 360);
                    bool major = deg % 10 == 0;
                    int w = major ? majorPx : minorPx;
                    float h = deg % 30 == 0 ? TickLabelled : (major ? TickMajor : TickMinor);
                    float x = SnapX(delta * PxPerDeg, (w & 1) == 1);
                    float yTop = SnapY(TickBase + h, true);
                    if (pass == 0)
                    {
                        mesh.Line(new Vector2(x, yBase - px), new Vector2(x, yTop + px), (w + 2) * px, Fade(halo, fade));
                    }
                    else
                    {
                        mesh.Line(new Vector2(x, yBase), new Vector2(x, yTop), w * px, Fade(mark, fade));
                    }
                }
            }

            // 2. Fixed double chevron (lubber line) under the tape, pointing up at the center tick.
            float cx = SnapX(0f, true);
            for (int pass = 0; pass < 2; pass++)
            {
                for (int c = 0; c < 2; c++)
                {
                    float tip = SnapY(ChevronTip - c * ChevronStep, true);
                    SetChevron(new Vector2(cx, tip), new Vector2(-ChevronHalfW, -ChevronDrop), new Vector2(ChevronHalfW, -ChevronDrop), pass == 0);
                    if (pass == 0)
                    {
                        mesh.Polyline(poly, 3, ChevronStroke + 2f * px, halo);
                    }
                    else
                    {
                        mesh.Polyline(poly, 3, ChevronStroke, ink);
                    }
                }
            }

            // 3. Bearing markers: home, then rocks, the focused rock last (on top).
            if (homeShown)
            {
                DrawMarker(Mathf.DeltaAngle(heading, homeBearing), false, ink);
            }
            for (int i = 0; i < rockCount; i++)
            {
                if (!rockFocused[i])
                {
                    DrawMarker(Mathf.DeltaAngle(heading, rockBearing[i]), true, ink);
                }
            }
            for (int i = 0; i < rockCount; i++)
            {
                if (rockFocused[i])
                {
                    DrawMarker(Mathf.DeltaAngle(heading, rockBearing[i]), true, accent);
                }
            }

            // 4. Readout box: scrim fill and a hairline frame on pixel edges (four non-overlapping bars).
            float x0 = SnapX(-BoxW * 0.5f, false), x1 = SnapX(BoxW * 0.5f, false);
            float y0 = SnapY(BoxTop - BoxH, false), y1 = SnapY(BoxTop, false);
            float bw = x1 - x0, bh = y1 - y0;
            float t = minorPx * px;
            mesh.Rect(new Rect(x0, y0, bw, bh), scrim);
            mesh.Rect(new Rect(x0, y1 - t, bw, t), mark);
            mesh.Rect(new Rect(x0, y0, bw, t), mark);
            mesh.Rect(new Rect(x0, y0 + t, t, bh - 2f * t), mark);
            mesh.Rect(new Rect(x1 - t, y0 + t, t, bh - 2f * t), mark);

            mesh.Commit();

            PlaceLabels(heading);
        }

        // Labels every 30 deg. Label k keeps pool slot k mod 5 while it scrolls, so its text is set only when it enters.
        private void PlaceLabels(float heading)
        {
            for (int i = 0; i < LabelPool; i++)
            {
                labelUsed[i] = false;
            }
            int first = Mathf.CeilToInt((heading - HalfRangeDeg) / 30f);
            int last = Mathf.FloorToInt((heading + HalfRangeDeg) / 30f);
            float charW = HudTokens.Advance(HudTokens.SizeMicro);
            float y = SnapY(LabelY, false);
            for (int k = first; k <= last; k++)
            {
                int slot = Wrap(k, LabelPool);
                if (labelUsed[slot])
                {
                    continue;
                }
                labelUsed[slot] = true;

                int index = Wrap(k, 12);
                bool cardinal = index % 3 == 0;
                float delta = k * 30f - heading;
                float x = delta * PxPerDeg;
                // Fade out under the readout box: gone once the label would reach 2 px into the box.
                float halfText = (cardinal ? 0.5f : 1.5f) * charW;
                float boxFade = Mathf.Clamp01((Mathf.Abs(x) - (BoxW * 0.5f + halfText - 2f)) / 8f);

                if (labelIndex[slot] != index)
                {
                    labelIndex[slot] = index;
                    labels[slot].text = s_Labels[index];
                    labels[slot].color = cardinal ? HudTokens.InkPrimary : HudTokens.InkSecondary;
                }
                Vector2 pos = new Vector2(SnapX(x, false), y);
                if (labelRects[slot].anchoredPosition != pos)
                {
                    labelRects[slot].anchoredPosition = pos;
                }
                SetLabelAlpha(slot, EdgeFade(delta) * boxFade);
            }
            for (int i = 0; i < LabelPool; i++)
            {
                if (!labelUsed[i])
                {
                    SetLabelAlpha(i, 0f);
                }
            }
        }

        private void SetLabelAlpha(int slot, float a)
        {
            if (Mathf.Abs(labelAlpha[slot] - a) > 0.002f || (a == 0f && labelAlpha[slot] != 0f))
            {
                labelAlpha[slot] = a;
                labels[slot].canvasRenderer.SetAlpha(a);
            }
        }

        // Marker at a bearing delta (deg, + = right). Off the tape: clamped at +-54 deg with an outward arrow.
        private void DrawMarker(float delta, bool rock, Color32 color)
        {
            bool clamped = Mathf.Abs(delta) > ClampDeg;
            float side = delta < 0f ? -1f : 1f;
            float x = (clamped ? side * ClampDeg : delta) * PxPerDeg;
            Vector2 c = new Vector2(SnapX(x, true), SnapY(MarkerY, true));

            if (rock)
            {
                Diamond(c, RockRadius + 1.5f * px, halo);
                Diamond(c, RockRadius, color);
            }
            else
            {
                mesh.Ring(c, HomeRadius, MarkerStroke + 2f * px, halo, 4);
                mesh.Ring(c, HomeRadius, MarkerStroke, color, 4);
            }

            if (clamped)
            {
                Vector2 tip = new Vector2(c.x + side * (ArrowGap + 3f), c.y);   // arrow spans 8..12 px out, clear of the diamond
                SetChevron(tip, new Vector2(-side * 4f, 4f), new Vector2(-side * 4f, -4f), true);
                mesh.Polyline(poly, 3, MarkerStroke + 2f * px, halo);
                SetChevron(tip, new Vector2(-side * 4f, 4f), new Vector2(-side * 4f, -4f), false);
                mesh.Polyline(poly, 3, MarkerStroke, color);
            }
        }

        // Filled diamond of vertex radius r: one straight stroke along the 45 deg diagonal whose width is the square side.
        // The butt ends get a 1 px AA ramp beyond them, so the core is shortened by 1 px to keep the shape square.
        private void Diamond(Vector2 c, float r, Color32 color)
        {
            float sideLen = r * 1.41421356f;
            float half = Mathf.Max(0f, sideLen - px) * 0.5f * 0.70710678f;
            Vector2 u = new Vector2(half, half);
            mesh.Line(c - u, c + u, sideLen, color);
        }

        // Three-point chevron into the reused buffer; keyline copies extend each arm 1 px past the ink.
        private void SetChevron(Vector2 tip, Vector2 armA, Vector2 armB, bool keyline)
        {
            Vector2 a = tip + armA, b = tip + armB;
            if (keyline)
            {
                a += armA.normalized * px;
                b += armB.normalized * px;
            }
            poly[0] = a;
            poly[1] = tip;
            poly[2] = b;
        }

        // ---- pixel grid

        private void ReadGrid()
        {
            px = mesh.PixelSize;
            Canvas c = mesh.canvas;
            Canvas root = c != null ? c.rootCanvas : null;
            snap = root != null && root.renderMode == RenderMode.ScreenSpaceOverlay;   // overlay: world units = screen px
            if (snap)
            {
                Vector3 o = meshRect.position;
                ox = o.x;
                oy = o.y;
            }
            else
            {
                ox = 0f;
                oy = 0f;
            }
        }

        // Local x of the nearest pixel center (center = true: odd widths, stroke ends) or pixel edge (even widths, fills).
        private float SnapX(float x, bool center)
        {
            if (!snap)
            {
                return x;
            }
            float s = ox + x / px;
            s = center ? Mathf.Floor(s) + 0.5f : Mathf.Round(s);
            return (s - ox) * px;
        }

        private float SnapY(float y, bool center)
        {
            if (!snap)
            {
                return y;
            }
            float s = oy + y / px;
            s = center ? Mathf.Floor(s) + 0.5f : Mathf.Round(s);
            return (s - oy) * px;
        }

        // ---- helpers

        // 1 inside +-34 deg, smooth fall to 0 at the tape ends (+-60 deg).
        private static float EdgeFade(float deltaDeg)
        {
            float t = Mathf.InverseLerp(HalfRangeDeg, FadeStartDeg, Mathf.Abs(deltaDeg));
            return t * t * (3f - 2f * t);
        }

        private static Color32 Fade(Color32 c, float f)
        {
            c.a = (byte)Mathf.Clamp(Mathf.RoundToInt(c.a * f), 0, 255);
            return c;
        }

        private static int Wrap(int v, int m)
        {
            int r = v % m;
            return r < 0 ? r + m : r;
        }

        private static bool Finite(float v)
        {
            return !float.IsNaN(v) && !float.IsInfinity(v);
        }
    }
}

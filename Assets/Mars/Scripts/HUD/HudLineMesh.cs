using System;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Crisp, resolution-independent vector strokes for the HUD (replaces down-scaled raster sprites for lines, ticks,
    /// rings and traces). Every stroke is a solid core plus a 1-screen-pixel anti-aliasing ramp (outer vertices alpha 0),
    /// centered on the ideal edge, so a stroke covers exactly its width at any canvas scale and any sub-pixel position.
    /// Strokes thinner than 1 screen pixel keep a 1 px footprint with proportionally lower alpha.
    ///
    /// Usage per redraw: <see cref="Clear"/>, any number of <see cref="Line"/> / <see cref="Polyline"/> /
    /// <see cref="Rect"/> / <see cref="Ring"/> / <see cref="Arc"/> calls (draw order = call order), then
    /// <see cref="Commit"/>. Coordinates are in this graphic's local space (origin at its pivot, y up), widths in local
    /// units. Angles are degrees counter-clockwise from local +X (as Mathf.Cos/Sin). Vertex colors are multiplied by
    /// <see cref="Graphic.color"/>. Commands are recorded into reused buffers; the tessellation runs in
    /// <see cref="OnPopulateMesh"/> with the current pixel size (no GC per rebuild once buffers have grown).
    /// Not a raycast target by default.
    /// </summary>
    // Unity 6 uGUI: Graphic no longer requires a CanvasRenderer (only Image/RawImage/Text declare it). Without this
    // attribute a runtime AddComponent gets no renderer and the mesh is never drawn.
    [DisallowMultipleComponent]
    [RequireComponent(typeof(CanvasRenderer))]
    public sealed class HudLineMesh : MaskableGraphic
    {
        private const float MiterLimit = 4f;      // max miter scale; sharper joins are clamped (no spikes on ECG peaks)
        private const int MaxVertices = 64000;    // 16-bit index meshes

        private enum Kind : byte { Stroke, StrokeClosed, Fill }

        private struct Cmd
        {
            public Kind Kind;
            public int Start, Count;          // range in pts (strokes)
            public UnityEngine.Rect Box;      // fills
            public float Width;
            public Color32 Color;
        }

        private static UIVertex s_Vertex = UIVertex.simpleVert;

        private Cmd[] cmds = new Cmd[16];
        private int cmdCount;
        private Vector2[] pts = new Vector2[128];
        private int ptCount;
        private float builtPixel = -1f;

        /// <summary>One screen pixel in this graphic's local units (canvas scale factor and parent scales included).</summary>
        public float PixelSize
        {
            get
            {
                Canvas c = canvas;
                if (c == null)
                {
                    return 1f;
                }
                Canvas root = c.rootCanvas;
                float s;
                if (root != null && root.renderMode == RenderMode.ScreenSpaceOverlay)
                {
                    s = Mathf.Abs(transform.lossyScale.x);   // overlay: world units are screen pixels
                }
                else
                {
                    s = root != null ? root.scaleFactor : c.scaleFactor;
                }
                return s > 1e-5f ? 1f / s : 1f;
            }
        }

        protected override void Awake()
        {
            base.Awake();
            raycastTarget = false;
        }

        // Screen resize or parent scale change: re-tessellate so the AA ramp stays exactly 1 screen pixel wide.
        private void LateUpdate()
        {
            if (cmdCount == 0 || builtPixel <= 0f)
            {
                return;
            }
            float px = PixelSize;
            if (Mathf.Abs(px - builtPixel) > builtPixel * 0.02f)
            {
                SetVerticesDirty();
            }
        }

        /// <summary>Removes every recorded primitive (call <see cref="Commit"/> to show the change).</summary>
        public void Clear()
        {
            cmdCount = 0;
            ptCount = 0;
        }

        /// <summary>Straight stroke from <paramref name="a"/> to <paramref name="b"/>.</summary>
        public void Line(Vector2 a, Vector2 b, float width, Color32 color)
        {
            int s = ReservePoints(2);
            pts[s] = a;
            pts[s + 1] = b;
            AddCmd(Kind.Stroke, s, 2, width, color);
        }

        /// <summary>Open stroke through the first <paramref name="count"/> points, mitered at every joint.</summary>
        public void Polyline(Vector2[] points, int count, float width, Color32 color)
        {
            if (points == null)
            {
                return;
            }
            count = Mathf.Min(count, points.Length);
            if (count < 2)
            {
                return;
            }
            int s = ReservePoints(count);
            Array.Copy(points, 0, pts, s, count);
            AddCmd(Kind.Stroke, s, count, width, color);
        }

        /// <summary>Filled axis-aligned rectangle with anti-aliased edges.</summary>
        public void Rect(UnityEngine.Rect r, Color32 color)
        {
            if (r.width <= 0f || r.height <= 0f)
            {
                return;
            }
            EnsureCmd();
            cmds[cmdCount++] = new Cmd { Kind = Kind.Fill, Box = r, Color = color };
        }

        /// <summary>
        /// Closed circle stroke of <paramref name="segments"/> segments (min 3). A filled disc of radius R is
        /// Ring(center, R / 2, R, ...).
        /// </summary>
        public void Ring(Vector2 center, float radius, float width, Color32 color, int segments)
        {
            segments = Mathf.Max(3, segments);
            int s = ReservePoints(segments);
            float step = 2f * Mathf.PI / segments;
            for (int i = 0; i < segments; i++)
            {
                float a = i * step;
                pts[s + i] = new Vector2(center.x + Mathf.Cos(a) * radius, center.y + Mathf.Sin(a) * radius);
            }
            AddCmd(Kind.StrokeClosed, s, segments, width, color);
        }

        /// <summary>
        /// Open circular arc from <paramref name="startDeg"/> to <paramref name="endDeg"/> (degrees, counter-clockwise from
        /// +X; an end below the start runs clockwise) in <paramref name="segments"/> segments (min 1).
        /// </summary>
        public void Arc(Vector2 center, float radius, float startDeg, float endDeg, float width, Color32 color, int segments)
        {
            segments = Mathf.Max(1, segments);
            int n = segments + 1;
            int s = ReservePoints(n);
            float a0 = startDeg * Mathf.Deg2Rad;
            float da = (endDeg - startDeg) * Mathf.Deg2Rad / segments;
            for (int i = 0; i < n; i++)
            {
                float a = a0 + i * da;
                pts[s + i] = new Vector2(center.x + Mathf.Cos(a) * radius, center.y + Mathf.Sin(a) * radius);
            }
            AddCmd(Kind.Stroke, s, n, width, color);
        }

        /// <summary>Marks the mesh dirty; the tessellation runs in OnPopulateMesh before the canvas renders.</summary>
        public void Commit()
        {
            SetVerticesDirty();
        }

        protected override void OnPopulateMesh(VertexHelper vh)
        {
            vh.Clear();
            float px = PixelSize;
            builtPixel = px;
            Color32 tint = color;
            for (int i = 0; i < cmdCount; i++)
            {
                Cmd c = cmds[i];
                Color32 col = Multiply(c.Color, tint);
                switch (c.Kind)
                {
                    case Kind.Fill:
                        if (vh.currentVertCount + 8 > MaxVertices)
                        {
                            return;
                        }
                        EmitFill(vh, c.Box, col, px);
                        break;
                    default:
                        if (vh.currentVertCount + 4 * (c.Count + 2) > MaxVertices)
                        {
                            return;
                        }
                        EmitStroke(vh, c.Start, c.Count, c.Kind == Kind.StrokeClosed && c.Count >= 3, c.Width, col, px);
                        break;
                }
            }
        }

        // ---- tessellation

        // Cross-section per point: outer+ (a 0), core+ (a 1), core- (a 1), outer- (a 0), offset along the miter normal.
        // Open ends get an extra all-transparent section 1 px further out, so the butt ends are anti-aliased too.
        private void EmitStroke(VertexHelper vh, int start, int count, bool closed, float width, Color32 col, float px)
        {
            if (width <= 0f || col.a == 0)
            {
                return;
            }
            float core, outer;
            if (width >= px)
            {
                core = 0.5f * (width - px);
                outer = core + px;
            }
            else
            {
                core = 0f;
                outer = px;
                col.a = (byte)Mathf.Clamp(Mathf.RoundToInt(col.a * (width / px)), 0, 255);
            }
            Color32 clear = col;
            clear.a = 0;

            int end = start + count - 1;
            Vector2 firstDir = Direction(pts[start], pts[start + 1], new Vector2(1f, 0f));
            Vector2 lastDir = firstDir;
            int baseIndex = vh.currentVertCount;

            if (!closed)
            {
                Vector2 o = Perp(firstDir);
                Section(vh, pts[start] - firstDir * px, o, core, outer, clear, clear);
            }

            Vector2 prevDir = closed ? Direction(pts[end], pts[start], firstDir) : firstDir;
            for (int i = start; i <= end; i++)
            {
                Vector2 p = pts[i];
                bool hasPrev = closed || i > start;
                bool hasNext = closed || i < end;
                Vector2 inDir = hasPrev ? Direction(i > start ? pts[i - 1] : pts[end], p, prevDir) : firstDir;
                Vector2 outDir = hasNext ? Direction(p, i < end ? pts[i + 1] : pts[start], inDir) : inDir;
                if (!hasPrev)
                {
                    inDir = outDir;
                }

                Vector2 nIn = Perp(inDir), nOut = Perp(outDir);
                Vector2 m = nIn + nOut;
                Vector2 offset;
                float len = m.magnitude;
                if (len < 1e-4f)
                {
                    offset = nOut;   // full reversal: no miter
                }
                else
                {
                    m /= len;
                    float cos = Vector2.Dot(m, nOut);
                    offset = m * (1f / Mathf.Max(cos, 1f / MiterLimit));
                }
                Section(vh, p, offset, core, outer, col, clear);
                prevDir = outDir;
                lastDir = outDir;
            }

            if (!closed)
            {
                Section(vh, pts[end] + lastDir * px, Perp(lastDir), core, outer, clear, clear);
            }

            int sections = count + (closed ? 0 : 2);
            for (int s = 0; s < sections - 1; s++)
            {
                Bridge(vh, baseIndex + 4 * s, baseIndex + 4 * (s + 1));
            }
            if (closed)
            {
                Bridge(vh, baseIndex + 4 * (sections - 1), baseIndex);
            }
        }

        private static void Section(VertexHelper vh, Vector2 p, Vector2 offset, float core, float outer, Color32 inner, Color32 edge)
        {
            AddVertex(vh, p + offset * outer, edge);
            AddVertex(vh, p + offset * core, inner);
            AddVertex(vh, p - offset * core, inner);
            AddVertex(vh, p - offset * outer, edge);
        }

        // Three quads between two 4-vertex cross-sections.
        private static void Bridge(VertexHelper vh, int a, int b)
        {
            for (int k = 0; k < 3; k++)
            {
                vh.AddTriangle(a + k, a + k + 1, b + k + 1);
                vh.AddTriangle(b + k + 1, b + k, a + k);
            }
        }

        // Inner rect (shrunk 0.5 px, full alpha) + outer rect (grown 0.5 px, alpha 0) and the four edge ramps.
        private static void EmitFill(VertexHelper vh, UnityEngine.Rect r, Color32 col, float px)
        {
            if (col.a == 0)
            {
                return;
            }
            float h = 0.5f * px;
            float ix0 = r.xMin + h, ix1 = r.xMax - h, iy0 = r.yMin + h, iy1 = r.yMax - h;
            float alpha = 1f;
            if (ix0 > ix1)
            {
                alpha *= r.width / px;
                ix0 = ix1 = r.center.x;
            }
            if (iy0 > iy1)
            {
                alpha *= r.height / px;
                iy0 = iy1 = r.center.y;
            }
            if (alpha < 1f)
            {
                col.a = (byte)Mathf.Clamp(Mathf.RoundToInt(col.a * alpha), 0, 255);
            }
            Color32 clear = col;
            clear.a = 0;

            int b = vh.currentVertCount;
            AddVertex(vh, new Vector2(r.xMin - h, r.yMin - h), clear);
            AddVertex(vh, new Vector2(r.xMin - h, r.yMax + h), clear);
            AddVertex(vh, new Vector2(r.xMax + h, r.yMax + h), clear);
            AddVertex(vh, new Vector2(r.xMax + h, r.yMin - h), clear);
            AddVertex(vh, new Vector2(ix0, iy0), col);
            AddVertex(vh, new Vector2(ix0, iy1), col);
            AddVertex(vh, new Vector2(ix1, iy1), col);
            AddVertex(vh, new Vector2(ix1, iy0), col);

            vh.AddTriangle(b + 4, b + 5, b + 6);
            vh.AddTriangle(b + 6, b + 7, b + 4);
            for (int k = 0; k < 4; k++)
            {
                int k1 = (k + 1) & 3;
                vh.AddTriangle(b + k, b + k1, b + 4 + k1);
                vh.AddTriangle(b + 4 + k1, b + 4 + k, b + k);
            }
        }

        private static void AddVertex(VertexHelper vh, Vector2 p, Color32 c)
        {
            s_Vertex.position = new Vector3(p.x, p.y, 0f);
            s_Vertex.color = c;
            vh.AddVert(s_Vertex);
        }

        private static Vector2 Direction(Vector2 from, Vector2 to, Vector2 fallback)
        {
            Vector2 d = to - from;
            float len = d.magnitude;
            return len > 1e-5f ? d / len : fallback;
        }

        private static Vector2 Perp(Vector2 d)
        {
            return new Vector2(-d.y, d.x);
        }

        private static Color32 Multiply(Color32 a, Color32 b)
        {
            return new Color32((byte)(a.r * b.r / 255), (byte)(a.g * b.g / 255), (byte)(a.b * b.b / 255), (byte)(a.a * b.a / 255));
        }

        // ---- command buffers (grow by doubling; steady-state redraws do not allocate)

        private void AddCmd(Kind kind, int start, int count, float width, Color32 color)
        {
            EnsureCmd();
            cmds[cmdCount++] = new Cmd { Kind = kind, Start = start, Count = count, Width = width, Color = color };
        }

        private void EnsureCmd()
        {
            if (cmdCount == cmds.Length)
            {
                Array.Resize(ref cmds, cmds.Length * 2);
            }
        }

        private int ReservePoints(int n)
        {
            int need = ptCount + n;
            if (need > pts.Length)
            {
                int size = pts.Length;
                while (size < need)
                {
                    size *= 2;
                }
                Array.Resize(ref pts, size);
            }
            int s = ptCount;
            ptCount = need;
            return s;
        }
    }
}

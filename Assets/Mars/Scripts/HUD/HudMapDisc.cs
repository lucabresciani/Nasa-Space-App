using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Circular map window of the compass dial: a 128-gon disc textured with an affine UV mapping (centre, and the UV step
    /// per local unit along +x and +y). Rotating or panning the map only rewrites the UVs: the quad itself never rotates,
    /// so nothing is pixel-snapped or resampled by a rotated RectTransform. The rim gets a 1-screen-pixel anti-aliased
    /// edge (no stencil mask, no jagged circle). Optionally owns its texture and destroys it with itself.
    /// Local coordinates: origin at the pivot (put it at the disc centre), y up. Not a raycast target.
    /// </summary>
    // Unity 6 uGUI: Graphic no longer requires a CanvasRenderer; declare it or the disc is never drawn.
    [DisallowMultipleComponent]
    [RequireComponent(typeof(CanvasRenderer))]
    public sealed class HudMapDisc : MaskableGraphic
    {
        private const int Segments = 128;

        private static UIVertex s_Vertex = UIVertex.simpleVert;
        private static Vector2[] s_Dirs;

        private Texture map;
        private bool ownsMap;
        private float radius = 100f;
        private Vector2 uvCenter = new Vector2(0.5f, 0.5f);
        private Vector2 uvAxisX = new Vector2(0.005f, 0f);
        private Vector2 uvAxisY = new Vector2(0f, 0.005f);
        private float builtPixel = -1f;

        public override Texture mainTexture => map != null ? map : s_WhiteTexture;

        protected override void Awake()
        {
            base.Awake();
            raycastTarget = false;
        }

        /// <summary>Sets the map texture; <paramref name="owned"/> = destroy it together with this component.</summary>
        public void SetTexture(Texture texture, bool owned)
        {
            if (ownsMap && map != null && map != texture)
            {
                Destroy(map);
            }
            map = texture;
            ownsMap = owned && texture != null;
            SetMaterialDirty();
            SetVerticesDirty();
        }

        /// <summary>Disc radius in local units.</summary>
        public void SetRadius(float r)
        {
            if (r != radius)
            {
                radius = r;
                SetVerticesDirty();
            }
        }

        /// <summary>
        /// UV at the disc centre and the UV change per local unit along local +x and +y. Rebuilds only on change (or when
        /// the screen pixel size changed, to keep the rim ramp at one pixel).
        /// </summary>
        public void SetMapping(Vector2 center, Vector2 axisX, Vector2 axisY)
        {
            bool changed = center != uvCenter || axisX != uvAxisX || axisY != uvAxisY;
            if (!changed && builtPixel > 0f)
            {
                float px = PixelSize();
                changed = Mathf.Abs(px - builtPixel) > builtPixel * 0.02f;
            }
            if (changed)
            {
                uvCenter = center;
                uvAxisX = axisX;
                uvAxisY = axisY;
                SetVerticesDirty();
            }
        }

        protected override void OnPopulateMesh(VertexHelper vh)
        {
            vh.Clear();
            if (s_Dirs == null)
            {
                s_Dirs = new Vector2[Segments];
                for (int i = 0; i < Segments; i++)
                {
                    float a = i * (2f * Mathf.PI / Segments);
                    s_Dirs[i] = new Vector2(Mathf.Cos(a), Mathf.Sin(a));
                }
            }

            float px = PixelSize();
            builtPixel = px;
            Color32 ink = color;
            Color32 clear = ink;
            clear.a = 0;
            float rIn = Mathf.Max(0f, radius - 0.5f * px);
            float rOut = radius + 0.5f * px;

            Add(vh, Vector2.zero, ink);
            for (int i = 0; i < Segments; i++)
            {
                Vector2 d = s_Dirs[i];
                Add(vh, d * rIn, ink);
                Add(vh, d * rOut, clear);
            }
            for (int i = 0; i < Segments; i++)
            {
                int a = 1 + 2 * i;
                int b = 1 + 2 * ((i + 1) % Segments);
                vh.AddTriangle(0, a, b);
                vh.AddTriangle(a, a + 1, b + 1);
                vh.AddTriangle(b + 1, b, a);
            }
        }

        private void Add(VertexHelper vh, Vector2 p, Color32 c)
        {
            Vector2 uv = uvCenter + p.x * uvAxisX + p.y * uvAxisY;
            s_Vertex.position = new Vector3(p.x, p.y, 0f);
            s_Vertex.color = c;
            s_Vertex.uv0 = new Vector4(uv.x, uv.y, 0f, 0f);
            vh.AddVert(s_Vertex);
        }

        // One screen pixel in local units (same rule as HudLineMesh).
        private float PixelSize()
        {
            Canvas c = canvas;
            if (c == null)
            {
                return 1f;
            }
            Canvas root = c.rootCanvas;
            float s = root != null && root.renderMode == RenderMode.ScreenSpaceOverlay
                ? Mathf.Abs(transform.lossyScale.x)
                : (root != null ? root.scaleFactor : c.scaleFactor);
            return s > 1e-5f ? 1f / s : 1f;
        }

        protected override void OnDestroy()
        {
            if (ownsMap && map != null)
            {
                Destroy(map);
            }
            map = null;
            base.OnDestroy();
        }
    }
}

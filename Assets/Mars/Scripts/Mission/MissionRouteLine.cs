using System.Collections.Generic;
using NasaSpaceApp.Homeline.Sim;
using UnityEngine;
using UnityEngine.Rendering;

namespace NasaSpaceApp.Mission
{
    /// <summary>
    /// Route guidance in the 3D world for a mission from the planner: the planned route as a thin amber line on the
    /// ground, with a post at the pad and at every waypoint. The same picture as the guidance of the built-in plans
    /// (Homeline/World/RouteWorldView.cs), which works on that plan type only.
    ///
    /// Only what is near the crew is drawn: the stretch of the route within <see cref="LineRadiusM"/> (fading out at
    /// both ends) and the posts within <see cref="PostRadiusM"/>. Built at run time, no scene edits; the material
    /// uses a built-in unlit shader, so it needs no asset.
    /// </summary>
    public sealed class MissionRouteLine : MonoBehaviour
    {
        public const float LineRadiusM = 45f, PostRadiusM = 70f;

        const float LineLift = 0.10f, LineWidth = 0.22f;
        const float PostHeight = 6f, PostWidth = 0.32f;
        const float RefreshSeconds = 0.12f;
        const int MaxRuns = 8;

        static readonly Color RouteColor = new Color(1.00f, 0.74f, 0.22f, 0.72f);
        static readonly Color WaypointColor = new Color(0.35f, 0.92f, 1.00f, 0.80f);
        static readonly Color PadColor = new Color(1.00f, 1.00f, 1.00f, 0.85f);

        Material material;
        readonly List<GameObject> parts = new List<GameObject>();
        readonly List<Vector3[]> legs = new List<Vector3[]>();
        readonly List<LineRenderer> runs = new List<LineRenderer>();
        readonly List<GameObject> posts = new List<GameObject>();
        readonly List<Vector3> postFeet = new List<Vector3>();
        float nextRefresh;
        bool drawn;

        /// <summary>The crew: guidance is drawn around this transform.</summary>
        public Transform Viewer;
        /// <summary>True when the guidance is switched on (the near part of it is then drawn).</summary>
        public bool Visible { get; private set; }
        /// <summary>Route vertices drawn now, and in the whole mission.</summary>
        public int ShownPoints { get; private set; }
        public int TotalPoints { get; private set; }

        public static MissionRouteLine Create(Transform parent)
        {
            var go = new GameObject("Mission Route Line");
            go.transform.SetParent(parent, false);
            return go.AddComponent<MissionRouteLine>();
        }

        public void SetVisible(bool visible)
        {
            Visible = visible;
            Refresh();
        }

        public void Show(MissionPlan plan, GroundSampler ground)
        {
            Clear();
            if (plan == null || ground == null) return;
            if (material == null)
            {
                Shader shader = Shader.Find("Sprites/Default");
                if (shader == null) shader = Shader.Find("Universal Render Pipeline/Unlit");
                if (shader == null)
                {
                    Debug.LogWarning("[Mission] no unlit shader found: the route line is not drawn");
                    return;
                }
                material = new Material(shader) { name = "Mission Route Line" };
            }

            Vector3[] route = plan.Route;
            int n = route != null ? route.Length : 0;
            foreach (MissionLeg leg in plan.Legs)
            {
                if (!leg.Routed || leg.FirstPoint < 0 || leg.PointCount < 2 || leg.FirstPoint + 1 >= n) continue;
                int first = leg.FirstPoint, last = Mathf.Min(n - 1, leg.FirstPoint + leg.PointCount - 1);
                int m = last - first + 1;
                // The route follows the cells of the planner's grid, a fine sawtooth: the drawn line is smoothed (a
                // few metres of running mean, ends kept), which moves it by well under a metre.
                var x = new double[m];
                var z = new double[m];
                for (int i = 0; i < m; i++)
                {
                    x[i] = route[first + i].x;
                    z[i] = route[first + i].z;
                }
                x = Smooth(Smooth(x));
                z = Smooth(Smooth(z));
                var points = new Vector3[m];
                for (int i = 0; i < m; i++) points[i] = ground.OnGround(x[i], z[i], LineLift);
                legs.Add(points);
                TotalPoints += m;
            }

            // A few line renderers shared by the stretches of route near the crew (the route can pass close twice).
            var fade = new Gradient();
            fade.SetKeys(new[] { new GradientColorKey(RouteColor, 0f), new GradientColorKey(RouteColor, 1f) },
                         new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(RouteColor.a, 0.22f), new GradientAlphaKey(RouteColor.a, 0.78f), new GradientAlphaKey(0f, 1f) });
            for (int i = 0; i < MaxRuns; i++)
            {
                LineRenderer line = NewLine("Route near " + i, RouteColor, LineWidth);
                // Lie flat on the ground like a painted track: the line faces the object's Z axis, turned to point up.
                line.alignment = LineAlignment.TransformZ;
                line.transform.rotation = Quaternion.Euler(-90f, 0f, 0f);
                line.numCornerVertices = 2;
                line.colorGradient = fade;
                line.gameObject.SetActive(false);
                runs.Add(line);
            }

            AddPost("Post pad", ground.OnGround(plan.PadWorld.x, plan.PadWorld.z, 0f), PadColor);
            foreach (MissionWaypoint w in plan.Waypoints)
                AddPost("Post " + w.Index, ground.OnGround(w.World.x, w.World.z, 0f), WaypointColor);
            Refresh();
        }

        void AddPost(string name, Vector3 foot, Color color)
        {
            LineRenderer post = NewLine(name, color, PostWidth);
            post.positionCount = 2;
            post.SetPosition(0, foot);
            post.SetPosition(1, foot + Vector3.up * PostHeight);
            post.gameObject.SetActive(false);
            posts.Add(post.gameObject);
            postFeet.Add(foot);
        }

        public void Clear()
        {
            foreach (GameObject g in parts)
                if (g != null) Destroy(g);
            parts.Clear();
            legs.Clear();
            runs.Clear();
            posts.Clear();
            postFeet.Clear();
            TotalPoints = ShownPoints = 0;
            drawn = false;
        }

        void LateUpdate()
        {
            if (!Visible && !drawn) return;
            if (Time.unscaledTime < nextRefresh) return;
            Refresh();
        }

        // Draws the stretch of the route and the posts that are near the viewer; hides everything when switched off.
        void Refresh()
        {
            nextRefresh = Time.unscaledTime + RefreshSeconds;
            int run = 0, shown = 0, shownPosts = 0;
            if (Visible && Viewer != null)
            {
                Vector3 p = Viewer.position;
                float r2 = LineRadiusM * LineRadiusM;
                foreach (Vector3[] points in legs)
                {
                    int start = -1;
                    for (int i = 0; i < points.Length; i++)
                    {
                        float dx = points[i].x - p.x, dz = points[i].z - p.z;
                        bool inside = dx * dx + dz * dz <= r2;
                        if (inside && start < 0) start = i;
                        bool last = i == points.Length - 1;
                        if (start >= 0 && (!inside || last))
                        {
                            int end = inside ? i : i - 1;
                            if (end > start && run < runs.Count)
                            {
                                LineRenderer line = runs[run++];
                                int count = end - start + 1;
                                line.positionCount = count;
                                for (int k = 0; k < count; k++) line.SetPosition(k, points[start + k]);
                                if (!line.gameObject.activeSelf) line.gameObject.SetActive(true);
                                shown += count;
                            }
                            start = -1;
                        }
                    }
                }
                float b2 = PostRadiusM * PostRadiusM;
                for (int i = 0; i < posts.Count; i++)
                {
                    float dx = postFeet[i].x - p.x, dz = postFeet[i].z - p.z;
                    bool near = dx * dx + dz * dz <= b2;
                    if (posts[i].activeSelf != near) posts[i].SetActive(near);
                    if (near) shownPosts++;
                }
            }
            else
            {
                foreach (GameObject post in posts)
                    if (post != null && post.activeSelf) post.SetActive(false);
            }
            for (int i = run; i < runs.Count; i++)
                if (runs[i] != null && runs[i].gameObject.activeSelf) runs[i].gameObject.SetActive(false);
            ShownPoints = shown;
            drawn = shown > 0 || shownPosts > 0;
        }

        // Running mean over five vertices; the window shrinks towards the two ends, which stay in place.
        static double[] Smooth(double[] v)
        {
            int n = v.Length;
            var o = new double[n];
            for (int i = 0; i < n; i++)
            {
                int r = System.Math.Min(2, System.Math.Min(i, n - 1 - i));
                double sum = 0;
                for (int k = i - r; k <= i + r; k++) sum += v[k];
                o[i] = sum / (2 * r + 1);
            }
            return o;
        }

        LineRenderer NewLine(string name, Color color, float width)
        {
            var go = new GameObject(name);
            go.transform.SetParent(transform, false);
            parts.Add(go);
            var line = go.AddComponent<LineRenderer>();
            line.sharedMaterial = material;
            line.useWorldSpace = true;
            line.startColor = color;
            line.endColor = color;
            line.widthMultiplier = width;
            line.shadowCastingMode = ShadowCastingMode.Off;
            line.receiveShadows = false;
            line.lightProbeUsage = LightProbeUsage.Off;
            line.reflectionProbeUsage = ReflectionProbeUsage.Off;
            line.alignment = LineAlignment.View;
            line.textureMode = LineTextureMode.Stretch;
            return line;
        }

        void OnDestroy()
        {
            if (material != null) Destroy(material);
        }
    }
}

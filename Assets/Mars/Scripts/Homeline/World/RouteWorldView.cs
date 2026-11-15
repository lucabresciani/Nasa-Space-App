using System.Collections.Generic;
using NasaSpaceApp.Homeline.Sim;
using UnityEngine;
using UnityEngine.Rendering;

namespace NasaSpaceApp.Homeline.World
{
    /// <summary>
    /// Route guidance in the 3D world: the planned route as a thin amber line on the ground, a post at the rover and
    /// at every station, a small post at every navigation point.
    ///
    /// It is a simulator aid, not part of the scene, so it is OFF by default (key R turns it on). When it is on, only
    /// what is near the crew is drawn: the stretch of the route within <see cref="RibbonRadiusM"/> (fading out at
    /// both ends) and the posts within <see cref="BeaconRadiusM"/>. Nothing is visible from far away.
    ///
    /// Everything is placed on the ground of this scene (planner positions carry no usable height here). Built at
    /// run time, no scene edits; the material uses a built-in unlit shader so it needs no asset and is present in a
    /// player build.
    /// </summary>
    public sealed class RouteWorldView : MonoBehaviour
    {
        /// <summary>How far from the crew the route line and the posts are drawn, metres.</summary>
        public const float RibbonRadiusM = 45f, BeaconRadiusM = 70f;

        const float RibbonLift = 0.10f, RibbonWidth = 0.22f;
        const float BeaconHeight = 6f, BeaconWidth = 0.32f;
        const float NavHeight = 2.2f, NavWidth = 0.14f;
        const float RefreshSeconds = 0.12f;
        const int MaxRuns = 8;

        static readonly Color RouteColor = new Color(1.00f, 0.74f, 0.22f, 0.72f);
        static readonly Color StationColor = new Color(0.35f, 0.92f, 1.00f, 0.80f);
        static readonly Color PadColor = new Color(1.00f, 1.00f, 1.00f, 0.85f);
        static readonly Color NavColor = new Color(1.00f, 0.74f, 0.22f, 0.60f);

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

        /// <summary>True when the guidance is switched on (the near part of it is then drawn). Kept across plans.</summary>
        public bool RibbonVisible { get; private set; }

        /// <summary>Route vertices drawn now / in the whole plan, and posts drawn now / in the whole plan.</summary>
        public int ShownPoints { get; private set; }
        public int TotalPoints { get; private set; }
        public int ShownPosts { get; private set; }
        public int TotalPosts { get { return posts.Count; } }

        public void SetRibbonVisible(bool visible)
        {
            RibbonVisible = visible;
            Refresh();
        }

        public static RouteWorldView Create(Transform parent)
        {
            var go = new GameObject("HOMELINE Route");
            go.transform.SetParent(parent, false);
            return go.AddComponent<RouteWorldView>();
        }

        public void Show(MissionPlan plan, GroundSampler ground)
        {
            Clear();
            if (material == null)
            {
                Shader shader = Shader.Find("Sprites/Default");
                if (shader == null) shader = Shader.Find("Universal Render Pipeline/Unlit");
                if (shader == null)
                {
                    Debug.LogWarning("[HOMELINE] no unlit shader found: the route is not drawn");
                    return;
                }
                material = new Material(shader) { name = "HOMELINE Route" };
            }

            foreach (RouteLeg leg in plan.Track.Legs)
            {
                var points = new Vector3[leg.X.Length];
                for (int i = 0; i < points.Length; i++)
                {
                    double wx, wz;
                    plan.Frame.LocalToWorld(leg.X[i], leg.Y[i], out wx, out wz);
                    points[i] = ground.OnGround(wx, wz, RibbonLift);
                }
                legs.Add(points);
                TotalPoints += points.Length;
            }

            // A few line renderers shared by the stretches of route near the crew (the route can pass close twice).
            var fade = new Gradient();
            fade.SetKeys(new[] { new GradientColorKey(RouteColor, 0f), new GradientColorKey(RouteColor, 1f) },
                         new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(RouteColor.a, 0.22f), new GradientAlphaKey(RouteColor.a, 0.78f), new GradientAlphaKey(0f, 1f) });
            for (int i = 0; i < MaxRuns; i++)
            {
                LineRenderer line = NewLine("Route near " + i, RouteColor, RibbonWidth);
                // Lie flat on the ground like a painted track: the line faces the object's Z axis, turned to point up.
                line.alignment = LineAlignment.TransformZ;
                line.transform.rotation = Quaternion.Euler(-90f, 0f, 0f);
                line.numCornerVertices = 2;
                line.colorGradient = fade;
                line.gameObject.SetActive(false);
                runs.Add(line);
            }

            foreach (Waypoint w in plan.Waypoints.All)
            {
                if (w.Kind == WaypointKind.Return) continue; // same place as the pad
                double wx, wz;
                plan.Frame.LocalToWorld(w.X, w.Y, out wx, out wz);
                Vector3 foot = ground.OnGround(wx, wz, 0f);
                bool nav = w.Kind == WaypointKind.Nav;
                Color c = nav ? NavColor : (w.Kind == WaypointKind.Pad ? PadColor : StationColor);
                LineRenderer post = NewLine((nav ? "Nav " : "Post ") + w.Id, c, nav ? NavWidth : BeaconWidth);
                post.positionCount = 2;
                post.SetPosition(0, foot);
                post.SetPosition(1, foot + Vector3.up * (nav ? NavHeight : BeaconHeight));
                post.gameObject.SetActive(false);
                posts.Add(post.gameObject);
                postFeet.Add(foot);
            }
            Refresh();
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
            TotalPoints = ShownPoints = ShownPosts = 0;
            drawn = false;
        }

        void LateUpdate()
        {
            if (!RibbonVisible && !drawn) return;
            if (Time.unscaledTime < nextRefresh) return;
            Refresh();
        }

        /// <summary>Draws the stretch of the route and the posts that are near the viewer; hides everything when switched off.</summary>
        void Refresh()
        {
            nextRefresh = Time.unscaledTime + RefreshSeconds;
            int run = 0, shown = 0, shownPosts = 0;
            if (RibbonVisible && Viewer != null)
            {
                Vector3 p = Viewer.position;
                float r2 = RibbonRadiusM * RibbonRadiusM;
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
                                int n = end - start + 1;
                                line.positionCount = n;
                                for (int k = 0; k < n; k++) line.SetPosition(k, points[start + k]);
                                if (!line.gameObject.activeSelf) line.gameObject.SetActive(true);
                                shown += n;
                            }
                            start = -1;
                        }
                    }
                }
                float b2 = BeaconRadiusM * BeaconRadiusM;
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
            ShownPosts = shownPosts;
            drawn = shown > 0 || shownPosts > 0;
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

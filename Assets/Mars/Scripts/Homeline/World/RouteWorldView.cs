using System.Collections.Generic;
using NasaSpaceApp.Homeline.Sim;
using UnityEngine;
using UnityEngine.Rendering;

namespace NasaSpaceApp.Homeline.World
{
    /// <summary>
    /// The plan drawn in the 3D world: the planner's route as a ribbon on the ground, a tall beacon at the pad and at
    /// every station, a short post at every navigation point. Everything is placed on the ground of this scene
    /// (planner positions carry no usable height here). Built at run time, no scene edits; the material uses a
    /// built-in unlit shader so it needs no asset and is present in a player build.
    /// </summary>
    public sealed class RouteWorldView : MonoBehaviour
    {
        const float RibbonLift = 0.12f, RibbonWidth = 0.45f;
        const float BeaconHeight = 90f, BeaconWidth = 1.4f;
        const float NavHeight = 5f, NavWidth = 0.3f;

        static readonly Color RouteColor = new Color(1.00f, 0.74f, 0.22f, 0.92f);
        static readonly Color StationColor = new Color(0.35f, 0.92f, 1.00f, 0.90f);
        static readonly Color PadColor = new Color(1.00f, 1.00f, 1.00f, 0.95f);
        static readonly Color NavColor = new Color(1.00f, 0.74f, 0.22f, 0.80f);

        Material material;
        readonly List<GameObject> parts = new List<GameObject>();
        readonly List<GameObject> ribbon = new List<GameObject>();

        /// <summary>The amber track on the ground; the beacons stay when it is hidden. Kept across plans.</summary>
        public bool RibbonVisible { get; private set; } = true;

        public void SetRibbonVisible(bool visible)
        {
            RibbonVisible = visible;
            foreach (GameObject g in ribbon)
                if (g != null) g.SetActive(visible);
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

            var buffer = new List<Vector3>(1024);
            foreach (RouteLeg leg in plan.Track.Legs)
            {
                buffer.Clear();
                for (int i = 0; i < leg.X.Length; i++)
                {
                    double wx, wz;
                    plan.Frame.LocalToWorld(leg.X[i], leg.Y[i], out wx, out wz);
                    buffer.Add(ground.OnGround(wx, wz, RibbonLift));
                }
                LineRenderer line = NewLine("Leg " + leg.Number, RouteColor, RibbonWidth);
                ribbon.Add(line.gameObject);
                line.gameObject.SetActive(RibbonVisible);
                // Lie flat on the ground like a painted track: the ribbon faces the object's Z axis, turned to point up.
                line.alignment = LineAlignment.TransformZ;
                line.transform.rotation = Quaternion.Euler(-90f, 0f, 0f);
                line.positionCount = buffer.Count;
                line.SetPositions(buffer.ToArray());
                line.numCornerVertices = 2;
            }

            foreach (Waypoint w in plan.Waypoints.All)
            {
                if (w.Kind == WaypointKind.Return) continue; // same place as the pad
                double wx, wz;
                plan.Frame.LocalToWorld(w.X, w.Y, out wx, out wz);
                Vector3 foot = ground.OnGround(wx, wz, 0f);
                bool nav = w.Kind == WaypointKind.Nav;
                Color c = nav ? NavColor : (w.Kind == WaypointKind.Pad ? PadColor : StationColor);
                LineRenderer post = NewLine((nav ? "Nav " : "Beacon ") + w.Id, c, nav ? NavWidth : BeaconWidth);
                post.positionCount = 2;
                post.SetPosition(0, foot);
                post.SetPosition(1, foot + Vector3.up * (nav ? NavHeight : BeaconHeight));
            }
        }

        public void Clear()
        {
            foreach (GameObject g in parts)
                if (g != null) Destroy(g);
            parts.Clear();
            ribbon.Clear();
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

using NasaSpaceApp.Mission;
using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>Colours and widths of the web Mission Planer's route on the HUD maps.</summary>
    public static class MissionRouteStyle
    {
        /// <summary>Planned outbound legs (pad → waypoints). Violet: distinct from slope, unit, contour and accent colours.</summary>
        public static readonly Color Route = HudTokens.Hex(0xC59BFF, 1f);
        /// <summary>The planned way home (last waypoint → pad, WS2 pointer path): the same hue, dimmer.</summary>
        public static readonly Color RouteHome = HudTokens.Light(0xC59BFF, 0.55f);
        public const float Width = 2f, HaloWidth = 4.5f, HomeWidth = 1.5f, HomeHaloWidth = 3.5f;
        public const float WaypointRadius = 6f, DialWaypointRadius = 4.5f;
    }

    /// <summary>
    /// Draws a <see cref="MissionPlan"/> route into a <see cref="HudLineMesh"/> through an affine map world XZ → local
    /// (local = ax·(x − origin.x) + ay·(z − origin.y)), clipped to a circle (the compass dial) or a rectangle (the map
    /// screen) so off-screen parts cost nothing. Points closer than <see cref="MinStep"/> local units are merged, so a
    /// zoomed-out 5 m-grid route stays light. Halos are drawn under all strokes. Buffers are reused (no per-frame GC once
    /// grown).
    /// </summary>
    public sealed class MissionRouteDrawer
    {
        public enum ClipShape { Circle, Rect }

        private const float MinStep = 1.5f;

        private Vector2[] pts = new Vector2[256];
        private Vector2[] scratch = new Vector2[256];
        private int[] runStart = new int[16], runCount = new int[16];
        private bool[] runHome = new bool[16];
        private int runs, used;

        private MissionPlan cachedPlan;
        private bool[] homeByLeg = new bool[8];

        /// <summary>World XZ → local under the map (origin, ax, ay).</summary>
        public static Vector2 Local(Vector3 world, Vector2 origin, Vector2 ax, Vector2 ay)
        {
            float dx = world.x - origin.x, dz = world.z - origin.y;
            return ax * dx + ay * dz;
        }

        /// <summary>True when <paramref name="p"/> lies inside the clip shape (circle: extent.x = radius; rect: half sizes).</summary>
        public static bool Inside(Vector2 p, ClipShape clip, Vector2 extent)
        {
            return clip == ClipShape.Circle
                ? p.sqrMagnitude <= extent.x * extent.x
                : Mathf.Abs(p.x) <= extent.x && Mathf.Abs(p.y) <= extent.y;
        }

        /// <summary>Adds the route (halos, then outbound and home strokes) to <paramref name="mesh"/>; no Clear/Commit.</summary>
        public void DrawRoute(HudLineMesh mesh, MissionPlan plan, Vector2 origin, Vector2 ax, Vector2 ay, ClipShape clip, Vector2 extent)
        {
            if (mesh == null || plan == null || plan.Route == null || plan.Route.Length < 2)
            {
                return;
            }
            CacheLegs(plan);
            Collect(plan, origin, ax, ay, clip, extent);
            for (int k = 0; k < runs; k++)
            {
                Emit(mesh, k, runHome[k] ? MissionRouteStyle.HomeHaloWidth : MissionRouteStyle.HaloWidth, HudTokens.Halo);
            }
            for (int k = 0; k < runs; k++)
            {
                if (runHome[k]) Emit(mesh, k, MissionRouteStyle.HomeWidth, MissionRouteStyle.RouteHome);
            }
            for (int k = 0; k < runs; k++)
            {
                if (!runHome[k]) Emit(mesh, k, MissionRouteStyle.Width, MissionRouteStyle.Route);
            }
        }

        /// <summary>Adds a ring per waypoint inside the clip shape; no Clear/Commit.</summary>
        public static void DrawWaypoints(HudLineMesh mesh, MissionPlan plan, Vector2 origin, Vector2 ax, Vector2 ay,
                                         ClipShape clip, Vector2 extent, float radius)
        {
            if (mesh == null || plan == null)
            {
                return;
            }
            for (int i = 0; i < plan.Waypoints.Count; i++)
            {
                Vector2 c = Local(plan.Waypoints[i].World, origin, ax, ay);
                if (!Inside(c, clip, extent))
                {
                    continue;
                }
                mesh.Ring(c, radius, 3.5f, HudTokens.Halo, 20);
                mesh.Ring(c, radius, 2f, MissionRouteStyle.Route, 20);
            }
        }

        private void CacheLegs(MissionPlan plan)
        {
            if (ReferenceEquals(plan, cachedPlan))
            {
                return;
            }
            cachedPlan = plan;
            int max = 0;
            foreach (MissionLeg l in plan.Legs) max = Mathf.Max(max, l.Leg);
            if (homeByLeg.Length <= max) homeByLeg = new bool[max + 1];
            System.Array.Clear(homeByLeg, 0, homeByLeg.Length);
            foreach (MissionLeg l in plan.Legs)
            {
                if (l.Leg >= 0) homeByLeg[l.Leg] = l.IsHome;
            }
        }

        private bool IsHome(int leg) => (uint)leg < (uint)homeByLeg.Length && homeByLeg[leg];

        // Clips every segment, chaining consecutive visible pieces of the same leg kind into runs.
        private void Collect(MissionPlan plan, Vector2 origin, Vector2 ax, Vector2 ay, ClipShape clip, Vector2 extent)
        {
            runs = used = 0;
            Vector3[] route = plan.Route;
            int[] legs = plan.RouteLeg;
            bool open = false, openHome = false;
            Vector2 prev = Local(route[0], origin, ax, ay);
            for (int i = 1; i < route.Length; i++)
            {
                Vector2 a = prev, b = Local(route[i], origin, ax, ay);
                prev = b;
                bool home = IsHome(legs[i]);
                if (!ClipSegment(ref a, ref b, out bool aCut, out bool bCut, clip, extent))
                {
                    open = false;
                    continue;
                }
                if (!open || aCut || home != openHome)
                {
                    BeginRun(home);
                    Append(a);
                    openHome = home;
                }
                AppendMerged(b);
                open = !bCut;
            }
        }

        private void BeginRun(bool home)
        {
            if (runs == runStart.Length)
            {
                System.Array.Resize(ref runStart, runs * 2);
                System.Array.Resize(ref runCount, runs * 2);
                System.Array.Resize(ref runHome, runs * 2);
            }
            runStart[runs] = used;
            runCount[runs] = 0;
            runHome[runs] = home;
            runs++;
        }

        private void Append(Vector2 p)
        {
            if (used == pts.Length)
            {
                System.Array.Resize(ref pts, used * 2);
            }
            pts[used++] = p;
            runCount[runs - 1]++;
        }

        // Keeps the run's end exact: a point too close to the one before the tail replaces the tail.
        private void AppendMerged(Vector2 p)
        {
            int n = runCount[runs - 1];
            if (n >= 2 && (p - pts[used - 2]).sqrMagnitude < MinStep * MinStep)
            {
                pts[used - 1] = p;
                return;
            }
            Append(p);
        }

        private void Emit(HudLineMesh mesh, int run, float width, Color32 color)
        {
            int n = runCount[run];
            if (n < 2)
            {
                return;
            }
            if (scratch.Length < n)
            {
                scratch = new Vector2[Mathf.NextPowerOfTwo(n)];
            }
            System.Array.Copy(pts, runStart[run], scratch, 0, n);
            mesh.Polyline(scratch, n, width, color);
        }

        // Clips segment a→b to the shape; aCut/bCut = that end was moved onto the border. False = fully outside.
        private static bool ClipSegment(ref Vector2 a, ref Vector2 b, out bool aCut, out bool bCut, ClipShape clip, Vector2 extent)
        {
            aCut = bCut = false;
            Vector2 d = b - a;
            float t0 = 0f, t1 = 1f;
            if (clip == ClipShape.Circle)
            {
                float r = extent.x;
                float qa = Vector2.Dot(d, d), qb = 2f * Vector2.Dot(a, d), qc = Vector2.Dot(a, a) - r * r;
                if (qa < 1e-12f)
                {
                    return qc <= 0f;
                }
                float disc = qb * qb - 4f * qa * qc;
                if (disc < 0f)
                {
                    return false;
                }
                float s = Mathf.Sqrt(disc);
                float e0 = (-qb - s) / (2f * qa), e1 = (-qb + s) / (2f * qa);
                t0 = Mathf.Max(0f, e0);
                t1 = Mathf.Min(1f, e1);
                if (t0 > t1)
                {
                    return false;
                }
            }
            else
            {
                // Liang–Barsky against |x| <= extent.x, |y| <= extent.y.
                if (!Edge(-d.x, a.x + extent.x, ref t0, ref t1) || !Edge(d.x, extent.x - a.x, ref t0, ref t1)
                    || !Edge(-d.y, a.y + extent.y, ref t0, ref t1) || !Edge(d.y, extent.y - a.y, ref t0, ref t1))
                {
                    return false;
                }
            }
            Vector2 a0 = a;
            if (t1 < 1f)
            {
                b = a0 + d * t1;
                bCut = true;
            }
            if (t0 > 0f)
            {
                a = a0 + d * t0;
                aCut = true;
            }
            return true;
        }

        private static bool Edge(float p, float q, ref float t0, ref float t1)
        {
            if (Mathf.Abs(p) < 1e-12f)
            {
                return q >= 0f;
            }
            float t = q / p;
            if (p < 0f)
            {
                if (t > t1) return false;
                if (t > t0) t0 = t;
            }
            else
            {
                if (t < t0) return false;
                if (t < t1) t1 = t;
            }
            return true;
        }
    }
}

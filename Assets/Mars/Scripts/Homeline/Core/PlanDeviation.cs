using System;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// Where a free-walking crew is relative to the planned route, from <see cref="PlanDeviation.Update"/>: the point
    /// of route.json it is snapped to and what the plan says there. Distances are horizontal metres in the pad-local
    /// frame; s is on the scale of the s_m column of route.json.
    /// </summary>
    public struct DeviationSample
    {
        /// <summary>Active leg after this update: index in RouteTrack.Legs.</summary>
        public int LegIndex;
        /// <summary>The planner's number of the active leg (1-based).</summary>
        public int LegNumber;
        /// <summary>Progress along the active leg, metres. Never decreases while the leg stays active.</summary>
        public double SLegM;
        /// <summary>Progress along the whole route, metres: the legs before the active one plus SLegM.</summary>
        public double STotalM;
        /// <summary>Horizontal distance from the crew to the snapped point, metres (cross-track).</summary>
        public double CrossTrackM;
        public double SnapX;
        public double SnapY;
        /// <summary>null where the route rows have no terrain height.</summary>
        public double? SnapZ;
        /// <summary>
        /// The planned EVA minute at the snapped point, from the t_eva_min column (linear between rows). At s = 0 of a
        /// leg that starts at a station this is the planned DEPARTURE from that station: the dwell is the gap before it
        /// (the planned arrival is the previous leg's EndMin).
        /// </summary>
        public double TPlanMin;
        /// <summary>Index of the leg this update completed (the crew came within the leg-end radius), else -1.</summary>
        public int CompletedLegIndex;
        /// <summary>True once the end of the last leg has been reached (back at the pad).</summary>
        public bool RouteComplete;
    }

    /// <summary>
    /// Tracks a free-walking crew against the planned route of route.json (contracts/bundle/README.md,
    /// contracts/bundle/route_local.schema.json), through <see cref="RouteTrack"/>. The planner has no counterpart to
    /// port: its HUD keeps the marker ON the route (web/src/hud/plan.ts stateAt, web/src/hud/drift.ts). This class only
    /// measures; it defines NO threshold (off-route distance, behind-schedule time): the planner defines none, so
    /// any would be invented. Planned O2 at the snapped point is Timeline.O2LeftAt(TPlanMin).
    /// Snap rule (verified on the official route, where consecutive legs overlap and cross near the stations, so a
    /// nearest-point search over the whole route picks the wrong leg there): the active leg is kept; the nearest point
    /// is searched on that leg only, FORWARD ONLY, from the progress already made to a window ahead of it; the next
    /// leg becomes active only when the crew comes within a radius of the active leg's end, or when the caller says
    /// so with <see cref="NotifyLegComplete"/>.
    /// </summary>
    public sealed class PlanDeviation
    {
        /// <summary>
        /// ASSUMED (not a planner value): how far ahead of the progress already made the snap may look, metres. Large
        /// enough to catch up after a shortcut over a few updates, small enough not to jump to a later part of the same
        /// leg that passes close by.
        /// </summary>
        public const double AssumedWindowM = 60.0;

        /// <summary>
        /// ASSUMED (the planner defines no arrival radius): the crew has reached a leg's end when it is within this
        /// horizontal distance of the leg's last point, metres. 5 m is the planner's position sigma at a station fix
        /// (config/hud.yaml fix_sigma_m.station), used here only as a plausible size.
        /// </summary>
        public const double AssumedLegEndRadiusM = 5.0;

        readonly RouteTrack route;
        readonly double windowM;
        readonly double legEndRadiusM;
        int leg;
        double s;
        bool complete;

        public RouteTrack Route { get { return route; } }
        /// <summary>Active leg: index in RouteTrack.Legs.</summary>
        public int LegIndex { get { return leg; } }
        /// <summary>Progress along the active leg, metres.</summary>
        public double SLegM { get { return s; } }
        public bool RouteComplete { get { return complete; } }
        public double WindowM { get { return windowM; } }
        public double LegEndRadiusM { get { return legEndRadiusM; } }

        /// <param name="route">The planned route; it must have at least one leg.</param>
        /// <param name="windowM">Forward search window, metres (see <see cref="AssumedWindowM"/>).</param>
        /// <param name="legEndRadiusM">
        /// Leg-end radius, metres (see <see cref="AssumedLegEndRadiusM"/>); 0 turns the automatic advance off, the
        /// caller then advances with <see cref="NotifyLegComplete"/>.
        /// </param>
        public PlanDeviation(RouteTrack route, double windowM = AssumedWindowM, double legEndRadiusM = AssumedLegEndRadiusM)
        {
            if (route == null) throw new ArgumentNullException("route");
            if (route.Legs.Count == 0) throw new ArgumentException("the route has no legs: nothing to track");
            if (!(windowM > 0)) throw new ArgumentException("the search window must be positive");
            this.route = route;
            this.windowM = windowM;
            this.legEndRadiusM = legEndRadiusM > 0 ? legEndRadiusM : 0.0;
        }

        /// <summary>Back to the start of the route (first leg, s = 0).</summary>
        public void Reset()
        {
            leg = 0;
            s = 0;
            complete = false;
        }

        /// <summary>Puts the tracker on a leg at a progress (clamped to the leg), e.g. after a teleport.</summary>
        public void Seek(int legIndex, double sLegM)
        {
            if (legIndex < 0 || legIndex >= route.Legs.Count) throw new ArgumentOutOfRangeException("legIndex");
            leg = legIndex;
            s = Math.Min(Math.Max(sLegM, 0.0), route.Legs[legIndex].ArcLengthM);
            complete = false;
        }

        /// <summary>
        /// Puts the tracker where the plan is at an EVA minute: on the leg walked at that time; during a dwell at the
        /// start of the leg that leaves the station; after the return at the end of the last leg (route complete).
        /// </summary>
        public void SeekTime(double tEvaMin)
        {
            RoutePose p = route.PoseAt(tEvaMin, 0.0);
            if (p.Phase == RoutePhase.Dwell) Seek(p.LegIndex + 1, 0.0);
            else Seek(p.LegIndex, p.SLegM);
            complete = p.Phase == RoutePhase.After;
        }

        /// <summary>
        /// The caller declares the active leg done (e.g. its own station logic saw the arrival): the next leg becomes
        /// active at s = 0. On the last leg the route is marked complete instead. Returns true when a next leg became
        /// active.
        /// </summary>
        public bool NotifyLegComplete()
        {
            if (leg + 1 < route.Legs.Count)
            {
                leg++;
                s = 0;
                return true;
            }
            s = route.Legs[leg].ArcLengthM;
            complete = true;
            return false;
        }

        /// <summary>
        /// Snaps the crew position (pad-local metres, x east, y north) to the route and returns the deviation. Call it
        /// with every new position; at most one leg is completed per call.
        /// </summary>
        public DeviationSample Update(double x, double y)
        {
            var o = new DeviationSample();
            o.CompletedLegIndex = -1;

            RouteLeg g = route.Legs[leg];
            int n = g.RowCount;
            if (legEndRadiusM > 0 && !complete)
            {
                double ex = g.X[n - 1] - x, ey = g.Y[n - 1] - y;
                if (Math.Sqrt(ex * ex + ey * ey) <= legEndRadiusM)
                {
                    o.CompletedLegIndex = leg;
                    NotifyLegComplete();
                    g = route.Legs[leg];
                    n = g.RowCount;
                }
            }

            double len = g.ArcLengthM;
            double sMin = Math.Min(Math.Max(s, 0.0), len);
            double sMax = Math.Min(len, sMin + windowM);
            double bestD2 = double.PositiveInfinity;
            double bestS = sMin, bestX = g.X[0], bestY = g.Y[0], bestU = 0;
            int bestK = 0;
            if (n < 2)
            {
                double dx0 = x - g.X[0], dy0 = y - g.Y[0];
                bestD2 = dx0 * dx0 + dy0 * dy0;
            }
            else
            {
                double s0 = g.S[0];
                // The segment that holds sMin: the last row at or before it.
                int lo = 0, hi = n - 2;
                while (lo < hi)
                {
                    int mid = (lo + hi + 1) / 2;
                    if (g.S[mid] - s0 <= sMin) lo = mid;
                    else hi = mid - 1;
                }
                for (int k = lo; k < n - 1; k++)
                {
                    double a = g.S[k] - s0, b = g.S[k + 1] - s0;
                    if (k > lo && a >= sMax) break;
                    double ds = b - a;
                    // The part of this segment inside [sMin, sMax], as fractions of the segment.
                    double uLo = ds > 0 ? Math.Min(1.0, Math.Max(0.0, (sMin - a) / ds)) : 0.0;
                    double uHi = ds > 0 ? Math.Min(1.0, Math.Max(0.0, (sMax - a) / ds)) : 0.0;
                    double ax = g.X[k], ay = g.Y[k];
                    double dx = g.X[k + 1] - ax, dy = g.Y[k + 1] - ay;
                    double d2 = dx * dx + dy * dy;
                    double u = d2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / d2 : 0.0;
                    if (u < uLo) u = uLo;
                    if (u > uHi) u = uHi;
                    double px = ax + u * dx, py = ay + u * dy;
                    double ox = x - px, oy = y - py;
                    double dist2 = ox * ox + oy * oy;
                    if (dist2 < bestD2)
                    {
                        bestD2 = dist2;
                        bestS = a + u * ds;
                        bestX = px;
                        bestY = py;
                        bestK = k;
                        bestU = u;
                    }
                }
            }
            if (bestS < sMin) bestS = sMin;
            if (bestS > len) bestS = len;
            s = bestS;

            o.LegIndex = leg;
            o.LegNumber = g.Number;
            o.SLegM = s;
            o.STotalM = route.ArcBefore(leg) + s;
            o.CrossTrackM = Math.Sqrt(bestD2);
            o.SnapX = bestX;
            o.SnapY = bestY;
            if (n < 2)
            {
                o.SnapZ = g.Z[0];
                o.TPlanMin = g.T[0];
            }
            else
            {
                double? z0 = g.Z[bestK], z1 = g.Z[bestK + 1];
                o.SnapZ = bestU <= 0 ? z0 : bestU >= 1 ? z1 : z0.HasValue && z1.HasValue ? z0.Value + bestU * (z1.Value - z0.Value) : (double?)null;
                o.TPlanMin = g.T[bestK] + bestU * (g.T[bestK + 1] - g.T[bestK]);
            }
            o.RouteComplete = complete;
            return o;
        }
    }
}

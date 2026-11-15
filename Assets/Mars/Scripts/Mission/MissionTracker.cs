using System;
using UnityEngine;

namespace NasaSpaceApp.Mission
{
    /// <summary>Where a waypoint stands during the EVA.</summary>
    public enum WaypointState { Upcoming, Stopping, Done, Skipped }

    /// <summary>
    /// Live mission status, most urgent first (SPEC F18 alarm rules + the plan comparison):
    /// RETURN NOW (margin &lt; 0, red) · TURN BACK (margin &lt; margin_amber_min, amber countdown) · REPLAN (the rest of
    /// the plan no longer fits at the current delay/O₂ use) · OFF ROUTE · BEHIND · ON PLAN / HEADING HOME / COMPLETE.
    /// </summary>
    public enum MissionStatus { None, OnPlan, HeadingHome, Behind, OffRoute, Replan, TurnBack, ReturnNow, Complete }

    /// <summary>
    /// Follows the walker along a loaded <see cref="MissionPlan"/> and compares the live EVA with it. Pure logic: feed it
    /// position, EVA minute and suit O₂ each frame with <see cref="Tick"/>; read the results from its properties.
    ///
    /// <para><b>Progress.</b> The walker is matched to the nearest point of the <i>current leg</i> (the leg toward the
    /// next open waypoint, or the way home once every waypoint is done or skipped), so overlapping out and home legs never
    /// confuse it. Cross-track distance = distance to that point.</para>
    ///
    /// <para><b>Stops.</b> Coming within <see cref="ArriveRadiusM"/> of the next open waypoint (or a later one: the ones in
    /// between become Skipped) starts its stop. It is Done when the planned stop time has passed, when the walker leaves
    /// it (beyond <see cref="LeaveRadiusM"/>: finished early), or by <see cref="CompleteWaypoint"/> (the map screen's
    /// Complete button). A waypoint with no stop time is Done on arrival. Back within <see cref="PadArriveM"/> of the pad
    /// with nothing open = Complete.</para>
    ///
    /// <para><b>Schedule.</b> Planned EVA minute at the matched point (inside a stop: arrival + stop time so far);
    /// <see cref="ScheduleDeltaMin"/> = live − planned (positive = behind). O₂ the same way, from the suit model.</para>
    ///
    /// <para><b>Margin</b> (the planner's terms, mission/margin.ts): O₂ = (O₂ left − O₂_home − tasks left − reserve) /
    /// effort rate; daylight = t_dark − t − T_home; EVA duration = EVA limit − t − T_home; the smallest binds. T_home and
    /// O₂_home come from the plan at the matched point plus the straight walk back to it at the leg's planned pace (an
    /// estimate off route). The dose term is left out: the mission file has no dose series.</para>
    ///
    /// <para><b>Projected margin</b> (REPLAN): the lowest margin over the rest of the planned timeline if the walker keeps
    /// the current delay and uses O₂ as planned from here.</para>
    /// </summary>
    public sealed class MissionTracker
    {
        // Thresholds (assumed for the simulator; not in the HOMELINE config): metres and minutes.
        public const float ArriveRadiusM = 10f;
        public const float LeaveRadiusM = 20f;
        public const float PadArriveM = 10f;
        public const float OffRouteCautionM = 25f;
        public const float BehindCautionMin = 5f;
        public const float FallbackPaceMPerMin = 50f;   // ~0.83 m/s when a leg has no planned pace
        private const float ProjectionPeriodMin = 0.05f; // recompute the projection at most every 3 s of EVA time

        public MissionPlan Plan { get; private set; }
        public bool Active => Plan != null;

        // ---- live inputs (last tick)
        public float EvaMin { get; private set; }
        public Vector3 Position { get; private set; }

        // ---- route matching
        /// <summary>Index in <see cref="MissionPlan.Legs"/> of the leg being walked (-1 when none).</summary>
        public int CurrentLeg { get; private set; } = -1;
        /// <summary>Nearest point of the current leg, and the walker's horizontal distance to it (m).</summary>
        public Vector3 RoutePoint { get; private set; }
        public float CrossTrackM { get; private set; } = float.NaN;
        /// <summary>Distance along the whole planned walk at the matched point (m, see <see cref="MissionPlan.RouteS"/>).</summary>
        public float ProgressS { get; private set; }
        /// <summary>Route point index at which the current leg starts: earlier points are walked (drawn dim).</summary>
        public int DoneBeforePoint { get; private set; }

        // ---- waypoints
        public WaypointState[] States { get; private set; } = Array.Empty<WaypointState>();
        public float[] ArrivedAtMin { get; private set; } = Array.Empty<float>();
        public float[] DoneAtMin { get; private set; } = Array.Empty<float>();
        /// <summary>True when the stop was ended by leaving early.</summary>
        public bool[] LeftEarly { get; private set; } = Array.Empty<bool>();
        /// <summary>Index (0-based) of the next open waypoint; -1 = all done or skipped (heading home).</summary>
        public int NextWaypoint { get; private set; } = -1;
        /// <summary>Index of the waypoint being stopped at; -1 = walking.</summary>
        public int StopWaypoint { get; private set; } = -1;
        public float StopElapsedMin { get; private set; }
        public float StopPlannedMin { get; private set; }
        /// <summary>Straight distance to the next waypoint (or the pad when heading home), m.</summary>
        public float DistanceToNextM { get; private set; } = float.NaN;
        /// <summary>Distance along the route to the next waypoint (or the pad), m; straight distance off a routed leg.</summary>
        public float RouteDistanceToNextM { get; private set; } = float.NaN;
        /// <summary>Predicted EVA minute of arrival at the next waypoint / the pad, at the leg's planned pace.</summary>
        public float NextEtaMin { get; private set; } = float.NaN;
        /// <summary>Planned EVA minute of arrival there.</summary>
        public float NextPlannedMin { get; private set; } = float.NaN;

        // ---- plan comparison
        public float PlannedMin { get; private set; } = float.NaN;
        /// <summary>Live − planned EVA minute at this point of the route: positive = behind, negative = ahead.</summary>
        public float ScheduleDeltaMin { get; private set; } = float.NaN;
        public float O2UsedL { get; private set; } = float.NaN;
        public float PlannedO2UsedL { get; private set; } = float.NaN;
        /// <summary>Suit O₂ used − planned O₂ used at this point (L): positive = using more than planned.</summary>
        public float O2DeltaL { get; private set; } = float.NaN;

        // ---- margin
        public float THomeMin { get; private set; } = float.NaN;
        public float O2HomeL { get; private set; } = float.NaN;
        public float MarginMin { get; private set; } = float.NaN;
        /// <summary>"O2" | "daylight" | "EVA duration"; null when unknown.</summary>
        public string Binding { get; private set; }
        public float ProjectedMarginMin { get; private set; } = float.NaN;
        public string ProjectedBinding { get; private set; }

        // ---- status
        public MissionStatus Status { get; private set; }
        public bool Complete { get; private set; }
        public float CompleteAtMin { get; private set; } = float.NaN;
        /// <summary>Incremented when a waypoint state or <see cref="Status"/> changes (HUD redraw hint).</summary>
        public int Version { get; private set; }

        /// <summary>Waypoint index (0-based) reached / done / skipped; status changes. For the EVA log and toasts.</summary>
        public event Action<int> WaypointArrived, WaypointDone, WaypointSkipped;
        public event Action<MissionStatus> StatusChanged;
        public event Action MissionComplete;

        private float o2LeftL = float.NaN;
        private float o2StartL = float.NaN;
        private float lastProjectionMin = float.NegativeInfinity;
        private int matchedSegment = -1;   // route index i: segment i -> i+1
        private float matchedU;

        // ------------------------------------------------------------------ lifecycle

        /// <summary>Starts following <paramref name="plan"/> at EVA minute 0 (the walker is on the pad).</summary>
        public void Begin(MissionPlan plan)
        {
            Plan = plan;
            int n = plan != null ? plan.Waypoints.Count : 0;
            States = new WaypointState[n];
            ArrivedAtMin = Filled(n);
            DoneAtMin = Filled(n);
            LeftEarly = new bool[n];
            NextWaypoint = n > 0 ? 0 : -1;
            StopWaypoint = -1;
            StopElapsedMin = StopPlannedMin = 0f;
            Complete = false;
            CompleteAtMin = float.NaN;
            o2StartL = float.NaN;
            o2LeftL = float.NaN;
            lastProjectionMin = float.NegativeInfinity;
            ProjectedMarginMin = float.NaN;
            ProjectedBinding = null;
            Status = plan != null ? MissionStatus.OnPlan : MissionStatus.None;
            SelectLeg();
            Version++;
        }

        /// <summary>Stops following (no mission).</summary>
        public void End()
        {
            Plan = null;
            States = Array.Empty<WaypointState>();
            ArrivedAtMin = DoneAtMin = Array.Empty<float>();
            LeftEarly = Array.Empty<bool>();
            NextWaypoint = StopWaypoint = CurrentLeg = -1;
            Status = MissionStatus.None;
            Version++;
        }

        /// <summary>
        /// Marks waypoint <paramref name="index"/> done now (the map screen's Complete button): ends its stop, or completes
        /// it without a visit. Earlier open waypoints stay open. Ignored when it is already done or skipped.
        /// </summary>
        public void CompleteWaypoint(int index)
        {
            if (Plan == null || (uint)index >= (uint)States.Length)
            {
                return;
            }
            WaypointState s = States[index];
            if (s == WaypointState.Done || s == WaypointState.Skipped)
            {
                return;
            }
            MarkDone(index, false);
            AdvanceNext();
        }

        // ------------------------------------------------------------------ per frame

        /// <summary>
        /// Advances the comparison. <paramref name="position"/> = the walker (world), <paramref name="evaMin"/> = minutes
        /// since the EVA started (suit mission clock), <paramref name="suitO2LeftL"/> = suit O₂ left (NaN = unknown).
        /// </summary>
        public void Tick(Vector3 position, float evaMin, float suitO2LeftL)
        {
            if (Plan == null)
            {
                return;
            }
            Position = position;
            EvaMin = evaMin;
            o2LeftL = suitO2LeftL;
            if (float.IsNaN(o2StartL) && !float.IsNaN(suitO2LeftL))
            {
                o2StartL = suitO2LeftL;   // the suit at EVA start (fresh EVA = full)
            }
            O2UsedL = float.IsNaN(o2StartL) || float.IsNaN(suitO2LeftL) ? float.NaN : o2StartL - suitO2LeftL;

            if (!Complete)
            {
                UpdateStops();
                MatchRoute();
                CheckReturn();
            }
            UpdateNext();
            UpdatePlanned();
            UpdateMargin();
            UpdateStatus();
        }

        // ------------------------------------------------------------------ waypoints

        private void UpdateStops()
        {
            var wps = Plan.Waypoints;

            // Inside a stop: time it, or end it when the walker leaves.
            if (StopWaypoint >= 0)
            {
                int i = StopWaypoint;
                StopElapsedMin = Mathf.Max(0f, EvaMin - ArrivedAtMin[i]);
                if (Horizontal(Position, wps[i].World) > LeaveRadiusM)
                {
                    MarkDone(i, StopElapsedMin < StopPlannedMin);
                    AdvanceNext();
                }
                else if (StopElapsedMin >= StopPlannedMin)
                {
                    MarkDone(i, false);
                    AdvanceNext();
                }
                return;
            }

            // Arrival at the next open waypoint, or a later one (the ones between are skipped).
            if (NextWaypoint < 0)
            {
                return;
            }
            for (int i = NextWaypoint; i < wps.Count; i++)
            {
                if (States[i] != WaypointState.Upcoming || Horizontal(Position, wps[i].World) > ArriveRadiusM)
                {
                    continue;
                }
                for (int k = NextWaypoint; k < i; k++)
                {
                    if (States[k] == WaypointState.Upcoming)
                    {
                        States[k] = WaypointState.Skipped;
                        WaypointSkipped?.Invoke(k);
                    }
                }
                ArrivedAtMin[i] = EvaMin;
                if (NextWaypoint != i)
                {
                    NextWaypoint = i;
                    SelectLeg();   // skipped ahead: follow the leg into this waypoint
                }
                WaypointArrived?.Invoke(i);
                float stop = wps[i].StopMin;
                if (stop > 0f)
                {
                    States[i] = WaypointState.Stopping;
                    StopWaypoint = i;
                    StopPlannedMin = stop;
                    StopElapsedMin = 0f;
                    Version++;
                }
                else
                {
                    MarkDone(i, false);
                    AdvanceNext();
                }
                break;
            }
        }

        private void MarkDone(int i, bool early)
        {
            States[i] = WaypointState.Done;
            DoneAtMin[i] = EvaMin;
            LeftEarly[i] = early;
            if (StopWaypoint == i)
            {
                StopWaypoint = -1;
                StopElapsedMin = StopPlannedMin = 0f;
            }
            Version++;
            WaypointDone?.Invoke(i);
        }

        // Next open waypoint after the done/skipped ones; a stop at another waypoint keeps it.
        private void AdvanceNext()
        {
            if (StopWaypoint >= 0)
            {
                NextWaypoint = StopWaypoint;
            }
            else
            {
                NextWaypoint = -1;
                for (int i = 0; i < States.Length; i++)
                {
                    if (States[i] == WaypointState.Upcoming)
                    {
                        NextWaypoint = i;
                        break;
                    }
                }
            }
            SelectLeg();
        }

        // The leg toward the next open waypoint (out leg #index), else the home leg.
        private void SelectLeg()
        {
            CurrentLeg = -1;
            DoneBeforePoint = 0;
            matchedSegment = -1;
            if (Plan == null)
            {
                return;
            }
            var legs = Plan.Legs;
            if (NextWaypoint >= 0)
            {
                string to = "wp" + Plan.Waypoints[NextWaypoint].Index.ToString(System.Globalization.CultureInfo.InvariantCulture);
                for (int k = 0; k < legs.Count; k++)
                {
                    if (!legs[k].IsHome && legs[k].To == to)
                    {
                        CurrentLeg = k;
                        break;
                    }
                }
            }
            else
            {
                for (int k = 0; k < legs.Count; k++)
                {
                    if (legs[k].IsHome)
                    {
                        CurrentLeg = k;
                        break;
                    }
                }
            }
            if (CurrentLeg >= 0 && legs[CurrentLeg].FirstPoint >= 0)
            {
                DoneBeforePoint = legs[CurrentLeg].FirstPoint;
            }
            else if (NextWaypoint < 0)
            {
                DoneBeforePoint = Plan.Route.Length;   // no home leg in the file: everything walked
            }
        }

        private void CheckReturn()
        {
            if (NextWaypoint >= 0 || StopWaypoint >= 0)
            {
                return;
            }
            if (Horizontal(Position, Plan.PadWorld) <= PadArriveM && EvaMin > 0f)
            {
                Complete = true;
                CompleteAtMin = EvaMin;
                Version++;
                MissionComplete?.Invoke();
            }
        }

        // ------------------------------------------------------------------ route matching

        private bool LegRange(out int first, out int last)
        {
            first = last = -1;
            if (CurrentLeg < 0)
            {
                return false;
            }
            MissionLeg leg = Plan.Legs[CurrentLeg];
            if (!leg.Routed || leg.FirstPoint < 0 || leg.PointCount < 2)
            {
                return false;
            }
            first = leg.FirstPoint;
            last = Mathf.Min(Plan.Route.Length - 1, leg.FirstPoint + leg.PointCount - 1);
            return last > first;
        }

        private void MatchRoute()
        {
            if (!LegRange(out int first, out int last))
            {
                // Unrouted leg: straight line from where it starts to where it ends.
                matchedSegment = -1;
                Vector3 a = LegStartWorld(), b = NextTargetWorld();
                float u = ProjectU(Position, a, b);
                RoutePoint = Vector3.Lerp(a, b, u);
                CrossTrackM = Horizontal(Position, RoutePoint);
                return;
            }
            Vector3[] r = Plan.Route;
            float best = float.MaxValue;
            int bestI = first;
            float bestU = 0f;
            for (int i = first; i < last; i++)
            {
                float u = ProjectU(Position, r[i], r[i + 1]);
                Vector3 p = Vector3.Lerp(r[i], r[i + 1], u);
                float dx = Position.x - p.x, dz = Position.z - p.z;
                float d2 = dx * dx + dz * dz;
                if (d2 < best)
                {
                    best = d2;
                    bestI = i;
                    bestU = u;
                }
            }
            matchedSegment = bestI;
            matchedU = bestU;
            RoutePoint = Vector3.Lerp(r[bestI], r[bestI + 1], bestU);
            CrossTrackM = Mathf.Sqrt(best);
            ProgressS = Mathf.Lerp(Plan.RouteS[bestI], Plan.RouteS[bestI + 1], bestU);
        }

        private Vector3 LegStartWorld()
        {
            // The last done/visited waypoint before the next one, else the pad.
            int from = NextWaypoint >= 0 ? NextWaypoint - 1 : Plan.Waypoints.Count - 1;
            for (int i = from; i >= 0; i--)
            {
                if (States[i] == WaypointState.Done)
                {
                    return Plan.Waypoints[i].World;
                }
            }
            return Plan.PadWorld;
        }

        private Vector3 NextTargetWorld() => NextWaypoint >= 0 ? Plan.Waypoints[NextWaypoint].World : Plan.PadWorld;

        // ------------------------------------------------------------------ next target

        private void UpdateNext()
        {
            Vector3 target = NextTargetWorld();
            DistanceToNextM = Horizontal(Position, target);
            float pace = LegPaceMPerMin();

            if (Complete)
            {
                RouteDistanceToNextM = 0f;
                NextEtaMin = CompleteAtMin;
                NextPlannedMin = PlannedReturnMin();
                return;
            }
            if (StopWaypoint >= 0)
            {
                RouteDistanceToNextM = 0f;
                NextEtaMin = ArrivedAtMin[StopWaypoint];
                NextPlannedMin = Plan.Waypoints[StopWaypoint].ArriveMin;
                return;
            }
            if (LegRange(out _, out int last) && matchedSegment >= 0)
            {
                RouteDistanceToNextM = CrossTrackM + Mathf.Max(0f, Plan.RouteS[last] - ProgressS);
            }
            else
            {
                RouteDistanceToNextM = DistanceToNextM;
            }
            NextEtaMin = EvaMin + RouteDistanceToNextM / pace;
            NextPlannedMin = NextWaypoint >= 0 ? Plan.Waypoints[NextWaypoint].ArriveMin : PlannedReturnMin();
        }

        private float PlannedReturnMin()
        {
            var legs = Plan.Legs;
            for (int k = legs.Count - 1; k >= 0; k--)
            {
                if (legs[k].IsHome)
                {
                    return legs[k].EndMin;
                }
            }
            return Plan.EvaMin;
        }

        /// <summary>Planned walking pace on the current leg (m/min).</summary>
        public float LegPaceMPerMin()
        {
            if (Plan != null && CurrentLeg >= 0)
            {
                MissionLeg l = Plan.Legs[CurrentLeg];
                if (l.LengthM > 0f && l.TimeMin > 0f)
                {
                    return l.LengthM / l.TimeMin;
                }
            }
            return FallbackPaceMPerMin;
        }

        // ------------------------------------------------------------------ plan comparison

        private void UpdatePlanned()
        {
            float planned = float.NaN, plannedO2 = float.NaN;
            float tHome = float.NaN, o2Home = float.NaN;
            if (StopWaypoint >= 0)
            {
                MissionWaypoint w = Plan.Waypoints[StopWaypoint];
                float inStop = Mathf.Min(StopElapsedMin, w.StopMin);
                planned = w.ArriveMin + inStop;
                float o2AtLeave = w.O2UsedAtLeaveL;
                float stationRate = (float)Plan.Constants.StationRateLMin;
                plannedO2 = float.IsNaN(o2AtLeave) ? float.NaN : o2AtLeave - (w.StopMin - inStop) * stationRate;
                tHome = w.THomeMin;
                o2Home = w.O2HomeL;
            }
            else if (matchedSegment >= 0)
            {
                int i = matchedSegment;
                planned = Lerp(Plan.RouteT[i], Plan.RouteT[i + 1], matchedU);
                plannedO2 = Lerp(Plan.RouteO2Used[i], Plan.RouteO2Used[i + 1], matchedU);
                tHome = Lerp(Plan.RouteTHome[i], Plan.RouteTHome[i + 1], matchedU);
                o2Home = Lerp(Plan.RouteO2Home[i], Plan.RouteO2Home[i + 1], matchedU);
            }
            else if (Complete)
            {
                planned = PlannedReturnMin();
                plannedO2 = Plan.O2UsedL;
                tHome = 0f;
                o2Home = 0f;
            }

            // Off route: add the straight walk back to the matched point at the leg's planned pace.
            if (!float.IsNaN(CrossTrackM) && StopWaypoint < 0 && !Complete)
            {
                float extraMin = CrossTrackM / LegPaceMPerMin();
                tHome += extraMin;
                o2Home += extraMin * (float)Plan.Constants.EffortRateLMin;
            }

            PlannedMin = planned;
            PlannedO2UsedL = plannedO2;
            THomeMin = tHome;
            O2HomeL = o2Home;
            ScheduleDeltaMin = EvaMin - planned;
            O2DeltaL = O2UsedL - plannedO2;
        }

        private void UpdateMargin()
        {
            MissionFile.ConstantsBlock c = Plan.Constants;
            float effort = (float)c.EffortRateLMin;
            float margin = float.NaN;
            string binding = null;
            if (!float.IsNaN(THomeMin))
            {
                // Engine order: O2, daylight, (dose: not available here), EVA duration; first wins on a tie.
                if (!float.IsNaN(o2LeftL) && !float.IsNaN(O2HomeL) && effort > 0f)
                {
                    float tasksLeft = StopWaypoint >= 0 ? Mathf.Max(0f, StopPlannedMin - StopElapsedMin) * (float)c.StationRateLMin : 0f;
                    Consider((o2LeftL - O2HomeL - tasksLeft - (float)c.ReserveL) / effort, "O2", ref margin, ref binding);
                }
                float tDark = Plan.TDarkMin;
                if (!float.IsNaN(tDark))
                {
                    Consider(tDark - EvaMin - THomeMin, "daylight", ref margin, ref binding);
                }
                if (c.EvaLimitMin > 0)
                {
                    Consider((float)c.EvaLimitMin - EvaMin - THomeMin, "EVA duration", ref margin, ref binding);
                }
            }
            MarginMin = margin;
            Binding = binding;

            if (EvaMin - lastProjectionMin >= ProjectionPeriodMin || EvaMin < lastProjectionMin)
            {
                lastProjectionMin = EvaMin;
                Project();
            }
        }

        // Lowest margin over the rest of the planned timeline at the current delay and O₂ state.
        private void Project()
        {
            ProjectedMarginMin = float.NaN;
            ProjectedBinding = null;
            var rows = Plan.Timeline;
            if (rows.Count == 0 || float.IsNaN(PlannedMin) || Complete)
            {
                return;
            }
            MissionFile.ConstantsBlock c = Plan.Constants;
            float effort = (float)c.EffortRateLMin;
            float delay = float.IsNaN(ScheduleDeltaMin) ? 0f : ScheduleDeltaMin;
            float o2Now = !float.IsNaN(o2LeftL) ? o2LeftL : (float)c.O2CapacityL - (float.IsNaN(PlannedO2UsedL) ? 0f : PlannedO2UsedL);
            float plannedUsedNow = float.IsNaN(PlannedO2UsedL) ? 0f : PlannedO2UsedL;
            float tDark = Plan.TDarkMin;
            float best = float.NaN;
            string bind = null;
            for (int k = 0; k < rows.Count; k++)
            {
                MissionTimelineRow r = rows[k];
                if (r.TMin < PlannedMin)
                {
                    continue;
                }
                float t = r.TMin + delay;
                float m = float.NaN;
                string b = null;
                if (effort > 0f)
                {
                    float o2Left = o2Now - (r.O2UsedL - plannedUsedNow);
                    Consider((o2Left - r.O2HomeL - r.TasksLeftL - (float)c.ReserveL) / effort, "O2", ref m, ref b);
                }
                if (!float.IsNaN(tDark)) Consider(tDark - t - r.THomeMin, "daylight", ref m, ref b);
                if (c.EvaLimitMin > 0) Consider((float)c.EvaLimitMin - t - r.THomeMin, "EVA duration", ref m, ref b);
                if (!float.IsNaN(m) && (float.IsNaN(best) || m < best))
                {
                    best = m;
                    bind = b;
                }
            }
            ProjectedMarginMin = best;
            ProjectedBinding = bind;
        }

        private static void Consider(float value, string name, ref float margin, ref string binding)
        {
            if (float.IsNaN(value))
            {
                return;
            }
            if (float.IsNaN(margin) || value < margin)
            {
                margin = value;
                binding = name;
            }
        }

        // ------------------------------------------------------------------ status

        private void UpdateStatus()
        {
            MissionStatus s;
            float amber = Plan.MarginAmberMin;
            if (Complete) s = MissionStatus.Complete;
            else if (MarginMin < 0f) s = MissionStatus.ReturnNow;
            else if (MarginMin < amber) s = MissionStatus.TurnBack;
            else if (NextWaypoint >= 0 && ProjectedMarginMin < 0f) s = MissionStatus.Replan;
            else if (CrossTrackM > OffRouteCautionM && StopWaypoint < 0) s = MissionStatus.OffRoute;
            else if (ScheduleDeltaMin > BehindCautionMin) s = MissionStatus.Behind;
            else if (NextWaypoint < 0) s = MissionStatus.HeadingHome;
            else s = MissionStatus.OnPlan;
            if (s != Status)
            {
                Status = s;
                Version++;
                StatusChanged?.Invoke(s);
            }
        }

        /// <summary>Short status word for the HUD pill.</summary>
        public static string StatusLabel(MissionStatus s)
        {
            switch (s)
            {
                case MissionStatus.OnPlan: return "ON PLAN";
                case MissionStatus.HeadingHome: return "HEADING HOME";
                case MissionStatus.Behind: return "BEHIND";
                case MissionStatus.OffRoute: return "OFF ROUTE";
                case MissionStatus.Replan: return "REPLAN";
                case MissionStatus.TurnBack: return "TURN BACK";
                case MissionStatus.ReturnNow: return "RETURN NOW";
                case MissionStatus.Complete: return "EVA COMPLETE";
                default: return string.Empty;
            }
        }

        /// <summary>The recommended action for the current status (one line, may allocate).</summary>
        public string Advice()
        {
            switch (Status)
            {
                case MissionStatus.ReturnNow:
                    return "Margin gone (" + Binding + "): leave now and walk straight home";
                case MissionStatus.TurnBack:
                    return "Turn back within " + Mathf.Max(0, Mathf.FloorToInt(MarginMin)).ToString(System.Globalization.CultureInfo.InvariantCulture)
                           + " min (" + Binding + ")";
                case MissionStatus.Replan:
                    return "Rest of plan no longer fits (" + ProjectedBinding + "): skip a waypoint or shorten stops";
                case MissionStatus.OffRoute:
                    return "Rejoin the planned route (" + Mathf.RoundToInt(CrossTrackM).ToString(System.Globalization.CultureInfo.InvariantCulture) + " m off)";
                case MissionStatus.Behind:
                    return "Behind plan: keep stops short, keep walking pace";
                case MissionStatus.HeadingHome:
                    return "All waypoints closed: follow the way home";
                case MissionStatus.Complete:
                    return "Back at the pad";
                default:
                    return "Follow the route";
            }
        }

        // ------------------------------------------------------------------ helpers

        private static float[] Filled(int n)
        {
            var a = new float[n];
            for (int i = 0; i < n; i++) a[i] = float.NaN;
            return a;
        }

        private static float Lerp(float a, float b, float u) => float.IsNaN(a) || float.IsNaN(b) ? float.NaN : a + (b - a) * u;

        private static float Horizontal(Vector3 a, Vector3 b)
        {
            float dx = a.x - b.x, dz = a.z - b.z;
            return Mathf.Sqrt(dx * dx + dz * dz);
        }

        private static float ProjectU(Vector3 p, Vector3 a, Vector3 b)
        {
            float abx = b.x - a.x, abz = b.z - a.z;
            float len2 = abx * abx + abz * abz;
            if (len2 < 1e-8f)
            {
                return 0f;
            }
            return Mathf.Clamp01(((p.x - a.x) * abx + (p.z - a.z) * abz) / len2);
        }
    }
}

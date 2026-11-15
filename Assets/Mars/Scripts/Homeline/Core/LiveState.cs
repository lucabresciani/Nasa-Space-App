using System;
using System.Collections.Generic;

namespace NasaSpaceApp.Homeline
{
    /// <summary>A station as the live state needs it: where it is and how long the planned work there lasts.</summary>
    public sealed class LiveStation
    {
        public string Id;
        public double X, Y;
        public double DwellMin;
        /// <summary>Minutes of station work already done.</summary>
        public double WorkedMin;
        public bool Done { get { return WorkedMin >= DwellMin - 1e-9; } }
    }

    /// <summary>
    /// The crew's oxygen in a FREE WALK, accounted with the planner's own model (<see cref="Physio"/>, a port of
    /// pipeline/engine/physio_core.py): O2 rate = VO2(speed, grade) x body mass, where the grade is the slope of the
    /// ground actually walked and the carried mass is the suit of the plan's scenario. Station work is charged at the
    /// planner's task rate (pipeline/engine/margin.py station_task_rate). The planner has no weather term in O2, so
    /// none is applied here.
    ///
    /// What the planner does not define for a free walk, and this class therefore ASSUMES (named constants below):
    /// when a station counts as reached, what a crew standing still away from a station burns, and over what
    /// distance the grade is measured. With the grade taken over the last 10 m the model reproduces the planner's
    /// per-leg O2 on the planned route within 1 % (Tools/homeline-core/tests/PhysioParityTests.cs); over 1 m it would
    /// overstate it by 2 to 7 %.
    /// </summary>
    public sealed class LiveState
    {
        /// <summary>ASSUMPTION: within this distance of a station's access point the crew is "at the station".</summary>
        public const double AssumedArrivalRadiusM = 5.0;
        /// <summary>ASSUMPTION: the grade is the height change over the last this-many metres walked.</summary>
        public const double AssumedGradeWindowM = 10.0;
        /// <summary>ASSUMPTION: below this speed the crew is standing (resting rate, or station work at a station).</summary>
        public const double AssumedStandingSpeedMs = 0.05;
        /// <summary>A jump larger than this in one step is a teleport, not walking: no O2 is charged for it.</summary>
        const double TeleportM = 25.0;

        readonly Physio physio;
        readonly double capacityL, taskRateLMin;
        readonly List<LiveStation> stations = new List<LiveStation>();
        readonly List<double> trailS = new List<double>();
        readonly List<double> trailZ = new List<double>();
        double s;
        double lastX, lastY;
        bool hasLast;

        public LiveState(Physio physio, double capacityL, double taskRateLMin, IEnumerable<LiveStation> stations)
        {
            this.physio = physio;
            this.capacityL = capacityL;
            this.taskRateLMin = taskRateLMin;
            if (stations != null) this.stations.AddRange(stations);
        }

        /// <summary>EVA clock, minutes.</summary>
        public double TMin { get; private set; }
        public double O2UsedL { get; private set; }
        public double O2LeftL { get { return Math.Max(0, capacityL - O2UsedL); } }
        /// <summary>Litres used on top of the planner's model (weather work, cold, stress: the simulator's additions).</summary>
        public double ExtraO2L { get; private set; }

        /// <summary>Takes O2 that the planner's model does not account for out of the tank.</summary>
        public void AddExtra(double litres)
        {
            if (!(litres > 0)) return;
            O2UsedL += litres;
            ExtraO2L += litres;
        }
        /// <summary>O2 rate of the last step, L/min.</summary>
        public double RateLMin { get; private set; }
        /// <summary>Signed grade of the ground walked, degrees (positive uphill), over the grade window.</summary>
        public double GradeDeg { get; private set; }
        public double SpeedMs { get; private set; }
        public double DistanceWalkedM { get { return s; } }
        /// <summary>The station the crew is working at, or null.</summary>
        public LiveStation AtStation { get; private set; }
        public IReadOnlyList<LiveStation> Stations { get { return stations; } }

        public int StationsDone
        {
            get
            {
                int n = 0;
                foreach (LiveStation st in stations) if (st.Done) n++;
                return n;
            }
        }

        /// <summary>
        /// The planner's governed walking speed on the current grade, m/s (0.91 on the level, 0.36 at +10 degrees,
        /// 1.0 downhill for the nominal 104 kg scenario); null where the variant forbids the slope.
        /// </summary>
        public double? SpeedCapMs { get { return physio.WalkSpeed(GradeDeg); } }

        /// <summary>
        /// Starts (or restarts) the accounting from a known state, e.g. the plan's state at the moment the player
        /// takes over from the replay. Stations whose planned departure is in the past are marked done.
        /// </summary>
        public void Reset(double tMin, double o2UsedL, Func<LiveStation, bool> alreadyDone)
        {
            TMin = tMin;
            O2UsedL = Math.Max(0, o2UsedL);
            RateLMin = 0;
            GradeDeg = 0;
            SpeedMs = 0;
            s = 0;
            hasLast = false;
            AtStation = null;
            trailS.Clear();
            trailZ.Clear();
            foreach (LiveStation st in stations)
                st.WorkedMin = alreadyDone != null && alreadyDone(st) ? st.DwellMin : 0;
        }

        /// <summary>
        /// Advances by <paramref name="dtSeconds"/> of EVA time with the crew now at (x, y) of the plan's frame and at
        /// height z (any consistent height of the ground under the crew, metres).
        /// </summary>
        public void Step(double dtSeconds, double x, double y, double z)
        {
            if (!(dtSeconds > 0)) return;
            double ds = 0;
            if (hasLast)
            {
                ds = Math.Sqrt((x - lastX) * (x - lastX) + (y - lastY) * (y - lastY));
                if (ds > TeleportM)
                {
                    ds = 0;
                    trailS.Clear();
                    trailZ.Clear();
                }
            }
            lastX = x;
            lastY = y;
            hasLast = true;

            s += ds;
            PushTrail(z);
            GradeDeg = WindowGrade();
            SpeedMs = ds / dtSeconds;

            double minutes = dtSeconds / 60.0;
            AtStation = null;
            double rate;
            if (SpeedMs < AssumedStandingSpeedMs)
            {
                LiveStation here = StationHere(x, y);
                if (here != null)
                {
                    // Station work replaces the resting rate for the planned dwell (margin.py, traverse.py).
                    AtStation = here;
                    here.WorkedMin = Math.Min(here.DwellMin, here.WorkedMin + minutes);
                    rate = taskRateLMin;
                }
                else
                {
                    rate = physio.RestO2RateLMin;
                }
            }
            else
            {
                rate = physio.O2RateLMin(SpeedMs, GradeDeg);
            }
            RateLMin = rate;
            O2UsedL += rate * minutes;
            TMin += minutes;
        }

        LiveStation StationHere(double x, double y)
        {
            LiveStation best = null;
            double bestD = AssumedArrivalRadiusM;
            foreach (LiveStation st in stations)
            {
                if (st.Done) continue;
                double d = Math.Sqrt((x - st.X) * (x - st.X) + (y - st.Y) * (y - st.Y));
                if (d <= bestD)
                {
                    bestD = d;
                    best = st;
                }
            }
            return best;
        }

        void PushTrail(double z)
        {
            int n = trailS.Count;
            // One sample per 0.25 m is plenty for a 10 m window; standing still adds nothing.
            if (n > 0 && s - trailS[n - 1] < 0.25)
            {
                trailZ[n - 1] = z;
                return;
            }
            trailS.Add(s);
            trailZ.Add(z);
            int drop = 0;
            while (drop < trailS.Count - 2 && trailS[drop + 1] <= s - AssumedGradeWindowM) drop++;
            if (drop > 0)
            {
                trailS.RemoveRange(0, drop);
                trailZ.RemoveRange(0, drop);
            }
        }

        double WindowGrade()
        {
            int n = trailS.Count;
            if (n < 2) return 0;
            // Height at exactly (s - window), interpolated; the whole trail when less than a window has been walked.
            double from = s - AssumedGradeWindowM;
            double zRef = trailZ[0], sRef = trailS[0];
            if (from > trailS[0])
            {
                for (int i = 1; i < n; i++)
                {
                    if (trailS[i] < from) continue;
                    double span = trailS[i] - trailS[i - 1];
                    double f = span > 0 ? (from - trailS[i - 1]) / span : 0;
                    zRef = trailZ[i - 1] + f * (trailZ[i] - trailZ[i - 1]);
                    sRef = from;
                    break;
                }
            }
            double run = s - sRef;
            if (run < 1.0) return 0;
            return Physio.GradeDeg(trailZ[n - 1] - zRef, run);
        }
    }
}

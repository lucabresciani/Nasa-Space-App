using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// The solar storm of a plan on the EVA clock: conditions/storm.json of a plan bundle (the RAD dose-rate series
    /// of 20 May 2024, shifted by the planner so that its tripwire fires at the route minute where the way home is
    /// longest), and the planner's timed dose leash (pipeline/engine/margin.py, DoseTiming):
    ///   dose rate(t)  linear between the samples, held at the first / last sample outside the series (numpy.interp)
    ///   tau_dose(t)   = 60 * D_allow / dose rate(t)                  minutes
    ///   dose term     = tau_dose(t) - T_home                          one of the four terms of the margin
    /// The series belongs to one plan: its shift depends on that plan's route.
    /// </summary>
    public sealed class StormTrack
    {
        readonly double[] evaMin, rateMGyH;

        /// <summary>Allowed dose, mGy (storm.json d_allow_mgy).</summary>
        public readonly double DAllowMGy;
        /// <summary>EVA minute at which the storm tripwire fires; null if the file does not say.</summary>
        public readonly double? TStarMin;
        public int SampleCount { get { return evaMin.Length; } }
        /// <summary>Quiet-time dose rate of the series, mGy/h (storm.json baseline_uGy_day); null if the file does not say.</summary>
        public double? BaselineMGyH { get; private set; }

        /// <summary>The dose rate at an EVA minute as a multiple of the quiet-time rate (1 = quiet); 1 when the baseline is unknown.</summary>
        public double RateOverBaseline(double tMin)
        {
            return BaselineMGyH.HasValue && BaselineMGyH.Value > 0 ? RateMGyH(tMin) / BaselineMGyH.Value : 1.0;
        }

        /// <summary>True from the EVA minute at which the storm tripwire fires.</summary>
        public bool TripwireFired(double tMin)
        {
            return TStarMin.HasValue && tMin >= TStarMin.Value;
        }

        StormTrack(double[] evaMin, double[] rateMGyH, double dAllowMGy, double? tStarMin)
        {
            this.evaMin = evaMin;
            this.rateMGyH = rateMGyH;
            DAllowMGy = dAllowMGy;
            TStarMin = tStarMin;
        }

        /// <summary>The storm of a plan bundle; null when the bundle carries none.</summary>
        public static StormTrack FromBundle(BundleReader plan)
        {
            return plan.Has("conditions/storm.json") ? Parse(plan.ReadJson("conditions/storm.json")) : null;
        }

        /// <summary>Reads storm.json: rows [eva_min, utc, uGy_day, mGy_h] (column order taken from "columns").</summary>
        public static StormTrack Parse(JToken storm)
        {
            int tCol = 0, rCol = 3;
            JArray columns = storm["columns"] as JArray;
            if (columns != null)
            {
                for (int i = 0; i < columns.Count; i++)
                {
                    string name = (string)columns[i];
                    if (name == "eva_min") tCol = i;
                    else if (name == "mGy_h") rCol = i;
                }
            }
            var t = new List<double>();
            var r = new List<double>();
            JArray rows = storm["rows"] as JArray;
            if (rows == null) throw new FormatException("storm.json has no rows");
            foreach (JToken row in rows)
            {
                JArray a = row as JArray;
                if (a == null || a.Count <= Math.Max(tCol, rCol) || HlJson.IsNull(a[tCol]) || HlJson.IsNull(a[rCol])) continue;
                double time = HlJson.ToDouble(a[tCol]), rate = HlJson.ToDouble(a[rCol]);
                if (rate <= 0) continue;
                if (t.Count > 0 && time <= t[t.Count - 1]) throw new FormatException("storm.json rows are not in increasing eva_min");
                t.Add(time);
                r.Add(rate);
            }
            if (t.Count == 0) throw new FormatException("storm.json has no valid sample");
            double? allow = HlJson.NumOrNull(storm, "d_allow_mgy");
            if (!allow.HasValue || allow.Value <= 0) throw new FormatException("storm.json has no d_allow_mgy");
            var track = new StormTrack(t.ToArray(), r.ToArray(), allow.Value, HlJson.NumOrNull(storm, "t_star_min"));
            double? baseline = HlJson.NumOrNull(storm, "baseline_uGy_day");
            if (baseline.HasValue) track.BaselineMGyH = baseline.Value / 24000.0; // uGy/day to mGy/h
            return track;
        }

        /// <summary>
        /// The same storm with its tripwire at another EVA minute: what the planner does for another route
        /// (the tripwire fires at the route minute where the way home is longest). Unchanged when the file
        /// did not state the tripwire minute.
        /// </summary>
        public StormTrack Retimed(double tStarMin)
        {
            if (!TStarMin.HasValue) return this;
            double shift = tStarMin - TStarMin.Value;
            var t = new double[evaMin.Length];
            for (int i = 0; i < t.Length; i++) t[i] = evaMin[i] + shift;
            return new StormTrack(t, rateMGyH, DAllowMGy, tStarMin) { BaselineMGyH = BaselineMGyH };
        }

        /// <summary>Dose rate at an EVA minute, mGy/h.</summary>
        public double RateMGyH(double tMin)
        {
            int n = evaMin.Length;
            if (tMin <= evaMin[0]) return rateMGyH[0];
            if (tMin >= evaMin[n - 1]) return rateMGyH[n - 1];
            int lo = 0, hi = n - 1;
            while (hi - lo > 1)
            {
                int mid = (lo + hi) / 2;
                if (evaMin[mid] <= tMin) lo = mid;
                else hi = mid;
            }
            double f = (tMin - evaMin[lo]) / (evaMin[hi] - evaMin[lo]);
            return rateMGyH[lo] + f * (rateMGyH[hi] - rateMGyH[lo]);
        }

        /// <summary>The dose leash at an EVA minute: minutes of exposure the allowed dose buys at the current rate.</summary>
        public double TauDoseMin(double tMin)
        {
            return 60.0 * DAllowMGy / RateMGyH(tMin);
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

namespace NasaSpaceApp
{
    /// <summary>
    /// Measured Gale crater climate for the weather's historical mode, read from the same files HOMELINE uses:
    /// <list type="bullet">
    /// <item>REMS seasonal statistics: HOMELINE's conditions/rems.json (contract contracts/rems.schema.json, built from
    /// PDS mslrem_1001 MODRDR). Only air temperature and pressure are exposed, following HOMELINE decision D37.</item>
    /// <item>Dust optical depth: PDS msl_mmm_tau_bundle msl_tau_880.csv, Mastcam solar imaging at 880 nm
    /// (Lemmon et al., doi:10.17189/fjh0-2978). Columns: image id, sol, Ls (deg), tau, sigma.</item>
    /// </list>
    /// The tau record is filtered to the REMS file's own season window (Ls range and Mars years), so both describe the
    /// same season. Nothing here is invented: every number is a statistic of the measurements, and each carries its source.
    /// </summary>
    public sealed class MarsHistoricalClimate
    {
        public const string TauSource = "Curiosity Mastcam solar imaging, 880 nm (PDS msl_tau_880.csv, Lemmon et al., doi:10.17189/fjh0-2978)";

        /// <summary>Median and 10th/90th percentiles over <see cref="count"/> values (linear between order statistics).</summary>
        [Serializable]
        public struct Stat
        {
            public float median, p10, p90;
            public int count;
        }

        public struct TauSample
        {
            public float sol, ls, tau, sigma;
            public int marsYear;
        }

        /// <summary>Daily minimum and maximum air temperature (degC), statistics over sols. From rems.json.</summary>
        public Stat AirTemperatureMinC { get; private set; }
        public Stat AirTemperatureMaxC { get; private set; }
        /// <summary>Daily minimum and maximum surface pressure (Pa), statistics over sols. From rems.json.</summary>
        public Stat PressureMinPa { get; private set; }
        public Stat PressureMaxPa { get; private set; }
        /// <summary>Mastcam tau (880 nm) over every measurement inside the season window.</summary>
        public Stat Tau { get; private set; }

        public Vector2 LsWindowDeg { get; private set; }
        public int[] MarsYears { get; private set; }
        /// <summary>Mars years that actually have tau measurements in the window (the PDS record may end earlier).</summary>
        public int[] TauMarsYears { get; private set; }
        /// <summary>Tau measurements inside the window, ordered by sol.</summary>
        public IReadOnlyList<TauSample> TauSamples => tauSamples;
        /// <summary>One line: where the REMS numbers come from (source, method, sols, build time).</summary>
        public string RemsProvenance { get; private set; }

        readonly List<TauSample> tauSamples = new List<TauSample>();
        readonly List<TauSample> allSamples = new List<TauSample>(); // the whole record (sols 33-3953)

        /// <summary>The tau for historical mode: the season median for sol &lt;= 0, else the measurement nearest that sol
        /// anywhere in the record (e.g. sol 2086: tau 8.6, the 2018 global dust storm at Gale).</summary>
        public float TauFor(float sol) => sol <= 0f || allSamples.Count == 0 ? Tau.median : NearestSample(sol).tau;

        /// <summary>The measurement closest to a mission sol, from the whole record.</summary>
        public TauSample NearestSample(float sol)
        {
            TauSample best = allSamples[0];
            foreach (TauSample s in allSamples)
                if (Mathf.Abs(s.sol - sol) < Mathf.Abs(best.sol - sol)) best = s;
            return best;
        }

        /// <summary>Parses both files. Throws FormatException with a readable message if one is unusable.</summary>
        public static MarsHistoricalClimate Load(string remsJson, string tauCsv)
        {
            var climate = new MarsHistoricalClimate();
            climate.ReadRems(remsJson);
            climate.ReadTau(tauCsv);
            return climate;
        }

        // ------------------------------------------------------------------ REMS (HOMELINE rems.json)

        [Serializable] class RemsStat { public float median, p10, p90; }
        [Serializable] class RemsVariable { public string name; public string units; public int n_sols; public RemsStat daily_min, daily_max; }
        [Serializable] class RemsFile
        {
            public string source, method, build_utc;
            public float[] ls_window_deg;
            public int[] mars_years;
            public int sols_used;
            public RemsVariable[] variables;
        }

        void ReadRems(string json)
        {
            RemsFile file = JsonUtility.FromJson<RemsFile>(json);
            if (file == null || file.variables == null || file.ls_window_deg == null || file.ls_window_deg.Length != 2)
                throw new FormatException("rems.json: missing variables or ls_window_deg (expected HOMELINE's rems.schema.json).");

            LsWindowDeg = new Vector2(file.ls_window_deg[0], file.ls_window_deg[1]);
            MarsYears = file.mars_years ?? Array.Empty<int>();
            RemsVariable air = Find(file.variables, "air temperature");
            RemsVariable pressure = Find(file.variables, "pressure");
            AirTemperatureMinC = ToStat(air.daily_min, air.n_sols);
            AirTemperatureMaxC = ToStat(air.daily_max, air.n_sols);
            PressureMinPa = ToStat(pressure.daily_min, pressure.n_sols);
            PressureMaxPa = ToStat(pressure.daily_max, pressure.n_sols);
            RemsProvenance = $"{file.source}; Ls {LsWindowDeg.x:0}-{LsWindowDeg.y:0}, MY {string.Join("/", MarsYears)}, {file.sols_used} sols; {file.method} (built {file.build_utc})";
        }

        static RemsVariable Find(RemsVariable[] variables, string prefix)
        {
            foreach (RemsVariable v in variables)
                if (v != null && v.name != null && v.name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && v.daily_min != null && v.daily_max != null)
                    return v;
            throw new FormatException($"rems.json: no '{prefix}' variable.");
        }

        static Stat ToStat(RemsStat s, int count) => new Stat { median = s.median, p10 = s.p10, p90 = s.p90, count = count };

        // ------------------------------------------------------------------ Mastcam tau (PDS msl_tau_880.csv)

        void ReadTau(string csv)
        {
            var all = new List<TauSample>();
            foreach (string raw in csv.Split('\n'))
            {
                string[] p = raw.Split(',');
                if (p.Length < 5) continue;
                if (!TryFloat(p[1], out float sol) || !TryFloat(p[2], out float ls) || !TryFloat(p[3], out float tau) || !TryFloat(p[4], out float sigma))
                    continue; // header or malformed row
                all.Add(new TauSample { sol = sol, ls = ls, tau = tau, sigma = sigma });
            }
            if (all.Count == 0) throw new FormatException("msl_tau_880.csv: no rows (expected PID, Sol, L_s, Tau, Sigma).");
            all.Sort((a, b) => a.sol.CompareTo(b.sol));

            // Curiosity landed in Mars year 31 (Ls 150); every wrap of Ls from ~360 back to ~0 starts a new year.
            int marsYear = 31;
            float previousLs = all[0].ls;
            var years = new SortedSet<int>();
            var taus = new List<float>();
            foreach (TauSample sample in all)
            {
                if (sample.ls < previousLs - 180f) marsYear++;
                previousLs = sample.ls;
                TauSample kept = sample;
                kept.marsYear = marsYear;
                allSamples.Add(kept);
                if (sample.ls < LsWindowDeg.x || sample.ls > LsWindowDeg.y) continue;
                if (MarsYears.Length > 0 && Array.IndexOf(MarsYears, marsYear) < 0) continue;
                tauSamples.Add(kept);
                taus.Add(sample.tau);
                years.Add(marsYear);
            }
            if (taus.Count == 0)
                throw new FormatException($"msl_tau_880.csv: no measurement in Ls {LsWindowDeg.x}-{LsWindowDeg.y}, MY {string.Join("/", MarsYears)}.");

            taus.Sort();
            Tau = new Stat { median = Quantile(taus, 0.5f), p10 = Quantile(taus, 0.1f), p90 = Quantile(taus, 0.9f), count = taus.Count };
            TauMarsYears = new int[years.Count];
            years.CopyTo(TauMarsYears);
        }

        static bool TryFloat(string s, out float value) =>
            float.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out value);

        static float Quantile(List<float> sorted, float q)
        {
            float index = q * (sorted.Count - 1);
            int lo = Mathf.FloorToInt(index);
            int hi = Mathf.Min(lo + 1, sorted.Count - 1);
            return Mathf.Lerp(sorted[lo], sorted[hi], index - lo);
        }
    }
}

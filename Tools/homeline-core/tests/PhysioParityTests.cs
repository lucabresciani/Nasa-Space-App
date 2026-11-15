using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline.Tests
{
    /// <summary>
    /// Parity of <see cref="Physio"/> with the planner on the planned route of the fixture (plan rank1.nom_104):
    /// O2 integrated along each leg against the planner's own per-leg O2 ("o2_L" of local/route.geojson).
    ///   (a) on the engine's own 3 m vertices: speed from "times_min", grade from z interpolated from route.json at
    ///       the same distance along the leg. Within 1 % per leg.
    ///   (b) on the 1 m rows of route.json, as a walker would measure it live: speed from the row times, grade over
    ///       the last W metres travelled (a trailing window, shorter at the start of a leg). Within 1.5 % per leg
    ///       for W = 10 m; W = 1 m and 3 m are printed to show the sensitivity (the 1 m relief is rougher than the
    ///       engine's 3 m grid and the cost is not symmetric in grade).
    /// Plus the governor table of the nominal 104 kg walker.
    /// </summary>
    public static class PhysioParityTests
    {
        /// <summary>The window of (b) that is asserted, metres of travel.</summary>
        const double AssertedWindowM = 10.0;
        static readonly double[] WindowsM = { 1.0, 3.0, 10.0 };

        sealed class Leg
        {
            public int Number;
            public double[] S, Z, T;           // route.json rows: m along the leg, m up, EVA minutes
            public double[][] Xy;              // local/route.geojson vertices, pad-local m
            public double[] TimesMin;          // EVA minutes at those vertices
            public double PlannerO2L;          // local/route.geojson o2_L
        }

        public static void Run(string fixture)
        {
            using (BundleReader plan = BundleReader.Open(Path.Combine(fixture, "plan_bundle.zip")))
            {
                HlConfig cfg = HlConfig.FromBundle(plan);
                var walker = new Physio(cfg);

                GovernorTable(walker, cfg);

                List<Leg> legs = ReadLegs(plan.ReadJson("route.json"), plan.ReadJson("local/route.geojson"));
                T.True(legs.Count == 5, "the planned route has 5 legs (got " + legs.Count + ")");

                // (a) the engine's own vertices
                var line = new List<string>();
                double total = 0.0, plannerTotal = 0.0;
                foreach (Leg leg in legs)
                {
                    double o2 = OnEngineVertices(walker, leg);
                    double err = (o2 - leg.PlannerO2L) / leg.PlannerO2L;
                    total += o2;
                    plannerTotal += leg.PlannerO2L;
                    line.Add("leg " + leg.Number + " " + HlJson.F(o2, 2) + " L vs " + HlJson.F(leg.PlannerO2L, 2) + " (" + Pct(err) + ")");
                    T.True(Math.Abs(err) <= 0.01, "(a) engine vertices, leg " + leg.Number + ": " + HlJson.F(o2, 3) + " L vs planner "
                        + HlJson.F(leg.PlannerO2L, 2) + " L, " + Pct(err) + " (limit 1 %)");
                }
                Console.WriteLine("  (a) engine 3 m vertices: " + string.Join("; ", line) + "; walking total " + HlJson.F(total, 2)
                    + " L vs " + HlJson.F(plannerTotal, 2));

                // (b) the 1 m rows with a trailing grade window
                foreach (double w in WindowsM)
                {
                    line.Clear();
                    total = 0.0;
                    foreach (Leg leg in legs)
                    {
                        double o2 = OnRows(walker, leg, w);
                        double err = (o2 - leg.PlannerO2L) / leg.PlannerO2L;
                        total += o2;
                        line.Add("leg " + leg.Number + " " + HlJson.F(o2, 2) + " L (" + Pct(err) + ")");
                        if (w == AssertedWindowM)
                            T.True(Math.Abs(err) <= 0.015, "(b) 1 m rows, grade over " + HlJson.F(w, 0) + " m, leg " + leg.Number + ": "
                                + HlJson.F(o2, 3) + " L vs planner " + HlJson.F(leg.PlannerO2L, 2) + " L, " + Pct(err) + " (limit 1.5 %)");
                    }
                    Console.WriteLine("  (b) 1 m rows, grade over the last " + HlJson.F(w, 0) + " m: " + string.Join("; ", line)
                        + "; walking total " + HlJson.F(total, 2) + " L vs " + HlJson.F(plannerTotal, 2)
                        + (w == AssertedWindowM ? "  [asserted]" : "  [printed only]"));
                }
            }
        }

        /// <summary>The nominal 104 kg walker: v* and the O2 rate at v* (uphill and level the governor is effort-limited).</summary>
        static void GovernorTable(Physio walker, HlConfig cfg)
        {
            T.Near(walker.Governor(0.0), 0.912, 0.002, "v* at 0 deg");
            T.Near(walker.Governor(10.0), 0.355, 0.002, "v* at +10 deg");
            T.Near(walker.Governor(-5.0), 1.0, 0.002, "v* at -5 deg");
            T.Near(walker.O2RateLMin(walker.Governor(0.0), 0.0), 1.35, 1e-9, "O2 rate at v*, 0 deg");
            T.Near(walker.O2RateLMin(walker.Governor(10.0), 10.0), 1.35, 1e-9, "O2 rate at v*, +10 deg");
            T.Near(walker.O2RateLMin(walker.Governor(0.0), 0.0), cfg.EffortRateLMin, 1e-12, "O2 rate at v* is the effort rate of the config");
            T.Near(walker.RestO2RateLMin, walker.O2RateLMin(0.0, 0.0), 0.0, "rest rate is the model at speed 0");
            T.True(walker.Passable(0.0) && walker.Passable(10.0) && walker.Passable(-5.0), "0, +10 and -5 deg are passable");
            Console.WriteLine("  governor (nominal, 104 kg): v* " + HlJson.F(walker.Governor(0.0), 4) + " m/s at 0 deg, "
                + HlJson.F(walker.Governor(10.0), 4) + " at +10 deg, " + HlJson.F(walker.Governor(-5.0), 4) + " at -5 deg; rest "
                + HlJson.F(walker.RestO2RateLMin, 3) + " L/min");
        }

        /// <summary>(a) O2 on the engine's vertices: each edge at its planned time, grade from the route.json relief.</summary>
        static double OnEngineVertices(Physio walker, Leg leg)
        {
            double o2 = 0.0, along = 0.0;
            for (int k = 0; k + 1 < leg.Xy.Length; k++)
            {
                double dx = leg.Xy[k + 1][0] - leg.Xy[k][0], dy = leg.Xy[k + 1][1] - leg.Xy[k][1];
                double length = Math.Sqrt(dx * dx + dy * dy);
                double minutes = leg.TimesMin[k + 1] - leg.TimesMin[k];
                if (!(length > 0.0) || !(minutes > 0.0))
                    throw new InvalidDataException("leg " + leg.Number + " edge " + k + ": length " + T.N(length) + " m in " + T.N(minutes) + " min");
                double grade = Physio.GradeDeg(ZAt(leg, along + length) - ZAt(leg, along), length);
                along += length;
                o2 += walker.O2RateLMin(length / (minutes * Physio.SecPerMin), grade) * minutes;
            }
            return o2;
        }

        /// <summary>(b) O2 on the 1 m rows: each step at its planned time, grade over the last <paramref name="windowM"/> m travelled.</summary>
        static double OnRows(Physio walker, Leg leg, double windowM)
        {
            double o2 = 0.0;
            for (int i = 0; i + 1 < leg.S.Length; i++)
            {
                double step = leg.S[i + 1] - leg.S[i];
                double minutes = leg.T[i + 1] - leg.T[i];
                if (!(step > 0.0) || !(minutes > 0.0))
                    throw new InvalidDataException("leg " + leg.Number + " row " + i + ": step " + T.N(step) + " m in " + T.N(minutes) + " min");
                double to = leg.S[i + 1];
                double from = Math.Max(leg.S[0], to - windowM);
                double grade = Physio.GradeDeg(ZAt(leg, to) - ZAt(leg, from), to - from);
                o2 += walker.O2RateLMin(step / (minutes * Physio.SecPerMin), grade) * minutes;
            }
            return o2;
        }

        /// <summary>Height of the route.json relief at a distance along the leg (linear between rows, clamped at the ends).</summary>
        static double ZAt(Leg leg, double s)
        {
            double[] ss = leg.S;
            int last = ss.Length - 1;
            if (s <= ss[0]) return leg.Z[0];
            if (s >= ss[last]) return leg.Z[last];
            int lo = 0, hi = last;                      // ss[lo] <= s < ss[hi]
            while (hi - lo > 1)
            {
                int mid = (lo + hi) / 2;
                if (ss[mid] <= s) lo = mid;
                else hi = mid;
            }
            double w = (s - ss[lo]) / (ss[hi] - ss[lo]);
            return leg.Z[lo] + w * (leg.Z[hi] - leg.Z[lo]);
        }

        static List<Leg> ReadLegs(JToken route, JToken geo)
        {
            var columns = new List<string>();
            foreach (JToken c in (JArray)route["columns"]) columns.Add((string)c);
            int cLeg = Column(columns, "leg"), cS = Column(columns, "s_m"), cZ = Column(columns, "z_m"), cT = Column(columns, "t_eva_min");
            var rows = (JArray)route["rows"];

            var legs = new List<Leg>();
            foreach (JToken l in (JArray)route["legs"])
            {
                var leg = new Leg();
                leg.Number = (int)HlJson.Num(l, "leg");
                int first = (int)HlJson.Num(l, "first_row"), n = (int)HlJson.Num(l, "n_rows");
                leg.S = new double[n];
                leg.Z = new double[n];
                leg.T = new double[n];
                for (int i = 0; i < n; i++)
                {
                    var r = (JArray)rows[first + i];
                    if ((int)HlJson.ToDouble(r[cLeg]) != leg.Number)
                        throw new InvalidDataException("route.json row " + (first + i) + " is not of leg " + leg.Number);
                    leg.S[i] = HlJson.ToDouble(r[cS]);
                    leg.Z[i] = HlJson.ToDouble(r[cZ]);
                    leg.T[i] = HlJson.ToDouble(r[cT]);
                }

                foreach (JToken f in (JArray)geo["features"])
                {
                    JToken props = f["properties"];
                    if ((int)HlJson.Num(props, "leg") != leg.Number) continue;
                    var coords = (JArray)f["geometry"]["coordinates"];
                    leg.Xy = new double[coords.Count][];
                    for (int i = 0; i < coords.Count; i++) leg.Xy[i] = HlJson.Doubles(coords[i]);
                    leg.TimesMin = HlJson.Doubles(props["times_min"]);
                    leg.PlannerO2L = HlJson.Num(props, "o2_L");
                }
                if (leg.Xy == null || leg.TimesMin == null || leg.TimesMin.Length != leg.Xy.Length)
                    throw new InvalidDataException("local/route.geojson: leg " + leg.Number + " has no vertices with times_min");
                legs.Add(leg);
            }
            return legs;
        }

        static int Column(List<string> columns, string name)
        {
            int i = columns.IndexOf(name);
            if (i < 0) throw new InvalidDataException("route.json has no column " + name);
            return i;
        }

        static string Pct(double fraction)
        {
            double p = fraction * 100.0;
            return (p >= 0.0 ? "+" : "") + HlJson.F(p, 2) + " %";
        }
    }
}

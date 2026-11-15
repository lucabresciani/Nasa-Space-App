using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline.Tests
{
    /// <summary>
    /// Known-answer tests against the planner's own reference cases, physio/golden.json of the fixture plan bundle
    /// (pipeline/engine/golden.py, D40): the groups "physio" (45 cases) and "o2_leg" (3 cases).
    /// Every expected value and both tolerances are read from the file; a case is re-evaluated from its inputs and
    /// compared as golden.py _close does: |got - want| &lt;= abs + rel * |want|, null where a number is not finite,
    /// booleans exact, same keys, same list lengths.
    /// The cases run twice: with the constants of config_snapshot.json (the path the simulator uses) and with the
    /// "config" block of golden.json itself.
    /// </summary>
    public static class GoldenTests
    {
        const int PhysioCases = 45;
        const int O2LegCases = 3;

        public static void Run(string fixture)
        {
            using (BundleReader plan = BundleReader.Open(Path.Combine(fixture, "plan_bundle.zip")))
            {
                JToken golden = plan.ReadJson("physio/golden.json");
                JToken cases = golden["cases"];
                JToken tolerances = golden["tolerances"];

                HlConfig fromBundle = HlConfig.FromBundle(plan);
                HlConfig fromGolden = HlConfig.FromGolden(golden["config"]);

                Config(fromBundle, golden["config"], Tol.Of(tolerances, "physio"));

                Group("physio", (JArray)cases["physio"], PhysioCases, Tol.Of(tolerances, "physio"), fromBundle,
                    "config_snapshot.json", PhysioCase);
                Group("o2_leg", (JArray)cases["o2_leg"], O2LegCases, Tol.Of(tolerances, "o2_leg"), fromBundle,
                    "config_snapshot.json", O2LegCase);
                Group("physio", (JArray)cases["physio"], PhysioCases, Tol.Of(tolerances, "physio"), fromGolden,
                    "golden.json config", PhysioCase);
                Group("o2_leg", (JArray)cases["o2_leg"], O2LegCases, Tol.Of(tolerances, "o2_leg"), fromGolden,
                    "golden.json config", O2LegCase);
            }
        }

        // ------------------------------------------------------------------ the two groups

        /// <summary>golden.py physio_case: one variant, suit mass and grade.</summary>
        static JToken PhysioCase(HlConfig cfg, JToken inputs, Tol tol, List<string> diffs)
        {
            var p = new Physio(cfg, HlJson.Str(inputs, "variant"), HlJson.Num(inputs, "suit_kg"));
            double g = HlJson.Num(inputs, "grade_deg");

            // The file also states the carried mass M = suit + tools it used: the config must give the same.
            double carried = HlJson.Num(inputs, "carried_kg");
            if (!tol.Close(p.Params.CarriedKg, carried))
                diffs.Add("inputs.carried_kg: got " + T.N(p.Params.CarriedKg) + ", want " + T.N(carried));

            double v = p.Governor(g);
            double vo2 = p.Vo2(v, g);
            var got = new JObject();
            got["a_M"] = Num(p.AOfM);
            got["k_uphill"] = Num(p.KUphill(g));
            got["cost_slope"] = Num(p.CostSlope(g));
            // physio_core.py v_safe is 0 beyond the last row of the table; the port says null (unknown speed) there.
            got["v_safe_ms"] = Num(p.VSafe(Math.Abs(g)) ?? 0.0);
            got["v_star_ms"] = Num(v);
            got["vo2_at_v_star"] = Num(vo2);
            got["vo2_cap"] = Num(p.Vo2Cap);
            got["passable"] = new JValue(p.Passable(g));
            got["pace_s_per_m"] = Num(p.PaceSPerM(g));
            got["o2_L_per_m"] = Num(p.O2LPerM(g));
            got["heat_W_at_v_star"] = Num(p.HeatW(vo2));
            return got;
        }

        /// <summary>golden.py o2_leg_case: a polyline walked at the governed speed, segment by segment.</summary>
        static JToken O2LegCase(HlConfig cfg, JToken inputs, Tol tol, List<string> diffs)
        {
            var p = new Physio(cfg, HlJson.Str(inputs, "variant"), HlJson.Num(inputs, "suit_kg"));
            var vertices = (JArray)inputs["vertices"];
            var segments = new JArray();
            double? tTotal = 0.0, o2Total = 0.0;
            for (int i = 0; i + 1 < vertices.Count; i++)
            {
                double[] a = HlJson.Doubles(vertices[i]), b = HlJson.Doubles(vertices[i + 1]);
                double dx = b[0] - a[0], dy = b[1] - a[1];
                PhysioSegment s = p.Segment(Math.Sqrt(dx * dx + dy * dy), b[2] - a[2]);
                var seg = new JObject();
                seg["length_m"] = Num(s.LengthM);
                seg["grade_deg"] = Num(s.GradeDeg);
                seg["v_star_ms"] = Num(s.VStarMs);
                seg["t_min"] = Num(s.TMin);
                seg["o2_L"] = Num(s.O2L);
                segments.Add(seg);
                tTotal = tTotal.HasValue && s.TMin.HasValue ? tTotal + s.TMin : (double?)null;
                o2Total = o2Total.HasValue && s.O2L.HasValue ? o2Total + s.O2L : (double?)null;
            }
            var got = new JObject();
            got["segments"] = segments;
            got["t_min"] = Num(tTotal);
            got["o2_L"] = Num(o2Total);
            return got;
        }

        /// <summary>The derived constants of config_snapshot.json against the ones the planner printed in golden.json "config".</summary>
        static void Config(HlConfig cfg, JToken goldenConfig, Tol tol)
        {
            JToken d = goldenConfig["derived"];
            int before = T.Passed, failedBefore = T.Failures.Count;

            T.Eq(cfg.Scenario.Variant, "nominal", "plan scenario variant");
            T.Near(cfg.Scenario.SuitKg, 104.0, 0.0, "plan scenario suit kg");

            Derived(cfg.Alpha, d, "alpha_ml_kg_min_per_ms_per_kg", tol);
            Derived(cfg.Ist2SpanMarsKg, d, "ist2_span_mars_kg", tol);
            Derived(cfg.Params("nominal", cfg.DefaultSuitKg).AAnchor, d, "a_anchor_ml_kg_min_per_ms", tol);
            DerivedValue(cfg.DownhillClampLo, d["downhill_clamp"][0], "downhill_clamp[0]", tol);
            DerivedValue(cfg.DownhillClampHi, d["downhill_clamp"][1], "downhill_clamp[1]", tol);
            double[] minetti = HlJson.Doubles(d["minetti_coef_c5_to_c0"]);
            T.True(cfg.MinettiCoefC5ToC0.Count == minetti.Length, "config: Minetti coefficient count");
            for (int i = 0; i < minetti.Length && i < cfg.MinettiCoefC5ToC0.Count; i++)
                T.Golden(cfg.MinettiCoefC5ToC0[i], minetti[i], tol.Abs, tol.Rel, "config: minetti_coef_c5_to_c0[" + i + "]");
            Derived(cfg.O2CapacityL, d, "o2_budget_L", tol);
            Derived(cfg.O2ReserveL, d, "o2_reserve_L", tol);
            Derived(cfg.EffortRateLMin, d, "effort_rate_L_min", tol);
            Derived(cfg.TaskRateLMin, d, "station_task_rate_L_min", tol);
            Derived(cfg.PlanningRateLMin, d, "planning_rate_L_min", tol);
            Derived(cfg.EvaBudgetMin, d, "eva_budget_min", tol);
            T.Eq(cfg.O2ReserveLabel, HlJson.Str(d, "o2_reserve_label"), "config: o2_reserve_label");

            Console.WriteLine("  config (config_snapshot.json vs golden.json config.derived): " + (T.Passed - before)
                + " passed, " + (T.Failures.Count - failedBefore) + " failed");
        }

        static void Derived(double got, JToken derived, string key, Tol tol)
        {
            DerivedValue(got, derived[key], key, tol);
        }

        static void DerivedValue(double got, JToken want, string what, Tol tol)
        {
            if (HlJson.IsNull(want))
            {
                T.True(false, "config: golden.json has no " + what);
                return;
            }
            T.Golden(got, HlJson.ToDouble(want), tol.Abs, tol.Rel, "config: " + what);
        }

        // ------------------------------------------------------------------ runner and comparison

        delegate JToken Evaluate(HlConfig cfg, JToken inputs, Tol tol, List<string> diffs);

        static void Group(string name, JArray cases, int expectedCount, Tol tol, HlConfig cfg, string configName, Evaluate evaluate)
        {
            int n = cases == null ? 0 : cases.Count, passed = 0;
            T.True(n == expectedCount, name + ": " + n + " cases in golden.json, expected " + expectedCount);
            for (int i = 0; i < n; i++)
            {
                JToken c = cases[i];
                string id = HlJson.Str(c, "id");
                var diffs = new List<string>();
                try
                {
                    JToken got = evaluate(cfg, c["inputs"], tol, diffs);
                    Compare(got, c["expected"], tol, "expected", diffs);
                }
                catch (Exception e)
                {
                    diffs.Add("exception: " + e.GetType().Name + ": " + e.Message);
                }
                if (diffs.Count == 0) passed++;
                T.True(diffs.Count == 0, id + " [" + configName + "]: " + string.Join("; ", diffs));
            }
            Console.WriteLine("  " + name + " (" + configName + "): " + passed + "/" + n + " cases pass");
        }

        /// <summary>golden.py _close, recording every difference.</summary>
        static void Compare(JToken got, JToken want, Tol tol, string path, List<string> diffs)
        {
            bool gotNull = HlJson.IsNull(got), wantNull = HlJson.IsNull(want);
            if (gotNull || wantNull)
            {
                if (gotNull != wantNull) diffs.Add(path + ": got " + Show(got) + ", want " + Show(want));
                return;
            }
            if (want.Type == JTokenType.Boolean || want.Type == JTokenType.String
                || got.Type == JTokenType.Boolean || got.Type == JTokenType.String)
            {
                if (!JToken.DeepEquals(got, want)) diffs.Add(path + ": got " + Show(got) + ", want " + Show(want));
                return;
            }
            if (want.Type == JTokenType.Object)
            {
                if (got.Type != JTokenType.Object)
                {
                    diffs.Add(path + ": got " + got.Type + ", want an object");
                    return;
                }
                foreach (JProperty w in ((JObject)want).Properties())
                {
                    JToken g = got[w.Name];
                    if (g == null) diffs.Add(path + "." + w.Name + ": not evaluated");
                    else Compare(g, w.Value, tol, path + "." + w.Name, diffs);
                }
                foreach (JProperty g in ((JObject)got).Properties())
                    if (want[g.Name] == null) diffs.Add(path + "." + g.Name + ": not in golden.json");
                return;
            }
            if (want.Type == JTokenType.Array)
            {
                var wa = (JArray)want;
                var ga = got as JArray;
                if (ga == null || ga.Count != wa.Count)
                {
                    diffs.Add(path + ": got " + (ga == null ? got.Type.ToString() : ga.Count + " items") + ", want " + wa.Count + " items");
                    return;
                }
                for (int i = 0; i < wa.Count; i++) Compare(ga[i], wa[i], tol, path + "[" + i + "]", diffs);
                return;
            }
            double a = HlJson.ToDouble(got), b = HlJson.ToDouble(want);
            if (!tol.Close(a, b)) diffs.Add(path + ": got " + T.N(a) + ", want " + T.N(b));
        }

        /// <summary>A number as golden.json stores it: null where it is unknown or not finite.</summary>
        static JToken Num(double? v)
        {
            if (!v.HasValue || double.IsNaN(v.Value) || double.IsInfinity(v.Value)) return JValue.CreateNull();
            return new JValue(v.Value);
        }

        static string Show(JToken t)
        {
            return HlJson.IsNull(t) ? "null" : t.ToString(Newtonsoft.Json.Formatting.None);
        }

        /// <summary>One entry of golden.json "tolerances".</summary>
        sealed class Tol
        {
            public double Abs, Rel;

            public static Tol Of(JToken tolerances, string group)
            {
                JToken t = tolerances[group];
                if (HlJson.IsNull(t)) throw new InvalidDataException("golden.json has no tolerance for " + group);
                return new Tol { Abs = HlJson.Num(t, "abs"), Rel = HlJson.Num(t, "rel") };
            }

            public bool Close(double got, double want)
            {
                return !double.IsNaN(got) && Math.Abs(got - want) <= Abs + Rel * Math.Abs(want);
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// One physiology variant of the planner (config/variants.yaml "variants": optimistic, nominal, conservative),
    /// as pipeline/engine/physio.py params() reads it.
    /// </summary>
    public sealed class HlVariant
    {
        public readonly string Name;
        /// <summary>Efficiency of the uphill term k.</summary>
        public readonly double Eta;
        /// <summary>Oxygen uptake at zero speed, mL/kg/min.</summary>
        public readonly double V0;
        /// <summary>Multiplier of the level cost slope a_anchor.</summary>
        public readonly double AMult;
        /// <summary>
        /// Variant slope limit, degrees. Null = unknown: the config states it as the text "N - v1_rmse_deg" and no
        /// V1 slope RMSE was supplied (physio.py resolve_nogo raises MissingInput in that case).
        /// </summary>
        public readonly double? NogoDeg;
        /// <summary>The limit exactly as the config states it.</summary>
        public readonly string NogoSpec;

        public HlVariant(string name, double eta, double v0, double aMult, double? nogoDeg, string nogoSpec)
        {
            Name = name;
            Eta = eta;
            V0 = v0;
            AMult = aMult;
            NogoDeg = nogoDeg;
            NogoSpec = nogoSpec;
        }
    }

    /// <summary>
    /// The scenario of a plan (plan.json "scenario"; pipeline/engine/physio.py parse_scenario): variant and suit mass.
    /// </summary>
    public sealed class HlScenario
    {
        /// <summary>For example "nom_104".</summary>
        public readonly string Id;
        /// <summary>"nominal" | "conservative" | "optimistic".</summary>
        public readonly string Variant;
        public readonly double SuitKg;

        public HlScenario(string id, string variant, double suitKg)
        {
            Id = id;
            Variant = variant;
            SuitKg = suitKg;
        }

        /// <summary>Reads plan.json "scenario" {id, variant, suit_kg}.</summary>
        public static HlScenario FromPlan(JToken planJson)
        {
            JToken s = planJson == null || planJson.Type != JTokenType.Object ? null : planJson["scenario"];
            if (HlJson.IsNull(s)) throw new InvalidDataException("plan.json has no scenario");
            string variant = HlJson.Str(s, "variant");
            if (string.IsNullOrEmpty(variant)) throw new InvalidDataException("plan.json scenario has no variant");
            return new HlScenario(HlJson.Str(s, "id"), variant, HlJson.Num(s, "suit_kg"));
        }
    }

    /// <summary>
    /// Typed, read-only view of the planner constants a bundle carries: config_snapshot.json (config/crew.yaml,
    /// variants.yaml, hud.yaml, conditions.yaml) or the "config" block of physio/golden.json. Nothing here is a
    /// literal of this repository except unit conversions (60, 1000): every value is read from the bundle, and the
    /// derived ones are computed exactly as the planner computes them:
    ///   pipeline/engine/physio.py (Minetti coefficients and downhill clamp parsed from the formula text,
    ///   ist2_span_mars_kg, alpha_level, resolve_nogo, params),
    ///   pipeline/engine/margin.py (o2_budget_l, o2_capacity_l, btu_h_to_l_min, effort_rate_l_min, reserve_l,
    ///   station_task_rate_l_min, eva_budget_min, with the same refusal when a formula text of the config changed),
    ///   web/src/hud/config.ts (HUD constants).
    /// A value the source does not carry is null (unknown), never a default.
    /// Not carried by a bundle, so not applied here: the per-plan crew overrides of physio.py crew_values (F26:
    /// body_mass_kg, tools_kg, vo2max_ml_kg_min, effort_cap_frac). The crew is the one of config/crew.yaml.
    /// </summary>
    public sealed class HlConfig
    {
        const double SecPerMin = 60.0;
        const double MlPerL = 1000.0;

        HlConfig()
        {
        }

        /// <summary>"config_snapshot.json" or "physio/golden.json config".</summary>
        public string Source { get; private set; }
        /// <summary>config_snapshot.json config_hash ("sha256:..."); null from golden.json.</summary>
        public string ConfigHash { get; private set; }
        /// <summary>The plan's scenario (plan.json); null when the config was built without a plan.</summary>
        public HlScenario Scenario { get; private set; }

        // ---- crew.yaml
        public double BodyMassKg { get; private set; }
        public double Vo2MaxMlKgMin { get; private set; }
        public double EffortCapFrac { get; private set; }
        public double GMars { get; private set; }
        public double ToolsKg { get; private set; }
        public IReadOnlyList<double> SuitMassesKg { get; private set; }
        public double DefaultSuitKg { get; private set; }
        public double EvaH { get; private set; }
        /// <summary>The one O2 energy equivalent (D29): 21.0 J per mL O2 (not the 20.1 of the formula text).</summary>
        public double O2EnergyJPerMl { get; private set; }
        public double AnchorVo2MlKgMin { get; private set; }
        public double AnchorSpeedMs { get; private set; }
        public double AnchorCarriedKg { get; private set; }
        /// <summary>crew.yaml v_safe_ms, ascending by max_deg: slope limits (degrees) of the safety speed steps.</summary>
        public IReadOnlyList<double> VSafeMaxDeg { get; private set; }
        /// <summary>crew.yaml v_safe_ms, ascending by max_deg: safety speed (m/s) up to that slope.</summary>
        public IReadOnlyList<double> VSafeMs { get; private set; }
        /// <summary>crew.yaml walkback_budgets_min (homeline budgets, 30 and 60 min); null from golden.json.</summary>
        public IReadOnlyList<double> WalkbackBudgetsMin { get; private set; }
        /// <summary>crew.yaml o2_budget.j_per_btu; null from golden.json.</summary>
        public double? JPerBtu { get; private set; }

        // ---- variants.yaml
        public IReadOnlyDictionary<string, HlVariant> Variants { get; private set; }
        /// <summary>variants.yaml route.o2_checkpoint_min (30); null from golden.json.</summary>
        public double? O2CheckpointMin { get; private set; }
        /// <summary>
        /// variants.yaml route.access_radius_m (50): used to choose a station's access cell, NOT an arrival radius.
        /// Null from golden.json.
        /// </summary>
        public double? AccessRadiusM { get; private set; }

        // ---- derived exactly as physio.py derives them
        /// <summary>IST-2 weight span as carried mass at Mars g, kg (physio.py ist2_span_mars_kg): 106.63.</summary>
        public double Ist2SpanMarsKg { get; private set; }
        /// <summary>
        /// alpha = ist2.level_increment / (span_kg * anchor.speed), mL/kg/min per m/s per kg (physio.py alpha_level):
        /// 0.018182.
        /// </summary>
        public double Alpha { get; private set; }
        /// <summary>Minetti 2002 f(i) coefficients c5..c0 (physio.py MINETTI_COEF, parsed from variants.formulas.minetti_f).</summary>
        public IReadOnlyList<double> MinettiCoefC5ToC0 { get; private set; }
        /// <summary>Downhill multiplier clamp, low end (physio.py DOWNHILL_CLAMP, from variants.formulas.vo2_downhill): 0.4.</summary>
        public double DownhillClampLo { get; private set; }
        /// <summary>Downhill multiplier clamp, high end: 3.0.</summary>
        public double DownhillClampHi { get; private set; }

        // ---- derived exactly as margin.py derives them
        /// <summary>O2 planned against, L (margin.py o2_capacity_l = o2_budget[margin_uses]): 482.311314286.</summary>
        public double O2CapacityL { get; private set; }
        /// <summary>crew.yaml o2_budget secondary, L (margin.py o2_budget_l("secondary_L")): 150.72; null from golden.json.</summary>
        public double? O2SecondaryL { get; private set; }
        /// <summary>O2 rate at the effort cap, L/min (margin.py effort_rate_l_min): 1.35. Converts the O2 term to minutes.</summary>
        public double EffortRateLMin { get; private set; }
        /// <summary>Fixed O2 reserve, L (margin.py reserve_l = reserve_min_at_effort_cap x effort rate): 40.5.</summary>
        public double O2ReserveL { get; private set; }
        /// <summary>crew.yaml o2_margin.reserve_label ("30 min at the effort cap (EMU precedent)").</summary>
        public string O2ReserveLabel { get; private set; }
        /// <summary>crew.yaml o2_margin.label ("minutes at maximum effort").</summary>
        public string O2MarginLabel { get; private set; }
        /// <summary>O2 rate while working at a station, L/min (margin.py station_task_rate_l_min): 0.837346032.</summary>
        public double TaskRateLMin { get; private set; }
        /// <summary>Second O2 display rate, L/min (margin.py btu_h_to_l_min(planning_rate_btu_h)): 1.004815238.</summary>
        public double PlanningRateLMin { get; private set; }
        /// <summary>EVA budget, min (margin.py eva_budget_min = crew.eva_h x 60): 390.</summary>
        public double EvaBudgetMin { get; private set; }

        // ---- hud.yaml (web/src/hud/config.ts); null from golden.json
        public IReadOnlyList<double> PlaybackSpeeds { get; private set; }
        public double? DefaultSpeed { get; private set; }
        /// <summary>"minimal" | "expanded".</summary>
        public string DefaultLevel { get; private set; }
        /// <summary>hud.yaml margin_amber_min (10): alarm 4 and the amber band.</summary>
        public double? MarginAmberMin { get; private set; }
        /// <summary>hud.yaml worst_case_radii_m, ascending (10, 50, 100).</summary>
        public IReadOnlyList<double> WorstCaseRadiiM { get; private set; }
        /// <summary>hud.yaml fallback_drift.pct_of_distance (2).</summary>
        public double? DriftPctOfDistance { get; private set; }
        /// <summary>hud.yaml fallback_drift.sigma_floor_m (5).</summary>
        public double? DriftSigmaFloorM { get; private set; }
        public double? FixSigmaRoverM { get; private set; }
        public double? FixSigmaStationM { get; private set; }
        /// <summary>hud.yaml labels.simulated: the label every view must show (the same text as index.json "label").</summary>
        public string SimulatedLabel { get; private set; }
        public double? EyeHeightM { get; private set; }

        // ---- conditions.yaml; the leash also from golden.json "dose_leash"
        /// <summary>conditions.yaml leash.d_allow_mgy (0.5): the dose allowance behind tau_dose = 60 D_allow / Ddot.</summary>
        public double? DAllowMgy { get; private set; }
        /// <summary>conditions.yaml leash.d_allow_range_mgy ([0.25, 1.0]).</summary>
        public IReadOnlyList<double> DAllowRangeMgy { get; private set; }
        public double? DAllowStepMgy { get; private set; }
        /// <summary>conditions.yaml storm_replay.tripwire_at ("route_max_t_home", D39); null from golden.json.</summary>
        public string StormTripwireAt { get; private set; }
        public string StormAnchorEvent { get; private set; }
        public string StormEvaClockUnits { get; private set; }
        public string StormTieBreak { get; private set; }
        /// <summary>conditions.yaml clock.eva_start_lmst_h (9.0, D31); null from golden.json.</summary>
        public double? EvaStartLmstH { get; private set; }

        /// <summary>Effort-capped oxygen uptake, mL/kg/min (physio_core.py Params.cap): effort_cap_frac x vo2max = 18.</summary>
        public double Vo2CapMlKgMin
        {
            get { return EffortCapFrac * Vo2MaxMlKgMin; }
        }

        // ------------------------------------------------------------------ factories

        /// <summary>
        /// The config of a plan bundle: config_snapshot.json plus the scenario of plan.json.
        /// <paramref name="v1RmseDeg"/> is only needed when a variant states its slope limit as "N - v1_rmse_deg".
        /// </summary>
        public static HlConfig FromBundle(BundleReader planBundle, double? v1RmseDeg = null)
        {
            if (planBundle == null) throw new ArgumentNullException("planBundle");
            HlConfig c = FromSnapshot(planBundle.ReadJson("config_snapshot.json"), v1RmseDeg);
            if (planBundle.Has("plan.json")) c.Scenario = HlScenario.FromPlan(planBundle.ReadJson("plan.json"));
            return c;
        }

        /// <summary>
        /// From config_snapshot.json (or its "files" object): every config/*.yaml parsed, keyed by file name.
        /// crew.yaml and variants.yaml are required; hud.yaml and conditions.yaml are read when present.
        /// </summary>
        public static HlConfig FromSnapshot(JToken snapshot, double? v1RmseDeg = null)
        {
            if (HlJson.IsNull(snapshot) || snapshot.Type != JTokenType.Object)
                throw new InvalidDataException("config snapshot is not an object");
            JToken files = HlJson.IsNull(snapshot["files"]) ? snapshot : snapshot["files"];
            JToken crew = Need(files, "crew.yaml", "config_snapshot.json");
            JToken vars = Need(files, "variants.yaml", "config_snapshot.json");

            var c = new HlConfig();
            c.Source = "config_snapshot.json";
            c.ConfigHash = HlJson.Str(snapshot, "config_hash");
            c.ReadCrew(crew);
            c.ReadVariants(Need(vars, "variants", "variants.yaml"), v1RmseDeg);
            c.WalkbackBudgetsMin = HlJson.Doubles(crew["walkback_budgets_min"]);

            // physio.py: MINETTI_COEF and DOWNHILL_CLAMP come from the formula text, so the config stays the single source.
            JToken formulas = Need(vars, "formulas", "variants.yaml");
            c.MinettiCoefC5ToC0 = ParseMinetti(Text(formulas, "minetti_f", "variants.yaml formulas"));
            double lo, hi;
            ParseClamp(Text(formulas, "vo2_downhill", "variants.yaml formulas"), out lo, out hi);
            c.DownhillClampLo = lo;
            c.DownhillClampHi = hi;

            // physio.py ist2_span_mars_kg and alpha_level.
            Check(BeforeHash(Text(formulas, "ist2_span_kg", "variants.yaml formulas")),
                "span_kg = (g_frac[1] - g_frac[0]) * g_earth_ms2 * (system_kg + subject_kg) / crew.g_mars",
                "variants.yaml formulas.ist2_span_kg");
            Check(BeforeHash(Text(formulas, "alpha", "variants.yaml formulas")),
                "alpha = ist2.level_increment / (span_kg * anchor.speed)", "variants.yaml formulas.alpha");
            JToken ist2 = Need(vars, "ist2", "variants.yaml");
            if (HlJson.Str(ist2, "level_span") != "weight_span")
                throw new InvalidDataException("variants.yaml ist2.level_span must be 'weight_span'");
            JToken w = Need(ist2, "weight_span", "variants.yaml ist2");
            double[] gFrac = HlJson.Doubles(Need(w, "g_frac", "variants.yaml ist2.weight_span"));
            double dg = (gFrac[1] - gFrac[0]) * HlJson.Num(ist2, "g_earth_ms2");
            c.Ist2SpanMarsKg = dg * (HlJson.Num(w, "system_kg") + HlJson.Num(w, "subject_kg")) / c.GMars;
            c.Alpha = HlJson.Num(ist2, "level_increment_ml_kg_min") / (c.Ist2SpanMarsKg * c.AnchorSpeedMs);

            // margin.py: O2 budget, rates, reserve and EVA budget, refused when a formula text changed.
            JToken budget = Need(crew, "o2_budget", "crew.yaml");
            Check(Text(budget, "formula", "crew.yaml o2_budget"),
                "O2_L = hours * rate_btu_h * j_per_btu / o2_energy_j_per_ml / 1000", "crew.yaml o2_budget.formula");
            c.JPerBtu = HlJson.Num(budget, "j_per_btu");
            double primary = HlJson.Num(budget, "primary_design_eva_h")
                * c.BtuHToLMin(HlJson.Num(budget, "primary_design_rate_btu_h")) * 60.0;
            double secondary = HlJson.Num(budget, "secondary_eva_h")
                * c.BtuHToLMin(HlJson.Num(budget, "secondary_design_rate_btu_h")) * 60.0;
            string uses = HlJson.Str(budget, "margin_uses");
            if (uses == "primary_L") c.O2CapacityL = primary;
            else if (uses == "secondary_L") c.O2CapacityL = secondary;
            else throw new InvalidDataException("crew.yaml o2_budget.margin_uses is not primary_L or secondary_L: " + uses);
            c.O2SecondaryL = secondary;

            JToken route = Need(vars, "route", "variants.yaml");
            if (HlJson.Str(route, "o2_margin") != "crew.o2_margin")
                throw new InvalidDataException("variants.yaml route.o2_margin must point at crew.o2_margin");
            JToken om = Need(crew, "o2_margin", "crew.yaml");
            Check(Text(om, "effort_rate_L_min", "crew.yaml o2_margin"),
                "effort_cap_frac * vo2max_ml_kg_min * body_mass_kg / 1000", "crew.yaml o2_margin.effort_rate_L_min");
            c.EffortRateLMin = c.EffortCapFrac * c.Vo2MaxMlKgMin * c.BodyMassKg / MlPerL;
            Check(Text(om, "reserve_L", "crew.yaml o2_margin"),
                "reserve_min_at_effort_cap * effort_rate_L_min", "crew.yaml o2_margin.reserve_L");
            c.O2ReserveL = HlJson.Num(om, "reserve_min_at_effort_cap") * c.EffortRateLMin;
            c.O2ReserveLabel = HlJson.Str(om, "reserve_label");
            c.O2MarginLabel = HlJson.Str(om, "label");
            Check(Text(om, "station_task_rate_formula", "crew.yaml o2_margin"),
                "station_task_rate_btu_h * o2_budget.j_per_btu / 60 / o2_energy_j_per_ml / 1000",
                "crew.yaml o2_margin.station_task_rate_formula");
            c.TaskRateLMin = c.BtuHToLMin(HlJson.Num(om, "station_task_rate_btu_h"));
            c.PlanningRateLMin = c.BtuHToLMin(HlJson.Num(om, "planning_rate_btu_h"));
            Check(Text(route, "eva_term", "variants.yaml route"), "crew.eva_h * 60 - t - T_home", "variants.yaml route.eva_term");
            c.EvaBudgetMin = c.EvaH * 60.0;
            c.O2CheckpointMin = HlJson.NumOrNull(route, "o2_checkpoint_min");
            c.AccessRadiusM = HlJson.NumOrNull(route, "access_radius_m");

            JToken hud = files["hud.yaml"];
            if (!HlJson.IsNull(hud)) c.ReadHud(hud);
            JToken conditions = files["conditions.yaml"];
            if (!HlJson.IsNull(conditions)) c.ReadConditions(conditions);
            return c;
        }

        /// <summary>
        /// From the "config" block of physio/golden.json (pipeline/engine/golden.py config_used): the crew and variant
        /// values plus the derived numbers the planner printed (rounded to 9 decimals, far below every tolerance).
        /// HUD and storm-replay values are not in that block and stay null. Accepts the whole golden.json too.
        /// </summary>
        public static HlConfig FromGolden(JToken goldenConfig)
        {
            if (HlJson.IsNull(goldenConfig) || goldenConfig.Type != JTokenType.Object)
                throw new InvalidDataException("golden config is not an object");
            if (!HlJson.IsNull(goldenConfig["config"]) && HlJson.IsNull(goldenConfig["crew"]))
                goldenConfig = goldenConfig["config"];
            JToken d = Need(goldenConfig, "derived", "golden.json config");

            var c = new HlConfig();
            c.Source = "physio/golden.json config";
            c.ReadCrew(Need(goldenConfig, "crew", "golden.json config"));
            c.ReadVariants(Need(goldenConfig, "variants", "golden.json config"), null);
            c.MinettiCoefC5ToC0 = HlJson.Doubles(Need(d, "minetti_coef_c5_to_c0", "golden.json config.derived"));
            if (c.MinettiCoefC5ToC0.Count != 6)
                throw new InvalidDataException("golden.json: minetti_coef_c5_to_c0 needs 6 values");
            double[] clamp = HlJson.Doubles(Need(d, "downhill_clamp", "golden.json config.derived"));
            c.DownhillClampLo = clamp[0];
            c.DownhillClampHi = clamp[1];
            c.Ist2SpanMarsKg = HlJson.Num(d, "ist2_span_mars_kg");
            c.Alpha = HlJson.Num(d, "alpha_ml_kg_min_per_ms_per_kg");
            c.O2CapacityL = HlJson.Num(d, "o2_budget_L");
            c.O2ReserveL = HlJson.Num(d, "o2_reserve_L");
            c.O2ReserveLabel = HlJson.Str(d, "o2_reserve_label");
            c.EffortRateLMin = HlJson.Num(d, "effort_rate_L_min");
            c.TaskRateLMin = HlJson.Num(d, "station_task_rate_L_min");
            c.PlanningRateLMin = HlJson.Num(d, "planning_rate_L_min");
            c.EvaBudgetMin = HlJson.Num(d, "eva_budget_min");
            JToken om = goldenConfig["o2_margin"];
            if (!HlJson.IsNull(om)) c.O2MarginLabel = HlJson.Str(om, "label");
            JToken leash = goldenConfig["dose_leash"];
            if (!HlJson.IsNull(leash)) c.ReadLeash(leash);
            return c;
        }

        /// <summary>A copy of this config bound to a scenario (plan.json scenario).</summary>
        public HlConfig WithScenario(HlScenario scenario)
        {
            var c = (HlConfig)MemberwiseClone();
            c.Scenario = scenario;
            return c;
        }

        // ------------------------------------------------------------------ what the formulas ask for

        /// <summary>The named variant; throws when the config has none of that name.</summary>
        public HlVariant Variant(string name)
        {
            HlVariant v;
            if (name == null || !Variants.TryGetValue(name, out v))
                throw new KeyNotFoundException("no such variant in the config: " + name);
            return v;
        }

        /// <summary>
        /// Walker parameters for a variant and a suit mass: carried mass M = suit + tools (physio.py params).
        /// Throws when the variant's slope limit is unknown (see <see cref="HlVariant.NogoDeg"/>).
        /// </summary>
        public PhysioParams Params(string variant, double suitKg)
        {
            return ParamsForCarried(variant, suitKg + ToolsKg);
        }

        /// <summary>Walker parameters for a variant and a carried mass M, kg (physio.py params(carried_kg=...)).</summary>
        public PhysioParams ParamsForCarried(string variant, double carriedKg)
        {
            HlVariant v = Variant(variant);
            if (!v.NogoDeg.HasValue)
                throw new InvalidOperationException(
                    "variant " + variant + ": nogo_deg '" + v.NogoSpec + "' needs v1_rmse_deg (V1 slope RMSE)");
            return new PhysioParams(v.Name, v.Eta, v.V0, v.AMult, v.NogoDeg.Value, BodyMassKg, carriedKg, GMars,
                Vo2MaxMlKgMin, EffortCapFrac, AnchorVo2MlKgMin, AnchorSpeedMs, AnchorCarriedKg, Alpha, O2EnergyJPerMl,
                VSafeMaxDeg, VSafeMs, MinettiCoefC5ToC0, DownhillClampLo, DownhillClampHi);
        }

        /// <summary>Walker parameters of the plan's scenario (plan.json scenario.variant and suit_kg).</summary>
        public PhysioParams ScenarioParams()
        {
            return Params(NeedScenario().Variant, Scenario.SuitKg);
        }

        /// <summary>The variant of the plan's scenario (eta, V0, a_mult, slope limit).</summary>
        public HlVariant ScenarioVariant
        {
            get { return Variant(NeedScenario().Variant); }
        }

        /// <summary>Carried mass M of the plan's scenario, kg: suit + tools (physio.py params).</summary>
        public double ScenarioCarriedKg
        {
            get { return NeedScenario().SuitKg + ToolsKg; }
        }

        HlScenario NeedScenario()
        {
            if (Scenario == null)
                throw new InvalidOperationException("this config has no scenario (build it with FromBundle or WithScenario)");
            return Scenario;
        }

        /// <summary>Metabolic rate (BTU/h) to O2 uptake (L/min) at o2_energy_j_per_ml (margin.py btu_h_to_l_min).</summary>
        public double BtuHToLMin(double btuH)
        {
            if (!JPerBtu.HasValue) throw new InvalidOperationException("j_per_btu is not in this config (" + Source + ")");
            return btuH * JPerBtu.Value / SecPerMin / O2EnergyJPerMl / MlPerL;
        }

        // ------------------------------------------------------------------ readers

        void ReadCrew(JToken crew)
        {
            BodyMassKg = HlJson.Num(crew, "body_mass_kg");
            Vo2MaxMlKgMin = HlJson.Num(crew, "vo2max_ml_kg_min");
            EffortCapFrac = HlJson.Num(crew, "effort_cap_frac");
            GMars = HlJson.Num(crew, "g_mars");
            ToolsKg = HlJson.Num(crew, "tools_kg");
            SuitMassesKg = HlJson.Doubles(Need(crew, "suit_masses_kg", "crew"));
            DefaultSuitKg = HlJson.Num(crew, "default_suit_kg");
            EvaH = HlJson.Num(crew, "eva_h");
            O2EnergyJPerMl = HlJson.Num(crew, "o2_energy_j_per_ml");
            JToken a = Need(crew, "anchor", "crew");
            AnchorVo2MlKgMin = HlJson.Num(a, "vo2_ml_kg_min");
            AnchorSpeedMs = HlJson.Num(a, "speed_ms");
            AnchorCarriedKg = HlJson.Num(a, "carried_kg");

            var rows = new List<KeyValuePair<double, double>>();
            foreach (JToken r in (JArray)Need(crew, "v_safe_ms", "crew"))
                rows.Add(new KeyValuePair<double, double>(HlJson.Num(r, "max_deg"), HlJson.Num(r, "v")));
            if (rows.Count == 0) throw new InvalidDataException("crew v_safe_ms is empty");
            rows.Sort((x, y) => x.Key.CompareTo(y.Key));
            var maxDeg = new double[rows.Count];
            var v = new double[rows.Count];
            for (int i = 0; i < rows.Count; i++)
            {
                maxDeg[i] = rows[i].Key;
                v[i] = rows[i].Value;
            }
            VSafeMaxDeg = maxDeg;
            VSafeMs = v;
        }

        void ReadVariants(JToken variants, double? v1RmseDeg)
        {
            var map = new Dictionary<string, HlVariant>(StringComparer.Ordinal);
            foreach (JProperty p in ((JObject)variants).Properties())
            {
                JToken v = p.Value;
                JToken nogo = v["nogo_deg"];
                if (HlJson.IsNull(nogo)) throw new InvalidDataException("variant " + p.Name + " has no nogo_deg");
                string spec = nogo.Type == JTokenType.String ? (string)nogo : HlJson.F(HlJson.ToDouble(nogo), 6);
                map[p.Name] = new HlVariant(p.Name, HlJson.Num(v, "eta"), HlJson.Num(v, "V0"), HlJson.Num(v, "a_mult"),
                    ResolveNogo(nogo, v1RmseDeg), spec);
            }
            if (map.Count == 0) throw new InvalidDataException("the config has no variants");
            Variants = map;
        }

        /// <summary>physio.py resolve_nogo: a number, or the text "N - v1_rmse_deg" (null when the RMSE is not known).</summary>
        static double? ResolveNogo(JToken spec, double? v1RmseDeg)
        {
            if (spec.Type == JTokenType.Integer || spec.Type == JTokenType.Float) return HlJson.ToDouble(spec);
            Match m = Regex.Match((string)spec, @"^\s*([0-9.]+)\s*-\s*v1_rmse_deg\s*$", RegexOptions.CultureInvariant);
            if (!m.Success) throw new InvalidDataException("cannot parse nogo_deg '" + (string)spec + "'");
            if (!v1RmseDeg.HasValue) return null;
            return Inv(m.Groups[1].Value) - v1RmseDeg.Value;
        }

        void ReadHud(JToken hud)
        {
            PlaybackSpeeds = HlJson.Doubles(hud["playback_speeds"]);
            DefaultSpeed = HlJson.NumOrNull(hud, "default_speed");
            DefaultLevel = HlJson.Str(hud, "default_level");
            MarginAmberMin = HlJson.NumOrNull(hud, "margin_amber_min");
            double[] radii = HlJson.Doubles(hud["worst_case_radii_m"]);
            if (radii != null) Array.Sort(radii);
            WorstCaseRadiiM = radii;
            JToken drift = hud["fallback_drift"];
            DriftPctOfDistance = HlJson.NumOrNull(drift, "pct_of_distance");
            DriftSigmaFloorM = HlJson.NumOrNull(drift, "sigma_floor_m");
            JToken fix = hud["fix_sigma_m"];
            FixSigmaRoverM = HlJson.NumOrNull(fix, "rover");
            FixSigmaStationM = HlJson.NumOrNull(fix, "station");
            SimulatedLabel = HlJson.Str(hud["labels"], "simulated");
            EyeHeightM = HlJson.NumOrNull(hud, "eye_height_m");
        }

        void ReadConditions(JToken conditions)
        {
            JToken leash = conditions["leash"];
            if (!HlJson.IsNull(leash)) ReadLeash(leash);
            JToken sr = conditions["storm_replay"];
            StormTripwireAt = HlJson.Str(sr, "tripwire_at");
            StormAnchorEvent = HlJson.Str(sr, "anchor_event");
            StormEvaClockUnits = HlJson.Str(sr, "eva_clock_units");
            StormTieBreak = HlJson.Str(sr, "tie_break");
            EvaStartLmstH = HlJson.NumOrNull(conditions["clock"], "eva_start_lmst_h");
        }

        void ReadLeash(JToken leash)
        {
            // golden.py dose_cases refuses any other leash formula.
            string formula = HlJson.Str(leash, "formula");
            if (formula != null) Check(formula, "tau_dose_min = 60 * D_allow / Ddot_mGy_per_h", "conditions.yaml leash.formula");
            DAllowMgy = HlJson.NumOrNull(leash, "d_allow_mgy");
            DAllowRangeMgy = HlJson.Doubles(leash["d_allow_range_mgy"]);
            DAllowStepMgy = HlJson.NumOrNull(leash, "d_allow_step_mgy");
        }

        // ------------------------------------------------------------------ formula text (physio.py, margin.py)

        /// <summary>
        /// Coefficients c5..c0 of f(i) from "f(i) = 280.5 i^5 - 58.7 i^4 ... + 2.5 # ..." (physio.py _parse_minetti).
        /// </summary>
        public static double[] ParseMinetti(string text)
        {
            int eq = text.IndexOf('=');
            if (eq < 0) throw new InvalidDataException("cannot parse the Minetti formula: " + text);
            string rhs = BeforeHash(text.Substring(eq + 1)).Replace(" ", "");
            var coef = new double[6];
            int found = 0;
            foreach (Match m in Regex.Matches(rhs, @"([+-]?)([0-9.]+)(i)?(?:\^([0-9]))?", RegexOptions.CultureInvariant))
            {
                bool hasVar = m.Groups[3].Success;
                int deg = !hasVar ? 0 : (m.Groups[4].Success ? int.Parse(m.Groups[4].Value, CultureInfo.InvariantCulture) : 1);
                if (deg > 5) throw new InvalidDataException("Minetti formula has a power above 5: " + text);
                coef[deg] = Inv(m.Groups[2].Value) * (m.Groups[1].Value == "-" ? -1.0 : 1.0);
                found++;
            }
            if (found == 0) throw new InvalidDataException("cannot parse the Minetti formula: " + text);
            var c5ToC0 = new double[6];
            for (int d = 5; d >= 0; d--) c5ToC0[5 - d] = coef[d];
            return c5ToC0;
        }

        /// <summary>The (lo, hi) of "clamp(f(i) / f(0), lo, hi)" in variants.formulas.vo2_downhill (physio.py _parse_clamp).</summary>
        public static void ParseClamp(string text, out double lo, out double hi)
        {
            Match m = Regex.Match(text, @"clamp\(\s*f\(i\)\s*/\s*f\(0\)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)",
                RegexOptions.CultureInvariant);
            if (!m.Success) throw new InvalidDataException("cannot parse the downhill clamp from: " + text);
            lo = Inv(m.Groups[1].Value);
            hi = Inv(m.Groups[2].Value);
        }

        static double Inv(string number)
        {
            return double.Parse(number, NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        static string BeforeHash(string text)
        {
            int i = text.IndexOf('#');
            return i < 0 ? text : text.Substring(0, i);
        }

        /// <summary>The planner refuses to run when a formula text it implements was edited; so does this port.</summary>
        static void Check(string text, string expected, string key)
        {
            if (text.Replace(" ", "") != expected.Replace(" ", ""))
                throw new InvalidDataException(key + " changed: '" + text + "'; the C# port implements '" + expected + "'");
        }

        static JToken Need(JToken obj, string key, string where)
        {
            JToken t = obj == null || obj.Type != JTokenType.Object ? null : obj[key];
            if (HlJson.IsNull(t)) throw new InvalidDataException(where + ": missing " + key);
            return t;
        }

        static string Text(JToken obj, string key, string where)
        {
            string s = HlJson.Str(obj, key);
            if (s == null) throw new InvalidDataException(where + ": missing " + key);
            return s;
        }
    }
}

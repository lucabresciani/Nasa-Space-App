using System;
using System.Collections.Generic;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// The walker of one scenario: a variant plus a carried mass. Port of the Params dataclass of
    /// pipeline/engine/physio_core.py, filled as pipeline/engine/physio.py params() fills it.
    /// Build it with <see cref="HlConfig.Params"/> so every number comes from the bundle.
    /// </summary>
    public sealed class PhysioParams
    {
        public readonly string Variant;
        public readonly double Eta;
        /// <summary>Oxygen uptake at zero speed, mL/kg/min.</summary>
        public readonly double V0;
        public readonly double AMult;
        /// <summary>Variant slope limit, degrees: a grade is impassable when |grade| &gt; NogoDeg + 1e-9.</summary>
        public readonly double NogoDeg;
        /// <summary>Body mass m_b, kg.</summary>
        public readonly double BodyMassKg;
        /// <summary>Carried mass M = suit + tools, kg.</summary>
        public readonly double CarriedKg;
        /// <summary>Gravity, m/s2.</summary>
        public readonly double G;
        public readonly double Vo2Max;
        public readonly double EffortCap;
        public readonly double AnchorVo2;
        public readonly double AnchorSpeed;
        public readonly double AnchorCarriedKg;
        public readonly double Alpha;
        /// <summary>O2 energy equivalent, J per mL (crew.yaml o2_energy_j_per_ml).</summary>
        public readonly double JPerMl;
        public readonly double DownhillClampLo;
        public readonly double DownhillClampHi;

        readonly double[] vsafeMaxDeg;
        readonly double[] vsafeV;
        readonly double[] minetti;

        public PhysioParams(string variant, double eta, double v0, double aMult, double nogoDeg, double bodyMassKg,
            double carriedKg, double g, double vo2Max, double effortCap, double anchorVo2, double anchorSpeed,
            double anchorCarriedKg, double alpha, double jPerMl, IReadOnlyList<double> vsafeMaxDegAscending,
            IReadOnlyList<double> vsafeMs, IReadOnlyList<double> minettiC5ToC0, double downhillClampLo, double downhillClampHi)
        {
            if (vsafeMaxDegAscending == null || vsafeMs == null || vsafeMaxDegAscending.Count != vsafeMs.Count)
                throw new ArgumentException("v_safe table: max_deg and v differ in length");
            if (minettiC5ToC0 == null || minettiC5ToC0.Count == 0) throw new ArgumentException("no Minetti coefficients");
            Variant = variant;
            Eta = eta;
            V0 = v0;
            AMult = aMult;
            NogoDeg = nogoDeg;
            BodyMassKg = bodyMassKg;
            CarriedKg = carriedKg;
            G = g;
            Vo2Max = vo2Max;
            EffortCap = effortCap;
            AnchorVo2 = anchorVo2;
            AnchorSpeed = anchorSpeed;
            AnchorCarriedKg = anchorCarriedKg;
            Alpha = alpha;
            JPerMl = jPerMl;
            DownhillClampLo = downhillClampLo;
            DownhillClampHi = downhillClampHi;
            vsafeMaxDeg = Copy(vsafeMaxDegAscending);
            vsafeV = Copy(vsafeMs);
            minetti = Copy(minettiC5ToC0);
            for (int i = 1; i < vsafeMaxDeg.Length; i++)
                if (!(vsafeMaxDeg[i] > vsafeMaxDeg[i - 1])) throw new ArgumentException("v_safe table is not ascending by max_deg");
        }

        /// <summary>Level cost slope of the anchor, mL/kg/min per m/s: (anchor.vo2 - V0) / anchor.speed.</summary>
        public double AAnchor
        {
            get { return (AnchorVo2 - V0) / AnchorSpeed; }
        }

        /// <summary>Effort-capped VO2, mL/kg/min: effort_cap x VO2max.</summary>
        public double Cap
        {
            get { return EffortCap * Vo2Max; }
        }

        /// <summary>Rows of the v_safe table (ascending by slope limit).</summary>
        public int VSafeRows
        {
            get { return vsafeMaxDeg.Length; }
        }

        public double VSafeMaxDeg(int row)
        {
            return vsafeMaxDeg[row];
        }

        public double VSafeMs(int row)
        {
            return vsafeV[row];
        }

        /// <summary>Minetti 2002 cost-of-transport shape f(i), i = tan(grade) (physio_core.py minetti_f; Horner as numpy.polyval).</summary>
        public double MinettiF(double i)
        {
            double r = 0.0;
            for (int k = 0; k < minetti.Length; k++) r = r * i + minetti[k];
            return r;
        }

        static double[] Copy(IReadOnlyList<double> src)
        {
            var a = new double[src.Count];
            for (int i = 0; i < a.Length; i++) a[i] = src[i];
            return a;
        }
    }

    /// <summary>
    /// One straight segment walked at the governed speed (pipeline/engine/golden.py o2_leg_case, the router's rule,
    /// and pipeline/engine/physio_core.py step): grade = atan(dz / horizontal length), time = horizontal length / v*.
    /// </summary>
    public struct PhysioSegment
    {
        /// <summary>Horizontal length, m.</summary>
        public double LengthM;
        /// <summary>Grade in degrees, positive = uphill in the direction of travel.</summary>
        public double GradeDeg;
        /// <summary>Governed speed v*, m/s (reported even when the segment is impassable, as golden.json does).</summary>
        public double VStarMs;
        public bool Passable;
        /// <summary>Minutes on the segment; null = impassable.</summary>
        public double? TMin;
        /// <summary>Litres of O2 on the segment; null = impassable.</summary>
        public double? O2L;
    }

    /// <summary>
    /// Suited walking oxygen model and speed governor (SPEC F3) of one walker (variant + carried mass): port of
    /// pipeline/engine/physio_core.py (a_of_m, k_uphill, cost_slope, vo2, v_safe, governor, o2_litres, heat_w, step),
    /// with the parameters of pipeline/engine/physio.py params(). Validated by the "physio" and "o2_leg" groups of
    /// physio/golden.json. Grades are in DEGREES here (positive = uphill in the direction of travel); the Python
    /// takes radians.
    ///   a(M) = a_anchor * a_mult + alpha * (M - anchor.carried_kg)
    ///   k    = (m_b + M) g sin(theta) / (eta m_b) * 60 / o2_energy_j_per_ml     theta &gt; 0, else 0
    ///          (the config formula text says 20.1; the planner's code and golden use o2_energy_j_per_ml = 21.0)
    ///   VO2  = V0 + (a(M) + k) v                                                theta &gt;= 0
    ///   VO2  = V0 + a(M) clamp(f(i) / f(0), lo, hi) v,  i = tan(theta)          theta &lt; 0
    ///   v*   = min(v_safe(|theta|), (effort_cap VO2max - V0) / cost_slope)
    ///   O2 [L] = VO2 m_b minutes / 1000
    /// There is no cap and no smoothing on VO2: the governor limits speed instead. Immutable, double precision.
    /// The only literals are unit conversions (60 s/min, 1000 mL/L, pi/180).
    /// </summary>
    public sealed class Physio
    {
        public const double SecPerMin = 60.0;
        public const double MlPerL = 1000.0;
        const double Deg2Rad = Math.PI / 180.0;
        const double Rad2Deg = 180.0 / Math.PI;

        /// <summary>Tolerance of the no-go comparison, degrees (physio_core.py step and grade_table, golden.py: |grade| &lt;= nogo_deg + 1e-9).</summary>
        public const double NogoToleranceDeg = 1e-9;

        readonly PhysioParams p;
        readonly double aOfM;

        /// <summary>The walker of the plan's scenario (plan.json scenario: variant and suit mass; M = suit + tools).</summary>
        public Physio(HlConfig config)
            : this(Need(config).ScenarioParams())
        {
        }

        /// <summary>A walker of the named variant with a suit mass in kg (physio.py params(variant, suit_kg)).</summary>
        public Physio(HlConfig config, string variant, double suitKg)
            : this(Need(config).Params(variant, suitKg))
        {
        }

        public Physio(PhysioParams parameters)
        {
            if (parameters == null) throw new ArgumentNullException("parameters");
            p = parameters;
            aOfM = AOfMFor(p.CarriedKg);
        }

        /// <summary>The walker's parameters (variant, masses, limits).</summary>
        public PhysioParams Params
        {
            get { return p; }
        }

        /// <summary>Level cost slope a(M) of the walker's own carried mass, mL/kg/min per m/s (physio_core.py a_of_m).</summary>
        public double AOfM
        {
            get { return aOfM; }
        }

        /// <summary>Effort-capped oxygen uptake, mL/kg/min: effort_cap x VO2max (physio_core.py Params.cap).</summary>
        public double Vo2Cap
        {
            get { return p.Cap; }
        }

        /// <summary>
        /// O2 use in L/min at zero speed: V0 x m_b / 1000 (the model at v = 0, whatever the grade). The planner never
        /// stands still on a leg and uses the station task rate while working, so WHERE this rate applies (idle away
        /// from a station) is the caller's assumption, not the planner's.
        /// </summary>
        public double RestO2RateLMin
        {
            get { return O2Litres(p.V0, 1.0); }
        }

        /// <summary>Level cost slope a(M) for another carried mass M, kg (physio_core.py a_of_m(p, m)).</summary>
        public double AOfMFor(double carriedKg)
        {
            return p.AAnchor * p.AMult + p.Alpha * (carriedKg - p.AnchorCarriedKg);
        }

        /// <summary>clamp(f(i) / f(0), lo, hi) for i = tan(theta) &lt; 0 (physio_core.py downhill_mult).</summary>
        public double DownhillMult(double i)
        {
            double m = p.MinettiF(i) / p.MinettiF(0.0);
            return Math.Min(Math.Max(m, p.DownhillClampLo), p.DownhillClampHi);
        }

        /// <summary>Uphill term k, mL/kg/min per m/s; 0 for grade &lt;= 0 (physio_core.py k_uphill).</summary>
        public double KUphill(double gradeDeg)
        {
            return KUphillRad(gradeDeg * Deg2Rad);
        }

        /// <summary>d VO2 / d v at a grade: a + k uphill and level, a * clamp(f / f0) downhill (physio_core.py cost_slope).</summary>
        public double CostSlope(double gradeDeg)
        {
            return CostSlopeRad(gradeDeg * Deg2Rad);
        }

        /// <summary>Oxygen uptake, mL/kg/min, at a speed (m/s) and grade (physio_core.py vo2). At speed 0 it is V0.</summary>
        public double Vo2(double speedMs, double gradeDeg)
        {
            return p.V0 + CostSlopeRad(gradeDeg * Deg2Rad) * speedMs;
        }

        /// <summary>O2 use in L/min at a speed and grade: VO2 x m_b / 1000 (physio_core.py o2_litres over one minute).</summary>
        public double O2RateLMin(double speedMs, double gradeDeg)
        {
            return O2Litres(Vo2(speedMs, gradeDeg), 1.0);
        }

        /// <summary>
        /// Safety speed from the crew.yaml v_safe table by |grade| (the sign is ignored): the row with the smallest
        /// max_deg that has |grade| &lt;= max_deg. Null = no row, i.e. steeper than the table's last step (physio_core.py
        /// v_safe returns 0 there). This is the table alone: the variant's own slope limit is <see cref="Passable"/>.
        /// </summary>
        public double? VSafe(double absGradeDeg)
        {
            double deg = Math.Abs(absGradeDeg);
            for (int i = 0; i < p.VSafeRows; i++)
                if (deg <= p.VSafeMaxDeg(i)) return p.VSafeMs(i);
            return null;
        }

        /// <summary>
        /// Governed speed v*, m/s = min(v_safe, (cap - V0) / cost_slope) (physio_core.py governor). 0 beyond the v_safe
        /// table. Exactly as the planner, it does NOT apply the variant's slope limit (golden.json "v_star_ms" is
        /// non-zero on impassable grades): use <see cref="Passable"/> or <see cref="WalkSpeed"/> for "may I walk here".
        /// </summary>
        public double Governor(double gradeDeg)
        {
            return GovernorRad(gradeDeg * Deg2Rad, Math.Abs(gradeDeg));
        }

        /// <summary>True when the grade is within the variant's slope limit and v* &gt; 0 (golden.py physio_case "passable").</summary>
        public bool Passable(double gradeDeg)
        {
            return Math.Abs(gradeDeg) <= p.NogoDeg + NogoToleranceDeg && Governor(gradeDeg) > 0.0;
        }

        /// <summary>Governed speed v* in m/s where the grade is passable; null = no-go for this variant.</summary>
        public double? WalkSpeed(double gradeDeg)
        {
            if (!(Math.Abs(gradeDeg) <= p.NogoDeg + NogoToleranceDeg)) return null;
            double v = Governor(gradeDeg);
            return v > 0.0 ? (double?)v : null;
        }

        /// <summary>Seconds per metre at v*; null = impassable (golden.json "pace_s_per_m").</summary>
        public double? PaceSPerM(double gradeDeg)
        {
            double? v = WalkSpeed(gradeDeg);
            return v.HasValue ? (double?)(1.0 / v.Value) : null;
        }

        /// <summary>Litres of O2 per metre at v*; null = impassable (golden.json "o2_L_per_m").</summary>
        public double? O2LPerM(double gradeDeg)
        {
            double? v = WalkSpeed(gradeDeg);
            if (!v.HasValue) return null;
            return O2Litres(Vo2(v.Value, gradeDeg), 1.0 / v.Value / SecPerMin);
        }

        /// <summary>O2 in litres for a constant VO2 (mL/kg/min) over some minutes: VO2 x m_b x minutes / 1000 (physio_core.py o2_litres).</summary>
        public double O2Litres(double vo2MlKgMin, double minutes)
        {
            return vo2MlKgMin * p.BodyMassKg * minutes / MlPerL;
        }

        /// <summary>Metabolic heat, W = VO2 x m_b / 60 x o2_energy_j_per_ml (physio_core.py heat_w).</summary>
        public double HeatW(double vo2MlKgMin)
        {
            return vo2MlKgMin * p.BodyMassKg / SecPerMin * p.JPerMl;
        }

        /// <summary>
        /// One straight segment at the governed speed: grade = atan2(dz, horizontal), time = horizontal / v* / 60,
        /// O2 = o2_litres(VO2(v*, grade), time). Impassable (beyond the variant's slope limit, or v* = 0) gives null
        /// time and O2 (golden.py o2_leg_case; physio_core.py step returns infinity there).
        /// </summary>
        public PhysioSegment Segment(double horizontalM, double dzM)
        {
            double th = Math.Atan2(dzM, horizontalM);
            double deg = th * Rad2Deg;
            double v = GovernorRad(th, Math.Abs(deg));
            bool ok = Math.Abs(deg) <= p.NogoDeg + NogoToleranceDeg && v > 0.0;
            var s = new PhysioSegment();
            s.LengthM = horizontalM;
            s.GradeDeg = deg;
            s.VStarMs = v;
            s.Passable = ok;
            if (ok)
            {
                double t = horizontalM / v / SecPerMin;
                s.TMin = t;
                s.O2L = O2Litres(p.V0 + CostSlopeRad(th) * v, t);
            }
            return s;
        }

        /// <summary>Grade angle in degrees of a step that rises <paramref name="dzM"/> over <paramref name="horizontalM"/> (atan2, as golden.py).</summary>
        public static double GradeDeg(double dzM, double horizontalM)
        {
            return Math.Atan2(dzM, horizontalM) * Rad2Deg;
        }

        double KUphillRad(double th)
        {
            if (!(th > 0.0)) return 0.0;
            return (p.BodyMassKg + p.CarriedKg) * p.G * Math.Sin(th) / (p.Eta * p.BodyMassKg) * SecPerMin / p.JPerMl;
        }

        double CostSlopeRad(double th)
        {
            if (th >= 0.0) return aOfM + KUphillRad(th);
            return aOfM * DownhillMult(Math.Tan(th));
        }

        double GovernorRad(double th, double absDeg)
        {
            double vs = VSafe(absDeg) ?? 0.0;
            double vCap = Math.Max(p.Cap - p.V0, 0.0) / CostSlopeRad(th);
            return Math.Min(vs, vCap);
        }

        static HlConfig Need(HlConfig config)
        {
            if (config == null) throw new ArgumentNullException("config");
            return config;
        }
    }
}

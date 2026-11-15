using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Per-frame inputs of <see cref="SuitTelemetry.Tick"/>, filled by HelmetHud from the player, sky hub and weather.
    /// </summary>
    public struct TelemetryInput
    {
        public float HorizontalSpeed;   // m/s, Player.Velocity on XZ (or camera displacement / dt without Player)
        public float VerticalSpeed;     // m/s, Player.Velocity.y; 0 when !Grounded
        public bool Grounded;           // Player.IsGrounded (true without Player)
        public bool Sprinting;          // Player.IsSprinting
        public float SlopeDeg;          // Player.GroundSlope (unsigned), 0 without Player
        public float LocalSolarTime;    // 0..1 sol fraction (MarsSkyState.LocalSolarTime if Version > 0, else DayNight.TimeOfDay, else NaN)
        public int Sol;                 // MarsSkyState.Sol if Version > 0, else -1
        public float AirTempMinC, AirTempMaxC; // Weather.Climate medians, else -74.5 / -19.5 (REMS Ls 10-35 medians)
        public Vector3 CameraPosition;  // world
        public float DustDevilProximity; // DustDevilField.ClosePass
        public Vector2 VelocityXZ;      // m/s, world X/Z (Player.Velocity, or camera displacement / dt without Player)
        public Vector2 WindXZ;          // m/s, world X/Z, direction the air moves toward (MarsAtmosphere.Frame.wind); 0 without weather
        public float WindSpeed;         // m/s, |wind| with gusts; 0 without weather
        public float Gust;              // 0..1 gustiness; 0 without weather
        public float DustTau;           // column dust optical depth now; 0.5 without weather
        public float StormAmount;       // 0..1 dust-storm amount; 0 without weather
        public float Darkness;          // 0 day .. 1 night (MarsSkyState.Darkness, else derived from the sun height)
    }

    /// <summary>
    /// Simulated suit and physiology model behind the vitals, ECG, mission caption and alerts. Everything is a documented
    /// MODEL (labelled SIM on screen), driven by what the player does and by the weather:
    /// <list type="bullet">
    /// <item>Metabolic rate (VO2) from walking speed and signed grade with an LCDA load-carriage equation (Looney et al.
    /// 2019) applied to body + suit + tools, scaled to Mars gravity and calibrated to the HOMELINE F3 suited anchors;
    /// weather adds wind drag work, gust bracing, storm footing and cold.</item>
    /// <item>Heart rate = rest + slope x VO2 + stress + drift, with on/off kinetics (30 s / 60 s) and beat-to-beat
    /// variability (respiratory sinus arrhythmia, 0.1 Hz Mayer wave, small jitter) exposed as <see cref="RrIntervalS"/>.</item>
    /// <item>Consumables and subsystems: primary O2 (VO2 x body mass), ventilation fan, helmet ppCO2, battery with a load
    /// split (fan, comms, heaters, lights), sublimator cooling water, regulated suit pressure, UHF link margin with a
    /// 1 Hz terrain line-of-sight check to the home antenna.</item>
    /// </list>
    /// Allocation-free after construction; advanced once per frame by HelmetHud with simulation time.
    /// </summary>
    public sealed class SuitTelemetry
    {
        // ---- external mission feed (HOMELINE planner integration). Left unset, the suit simulation runs on its own.
        /// <summary>Home (the rover) on the world XZ plane: x = east, y = north. Default: the world origin.</summary>
        public static Vector2 HomeXZ;
        /// <summary>Called at the end of every <see cref="Tick"/>, also while paused: a mission layer may overwrite the O2 and mission-time read-outs here.</summary>
        public static System.Action<SuitTelemetry> AfterTick;

        // Domain reload is off: drop the previous session's feed.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetMissionFeed()
        {
            HomeXZ = Vector2.zero;
            AfterTick = null;
        }

        // ---- body, load, energy
        public const float BodyMassKg = 75f;             // m_b, crew body mass (HOMELINE D10)
        public const float CarriedMassKg = 114f;         // M = 104 kg suit + 10 kg tools (HOMELINE)
        public const float MarsGravity = 3.71f;          // m/s^2
        public const float EarthGravity = 9.81f;         // m/s^2, gravity of the empirical walking equations
        public const float WorkEfficiency = 0.225f;      // eta, nominal muscular efficiency (HOMELINE F3)
        public const float JoulesPerMlO2 = 20.1f;        // J per mL O2 (HOMELINE F3; ~4.8 kcal/L)

        // ---- VO2 (mL/kg/min of body mass)
        public const float Vo2Rest = 6f;                 // V0, standing suited (HOMELINE F3)
        public const float Vo2PerSpeed = 13.27f;         // HOMELINE F3 linear slope 13/0.98 (reference; replaced by the LCDA shape)
        public const float Vo2AnchorSpeed = 0.98f;       // ICES-2026-127 anchor: 19 mL/kg/min suited at 0.98 m/s level
        public const float Vo2AnchorValue = 19f;
        public const float Vo2Max = 36f;                 // ceiling (HOMELINE F3); demand above it saturates
        public const float Vo2Resting = 3.5f;            // 1 MET: baseline of the VO2 reserve (Swain 1997)
        public const float Vo2TauOnS = 30f;              // phase II VO2 on-kinetics, moderate work (Whipp & Wasserman 1972: 20-45 s)
        public const float Vo2TauOffS = 45f;             // off-kinetics, slightly slower
        public const float Vo2TauS = Vo2TauOnS;          // kept for compatibility

        // LCDA walking equation (Looney DP et al. 2019, "Estimating energy expenditure during level, uphill, and downhill
        // walking", Med Sci Sports Exerc 51(9):1954-1960), W per kg of TOTAL mass at 1 g, S in m/s, G grade in %:
        //   M = 1.44 + 1.94 S^0.43 + 0.24 S^4 + 0.34 S G (1 - 1.05^(1 - 1.1^(G + 32)))
        // Standing (1.44) is replaced by the suited V0. The speed term is scaled by SuitWalkFactor so that the suited
        // level cost hits the ICES anchor (the pressurized suit roughly doubles the walking increment). The grade term is
        // work against gravity: it is scaled by g_Mars / g_Earth and carried mass, like Pandolf's grade term (Pandolf,
        // Givoni & Goldman 1977, J Appl Physiol 43:577-581); it goes negative on gentle descents and rises again on steep
        // ones (eccentric braking, Santee et al. 2001).
        private const float LcdaSpeedA = 1.94f, LcdaSpeedExp = 0.43f, LcdaSpeedB = 0.24f, LcdaGradeK = 0.34f;
        private const float MlPerMinPerWatt = 60f / JoulesPerMlO2;   // W -> mL O2 / min
        public static readonly float SuitWalkFactor =
            (Vo2AnchorValue - Vo2Rest) / (LcdaSpeedTerm(Vo2AnchorSpeed) * MlPerMinPerWatt);

        // ---- grade (signed, measured from the helmet's real motion)
        public const float GradeMaxDeg = 30f;            // clamp of the signed walking grade
        public const float GradeMinSpeed = 0.1f;         // m/s; below this the grade is 0
        public const float GradeSlopeSlackDeg = 3f;      // |grade| never exceeds the terrain slope + 3 deg
        public const float MotionTauS = 0.5f;            // low-pass of the measured helmet velocity
        public const float GradeTauS = 0.8f;
        public const float TeleportM = 25f;              // a jump larger than this in one frame resets the filters

        // ---- weather workload (MODEL: modest by physics; Mars air is ~1.5 % as dense as Earth's)
        public const float MarsAirPressurePa = 820f;     // REMS daily min/max medians 792 / 862 Pa (Gale, Ls 10-35)
        public const float GasConstantCo2 = 188.9f;      // J/(kg K)
        public const float SuitDragAreaM2 = 0.9f;        // Cd x frontal area of a suited crew member (assumed)
        public const float WindBraceWPerN = 3f;          // isometric bracing cost per newton of gusty side load (assumed)
        public const float StormFootingGain = 0.12f;     // +12 % walking cost in a full storm: visibility, footing (assumed)
        public const float DustFootingGain = 0.05f;      // +5 % at tau >= 3 (assumed)
        public const float ColdOnC = -40f;               // cold metabolic term starts below this air temperature (assumed)
        public const float ColdFullC = -80f;
        public const float ColdVo2Gain = 0.8f;           // mL/kg/min at full cold while resting (~+13 %, assumed)

        // ---- heart rate: HR = rest + slope * (VO2 - 1 MET) + stress + drift (%HRR ~ %VO2R, Swain 1997)
        public const float HeartRateRest = 70f;          // bpm (assumed)
        public const float HeartRateMax = 187f;          // bpm, Tanaka 208 - 0.7 * age, age 30 assumed
        public const float HeartRatePerVo2 = (HeartRateMax - HeartRateRest) / (Vo2Max - Vo2Resting); // 3.6 bpm per mL/kg/min
        public const float HeartRateTauRiseS = 30f;      // on-kinetics time constant
        public const float HeartRateTauFallS = 60f;      // recovery time constant
        public const float HeartDemandTauS = 2f;         // smoothing of the demand the heart follows
        public const float HeartRateCaution = 159f;      // 85 % HRmax, held 10 s
        public const float HeartRateWarning = 178f;      // 95 % HRmax, held 10 s
        public const float HeartRateHoldS = 10f;
        public const float HeartRateClearBpm = 5f;       // a state clears 5 bpm below its threshold
        public const float StressStormBpm = 8f;          // sympathetic arousal (assumed): full storm
        public const float StressDustBpm = 4f;           // tau 1 -> 4, low visibility
        public const float StressDevilBpm = 10f;         // dust devil passing close
        public const float StressNightBpm = 2f;          // darkness
        public const float StressMaxBpm = 18f;
        public const float StressTauS = 15f;
        public const float DriftMaxBpm = 10f;            // cardiovascular drift at sustained full effort (Coyle & Gonzalez-Alonso 2001)
        public const float DriftTauRiseS = 900f, DriftTauFallS = 300f;

        // ---- heart-rate variability (RR modulation as a fraction of the mean RR)
        public const float RespRateRest = 12f;           // breaths/min at rest
        public const float RespRateMax = 34f;            // breaths/min at VO2max (assumed)
        public const float RsaRestFraction = 0.045f;     // respiratory sinus arrhythmia at rest, vanishes with effort
        public const float RsaFloorFraction = 0.004f;
        public const float MayerFraction = 0.012f;       // 0.1 Hz baroreflex (Mayer) wave
        public const float MayerHz = 0.1f;
        public const float JitterFraction = 0.006f;      // smooth residual beat-to-beat noise

        // ---- primary O2 (SIM consumable)
        public const float O2CapacityL = 482f;           // HOMELINE live build, ICES 5.02 kcal/L
        public const float O2ReserveL = 40.5f;           // HOMELINE live build reserve
        public const float O2RateTauS = 300f;            // EMA of the consumption rate (time to reserve)
        public const float O2CautionMinutes = 30f;       // Caution when less than this to reserve

        // ---- ventilation fan (xEMU-style variable-speed fan, values assumed unless stated)
        public const float FanFlowMinAcfm = 6f;          // EMU nominal vent flow 6 acfm (~170 L/min actual)
        public const float FanFlowMaxAcfm = 8f;          // fan ceiling (assumed)
        public const float FanFullVo2Lpm = 2.0f;         // VO2 at which the controller asks for full flow (assumed)
        public const float FanRpmNominal = 19300f;       // rpm at 6 acfm (assumed, EMU fan class)
        public const float FanPowerNominalW = 18f;       // W at 6 acfm; affinity laws: flow ~ rpm, power ~ rpm^3
        public const float FanTauS = 3f;                 // spool-up
        public const float FanSaturationHoldS = 10f;     // caution after 10 s at the ceiling with more demand
        public const float AcfmToLpm = 28.3168f;

        // ---- helmet ppCO2 (well-mixed loop): ppCO2 = 760 mmHg * VCO2(STPD) * (T_gas / 273 K) / Q_actual + residual
        public const float RqRest = 0.85f, RqMax = 1.0f; // respiratory exchange ratio, rises with intensity
        public const float SuitGasTempK = 291f;          // vent gas ~18 C
        public const float ScrubberResidualMmhg = 0.4f;  // scrubber (RCA) outlet ppCO2 (assumed)
        public const float Co2TauS = 20f;                // loop washout: ~60 L suit volume / ~170 L/min
        public const float Co2CautionMmhg = 8f;          // inspired-CO2 design limit for exploration suits (NASA-STD-3001 Vol. 2, assumed reading)
        public const float Co2WarningMmhg = 15f;         // legacy EMU "CO2 HI" alarm level
        public const float Co2ClearMmhg = 0.5f;

        // ---- battery: load split (assumed), capacity sized for the HOMELINE 8 h EVA (ref P9) at a ~60 W mean
        public const float BatteryEvaHours = 8f;
        public const float BatteryCapacityWh = 480f;
        public const float AvionicsW = 15f;              // PLSS controller, sensors, HUD
        public const float CommBaseW = 5f;               // UHF radio, receive + nominal transmit
        public const float CommBoostW = 5f;              // transmit power step-up on a weak link
        public const float CommBoostBelowDb = 10f;
        public const float PumpW = 8f;                   // cooling-water pump
        public const float HeaterMaxW = 30f;             // glove, boot and visor heaters at full cold
        public const float HeaterOnC = -30f, HeaterFullC = -90f;
        public const float HeaterWindGain = 0.02f;       // forced convection: +2 % per m/s of wind
        public const float HelmetLightsW = 6f;           // at night
        public const float LoadAvgTauS = 60f;            // EMA used for "time remaining"
        public const float BatteryBaseLoad = 0.7f;       // legacy constants (v1 load factor model), unused
        public const float BatteryEffortLoad = 0.3f;
        public const float BatteryCautionPct = 20f;
        public const float BatteryWarningPct = 10f;
        public const float PowerWarningPct = 5f;         // power bus mirrors the battery (derived)

        // ---- cooling water: sublimator rejects metabolic + electrical + solar heat minus the suit's heat leak
        public const float CoolingCapacityJ = 10.13e6f;  // 1,200 BTU/h x 8 h = 10.13 MJ (~3.6 kg feedwater at 2.83 MJ/kg)
        public const float SolarAbsorbedW = 70f;         // ~0.6 m^2 x 590 W/m^2 x absorptance 0.2 at zenith, clear sky (assumed)
        public const float SuitHeatLeakWPerK = 0.45f;    // insulated suit to ambient (assumed)
        public const float SuitGasTempC = 20f;
        public const float ElectricHeatShare = 0.5f;     // PLSS electrical dissipation that ends in the water loop (assumed)
        public const float WaterCautionPct = 20f;
        public const float WaterWarningPct = 10f;

        // ---- suit pressure (O2 regulator)
        public const float SuitPressureNominalKpa = 29.6f; // 4.3 psi, NASA EMU operating pressure
        public const float PressureCautionKpa = 28.3f;     // 4.1 psi (assumed band)
        public const float PressureWarningKpa = 26.9f;     // 3.9 psi (assumed)
        public const float PressureClearKpa = 0.2f;

        // ---- UHF link to the home antenna (simple link budget, values assumed unless stated)
        public const float LinkFrequencyHz = 414.2e6f;   // EMU UHF channel A
        public const float LinkEirpDbm = 33f;            // 2 W
        public const float LinkSensitivityDbm = -110f;   // narrow-band voice/data receiver
        public const float LinkMiscLossDb = 4f;          // body blockage, cables, polarization
        public const float HelmetAntennaM = 1.7f;
        public const float HomeAntennaM = 2f;            // home/rover antenna 2 m above the ground at the home position
        public const float ShallowObstructionDb = 8f;    // ray to 2 m blocked, ray to +10 m clear: grazing knife edge
        public const float DeepObstructionDb = 20f;      // both blocked: deep diffraction shadow
        public const float HighProbeM = 10f;
        public const float LinkTauS = 2f;
        public const float LinkWeakDb = 6f;              // caution below 6 dB margin
        public const float LinkLostDb = 0f;              // warning below 0 dB (no link)
        public const float LinkClearDb = 1f;
        public const float LosPeriodS = 1f;              // terrain line-of-sight check at 1 Hz
        // Dust does not attenuate UHF (wavelength 72 cm >> dust grains): storms do not change the link.

        // ---- radiation (cited constant)
        public const float DoseRateGaleMsvH = 0.027f;    // 0.64 +/- 0.12 mSv/day dose equivalent, Hassler et al. 2014, Science 343, doi:10.1126/science.1244797
        public const float DoseRateCautionMsvH = 0.080f; // ~3x baseline (HOMELINE tripwire)
        public const float DoseRateWarningMsvH = 0.27f;  // 10x baseline (assumed)

        // ---- ambient air temperature (derived estimate)
        public const float RemsAirTempMinC = -74.5f;     // REMS daily min median, Ls 10-35, MY 36-38 (fallback)
        public const float RemsAirTempMaxC = -19.5f;     // REMS daily max median, Ls 10-35, MY 36-38 (fallback)
        public const float AirTempMinPhase = 0.24f;      // sol fraction of the daily minimum (assumed curve shape)
        public const float AirTempMaxPhase = 0.60f;      // sol fraction of the daily maximum (assumed curve shape)

        // ---- slope, extent, MET
        public const float PlanningExtentM = 3700f;        // HOMELINE planning extent 3.7 km
        public const float SlopeCautionEnterDeg = 17f;     // HOMELINE F2: 17-20 deg beyond tested suited data
        public const float SlopeCautionExitDeg = 16f;
        public const float SlopeWarningEnterDeg = 20f;     // HOMELINE F2: no-go 20 deg
        public const float SlopeWarningExitDeg = 19f;
        public const float MetCautionS = 6f * 3600f;       // 6 h
        public const float MetWarningS = 6.5f * 3600f;     // 6.5 h HOMELINE EVA length

        private readonly RaycastHit[] hits = new RaycastHit[16];

        private float simTime;
        private float hrDisplayTimer;
        private float o2RateLpm;
        private float hrCautionTimer, hrWarningTimer;
        private float hrDemandVo2;
        private Vector3 lastCamera;
        private bool hasLastCamera;
        private float vyFilt, vhFilt;
        private float fanSaturatedTimer;
        private float co2Prev;
        private float batteryWh;
        private float loadAvgW;
        private float coolingAvgW;
        private float losTimer = LosPeriodS;   // first tick checks
        private float obstructionDb;
        private bool homeGroundKnown;
        private float homeGroundY;
        private Vector2 homeGroundFor;
        private float weatherVo2Raw;
        private float stressTarget;

        /// <summary>Starts a fresh EVA: full consumables, resting physiology, MET 0, time unknown.</summary>
        public SuitTelemetry()
        {
            Vo2 = Vo2Rest;
            Vo2Demand = Vo2Rest;
            hrDemandVo2 = Vo2Rest;
            Activity = VO2ReserveFraction(Vo2Rest);
            HeartRate = HeartRateRest + HeartRatePerVo2 * (Vo2Rest - Vo2Resting);
            HeartRateDisplay = Mathf.RoundToInt(HeartRate);
            RespirationRate = Mathf.Lerp(RespRateRest, RespRateMax, Activity);
            RrIntervalS = 60f / HeartRate;
            O2FlowLpm = Vo2Rest * BodyMassKg / 1000f;
            MetabolicRateW = Vo2Rest * BodyMassKg / MlPerMinPerWatt;
            O2LeftL = O2CapacityL;
            o2RateLpm = O2FlowLpm;
            O2MinutesToReserve = (O2CapacityL - O2ReserveL) / o2RateLpm;
            O2PercentDisplay = 100;
            FanFlowAcfm = FanFlowMinAcfm;
            FanRpm = FanRpmNominal;
            FanPowerW = FanPowerNominalW;
            Co2Mmhg = Co2Target(O2FlowLpm, Activity, FanFlowAcfm);
            co2Prev = Co2Mmhg;
            batteryWh = BatteryCapacityWh;
            BatteryPct = 100f;
            BatteryLoadW = AvionicsW + CommBaseW + FanPowerNominalW + PumpW;
            loadAvgW = BatteryLoadW;
            BatteryMinutesLeft = batteryWh / loadAvgW * 60f;
            CoolingWaterPct = 100f;
            CoolingLoadW = MetabolicRateW;
            coolingAvgW = CoolingLoadW;
            WaterMinutesLeft = CoolingCapacityJ / coolingAvgW / 60f;
            SuitPressureKpa = SuitPressureNominalKpa;
            SuitLeakKpaPerMin = 0.05f;
            LinkMarginDb = float.NaN;
            LineOfSight = true;
            DoseRateMsvH = DoseRateGaleMsvH;
            AirTempC = float.NaN;
            AirTempDisplay = int.MinValue;
            Sol = -1;
            LocalSolarTime = float.NaN;
        }

        // ---- physiology (SIM)
        /// <summary>Actual oxygen uptake, mL/kg/min (follows the demand with 30 s / 45 s kinetics).</summary>
        public float Vo2 { get; private set; }
        /// <summary>Instant metabolic demand, mL/kg/min (activity + weather), capped at <see cref="Vo2Max"/>.</summary>
        public float Vo2Demand { get; private set; }
        /// <summary>Part of the demand caused by the weather (wind work, gust bracing, storm footing, cold), mL/kg/min.</summary>
        public float WeatherVo2 { get; private set; }
        /// <summary>VO2 reserve fraction 0 (1 MET) .. 1 (VO2max) of the actual VO2.</summary>
        public float Activity { get; private set; }
        public float MetabolicRateW { get; private set; }      // W, VO2 x 20.1 J/mL
        public float O2FlowLpm { get; internal set; }           // L/min STPD, = VO2 x body mass
        public float HeartRate { get; private set; }           // bpm, mean (smoothed) heart rate
        public int HeartRateDisplay { get; private set; }      // updated at 1 Hz
        public HudSeverity HeartState { get; private set; }
        public float StressBpm { get; private set; }           // weather/environment arousal term
        public float DriftBpm { get; private set; }            // cardiovascular drift
        /// <summary>Instant beat-to-beat interval in seconds: mean RR modulated by breathing (RSA), Mayer wave and jitter.</summary>
        public float RrIntervalS { get; private set; }
        public float RespirationRate { get; private set; }     // breaths/min
        public float RespirationPhase { get; private set; }    // 0..1, inspiration in the first half
        public float GradeDeg { get; private set; }            // signed walking grade (+ uphill)
        public float HeadwindMs { get; private set; }          // wind component against the walking direction
        public float WindSpeedMs { get; private set; }

        // ---- O2 (SIM consumable)
        public float O2LeftL { get; internal set; }
        public int O2PercentDisplay { get; internal set; }
        public float O2MinutesToReserve { get; internal set; }
        public HudSeverity O2State { get; internal set; }

        // ---- radiation (cited constant, settable for future storm replay)
        public float DoseRateMsvH { get; set; }                // default 0.027
        public HudSeverity RadState => DoseRateMsvH >= DoseRateWarningMsvH ? HudSeverity.Warning
                                     : DoseRateMsvH >= DoseRateCautionMsvH ? HudSeverity.Caution
                                     : HudSeverity.Nominal;

        // ---- ambient (derived from REMS)
        /// <summary>Air temperature in deg C; NaN while the local solar time is unknown.</summary>
        public float AirTempC { get; private set; }
        /// <summary>Rounded air temperature; int.MinValue while unknown (check <see cref="AirTempC"/> for NaN).</summary>
        public int AirTempDisplay { get; private set; }
        public float Darkness { get; private set; }

        // ---- ventilation and CO2 (SIM)
        public float FanFlowAcfm { get; private set; }
        public float FanRpm { get; private set; }
        public float FanPowerW { get; private set; }
        public bool FanSaturated { get; private set; }         // demand above the fan ceiling right now
        public HudSeverity FanState { get; private set; }
        public float Co2Mmhg { get; private set; }             // helmet ppCO2
        public float Co2TrendPerMin { get; private set; }      // mmHg/min, smoothed
        public HudSeverity Co2State { get; private set; }

        // ---- power (SIM)
        public float BatteryPct { get; private set; }
        public float BatteryWh => batteryWh;
        public float BatteryLoadW { get; private set; }        // instant total load
        public float BatteryMinutesLeft { get; private set; }  // at the 60 s mean load
        public float HeaterW { get; private set; }
        public float LightsW { get; private set; }
        public float CommW { get; private set; }
        public HudSeverity BatteryState { get; private set; }
        public HudSeverity PowerState { get; private set; }

        // ---- thermal (SIM)
        public float CoolingWaterPct { get; private set; }
        public float CoolingLoadW { get; private set; }        // heat the sublimator rejects now
        public float WaterMinutesLeft { get; private set; }    // at the 60 s mean load
        public HudSeverity WaterState { get; private set; }

        // ---- suit pressure (SIM)
        public float SuitPressureKpa { get; private set; }     // 29.6
        /// <summary>Suit leak once no makeup O2 is left (kPa/min); settable for fault injection.</summary>
        public float SuitLeakKpaPerMin { get; set; }
        public HudSeverity PressureState { get; private set; }

        // ---- comm link (SIM)
        public float LinkMarginDb { get; private set; }        // NaN until the first tick
        public bool LineOfSight { get; private set; }          // terrain-clear ray helmet -> home antenna
        public float LinkDistanceM { get; private set; }       // slant range to the home antenna
        public HudSeverity SignalState { get; private set; }   // weak link: Caution, no link: Warning

        // ---- mission
        public HudSeverity MetState { get; internal set; }

        // ---- navigation
        public float DistanceHomeM { get; private set; }
        public float BearingHomeDeg { get; private set; }
        public float SlopeDeg { get; private set; }
        public HudSeverity SlopeState { get; private set; }
        public bool BeyondExtent => DistanceHomeM > PlanningExtentM;

        // ---- time
        public float MetSeconds { get; internal set; }
        public int Sol { get; private set; }
        public float LocalSolarTime { get; private set; }
        public float DustDevilProximity { get; private set; }

        /// <summary>
        /// Advances the model by <paramref name="simDt"/> seconds of simulation time (Time.deltaTime). Pass-through and
        /// navigation values update even when <paramref name="simDt"/> is 0 (paused).
        /// </summary>
        public void Tick(float simDt, in TelemetryInput input)
        {
            // ---- pass-through and navigation
            float slope = Finite(input.SlopeDeg, 0f);
            SlopeDeg = slope < 0f ? -slope : slope;
            SlopeState = SlopeHysteresis(SlopeState, SlopeDeg);
            Sol = input.Sol;
            LocalSolarTime = input.LocalSolarTime;
            DustDevilProximity = Mathf.Clamp01(Finite(input.DustDevilProximity, 0f));
            Darkness = Mathf.Clamp01(Finite(input.Darkness, 0f));

            float x = input.CameraPosition.x - HomeXZ.x, z = input.CameraPosition.z - HomeXZ.y;
            DistanceHomeM = Mathf.Sqrt(x * x + z * z);
            BearingHomeDeg = Mathf.Repeat(Mathf.Atan2(-x, -z) * Mathf.Rad2Deg, 360f);

            UpdateAirTemperature(input);

            if (!(simDt > 0f))
            {
                AfterTick?.Invoke(this);
                return;
            }
            simTime = Mathf.Repeat(simTime + simDt, 3600f);   // phase clock only (keeps float precision)

            float airC = float.IsNaN(AirTempC) ? Mathf.Lerp(RemsAirTempMaxC, RemsAirTempMinC, Darkness) : AirTempC;
            float tau = Finite(input.DustTau, 0.5f);
            float storm = Mathf.Clamp01(Finite(input.StormAmount, 0f));

            UpdateMotion(simDt, input);
            float footing = UpdateWeatherLoad(input, airC, tau, storm);
            UpdateMetabolism(simDt, input, footing);
            UpdateHeart(simDt);
            UpdateOxygen(simDt);
            UpdateVentilation(simDt);
            UpdateLink(simDt, input.CameraPosition);
            UpdatePower(simDt, airC);
            UpdateCooling(simDt, airC, tau);
            UpdatePressure(simDt);

            // ---- mission elapsed time
            MetSeconds += simDt;
            MetState = MetSeconds >= MetWarningS ? HudSeverity.Warning
                     : MetSeconds >= MetCautionS ? HudSeverity.Caution
                     : HudSeverity.Nominal;
            AfterTick?.Invoke(this);
        }

        // ---------------------------------------------------------------- locomotion

        // Signed grade from the helmet's real motion. Player.Velocity.y is the controller's internal ground-stick
        // velocity (always negative on the ground), so the vertical speed is measured from the camera path instead.
        private void UpdateMotion(float dt, in TelemetryInput input)
        {
            Vector3 cam = input.CameraPosition;
            if (hasLastCamera)
            {
                Vector3 d = cam - lastCamera;
                if (d.sqrMagnitude > TeleportM * TeleportM || !Finite(d.x) || !Finite(d.y) || !Finite(d.z))
                {
                    vyFilt = 0f;
                    vhFilt = 0f;
                }
                else
                {
                    float a = 1f - Mathf.Exp(-dt / MotionTauS);
                    vyFilt += (d.y / dt - vyFilt) * a;
                    vhFilt += (Mathf.Sqrt(d.x * d.x + d.z * d.z) / dt - vhFilt) * a;
                }
            }
            lastCamera = cam;
            hasLastCamera = true;

            float target = 0f;
            if (input.Grounded && vhFilt > GradeMinSpeed)
            {
                float bound = Mathf.Min(GradeMaxDeg, SlopeDeg + GradeSlopeSlackDeg);
                target = Mathf.Clamp(Mathf.Atan2(vyFilt, vhFilt) * Mathf.Rad2Deg, -bound, bound);
            }
            GradeDeg += (target - GradeDeg) * (1f - Mathf.Exp(-dt / GradeTauS));
        }

        // Weather work and stress targets. Returns the walking-cost multiplier for footing and visibility.
        private float UpdateWeatherLoad(in TelemetryInput input, float airC, float tau, float storm)
        {
            float rho = MarsAirPressurePa / (GasConstantCo2 * Mathf.Max(150f, airC + 273.15f));   // ~0.02 kg/m^3
            float ws = Mathf.Max(0f, Finite(input.WindSpeed, 0f));
            Vector2 windDir = input.WindXZ;
            Vector2 wind = Finite(windDir.x) && Finite(windDir.y) && windDir.sqrMagnitude > 1e-4f ? windDir.normalized * ws : Vector2.zero;
            Vector2 body = input.VelocityXZ;
            if (!Finite(body.x) || !Finite(body.y))
            {
                body = Vector2.zero;
            }
            WindSpeedMs = ws;

            // Drag of the air moving relative to the walker; the walker supplies the power that opposes its motion.
            Vector2 rel = wind - body;
            float q = 0.5f * rho * SuitDragAreaM2;
            Vector2 drag = q * rel.magnitude * rel;                       // N on the body
            float against = Mathf.Max(0f, -Vector2.Dot(drag, body));     // W mechanical, headwind only
            float speed = body.magnitude;
            HeadwindMs = speed > 0.05f ? -Vector2.Dot(wind, body / speed) : 0f;

            // Bracing against a gusty side load, isometric: proportional to the force (and gustiness).
            float gust = Mathf.Clamp01(Finite(input.Gust, 0f));
            float brace = WindBraceWPerN * q * ws * ws * (0.5f + gust);
            float windW = against / WorkEfficiency + brace;

            float cold = Mathf.Clamp01((ColdOnC - airC) / (ColdOnC - ColdFullC));
            float coldVo2 = ColdVo2Gain * cold * (1f - Activity);
            weatherVo2Raw = windW / BodyMassKg * MlPerMinPerWatt + coldVo2;

            stressTarget = Mathf.Min(StressMaxBpm,
                storm * StressStormBpm
                + Mathf.Clamp01((tau - 1f) / 3f) * StressDustBpm
                + DustDevilProximity * StressDevilBpm
                + Darkness * StressNightBpm);

            return 1f + StormFootingGain * storm + DustFootingGain * Mathf.Clamp01((tau - 1f) / 2f);
        }

        private void UpdateMetabolism(float dt, in TelemetryInput input, float footing)
        {
            float s = Mathf.Max(0f, Finite(input.HorizontalSpeed, 0f));
            if (!input.Grounded)
            {
                s = Mathf.Min(s, vhFilt);   // airborne: no stepping cost beyond the real motion
            }

            float levelBase = SuitWalkFactor * LcdaSpeedTerm(s) * MlPerMinPerWatt;
            float level = levelBase * footing;
            float gradePct = Mathf.Tan(GradeDeg * Mathf.Deg2Rad) * 100f;
            float gradeW = LcdaGradeK * s * gradePct
                           * (1f - Mathf.Pow(1.05f, 1f - Mathf.Pow(1.1f, gradePct + 32f)));            // W/kg total, 1 g
            float gradeVo2 = gradeW * (MarsGravity / EarthGravity) * ((BodyMassKg + CarriedMassKg) / BodyMassKg)
                             * MlPerMinPerWatt;

            float raw = Vo2Rest + level + gradeVo2 + weatherVo2Raw;
            Vo2Demand = Mathf.Clamp(raw, Vo2Rest, Vo2Max);
            WeatherVo2 = Mathf.Max(0f, weatherVo2Raw + (level - levelBase));

            float tauV = Vo2Demand > Vo2 ? Vo2TauOnS : Vo2TauOffS;
            Vo2 += (Vo2Demand - Vo2) * (1f - Mathf.Exp(-dt / tauV));
            Activity = VO2ReserveFraction(Vo2);
            MetabolicRateW = Vo2 * BodyMassKg / MlPerMinPerWatt;
            O2FlowLpm = Vo2 * BodyMassKg / 1000f;
        }

        // ---------------------------------------------------------------- heart

        private void UpdateHeart(float dt)
        {
            hrDemandVo2 += (Vo2Demand - hrDemandVo2) * (1f - Mathf.Exp(-dt / HeartDemandTauS));
            StressBpm += (stressTarget - StressBpm) * (1f - Mathf.Exp(-dt / StressTauS));
            float driftTarget = DriftMaxBpm * Activity;
            DriftBpm += (driftTarget - DriftBpm) * (1f - Mathf.Exp(-dt / (driftTarget > DriftBpm ? DriftTauRiseS : DriftTauFallS)));

            float hrTarget = HeartRateRest + HeartRatePerVo2 * (hrDemandVo2 - Vo2Resting) + StressBpm + DriftBpm;
            hrTarget = Mathf.Clamp(hrTarget, HeartRateRest, HeartRateMax);
            float hrTau = hrTarget > HeartRate ? HeartRateTauRiseS : HeartRateTauFallS;
            HeartRate += (hrTarget - HeartRate) * (1f - Mathf.Exp(-dt / hrTau));

            hrDisplayTimer += dt;
            if (hrDisplayTimer >= 1f)
            {
                hrDisplayTimer = hrDisplayTimer >= 2f ? 0f : hrDisplayTimer - 1f;
                HeartRateDisplay = Mathf.RoundToInt(HeartRate);
            }
            UpdateHeartState(dt);

            // Breathing paces the RSA: faster and with vanishing RR modulation as effort rises; stress adds a little.
            RespirationRate = Mathf.Lerp(RespRateRest, RespRateMax, Activity) + 0.2f * StressBpm;
            RespirationPhase = Mathf.Repeat(RespirationPhase + dt * RespirationRate / 60f, 1f);
            float calm = 1f - Activity;
            float rsa = RsaRestFraction * calm * calm + RsaFloorFraction;
            float mayer = MayerFraction * calm;
            float jitter = JitterFraction * (Mathf.PerlinNoise(simTime * 0.9f, 7.3f) * 2f - 1f);
            float mod = 1f - rsa * Mathf.Sin(2f * Mathf.PI * RespirationPhase)   // inspiration shortens RR
                           - mayer * Mathf.Sin(2f * Mathf.PI * MayerHz * simTime) + jitter;
            RrIntervalS = 60f / Mathf.Max(30f, HeartRate) * mod;
        }

        private void UpdateHeartState(float simDt)
        {
            hrCautionTimer = HeartRate >= HeartRateCaution ? hrCautionTimer + simDt : 0f;
            hrWarningTimer = HeartRate >= HeartRateWarning ? hrWarningTimer + simDt : 0f;

            // Enter after 10 s above the threshold; once in, hold until 5 bpm below it.
            HudSeverity s = HeartState;
            if (hrWarningTimer >= HeartRateHoldS
                || (s == HudSeverity.Warning && HeartRate >= HeartRateWarning - HeartRateClearBpm))
            {
                HeartState = HudSeverity.Warning;
            }
            else if (hrCautionTimer >= HeartRateHoldS
                     || (s >= HudSeverity.Caution && HeartRate >= HeartRateCaution - HeartRateClearBpm))
            {
                HeartState = HudSeverity.Caution;
            }
            else
            {
                HeartState = HudSeverity.Nominal;
            }
        }

        // ---------------------------------------------------------------- consumables and subsystems

        private void UpdateOxygen(float dt)
        {
            O2LeftL = Mathf.Max(0f, O2LeftL - O2FlowLpm * dt / 60f);
            o2RateLpm += (O2FlowLpm - o2RateLpm) * (1f - Mathf.Exp(-dt / O2RateTauS));
            O2MinutesToReserve = Mathf.Max(0f, O2LeftL - O2ReserveL) / Mathf.Max(o2RateLpm, 1e-4f);
            O2PercentDisplay = Mathf.Clamp(Mathf.CeilToInt(O2LeftL / O2CapacityL * 100f), 0, 100); // ceil: 0 % only when empty
            O2State = O2LeftL <= O2ReserveL ? HudSeverity.Warning
                    : O2MinutesToReserve < O2CautionMinutes ? HudSeverity.Caution
                    : HudSeverity.Nominal;
        }

        private void UpdateVentilation(float dt)
        {
            // The controller raises vent flow with metabolic rate to keep CO2 washed out of the helmet.
            float restLpm = Vo2Rest * BodyMassKg / 1000f;
            float demand = FanFlowMinAcfm + (FanFlowMaxAcfm - FanFlowMinAcfm)
                           * (O2FlowLpm - restLpm) / Mathf.Max(0.1f, FanFullVo2Lpm - restLpm);
            FanSaturated = demand > FanFlowMaxAcfm;
            float target = Mathf.Clamp(demand, FanFlowMinAcfm, FanFlowMaxAcfm);
            FanFlowAcfm += (target - FanFlowAcfm) * (1f - Mathf.Exp(-dt / FanTauS));
            float ratio = FanFlowAcfm / FanFlowMinAcfm;
            FanRpm = FanRpmNominal * ratio;
            FanPowerW = FanPowerNominalW * ratio * ratio * ratio;
            fanSaturatedTimer = FanSaturated ? fanSaturatedTimer + dt : 0f;
            FanState = fanSaturatedTimer >= FanSaturationHoldS || (FanState == HudSeverity.Caution && FanSaturated)
                ? HudSeverity.Caution : HudSeverity.Nominal;

            float co2Target = Co2Target(O2FlowLpm, Activity, FanFlowAcfm);
            Co2Mmhg += (co2Target - Co2Mmhg) * (1f - Mathf.Exp(-dt / Co2TauS));
            float rate = (Co2Mmhg - co2Prev) / dt * 60f;
            co2Prev = Co2Mmhg;
            Co2TrendPerMin += (rate - Co2TrendPerMin) * (1f - Mathf.Exp(-dt / 10f));

            HudSeverity c = Co2State;
            if (Co2Mmhg >= Co2WarningMmhg || (c == HudSeverity.Warning && Co2Mmhg >= Co2WarningMmhg - Co2ClearMmhg))
            {
                Co2State = HudSeverity.Warning;
            }
            else if (Co2Mmhg >= Co2CautionMmhg || (c >= HudSeverity.Caution && Co2Mmhg >= Co2CautionMmhg - Co2ClearMmhg))
            {
                Co2State = HudSeverity.Caution;
            }
            else
            {
                Co2State = HudSeverity.Nominal;
            }
        }

        private static float Co2Target(float vo2Lpm, float activity, float acfm)
        {
            float vco2 = Mathf.Lerp(RqRest, RqMax, activity) * vo2Lpm;              // L/min STPD
            float q = Mathf.Max(1f, acfm * AcfmToLpm);                              // L/min at suit conditions
            return 760f * vco2 * (SuitGasTempK / 273.15f) / q + ScrubberResidualMmhg;
        }

        // Link budget: margin = EIRP - losses + sensitivity - path loss - terrain obstruction. Path loss is the larger of
        // free space and the two-ray plane-earth model (antennas ~2 m above the ground): PL = 40 log d - 20 log(h1 h2).
        private void UpdateLink(float dt, Vector3 helmet)
        {
            losTimer += dt;
            if (losTimer >= LosPeriodS)
            {
                losTimer = 0f;
                CheckLineOfSight(helmet);
            }

            Vector3 antenna = new Vector3(HomeXZ.x, (homeGroundKnown ? homeGroundY : helmet.y - HelmetAntennaM) + HomeAntennaM, HomeXZ.y);
            float d = Mathf.Max(1f, Vector3.Distance(helmet, antenna));
            LinkDistanceM = d;
            float logD = Mathf.Log10(d);
            float fspl = 20f * logD + 20f * Mathf.Log10(LinkFrequencyHz) - 147.55f;
            float planeEarth = 40f * logD - 20f * Mathf.Log10(HelmetAntennaM * HomeAntennaM);
            float margin = LinkEirpDbm - LinkMiscLossDb - LinkSensitivityDbm - Mathf.Max(fspl, planeEarth) - obstructionDb;

            LinkMarginDb = float.IsNaN(LinkMarginDb) ? margin : LinkMarginDb + (margin - LinkMarginDb) * (1f - Mathf.Exp(-dt / LinkTauS));

            HudSeverity s = SignalState;
            float m = LinkMarginDb;
            if (m < LinkLostDb || (s == HudSeverity.Warning && m < LinkLostDb + LinkClearDb))
            {
                SignalState = HudSeverity.Warning;
            }
            else if (m < LinkWeakDb || (s >= HudSeverity.Caution && m < LinkWeakDb + LinkClearDb))
            {
                SignalState = HudSeverity.Caution;
            }
            else
            {
                SignalState = HudSeverity.Nominal;
            }
        }

        // 1 Hz: terrain-only rays (rocks are ignored: UHF diffracts around them) from the helmet to the home antenna and to
        // a point 10 m higher. Allocation-free (RaycastNonAlloc into a cached buffer).
        private void CheckLineOfSight(Vector3 helmet)
        {
            if (homeGroundKnown && homeGroundFor != HomeXZ)
            {
                homeGroundKnown = false;   // home moved (a mission plan set another pad)
            }
            if (!homeGroundKnown)
            {
                float top = helmet.y + 3000f;
                if (TerrainHit(new Vector3(HomeXZ.x, top, HomeXZ.y), Vector3.down, 6000f, out float y))
                {
                    homeGroundY = y;
                    homeGroundKnown = true;
                    homeGroundFor = HomeXZ;
                }
            }

            float baseY = homeGroundKnown ? homeGroundY : helmet.y - HelmetAntennaM;
            Vector3 antenna = new Vector3(HomeXZ.x, baseY + HomeAntennaM, HomeXZ.y);
            if ((antenna - helmet).sqrMagnitude < 25f)
            {
                obstructionDb = 0f;
                LineOfSight = true;
                return;
            }

            bool blocked = Blocked(helmet, antenna);
            LineOfSight = !blocked;
            if (!blocked)
            {
                obstructionDb = 0f;
            }
            else
            {
                obstructionDb = Blocked(helmet, antenna + new Vector3(0f, HighProbeM, 0f)) ? DeepObstructionDb : ShallowObstructionDb;
            }
        }

        private bool Blocked(Vector3 from, Vector3 to)
        {
            Vector3 d = to - from;
            float len = d.magnitude;
            if (len < 1e-3f)
            {
                return false;
            }
            return TerrainHit(from, d / len, len, out _);
        }

        // Highest terrain hit along the ray (TerrainCollider only), or false.
        private bool TerrainHit(Vector3 origin, Vector3 dir, float maxDistance, out float hitY)
        {
            hitY = float.NegativeInfinity;
            int n = Physics.RaycastNonAlloc(new Ray(origin, dir), hits, maxDistance, Physics.DefaultRaycastLayers,
                                            QueryTriggerInteraction.Ignore);
            bool any = false;
            for (int i = 0; i < n; i++)
            {
                if (hits[i].collider is TerrainCollider)
                {
                    any = true;
                    if (hits[i].point.y > hitY)
                    {
                        hitY = hits[i].point.y;
                    }
                }
            }
            return any;
        }

        private void UpdatePower(float dt, float airC)
        {
            // Heaters: extremities and visor, more in cold air and wind, less while working hard (warm hands).
            float cold = Mathf.Clamp01((HeaterOnC - airC) / (HeaterOnC - HeaterFullC));
            float windFactor = 1f + HeaterWindGain * Mathf.Min(WindSpeedMs, 30f);
            float heaterTarget = HeaterMaxW * Mathf.Clamp01(cold * windFactor) * (1f - 0.5f * Activity);
            HeaterW += (heaterTarget - HeaterW) * (1f - Mathf.Exp(-dt / 20f));
            LightsW = HelmetLightsW * Mathf.Clamp01((Darkness - 0.3f) / 0.4f);
            CommW = CommBaseW + (!float.IsNaN(LinkMarginDb) && LinkMarginDb < CommBoostBelowDb ? CommBoostW : 0f);

            BatteryLoadW = AvionicsW + CommW + FanPowerW + PumpW + HeaterW + LightsW;
            batteryWh = Mathf.Max(0f, batteryWh - BatteryLoadW * dt / 3600f);
            BatteryPct = batteryWh / BatteryCapacityWh * 100f;
            loadAvgW += (BatteryLoadW - loadAvgW) * (1f - Mathf.Exp(-dt / LoadAvgTauS));
            BatteryMinutesLeft = batteryWh / Mathf.Max(1f, loadAvgW) * 60f;
            BatteryState = Level(BatteryPct, BatteryCautionPct, BatteryWarningPct);
            PowerState = BatteryPct <= PowerWarningPct ? HudSeverity.Warning : HudSeverity.Nominal;
        }

        private void UpdateCooling(float dt, float airC, float tau)
        {
            float sun = Finite(MarsAtmosphere.SunHeight, 0f);
            float solar = sun > 0f ? SolarAbsorbedW * sun * Mathf.Exp(-0.5f * Mathf.Max(0f, tau) / Mathf.Max(sun, 0.1f)) : 0f;
            float leak = SuitHeatLeakWPerK * (1f + 0.03f * Mathf.Min(WindSpeedMs, 30f)) * Mathf.Max(0f, SuitGasTempC - airC);
            float electric = ElectricHeatShare * (FanPowerW + PumpW + AvionicsW) + HeaterW;
            CoolingLoadW = Mathf.Max(0f, MetabolicRateW + solar + electric - leak);
            CoolingWaterPct = Mathf.Max(0f, CoolingWaterPct - CoolingLoadW * dt / CoolingCapacityJ * 100f);
            coolingAvgW += (CoolingLoadW - coolingAvgW) * (1f - Mathf.Exp(-dt / LoadAvgTauS));
            WaterMinutesLeft = CoolingWaterPct * 0.01f * CoolingCapacityJ / Mathf.Max(1f, coolingAvgW) / 60f;
            WaterState = Level(CoolingWaterPct, WaterCautionPct, WaterWarningPct);
        }

        private void UpdatePressure(float dt)
        {
            // The O2 regulator holds the suit at 29.6 kPa while any O2 is left; without makeup gas the suit leaks down.
            if (O2LeftL > 0f)
            {
                SuitPressureKpa = SuitPressureNominalKpa;
            }
            else
            {
                SuitPressureKpa = Mathf.Max(0f, SuitPressureKpa - Mathf.Max(0f, SuitLeakKpaPerMin) * dt / 60f);
            }

            HudSeverity s = PressureState;
            float p = SuitPressureKpa;
            if (p < PressureWarningKpa || (s == HudSeverity.Warning && p < PressureWarningKpa + PressureClearKpa))
            {
                PressureState = HudSeverity.Warning;
            }
            else if (p < PressureCautionKpa || (s >= HudSeverity.Caution && p < PressureCautionKpa + PressureClearKpa))
            {
                PressureState = HudSeverity.Caution;
            }
            else
            {
                PressureState = HudSeverity.Nominal;
            }
        }

        // ---------------------------------------------------------------- ambient

        private void UpdateAirTemperature(in TelemetryInput input)
        {
            float h = input.LocalSolarTime;
            if (float.IsNaN(h) || float.IsInfinity(h))
            {
                AirTempC = float.NaN;
                AirTempDisplay = int.MinValue;
                return;
            }

            float tMin = input.AirTempMinC, tMax = input.AirTempMaxC;
            bool unset = tMin == 0f && tMax == 0f;   // default struct: no climate filled in
            if (unset || float.IsNaN(tMin) || float.IsNaN(tMax) || float.IsInfinity(tMin) || float.IsInfinity(tMax))
            {
                tMin = RemsAirTempMinC;
                tMax = RemsAirTempMaxC;
            }

            h = Mathf.Repeat(h, 1f);
            float range = tMax - tMin;
            float t;
            if (h >= AirTempMinPhase && h < AirTempMaxPhase)
            {
                float u = (h - AirTempMinPhase) / (AirTempMaxPhase - AirTempMinPhase);
                t = tMin + range * (1f - Mathf.Cos(Mathf.PI * u)) * 0.5f;
            }
            else
            {
                float u = Mathf.Repeat(h - AirTempMaxPhase, 1f) / (1f - (AirTempMaxPhase - AirTempMinPhase));
                t = tMax - range * (1f - Mathf.Cos(Mathf.PI * u)) * 0.5f;
            }
            AirTempC = t;
            AirTempDisplay = Mathf.RoundToInt(t);
        }

        // ---------------------------------------------------------------- helpers

        /// <summary>LCDA level-walking speed term 1.94 S^0.43 + 0.24 S^4 (W per kg, standing term excluded).</summary>
        private static float LcdaSpeedTerm(float s)
        {
            if (!(s > 0f))
            {
                return 0f;
            }
            float s2 = s * s;
            return LcdaSpeedA * Mathf.Pow(s, LcdaSpeedExp) + LcdaSpeedB * s2 * s2;
        }

        private static float VO2ReserveFraction(float vo2)
        {
            return Mathf.Clamp01((vo2 - Vo2Resting) / (Vo2Max - Vo2Resting));
        }

        private static HudSeverity SlopeHysteresis(HudSeverity s, float slope)
        {
            if (slope >= SlopeWarningEnterDeg || (s == HudSeverity.Warning && slope >= SlopeWarningExitDeg))
            {
                return HudSeverity.Warning;
            }
            if (slope >= SlopeCautionEnterDeg || (s >= HudSeverity.Caution && slope >= SlopeCautionExitDeg))
            {
                return HudSeverity.Caution;
            }
            return HudSeverity.Nominal;
        }

        private static HudSeverity Level(float pct, float caution, float warning)
        {
            return pct <= warning ? HudSeverity.Warning
                 : pct <= caution ? HudSeverity.Caution
                 : HudSeverity.Nominal;
        }

        private static float Finite(float v, float fallback)
        {
            return float.IsNaN(v) || float.IsInfinity(v) ? fallback : v;
        }

        private static bool Finite(float v)
        {
            return !float.IsNaN(v) && !float.IsInfinity(v);
        }
    }
}

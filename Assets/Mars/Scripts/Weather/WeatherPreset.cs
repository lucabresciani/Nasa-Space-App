using System;
using UnityEngine;

namespace NasaSpaceApp
{
    /// <summary>
    /// The targets of one weather state. <see cref="MarsWeather"/> springs toward these values, so a preset is
    /// a destination, never a jump. Everything the lighting needs is derived from <see cref="opticalDepth"/>
    /// (MarsWeather.FromDust); nothing optical is set per state.
    /// </summary>
    [Serializable]
    public struct WeatherPreset
    {
        [Tooltip("Label only: MarsWeather indexes its presets by WeatherKind (Clear, IceClouds, DustDevils, DustyHaze, DustStorm).")]
        public WeatherKind kind;
        [Min(0.05f), Tooltip("Column dust optical depth tau. Rover sites see about 0.3-0.9 outside storms; at or below the clear baseline the sky looks exactly like today's.")]
        public float opticalDepth;
        [Min(0f), Tooltip("Mean wind speed near the ground, m/s. Gusts add up to +/-35% x gust on top.")]
        public float windSpeed;
        [Range(0f, 360f), Tooltip("Compass heading the wind blows FROM, in degrees (0 north = +Z, 90 east = +X), like a weather report.")]
        public float windFromHeadingDeg;
        [Range(0f, 1f), Tooltip("Gustiness: how strongly the wind speed and heading fluctuate.")]
        public float gust;
        [Range(0f, 1f), Tooltip("Dust lifted around the observer (streaks, motes).")]
        public float localDust;
        [Range(0f, 1f), Tooltip("Distant rolling dust sheets.")]
        public float dustSheets;
        [Range(0f, 1f), Tooltip("Dust-devil activity. The effects also scale it by sun height, so there are none at night.")]
        public float devilActivity;
        [Range(0f, 1f), Tooltip("Water-ice cloud cover in the sky.")]
        public float iceClouds;
        [Min(0f), Tooltip("Relative chance that automatic evolution picks this state. 0 = never automatic (still reachable with the key).")]
        public float autoWeight;

        public WeatherPreset(WeatherKind kind, float opticalDepth, float windSpeed, float windFromHeadingDeg, float gust,
            float localDust, float dustSheets, float devilActivity, float iceClouds, float autoWeight)
        {
            this.kind = kind;
            this.opticalDepth = opticalDepth;
            this.windSpeed = windSpeed;
            this.windFromHeadingDeg = windFromHeadingDeg;
            this.gust = gust;
            this.localDust = localDust;
            this.dustSheets = dustSheets;
            this.devilActivity = devilActivity;
            this.iceClouds = iceClouds;
            this.autoWeight = autoWeight;
        }

        /// <summary>
        /// Mean wind velocity in m/s on world X/Z, pointing where the air goes (opposite the "from" heading).
        /// A vector rather than an angle, so blending two presets never wraps around 359 -> 0 degrees.
        /// </summary>
        public Vector2 WindVelocity
        {
            get
            {
                float heading = windFromHeadingDeg * Mathf.Deg2Rad;
                return new Vector2(-Mathf.Sin(heading), -Mathf.Cos(heading)) * windSpeed;
            }
        }

        /// <summary>
        /// The default five presets, indexed by <see cref="WeatherKind"/>. Returns a new array each call: meant for
        /// field initialisers and editor setup, not for per-frame code.
        ///
        /// Sources (PRODUCT.md: never fabricate science; anything tuned is labelled):
        /// - tau: rover sites outside storms see about 0.3-0.9, Opportunity's usual about 0.5 (Lemmon et al. 2015,
        ///   Icarus). Opportunity measured tau about 1.0 on sol 5105 and 2.1 on sol 5106 as the 2018 storm arrived
        ///   (Planetary Society MER update, June 2018). Perseverance's January 2022 Jezero storm peaked near tau 2
        ///   with winds up to 20 m/s (Lemmon et al. 2022, GRL, doi:10.1029/2022GL100126).
        /// - Wind: daytime surface winds of a few m/s (Viking, Pathfinder, MEDA; approximate); a 28 m/s gust at
        ///   InSight (Spiga et al. 2020). Headings are an art choice: 250 degrees reproduces the existing mote drift.
        /// - Dust devils: Gusev (Greeley et al. 2006, JGR) and Jezero (Hueso et al. 2023, JGR Planets: 2-3 per km^2
        ///   per sol, peak around noon). Curiosity saw them stop during the 2018 global storm.
        /// - Ice clouds: water-ice clouds about 50 km up, glowing after sunset (Curiosity twilight clouds 2019/2021).
        /// The 0..1 amounts (gust, local dust, sheets, devils, clouds) and the auto weights are artistic tuning.
        /// </summary>
        public static WeatherPreset[] CreateDefaults() => new[]
        {
            // A typical clear sol. tau sits on the clear baseline, so every modifier is the identity and the scene
            // looks exactly like it did before weather existed.
            new WeatherPreset(WeatherKind.Clear, opticalDepth: 0.5f, windSpeed: 3f, windFromHeadingDeg: 250f, gust: 0.2f,
                localDust: 0.1f, dustSheets: 0f, devilActivity: 0.3f, iceClouds: 0f, autoWeight: 4f),

            // Aphelion-season sky: a little clearer than the baseline (fog is clamped, so never clearer than today)
            // with thin water-ice clouds. Auto weight 0: the default season is the dust season, and the aphelion
            // cloud belt and dust-storm season are seasonally separate (general knowledge, exact Ls bounds unsure).
            new WeatherPreset(WeatherKind.IceClouds, opticalDepth: 0.4f, windSpeed: 2.5f, windFromHeadingDeg: 260f, gust: 0.15f,
                localDust: 0.05f, dustSheets: 0f, devilActivity: 0.2f, iceClouds: 0.7f, autoWeight: 0f),

            // Convective afternoon: breezier, slightly hazier, full dust-devil activity (still gated by the sun).
            new WeatherPreset(WeatherKind.DustDevils, opticalDepth: 0.6f, windSpeed: 5f, windFromHeadingDeg: 240f, gust: 0.5f,
                localDust: 0.2f, dustSheets: 0f, devilActivity: 1f, iceClouds: 0f, autoWeight: 3f),

            // Raised background dust (dusty season, or a storm decaying): tau 1.3 sits between Opportunity's 1.0 and
            // 2.1 of June 2018. A derived in-between state, not a specific measurement.
            new WeatherPreset(WeatherKind.DustyHaze, opticalDepth: 1.3f, windSpeed: 6f, windFromHeadingDeg: 230f, gust: 0.35f,
                localDust: 0.35f, dustSheets: 0.15f, devilActivity: 0.4f, iceClouds: 0f, autoWeight: 2f),

            // Regional storm analog: Jezero, January 2022 (tau about 2, winds to 20 m/s) and regional storms of tau 2-3.
            // tau 3.0 is the upper end of that range, chosen so the storm reads clearly (a lead decision, not a
            // measurement); planet-encircling storms (tau 8-10.8) are out of scope. 17 m/s mean wind with gust 0.6
            // peaks near 20.6 m/s. No dust devils: storms suppress surface convection (unsure for regional storms).
            new WeatherPreset(WeatherKind.DustStorm, opticalDepth: 3f, windSpeed: 17f, windFromHeadingDeg: 210f, gust: 0.6f,
                localDust: 1f, dustSheets: 1f, devilActivity: 0f, iceClouds: 0f, autoWeight: 0.6f),
        };
    }
}

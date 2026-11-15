using System;
using System.Globalization;
using UnityEngine;

namespace NasaSpaceApp.Mission
{
    /// <summary>
    /// Puts the scene's sky and weather on the plan's conditions when a web mission starts, and back afterwards.
    ///
    /// <para><b>Time.</b> The sky jumps to the planned EVA start: <c>conditions.eva_start_utc</c> when the file has it,
    /// else the instant on the scene's current date when LMST at the pad is <c>eva_start_lmst</c> (09:00, D31). The sol
    /// then runs in real time (<see cref="MarsClock.SolSeconds"/> per sol instead of the scene's sped-up 1200 s), so EVA
    /// minute t in the simulator is the plan's minute t and the sun sets when the plan's t_dark says.</para>
    ///
    /// <para><b>Weather.</b> The planner assumes today's clear sky: the weather snaps to Clear and stops evolving on its own
    /// (M still works). With the D39 storm switch on, the radiation storm is replayed on the suit's dose rate
    /// (<see cref="DoseRateMsvH"/>); the dust weather is not part of it (it was a solar particle event).</para>
    /// </summary>
    public static class MissionEnvironment
    {
        private static bool saved;
        private static float savedSolDuration;
        private static bool savedAutoEvolve, savedHistorical;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            saved = false;
        }

        /// <summary>Applies the plan's start time and weather; returns a one-line summary for the log.</summary>
        public static string Apply(MissionPlan plan)
        {
            string time = "sky unchanged (no DayNightCycle)";
            DayNightCycle sky = UnityEngine.Object.FindAnyObjectByType<DayNightCycle>();
            MarsWeather weather = UnityEngine.Object.FindAnyObjectByType<MarsWeather>();
            if (!saved)
            {
                saved = true;
                savedSolDuration = sky != null ? sky.SolDuration : 0f;
                savedAutoEvolve = weather != null && weather.AutoEvolve;
                savedHistorical = weather != null && weather.Historical;
            }

            if (sky != null)
            {
                DateTime? start = EvaStart(plan, out string how);
                if (start.HasValue && sky.SetInstant(start.Value))
                {
                    sky.SolDuration = (float)MarsClock.SolSeconds;
                    double lon = plan.Source.Frame.Pad.Lon;
                    time = string.Format(CultureInfo.InvariantCulture, "sky at EVA start {0:yyyy-MM-dd HH:mm:ss} UTC = {1} LMST at the pad ({2}); real-time sol",
                                         start.Value, MarsClock.Hms(MarsClock.LmstHours(start.Value, lon)), how);
                }
                else
                {
                    time = "sky not moved: " + (start.HasValue ? "Real Sky is off" : how);
                }
            }

            string wx = "weather unchanged (no MarsWeather)";
            if (weather != null)
            {
                weather.Historical = false;
                weather.AutoEvolve = false;
                weather.SnapTo(WeatherKind.Clear);
                wx = "weather Clear, fixed (the plan assumes today's clear sky; M still changes it)";
            }
            string dose = plan.Dose != null
                ? string.Format(CultureInfo.InvariantCulture, "storm replay: dose series {0} knots, D_allow {1} mGy", plan.Dose.EvaMin.Length, plan.Dose.DAllowMgy)
                : "no storm replay";
            return time + "; " + wx + "; " + dose;
        }

        /// <summary>Back to the scene's own clock speed and weather behaviour (the sky stays where it is).</summary>
        public static void Restore()
        {
            if (!saved)
            {
                return;
            }
            saved = false;
            DayNightCycle sky = UnityEngine.Object.FindAnyObjectByType<DayNightCycle>();
            if (sky != null) sky.SolDuration = savedSolDuration;
            MarsWeather weather = UnityEngine.Object.FindAnyObjectByType<MarsWeather>();
            if (weather != null)
            {
                weather.AutoEvolve = savedAutoEvolve;
                weather.Historical = savedHistorical;
            }
        }

        /// <summary>
        /// Suit dose rate for EVA minute <paramref name="evaMin"/> under the storm replay: the Gale background scaled by the
        /// storm series relative to its quiet level (the series is absorbed dose, the suit shows dose equivalent; the
        /// ratio carries over, the unit conversion is not needed). NaN when there is no storm replay.
        /// </summary>
        public static float DoseRateMsvH(MissionPlan plan, float evaMin, float galeBackgroundMsvH)
        {
            DoseSeries d = plan != null ? plan.Dose : null;
            if (d == null || !(d.QuietRateMgyH > 0f)) return float.NaN;
            return galeBackgroundMsvH * d.RateAt(evaMin) / d.QuietRateMgyH;
        }

        /// <summary>The planned EVA start instant, and how it was found.</summary>
        public static DateTime? EvaStart(MissionPlan plan, out string how)
        {
            if (plan.EvaStartUtc.HasValue)
            {
                how = "eva_start_utc from the file";
                return plan.EvaStartUtc.Value;
            }
            if (float.IsNaN(plan.EvaStartLmstHours))
            {
                how = "the file has no EVA start time";
                return null;
            }
            DateTime near = MarsSkyState.Version > 0 ? MarsSkyState.StartDateUtc : new DateTime(2026, 11, 14, 12, 0, 0, DateTimeKind.Utc);
            how = "eva_start_lmst on the scene's date";
            return MarsClock.UtcForLmst(near, plan.EvaStartLmstHours, plan.Source.Frame.Pad.Lon);
        }
    }
}

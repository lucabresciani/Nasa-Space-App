using System;
using System.Globalization;
using UnityEngine;

namespace NasaSpaceApp.Homeline.Sim
{
    /// <summary>
    /// Keeps the scene's sky on the EVA clock. The planner's EVA starts at a real instant (plan.json eva_start.utc,
    /// 09:00 local mean solar time at Gale); the scene's DayNightCycle computes the real sun from ephemerides for
    /// whatever instant its own clock says, and by default lets a sol pass in 20 minutes. During an EVA the cycle is
    /// set to the EVA instant and made to flow at the EVA's speed, so the sun the crew sees is the sun of that minute
    /// of the plan (stars, planets and moons follow, since they share the cycle's instant).
    ///
    /// DayNightCycle is not edited: its two serialized clock fields (timeOfDay, solDuration) are written with
    /// JsonUtility and the component is re-enabled so it snaps to them. Without a real-sky cycle nothing is done.
    /// </summary>
    public sealed class SkySync
    {
        /// <summary>One Mars sol in seconds (the cycle's solDuration at real time).</summary>
        const double SolSeconds = 88775.244;
        const float DriftTolerance = 0.0006f; // of a sol, about 50 s of EVA

        DayNightCycle cycle;
        bool captured;
        float originalTimeOfDay, originalSolDuration;
        double lastFlow = double.NaN;

        public bool Available
        {
            get { return Find() != null && MarsSkyState.Version > 0 && MarsSkyState.RealSky; }
        }

        /// <summary>
        /// Puts the sky at the EVA instant and lets it flow at <paramref name="flow"/> EVA seconds per game second
        /// (0 = frozen). Cheap to call often: it only touches the cycle when the speed changed or the sky drifted.
        /// </summary>
        public void Apply(DateTime evaStartUtc, double tEvaMin, double flow, bool force)
        {
            DayNightCycle c = Find();
            if (c == null || MarsSkyState.Version <= 0 || !MarsSkyState.RealSky) return;
            if (!captured) Capture(c);

            float want = SolarTime(evaStartUtc, tEvaMin);
            float drift = Mathf.Abs(Mathf.DeltaAngle(c.TimeOfDay * 360f, want * 360f)) / 360f;
            if (!force && flow == lastFlow && drift < DriftTolerance) return;
            lastFlow = flow;
            Write(c, want, flow > 0 ? (float)(SolSeconds / flow) : 0f);
        }

        /// <summary>Gives the sky back to the scene's own clock, as it was before the EVA.</summary>
        public void Release()
        {
            if (captured && cycle != null) Write(cycle, originalTimeOfDay, originalSolDuration);
            captured = false;
            lastFlow = double.NaN;
        }

        /// <summary>Local true solar time at the site as a fraction of the sol (0.5 = the sun on the meridian).</summary>
        public static float SolarTime(DateTime evaStartUtc, double tEvaMin)
        {
            double days = MarsEphemeris.DaysTT(MarsEphemeris.JulianDateUtc(evaStartUtc.AddMinutes(tEvaMin)));
            double hourAngle = MarsEphemeris.SunHourAngleDeg(days, MarsSkyState.Longitude);
            return Mathf.Repeat((float)(0.5 + hourAngle / 360.0), 1f);
        }

        DayNightCycle Find()
        {
            if (cycle == null) cycle = UnityEngine.Object.FindAnyObjectByType<DayNightCycle>();
            return cycle;
        }

        void Capture(DayNightCycle c)
        {
            Newtonsoft.Json.Linq.JToken j = HlJson.Parse(JsonUtility.ToJson(c));
            originalTimeOfDay = (float)(HlJson.NumOrNull(j, "timeOfDay") ?? c.TimeOfDay);
            originalSolDuration = (float)(HlJson.NumOrNull(j, "solDuration") ?? 1200.0);
            captured = true;
        }

        static void Write(DayNightCycle c, float timeOfDay, float solDuration)
        {
            string json = "{\"timeOfDay\":" + timeOfDay.ToString("0.#######", CultureInfo.InvariantCulture) +
                          ",\"solDuration\":" + solDuration.ToString("0.###", CultureInfo.InvariantCulture) + "}";
            JsonUtility.FromJsonOverwrite(json, c);
            // OnEnable snaps the cycle's running clock to the serialized time.
            c.enabled = false;
            c.enabled = true;
        }
    }
}

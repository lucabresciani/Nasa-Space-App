using System;

namespace NasaSpaceApp
{
    /// <summary>
    /// Local mean solar time on Mars (Mars24, Allison &amp; McEwen 2000): Mars sol date MSD = (Δt_J2000(TT) − 4.5) /
    /// 1.0274912517 + 44796.0 − 0.0009626, MST = 24 h · frac(MSD), LMST = MST + east longitude / 15. This is the clock the
    /// HOMELINE web app plans on (EVA start 09:00 LMST, D31); <see cref="DayNightCycle"/> shows local TRUE solar time,
    /// which differs by the equation of time. Checked against the web's clock.json: 2026-11-14T10:51:18Z at 137.4018°E
    /// gives 08:59:58 LMST (web: 09:00:00).
    /// </summary>
    public static class MarsClock
    {
        /// <summary>Length of a mean solar day (sol) in SI seconds.</summary>
        public const double SolSeconds = 88775.244;

        /// <summary>Mars sol date at <paramref name="daysTT"/> (days since J2000, TT).</summary>
        public static double SolDate(double daysTT) => (daysTT - 4.5) / 1.0274912517 + 44796.0 - 0.0009626;

        /// <summary>LMST in hours [0, 24) at <paramref name="utc"/> and east longitude <paramref name="eastLonDeg"/>.</summary>
        public static double LmstHours(DateTime utc, double eastLonDeg)
        {
            double msd = SolDate(MarsEphemeris.DaysTT(MarsEphemeris.JulianDateUtc(utc)));
            double h = 24.0 * msd + eastLonDeg / 15.0;
            h -= 24.0 * Math.Floor(h / 24.0);
            return h;
        }

        /// <summary>LMST in hours [0, 24) at <paramref name="daysTT"/> (days since J2000 TT, e.g. MarsSkyState.DaysTT).</summary>
        public static double LmstHoursAtDays(double daysTT, double eastLonDeg)
        {
            double h = 24.0 * SolDate(daysTT) + eastLonDeg / 15.0;
            return h - 24.0 * Math.Floor(h / 24.0);
        }

        /// <summary>The instant nearest <paramref name="near"/> at which the LMST at the longitude is <paramref name="lmstHours"/>.</summary>
        public static DateTime UtcForLmst(DateTime near, double lmstHours, double eastLonDeg)
        {
            DateTime t = near;
            for (int i = 0; i < 3; i++)
            {
                double dh = lmstHours - LmstHours(t, eastLonDeg);
                dh -= 24.0 * Math.Floor((dh + 12.0) / 24.0);   // to [-12, 12)
                if (Math.Abs(dh) < 1e-6) break;
                t = t.AddSeconds(dh / 24.0 * SolSeconds);
            }
            return t;
        }

        /// <summary>"HH:MM:SS" of an hour value.</summary>
        public static string Hms(double hours)
        {
            int s = (int)Math.Round(hours * 3600.0);
            s = ((s % 86400) + 86400) % 86400;
            return (s / 3600).ToString("00") + ":" + (s / 60 % 60).ToString("00") + ":" + (s % 60).ToString("00");
        }
    }
}

using System;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Sunrise and sunset at a site on Mars, from <see cref="MarsEphemeris"/> (JPL approximate elements, NAIF pck00010
    /// orientation; its local true solar time agrees with NASA GISS Mars24 within 5 s). Pure maths, no allocation.
    ///
    /// Horizon: the event is the moment the Sun's CENTRE crosses <see cref="HorizonDeg"/> = −0.5° of geometric elevation
    /// (radial "up" of the scene's MOLA sphere, as MarsEphemeris uses). Mars's air bends light by well under an
    /// arcminute (MarsEphemeris notes ~2% of Earth's refractivity) and the solar semi-diameter is ~0.16–0.19° at
    /// 1.38–1.67 au, so −0.5° is a fixed operational threshold comparable to Earth's −0.833° convention, not a limb
    /// contact: at Gale's latitude (4.7° S) it moves sunrise ~1–2 min earlier and sunset ~1–2 min later than the upper
    /// limb touching the geometric horizon. Local terrain (crater rim, Mount Sharp) is not modelled.
    ///
    /// Search: the sol is the local one (true-solar midnight to midnight). Its true noon comes from
    /// <see cref="MarsEphemeris.LocalTrueNoon"/>; sunrise is bisected between the preceding midnight (noon − ½ sol) and
    /// noon, sunset between noon and the following midnight. 22 halvings of ½ sol give ~10 ms resolution.
    /// </summary>
    public static class MarsSunClock
    {
        /// <summary>Geometric elevation of the Sun's centre that defines sunrise and sunset, degrees.</summary>
        public const double HorizonDeg = -0.5;

        private const double Deg = Math.PI / 180.0;
        private const int Halvings = 22;

        /// <summary>
        /// Geometric elevation of the Sun's centre (degrees) at <paramref name="d"/> days since J2000 TT, seen from
        /// planetocentric latitude <paramref name="latDeg"/> and east longitude <paramref name="eastLonDeg"/>. Solar
        /// parallax from the surface (~0.001°) is ignored.
        /// </summary>
        public static double SunElevationDeg(double d, double latDeg, double eastLonDeg)
        {
            DVec3 sun = (MarsEphemeris.IcrfToBodyFixed(d) * MarsEphemeris.MarsCentricIcrf(SkyBody.Sun, d)).Normalized;
            double lat = latDeg * Deg, lon = eastLonDeg * Deg;
            double cosLat = Math.Cos(lat);
            double s = sun.X * cosLat * Math.Cos(lon) + sun.Y * cosLat * Math.Sin(lon) + sun.Z * Math.Sin(lat);
            return Math.Asin(s < -1.0 ? -1.0 : (s > 1.0 ? 1.0 : s)) / Deg;
        }

        /// <summary>
        /// The daylight period in progress at <paramref name="d"/>, or the next one: sunrise and sunset in days since
        /// J2000 TT, with <paramref name="d"/> &lt; <paramref name="setDays"/>. Day when d ≥ riseDays, night before.
        /// False (outputs NaN) under polar day or polar night, or for non-finite input.
        /// </summary>
        public static bool NextDaylight(double d, double latDeg, double eastLonDeg, out double riseDays, out double setDays)
        {
            riseDays = setDays = double.NaN;
            if (double.IsNaN(d) || double.IsInfinity(d) || double.IsNaN(latDeg) || double.IsNaN(eastLonDeg))
            {
                return false;
            }

            // This sol's noon: step back by the hour angle (H in (−180, 180]) so the search stays inside this sol.
            double h = MarsEphemeris.SunHourAngleDeg(d, eastLonDeg);
            double noon = MarsEphemeris.LocalTrueNoon(d - h / 360.0 * MarsEphemeris.SolDays, eastLonDeg);
            if (!Window(noon, latDeg, eastLonDeg, out riseDays, out setDays))
            {
                return false;
            }
            if (d >= setDays)
            {
                // After sunset: tomorrow's daylight.
                noon = MarsEphemeris.LocalTrueNoon(noon + MarsEphemeris.SolDays, eastLonDeg);
                if (!Window(noon, latDeg, eastLonDeg, out riseDays, out setDays))
                {
                    return false;
                }
            }
            return true;
        }

        // Sunrise and sunset around one true noon; false when the Sun does not cross the threshold that sol.
        private static bool Window(double noon, double lat, double lon, out double rise, out double set)
        {
            rise = set = double.NaN;
            double half = 0.5 * MarsEphemeris.SolDays;
            if (Above(noon, lat, lon) <= 0.0)
            {
                return false;   // polar night
            }
            if (Above(noon - half, lat, lon) >= 0.0 || Above(noon + half, lat, lon) >= 0.0)
            {
                return false;   // polar day
            }
            rise = Crossing(noon - half, noon, lat, lon, true);
            set = Crossing(noon, noon + half, lat, lon, false);
            return true;
        }

        // Bisection of a bracketed crossing: rising = below at a, above at b; setting = above at a, below at b.
        private static double Crossing(double a, double b, double lat, double lon, bool rising)
        {
            for (int i = 0; i < Halvings; i++)
            {
                double m = 0.5 * (a + b);
                bool below = Above(m, lat, lon) < 0.0;
                if (below == rising)
                {
                    a = m;
                }
                else
                {
                    b = m;
                }
            }
            return 0.5 * (a + b);
        }

        private static double Above(double d, double lat, double lon) => SunElevationDeg(d, lat, lon) - HorizonDeg;
    }
}

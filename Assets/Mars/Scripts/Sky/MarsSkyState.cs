using System;
using UnityEngine;

namespace NasaSpaceApp
{
    /// <summary>
    /// Static hub for the sky's clock and orientation. Published by <see cref="DayNightCycle"/> once per Apply; read by
    /// MarsNightSky (stars, planets, moons, labels) and anything else that needs the sky without finding the cycle.
    ///
    /// <see cref="CelestialToWorld"/> maps ICRF (J2000 equator and equinox) directions to Unity world directions
    /// (+X east, +Y up, +Z north). That map is improper (determinant -1): Unity's (east, up, north) triple is
    /// left-handed while the sky is right-handed, so it is a matrix and never a Quaternion. Use it as
    /// <c>world = CelestialToWorld.MultiplyVector(icrf)</c>; its transpose goes back (world to ICRF).
    ///
    /// Readers poll <see cref="Version"/> instead of subscribing to an event, as with <see cref="MarsAtmosphere"/>:
    /// domain reload is disabled (Enter Play Mode Options), so event subscriptions would survive play sessions and leak.
    /// </summary>
    public static class MarsSkyState
    {
        /// <summary>True: the sun and sky come from the ephemeris. False: the artistic sun path, with the real star
        /// field turned so the sun sits at its true right ascension among the stars.</summary>
        public static bool RealSky { get; private set; }

        /// <summary>The instant shown, in days since J2000.0 TT (JD_TT - 2451545.0).</summary>
        public static double DaysTT { get; private set; }

        /// <summary>ICRF to Unity world (improper, see the class summary). Identity until the first publish.</summary>
        public static Matrix4x4 CelestialToWorld { get; private set; } = Matrix4x4.identity;

        /// <summary>Observer latitude, degrees (planetocentric, south negative).</summary>
        public static double Latitude { get; private set; }

        /// <summary>Observer longitude, degrees east.</summary>
        public static double Longitude { get; private set; }

        /// <summary>Observer distance from Mars's centre, km: the maps' sphere plus the spawn's MOLA elevation.
        /// Default: the HOMELINE pad, 3396.19 km plus its MOLA elevation of about -3.64 km.</summary>
        public static double ObserverRadiusKm { get; private set; } = 3392.5;

        /// <summary>Sols since the start date (0 on the first sol).</summary>
        public static int Sol { get; private set; }

        /// <summary>Fraction of the sol: 0 midnight, 0.5 true noon (local true solar time in real-sky mode).</summary>
        public static float LocalSolarTime { get; private set; }

        /// <summary>0 by day .. 1 at night, from the sun's elevation alone, no dust term (the same as the shader global
        /// _MarsSkyDark). Dust is left to the readers, which dim each direction by its own air mass.</summary>
        public static float Darkness { get; private set; }

        /// <summary>Earth date and time (UTC) of sol 0.</summary>
        public static DateTime StartDateUtc { get; private set; }

        /// <summary>Changes on every publish (and when play mode starts). Poll it to know when to rebuild.</summary>
        public static int Version { get; private set; }

        /// <summary>Publishes the sky. DayNightCycle calls it from every Apply, so <see cref="Version"/> moves every
        /// frame in play mode and only on snaps or weather changes in edit mode.</summary>
        public static void Publish(bool realSky, double daysTT, Matrix4x4 celestialToWorld, double latitude, double longitude,
            double observerRadiusKm, int sol, float localSolarTime, float darkness, DateTime startDateUtc)
        {
            RealSky = realSky;
            DaysTT = daysTT;
            CelestialToWorld = celestialToWorld;
            Latitude = latitude;
            Longitude = longitude;
            ObserverRadiusKm = observerRadiusKm;
            Sol = sol;
            LocalSolarTime = localSolarTime;
            Darkness = darkness;
            StartDateUtc = startDateUtc;
            unchecked { Version++; }
        }

        // Domain reload is off: without this the last session's sky would linger until a DayNightCycle publishes.
        // Version moves on rather than back to 0, so a reader that cached an old value still sees a change.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            RealSky = false;
            DaysTT = 0.0;
            CelestialToWorld = Matrix4x4.identity;
            Latitude = 0.0;
            Longitude = 0.0;
            ObserverRadiusKm = 3392.5;
            Sol = 0;
            LocalSolarTime = 0f;
            Darkness = 0f;
            StartDateUtc = default;
            unchecked { Version++; }
        }
    }
}

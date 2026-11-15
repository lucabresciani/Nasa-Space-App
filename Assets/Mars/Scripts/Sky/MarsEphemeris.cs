using System;
using System.Globalization;

namespace NasaSpaceApp
{
    /// <summary>
    /// Double-precision 3-vector for the sky maths. Float is not enough here: by 2027 Mars's prime-meridian angle has
    /// grown to ~3.4 million degrees and Phobos's mean anomaly to ~11 million, where a float keeps no fraction of a degree.
    /// <see cref="Cross"/> is the mathematical cross product of a right-handed frame (ICRF, ecliptic, Mars body-fixed).
    /// Unity world vectors (x east, y up, z north) form a left-handed triple: the physical cross product of two of them is
    /// <c>Cross(b, a)</c>, not <c>Cross(a, b)</c>.
    /// </summary>
    public readonly struct DVec3
    {
        public readonly double X, Y, Z;

        public DVec3(double x, double y, double z)
        {
            X = x;
            Y = y;
            Z = z;
        }

        public static DVec3 operator +(DVec3 a, DVec3 b) => new DVec3(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
        public static DVec3 operator -(DVec3 a, DVec3 b) => new DVec3(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
        public static DVec3 operator -(DVec3 a) => new DVec3(-a.X, -a.Y, -a.Z);
        public static DVec3 operator *(DVec3 a, double s) => new DVec3(a.X * s, a.Y * s, a.Z * s);
        public static DVec3 operator *(double s, DVec3 a) => new DVec3(a.X * s, a.Y * s, a.Z * s);
        public static DVec3 operator /(DVec3 a, double s) => new DVec3(a.X / s, a.Y / s, a.Z / s);

        public static double Dot(DVec3 a, DVec3 b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;

        /// <summary>a × b by the textbook formula; physically meaningful only in a right-handed frame.</summary>
        public static DVec3 Cross(DVec3 a, DVec3 b) =>
            new DVec3(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X);

        public double Length => Math.Sqrt(X * X + Y * Y + Z * Z);

        /// <summary>Unit vector in the same direction; the zero vector stays zero (no NaN).</summary>
        public DVec3 Normalized
        {
            get
            {
                double length = Length;
                return length > 0.0 ? this / length : this;
            }
        }

        public override string ToString() =>
            string.Format(CultureInfo.InvariantCulture, "({0:G9}, {1:G9}, {2:G9})", X, Y, Z);
    }

    /// <summary>
    /// Double-precision 3×3 matrix, row-major (<c>Mrc</c> = row r, column c), acting on column vectors: <c>m * v</c>.
    /// Celestial transforms into Unity's world are improper (determinant −1, see <see cref="MarsEphemeris.IcrfToUnity"/>),
    /// which is why they live in a matrix and never in a quaternion.
    /// </summary>
    public readonly struct DMat3
    {
        public readonly double M00, M01, M02, M10, M11, M12, M20, M21, M22;

        public DMat3(double m00, double m01, double m02, double m10, double m11, double m12, double m20, double m21, double m22)
        {
            M00 = m00; M01 = m01; M02 = m02;
            M10 = m10; M11 = m11; M12 = m12;
            M20 = m20; M21 = m21; M22 = m22;
        }

        public static readonly DMat3 Identity = new DMat3(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);

        public static DMat3 FromRows(DVec3 r0, DVec3 r1, DVec3 r2) =>
            new DMat3(r0.X, r0.Y, r0.Z, r1.X, r1.Y, r1.Z, r2.X, r2.Y, r2.Z);

        public DVec3 Row0 => new DVec3(M00, M01, M02);
        public DVec3 Row1 => new DVec3(M10, M11, M12);
        public DVec3 Row2 => new DVec3(M20, M21, M22);

        /// <summary>The transpose; for a rotation, proper or improper, also the inverse.</summary>
        public DMat3 Transpose => new DMat3(M00, M10, M20, M01, M11, M21, M02, M12, M22);

        public static DMat3 operator *(DMat3 a, DMat3 b) => new DMat3(
            a.M00 * b.M00 + a.M01 * b.M10 + a.M02 * b.M20,
            a.M00 * b.M01 + a.M01 * b.M11 + a.M02 * b.M21,
            a.M00 * b.M02 + a.M01 * b.M12 + a.M02 * b.M22,
            a.M10 * b.M00 + a.M11 * b.M10 + a.M12 * b.M20,
            a.M10 * b.M01 + a.M11 * b.M11 + a.M12 * b.M21,
            a.M10 * b.M02 + a.M11 * b.M12 + a.M12 * b.M22,
            a.M20 * b.M00 + a.M21 * b.M10 + a.M22 * b.M20,
            a.M20 * b.M01 + a.M21 * b.M11 + a.M22 * b.M21,
            a.M20 * b.M02 + a.M21 * b.M12 + a.M22 * b.M22);

        public static DVec3 operator *(DMat3 m, DVec3 v) => new DVec3(
            m.M00 * v.X + m.M01 * v.Y + m.M02 * v.Z,
            m.M10 * v.X + m.M11 * v.Y + m.M12 * v.Z,
            m.M20 * v.X + m.M21 * v.Y + m.M22 * v.Z);

        /// <summary>
        /// Passive (frame) rotation about x by <paramref name="deg"/>: the coordinates of a fixed vector in axes turned by
        /// +deg. [[1, 0, 0], [0, c, s], [0, −s, c]], the R1 of the IAU/WGCCRE conventions.
        /// </summary>
        public static DMat3 RotX(double deg)
        {
            double r = deg * (Math.PI / 180.0), c = Math.Cos(r), s = Math.Sin(r);
            return new DMat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
        }

        /// <summary>Passive (frame) rotation about z by <paramref name="deg"/>: [[c, s, 0], [−s, c, 0], [0, 0, 1]] (R3).</summary>
        public static DMat3 RotZ(double deg)
        {
            double r = deg * (Math.PI / 180.0), c = Math.Cos(r), s = Math.Sin(r);
            return new DMat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
        }
    }

    /// <summary>Bodies the Mars sky can show. Mars itself is the observer's planet and is not listed.</summary>
    public enum SkyBody { Sun, Mercury, Venus, Earth, Moon, Jupiter, Saturn, Uranus, Neptune, Phobos, Deimos }

    /// <summary>
    /// Where things are in the sky of Mars, from NASA-published low-precision models: no external data at run time,
    /// double precision, no UnityEngine (it builds and is tested as a plain .NET library). Every constant below comes
    /// from a NASA page (JPL Solar System Dynamics, JPL Horizons, NASA NAIF, NASA GISS, NASA NSSDCA), cited where used.
    /// <list type="bullet">
    /// <item>Planets: JPL SSD "Keplerian Elements for Approximate Positions of the Major Planets",
    /// https://ssd.jpl.nasa.gov/planets/approx_pos.html , Table 1, valid 1800-2050. Nominal errors over that span:
    /// Mars 40", Earth-Moon barycentre 20", Jupiter 400", Saturn 600" in heliocentric longitude (JPL's own table).</item>
    /// <item>Moon (for the Earth-Moon pair seen from Mars): a precessing ellipse from the JPL SSD planetary satellite
    /// mean elements of the Moon (https://ssd.jpl.nasa.gov/sats/elem/ ; DE405/LE405, J2000 ecliptic). Mean elements leave
    /// out the Sun's large perturbations of the lunar orbit; against JPL Horizons over 2000-2027 the Moon's geocentric
    /// direction errs by up to ~4°, which seen from Mars moves it by under 0.02° from the Earth (see
    /// <c>MoonElements</c>).</item>
    /// <item>Mars orientation: NASA NAIF pck00010.tpc (BODY499_POLE_RA, POLE_DEC, PM: the IAU WGCCRE 2009 report
    /// values), https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00010.tpc , the model whose prime meridian
    /// (Airy-0) the scene's MOLA maps use.</item>
    /// <item>Phobos and Deimos: a precessing ellipse from the JPL SSD planetary satellite mean elements (ephemeris
    /// MAR099), with precession and mean-motion rates fitted to JPL Horizons; within ~0.4° of Horizons over 2000-2035
    /// (see the notes above <c>SatelliteElements</c>).</item>
    /// </list>
    /// Checked offline against JPL Horizons (DE441, mar099), 2000-2027 seen from Mars's centre: Sun, Mercury, Venus,
    /// Earth, Moon within 0.04°, Jupiter 0.11°, Saturn 0.19°. From the HOMELINE site (2026-11-14) the Sun's
    /// azimuth and elevation agree to 0.004° once the same vertical is used (Horizons measures elevation from the
    /// ellipsoid normal, 0.057° from the sphere's radial "up" of the scene's maps, which is what this class uses), Phobos
    /// and Deimos to 0.1°. Local true solar time agrees with NASA GISS's Mars24 algorithm
    /// (https://www.giss.nasa.gov/tools/mars24/help/algorithm.html) within 5 s.
    /// Time <c>d</c> = days since J2000.0 TT (JD_TT − 2451545.0); TDB, the argument of the planetary theories, differs
    /// from TT by under 2 ms. Positions are geometric: no light-time correction (a planet moves at most ~30" while its
    /// light reaches Mars), no aberration (~17" at Mars's 24 km/s), no atmospheric refraction (an estimate: Mars's air
    /// has ~2% of Earth's refractivity, well under an arcminute even at the horizon).
    /// Frames: ICRF = J2000 mean equator and equinox (the ~0.02" frame bias is ignored); the J2000 ecliptic is tilted by
    /// ε = 23.43928°, the obliquity at J2000 stated on the JPL approx_pos page for these elements. Mars body-fixed:
    /// x toward the prime meridian on the equator, z the north pole, planetocentric latitude, east longitude positive
    /// (as the scene's maps).
    /// </summary>
    public static class MarsEphemeris
    {
        /// <summary>
        /// Mars mean solar day in Earth days (88775.244 s): the divisor of the mean solar time in NASA GISS's Mars24
        /// algorithm, step C-2 (https://www.giss.nasa.gov/tools/mars24/help/algorithm.html).
        /// </summary>
        public const double SolDays = 1.0274912517;
        /// <summary>Astronomical unit, km: 149597870700 m, JPL SSD astrodynamic parameters (https://ssd.jpl.nasa.gov/astro_par.html).</summary>
        public const double AuKm = 149597870.7;
        /// <summary>
        /// Mars radius of the scene's maps (MarsGeoReference: MOLA sphere, 3396.19 km), equal to Mars's equatorial radius
        /// in NASA NAIF pck00010.tpc (BODY499_RADII) and on the JPL SSD planetary physical parameters page.
        /// </summary>
        public const double MarsRadiusKm = 3396.19;
        /// <summary>
        /// TT − UTC = DELTA_T_A 32.184 s + DELTA_AT 37 s (the leap-second count from 2017-01-01 on), NASA NAIF leap-seconds
        /// kernel naif0012.tls (https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/naif0012.tls); its table makes it
        /// 1 s smaller from 2015-07-01 and 2 s smaller from 2012-07-01.
        /// </summary>
        public const double TTMinusUTCSeconds = 69.184;

        const double Deg = Math.PI / 180.0;
        const double J2000Jd = 2451545.0;
        const double DaysPerCentury = 36525.0;
        const double DaysPerJulianYear = 365.25;
        // Obliquity of the ecliptic at J2000, as stated on the JPL approx_pos page for its elements.
        const double ObliquityJ2000Deg = 23.43928;
        // Earth/Moon mass ratio: EMRAT = 81.3005682214972154 of JPL's DE440 ephemeris (constants in its header file,
        // https://ssd.jpl.nasa.gov/ftp/eph/planets/ascii/de440/header.440). The barycentre sits 1/82.30057 of the way to
        // the Moon.
        const double EarthMoonMassRatio = 81.3005682214972154;

        static readonly long J2000Ticks = new DateTime(2000, 1, 1, 12, 0, 0, DateTimeKind.Utc).Ticks;
        static readonly double CosObliquity = Math.Cos(ObliquityJ2000Deg * Deg);
        static readonly double SinObliquity = Math.Sin(ObliquityJ2000Deg * Deg);

        // ---------------------------------------------------------------------------------------------------- Time

        /// <summary>Julian date of a UTC instant. The Kind of <paramref name="utc"/> is ignored: it is taken as UTC.</summary>
        public static double JulianDateUtc(DateTime utc) =>
            J2000Jd + (utc.Ticks - J2000Ticks) / (double)TimeSpan.TicksPerDay;

        /// <summary>Days since J2000.0 TT for a UTC Julian date (TT − UTC = <see cref="TTMinusUTCSeconds"/>).</summary>
        public static double DaysTT(double jdUtc) => jdUtc + TTMinusUTCSeconds / 86400.0 - J2000Jd;

        /// <summary>
        /// UTC instant (<see cref="DateTimeKind.Utc"/>) of <paramref name="d"/> days since J2000.0 TT; the inverse of
        /// <see cref="DaysTT"/>(<see cref="JulianDateUtc"/>(t)) to within ~0.1 ms (the resolution of a double Julian
        /// date). Clamped to the DateTime range; NaN throws.
        /// </summary>
        public static DateTime UtcFromDaysTT(double d)
        {
            if (double.IsNaN(d)) throw new ArgumentException("Days since J2000 must be a number.", nameof(d));
            // Offset from J2000 in ticks, kept apart from the large epoch tick count so the double keeps its precision.
            double offset = (d - TTMinusUTCSeconds / 86400.0) * TimeSpan.TicksPerDay;
            if (offset <= DateTime.MinValue.Ticks - J2000Ticks) return new DateTime(DateTime.MinValue.Ticks, DateTimeKind.Utc);
            if (offset >= DateTime.MaxValue.Ticks - J2000Ticks) return new DateTime(DateTime.MaxValue.Ticks, DateTimeKind.Utc);
            long ticks = J2000Ticks + (long)Math.Round(offset);
            ticks = Math.Min(Math.Max(ticks, DateTime.MinValue.Ticks), DateTime.MaxValue.Ticks);
            return new DateTime(ticks, DateTimeKind.Utc);
        }

        // ------------------------------------------------------------------------------------------------- Planets

        // JPL approximate elements, Table 1 (1800-2050), J2000 ecliptic and equinox, copied digit for digit from
        // https://ssd.jpl.nasa.gov/planets/approx_pos.html : a [au], e, I [deg], L mean longitude [deg],
        // ϖ longitude of perihelion [deg], Ω longitude of the ascending node [deg]; each followed by its rate per Julian
        // century. Table 1 needs no extra terms for the outer planets (those belong to Table 2, 3000 BC-3000 AD).
        readonly struct PlanetElements
        {
            public readonly double A, E, I, L, Peri, Node, ADot, EDot, IDot, LDot, PeriDot, NodeDot;

            public PlanetElements(double a, double e, double i, double l, double peri, double node,
                double aDot, double eDot, double iDot, double lDot, double periDot, double nodeDot)
            {
                A = a; E = e; I = i; L = l; Peri = peri; Node = node;
                ADot = aDot; EDot = eDot; IDot = iDot; LDot = lDot; PeriDot = periDot; NodeDot = nodeDot;
            }
        }

        const int MercuryIndex = 0, VenusIndex = 1, EmBaryIndex = 2, MarsIndex = 3,
            JupiterIndex = 4, SaturnIndex = 5, UranusIndex = 6, NeptuneIndex = 7;

        static readonly PlanetElements[] Planets =
        {
            new PlanetElements(0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
                0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081),       // Mercury
            new PlanetElements(0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
                0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418),        // Venus
            new PlanetElements(1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
                0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0),                // Earth-Moon barycentre
            new PlanetElements(1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
                0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343),         // Mars
            new PlanetElements(5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
                -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106),         // Jupiter
            new PlanetElements(9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
                -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794),        // Saturn
            new PlanetElements(19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503,
                -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589),          // Uranus
            new PlanetElements(30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
                0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664),           // Neptune
        };

        /// <summary>
        /// Heliocentric position (au) in the J2000 ecliptic frame. Sun = origin. Earth and Moon split the Earth-Moon
        /// barycentre of the JPL table with the JPL mean lunar ellipse: Earth = EMB − moon/82.30057 (DE440 mass ratio),
        /// Moon = Earth + moon (the pair is up to ~0.4° apart seen from Mars, enough to show them as two points). Phobos and Deimos have
        /// no heliocentric theory here (ArgumentException): use <see cref="MarsCentricIcrf"/>.
        /// </summary>
        public static DVec3 HeliocentricEcliptic(SkyBody body, double d)
        {
            switch (body)
            {
                case SkyBody.Sun: return default;
                case SkyBody.Mercury: return PlanetHeliocentric(MercuryIndex, d);
                case SkyBody.Venus: return PlanetHeliocentric(VenusIndex, d);
                case SkyBody.Earth: return PlanetHeliocentric(EmBaryIndex, d) - MoonGeocentricEcliptic(d) / (1.0 + EarthMoonMassRatio);
                case SkyBody.Moon:
                {
                    DVec3 moon = MoonGeocentricEcliptic(d);
                    DVec3 earth = PlanetHeliocentric(EmBaryIndex, d) - moon / (1.0 + EarthMoonMassRatio);
                    return earth + moon;
                }
                case SkyBody.Jupiter: return PlanetHeliocentric(JupiterIndex, d);
                case SkyBody.Saturn: return PlanetHeliocentric(SaturnIndex, d);
                case SkyBody.Uranus: return PlanetHeliocentric(UranusIndex, d);
                case SkyBody.Neptune: return PlanetHeliocentric(NeptuneIndex, d);
                case SkyBody.Phobos:
                case SkyBody.Deimos:
                    throw new ArgumentException(body + " orbits Mars: use MarsCentricIcrf.", nameof(body));
                default:
                    throw new ArgumentOutOfRangeException(nameof(body), body, null);
            }
        }

        /// <summary>J2000 ecliptic → ICRF (J2000 equatorial): rotation about x by +ε, as on the JPL elements page.</summary>
        public static DVec3 EclipticToIcrf(DVec3 v) =>
            new DVec3(v.X, CosObliquity * v.Y - SinObliquity * v.Z, SinObliquity * v.Y + CosObliquity * v.Z);

        /// <summary>
        /// Position (au, ICRF) seen from the centre of Mars, geometric (no light time). The Sun is −(Mars heliocentric).
        /// Phobos and Deimos come from their precessing mean ellipses (<see cref="SatelliteMarsCentricKm"/>), within
        /// ~0.4° of JPL Horizons. For anything near Mars use <see cref="TopocentricIcrf"/>: Phobos is ~6000 km from a
        /// surface observer but 9375 km from the centre.
        /// </summary>
        public static DVec3 MarsCentricIcrf(SkyBody body, double d)
        {
            switch (body)
            {
                case SkyBody.Sun: return -EclipticToIcrf(PlanetHeliocentric(MarsIndex, d));
                case SkyBody.Phobos:
                case SkyBody.Deimos: return SatelliteMarsCentricKm(body, d) / AuKm;
                default: return EclipticToIcrf(HeliocentricEcliptic(body, d) - PlanetHeliocentric(MarsIndex, d));
            }
        }

        /// <summary>
        /// Position (au, ICRF) seen from an observer on Mars: <see cref="MarsCentricIcrf"/> minus the observer's offset
        /// from the centre (<see cref="ObserverIcrfKm"/>, km). Parallax is up to ~21° for Phobos, ~8° for Deimos and
        /// ~0.003° for Earth at its closest; the direction of the result is what the sky shows.
        /// </summary>
        public static DVec3 TopocentricIcrf(SkyBody body, double d, DVec3 observerIcrfKm) =>
            MarsCentricIcrf(body, d) - observerIcrfKm / AuKm;

        // ---------------------------------------------------------------------------- Mars orientation (NAIF pck00010)

        /// <summary>
        /// Mars north pole (unit vector, ICRF): α0 = 317.68143 − 0.1061 T, δ0 = 52.88650 − 0.0609 T (degrees, T = Julian
        /// centuries TT from J2000), BODY499_POLE_RA and BODY499_POLE_DEC of NASA NAIF pck00010.tpc (IAU WGCCRE 2009
        /// report values). Mars's north celestial pole lies in Cygnus,
        /// about halfway between Deneb and Alderamin (α Cephei), ~9-10° from each; it drifts ~0.1° per century.
        /// </summary>
        public static DVec3 MarsPoleIcrf(double d)
        {
            PoleRaDec(d, out double ra, out double dec);
            return UnitFromRaDec(ra, dec);
        }

        /// <summary>
        /// Mars prime-meridian angle W = 176.630 + 350.89198226 d (degrees; BODY499_PM of NASA NAIF pck00010.tpc, the
        /// IAU WGCCRE 2009 report values), wrapped to [0, 360): the
        /// angle along Mars's equator from its ascending node on the ICRF equator to the prime meridian (Airy-0).
        /// </summary>
        public static double PrimeMeridianDeg(double d) => Wrap360(176.630 + 350.89198226 * d);

        /// <summary>
        /// ICRF → Mars body-fixed rotation (proper, det +1): RotZ(W) · RotX(90 − δ0) · RotZ(90 + α0), the WGCCRE
        /// construction with passive rotations. Row 2 is the pole; row 0 the prime meridian on the equator.
        /// </summary>
        public static DMat3 IcrfToBodyFixed(double d)
        {
            PoleRaDec(d, out double ra, out double dec);
            return DMat3.RotZ(PrimeMeridianDeg(d)) * DMat3.RotX(90.0 - dec) * DMat3.RotZ(90.0 + ra);
        }

        /// <summary>
        /// Body-fixed → Unity world at planetocentric latitude <paramref name="latDeg"/> and east longitude
        /// <paramref name="eastLonDeg"/>: rows are the local east, up and north unit vectors in body-fixed coordinates,
        /// so the product is (east, up, north) = Unity (x, y, z). Improper (det −1): (east, north, up) is right-handed,
        /// Unity's (x east, y up, z north) is not.
        /// </summary>
        public static DMat3 BodyFixedToUnity(double latDeg, double eastLonDeg)
        {
            double sinLat = Math.Sin(latDeg * Deg), cosLat = Math.Cos(latDeg * Deg);
            double sinLon = Math.Sin(eastLonDeg * Deg), cosLon = Math.Cos(eastLonDeg * Deg);
            return DMat3.FromRows(
                new DVec3(-sinLon, cosLon, 0.0),                                   // east
                new DVec3(cosLat * cosLon, cosLat * sinLon, sinLat),              // up
                new DVec3(-sinLat * cosLon, -sinLat * sinLon, cosLat));           // north
        }

        /// <summary>
        /// ICRF → Unity world (x east, y up, z north) at the site: <see cref="BodyFixedToUnity"/> ·
        /// <see cref="IcrfToBodyFixed"/>. Improper (det −1): keep it a matrix (never a quaternion); its inverse is
        /// still its transpose.
        /// </summary>
        public static DMat3 IcrfToUnity(double d, double latDeg, double eastLonDeg) =>
            BodyFixedToUnity(latDeg, eastLonDeg) * IcrfToBodyFixed(d);

        /// <summary>
        /// Observer's position (km, ICRF) relative to the centre of Mars, on a sphere of <paramref name="radiusKm"/>
        /// (planetocentric latitude, as the maps): IcrfToBodyFixed(d)ᵀ · (radiusKm · up).
        /// </summary>
        public static DVec3 ObserverIcrfKm(double d, double latDeg, double eastLonDeg, double radiusKm)
        {
            double cosLat = Math.Cos(latDeg * Deg);
            var up = new DVec3(cosLat * Math.Cos(eastLonDeg * Deg), cosLat * Math.Sin(eastLonDeg * Deg), Math.Sin(latDeg * Deg));
            return IcrfToBodyFixed(d).Transpose * (radiusKm * up);
        }

        // ------------------------------------------------------------------------------------------ Sun and season

        /// <summary>
        /// Local hour angle of the Sun (degrees, (−180, 180]): 0 at local true noon, positive in the afternoon. The
        /// subsolar east longitude is atan2(y, x) of the body-fixed Sun direction and H = observer longitude − subsolar
        /// longitude. Local true solar time (hours) = 12 + H/15.
        /// </summary>
        public static double SunHourAngleDeg(double d, double eastLonDeg)
        {
            DVec3 sun = IcrfToBodyFixed(d) * MarsCentricIcrf(SkyBody.Sun, d);
            double subsolarLon = Math.Atan2(sun.Y, sun.X) / Deg;
            return Wrap180(eastLonDeg - subsolarLon);
        }

        /// <summary>
        /// Declination of the Sun relative to Mars's equator (degrees; ±25.19° at the solstices, Mars's obliquity):
        /// asin of the z of the body-fixed unit Sun vector. Planetocentric, i.e. the subsolar latitude.
        /// </summary>
        public static double SunDeclinationDeg(double d)
        {
            DVec3 sun = (IcrfToBodyFixed(d) * MarsCentricIcrf(SkyBody.Sun, d)).Normalized;
            return Math.Asin(Clamp(sun.Z, -1.0, 1.0)) / Deg;
        }

        /// <summary>
        /// TT days of the local true noon (Sun on the meridian) nearest to <paramref name="dNear"/>: d −= H/360 · sol,
        /// repeated until |H| &lt; 1e-7°. The true Sun's hour-angle rate departs from the mean one by well under 0.1%
        /// (orbit eccentricity and obliquity, i.e. the equation of time), so each step shrinks the error by over 1000×
        /// and three or four steps converge; at most 8 are taken.
        /// </summary>
        public static double LocalTrueNoon(double dNear, double eastLonDeg)
        {
            double d = dNear;
            for (int i = 0; i < 8; i++)
            {
                double h = SunHourAngleDeg(d, eastLonDeg);
                if (Math.Abs(h) < 1e-7) break;
                d -= h / 360.0 * SolDays;
            }
            return d;
        }

        /// <summary>
        /// Areocentric solar longitude Ls (degrees, [0, 360)): the Sun's longitude along Mars's orbit measured from Mars's
        /// northern spring equinox (Ls 0 spring, 90 northern summer solstice, 180 autumn, 270 winter; perihelion ~251).
        /// Built geometrically from the same models: n̂ = Mars orbit normal (from I and Ω of the JPL elements), p̂ = Mars
        /// pole, q̂ = p̂ × n̂ normalised (where the Sun crosses Mars's equator northward), ŝ = Sun direction from Mars,
        /// Ls = atan2(ŝ · (n̂ × q̂), ŝ · q̂). Sanity: it puts Ls 0 (the start of Mars years 37, 38 and 39) on 2022-12-26,
        /// 2024-11-12 and 2026-09-30.
        /// </summary>
        public static double SolarLongitudeDeg(double d)
        {
            PlanetElements mars = Planets[MarsIndex];
            double t = d / DaysPerCentury;
            double inc = (mars.I + mars.IDot * t) * Deg, node = (mars.Node + mars.NodeDot * t) * Deg;
            DVec3 orbitNormal = EclipticToIcrf(new DVec3(Math.Sin(inc) * Math.Sin(node), -Math.Sin(inc) * Math.Cos(node), Math.Cos(inc)));
            DVec3 equinox = DVec3.Cross(MarsPoleIcrf(d), orbitNormal).Normalized;
            DVec3 sun = MarsCentricIcrf(SkyBody.Sun, d).Normalized;
            double ls = Math.Atan2(DVec3.Dot(sun, DVec3.Cross(orbitNormal, equinox)), DVec3.Dot(sun, equinox)) / Deg;
            return Wrap360(ls);
        }

        // --------------------------------------------------------------------------------------------- Photometry

        // The Sun: volumetric mean radius 695700 km (JPL Horizons, body 10, physical properties; the NASA NSSDCA Sun Fact
        // Sheet gives the same) and visual magnitude V(1,0) −26.74 at 1 au (NASA NSSDCA Sun Fact Sheet,
        // https://nssdc.gsfc.nasa.gov/planetary/factsheet/sunfact.html).
        const double SunRadiusKm = 695700.0;
        const double SunMagnitudeAt1Au = -26.74;

        /// <summary>
        /// Rough visual magnitude (V) seen by the observer, with the phase angle (Sun-body-observer, degrees) and the
        /// angular radius (radians, from the volumetric mean radius). m = H + 5 log10(r Δ) − 2.5 log10(q(α)):
        /// r = heliocentric distance (au; Mars's for its moons), Δ = distance from the observer (au),
        /// q = ((π − α) cos α + sin α)/π the Lambert-sphere phase law (clamped ≥ 1e-4; the standard diffuse-sphere
        /// formula, a modelling choice). H = V(1,0) from JPL (see <c>AbsoluteMagnitude</c>). An estimate good to about
        /// ±0.5 mag: real phase curves (Mercury, Venus), Saturn's rings and the moons' opposition surge are not modelled.
        /// Sun: −26.74 + 5 log10(r), phase 0. What this model gives from Gale, 2024-2030 (estimates, not observations):
        /// Venus up to −3.6, Jupiter −3.1, Earth −2.3, Saturn +0.4; Deimos about −5; Phobos high and nearly full about −9,
        /// a 12-13 arcmin disc.
        /// </summary>
        public static double ApparentMagnitude(SkyBody body, double d, DVec3 observerIcrfKm,
            out double phaseAngleDeg, out double angularRadiusRad)
        {
            DVec3 marsHelio = EclipticToIcrf(PlanetHeliocentric(MarsIndex, d));
            DVec3 fromMars = MarsCentricIcrf(body, d);
            DVec3 toBody = fromMars - observerIcrfKm / AuKm;
            double delta = Math.Max(toBody.Length, 1e-12);
            angularRadiusRad = Math.Asin(Math.Min(1.0, RadiusKm(body) / (delta * AuKm)));

            if (body == SkyBody.Sun)
            {
                phaseAngleDeg = 0.0;
                return SunMagnitudeAt1Au + 5.0 * Math.Log10(delta);
            }

            DVec3 bodyHelio = marsHelio + fromMars;
            bool moonOfMars = body == SkyBody.Phobos || body == SkyBody.Deimos;
            double r = moonOfMars ? marsHelio.Length : bodyHelio.Length;
            // Phase angle between body → Sun (−bodyHelio) and body → observer (−toBody).
            double cosPhase = DVec3.Dot(bodyHelio, toBody) / (Math.Max(bodyHelio.Length, 1e-12) * delta);
            double alpha = Math.Acos(Clamp(cosPhase, -1.0, 1.0));
            phaseAngleDeg = alpha / Deg;
            double q = Math.Max(((Math.PI - alpha) * Math.Cos(alpha) + Math.Sin(alpha)) / Math.PI, 1e-4);
            return AbsoluteMagnitude(body) + 5.0 * Math.Log10(r * delta) - 2.5 * Math.Log10(q);
        }

        /// <summary>
        /// True when Phobos or Deimos is inside Mars's shadow, modelled as a cylinder of radius
        /// <see cref="MarsRadiusKm"/> behind Mars (an approximation: the true umbra narrows by only ~1% at Phobos's
        /// distance and ~2% at Deimos's, and the penumbra is ignored). Phobos's orbit lies within ~1° of Mars's equator
        /// and at its distance the shadow is ~21° in radius seen from Mars's centre, so whenever the Sun is within ~20° of
        /// the equator (Ls within ~50° of an equinox, over half the Mars year) Phobos is eclipsed on every orbit: a dark
        /// Phobos is a common sight in Gale's night sky. At Deimos the shadow is only ~8° in radius, so Deimos is
        /// eclipsed only near the equinoxes. False for other bodies.
        /// </summary>
        public static bool InMarsShadow(SkyBody body, double d)
        {
            if (body != SkyBody.Phobos && body != SkyBody.Deimos) return false;
            DVec3 sun = MarsCentricIcrf(SkyBody.Sun, d).Normalized;
            DVec3 r = SatelliteMarsCentricKm(body, d);
            double along = DVec3.Dot(r, sun);
            return along < 0.0 && (r - along * sun).Length < MarsRadiusKm;
        }

        /// <summary>English display name ("Sun", "Mercury", ..., "Phobos", "Deimos"); no allocation.</summary>
        public static string DisplayName(SkyBody body)
        {
            switch (body)
            {
                case SkyBody.Sun: return "Sun";
                case SkyBody.Mercury: return "Mercury";
                case SkyBody.Venus: return "Venus";
                case SkyBody.Earth: return "Earth";
                case SkyBody.Moon: return "Moon";
                case SkyBody.Jupiter: return "Jupiter";
                case SkyBody.Saturn: return "Saturn";
                case SkyBody.Uranus: return "Uranus";
                case SkyBody.Neptune: return "Neptune";
                case SkyBody.Phobos: return "Phobos";
                case SkyBody.Deimos: return "Deimos";
                default: return body.ToString();
            }
        }

        // Mean radii (km, radius of the sphere of equal volume), as published: planets from the JPL SSD planetary physical
        // parameters (https://ssd.jpl.nasa.gov/planets/phys_par.html , "Mean Radius"), the Moon, Phobos and Deimos from
        // the JPL SSD planetary satellite physical parameters (https://ssd.jpl.nasa.gov/sats/phys_par/), the Sun above.
        // Phobos and Deimos are irregular: JPL Horizons quotes their triaxial radii (13.1 × 11.1 × 9.3 km and
        // 7.8 × 6.0 × 5.1 km) and its angular diameters run ~15-20% above the ones from these mean radii.
        static double RadiusKm(SkyBody body)
        {
            switch (body)
            {
                case SkyBody.Sun: return SunRadiusKm;
                case SkyBody.Mercury: return 2439.4;
                case SkyBody.Venus: return 6051.8;
                case SkyBody.Earth: return 6371.0084;
                case SkyBody.Moon: return 1737.4;
                case SkyBody.Jupiter: return 69911.0;
                case SkyBody.Saturn: return 58232.0;
                case SkyBody.Uranus: return 25362.0;
                case SkyBody.Neptune: return 24622.0;
                case SkyBody.Phobos: return 11.08;
                case SkyBody.Deimos: return 6.2;
                default: throw new ArgumentOutOfRangeException(nameof(body), body, null);
            }
        }

        // Absolute magnitudes V(1,0) (V at 1 au from both the Sun and the observer, phase 0), as published by NASA JPL:
        // - planets: the "V(1,0)" column of the JPL SSD planetary physical parameters,
        //   https://ssd.jpl.nasa.gov/planets/phys_par.html ;
        // - Moon +0.21, Phobos +11.8, Deimos +12.89: the "V(1,0)" of the JPL Horizons physical-data headers of bodies 301,
        //   401 and 402 (the JPL SSD satellite physical parameters page lists no magnitudes or albedos).
        // Cross-check with the standard diameter-albedo-H relation, H = 5 log10(1329 km / (D √p)), the mean radii above and
        // the geometric albedos of the same Horizons headers (Moon 0.12, Phobos 0.06, Deimos 0.06): 0.21, 11.94 and 13.21.
        // The moons' 0.1-0.3 mag gap (albedos given to one digit) is well inside this model's ±0.5 mag.
        static double AbsoluteMagnitude(SkyBody body)
        {
            switch (body)
            {
                case SkyBody.Mercury: return -0.60;
                case SkyBody.Venus: return -4.47;
                case SkyBody.Earth: return -3.86;
                case SkyBody.Moon: return 0.21;
                case SkyBody.Jupiter: return -9.40;
                case SkyBody.Saturn: return -8.88;
                case SkyBody.Uranus: return -7.19;
                case SkyBody.Neptune: return -6.87;
                case SkyBody.Phobos: return 11.8;
                case SkyBody.Deimos: return 12.89;
                default: throw new ArgumentOutOfRangeException(nameof(body), body, null);
            }
        }

        // ------------------------------------------------------------------------------- Moon, Phobos and Deimos

        // Each moon is a uniformly precessing ellipse in its reference plane (JPL: such mean elements "are not intended
        // for ephemeris computation"; they are good enough for a sky picture).
        // Epoch elements, as published: JPL SSD planetary satellite mean elements, https://ssd.jpl.nasa.gov/sats/elem/
        // (epoch 2000-01-01.5 TDB = d 0). Phobos and Deimos (ephemeris MAR099), referred to their local Laplace planes:
        //            a (km)   e      ω (deg)  M (deg)  i (deg)  Ω (deg)  P apsis (yr)  P node (yr)  Laplace pole RA, Dec
        //   Phobos   9375.    0.015  216.3    189.7    1.1      169.2    1.1           2.3          317.7, 52.9
        //   Deimos   23457.   0.000    0.0    205.0    1.8       54.3    (none)        56.2         316.6, 53.5
        // Ω is measured from the ascending node of the Laplace plane on the ICRF equator (JPL's column definition), ω from
        // the node along the orbit; the mean longitude is λ = Ω + ω + M.
        // Rates: that table rounds its periods to 2-5 digits, far too coarse to carry 27 years. With P apsis 1.1 and
        // P node 2.3 yr Phobos strays up to 3.8° (and 280 km in radius) from JPL Horizons over 2000-2035, mostly because
        // its perigee (e = 0.015, a ±1.7° swing in longitude) drifts to the wrong side of the orbit. So the three rates
        // below were fitted by least squares, keeping the epoch elements above, to 1163 Mars-centric ICRF vectors from
        // JPL Horizons (ephemeris mar099, 2000-01-01 to 2035-01-01 every 11 days; this project's offline check, 2026):
        //   Phobos: λ̇ 1128.8448427 °/d, ω̇ +0.871032 °/d (P apsis 1.1316 yr), Ω̇ −0.435838 °/d (P node 2.2615 yr)
        //   Deimos: λ̇  285.1619148 °/d, ω̇ 0 (circular),                      Ω̇ −0.018089 °/d (P node 54.49 yr)
        // λ̇ is the sidereal rate (one turn relative to the stars: 360/λ̇ = 0.318910 d and 1.262441 d, the JPL table's
        // P rounded to 0.3187 and 1.2625 d), so the mean anomaly advances at λ̇ − ω̇ − Ω̇. Phobos's tidal secular
        // acceleration is absorbed into the fitted mean rate over that span. Residuals against Horizons over 2000-2035,
        // seen from Mars's centre: Phobos 0.17° mean, 0.43° max, 3 km in radius; Deimos 0.20° mean, 0.41° max. Good for
        // the sky and for which sols Phobos crosses the Sun, not for timing an eclipse to the minute.
        readonly struct SatelliteElements
        {
            public readonly double A, E, ArgPeri0, M0, I, Node0, ArgPeriRate, NodeRate, MeanAnomalyRate;
            public readonly DVec3 LaplaceX, LaplaceY, LaplaceZ;

            public SatelliteElements(double aKm, double e, double argPeriDeg, double meanAnomalyDeg, double incDeg,
                double nodeDeg, double meanLongitudeRate, double argPeriRate, double nodeRate, double poleRaDeg, double poleDecDeg)
            {
                A = aKm;
                E = e;
                ArgPeri0 = argPeriDeg;
                M0 = meanAnomalyDeg;
                I = incDeg;
                Node0 = nodeDeg;
                ArgPeriRate = argPeriRate;
                NodeRate = nodeRate;
                MeanAnomalyRate = meanLongitudeRate - argPeriRate - nodeRate;
                // Reference-plane frame (Laplace plane, or the ecliptic for the Moon): z = the plane's pole, x = its
                // ascending node on the ICRF equator (JPL measures the node from there), y = z × x.
                LaplaceZ = UnitFromRaDec(poleRaDeg, poleDecDeg);
                LaplaceX = DVec3.Cross(new DVec3(0.0, 0.0, 1.0), LaplaceZ).Normalized;
                LaplaceY = DVec3.Cross(LaplaceZ, LaplaceX);
            }
        }

        static readonly SatelliteElements PhobosElements =
            new SatelliteElements(9375.0, 0.015, 216.3, 189.7, 1.1, 169.2, 1128.8448427, 0.871032, -0.435838, 317.7, 52.9);
        static readonly SatelliteElements DeimosElements =
            new SatelliteElements(23457.0, 0.000, 0.0, 205.0, 1.8, 54.3, 285.1619148, 0.0, -0.018089, 316.6, 53.5);

        // The Moon (Earth's satellite, ephemeris DE405/LE405), same JPL table, referred to the ecliptic:
        //            a (km)   e       ω (deg)  M (deg)  i (deg)  Ω (deg)  P (d)    P apsis (yr)  P node (yr)
        //   Moon     384400.  0.0554  318.15   135.27   5.16     125.08   27.322   5.997         18.600
        // Used exactly as published: λ̇ = 360/P (P is the sidereal period), the argument of perigee advancing once per
        // P apsis and the node regressing once per P node (Julian years of 365.25 d), so the mean anomaly advances at
        // λ̇ − ω̇ − Ω̇ = 13.0647 °/d (as for Phobos and Deimos above). The table's "ecliptic" is taken as the J2000
        // ecliptic (pole at RA 270°, Dec 90° − ε; its node on the ICRF equator is the equinox), so the in-plane
        // coordinates are J2000 ecliptic ones; were it the ecliptic of date, the difference (precession, ~0.014° a year
        // in longitude) would not show from Mars.
        // How good (this project's offline check against JPL Horizons DE441, 2000-2027 every 97 d, 102 epochs): the mean
        // ellipse leaves out the Sun's perturbations of the lunar orbit (the largest move the Moon by over a degree), so
        // the geocentric Moon errs by 1.0° on average and 3.9° at most in direction, and by up to 6800 km in distance.
        // Seen from Mars, where the Earth-Moon pair spans at most 0.41° (2000-2030), that shifts the Moon-Earth
        // separation by at most 0.016°. Its geocentric distance stays within a(1 ± e) = 363100-405700 km (the real Moon
        // ranges over ~356000-407000 km).
        static readonly SatelliteElements MoonElements =
            new SatelliteElements(384400.0, 0.0554, 318.15, 135.27, 5.16, 125.08, 360.0 / 27.322,
                360.0 / (5.997 * DaysPerJulianYear), -360.0 / (18.600 * DaysPerJulianYear), 270.0, 90.0 - ObliquityJ2000Deg);

        /// <summary>
        /// Position on a satellite's precessing mean ellipse (km), in its reference-plane frame (x = the plane's node on
        /// the ICRF equator, z = the plane's pole): node, argument of periapsis and mean anomaly advanced linearly from
        /// the epoch.
        /// </summary>
        static DVec3 MeanEllipseInPlane(in SatelliteElements s, double d) =>
            OrbitPosition(s.A, s.E, s.I, s.Node0 + s.NodeRate * d, s.ArgPeri0 + s.ArgPeriRate * d, s.M0 + s.MeanAnomalyRate * d);

        /// <summary>Phobos or Deimos relative to the centre of Mars (km, ICRF), from the precessing mean ellipse above.</summary>
        static DVec3 SatelliteMarsCentricKm(SkyBody body, double d)
        {
            SatelliteElements s = body == SkyBody.Phobos ? PhobosElements : DeimosElements;
            DVec3 p = MeanEllipseInPlane(s, d);
            return s.LaplaceX * p.X + s.LaplaceY * p.Y + s.LaplaceZ * p.Z;
        }

        /// <summary>
        /// Geocentric Moon (au, J2000 ecliptic) from the JPL mean lunar ellipse (<see cref="MoonElements"/>); its
        /// reference plane is the J2000 ecliptic, so no rotation is needed.
        /// </summary>
        static DVec3 MoonGeocentricEcliptic(double d) => MeanEllipseInPlane(MoonElements, d) / AuKm;

        // ------------------------------------------------------------------------------------------------ Helpers

        static DVec3 PlanetHeliocentric(int index, double d)
        {
            PlanetElements p = Planets[index];
            double t = d / DaysPerCentury;
            double peri = p.Peri + p.PeriDot * t, node = p.Node + p.NodeDot * t;
            return OrbitPosition(p.A + p.ADot * t, p.E + p.EDot * t, p.I + p.IDot * t, node, peri - node,
                p.L + p.LDot * t - peri);
        }

        /// <summary>
        /// Position on a Keplerian ellipse in its reference frame, by the JPL page's procedure: M wrapped to ±180°,
        /// Kepler's equation by Newton (|ΔE| &lt; 1e-12 rad), x' = a(cos E − e), y' = a √(1 − e²) sin E, then
        /// Rz(−Ω) Rx(−I) Rz(−ω).
        /// </summary>
        static DVec3 OrbitPosition(double a, double e, double incDeg, double nodeDeg, double argPeriDeg, double meanAnomalyDeg)
        {
            double m = Wrap180(meanAnomalyDeg) * Deg;
            double ecc = m + e * Math.Sin(m);
            for (int i = 0; i < 30; i++)
            {
                double step = (ecc - e * Math.Sin(ecc) - m) / (1.0 - e * Math.Cos(ecc));
                ecc -= step;
                if (Math.Abs(step) < 1e-12) break;
            }
            double xp = a * (Math.Cos(ecc) - e), yp = a * Math.Sqrt(1.0 - e * e) * Math.Sin(ecc);
            double cw = Math.Cos(argPeriDeg * Deg), sw = Math.Sin(argPeriDeg * Deg);
            double cn = Math.Cos(nodeDeg * Deg), sn = Math.Sin(nodeDeg * Deg);
            double ci = Math.Cos(incDeg * Deg), si = Math.Sin(incDeg * Deg);
            return new DVec3(
                (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
                (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
                sw * si * xp + cw * si * yp);
        }

        static void PoleRaDec(double d, out double raDeg, out double decDeg)
        {
            double t = d / DaysPerCentury;
            raDeg = 317.68143 - 0.1061 * t;
            decDeg = 52.88650 - 0.0609 * t;
        }

        static DVec3 UnitFromRaDec(double raDeg, double decDeg)
        {
            double cosDec = Math.Cos(decDeg * Deg);
            return new DVec3(cosDec * Math.Cos(raDeg * Deg), cosDec * Math.Sin(raDeg * Deg), Math.Sin(decDeg * Deg));
        }

        static double Clamp(double x, double lo, double hi) => x < lo ? lo : (x > hi ? hi : x);

        /// <summary>Wraps to [0, 360).</summary>
        static double Wrap360(double deg)
        {
            double w = deg - 360.0 * Math.Floor(deg / 360.0);
            return w >= 360.0 ? 0.0 : w;
        }

        /// <summary>Wraps to (−180, 180].</summary>
        static double Wrap180(double deg)
        {
            double w = Wrap360(deg);
            return w > 180.0 ? w - 360.0 : w;
        }
    }
}

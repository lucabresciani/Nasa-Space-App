using System;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// The linear lat/lon to world mapping of the scene, copied from MarsGeoReference so the logic can run without Unity:
    /// X = swX + (lon - swLon) * metersPerDegree * eastScale, Z = swZ + (lat - swLat) * metersPerDegree.
    /// World frame: +X east, +Z north, metres.
    /// </summary>
    public readonly struct SceneGeo
    {
        public readonly double SwLat, SwLon, MetersPerDegree, EastScale, SwX, SwZ;

        public SceneGeo(double swLat, double swLon, double metersPerDegree, double eastScale, double swX, double swZ)
        {
            SwLat = swLat;
            SwLon = swLon;
            MetersPerDegree = metersPerDegree;
            EastScale = eastScale;
            SwX = swX;
            SwZ = swZ;
        }

        public void World(double lat, double lon, out double x, out double z)
        {
            x = SwX + (lon - SwLon) * MetersPerDegree * EastScale;
            z = SwZ + (lat - SwLat) * MetersPerDegree;
        }

        public void LatLon(double x, double z, out double lat, out double lon)
        {
            lat = SwLat + (z - SwZ) / MetersPerDegree;
            lon = SwLon + (x - SwX) / (MetersPerDegree * EastScale);
        }
    }

    /// <summary>
    /// Converts between the pad-local metres of a bundle (x east, y north; contracts/bundle/README.md), Mars lon/lat
    /// (through the equirectangular analysis projection of the planner, stated in index.json) and the Unity world
    /// (Unity position = (x, z, y) = (east, up, north) after the lat/lon mapping of the scene).
    /// All in double precision; heights are handled by the caller (terrain sampling).
    /// </summary>
    public sealed class PadFrame
    {
        const double Deg2Rad = Math.PI / 180.0;

        public readonly BundleFrame Frame;
        public readonly SceneGeo Scene;
        readonly double cosTs;

        public PadFrame(BundleFrame frame, SceneGeo scene)
        {
            Frame = frame;
            Scene = scene;
            cosTs = Math.Cos(frame.LatTsDeg * Deg2Rad);
        }

        public void LocalToLonLat(double x, double y, out double lon, out double lat)
        {
            lon = Frame.Lon0Deg + (x + Frame.PadProjX) / (Frame.RadiusM * cosTs) / Deg2Rad;
            lat = (y + Frame.PadProjY) / Frame.RadiusM / Deg2Rad;
        }

        public void LonLatToLocal(double lon, double lat, out double x, out double y)
        {
            x = Frame.RadiusM * (lon - Frame.Lon0Deg) * Deg2Rad * cosTs - Frame.PadProjX;
            y = Frame.RadiusM * lat * Deg2Rad - Frame.PadProjY;
        }

        /// <summary>Pad-local (x east, y north) to Unity world X (east) and Z (north).</summary>
        public void LocalToWorld(double x, double y, out double worldX, out double worldZ)
        {
            double lon, lat;
            LocalToLonLat(x, y, out lon, out lat);
            Scene.World(lat, lon, out worldX, out worldZ);
        }

        /// <summary>Unity world X, Z to pad-local (x east, y north).</summary>
        public void WorldToLocal(double worldX, double worldZ, out double x, out double y)
        {
            double lat, lon;
            Scene.LatLon(worldX, worldZ, out lat, out lon);
            LonLatToLocal(lon, lat, out x, out y);
        }

        /// <summary>
        /// A planner bearing (degrees clockwise from north) as a Unity yaw: a rotation of b degrees about +Y starting
        /// from +Z. The two frames differ only by parts per million in scale, so the angle is unchanged.
        /// </summary>
        public static double BearingToYaw(double bearingDeg)
        {
            return bearingDeg;
        }
    }
}

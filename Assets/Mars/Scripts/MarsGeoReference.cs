using UnityEngine;

namespace NasaSpaceApp
{
    /// <summary>
    /// Ties the scene to real Mars coordinates (Gale crater, Mount Sharp; USGS MSL Gale DEM/ortho, sphere R = 3396190 m,
    /// equirectangular, centre longitude 0). Lives on the "Mars Terrain" GameObject, configured by
    /// Tools > Mars > Build Mars Landscape Scene / Apply Mount Sharp Terrain.
    ///
    /// World frame: origin = spawn point, +X = east, +Z = north, metres. The terrain heights are stored with the
    /// planet's curvature drop r²/2R already subtracted (r = ground distance from the spawn), so the horizon behaves
    /// like on a 3390 km planet; <see cref="ElevationMOLA"/> adds it back.
    /// </summary>
    [DisallowMultipleComponent]
    public class MarsGeoReference : MonoBehaviour
    {
        [SerializeField, Tooltip("MOLA elevation (m) of world y = 0 at the spawn point.")] float datumElevation;
        [SerializeField, Tooltip("Mars sphere radius used by the maps (m).")] float planetRadius = 3396190f;
        [SerializeField, Tooltip("Latitude of the play terrain's south-west height post (degrees, south negative).")] double swLat;
        [SerializeField, Tooltip("Longitude of the play terrain's south-west height post (degrees east).")] double swLon;
        [SerializeField, Tooltip("Projected metres per degree of the equirectangular map.")] double metersPerDegree = 59274.6975;
        [SerializeField, Tooltip("Ground metres per projected metre along east (cos of the play centre latitude).")] float eastScale = 1f;
        [SerializeField, Tooltip("World XZ of the play terrain's south-west height post.")] Vector2 playSwWorld;

        static MarsGeoReference instance;

        /// <summary>The scene's geo-reference (cached; found on demand). Null if the scene has none.</summary>
        public static MarsGeoReference Instance
        {
            get
            {
                if (instance == null) instance = FindAnyObjectByType<MarsGeoReference>();
                return instance;
            }
        }

        public float DatumElevation => datumElevation;
        public float PlanetRadius => planetRadius;
        public double SwLat => swLat;
        public double SwLon => swLon;
        public double MetersPerDegree => metersPerDegree;
        public float EastScale => eastScale;
        public Vector2 PlaySwWorld => playSwWorld;

        void OnEnable()
        {
            if (instance == null) instance = this;
        }

        void OnDisable()
        {
            if (instance == this) instance = null;
        }

        /// <summary>Editor setup; values come from Assets/Mars/Data/MountSharp/MountSharp.json.</summary>
        public void Configure(float datumElevation, float planetRadius, double swLat, double swLon, double metersPerDegree, float eastScale, Vector2 playSwWorld)
        {
            this.datumElevation = datumElevation;
            this.planetRadius = planetRadius;
            this.swLat = swLat;
            this.swLon = swLon;
            this.metersPerDegree = metersPerDegree;
            this.eastScale = eastScale;
            this.playSwWorld = playSwWorld;
        }

        /// <summary>Curvature drop (m) at ground distance r from the spawn, as baked into the terrain.</summary>
        public float CurvatureDrop(float x, float z) => (float)(((double)x * x + (double)z * z) / (2.0 * planetRadius));

        /// <summary>Real MOLA-areoid elevation (m) of a world position.</summary>
        public float ElevationMOLA(Vector3 world) => world.y + datumElevation + CurvatureDrop(world.x, world.z);

        /// <summary>World y of a real MOLA elevation at the world XZ of <paramref name="world"/> (its y is ignored).</summary>
        public float WorldY(Vector3 world, float elevationMOLA) => elevationMOLA - datumElevation - CurvatureDrop(world.x, world.z);

        /// <summary>Latitude (x, degrees, south negative) and longitude (y, degrees east) of a world position.</summary>
        public Vector2 LatLon(Vector3 world)
        {
            double lat = swLat + (world.z - playSwWorld.y) / metersPerDegree;
            double lon = swLon + (world.x - playSwWorld.x) / (eastScale * metersPerDegree);
            return new Vector2((float)lat, (float)lon);
        }

        /// <summary>World position (y = 0) of a latitude/longitude in degrees.</summary>
        public Vector3 WorldXZ(float lat, float lon) => WorldXZ((double)lat, (double)lon);

        /// <summary>Double-precision overload of <see cref="WorldXZ(float, float)"/>.</summary>
        public Vector3 WorldXZ(double lat, double lon)
        {
            double x = playSwWorld.x + (lon - swLon) * metersPerDegree * eastScale;
            double z = playSwWorld.y + (lat - swLat) * metersPerDegree;
            return new Vector3((float)x, 0f, (float)z);
        }
    }
}

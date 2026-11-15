using UnityEngine;

namespace NasaSpaceApp.Mission
{
    /// <summary>
    /// Lat/lon → this scene's world via <see cref="MarsGeoReference.WorldXZ(double,double)"/>; y = height of the finest
    /// terrain under the point (the HD play terrain where it exists, else the backdrop), 0 when no terrain covers it.
    /// </summary>
    public sealed class SceneMissionWorld : IMissionWorld
    {
        private readonly MarsGeoReference geo;
        private readonly Terrain[] terrains;

        public SceneMissionWorld(MarsGeoReference geo)
        {
            this.geo = geo;
            terrains = Terrain.activeTerrains;
        }

        public Vector3 ToWorld(double lat, double lon)
        {
            Vector3 p = geo.WorldXZ(lat, lon);
            Terrain t = TerrainAt(p);
            if (t != null)
            {
                p.y = t.SampleHeight(p) + t.GetPosition().y;
            }
            return p;
        }

        /// <summary>The finest (smallest) active terrain whose footprint contains the world XZ of <paramref name="p"/>.</summary>
        public Terrain TerrainAt(Vector3 p)
        {
            Terrain best = null;
            float bestArea = float.MaxValue;
            foreach (Terrain t in terrains)
            {
                if (t == null || t.terrainData == null) continue;
                Vector3 o = t.GetPosition(), size = t.terrainData.size;
                if (p.x < o.x || p.z < o.z || p.x > o.x + size.x || p.z > o.z + size.z) continue;
                float area = size.x * size.z;
                if (area < bestArea)
                {
                    bestArea = area;
                    best = t;
                }
            }
            return best;
        }

        /// <summary>The finest terrain in the scene (the HD play terrain), null without terrain.</summary>
        public Terrain FinestTerrain()
        {
            Terrain best = null;
            float bestArea = float.MaxValue;
            foreach (Terrain t in terrains)
            {
                if (t == null || t.terrainData == null) continue;
                float area = t.terrainData.size.x * t.terrainData.size.z;
                if (area < bestArea)
                {
                    bestArea = area;
                    best = t;
                }
            }
            return best;
        }
    }
}

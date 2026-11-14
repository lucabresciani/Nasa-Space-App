using System;
using UnityEngine;

namespace NasaSpaceApp.Homeline.Sim
{
    /// <summary>
    /// Ground height of the Mars scene at a world X/Z, from the terrains themselves. The scene has a detailed play
    /// terrain (about 1 m posts) inside a coarse backdrop (about 32 m posts): the finest terrain that covers the
    /// point wins. Planner positions carry no trustworthy height for this scene (its heights are the planner's own
    /// 1 m and 8 m grids, and this scene subtracts the curvature drop), so everything the planner places is put on
    /// THIS ground.
    /// </summary>
    public sealed class GroundSampler
    {
        struct Patch
        {
            public Terrain Terrain;
            public float MinX, MinZ, MaxX, MaxZ;
            public float PostSpacing;
        }

        Patch[] patches = new Patch[0];

        public GroundSampler()
        {
            Refresh();
        }

        public int TerrainCount { get { return patches.Length; } }

        /// <summary>Re-reads the active terrains (call after a scene load).</summary>
        public void Refresh()
        {
            Terrain[] terrains = Terrain.activeTerrains;
            var list = new Patch[terrains.Length];
            int n = 0;
            for (int i = 0; i < terrains.Length; i++)
            {
                Terrain t = terrains[i];
                if (t == null || t.terrainData == null) continue;
                Vector3 origin = t.GetPosition();
                Vector3 size = t.terrainData.size;
                int posts = Mathf.Max(2, t.terrainData.heightmapResolution);
                list[n++] = new Patch
                {
                    Terrain = t,
                    MinX = origin.x,
                    MinZ = origin.z,
                    MaxX = origin.x + size.x,
                    MaxZ = origin.z + size.z,
                    PostSpacing = size.x / (posts - 1),
                };
            }
            Array.Resize(ref list, n);
            Array.Sort(list, (a, b) => a.PostSpacing.CompareTo(b.PostSpacing));
            patches = list;
        }

        /// <summary>
        /// Height of the ground at world X/Z. <paramref name="detailed"/> is true on the finest terrain (the play
        /// area); false on the coarse backdrop, where the HUD must say "coarse terrain".
        /// </summary>
        public bool TryHeight(float x, float z, out float y, out bool detailed)
        {
            for (int i = 0; i < patches.Length; i++)
            {
                Patch p = patches[i];
                if (x < p.MinX || x > p.MaxX || z < p.MinZ || z > p.MaxZ || p.Terrain == null) continue;
                y = p.Terrain.SampleHeight(new Vector3(x, 0f, z)) + p.Terrain.GetPosition().y;
                detailed = i == 0;
                return true;
            }
            y = 0f;
            detailed = false;
            return false;
        }

        /// <summary>World point on the ground at X/Z, lifted by <paramref name="lift"/> metres; y = 0 off every terrain.</summary>
        public Vector3 OnGround(double x, double z, float lift)
        {
            float y;
            bool detailed;
            TryHeight((float)x, (float)z, out y, out detailed);
            return new Vector3((float)x, y + lift, (float)z);
        }

        public bool IsDetailed(float x, float z)
        {
            float y;
            bool detailed;
            return TryHeight(x, z, out y, out detailed) && detailed;
        }

        /// <summary>
        /// Height of whatever solid surface is highest at X/Z (ground or a boulder), for a camera that must not
        /// end up inside a rock. Falls back to the terrain height when nothing is hit.
        /// </summary>
        public float SurfaceHeight(float x, float z, int layerMask)
        {
            float ground;
            bool detailed;
            if (!TryHeight(x, z, out ground, out detailed)) ground = 0f;
            RaycastHit hit;
            var from = new Vector3(x, ground + 50f, z);
            if (Physics.Raycast(from, Vector3.down, out hit, 100f, layerMask, QueryTriggerInteraction.Ignore))
                return Mathf.Max(ground, hit.point.y);
            return ground;
        }
    }
}

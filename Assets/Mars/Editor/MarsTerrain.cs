using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Generates the Mars heightmap and splatmap.
    /// World layout (origin = spawn, +Z = initial view direction): a cratered plain inside a wide basin,
    /// with terraced buttes, dark dune fields and ridged rim mountains toward the edges.
    /// </summary>
    static class MarsTerrain
    {
        public const float Size = 2048f;   // meters, square
        public const int HeightRes = 2049; // 1 m between height samples
        public const int SplatRes = 1024;  // 2 m per splat texel

        // Splat layer order (must match MarsTextures.CreateTerrainLayers).
        const int Dust = 0, Gravel = 1, Rock = 2, DarkSand = 3;

        public struct Crater
        {
            public Vector2 center;
            public float radius, floor, depth;
        }

        struct Mesa
        {
            public Vector2 center;
            public float radius, height;
            public int seed;
        }

        public class Result
        {
            public TerrainData data;
            public float minHeight; // world Y of a normalized height of 0 → place the Terrain at this Y
            public List<Crater> craters;
        }

        public static Result Generate(string assetPath, TerrainLayer[] layers, int seed)
        {
            var rng = new System.Random(seed);
            List<Crater> craters = MakeCraters(rng);
            List<Mesa> mesas = MakeMesas(rng, seed);

            int res = HeightRes;
            float step = Size / (res - 1);
            float half = Size * 0.5f;
            var h = new float[res * res];
            var dune = new float[res * res];
            var ejecta = new float[res * res];

            EditorUtility.DisplayProgressBar("Mars", "Sculpting plains, buttes and dunes…", 0.3f);
            Parallel.For(0, res, z =>
            {
                float wz = z * step - half;
                for (int x = 0; x < res; x++)
                {
                    float wx = x * step - half;
                    h[z * res + x] = BaseHeight(wx, wz, seed, mesas, out dune[z * res + x]);
                }
            });

            EditorUtility.DisplayProgressBar("Mars", "Impact craters…", 0.45f);
            foreach (Crater c in craters) StampCrater(c, h, ejecta, res, step, half, seed);

            float min = float.MaxValue, max = float.MinValue;
            foreach (float v in h) { if (v < min) min = v; if (v > max) max = v; }
            float range = Mathf.Max(1f, max - min);

            var heights = new float[res, res];
            for (int z = 0; z < res; z++)
            for (int x = 0; x < res; x++)
                heights[z, x] = (h[z * res + x] - min) / range;

            EditorUtility.DisplayProgressBar("Mars", "Painting surface layers…", 0.55f);
            float[,,] splat = Splat(h, dune, ejecta, res, step, half, seed);

            var data = AssetDatabase.LoadAssetAtPath<TerrainData>(assetPath);
            bool isNew = data == null;
            if (isNew) data = new TerrainData();
            data.heightmapResolution = res; // must be set before size
            data.size = new Vector3(Size, range, Size);
            data.SetHeights(0, 0, heights);
            data.terrainLayers = layers;
            data.alphamapResolution = SplatRes;
            data.baseMapResolution = 1024;
            data.SetAlphamaps(0, 0, splat);
            if (isNew) AssetDatabase.CreateAsset(data, assetPath);
            else EditorUtility.SetDirty(data);

            return new Result { data = data, minHeight = min, craters = craters };
        }

        // ------------------------------------------------------------------ height

        static float BaseHeight(float wx, float wz, int seed, List<Mesa> mesas, out float duneMask)
        {
            float r = Mathf.Sqrt(wx * wx + wz * wz);

            // Rolling plains + a broad regional swell.
            float h = 7f * MarsNoise.Fbm(wx / 260f, wz / 260f, 5, seed)
                    + 1.5f * MarsNoise.Fbm(wx / 45f, wz / 45f, 3, seed + 1)
                    + 10f * MarsNoise.Fbm(wx / 900f, wz / 900f, 2, seed + 2);

            // Basin rim: ridged mountains rising beyond ~650 m, with a wobbly edge.
            float wobble = 140f * MarsNoise.Fbm(wx / 500f, wz / 500f, 3, seed + 3);
            float ring = MarsNoise.SmoothStep(620f, 980f, r + wobble);
            if (ring > 0f)
            {
                float ridges = MarsNoise.Ridged(wx / 380f, wz / 380f, 7, seed + 4);
                float massif = 0.55f + 0.45f * MarsNoise.Fbm(wx / 700f, wz / 700f, 2, seed + 5);
                h += ring * (25f + 230f * ridges * massif);
            }

            // Terraced buttes (think Gale crater's sedimentary mounds).
            foreach (Mesa m in mesas)
            {
                float dx = wx - m.center.x, dz = wz - m.center.y;
                float d = Mathf.Sqrt(dx * dx + dz * dz);
                if (d > m.radius * 2.3f) continue;
                d += MarsNoise.Fbm(wx / 40f, wz / 40f, 3, m.seed) * 0.22f * m.radius;
                float t = MarsNoise.SmoothStep(m.radius, m.radius * 0.8f, d);
                const float steps = 3f;
                float ts = t * steps, ti = Mathf.Floor(ts);
                t = (ti + MarsNoise.SmoothStep(0.55f, 1f, ts - ti)) / steps;
                float skirt = MarsNoise.SmoothStep(m.radius * 2.1f, m.radius * 0.9f, d);
                float top = 1f + 0.06f * MarsNoise.Fbm(wx / 25f, wz / 25f, 3, m.seed + 1);
                h += m.height * (0.82f * t * top + 0.18f * skirt * skirt);
            }

            // Dune fields: asymmetric transverse dunes (gentle stoss, steep lee), patchy.
            duneMask = MarsNoise.SmoothStep(0.05f, 0.45f, MarsNoise.Fbm(wx / 450f + 3.1f, wz / 450f - 1.7f, 3, seed + 6)) * (1f - ring);
            if (duneMask > 0.001f)
            {
                float s = (wx * 0.86f + wz * 0.5f) / 38f + 1.3f * MarsNoise.Fbm(wx / 160f, wz / 160f, 3, seed + 7);
                float t = s - Mathf.Floor(s);
                float profile = t < 0.72f ? MarsNoise.SmoothStep(0f, 0.72f, t) : 1f - MarsNoise.SmoothStep(0.72f, 1f, t);
                float crest = 0.6f + 0.4f * MarsNoise.Fbm(wx / 90f, wz / 90f, 2, seed + 8);
                h += duneMask * profile * 5f * crest;
            }
            return h;
        }

        static List<Mesa> MakeMesas(System.Random rng, int seed)
        {
            var list = new List<Mesa>
            {
                // One butte framed in the initial view, ahead and to the right.
                new Mesa { center = new Vector2(150f, 360f), radius = 75f, height = 40f, seed = seed + 500 },
            };
            for (int i = 0; i < 5; i++)
            {
                float angle = (float)rng.NextDouble() * Mathf.PI * 2f;
                float dist = Mathf.Lerp(260f, 560f, (float)rng.NextDouble());
                list.Add(new Mesa
                {
                    center = new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * dist,
                    radius = Mathf.Lerp(45f, 120f, (float)rng.NextDouble()),
                    height = Mathf.Lerp(18f, 55f, (float)rng.NextDouble()),
                    seed = seed + 501 + i,
                });
            }
            return list;
        }

        // ------------------------------------------------------------------ craters

        /// <summary>The craters <see cref="Generate"/> stamps for this seed, without regenerating the terrain.</summary>
        public static List<Crater> Craters(int seed) => MakeCraters(new System.Random(seed));

        static List<Crater> MakeCraters(System.Random rng)
        {
            var list = new List<Crater>
            {
                new Crater { center = new Vector2(-60f, 150f), radius = 42f, floor = -0.55f, depth = 0.5f },   // in view at spawn
                new Crater { center = new Vector2(-430f, 420f), radius = 170f, floor = -0.3f, depth = 0.45f },  // old, filled basin
                new Crater { center = new Vector2(380f, -250f), radius = 95f, floor = -0.45f, depth = 0.5f },
            };
            AddRandomCraters(rng, list, count: 8, minR: 25f, maxR: 70f, maxDist: 650f);
            AddRandomCraters(rng, list, count: 60, minR: 6f, maxR: 24f, maxDist: 750f);
            AddRandomCraters(rng, list, count: 160, minR: 2.5f, maxR: 6f, maxDist: 400f);
            return list;
        }

        static void AddRandomCraters(System.Random rng, List<Crater> list, int count, float minR, float maxR, float maxDist)
        {
            int placed = 0, guard = 0;
            while (placed < count && guard++ < count * 20)
            {
                // Bias toward small radii, like real crater populations.
                float radius = Mathf.Lerp(minR, maxR, Mathf.Pow((float)rng.NextDouble(), 2f));
                float dist = Mathf.Sqrt((float)rng.NextDouble()) * maxDist;
                float angle = (float)rng.NextDouble() * Mathf.PI * 2f;
                var center = new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * dist;
                if (center.magnitude < radius * 1.8f + 8f) continue; // keep the spawn point clear
                float freshness = Mathf.Lerp(0.45f, 1f, (float)rng.NextDouble());
                list.Add(new Crater
                {
                    center = center,
                    radius = radius,
                    floor = Mathf.Lerp(-0.75f, -0.35f, (float)rng.NextDouble()),
                    depth = 0.5f * freshness,
                });
                placed++;
            }
        }

        /// <summary>Crater profile: bowl, optional flat floor and raised rim (after S. Lague's crater function).</summary>
        static void StampCrater(Crater c, float[] h, float[] ejecta, int res, float step, float half, int seed)
        {
            const float rimWidth = 0.7f, rimSteepness = 0.6f, smooth = 0.3f;
            float reach = c.radius * (1f + rimWidth + 0.6f);
            int x0 = Mathf.Max(0, Mathf.FloorToInt((c.center.x - reach + half) / step));
            int x1 = Mathf.Min(res - 1, Mathf.CeilToInt((c.center.x + reach + half) / step));
            int z0 = Mathf.Max(0, Mathf.FloorToInt((c.center.y - reach + half) / step));
            int z1 = Mathf.Min(res - 1, Mathf.CeilToInt((c.center.y + reach + half) / step));
            float noiseScale = Mathf.Max(4f, c.radius * 0.5f);
            float fresh = c.depth / 0.5f;

            for (int z = z0; z <= z1; z++)
            {
                float wz = z * step - half;
                for (int x = x0; x <= x1; x++)
                {
                    float wx = x * step - half;
                    float dx = wx - c.center.x, dz = wz - c.center.y;
                    float d = Mathf.Sqrt(dx * dx + dz * dz);
                    if (d > reach) continue;
                    d *= 1f + 0.07f * MarsNoise.Fbm(wx / noiseScale, wz / noiseScale, 2, seed + 900);
                    float xr = d / c.radius;

                    float cavity = xr * xr - 1f;
                    float rimX = Mathf.Min(xr - 1f - rimWidth, 0f);
                    float rim = rimSteepness * rimX * rimX;
                    float shape = MarsNoise.SmoothMax(cavity, c.floor, smooth);
                    shape = MarsNoise.SmoothMin(shape, rim, smooth);

                    int i = z * res + x;
                    h[i] += shape * c.radius * c.depth;
                    if (xr > 0.85f)
                        ejecta[i] = Mathf.Max(ejecta[i], MarsNoise.SmoothStep(2.2f, 1f, xr) * fresh);
                }
            }
        }

        // ------------------------------------------------------------------ splat

        static float[,,] Splat(float[] h, float[] dune, float[] ejecta, int res, float step, float half, int seed)
        {
            var splat = new float[SplatRes, SplatRes, 4];
            float texel = Size / SplatRes;
            Parallel.For(0, SplatRes, az =>
            {
                for (int ax = 0; ax < SplatRes; ax++)
                {
                    float wx = (ax + 0.5f) * texel - half, wz = (az + 0.5f) * texel - half;
                    int hx = Mathf.Clamp(Mathf.RoundToInt((wx + half) / step), 1, res - 2);
                    int hz = Mathf.Clamp(Mathf.RoundToInt((wz + half) / step), 1, res - 2);
                    int i = hz * res + hx;

                    float gx = (h[i + 1] - h[i - 1]) / (2f * step);
                    float gz = (h[i + res] - h[i - res]) / (2f * step);
                    float slope = Mathf.Atan(Mathf.Sqrt(gx * gx + gz * gz)) * Mathf.Rad2Deg;

                    float rock = MarsNoise.SmoothStep(24f, 36f, slope);
                    float gravel = MarsNoise.SmoothStep(10f, 22f, slope) * (1f - rock);
                    float patches = MarsNoise.SmoothStep(0.1f, 0.45f, MarsNoise.Fbm(wx / 35f, wz / 35f, 3, seed + 20));
                    gravel = Mathf.Max(gravel, Mathf.Max(patches * 0.8f, ejecta[i] * 0.9f) * (1f - rock));
                    float dark = MarsNoise.SmoothStep(0.15f, 0.6f, dune[i]) * (1f - rock) * (1f - 0.5f * gravel);
                    float dust = Mathf.Max(0.05f, 1f - rock - gravel - dark);

                    float sum = dust + gravel + rock + dark;
                    splat[az, ax, Dust] = dust / sum;
                    splat[az, ax, Gravel] = gravel / sum;
                    splat[az, ax, Rock] = rock / sum;
                    splat[az, ax, DarkSand] = dark / sum;
                }
            });
            return splat;
        }
    }
}

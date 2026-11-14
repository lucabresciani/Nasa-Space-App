using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Thread-safe, managed noise used by the Mars generators.
    /// "Tile" variants are periodic over the unit square so the textures tile seamlessly.
    /// </summary>
    static class MarsNoise
    {
        static readonly float[] GX = { 1f, -1f, 0f, 0f, 0.7071f, -0.7071f, 0.7071f, -0.7071f };
        static readonly float[] GY = { 0f, 0f, 1f, -1f, 0.7071f, 0.7071f, -0.7071f, -0.7071f };

        public static uint Hash(int x, int y, int seed)
        {
            unchecked
            {
                uint h = (uint)seed * 0x9E3779B9u + 0x7F4A7C15u;
                h ^= (uint)x * 0x85EBCA6Bu; h = (h << 13) | (h >> 19); h = h * 5u + 0xE6546B64u;
                h ^= (uint)y * 0xC2B2AE35u; h = (h << 13) | (h >> 19); h = h * 5u + 0xE6546B64u;
                h ^= h >> 16; h *= 0x85EBCA6Bu; h ^= h >> 13; h *= 0xC2B2AE35u; h ^= h >> 16;
                return h;
            }
        }

        public static float Hash01(int x, int y, int seed) => (Hash(x, y, seed) & 0xFFFFFF) / 16777216f;
        public static float Hash01(uint h, int salt) => (Hash((int)h, salt, 17) & 0xFFFFFF) / 16777216f;

        static int Wrap(int v, int period)
        {
            if (period <= 0) return v;
            int m = v % period;
            return m < 0 ? m + period : m;
        }

        static float Fade(float t) => t * t * t * (t * (t * 6f - 15f) + 10f);

        static float Grad(int ix, int iy, float dx, float dy, int period, int seed)
        {
            uint h = Hash(Wrap(ix, period), Wrap(iy, period), seed) & 7u;
            return GX[h] * dx + GY[h] * dy;
        }

        /// <summary>Gradient noise in roughly [-1, 1]. period &lt;= 0 means non-repeating.</summary>
        public static float Perlin(float x, float y, int seed, int period = 0)
        {
            int x0 = Mathf.FloorToInt(x), y0 = Mathf.FloorToInt(y);
            float fx = x - x0, fy = y - y0;
            float u = Fade(fx), v = Fade(fy);
            float a = Grad(x0, y0, fx, fy, period, seed);
            float b = Grad(x0 + 1, y0, fx - 1f, fy, period, seed);
            float c = Grad(x0, y0 + 1, fx, fy - 1f, period, seed);
            float d = Grad(x0 + 1, y0 + 1, fx - 1f, fy - 1f, period, seed);
            float ab = a + (b - a) * u;
            float cd = c + (d - c) * u;
            return (ab + (cd - ab) * v) * 1.4f;
        }

        /// <summary>Non-repeating fBm in roughly [-1, 1].</summary>
        public static float Fbm(float x, float y, int octaves, int seed, float gain = 0.5f)
        {
            float sum = 0f, amp = 1f, norm = 0f, f = 1f;
            for (int i = 0; i < octaves; i++)
            {
                sum += Perlin(x * f, y * f, seed + i * 131) * amp;
                norm += amp;
                amp *= gain;
                f *= 2.03f;
            }
            return sum / norm;
        }

        /// <summary>Ridged multifractal in roughly [0, 1]: sharp crests, good for mountains.</summary>
        public static float Ridged(float x, float y, int octaves, int seed)
        {
            float sum = 0f, amp = 0.5f, f = 1f, weight = 1f;
            for (int i = 0; i < octaves; i++)
            {
                float n = 1f - Mathf.Abs(Perlin(x * f, y * f, seed + i * 71));
                n *= n * weight;
                weight = Mathf.Clamp01(n * 2f);
                sum += n * amp;
                amp *= 0.5f;
                f *= 2.1f;
            }
            return sum;
        }

        /// <summary>fBm that tiles over the unit square. baseCells = noise cells across the tile.</summary>
        public static float TileFbm(float u, float v, int baseCells, int octaves, int seed, float gain = 0.5f)
        {
            float sum = 0f, amp = 1f, norm = 0f;
            int cells = baseCells;
            for (int i = 0; i < octaves; i++)
            {
                sum += Perlin(u * cells, v * cells, seed + i * 131, cells) * amp;
                norm += amp;
                amp *= gain;
                cells *= 2;
            }
            return sum / norm;
        }

        /// <summary>Cellular noise that tiles over the unit square. Distances are in cell units.</summary>
        public static void TileWorley(float u, float v, int cells, int seed, out float f1, out float f2, out uint id)
        {
            float x = u * cells, y = v * cells;
            int cx = Mathf.FloorToInt(x), cy = Mathf.FloorToInt(y);
            f1 = f2 = 9f;
            id = 0;
            for (int j = -1; j <= 1; j++)
            for (int i = -1; i <= 1; i++)
            {
                int gx = cx + i, gy = cy + j;
                int wx = Wrap(gx, cells), wy = Wrap(gy, cells);
                float px = gx + Hash01(wx, wy, seed);
                float py = gy + Hash01(wx, wy, seed + 7);
                float d = Mathf.Sqrt((px - x) * (px - x) + (py - y) * (py - y));
                if (d < f1) { f2 = f1; f1 = d; id = Hash(wx, wy, seed + 13); }
                else if (d < f2) f2 = d;
            }
        }

        public static float SmoothMin(float a, float b, float k)
        {
            float h = Mathf.Clamp01((b - a + k) / (2f * k));
            return a * h + b * (1f - h) - k * h * (1f - h);
        }

        public static float SmoothMax(float a, float b, float k) => SmoothMin(a, b, -k);

        public static float SmoothStep(float edge0, float edge1, float x)
        {
            float t = Mathf.Clamp01((x - edge0) / (edge1 - edge0));
            return t * t * (3f - 2f * t);
        }
    }
}

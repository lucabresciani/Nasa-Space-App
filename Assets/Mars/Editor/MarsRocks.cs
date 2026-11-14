using System.Collections.Generic;
using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Procedural boulder meshes: an icosphere chopped by random planes (gives flat fractured faces),
    /// roughened with noise and squashed. Vertices are split per triangle so each face gets its own
    /// planar UVs (no stretching), while normals are taken from the welded mesh to keep shading smooth.
    /// </summary>
    static class MarsRocks
    {
        public static Mesh Build(int seed, int subdivisions = 3)
        {
            var verts = new List<Vector3>();
            var tris = new List<int>();
            Icosphere(subdivisions, verts, tris);

            var rng = new System.Random(seed);
            float R() => (float)rng.NextDouble();

            // Flat bottom first, then random fracture planes.
            Cut(verts, Vector3.down, 0.35f + 0.15f * R());
            int cuts = 5 + rng.Next(6);
            for (int c = 0; c < cuts; c++)
            {
                float theta = R() * Mathf.PI * 2f;
                float y = Mathf.Lerp(-0.2f, 0.9f, R());
                float r = Mathf.Sqrt(1f - y * y);
                Cut(verts, new Vector3(r * Mathf.Cos(theta), y, r * Mathf.Sin(theta)), 0.55f + 0.35f * R());
            }

            int noiseSeed = rng.Next(1, 100000);
            var scale = new Vector3(0.8f + 0.5f * R(), 0.45f + 0.35f * R(), 0.8f + 0.5f * R());
            for (int i = 0; i < verts.Count; i++)
            {
                Vector3 v = verts[i];
                float n = Noise3(v * 1.8f, noiseSeed) * 0.12f + Noise3(v * 5f, noiseSeed + 31) * 0.035f;
                verts[i] = Vector3.Scale(v + v.normalized * n, scale);
            }

            FixWinding(verts, tris);

            var welded = new Mesh();
            welded.SetVertices(verts);
            welded.SetTriangles(tris, 0);
            welded.RecalculateNormals();
            Vector3[] smoothNormals = welded.normals;
            Object.DestroyImmediate(welded);

            int count = tris.Count;
            var pos = new Vector3[count];
            var nrm = new Vector3[count];
            var uv = new Vector2[count];
            var idx = new int[count];
            for (int t = 0; t < count; t += 3)
            {
                Vector3 a = verts[tris[t]], b = verts[tris[t + 1]], c = verts[tris[t + 2]];
                Vector3 face = Vector3.Cross(b - a, c - a);
                float ax = Mathf.Abs(face.x), ay = Mathf.Abs(face.y), az = Mathf.Abs(face.z);
                for (int k = 0; k < 3; k++)
                {
                    int src = tris[t + k];
                    Vector3 p = verts[src];
                    pos[t + k] = p;
                    nrm[t + k] = smoothNormals[src];
                    uv[t + k] = (ax >= ay && ax >= az ? new Vector2(p.z, p.y)
                               : ay >= az ? new Vector2(p.x, p.z)
                               : new Vector2(p.x, p.y)) * 0.6f;
                    idx[t + k] = t + k;
                }
            }

            var mesh = new Mesh { name = $"MarsRock_{seed}" };
            mesh.vertices = pos;
            mesh.normals = nrm;
            mesh.uv = uv;
            mesh.triangles = idx;
            mesh.RecalculateTangents();
            mesh.RecalculateBounds();
            return mesh;
        }

        static void Cut(List<Vector3> verts, Vector3 normal, float distance)
        {
            for (int i = 0; i < verts.Count; i++)
            {
                float d = Vector3.Dot(verts[i], normal);
                if (d > distance) verts[i] -= normal * (d - distance);
            }
        }

        static float Noise3(Vector3 p, int seed) =>
            (MarsNoise.Perlin(p.x, p.y, seed) + MarsNoise.Perlin(p.y, p.z, seed + 1) + MarsNoise.Perlin(p.z, p.x, seed + 2)) / 3f;

        /// <summary>Unity treats clockwise triangles as front faces; make every face point outward.</summary>
        static void FixWinding(List<Vector3> verts, List<int> tris)
        {
            for (int t = 0; t < tris.Count; t += 3)
            {
                Vector3 a = verts[tris[t]], b = verts[tris[t + 1]], c = verts[tris[t + 2]];
                Vector3 centroid = (a + b + c) / 3f;
                if (Vector3.Dot(Vector3.Cross(b - a, c - a), centroid) < 0f)
                    (tris[t + 1], tris[t + 2]) = (tris[t + 2], tris[t + 1]);
            }
        }

        static void Icosphere(int subdivisions, List<Vector3> verts, List<int> tris)
        {
            float g = (1f + Mathf.Sqrt(5f)) / 2f;
            Vector3[] baseVerts =
            {
                new(-1, g, 0), new(1, g, 0), new(-1, -g, 0), new(1, -g, 0),
                new(0, -1, g), new(0, 1, g), new(0, -1, -g), new(0, 1, -g),
                new(g, 0, -1), new(g, 0, 1), new(-g, 0, -1), new(-g, 0, 1),
            };
            foreach (Vector3 v in baseVerts) verts.Add(v.normalized);
            tris.AddRange(new[]
            {
                0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
                1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
                3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
                4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
            });

            for (int s = 0; s < subdivisions; s++)
            {
                var cache = new Dictionary<long, int>();
                var next = new List<int>(tris.Count * 4);
                for (int t = 0; t < tris.Count; t += 3)
                {
                    int a = tris[t], b = tris[t + 1], c = tris[t + 2];
                    int ab = Midpoint(a, b, verts, cache), bc = Midpoint(b, c, verts, cache), ca = Midpoint(c, a, verts, cache);
                    next.AddRange(new[] { a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca });
                }
                tris.Clear();
                tris.AddRange(next);
            }
        }

        static int Midpoint(int a, int b, List<Vector3> verts, Dictionary<long, int> cache)
        {
            long key = a < b ? ((long)a << 32) | (uint)b : ((long)b << 32) | (uint)a;
            if (cache.TryGetValue(key, out int i)) return i;
            verts.Add(((verts[a] + verts[b]) * 0.5f).normalized);
            cache[key] = verts.Count - 1;
            return verts.Count - 1;
        }
    }
}

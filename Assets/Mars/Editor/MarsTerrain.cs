using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Loads the real Mount Sharp (Gale crater) terrain prepared from NASA/USGS data in Assets/Mars/Data/MountSharp:
    /// a 4 km play area at 1 m (Murray Buttes, Vera Rubin Ridge, Glen Torridon) and a 65 km backdrop at 32 m that
    /// reaches the real summit of Mount Sharp, with a hole where the play area sits.
    ///
    /// World frame: origin = spawn, +X = east, +Z = north, y = 0 at the spawn ground. Heights are stored with the
    /// planet's curvature drop already subtracted (see MountSharp.json / MarsGeoReference).
    /// </summary>
    static class MarsTerrain
    {
        public const string DataFolder = "Assets/Mars/Data/MountSharp";
        public const string JsonPath = DataFolder + "/MountSharp.json";
        public const string PlayAssetName = "MarsTerrainData.asset";
        public const string BackdropAssetName = "MarsBackdropData.asset";

        // Splat layer order (must match MarsTextures.CreateTerrainLayers).
        public const int Dust = 0, Gravel = 1, Rock = 2, DarkSand = 3;

        public struct Crater
        {
            public Vector2 center; // world XZ, metres
            public float radius, floor, depth;
        }

        /// <summary>A real boulder mapped on HiRISE, world XZ.</summary>
        public struct RealRock
        {
            public Vector2 position;
            public float diameter, height;
        }

        // ------------------------------------------------------------------ MountSharp.json
#pragma warning disable 0649 // filled by JsonUtility

        [Serializable]
        public class GridInfo
        {
            public string heightFile;
            public int resolution;
            public float sizeX, sizeZ, minElevation, maxElevation;
            public string splatFile;
            public int splatResolution;
        }

        [Serializable]
        public class PlayInfo : GridInfo
        {
            public double swLat, swLon;
        }

        [Serializable]
        public class BackdropInfo : GridInfo
        {
            public float offsetX, offsetZ;
            public int holeX0, holeZ0, holeX1, holeZ1;
        }

        [Serializable]
        public class SpawnInfo
        {
            public float x, z, elevation, yawDeg;
            public int sol;
            public string label;
        }

        [Serializable]
        public class SummitInfo
        {
            public float x, z, elevation;
            public double lat, lon;
        }

        [Serializable]
        public class Info
        {
            public string name, credit;
            public float eastScale;
            public float planetRadius;
            public double metersPerDegree;
            public PlayInfo play;
            public BackdropInfo backdrop;
            public SpawnInfo spawn;
            public SummitInfo summit;
            public string rocksFile, cratersFile;
        }

#pragma warning restore 0649

        // ------------------------------------------------------------------ result

        public class Result
        {
            public Info info;
            public TerrainData play, backdrop;
            public Vector3 playPosition, backdropPosition; // world position of each Terrain (SW corner, y of height 0)
            public float spawnYaw;                          // degrees clockwise from +Z (north), toward the summit
            public Vector2 playSwWorld;                     // world XZ of the play SW post
            public List<Crater> craters;                    // world XZ
            public List<RealRock> rocks;                    // world XZ
            public Color32[] playSplat;                     // row 0 = south
            public int playSplatRes;

            public Rect PlayRectWorld => new Rect(playSwWorld.x, playSwWorld.y, info.play.sizeX, info.play.sizeZ);

            /// <summary>DarkSand splat weight (0..1) at a world XZ; 0 outside the play area.</summary>
            public float DarkSandWeight(Vector2 world)
            {
                if (playSplat == null) return 0f;
                float u = (world.x - playSwWorld.x) / info.play.sizeX, v = (world.y - playSwWorld.y) / info.play.sizeZ;
                if (u < 0f || v < 0f || u > 1f || v > 1f) return 0f;
                int n = playSplatRes;
                Color32 c = playSplat[Mathf.Min(n - 1, (int)(v * n)) * n + Mathf.Min(n - 1, (int)(u * n))];
                int sum = c.r + c.g + c.b + c.a;
                return sum > 0 ? c.a / (float)sum : 0f;
            }

            public string Describe() =>
                $"{info.name}: play {info.play.sizeX / 1000f:0.0}×{info.play.sizeZ / 1000f:0.0} km ({info.play.minElevation:0}..{info.play.maxElevation:0} m), " +
                $"backdrop {info.backdrop.sizeX / 1000f:0}×{info.backdrop.sizeZ / 1000f:0} km, spawn '{info.spawn.label}' (sol {info.spawn.sol}, " +
                $"{info.spawn.elevation:0} m), summit {info.summit.elevation:0} m at {Mathf.Sqrt(Sq(info.summit.x - info.spawn.x) + Sq(info.summit.z - info.spawn.z)) / 1000f:0.0} km, " +
                $"{rocks.Count} mapped boulders, {craters.Count} craters";
        }

        static float Sq(float v) => v * v;

        // ------------------------------------------------------------------ loading

        public static Info LoadInfo()
        {
            string full = Path.GetFullPath(JsonPath);
            if (!File.Exists(full))
                throw new FileNotFoundException($"[Mars] Mount Sharp terrain data not found: {JsonPath}. Copy the MountSharp data folder into the project first.", full);
            Info info = JsonUtility.FromJson<Info>(File.ReadAllText(full));
            if (info == null || info.play == null || info.backdrop == null || info.spawn == null || info.summit == null)
                throw new InvalidDataException($"[Mars] {JsonPath} is missing play/backdrop/spawn/summit.");
            if (info.planetRadius <= 0f) info.planetRadius = 3396190f;
            if (info.metersPerDegree <= 0.0) info.metersPerDegree = 59274.6975;
            return info;
        }

        /// <summary>Builds or updates the play and backdrop TerrainData assets in <paramref name="folder"/>.</summary>
        public static Result Generate(string folder, TerrainLayer[] layers)
        {
            Info info = LoadInfo();
            var spawn = new Vector2(info.spawn.x, info.spawn.z);

            EditorUtility.DisplayProgressBar("Mars", "Loading Mount Sharp heights…", 0.3f);
            TerrainData play = BuildData($"{folder}/{PlayAssetName}", info.play, layers, null, out Color32[] playSplat);

            EditorUtility.DisplayProgressBar("Mars", "Loading the Gale crater backdrop…", 0.5f);
            bool[,] solid = new bool[info.backdrop.resolution - 1, info.backdrop.resolution - 1];
            for (int z = 0; z < solid.GetLength(0); z++)
            for (int x = 0; x < solid.GetLength(1); x++)
                solid[z, x] = x < info.backdrop.holeX0 || x >= info.backdrop.holeX1 || z < info.backdrop.holeZ0 || z >= info.backdrop.holeZ1;
            TerrainData backdrop = BuildData($"{folder}/{BackdropAssetName}", info.backdrop, layers, solid, out _);

            return new Result
            {
                info = info,
                play = play,
                backdrop = backdrop,
                playPosition = new Vector3(-spawn.x, info.play.minElevation - info.spawn.elevation, -spawn.y),
                backdropPosition = new Vector3(-spawn.x + info.backdrop.offsetX, info.backdrop.minElevation - info.spawn.elevation, -spawn.y + info.backdrop.offsetZ),
                spawnYaw = info.spawn.yawDeg,
                playSwWorld = -spawn,
                craters = LoadCraters(info),
                rocks = LoadRocks(info),
                playSplat = playSplat,
                playSplatRes = info.play.splatResolution,
            };
        }

        static TerrainData BuildData(string assetPath, GridInfo grid, TerrainLayer[] layers, bool[,] solid, out Color32[] splatPixels)
        {
            int res = grid.resolution;
            float[,] heights = ReadHeights($"{DataFolder}/{grid.heightFile}", res);
            float[,,] alpha = ReadSplat($"{DataFolder}/{grid.splatFile}", grid.splatResolution, out splatPixels);

            var data = AssetDatabase.LoadAssetAtPath<TerrainData>(assetPath);
            bool isNew = data == null;
            if (isNew) data = new TerrainData();
            data.heightmapResolution = res; // must be set before size
            data.size = new Vector3(grid.sizeX, Mathf.Max(1f, grid.maxElevation - grid.minElevation), grid.sizeZ);
            data.SetHeights(0, 0, heights);
            data.terrainLayers = layers;
            data.alphamapResolution = grid.splatResolution;
            data.baseMapResolution = 1024;
            data.SetAlphamaps(0, 0, alpha);
            if (solid != null) data.SetHoles(0, 0, solid);
            if (isNew) AssetDatabase.CreateAsset(data, assetPath);
            else EditorUtility.SetDirty(data);
            return data;
        }

        /// <summary>gzip of little-endian uint16, row 0 = south, column 0 = west → heights[z, x] normalized 0..1.</summary>
        static float[,] ReadHeights(string assetPath, int res)
        {
            byte[] raw;
            using (FileStream file = File.OpenRead(Path.GetFullPath(assetPath)))
            using (var gzip = new GZipStream(file, CompressionMode.Decompress))
            using (var buffer = new MemoryStream(res * res * 2))
            {
                gzip.CopyTo(buffer);
                if (buffer.Length != (long)res * res * 2)
                    throw new InvalidDataException($"[Mars] {assetPath}: {buffer.Length} bytes, expected {res}×{res} uint16.");
                raw = buffer.GetBuffer();
            }

            var heights = new float[res, res];
            const float inv = 1f / 65535f;
            Parallel.For(0, res, z =>
            {
                int i = z * res * 2;
                for (int x = 0; x < res; x++, i += 2)
                    heights[z, x] = (raw[i] | (raw[i + 1] << 8)) * inv;
            });
            return heights;
        }

        /// <summary>
        /// RGBA weights (R Dust, G Gravel, B Bedrock, A DarkSand) → alphamap[z, x, layer].
        /// The PNG's top row is north; Texture2D.LoadImage stores it bottom-up (pixel row 0 = the PNG's last row = south),
        /// which is exactly the alphamap's z order, so pixels are read row-for-row.
        /// </summary>
        static float[,,] ReadSplat(string assetPath, int res, out Color32[] pixels)
        {
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false, true);
            try
            {
                if (!tex.LoadImage(File.ReadAllBytes(Path.GetFullPath(assetPath))))
                    throw new InvalidDataException($"[Mars] {assetPath} is not a readable PNG.");
                if (tex.width != res || tex.height != res)
                    throw new InvalidDataException($"[Mars] {assetPath} is {tex.width}×{tex.height}, expected {res}×{res}.");
                pixels = tex.GetPixels32();
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(tex);
            }

            Color32[] px = pixels;
            var alpha = new float[res, res, 4];
            Parallel.For(0, res, z =>
            {
                for (int x = 0; x < res; x++)
                {
                    Color32 c = px[z * res + x];
                    int sum = c.r + c.g + c.b + c.a;
                    if (sum == 0) { alpha[z, x, Dust] = 1f; continue; }
                    float k = 1f / sum;
                    alpha[z, x, Dust] = c.r * k;
                    alpha[z, x, Gravel] = c.g * k;
                    alpha[z, x, Rock] = c.b * k;
                    alpha[z, x, DarkSand] = c.a * k;
                }
            });
            return alpha;
        }

        // ------------------------------------------------------------------ craters and boulders

        /// <summary>
        /// The real craters mapped in the play area, world XZ. <paramref name="seed"/> is ignored (kept for
        /// MarsRockScience); empty when the Mount Sharp data is missing.
        /// </summary>
        public static List<Crater> Craters(int seed)
        {
            try
            {
                return LoadCraters(LoadInfo());
            }
            catch (Exception e) when (e is IOException || e is InvalidDataException)
            {
                Debug.LogWarning(e.Message);
                return new List<Crater>();
            }
        }

        static List<Crater> LoadCraters(Info info)
        {
            var list = new List<Crater>();
            foreach (float[] row in ReadCsv(info.cratersFile, 3))
                list.Add(new Crater
                {
                    center = new Vector2(row[0] - info.spawn.x, row[1] - info.spawn.z),
                    radius = row[2],
                    floor = -0.5f,
                    depth = 0.5f,
                });
            return list;
        }

        static List<RealRock> LoadRocks(Info info)
        {
            var list = new List<RealRock>();
            foreach (float[] row in ReadCsv(info.rocksFile, 4))
                list.Add(new RealRock
                {
                    position = new Vector2(row[0] - info.spawn.x, row[1] - info.spawn.z),
                    diameter = row[2],
                    height = row[3],
                });
            return list;
        }

        /// <summary>Numeric CSV rows with at least <paramref name="columns"/> values; skips the header and bad lines.</summary>
        static IEnumerable<float[]> ReadCsv(string fileName, int columns)
        {
            if (string.IsNullOrEmpty(fileName)) yield break;
            string full = Path.GetFullPath($"{DataFolder}/{fileName}");
            if (!File.Exists(full))
            {
                Debug.LogWarning($"[Mars] {DataFolder}/{fileName} not found; skipping.");
                yield break;
            }
            foreach (string line in File.ReadLines(full))
            {
                string[] parts = line.Split(',');
                if (parts.Length < columns) continue;
                var row = new float[columns];
                bool ok = true;
                for (int i = 0; i < columns && ok; i++)
                    ok = float.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out row[i]);
                if (ok) yield return row;
            }
        }
    }
}

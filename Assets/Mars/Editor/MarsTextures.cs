using System.IO;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Bakes tileable Mars surface textures (albedo / normal / mask) to PNG assets, and sets up the sky material.
    /// Colours are authored in sRGB.
    /// </summary>
    static class MarsTextures
    {
        public struct Surface
        {
            public float height;     // 0..1
            public Color albedo;     // sRGB
            public float smoothness; // 0..1
        }

        public delegate Surface SurfaceFn(float u, float v);

        public struct TextureSet
        {
            public Texture2D albedo, normal, mask;
        }

        static readonly Color DustColor = C(0.70f, 0.42f, 0.28f); // boulder dust coating

        // Terrain layer palette, after Curiosity Mastcam views of Gale crater (Murray Buttes to Glen Torridon).
        static readonly Color TerrainDust = C(0.69f, 0.48f, 0.31f); // ochre airfall dust, ~#B07A50
        // Murray formation, ~#9E755C: lighter-toned than the regolith in Mastcam frames, but anything paler reads as snow
        // under the Mars sun + Neutral tonemapping.
        static readonly Color Mudstone = C(0.62f, 0.46f, 0.36f);

        static Color C(float r, float g, float b) => new Color(r, g, b, 1f);

        // ------------------------------------------------------------------ terrain layers

        /// <summary>Creates the four terrain layers, in splat order: dust, gravel, bedrock, dark sand.</summary>
        public static TerrainLayer[] CreateTerrainLayers(string folder, int size, int seed)
        {
            return new[]
            {
                MakeLayer(folder, "Dust", size, tileMeters: 6f, bumpMeters: 0.02f, (u, v) => Dust(u, v, seed)),
                MakeLayer(folder, "Gravel", size, tileMeters: 4f, bumpMeters: 0.03f, (u, v) => Gravel(u, v, seed + 100)),
                MakeLayer(folder, "Bedrock", size, tileMeters: 9f, bumpMeters: 0.09f, (u, v) => MurrayBedrock(u, v, seed + 200)),
                MakeLayer(folder, "DarkSand", size, tileMeters: 5f, bumpMeters: 0.03f, (u, v) => DarkSand(u, v, seed + 300)),
            };
        }

        static TerrainLayer MakeLayer(string folder, string name, int size, float tileMeters, float bumpMeters, SurfaceFn fn)
        {
            // Normal strength: height range in meters relative to the size of a texel (central difference spans 2 texels).
            float bump = bumpMeters * size / (2f * tileMeters);
            TextureSet set = Bake(folder, name, size, bump, fn);

            string path = $"{folder}/{name}.terrainlayer";
            var layer = AssetDatabase.LoadAssetAtPath<TerrainLayer>(path);
            bool isNew = layer == null;
            if (isNew) layer = new TerrainLayer();
            layer.diffuseTexture = set.albedo;
            layer.normalMapTexture = set.normal;
            layer.maskMapTexture = set.mask;
            layer.normalScale = 1f;
            layer.tileSize = new Vector2(tileMeters, tileMeters);
            layer.tileOffset = Vector2.zero;
            layer.metallic = 0f;
            layer.smoothness = 0.15f;
            if (isNew) AssetDatabase.CreateAsset(layer, path);
            else EditorUtility.SetDirty(layer);
            return layer;
        }

        /// <summary>Surface for boulders: fine-cracked rock with little dust.</summary>
        public static TextureSet CreateRockTextures(string folder, int size, int seed)
        {
            float bump = 0.05f * size / (2f * 2f);
            return Bake(folder, "Boulder", size, bump, (u, v) => Bedrock(u, v, seed + 400, 7, 0.35f));
        }

        // ------------------------------------------------------------------ surface recipes

        static Surface Dust(float u, float v, int seed)
        {
            float broad = MarsNoise.TileFbm(u, v, 3, 5, seed);
            float patch = MarsNoise.SmoothStep(-0.15f, 0.35f, MarsNoise.TileFbm(u, v, 2, 3, seed + 40));
            // Integer coefficients keep the ripples tileable.
            float phase = (u * 23f + v * 9f) * 2f * Mathf.PI + broad * 4f;
            float ripple = Mathf.Pow(0.5f + 0.5f * Mathf.Sin(phase), 1.6f);
            float grain = MarsNoise.TileFbm(u, v, 96, 2, seed + 7);

            float h = 0.45f + 0.2f * broad + 0.25f * ripple * patch + 0.08f * grain;
            Color c = Color.Lerp(C(0.62f, 0.43f, 0.28f), C(0.80f, 0.58f, 0.40f), Mathf.Clamp01(0.5f + broad * 0.9f));
            c = Color.Lerp(c, TerrainDust, 0.4f);
            c *= 0.97f + 0.1f * grain;
            return new Surface { height = Mathf.Clamp01(h), albedo = c, smoothness = 0.1f };
        }

        static Surface Gravel(float u, float v, int seed)
        {
            Surface dust = Dust(u, v, seed + 1000);

            MarsNoise.TileWorley(u, v, 22, seed, out float f1, out _, out uint id);
            float radius = 0.18f + 0.32f * MarsNoise.Hash01(id, 1);
            float dome = MarsNoise.Hash01(id, 2) < 0.35f ? Dome(f1, radius) : 0f;

            MarsNoise.TileWorley(u, v, 64, seed + 3, out float g1, out _, out uint gid);
            float gritRadius = 0.15f + 0.25f * MarsNoise.Hash01(gid, 1);
            float grit = MarsNoise.Hash01(gid, 2) < 0.3f ? Dome(g1, gritRadius) : 0f;

            float stoneNoise = MarsNoise.TileFbm(u, v, 48, 3, seed + 9);
            Color ground = Color.Lerp(dust.albedo, Mudstone * 0.86f, 0.45f) * 0.86f;
            // Pebbles carry a dust coat in every Mastcam frame: pull them toward the ground tone, or they read as
            // a carpet of black and white discs from eye height.
            Color pebble = Color.Lerp(PebbleColor(id), ground, 0.45f) * (1f + 0.12f * stoneNoise);
            Color gritColor = Color.Lerp(PebbleColor(gid), ground, 0.55f);

            // Wide, soft rims: the dusty skirt hides the disc outline.
            float cover = MarsNoise.SmoothStep(0.05f, 0.7f, dome);
            float gritCover = MarsNoise.SmoothStep(0.05f, 0.6f, grit) * (1f - cover);
            // Mixed pebbles on dusty mudstone, ~#8C6A52 overall.
            Color c = Color.Lerp(ground, pebble, cover * 0.6f);
            c = Color.Lerp(c, gritColor, gritCover * 0.35f);

            float h = 0.25f + 0.12f * dust.height + 0.55f * dome + 0.2f * grit * (1f - cover);
            return new Surface { height = Mathf.Clamp01(h), albedo = c, smoothness = Mathf.Lerp(0.1f, 0.18f, cover) };
        }

        static float Dome(float distance, float radius)
        {
            float x = distance / radius;
            return x >= 1f ? 0f : Mathf.Sqrt(1f - x * x);
        }

        static Color PebbleColor(uint id)
        {
            float pick = MarsNoise.Hash01(id, 3);
            Color c = pick < 0.3f ? C(0.32f, 0.29f, 0.27f)    // basalt
                    : pick < 0.6f ? C(0.50f, 0.36f, 0.27f)    // oxidised
                    : C(0.68f, 0.55f, 0.45f);                 // pale mudstone chips
            return c * (0.85f + 0.3f * MarsNoise.Hash01(id, 4));
        }

        static Surface Bedrock(float u, float v, int seed, int plates, float dustiness)
        {
            MarsNoise.TileWorley(u, v, plates, seed, out float f1, out float f2, out uint id);
            float crack = MarsNoise.SmoothStep(0f, 0.06f, f2 - f1);
            MarsNoise.TileWorley(u, v, plates * 3 - 2, seed + 5, out float s1, out float s2, out _);
            float crack2 = MarsNoise.SmoothStep(0f, 0.05f, s2 - s1);

            float rough = MarsNoise.TileFbm(u, v, 6, 6, seed + 11);
            float fine = MarsNoise.TileFbm(u, v, 64, 3, seed + 12);
            float plate = MarsNoise.Hash01(id, 1);

            float h = 0.55f + 0.18f * rough + 0.12f * (plate - 0.5f) + 0.04f * fine;
            h *= Mathf.Lerp(0.25f, 1f, crack) * Mathf.Lerp(0.7f, 1f, crack2);

            Color rock = Color.Lerp(C(0.40f, 0.26f, 0.19f), C(0.58f, 0.38f, 0.27f), plate);
            float gray = MarsNoise.SmoothStep(0.2f, 0.7f, MarsNoise.TileFbm(u, v, 4, 3, seed + 20));
            rock = Color.Lerp(rock, C(0.36f, 0.31f, 0.28f), gray * 0.5f);
            rock *= 0.92f + 0.16f * (0.5f + 0.5f * fine);

            float dustAmount = MarsNoise.SmoothStep(0.42f, 0.22f, h) * dustiness;
            Color c = Color.Lerp(rock, DustColor, dustAmount * 0.9f);
            return new Surface { height = Mathf.Clamp01(h), albedo = c, smoothness = Mathf.Lerp(0.28f, 0.1f, dustAmount) };
        }

        /// <summary>
        /// Murray formation mudstone (terrain bedrock layer): pale pinkish tan, fine horizontal laminations and a
        /// polygonal fracture network with dust-filled joints.
        /// </summary>
        static Surface MurrayBedrock(float u, float v, int seed)
        {
            MarsNoise.TileWorley(u, v, 7, seed, out float f1, out float f2, out uint id);
            float crack = MarsNoise.SmoothStep(0f, 0.045f, f2 - f1);
            MarsNoise.TileWorley(u, v, 19, seed + 5, out float s1, out float s2, out _);
            float crack2 = MarsNoise.SmoothStep(0f, 0.035f, s2 - s1);

            // Integer frequencies keep the laminae tileable; a low-frequency warp bends them gently.
            float warp = MarsNoise.TileFbm(u, v, 3, 3, seed + 7);
            float lamina = 0.5f + 0.5f * Mathf.Sin((v * 48f + u * 2f) * 2f * Mathf.PI + warp * 6f);
            float bed = 0.5f + 0.5f * Mathf.Sin(v * 11f * 2f * Mathf.PI + warp * 3f);

            float rough = MarsNoise.TileFbm(u, v, 6, 5, seed + 11);
            float fine = MarsNoise.TileFbm(u, v, 64, 3, seed + 12);
            float plate = MarsNoise.Hash01(id, 1);

            float h = 0.55f + 0.12f * rough + 0.08f * (plate - 0.5f) + 0.05f * lamina + 0.04f * bed + 0.03f * fine;
            h *= Mathf.Lerp(0.3f, 1f, crack) * Mathf.Lerp(0.75f, 1f, crack2);

            Color rock = Color.Lerp(Mudstone * 0.92f, Mudstone * 1.07f, plate * 0.6f + bed * 0.4f);
            float tint = MarsNoise.SmoothStep(0.25f, 0.75f, MarsNoise.TileFbm(u, v, 4, 3, seed + 20));
            rock = Color.Lerp(rock, C(0.52f, 0.40f, 0.35f), tint * 0.3f); // greyer, hematite-bearing patches
            rock *= 0.95f + 0.06f * lamina + 0.05f * fine;

            float dustAmount = MarsNoise.SmoothStep(0.40f, 0.22f, h);
            Color c = Color.Lerp(rock, TerrainDust, dustAmount * 0.85f) * Mathf.Lerp(0.85f, 1f, crack);
            return new Surface { height = Mathf.Clamp01(h), albedo = c, smoothness = Mathf.Lerp(0.14f, 0.08f, dustAmount) };
        }

        static Surface DarkSand(float u, float v, int seed)
        {
            float broad = MarsNoise.TileFbm(u, v, 3, 5, seed);
            float phase = (u * 17f - v * 11f) * 2f * Mathf.PI + broad * 5f;
            float ripple = Mathf.Pow(0.5f + 0.5f * Mathf.Sin(phase), 1.4f);
            float grain = MarsNoise.TileFbm(u, v, 128, 2, seed + 3);
            float patch = MarsNoise.SmoothStep(-0.1f, 0.4f, MarsNoise.TileFbm(u, v, 2, 3, seed + 9));

            float h = 0.45f + 0.15f * broad + 0.3f * ripple + 0.06f * grain;
            // Basaltic Bagnold sand, grey-brown ~#73604D: darker than the dusty plains in Mastcam frames, but not the
            // near-black it reads as when rendered darker under the orange Mars light.
            Color c = Color.Lerp(C(0.40f, 0.32f, 0.26f), C(0.50f, 0.40f, 0.32f), 0.5f + 0.5f * broad);
            c = Color.Lerp(c, C(0.55f, 0.40f, 0.29f), MarsNoise.SmoothStep(0.35f, 0.1f, ripple) * 0.45f * patch);
            c *= 0.94f + 0.12f * (0.5f + 0.5f * grain);
            return new Surface { height = Mathf.Clamp01(h), albedo = c, smoothness = 0.18f };
        }

        // ------------------------------------------------------------------ baking

        static TextureSet Bake(string folder, string name, int size, float bump, SurfaceFn fn)
        {
            int n = size * size;
            var height = new float[n];
            var albedo = new Color32[n];
            var mask = new Color32[n];

            Parallel.For(0, size, y =>
            {
                float v = (y + 0.5f) / size;
                for (int x = 0; x < size; x++)
                {
                    Surface s = fn((x + 0.5f) / size, v);
                    int i = y * size + x;
                    height[i] = s.height;
                    albedo[i] = Dither(s.albedo, x, y);
                    float ao = Mathf.Lerp(0.55f, 1f, MarsNoise.SmoothStep(0.05f, 0.6f, s.height));
                    // Mask map: R metallic, G occlusion, B height (for height blending), A smoothness.
                    mask[i] = new Color32(0, ToByte(ao), ToByte(s.height), ToByte(s.smoothness));
                }
            });

            var normal = new Color32[n];
            Parallel.For(0, size, y =>
            {
                int yUp = (y + 1) % size, yDown = (y - 1 + size) % size;
                for (int x = 0; x < size; x++)
                {
                    int xR = (x + 1) % size, xL = (x - 1 + size) % size;
                    float dx = height[y * size + xR] - height[y * size + xL];
                    float dy = height[yUp * size + x] - height[yDown * size + x];
                    Vector3 nrm = new Vector3(-dx * bump, -dy * bump, 1f).normalized;
                    normal[y * size + x] = new Color32(ToByte(nrm.x * 0.5f + 0.5f), ToByte(nrm.y * 0.5f + 0.5f), ToByte(nrm.z * 0.5f + 0.5f), 255);
                }
            });

            return new TextureSet
            {
                albedo = SavePng($"{folder}/{name}_Albedo.png", albedo, size, size, TextureKind.Color),
                normal = SavePng($"{folder}/{name}_Normal.png", normal, size, size, TextureKind.Normal),
                mask = SavePng($"{folder}/{name}_Mask.png", mask, size, size, TextureKind.Linear),
            };
        }

        // ------------------------------------------------------------------ sky

        /// <summary>
        /// Procedural sky material (NasaSpaceApp/Mars Sky). Its colours and sun position are driven at
        /// runtime by <see cref="NasaSpaceApp.DayNightCycle"/>, so the sky follows the sun through the sol.
        /// </summary>
        public static Material CreateSkyMaterial(string folder)
        {
            var mat = LoadOrCreateMaterial($"{folder}/MarsSky.mat", "NasaSpaceApp/Mars Sky");
            EditorUtility.SetDirty(mat);
            return mat;
        }

        // ------------------------------------------------------------------ helpers

        public static Texture2D CreateSoftDot(string folder, int size)
        {
            var px = new Color32[size * size];
            for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                float dx = (x + 0.5f) / size * 2f - 1f, dy = (y + 0.5f) / size * 2f - 1f;
                float a = MarsNoise.SmoothStep(1f, 0f, Mathf.Sqrt(dx * dx + dy * dy));
                px[y * size + x] = new Color32(255, 255, 255, ToByte(a * a));
            }
            return SavePng($"{folder}/SoftDot.png", px, size, size, TextureKind.Sprite);
        }

        public static Material LoadOrCreateMaterial(string path, string shaderName)
        {
            Shader shader = Shader.Find(shaderName);
            if (shader == null) throw new System.InvalidOperationException($"Shader '{shaderName}' not found.");
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(shader);
                AssetDatabase.CreateAsset(mat, path);
            }
            else if (mat.shader != shader)
            {
                mat.shader = shader;
            }
            return mat;
        }

        enum TextureKind { Color, Normal, Linear, Sprite }

        static Texture2D SavePng(string assetPath, Color32[] pixels, int width, int height, TextureKind kind)
        {
            var tex = new Texture2D(width, height, TextureFormat.RGBA32, false, kind != TextureKind.Color);
            tex.SetPixels32(pixels);
            tex.Apply(false);
            File.WriteAllBytes(Path.GetFullPath(assetPath), tex.EncodeToPNG());
            Object.DestroyImmediate(tex);

            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport);
            var importer = (TextureImporter)AssetImporter.GetAtPath(assetPath);
            importer.textureType = kind == TextureKind.Normal ? TextureImporterType.NormalMap : TextureImporterType.Default;
            importer.sRGBTexture = kind == TextureKind.Color;
            importer.alphaSource = kind == TextureKind.Linear || kind == TextureKind.Sprite
                ? TextureImporterAlphaSource.FromInput
                : TextureImporterAlphaSource.None;
            importer.alphaIsTransparency = kind == TextureKind.Sprite;
            importer.mipmapEnabled = true;
            importer.wrapModeU = TextureWrapMode.Repeat;
            importer.wrapModeV = kind == TextureKind.Sprite ? TextureWrapMode.Clamp : TextureWrapMode.Repeat;
            importer.anisoLevel = 8;
            importer.maxTextureSize = Mathf.Max(width, height);
            importer.textureCompression = TextureImporterCompression.Compressed;
            importer.SaveAndReimport();
            return AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
        }

        static byte ToByte(float v) => (byte)Mathf.Clamp(Mathf.RoundToInt(v * 255f), 0, 255);

        /// <summary>Adds ±0.5 LSB of hashed noise so 8-bit gradients don't band.</summary>
        static Color32 Dither(Color c, int x, int y)
        {
            float d = MarsNoise.Hash01(x, y, 991) - 0.5f;
            return new Color32(ToByte(c.r + d / 255f), ToByte(c.g + d / 255f), ToByte(c.b + d / 255f), 255);
        }
    }
}

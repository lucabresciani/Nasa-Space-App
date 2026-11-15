using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Keeps the HUD sprite set (Assets/Mars/UI/**.png, except the reference overlay image) on the import settings of
    /// spec §6.1: single FullRect sprites, per-folder mipmaps / filter / wrap / compression, 9-slice borders for panels.
    /// </summary>
    public sealed class HudSpriteImporter : AssetPostprocessor
    {
        /// <summary>Asset folder of the HUD art (trailing slash).</summary>
        public const string Root = "Assets/Mars/UI/";

        /// <summary>File name that is never touched (reference art, not a HUD sprite).</summary>
        public const string Excluded = "Futuristic Cyan HUD Overlay Interface.png";

        private const int MaxSize = 2048;
        private const float MipSharpenBias = -0.5f;

        // Named platforms whose overridden entries also get the folder compression (the default entry is
        // TextureImporter.textureCompression). Non-overridden entries do not affect the import and are left alone.
        private static readonly string[] OverridePlatforms = { "Standalone", "WebGL" };

        private readonly struct FolderRule
        {
            public readonly bool Mips;
            public readonly FilterMode Filter;
            public readonly TextureWrapMode Wrap;
            public readonly TextureImporterCompression Compression;
            public readonly float MipBias;

            public FolderRule(bool mips, FilterMode filter, TextureWrapMode wrap, TextureImporterCompression compression,
                              float mipBias = 0f)
            {
                Mips = mips;
                Filter = filter;
                Wrap = wrap;
                Compression = compression;
                MipBias = mipBias;
            }
        }

        /// <summary>True for a .png under <see cref="Root"/> that is not <see cref="Excluded"/>.</summary>
        public static bool IsHudSprite(string assetPath)
        {
            return !string.IsNullOrEmpty(assetPath)
                && assetPath.StartsWith(Root, StringComparison.Ordinal)
                && assetPath.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(Path.GetFileName(assetPath), Excluded, StringComparison.Ordinal);
        }

        /// <summary>
        /// Applies the §6.1 rules of the sprite's folder to <paramref name="ti"/>. Idempotent; returns true if any setting
        /// changed. Paths outside the HUD set, and files outside the known folders, are left untouched (false).
        /// </summary>
        public static bool Apply(TextureImporter ti, string path)
        {
            if (ti == null || !TryGetRule(path, out string folder, out FolderRule rule))
            {
                return false;
            }

            var before = new TextureImporterSettings();
            ti.ReadTextureSettings(before);
            var s = new TextureImporterSettings();
            before.CopyTo(s);

            float border = BorderFor(folder, path);
            s.textureType = TextureImporterType.Sprite;
            s.spriteMode = (int)SpriteImportMode.Single;
            s.spriteMeshType = SpriteMeshType.FullRect;          // required for Sliced / Filled / Tiled images
            s.spritePixelsPerUnit = 100f;
            s.spriteAlignment = (int)SpriteAlignment.Center;
            s.spritePivot = new Vector2(0.5f, 0.5f);
            s.spriteBorder = new Vector4(border, border, border, border); // (left, bottom, right, top)
            s.spriteGenerateFallbackPhysicsShape = false;
            s.alphaSource = TextureImporterAlphaSource.FromInput;
            s.alphaIsTransparency = true;
            s.sRGBTexture = true;
            s.npotScale = TextureImporterNPOTScale.None;
            s.mipmapEnabled = rule.Mips;
            s.mipMapsPreserveCoverage = false;
            s.filterMode = rule.Filter;
            s.mipmapBias = rule.MipBias;
            s.aniso = 1;
            s.wrapModeU = rule.Wrap;
            s.wrapModeV = rule.Wrap;
            s.wrapModeW = rule.Wrap;

            bool changed = false;
            if (!SameSettings(before, s))
            {
                ti.SetTextureSettings(s);
                changed = true;
            }

            if (ti.maxTextureSize != MaxSize)
            {
                ti.maxTextureSize = MaxSize;
                changed = true;
            }
            if (ti.textureCompression != rule.Compression)
            {
                ti.textureCompression = rule.Compression;
                changed = true;
            }
            for (int i = 0; i < OverridePlatforms.Length; i++)
            {
                TextureImporterPlatformSettings ps = ti.GetPlatformTextureSettings(OverridePlatforms[i]);
                if (ps != null && ps.overridden && ps.textureCompression != rule.Compression)
                {
                    ps.textureCompression = rule.Compression;
                    ti.SetPlatformTextureSettings(ps);
                    changed = true;
                }
            }
            return changed;
        }

        private void OnPreprocessTexture()
        {
            if (IsHudSprite(assetPath) && assetImporter is TextureImporter ti)
            {
                Apply(ti, assetPath);
            }
        }

        [MenuItem("Tools/Mars/HUD/Reimport HUD Sprites")]
        private static void ReimportAll()
        {
            string[] guids = AssetDatabase.FindAssets("t:Texture2D", new[] { Root.TrimEnd('/') });
            int count = 0;
            AssetDatabase.StartAssetEditing();
            try
            {
                for (int i = 0; i < guids.Length; i++)
                {
                    string path = AssetDatabase.GUIDToAssetPath(guids[i]);
                    if (!IsHudSprite(path))
                    {
                        continue;
                    }
                    // Apply up front so the new settings are also written to the .meta, then force the reimport.
                    if (AssetImporter.GetAtPath(path) is TextureImporter ti && Apply(ti, path))
                    {
                        ti.SaveAndReimport();
                    }
                    else
                    {
                        AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
                    }
                    count++;
                }
            }
            finally
            {
                AssetDatabase.StopAssetEditing();
            }
            Debug.Log($"[HUD] Reimported {count} HUD sprite(s) under {Root}");
        }

        private static bool TryGetRule(string path, out string folder, out FolderRule rule)
        {
            folder = null;
            rule = default;
            if (!IsHudSprite(path))
            {
                return false;
            }
            int slash = path.IndexOf('/', Root.Length);
            if (slash < 0)
            {
                return false; // directly under Root: no folder rule
            }
            folder = path.Substring(Root.Length, slash - Root.Length);
            switch (folder)
            {
                case "Icons":
                case "Rings":
                case "Widgets":
                    // Drawn 8-30x down-scaled: mipmaps stop the aliasing, a -0.5 bias keeps the trilinear blend from going soft.
                    rule = new FolderRule(true, FilterMode.Trilinear, TextureWrapMode.Clamp, TextureImporterCompression.Uncompressed, MipSharpenBias);
                    return true;
                case "Panels":
                case "Bars":
                    rule = new FolderRule(false, FilterMode.Bilinear, TextureWrapMode.Clamp, TextureImporterCompression.Uncompressed);
                    return true;
                case "Tiling":
                    rule = new FolderRule(false, FilterMode.Bilinear, TextureWrapMode.Repeat, TextureImporterCompression.Uncompressed);
                    return true;
                case "Overlay":
                    rule = new FolderRule(false, FilterMode.Bilinear, TextureWrapMode.Clamp, TextureImporterCompression.CompressedHQ);
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>9-slice border in source pixels (same on all four sides); 0 outside Panels.</summary>
        private static float BorderFor(string folder, string path)
        {
            if (folder != "Panels")
            {
                return 0f;
            }
            switch (Path.GetFileName(path))
            {
                case "panel_rounded_fill.png":
                case "panel_rounded_outline.png":
                    return HudTokens.PanelSpriteRadius;  // 20 = source corner radius
                case "frame_corners.png":
                    return 40f;
                case "panel_chamfer_fill.png":
                case "panel_chamfer_outline.png":
                case "panel_tab_fill.png":
                    return 32f;
                default:
                    return 0f;
            }
        }

        private static bool SameSettings(TextureImporterSettings a, TextureImporterSettings b)
        {
            return a.textureType == b.textureType
                && a.spriteMode == b.spriteMode
                && a.spriteMeshType == b.spriteMeshType
                && a.spritePixelsPerUnit == b.spritePixelsPerUnit
                && a.spriteAlignment == b.spriteAlignment
                && a.spritePivot == b.spritePivot
                && a.spriteBorder == b.spriteBorder
                && a.spriteGenerateFallbackPhysicsShape == b.spriteGenerateFallbackPhysicsShape
                && a.alphaSource == b.alphaSource
                && a.alphaIsTransparency == b.alphaIsTransparency
                && a.sRGBTexture == b.sRGBTexture
                && a.npotScale == b.npotScale
                && a.mipmapEnabled == b.mipmapEnabled
                && a.mipMapsPreserveCoverage == b.mipMapsPreserveCoverage
                && a.filterMode == b.filterMode
                && a.mipmapBias == b.mipmapBias
                && a.aniso == b.aniso
                && a.wrapModeU == b.wrapModeU
                && a.wrapModeV == b.wrapModeV
                && a.wrapModeW == b.wrapModeW;
        }
    }
}

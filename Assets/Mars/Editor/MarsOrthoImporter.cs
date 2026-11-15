using UnityEditor;
using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Import settings of the EVA map's satellite image (Resources/MarsPlayOrtho.jpg, built by
    /// Tools/ortho/build_play_ortho.py): full 4096 px (Unity's default would halve it), sRGB, mipmaps, trilinear,
    /// clamped, high-quality compression.
    /// </summary>
    public sealed class MarsOrthoImporter : AssetPostprocessor
    {
        private void OnPreprocessTexture()
        {
            if (!assetPath.EndsWith("Resources/MarsPlayOrtho.jpg", System.StringComparison.Ordinal))
            {
                return;
            }
            var ti = (TextureImporter)assetImporter;
            ti.textureType = TextureImporterType.Default;
            ti.sRGBTexture = true;
            ti.alphaSource = TextureImporterAlphaSource.None;
            ti.mipmapEnabled = true;
            ti.maxTextureSize = 4096;
            ti.textureCompression = TextureImporterCompression.CompressedHQ;
            ti.wrapMode = TextureWrapMode.Clamp;
            ti.filterMode = FilterMode.Trilinear;
            ti.anisoLevel = 4;
            ti.npotScale = TextureImporterNPOTScale.None;
        }
    }
}

using System.IO;
using UnityEditor;
using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Editor menu that loads or creates Assets/Mars/UI/Resources/HudSkin.asset, refills every reference from the
    /// HudSkin path table and logs the fields that stay unresolved.
    /// </summary>
    public static class HudSkinBuilder
    {
        /// <summary>Project path of the skin asset loaded at runtime via Resources (<see cref="HudSkin.ResourcePath"/>).</summary>
        public const string AssetPath = "Assets/Mars/UI/Resources/HudSkin.asset";

        private const string ResourcesFolder = "Assets/Mars/UI/Resources";

        /// <summary>Rebuilds the skin asset in place (keeps its GUID) and saves it.</summary>
        [MenuItem("Tools/Mars/HUD/Rebuild HUD Skin")]
        public static void Rebuild()
        {
            HudSkin skin = AssetDatabase.LoadAssetAtPath<HudSkin>(AssetPath);
            if (skin == null)
            {
                if (File.Exists(AssetPath))
                {
                    // Never overwrite a file we cannot read as a skin (e.g. broken script reference): that would change its GUID.
                    Debug.LogError($"[HUD] {AssetPath} exists but does not load as HudSkin. Fix or delete it, then rebuild.");
                    return;
                }
                EnsureFolder(ResourcesFolder);
                skin = ScriptableObject.CreateInstance<HudSkin>();
                AssetDatabase.CreateAsset(skin, AssetPath);
            }

            skin.EditorFill(true);
            EditorUtility.SetDirty(skin);
            AssetDatabase.SaveAssets();

            int missing = 0;
            using (var so = new SerializedObject(skin))
            {
                SerializedProperty p = so.GetIterator();
                bool enterChildren = true;
                while (p.NextVisible(enterChildren))
                {
                    enterChildren = false;
                    if (p.propertyType == SerializedPropertyType.ObjectReference && p.name != "m_Script"
                        && p.objectReferenceValue == null)
                    {
                        Debug.LogWarning($"[HUD] HudSkin.{p.name} is unresolved: its file under {HudSpriteImporter.Root} is missing, "
                                         + "or not imported as Sprite/Font (try Tools/Mars/HUD/Reimport HUD Sprites).", skin);
                        missing++;
                    }
                }
            }

            if (missing == 0)
            {
                Debug.Log($"[HUD] Rebuilt {AssetPath}: all references set.", skin);
            }
            else
            {
                Debug.LogWarning($"[HUD] Rebuilt {AssetPath}: {missing} reference(s) missing (runtime falls back).", skin);
            }
        }

        private static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder))
            {
                return;
            }
            int slash = folder.LastIndexOf('/');
            string parent = folder.Substring(0, slash);
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, folder.Substring(slash + 1));
        }
    }
}

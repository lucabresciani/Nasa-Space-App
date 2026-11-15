using System.IO;
using NasaSpaceApp.Mission;
using UnityEditor;
using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>Editor menu for the web Mission Planer link (<see cref="MissionLink"/>).</summary>
    public static class MissionMenu
    {
        private const string LastDirKey = "NasaSpaceApp.Mission.LastDir";

        [MenuItem("Tools/Mars/Load Mission JSON…")]
        private static void LoadMission()
        {
            if (!EditorApplication.isPlaying || MissionLink.Instance == null)
            {
                EditorUtility.DisplayDialog("Load Mission JSON",
                    "Enter play mode in the Mars scene first: the mission is placed on the running scene's terrain.", "OK");
                return;
            }
            string start = EditorPrefs.GetString(LastDirKey, DefaultDir());
            string path = EditorUtility.OpenFilePanel("Load mission.json (web Mission Planer export)", start, "json");
            if (string.IsNullOrEmpty(path))
            {
                return;
            }
            EditorPrefs.SetString(LastDirKey, Path.GetDirectoryName(path));
            if (!MissionLink.Instance.LoadFile(path))
            {
                EditorUtility.DisplayDialog("Load Mission JSON", "Not loaded:\n" + MissionLink.LastError, "OK");
            }
        }

        [MenuItem("Tools/Mars/Clear Mission")]
        private static void ClearMission()
        {
            if (MissionLink.Instance != null)
            {
                MissionLink.Instance.Clear();
            }
        }

        [MenuItem("Tools/Mars/Clear Mission", true)]
        private static bool ClearMissionValid() => EditorApplication.isPlaying && MissionLink.Current != null;

        private static string DefaultDir()
        {
            string home = System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile);
            string downloads = Path.Combine(home, "Downloads");
            return Directory.Exists(downloads) ? downloads : Application.dataPath;
        }
    }
}

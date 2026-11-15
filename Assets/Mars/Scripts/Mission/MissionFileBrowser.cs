using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace NasaSpaceApp.Mission
{
    /// <summary>One mission file found on disk, with what its header says (parsed once per path and write time).</summary>
    public sealed class MissionFileInfo
    {
        public string Path;
        public DateTime WrittenUtc;
        public bool Valid;
        public string Title;       // or the parse error when !Valid
        public string MissionId;
        public int Waypoints;
        public float EvaMin = float.NaN;
        public bool? Feasible;
    }

    /// <summary>
    /// Finds mission files for the map screen's Missions tab and opens the operating system's file dialog ("Browse…").
    /// Searched: <c>mission*.json</c> in ~/Downloads, ~/Desktop and persistentDataPath (and its <c>missions</c> folder),
    /// newest first. The dialog runs as a separate process (macOS <c>osascript</c>, Windows PowerShell, Linux
    /// <c>zenity</c>) so the game keeps running; in the editor it is Unity's own file panel. No dialog in WebGL.
    /// </summary>
    public static class MissionFileBrowser
    {
        public const int MaxListed = 24;

        private static readonly Dictionary<string, MissionFileInfo> cache = new Dictionary<string, MissionFileInfo>();

        /// <summary>Folders that are searched (existing ones only).</summary>
        public static List<string> Folders()
        {
            var list = new List<string>(5);
#if !UNITY_WEBGL || UNITY_EDITOR
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(home))
            {
                list.Add(System.IO.Path.Combine(home, "Downloads"));
                list.Add(System.IO.Path.Combine(home, "Desktop"));
            }
            list.Add(Application.persistentDataPath);
            list.Add(System.IO.Path.Combine(Application.persistentDataPath, "missions"));
#endif
            list.RemoveAll(d => !Directory.Exists(d));
            return list;
        }

        /// <summary>Mission files found, newest first (at most <see cref="MaxListed"/>).</summary>
        public static List<MissionFileInfo> Find()
        {
            var found = new List<MissionFileInfo>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (string dir in Folders())
            {
                string[] files;
                try
                {
                    files = Directory.GetFiles(dir, MissionLink.DownloadPattern, SearchOption.TopDirectoryOnly);
                }
                catch (Exception)
                {
                    continue;
                }
                foreach (string f in files)
                {
                    string full = System.IO.Path.GetFullPath(f);
                    if (seen.Add(full))
                    {
                        found.Add(Describe(full));
                    }
                }
            }
            found.Sort((a, b) => b.WrittenUtc.CompareTo(a.WrittenUtc));
            if (found.Count > MaxListed)
            {
                found.RemoveRange(MaxListed, found.Count - MaxListed);
            }
            return found;
        }

        /// <summary>Header of one file (cached until the file changes).</summary>
        public static MissionFileInfo Describe(string path)
        {
            DateTime written;
            try
            {
                written = File.GetLastWriteTimeUtc(path);
            }
            catch (Exception)
            {
                written = DateTime.MinValue;
            }
            if (cache.TryGetValue(path, out MissionFileInfo hit) && hit.WrittenUtc == written)
            {
                return hit;
            }
            var info = new MissionFileInfo { Path = path, WrittenUtc = written };
            try
            {
                MissionFile f = MissionFile.Parse(File.ReadAllText(path), out string error);
                info.Valid = f != null;
                if (f != null)
                {
                    info.Title = string.IsNullOrEmpty(f.Title) ? System.IO.Path.GetFileNameWithoutExtension(path) : f.Title;
                    info.MissionId = f.MissionId;
                    info.Waypoints = f.Waypoints.Count;
                    info.EvaMin = f.Summary.EvaMin.HasValue ? (float)f.Summary.EvaMin.Value : float.NaN;
                    info.Feasible = f.Summary.Feasible;
                }
                else
                {
                    info.Title = error;
                }
            }
            catch (Exception e)
            {
                info.Valid = false;
                info.Title = e.Message;
            }
            cache[path] = info;
            return info;
        }

        // ------------------------------------------------------------------ native "open file" dialog

        private static Process dialog;
        private static string dialogOutput;
        private static Action<string> dialogDone;

        /// <summary>True while a dialog is open.</summary>
        public static bool DialogOpen => dialog != null;

        /// <summary>
        /// Opens the system's file dialog for a .json file; <paramref name="done"/> gets the path (null when cancelled
        /// or unavailable) on the main thread from <see cref="Poll"/>. Returns false when no dialog is available.
        /// </summary>
        public static bool Browse(Action<string> done)
        {
            if (dialog != null)
            {
                return true;   // already open
            }
            string start = Folders().Count > 0 ? Folders()[0] : Application.persistentDataPath;
#if UNITY_EDITOR
            string picked = UnityEditor.EditorUtility.OpenFilePanel("Open mission.json (web Mission Planer)", start, "json");
            done?.Invoke(string.IsNullOrEmpty(picked) ? null : picked);
            return true;
#elif UNITY_WEBGL
            return false;
#else
            ProcessStartInfo psi;
            switch (Application.platform)
            {
                case RuntimePlatform.OSXPlayer:
                    string script = "POSIX path of (choose file with prompt \"Open mission.json (web Mission Planer)\" of type {\"public.json\"} "
                                    + "default location (POSIX file \"" + start.Replace("\"", "") + "\"))";
                    psi = new ProcessStartInfo("/usr/bin/osascript", "-e " + Quote(script));
                    break;
                case RuntimePlatform.WindowsPlayer:
                    psi = new ProcessStartInfo("powershell.exe",
                        "-NoProfile -STA -Command \"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; " +
                        "$d.Filter = 'Mission JSON (*.json)|*.json'; $d.InitialDirectory = '" + start.Replace("'", "''") + "'; " +
                        "if ($d.ShowDialog() -eq 'OK') { $d.FileName }\"");
                    break;
                case RuntimePlatform.LinuxPlayer:
                    psi = new ProcessStartInfo("zenity", "--file-selection --title=\"Open mission.json\" --file-filter=\"*.json\" --filename=\"" + Escape(start) + "/\"");
                    break;
                default:
                    return false;
            }
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.CreateNoWindow = true;
            try
            {
                dialogOutput = null;
                dialogDone = done;
                dialog = Process.Start(psi);
                return dialog != null;
            }
            catch (Exception e)
            {
                Debug.LogWarning("[Mission] file dialog unavailable: " + e.Message);
                dialog = null;
                return false;
            }
#endif
        }

        /// <summary>Call every frame (the map screen does): finishes a dialog that was closed.</summary>
        public static void Poll()
        {
            if (dialog == null)
            {
                return;
            }
            try
            {
                if (!dialog.HasExited)
                {
                    return;
                }
                dialogOutput = dialog.StandardOutput.ReadToEnd().Trim();
            }
            catch (Exception e)
            {
                Debug.LogWarning("[Mission] file dialog failed: " + e.Message);
                dialogOutput = null;
            }
            dialog.Dispose();
            dialog = null;
            Action<string> cb = dialogDone;
            dialogDone = null;
            cb?.Invoke(string.IsNullOrEmpty(dialogOutput) ? null : dialogOutput);
        }

        private static string Escape(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");

        // One command-line argument in double quotes (MS argument rules, also used by Mono on macOS / Linux).
        private static string Quote(string s) => "\"" + s.Replace("\"", "\\\"") + "\"";
    }
}

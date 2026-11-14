using System;
using System.Diagnostics;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace NasaSpaceApp.Homeline.EditorTools
{
    /// <summary>
    /// Builds the Windows player with an explicit scene list and window settings, then puts the planner data
    /// (HomelineData: the built web app and the simulator bundle) next to the exe.
    ///
    /// From the editor: Tools > Mars > HOMELINE > Build Windows Player.
    /// Headless, without touching an open editor (run it on a separate checkout of the project):
    ///   Unity.exe -batchmode -quit -projectPath DIR -logFile LOG
    ///             -executeMethod NasaSpaceApp.Homeline.EditorTools.HomelineBuild.Win64
    ///             [-homelineOut DIR] [-homelineExe NAME] [-homelineData DIR] [-homelineDev]
    ///
    /// The build does not rely on EditorBuildSettings (its scene list is edited by other work) and leaves
    /// ProjectSettings as it found them.
    /// </summary>
    public static class HomelineBuild
    {
        const string Scene = "Assets/Scenes/MarsLandscape.unity";
        const string DefaultExeName = "MARTIS";
        public const string DataFolderName = "HomelineData";

        [MenuItem("Tools/Mars/HOMELINE/Build Windows Player")]
        static void BuildFromMenu()
        {
            Run(false);
        }

        /// <summary>Entry point for -executeMethod. Exits the editor with code 0 on success, 1 on failure.</summary>
        public static void Win64()
        {
            int code = 1;
            try
            {
                code = Run(true) ? 0 : 1;
            }
            catch (Exception e)
            {
                Debug.LogError("[HOMELINE build] " + e);
            }
            EditorApplication.Exit(code);
        }

        static bool Run(bool batch)
        {
            string projectRoot = Directory.GetParent(Application.dataPath).FullName;
            string outDir = Arg("-homelineOut") ?? Path.Combine(projectRoot, "Builds", DefaultExeName);
            string exeName = Arg("-homelineExe") ?? DefaultExeName;
            string dataDir = Arg("-homelineData") ?? Path.Combine(projectRoot, DataFolderName);
            bool development = HasFlag("-homelineDev");

            if (!File.Exists(Path.Combine(projectRoot, Scene)))
            {
                Debug.LogError("[HOMELINE build] scene not found: " + Scene);
                return false;
            }

            var options = new BuildPlayerOptions
            {
                scenes = new[] { Scene },
                locationPathName = Path.Combine(outDir, exeName + ".exe"),
                target = BuildTarget.StandaloneWindows64,
                targetGroup = BuildTargetGroup.Standalone,
                options = development ? BuildOptions.Development : BuildOptions.None,
            };

            // Window behaviour the staged flow needs: the app keeps running behind the planner window and never
            // uses exclusive full screen (which would minimise on focus loss). Restored after the build.
            bool oldRunInBackground = PlayerSettings.runInBackground;
            bool oldVisibleInBackground = PlayerSettings.visibleInBackground;
            bool oldResizable = PlayerSettings.resizableWindow;
            FullScreenMode oldFullScreen = PlayerSettings.fullScreenMode;
            var watch = Stopwatch.StartNew();
            BuildReport report;
            try
            {
                PlayerSettings.runInBackground = true;
                PlayerSettings.visibleInBackground = true;
                PlayerSettings.resizableWindow = true;
                PlayerSettings.fullScreenMode = FullScreenMode.FullScreenWindow;
                report = BuildPipeline.BuildPlayer(options);
            }
            finally
            {
                PlayerSettings.runInBackground = oldRunInBackground;
                PlayerSettings.visibleInBackground = oldVisibleInBackground;
                PlayerSettings.resizableWindow = oldResizable;
                PlayerSettings.fullScreenMode = oldFullScreen;
            }

            BuildSummary s = report.summary;
            Debug.Log("[HOMELINE build] result " + s.result + ", " + (s.totalSize / (1024 * 1024)) + " MB, " +
                      s.totalErrors + " error(s), " + s.totalWarnings + " warning(s), " +
                      (int)watch.Elapsed.TotalSeconds + " s, output " + options.locationPathName);
            if (s.result != BuildResult.Succeeded) return false;

            if (Directory.Exists(dataDir))
            {
                string target = Path.Combine(outDir, DataFolderName);
                int code = Robocopy(dataDir, target);
                // robocopy: 0-7 = success (files copied, extras, mismatches), 8+ = failure.
                if (code >= 8)
                {
                    Debug.LogError("[HOMELINE build] copying " + DataFolderName + " failed (robocopy " + code + ")");
                    return false;
                }
                Debug.Log("[HOMELINE build] planner data copied to " + target);
            }
            else
            {
                Debug.LogWarning("[HOMELINE build] no " + DataFolderName + " folder at " + dataDir +
                                 ": the exe will start without the planner and without a plan. " +
                                 "Run Tools/homeline-data/fetch.ps1 first.");
            }

            if (!batch) EditorUtility.RevealInFinder(options.locationPathName);
            return true;
        }

        static int Robocopy(string from, string to)
        {
            var info = new ProcessStartInfo
            {
                FileName = "robocopy",
                Arguments = "\"" + from + "\" \"" + to + "\" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XF .gitignore",
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using (Process p = Process.Start(info))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }

        static string Arg(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++)
                if (args[i] == name) return args[i + 1];
            return null;
        }

        static bool HasFlag(string name)
        {
            return Array.IndexOf(Environment.GetCommandLineArgs(), name) >= 0;
        }
    }
}

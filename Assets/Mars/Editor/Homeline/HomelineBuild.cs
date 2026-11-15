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
        const string DefaultExeName = "MARVIS";
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
                IncludeRuntimeShaders();
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
                int files = CopyPlannerData(dataDir, target);
                Debug.Log("[HOMELINE build] planner data copied to " + target + " (" + files + " files)");
            }
            else
            {
                Debug.LogWarning("[HOMELINE build] no " + DataFolderName + " folder at " + dataDir +
                                 ": the exe will start without the planner and without a plan. " +
                                 "Run Tools/homeline-data/fetch.ps1 first.");
            }

            string guide = Path.Combine(projectRoot, "Docs", "homeline", "USER_GUIDE.md");
            if (File.Exists(guide)) File.Copy(guide, Path.Combine(outDir, "README.md"), true);

            if (!batch) EditorUtility.RevealInFinder(options.locationPathName);
            return true;
        }

        /// <summary>
        /// Copies only what the app reads: the plans (route, timeline, pad list, station names), the official
        /// simulator bundle and any engine-service result trees. The planner's web app itself (map tiles, 3D
        /// chunks, about 250 MB) is not used by the app and is left out.
        /// </summary>
        static int CopyPlannerData(string from, string to)
        {
            if (Directory.Exists(to)) Directory.Delete(to, true);
            int n = 0;
            string web = Path.Combine(from, "web", "data");
            if (Directory.Exists(web))
            {
                string webTo = Path.Combine(to, "web", "data");
                foreach (string pattern in new[] { "route_*.geojson", "timeline_*.json", "stations.json", "pad.json" })
                    foreach (string f in Directory.GetFiles(web, pattern))
                        n += CopyFile(f, Path.Combine(webTo, Path.GetFileName(f)));
                string pads = Path.Combine(web, "scenarios", "pads");
                if (Directory.Exists(pads))
                {
                    string padsTo = Path.Combine(webTo, "scenarios", "pads");
                    foreach (string f in Directory.GetFiles(pads, "*.json")) n += CopyFile(f, Path.Combine(padsTo, Path.GetFileName(f)));
                    foreach (string dir in Directory.GetDirectories(pads))
                        foreach (string pattern in new[] { "route_*.geojson", "timeline_*.json", "summary.json" })
                            foreach (string f in Directory.GetFiles(dir, pattern))
                                n += CopyFile(f, Path.Combine(padsTo, Path.GetFileName(dir), Path.GetFileName(f)));
                }
            }
            foreach (string sub in new[] { "bundle", "results", "router" })
            {
                string dir = Path.Combine(from, sub);
                if (!Directory.Exists(dir)) continue;
                foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                    n += CopyFile(f, Path.Combine(to, sub, f.Substring(dir.Length).TrimStart('\\', '/')));
            }
            string source = Path.Combine(from, "source.json");
            if (File.Exists(source)) n += CopyFile(source, Path.Combine(to, "source.json"));
            return n;
        }

        /// <summary>
        /// Shaders that scripts look up by name at run time (the night sky attaches itself from code) are stripped
        /// from a player unless they are in Always Included Shaders: add them before building.
        /// </summary>
        static void IncludeRuntimeShaders()
        {
            string[] paths = { "Assets/Mars/Shaders/MarsStars.shader", "Assets/Mars/Shaders/MarsConstellations.shader" };
            UnityEngine.Object[] settings = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/GraphicsSettings.asset");
            if (settings == null || settings.Length == 0) return;
            var so = new SerializedObject(settings[0]);
            SerializedProperty list = so.FindProperty("m_AlwaysIncludedShaders");
            if (list == null) return;
            int added = 0;
            foreach (string p in paths)
            {
                Shader shader = AssetDatabase.LoadAssetAtPath<Shader>(p);
                if (shader == null) continue;
                bool present = false;
                for (int i = 0; i < list.arraySize; i++)
                    if (list.GetArrayElementAtIndex(i).objectReferenceValue == shader) present = true;
                if (present) continue;
                list.InsertArrayElementAtIndex(list.arraySize);
                list.GetArrayElementAtIndex(list.arraySize - 1).objectReferenceValue = shader;
                added++;
            }
            if (added > 0)
            {
                so.ApplyModifiedPropertiesWithoutUndo();
                Debug.Log("[HOMELINE build] " + added + " run-time shader(s) added to Always Included Shaders");
            }
        }

        static int CopyFile(string from, string to)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(to));
            File.Copy(from, to, true);
            return 1;
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

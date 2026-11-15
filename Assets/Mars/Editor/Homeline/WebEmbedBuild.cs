#if UNITY_EDITOR_WIN
using System;
using System.IO;
using NasaSpaceApp.Homeline.Web;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace NasaSpaceApp.Homeline.EditorTools
{
    /// <summary>
    /// After every Windows player build, puts what the web planner needs next to the exe:
    ///   {project}/HomelineData/web             ->  {output}/MarvisPlanner   (the local copy of the planner: the offline fallback)
    ///   {project}/Tools/marvis-web/viewer/dist ->  {output}/MarvisWeb       (MarvisWeb.exe, the WebView2 window)
    ///   {project}/Tools/marvis-web/live/marvis-inject.js, planner-url.txt  ->  {output}/MarvisWeb   (the page script and
    ///                                              the address of the planner site)
    /// A missing source is a warning, not an error, and the folder of an earlier build is removed. Without the viewer
    /// the exe keeps the built-in MISSION PLAN panel; without the local copy it has no fallback when the planner site
    /// cannot be reached; without the page script it uses the local copy only. The viewer folder does not depend on
    /// the local copy. A copy that fails (a file in use in the output) fails the build.
    /// The output's HomelineData folder is never touched (HomelineBuild deletes and rebuilds it after the build).
    /// </summary>
    public sealed class WebEmbedBuild : IPostprocessBuildWithReport
    {
        public int callbackOrder
        {
            get { return 0; }
        }

        public void OnPostprocessBuild(BuildReport report)
        {
            BuildTarget target = report.summary.platform;
            if (target != BuildTarget.StandaloneWindows64 && target != BuildTarget.StandaloneWindows) return;

            string projectRoot = Directory.GetParent(Application.dataPath).FullName;
            string outDir = Path.GetDirectoryName(Path.GetFullPath(report.summary.outputPath));

            string web = Path.Combine(projectRoot, "HomelineData", "web");
            string webOut = Path.Combine(outDir, WebPlanner.WebFolderName);
            if (WebPlanner.IsValidWebRoot(web))
                Copy(web, webOut, "web app");
            else
            {
                Remove(webOut, "web app");
                Debug.LogWarning("[WebPlanner build] no web app with the MARVIS bridge at " + web + " (index.html, assets/ and " +
                                 WebPlanner.BridgeMarkerFile + "): the exe will have no local copy of the planner, so no " +
                                 "fallback when the planner site cannot be reached.");
            }

            string viewer = Path.Combine(projectRoot, WebPlanner.ViewerDevFolder);
            string viewerOut = Path.Combine(outDir, WebPlanner.ViewerFolderName);
            if (File.Exists(Path.Combine(viewer, WebPlanner.ViewerExeName)))
            {
                Copy(viewer, viewerOut, "viewer");
                string live = Path.Combine(projectRoot, WebPlanner.LiveDevFolder);
                CopyFile(live, viewerOut, WebPlanner.InjectFileName,
                         "the exe will not use the planner site, only the local copy of the planner");
                CopyFile(live, viewerOut, WebPlanner.PlannerUrlFileName,
                         "the exe will use the built-in address " + WebPlanner.DefaultPlannerUrl);
            }
            else
            {
                Remove(viewerOut, "viewer");
                Debug.LogWarning("[WebPlanner build] no " + WebPlanner.ViewerExeName + " at " + viewer +
                                 ": the exe will keep the built-in MISSION PLAN panel.");
            }
        }

        // One file of the live planner into the viewer folder (just replaced by Copy). A missing source is a warning.
        static void CopyFile(string fromDir, string toDir, string name, string otherwise)
        {
            string from = Path.Combine(fromDir, name);
            if (!File.Exists(from))
            {
                Debug.LogWarning("[WebPlanner build] no " + name + " at " + fromDir + ": " + otherwise + ".");
                return;
            }
            try
            {
                File.Copy(from, Path.Combine(toDir, name), true);
                Debug.Log("[WebPlanner build] " + name + " copied to " + toDir);
            }
            catch (Exception e)
            {
                throw new BuildFailedException("[WebPlanner build] " + name + " NOT copied to " + toDir + ": " + e.Message);
            }
        }

        // The source is missing: the copy an earlier build left in the output must not be used in its place.
        static void Remove(string dir, string what)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
            }
            catch (Exception e)
            {
                throw new BuildFailedException("[WebPlanner build] old " + what + " folder " + dir + " NOT removed: " + e.Message);
            }
        }

        // Replaces the target folder (ours alone) with a copy of the source tree.
        static void Copy(string from, string to, string what)
        {
            try
            {
                if (Directory.Exists(to)) Directory.Delete(to, true);
                int files = 0;
                long bytes = 0;
                foreach (string f in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
                {
                    string target = Path.Combine(to, f.Substring(from.Length).TrimStart('\\', '/'));
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    File.Copy(f, target, true);
                    files++;
                    bytes += new FileInfo(f).Length;
                }
                Debug.Log("[WebPlanner build] " + what + " copied to " + to + " (" + files + " files, " +
                          (bytes / (1024.0 * 1024.0)).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " MB)");
            }
            catch (Exception e)
            {
                // Half a copy would pass for a usable folder: remove what can be removed. The build fails, so that
                // its result and the batch exit code say it (a warning is lost among the other log lines).
                try
                {
                    if (Directory.Exists(to)) Directory.Delete(to, true);
                }
                catch (Exception)
                {
                }
                throw new BuildFailedException("[WebPlanner build] " + what + " NOT copied to " + to + ": " + e.Message);
            }
        }
    }
}
#endif

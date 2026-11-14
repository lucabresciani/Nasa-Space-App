using System;
using System.IO;
using UnityEngine;

namespace NasaSpaceApp.Homeline.Sim
{
    /// <summary>
    /// Where the planner data lives. It is never inside Assets (3,000+ files that Unity must not import):
    ///   HomelineData/web     the built planner web app (the "mission planning" stage)
    ///   HomelineData/bundle  plan_bundle.zip and world_pack.zip (simulator bundle, contracts/bundle v1)
    /// HomelineData sits next to the exe in a build and next to the Assets folder in the editor; the environment
    /// variable HOMELINE_DATA overrides it. In the editor, a home-line clone next to the project is used when the
    /// folder is missing. Filled by Tools/homeline-data/fetch.ps1.
    /// Resolve once on the main thread (Application paths are main-thread only), then pass the result around.
    /// </summary>
    public sealed class HomelinePaths
    {
        public const string DataFolderName = "HomelineData";
        public const string DataEnvVar = "HOMELINE_DATA";

        /// <summary>The planner's built web app (folder with index.html), or null.</summary>
        public readonly string WebRoot;
        /// <summary>plan_bundle.zip, or null.</summary>
        public readonly string PlanBundle;
        /// <summary>world_pack.zip, or null.</summary>
        public readonly string WorldPack;
        /// <summary>Folder of the script this app injects into the planner page (StreamingAssets/homeline), or null.</summary>
        public readonly string BridgeFolder;
        /// <summary>Human-readable account of what was found and where, for the log and the menu.</summary>
        public readonly string Description;

        public bool HasPlanner { get { return WebRoot != null; } }
        public bool HasPlan { get { return PlanBundle != null && WorldPack != null; } }

        HomelinePaths(string webRoot, string planBundle, string worldPack, string bridgeFolder, string description)
        {
            WebRoot = webRoot;
            PlanBundle = planBundle;
            WorldPack = worldPack;
            BridgeFolder = bridgeFolder;
            Description = description;
        }

        public static HomelinePaths Resolve()
        {
            string appRoot = Directory.GetParent(Application.dataPath).FullName;
            string web = null, plan = null, world = null, source = "not found";

            string env = Environment.GetEnvironmentVariable(DataEnvVar);
            string[] dataRoots =
            {
                string.IsNullOrEmpty(env) ? null : env,
                Path.Combine(appRoot, DataFolderName),
            };
            foreach (string root in dataRoots)
            {
                if (root == null || !Directory.Exists(root)) continue;
                TryData(Path.Combine(root, "web"), Path.Combine(root, "bundle"), ref web, ref plan, ref world);
                if (web != null || plan != null)
                {
                    source = root;
                    break;
                }
            }

            if (web == null && plan == null && Application.isEditor)
            {
                // Development: a clone of the planner next to the project, built with npm run build.
                string clone = Path.Combine(Directory.GetParent(appRoot).FullName, "home-line");
                TryData(Path.Combine(clone, "web", "dist"),
                        Path.Combine(clone, "contracts", "bundle", "fixtures", "official_pad_v1"),
                        ref web, ref plan, ref world);
                if (web != null || plan != null) source = clone + " (planner clone)";
            }

            string bridge = Path.Combine(Application.streamingAssetsPath, "homeline");
            if (!File.Exists(Path.Combine(bridge, "bridge.js"))) bridge = null;

            string description = "HOMELINE data: " + source +
                                 " | planner web app: " + (web != null ? "yes" : "MISSING") +
                                 " | plan bundle: " + (plan != null ? "yes" : "MISSING") +
                                 " | world pack: " + (world != null ? "yes" : "MISSING") +
                                 " | bridge script: " + (bridge != null ? "yes" : "MISSING");
            return new HomelinePaths(web, plan, world, bridge, description);
        }

        static void TryData(string webDir, string bundleDir, ref string web, ref string plan, ref string world)
        {
            if (web == null && File.Exists(Path.Combine(webDir, "index.html"))) web = webDir;
            string p = Path.Combine(bundleDir, "plan_bundle.zip");
            string w = Path.Combine(bundleDir, "world_pack.zip");
            if (plan == null && File.Exists(p)) plan = p;
            if (world == null && File.Exists(w)) world = w;
        }
    }
}

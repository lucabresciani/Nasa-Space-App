using System;
using System.IO;
using UnityEngine;

namespace NasaSpaceApp.Homeline.Sim
{
    /// <summary>
    /// Where the planner data lives. It is never inside Assets (thousands of files that Unity must not import):
    ///   HomelineData/web/data   the planner's published data: the official plan and the alternative pads
    ///   HomelineData/bundle     plan_bundle.zip and world_pack.zip (simulator bundle of the official plan)
    ///   HomelineData/results    result trees of the planner's engine service (custom pads), if any
    /// HomelineData sits next to the exe in a build and next to the Assets folder in the editor; the environment
    /// variable HOMELINE_DATA overrides it. In the editor, a home-line clone next to the project is used when the
    /// folder is missing. Filled by Tools/homeline-data/fetch.ps1.
    /// Resolve once on the main thread (Application paths are main-thread only), then pass the result around.
    /// </summary>
    public sealed class HomelinePaths
    {
        public const string DataFolderName = "HomelineData";
        public const string DataEnvVar = "HOMELINE_DATA";

        /// <summary>Folder with route_{scenario}.geojson, timeline_{scenario}.json, stations.json, scenarios/pads; or null.</summary>
        public readonly string WebData;
        /// <summary>Folder scanned for engine-service result trees; may not exist.</summary>
        public readonly string ResultsDir;
        /// <summary>plan_bundle.zip of the official plan, or null.</summary>
        public readonly string PlanBundle;
        /// <summary>world_pack.zip, or null.</summary>
        public readonly string WorldPack;
        /// <summary>Human-readable account of what was found and where, for the log.</summary>
        public readonly string Description;

        public bool HasPlans { get { return WebData != null; } }

        HomelinePaths(string webData, string resultsDir, string planBundle, string worldPack, string description)
        {
            WebData = webData;
            ResultsDir = resultsDir;
            PlanBundle = planBundle;
            WorldPack = worldPack;
            Description = description;
        }

        public static HomelinePaths Resolve()
        {
            string appRoot = Directory.GetParent(Application.dataPath).FullName;
            string web = null, plan = null, world = null, results = null, source = "not found";

            string env = Environment.GetEnvironmentVariable(DataEnvVar);
            string[] dataRoots =
            {
                string.IsNullOrEmpty(env) ? null : env,
                Path.Combine(appRoot, DataFolderName),
            };
            foreach (string root in dataRoots)
            {
                if (root == null || !Directory.Exists(root)) continue;
                TryData(Path.Combine(root, "web", "data"), Path.Combine(root, "bundle"), ref web, ref plan, ref world);
                if (web != null || plan != null)
                {
                    source = root;
                    results = Path.Combine(root, "results");
                    break;
                }
            }

            if (web == null && plan == null && Application.isEditor)
            {
                // Development: a clone of the planner next to the project, built with npm run build.
                string clone = Path.Combine(Directory.GetParent(appRoot).FullName, "home-line");
                TryData(Path.Combine(clone, "web", "dist", "data"),
                        Path.Combine(clone, "contracts", "bundle", "fixtures", "official_pad_v1"),
                        ref web, ref plan, ref world);
                if (web != null || plan != null) source = clone + " (planner clone)";
            }

            string description = "HOMELINE data: " + source +
                                 " | plans: " + (web != null ? "yes" : "MISSING") +
                                 " | official bundle: " + (plan != null ? "yes" : "MISSING") +
                                 " | world pack: " + (world != null ? "yes" : "MISSING");
            return new HomelinePaths(web, results, plan, world, description);
        }

        static void TryData(string webData, string bundleDir, ref string web, ref string plan, ref string world)
        {
            if (web == null && File.Exists(Path.Combine(webData, "route_nom_104.geojson"))) web = webData;
            string p = Path.Combine(bundleDir, "plan_bundle.zip");
            string w = Path.Combine(bundleDir, "world_pack.zip");
            if (plan == null && File.Exists(p)) plan = p;
            if (world == null && File.Exists(w)) world = w;
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Threading;

namespace NasaSpaceApp.Homeline.Tests
{
    public static class Program
    {
        /// <summary>The lat/lon mapping of the Unity scene (Assets/Mars/Data/MountSharp/MountSharp.json, MarsGeoReference).</summary>
        public static readonly SceneGeo Scene = new SceneGeo(
            swLat: -4.85418884, swLon: 137.33278002, metersPerDegree: 59274.6975, eastScale: 0.996489,
            swX: -3061.675154, swZ: -3071.707);

        public static int Main(string[] args)
        {
            // Prove the logic is culture-proof: run under a culture that writes decimal commas.
            Thread.CurrentThread.CurrentCulture = new CultureInfo("it-IT");

            string fixture = ResolveFixture(args);
            if (fixture == null)
            {
                Console.WriteLine("Fixture not found. Pass --fixture <folder with plan_bundle.zip and world_pack.zip>,");
                Console.WriteLine("or set HOMELINE_FIXTURE, or clone home-line next to this repository.");
                return 2;
            }
            Console.WriteLine("Fixture: " + fixture);

            // Every public static class named *Tests with a public static Run(string fixtureFolder) is a suite.
            // Adding a suite is adding a file: nothing to register here.
            var suites = new List<KeyValuePair<string, Action<string>>>();
            Type[] types = typeof(Program).Assembly.GetTypes();
            Array.Sort(types, (a, b) => string.CompareOrdinal(a.Name, b.Name));
            string only = null;
            for (int i = 0; i + 1 < args.Length; i++)
                if (args[i] == "--only") only = args[i + 1];
            foreach (Type t in types)
            {
                if (!t.Name.EndsWith("Tests", StringComparison.Ordinal)) continue;
                MethodInfo run = t.GetMethod("Run", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
                if (run == null) continue;
                string name = t.Name.Substring(0, t.Name.Length - "Tests".Length).ToLowerInvariant();
                if (only != null && !string.Equals(only, name, StringComparison.OrdinalIgnoreCase)) continue;
                suites.Add(new KeyValuePair<string, Action<string>>(name, (Action<string>)Delegate.CreateDelegate(typeof(Action<string>), run)));
            }

            foreach (KeyValuePair<string, Action<string>> s in suites)
            {
                int before = T.Passed, failedBefore = T.Failures.Count;
                T.Group(s.Key);
                try
                {
                    s.Value(fixture);
                }
                catch (Exception e)
                {
                    T.True(false, "exception: " + e.GetType().Name + ": " + e.Message);
                }
                Console.WriteLine(s.Key + ": " + (T.Passed - before) + " passed, " + (T.Failures.Count - failedBefore) + " failed");
            }

            Console.WriteLine();
            Console.WriteLine("TOTAL: " + T.Passed + " passed, " + T.Failures.Count + " failed");
            return T.Failures.Count == 0 ? 0 : 1;
        }

        static string ResolveFixture(string[] args)
        {
            var candidates = new List<string>();
            for (int i = 0; i + 1 < args.Length; i++)
                if (args[i] == "--fixture") candidates.Add(args[i + 1]);
            string env = Environment.GetEnvironmentVariable("HOMELINE_FIXTURE");
            if (!string.IsNullOrEmpty(env)) candidates.Add(env);

            // A home-line clone next to this repository: <parent>/home-line/contracts/bundle/fixtures/official_pad_v1
            string dir = AppContext.BaseDirectory;
            for (int up = 0; up < 10 && dir != null; up++)
            {
                candidates.Add(Path.Combine(dir, "home-line", "contracts", "bundle", "fixtures", "official_pad_v1"));
                dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            }

            foreach (string c in candidates)
                if (File.Exists(Path.Combine(c, "plan_bundle.zip")) && File.Exists(Path.Combine(c, "world_pack.zip")))
                    return Path.GetFullPath(c);
            return null;
        }
    }
}

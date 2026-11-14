using System.Collections.Generic;
using System.Linq;
using System.Text;
using NasaSpaceApp.Science;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Gives every boulder science data: a <see cref="RockSample"/> pointing at a rock class and a real
    /// analog analysis from <see cref="RockDatabase"/>, a collider the scanner's ray can hit, and a
    /// <see cref="RockScanner"/> on the player camera.
    ///
    /// Classes are placed like geology, not confetti: each class has a low-frequency "outcrop" noise
    /// field, so neighbours tend to share a class, weighted by the class abundance. Classes whose
    /// group is "impact" or "meteorite" are boosted around craters. Deterministic for a given seed.
    ///
    /// Runs inside Tools > Mars > Build Mars Landscape Scene, or on the open scene via
    /// Tools > Mars > Science > Assign Rock Data (Open Scene) (undoable) after editing the database.
    /// </summary>
    static class MarsRockScience
    {
        const string RocksPath = "Environment/Rocks";
        const float OutcropScale = 160f;   // meters per noise unit: size of a same-class patch
        const float OutcropContrast = 2.2f; // how strongly a class dominates its patch
        const float CraterInfluence = 2.2f; // crater radii within which impact products are boosted

        public struct Result
        {
            public int rocks, triggerColliders;
            public Dictionary<string, int> perClass;
        }

        [MenuItem("Tools/Mars/Science/Assign Rock Data (Open Scene)")]
        static void AssignInOpenScene()
        {
            GameObject root = GameObject.Find(RocksPath);
            if (root == null)
            {
                Debug.LogError($"[Mars] No '{RocksPath}' object in the open scene. Open the Mars scene or run Tools > Mars > Build Mars Landscape Scene.");
                return;
            }
            Undo.SetCurrentGroupName("Assign Rock Science Data");
            int group = Undo.GetCurrentGroup();

            Result result = Apply(root.transform, MarsTerrain.Craters(MarsSceneBuilder.Seed), MarsSceneBuilder.Seed, undo: true);
            GameObject player = GameObject.FindWithTag("Player");
            if (player != null) SetupScanner(player, undo: true);
            else Debug.LogWarning("[Mars] No object tagged Player: add a RockScanner to your camera by hand.");

            Undo.CollapseUndoOperations(group);
            EditorSceneManager.MarkSceneDirty(root.scene);
            Debug.Log(Describe(result));
        }

        [MenuItem("Tools/Mars/Science/Reload Rock Database")]
        static void Reload()
        {
            RockDatabase.ReloadDefault();
            RockDatabase db = RockDatabase.Default;
            Debug.Log($"[Mars] Rock database: {db.Classes.Count} classes, {db.Analyses.Count} analyses.");
        }

        /// <summary>Adds or refreshes science data on every rock under <paramref name="rocksRoot"/>.</summary>
        public static Result Apply(Transform rocksRoot, List<MarsTerrain.Crater> craters, int seed, bool undo)
        {
            var result = new Result { perClass = new Dictionary<string, int>() };

            RockDatabase.ReloadDefault();
            RockDatabase db = RockDatabase.Default;
            List<RockClass> classes = db.Classes.Where(c => c.Abundance > 0f && db.AnalysesOf(c.Id).Count > 0).ToList();
            if (classes.Count == 0)
            {
                Debug.LogError("[Mars] The rock database has no class with abundance > 0 and at least one analysis; rocks left without data.");
                return result;
            }
            List<MarsTerrain.Crater> bigCraters = craters?.Where(c => c.radius >= 15f).ToList() ?? new List<MarsTerrain.Crater>();

            var volumes = new Dictionary<Mesh, float>();
            var weights = new float[classes.Count];
            int index = 0;

            foreach (Transform rock in rocksRoot)
            {
                var filter = rock.GetComponent<MeshFilter>();
                Mesh mesh = filter != null ? filter.sharedMesh : null;
                if (mesh == null) continue;
                index++;

                Vector3 p = rock.position;
                Vector3 size = Vector3.Scale(mesh.bounds.size, Abs(rock.lossyScale));
                float largest = Mathf.Max(size.x, Mathf.Max(size.y, size.z));
                if (!volumes.TryGetValue(mesh, out float unitVolume)) volumes[mesh] = unitVolume = MeshVolume(mesh);
                Vector3 s = rock.lossyScale;
                float volume = unitVolume * Mathf.Abs(s.x * s.y * s.z);

                // Seed from position so a rock keeps its data if the hierarchy is reordered.
                int rockSeed = (int)MarsNoise.Hash(Mathf.RoundToInt(p.x * 100f), Mathf.RoundToInt(p.z * 100f), seed);
                var rng = new System.Random(rockSeed);

                float nearCrater = 0f, inCrater = 0f;
                var flat = new Vector2(p.x, p.z);
                foreach (MarsTerrain.Crater c in bigCraters)
                {
                    float d = Vector2.Distance(flat, c.center) / c.radius;
                    nearCrater = Mathf.Max(nearCrater, 1f - d / CraterInfluence);
                    inCrater = Mathf.Max(inCrater, 1f - d);
                }

                RockClass chosen = Pick(classes, weights, rng, p, largest, nearCrater, inCrater, seed, respectSize: true)
                                   ?? Pick(classes, weights, rng, p, largest, nearCrater, inCrater, seed, respectSize: false);
                IReadOnlyList<RockAnalysis> analyses = db.AnalysesOf(chosen.Id);
                RockAnalysis analysis = analyses[rng.Next(analyses.Count)];

                var sample = rock.GetComponent<RockSample>();
                if (sample == null) sample = undo ? Undo.AddComponent<RockSample>(rock.gameObject) : rock.gameObject.AddComponent<RockSample>();
                else if (undo) Undo.RecordObject(sample, "Assign Rock Science Data");
                sample.Configure($"MR-{index:0000}", chosen.Id, analysis.Id, rockSeed, volume, size);
                EditorUtility.SetDirty(sample);

                // The scene builder only gives colliders to rocks you could trip on; the rest get a
                // trigger so the scanner ray can still hit them while the player walks over them.
                if (rock.GetComponent<Collider>() == null)
                {
                    var collider = undo ? Undo.AddComponent<MeshCollider>(rock.gameObject) : rock.gameObject.AddComponent<MeshCollider>();
                    collider.sharedMesh = mesh;
                    collider.convex = true;
                    collider.isTrigger = true;
                    result.triggerColliders++;
                }

                result.rocks++;
                result.perClass.TryGetValue(chosen.Id, out int n);
                result.perClass[chosen.Id] = n + 1;
            }
            return result;
        }

        static RockClass Pick(List<RockClass> classes, float[] weights, System.Random rng, Vector3 p, float size,
                              float nearCrater, float inCrater, int seed, bool respectSize)
        {
            float total = 0f;
            for (int i = 0; i < classes.Count; i++)
            {
                RockClass c = classes[i];
                float w = 0f;
                if (!respectSize || FitsSize(c, size))
                {
                    int classSeed = seed ^ (int)MarsNoise.Hash(c.Id.GetHashStable(), 0, 977);
                    float outcrop = MarsNoise.Fbm(p.x / OutcropScale, p.z / OutcropScale, 3, classSeed);
                    w = c.Abundance * Mathf.Exp(OutcropContrast * outcrop);
                    if (c.Group == "impact") w *= 1f + 8f * nearCrater;
                    else if (c.Group == "meteorite") w *= 1f + 6f * inCrater;
                }
                weights[i] = w;
                total += w;
            }
            if (total <= 0f) return null;

            float r = (float)rng.NextDouble() * total;
            for (int i = 0; i < classes.Count; i++)
            {
                r -= weights[i];
                if (r <= 0f && weights[i] > 0f) return classes[i];
            }
            for (int i = classes.Count - 1; i >= 0; i--)
                if (weights[i] > 0f) return classes[i];
            return null;
        }

        static bool FitsSize(RockClass c, float size) =>
            c.SizeRangeM == null || c.SizeRangeM.Length < 2 || (size >= c.SizeRangeM[0] && size <= c.SizeRangeM[1]);

        /// <summary>Puts a <see cref="RockScanner"/> (and the temporary debug readout) on the player's camera.</summary>
        public static void SetupScanner(GameObject player, bool undo)
        {
            var cam = player.GetComponentInChildren<Camera>();
            if (cam == null)
            {
                Debug.LogWarning("[Mars] Player has no camera; RockScanner not added.", player);
                return;
            }
            GameObject go = cam.gameObject;
            if (go.GetComponent<RockScanner>() == null)
            {
                if (undo) Undo.AddComponent<RockScanner>(go);
                else go.AddComponent<RockScanner>();
            }
            if (go.GetComponent<RockScanDebugOverlay>() == null)
            {
                if (undo) Undo.AddComponent<RockScanDebugOverlay>(go);
                else go.AddComponent<RockScanDebugOverlay>();
            }
        }

        public static string Describe(Result r)
        {
            var sb = new StringBuilder($"[Mars] Rock science data on {r.rocks} rocks ({r.triggerColliders} new trigger colliders): ");
            sb.Append(string.Join(", ", r.perClass.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key} {kv.Value}")));
            return sb.ToString();
        }

        /// <summary>Volume of a closed mesh in its local units (divergence theorem over its triangles).</summary>
        static float MeshVolume(Mesh mesh)
        {
            Vector3[] v = mesh.vertices;
            int[] t = mesh.triangles;
            double volume = 0.0;
            for (int i = 0; i + 2 < t.Length; i += 3)
                volume += Vector3.Dot(v[t[i]], Vector3.Cross(v[t[i + 1]], v[t[i + 2]]));
            return Mathf.Abs((float)(volume / 6.0));
        }

        static Vector3 Abs(Vector3 v) => new Vector3(Mathf.Abs(v.x), Mathf.Abs(v.y), Mathf.Abs(v.z));

        /// <summary>Drops the cached database whenever its JSON is (re)imported, so edits show up on the next read.</summary>
        sealed class DatabaseWatcher : AssetPostprocessor
        {
            static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
            {
                string file = $"/Resources/{RockDatabase.ResourcePath}.json";
                if (imported.Concat(deleted).Concat(moved).Any(p => p.EndsWith(file))) RockDatabase.ReloadDefault();
            }
        }

        /// <summary>string.GetHashCode is randomized per process in .NET; this one is stable across sessions.</summary>
        static int GetHashStable(this string s)
        {
            unchecked
            {
                int h = 23;
                foreach (char ch in s) h = h * 31 + ch;
                return h;
            }
        }
    }
}

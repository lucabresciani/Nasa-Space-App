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
            public int rocks, triggerColliders, locked;
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
            List<RockClass> classes = db.Classes.Where(c => c.Abundance > 0f && db.AnalogsOf(c.Id).Count > 0).ToList();
            if (classes.Count == 0)
            {
                Debug.LogError("[Mars] The rock database has no class with abundance > 0 and at least one analog analysis; rocks left without data.");
                return result;
            }
            List<MarsTerrain.Crater> bigCraters = craters?.Where(c => c.radius >= 15f).ToList() ?? new List<MarsTerrain.Crater>();

            var volumes = new Dictionary<Mesh, float>();
            var weights = new float[classes.Count];

            // Real terrain (MarsGeoReference): Mount Sharp's layers are nearly flat, so a rock's MOLA elevation says which
            // layer it sits in. Each class keeps to the elevation span of its samples measured within this terrain's
            // elevation range; a class measured only above or below it (e.g. a higher bed) does not occur here.
            NasaSpaceApp.MarsGeoReference geo = NasaSpaceApp.MarsGeoReference.Instance;
            Terrain terrain = geo != null ? Terrain.activeTerrain : null;
            var bands = new Dictionary<string, Vector2>();
            if (geo != null)
            {
                float lo = float.MaxValue, hi = float.MinValue;
                foreach (Transform rock in rocksRoot)
                {
                    float e = geo.ElevationMOLA(rock.position);
                    lo = Mathf.Min(lo, e);
                    hi = Mathf.Max(hi, e);
                }
                foreach (RockClass c in classes.ToList())
                {
                    List<float> all = db.AnalogsOf(c.Id).Where(a => a.ElevationM.HasValue).Select(a => a.ElevationM.Value).ToList();
                    if (all.Count == 0) continue; // no elevation data (e.g. meteorites): anywhere
                    List<float> here = all.Where(e => e >= lo - AreaMarginM && e <= hi + AreaMarginM).ToList();
                    if (here.Count == 0) classes.Remove(c); // measured only outside this terrain's layers
                    else bands[c.Id] = new Vector2(here.Min(), here.Max());
                }
                weights = new float[classes.Count];
                if (classes.Count == 0)
                {
                    Debug.LogError("[Mars] No rock class has samples within this terrain's elevation range; rocks left as they were.");
                    return result;
                }
            }

            // Field ids are permanent once given: re-running keeps them, new rocks continue the numbering.
            // A duplicated rock (Ctrl+D copies the id) keeps the id on its first occurrence and the copy gets a new one.
            int nextFieldNumber = 1;
            var takenIds = new HashSet<string>();
            foreach (Transform rock in rocksRoot)
            {
                var existing = rock.GetComponent<RockSample>();
                if (existing != null && TryFieldNumber(existing.FieldId, out int number)) nextFieldNumber = Mathf.Max(nextFieldNumber, number + 1);
            }

            foreach (Transform rock in rocksRoot)
            {
                var filter = rock.GetComponent<MeshFilter>();
                Mesh mesh = filter != null ? filter.sharedMesh : null;
                if (mesh == null) continue;

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

                var sample = rock.GetComponent<RockSample>();
                if (sample == null) sample = undo ? Undo.AddComponent<RockSample>(rock.gameObject) : rock.gameObject.AddComponent<RockSample>();
                else if (undo) Undo.RecordObject(sample, "Assign Rock Science Data");
                string fieldId = !string.IsNullOrEmpty(sample.FieldId) && takenIds.Add(sample.FieldId)
                    ? sample.FieldId
                    : $"MR-{nextFieldNumber++:0000}";
                takenIds.Add(fieldId);

                string classId;
                if (sample.Locked)
                {
                    // Hand-set science data stays; only geometry-derived facts are refreshed.
                    sample.SetGeometry(fieldId, volume, size);
                    classId = sample.ClassId;
                    result.locked++;
                }
                else
                {
                    float? elevation = geo != null ? geo.ElevationMOLA(p) : (float?)null;
                    float? relief = terrain != null ? LocalRelief(terrain, p) : (float?)null;
                    RockClass chosen = Pick(classes, weights, rng, p, largest, nearCrater, inCrater, seed, elevation, relief, bands, respectSize: true)
                                       ?? Pick(classes, weights, rng, p, largest, nearCrater, inCrater, seed, elevation, relief, bands, respectSize: false);
                    List<RockAnalysis> analogs = db.AnalogsOf(chosen.Id);
                    List<RockAnalysis> analogsHere = bands.TryGetValue(chosen.Id, out Vector2 chosenBand)
                        ? analogs.Where(a => a.ElevationM.HasValue && a.ElevationM.Value >= chosenBand.x && a.ElevationM.Value <= chosenBand.y).ToList()
                        : analogs;
                    if (analogsHere.Count > 0) analogs = analogsHere;
                    RockAnalysis analysis = analogs[rng.Next(analogs.Count)];
                    // On a geo-referenced terrain the rock is an analog of the class sample measured closest in elevation,
                    // i.e. closest in Mount Sharp's flat-lying stratigraphy.
                    if (elevation.HasValue && analogs.Any(a => a.ElevationM.HasValue))
                        analysis = analogs.Where(a => a.ElevationM.HasValue).OrderBy(a => Mathf.Abs(a.ElevationM.Value - elevation.Value)).First();
                    sample.Configure(fieldId, chosen.Id, analysis.Id, rockSeed, volume, size);
                    classId = chosen.Id;
                }
                EditorUtility.SetDirty(sample);

                result.triggerColliders += EnsureScanCollider(rock.gameObject, mesh, undo);
                result.rocks++;
                result.perClass.TryGetValue(classId ?? "?", out int n);
                result.perClass[classId ?? "?"] = n + 1;
            }
            return result;
        }

        /// <summary>
        /// The scene builder only gives colliders to rocks you could trip on; the rest get a trigger box
        /// fitted to the mesh, so the scanner ray can hit them while the player walks over them.
        /// (A convex MeshCollider would exceed PhysX's 255-polygon hull limit on these meshes and fall
        /// back to a partial hull.) Earlier trigger MeshColliders from this tool are replaced.
        /// Returns 1 if a collider was added.
        /// </summary>
        static int EnsureScanCollider(GameObject rock, Mesh mesh, bool undo)
        {
            Collider existing = rock.GetComponent<Collider>();
            if (existing is MeshCollider oldTrigger && oldTrigger.isTrigger)
            {
                if (undo) Undo.DestroyObjectImmediate(oldTrigger);
                else Object.DestroyImmediate(oldTrigger);
                existing = null;
            }
            if (existing != null) return 0;

            var box = undo ? Undo.AddComponent<BoxCollider>(rock) : rock.AddComponent<BoxCollider>();
            box.center = mesh.bounds.center;
            box.size = mesh.bounds.size;
            box.isTrigger = true;
            return 1;
        }

        static bool TryFieldNumber(string fieldId, out int number)
        {
            number = 0;
            return !string.IsNullOrEmpty(fieldId) && fieldId.StartsWith("MR-") && int.TryParse(fieldId.Substring(3), out number);
        }

        const float BandMarginM = 15f;   // a class is at full weight within its sampled elevation span ± this
        const float BandFalloffM = 20f;  // then fades by e every this many meters further away
        const float AreaMarginM = 30f;   // samples this far outside the terrain's elevation range still count as "here"
        const float CaprockReliefM = 8f; // "caprock" classes need the rock to stand this much above the surroundings

        /// <summary>How far the ground at <paramref name="p"/> stands above the mean ground on rings of 100 m and 250 m (largest).</summary>
        static float LocalRelief(Terrain terrain, Vector3 p)
        {
            float origin = terrain.transform.position.y;
            float here = terrain.SampleHeight(p) + origin;
            float best = float.MinValue;
            foreach (float radius in new[] { 100f, 250f })
            {
                float sum = 0f;
                for (int i = 0; i < 8; i++)
                {
                    float a = i * Mathf.PI / 4f;
                    sum += terrain.SampleHeight(p + new Vector3(Mathf.Cos(a), 0f, Mathf.Sin(a)) * radius) + origin;
                }
                best = Mathf.Max(best, here - sum / 8f);
            }
            return best;
        }

        static RockClass Pick(List<RockClass> classes, float[] weights, System.Random rng, Vector3 p, float size,
                              float nearCrater, float inCrater, int seed, float? elevation, float? relief,
                              Dictionary<string, Vector2> bands, bool respectSize)
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
                    if (c.Setting == "caprock" && relief.HasValue && relief.Value < CaprockReliefM) w = 0f;
                    else if (elevation.HasValue && bands.TryGetValue(c.Id, out Vector2 band) && c.Setting != "caprock")
                    {
                        // Caprock (unconformable) units drape any elevation, so the band applies only to layered classes.
                        float outside = Mathf.Max(0f, band.x - BandMarginM - elevation.Value, elevation.Value - band.y - BandMarginM);
                        w *= Mathf.Exp(-outside / BandFalloffM);
                    }
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
            !c.SizeRangeM.HasValue || c.SizeRangeM.Contains(size);

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
            if (go.GetComponent<RockScanner>() != null) return; // already set up: never re-add a removed debug readout
            if (undo)
            {
                Undo.AddComponent<RockScanner>(go);
                Undo.AddComponent<RockScanDebugOverlay>(go);
            }
            else
            {
                go.AddComponent<RockScanner>();
                go.AddComponent<RockScanDebugOverlay>();
            }
        }

        public static string Describe(Result r)
        {
            var sb = new StringBuilder($"[Mars] Rock science data on {r.rocks} rocks ({r.locked} locked kept as set, {r.triggerColliders} new trigger colliders): ");
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
                if (!imported.Concat(deleted).Concat(moved).Any(p => p.EndsWith(file))) return;
                RockDatabase.ReloadDefault();
                _ = RockDatabase.Default; // parse now, so a broken edit is reported right after saving the JSON
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

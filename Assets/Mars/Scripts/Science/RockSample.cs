using System;
using System.Collections.Generic;
using UnityEngine;

namespace NasaSpaceApp.Science
{
    /// <summary>
    /// Science data attached to one rock. Stores only references into <see cref="RockDatabase"/>
    /// (class + analog analysis) plus per-rock facts (seed, volume, size), so editing the database
    /// updates every rock. Call <see cref="Read"/> to get the rock's values.
    ///
    /// Filled in by Tools > Mars > Science > Assign Rock Data (or the scene builder); every field can
    /// also be edited by hand, e.g. to point a landmark rock at a specific analysis with variation 0.
    /// </summary>
    [DisallowMultipleComponent]
    public class RockSample : MonoBehaviour
    {
        [SerializeField, Tooltip("Field designation shown to the astronaut, e.g. MR-0421.")]
        string fieldId;
        [SerializeField, Tooltip("RockClass id in the database, e.g. olivine-basalt.")]
        string classId;
        [SerializeField, Tooltip("RockAnalysis id this rock is an analog of. Falls back to the first analysis of the class if missing.")]
        string analysisId;
        [SerializeField, Range(0f, 3f), Tooltip("Per-rock spread of the oxide values, in units of the analysis' analytical uncertainty. 0 = exact published values.")]
        float variation = 1f;
        [SerializeField, Tooltip("Seed for the per-rock variation.")]
        int seed;
        [SerializeField, Min(0f), Tooltip("Whole-rock volume in m³ (including the buried part).")]
        float volumeM3;
        [SerializeField, Tooltip("World-space bounding size of the rock in meters.")]
        Vector3 sizeM;

        public string FieldId => fieldId;
        public string ClassId => classId;
        public string AnalysisId => analysisId;
        public float VolumeM3 => volumeM3;
        public Vector3 SizeM => sizeM;

        RockReading reading;
        static int readingsVersion;
        int readingVersion = -1;

        /// <summary>Makes every rock recompute its reading on the next <see cref="Read"/> (after the database changes).</summary>
        public static void InvalidateAllReadings() => readingsVersion++;

        /// <summary>Sets every field at once (used by the editor assignment tool).</summary>
        public void Configure(string fieldId, string classId, string analysisId, int seed, float volumeM3, Vector3 sizeM, float variation = 1f)
        {
            this.fieldId = fieldId;
            this.classId = classId;
            this.analysisId = analysisId;
            this.seed = seed;
            this.volumeM3 = volumeM3;
            this.sizeM = sizeM;
            this.variation = variation;
            reading = null;
        }

        /// <summary>
        /// This rock's science values, computed from the default database and cached.
        /// Returns null when the database has neither the rock's analysis nor its class.
        /// </summary>
        public RockReading Read() => Read(RockDatabase.Default);

        public RockReading Read(RockDatabase database)
        {
            bool isDefault = database == RockDatabase.Default;
            if (isDefault && reading != null && readingVersion == readingsVersion) return reading;

            RockReading result = RockReading.Compute(this, database);
            if (isDefault)
            {
                reading = result;
                readingVersion = readingsVersion;
            }
            return result;
        }

        internal float Variation => variation;
        internal int Seed => seed;

        void OnValidate() => reading = null;
    }

    /// <summary>A value with its key and 1-sigma uncertainty (0 when unknown).</summary>
    public readonly struct Measurement
    {
        public readonly string Key;
        public readonly float Value;
        public readonly float Sigma;

        public Measurement(string key, float value, float sigma = 0f)
        {
            Key = key;
            Value = value;
            Sigma = sigma;
        }

        public override string ToString() => Sigma > 0f ? $"{Key} {Value:0.##} ± {Sigma:0.##}" : $"{Key} {Value:0.##}";
    }

    /// <summary>
    /// The science values of one rock: its class, the real analysis it is an analog of, and the
    /// rock's own composition (the analog's values with a small seeded spread inside analytical
    /// uncertainty) plus derived physical properties. Immutable; obtained from <see cref="RockSample.Read()"/>.
    /// </summary>
    public sealed class RockReading
    {
        /// <summary>Relative 1-sigma used when the source gives no uncertainty for an oxide (typical APXS precision).</summary>
        public const float DefaultRelativeSigma = 0.03f;

        public string FieldId { get; private set; }
        public RockClass Class { get; private set; }
        /// <summary>The published measurement this rock is an analog of. Null if the class has no analyses.</summary>
        public RockAnalysis Analog { get; private set; }

        /// <summary>Major-element oxides, wt%, in the database's display order. Only oxides the analog reports.</summary>
        public IReadOnlyList<Measurement> Oxides { get; private set; }
        /// <summary>Sum of <see cref="Oxides"/>, wt%. Below 100 when volatiles, metals or unreported elements are present.</summary>
        public float OxideTotal { get; private set; }
        /// <summary>Trace elements, ppm (analog values with the same seeded spread).</summary>
        public IReadOnlyList<Measurement> Traces { get; private set; }
        /// <summary>Metal abundances, wt% (iron meteorites).</summary>
        public IReadOnlyList<Measurement> Metals { get; private set; }
        /// <summary>Mineral abundances, wt%, exactly as measured on the analog (empty when not measured).</summary>
        public IReadOnlyList<Measurement> Minerals { get; private set; }

        public float DensityGcm3 { get; private set; }
        public float VolumeM3 { get; private set; }
        public float MassKg { get; private set; }
        public Vector3 SizeM { get; private set; }

        /// <summary>True when the oxide values were varied away from the published analysis.</summary>
        public bool IsVaried { get; private set; }

        /// <summary>Model VNIR reflectance of the rock's class at a wavelength in µm (see <see cref="RockClass.Reflectance"/>).</summary>
        public float Reflectance(float micrometers) => Class?.Reflectance(micrometers) ?? 0f;

        /// <summary>Value of one oxide in wt%, or NaN if not reported.</summary>
        public float Oxide(string key)
        {
            foreach (Measurement m in Oxides)
                if (string.Equals(m.Key, key, StringComparison.OrdinalIgnoreCase)) return m.Value;
            return float.NaN;
        }

        RockReading() { }

        internal static RockReading Compute(RockSample rock, RockDatabase db)
        {
            RockAnalysis analog = db.GetAnalysis(rock.AnalysisId);
            RockClass rockClass = db.GetClass(analog?.ClassId ?? rock.ClassId) ?? db.GetClass(rock.ClassId);
            if (analog == null && rockClass != null)
            {
                IReadOnlyList<RockAnalysis> ofClass = db.AnalysesOf(rockClass.Id);
                if (ofClass.Count > 0) analog = ofClass[0];
            }
            if (rockClass == null && analog == null) return null;

            var rng = new System.Random(rock.Seed);
            float spread = Mathf.Max(0f, rock.Variation);

            var oxides = new List<Measurement>();
            float total = 0f, publishedTotal = 0f;
            if (analog?.OxidesWtPct != null)
            {
                // Display order first, then any extra keys the source reported.
                var keys = new List<string>(db.OxideKeys);
                foreach (string key in analog.OxidesWtPct.Keys)
                    if (!keys.Exists(k => string.Equals(k, key, StringComparison.OrdinalIgnoreCase))) keys.Add(key);

                foreach (string key in keys)
                {
                    if (!TryGet(analog.OxidesWtPct, key, out float value)) continue;
                    float sigma = TryGet(analog.OxideSigmaWtPct, key, out float s) ? s : value * DefaultRelativeSigma;
                    float varied = Mathf.Max(0f, value + Gaussian(rng) * sigma * spread);
                    oxides.Add(new Measurement(key, varied, sigma));
                    total += varied;
                    publishedTotal += value;
                }
                // Keep the analytical total of the source: spread redistributes, it does not invent mass.
                if (total > 0f && publishedTotal > 0f && spread > 0f)
                {
                    float k = publishedTotal / total;
                    for (int i = 0; i < oxides.Count; i++)
                        oxides[i] = new Measurement(oxides[i].Key, oxides[i].Value * k, oxides[i].Sigma);
                    total = publishedTotal;
                }
            }

            float density = rockClass?.DensityGcm3 is { Length: >= 2 } d
                ? Mathf.Lerp(d[0], d[1], (float)rng.NextDouble())
                : rockClass?.DensityGcm3 is { Length: 1 } d1 ? d1[0] : 0f;

            return new RockReading
            {
                FieldId = rock.FieldId,
                Class = rockClass,
                Analog = analog,
                Oxides = oxides,
                OxideTotal = total,
                Traces = Vary(analog?.TracesPpm, rng, spread),
                Metals = Vary(analog?.MetalsWtPct, rng, spread),
                Minerals = Vary(analog?.MineralsWtPct, rng, 0f),
                DensityGcm3 = density,
                VolumeM3 = rock.VolumeM3,
                MassKg = rock.VolumeM3 * density * 1000f,
                SizeM = rock.SizeM,
                IsVaried = spread > 0f && oxides.Count > 0,
            };
        }

        static List<Measurement> Vary(Dictionary<string, float> source, System.Random rng, float spread)
        {
            var list = new List<Measurement>();
            if (source == null) return list;
            foreach (KeyValuePair<string, float> kv in source)
            {
                float sigma = kv.Value * DefaultRelativeSigma;
                list.Add(new Measurement(kv.Key, Mathf.Max(0f, kv.Value + Gaussian(rng) * sigma * spread), spread > 0f ? sigma : 0f));
            }
            return list;
        }

        static bool TryGet(Dictionary<string, float> map, string key, out float value)
        {
            value = 0f;
            if (map == null) return false;
            if (map.TryGetValue(key, out value)) return true;
            foreach (KeyValuePair<string, float> kv in map)
            {
                if (!string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase)) continue;
                value = kv.Value;
                return true;
            }
            return false;
        }

        // Box-Muller standard normal, clamped to ±2.5σ so a rock never drifts out of its class.
        static float Gaussian(System.Random rng)
        {
            double u1 = 1.0 - rng.NextDouble(), u2 = rng.NextDouble();
            double n = Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Cos(2.0 * Math.PI * u2);
            return Mathf.Clamp((float)n, -2.5f, 2.5f);
        }
    }
}

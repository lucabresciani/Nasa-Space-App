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
    /// Tick <see cref="Locked"/> to keep such edits when the assignment runs again.
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
        [SerializeField, Range(0f, 3f), Tooltip("Per-rock spread of the values, in units of the analysis' published 1-sigma uncertainty. 0 = exact published values. Values without a published uncertainty never vary.")]
        float variation = 1f;
        [SerializeField, Tooltip("Seed for the per-rock variation.")]
        int seed;
        [SerializeField, Min(0f), Tooltip("Whole-rock volume in m³ (including the buried part).")]
        float volumeM3;
        [SerializeField, Tooltip("Size of the rock along its own axes, in meters.")]
        Vector3 sizeM;
        [SerializeField, Tooltip("Keep this rock's hand-set class, analysis and variation when Tools > Mars > Science > Assign Rock Data runs again.")]
        bool locked;

        public string FieldId => fieldId;
        public string ClassId => classId;
        public string AnalysisId => analysisId;
        public float Variation => variation;
        public float VolumeM3 => volumeM3;
        public Vector3 SizeM => sizeM;
        public bool Locked => locked;

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

        /// <summary>Updates only the geometry-derived facts (used for locked rocks, whose science data is hand-set).</summary>
        public void SetGeometry(string fieldId, float volumeM3, Vector3 sizeM)
        {
            this.fieldId = fieldId;
            this.volumeM3 = volumeM3;
            this.sizeM = sizeM;
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

        internal int Seed => seed;

        void OnValidate() => reading = null;
    }

    /// <summary>A value with its key and published 1-sigma uncertainty (0 when the source gives none).</summary>
    public readonly struct Measurement
    {
        public readonly string Key;
        public readonly float Value;
        /// <summary>Published 1-sigma uncertainty; 0 when the source publishes none.</summary>
        public readonly float Sigma;
        /// <summary>Upper limit / not detected (value not above its own uncertainty): show <see cref="UpperBound"/> or "n.d.", not a precise number.</summary>
        public readonly bool IsUpperLimit;

        public Measurement(string key, float value, float sigma = 0f, bool isUpperLimit = false)
        {
            Key = key;
            Value = value;
            Sigma = sigma;
            IsUpperLimit = isUpperLimit;
        }

        /// <summary>For an upper limit, the 2-sigma bound the true value lies below (value + 2σ); 0 when nothing is known.</summary>
        public float UpperBound => Value + 2f * Sigma;

        public override string ToString() =>
            IsUpperLimit ? (UpperBound > 0f ? $"{Key} < {UpperBound:0.##}" : $"{Key} n.d.")
            : Sigma > 0f ? $"{Key} {Value:0.##} ± {Sigma:0.##}"
            : $"{Key} {Value:0.##}";
    }

    /// <summary>
    /// The science values of one rock: its class, the real analysis it is an analog of, and the
    /// rock's own composition (the analog's values with a small seeded spread inside their published
    /// analytical uncertainty) plus derived physical properties. Immutable; obtained from <see cref="RockSample.Read()"/>.
    ///
    /// Variation rules: a value varies only if the source publishes its uncertainty (converted to 1-sigma
    /// with <see cref="RockAnalysis.SigmaLevel"/>); upper limits / non-detections never vary; oxides, and metals
    /// when there are two or more, are then rescaled to the published total so a composition never exceeds it.
    /// </summary>
    public sealed class RockReading
    {
        /// <summary>A varied value never goes below this fraction of the published one (large-σ values would otherwise hit 0).</summary>
        const float MinFractionOfPublished = 0.1f;

        public string FieldId { get; private set; }
        public RockClass Class { get; private set; }
        /// <summary>The published measurement this rock is an analog of. Null if the class has no analyses.</summary>
        public RockAnalysis Analog { get; private set; }

        /// <summary>Major-element oxides, wt%, in the database's display order. Only oxides the analog reports.</summary>
        public IReadOnlyList<Measurement> Oxides { get; private set; }
        /// <summary>Sum of <see cref="Oxides"/>, wt% (equals the analog's published total). Below 100 when volatiles, metals or unreported elements are present.</summary>
        public float OxideTotal { get; private set; }
        /// <summary>Trace elements, ppm.</summary>
        public IReadOnlyList<Measurement> Traces { get; private set; }
        /// <summary>Metal abundances, wt% (iron meteorites).</summary>
        public IReadOnlyList<Measurement> Metals { get; private set; }
        /// <summary>Mineral abundances, wt%, exactly as measured on the analog (empty when not measured).</summary>
        public IReadOnlyList<Measurement> Minerals { get; private set; }

        /// <summary>Bulk density in g/cm³ picked inside the class range; NaN when the class has none.</summary>
        public float DensityGcm3 { get; private set; }
        public float VolumeM3 { get; private set; }
        /// <summary>Estimated whole-rock mass (volume × density); NaN when the density is unknown.</summary>
        public float MassKg { get; private set; }
        /// <summary>Size of the rock along its own axes, in meters.</summary>
        public Vector3 SizeM { get; private set; }

        /// <summary>True when at least one value differs from the published analysis.</summary>
        public bool IsVaried { get; private set; }

        /// <summary>Model VNIR reflectance of the rock's class at a wavelength in µm (see <see cref="RockClass.Reflectance"/>); NaN when unknown.</summary>
        public float Reflectance(float micrometers) => Class?.Reflectance(micrometers) ?? float.NaN;

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
                List<RockAnalysis> analogs = db.AnalogsOf(rockClass.Id);
                IReadOnlyList<RockAnalysis> all = db.AnalysesOf(rockClass.Id);
                analog = analogs.Count > 0 ? analogs[0] : all.Count > 0 ? all[0] : null;
            }
            if (rockClass == null && analog == null) return null;

            // Own stream, decorrelated from the one the assignment tool used to pick class and analysis.
            var rng = new System.Random(unchecked(rock.Seed * -1640531535 + 2135587861));
            float spread = Mathf.Max(0f, rock.Variation);

            var oxideValues = new List<KeyValuePair<string, float>>();
            if (analog?.OxidesWtPct != null)
            {
                // Display order first, then any extra keys the source reported.
                foreach (string key in db.OxideKeys)
                    if (TryGet(analog.OxidesWtPct, key, out float v)) oxideValues.Add(new KeyValuePair<string, float>(key, v));
                foreach (KeyValuePair<string, float> kv in analog.OxidesWtPct)
                    if (!oxideValues.Exists(o => string.Equals(o.Key, kv.Key, StringComparison.OrdinalIgnoreCase))) oxideValues.Add(kv);
            }

            bool varied = false;
            List<Measurement> oxides = Vary(oxideValues, k => TryGet(analog?.OxideSigmaWtPct, k, out float s) ? s : (float?)null,
                                            analog, rng, spread, closeToTotal: true, ref varied);
            List<Measurement> traces = Vary(analog?.TracesPpm, k => analog.TraceSigma(k), analog, rng, spread, closeToTotal: false, ref varied);
            List<Measurement> metals = Vary(analog?.MetalsWtPct, k => analog.MetalSigma(k), analog, rng, spread,
                                            closeToTotal: analog?.MetalsWtPct != null && analog.MetalsWtPct.Count >= 2, ref varied);
            var minerals = new List<Measurement>();
            if (analog?.MineralsWtPct != null)
                foreach (KeyValuePair<string, float> kv in analog.MineralsWtPct) minerals.Add(new Measurement(kv.Key, kv.Value));

            float total = 0f;
            foreach (Measurement m in oxides) total += m.Value;

            // NaN when the class has no published density: mass stays unknown rather than invented.
            float density = rockClass != null ? rockClass.DensityGcm3.Lerp((float)rng.NextDouble()) : float.NaN;

            return new RockReading
            {
                FieldId = rock.FieldId,
                Class = rockClass,
                Analog = analog,
                Oxides = oxides,
                OxideTotal = total,
                Traces = traces,
                Metals = metals,
                Minerals = minerals,
                DensityGcm3 = density,
                VolumeM3 = rock.VolumeM3,
                MassKg = rock.VolumeM3 * density * 1000f,
                SizeM = rock.SizeM,
                IsVaried = varied,
            };
        }

        /// <summary>
        /// Varies each value by its published 1-sigma (× <paramref name="spread"/>). Values with no published
        /// uncertainty, and upper limits, stay exactly as published. With <paramref name="closeToTotal"/>, the
        /// varied values are rescaled so the sum equals the published sum.
        /// </summary>
        static List<Measurement> Vary(IEnumerable<KeyValuePair<string, float>> source, Func<string, float?> publishedSigma,
                                      RockAnalysis analog, System.Random rng, float spread, bool closeToTotal, ref bool anyVaried)
        {
            var list = new List<Measurement>();
            if (source == null || analog == null) return list;
            float level = analog.SigmaLevel > 0f ? analog.SigmaLevel : 1f;

            float publishedSum = 0f, fixedSum = 0f, variedSum = 0f;
            var canVary = new List<bool>();
            foreach (KeyValuePair<string, float> kv in source)
            {
                float? s = publishedSigma(kv.Key);
                float sigma = s.HasValue && s.Value > 0f ? s.Value / level : 0f;
                bool upper = analog.IsUpperLimit(kv.Key, kv.Value, s);
                float g = Gaussian(rng); // always drawn, so editing one flag does not reshuffle every other value
                bool varies = !upper && sigma > 0f && spread > 0f;
                // A detected value never drops to (or near) zero, which would read like a non-detection.
                float value = varies ? Mathf.Max(kv.Value * MinFractionOfPublished, kv.Value + g * sigma * spread) : kv.Value;
                list.Add(new Measurement(kv.Key, value, sigma, upper));
                canVary.Add(varies);
                publishedSum += kv.Value;
                if (varies) variedSum += value; else fixedSum += kv.Value;
            }

            float target = publishedSum - fixedSum;
            if (closeToTotal && variedSum > 0f && target > 0f)
            {
                float k = target / variedSum;
                for (int i = 0; i < list.Count; i++)
                    if (canVary[i]) list[i] = new Measurement(list[i].Key, list[i].Value * k, list[i].Sigma, list[i].IsUpperLimit);
            }
            if (canVary.Contains(true)) anyVaried = true;
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

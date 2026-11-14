using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace NasaSpaceApp.Science
{
    /// <summary>
    /// The rock science dataset: rock classes (what kind of rock) and analyses (real published
    /// rover measurements of named Mars targets). Every in-game rock is an analog of one analysis.
    ///
    /// Source of truth is a JSON file (schema "mars-rock-db/1") loaded from
    /// Resources/<see cref="ResourcePath"/>.json. Edit that file, or regenerate it with
    /// Tools > Mars > Science > Import Rock Data, to change the data of every rock at once:
    /// rocks only store ids into this database, never copies of the values.
    /// </summary>
    public sealed class RockDatabase
    {
        public const string Schema = "mars-rock-db/1";
        public const string ResourcePath = "MarsRockDatabase";

        /// <summary>Canonical major-element oxides, in display order. FeO is total iron expressed as FeO.</summary>
        public static readonly string[] DefaultOxideKeys =
            { "SiO2", "TiO2", "Al2O3", "Cr2O3", "FeO", "MnO", "MgO", "CaO", "Na2O", "K2O", "P2O5", "SO3", "Cl" };

        [JsonProperty("schema")] public string SchemaId;
        [JsonProperty("title")] public string Title;
        [JsonProperty("notes")] public string Notes;
        [JsonProperty("oxideKeys")] public string[] OxideKeys;
        [JsonProperty("classes")] public List<RockClass> Classes = new List<RockClass>();
        [JsonProperty("samples")] public List<RockAnalysis> Analyses = new List<RockAnalysis>();

        Dictionary<string, RockClass> classById;
        Dictionary<string, RockAnalysis> analysisById;
        Dictionary<string, List<RockAnalysis>> analysesByClass;

        static RockDatabase defaultDatabase;

        /// <summary>The database shipped in Resources. Loaded on first use and cached.</summary>
        public static RockDatabase Default
        {
            get
            {
                if (defaultDatabase == null) defaultDatabase = LoadFromResources();
                return defaultDatabase;
            }
        }

        /// <summary>Drops the cached default database; the next access re-reads the JSON (e.g. after an import).</summary>
        public static void ReloadDefault()
        {
            defaultDatabase = null;
            RockSample.InvalidateAllReadings();
        }

        // Static caches survive play-mode entry when domain reload is disabled; start every session fresh.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics() => defaultDatabase = null;

        static RockDatabase LoadFromResources()
        {
            var asset = Resources.Load<TextAsset>(ResourcePath);
            if (asset == null)
            {
                Debug.LogError($"[RockDatabase] Resources/{ResourcePath}.json not found; rocks will have no science data.");
                return new RockDatabase { SchemaId = Schema, OxideKeys = DefaultOxideKeys }.Indexed();
            }
            try
            {
                return Parse(asset.text);
            }
            catch (Exception e)
            {
                Debug.LogError($"[RockDatabase] Could not parse Resources/{ResourcePath}.json: {e.Message}", asset);
                return new RockDatabase { SchemaId = Schema, OxideKeys = DefaultOxideKeys }.Indexed();
            }
        }

        /// <summary>
        /// Parses a mars-rock-db/1 JSON string.
        /// Malformed JSON (syntax error, truncated file, root not an object) throws, so a broken file fails loudly.
        /// In well-formed JSON, a value that does not fit its field (null where a number is expected, "n/a" in a
        /// number, a list where a text is expected...) is skipped with a warning naming its path, so one bad edit
        /// does not wipe every rock's data.
        /// </summary>
        public static RockDatabase Parse(string json)
        {
            // Syntax first: any error raised after this point is a value that does not fit its field.
            JToken token = JToken.Parse(json);
            if (token.Type != JTokenType.Object)
                throw new JsonSerializationException("The rock database must be a JSON object (schema mars-rock-db/1).");

            var settings = new JsonSerializerSettings
            {
                Error = (_, args) =>
                {
                    Debug.LogWarning($"[RockDatabase] Skipped '{args.ErrorContext.Path}': {args.ErrorContext.Error.Message}");
                    args.ErrorContext.Handled = true;
                },
            };
            var db = token.ToObject<RockDatabase>(JsonSerializer.Create(settings)) ?? new RockDatabase();
            if (!string.IsNullOrEmpty(db.SchemaId) && db.SchemaId != Schema)
                Debug.LogWarning($"[RockDatabase] Expected schema '{Schema}', got '{db.SchemaId}'. Loading anyway.");
            if (db.OxideKeys == null || db.OxideKeys.Length == 0) db.OxideKeys = DefaultOxideKeys;
            return db.Indexed();
        }

        RockDatabase Indexed()
        {
            Classes ??= new List<RockClass>();
            Analyses ??= new List<RockAnalysis>();
            classById = new Dictionary<string, RockClass>(StringComparer.OrdinalIgnoreCase);
            analysisById = new Dictionary<string, RockAnalysis>(StringComparer.OrdinalIgnoreCase);
            analysesByClass = new Dictionary<string, List<RockAnalysis>>(StringComparer.OrdinalIgnoreCase);
            foreach (RockClass c in Classes)
                if (!string.IsNullOrEmpty(c?.Id)) classById[c.Id] = c;
            foreach (RockAnalysis a in Analyses)
            {
                if (string.IsNullOrEmpty(a?.Id)) continue;
                analysisById[a.Id] = a;
                if (string.IsNullOrEmpty(a.ClassId)) continue;
                if (!analysesByClass.TryGetValue(a.ClassId, out var list)) analysesByClass[a.ClassId] = list = new List<RockAnalysis>();
                list.Add(a);
            }
            return this;
        }

        public RockClass GetClass(string id) =>
            id != null && classById.TryGetValue(id, out RockClass c) ? c : null;

        public RockAnalysis GetAnalysis(string id) =>
            id != null && analysisById.TryGetValue(id, out RockAnalysis a) ? a : null;

        static readonly List<RockAnalysis> None = new List<RockAnalysis>();

        /// <summary>Every analysis of a class, including reference-only ones (<see cref="RockAnalysis.UseAsAnalog"/> false).</summary>
        public IReadOnlyList<RockAnalysis> AnalysesOf(string classId) =>
            classId != null && analysesByClass.TryGetValue(classId, out var list) ? list : None;

        /// <summary>Analyses of a class that rocks may take as their analog.</summary>
        public List<RockAnalysis> AnalogsOf(string classId)
        {
            var result = new List<RockAnalysis>();
            foreach (RockAnalysis a in AnalysesOf(classId))
                if (a.UseAsAnalog) result.Add(a);
            return result;
        }
    }

    /// <summary>A kind of rock, with class-level properties (ranges come from terrestrial or meteorite analogs).</summary>
    public sealed class RockClass
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("name")] public string Name;
        /// <summary>Short geologic-map style unit symbol, e.g. "Hb".</summary>
        [JsonProperty("unitSymbol")] public string UnitSymbol;
        /// <summary>igneous | sedimentary | impact | meteorite | alteration</summary>
        [JsonProperty("group")] public string Group;
        /// <summary>Noachian | Hesperian | Amazonian | unknown</summary>
        [JsonProperty("epoch")] public string Epoch;
        [JsonProperty("ageGa")] public ValueRange AgeGa;
        [JsonProperty("summary")] public string Summary;
        [JsonProperty("formation")] public string Formation;
        [JsonProperty("whySample")] public string WhySample;
        [JsonProperty("densityGcm3")] public ValueRange DensityGcm3;
        [JsonProperty("porosityPct")] public ValueRange PorosityPct;
        [JsonProperty("mohs")] public ValueRange Mohs;
        [JsonProperty("vnir")] public VnirSignature Vnir;
        /// <summary>Relative abundance on the generated plain (0-1). 0 keeps the class out of automatic assignment.</summary>
        [JsonProperty("abundance")] public float Abundance = 1f;
        /// <summary>Optional [min,max] rock size in meters this class may be assigned to (e.g. concretions are small).</summary>
        [JsonProperty("sizeRangeM")] public ValueRange SizeRangeM;
        /// <summary>Optional placement rule. "caprock": only on local topographic highs (buttes, pediment edges), e.g. an unconformable cap.</summary>
        [JsonProperty("setting")] public string Setting;
        [JsonProperty("references")] public List<Reference> References;

        /// <summary>True when the class has enough VNIR data to model a reflectance curve (an albedo).</summary>
        public bool HasSpectrum => Vnir?.Albedo != null;

        /// <summary>
        /// Model VNIR reflectance (0-1) at <paramref name="micrometers"/>, built from the class's albedo, slope and
        /// Gaussian absorption bands. A schematic signature for display, not a measured spectrum.
        /// Scaled so that Reflectance(0.75) equals the albedo exactly (the albedo is defined at 0.75 µm).
        /// NaN when the class has no albedo; bands without a depth or width are listed but not drawn.
        /// </summary>
        public float Reflectance(float micrometers)
        {
            if (!HasSpectrum) return float.NaN;
            float continuum = Vnir.Albedo.Value * (1f + (Vnir.Slope ?? 0f) * (micrometers - 0.75f));
            float anchor = BandProduct(0.75f);
            return Mathf.Clamp01(anchor > 0f ? continuum * BandProduct(micrometers) / anchor : continuum);
        }

        float BandProduct(float micrometers)
        {
            float product = 1f;
            if (Vnir?.Bands == null) return product;
            foreach (SpectralBand b in Vnir.Bands)
            {
                if (b?.Depth == null || b.Width == null) continue;
                // Width is the continuum (shoulder-to-shoulder) span, so the band fits inside it at about ±3 sigma;
                // then the dip at the band center matches the stated depth measured against that continuum.
                float sigma = Mathf.Max(0.005f, b.Width.Value / 6f);
                float x = (micrometers - b.Um) / sigma;
                product *= 1f - Mathf.Clamp01(b.Depth.Value) * Mathf.Exp(-0.5f * x * x);
            }
            return product;
        }
    }

    /// <summary>
    /// A [min, max] pair from the JSON. Either bound may be null (unknown), e.g. an age known only as "older than 3.71 Ga".
    /// </summary>
    [JsonConverter(typeof(ValueRangeConverter))]
    public readonly struct ValueRange
    {
        public readonly float? Min;
        public readonly float? Max;

        public ValueRange(float? min, float? max)
        {
            Min = min;
            Max = max;
        }

        public bool HasValue => Min.HasValue || Max.HasValue;

        /// <summary>Point at <paramref name="t"/> (0-1) inside the range; the known bound if only one is known; NaN if none.</summary>
        public float Lerp(float t) =>
            Min.HasValue && Max.HasValue ? Mathf.Lerp(Min.Value, Max.Value, t) : Min ?? Max ?? float.NaN;

        /// <summary>True when <paramref name="value"/> is inside the known bounds (an unknown bound does not limit).</summary>
        public bool Contains(float value) => (!Min.HasValue || value >= Min.Value) && (!Max.HasValue || value <= Max.Value);

        public override string ToString() =>
            !HasValue ? "unknown"
            : Min.HasValue && Max.HasValue
                ? (Mathf.Approximately(Min.Value, Max.Value) ? $"{Min.Value:0.###}" : $"{Min.Value:0.###}-{Max.Value:0.###}")
                : Min.HasValue ? $">= {Min.Value:0.###}" : $"<= {Max.Value:0.###}";
    }

    /// <summary>Reads ranges written as [min, max], [value] or a bare number; null elements are unknown bounds.</summary>
    sealed class ValueRangeConverter : JsonConverter<ValueRange>
    {
        public override ValueRange ReadJson(JsonReader reader, Type objectType, ValueRange existingValue, bool hasExistingValue, JsonSerializer serializer)
        {
            switch (reader.TokenType)
            {
                case JsonToken.Null:
                    return default;
                case JsonToken.Integer:
                case JsonToken.Float:
                    float v = Convert.ToSingle(reader.Value, System.Globalization.CultureInfo.InvariantCulture);
                    return new ValueRange(v, v);
                case JsonToken.StartArray:
                    var values = serializer.Deserialize<List<float?>>(reader) ?? new List<float?>();
                    float? min = values.Count > 0 ? values[0] : null;
                    float? max = values.Count > 1 ? values[1] : min;
                    return new ValueRange(min, max);
                default:
                    throw new JsonSerializationException($"Expected [min, max] or a number for a range, got {reader.TokenType}.");
            }
        }

        public override void WriteJson(JsonWriter writer, ValueRange value, JsonSerializer serializer)
        {
            if (!value.HasValue)
            {
                writer.WriteNull();
                return;
            }
            writer.WriteStartArray();
            if (value.Min.HasValue) writer.WriteValue(value.Min.Value); else writer.WriteNull();
            if (value.Max.HasValue) writer.WriteValue(value.Max.Value); else writer.WriteNull();
            writer.WriteEndArray();
        }
    }

    public sealed class VnirSignature
    {
        /// <summary>Reflectance at 0.75 µm; null when unknown.</summary>
        [JsonProperty("albedo")] public float? Albedo;
        /// <summary>Relative reflectance change per µm around 0.75 µm (null/0 = flat).</summary>
        [JsonProperty("slope")] public float? Slope;
        [JsonProperty("bands")] public List<SpectralBand> Bands;
    }

    public sealed class SpectralBand
    {
        [JsonProperty("um")] public float Um;
        /// <summary>Fractional band depth 0-1; null when the source gives only the position.</summary>
        [JsonProperty("depth")] public float? Depth;
        /// <summary>Continuum span (shoulder-to-shoulder separation) in µm, not FWHM; null when unknown.</summary>
        [JsonProperty("width")] public float? Width;
        [JsonProperty("label")] public string Label;
    }

    public sealed class Reference
    {
        [JsonProperty("citation")] public string Citation;
        [JsonProperty("url")] public string Url;
    }

    /// <summary>One published measurement of a real Mars target (APXS, PIXL, CheMin...).</summary>
    public sealed class RockAnalysis
    {
        [JsonProperty("id")] public string Id;
        /// <summary>Target name given by the mission team, e.g. "Adirondack".</summary>
        [JsonProperty("target")] public string Target;
        [JsonProperty("classId")] public string ClassId;
        [JsonProperty("mission")] public string Mission;
        [JsonProperty("instrument")] public string Instrument;
        [JsonProperty("site")] public string Site;
        [JsonProperty("sol")] public int? Sol;
        /// <summary>Elevation of the measured target in meters (MOLA datum), when the source gives it.</summary>
        [JsonProperty("elevationM")] public float? ElevationM;
        /// <summary>Surface preparation: natural, brushed, RAT-abraded, abrasion patch...</summary>
        [JsonProperty("prep")] public string Prep;
        [JsonProperty("oxidesWtPct")] public Dictionary<string, float> OxidesWtPct;
        [JsonProperty("oxideSigmaWtPct")] public Dictionary<string, float> OxideSigmaWtPct;
        /// <summary>How many sigma the published uncertainties are (APXS tables are usually 2). Divide by it for 1-sigma.</summary>
        [JsonProperty("sigmaLevel")] public float SigmaLevel = 1f;
        [JsonProperty("tracesPpm")] public Dictionary<string, float> TracesPpm;
        [JsonProperty("metalsWtPct")] public Dictionary<string, float> MetalsWtPct;
        [JsonProperty("mineralsWtPct")] public Dictionary<string, float> MineralsWtPct;
        [JsonProperty("mineralsSource")] public string MineralsSource;
        [JsonProperty("citation")] public string Citation;
        [JsonProperty("url")] public string Url;
        /// <summary>high | medium | low: how directly the values were checked against the source table.</summary>
        [JsonProperty("confidence")] public string Confidence;
        [JsonProperty("notes")] public string Notes;
        /// <summary>False keeps the analysis as reference only (e.g. a soil): automatic assignment never gives it to a boulder.</summary>
        [JsonProperty("useAsAnalog")] public bool UseAsAnalog = true;
        /// <summary>Provenance block; only the parts the game uses are mapped, the rest is ignored.</summary>
        [JsonProperty("ext")] public AnalysisExt Ext;

        /// <summary>Published uncertainty of a trace element in ppm (at <see cref="SigmaLevel"/>), or null.</summary>
        public float? TraceSigma(string key) => Ext?.TraceSigmaPpm != null && Ext.TraceSigmaPpm.TryGetValue(key, out float s) ? s : (float?)null;

        /// <summary>Published uncertainty of a metal in wt% (at <see cref="SigmaLevel"/>), or null.</summary>
        public float? MetalSigma(string key) => Ext?.MetalsSigmaWtPct != null && Ext.MetalsSigmaWtPct.TryGetValue(key, out float s) ? s : (float?)null;

        /// <summary>
        /// True when this value is an upper limit / non-detection: flagged in ext.detectionFlags, reported as 0, or not
        /// larger than its own published uncertainty (the same rule the curated flags follow, so imported rows get it too).
        /// </summary>
        public bool IsUpperLimit(string key, float value, float? publishedSigma) =>
            (Ext?.DetectionFlags != null && Ext.DetectionFlags.ContainsKey(key))
            || value <= 0f
            || (publishedSigma.HasValue && value <= publishedSigma.Value);
    }

    /// <summary>The parts of an analysis' "ext" provenance block the game reads.</summary>
    public sealed class AnalysisExt
    {
        [JsonProperty("traceSigmaPpm")] public Dictionary<string, float> TraceSigmaPpm;
        [JsonProperty("metalsSigmaWtPct")] public Dictionary<string, float> MetalsSigmaWtPct;
        /// <summary>Element/oxide → note, for values at or below their uncertainty (upper limits, non-detections).</summary>
        [JsonProperty("detectionFlags")] public Dictionary<string, string> DetectionFlags;
    }
}

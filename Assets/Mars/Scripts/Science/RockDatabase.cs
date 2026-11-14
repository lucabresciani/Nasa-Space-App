using System;
using System.Collections.Generic;
using Newtonsoft.Json;
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

        public static RockDatabase Parse(string json)
        {
            var db = JsonConvert.DeserializeObject<RockDatabase>(json) ?? new RockDatabase();
            if (!string.IsNullOrEmpty(db.SchemaId) && db.SchemaId != Schema)
                Debug.LogWarning($"[RockDatabase] Expected schema '{Schema}', got '{db.SchemaId}'. Loading anyway.");
            if (db.OxideKeys == null || db.OxideKeys.Length == 0) db.OxideKeys = DefaultOxideKeys;
            return db.Indexed();
        }

        public string ToJson() => JsonConvert.SerializeObject(this, Formatting.Indented,
            new JsonSerializerSettings { NullValueHandling = NullValueHandling.Ignore });

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

        public IReadOnlyList<RockAnalysis> AnalysesOf(string classId) =>
            classId != null && analysesByClass.TryGetValue(classId, out var list) ? list : None;
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
        [JsonProperty("ageGa")] public float[] AgeGa;
        [JsonProperty("summary")] public string Summary;
        [JsonProperty("formation")] public string Formation;
        [JsonProperty("whySample")] public string WhySample;
        [JsonProperty("densityGcm3")] public float[] DensityGcm3;
        [JsonProperty("porosityPct")] public float[] PorosityPct;
        [JsonProperty("mohs")] public float[] Mohs;
        [JsonProperty("vnir")] public VnirSignature Vnir;
        /// <summary>Relative abundance on the generated plain (0-1). 0 keeps the class out of automatic assignment.</summary>
        [JsonProperty("abundance")] public float Abundance = 1f;
        /// <summary>Optional [min,max] rock size in meters this class may be assigned to (e.g. concretions are small).</summary>
        [JsonProperty("sizeRangeM")] public float[] SizeRangeM;
        [JsonProperty("references")] public List<Reference> References;

        /// <summary>
        /// Model VNIR reflectance (0-1) at <paramref name="micrometers"/>, built from the class's albedo, slope and
        /// Gaussian absorption bands. A schematic signature for display, not a measured spectrum.
        /// </summary>
        public float Reflectance(float micrometers)
        {
            if (Vnir == null) return 0f;
            float r = Vnir.Albedo * (1f + Vnir.Slope * (micrometers - 0.75f));
            if (Vnir.Bands != null)
            {
                foreach (SpectralBand b in Vnir.Bands)
                {
                    float sigma = Mathf.Max(0.005f, b.Width / 2.3548f); // width is FWHM
                    float x = (micrometers - b.Um) / sigma;
                    r *= 1f - Mathf.Clamp01(b.Depth) * Mathf.Exp(-0.5f * x * x);
                }
            }
            return Mathf.Clamp01(r);
        }
    }

    public sealed class VnirSignature
    {
        /// <summary>Reflectance at 0.75 µm.</summary>
        [JsonProperty("albedo")] public float Albedo;
        /// <summary>Relative reflectance change per µm around 0.75 µm (0 = flat).</summary>
        [JsonProperty("slope")] public float Slope;
        [JsonProperty("bands")] public List<SpectralBand> Bands;
    }

    public sealed class SpectralBand
    {
        [JsonProperty("um")] public float Um;
        [JsonProperty("depth")] public float Depth;
        /// <summary>Full width at half maximum, µm.</summary>
        [JsonProperty("width")] public float Width;
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
        /// <summary>Surface preparation: natural, brushed, RAT-abraded, abrasion patch...</summary>
        [JsonProperty("prep")] public string Prep;
        [JsonProperty("oxidesWtPct")] public Dictionary<string, float> OxidesWtPct;
        [JsonProperty("oxideSigmaWtPct")] public Dictionary<string, float> OxideSigmaWtPct;
        [JsonProperty("tracesPpm")] public Dictionary<string, float> TracesPpm;
        [JsonProperty("metalsWtPct")] public Dictionary<string, float> MetalsWtPct;
        [JsonProperty("mineralsWtPct")] public Dictionary<string, float> MineralsWtPct;
        [JsonProperty("mineralsSource")] public string MineralsSource;
        [JsonProperty("citation")] public string Citation;
        [JsonProperty("url")] public string Url;
        /// <summary>high | medium | low: how directly the values were checked against the source table.</summary>
        [JsonProperty("confidence")] public string Confidence;
        [JsonProperty("notes")] public string Notes;
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using NasaSpaceApp.Science;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace NasaSpaceApp.MarsGen
{
    /// <summary>
    /// Tools > Mars > Science > Import Rock Analyses (CSV)...
    /// Adds rows of a public oxide-abundance table to the rock database JSON as analyses of a chosen class.
    ///
    /// Header-driven, so it reads the PDS Geosciences Node APXS tables as published:
    ///  - MER "apxs_oxides_mer1/2.csv": Spectrum, Type, Name, ..., SiO2, SiO2.err, ..., Ni, Ni.err;
    ///  - MSL "msl_apxs_concentrations_*.csv" (sol, target, ..., SiO2, SiO2_err, ...), including the ones with a text
    ///    preamble before the header, and the MSL supplements with "SiO2_pct" / "Ni_ppm" headers;
    ///  - any CSV that uses oxide names as column headers.
    /// Rules: the header is the first line with at least three oxide columns; a column named like an oxide (SiO2, FeO,
    /// FeOT, Fe2O3...) is wt%; "&lt;col&gt;.err" / "_err" / "_sigma" is its uncertainty; Ni, Zn, Br and other bare
    /// element symbols are ppm traces; Spectrum / Id, Name / Target, Type and Sol identify the row.
    /// Other formats: convert them to this shape, or add a reader that fills <see cref="Row"/>.
    /// </summary>
    public class RockDataImportWindow : EditorWindow
    {
        const string DatabaseAssetPath = "Assets/Mars/Resources/" + RockDatabase.ResourcePath + ".json";

        // Fe2O3 → FeO: 2 FeO / Fe2O3 = 143.69 / 159.69.
        const float Fe2O3ToFeO = 0.8998f;

        static readonly Dictionary<string, string> TypeToPrep = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "RU", "rock, undisturbed (dusty surface)" }, { "RB", "rock, brushed" }, { "RR", "rock, RAT-abraded" },
            { "OU", "outcrop, undisturbed" }, { "OB", "outcrop, brushed" }, { "C", "cobble" },
            { "SU", "soil, undisturbed" }, { "SD", "soil, disturbed" }, { "ST", "soil, trench" }, { "SC", "soil, crest" },
        };

        class Row
        {
            public bool selected;
            public string id, name, type;
            public int? sol;
            public readonly Dictionary<string, float> oxides = new Dictionary<string, float>();
            public readonly Dictionary<string, float> sigma = new Dictionary<string, float>();
            public readonly Dictionary<string, float> traces = new Dictionary<string, float>();
            public readonly Dictionary<string, float> traceSigma = new Dictionary<string, float>();
            public readonly List<string> extras = new List<string>();
        }

        // Fields a re-import of the same target overwrites; everything else in the entry is left as curated.
        static readonly string[] RefreshedKeys =
        {
            "mission", "instrument", "sol", "prep", "oxidesWtPct", "oxideSigmaWtPct", "sigmaLevel", "tracesPpm", "citation", "url", "confidence",
        };

        // Which iron column a header is; total iron wins over split FeO + Fe2O3.
        enum Iron { None, FeO, Fe2O3, FeOTotal, Fe2O3Total }

        string csvPath;
        List<Row> rows = new List<Row>();
        string parseReport;
        string filter = "";
        bool rocksOnly = true;
        int classIndex;
        string mission = "", instrument = "APXS", idPrefix = "", citation = "", url = "";
        float sigmaLevel = 2f; // PDS APXS tables publish 2-sigma statistical errors
        Vector2 scroll;

        [MenuItem("Tools/Mars/Science/Import Rock Analyses (CSV)...")]
        static void Open() => GetWindow<RockDataImportWindow>("Rock Data Import").minSize = new Vector2(560f, 420f);

        void OnGUI()
        {
            EditorGUILayout.HelpBox("Adds rows of an oxide-abundance CSV (e.g. PDS Geosciences Node APXS tables) to " +
                                    DatabaseAssetPath + " as analyses of the chosen rock class. Rocks then use them as analogs " +
                                    "after Tools > Mars > Science > Assign Rock Data.", MessageType.None);

            using (new EditorGUILayout.HorizontalScope())
            {
                EditorGUILayout.TextField("CSV file", csvPath ?? "");
                if (GUILayout.Button("Browse…", GUILayout.Width(80f)))
                {
                    string picked = EditorUtility.OpenFilePanel("Oxide abundance table", "", "csv,CSV,txt");
                    if (!string.IsNullOrEmpty(picked)) Load(picked);
                }
            }
            if (!string.IsNullOrEmpty(parseReport)) EditorGUILayout.LabelField(parseReport, EditorStyles.wordWrappedMiniLabel);
            if (rows.Count == 0) return;

            RockDatabase db = RockDatabase.Default;
            string[] classIds = db.Classes.Select(c => c.Id).ToArray();
            if (classIds.Length == 0)
            {
                EditorGUILayout.HelpBox("The database has no rock classes yet; add one to the JSON first.", MessageType.Warning);
                return;
            }
            classIndex = EditorGUILayout.Popup("Rock class", Mathf.Clamp(classIndex, 0, classIds.Length - 1),
                db.Classes.Select(c => $"{c.Id}  ({c.Name})").ToArray());
            mission = EditorGUILayout.TextField("Mission", mission);
            instrument = EditorGUILayout.TextField("Instrument", instrument);
            sigmaLevel = Mathf.Max(1f, EditorGUILayout.FloatField(
                new GUIContent("Error columns are (σ)", "How many sigma the error columns are. PDS APXS tables: 2."), sigmaLevel));
            idPrefix = EditorGUILayout.TextField("Id prefix", idPrefix);
            citation = EditorGUILayout.TextField("Citation", citation);
            url = EditorGUILayout.TextField("URL", url);

            using (new EditorGUILayout.HorizontalScope())
            {
                filter = EditorGUILayout.TextField("Filter name", filter);
                rocksOnly = EditorGUILayout.ToggleLeft("Rocks/outcrops only", rocksOnly, GUILayout.Width(150f));
            }

            List<Row> visible = rows.Where(Visible).ToList();
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Select visible")) visible.ForEach(r => r.selected = true);
                if (GUILayout.Button("Clear selection")) rows.ForEach(r => r.selected = false);
            }

            scroll = EditorGUILayout.BeginScrollView(scroll);
            foreach (Row r in visible)
            {
                string si = r.oxides.TryGetValue("SiO2", out float s) ? s.ToString("0.0", CultureInfo.InvariantCulture) : "-";
                string fe = r.oxides.TryGetValue("FeO", out float f) ? f.ToString("0.0", CultureInfo.InvariantCulture) : "-";
                string so = r.oxides.TryGetValue("SO3", out float so3) ? so3.ToString("0.0", CultureInfo.InvariantCulture) : "-";
                r.selected = EditorGUILayout.ToggleLeft(
                    $"{r.id,-10} {r.type,-4} {r.name}   SiO2 {si}  FeO {fe}  SO3 {so}{(r.sol.HasValue ? $"   sol {r.sol}" : "")}", r.selected);
            }
            EditorGUILayout.EndScrollView();

            int count = rows.Count(r => r.selected);
            using (new EditorGUI.DisabledScope(count == 0))
            {
                if (GUILayout.Button($"Add {count} analyses to '{classIds[classIndex]}'", GUILayout.Height(28f)))
                    Import(rows.Where(r => r.selected).ToList(), classIds[classIndex]);
            }
        }

        bool Visible(Row r)
        {
            if (rocksOnly && r.type != null && r.type.StartsWith("S", StringComparison.OrdinalIgnoreCase)) return false;
            return string.IsNullOrEmpty(filter) || (r.name ?? "").IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0
                                                || (r.id ?? "").IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        void Load(string path)
        {
            csvPath = path;
            rows = Parse(File.ReadAllLines(path), Path.GetFileNameWithoutExtension(path), out parseReport);

            // Provenance belongs to one file: never carry it over from the previous one.
            mission = idPrefix = citation = url = "";
            instrument = "APXS";
            sigmaLevel = 2f; // APXS default; change it for tables with 1-sigma errors (e.g. PIXL)
            string file = Path.GetFileName(path).ToLowerInvariant();
            // PDS MER archive convention: mer1 = Opportunity (MER-B), mer2 = Spirit (MER-A).
            if (file.Contains("mer1")) { mission = "MER-B Opportunity"; idPrefix = "MER-B_"; }
            else if (file.Contains("mer2")) { mission = "MER-A Spirit"; idPrefix = "MER-A_"; }
            if (file.StartsWith("apxs_oxides_mer"))
            {
                citation = "Gellert, R. et al., MER APXS derived oxide abundances, PDS Geosciences Node (MER-1/2 APXS oxide data set; see Gellert et al. 2006, JGR 111, E02S05)";
                url = "https://pds-geosciences.wustl.edu/missions/mer/apxs_oxide.htm";
            }
            else if (file.StartsWith("msl_apxs"))
            {
                mission = "MSL Curiosity";
                idPrefix = "MSL_";
                citation = "MSL APXS concentration tables, PDS Geosciences Node (msl-m-apxs-4_5-rdr-v1, extras/" + Path.GetFileName(path) + ")";
                url = "https://pds-geosciences.wustl.edu/missions/msl/apxs.htm";
            }
        }

        /// <summary>Parses a header-driven oxide table into rows; rows without any oxide value are skipped.</summary>
        static List<Row> Parse(string[] lines, string fileStem, out string report)
        {
            var result = new List<Row>();
            // The header is the first line with at least three oxide columns: tables may start with a free-text preamble.
            int headerIndex = Array.FindIndex(lines, l => SplitCsv(l).Count(c => OxideKey(Normalize(c), out _, out _) != null) >= 3);
            if (headerIndex < 0)
            {
                report = "No header with oxide columns (SiO2, FeO, MgO, ...) found.";
                return result;
            }
            string[] header = SplitCsv(lines[headerIndex]).Select(Normalize).ToArray();
            int Col(params string[] names) => Array.FindIndex(header, h => names.Any(n => string.Equals(h, n, StringComparison.OrdinalIgnoreCase)));
            int idCol = Col("Spectrum", "Id", "Sample", "Sample_ID", "Target_ID", "SEQ_ID");
            int nameCol = Col("Name", "Target", "Target_Name", "Target Name");
            int typeCol = Col("Type", "Sample_Type", "Preparation_method", "Preparation method"); // MSL supplements: SU/SD/DRT...
            int solCol = Col("Sol", "Sol_Number");

            var mapped = header.Where(h => OxideKey(h, out _, out _) != null).ToList();
            var usedIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            for (int li = headerIndex + 1; li < lines.Length; li++)
            {
                if (string.IsNullOrWhiteSpace(lines[li])) continue;
                string[] cells = SplitCsv(lines[li]);
                var row = new Row
                {
                    name = Cell(cells, nameCol) ?? Cell(cells, idCol),
                    type = Cell(cells, typeCol),
                };
                if (solCol >= 0 && int.TryParse(Cell(cells, solCol), NumberStyles.Integer, CultureInfo.InvariantCulture, out int sol)) row.sol = sol;
                else if (idCol >= 0 && Regex.Match(Cell(cells, idCol) ?? "", @"^[AB](\d{3,4})") is { Success: true } m) row.sol = int.Parse(m.Groups[1].Value); // MER spectrum ids start with rover + sol
                row.id = MakeId(Cell(cells, idCol), row, fileStem, li, usedIds);

                // Iron can come as total (FeOT, Fe2O3T) or split (FeO + Fe2O3); collect both, combine after the loop.
                var iron = new Dictionary<Iron, float>();
                var ironSigma = new Dictionary<Iron, float>();
                for (int c = 0; c < header.Length && c < cells.Length; c++)
                {
                    if (c == idCol || c == nameCol || c == typeCol || c == solCol) continue;
                    if (!float.TryParse(cells[c], NumberStyles.Float, CultureInfo.InvariantCulture, out float value)) continue;
                    string h = header[c];
                    string baseName = ErrorBase(h);
                    string oxide = OxideKey(baseName ?? h, out float factor, out Iron ironKind);
                    if (baseName != null)
                    {
                        if (ironKind != Iron.None) ironSigma[ironKind] = value * factor;
                        else if (oxide != null) row.sigma[oxide] = value;
                        else if (IsElement(baseName)) row.traceSigma[baseName] = value;
                        continue;
                    }
                    if (ironKind != Iron.None) iron[ironKind] = value * factor;
                    else if (oxide != null) row.oxides[oxide] = value;
                    else if (IsElement(h)) row.traces[h] = value;
                    else row.extras.Add($"{h}={cells[c].Trim()}");
                }
                CombineIron(row, iron, ironSigma);
                if (row.oxides.Count > 0) result.Add(row);
            }
            report = $"{result.Count} rows with oxide values (header on line {headerIndex + 1}). Oxide columns: {string.Join(", ", mapped)}.";
            return result;
        }

        static string MakeId(string idCell, Row row, string fileStem, int line, HashSet<string> used)
        {
            string id = idCell;
            if (string.IsNullOrEmpty(id))
            {
                // No id column (e.g. MSL tables): build a stable id from the row's own content.
                id = row.sol.HasValue && !string.IsNullOrEmpty(row.name) ? $"sol{row.sol.Value:0000}_{row.name}" : $"{fileStem}_L{line + 1}";
                id = Regex.Replace(id, @"[^A-Za-z0-9_\-]+", "_");
            }
            string unique = id;
            for (int n = 2; !used.Add(unique); n++) unique = $"{id}_{n}";
            return unique;
        }

        static void CombineIron(Row row, Dictionary<Iron, float> iron, Dictionary<Iron, float> sigma)
        {
            if (iron.Count == 0) return;
            if (iron.TryGetValue(Iron.FeOTotal, out float total) || iron.TryGetValue(Iron.Fe2O3Total, out total))
            {
                row.oxides["FeO"] = total;
                if (sigma.TryGetValue(Iron.FeOTotal, out float s) || sigma.TryGetValue(Iron.Fe2O3Total, out s)) row.sigma["FeO"] = s;
                return;
            }
            iron.TryGetValue(Iron.FeO, out float feo);
            iron.TryGetValue(Iron.Fe2O3, out float fe2o3); // already converted to FeO equivalent
            row.oxides["FeO"] = feo + fe2o3;
            bool hasS1 = sigma.TryGetValue(Iron.FeO, out float s1), hasS2 = sigma.TryGetValue(Iron.Fe2O3, out float s2);
            if (hasS1 || hasS2) row.sigma["FeO"] = Mathf.Sqrt(s1 * s1 + s2 * s2);
        }

        /// <summary>Strips unit suffixes so "SiO2_pct", "SiO2 (wt%)" and "Ni_ppm" read as "SiO2" and "Ni".</summary>
        static string Normalize(string header)
        {
            string h = header.Trim().Trim('"').Trim();
            return Regex.Replace(h, @"(_pct|_wtpct|_wt%|\s*\(wt\s*%\)|_ppm|\s*\(ppm\))$", "", RegexOptions.IgnoreCase);
        }

        static string OxideKey(string header, out float factor, out Iron iron)
        {
            factor = 1f;
            iron = Iron.None;
            string h = header.Trim().Replace(" ", "");
            Match fe = Regex.Match(h, @"^(FeO|Fe2O3)(T|_T|\*|tot|total)?$", RegexOptions.IgnoreCase);
            if (fe.Success)
            {
                bool ferric = fe.Groups[1].Value.Equals("Fe2O3", StringComparison.OrdinalIgnoreCase);
                bool total = fe.Groups[2].Success && fe.Groups[2].Length > 0;
                factor = ferric ? Fe2O3ToFeO : 1f;
                iron = ferric ? (total ? Iron.Fe2O3Total : Iron.Fe2O3) : (total ? Iron.FeOTotal : Iron.FeO);
                return "FeO";
            }
            return RockDatabase.DefaultOxideKeys.FirstOrDefault(k => string.Equals(k, h, StringComparison.OrdinalIgnoreCase));
        }

        static string ErrorBase(string header)
        {
            Match m = Regex.Match(header, @"^(.+?)(\.err|_err|_error|_sigma|_unc|\.sigma|\s+err)$", RegexOptions.IgnoreCase);
            return m.Success ? Normalize(m.Groups[1].Value) : null;
        }

        static bool IsElement(string header) => Regex.IsMatch(header.Trim(), @"^[A-Z][a-z]?$");

        static string Cell(string[] cells, int index) =>
            index >= 0 && index < cells.Length && !string.IsNullOrWhiteSpace(cells[index]) ? cells[index].Trim() : null;

        static string[] SplitCsv(string line)
        {
            var cells = new List<string>();
            var cell = new System.Text.StringBuilder();
            bool quoted = false;
            foreach (char ch in line.TrimStart('﻿'))
            {
                if (ch == '"') quoted = !quoted;
                else if (ch == ',' && !quoted)
                {
                    cells.Add(cell.ToString());
                    cell.Clear();
                }
                else cell.Append(ch);
            }
            cells.Add(cell.ToString());
            return cells.ToArray();
        }

        void Import(List<Row> selected, string classId)
        {
            string fullPath = Path.GetFullPath(DatabaseAssetPath);
            JObject root = File.Exists(fullPath) ? JObject.Parse(File.ReadAllText(fullPath)) : new JObject { ["schema"] = RockDatabase.Schema };
            var samples = root["samples"] as JArray ?? (JArray)(root["samples"] = new JArray());

            int added = 0, replaced = 0;
            var skipped = new List<string>();
            foreach (Row r in selected)
            {
                string id = idPrefix + r.id;
                var entry = new JObject
                {
                    ["id"] = id,
                    ["target"] = r.name,
                    ["classId"] = classId,
                    ["mission"] = mission,
                    ["instrument"] = instrument,
                    ["site"] = "",
                    ["sol"] = r.sol.HasValue ? (JToken)r.sol.Value : JValue.CreateNull(),
                    ["prep"] = r.type != null && TypeToPrep.TryGetValue(Regex.Replace(r.type, @"\d+$", ""), out string prep) ? prep : r.type ?? "",
                    ["oxidesWtPct"] = JObject.FromObject(r.oxides),
                    ["oxideSigmaWtPct"] = JObject.FromObject(r.sigma),
                    ["sigmaLevel"] = sigmaLevel,
                    ["tracesPpm"] = JObject.FromObject(r.traces),
                    ["citation"] = citation,
                    ["url"] = url,
                    ["confidence"] = "high",
                    // Soils (PDS types SU, SD, ST, SC; MSL "Soil...", "Sieve") are kept as reference, never given to boulders.
                    ["useAsAnalog"] = !(r.type?.StartsWith("S", StringComparison.OrdinalIgnoreCase) ?? false),
                    ["notes"] = $"Imported from {Path.GetFileName(csvPath)} row '{r.id}'{(r.type != null ? $" (type {r.type})" : "")}. " +
                                $"{string.Join(", ", r.extras)}. Uncertainties are statistical (precision), as published.",
                    ["ext"] = new JObject { ["traceSigmaPpm"] = JObject.FromObject(r.traceSigma) },
                };

                JToken old = samples.FirstOrDefault(s => string.Equals((string)s["id"], id, StringComparison.OrdinalIgnoreCase));
                if (old == null)
                {
                    samples.Add(entry);
                    added++;
                }
                else if (!string.IsNullOrEmpty(r.name)
                         && string.Equals((string)old["target"], r.name, StringComparison.OrdinalIgnoreCase)
                         && string.Equals((string)old["classId"], classId, StringComparison.OrdinalIgnoreCase)
                         && old is JObject existing)
                {
                    // Same target re-imported: refresh only the measured values and their provenance, keep what was
                    // curated by hand (useAsAnalog, site, notes, minerals, metals, other ext keys such as detectionFlags).
                    foreach (string key in RefreshedKeys) existing[key] = entry[key];
                    var ext = existing["ext"] as JObject ?? (JObject)(existing["ext"] = new JObject());
                    ext["traceSigmaPpm"] = entry["ext"]["traceSigmaPpm"];
                    replaced++;
                }
                else
                {
                    skipped.Add(id); // the id belongs to a different analysis: never overwrite it
                }
            }

            Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
            File.WriteAllText(fullPath, root.ToString(Formatting.Indented));
            AssetDatabase.ImportAsset(DatabaseAssetPath);
            RockDatabase.ReloadDefault();
            Debug.Log($"[Mars] Rock database: {added} analyses added, {replaced} refreshed in class '{classId}'. " +
                      "Run Tools > Mars > Science > Assign Rock Data (Open Scene) to give rocks the new analogs.");
            if (skipped.Count > 0)
                Debug.LogWarning($"[Mars] Skipped {skipped.Count} rows whose id already belongs to a different target or class " +
                                 $"(change the Id prefix to import them): {string.Join(", ", skipped)}");
        }
    }
}

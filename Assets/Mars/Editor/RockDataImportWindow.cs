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
    /// Header-driven, so it reads the PDS Geosciences Node APXS oxide tables as published
    /// (e.g. MER "apxs_oxides_mer1.csv": Spectrum, Type, Name, ..., SiO2, SiO2.err, ..., Ni, Ni.err)
    /// and any CSV that uses oxide names as column headers:
    ///  - a column named like an oxide (SiO2, FeO, FeOT, Fe2O3...) is wt%; "&lt;col&gt;.err" / "_err" / "_sigma" is its uncertainty;
    ///  - Ni, Zn, Br and other bare element symbols are ppm traces;
    ///  - Spectrum / Id, Name / Target, Type and Sol identify the row.
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
            public readonly List<string> extras = new List<string>();
        }

        string csvPath;
        List<Row> rows = new List<Row>();
        string parseReport;
        string filter = "";
        bool rocksOnly = true;
        int classIndex;
        string mission = "", instrument = "APXS", idPrefix = "", citation = "", url = "";
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
            if (!string.IsNullOrEmpty(parseReport)) EditorGUILayout.LabelField(parseReport, EditorStyles.miniLabel);
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
            rows = Parse(File.ReadAllLines(path), out parseReport);
            string file = Path.GetFileName(path).ToLowerInvariant();
            // PDS MER archive convention: mer1 = Opportunity (MER-B), mer2 = Spirit (MER-A).
            if (file.Contains("mer1")) { mission = "MER-B Opportunity"; idPrefix = "MER-B_"; }
            else if (file.Contains("mer2")) { mission = "MER-A Spirit"; idPrefix = "MER-A_"; }
            if (file.StartsWith("apxs_oxides_mer"))
            {
                citation = "Gellert, R. et al., MER APXS derived oxide abundances, PDS Geosciences Node (MER-1/2 APXS oxide data set; see Gellert et al. 2006, JGR 111, E02S05)";
                url = "https://pds-geosciences.wustl.edu/missions/mer/apxs_oxide.htm";
            }
        }

        /// <summary>Parses a header-driven oxide table into rows; rows without any oxide value are skipped.</summary>
        static List<Row> Parse(string[] lines, out string report)
        {
            var result = new List<Row>();
            int headerIndex = Array.FindIndex(lines, l => !string.IsNullOrWhiteSpace(l));
            if (headerIndex < 0)
            {
                report = "Empty file.";
                return result;
            }
            string[] header = SplitCsv(lines[headerIndex]).Select(h => h.Trim()).ToArray();
            int Col(params string[] names) => Array.FindIndex(header, h => names.Any(n => string.Equals(h, n, StringComparison.OrdinalIgnoreCase)));
            int idCol = Col("Spectrum", "Id", "Sample", "Sample_ID", "Target_ID", "SEQ_ID");
            int nameCol = Col("Name", "Target", "Target_Name", "TARGET_NAME");
            int typeCol = Col("Type", "Sample_Type");
            int solCol = Col("Sol", "SOL", "Sol_Number");

            var mapped = new List<string>();
            for (int i = 0; i < header.Length; i++)
            {
                if (OxideKey(header[i]) != null) mapped.Add(header[i]);
            }

            for (int li = headerIndex + 1; li < lines.Length; li++)
            {
                if (string.IsNullOrWhiteSpace(lines[li])) continue;
                string[] cells = SplitCsv(lines[li]);
                var row = new Row
                {
                    id = Cell(cells, idCol) ?? $"row{li}",
                    name = Cell(cells, nameCol) ?? Cell(cells, idCol),
                    type = Cell(cells, typeCol),
                };
                if (solCol >= 0 && int.TryParse(Cell(cells, solCol), NumberStyles.Integer, CultureInfo.InvariantCulture, out int sol)) row.sol = sol;
                else if (idCol >= 0 && Regex.Match(row.id, @"^[AB](\d{3,4})") is { Success: true } m) row.sol = int.Parse(m.Groups[1].Value); // MER spectrum ids start with rover + sol

                for (int c = 0; c < header.Length && c < cells.Length; c++)
                {
                    if (c == idCol || c == nameCol || c == typeCol || c == solCol) continue;
                    if (!float.TryParse(cells[c], NumberStyles.Float, CultureInfo.InvariantCulture, out float value)) continue;
                    string h = header[c];
                    string baseName = ErrorBase(h);
                    string oxide = OxideKey(baseName ?? h, out float factor);
                    if (baseName != null)
                    {
                        if (oxide != null) row.sigma[oxide] = value * factor;
                        continue; // uncertainty of a trace or unknown column: not stored
                    }
                    if (oxide != null) row.oxides[oxide] = value * factor;
                    else if (IsElement(h)) row.traces[h] = value;
                    else row.extras.Add($"{h}={cells[c].Trim()}");
                }
                if (row.oxides.Count > 0) result.Add(row);
            }
            report = $"{result.Count} rows with oxide values. Oxide columns: {string.Join(", ", mapped)}.";
            return result;
        }

        static string OxideKey(string header) => OxideKey(header, out _);

        static string OxideKey(string header, out float factor)
        {
            factor = 1f;
            string h = header.Trim().Replace(" ", "");
            if (Regex.IsMatch(h, @"^FeO(T|_T|\*|tot|total)?$", RegexOptions.IgnoreCase)) return "FeO";
            if (Regex.IsMatch(h, @"^Fe2O3(T|_T|\*|tot|total)?$", RegexOptions.IgnoreCase))
            {
                factor = Fe2O3ToFeO;
                return "FeO";
            }
            return RockDatabase.DefaultOxideKeys.FirstOrDefault(k => string.Equals(k, h, StringComparison.OrdinalIgnoreCase));
        }

        static string ErrorBase(string header)
        {
            Match m = Regex.Match(header, @"^(.+?)(\.err|_err|_error|_sigma|_unc|\.sigma|\s+err)$", RegexOptions.IgnoreCase);
            return m.Success ? m.Groups[1].Value : null;
        }

        static bool IsElement(string header) => Regex.IsMatch(header.Trim(), @"^[A-Z][a-z]?$");

        static string Cell(string[] cells, int index) =>
            index >= 0 && index < cells.Length && !string.IsNullOrWhiteSpace(cells[index]) ? cells[index].Trim() : null;

        static string[] SplitCsv(string line)
        {
            var cells = new List<string>();
            var cell = new System.Text.StringBuilder();
            bool quoted = false;
            foreach (char ch in line)
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
            var existing = new HashSet<string>(samples.Select(s => (string)s["id"]).Where(s => s != null), StringComparer.OrdinalIgnoreCase);

            int added = 0, replaced = 0;
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
                    ["tracesPpm"] = JObject.FromObject(r.traces),
                    ["citation"] = citation,
                    ["url"] = url,
                    ["confidence"] = "high",
                    ["notes"] = $"Imported from {Path.GetFileName(csvPath)} row '{r.id}' (type {r.type}). {string.Join(", ", r.extras)}. " +
                                "Uncertainties are statistical (precision), as published.",
                };
                if (existing.Contains(id))
                {
                    JToken old = samples.First(s => string.Equals((string)s["id"], id, StringComparison.OrdinalIgnoreCase));
                    old.Replace(entry);
                    replaced++;
                }
                else
                {
                    samples.Add(entry);
                    existing.Add(id);
                    added++;
                }
            }

            Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
            File.WriteAllText(fullPath, root.ToString(Formatting.Indented));
            AssetDatabase.ImportAsset(DatabaseAssetPath);
            RockDatabase.ReloadDefault();
            Debug.Log($"[Mars] Rock database: {added} analyses added, {replaced} replaced in class '{classId}'. " +
                      "Run Tools > Mars > Science > Assign Rock Data (Open Scene) to give rocks the new analogs.");
        }
    }
}

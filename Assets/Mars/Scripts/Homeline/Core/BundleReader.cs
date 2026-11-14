using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>Header of a raw float32 grid, as stated in the index.json of a bundle (contracts/bundle/README.md, v1.0.0).</summary>
    public sealed class GridHeader
    {
        public int Rows;
        public int Cols;
        public double CellM;
        /// <summary>Pad-local x of the WEST edge of column 0, metres.</summary>
        public double OriginX;
        /// <summary>Pad-local y of the NORTH edge of row 0, metres.</summary>
        public double OriginY;
        public float? NoData;
        public string Units;
        public string Value;
        public double? Quantum;
        /// <summary>Heights only: pad-local z = stored value + this.</summary>
        public double? ZToFrameM;
        /// <summary>Pointer only: [drow, dcol] per move index.</summary>
        public int[][] Stencil;
    }

    public sealed class BundleFile
    {
        public string Path;
        public string MediaType;
        public long Bytes;
        public string Sha256;
        public string Role;
        public string Frame;
        public string Contract;
        public string Status;
        public GridHeader Grid;
    }

    /// <summary>The pad-local frame of a bundle: metres, origin at the pad, x = east, y = north, z = up.</summary>
    public sealed class BundleFrame
    {
        public string PadId;
        public double PadLon;
        public double PadLat;
        public double PadElevM;
        public string Proj;
        /// <summary>The pad in the analysis projection of the planner (equirectangular), metres.</summary>
        public double PadProjX;
        public double PadProjY;
        public double LatTsDeg;
        public double Lon0Deg;
        public double RadiusM;
    }

    public sealed class BundleIndex
    {
        public string SchemaVersion;
        public string Kind;
        public string BundleId;
        public string PlanId;
        public string WorldVersion;
        public string EngineCommit;
        public string ConfigHash;
        public string ContractVersion;
        public string CreatedUtc;
        public string Label;
        public bool Dummy;
        public BundleFrame Frame;
        public double[] BoundsM;
        public Dictionary<string, BundleFile> Files = new Dictionary<string, BundleFile>(StringComparer.Ordinal);
    }

    /// <summary>
    /// Reads a HOMELINE simulator bundle (plan bundle or world pack) from a .zip or from an unzipped folder.
    /// Nothing is recomputed: files are returned as the planner wrote them.
    /// </summary>
    public sealed class BundleReader : IDisposable
    {
        public const string SupportedContractMajor = "1.";

        readonly string root;
        readonly ZipArchive zip;
        readonly FileStream zipStream;
        readonly Dictionary<string, ZipArchiveEntry> entries;

        public BundleIndex Index { get; private set; }
        public string Source { get { return root; } }

        BundleReader(string path)
        {
            root = path;
            if (Directory.Exists(path)) return;
            if (!File.Exists(path)) throw new FileNotFoundException("HOMELINE bundle not found", path);
            zipStream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            zip = new ZipArchive(zipStream, ZipArchiveMode.Read);
            entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.Ordinal);
            foreach (ZipArchiveEntry e in zip.Entries) entries[e.FullName] = e;
        }

        /// <summary>Opens a bundle zip or an unzipped bundle folder and parses its index.json.</summary>
        public static BundleReader Open(string zipOrFolder)
        {
            var r = new BundleReader(zipOrFolder);
            try
            {
                r.Index = ParseIndex(r.ReadJson("index.json"));
            }
            catch
            {
                r.Dispose();
                throw;
            }
            return r;
        }

        public bool Has(string path)
        {
            if (zip != null) return entries.ContainsKey(path);
            return File.Exists(System.IO.Path.Combine(root, path));
        }

        public byte[] ReadBytes(string path)
        {
            if (zip == null) return File.ReadAllBytes(System.IO.Path.Combine(root, path));
            ZipArchiveEntry e;
            if (!entries.TryGetValue(path, out e)) throw new FileNotFoundException("not in bundle: " + path, path);
            var buf = new byte[e.Length];
            using (Stream s = e.Open())
            {
                int off = 0;
                while (off < buf.Length)
                {
                    int n = s.Read(buf, off, buf.Length - off);
                    if (n <= 0) throw new EndOfStreamException("truncated bundle entry: " + path);
                    off += n;
                }
            }
            return buf;
        }

        public string ReadText(string path)
        {
            byte[] b = ReadBytes(path);
            int skip = b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF ? 3 : 0;
            return Encoding.UTF8.GetString(b, skip, b.Length - skip);
        }

        public JToken ReadJson(string path)
        {
            return HlJson.Parse(ReadText(path));
        }

        /// <summary>Reads a raw float32 grid; its header comes from index.json.</summary>
        public GridF32 ReadGrid(string path)
        {
            BundleFile f;
            if (!Index.Files.TryGetValue(path, out f) || f.Grid == null)
                throw new InvalidDataException("no grid header in index.json for " + path);
            return GridF32.FromBytes(f.Grid, ReadBytes(path), path);
        }

        /// <summary>
        /// Checks the bundle against its index: contract version, every listed file present with the stated size
        /// (and sha256 when <paramref name="hashes"/> is set), every grid 4 x rows x cols bytes. Returns the problems found.
        /// </summary>
        public List<string> Verify(bool hashes)
        {
            var problems = new List<string>();
            if (Index.ContractVersion == null || !Index.ContractVersion.StartsWith(SupportedContractMajor, StringComparison.Ordinal))
                problems.Add("unsupported contract version: " + Index.ContractVersion);
            if (Index.Dummy) problems.Add("bundle is flagged dummy");
            foreach (BundleFile f in Index.Files.Values)
            {
                if (!Has(f.Path))
                {
                    problems.Add("missing: " + f.Path);
                    continue;
                }
                long len = zip != null ? entries[f.Path].Length : new FileInfo(System.IO.Path.Combine(root, f.Path)).Length;
                if (len != f.Bytes) problems.Add("size mismatch: " + f.Path);
                if (f.Grid != null && f.Bytes != 4L * f.Grid.Rows * f.Grid.Cols) problems.Add("grid size mismatch: " + f.Path);
                if (hashes && !string.Equals(Sha256Hex(ReadBytes(f.Path)), f.Sha256, StringComparison.OrdinalIgnoreCase))
                    problems.Add("sha256 mismatch: " + f.Path);
            }
            return problems;
        }

        public static string Sha256Hex(byte[] data)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] h = sha.ComputeHash(data);
                var sb = new StringBuilder(h.Length * 2);
                for (int i = 0; i < h.Length; i++) sb.Append(h[i].ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        static BundleIndex ParseIndex(JToken j)
        {
            var ix = new BundleIndex();
            ix.SchemaVersion = HlJson.Str(j, "schema_version");
            ix.Kind = HlJson.Str(j, "kind");
            ix.BundleId = HlJson.Str(j, "bundle_id");
            ix.PlanId = HlJson.Str(j, "plan_id");
            ix.WorldVersion = HlJson.Str(j, "world_version");
            ix.EngineCommit = HlJson.Str(j, "engine_commit");
            ix.ConfigHash = HlJson.Str(j, "config_hash");
            ix.ContractVersion = HlJson.Str(j, "contract_version");
            ix.CreatedUtc = HlJson.Str(j, "created_utc");
            ix.Label = HlJson.Str(j, "label");
            ix.Dummy = HlJson.Bool(j, "dummy", false);
            ix.BoundsM = HlJson.Doubles(j["bounds_m"]);

            JToken fr = j["frame"];
            if (HlJson.IsNull(fr)) throw new InvalidDataException("index.json has no frame");
            JToken pad = fr["pad"];
            JToken proj = fr["projection"];
            double[] padXy = HlJson.Doubles(proj["pad_xy_m"]);
            var frame = new BundleFrame();
            frame.PadId = HlJson.Str(pad, "id");
            frame.PadLon = HlJson.Num(pad, "lon");
            frame.PadLat = HlJson.Num(pad, "lat");
            frame.PadElevM = HlJson.Num(pad, "elev_m");
            frame.Proj = HlJson.Str(proj, "proj");
            frame.PadProjX = padXy[0];
            frame.PadProjY = padXy[1];
            if (frame.Proj == null || frame.Proj.IndexOf("+proj=eqc", StringComparison.Ordinal) < 0)
                throw new InvalidDataException("unsupported projection (expected eqc): " + frame.Proj);
            frame.LatTsDeg = ProjParam(frame.Proj, "lat_ts");
            frame.Lon0Deg = ProjParam(frame.Proj, "lon_0");
            frame.RadiusM = ProjParam(frame.Proj, "R");
            ix.Frame = frame;

            foreach (JToken f in (JArray)j["files"])
            {
                var bf = new BundleFile();
                bf.Path = HlJson.Str(f, "path");
                bf.MediaType = HlJson.Str(f, "media_type");
                bf.Bytes = (long)HlJson.Num(f, "bytes");
                bf.Sha256 = HlJson.Str(f, "sha256");
                bf.Role = HlJson.Str(f, "role");
                bf.Frame = HlJson.Str(f, "frame");
                bf.Contract = HlJson.Str(f, "contract");
                bf.Status = HlJson.Str(f, "status");
                JToken g = f["grid"];
                if (g != null && g.Type == JTokenType.Object) bf.Grid = ParseGrid(g, bf.Path);
                ix.Files[bf.Path] = bf;
            }
            return ix;
        }

        static GridHeader ParseGrid(JToken g, string path)
        {
            string dtype = HlJson.Str(g, "dtype");
            string order = HlJson.Str(g, "byte_order");
            if (dtype != "float32" || order != "little")
                throw new InvalidDataException("unsupported grid encoding in " + path + ": " + dtype + "/" + order);
            double[] shape = HlJson.Doubles(g["shape"]);
            double[] origin = HlJson.Doubles(g["origin_m"]);
            var h = new GridHeader();
            h.Rows = (int)shape[0];
            h.Cols = (int)shape[1];
            h.CellM = HlJson.Num(g, "cell_m");
            h.OriginX = origin[0];
            h.OriginY = origin[1];
            double? nodata = HlJson.NumOrNull(g, "nodata");
            h.NoData = nodata.HasValue ? (float?)(float)nodata.Value : null;
            h.Units = HlJson.Str(g, "units");
            h.Value = HlJson.Str(g, "value");
            h.Quantum = HlJson.NumOrNull(g, "quantum");
            h.ZToFrameM = HlJson.NumOrNull(g, "z_to_frame_m");
            JToken st = g["stencil"];
            if (st != null && st.Type == JTokenType.Array)
            {
                var arr = (JArray)st;
                h.Stencil = new int[arr.Count][];
                for (int i = 0; i < arr.Count; i++)
                    h.Stencil[i] = new[] { (int)arr[i][0], (int)arr[i][1] };
            }
            return h;
        }

        static double ProjParam(string proj, string key)
        {
            string tag = "+" + key + "=";
            int i = proj.IndexOf(tag, StringComparison.Ordinal);
            if (i < 0) throw new InvalidDataException("projection has no " + key + ": " + proj);
            int a = i + tag.Length;
            int b = proj.IndexOf(" ", a, StringComparison.Ordinal);
            string v = b < 0 ? proj.Substring(a) : proj.Substring(a, b - a);
            return double.Parse(v, NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        public void Dispose()
        {
            if (zip != null) zip.Dispose();
            if (zipStream != null) zipStream.Dispose();
        }
    }
}

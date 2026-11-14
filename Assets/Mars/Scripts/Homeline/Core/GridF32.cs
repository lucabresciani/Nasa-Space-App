using System;
using System.IO;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// A planner grid in pad-local metres: raw little-endian float32, row-major, row 0 = northernmost row,
    /// column 0 = westernmost. Planner values are sampled by NEAREST CELL (the rule of the planner HUD) so they match
    /// the planner exactly; T_home and O2_home are looked up, never recomputed (handover rule 1).
    /// </summary>
    public sealed class GridF32
    {
        public readonly GridHeader Header;
        public readonly float[] Data;
        public readonly string Name;

        public int Rows { get { return Header.Rows; } }
        public int Cols { get { return Header.Cols; } }
        public double CellM { get { return Header.CellM; } }

        public GridF32(GridHeader header, float[] data, string name)
        {
            if (data.Length != header.Rows * header.Cols) throw new InvalidDataException("grid size mismatch: " + name);
            Header = header;
            Data = data;
            Name = name;
        }

        public static GridF32 FromBytes(GridHeader h, byte[] bytes, string name)
        {
            int n = h.Rows * h.Cols;
            if (bytes.Length != 4 * n)
                throw new InvalidDataException("grid " + name + ": expected " + (4 * n) + " bytes, got " + bytes.Length);
            var data = new float[n];
            if (BitConverter.IsLittleEndian)
            {
                Buffer.BlockCopy(bytes, 0, data, 0, bytes.Length);
            }
            else
            {
                var four = new byte[4];
                for (int i = 0; i < n; i++)
                {
                    four[0] = bytes[4 * i + 3];
                    four[1] = bytes[4 * i + 2];
                    four[2] = bytes[4 * i + 1];
                    four[3] = bytes[4 * i];
                    data[i] = BitConverter.ToSingle(four, 0);
                }
            }
            return new GridF32(h, data, name);
        }

        /// <summary>Cell that contains the pad-local point (x east, y north); false outside the grid.</summary>
        public bool TryCell(double x, double y, out int row, out int col)
        {
            col = (int)Math.Floor((x - Header.OriginX) / Header.CellM);
            row = (int)Math.Floor((Header.OriginY - y) / Header.CellM);
            return row >= 0 && row < Header.Rows && col >= 0 && col < Header.Cols;
        }

        /// <summary>Pad-local centre of a cell.</summary>
        public void CellCentre(int row, int col, out double x, out double y)
        {
            x = Header.OriginX + (col + 0.5) * Header.CellM;
            y = Header.OriginY - (row + 0.5) * Header.CellM;
        }

        public bool IsKnown(float v)
        {
            return !float.IsNaN(v) && (!Header.NoData.HasValue || v != Header.NoData.Value);
        }

        /// <summary>Raw cell value (may be nodata); null outside the grid.</summary>
        public float? RawAt(int row, int col)
        {
            if (row < 0 || row >= Header.Rows || col < 0 || col >= Header.Cols) return null;
            return Data[row * Header.Cols + col];
        }

        /// <summary>Planner value at a pad-local point by nearest cell; null = unknown (outside the grid or nodata).</summary>
        public double? ValueAt(double x, double y)
        {
            int r, c;
            if (!TryCell(x, y, out r, out c)) return null;
            float v = Data[r * Header.Cols + c];
            return IsKnown(v) ? (double?)v : null;
        }

        /// <summary>
        /// Largest known value among the cells whose centres lie within <paramref name="radiusM"/> of the point
        /// (discMax of the planner HUD, web/src/hud/fields.ts). <paramref name="anyUnknown"/> reports a nodata or
        /// off-grid cell inside the disc. Null when no known cell is inside.
        /// </summary>
        public double? DiscMax(double x, double y, double radiusM, out bool anyUnknown)
        {
            anyUnknown = false;
            double cell = Header.CellM;
            int c0 = (int)Math.Floor((x - radiusM - Header.OriginX) / cell);
            int c1 = (int)Math.Floor((x + radiusM - Header.OriginX) / cell);
            int r0 = (int)Math.Floor((Header.OriginY - (y + radiusM)) / cell);
            int r1 = (int)Math.Floor((Header.OriginY - (y - radiusM)) / cell);
            double r2 = radiusM * radiusM;
            double best = double.NegativeInfinity;
            bool found = false;
            for (int r = r0; r <= r1; r++)
            {
                for (int c = c0; c <= c1; c++)
                {
                    double cx = Header.OriginX + (c + 0.5) * cell;
                    double cy = Header.OriginY - (r + 0.5) * cell;
                    double dx = cx - x, dy = cy - y;
                    if (dx * dx + dy * dy > r2) continue;
                    if (r < 0 || r >= Header.Rows || c < 0 || c >= Header.Cols)
                    {
                        anyUnknown = true;
                        continue;
                    }
                    float v = Data[r * Header.Cols + c];
                    if (!IsKnown(v))
                    {
                        anyUnknown = true;
                        continue;
                    }
                    if (v > best) best = v;
                    found = true;
                }
            }
            return found ? (double?)best : null;
        }
    }
}

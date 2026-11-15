using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>One routed leg: the cells of the fastest walk from a start cell to an end cell, with running time and O2.</summary>
    public sealed class RoutedLeg
    {
        /// <summary>Cell centres in the grid's frame (pad-local metres, x east, y north), start to end.</summary>
        public double[] X, Y;
        /// <summary>Minutes since the start of the leg at each vertex.</summary>
        public double[] TauMin;
        /// <summary>Litres of O2 used since the start of the leg at each vertex.</summary>
        public double[] O2L;
        public double LengthM;
        public double TimeMin { get { return TauMin[TauMin.Length - 1]; } }
        public double O2TotalL { get { return O2L[O2L.Length - 1]; } }
        public int Count { get { return X.Length; } }
    }

    /// <summary>
    /// Time (min) and O2 (L) of the fastest walk home from every cell around a pad, computed by
    /// <see cref="GridRouter.HomeFieldOf"/>: the simulator's stand-in for the planner's way-home maps on pads that
    /// have none. Unknown (null) where the pad cannot be reached within the search limits.
    /// </summary>
    public sealed class HomeField
    {
        internal GridRouter Router;
        internal int R0, C0, H, W;
        internal float[] TMin, O2L;

        int Index(double x, double y)
        {
            int r, c;
            Router.CellOf(x, y, out r, out c);
            r -= R0;
            c -= C0;
            if (r < 0 || r >= H || c < 0 || c >= W) return -1;
            int i = r * W + c;
            return TMin[i] < 0 ? -1 : i;
        }

        public double? TAt(double x, double y)
        {
            int i = Index(x, y);
            return i < 0 ? (double?)null : TMin[i];
        }

        public double? O2At(double x, double y)
        {
            int i = Index(x, y);
            return i < 0 ? (double?)null : O2L[i];
        }
    }

    /// <summary>
    /// The planner's route search, re-implemented for the simulator so that a plan can be re-routed after a station
    /// is moved by hand (the planner's engine does not run inside the app). Same rules as the engine
    /// (pipeline/engine graph.py and dijkstra.py), checked against its legs:
    ///   nodes      the cells of the 3 m routing grid that the planner marks passable;
    ///   moves      the 16-move stencil (8 neighbours and 8 knight moves), not through impassable cells;
    ///   grade      atan2(elevation difference, horizontal length) of the move;
    ///   cost       horizontal length times the pace of the planner's grade table (linear between table rows),
    ///              infinite beyond the slope limit; the time is minimised and the O2 is summed along that path.
    /// Data: HomelineData/router (Tools/homeline-data/make_router_grid.py). On the official plan this reproduces the
    /// planner's five legs to 0.02 min and 0.05 L where the world pack has 1 m terrain; elsewhere the elevation is
    /// interpolated from the 8 m grid and leg times differ by about 2 %.
    /// The search is A* (straight distance at the fastest pace), which finds the same minimum time as the engine's
    /// Dijkstra; between two paths of equal time it may pick the other one.
    /// </summary>
    public sealed class GridRouter
    {
        static readonly int[] OffR = { -1, 1, 0, 0, -1, -1, 1, 1, -2, -2, 2, 2, -1, -1, 1, 1 };
        static readonly int[] OffC = { 0, 0, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -2, 2, -2, 2 };
        // Cells (relative to the move's origin) that a diagonal or knight move passes through; both must be passable.
        static readonly int[] CrossR1 = new int[16], CrossC1 = new int[16], CrossR2 = new int[16], CrossC2 = new int[16];
        static readonly bool[] HasCross = new bool[16];
        static readonly double[] UnitLen = new double[16];

        static GridRouter()
        {
            for (int k = 0; k < 16; k++)
            {
                int di = OffR[k], dj = OffC[k];
                UnitLen[k] = Math.Sqrt(di * di + dj * dj);
                if (Math.Abs(di) == 1 && Math.Abs(dj) == 1) { Set(k, di, 0, 0, dj); }
                else if (Math.Abs(di) == 2) { Set(k, di / 2, 0, di / 2, dj); }
                else if (Math.Abs(dj) == 2) { Set(k, 0, dj / 2, di, dj / 2); }
            }
        }

        static void Set(int k, int r1, int c1, int r2, int c2)
        {
            HasCross[k] = true;
            CrossR1[k] = r1; CrossC1[k] = c1; CrossR2[k] = r2; CrossC2[k] = c2;
        }

        public readonly int Rows, Cols;
        public readonly double CellM, OriginX, OriginY;
        readonly float[] elev;
        readonly float noData;
        readonly double[] pace, o2PerM;
        readonly double th0, dth, minPace;

        GridRouter(int rows, int cols, double cellM, double originX, double originY, float[] elev, float noData,
                   double[] pace, double[] o2PerM, double th0, double dth, double minPace)
        {
            Rows = rows; Cols = cols; CellM = cellM; OriginX = originX; OriginY = originY;
            this.elev = elev; this.noData = noData; this.pace = pace; this.o2PerM = o2PerM;
            this.th0 = th0; this.dth = dth; this.minPace = minPace;
        }

        /// <summary>Loads router.json, elev3.f32 and grade.f64 from a folder; null when the folder has no router data.</summary>
        public static GridRouter Load(string folder)
        {
            if (string.IsNullOrEmpty(folder)) return null;
            string metaPath = Path.Combine(folder, "router.json");
            string elevPath = Path.Combine(folder, "elev3.f32"), gradePath = Path.Combine(folder, "grade.f64");
            if (!File.Exists(metaPath) || !File.Exists(elevPath) || !File.Exists(gradePath)) return null;
            JToken m = HlJson.Parse(File.ReadAllText(metaPath));
            int rows = (int)HlJson.Num(m, "rows"), cols = (int)HlJson.Num(m, "cols"), n = (int)HlJson.Num(m, "grade_n");
            byte[] eb = File.ReadAllBytes(elevPath);
            if (eb.Length != rows * cols * 4) throw new InvalidDataException("elev3.f32 has the wrong size");
            var e = new float[rows * cols];
            Buffer.BlockCopy(eb, 0, e, 0, eb.Length);
            byte[] gb = File.ReadAllBytes(gradePath);
            if (gb.Length != n * 16) throw new InvalidDataException("grade.f64 has the wrong size");
            var p = new double[n];
            var o = new double[n];
            Buffer.BlockCopy(gb, 0, p, 0, n * 8);
            Buffer.BlockCopy(gb, n * 8, o, 0, n * 8);
            JArray origin = (JArray)m["origin_m"];
            return new GridRouter(rows, cols, HlJson.Num(m, "cell_m"), HlJson.ToDouble(origin[0]), HlJson.ToDouble(origin[1]),
                                  e, (float)HlJson.Num(m, "nodata"), p, o, HlJson.Num(m, "grade_th0_deg"),
                                  HlJson.Num(m, "grade_step_deg"), HlJson.Num(m, "min_pace_s_per_m"));
        }

        int allowR0, allowR1 = int.MaxValue, allowC0, allowC1 = int.MaxValue;

        /// <summary>
        /// Restricts routes to a box of the frame (x east, y north, metres): legs are searched inside it only and a
        /// leg with an end outside it has no route. Used to keep edited routes on the simulator's detailed terrain.
        /// </summary>
        public void SetAllowedRect(double minX, double minY, double maxX, double maxY)
        {
            int rTop, cLeft, rBottom, cRight;
            CellOf(minX, maxY, out rTop, out cLeft);
            CellOf(maxX, minY, out rBottom, out cRight);
            allowR0 = Math.Max(0, rTop);
            allowR1 = Math.Min(Rows, rBottom + 1);
            allowC0 = Math.Max(0, cLeft);
            allowC1 = Math.Min(Cols, cRight + 1);
        }

        /// <summary>True when the point lies inside the box set by <see cref="SetAllowedRect"/> (always, if none was set).</summary>
        public bool InAllowed(double x, double y)
        {
            int r, c;
            CellOf(x, y, out r, out c);
            return r >= allowR0 && r < allowR1 && c >= allowC0 && c < allowC1;
        }

        public void CellOf(double x, double y, out int row, out int col)
        {
            row = (int)Math.Floor((OriginY - y) / CellM);
            col = (int)Math.Floor((x - OriginX) / CellM);
        }

        public void CentreOf(int row, int col, out double x, out double y)
        {
            x = OriginX + (col + 0.5) * CellM;
            y = OriginY - (row + 0.5) * CellM;
        }

        public bool Passable(int row, int col)
        {
            return row >= 0 && row < Rows && col >= 0 && col < Cols && elev[row * Cols + col] != noData;
        }

        /// <summary>The passable cell nearest to a point, searched up to <paramref name="maxM"/> away; false if none.</summary>
        public bool NearestPassable(double x, double y, double maxM, out int row, out int col)
        {
            int r0, c0;
            CellOf(x, y, out r0, out c0);
            int reach = (int)Math.Ceiling(maxM / CellM);
            double best = double.MaxValue;
            row = col = -1;
            for (int dr = -reach; dr <= reach; dr++)
            {
                for (int dc = -reach; dc <= reach; dc++)
                {
                    if (!Passable(r0 + dr, c0 + dc)) continue;
                    double cx, cy;
                    CentreOf(r0 + dr, c0 + dc, out cx, out cy);
                    double d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
                    if (d < best && d <= maxM * maxM + 1e-9)
                    {
                        best = d;
                        row = r0 + dr;
                        col = c0 + dc;
                    }
                }
            }
            return row >= 0;
        }

        /// <summary>
        /// Fastest walk between two points (snapped to their cells). The search is tried in a box around the two
        /// cells, widened twice before the whole grid is used; null when the end cannot be reached.
        /// </summary>
        public RoutedLeg Route(double fromX, double fromY, double toX, double toY)
        {
            int sr, sc, tr, tc;
            CellOf(fromX, fromY, out sr, out sc);
            CellOf(toX, toY, out tr, out tc);
            if (!Passable(sr, sc) || !Passable(tr, tc)) return null;
            foreach (double marginM in new[] { 450.0, 1500.0, -1.0 })
            {
                RoutedLeg leg = Search(sr, sc, tr, tc, marginM);
                if (leg != null) return leg;
            }
            return null;
        }

        /// <summary>
        /// The way-home map of a pad, computed here as the planner computes its own (reverse search from the pad):
        /// for every cell, the time and the O2 of the fastest walk to the pad. Cells farther than
        /// <paramref name="maxMin"/> minutes, or outside the box of <paramref name="windowM"/> metres around the
        /// pad, stay unknown. Used for pads that have no planner way-home map; null when the pad is not walkable.
        /// </summary>
        public HomeField HomeFieldOf(double padX, double padY, double maxMin, double windowM)
        {
            int pr, pc;
            if (!NearestPassable(padX, padY, 2.0 * CellM, out pr, out pc)) return null;
            int m = (int)Math.Round(windowM / CellM);
            int r0 = Math.Max(0, pr - m), r1 = Math.Min(Rows, pr + m + 1), c0 = Math.Max(0, pc - m), c1 = Math.Min(Cols, pc + m + 1);
            int h = r1 - r0, w = c1 - c0;
            var time = new double[h * w];
            var o2 = new float[h * w];
            var done = new bool[h * w];
            for (int i = 0; i < time.Length; i++) time[i] = double.PositiveInfinity;
            int cap = 1 << 18, size = 1;
            var hk = new double[cap];
            var hv = new int[cap];
            int seed = (pr - r0) * w + (pc - c0);
            time[seed] = 0;
            hk[0] = 0;
            hv[0] = seed;
            const double rad2deg = 180.0 / Math.PI;
            int ntab = pace.Length;
            double maxS = maxMin * 60.0;

            while (size > 0)
            {
                double key = hk[0];
                int idx = hv[0];
                size--;
                hk[0] = hk[size];
                hv[0] = hv[size];
                int i = 0;
                while (true)
                {
                    int lft = 2 * i + 1;
                    if (lft >= size) break;
                    int mm = lft;
                    if (lft + 1 < size && hk[lft + 1] < hk[lft]) mm = lft + 1;
                    if (hk[i] <= hk[mm]) break;
                    double tk = hk[mm]; hk[mm] = hk[i]; hk[i] = tk;
                    int tv = hv[mm]; hv[mm] = hv[i]; hv[i] = tv;
                    i = mm;
                }
                if (done[idx] || key > time[idx]) continue;
                if (key > maxS) break;
                done[idx] = true;
                int r = idx / w, c = idx - r * w;
                double g = time[idx];
                float ze = elev[(r + r0) * Cols + c + c0];
                for (int k = 0; k < 16; k++)
                {
                    // The move k goes FROM the neighbour n TO this cell: n = this cell minus the move.
                    int nr = r - OffR[k], nc = c - OffC[k];
                    if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
                    int nidx = nr * w + nc;
                    if (done[nidx]) continue;
                    float zn = elev[(nr + r0) * Cols + nc + c0];
                    if (zn == noData) continue;
                    if (HasCross[k])
                    {
                        int ar = nr + CrossR1[k], ac = nc + CrossC1[k], br = nr + CrossR2[k], bc = nc + CrossC2[k];
                        if (ar < 0 || ar >= h || ac < 0 || ac >= w || br < 0 || br >= h || bc < 0 || bc >= w) continue;
                        if (elev[(ar + r0) * Cols + ac + c0] == noData || elev[(br + r0) * Cols + bc + c0] == noData) continue;
                    }
                    double length = CellM * UnitLen[k];
                    double theta = Math.Atan2((double)ze - zn, length) * rad2deg;
                    double f = (theta - th0) / dth;
                    int i0 = (int)f;
                    if (i0 < 0) i0 = 0;
                    else if (i0 > ntab - 2) i0 = ntab - 2;
                    double wgt = f - i0, p0 = pace[i0], p1 = pace[i0 + 1];
                    if (double.IsInfinity(p0) || double.IsInfinity(p1) || double.IsNaN(p0) || double.IsNaN(p1)) continue;
                    double nt = g + length * (p0 + wgt * (p1 - p0));
                    if (nt < time[nidx])
                    {
                        time[nidx] = nt;
                        o2[nidx] = (float)(o2[idx] + length * (o2PerM[i0] + wgt * (o2PerM[i0 + 1] - o2PerM[i0])));
                        if (size == cap)
                        {
                            cap *= 2;
                            Array.Resize(ref hk, cap);
                            Array.Resize(ref hv, cap);
                        }
                        int j = size++;
                        hk[j] = nt;
                        hv[j] = nidx;
                        while (j > 0)
                        {
                            int par = (j - 1) >> 1;
                            if (hk[par] <= hk[j]) break;
                            double tk = hk[par]; hk[par] = hk[j]; hk[j] = tk;
                            int tv = hv[par]; hv[par] = hv[j]; hv[j] = tv;
                            j = par;
                        }
                    }
                }
            }

            var field = new HomeField { Router = this, R0 = r0, C0 = c0, H = h, W = w, TMin = new float[h * w], O2L = o2 };
            for (int i = 0; i < time.Length; i++) field.TMin[i] = done[i] ? (float)(time[i] / 60.0) : -1f;
            return field;
        }

        RoutedLeg Search(int sr, int sc, int tr, int tc, double marginM)
        {
            int r0 = 0, r1 = Rows, c0 = 0, c1 = Cols;
            if (marginM >= 0)
            {
                int m = (int)Math.Round(marginM / CellM);
                r0 = Math.Max(0, Math.Min(sr, tr) - m);
                r1 = Math.Min(Rows, Math.Max(sr, tr) + m + 1);
                c0 = Math.Max(0, Math.Min(sc, tc) - m);
                c1 = Math.Min(Cols, Math.Max(sc, tc) + m + 1);
            }
            // Routes stay inside the allowed box (the simulator's detailed terrain), whatever the search window.
            r0 = Math.Max(r0, allowR0);
            r1 = Math.Min(r1, allowR1);
            c0 = Math.Max(c0, allowC0);
            c1 = Math.Min(c1, allowC1);
            if (sr < r0 || sr >= r1 || sc < c0 || sc >= c1 || tr < r0 || tr >= r1 || tc < c0 || tc >= c1) return null;
            int h = r1 - r0, w = c1 - c0;
            var time = new double[h * w];
            var o2 = new float[h * w];
            var ptr = new sbyte[h * w];
            var done = new bool[h * w];
            for (int i = 0; i < time.Length; i++)
            {
                time[i] = double.PositiveInfinity;
                ptr[i] = -1;
            }
            int cap = 1 << 16, size = 0;
            var hk = new double[cap];
            var hv = new int[cap];
            int start = (sr - r0) * w + (sc - c0), goal = (tr - r0) * w + (tc - c0);
            time[start] = 0;
            o2[start] = 0;
            hk[0] = minPace * CellM * Math.Sqrt((double)(sr - tr) * (sr - tr) + (double)(sc - tc) * (sc - tc));
            hv[0] = start;
            size = 1;
            const double rad2deg = 180.0 / Math.PI;
            int ntab = pace.Length;
            bool found = false;

            while (size > 0)
            {
                int idx = hv[0];
                size--;
                hk[0] = hk[size];
                hv[0] = hv[size];
                int i = 0;
                while (true)
                {
                    int lft = 2 * i + 1;
                    if (lft >= size) break;
                    int m = lft;
                    if (lft + 1 < size && hk[lft + 1] < hk[lft]) m = lft + 1;
                    if (hk[i] <= hk[m]) break;
                    double tk = hk[m]; hk[m] = hk[i]; hk[i] = tk;
                    int tv = hv[m]; hv[m] = hv[i]; hv[i] = tv;
                    i = m;
                }
                if (done[idx]) continue;
                done[idx] = true;
                if (idx == goal)
                {
                    found = true;
                    break;
                }
                int r = idx / w, c = idx - r * w;
                double g = time[idx];
                float ze = elev[(r + r0) * Cols + c + c0];
                for (int k = 0; k < 16; k++)
                {
                    int nr = r + OffR[k], nc = c + OffC[k];
                    if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
                    int nidx = nr * w + nc;
                    if (done[nidx]) continue;
                    float zn = elev[(nr + r0) * Cols + nc + c0];
                    if (zn == noData) continue;
                    if (HasCross[k])
                    {
                        int ar = r + CrossR1[k], ac = c + CrossC1[k], br = r + CrossR2[k], bc = c + CrossC2[k];
                        if (ar < 0 || ar >= h || ac < 0 || ac >= w || br < 0 || br >= h || bc < 0 || bc >= w) continue;
                        if (elev[(ar + r0) * Cols + ac + c0] == noData || elev[(br + r0) * Cols + bc + c0] == noData) continue;
                    }
                    double length = CellM * UnitLen[k];
                    double theta = Math.Atan2((double)zn - ze, length) * rad2deg;
                    double f = (theta - th0) / dth;
                    int i0 = (int)f;
                    if (i0 < 0) i0 = 0;
                    else if (i0 > ntab - 2) i0 = ntab - 2;
                    double wgt = f - i0, p0 = pace[i0], p1 = pace[i0 + 1];
                    if (double.IsInfinity(p0) || double.IsInfinity(p1) || double.IsNaN(p0) || double.IsNaN(p1)) continue;
                    double nt = g + length * (p0 + wgt * (p1 - p0));
                    if (nt < time[nidx])
                    {
                        time[nidx] = nt;
                        o2[nidx] = (float)(o2[idx] + length * (o2PerM[i0] + wgt * (o2PerM[i0 + 1] - o2PerM[i0])));
                        ptr[nidx] = (sbyte)k;
                        double dr = nr + r0 - tr, dc = nc + c0 - tc;
                        double key = nt + minPace * CellM * Math.Sqrt(dr * dr + dc * dc);
                        if (size == cap)
                        {
                            cap *= 2;
                            Array.Resize(ref hk, cap);
                            Array.Resize(ref hv, cap);
                        }
                        int j = size++;
                        hk[j] = key;
                        hv[j] = nidx;
                        while (j > 0)
                        {
                            int par = (j - 1) >> 1;
                            if (hk[par] <= hk[j]) break;
                            double tk = hk[par]; hk[par] = hk[j]; hk[j] = tk;
                            int tv = hv[par]; hv[par] = hv[j]; hv[j] = tv;
                            j = par;
                        }
                    }
                }
            }
            if (!found) return null;

            var cells = new List<int>();
            int cur = goal;
            while (true)
            {
                cells.Add(cur);
                int k = ptr[cur];
                if (k < 0) break;
                cur -= OffR[k] * w + OffC[k];
            }
            cells.Reverse();
            int n = cells.Count;
            var leg = new RoutedLeg { X = new double[n], Y = new double[n], TauMin = new double[n], O2L = new double[n] };
            for (int i = 0; i < n; i++)
            {
                int r = cells[i] / w, c = cells[i] - r * w;
                CentreOf(r + r0, c + c0, out leg.X[i], out leg.Y[i]);
                leg.TauMin[i] = time[cells[i]] / 60.0;
                leg.O2L[i] = o2[cells[i]];
                if (i > 0) leg.LengthM += Math.Sqrt((leg.X[i] - leg.X[i - 1]) * (leg.X[i] - leg.X[i - 1]) + (leg.Y[i] - leg.Y[i - 1]) * (leg.Y[i] - leg.Y[i - 1]));
            }
            return leg;
        }
    }
}

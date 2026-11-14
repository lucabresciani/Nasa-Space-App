using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline.Tests
{
    /// <summary>Bundle reading, grids and coordinate frame, against the official-pad fixture (plan rank1.nom_104).</summary>
    public static class BundleTests
    {
        public static void Run(string fixture)
        {
            using (BundleReader plan = BundleReader.Open(Path.Combine(fixture, "plan_bundle.zip")))
            using (BundleReader world = BundleReader.Open(Path.Combine(fixture, "world_pack.zip")))
            {
                // Identity and integrity: every file matches the size and sha256 its index states.
                T.Eq(plan.Index.Kind, "plan", "plan bundle kind");
                T.Eq(world.Index.Kind, "world", "world pack kind");
                T.Eq(plan.Index.PlanId, "rank1.nom_104", "plan id");
                T.Eq(plan.Index.WorldVersion, world.Index.WorldVersion, "plan names the world pack it was built against");
                T.Eq(plan.Index.Label, "Simulated EVA · real terrain and data", "mandatory label, read as UTF-8");
                List<string> p1 = plan.Verify(true);
                T.True(p1.Count == 0, "plan bundle verifies (" + string.Join("; ", p1) + ")");
                List<string> p2 = world.Verify(true);
                T.True(p2.Count == 0, "world pack verifies (" + string.Join("; ", p2) + ")");

                // Frame: the official pad (D21/D42) and the planner projection.
                BundleFrame f = plan.Index.Frame;
                T.Near(f.PadLon, 137.401783, 1e-9, "pad lon");
                T.Near(f.PadLat, -4.77748, 1e-9, "pad lat");
                T.Near(f.PadElevM, -3742.4, 1e-6, "pad elevation");
                T.Near(f.LatTsDeg, -4.8, 1e-12, "lat_ts");
                T.Near(f.Lon0Deg, 137.39, 1e-12, "lon_0");
                T.Near(f.RadiusM, 3396190, 1e-6, "sphere radius");

                var frame = new PadFrame(f, Program.Scene);
                double x, y, lon, lat, wx, wz;
                frame.LonLatToLocal(f.PadLon, f.PadLat, out x, out y);
                T.Near(x, 0, 1e-3, "pad is the origin (x)");
                T.Near(y, 0, 1e-3, "pad is the origin (y)");
                frame.LocalToLonLat(-1234.5, 678.9, out lon, out lat);
                frame.LonLatToLocal(lon, lat, out x, out y);
                T.Near(x, -1234.5, 1e-6, "lon/lat round trip (x)");
                T.Near(y, 678.9, 1e-6, "lon/lat round trip (y)");
                frame.LocalToWorld(0, 0, out wx, out wz);
                T.Near(wx, 1014.096, 0.01, "pad in the Unity world (X east)");
                T.Near(wz, 1475.186, 0.01, "pad in the Unity world (Z north)");
                frame.WorldToLocal(wx, wz, out x, out y);
                T.Near(x, 0, 1e-6, "world round trip (x)");
                T.Near(y, 0, 1e-6, "world round trip (y)");

                // points.json states both lon/lat and pad-local metres for every point: they must agree.
                JToken points = plan.ReadJson("points.json");
                int checkedPoints = 0;
                foreach (JToken p in (JArray)points["points"])
                {
                    frame.LonLatToLocal(HlJson.Num(p, "lon"), HlJson.Num(p, "lat"), out x, out y);
                    // lon/lat are rounded to 6 decimals in the planner files (about 0.06 m).
                    T.Near(x, HlJson.Num(p, "x_m"), 0.1, "point " + HlJson.Str(p, "id") + " x");
                    T.Near(y, HlJson.Num(p, "y_m"), 0.1, "point " + HlJson.Str(p, "id") + " y");
                    checkedPoints++;
                }
                T.True(checkedPoints == 13, "13 points (pad, 6 stations, 6 access cells), got " + checkedPoints);

                // Fields: T_home and O2_home are 0 at the pad and unknown off the grid.
                GridF32 tHome = plan.ReadGrid("fields/t_home.f32");
                GridF32 o2Home = plan.ReadGrid("fields/o2_home.f32");
                T.True(tHome.Rows == 1480 && tHome.Cols == 1480, "t_home is 1480 x 1480");
                T.Near(tHome.CellM, 5.0, 1e-12, "t_home cell size");
                T.Near(tHome.ValueAt(0, 0), 0.0, 0.25, "T_home at the pad");
                T.Near(o2Home.ValueAt(0, 0), 0.0, 0.5, "O2_home at the pad");
                T.True(!tHome.ValueAt(1e6, 0).HasValue, "off-grid lookup is unknown");

                // S7 is the first station of the plan: the timeline says T_home 45.42 min on arrival (t = 44.39).
                T.Near(tHome.ValueAt(-1680.037, -729.020), 45.42, 0.5, "T_home at S7 (timeline arrive row)");

                bool anyUnknown;
                double? worst = tHome.DiscMax(0, 0, 50, out anyUnknown);
                T.True(worst.HasValue && worst.Value >= tHome.ValueAt(0, 0).Value, "discMax is at least the point value");

                // Pointer grid: 3 m routing grid with the 16-neighbour stencil.
                GridF32 pointer = plan.ReadGrid("fields/pointer.f32");
                T.True(pointer.Rows == 2468 && pointer.Header.Stencil != null && pointer.Header.Stencil.Length == 16,
                    "pointer is 2468 x 2468 with a 16-move stencil");

                // World pack: slope on the same 5 m grid as the fields; cell states on the 3 m routing grid.
                GridF32 slope = world.ReadGrid("terrain/slope.f32");
                T.True(slope.Rows == tHome.Rows && slope.Header.OriginX == tHome.Header.OriginX, "slope shares the fields grid");
                T.True(slope.ValueAt(0, 0).HasValue, "slope is known at the pad");
                GridF32 cells = world.ReadGrid("terrain/cellstate_nominal.f32");
                T.Near(cells.ValueAt(0, 0), 0.0, 1e-6, "the pad cell is assessed (state 0)");
            }
        }
    }
}

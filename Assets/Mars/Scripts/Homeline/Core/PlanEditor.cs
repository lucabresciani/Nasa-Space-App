using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>A stop of a plan being edited: a station at a point of the frame, with its planned work time.</summary>
    public sealed class EditStop
    {
        public string Id;
        public double X, Y;
        public double DwellMin;
    }

    /// <summary>What the editor needs besides the stops: the router, the planner's numbers and its way-home maps.</summary>
    public sealed class EditContext
    {
        public GridRouter Router;
        public HlConfig Config;
        public double? TDarkMin;
        /// <summary>The storm as timed for the official plan; re-timed for the edited route (may be null).</summary>
        public StormTrack Storm;
        public GridF32 THome, O2Home;
        public double PadX, PadY;
        public string Scenario;
        /// <summary>Minutes between O2 checkpoint rows of the timeline (the planner uses 30).</summary>
        public double CheckpointMin = 30.0;
    }

    /// <summary>An edited plan in the planner's own file shapes, ready for <see cref="MissionPlan.FromEdited"/>.</summary>
    public sealed class EditedPlanData
    {
        public JObject RouteGeoJson;
        public JArray TimelineRows;
        public StormTrack Storm;
        public double EndMin, O2AtReturnL;
        /// <summary>The smallest margin of the timeline, where it occurs and which limit binds there.</summary>
        public double MinMarginMin, MinMarginAtMin;
        public string MinMarginBinding, MinMarginWhere;
        public bool Feasible { get { return MinMarginMin >= 0; } }
    }

    /// <summary>
    /// Rebuilds a plan after stations were moved by hand: routes each leg with <see cref="GridRouter"/> and writes
    /// the timeline with the planner's formulas (pipeline/engine/margin.py):
    ///   O2 left      capacity - O2 walked - station work done (work at the planner's task rate)
    ///   margin       min( (O2 left - O2 home - work left at this station - reserve) / effort rate,
    ///                     t_dark - t - T_home,  tau_dose(t) - T_home,  EVA budget - t - T_home )
    ///   storm        re-timed as the planner does: its tripwire fires at the route minute where T_home is largest.
    /// T_home and O2 home come from the planner's way-home maps of the pad, so the pad itself cannot be moved.
    /// This is the simulator's re-computation with the planner's model, NOT output of the planner engine: station
    /// order is kept as planned (the engine would also re-optimise it), and no turn-back rows are written.
    /// </summary>
    public static class PlanEditor
    {
        public const string LabelRerouted = "Re-routed by the simulator with the planner's cost model after a manual edit. Not planner engine output.";

        /// <summary>Returns null when a leg cannot be routed (a stop on impassable ground or cut off).</summary>
        public static EditedPlanData Build(EditContext ctx, PadFrame frame, IList<EditStop> stops)
        {
            int n = stops.Count;
            var legs = new RoutedLeg[n + 1];
            for (int i = 0; i <= n; i++)
            {
                double ax = i == 0 ? ctx.PadX : stops[i - 1].X, ay = i == 0 ? ctx.PadY : stops[i - 1].Y;
                double bx = i == n ? ctx.PadX : stops[i].X, by = i == n ? ctx.PadY : stops[i].Y;
                legs[i] = ctx.Router.Route(ax, ay, bx, by);
                if (legs[i] == null) return null;
            }

            // Pass 1: leg start times, and the route minute where the way home is longest (storm re-timing).
            var legStart = new double[n + 1];
            double clock = 0, worstHome = -1, tStar = 0;
            for (int i = 0; i <= n; i++)
            {
                legStart[i] = clock;
                RoutedLeg leg = legs[i];
                for (int v = 0; v < leg.Count; v++)
                {
                    double? th = ctx.THome != null ? ctx.THome.ValueAt(leg.X[v], leg.Y[v]) : null;
                    if (th.HasValue && th.Value > worstHome)
                    {
                        worstHome = th.Value;
                        tStar = clock + leg.TauMin[v];
                    }
                }
                clock += leg.TimeMin;
                if (i < n) clock += stops[i].DwellMin;
            }
            StormTrack storm = ctx.Storm != null && worstHome >= 0 ? ctx.Storm.Retimed(tStar) : ctx.Storm;

            var data = new EditedPlanData { Storm = storm, MinMarginMin = double.PositiveInfinity };
            var rows = new JArray();
            var features = new JArray();
            double used = 0;                       // litres of O2 used so far
            double nextCheckpoint = ctx.CheckpointMin;
            AddRow(ctx, storm, data, rows, 0, "depart", null, ctx.PadX, ctx.PadY, used, 0, "the rover");

            for (int i = 0; i <= n; i++)
            {
                RoutedLeg leg = legs[i];
                double t0 = legStart[i], t1 = t0 + leg.TimeMin;
                string from = i == 0 ? "pad" : stops[i - 1].Id, to = i == n ? "pad" : stops[i].Id;

                var coords = new JArray();
                var times = new JArray();
                for (int v = 0; v < leg.Count; v++)
                {
                    double lon, lat;
                    frame.LocalToLonLat(leg.X[v], leg.Y[v], out lon, out lat);
                    coords.Add(new JArray(lon, lat));
                    times.Add(t0 + leg.TauMin[v]);
                }
                var props = new JObject();
                props["leg"] = i + 1;
                props["from"] = from;
                props["to"] = to;
                props["t_min"] = leg.TimeMin;
                props["o2_L"] = leg.O2TotalL;
                props["length_m"] = leg.LengthM;
                props["t_start_min"] = t0;
                props["t_end_min"] = t1;
                props["times_min"] = times;
                props["to_access_dist_m"] = 0.0;
                var geom = new JObject();
                geom["type"] = "LineString";
                geom["coordinates"] = coords;
                var feature = new JObject();
                feature["type"] = "Feature";
                feature["properties"] = props;
                feature["geometry"] = geom;
                features.Add(feature);

                // Checkpoints while walking this leg.
                int seg = 1;
                while (nextCheckpoint < t1 - 1e-9)
                {
                    double tau = nextCheckpoint - t0;
                    while (seg < leg.Count - 1 && leg.TauMin[seg] < tau) seg++;
                    double span = leg.TauMin[seg] - leg.TauMin[seg - 1];
                    double f = span > 1e-12 ? (tau - leg.TauMin[seg - 1]) / span : 0;
                    double x = leg.X[seg - 1] + f * (leg.X[seg] - leg.X[seg - 1]);
                    double y = leg.Y[seg - 1] + f * (leg.Y[seg] - leg.Y[seg - 1]);
                    double o2 = leg.O2L[seg - 1] + f * (leg.O2L[seg] - leg.O2L[seg - 1]);
                    AddRow(ctx, storm, data, rows, nextCheckpoint, "o2_checkpoint", null, x, y, used + o2, 0, "the walk to " + (i == n ? "the rover" : to));
                    nextCheckpoint += ctx.CheckpointMin;
                }
                used += leg.O2TotalL;

                if (i == n)
                {
                    AddRow(ctx, storm, data, rows, t1, "return", null, ctx.PadX, ctx.PadY, used, 0, "the rover");
                    data.EndMin = t1;
                    data.O2AtReturnL = ctx.Config.O2CapacityL - used;
                    break;
                }

                EditStop s = stops[i];
                double leave = t1 + s.DwellMin, rate = ctx.Config.TaskRateLMin;
                AddRow(ctx, storm, data, rows, t1, "arrive", s.Id, s.X, s.Y, used, s.DwellMin * rate, s.Id);
                while (nextCheckpoint < leave - 1e-9)
                {
                    if (nextCheckpoint > t1 + 1e-9)
                        AddRow(ctx, storm, data, rows, nextCheckpoint, "o2_checkpoint", null, s.X, s.Y,
                               used + (nextCheckpoint - t1) * rate, (leave - nextCheckpoint) * rate, s.Id);
                    nextCheckpoint += ctx.CheckpointMin;
                }
                used += s.DwellMin * rate;
                AddRow(ctx, storm, data, rows, leave, "leave", s.Id, s.X, s.Y, used, 0, s.Id);
            }

            var geojson = new JObject();
            geojson["type"] = "FeatureCollection";
            geojson["features"] = features;
            data.RouteGeoJson = geojson;
            data.TimelineRows = rows;
            return data;
        }

        /// <summary>The planner's margin from a state; null terms are left out. Returns false when nothing is known.</summary>
        public static bool Margin(HlConfig cfg, double? tDarkMin, StormTrack storm, double tMin, double o2LeftL,
                                  double? tHomeMin, double? o2HomeL, double tasksLeftL, out double margin, out string binding)
        {
            margin = double.PositiveInfinity;
            binding = null;
            if (!tHomeMin.HasValue || !o2HomeL.HasValue) return false;
            margin = (o2LeftL - o2HomeL.Value - tasksLeftL - cfg.O2ReserveL) / cfg.EffortRateLMin;
            binding = "O2";
            if (tDarkMin.HasValue && tDarkMin.Value - tMin - tHomeMin.Value < margin)
            {
                margin = tDarkMin.Value - tMin - tHomeMin.Value;
                binding = "daylight";
            }
            if (storm != null && storm.TauDoseMin(tMin) - tHomeMin.Value < margin)
            {
                margin = storm.TauDoseMin(tMin) - tHomeMin.Value;
                binding = "dose";
            }
            if (cfg.EvaBudgetMin - tMin - tHomeMin.Value < margin)
            {
                margin = cfg.EvaBudgetMin - tMin - tHomeMin.Value;
                binding = "EVA duration";
            }
            return true;
        }

        static void AddRow(EditContext ctx, StormTrack storm, EditedPlanData data, JArray rows, double t, string ev, string station,
                           double x, double y, double usedL, double tasksLeftL, string where)
        {
            double o2Left = ctx.Config.O2CapacityL - usedL;
            bool atPad = ev == "depart" || ev == "return";
            double? tHome = atPad ? 0 : (ctx.THome != null ? ctx.THome.ValueAt(x, y) : null);
            double? o2Home = atPad ? 0 : (ctx.O2Home != null ? ctx.O2Home.ValueAt(x, y) : null);
            var row = new JObject();
            row["t_min"] = t;
            row["event"] = ev;
            if (station != null) row["station"] = station;
            row["o2_left_L"] = o2Left;
            if (tHome.HasValue) row["t_home_min"] = tHome.Value;
            row["o2_tasks_left_L"] = tasksLeftL;
            double margin;
            string binding;
            if (Margin(ctx.Config, ctx.TDarkMin, storm, t, o2Left, tHome, o2Home, tasksLeftL, out margin, out binding))
            {
                row["margin_min"] = margin;
                row["margin_binding"] = binding;
                if (margin < data.MinMarginMin)
                {
                    data.MinMarginMin = margin;
                    data.MinMarginBinding = binding;
                    data.MinMarginAtMin = t;
                    data.MinMarginWhere = where;
                }
            }
            if (station != null) row["access_dist_m"] = 0.0;
            rows.Add(row);
        }
    }
}

using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// One row of planner/timeline_{scenario}.json (contracts/timeline.schema.json v1.1.3, written by
    /// pipeline/engine/traverse.py). Every number is the planner's; null = the row does not state it.
    /// </summary>
    public sealed class TimelineRow
    {
        public double TMin;
        /// <summary>depart, arrive, leave, return, o2_checkpoint, turn_back (other strings are allowed by the contract).</summary>
        public string Event;
        public string Station;
        public double? O2LeftL;
        public double? THomeMin;
        public double? MarginMin;
        /// <summary>"O2", "daylight", "dose", "EVA duration", or null = unknown at this row.</summary>
        public string MarginBinding;
        /// <summary>False when the row has no margin_binding property at all (optional since contract v1.1.0).</summary>
        public bool HasMarginBinding;
        public double? O2TasksLeftL;
        public double? O2MarginMinPlanningRate;
        public bool? InPartnerLine;
        public double? AccessDistM;
    }

    /// <summary>A planned stay at a station: from its arrive row to its leave row (Dwell of web/src/hud/plan.ts).</summary>
    public sealed class TimelineDwell
    {
        public string Station;
        public double ArriveMin;
        public double LeaveMin;
        public double DurationMin { get { return LeaveMin - ArriveMin; } }
    }

    /// <summary>A planned walk: from a depart/leave row to the next arrive/return row (the walk segments of web/src/hud/plan.ts).</summary>
    public sealed class TimelineWalk
    {
        /// <summary>Station left; null = the pad.</summary>
        public string From;
        /// <summary>Station reached; null = the pad.</summary>
        public string To;
        public double StartMin;
        public double EndMin;
    }

    /// <summary>
    /// The planner's turn_back row of a station (turnBackAt of web/src/hud/plan.ts; pipeline/engine/margin.py latest
    /// departure, D28): the latest time to leave the station, where the margin reaches 0, and the term that binds.
    /// </summary>
    public sealed class TimelineTurnBack
    {
        public string Station;
        public double TMin;
        public string Binding;
        public TimelineRow Row;
    }

    /// <summary>A planned station arrival (nextArrival of web/src/hud/plan.ts).</summary>
    public sealed class TimelineArrival
    {
        public string Station;
        public double TMin;
    }

    /// <summary>
    /// The planned EVA in time: planner/timeline_{scenario}.json of a plan bundle, with the semantics of
    /// web/src/hud/plan.ts (constructor, interpSeries, headroomAt, o2LeftAt, bindingAt, turnBackAt, nextArrival).
    /// Lookups and interpolation of planner rows only. The turn_back rows are per-station latest departures written
    /// after the return: they are annotations and never enter the walk series, the interpolation or the end time.
    /// </summary>
    public sealed class Timeline
    {
        readonly List<TimelineRow> events = new List<TimelineRow>();
        readonly List<TimelineRow> turnBacks = new List<TimelineRow>();
        readonly List<TimelineDwell> dwells = new List<TimelineDwell>();
        readonly List<TimelineWalk> walks = new List<TimelineWalk>();
        double[] headroomT, headroomV, o2T, o2V;

        /// <summary>The walk series: every row except turn_back, by time (stable).</summary>
        public IReadOnlyList<TimelineRow> Events { get { return events; } }
        /// <summary>The turn_back rows, by time.</summary>
        public IReadOnlyList<TimelineRow> TurnBacks { get { return turnBacks; } }
        public IReadOnlyList<TimelineDwell> Dwells { get { return dwells; } }
        public IReadOnlyList<TimelineWalk> Walks { get { return walks; } }
        /// <summary>Planned end of the EVA: the time of the last row of the walk series (tEnd of plan.ts); 0 when empty.</summary>
        public double EndMin { get; private set; }
        /// <summary>The row of the return to the pad ("return"; "arrive_home" in old dummies); null when there is none.</summary>
        public TimelineRow ReturnRow { get; private set; }
        /// <summary>False when no row of the walk series has a margin_binding property (then BindingAt says nothing).</summary>
        public bool HasBinding { get; private set; }

        Timeline()
        {
        }

        /// <summary>Reads planner/timeline_{scenario}.json; the scenario id comes from plan.json when not given.</summary>
        public static Timeline FromBundle(BundleReader plan, string scenarioId = null)
        {
            if (scenarioId == null) scenarioId = HlJson.Str(plan.ReadJson("plan.json")["scenario"], "id");
            if (string.IsNullOrEmpty(scenarioId)) throw new InvalidDataException("plan.json has no scenario id");
            return Parse(plan.ReadJson("planner/timeline_" + scenarioId + ".json"));
        }

        /// <summary>Parses a timeline document (a JSON array of rows).</summary>
        public static Timeline Parse(JToken rows)
        {
            JArray arr = rows as JArray;
            if (arr == null) throw new InvalidDataException("timeline is not an array");
            var all = new List<TimelineRow>(arr.Count);
            foreach (JToken j in arr)
            {
                var r = new TimelineRow();
                r.TMin = HlJson.Num(j, "t_min");
                r.Event = HlJson.Str(j, "event");
                r.Station = HlJson.Str(j, "station");
                r.O2LeftL = HlJson.NumOrNull(j, "o2_left_L");
                r.THomeMin = HlJson.NumOrNull(j, "t_home_min");
                r.MarginMin = HlJson.NumOrNull(j, "margin_min");
                r.HasMarginBinding = j.Type == JTokenType.Object && j["margin_binding"] != null;
                r.MarginBinding = HlJson.Str(j, "margin_binding");
                r.O2TasksLeftL = HlJson.NumOrNull(j, "o2_tasks_left_L");
                r.O2MarginMinPlanningRate = HlJson.NumOrNull(j, "o2_margin_min_planning_rate");
                JToken ipl = j.Type == JTokenType.Object ? j["in_partner_line"] : null;
                r.InPartnerLine = HlJson.IsNull(ipl) ? (bool?)null : (bool)ipl;
                r.AccessDistM = HlJson.NumOrNull(j, "access_dist_m");
                all.Add(r);
            }
            // plan.ts: [...timeline].sort((a, b) => a.t_min - b.t_min), which is stable. Insertion sort keeps that.
            for (int i = 1; i < all.Count; i++)
            {
                TimelineRow r = all[i];
                int k = i - 1;
                while (k >= 0 && all[k].TMin > r.TMin)
                {
                    all[k + 1] = all[k];
                    k--;
                }
                all[k + 1] = r;
            }

            var tl = new Timeline();
            foreach (TimelineRow r in all)
            {
                if (r.Event == "turn_back") tl.turnBacks.Add(r);
                else tl.events.Add(r);
            }

            // Walk segments and dwells, as the constructor of Plan (plan.ts): a walk runs from depart/leave to the next
            // arrive/return/arrive_home; a dwell from that arrival to the leave that follows it.
            TimelineRow open = null, arrived = null;
            foreach (TimelineRow ev in tl.events)
            {
                if (ev.Event == "depart" || ev.Event == "leave")
                {
                    if (ev.Event == "leave" && arrived != null && !string.IsNullOrEmpty(arrived.Station))
                    {
                        var d = new TimelineDwell();
                        d.Station = arrived.Station;
                        d.ArriveMin = arrived.TMin;
                        d.LeaveMin = ev.TMin;
                        tl.dwells.Add(d);
                    }
                    open = ev;
                    arrived = null;
                }
                else if ((ev.Event == "arrive" || ev.Event == "return" || ev.Event == "arrive_home") && open != null)
                {
                    var w = new TimelineWalk();
                    w.StartMin = open.TMin;
                    w.EndMin = ev.TMin;
                    w.From = open.Station;
                    w.To = ev.Station;
                    tl.walks.Add(w);
                    open = null;
                    arrived = ev;
                }
                if (ev.Event == "return" || ev.Event == "arrive_home") tl.ReturnRow = ev;
                if (ev.HasMarginBinding) tl.HasBinding = true;
            }
            tl.EndMin = tl.events.Count > 0 ? tl.events[tl.events.Count - 1].TMin : 0.0;

            var ht = new List<double>();
            var hv = new List<double>();
            var ot = new List<double>();
            var ov = new List<double>();
            foreach (TimelineRow e in tl.events)
            {
                if (e.MarginMin.HasValue && e.THomeMin.HasValue)
                {
                    ht.Add(e.TMin);
                    hv.Add(e.MarginMin.Value + e.THomeMin.Value);
                }
                if (e.O2LeftL.HasValue)
                {
                    ot.Add(e.TMin);
                    ov.Add(e.O2LeftL.Value);
                }
            }
            tl.headroomT = ht.ToArray();
            tl.headroomV = hv.ToArray();
            tl.o2T = ot.ToArray();
            tl.o2V = ov.ToArray();
            return tl;
        }

        /// <summary>
        /// Piecewise-linear interpolation over (t, v) points sorted by t, held at both ends; null when there are no
        /// points (interpSeries of plan.ts: of two points at the same time, the later one wins from that time on).
        /// </summary>
        public static double? InterpSeries(double[] ts, double[] vs, double t)
        {
            int n = ts.Length;
            if (n == 0) return null;
            if (t <= ts[0]) return vs[0];
            // first i >= 1 with t <= ts[i]
            int lo = 1, hi = n;
            while (lo < hi)
            {
                int mid = (lo + hi) / 2;
                if (ts[mid] >= t) hi = mid;
                else lo = mid + 1;
            }
            if (lo >= n) return vs[n - 1];
            double t0 = ts[lo - 1], t1 = ts[lo];
            return t1 == t0 ? vs[lo] : vs[lo - 1] + (vs[lo] - vs[lo - 1]) * (t - t0) / (t1 - t0);
        }

        /// <summary>Planned O2 left (L) at EVA minute t, interpolated between rows; null if the timeline states none.</summary>
        public double? O2LeftAt(double tEvaMin)
        {
            return InterpSeries(o2T, o2V, tEvaMin);
        }

        /// <summary>
        /// Planned headroom H(t) = margin_min + t_home_min (min), interpolated between rows; null if absent. The planner
        /// HUD's margin away from the route is H(t) - T_home(position).
        /// </summary>
        public double? HeadroomAt(double tEvaMin)
        {
            return InterpSeries(headroomT, headroomV, tEvaMin);
        }

        /// <summary>
        /// Binding term of the margin in force at t: that of the last row of the walk series at or before t (held,
        /// never interpolated). null = unknown at that row, before the first row, or <see cref="HasBinding"/> is false.
        /// </summary>
        public string BindingAt(double tEvaMin)
        {
            if (!HasBinding) return null;
            string b = null;
            foreach (TimelineRow e in events)
            {
                if (e.TMin > tEvaMin + 1e-9) break;
                b = e.MarginBinding;
            }
            return b;
        }

        /// <summary>The planner's latest departure from a station (its turn_back row); null = no row for that station.</summary>
        public TimelineTurnBack TurnBackFor(string station)
        {
            foreach (TimelineRow e in turnBacks)
            {
                if (e.Station != station) continue;
                var tb = new TimelineTurnBack();
                tb.Station = station;
                tb.TMin = e.TMin;
                tb.Binding = e.MarginBinding;
                tb.Row = e;
                return tb;
            }
            return null;
        }

        /// <summary>Next planned station arrival strictly after t; null when none is left.</summary>
        public TimelineArrival NextArrival(double tEvaMin)
        {
            foreach (TimelineRow e in events)
            {
                if (e.Event != "arrive" || string.IsNullOrEmpty(e.Station) || !(e.TMin > tEvaMin)) continue;
                var a = new TimelineArrival();
                a.Station = e.Station;
                a.TMin = e.TMin;
                return a;
            }
            return null;
        }

        /// <summary>The planned stay at a station (its first one); null when the plan does not stop there.</summary>
        public TimelineDwell DwellFor(string station)
        {
            foreach (TimelineDwell d in dwells)
                if (d.Station == station) return d;
            return null;
        }

        /// <summary>The planned stay in progress at t (arrive &lt;= t &lt;= leave); null when walking.</summary>
        public TimelineDwell DwellAt(double tEvaMin)
        {
            foreach (TimelineDwell d in dwells)
                if (d.ArriveMin <= tEvaMin && tEvaMin <= d.LeaveMin) return d;
            return null;
        }
    }
}

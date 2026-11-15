using System;
using System.IO;

namespace NasaSpaceApp.Homeline.Tests
{
    /// <summary>
    /// The timed dose leash against the planner's own timeline: on every row where the planner says the margin is
    /// bound by the dose, tau_dose(t) - T_home must be that margin; on every other row it must not be smaller.
    /// </summary>
    public static class StormTests
    {
        public static void Run(string fixture)
        {
            T.Group("storm");
            using (BundleReader bundle = BundleReader.Open(Path.Combine(fixture, "plan_bundle.zip")))
            {
                StormTrack storm = StormTrack.FromBundle(bundle);
                T.True(storm != null, "the official bundle carries the storm");
                if (storm == null) return;
                T.True(storm.SampleCount > 100, "storm samples read (" + storm.SampleCount + ")");
                T.Near(storm.DAllowMGy, 0.5, 1e-9, "allowed dose, mGy");
                T.Near(storm.TStarMin, 44.39, 1e-6, "tripwire minute");
                // Peak of the series (storm.json peak_uGy_day 8377.9 at EVA minute 67.14) in mGy/h.
                T.Near(storm.RateMGyH(67.14), 8377.9 / 24000.0, 0.002, "dose rate at the peak, mGy/h");
                // Held at the ends, like numpy.interp.
                T.Near(storm.RateMGyH(-1e6), storm.RateMGyH(-1748.86), 1e-12, "rate before the series");
                T.True(storm.RateMGyH(1e6) > 0, "rate after the series");
                T.Near(storm.RateOverBaseline(67.14), 8377.9 / 152.3, 1.0, "storm peak as a multiple of the quiet rate");
                T.True(!storm.TripwireFired(44.0) && storm.TripwireFired(44.5), "tripwire fires at its minute");

                // The planner's HUD alarm rules (web/src/hud/alarms.ts).
                T.Eq(HudAlarms.Evaluate(-1, false, 10, 100).Text, "TURN BACK NOW", "rule 1: margin below zero");
                T.Eq(HudAlarms.Evaluate(50, true, 45, 40).Text, "RADIATION: HEAD HOME", "rule 2: tripwire fired and the way home longer than the dose leash");
                T.True(!HudAlarms.Evaluate(50, false, 45, 40).Active, "rule 2 needs the tripwire");
                T.Eq(HudAlarms.Evaluate(7.9, false, 10, 100).Text, "TURN-BACK IN 7 MIN", "rule 4: amber below 10 min, minutes rounded down");
                T.True(!HudAlarms.Evaluate(10, false, 10, 100).Active && !HudAlarms.Evaluate(null, true, null, 40).Active, "no alarm at the threshold or with unknown inputs");

                Timeline timeline = Timeline.FromBundle(bundle);
                int doseRows = 0, otherRows = 0;
                foreach (TimelineRow row in timeline.Events)
                {
                    if (!row.THomeMin.HasValue || !row.MarginMin.HasValue) continue;
                    double dose = storm.TauDoseMin(row.TMin) - row.THomeMin.Value;
                    string at = "t = " + T.N(row.TMin) + " min";
                    if (row.MarginBinding == "dose")
                    {
                        doseRows++;
                        // The timeline rounds t, T_home and the margin to 0.01; near the peak the rate changes fast.
                        T.Near(dose, row.MarginMin.Value, 0.25, "dose term is the planner's margin, " + at);
                    }
                    else
                    {
                        otherRows++;
                        T.True(dose >= row.MarginMin.Value - 0.25, "dose term does not undercut the planner's margin, " + at +
                               " (dose " + T.N(dose) + ", margin " + T.N(row.MarginMin.Value) + ", limit " + row.MarginBinding + ")");
                    }
                }
                T.True(doseRows >= 2, "rows bound by the dose were checked (" + doseRows + ")");
                T.True(otherRows >= 5, "rows bound by other limits were checked (" + otherRows + ")");
                Console.WriteLine("  storm: " + doseRows + " dose-bound rows, " + otherRows + " other rows");
            }
        }
    }
}

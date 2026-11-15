namespace NasaSpaceApp.Homeline
{
    public enum AlarmLevel
    {
        None,
        Info,
        Amber,
        Red,
    }

    /// <summary>One alarm of the planner's HUD rules: which rule fired, how serious, and its text.</summary>
    public struct HudAlarm
    {
        public int Rule;
        public AlarmLevel Level;
        public string Text;
        public bool Active { get { return Level != AlarmLevel.None; } }
    }

    /// <summary>
    /// The planner's HUD alarm rules (web/src/hud/alarms.ts, SPEC F18), first match wins:
    ///   1. margin below zero                                  red    "TURN BACK NOW"
    ///   2. storm tripwire fired and T_home >= tau_dose        red    "RADIATION: HEAD HOME"
    ///   4. margin below the amber threshold (10 min)          amber  "TURN-BACK IN N MIN" (N rounded down)
    /// Rule 3 (position uncertainty crosses the homeline) and rule 5 (beyond partner-haul range) are not evaluated
    /// here: the simulator knows its position exactly and does not load the partner line.
    /// Unknown inputs (null) never fire a rule.
    /// </summary>
    public static class HudAlarms
    {
        /// <summary>config/hud.yaml margin_amber_min of the planner.</summary>
        public const double MarginAmberMin = 10.0;
        public const string TextTurnBackNow = "TURN BACK NOW", TextRadiation = "RADIATION: HEAD HOME";

        public static HudAlarm Evaluate(double? marginMin, bool tripwireFired, double? tHomeMin, double? tauDoseMin)
        {
            if (marginMin.HasValue && marginMin.Value < 0)
                return new HudAlarm { Rule = 1, Level = AlarmLevel.Red, Text = TextTurnBackNow };
            if (tripwireFired && tHomeMin.HasValue && tauDoseMin.HasValue && tHomeMin.Value >= tauDoseMin.Value)
                return new HudAlarm { Rule = 2, Level = AlarmLevel.Red, Text = TextRadiation };
            if (marginMin.HasValue && marginMin.Value < MarginAmberMin)
                return new HudAlarm { Rule = 4, Level = AlarmLevel.Amber, Text = "TURN-BACK IN " + (int)System.Math.Max(0, System.Math.Floor(marginMin.Value)) + " MIN" };
            return new HudAlarm { Rule = 0, Level = AlarmLevel.None, Text = null };
        }
    }
}

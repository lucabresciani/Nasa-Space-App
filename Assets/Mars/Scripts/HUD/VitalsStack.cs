using System.Globalization;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Bottom-right vitals stack, <see cref="HudTokens.ScreenMargin"/> from the right and bottom edges: BPM card with the
    /// ECG sweep and live O2 uptake, RAD/TMP card, O2 pill and the suit-status strip. Every status icon is backed by a
    /// live subsystem value shown under it (CO2 mmHg, fan krpm, battery %, cooling water %, suit kPa, link dB) and
    /// tinted by its state (nominal ink, caution amber, warning red; only warnings blink). Hovering any element with the
    /// cursor free (hold Tab) opens <see cref="HudTooltip"/> with name, value and units, limits and trend or time
    /// remaining, refreshed live. Values refresh at 2 Hz (BPM follows the model's 1 Hz display value); text and colors
    /// are assigned only on change, from cached strings (no per-frame GC).
    /// </summary>
    public sealed class VitalsStack
    {
        private const float RefreshPeriod = 0.5f;   // 2 Hz
        private const float BlinkLowAlpha = 0.3f;   // warning blink: dimmed, never invisible
        private const string Dashes = "--";
        private const string Lost = "LOST";

        // Layout (px). Children are placed from the root's bottom-right corner, which sits at the screen margin.
        private const float Gap = HudTokens.StackGap;
        private const float O2W = 172f, RowH = 64f;
        private const float SlotW = 52f, StripPad = 8f;
        private const float RadW = 284f, RadH = 104f;
        private const float BpmW = 324f, BpmH = 180f;

        // HudPointerRelay.Index of the hover areas (0..5 are suit-strip slots).
        private const int SlotCount = 6;
        private const int SlotCo2 = 0, SlotFan = 1, SlotBattery = 2, SlotWater = 3, SlotPressure = 4, SlotSignal = 5;
        private const int HoverBpm = 6, HoverRad = 7, HoverTmp = 8, HoverO2 = 9;

        private const string LevelThresholds = "Caution ≤ 20 % · warning ≤ 10 %";

        private readonly HudContext ctx;
        private readonly PulseStrip pulse;
        private readonly Text bpmValue, vo2Value, radValue, tmpValue, o2Value;
        private readonly Text[] slotValue = new Text[SlotCount];
        private readonly string[] slotShown = new string[SlotCount];
        private readonly Indicator bpmInd, radInd, o2Ind;
        private readonly Indicator[] slotInd = new Indicator[SlotCount];
        private readonly System.Action<HudPointerRelay, bool> hoverHandler;

        private string bpmShown, vo2Shown, radShown, tmpShown, o2Shown;
        private float doseShown = float.NaN;
        private string doseText = Dashes;
        private bool tmpKnown = true;
        private float now;
        private float refreshTimer = RefreshPeriod;   // first Tick refreshes
        private HudPointerRelay hovered;

        public VitalsStack(HudContext ctx)
        {
            this.ctx = ctx;
            hoverHandler = OnHover;
            HudSkin skin = ctx.Skin != null ? ctx.Skin : HudSkin.Load();
            Font regular = skin.Regular, medium = skin.Medium;
            Transform layer = ctx.StaticLayer != null ? ctx.StaticLayer : ctx.CanvasRect;
            Vector2 br = new Vector2(1f, 0f);

            float stripW = 2f * StripPad + SlotCount * SlotW;
            float radY = RowH + Gap;
            float bpmY = radY + RadH + Gap;
            RectTransform root = HudFactory.CreateRect("Vitals", layer, br, br,
                                                       new Vector2(-HudTokens.ScreenMargin, HudTokens.ScreenMargin),
                                                       new Vector2(stripW + Gap + O2W, bpmY + BpmH));

            // ---- BPM card: ECG sweep, heart rate, live O2 uptake (whole card is the hover area)
            Image bpmCard = HudFactory.CreatePanel("VitalsBpm", root, skin, HudTokens.Scrim, HudTokens.RadiusCard,
                                                   br, br, new Vector2(0f, bpmY), new Vector2(BpmW, BpmH));
            bpmCard.raycastTarget = true;
            AddRelay(bpmCard.gameObject, HoverBpm);
            RectTransform bpm = bpmCard.rectTransform;
            pulse = new PulseStrip(ctx, bpm, new Vector2(6f, 12f), new Vector2(312f, 112f));
            Image heart = Icon(bpm, skin.iconHeart, 18f, 33f, 150f);
            TextLeft(bpm, medium, HudTokens.SizeFoot, HudTokens.InkTertiary, 50f, 150f).text = "SIM";
            vo2Value = TextLeft(bpm, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, 86f, 150f);
            vo2Value.rectTransform.sizeDelta = new Vector2(124f, HudTokens.SizeMicro + 8f);
            bpmValue = TextRight(bpm, regular, HudTokens.SizeValueLarge, HudTokens.InkPrimary, 266f, 150f);
            TextRight(bpm, medium, HudTokens.SizeLabel, HudTokens.InkSecondary, 300f, 150f).text = "BPM";
            Underline(bpm, 210f, 300f, 165f);
            bpmInd = new Indicator(bpmValue, heart);
            ctx.ReserveZone(bpm);

            // ---- RAD / TMP card (one hover area per row)
            Image radCard = HudFactory.CreatePanel("VitalsRadTmp", root, skin, HudTokens.Scrim, HudTokens.RadiusCard,
                                                   br, br, new Vector2(0f, radY), new Vector2(RadW, RadH));
            RectTransform rt = radCard.rectTransform;
            HitArea(rt, "RadHover", 0f, 30f, RadW, 44f, HoverRad);
            HitArea(rt, "TmpHover", 0f, 74f, RadW, 44f, HoverTmp);

            Image radIcon = Icon(rt, skin.iconRadiation, 18f, 31f, 30f);
            TextLeft(rt, medium, HudTokens.SizeLabel, HudTokens.InkSecondary, 50f, 30f).text = "RAD";
            radValue = TextRight(rt, regular, HudTokens.SizeValueLarge, HudTokens.InkPrimary, 209f, 30f);
            TextRight(rt, medium, HudTokens.SizeLabel, HudTokens.InkSecondary, 260f, 30f).text = "mSv/h";
            Underline(rt, 136f, 260f, 45f);
            radInd = new Indicator(radValue, radIcon);

            Icon(rt, skin.iconTemperature, 18f, 31f, 74f);
            TextLeft(rt, medium, HudTokens.SizeLabel, HudTokens.InkSecondary, 50f, 74f).text = "TMP";
            tmpValue = TextRight(rt, regular, HudTokens.SizeValueLarge, HudTokens.InkPrimary, 236f, 74f);
            TextRight(rt, medium, HudTokens.SizeLabel, HudTokens.InkSecondary, 260f, 74f).text = "°C";
            Underline(rt, 170f, 260f, 89f);
            ctx.ReserveZone(rt);

            // ---- O2 pill (whole pill is the hover area)
            Image o2Pill = HudFactory.CreatePanel("VitalsO2", root, skin, HudTokens.Scrim, RowH * 0.5f,
                                                  br, br, Vector2.zero, new Vector2(O2W, RowH));
            o2Pill.raycastTarget = true;
            AddRelay(o2Pill.gameObject, HoverO2);
            RectTransform o2 = o2Pill.rectTransform;
            Image o2Icon = Icon(o2, skin.iconOxygen, 24f, 40f, 32f);   // reads "O2"
            o2Value = TextRight(o2, regular, HudTokens.SizeValueLarge, HudTokens.InkPrimary, 130f, 32f);
            TextRight(o2, medium, HudTokens.SizeLabel, HudTokens.InkSecondary, 148f, 32f).text = "%";
            Underline(o2, 92f, 148f, 47f);
            o2Ind = new Indicator(o2Value, o2Icon);
            ctx.ReserveZone(o2);

            // ---- suit-status strip: icon + live value per subsystem, each slot is a hover area
            Image strip = HudFactory.CreatePanel("VitalsSuit", root, skin, HudTokens.Scrim, HudTokens.RadiusCard,
                                                 br, br, new Vector2(-(O2W + Gap), 0f), new Vector2(stripW, RowH));
            RectTransform st = strip.rectTransform;
            Sprite[] icons = { skin.iconCo2, skin.iconFan, skin.iconBattery, skin.iconWater, skin.iconPressure, skin.iconSignal };
            Vector2 topCenter = new Vector2(0.5f, 1f);
            Vector2 center = new Vector2(0.5f, 0.5f);
            for (int i = 0; i < SlotCount; i++)
            {
                RectTransform hit = HitArea(st, "Slot", StripPad + SlotW * i, RowH * 0.5f, SlotW, RowH, i);
                Image icon = HudFactory.CreateIcon("Icon", hit, icons[i], HudTokens.InkSecondary, 20f,
                                                   topCenter, center, new Vector2(0f, -22f));
                Text value = HudFactory.CreateText("Value", hit, regular, HudTokens.SizeLabel, HudTokens.InkPrimary,
                                                   TextAnchor.MiddleCenter, topCenter, center, new Vector2(0f, -46f),
                                                   new Vector2(SlotW, HudTokens.SizeLabel + 4f));
                value.text = Dashes;
                slotShown[i] = Dashes;
                slotValue[i] = value;
                slotInd[i] = new Indicator(value, icon);
            }
            ctx.ReserveZone(st);
        }

        /// <summary>Per-frame update with unscaled <paramref name="dt"/> (the ECG runs on simulation time).</summary>
        public void Tick(float dt)
        {
            SuitTelemetry t = ctx.Telemetry;
            if (t == null)
            {
                return;
            }
            now += dt;

            pulse.Tick(Time.deltaTime, t, t.HeartState);
            Assign(bpmValue, ref bpmShown, HudStrings.Int(t.HeartRateDisplay));   // model updates it at 1 Hz

            refreshTimer += dt;
            if (refreshTimer >= RefreshPeriod)
            {
                refreshTimer = 0f;
                Refresh(t);
            }

            bpmInd.Tick(now);
            radInd.Tick(now);
            o2Ind.Tick(now);
            for (int i = 0; i < SlotCount; i++)
            {
                slotInd[i].Tick(now);
            }
        }

        private void Refresh(SuitTelemetry t)
        {
            // RAD: 3 decimals, formatted only when the dose rate changes
            float dose = t.DoseRateMsvH;
            if (dose != doseShown && !(float.IsNaN(dose) && float.IsNaN(doseShown)))
            {
                doseShown = dose;
                doseText = float.IsNaN(dose) ? Dashes : dose.ToString("0.000", CultureInfo.InvariantCulture);
            }
            Assign(radValue, ref radShown, doseText);

            // TMP: "--" (tertiary) while the solar time is unknown
            bool known = !float.IsNaN(t.AirTempC);
            Assign(tmpValue, ref tmpShown, known ? HudStrings.SignedInt(t.AirTempDisplay) : Dashes);
            if (known != tmpKnown)
            {
                tmpKnown = known;
                tmpValue.color = known ? HudTokens.InkPrimary : HudTokens.InkTertiary;
            }

            Assign(o2Value, ref o2Shown, HudStrings.Int(t.O2PercentDisplay));
            Assign(vo2Value, ref vo2Shown, Fmt.Vo2(Mathf.RoundToInt(t.O2FlowLpm * 100f)));

            // Suit strip values
            SetSlot(SlotCo2, Fmt.Tenths(Mathf.RoundToInt(t.Co2Mmhg * 10f)));
            SetSlot(SlotFan, Fmt.Krpm(Mathf.RoundToInt(t.FanRpm / 100f)));
            SetSlot(SlotBattery, Fmt.Percent(Mathf.CeilToInt(t.BatteryPct)));
            SetSlot(SlotWater, Fmt.Percent(Mathf.CeilToInt(t.CoolingWaterPct)));
            SetSlot(SlotPressure, Fmt.Tenths(Mathf.RoundToInt(t.SuitPressureKpa * 10f)));
            float margin = t.LinkMarginDb;
            SetSlot(SlotSignal, float.IsNaN(margin) ? Dashes : margin < SuitTelemetry.LinkLostDb ? Lost : Fmt.Db(Mathf.FloorToInt(margin)));

            bpmInd.Set(t.HeartState, now);
            radInd.Set(t.RadState, now);
            o2Ind.Set(t.O2State, now);
            slotInd[SlotCo2].Set(t.Co2State, now);
            slotInd[SlotFan].Set(t.FanState, now);
            slotInd[SlotBattery].Set(t.BatteryState, now);
            slotInd[SlotWater].Set(t.WaterState, now);
            slotInd[SlotPressure].Set(t.PressureState, now);
            slotInd[SlotSignal].Set(t.SignalState, now);

            // Live tooltip while hovering (2 Hz, event-time strings).
            if (hovered != null && ctx.Tooltip != null)
            {
                var target = (RectTransform)hovered.transform;
                if (ctx.Tooltip.IsShowing(target))
                {
                    Describe(hovered.Index, t, out string l1, out string l2, out string l3);
                    ctx.Tooltip.Refresh(target, l1, l2, l3);
                }
            }
        }

        private void SetSlot(int i, string value)
        {
            Assign(slotValue[i], ref slotShown[i], value);
        }

        // ---- tooltips (strings built on show and at 2 Hz while hovered)

        private void OnHover(HudPointerRelay relay, bool isHovered)
        {
            HudTooltip tip = ctx.Tooltip;
            if (tip == null || relay == null)
            {
                return;
            }
            var target = (RectTransform)relay.transform;
            if (!isHovered)
            {
                if (hovered == relay)
                {
                    hovered = null;
                }
                tip.Hide(target);
                return;
            }
            SuitTelemetry t = ctx.Telemetry;
            if (t == null)
            {
                return;
            }
            hovered = relay;
            Describe(relay.Index, t, out string line1, out string line2, out string line3);
            tip.Show(target, line1, line2, line3);
        }

        private void Describe(int index, SuitTelemetry t, out string line1, out string line2, out string line3)
        {
            line3 = null;
            switch (index)
            {
                case HoverBpm:
                    line1 = "Heart rate " + HudStrings.Int(t.HeartRateDisplay) + " bpm · breathing "
                            + HudStrings.Int(Mathf.RoundToInt(t.RespirationRate)) + "/min";
                    line2 = "VO₂ " + F1(t.Vo2) + " mL/kg/min · " + F2(t.O2FlowLpm) + " L/min";
                    line3 = "Weather +" + F1(t.WeatherVo2) + " mL/kg/min · stress +" + HudStrings.Int(Mathf.RoundToInt(t.StressBpm))
                            + " bpm";
                    break;
                case HoverRad:
                    line1 = "Dose rate " + doseText + " mSv/h";
                    line2 = "Curiosity RAD mean, Gale · not live";
                    break;
                case HoverTmp:
                    line1 = "Air temperature " + (float.IsNaN(t.AirTempC) ? Dashes : HudStrings.SignedInt(t.AirTempDisplay)) + " °C";
                    line2 = "REMS season medians · diurnal model";
                    break;
                case HoverO2:
                    line1 = "Primary O₂ " + HudStrings.Int(Mathf.RoundToInt(t.O2LeftL)) + " L of 482 L · sim";
                    line2 = "Using " + F2(t.O2FlowLpm) + " L/min · " + Duration(t.O2MinutesToReserve) + " to reserve";
                    line3 = "Reserve 40.5 L · caution under 30 min";
                    break;
                case SlotCo2:
                    line1 = "Helmet CO₂ " + F1(t.Co2Mmhg) + " mmHg · " + Trend(t.Co2TrendPerMin, 0.15f);
                    line2 = "Caution 8 · warning 15 mmHg";
                    line3 = "Washout by vent flow " + F1(t.FanFlowAcfm) + " acfm · sim";
                    break;
                case SlotFan:
                    line1 = "Vent fan " + HudStrings.Int(Mathf.RoundToInt(t.FanRpm / 10f) * 10) + " rpm · " + F1(t.FanFlowAcfm) + " acfm";
                    line2 = t.FanSaturated ? "At maximum: demand above fan ceiling" : "Tracks metabolic rate · 6–8 acfm";
                    line3 = HudStrings.Int(Mathf.RoundToInt(t.FanPowerW)) + " W · caution after 10 s at max · sim";
                    break;
                case SlotBattery:
                    line1 = "Battery " + HudStrings.Int(Mathf.CeilToInt(t.BatteryPct)) + " % · "
                            + HudStrings.Int(Mathf.RoundToInt(t.BatteryWh)) + " Wh · sim";
                    line2 = "Load " + HudStrings.Int(Mathf.RoundToInt(t.BatteryLoadW)) + " W · " + Duration(t.BatteryMinutesLeft) + " left";
                    line3 = "Fan " + W(t.FanPowerW) + " · comm " + W(t.CommW) + " · heat " + W(t.HeaterW) + " · light "
                            + W(t.LightsW) + " W";
                    break;
                case SlotWater:
                    line1 = "Cooling water " + HudStrings.Int(Mathf.CeilToInt(t.CoolingWaterPct)) + " % · sim";
                    line2 = "Sublimator " + HudStrings.Int(Mathf.RoundToInt(t.CoolingLoadW)) + " W · "
                            + Duration(t.WaterMinutesLeft) + " left";
                    line3 = LevelThresholds;
                    break;
                case SlotPressure:
                    line1 = "Suit pressure " + F1(t.SuitPressureKpa) + " kPa · "
                            + (t.SuitPressureKpa * 0.145038f).ToString("0.00", CultureInfo.InvariantCulture) + " psi";
                    line2 = "Caution < 28.3 · warning < 26.9 kPa";
                    line3 = t.O2LeftL > 0f ? "Held by the O₂ regulator · sim" : "No makeup O₂ · suit leaking · sim";
                    break;
                case SlotSignal:
                    line1 = "UHF link home " + (float.IsNaN(t.LinkMarginDb) ? Dashes : HudStrings.Int(Mathf.FloorToInt(t.LinkMarginDb)))
                            + " dB margin · sim";
                    line2 = HudStrings.Distance(t.LinkDistanceM) + " · "
                            + (t.LineOfSight ? "line of sight to antenna" : "terrain blocks line of sight");
                    line3 = "Caution < 6 dB · lost < 0 dB";
                    break;
                default:
                    line1 = string.Empty;
                    line2 = string.Empty;
                    break;
            }
        }

        private static string F1(float v)
        {
            return v.ToString("0.0", CultureInfo.InvariantCulture);
        }

        private static string F2(float v)
        {
            return v.ToString("0.00", CultureInfo.InvariantCulture);
        }

        private static string W(float v)
        {
            return HudStrings.Int(Mathf.RoundToInt(v));
        }

        private static string Trend(float perMin, float deadband)
        {
            return perMin > deadband ? "rising" : perMin < -deadband ? "falling" : "steady";
        }

        // "52 min" or "5 h 12 min" (event-time only).
        private static string Duration(float minutes)
        {
            if (float.IsNaN(minutes) || float.IsInfinity(minutes))
            {
                return Dashes;
            }
            int m = Mathf.Clamp(Mathf.FloorToInt(minutes), 0, 99 * 60 + 59);
            return m < 60 ? HudStrings.Int(m) + " min" : HudStrings.Int(m / 60) + " h " + HudStrings.Int(m % 60) + " min";
        }

        // ---- build helpers (local coordinates from the parent's top-left, y down)

        private void AddRelay(GameObject go, int index)
        {
            var relay = go.AddComponent<HudPointerRelay>();
            relay.Index = index;
            relay.HoverChanged += hoverHandler;
        }

        // Transparent raycast-target hit area: left edge x, vertical center y.
        private RectTransform HitArea(RectTransform parent, string name, float x, float y, float w, float h, int index)
        {
            Image hit = HudFactory.CreateImage(name, parent, null, new Color(1f, 1f, 1f, 0f), new Vector2(0f, 1f),
                                               new Vector2(0f, 0.5f), new Vector2(x, -y), new Vector2(w, h));
            hit.raycastTarget = true;
            AddRelay(hit.gameObject, index);
            return hit.rectTransform;
        }

        private static Image Icon(RectTransform parent, Sprite sprite, float size, float cx, float cy)
        {
            return HudFactory.CreateIcon("Icon", parent, sprite, HudTokens.InkSecondary, size, new Vector2(0f, 1f),
                                         new Vector2(0.5f, 0.5f), new Vector2(cx, -cy));
        }

        private static Text TextLeft(RectTransform parent, Font font, int size, Color color, float x, float cy)
        {
            return HudFactory.CreateText("Text", parent, font, size, color, TextAnchor.MiddleLeft, new Vector2(0f, 1f),
                                         new Vector2(0f, 0.5f), new Vector2(x, -cy), new Vector2(120f, size + 8f));
        }

        private static Text TextRight(RectTransform parent, Font font, int size, Color color, float rightX, float cy)
        {
            return HudFactory.CreateText("Text", parent, font, size, color, TextAnchor.MiddleRight, new Vector2(0f, 1f),
                                         new Vector2(1f, 0.5f), new Vector2(rightX, -cy), new Vector2(120f, size + 8f));
        }

        private static void Underline(RectTransform parent, float x0, float x1, float y)
        {
            HudFactory.CreateImage("Underline", parent, null, HudTokens.StrokeHair, new Vector2(0f, 1f), new Vector2(0f, 0.5f),
                                   new Vector2(x0, -y), new Vector2(x1 - x0, HudTokens.Hairline));
        }

        private static void Assign(Text text, ref string shown, string value)
        {
            if (!ReferenceEquals(shown, value))
            {
                shown = value;
                text.text = value;
            }
        }

        /// <summary>Attention alpha: only warnings blink (2 Hz for up to 10 s, then steady); cautions are steady amber.</summary>
        private static float AttentionAlpha(HudSeverity s, float t)
        {
            if (s == HudSeverity.Warning && t < HudTokens.WarningBlinkMaxS)
            {
                return Mathf.Repeat(t * HudTokens.WarningBlinkHz, 1f) < 0.5f ? 1f : BlinkLowAlpha;
            }
            return 1f;
        }

        /// <summary>Cached display strings for the strip and the O2-uptake line (allocation only on first use of a value).</summary>
        private static class Fmt
        {
            private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
            private static string[] s_Tenths, s_Percent, s_Db, s_Krpm, s_Vo2;

            /// <summary>0.0 .. 99.9 from tenths; out of range reads "--".</summary>
            public static string Tenths(int tenths)
            {
                if (tenths < 0 || tenths > 999)
                {
                    return Dashes;
                }
                s_Tenths ??= new string[1000];
                return s_Tenths[tenths] ??= (tenths / 10).ToString(Inv) + "." + (tenths % 10).ToString(Inv);
            }

            public static string Percent(int pct)
            {
                pct = Mathf.Clamp(pct, 0, 100);
                s_Percent ??= new string[101];
                return s_Percent[pct] ??= pct.ToString(Inv) + "%";
            }

            public static string Db(int db)
            {
                db = Mathf.Clamp(db, 0, 99);
                s_Db ??= new string[100];
                return s_Db[db] ??= db.ToString(Inv) + "dB";
            }

            /// <summary>Fan speed in krpm from hundreds of rpm: 193 -> "19.3k".</summary>
            public static string Krpm(int hundreds)
            {
                hundreds = Mathf.Clamp(hundreds, 0, 999);
                s_Krpm ??= new string[1000];
                return s_Krpm[hundreds] ??= (hundreds / 10).ToString(Inv) + "." + (hundreds % 10).ToString(Inv) + "k";
            }

            /// <summary>O2 uptake from hundredths of L/min: 189 -> "VO₂ 1.89 L/min".</summary>
            public static string Vo2(int hundredths)
            {
                hundredths = Mathf.Clamp(hundredths, 0, 999);
                s_Vo2 ??= new string[1000];
                return s_Vo2[hundredths] ??= "VO₂ " + (hundredths / 100).ToString(Inv) + "."
                                             + (hundredths % 100).ToString("00", Inv) + " L/min";
            }
        }

        /// <summary>Severity color of a value and its icon; colors are written only when they change.</summary>
        private sealed class Indicator
        {
            private readonly Graphic[] graphics;
            private readonly Color[] nominal;
            private HudSeverity state;
            private float onset = float.NegativeInfinity;
            private HudSeverity appliedState;
            private float appliedAlpha = 1f;

            public Indicator(params Graphic[] graphics)
            {
                this.graphics = graphics;
                nominal = new Color[graphics.Length];
                for (int i = 0; i < graphics.Length; i++)
                {
                    nominal[i] = graphics[i].color;
                }
            }

            public void Set(HudSeverity s, float now)
            {
                if (s == state)
                {
                    return;
                }
                // Escalation draws attention; de-escalation changes color steadily.
                onset = s > state ? now : float.NegativeInfinity;
                state = s;
            }

            public void Tick(float now)
            {
                float alpha = HudTokens.ReducedMotion ? 1f : AttentionAlpha(state, now - onset);
                if (state == appliedState && alpha == appliedAlpha)
                {
                    return;
                }
                appliedState = state;
                appliedAlpha = alpha;
                for (int i = 0; i < graphics.Length; i++)
                {
                    Color c = HudTokens.Severity(state, nominal[i]);
                    c.a *= alpha;
                    graphics[i].color = c;
                }
            }
        }
    }
}

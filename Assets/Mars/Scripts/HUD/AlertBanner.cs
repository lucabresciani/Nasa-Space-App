using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Top-center alert banner (below the heading tape): one alert at a time from <see cref="SuitTelemetry"/> (first
    /// match wins in priority order: physiology, consumables and every suit subsystem), re-evaluated at 4 Hz; a newly
    /// shown alert holds at least 2 s. Warning and caution show the warning icon and a severity tag; info shows the
    /// message only. The message is rebuilt only when (alert, number) changes. The panel is deactivated while hidden, so
    /// its reserved zone only repels rock cards while an alert shows.
    /// </summary>
    public sealed class AlertBanner
    {
        private const float EvalPeriod = 0.25f;   // 4 Hz
        private const float MinHoldS = 2f;
        private const float DustDevilClosePass = 0.5f;
        private const float TopOffset = 96f;      // panel top below the canvas top (heading tape owns 24..80 px)
        private const float Width = 600f, Height = 36f;
        private const float IconSize = 18f, IconGap = 8f, TagHeight = 22f, TagPad = 16f, TagGap = 10f;
        private const float PulseLowAlpha = 0.4f;
        private const float BlinkLowAlpha = 0.3f;
        private const string TagCaution = "CAUTION", TagWarning = "WARNING";

        // Alert ids in priority order (first match wins); warnings up to LastWarning, cautions up to LastCaution, then info.
        private const int None = 0;
        private const int O2Reserve = 1, PressureLow = 2, Co2High = 3, SlopeNoGo = 4, RadiationHigh = 5, BatteryLow = 6,
                          WaterLow = 7, HeartHigh = 8, CommLost = 9, EvaLimit = 10;
        private const int LastWarning = EvaLimit;
        private const int SlopeBeyond = 11, O2ToReserve = 12, PressureCaution = 13, Co2Elevated = 14, RadiationElevated = 15,
                          HeartElevated = 16, BatteryCaution = 17, WaterCaution = 18, CommWeak = 19, FanMax = 20, EvaLong = 21;
        private const int LastCaution = EvaLong;
        private const int BeyondExtent = 22, DustDevilNearby = 23;

        private readonly HudContext ctx;
        private readonly GameObject panelGo;
        private readonly CanvasGroup group;
        private readonly CanvasGroup tagGroup;
        private readonly Image icon;
        private readonly Image tagFill;
        private readonly Text tagText;
        private readonly Text message;
        private readonly RectTransform iconRect, tagRect, messageRect;
        private readonly bool hasIcon;
        private readonly int tagWidthChars = TagCaution.Length;

        private int shownId = None;
        private int shownNumber = int.MinValue;
        private HudSeverity shownSeverity = HudSeverity.Nominal;
        private float shownSince;
        private float tagOnset = float.NegativeInfinity;
        private float tagAlpha = 1f;
        private float now;
        private float evalTimer;
        private float fadeFrom, fadeTo, fadeT = 1f;

        public AlertBanner(HudContext ctx)
        {
            this.ctx = ctx;
            HudSkin skin = ctx.Skin != null ? ctx.Skin : HudSkin.Load();
            Transform layer = ctx.AlertLayer != null ? ctx.AlertLayer : ctx.CanvasRect;

            Vector2 top = new Vector2(0.5f, 1f);
            Image panel = HudFactory.CreatePanel("AlertBanner", layer, skin, HudTokens.Scrim, Height * 0.5f,
                                                 top, top, new Vector2(0f, -TopOffset), new Vector2(Width, Height));
            group = HudFactory.AddGroup(panel.gameObject, 0f, false);
            group.interactable = false;
            RectTransform p = panel.rectTransform;
            panelGo = panel.gameObject;
            ctx.ReserveZone(p);

            // Children are laid out left to right from the panel center (pivot left-middle), positions set per alert.
            Vector2 center = new Vector2(0.5f, 0.5f);
            Vector2 midLeft = new Vector2(0f, 0.5f);
            icon = HudFactory.CreateIcon("Icon", p, skin.iconWarning, HudTokens.Caution, IconSize, center, midLeft, Vector2.zero);
            hasIcon = icon.sprite != null;
            iconRect = icon.rectTransform;

            float tagWidth = HudTokens.Advance(HudTokens.SizeMicro) * tagWidthChars + TagPad;
            tagFill = HudFactory.CreatePanel("Tag", p, skin, HudTokens.Caution, HudTokens.RadiusTag, center, midLeft,
                                             Vector2.zero, new Vector2(tagWidth, TagHeight));
            tagRect = tagFill.rectTransform;
            tagGroup = HudFactory.AddGroup(tagFill.gameObject, 1f, false);
            tagText = HudFactory.CreateText("TagText", tagRect, skin.SemiBold, HudTokens.SizeMicro, HudTokens.CautionInk,
                                            TextAnchor.MiddleCenter, center, center, Vector2.zero, new Vector2(tagWidth, TagHeight));
            tagText.text = TagCaution;

            message = HudFactory.CreateText("Message", p, skin.Medium, HudTokens.SizeLabel, HudTokens.InkPrimary,
                                            TextAnchor.MiddleLeft, center, midLeft, Vector2.zero, new Vector2(0f, TagHeight));
            messageRect = message.rectTransform;
            panelGo.SetActive(false);   // hidden until the first alert
        }

        /// <summary>Evaluates alerts at 4 Hz and runs fades and the tag pulse/blink (unscaled <paramref name="dt"/>).</summary>
        public void Tick(float dt)
        {
            now += dt;
            evalTimer -= dt;
            if (evalTimer <= 0f)
            {
                evalTimer = EvalPeriod;
                Evaluate();
            }
            TickFade(dt);
            TickTag();
        }

        private void Evaluate()
        {
            int id = Select(ctx.Telemetry, out int number);
            if (id == shownId)
            {
                if (id != None && number != shownNumber)
                {
                    SetMessage(id, number);
                }
                return;
            }
            if (shownId != None && now - shownSince < MinHoldS)
            {
                return;   // the current alert holds at least 2 s
            }
            if (id == None)
            {
                shownId = None;
                FadeTo(0f);   // keeps the last content while it fades out
                return;
            }

            HudSeverity severity = SeverityOf(id);
            if (severity != shownSeverity)
            {
                ApplySeverity(severity);
            }
            shownId = id;
            shownSince = now;
            tagOnset = now;
            SetMessage(id, number);
            FadeTo(1f);
        }

        private static int Select(SuitTelemetry t, out int number)
        {
            number = 0;
            if (t == null)
            {
                return None;
            }

            // warning
            if (t.O2State == HudSeverity.Warning) return O2Reserve;
            if (t.PressureState == HudSeverity.Warning) { number = Tenths(t.SuitPressureKpa); return PressureLow; }
            if (t.Co2State == HudSeverity.Warning) { number = Tenths(t.Co2Mmhg); return Co2High; }
            if (t.SlopeState == HudSeverity.Warning) { number = Mathf.RoundToInt(t.SlopeDeg); return SlopeNoGo; }
            if (t.RadState == HudSeverity.Warning) return RadiationHigh;
            if (t.BatteryState == HudSeverity.Warning) { number = Mathf.CeilToInt(t.BatteryPct); return BatteryLow; }
            if (t.WaterState == HudSeverity.Warning) { number = Mathf.CeilToInt(t.CoolingWaterPct); return WaterLow; }
            if (t.HeartState == HudSeverity.Warning) { number = t.HeartRateDisplay; return HeartHigh; }
            if (t.SignalState == HudSeverity.Warning) return CommLost;
            if (t.MetState == HudSeverity.Warning) return EvaLimit;

            // caution
            if (t.SlopeState == HudSeverity.Caution) { number = Mathf.RoundToInt(t.SlopeDeg); return SlopeBeyond; }
            if (t.O2State == HudSeverity.Caution) { number = Mathf.Max(0, Mathf.FloorToInt(t.O2MinutesToReserve)); return O2ToReserve; }
            if (t.PressureState == HudSeverity.Caution) { number = Tenths(t.SuitPressureKpa); return PressureCaution; }
            if (t.Co2State == HudSeverity.Caution) { number = Tenths(t.Co2Mmhg); return Co2Elevated; }
            if (t.RadState == HudSeverity.Caution) return RadiationElevated;
            if (t.HeartState == HudSeverity.Caution) { number = t.HeartRateDisplay; return HeartElevated; }
            if (t.BatteryState == HudSeverity.Caution) { number = Mathf.CeilToInt(t.BatteryPct); return BatteryCaution; }
            if (t.WaterState == HudSeverity.Caution) { number = Mathf.CeilToInt(t.CoolingWaterPct); return WaterCaution; }
            if (t.SignalState == HudSeverity.Caution) { number = Mathf.Max(0, Mathf.FloorToInt(t.LinkMarginDb)); return CommWeak; }
            if (t.FanState == HudSeverity.Caution) return FanMax;
            if (t.MetState == HudSeverity.Caution) { number = Mathf.FloorToInt(t.MetSeconds / 60f); return EvaLong; }

            // info
            if (t.BeyondExtent) return BeyondExtent;
            if (t.DustDevilProximity > DustDevilClosePass) return DustDevilNearby;
            return None;
        }

        private static int Tenths(float v)
        {
            return float.IsNaN(v) || float.IsInfinity(v) ? 0 : Mathf.Clamp(Mathf.RoundToInt(v * 10f), 0, 9999);
        }

        private static HudSeverity SeverityOf(int id)
        {
            return id <= LastWarning ? HudSeverity.Warning : id <= LastCaution ? HudSeverity.Caution : HudSeverity.Info;
        }

        // Event-time only (alert or number change, at most 4 Hz): may allocate.
        private static string Message(int id, int n)
        {
            switch (id)
            {
                case O2Reserve: return "O₂ RESERVE · HEAD HOME";
                case PressureLow: return "SUIT PRESSURE " + Decimal(n) + " kPa · HEAD HOME";
                case Co2High: return "CO₂ " + Decimal(n) + " mmHg · STOP AND REST";
                case SlopeNoGo: return "SLOPE NO-GO " + HudStrings.Int(n) + "°";
                case RadiationHigh: return "RADIATION · HEAD HOME";
                case BatteryLow: return "BATTERY " + HudStrings.Int(n) + " %";
                case WaterLow: return "COOLING WATER " + HudStrings.Int(n) + " %";
                case HeartHigh: return "HEART RATE " + HudStrings.Int(n) + " · STOP AND REST";
                case CommLost: return "COMM LINK LOST · REGAIN LINE OF SIGHT";
                case EvaLimit: return "EVA TIME LIMIT";
                case SlopeBeyond: return "SLOPE " + HudStrings.Int(n) + "° · BEYOND TESTED SUIT DATA";
                case O2ToReserve: return "O₂ " + HudStrings.Int(n) + " MIN TO RESERVE";
                case PressureCaution: return "SUIT PRESSURE " + Decimal(n) + " kPa";
                case Co2Elevated: return "CO₂ " + Decimal(n) + " mmHg · SLOW DOWN";
                case RadiationElevated: return "RADIATION 3× BASELINE";
                case HeartElevated: return "HEART RATE " + HudStrings.Int(n) + " · SLOW DOWN";
                case BatteryCaution: return "BATTERY " + HudStrings.Int(n) + " %";
                case WaterCaution: return "COOLING WATER " + HudStrings.Int(n) + " %";
                case CommWeak: return "COMM LINK WEAK " + HudStrings.Int(n) + " dB";
                case FanMax: return "VENT FAN AT MAX · SLOW DOWN";
                case EvaLong:
                    int mm = n % 60;
                    return "EVA " + HudStrings.Int(n / 60) + (mm < 10 ? ":0" : ":") + HudStrings.Int(mm) + " OF 6:30";
                case BeyondExtent: return "Beyond planning extent 3.7 km";
                case DustDevilNearby: return "Dust devil nearby";
                default: return string.Empty;
            }
        }

        private static string Decimal(int tenths)
        {
            return HudStrings.Int(tenths / 10) + "." + HudStrings.Int(tenths % 10);
        }

        private void ApplySeverity(HudSeverity severity)
        {
            shownSeverity = severity;
            bool marker = severity >= HudSeverity.Caution;
            bool warning = severity == HudSeverity.Warning;
            icon.enabled = marker && hasIcon;
            tagFill.enabled = marker;
            tagText.enabled = marker;
            if (marker)
            {
                icon.color = HudTokens.Severity(severity, HudTokens.InkPrimary);
                tagFill.color = warning ? HudTokens.WarningFill : HudTokens.Caution;
                tagText.color = warning ? Color.white : HudTokens.CautionInk;
                tagText.text = warning ? TagWarning : TagCaution;
            }
            message.color = marker ? HudTokens.InkPrimary : HudTokens.InkSecondary;
        }

        // Rebuilds the message and lays out icon, tag and message as one centered group (monospace char counts).
        private void SetMessage(int id, int number)
        {
            shownNumber = number;
            string text = Message(id, number);
            message.text = text;

            bool marker = shownSeverity >= HudSeverity.Caution;
            float messageWidth = text.Length * HudTokens.Advance(HudTokens.SizeLabel);
            float iconWidth = marker && hasIcon ? IconSize + IconGap : 0f;
            float tagWidth = marker ? tagRect.sizeDelta.x + TagGap : 0f;
            float x = -(iconWidth + tagWidth + messageWidth) * 0.5f;

            iconRect.anchoredPosition = new Vector2(x, 0f);
            x += iconWidth;
            tagRect.anchoredPosition = new Vector2(x, 0f);
            x += tagWidth;
            messageRect.anchoredPosition = new Vector2(x, 0f);
            messageRect.sizeDelta = new Vector2(messageWidth, TagHeight);
        }

        private void FadeTo(float target)
        {
            if (target == fadeTo && fadeT < 1f)
            {
                return;   // already heading there
            }
            if (target > 0f && !panelGo.activeSelf)
            {
                panelGo.SetActive(true);
            }
            fadeFrom = group.alpha;
            fadeTo = target;
            fadeT = fadeFrom == target ? 1f : 0f;
            if (fadeT >= 1f && target <= 0f)
            {
                panelGo.SetActive(false);
            }
        }

        private void TickFade(float dt)
        {
            if (fadeT >= 1f)
            {
                return;
            }
            float dur = HudTokens.Dur(fadeTo > fadeFrom ? HudTokens.DurAlertIn : HudTokens.DurAlertOut);
            fadeT = dur > 0f ? Mathf.Min(1f, fadeT + dt / dur) : 1f;
            group.alpha = Mathf.Lerp(fadeFrom, fadeTo, HudTokens.EaseOut(fadeT));
            if (fadeT >= 1f && fadeTo <= 0f)
            {
                panelGo.SetActive(false);   // also frees its reserved zone for rock cards
            }
        }

        // Caution: 2 pulses at 2 Hz then steady; warning: tag blinks at 2 Hz for up to 10 s then steady.
        private void TickTag()
        {
            float a = 1f;
            if (!HudTokens.ReducedMotion && shownId != None)
            {
                float t = now - tagOnset;
                if (shownSeverity == HudSeverity.Caution && t < HudTokens.CautionPulseCount / HudTokens.CautionPulseHz)
                {
                    a = 1f - (1f - PulseLowAlpha) * (0.5f - 0.5f * Mathf.Cos(2f * Mathf.PI * HudTokens.CautionPulseHz * t));
                }
                else if (shownSeverity == HudSeverity.Warning && t < HudTokens.WarningBlinkMaxS)
                {
                    a = Mathf.Repeat(t * HudTokens.WarningBlinkHz, 1f) < 0.5f ? 1f : BlinkLowAlpha;
                }
            }
            if (a != tagAlpha)
            {
                tagAlpha = a;
                tagGroup.alpha = a;
            }
        }
    }
}

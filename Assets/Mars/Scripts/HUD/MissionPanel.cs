using System.Globalization;
using NasaSpaceApp.Mission;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Top-right mission panel under the <see cref="MissionCaption"/>, shown while a web mission is loaded
    /// (<see cref="HudContext.Mission"/>): status (ON PLAN … RETURN NOW, coloured by severity) and waypoint count; next
    /// waypoint with its distance and predicted vs planned arrival; schedule and O₂ against the plan; live margin and its
    /// binding term; the recommended action. At a waypoint a stop card follows: the stop counter (elapsed / planned) with a
    /// progress bar, the waypoint's tags and note from the Mission Planer, and how to finish (walk away = early, or
    /// G ▸ Waypoints ▸ Complete). A waypoint without a stop shows the same card for a few seconds after arrival.
    /// Refreshes at 4 Hz; text and layout change only when their values do.
    /// </summary>
    public sealed class MissionPanel
    {
        private const float RefreshPeriod = 0.25f;
        private const float Width = 336f, Pad = 16f, Gap = 12f;
        private const float RowPitch = 22f;
        private const float ArrivalCardS = 8f;   // seconds a no-stop waypoint's card stays up (unscaled)
        private const float CaptionHeight = 78f; // MissionCaption panel height (same column)
        private const int NoteLines = 4;
        private const float AdviceTop = -131f;   // top of the advice text (below the Margin row at -114)

        private static readonly Color NominalGreen = HudTokens.Hex(0x5FD68E, 1f);
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        private readonly HudContext ctx;
        private readonly RectTransform panel;
        private readonly GameObject panelGo;
        private readonly Text status, count, nextLabel, nextValue, schedValue, o2Value, marginValue, advice, footer;
        private readonly Text stopTitle, stopCounter, stopTags, stopNote, stopHint;
        private readonly Text[] labels;
        private readonly HudLineMesh bar;
        private readonly Image divider;

        private float timer = RefreshPeriod;
        private float arrivalShownAt = float.NegativeInfinity;
        private int arrivalIndex = -1;
        private MissionTracker subscribed;
        private float shownHeight = -1f;
        private int barShown = -1;

        public MissionPanel(HudContext ctx)
        {
            this.ctx = ctx;
            HudSkin skin = ctx.Skin != null ? ctx.Skin : HudSkin.Load();
            Transform layer = ctx.StaticLayer != null ? ctx.StaticLayer : ctx.CanvasRect;
            Font regular = skin != null ? skin.Regular : null;
            Font medium = skin != null ? skin.Medium : null;
            Font semi = skin != null && skin.SemiBold != null ? skin.SemiBold : medium;

            Vector2 topRight = new Vector2(1f, 1f);
            Image img = HudFactory.CreatePanel("MissionPanel", layer, skin, HudTokens.Scrim, HudTokens.RadiusCard, topRight, topRight,
                                               new Vector2(-HudTokens.ScreenMargin, -(HudTokens.ScreenMargin + CaptionHeight + Gap)),
                                               new Vector2(Width, 200f));
            panel = img.rectTransform;
            panelGo = img.gameObject;
            ctx.ReserveZone(panel);

            Vector2 tl = new Vector2(0f, 1f), left = new Vector2(0f, 0.5f), right = new Vector2(1f, 0.5f);
            float wide = Width - 2f * Pad;
            float y = -20f;
            status = HudFactory.CreateText("Status", panel, semi, HudTokens.SizeValue, NominalGreen, TextAnchor.MiddleLeft,
                                           tl, left, new Vector2(Pad, y), new Vector2(200f, 22f));
            count = HudFactory.CreateText("Count", panel, regular, HudTokens.SizeLabel, HudTokens.InkSecondary, TextAnchor.MiddleRight,
                                          tl, right, new Vector2(Width - Pad, y), new Vector2(120f, 20f));
            y -= 28f;
            labels = new Text[4];
            nextLabel = Label(0, "Next", y, regular);
            nextValue = Value("Next", y, regular);
            y -= RowPitch;
            Label(1, "Schedule", y, regular);
            schedValue = Value("Sched", y, regular);
            y -= RowPitch;
            Label(2, "O₂ vs plan", y, regular);
            o2Value = Value("O2", y, regular);
            y -= RowPitch;
            Label(3, "Margin", y, regular);
            marginValue = Value("Margin", y, medium);
            advice = HudFactory.CreateWrappedText("Advice", panel, regular, HudTokens.SizeMicro, HudTokens.InkPrimary, TextAnchor.UpperLeft,
                                                  tl, tl, new Vector2(Pad, AdviceTop), new Vector2(wide, 40f));

            // Stop card (positioned in Layout).
            divider = HudFactory.CreateImage("StopDivider", panel, null, HudTokens.StrokeHair, tl, left, Vector2.zero, new Vector2(wide, 1f));
            stopTitle = HudFactory.CreateText("StopTitle", panel, medium, HudTokens.SizeLabel, MissionRouteStyle.Route, TextAnchor.MiddleLeft,
                                              tl, left, Vector2.zero, new Vector2(200f, 20f));
            stopCounter = HudFactory.CreateText("StopCounter", panel, medium, HudTokens.SizeValueLarge, HudTokens.InkPrimary,
                                                TextAnchor.MiddleRight, tl, right, Vector2.zero, new Vector2(160f, 26f));
            bar = HudFactory.CreateLineMesh("StopBar", panel, tl, left, Vector2.zero, new Vector2(wide, 6f));
            stopTags = HudFactory.CreateWrappedText("StopTags", panel, regular, HudTokens.SizeMicro, HudTokens.InkSecondary,
                                                    TextAnchor.UpperLeft, tl, tl, Vector2.zero, new Vector2(wide, 18f));
            stopNote = HudFactory.CreateWrappedText("StopNote", panel, regular, HudTokens.SizeLabel, HudTokens.InkPrimary,
                                                    TextAnchor.UpperLeft, tl, tl, Vector2.zero, new Vector2(wide, NoteLines * 20f));
            stopHint = HudFactory.CreateWrappedText("StopHint", panel, regular, HudTokens.SizeFoot, HudTokens.InkTertiary,
                                                    TextAnchor.UpperLeft, tl, tl, Vector2.zero, new Vector2(wide, 36f));
            footer = HudFactory.CreateText("Footer", panel, regular, HudTokens.SizeFoot, HudTokens.InkTertiary, TextAnchor.MiddleLeft,
                                           tl, left, Vector2.zero, new Vector2(wide, 18f));
            panelGo.SetActive(false);
        }

        private Text Label(int i, string text, float y, Font font)
        {
            Text t = HudFactory.CreateText("Label" + i, panel, font, HudTokens.SizeLabel, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                           new Vector2(0f, 1f), new Vector2(0f, 0.5f), new Vector2(Pad, y), new Vector2(120f, 20f));
            t.text = text;
            labels[i] = t;
            return t;
        }

        private Text Value(string name, float y, Font font)
        {
            return HudFactory.CreateText(name + "Value", panel, font, HudTokens.SizeLabel, HudTokens.InkPrimary, TextAnchor.MiddleRight,
                                         new Vector2(0f, 1f), new Vector2(1f, 0.5f), new Vector2(Width - Pad, y), new Vector2(220f, 20f));
        }

        /// <summary>Refreshes at 4 Hz (unscaled <paramref name="dt"/>).</summary>
        public void Tick(float dt)
        {
            MissionTracker m = ctx.Mission;
            if (!ReferenceEquals(m, subscribed))
            {
                if (subscribed != null) subscribed.WaypointArrived -= OnArrived;
                subscribed = m;
                if (m != null) m.WaypointArrived += OnArrived;
            }
            bool show = m != null && m.Active;
            if (panelGo.activeSelf != show)
            {
                panelGo.SetActive(show);
                timer = RefreshPeriod;
            }
            if (!show)
            {
                return;
            }
            timer += dt;
            if (timer < RefreshPeriod)
            {
                return;
            }
            timer = 0f;
            Refresh(m);
        }

        private void OnArrived(int index)
        {
            arrivalIndex = index;
            arrivalShownAt = ctx.UnscaledTime;
        }

        private void Refresh(MissionTracker m)
        {
            MissionPlan plan = m.Plan;
            int n = plan.Waypoints.Count;

            // Status pill and waypoint count.
            Set(status, MissionTracker.StatusLabel(m.Status));
            SetColor(status, StatusColor(m.Status));
            int closed = 0;
            for (int i = 0; i < m.States.Length; i++)
            {
                if (m.States[i] == WaypointState.Done || m.States[i] == WaypointState.Skipped) closed++;
            }
            Set(count, "WP " + closed.ToString(Inv) + " / " + n.ToString(Inv));

            // Next target.
            if (m.Complete)
            {
                Set(nextLabel, "EVA");
                Set(nextValue, Clock(m.CompleteAtMin) + " · plan " + Clock(m.NextPlannedMin));
            }
            else if (m.StopWaypoint >= 0)
            {
                Set(nextLabel, "At");
                Set(nextValue, "WP " + plan.Waypoints[m.StopWaypoint].Index.ToString(Inv) + " · stop");
            }
            else
            {
                string target = m.NextWaypoint >= 0 ? "WP " + plan.Waypoints[m.NextWaypoint].Index.ToString(Inv) : "Pad";
                Set(nextLabel, "Next");
                Set(nextValue, target + " " + Distance(m.RouteDistanceToNextM) + " · " + Clock(m.NextEtaMin) + " / " + Clock(m.NextPlannedMin));
            }

            // Schedule and O₂ against the plan.
            float d = m.ScheduleDeltaMin;
            string sched = float.IsNaN(d) ? "--" : Mathf.Abs(d) < 1f ? "on time" : Mathf.RoundToInt(Mathf.Abs(d)).ToString(Inv) + (d > 0f ? " min behind" : " min ahead");
            Set(schedValue, sched);
            SetColor(schedValue, !float.IsNaN(d) && d > MissionTracker.BehindCautionMin ? HudTokens.Caution : HudTokens.InkPrimary);
            float o2 = m.O2DeltaL;
            Set(o2Value, float.IsNaN(o2) ? "--" : (o2 >= 0f ? "+" : HudStrings.Minus.ToString()) + Mathf.Abs(o2).ToString("0.0", Inv) + " L");

            // Margin.
            float mm = m.MarginMin;
            Set(marginValue, float.IsNaN(mm) ? "--" : Mathf.FloorToInt(mm).ToString(Inv) + " min · " + BindingLabel(m.Binding));
            SetColor(marginValue, float.IsNaN(mm) ? HudTokens.InkTertiary
                                  : mm < 0f ? HudTokens.WarningText
                                  : mm < plan.MarginAmberMin ? HudTokens.Caution : NominalGreen);

            Set(advice, m.Advice());
            SetColor(advice, StatusColor(m.Status) == NominalGreen ? HudTokens.InkSecondary : StatusColor(m.Status));

            // Stop card: an active stop, or a recent arrival at a no-stop waypoint.
            int card = m.StopWaypoint;
            bool timed = card >= 0;
            if (!timed && arrivalIndex >= 0 && ctx.UnscaledTime - arrivalShownAt < ArrivalCardS && arrivalIndex < n)
            {
                card = arrivalIndex;
            }
            Layout(m, card, timed);
        }

        // Positions the stop card under the main block and sizes the panel to fit.
        private void Layout(MissionTracker m, int card, bool timed)
        {
            float wide = Width - 2f * Pad;
            float y = AdviceTop - AdviceHeight() - 10f;   // below the advice text
            bool show = card >= 0;
            Enable(divider, show);
            Enable(stopTitle, show);
            Enable(stopCounter, show && timed);
            Enable(bar, show && timed);
            Enable(stopTags, false);
            Enable(stopNote, false);
            Enable(stopHint, show && timed);
            if (show)
            {
                MissionWaypoint w = m.Plan.Waypoints[card];
                Place(divider.rectTransform, new Vector2(Pad, y));
                y -= 18f;
                Set(stopTitle, (timed ? "STOP · WP " : "ARRIVED · WP ") + w.Index.ToString(Inv));
                Place(stopTitle.rectTransform, new Vector2(Pad, y));
                if (timed)
                {
                    Set(stopCounter, MinSec(m.StopElapsedMin) + " / " + MinSec(m.StopPlannedMin));
                    Place(stopCounter.rectTransform, new Vector2(Width - Pad, y));
                    y -= 20f;
                    Place(bar.rectTransform, new Vector2(Pad, y));
                    int q = Mathf.Clamp(Mathf.RoundToInt(100f * m.StopElapsedMin / Mathf.Max(1e-3f, m.StopPlannedMin)), 0, 100);
                    if (q != barShown)
                    {
                        barShown = q;
                        bar.Clear();
                        bar.Line(new Vector2(0f, 0f), new Vector2(wide, 0f), 4f, HudTokens.StrokeHair);
                        if (q > 0) bar.Line(new Vector2(0f, 0f), new Vector2(wide * q / 100f, 0f), 4f, MissionRouteStyle.Route);
                        bar.Commit();
                    }
                }
                y -= 14f;
                if (w.Tags != null && w.Tags.Count > 0)
                {
                    Enable(stopTags, true);
                    Set(stopTags, string.Join(" · ", w.Tags));
                    Place(stopTags.rectTransform, new Vector2(Pad, y));
                    y -= 20f;
                }
                if (!string.IsNullOrEmpty(w.Note))
                {
                    Enable(stopNote, true);
                    Set(stopNote, w.Note);
                    Place(stopNote.rectTransform, new Vector2(Pad, y));
                    y -= Mathf.Min(NoteLines, Mathf.Max(1, Mathf.CeilToInt(stopNote.preferredHeight / 20f))) * 20f + 2f;
                }
                if (timed)
                {
                    Set(stopHint, "Walk away to finish early · G ▸ Waypoints ▸ Complete");
                    Place(stopHint.rectTransform, new Vector2(Pad, y));
                    y -= 36f;
                }
            }
            Set(footer, Footer(m.Plan));
            Place(footer.rectTransform, new Vector2(Pad, y - 8f));
            float height = -(y - 8f) + 18f;
            if (Mathf.Abs(height - shownHeight) > 0.5f)
            {
                shownHeight = height;
                panel.sizeDelta = new Vector2(Width, height);
            }
        }

        // Advice text: one or two lines of 14 px.
        private float AdviceHeight()
        {
            return advice.preferredHeight > 22f ? 36f : 18f;
        }

        private static string Footer(MissionPlan p)
        {
            return (p.Dummy ? "DUMMY DATA · " : string.Empty) + "Mission Planer plan · " + (p.Id ?? "?");
        }

        private static Color StatusColor(MissionStatus s)
        {
            switch (s)
            {
                case MissionStatus.ReturnNow: return HudTokens.WarningText;
                case MissionStatus.TurnBack:
                case MissionStatus.Replan:
                case MissionStatus.OffRoute:
                case MissionStatus.Behind: return HudTokens.Caution;
                case MissionStatus.Complete: return HudTokens.InkPrimary;
                default: return NominalGreen;
            }
        }

        private static string BindingLabel(string b)
        {
            return b == "O2" ? "O₂" : b ?? "--";
        }

        private static string Distance(float m)
        {
            if (float.IsNaN(m)) return "--";
            return m >= 1000f ? (m / 1000f).ToString("0.0", Inv) + " km" : Mathf.RoundToInt(m).ToString(Inv) + " m";
        }

        // EVA minute → "H:MM".
        private static string Clock(float min)
        {
            if (float.IsNaN(min) || float.IsInfinity(min)) return "--:--";
            int m = Mathf.Max(0, Mathf.RoundToInt(min));
            return (m / 60).ToString(Inv) + ":" + (m % 60).ToString("00", Inv);
        }

        // Minutes → "MM:SS".
        private static string MinSec(float min)
        {
            if (float.IsNaN(min)) return "--:--";
            int s = Mathf.Max(0, Mathf.FloorToInt(min * 60f));
            return (s / 60).ToString("00", Inv) + ":" + (s % 60).ToString("00", Inv);
        }

        private static void Set(Text t, string s)
        {
            if (t.text != s) t.text = s;
        }

        private static void SetColor(Graphic g, Color c)
        {
            if (g.color != c) g.color = c;
        }

        private static void Enable(Behaviour b, bool on)
        {
            if (b.enabled != on) b.enabled = on;
        }

        private static void Place(RectTransform rt, Vector2 pos)
        {
            if (rt.anchoredPosition != pos) rt.anchoredPosition = pos;
        }
    }
}

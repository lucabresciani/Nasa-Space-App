using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Top-right mission caption: local true solar time, sol, mission elapsed time and the simulation label. Reads
    /// <see cref="SuitTelemetry"/> (sky hub or DayNightCycle time; "LTST --:--" / "SOL --" when unknown). Refreshes at 4 Hz;
    /// text is assigned only when the cached string changes.
    /// </summary>
    public sealed class MissionCaption
    {
        private const float RefreshPeriod = 0.25f;   // 4 Hz
        private const float Width = 336f, Height = 78f;   // the 37-char sim label at 14 px (8 px advance) + 2 x 16 pad
        private const string SimLabel = "Simulated EVA · real terrain and data";   // HOMELINE label rule

        private readonly HudContext ctx;
        private readonly Text ltst, sol, met, lamp;
        private string ltstShown, solShown, metShown;
        private bool lampShown;
        private float timer = RefreshPeriod;   // first Tick refreshes

        public MissionCaption(HudContext ctx)
        {
            this.ctx = ctx;
            HudSkin skin = ctx.Skin != null ? ctx.Skin : HudSkin.Load();
            Transform layer = ctx.StaticLayer != null ? ctx.StaticLayer : ctx.CanvasRect;

            Vector2 topRight = new Vector2(1f, 1f);
            Image panel = HudFactory.CreatePanel("MissionCaption", layer, skin, HudTokens.Scrim, HudTokens.RadiusCard,
                                                 topRight, topRight, new Vector2(-HudTokens.ScreenMargin, -HudTokens.ScreenMargin),
                                                 new Vector2(Width, Height));
            RectTransform p = panel.rectTransform;
            ctx.ReserveZone(p);   // rock cards keep clear of the caption

            // Local coordinates from the panel's top-left, y down; row y = text center.
            Vector2 topLeft = new Vector2(0f, 1f);
            HudFactory.CreateIcon("Clock", p, skin.iconClock, HudTokens.InkSecondary, 16f, topLeft, new Vector2(0.5f, 0.5f),
                                  new Vector2(24f, -18f));
            ltst = HudFactory.CreateText("Ltst", p, skin.Medium, HudTokens.SizeLabel, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                         topLeft, new Vector2(0f, 0.5f), new Vector2(40f, -18f), new Vector2(160f, 20f));
            sol = HudFactory.CreateText("Sol", p, skin.Regular, HudTokens.SizeLabel, HudTokens.InkSecondary, TextAnchor.MiddleRight,
                                        topLeft, new Vector2(1f, 0.5f), new Vector2(Width - 16f, -18f), new Vector2(100f, 20f));
            met = HudFactory.CreateText("Met", p, skin.Regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                        topLeft, new Vector2(0f, 0.5f), new Vector2(40f, -39f), new Vector2(160f, 18f));
            lamp = HudFactory.CreateText("Lamp", p, skin.Medium, HudTokens.SizeMicro, HudTokens.InkPrimary, TextAnchor.MiddleRight,
                                         topLeft, new Vector2(1f, 0.5f), new Vector2(Width - 16f, -39f), new Vector2(100f, 18f));
            lamp.text = "LAMP ON";
            lamp.enabled = false;
            Text label = HudFactory.CreateText("SimLabel", p, skin.Regular, HudTokens.SizeFoot, HudTokens.InkTertiary, TextAnchor.MiddleLeft,
                                               topLeft, new Vector2(0f, 0.5f), new Vector2(16f, -61f), new Vector2(Width - 32f, 18f));
            label.text = SimLabel;
        }

        /// <summary>Refreshes the readouts at 4 Hz (unscaled <paramref name="dt"/>).</summary>
        public void Tick(float dt)
        {
            timer += dt;
            if (timer < RefreshPeriod)
            {
                return;
            }
            timer = 0f;

            int minuteOfSol = -1, solNumber = -1, metMinutes = 0;
            SuitTelemetry t = ctx.Telemetry;
            if (t != null)
            {
                float lst = t.LocalSolarTime;
                if (!float.IsNaN(lst) && !float.IsInfinity(lst))
                {
                    minuteOfSol = Mathf.Min(1439, Mathf.FloorToInt(Mathf.Repeat(lst, 1f) * 1440f));
                }
                solNumber = t.Sol;
                metMinutes = Mathf.FloorToInt(t.MetSeconds / 60f);
            }

            // During a web mission the clock is the planner's: LMST at the mission pad (Mars24), not LTST.
            NasaSpaceApp.Mission.MissionTracker mission = ctx.Mission;
            if (mission != null && mission.Active && MarsSkyState.Version > 0)
            {
                double h = MarsClock.LmstHoursAtDays(MarsSkyState.DaysTT, mission.Plan.Source.Frame.Pad.Lon);
                Assign(ltst, ref ltstShown, HudStrings.Lmst(Mathf.Min(1439, Mathf.FloorToInt((float)h * 60f))));
            }
            else
            {
                Assign(ltst, ref ltstShown, HudStrings.Ltst(minuteOfSol));
            }
            Assign(sol, ref solShown, HudStrings.Sol(solNumber));
            Assign(met, ref metShown, HudStrings.Met(metMinutes));
            bool lampOn = t != null && t.HeadlampOn;
            if (lampOn != lampShown)
            {
                lampShown = lampOn;
                lamp.enabled = lampOn;
            }
        }

        private static void Assign(Text text, ref string shown, string value)
        {
            if (!ReferenceEquals(shown, value))
            {
                shown = value;
                text.text = value;
            }
        }
    }
}

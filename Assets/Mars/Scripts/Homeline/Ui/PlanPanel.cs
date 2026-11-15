using System.Text;
using NasaSpaceApp.Homeline.Flow;
using NasaSpaceApp.Homeline.Sim;
using NasaSpaceApp.HUD;
using NasaSpaceApp.Menu;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Homeline.Ui
{
    /// <summary>
    /// The plan read-out shown during the EVA, on its own canvas: EVA clock, next waypoint, the planner's O2 and
    /// margin, and the text that says where each number comes from.
    ///
    /// Honest labelling is the point of this panel:
    ///   replay     O2 and margin are the planner's timeline values (margin interpolated between its rows);
    ///   free walk  O2 is the planner's model applied to the ground actually walked; the margin uses the planner's
    ///              return fields where they exist (official plan) and says "n/a" elsewhere. Without the planner's
    ///              model the panel says the suit read-out is the game's own.
    /// Weather, heart rate, CO2 and dose rate on the helmet are the game's simulation, never the planner's.
    /// </summary>
    public sealed class PlanPanel : MonoBehaviour
    {
        const float Width = 460f, Height = 326f, Left = 28f, TopFromMiddle = 250f;
        const float RefreshSeconds = 0.2f;

        Canvas canvas;
        Text title, body, footer;
        float nextRefresh;
        readonly StringBuilder sb = new StringBuilder(640);

        void Start()
        {
            Build();
        }

        void Build()
        {
            var go = new GameObject("HOMELINE Plan Panel");
            go.transform.SetParent(transform, false);
            canvas = go.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = 60; // above the helmet HUD (50), below the menu (200)
            var scaler = go.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);
            scaler.matchWidthOrHeight = 1f;

            HudSkin skin = HudSkin.Load();
            Font mono = skin != null ? (skin.monoMedium != null ? skin.monoMedium : skin.monoRegular) : null;
            if (mono == null) mono = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

            var leftMiddle = new Vector2(0f, 0.5f);
            var topLeft = new Vector2(0f, 1f);
            Image box = HudFactory.CreatePanel("Box", go.transform, skin, new Color(0.03f, 0.03f, 0.05f, 0.80f), 14f,
                                               leftMiddle, topLeft, new Vector2(Left, TopFromMiddle), new Vector2(Width, Height));
            RectTransform r = box.rectTransform;
            title = HudFactory.CreateText("Title", r, mono, 15, new Color(0.92f, 0.85f, 0.75f, 1f), TextAnchor.UpperLeft,
                                          topLeft, topLeft, new Vector2(16f, -12f), new Vector2(Width - 32f, 20f));
            body = HudFactory.CreateWrappedText("Body", r, mono, 15, new Color(0.96f, 0.96f, 0.96f, 1f), TextAnchor.UpperLeft,
                                                topLeft, topLeft, new Vector2(16f, -40f), new Vector2(Width - 32f, 210f));
            body.verticalOverflow = VerticalWrapMode.Overflow;
            body.lineSpacing = 1.12f;
            footer = HudFactory.CreateWrappedText("Footer", r, mono, 13, new Color(0.78f, 0.72f, 0.63f, 1f), TextAnchor.LowerLeft,
                                                  topLeft, topLeft, new Vector2(16f, -(Height - 62f)), new Vector2(Width - 32f, 52f));
            footer.verticalOverflow = VerticalWrapMode.Overflow;
            canvas.enabled = false;
        }

        void LateUpdate()
        {
            if (canvas == null) return;
            HomelineApp app = HomelineApp.Instance;
            EvaDriver d = app != null ? app.Driver : null;
            // Hidden under the menu and under the helmet's full-screen map (G), which it would otherwise cover.
            HelmetHud hud = HelmetHud.Instance;
            bool mapOpen = hud != null && hud.Context != null && hud.Context.MapScreenOpen;
            bool show = d != null && d.Active && !MartisMenu.IsOpen && !mapOpen;
            if (canvas.enabled != show) canvas.enabled = show;
            if (!show || Time.unscaledTime < nextRefresh) return;
            nextRefresh = Time.unscaledTime + RefreshSeconds;
            Refresh(d);
        }

        void Refresh(EvaDriver d)
        {
            MissionPlan plan = d.Plan;
            double t = d.TMin;
            title.text = MissionPlan.LabelSimulated.ToUpperInvariant();

            sb.Length = 0;
            sb.Append("PLAN    ").Append(plan.Entry.Title).Append('\n');
            sb.Append("        ").Append(plan.Entry.Origin == PlanOrigin.Official ? PlanCatalog.LabelOfficial : ShortOrigin(plan.Entry)).Append('\n');
            if (d.Mode == EvaMode.Replay)
            {
                sb.Append("MODE    REPLAY ").Append(HlJson.F(d.Speed, 0)).Append("x");
                sb.Append(d.ReplayFinished ? "  back at the rover" : (d.Playing ? "" : "  paused")).Append('\n');
            }
            else
            {
                sb.Append("MODE    FREE WALK 1x").Append('\n');
            }
            sb.Append("EVA     ").Append(Clock(t)).Append(" of ").Append(Clock(plan.EndMin)).Append('\n');

            Waypoint next = plan.Waypoints.NextAfter(t, true);
            if (next != null)
            {
                sb.Append("NEXT    ").Append(next.Id == "pad" ? "ROVER" : next.Id);
                if (d.Mode == EvaMode.Replay) sb.Append("  in ").Append(HlJson.F(next.ArriveMin - t, 0)).Append(" min");
                else sb.Append("  planned at ").Append(Clock(next.ArriveMin));
                sb.Append('\n');
            }
            else sb.Append("NEXT    -\n");

            if (d.Mode == EvaMode.Replay)
            {
                double? o2 = plan.O2LeftAt(t), margin = plan.MarginAt(t);
                string binding = plan.BindingAt(t);
                sb.Append("O2      ").Append(o2.HasValue ? HlJson.F(o2.Value, 1) + " L" : "-").Append('\n');
                sb.Append("MARGIN  ").Append(margin.HasValue ? HlJson.F(margin.Value, 0) + " min" : "-");
                if (!string.IsNullOrEmpty(binding)) sb.Append("  limit: ").Append(binding);
                sb.Append('\n');
                if (d.THomeMin.HasValue) sb.Append("HOME    ").Append(HlJson.F(d.THomeMin.Value, 0)).Append(" min walk").Append('\n');
                footer.text = "O2: planner timeline. Margin: timeline, interpolated.\nSuit vitals, weather and dose rate: SIM.\n[ ] speed   T pause   V walk freely";
            }
            else if (d.Live != null)
            {
                LiveState live = d.Live;
                sb.Append("O2      ").Append(HlJson.F(live.O2LeftL, 1)).Append(" L  ").Append(HlJson.F(live.RateLMin, 2)).Append(" L/min").Append('\n');
                sb.Append("SLOPE   ").Append(HlJson.F(live.GradeDeg, 0)).Append(" deg  max ");
                sb.Append(live.SpeedCapMs.HasValue ? HlJson.F(live.SpeedCapMs.Value, 2) + " m/s" : "no-go").Append('\n');
                if (live.AtStation != null)
                    sb.Append("WORK    ").Append(live.AtStation.Id).Append("  ").Append(HlJson.F(live.AtStation.DwellMin - live.AtStation.WorkedMin, 0)).Append(" min left").Append('\n');
                if (d.LiveMarginMin.HasValue)
                {
                    sb.Append("HOME    ").Append(HlJson.F(d.THomeMin.Value, 0)).Append(" min  ").Append(HlJson.F(d.O2HomeL.Value, 1)).Append(" L").Append('\n');
                    sb.Append("MARGIN  ").Append(HlJson.F(d.LiveMarginMin.Value, 0)).Append(" min  limit: ").Append(d.LiveBinding).Append('\n');
                    footer.text = "O2: planner model on the ground walked (no weather term).\nMargin: O2, daylight, EVA duration; dose term not live.\nV back to replay";
                }
                else
                {
                    sb.Append("MARGIN  n/a (no return field ").Append(plan.HasReturnFields ? "here" : "for this pad").Append(")\n");
                    footer.text = "O2: planner model on the ground walked (no weather term).\nSuit vitals, weather and dose rate: SIM.\nV back to replay";
                }
            }
            else
            {
                double? o2 = plan.O2LeftAt(t);
                sb.Append("O2      suit read-out = SIM\n");
                sb.Append("PLAN O2 ").Append(o2.HasValue ? HlJson.F(o2.Value, 1) + " L at this time" : "-").Append('\n');
                footer.text = "O2: SIM (game model, not the planner).\nPlan values are for the planned track.\nV back to replay";
            }
            if (!d.OnDetailedTerrain) sb.Append("TERRAIN coarse (32 m)\n");
            body.text = sb.ToString();
        }

        static string ShortOrigin(PlanEntry e)
        {
            return e.Origin == PlanOrigin.Live ? "Computed live, not validated" : "Precomputed, alternative pad";
        }

        static string Clock(double minutes)
        {
            if (minutes < 0) minutes = 0;
            int total = (int)System.Math.Floor(minutes * 60.0 + 0.5);
            int h = total / 3600, m = total / 60 % 60, s = total % 60;
            return h.ToString("00") + ":" + m.ToString("00") + ":" + s.ToString("00");
        }
    }
}

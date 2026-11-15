using System.Collections.Generic;
using System.Text;
using NasaSpaceApp.Homeline.Flow;
using NasaSpaceApp.HUD;
using NasaSpaceApp.Menu;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Homeline.Ui
{
    /// <summary>
    /// MISSION PLANNING: the screen shown before the EVA, hosted by the MARTIS menu as one of its panels (so the menu
    /// keeps handling focus, keyboard, gamepad, Back and fades).
    ///
    ///   1. choose one of the plans the HOMELINE planner engine precomputed (official pad, alternative pads, and any
    ///      engine-service result found on disk);
    ///   2. GENERATE WAYPOINTS FROM PLAN: loads the engine's route and timeline and derives the waypoints;
    ///   3. optionally move a station by dragging it on the map (official plan only): the simulator re-routes the
    ///      plan with the planner's cost model and says so; RESET TO PLANNER PLAN undoes it;
    ///   4. START EVA, as a replay of the plan or as a free walk from the pad.
    ///
    /// The wording never suggests that the planner engine computed something here: an unedited plan is the planner's,
    /// an edited plan is labelled as the simulator's re-computation.
    /// </summary>
    public sealed class PlanningPanel : MenuPanel
    {
        const float W = MenuTokens.ContentWidth;
        const float RowH = 40f, RowGap = 3f, ListTop = 30f;
        const int MaxTitleChars = 36;
        const int MaxRows = 6;

        readonly HomelineApp app;
        readonly List<Button> rows = new List<Button>();
        readonly List<Image> rowMarks = new List<Image>();
        MenuButton generate, reset, startReplay, startWalk;
        string editProblem;
        Text table, result;
        PlanMap map;
        int chosen;
        MissionPlan generated;
        bool generateFailed;

        public PlanningPanel(HomelineApp app)
        {
            this.app = app;
        }

        public override string Title => "MISSION PLANNING";

        public override Selectable DefaultSelection => rows.Count > 0 ? rows[Mathf.Clamp(chosen, 0, rows.Count - 1)] : null;

        public override void Build(MenuContext ctx, RectTransform content)
        {
            var topLeft = new Vector2(0f, 1f);
            Font regular = ctx.Assets != null ? ctx.Assets.Regular : null;
            Font medium = ctx.Assets != null ? ctx.Assets.Medium : null;
            Font mono = ctx.Assets != null ? ctx.Assets.Mono : null;

            IReadOnlyList<PlanEntry> plans = app.Catalog.Plans;
            int precomputed = 0;
            foreach (PlanEntry e in plans) if (e.Origin != PlanOrigin.Live) precomputed++;
            string caption = MissionPlan.LabelSimulated + "\n" + precomputed + " plans precomputed by the HOMELINE planner engine · " +
                             ScenarioText(app.Catalog.ScenarioId);
            Text cap = MenuUi.Paragraph("Caption", content, regular, MenuTokens.SizeHint, MenuTokens.SandDim, TextAnchor.UpperLeft,
                                        topLeft, topLeft, new Vector2(0f, 4f), new Vector2(W, 34f), caption);
            cap.lineSpacing = 1.05f;

            int n = Mathf.Min(plans.Count, MaxRows);
            for (int i = 0; i < n; i++)
            {
                int index = i;
                float y = -(ListTop + i * (RowH + RowGap));
                Image bg = MenuUi.Pill("Plan" + i, content, ctx, Color.white, MenuTokens.RowRadius, topLeft, topLeft,
                                       new Vector2(0f, y), new Vector2(W, RowH));
                bg.raycastTarget = true;
                var button = bg.gameObject.AddComponent<Button>();
                button.targetGraphic = bg;
                ColorBlock colors = button.colors;
                colors.normalColor = MenuTokens.Alpha(MenuTokens.RowFocus, 0.35f);
                colors.highlightedColor = MenuTokens.RowFocus;
                // Focus must read clearly above the rest state (keyboard and gamepad users see only this).
                colors.selectedColor = HudTokens.Light(0xEAD8BE, 0.30f);
                colors.pressedColor = HudTokens.Light(0xEAD8BE, 0.40f);
                colors.disabledColor = MenuTokens.Alpha(MenuTokens.RowFocus, 0.15f);
                colors.colorMultiplier = 1f;
                colors.fadeDuration = MenuTokens.Dur(MenuTokens.DurFocus);
                button.colors = colors;
                button.onClick.AddListener(() => Choose(index));
                rows.Add(button);

                // Chosen-plan mark: a bronze bar on the left edge (shape, not colour alone, carries the state).
                Image mark = HudFactory.CreateImage("Mark", bg.transform, null, MenuTokens.BronzeBright, new Vector2(0f, 0.5f),
                                                    new Vector2(0f, 0.5f), new Vector2(6f, 0f), new Vector2(4f, RowH - 14f));
                rowMarks.Add(mark);

                PlanEntry e = plans[i];
                MenuUi.Label("Title", bg.transform, medium, MenuTokens.SizeBody, MenuTokens.Sand, TextAnchor.MiddleLeft,
                             new Vector2(0f, 0.5f), new Vector2(0f, 0.5f), new Vector2(20f, 0f), new Vector2(330f, RowH), Clip(e.Title));
                string stops = e.Stops != null && e.Stops.Length > 0 ? string.Join(" › ", e.Stops) : "";
                MenuUi.Label("Stops", bg.transform, mono, MenuTokens.SizeSmall, MenuTokens.SandDim, TextAnchor.MiddleLeft,
                             new Vector2(0f, 0.5f), new Vector2(0f, 0.5f), new Vector2(352f, 0f), new Vector2(200f, RowH), stops);
                string right = e.TotalMin.HasValue ? HlJson.F(e.TotalMin.Value, 0) + "\u00a0min" : "";
                if (!string.IsNullOrEmpty(e.Note)) right = right.Length > 0 ? e.Note + " · " + right : e.Note;
                MenuUi.Label("Minutes", bg.transform, mono, MenuTokens.SizeSmall, MenuTokens.Sand, TextAnchor.MiddleRight,
                             new Vector2(1f, 0.5f), new Vector2(1f, 0.5f), new Vector2(-14f, 0f), new Vector2(230f, RowH), right);
            }

            float y0 = ListTop + n * (RowH + RowGap) + 26f;
            generate = MenuButton.Create(ctx, content, "GENERATE WAYPOINTS FROM PLAN", MenuTokens.SizeTab, topLeft,
                                         new Vector2(0f, 0.5f), new Vector2(0f, -y0), Generate);
            reset = MenuButton.Create(ctx, content, "RESET TO PLANNER PLAN", MenuTokens.SizeTab, topLeft,
                                      new Vector2(0f, 0.5f), new Vector2(generate.Width + 60f, -y0), ResetEdit);

            float tableTop = y0 + 30f;
            table = MenuUi.Paragraph("Table", content, mono, MenuTokens.SizeHint, MenuTokens.Sand, TextAnchor.UpperLeft,
                                     topLeft, topLeft, new Vector2(0f, -tableTop), new Vector2(W, 150f), "");
            table.horizontalOverflow = HorizontalWrapMode.Overflow;
            table.lineSpacing = 1.2f;

            result = MenuUi.Paragraph("Result", content, regular, MenuTokens.SizeFine, MenuTokens.SandDim, TextAnchor.UpperLeft,
                                      topLeft, topLeft, new Vector2(0f, -(MenuTokens.ContentHeight - 118f)), new Vector2(W, 60f), "");

            float by = MenuTokens.ContentHeight - 26f;
            startReplay = MenuButton.Create(ctx, content, "START EVA · REPLAY", MenuTokens.SizeTab, topLeft,
                                            new Vector2(0f, 0.5f), new Vector2(0f, -by), () => Begin(EvaMode.Replay));
            startWalk = MenuButton.Create(ctx, content, "START EVA · FREE WALK", MenuTokens.SizeTab, topLeft,
                                          new Vector2(0f, 0.5f), new Vector2(startReplay.Width + 60f, -by), () => Begin(EvaMode.FreeWalk));

            // The map of the generated plan sits to the right of the panel box.
            map = new PlanMap(ctx, content, new Vector2(W + MenuTokens.PanelPad + 28f, MenuTokens.PanelHeaderHeight - 4f), 600f);
            map.StationMoved = (id, x, y) => MoveStation(id, x, y);
            map.Probe = (x, y) => app.ProbeStationPoint(generated, x, y);

            WireNavigation();
            Choose(DefaultIndex());
        }

        public override void OnShow()
        {
            RefreshState();
        }

        /// <summary>Selects a plan row (index in the catalog). Changing the plan clears the generated waypoints.</summary>
        public void Choose(int index)
        {
            if (index < 0 || index >= rows.Count) return;
            if (index != chosen)
            {
                generated = null;
                generateFailed = false;
                editProblem = null;
            }
            chosen = index;
            RefreshState();
        }

        /// <summary>GENERATE WAYPOINTS FROM PLAN.</summary>
        public void Generate()
        {
            if (chosen < 0 || chosen >= app.Catalog.Plans.Count) return;
            generated = app.Generate(app.Catalog.Plans[chosen]);
            generateFailed = generated == null;
            editProblem = null;
            RefreshState();
            if (generated != null && startReplay != null && UnityEngine.EventSystems.EventSystem.current != null)
                UnityEngine.EventSystems.EventSystem.current.SetSelectedGameObject(startReplay.gameObject);
        }

        /// <summary>START EVA with the generated plan.</summary>
        public void Begin(EvaMode mode)
        {
            if (generated == null) return;
            app.Begin(generated, mode);
        }

        public MissionPlan Generated { get { return generated; } }

        /// <summary>
        /// Moves a station of the generated plan to a point of the frame (what dropping its mark on the map does):
        /// the simulator re-routes the plan through it. Returns false, with the reason on screen, when it cannot.
        /// </summary>
        public bool MoveStation(string stationId, double x, double y)
        {
            if (generated == null) return false;
            string problem;
            MissionPlan edited = app.MoveStation(generated, stationId, x, y, out problem);
            editProblem = edited == null ? problem : null;
            if (edited != null) generated = edited;
            RefreshState();
            return edited != null;
        }

        /// <summary>RESET TO PLANNER PLAN: drops every manual edit.</summary>
        public void ResetEdit()
        {
            if (generated == null || !generated.Edited) return;
            generated = generated.BasePlan;
            editProblem = null;
            RefreshState();
            if (generate != null && UnityEngine.EventSystems.EventSystem.current != null)
                UnityEngine.EventSystems.EventSystem.current.SetSelectedGameObject(generate.gameObject);
        }

        int DefaultIndex()
        {
            IReadOnlyList<PlanEntry> plans = app.Catalog.Plans;
            for (int i = 0; i < plans.Count && i < rows.Count; i++)
                if (plans[i].Origin == PlanOrigin.Official) return i;
            return 0;
        }

        void RefreshState()
        {
            for (int i = 0; i < rowMarks.Count; i++) rowMarks[i].enabled = i == chosen;
            bool ready = generated != null;
            if (startReplay != null) startReplay.SetInteractable(ready);
            if (startWalk != null) startWalk.SetInteractable(ready);
            if (reset != null) reset.SetInteractable(ready && generated.Edited);
            if (table == null) return;

            PlanEntry e = chosen >= 0 && chosen < app.Catalog.Plans.Count ? app.Catalog.Plans[chosen] : null;
            if (map != null)
            {
                map.Editable = ready && app.CanEdit(generated);
                if (ready) map.Show(generated);
                else map.Hide();
            }
            if (!ready)
            {
                table.text = e == null ? ""
                    : generateFailed ? "This plan could not be read.\nCheck that the HomelineData folder next to the app is complete,\nthen try again or pick another plan."
                    : "No waypoints yet for this plan.\nPress GENERATE WAYPOINTS FROM PLAN.";
                result.text = e == null ? "" : e.OriginLabel;
                return;
            }
            table.text = TableText(generated);
            if (generated.Edited)
            {
                EditedPlanData d = generated.EditData;
                string margin = d.Feasible
                    ? "Smallest margin " + HlJson.F(d.MinMarginMin, 0) + "\u00a0min (limit: " + d.MinMarginBinding + ") at " + d.MinMarginWhere + "."
                    : "NOT FEASIBLE: the margin falls to " + HlJson.F(d.MinMarginMin, 0) + "\u00a0min (limit: " + d.MinMarginBinding + ") at " +
                      d.MinMarginWhere + ". Move the station closer or reset.";
                result.text = generated.Waypoints.CountText() + ". " + PlanEditor.LabelRerouted + "\n" + margin +
                              (editProblem != null ? " Last move refused: " + editProblem : "");
                return;
            }
            result.text = generated.GenerationText() + "\n" + generated.Entry.OriginLabel +
                          (generated.HasReturnFields ? "" : " · Off the planned track: " + MissionPlan.LabelNoReturnField + ".") +
                          (editProblem != null ? "\nMove refused: " + editProblem : "");
        }

        static string TableText(MissionPlan plan)
        {
            var sb = new StringBuilder(640);
            sb.Append("WAYPOINT  ARRIVE  LEAVE   O2 LEFT   MARGIN  LIMIT         NAV PTS\n");
            IReadOnlyList<Waypoint> main = plan.Waypoints.Main;
            for (int i = 0; i < main.Count; i++)
            {
                Waypoint w = main[i];
                int nav = 0;
                foreach (Waypoint a in plan.Waypoints.All)
                    if (a.Kind == WaypointKind.Nav && a.LegIndex == w.LegIndex) nav++;
                string id = w.Kind == WaypointKind.Pad ? "ROVER" : (w.Kind == WaypointKind.Return ? "ROVER" : w.Id);
                sb.Append(Pad(id, 10));
                sb.Append(Pad(w.Kind == WaypointKind.Pad ? "-" : Clock(w.ArriveMin), 8));
                sb.Append(Pad(w.LeaveMin.HasValue && w.Kind != WaypointKind.Return ? Clock(w.LeaveMin.Value) : "-", 8));
                sb.Append(Pad(w.O2LeftArriveL.HasValue ? HlJson.F(w.O2LeftArriveL.Value, 1) + " L" : "-", 10));
                sb.Append(Pad(w.MarginArriveMin.HasValue ? HlJson.F(w.MarginArriveMin.Value, 0) + " min" : "-", 8));
                sb.Append(Pad(string.IsNullOrEmpty(w.Binding) ? "-" : w.Binding, 14));
                sb.Append(w.LegIndex >= 0 ? nav.ToString(System.Globalization.CultureInfo.InvariantCulture) : "-");
                if (i < main.Count - 1) sb.Append('\n');
            }
            return sb.ToString();
        }

        /// <summary>Long titles (live plans carry user text) are cut with an ellipsis instead of running into the next column.</summary>
        static string Clip(string s)
        {
            if (string.IsNullOrEmpty(s) || s.Length <= MaxTitleChars) return s;
            return s.Substring(0, MaxTitleChars - 1).TrimEnd() + "\u2026";
        }

        static string Pad(string s, int width)
        {
            return s.Length >= width ? s + " " : s.PadRight(width);
        }

        static string Clock(double minutes)
        {
            int total = (int)System.Math.Floor(minutes + 0.5);
            return (total / 60).ToString("0") + "h" + (total % 60).ToString("00");
        }

        static string ScenarioText(string scenarioId)
        {
            // "nom_104" = nominal physiology, 104 kg suit (the planner's scenario ids).
            if (string.IsNullOrEmpty(scenarioId)) return "";
            string[] p = scenarioId.Split('_');
            string variant = p[0] == "nom" ? "nominal" : (p[0] == "con" ? "conservative" : (p[0] == "opt" ? "optimistic" : p[0]));
            return p.Length > 1 ? variant + " · " + p[1] + " kg suit" : variant;
        }

        void WireNavigation()
        {
            // Explicit vertical order: plan rows, GENERATE, then the two START buttons side by side.
            for (int i = 0; i < rows.Count; i++)
            {
                Navigation nav = rows[i].navigation;
                nav.mode = Navigation.Mode.Explicit;
                nav.selectOnUp = i > 0 ? rows[i - 1] : null;
                nav.selectOnDown = i < rows.Count - 1 ? (Selectable)rows[i + 1] : generate;
                rows[i].navigation = nav;
            }
            Navigation g = generate.navigation;
            g.mode = Navigation.Mode.Explicit;
            g.selectOnUp = rows.Count > 0 ? rows[rows.Count - 1] : null;
            g.selectOnDown = startReplay;
            g.selectOnRight = reset;
            generate.navigation = g;

            Navigation x = reset.navigation;
            x.mode = Navigation.Mode.Explicit;
            x.selectOnUp = rows.Count > 0 ? rows[rows.Count - 1] : null;
            x.selectOnDown = startWalk;
            x.selectOnLeft = generate;
            reset.navigation = x;

            Navigation r = startReplay.navigation;
            r.mode = Navigation.Mode.Explicit;
            r.selectOnUp = generate;
            r.selectOnRight = startWalk;
            startReplay.navigation = r;

            Navigation w = startWalk.navigation;
            w.mode = Navigation.Mode.Explicit;
            w.selectOnUp = generate;
            w.selectOnLeft = startReplay;
            startWalk.navigation = w;
        }
    }
}

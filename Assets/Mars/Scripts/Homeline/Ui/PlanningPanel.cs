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
    ///   1. choose a plan: one the HOMELINE planner engine precomputed (PLANNER PLANS), or one of the routes saved
    ///      here earlier (MY ROUTES);
    ///   2. GENERATE WAYPOINTS FROM PLAN: loads the route and timeline and derives the waypoints;
    ///   3. optionally move a station by dragging it on the map: the simulator re-routes the plan with the planner's
    ///      cost model and says so; RESET PLAN undoes it, SAVE ROUTE keeps it in MY ROUTES;
    ///   4. START EVA, as a replay of the plan or as a free walk from the pad.
    ///
    /// START is offered only for a plan that respects the limits (oxygen, daylight, dose, EVA duration), whoever made
    /// it. The wording never suggests that the planner engine computed something here: an unedited plan is the
    /// planner's, an edited plan is labelled as the simulator's re-computation.
    /// </summary>
    public sealed class PlanningPanel : MenuPanel
    {
        const float W = MenuTokens.ContentWidth;
        const float RowH = 40f, RowGap = 3f, ListTop = 30f;
        const int MaxTitleChars = 36;
        const int MaxRows = 6;

        sealed class Row
        {
            public Button Button;
            public Image Mark;
            public Text Title, Stops, Right;
        }

        sealed class Item
        {
            public PlanEntry Entry;
            public SavedRoute Saved;
        }

        readonly HomelineApp app;
        readonly List<Row> rows = new List<Row>();
        readonly List<Item> items = new List<Item>();
        MenuButton tab, generate, reset, save, startReplay, startWalk;
        Text caption, table, result;
        PlanMap map;
        bool showSaved;
        int chosen;
        MissionPlan generated, savedPlan;
        bool generateFailed;
        string note;

        public PlanningPanel(HomelineApp app)
        {
            this.app = app;
        }

        public override string Title => "MISSION PLANNING";

        public override Selectable DefaultSelection => items.Count > 0 ? rows[Mathf.Clamp(chosen, 0, items.Count - 1)].Button : (Selectable)tab;

        /// <summary>The plan shown, after GENERATE and any manual edit; null before.</summary>
        public MissionPlan Generated { get { return generated; } }
        /// <summary>True when START EVA is offered: a plan is generated and respects the limits.</summary>
        public bool StartAllowed { get; private set; }
        /// <summary>True when the list shows the user's saved routes instead of the planner's plans.</summary>
        public bool ShowingSaved { get { return showSaved; } }
        public int ItemCount { get { return items.Count; } }

        public override void Build(MenuContext ctx, RectTransform content)
        {
            var topLeft = new Vector2(0f, 1f);
            Font regular = ctx.Assets != null ? ctx.Assets.Regular : null;
            Font medium = ctx.Assets != null ? ctx.Assets.Medium : null;
            Font mono = ctx.Assets != null ? ctx.Assets.Mono : null;

            caption = MenuUi.Paragraph("Caption", content, regular, MenuTokens.SizeHint, MenuTokens.SandDim, TextAnchor.UpperLeft,
                                       topLeft, topLeft, new Vector2(0f, 4f), new Vector2(W - 200f, 34f), "");
            caption.lineSpacing = 1.05f;
            tab = MenuButton.Create(ctx, content, "PLANNER PLANS", MenuTokens.SizeTab, topLeft,
                                    new Vector2(0f, 0.5f), new Vector2(W - 190f, -12f), ToggleList);

            int n = Mathf.Clamp(app.Catalog.Plans.Count, 1, MaxRows);
            for (int i = 0; i < n; i++)
            {
                int index = i;
                float y = -(ListTop + i * (RowH + RowGap));
                Image bg = MenuUi.Pill("Plan" + i, content, ctx, Color.white, MenuTokens.RowRadius, topLeft, topLeft,
                                       new Vector2(0f, y), new Vector2(W, RowH));
                bg.raycastTarget = true;
                var row = new Row();
                row.Button = bg.gameObject.AddComponent<Button>();
                row.Button.targetGraphic = bg;
                ColorBlock colors = row.Button.colors;
                colors.normalColor = MenuTokens.Alpha(MenuTokens.RowFocus, 0.35f);
                colors.highlightedColor = MenuTokens.RowFocus;
                // Focus must read clearly above the rest state (keyboard and gamepad users see only this).
                colors.selectedColor = HudTokens.Light(0xEAD8BE, 0.30f);
                colors.pressedColor = HudTokens.Light(0xEAD8BE, 0.40f);
                colors.disabledColor = MenuTokens.Alpha(MenuTokens.RowFocus, 0.15f);
                colors.colorMultiplier = 1f;
                colors.fadeDuration = MenuTokens.Dur(MenuTokens.DurFocus);
                row.Button.colors = colors;
                row.Button.onClick.AddListener(() => Choose(index));

                // Chosen-plan mark: a bronze bar on the left edge (shape, not colour alone, carries the state).
                row.Mark = HudFactory.CreateImage("Mark", bg.transform, null, MenuTokens.BronzeBright, new Vector2(0f, 0.5f),
                                                  new Vector2(0f, 0.5f), new Vector2(6f, 0f), new Vector2(4f, RowH - 14f));
                row.Title = MenuUi.Label("Title", bg.transform, medium, MenuTokens.SizeBody, MenuTokens.Sand, TextAnchor.MiddleLeft,
                                         new Vector2(0f, 0.5f), new Vector2(0f, 0.5f), new Vector2(20f, 0f), new Vector2(330f, RowH), "");
                row.Stops = MenuUi.Label("Stops", bg.transform, mono, MenuTokens.SizeSmall, MenuTokens.SandDim, TextAnchor.MiddleLeft,
                                         new Vector2(0f, 0.5f), new Vector2(0f, 0.5f), new Vector2(352f, 0f), new Vector2(200f, RowH), "");
                row.Right = MenuUi.Label("Minutes", bg.transform, mono, MenuTokens.SizeSmall, MenuTokens.Sand, TextAnchor.MiddleRight,
                                         new Vector2(1f, 0.5f), new Vector2(1f, 0.5f), new Vector2(-14f, 0f), new Vector2(230f, RowH), "");
                rows.Add(row);
            }

            float y0 = ListTop + n * (RowH + RowGap) + 26f;
            generate = MenuButton.Create(ctx, content, "GENERATE WAYPOINTS FROM PLAN", MenuTokens.SizeTab, topLeft,
                                         new Vector2(0f, 0.5f), new Vector2(0f, -y0), Generate);
            reset = MenuButton.Create(ctx, content, "RESET PLAN", MenuTokens.SizeTab, topLeft,
                                      new Vector2(0f, 0.5f), new Vector2(generate.Width + 56f, -y0), ResetEdit);
            save = MenuButton.Create(ctx, content, "SAVE ROUTE", MenuTokens.SizeTab, topLeft,
                                     new Vector2(0f, 0.5f), new Vector2(generate.Width + reset.Width + 112f, -y0), () => SaveRoute());

            float tableTop = y0 + 30f;
            table = MenuUi.Paragraph("Table", content, mono, MenuTokens.SizeHint, MenuTokens.Sand, TextAnchor.UpperLeft,
                                     topLeft, topLeft, new Vector2(0f, -tableTop), new Vector2(W, 150f), "");
            table.horizontalOverflow = HorizontalWrapMode.Overflow;
            table.lineSpacing = 1.2f;

            result = MenuUi.Paragraph("Result", content, regular, MenuTokens.SizeFine, MenuTokens.SandDim, TextAnchor.UpperLeft,
                                      topLeft, topLeft, new Vector2(0f, -(MenuTokens.ContentHeight - 118f)), new Vector2(W, 64f), "");

            float by = MenuTokens.ContentHeight - 26f;
            startReplay = MenuButton.Create(ctx, content, "START EVA · REPLAY", MenuTokens.SizeTab, topLeft,
                                            new Vector2(0f, 0.5f), new Vector2(0f, -by), () => Begin(EvaMode.Replay));
            startWalk = MenuButton.Create(ctx, content, "START EVA · FREE WALK", MenuTokens.SizeTab, topLeft,
                                          new Vector2(0f, 0.5f), new Vector2(startReplay.Width + 60f, -by), () => Begin(EvaMode.FreeWalk));

            // The map of the generated plan sits to the right of the panel box.
            map = new PlanMap(ctx, content, new Vector2(W + MenuTokens.PanelPad + 28f, MenuTokens.PanelHeaderHeight - 4f), 600f);
            map.StationMoved = (id, x, y) => MoveStation(id, x, y);
            map.Probe = (x, y) => app.ProbeStationPoint(generated, x, y);

            Rebind();
            Choose(DefaultIndex());
        }

        public override void OnShow()
        {
            RefreshState();
        }

        /// <summary>A pad without planner way-home map gets one computed in the background; the screen follows.</summary>
        public override void Tick(float unscaledDeltaTime)
        {
            if (generated != null && !generated.HasReturnFields) app.EnsureHomeMap(generated);
            if (app.PollHomeMap()) RefreshState();
        }

        /// <summary>Switches the list between the planner's plans and the user's saved routes.</summary>
        public void ShowSavedRoutes(bool saved)
        {
            if (showSaved == saved) return;
            showSaved = saved;
            generated = null;
            generateFailed = false;
            note = null;
            Rebind();
            chosen = showSaved ? 0 : DefaultIndex();
            RefreshState();
        }

        void ToggleList()
        {
            ShowSavedRoutes(!showSaved);
        }

        /// <summary>Selects a row of the list. Changing the plan clears the generated waypoints.</summary>
        public void Choose(int index)
        {
            if (index < 0 || index >= items.Count) return;
            if (index != chosen)
            {
                generated = null;
                generateFailed = false;
                note = null;
            }
            chosen = index;
            RefreshState();
        }

        /// <summary>GENERATE WAYPOINTS FROM PLAN (for a saved route: re-builds it from its saved stations).</summary>
        public void Generate()
        {
            if (chosen < 0 || chosen >= items.Count) return;
            Item item = items[chosen];
            note = null;
            if (item.Saved != null)
            {
                string problem;
                generated = app.LoadSaved(item.Saved, out problem);
                if (generated == null) note = "This saved route could not be re-built: " + problem;
                savedPlan = generated;
            }
            else
            {
                generated = app.Generate(item.Entry);
                if (generated != null) app.EnsureHomeMap(generated);
            }
            generateFailed = generated == null;
            RefreshState();
            if (StartAllowed && startReplay != null && UnityEngine.EventSystems.EventSystem.current != null)
                UnityEngine.EventSystems.EventSystem.current.SetSelectedGameObject(startReplay.gameObject);
        }

        /// <summary>START EVA with the generated plan; refused for a plan that breaks a limit.</summary>
        public void Begin(EvaMode mode)
        {
            if (generated == null || !StartAllowed) return;
            app.Begin(generated, mode);
        }

        /// <summary>
        /// Moves a station of the generated plan to a point of the frame (what dropping its mark on the map does):
        /// the simulator re-routes the plan through it. Returns false, with the reason on screen, when it cannot.
        /// </summary>
        public bool MoveStation(string stationId, double x, double y)
        {
            if (generated == null) return false;
            string problem;
            MissionPlan edited = app.MoveStation(generated, stationId, x, y, out problem);
            note = edited == null ? "Move refused: " + problem : null;
            if (edited != null) generated = edited;
            RefreshState();
            return edited != null;
        }

        /// <summary>RESET PLAN: drops every manual edit and shows the planner's plan again.</summary>
        public void ResetEdit()
        {
            if (generated == null || !generated.Edited) return;
            generated = generated.BasePlan;
            note = null;
            RefreshState();
            if (generate != null && UnityEngine.EventSystems.EventSystem.current != null)
                UnityEngine.EventSystems.EventSystem.current.SetSelectedGameObject(generate.gameObject);
        }

        /// <summary>SAVE ROUTE: keeps the edited plan in MY ROUTES. Only a plan that respects the limits can be saved.</summary>
        public bool SaveRoute()
        {
            if (generated == null || !generated.Edited || !StartAllowed || ReferenceEquals(savedPlan, generated)) return false;
            string problem;
            SavedRoute r = app.SaveRoute(generated, out problem);
            note = r != null ? "Saved as \"" + r.Name + "\". Find it under MY ROUTES." : "Not saved: " + problem;
            if (r != null) savedPlan = generated;
            if (showSaved) Rebind();
            RefreshState();
            return r != null;
        }

        int DefaultIndex()
        {
            if (showSaved) return 0;
            for (int i = 0; i < items.Count; i++)
                if (items[i].Entry != null && items[i].Entry.Origin == PlanOrigin.Official) return i;
            return 0;
        }

        /// <summary>Fills the rows from the list being shown (planner plans, or saved routes newest first).</summary>
        void Rebind()
        {
            items.Clear();
            List<SavedRoute> saved = app.SavedRoutes();
            if (showSaved)
            {
                foreach (SavedRoute r in saved)
                {
                    if (items.Count == rows.Count) break;
                    items.Add(new Item { Saved = r });
                }
            }
            else
            {
                foreach (PlanEntry e in app.Catalog.Plans)
                {
                    if (items.Count == rows.Count) break;
                    items.Add(new Item { Entry = e });
                }
            }
            for (int i = 0; i < rows.Count; i++)
            {
                Row row = rows[i];
                bool on = i < items.Count;
                row.Button.gameObject.SetActive(on);
                if (!on) continue;
                Item it = items[i];
                if (it.Saved != null)
                {
                    var ids = new List<string>();
                    foreach (EditStop s in it.Saved.Stops) ids.Add(s.Id);
                    row.Title.text = Clip(it.Saved.Name);
                    row.Stops.text = string.Join(" › ", ids.ToArray());
                    row.Right.text = HlJson.F(it.Saved.EndMin, 0) + " min";
                }
                else
                {
                    PlanEntry e = it.Entry;
                    row.Title.text = Clip(e.Title);
                    row.Stops.text = e.Stops != null && e.Stops.Length > 0 ? string.Join(" › ", e.Stops) : "";
                    string right = e.TotalMin.HasValue ? HlJson.F(e.TotalMin.Value, 0) + " min" : "";
                    if (!string.IsNullOrEmpty(e.Note)) right = right.Length > 0 ? e.Note + " · " + right : e.Note;
                    row.Right.text = right;
                }
            }
            if (chosen >= items.Count) chosen = Mathf.Max(0, items.Count - 1);

            int precomputed = 0;
            foreach (PlanEntry e in app.Catalog.Plans) if (e.Origin != PlanOrigin.Live) precomputed++;
            caption.text = showSaved
                ? MissionPlan.LabelSimulated + "\nYour saved routes, newest first" + (saved.Count > rows.Count ? " (the latest " + rows.Count + " of " + saved.Count + ")" : "") + "."
                : MissionPlan.LabelSimulated + "\n" + precomputed + " plans precomputed by the HOMELINE planner engine · " + ScenarioText(app.Catalog.ScenarioId);
            tab.SetLabel(showSaved ? "PLANNER PLANS" : "MY ROUTES (" + saved.Count + ")");
            WireNavigation();
        }

        void RefreshState()
        {
            for (int i = 0; i < rows.Count; i++) rows[i].Mark.enabled = i == chosen && i < items.Count;
            bool ready = generated != null;
            double minMargin = 0, atMin = 0;
            string binding = null;
            double? o2Return = null;
            double reserve = app.Config != null ? app.Config.O2ReserveL : 0;
            bool limitsOk = ready && generated.LimitsOk(reserve, out minMargin, out binding, out atMin, out o2Return);
            StartAllowed = limitsOk;
            if (startReplay != null) startReplay.SetInteractable(limitsOk);
            if (startWalk != null) startWalk.SetInteractable(limitsOk);
            if (reset != null) reset.SetInteractable(ready && generated.Edited);
            if (save != null) save.SetInteractable(limitsOk && generated.Edited && !ReferenceEquals(savedPlan, generated));
            if (tab != null && !showSaved) tab.SetLabel("MY ROUTES (" + app.SavedRoutes().Count + ")");
            if (table == null) return;

            if (map != null)
            {
                map.Editable = ready && app.CanEdit(generated);
                if (ready) map.Show(generated);
                else map.Hide();
            }
            if (!ready)
            {
                table.text = items.Count == 0
                        ? (showSaved ? "No saved routes yet.\nOpen PLANNER PLANS, generate a plan, drag a station on the map,\nthen press SAVE ROUTE." : "")
                    : generateFailed ? (showSaved ? "This saved route could not be re-built." : "This plan could not be read.\nCheck that the HomelineData folder next to the app is complete,\nthen try again or pick another plan.")
                    : "No waypoints yet for this " + (showSaved ? "route" : "plan") + ".\nPress GENERATE WAYPOINTS FROM PLAN.";
                Item it = chosen >= 0 && chosen < items.Count ? items[chosen] : null;
                result.text = note != null ? note : (it == null ? "" : (it.Saved != null ? PlanCatalog.LabelEdited : it.Entry.OriginLabel));
                return;
            }

            table.text = TableText(generated);
            var sb = new StringBuilder(420);
            sb.Append(generated.Waypoints.CountText());
            if (generated.Edited) sb.Append(". ").Append(PlanEditor.LabelRerouted);
            else sb.Append(" (navigation points derived by the simulator). Route, timings, O₂: planner engine, precomputed.");
            sb.Append('\n');
            string where = "at " + Clock(atMin);
            string o2Text = o2Return.HasValue ? HlJson.F(o2Return.Value, 1) + " L of O₂ at the return (reserve " + HlJson.F(reserve, 1) + " L)" : "";
            if (limitsOk)
            {
                sb.Append("Limits respected: smallest margin ").Append(HlJson.F(minMargin, 0)).Append(" min (limit: ").Append(binding).Append(") ").Append(where);
                if (o2Text.Length > 0) sb.Append("; ").Append(o2Text);
                sb.Append('.');
                if (generated.Edited && generated.EditData != null)
                    sb.Append(" Oxygen alone: ").Append(HlJson.F(generated.EditData.MinO2MarginMin, 0)).Append(" min at ").Append(generated.EditData.MinO2MarginWhere).Append('.');
            }
            else
            {
                sb.Append("LIMITS NOT RESPECTED, START is off: margin ").Append(HlJson.F(minMargin, 0)).Append(" min (limit: ").Append(binding).Append(") ").Append(where);
                if (o2Text.Length > 0) sb.Append("; ").Append(o2Text);
                sb.Append(generated.Edited ? ". Move the station closer or press RESET PLAN." : ".");
            }
            if (note != null) sb.Append('\n').Append(note);
            else if (!generated.HasReturnFields)
                sb.Append('\n').Append(app.HomeMapPending(generated) ? "Preparing this pad's way-home map; its stations can be moved in a few seconds."
                                                                      : "Off the planned track: " + MissionPlan.LabelNoReturnField + ".");
            else if (!generated.PlannerHomeMap && !generated.Edited)
                sb.Append('\n').Append("Way-home map of this pad: computed by the simulator with the planner's model.");
            result.text = sb.ToString();
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
            return s.Substring(0, MaxTitleChars - 1).TrimEnd() + "…";
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
            // Vertical order: list switch, rows, GENERATE / RESET / SAVE, then the two START buttons.
            int count = items.Count;
            Selectable firstRow = count > 0 ? rows[0].Button : null, lastRow = count > 0 ? rows[count - 1].Button : null;
            for (int i = 0; i < count; i++)
            {
                Navigation nav = rows[i].Button.navigation;
                nav.mode = Navigation.Mode.Explicit;
                nav.selectOnUp = i > 0 ? rows[i - 1].Button : (Selectable)tab;
                nav.selectOnDown = i < count - 1 ? (Selectable)rows[i + 1].Button : generate;
                rows[i].Button.navigation = nav;
            }
            Navigation t = tab.navigation;
            t.mode = Navigation.Mode.Explicit;
            t.selectOnDown = firstRow != null ? firstRow : generate;
            tab.navigation = t;

            Navigation g = generate.navigation;
            g.mode = Navigation.Mode.Explicit;
            g.selectOnUp = lastRow != null ? lastRow : tab;
            g.selectOnDown = startReplay;
            g.selectOnRight = reset;
            generate.navigation = g;

            Navigation x = reset.navigation;
            x.mode = Navigation.Mode.Explicit;
            x.selectOnUp = lastRow != null ? lastRow : tab;
            x.selectOnDown = startWalk;
            x.selectOnLeft = generate;
            x.selectOnRight = save;
            reset.navigation = x;

            Navigation s = save.navigation;
            s.mode = Navigation.Mode.Explicit;
            s.selectOnUp = lastRow != null ? lastRow : tab;
            s.selectOnDown = startWalk;
            s.selectOnLeft = reset;
            save.navigation = s;

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

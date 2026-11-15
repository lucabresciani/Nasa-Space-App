using System;
using System.Collections.Generic;
using System.Globalization;
using NasaSpaceApp.Mission;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// "Waypoints" tab of the map screen's right column, next to the legend, shown while a web mission is loaded. A list
    /// of the mission's waypoints (number, state, planned arrival, note) and a detail box for the selected one: planned
    /// arrive / stop / leave, what actually happened, the Mission Planer's tags and note, a <b>Complete</b> button
    /// (<see cref="MissionTracker.CompleteWaypoint"/>: ends the stop, or closes a waypoint without visiting it) and
    /// <b>Show on map</b>. Without a mission the tabs hide and the column shows the plain "Map legend" title.
    /// Refreshes at the screen's 10 Hz only when the selection, page or the tracker's state changed.
    /// </summary>
    public sealed class MapWaypointsTab
    {
        private const int RowsPerPage = 8;
        private const float RowPitch = 34f, RowH = 30f, TabW = 132f, TabH = 30f, BtnH = 32f;
        private const int SizeRow = HudTokens.SizeLabel;

        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        private static readonly Color SelectedFill = HudTokens.Light(0xFFFFFF, 0.10f);

        private readonly HudContext ctx;
        private readonly MapView map;
        private readonly Text legendTitle;
        private readonly RectTransform legendRect;
        private readonly RectTransform root;
        private readonly GameObject tabsGo;
        private readonly Text legendTabText, waypointTabText;
        private readonly Image legendTabLine, waypointTabLine;
        private readonly List<Row> rows = new List<Row>(RowsPerPage);
        private readonly Button prevPage, nextPage;
        private readonly Text pageText;
        private readonly Text detailTitle, detailPlan, detailLive, detailTags, detailNote;
        private readonly Button completeButton, showButton;
        private readonly Text completeText;
        private readonly float width;

        private bool waypointsTab;
        private int selected = -1, page;
        private int shownKey = int.MinValue;
        private int missionVersionShown = -1;

        private sealed class Row
        {
            public Image Fill;
            public Text Number, State, Note, Time;
        }

        /// <summary>
        /// Builds the tabs at <paramref name="titlePos"/> (where the legend title sits) and the waypoint view over the
        /// legend's area <paramref name="area"/> (top-left position and size in <paramref name="frame"/>).
        /// </summary>
        public MapWaypointsTab(HudContext ctx, RectTransform frame, HudSkin skin, Font regular, Font medium, MapView map,
                               Text legendTitle, RectTransform legendRect, Vector2 titlePos, Vector2 areaPos, Vector2 areaSize)
        {
            this.ctx = ctx;
            this.map = map;
            this.legendTitle = legendTitle;
            this.legendRect = legendRect;
            width = areaSize.x;
            Vector2 tl = new Vector2(0f, 1f), left = new Vector2(0f, 0.5f), right = new Vector2(1f, 0.5f), mid = new Vector2(0.5f, 0.5f);

            // Tabs: "Map legend" | "Waypoints", underline on the active one.
            RectTransform tabs = HudFactory.CreateRect("MapTabs", frame, tl, left, titlePos, new Vector2(2f * TabW + 8f, TabH));
            tabsGo = tabs.gameObject;
            legendTabText = TabButton(tabs, skin, medium, "Map legend", 0f, () => SetTab(false), out legendTabLine);
            waypointTabText = TabButton(tabs, skin, medium, "Waypoints", TabW + 8f, () => SetTab(true), out waypointTabLine);

            root = HudFactory.CreateRect("Waypoints", frame, tl, tl, areaPos, areaSize);

            // List rows.
            for (int i = 0; i < RowsPerPage; i++)
            {
                int slot = i;
                float y = -(i * RowPitch);
                Button b = MakeButton("Row" + i, root, skin, tl, tl, new Vector2(0f, y), new Vector2(width, RowH), () => Select(slot));
                var row = new Row { Fill = (Image)b.targetGraphic };
                RectTransform r = row.Fill.rectTransform;
                row.Number = HudFactory.CreateText("Num", r, medium, SizeRow, MissionRouteStyle.Route, TextAnchor.MiddleLeft,
                                                   left, left, new Vector2(8f, 0f), new Vector2(44f, 20f));
                row.State = HudFactory.CreateText("State", r, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                                  left, left, new Vector2(52f, 0f), new Vector2(76f, 20f));
                row.Note = HudFactory.CreateText("Note", r, regular, SizeRow, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                                 left, left, new Vector2(130f, 0f), new Vector2(width - 200f, 20f));
                row.Time = HudFactory.CreateText("Time", r, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleRight,
                                                 right, right, new Vector2(-8f, 0f), new Vector2(64f, 20f));
                rows.Add(row);
            }
            float pagerY = -(RowsPerPage * RowPitch) - 4f;
            prevPage = MakeButton("PrevPage", root, skin, tl, tl, new Vector2(0f, pagerY), new Vector2(80f, 26f), () => Page(-1), regular, "◀ Prev");
            nextPage = MakeButton("NextPage", root, skin, tl, tl, new Vector2(width - 80f, pagerY), new Vector2(80f, 26f), () => Page(1), regular, "Next ▶");
            pageText = HudFactory.CreateText("Page", root, regular, HudTokens.SizeMicro, HudTokens.InkTertiary, TextAnchor.MiddleCenter,
                                             tl, new Vector2(0.5f, 0.5f), new Vector2(width * 0.5f, pagerY - 13f), new Vector2(160f, 20f));

            // Detail box.
            float y0 = pagerY - 40f;
            HudFactory.CreateImage("DetailDivider", root, null, HudTokens.StrokeHair, tl, left, new Vector2(0f, y0), new Vector2(width, 1f));
            detailTitle = HudFactory.CreateText("DetailTitle", root, medium, HudTokens.SizeValue, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                                tl, left, new Vector2(0f, y0 - 20f), new Vector2(width, 22f));
            detailPlan = HudFactory.CreateText("DetailPlan", root, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                               tl, left, new Vector2(0f, y0 - 44f), new Vector2(width, 20f));
            detailLive = HudFactory.CreateText("DetailLive", root, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                               tl, left, new Vector2(0f, y0 - 64f), new Vector2(width, 20f));
            detailTags = HudFactory.CreateText("DetailTags", root, regular, HudTokens.SizeMicro, MissionRouteStyle.Route, TextAnchor.MiddleLeft,
                                               tl, left, new Vector2(0f, y0 - 86f), new Vector2(width, 20f));
            detailNote = HudFactory.CreateWrappedText("DetailNote", root, regular, SizeRow, HudTokens.InkPrimary, TextAnchor.UpperLeft,
                                                      tl, tl, new Vector2(0f, y0 - 98f), new Vector2(width, 80f));
            float by = y0 - 196f;
            completeButton = MakeButton("Complete", root, skin, tl, tl, new Vector2(0f, by), new Vector2(150f, BtnH), OnComplete, medium, "Complete");
            completeText = completeButton.GetComponentInChildren<Text>();
            showButton = MakeButton("ShowOnMap", root, skin, tl, tl, new Vector2(162f, by), new Vector2(150f, BtnH), OnShow, regular, "Show on map");
            Outline(completeButton, skin);
            Outline(showButton, skin);

            root.gameObject.SetActive(false);
            tabsGo.SetActive(false);
        }

        /// <summary>Called by the map screen at 10 Hz while it is open.</summary>
        public void Refresh()
        {
            MissionTracker m = ctx.Mission;
            bool has = m != null && m.Active;
            if (tabsGo.activeSelf != has)
            {
                tabsGo.SetActive(has);
                legendTitle.enabled = !has;
                if (!has)
                {
                    waypointsTab = false;
                }
                ApplyTab();
            }
            if (!has)
            {
                return;
            }
            if (MissionLink.Version != missionVersionShown)
            {
                missionVersionShown = MissionLink.Version;
                selected = m.NextWaypoint >= 0 ? m.NextWaypoint : 0;
                page = selected / RowsPerPage;
                shownKey = int.MinValue;
            }
            if (!waypointsTab)
            {
                return;
            }
            int key = m.Version * 7919 + selected * 31 + page + Mathf.FloorToInt(m.EvaMin * 60f) * 104729;
            if (key == shownKey)
            {
                return;
            }
            shownKey = key;
            Draw(m);
        }

        private void Draw(MissionTracker m)
        {
            MissionPlan plan = m.Plan;
            int n = plan.Waypoints.Count;
            if (selected >= n) selected = n - 1;
            int pages = Mathf.Max(1, (n + RowsPerPage - 1) / RowsPerPage);
            page = Mathf.Clamp(page, 0, pages - 1);
            int noteChars = Mathf.Max(4, Mathf.FloorToInt((width - 200f) / HudTokens.Advance(SizeRow)));

            for (int r = 0; r < RowsPerPage; r++)
            {
                int i = page * RowsPerPage + r;
                Row row = rows[r];
                bool on = i < n;
                GameObject go = row.Fill.gameObject;
                if (go.activeSelf != on) go.SetActive(on);
                if (!on) continue;
                MissionWaypoint w = plan.Waypoints[i];
                Color fill = i == selected ? SelectedFill : new Color(1f, 1f, 1f, 0f);
                Button b = go.GetComponent<Button>();
                ColorBlock cb = b.colors;
                if (cb.normalColor != fill)
                {
                    cb.normalColor = fill;
                    cb.selectedColor = fill;
                    b.colors = cb;
                }
                row.Number.text = "#" + w.Index.ToString(Inv);
                string state = StateLabel(m, i, out Color sc);
                row.State.text = state;
                row.State.color = sc;
                bool closed = m.States[i] == WaypointState.Done || m.States[i] == WaypointState.Skipped;
                row.Number.color = closed ? MissionRouteStyle.Done : MissionRouteStyle.Route;
                row.Note.text = HudStrings.Truncate(string.IsNullOrEmpty(w.Note) ? "(no note)" : w.Note, noteChars);
                row.Note.color = string.IsNullOrEmpty(w.Note) ? HudTokens.InkTertiary : HudTokens.InkPrimary;
                row.Time.text = Clock(w.ArriveMin);
            }
            bool paged = pages > 1;
            prevPage.gameObject.SetActive(paged);
            nextPage.gameObject.SetActive(paged);
            pageText.text = paged ? "Page " + (page + 1).ToString(Inv) + " / " + pages.ToString(Inv) : string.Empty;

            // Detail of the selected waypoint.
            if (selected < 0)
            {
                return;
            }
            MissionWaypoint s = plan.Waypoints[selected];
            string st = StateLabel(m, selected, out Color stc);
            detailTitle.text = "Waypoint #" + s.Index.ToString(Inv) + " · " + st;
            detailTitle.color = stc == HudTokens.InkSecondary ? HudTokens.InkPrimary : stc;
            detailPlan.text = "Plan: arrive " + Clock(s.ArriveMin) + " · stop " + Minutes(s.StopMin) + " · leave " + Clock(s.LeaveMin);
            float arr = m.ArrivedAtMin[selected], done = m.DoneAtMin[selected];
            string live;
            switch (m.States[selected])
            {
                case WaypointState.Stopping:
                    live = "Now: arrived " + Clock(arr) + " · stopping " + MinSec(m.StopElapsedMin) + " of " + MinSec(m.StopPlannedMin);
                    break;
                case WaypointState.Done:
                    live = float.IsNaN(arr)
                        ? "Closed " + Clock(done) + " without a visit (Complete)"
                        : "Arrived " + Clock(arr) + " · done " + Clock(done) + (m.LeftEarly[selected] ? " (left early)" : string.Empty);
                    break;
                case WaypointState.Skipped:
                    live = "Skipped (a later waypoint was reached first)";
                    break;
                default:
                    live = selected == m.NextWaypoint
                        ? "Next · " + DistanceText(m.RouteDistanceToNextM) + " · ETA " + Clock(m.NextEtaMin)
                        : "Not reached yet";
                    break;
            }
            detailLive.text = live;
            detailTags.text = s.Tags != null && s.Tags.Count > 0 ? "Tags: " + string.Join(" · ", s.Tags) : "No tags";
            detailTags.color = s.Tags != null && s.Tags.Count > 0 ? MissionRouteStyle.Route : HudTokens.InkTertiary;
            detailNote.text = string.IsNullOrEmpty(s.Note) ? "No note from the Mission Planer." : s.Note;
            detailNote.color = string.IsNullOrEmpty(s.Note) ? HudTokens.InkTertiary : HudTokens.InkPrimary;
            bool canComplete = m.States[selected] == WaypointState.Upcoming || m.States[selected] == WaypointState.Stopping;
            completeButton.interactable = canComplete;
            completeText.text = m.States[selected] == WaypointState.Stopping ? "Complete stop" : canComplete ? "Complete" : "Closed";
            completeText.color = canComplete ? HudTokens.InkPrimary : HudTokens.InkTertiary;
        }

        private static string StateLabel(MissionTracker m, int i, out Color c)
        {
            switch (m.States[i])
            {
                case WaypointState.Stopping: c = MissionRouteStyle.Route; return "STOP";
                case WaypointState.Done: c = HudTokens.InkTertiary; return "DONE";
                case WaypointState.Skipped: c = HudTokens.Caution; return "SKIPPED";
                default:
                    if (i == m.NextWaypoint) { c = HudTokens.InkPrimary; return "NEXT"; }
                    c = HudTokens.InkSecondary;
                    return "—";
            }
        }

        // ---- actions

        private void SetTab(bool waypoints)
        {
            waypointsTab = waypoints;
            shownKey = int.MinValue;
            ApplyTab();
        }

        private void ApplyTab()
        {
            bool has = tabsGo.activeSelf;
            bool wp = has && waypointsTab;
            if (root.gameObject.activeSelf != wp) root.gameObject.SetActive(wp);
            if (legendRect.gameObject.activeSelf == wp) legendRect.gameObject.SetActive(!wp);
            legendTabText.color = wp ? HudTokens.InkSecondary : HudTokens.InkPrimary;
            waypointTabText.color = wp ? HudTokens.InkPrimary : HudTokens.InkSecondary;
            legendTabLine.enabled = !wp;
            waypointTabLine.enabled = wp;
        }

        private void Select(int slot)
        {
            MissionTracker m = ctx.Mission;
            if (m == null || !m.Active) return;
            int i = page * RowsPerPage + slot;
            if (i < m.Plan.Waypoints.Count)
            {
                selected = i;
                shownKey = int.MinValue;
            }
        }

        private void Page(int delta)
        {
            page += delta;
            shownKey = int.MinValue;
        }

        private void OnComplete()
        {
            MissionTracker m = ctx.Mission;
            if (m == null || !m.Active || selected < 0) return;
            m.CompleteWaypoint(selected);
            Debug.Log("[Mission] waypoint #" + m.Plan.Waypoints[selected].Index + " completed from the map screen");
            shownKey = int.MinValue;
        }

        private void OnShow()
        {
            MissionTracker m = ctx.Mission;
            if (m == null || !m.Active || selected < 0 || map == null) return;
            map.CenterOn(m.Plan.Waypoints[selected].World);
        }

        // ---- building

        private Text TabButton(RectTransform parent, HudSkin skin, Font font, string label, float x, Action onClick, out Image underline)
        {
            Vector2 tl = new Vector2(0f, 1f);
            Button b = MakeButton("Tab" + label, parent, skin, tl, tl, new Vector2(x, 0f), new Vector2(TabW, TabH), onClick, font, label);
            Text t = b.GetComponentInChildren<Text>();
            t.fontSize = HudTokens.SizeValue;
            underline = HudFactory.CreateImage("Underline", b.transform, null, MissionRouteStyle.Route, new Vector2(0.5f, 0f),
                                               new Vector2(0.5f, 0f), new Vector2(0f, 1f), new Vector2(TabW - 16f, 2f));
            return t;
        }

        private static Button MakeButton(string name, Transform parent, HudSkin skin, Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 size,
                                         Action onClick, Font font = null, string label = null)
        {
            Image hit = HudFactory.CreatePanel(name, parent, skin, Color.white, HudTokens.RadiusButton, anchor, pivot, pos, size);
            hit.raycastTarget = true;
            if (label != null)
            {
                HudFactory.CreateText("Label", hit.rectTransform, font, HudTokens.SizeLabel, HudTokens.InkPrimary, TextAnchor.MiddleCenter,
                                      new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, size).text = label;
            }
            var button = hit.gameObject.AddComponent<Button>();
            button.transition = Selectable.Transition.ColorTint;
            button.targetGraphic = hit;
            button.navigation = new Navigation { mode = Navigation.Mode.None };
            Color rest = new Color(1f, 1f, 1f, 0f);
            ColorBlock colors = ColorBlock.defaultColorBlock;
            colors.normalColor = rest;
            colors.highlightedColor = HudTokens.HoverFill;
            colors.pressedColor = HudTokens.PressFill;
            colors.selectedColor = rest;
            colors.disabledColor = rest;
            colors.colorMultiplier = 1f;
            colors.fadeDuration = 0f;           // no white flash on the first apply
            button.colors = colors;
            colors.fadeDuration = HudTokens.DurButton;
            button.colors = colors;
            button.onClick.AddListener(() => onClick());
            return button;
        }

        private static void Outline(Button b, HudSkin skin)
        {
            RectTransform r = (RectTransform)b.transform;
            HudFactory.CreateOutline(b.name + "Outline", r, skin, HudTokens.StrokeHair, HudTokens.RadiusButton, new Vector2(0.5f, 0.5f),
                                     new Vector2(0.5f, 0.5f), Vector2.zero, r.sizeDelta);
        }

        // ---- formatting

        private static string Clock(float min)
        {
            if (float.IsNaN(min) || float.IsInfinity(min)) return "--:--";
            int m = Mathf.Max(0, Mathf.RoundToInt(min));
            return (m / 60).ToString(Inv) + ":" + (m % 60).ToString("00", Inv);
        }

        private static string MinSec(float min)
        {
            if (float.IsNaN(min)) return "--:--";
            int s = Mathf.Max(0, Mathf.FloorToInt(min * 60f));
            return (s / 60).ToString("00", Inv) + ":" + (s % 60).ToString("00", Inv);
        }

        private static string Minutes(float min)
        {
            return float.IsNaN(min) ? "--" : Mathf.RoundToInt(min).ToString(Inv) + " min";
        }

        private static string DistanceText(float m)
        {
            if (float.IsNaN(m)) return "--";
            return m >= 1000f ? (m / 1000f).ToString("0.0", Inv) + " km" : Mathf.RoundToInt(m).ToString(Inv) + " m";
        }
    }
}

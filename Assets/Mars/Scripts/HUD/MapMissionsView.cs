using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using NasaSpaceApp.Mission;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// "Missions" tab of the map screen's right column: the loaded mission, the mission files found on disk
    /// (<see cref="MissionFileBrowser.Find"/>: ~/Downloads, ~/Desktop, persistentDataPath; newest first) with title,
    /// waypoints, planned EVA and date, and buttons: <b>Load</b> (the selected file), <b>Browse…</b> (the system's file
    /// dialog), <b>Refresh</b>, <b>Clear mission</b>. Loading starts a fresh EVA on the mission pad, as F5 does.
    /// </summary>
    public sealed class MapMissionsView
    {
        private const int Rows = 9;
        private const float RowPitch = 40f, RowH = 36f, BtnH = 32f;
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        private static readonly Color SelectedFill = HudTokens.Light(0xFFFFFF, 0.10f);

        private readonly HudContext ctx;
        private readonly RectTransform root;
        private readonly float width;
        private readonly Text loadedTitle, loadedSub, status, empty;
        private readonly List<Row> rows = new List<Row>(Rows);
        private readonly Button loadButton, browseButton, clearButton;
        private readonly Action onLoaded;

        private List<MissionFileInfo> files = new List<MissionFileInfo>();
        private int selected = -1;
        private bool dirty = true;
        private int missionVersionShown = -1;
        private string message;

        private sealed class Row
        {
            public Button Button;
            public Image Fill;
            public Text Title, Sub;
        }

        public RectTransform Root => root;

        public MapMissionsView(HudContext ctx, RectTransform frame, HudSkin skin, Font regular, Font medium, Vector2 areaPos, Vector2 areaSize,
                               Action onLoaded)
        {
            this.ctx = ctx;
            this.onLoaded = onLoaded;
            width = areaSize.x;
            Vector2 tl = new Vector2(0f, 1f), left = new Vector2(0f, 0.5f);
            root = HudFactory.CreateRect("Missions", frame, tl, tl, areaPos, areaSize);

            loadedTitle = HudFactory.CreateText("Loaded", root, medium, HudTokens.SizeLabel, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                                tl, left, new Vector2(0f, -10f), new Vector2(width, 20f));
            loadedSub = HudFactory.CreateText("LoadedSub", root, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                              tl, left, new Vector2(0f, -30f), new Vector2(width, 18f));
            HudFactory.CreateImage("Divider", root, null, HudTokens.StrokeHair, tl, left, new Vector2(0f, -46f), new Vector2(width, 1f));

            float y0 = -54f;
            for (int i = 0; i < Rows; i++)
            {
                int slot = i;
                Button b = MapWaypointsTab.MakeButton("File" + i, root, skin, tl, tl, new Vector2(0f, y0 - i * RowPitch), new Vector2(width, RowH),
                                                      () => Select(slot));
                var row = new Row { Button = b, Fill = (Image)b.targetGraphic };
                RectTransform r = row.Fill.rectTransform;
                row.Title = HudFactory.CreateText("Title", r, regular, HudTokens.SizeLabel, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                                  tl, left, new Vector2(8f, -10f), new Vector2(width - 16f, 18f));
                row.Sub = HudFactory.CreateText("Sub", r, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                                tl, left, new Vector2(8f, -27f), new Vector2(width - 16f, 16f));
                rows.Add(row);
            }
            empty = HudFactory.CreateWrappedText("Empty", root, regular, HudTokens.SizeLabel, HudTokens.InkTertiary, TextAnchor.UpperLeft,
                                                 tl, tl, new Vector2(0f, y0 - 4f), new Vector2(width, 80f));

            float by = y0 - Rows * RowPitch - 6f;
            float bw = (width - 3f * 8f) / 4f;
            loadButton = MapWaypointsTab.MakeButton("Load", root, skin, tl, tl, new Vector2(0f, by), new Vector2(bw, BtnH), LoadSelected, medium, "Load");
            browseButton = MapWaypointsTab.MakeButton("Browse", root, skin, tl, tl, new Vector2(bw + 8f, by), new Vector2(bw, BtnH), Browse, regular, "Browse…");
            Button refresh = MapWaypointsTab.MakeButton("Refresh", root, skin, tl, tl, new Vector2(2f * (bw + 8f), by), new Vector2(bw, BtnH),
                                                        () => { dirty = true; message = null; }, regular, "Refresh");
            clearButton = MapWaypointsTab.MakeButton("Clear", root, skin, tl, tl, new Vector2(3f * (bw + 8f), by), new Vector2(bw, BtnH), ClearMission, regular, "Clear");
            foreach (Button b in new[] { loadButton, browseButton, refresh, clearButton })
            {
                MapWaypointsTab.Outline(b, skin);
            }
            status = HudFactory.CreateWrappedText("Status", root, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.UpperLeft,
                                                  tl, tl, new Vector2(0f, by - BtnH - 8f), new Vector2(width, 40f));
            root.gameObject.SetActive(false);
        }

        /// <summary>Shows or hides the tab; showing it rescans the folders.</summary>
        public void SetVisible(bool on)
        {
            if (root.gameObject.activeSelf != on)
            {
                root.gameObject.SetActive(on);
                if (on) dirty = true;
            }
        }

        /// <summary>Called by the map screen at 10 Hz while it is open.</summary>
        public void Refresh()
        {
            MissionFileBrowser.Poll();
            if (!root.gameObject.activeSelf)
            {
                return;
            }
            if (dirty)
            {
                dirty = false;
                files = MissionFileBrowser.Find();
                if (selected >= files.Count) selected = files.Count - 1;
                if (selected < 0 && files.Count > 0) selected = 0;
                missionVersionShown = -1;
            }
            if (missionVersionShown == MissionLink.Version + 1000 * (selected + 1))
            {
                SetStatus();
                return;
            }
            missionVersionShown = MissionLink.Version + 1000 * (selected + 1);
            Draw();
        }

        private void Draw()
        {
            MissionPlan cur = MissionLink.Current;
            loadedTitle.text = cur != null ? "Loaded: " + cur.Title : "No mission loaded";
            loadedTitle.color = cur != null ? MissionRouteStyle.Route : HudTokens.InkSecondary;
            loadedSub.text = cur != null
                ? cur.Id + " · " + Path.GetFileName(MissionLink.CurrentSource ?? "?")
                : "Load one below, Browse… for any file, or F5 for the newest download";

            int titleChars = Mathf.Max(8, Mathf.FloorToInt((width - 16f) / HudTokens.Advance(HudTokens.SizeLabel)));
            for (int i = 0; i < Rows; i++)
            {
                Row row = rows[i];
                bool on = i < files.Count;
                if (row.Button.gameObject.activeSelf != on) row.Button.gameObject.SetActive(on);
                if (!on) continue;
                MissionFileInfo f = files[i];
                bool isLoaded = cur != null && f.Valid && f.MissionId == cur.Id;
                Color fill = i == selected ? SelectedFill : new Color(1f, 1f, 1f, 0f);
                ColorBlock cb = row.Button.colors;
                if (cb.normalColor != fill)
                {
                    cb.normalColor = fill;
                    cb.selectedColor = fill;
                    row.Button.colors = cb;
                }
                row.Title.text = HudStrings.Truncate((isLoaded ? "● " : string.Empty) + (f.Valid ? f.Title : Path.GetFileName(f.Path)), titleChars);
                row.Title.color = !f.Valid ? HudTokens.InkTertiary : isLoaded ? MissionRouteStyle.Route : HudTokens.InkPrimary;
                string when = f.WrittenUtc.ToLocalTime().ToString("dd MMM HH:mm", Inv);
                row.Sub.text = f.Valid
                    ? HudStrings.Truncate(f.Waypoints.ToString(Inv) + " waypoints · EVA " + Minutes(f.EvaMin)
                                          + (f.Feasible == false ? " · NOT feasible" : string.Empty) + " · " + when + " · " + Path.GetFileName(f.Path), titleChars + 6)
                    : HudStrings.Truncate("not a mission: " + f.Title, titleChars + 6);
                row.Sub.color = f.Valid ? (f.Feasible == false ? HudTokens.Caution : HudTokens.InkSecondary) : HudTokens.InkTertiary;
            }
            empty.text = files.Count == 0
                ? "No mission*.json in " + string.Join(", ", MissionFileBrowser.Folders().ConvertAll(Path.GetFileName)) + ". Download one from the Mission Planer (/mission) or use Browse…"
                : string.Empty;
            loadButton.interactable = selected >= 0 && selected < files.Count && files[selected].Valid;
            clearButton.interactable = cur != null;
            SetStatus();
        }

        private void SetStatus()
        {
            string s = MissionFileBrowser.DialogOpen ? "File dialog open…" : message ?? string.Empty;
            if (status.text != s) status.text = s;
        }

        private void Select(int slot)
        {
            if (slot < files.Count)
            {
                selected = slot;
                missionVersionShown = -1;
            }
        }

        private void LoadSelected()
        {
            if (selected < 0 || selected >= files.Count) return;
            Load(files[selected].Path);
        }

        private void Browse()
        {
            message = null;
            bool ok = MissionFileBrowser.Browse(path =>
            {
                if (path != null) Load(path);
                else message = "No file chosen.";
                missionVersionShown = -1;
            });
            if (!ok) message = "No file dialog on this platform: copy the file to " + Application.persistentDataPath;
            missionVersionShown = -1;
        }

        private void Load(string path)
        {
            MissionLink link = MissionLink.Instance;
            if (link == null)
            {
                message = "No mission link in this scene.";
                return;
            }
            if (link.LoadFile(path))
            {
                message = "Loaded " + Path.GetFileName(path) + ": fresh EVA on the mission pad.";
                dirty = true;
                onLoaded?.Invoke();
            }
            else
            {
                message = "Not loaded: " + MissionLink.LastError;
            }
            missionVersionShown = -1;
        }

        private void ClearMission()
        {
            if (MissionLink.Instance != null && MissionLink.Current != null)
            {
                MissionLink.Instance.Clear();
                message = "Mission cleared: HOME is the scene spawn again.";
                missionVersionShown = -1;
            }
        }

        private static string Minutes(float min)
        {
            if (float.IsNaN(min)) return "--";
            int m = Mathf.RoundToInt(min);
            return (m / 60).ToString(Inv) + ":" + (m % 60).ToString("00", Inv);
        }
    }
}

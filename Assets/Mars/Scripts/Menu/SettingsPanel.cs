using System.Collections.Generic;
using System.Globalization;
using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// SETTINGS panel: a GENERAL / CONTROLS tab bar over two pages. GENERAL holds the grouped settings rows of
    /// <see cref="MenuSettings"/> and RESET TO DEFAULTS; CONTROLS is a read-only two-column key reference from
    /// <see cref="KeybindCatalog"/>, rebuilt when the bindings change.
    /// </summary>
    public sealed class SettingsPanel : MenuPanel
    {
        /// <summary>Tab indices for <see cref="SelectTab"/>.</summary>
        public const int TabGeneral = 0, TabControls = 1;

        // ---- layout (px, inside the content rect)
        private const float PageTop = MenuWidgets.TabHeight + 8f;              // tab bar + gap
        private const float PageHeight = MenuTokens.ContentHeight - PageTop;   // 508
        private const float GroupGap = 8f;                                     // above every group header but the first
        private const float KeyHeaderGap = 4f, KeyGroupGap = 16f, ColumnGap = 24f, KeysAfterName = 16f, MinKeysX = 96f;

        private MenuContext m_Ctx;
        private MenuTabBar m_Tabs;
        private RectTransform m_General, m_Controls;
        private CanvasGroup m_GeneralGroup, m_ControlsGroup;
        private int m_PendingTab = TabGeneral;
        private float m_PageT = 1f;
        private CanvasGroup m_FadingPage;

        private readonly List<MenuRowControl> m_Rows = new List<MenuRowControl>(8);
        private MenuSlider m_Sensitivity, m_Fov;
        private MenuSwitch m_InvertY, m_Fullscreen;
        private MenuStepper m_Quality;
        private MenuButton m_Reset;
        private string m_KeySignature;

        /// <summary>Creates the panel; nothing is built until <see cref="Build"/>.</summary>
        public SettingsPanel()
        {
        }

        public override string Title => "SETTINGS";

        /// <summary>The active tab (the host focuses it when the panel opens).</summary>
        public override Selectable DefaultSelection => m_Tabs != null ? m_Tabs.CurrentTab : null;

        /// <summary>Shows tab <paramref name="index"/> (<see cref="TabGeneral"/> or <see cref="TabControls"/>); may be called before Build.</summary>
        public void SelectTab(int index)
        {
            m_PendingTab = Mathf.Clamp(index, TabGeneral, TabControls);
            if (m_Tabs != null)
            {
                m_Tabs.Activate(m_PendingTab, false);
            }
        }

        public override void Build(MenuContext ctx, RectTransform content)
        {
            m_Ctx = ctx;
            float width = MenuTokens.ContentWidth;

            m_Tabs = MenuWidgets.TabBar(ctx, content, new[] { "GENERAL", "CONTROLS" }, width);

            m_General = Page("General", content, width, out m_GeneralGroup);
            m_Controls = Page("Controls", content, width, out m_ControlsGroup);
            BuildGeneral(ctx, m_General, width);

            m_Tabs.Changed = OnTabChanged;
            m_Tabs.Activate(m_PendingTab, true);
            ShowPage(m_Tabs.Current, false);
        }

        public override void OnShow()
        {
            if (m_Tabs == null)
            {
                return;
            }
            MenuSettings.Refresh();
            RefreshRows();
            RebuildControlsIfChanged();
            m_Tabs.Activate(m_PendingTab, true);
            ShowPage(m_Tabs.Current, false);
            UpdateNavigation();
        }

        public override void OnHide()
        {
            MenuSettings.Save();
        }

        public override void Tick(float unscaledDeltaTime)
        {
            if (m_Tabs == null)
            {
                return;
            }
            m_Tabs.Tick(unscaledDeltaTime);
            if (m_PageT < 1f && m_FadingPage != null)
            {
                float dur = MenuTokens.Dur(MenuTokens.DurPanelIn);
                m_PageT = dur > 0f ? Mathf.Min(1f, m_PageT + unscaledDeltaTime / dur) : 1f;
                m_FadingPage.alpha = MenuTokens.EaseOut(m_PageT);
            }
        }

        // ---------------------------------------------------------------- pages

        private static RectTransform Page(string name, RectTransform content, float width, out CanvasGroup group)
        {
            var topLeft = new Vector2(0f, 1f);
            RectTransform page = HudFactory.CreateRect(name, content, topLeft, topLeft, new Vector2(0f, -PageTop),
                                                       new Vector2(width, PageHeight));
            group = HudFactory.AddGroup(page.gameObject, 1f, true);
            return page;
        }

        private void OnTabChanged(int index)
        {
            m_PendingTab = index;
            ShowPage(index, true);
            UpdateNavigation();
        }

        private void ShowPage(int index, bool fade)
        {
            bool general = index == TabGeneral;
            m_General.gameObject.SetActive(general);
            m_Controls.gameObject.SetActive(!general);
            m_FadingPage = general ? m_GeneralGroup : m_ControlsGroup;
            if (fade)
            {
                m_FadingPage.alpha = 0f;
                m_PageT = 0f;
            }
            else
            {
                m_FadingPage.alpha = 1f;
                m_PageT = 1f;
            }
        }

        // ---------------------------------------------------------------- general

        // Page budget (508 px): 4 headers x 18 + 8 rows x 44 + 3 group gaps x 8 = 448; RESET TO DEFAULTS sits in the
        // remaining 60 px, bottom-right.
        private void BuildGeneral(MenuContext ctx, RectTransform page, float width)
        {
            float ruleWidth = width - 2f * MenuWidgets.RowPadX;
            float y = 0f;

            y = Header(ctx, page, "AUDIO", y, ruleWidth, true);
            AddRow(MenuWidgets.Slider(ctx, page, "Master volume", y, width, 0f, 1f, 0.05f, false,
                                      () => MenuSettings.MasterVolume, v => MenuSettings.MasterVolume = v, Percent));
            y += MenuTokens.RowHeight;

            y = Header(ctx, page, "LOOK", y, ruleWidth, false);
            float sensStep = (MenuSettings.SensitivityMax - MenuSettings.SensitivityMin) * 0.05f;
            m_Sensitivity = MenuWidgets.Slider(ctx, page, "Mouse sensitivity", y, width, MenuSettings.SensitivityMin,
                                               MenuSettings.SensitivityMax, sensStep, false,
                                               () => MenuSettings.MouseSensitivity, v => MenuSettings.MouseSensitivity = v, TwoDecimals);
            AddRow(m_Sensitivity);
            y += MenuTokens.RowHeight;
            m_InvertY = MenuWidgets.Switch(ctx, page, "Invert vertical look", y, width,
                                           () => MenuSettings.InvertY, v => MenuSettings.InvertY = v);
            AddRow(m_InvertY);
            y += MenuTokens.RowHeight;
            m_Fov = MenuWidgets.Slider(ctx, page, "Field of view", y, width, MenuSettings.FovMin, MenuSettings.FovMax, 1f, true,
                                       () => MenuSettings.FieldOfView, v => MenuSettings.FieldOfView = v, Degrees);
            AddRow(m_Fov);
            y += MenuTokens.RowHeight;

            y = Header(ctx, page, "DISPLAY", y, ruleWidth, false);
            m_Quality = MenuWidgets.Stepper(ctx, page, "Graphics quality", y, width, QualityNames(),
                                            () => MenuSettings.QualityLevel, OnQualityChanged);
            AddRow(m_Quality);
            y += MenuTokens.RowHeight;
            m_Fullscreen = MenuWidgets.Switch(ctx, page, "Fullscreen", y, width,
                                              () => MenuSettings.Fullscreen, v => MenuSettings.Fullscreen = v);
            AddRow(m_Fullscreen);
            y += MenuTokens.RowHeight;
            AddRow(MenuWidgets.Switch(ctx, page, "Vertical sync", y, width,
                                      () => MenuSettings.VSync, v => MenuSettings.VSync = v));
            y += MenuTokens.RowHeight;

            y = Header(ctx, page, "ACCESSIBILITY", y, ruleWidth, false);
            AddRow(MenuWidgets.Switch(ctx, page, "Reduced motion", y, width,
                                      () => MenuSettings.ReducedMotion, v => MenuSettings.ReducedMotion = v));

            m_Reset = MenuButton.Create(ctx, page, "RESET TO DEFAULTS", MenuTokens.SizeTab,
                                        new Vector2(1f, 0f), new Vector2(1f, 0f), Vector2.zero, OnReset);
        }

        private static float Header(MenuContext ctx, RectTransform page, string text, float y, float ruleWidth, bool first)
        {
            if (!first)
            {
                y += GroupGap;
            }
            return y + MenuWidgets.SectionHeader(ctx, page, text, MenuWidgets.RowPadX, y, ruleWidth);
        }

        private void AddRow(MenuRowControl row)
        {
            m_Rows.Add(row);
        }

        private void OnQualityChanged(int index)
        {
            MenuSettings.QualityLevel = index;
            // A quality level carries its own vsync; show what is in effect now.
            RefreshRows();
        }

        private void OnReset()
        {
            MenuSettings.ResetToDefaults();
            RefreshRows();
            UpdateNavigation();
        }

        private void RefreshRows()
        {
            if (m_Sensitivity != null)
            {
                m_Sensitivity.SetInteractable(MenuSettings.MouseLookAvailable);
                m_InvertY.SetInteractable(MenuSettings.MouseLookAvailable);
                m_Fov.SetInteractable(MenuSettings.FieldOfViewAvailable);
                m_Quality.SetInteractable(MenuSettings.QualityAvailable);
                m_Fullscreen.SetInteractable(MenuSettings.FullscreenAvailable);
            }
            for (int i = 0; i < m_Rows.Count; i++)
            {
                m_Rows[i].Refresh();
            }
        }

        // Explicit vertical chain: current tab -> interactable rows of the visible page -> RESET TO DEFAULTS.
        private void UpdateNavigation()
        {
            if (m_Tabs == null)
            {
                return;
            }
            bool general = m_Tabs.Current == TabGeneral;
            Selectable previous = m_Tabs.CurrentTab;
            Selectable first = null;
            MenuRowControl last = null;
            for (int i = 0; i < m_Rows.Count; i++)
            {
                MenuRowControl row = m_Rows[i];
                if (!row.IsInteractable())
                {
                    row.navigation = new Navigation { mode = Navigation.Mode.None };
                    continue;
                }
                if (first == null)
                {
                    first = row;
                }
                if (last != null)
                {
                    SetDown(last, row);
                }
                row.navigation = new Navigation { mode = Navigation.Mode.Explicit, selectOnUp = previous };
                previous = row;
                last = row;
            }
            if (m_Reset != null)
            {
                Navigation resetNav = m_Reset.navigation;
                resetNav.mode = Navigation.Mode.Explicit;
                resetNav.selectOnUp = previous;
                resetNav.selectOnLeft = null;
                resetNav.selectOnRight = null;
                resetNav.selectOnDown = null;
                m_Reset.navigation = resetNav;
                // Below the page is the host's Back button: hand over to it with the automatic search.
                resetNav.selectOnDown = BelowPage(m_Reset);
                m_Reset.navigation = resetNav;
                if (last != null)
                {
                    SetDown(last, m_Reset);
                }
                if (first == null)
                {
                    first = m_Reset;
                }
            }
            m_Tabs.SetNavigation(general ? first : BelowPage(m_Tabs.CurrentTab));
        }

        // The nearest selectable below, unless it is one of this panel's (explicit links handle those).
        private Selectable BelowPage(Selectable from)
        {
            if (from == null || !from.isActiveAndEnabled)
            {
                return null;
            }
            Selectable below = from.FindSelectable(Vector3.down);
            if (below == null || below.transform.IsChildOf(m_General) || below.transform.IsChildOf(m_Controls)
                || below is MenuTab)
            {
                return null;
            }
            return below;
        }

        private static void SetDown(Selectable from, Selectable to)
        {
            Navigation nav = from.navigation;
            nav.selectOnDown = to;
            from.navigation = nav;
        }

        private static string[] QualityNames()
        {
            string[] names = QualitySettings.names;
            var result = new string[names.Length];
            for (int i = 0; i < names.Length; i++)
            {
                result[i] = names[i].ToUpperInvariant();
            }
            return result;
        }

        private static string Percent(float v)
        {
            return Mathf.RoundToInt(v * 100f).ToString(CultureInfo.InvariantCulture) + "%";
        }

        private static string TwoDecimals(float v)
        {
            return v.ToString("0.00", CultureInfo.InvariantCulture);
        }

        private static string Degrees(float v)
        {
            return Mathf.RoundToInt(v).ToString(CultureInfo.InvariantCulture) + "°";
        }

        // ---------------------------------------------------------------- controls

        private void RebuildControlsIfChanged()
        {
            List<KeybindCatalog.Group> groups = KeybindCatalog.Read();
            string signature = KeybindCatalog.Signature(groups);
            if (signature == m_KeySignature)
            {
                return;
            }
            m_KeySignature = signature;
            for (int i = m_Controls.childCount - 1; i >= 0; i--)
            {
                Object.Destroy(m_Controls.GetChild(i).gameObject);
            }
            BuildControls(m_Ctx, m_Controls, groups);
        }

        private static float GroupHeight(KeybindCatalog.Group group)
        {
            return MenuWidgets.HeaderHeight + KeyHeaderGap + group.Rows.Count * MenuWidgets.KeyRowHeight;
        }

        // Two columns: the split point is the one that keeps the taller column shortest.
        private static void BuildControls(MenuContext ctx, RectTransform page, List<KeybindCatalog.Group> groups)
        {
            int count = groups.Count;
            int split = count;
            float best = float.MaxValue;
            for (int s = 0; s <= count; s++)
            {
                float left = 0f, right = 0f;
                for (int g = 0; g < count; g++)
                {
                    float h = GroupHeight(groups[g]);
                    if (g < s)
                    {
                        left += (g > 0 ? KeyGroupGap : 0f) + h;
                    }
                    else
                    {
                        right += (g > s ? KeyGroupGap : 0f) + h;
                    }
                }
                float tallest = Mathf.Max(left, right);
                if (tallest < best)
                {
                    best = tallest;
                    split = s;
                }
            }

            float columnWidth = (MenuTokens.ContentWidth - ColumnGap) * 0.5f;
            Font medium = ctx != null && ctx.Assets != null ? ctx.Assets.Medium : null;
            float y0 = 0f, y1 = 0f;
            for (int g = 0; g < count; g++)
            {
                KeybindCatalog.Group group = groups[g];
                bool second = g >= split;
                float x = second ? columnWidth + ColumnGap : 0f;
                float y = second ? y1 : y0;
                if (y > 0f)
                {
                    y += KeyGroupGap;
                }

                MenuWidgets.SectionHeader(ctx, page, group.Title, x + MenuWidgets.RowPadX, y,
                                          columnWidth - 2f * MenuWidgets.RowPadX);
                y += MenuWidgets.HeaderHeight + KeyHeaderGap;

                // Keys start after the group's longest action name, so they line up within the group.
                float keysX = MinKeysX;
                for (int r = 0; r < group.Rows.Count; r++)
                {
                    float name = MenuWidgets.TextWidth(medium, MenuTokens.SizeSmall, group.Rows[r].Action.ToUpperInvariant());
                    keysX = Mathf.Max(keysX, MenuWidgets.RowPadX + name + KeysAfterName);
                }
                for (int r = 0; r < group.Rows.Count; r++)
                {
                    KeybindCatalog.Binding row = group.Rows[r];
                    MenuWidgets.KeyRow(ctx, page, row.Action, row.Keys, row.Gamepad, x, y, columnWidth, keysX);
                    y += MenuWidgets.KeyRowHeight;
                }

                if (second)
                {
                    y1 = y;
                }
                else
                {
                    y0 = y;
                }
            }
        }
    }
}

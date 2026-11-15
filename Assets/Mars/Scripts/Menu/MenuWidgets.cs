using System;
using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Builders for the panel widgets: settings rows (slider, switch, stepper), the tab bar, group headers and the
    /// key reference rows. Rows are <see cref="MenuTokens.RowHeight"/> tall and as wide as asked; the label sits on the
    /// left, the control is right-aligned, the whole row is the pointer target. Every element is placed with anchor and
    /// pivot at its parent's top-left, y down negative. Build-time only (allocates).
    /// </summary>
    public static class MenuWidgets
    {
        /// <summary>Inner padding of a row: label inset from the left edge, control inset from the right edge.</summary>
        public const float RowPadX = 12f;

        /// <summary>Header line height (group headers).</summary>
        public const float HeaderHeight = 18f;

        /// <summary>Tab height (pointer target).</summary>
        public const float TabHeight = 44f;

        /// <summary>Height of a key reference row.</summary>
        public const float KeyRowHeight = 32f;

        private const float TrackWidth = 220f, TrackHeight = 4f, KnobSize = 16f;
        private const float ReadoutWidth = 64f, ControlGap = 12f;
        private const float SwitchWidth = 44f, SwitchHeight = 24f, SwitchKnobInset = 3f;
        private const float ChevronSize = 16f, ChevronHit = 44f;
        private const float TabPadX = 12f, TabGap = 8f, UnderlineHeight = 2f;
        private const float HeaderRuleGap = 12f;
        private const float GamepadGap = 12f;

        private static readonly Vector2 TopLeft = new Vector2(0f, 1f);
        private static readonly Vector2 MidLeft = new Vector2(0f, 0.5f);
        private static readonly Vector2 MidRight = new Vector2(1f, 0.5f);
        private static readonly Vector2 Center = new Vector2(0.5f, 0.5f);

        // Right edge of the track / switch / stepper area, measured from the row's right edge (the readout sits beyond).
        private const float ControlRight = RowPadX + ReadoutWidth + ControlGap;

        // ---------------------------------------------------------------- rows

        /// <summary>
        /// Slider row. <paramref name="step"/> is the left / right increment; <paramref name="whole"/> snaps to whole
        /// numbers. <paramref name="format"/> turns the value into the readout text.
        /// </summary>
        public static MenuSlider Slider(MenuContext ctx, Transform parent, string label, float y, float width,
                                        float min, float max, float step, bool whole,
                                        Func<float> get, Action<float> set, Func<float, string> format)
        {
            RectTransform row = Row(ctx, parent, label, y, width, out Image focus, out CanvasGroup group);

            Image track = MenuUi.Pill("Track", row, ctx, MenuTokens.Hairline, TrackHeight * 0.5f, MidRight, MidLeft,
                                      new Vector2(-(ControlRight + TrackWidth), 0f), new Vector2(TrackWidth, TrackHeight));
            Image fill = MenuUi.Pill("Fill", track.rectTransform, ctx, MenuTokens.Bronze, TrackHeight * 0.5f, MidLeft, MidLeft,
                                     Vector2.zero, new Vector2(0f, TrackHeight));
            Sprite disc = ctx != null && ctx.Skin != null ? ctx.Skin.discSolid : null;
            Image knob = HudFactory.CreateImage("Knob", track.rectTransform, disc, MenuTokens.BronzeBright, MidLeft, Center,
                                                Vector2.zero, new Vector2(KnobSize, KnobSize));
            Text readout = Readout(ctx, row, TextAnchor.MiddleRight);

            var slider = row.gameObject.AddComponent<MenuSlider>();
            slider.InitRow(focus, group);
            slider.Init(track.rectTransform, fill.rectTransform, knob.rectTransform, readout, min, max, step, whole, get, set, format);
            return slider;
        }

        /// <summary>Switch row with an ON / OFF readout next to the pill.</summary>
        public static MenuSwitch Switch(MenuContext ctx, Transform parent, string label, float y, float width,
                                        Func<bool> get, Action<bool> set)
        {
            RectTransform row = Row(ctx, parent, label, y, width, out Image focus, out CanvasGroup group);

            Image track = MenuUi.Pill("Track", row, ctx, MenuTokens.Hairline, SwitchHeight * 0.5f, MidRight, MidRight,
                                      new Vector2(-ControlRight, 0f), new Vector2(SwitchWidth, SwitchHeight));
            float knobSize = SwitchHeight - 2f * SwitchKnobInset;
            Sprite disc = ctx != null && ctx.Skin != null ? ctx.Skin.discSolid : null;
            Image knob;
            if (disc != null)
            {
                knob = HudFactory.CreateImage("Knob", track.rectTransform, disc, MenuTokens.SandDim, MidLeft, Center,
                                              Vector2.zero, new Vector2(knobSize, knobSize));
            }
            else
            {
                knob = MenuUi.Pill("Knob", track.rectTransform, ctx, MenuTokens.SandDim, knobSize * 0.5f, MidLeft, Center,
                                   Vector2.zero, new Vector2(knobSize, knobSize));
            }
            Text state = Readout(ctx, row, TextAnchor.MiddleLeft);

            float offX = SwitchKnobInset + knobSize * 0.5f;
            var toggle = row.gameObject.AddComponent<MenuSwitch>();
            toggle.InitRow(focus, group);
            toggle.Init(track, knob, state, offX, SwitchWidth - offX, get, set);
            return toggle;
        }

        /// <summary>Stepper row over <paramref name="options"/> (display strings, upper case); wraps around.</summary>
        public static MenuStepper Stepper(MenuContext ctx, Transform parent, string label, float y, float width,
                                          string[] options, Func<int> get, Action<int> set)
        {
            RectTransform row = Row(ctx, parent, label, y, width, out Image focus, out CanvasGroup group);

            RectTransform area = HudFactory.CreateRect("Stepper", row, MidRight, MidRight, new Vector2(-ControlRight, 0f),
                                                       new Vector2(TrackWidth, MenuTokens.RowHeight));
            Sprite chevron = ctx != null && ctx.Assets != null ? ctx.Assets.Chevron : null;
            Image left = HudFactory.CreateIcon("ChevronLeft", area, chevron, MenuTokens.SandDim, ChevronSize, MidLeft, Center,
                                               new Vector2(ChevronSize * 0.5f, 0f));
            left.rectTransform.localScale = new Vector3(-1f, 1f, 1f);
            Image right = HudFactory.CreateIcon("ChevronRight", area, chevron, MenuTokens.SandDim, ChevronSize, MidRight, Center,
                                                new Vector2(-ChevronSize * 0.5f, 0f));
            RectTransform leftHit = HudFactory.CreateRect("BackHit", area, MidLeft, MidLeft,
                                                          new Vector2(ChevronSize * 0.5f - ChevronHit * 0.5f, 0f),
                                                          new Vector2(ChevronHit, MenuTokens.RowHeight));
            Font mono = ctx != null && ctx.Assets != null ? ctx.Assets.Mono : null;
            Text value = MenuUi.Label("Value", area, mono, MenuTokens.SizeValue, MenuTokens.Sand, TextAnchor.MiddleCenter,
                                      Center, Center, Vector2.zero, new Vector2(TrackWidth - 2f * ChevronHit, MenuTokens.RowHeight),
                                      string.Empty);

            var stepper = row.gameObject.AddComponent<MenuStepper>();
            stepper.InitRow(focus, group);
            stepper.Init(value, left, right, leftHit, options, get, set);
            return stepper;
        }

        // Row shell: CanvasGroup (disabled alpha), focus fill = pointer target, upper-case label on the left.
        private static RectTransform Row(MenuContext ctx, Transform parent, string label, float y, float width,
                                         out Image focus, out CanvasGroup group)
        {
            string name = "Row " + label;
            RectTransform row = HudFactory.CreateRect(name, parent, TopLeft, TopLeft, new Vector2(0f, -y),
                                                      new Vector2(width, MenuTokens.RowHeight));
            group = HudFactory.AddGroup(row.gameObject, 1f, true);
            focus = MenuUi.Pill("Focus", row, ctx, MenuTokens.Alpha(MenuTokens.RowFocus, 0f), MenuTokens.RowRadius,
                                Center, Center, Vector2.zero, new Vector2(width, MenuTokens.RowHeight));
            focus.raycastTarget = true;
            Font medium = ctx != null && ctx.Assets != null ? ctx.Assets.Medium : null;
            float labelWidth = width - RowPadX - ControlRight - TrackWidth - ControlGap;
            MenuUi.Label("Label", row, medium, MenuTokens.SizeBody, MenuTokens.Sand, TextAnchor.MiddleLeft,
                         MidLeft, MidLeft, new Vector2(RowPadX, 0f), new Vector2(labelWidth, MenuTokens.RowHeight),
                         label.ToUpperInvariant());
            return row;
        }

        private static Text Readout(MenuContext ctx, RectTransform row, TextAnchor align)
        {
            Font mono = ctx != null && ctx.Assets != null ? ctx.Assets.Mono : null;
            return MenuUi.Label("Readout", row, mono, MenuTokens.SizeValue, MenuTokens.Sand, align, MidRight, MidRight,
                                new Vector2(-RowPadX, 0f), new Vector2(ReadoutWidth, MenuTokens.RowHeight), string.Empty);
        }

        // ---------------------------------------------------------------- tab bar

        /// <summary>
        /// Tab bar at the top of <paramref name="parent"/> (<see cref="TabHeight"/> tall, <paramref name="width"/> wide)
        /// with a Hairline rule along its bottom edge. Call <see cref="MenuTabBar.Activate"/> to pick the first tab.
        /// </summary>
        public static MenuTabBar TabBar(MenuContext ctx, Transform parent, string[] labels, float width)
        {
            RectTransform bar = HudFactory.CreateRect("TabBar", parent, TopLeft, TopLeft, Vector2.zero, new Vector2(width, TabHeight));
            HudFactory.CreateImage("Rule", bar, null, MenuTokens.Hairline, TopLeft, new Vector2(0f, 0f),
                                   new Vector2(0f, -TabHeight), new Vector2(width, 1f));

            Font bold = ctx != null && ctx.Assets != null ? ctx.Assets.Bold : null;
            var tabs = new MenuTab[labels.Length];
            var lineX = new float[labels.Length];
            var lineW = new float[labels.Length];
            MenuTabBar result = null;
            float x = 0f;
            for (int i = 0; i < labels.Length; i++)
            {
                string text = labels[i].ToUpperInvariant();
                float textWidth = TextWidth(bold, MenuTokens.SizeTab, text);
                float w = Mathf.Max(TabHeight, textWidth + 2f * TabPadX);
                RectTransform tab = HudFactory.CreateRect("Tab " + text, bar, TopLeft, TopLeft, new Vector2(x, 0f), new Vector2(w, TabHeight));
                CanvasGroup group = HudFactory.AddGroup(tab.gameObject, 1f, true);
                Image focus = MenuUi.Pill("Focus", tab, ctx, MenuTokens.Alpha(MenuTokens.RowFocus, 0f), MenuTokens.RowRadius,
                                          Center, Center, Vector2.zero, new Vector2(w, TabHeight));
                focus.raycastTarget = true;
                Text label = MenuUi.Label("Label", tab, bold, MenuTokens.SizeTab, MenuTokens.SandDim, TextAnchor.MiddleCenter,
                                          Center, Center, Vector2.zero, new Vector2(w, TabHeight), text);

                var control = tab.gameObject.AddComponent<MenuTab>();
                control.InitRow(focus, group);
                control.Init(label, i, index => result?.Activate(index, false));
                tabs[i] = control;
                lineX[i] = x + (w - textWidth) * 0.5f;
                lineW[i] = textWidth;
                x += w + TabGap;
            }

            Image underline = HudFactory.CreateImage("Underline", bar, null, MenuTokens.Bronze, TopLeft, new Vector2(0f, 0f),
                                                     new Vector2(0f, -TabHeight), new Vector2(0f, UnderlineHeight));
            result = new MenuTabBar(tabs, underline.rectTransform, lineX, lineW);
            return result;
        }

        // ---------------------------------------------------------------- headers and key rows

        /// <summary>
        /// Group header at (<paramref name="x"/>, <paramref name="y"/>): Bold SizeSection Bronze upper case with a
        /// Hairline rule from the text to x + <paramref name="width"/>. Returns <see cref="HeaderHeight"/>.
        /// </summary>
        public static float SectionHeader(MenuContext ctx, Transform parent, string text, float x, float y, float width)
        {
            string caps = text.ToUpperInvariant();
            Font bold = ctx != null && ctx.Assets != null ? ctx.Assets.Bold : null;
            float textWidth = TextWidth(bold, MenuTokens.SizeSection, caps);
            MenuUi.Label("Header " + caps, parent, bold, MenuTokens.SizeSection, MenuTokens.Bronze, TextAnchor.MiddleLeft,
                         TopLeft, TopLeft, new Vector2(x, -y), new Vector2(Mathf.Max(1f, textWidth), HeaderHeight), caps);
            float ruleX = x + textWidth + HeaderRuleGap;
            float ruleWidth = width - textWidth - HeaderRuleGap;
            if (ruleWidth > 0f)
            {
                HudFactory.CreateImage("Rule " + caps, parent, null, MenuTokens.Hairline, TopLeft, MidLeft,
                                       new Vector2(ruleX, -(y + HeaderHeight * 0.5f)), new Vector2(ruleWidth, 1f));
            }
            return HeaderHeight;
        }

        /// <summary>
        /// Key reference row (<see cref="KeyRowHeight"/> tall): action name on the left, key chips from
        /// <paramref name="keysX"/>, the gamepad control (may be null) right-aligned as plain text.
        /// </summary>
        public static RectTransform KeyRow(MenuContext ctx, Transform parent, string action, string[] keys, string gamepad,
                                           float x, float y, float width, float keysX)
        {
            RectTransform row = HudFactory.CreateRect("Keys " + action, parent, TopLeft, TopLeft, new Vector2(x, -y),
                                                      new Vector2(width, KeyRowHeight));
            Font medium = ctx != null && ctx.Assets != null ? ctx.Assets.Medium : null;
            MenuUi.Label("Action", row, medium, MenuTokens.SizeSmall, MenuTokens.Sand, TextAnchor.MiddleLeft, MidLeft, MidLeft,
                         new Vector2(RowPadX, 0f), new Vector2(Mathf.Max(1f, keysX - RowPadX), KeyRowHeight), action.ToUpperInvariant());

            float cx = keysX;
            if (keys != null)
            {
                for (int i = 0; i < keys.Length; i++)
                {
                    string key = keys[i].ToUpperInvariant();
                    MenuUi.Keycap("Key " + key, row, ctx, key, MidLeft, MidLeft, new Vector2(cx, 0f));
                    cx += MenuUi.KeycapWidth(key) + MenuTokens.KeycapGap;
                }
            }

            if (!string.IsNullOrEmpty(gamepad))
            {
                Font regular = ctx != null && ctx.Assets != null ? ctx.Assets.Regular : null;
                float box = Mathf.Max(1f, width - RowPadX - (cx - MenuTokens.KeycapGap + GamepadGap));
                MenuUi.Label("Gamepad", row, regular, MenuTokens.SizeHint, MenuTokens.SandFaint, TextAnchor.MiddleRight,
                             MidRight, MidRight, new Vector2(-RowPadX, 0f), new Vector2(box, KeyRowHeight), gamepad.ToUpperInvariant());
            }
            return row;
        }

        /// <summary>Width the key chips of <paramref name="keys"/> take, gaps included.</summary>
        public static float KeysWidth(string[] keys)
        {
            if (keys == null || keys.Length == 0)
            {
                return 0f;
            }
            float w = 0f;
            for (int i = 0; i < keys.Length; i++)
            {
                w += MenuUi.KeycapWidth(keys[i]);
            }
            return w + (keys.Length - 1) * MenuTokens.KeycapGap;
        }

        /// <summary>Advance width in px of <paramref name="text"/> at <paramref name="size"/> (reference canvas units).</summary>
        public static float TextWidth(Font font, int size, string text)
        {
            if (font == null || string.IsNullOrEmpty(text))
            {
                return 0f;
            }
            font.RequestCharactersInTexture(text, size, FontStyle.Normal);
            float w = 0f;
            for (int i = 0; i < text.Length; i++)
            {
                if (font.GetCharacterInfo(text[i], out CharacterInfo info, size, FontStyle.Normal))
                {
                    w += info.advance;
                }
                else
                {
                    w += size * 0.6f;
                }
            }
            return w;
        }
    }
}

using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// CREDITS panel: a vertical scroll view over the credits text (<see cref="MenuAssets.Credits"/>), one element per
    /// line: "# Heading", "## Name", "&gt; fine print", blank line = gap, anything else = body paragraph. Scrolls with
    /// the wheel, by dragging, with the slim scrollbar, and while open with up / down, PageUp / PageDown and the
    /// gamepad left stick. Focus stays on the host's Back button.
    /// </summary>
    public sealed class CreditsPanel : MenuPanel
    {
        private const string Fallback = "# MARVIS\nA NASA Space Apps Challenge project\nData: NASA. See DATA_SOURCES.md.";

        private const float Gutter = 20f;                 // scrollbar column on the right of the text
        private const float BarWidth = 4f, BarHitWidth = 16f, BarRadius = 2f;
        private const float HeadingAbove = 28f, HeadingBelow = 8f, BlankGap = 10f, ElementGap = 4f;
        private const float ScrollSpeed = 600f;           // px per second, arrows and stick
        private const float PageFraction = 0.85f;         // PageUp / PageDown jump
        private const float StickDeadZone = 0.2f;
        private const float WheelSensitivity = 40f;

        private ScrollRect m_Scroll;
        private RectTransform m_Viewport, m_Content;

        /// <summary>Creates the panel; nothing is built until <see cref="Build"/>.</summary>
        public CreditsPanel()
        {
        }

        public override string Title => "CREDITS";

        public override Selectable DefaultSelection => null;

        public override void Build(MenuContext ctx, RectTransform content)
        {
            var topLeft = new Vector2(0f, 1f);
            float width = MenuTokens.ContentWidth, height = MenuTokens.ContentHeight;

            RectTransform root = HudFactory.CreateRect("Scroll", content, topLeft, topLeft, Vector2.zero, new Vector2(width, height));
            m_Scroll = root.gameObject.AddComponent<ScrollRect>();

            // Transparent raycast target over the text: wheel and drag work anywhere in the view.
            Image viewport = HudFactory.CreateImage("Viewport", root, null, new Color(1f, 1f, 1f, 0f), topLeft, topLeft,
                                                    Vector2.zero, new Vector2(width - Gutter, height));
            viewport.raycastTarget = true;
            viewport.gameObject.AddComponent<RectMask2D>();
            m_Viewport = viewport.rectTransform;

            m_Content = HudFactory.CreateRect("Content", m_Viewport, topLeft, topLeft, Vector2.zero, new Vector2(width - Gutter, 0f));
            string text = ctx.Assets != null && ctx.Assets.Credits != null ? ctx.Assets.Credits.text : Fallback;
            float contentHeight = Layout(ctx, m_Content, text, width - Gutter);
            m_Content.sizeDelta = new Vector2(width - Gutter, contentHeight);

            Scrollbar bar = BuildScrollbar(ctx, root, height);

            m_Scroll.content = m_Content;
            m_Scroll.viewport = m_Viewport;
            m_Scroll.horizontal = false;
            m_Scroll.vertical = true;
            m_Scroll.movementType = ScrollRect.MovementType.Clamped;
            m_Scroll.inertia = true;
            m_Scroll.scrollSensitivity = WheelSensitivity;
            m_Scroll.verticalScrollbar = bar;
            m_Scroll.verticalScrollbarVisibility = ScrollRect.ScrollbarVisibility.AutoHide;
            m_Scroll.verticalNormalizedPosition = 1f;
        }

        public override void OnShow()
        {
            if (m_Scroll == null)
            {
                return;
            }
            m_Scroll.StopMovement();
            m_Content.anchoredPosition = Vector2.zero;
            m_Scroll.verticalNormalizedPosition = 1f;
        }

        public override void Tick(float unscaledDeltaTime)
        {
            if (m_Scroll == null)
            {
                return;
            }
            float delta = 0f;   // px, positive = towards the end of the text
            Keyboard keyboard = Keyboard.current;
            if (keyboard != null)
            {
                if (keyboard.downArrowKey.isPressed)
                {
                    delta += ScrollSpeed * unscaledDeltaTime;
                }
                if (keyboard.upArrowKey.isPressed)
                {
                    delta -= ScrollSpeed * unscaledDeltaTime;
                }
                float page = m_Viewport.rect.height * PageFraction;
                if (keyboard.pageDownKey.wasPressedThisFrame)
                {
                    delta += page;
                }
                if (keyboard.pageUpKey.wasPressedThisFrame)
                {
                    delta -= page;
                }
            }
            Gamepad pad = Gamepad.current;
            if (pad != null)
            {
                float y = pad.leftStick.ReadValue().y;
                if (Mathf.Abs(y) > StickDeadZone)
                {
                    delta -= y * ScrollSpeed * unscaledDeltaTime;
                }
            }
            if (delta != 0f)
            {
                ScrollBy(delta);
            }
        }

        private void ScrollBy(float delta)
        {
            float max = Mathf.Max(0f, m_Content.rect.height - m_Viewport.rect.height);
            if (max <= 0f)
            {
                return;
            }
            m_Scroll.StopMovement();
            Vector2 pos = m_Content.anchoredPosition;
            pos.y = Mathf.Clamp(pos.y + delta, 0f, max);
            m_Content.anchoredPosition = pos;
        }

        // Lays the elements out top to bottom and returns the content height.
        private static float Layout(MenuContext ctx, RectTransform parent, string text, float width)
        {
            var topLeft = new Vector2(0f, 1f);
            MenuAssets a = ctx.Assets;
            string[] lines = text.Replace("\r", string.Empty).Split('\n');
            float y = 0f, pendingGap = 0f;
            bool any = false;

            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.Length == 0)
                {
                    if (any)
                    {
                        pendingGap += BlankGap;
                    }
                    continue;
                }

                if (line.StartsWith("# ", System.StringComparison.Ordinal))
                {
                    if (any)
                    {
                        y += Mathf.Max(HeadingAbove, pendingGap);
                    }
                    y += MenuWidgets.SectionHeader(ctx, parent, line.Substring(2).Trim(), 0f, y, width) + HeadingBelow;
                }
                else
                {
                    y += pendingGap;
                    Font font;
                    int size;
                    Color color;
                    string body;
                    if (line.StartsWith("## ", System.StringComparison.Ordinal))
                    {
                        font = a.Medium;
                        size = MenuTokens.SizeBody;
                        color = MenuTokens.Sand;
                        body = line.Substring(3).Trim();
                    }
                    else if (line.StartsWith(">", System.StringComparison.Ordinal))
                    {
                        font = a.Regular;
                        size = MenuTokens.SizeSmall;
                        color = MenuTokens.SandFaint;
                        body = line.Substring(1).Trim();
                    }
                    else
                    {
                        font = a.Regular;
                        size = MenuTokens.SizeSmall;
                        color = MenuTokens.SandDim;
                        body = line;
                    }
                    Text t = MenuUi.Paragraph("Line " + i, parent, font, size, color, TextAnchor.UpperLeft,
                                              topLeft, topLeft, new Vector2(0f, -y), new Vector2(width, size), body);
                    float h = Mathf.Ceil(t.preferredHeight);
                    t.rectTransform.sizeDelta = new Vector2(width, h);
                    y += h + ElementGap;
                }
                pendingGap = 0f;
                any = true;
            }
            return Mathf.Ceil(y);
        }

        // Slim bar on the right edge: a 16 px wide transparent hit column holding a 4 px Hairline track and a
        // 4 px Bronze handle (ColorTint states on the handle).
        private static Scrollbar BuildScrollbar(MenuContext ctx, RectTransform root, float height)
        {
            var topRight = new Vector2(1f, 1f);
            Image hit = HudFactory.CreateImage("Scrollbar", root, null, new Color(1f, 1f, 1f, 0f), topRight, topRight,
                                               Vector2.zero, new Vector2(BarHitWidth, height));
            hit.raycastTarget = true;
            RectTransform barRect = hit.rectTransform;

            MenuUi.Pill("Track", barRect, ctx, MenuTokens.Hairline, BarRadius, new Vector2(1f, 0.5f), new Vector2(1f, 0.5f),
                        Vector2.zero, new Vector2(BarWidth, height));

            RectTransform area = HudFactory.CreateStretch("Sliding Area", barRect);
            RectTransform handle = HudFactory.CreateStretch("Handle", area);
            Image handleHit = handle.gameObject.AddComponent<Image>();
            handleHit.color = new Color(1f, 1f, 1f, 0f);
            handleHit.raycastTarget = true;
            Image handleBar = MenuUi.Pill("HandleBar", handle, ctx, Color.white, BarRadius, new Vector2(1f, 0.5f),
                                          new Vector2(1f, 0.5f), Vector2.zero, new Vector2(BarWidth, 0f));
            RectTransform hb = handleBar.rectTransform;
            hb.anchorMin = new Vector2(1f, 0f);
            hb.anchorMax = new Vector2(1f, 1f);
            hb.sizeDelta = new Vector2(BarWidth, 0f);

            var bar = barRect.gameObject.AddComponent<Scrollbar>();
            bar.direction = Scrollbar.Direction.BottomToTop;
            bar.handleRect = handle;
            bar.targetGraphic = handleBar;
            bar.navigation = new Navigation { mode = Navigation.Mode.None };
            bar.transition = Selectable.Transition.ColorTint;
            ColorBlock colors = ColorBlock.defaultColorBlock;
            colors.normalColor = MenuTokens.Bronze;
            colors.highlightedColor = MenuTokens.BronzeBright;
            colors.pressedColor = MenuTokens.BronzeBright;
            colors.selectedColor = MenuTokens.Bronze;
            colors.disabledColor = MenuTokens.Alpha(MenuTokens.Bronze, MenuTokens.DisabledAlpha);
            colors.colorMultiplier = 1f;
            // Apply once with no fade so the white handle never flashes, then set the real fade.
            colors.fadeDuration = 0f;
            bar.colors = colors;
            colors.fadeDuration = MenuTokens.DurFocus;
            bar.colors = colors;
            return bar;
        }
    }
}

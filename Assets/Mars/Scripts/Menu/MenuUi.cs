using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Small uGUI builders shared by the menu (on top of <see cref="HudFactory"/>). Everything created here has
    /// raycastTarget = false. Build-time only (allocates).
    /// </summary>
    public static class MenuUi
    {
        /// <summary>Single-line legacy Text (see <see cref="HudFactory.CreateText"/>) with its string set.</summary>
        public static Text Label(string name, Transform parent, Font font, int size, Color color, TextAnchor align,
                                 Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 box, string text)
        {
            Text t = HudFactory.CreateText(name, parent, font, size, color, align, anchor, pivot, pos, box);
            t.text = text;
            return t;
        }

        /// <summary>Wrapping legacy Text (wraps horizontally, overflows vertically) with its string set.</summary>
        public static Text Paragraph(string name, Transform parent, Font font, int size, Color color, TextAnchor align,
                                     Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 box, string text)
        {
            Text t = HudFactory.CreateWrappedText(name, parent, font, size, color, align, anchor, pivot, pos, box);
            t.verticalOverflow = VerticalWrapMode.Overflow;
            t.lineSpacing = 1.15f;
            t.text = text;
            return t;
        }

        /// <summary>Rounded rectangle (the HUD's 9-slice panel) with corner radius <paramref name="radius"/> px.</summary>
        public static Image Pill(string name, Transform parent, MenuContext ctx, Color color, float radius,
                                 Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 size)
        {
            return HudFactory.CreatePanel(name, parent, ctx != null ? ctx.Skin : null, color, radius, anchor, pivot, pos, size);
        }

        /// <summary>Width in px of the key chip for <paramref name="key"/> (monospace advance of the keycap font).</summary>
        public static float KeycapWidth(string key)
        {
            int chars = string.IsNullOrEmpty(key) ? 1 : key.Length;
            float w = chars * HudTokens.Advance(MenuTokens.SizeHint) + 2f * MenuTokens.KeycapPadX;
            return Mathf.Max(MenuTokens.KeycapHeight, w);
        }

        /// <summary>
        /// Key chip: <see cref="MenuTokens.KeycapHeight"/> px tall, as wide as <see cref="KeycapWidth"/>, upper-case
        /// mono letters. Returns the chip's RectTransform.
        /// </summary>
        public static RectTransform Keycap(string name, Transform parent, MenuContext ctx, string key,
                                           Vector2 anchor, Vector2 pivot, Vector2 pos)
        {
            var size = new Vector2(KeycapWidth(key), MenuTokens.KeycapHeight);
            Image chip = Pill(name, parent, ctx, MenuTokens.KeycapFill, MenuTokens.KeycapRadius, anchor, pivot, pos, size);
            Font font = ctx != null && ctx.Assets != null ? ctx.Assets.MonoMedium : null;
            Label(name + "Key", chip.rectTransform, font, MenuTokens.SizeHint, MenuTokens.Sand, TextAnchor.MiddleCenter,
                  new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, size, key);
            return chip.rectTransform;
        }
    }
}

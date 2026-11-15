using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Static uGUI builders for the helmet HUD. Every Graphic created here has raycastTarget = false unless stated and
    /// Image.type Simple unless stated. Missing sprites degrade per spec: panels draw square quads, outlines and icons
    /// are disabled, lines never use sprites. Build-time only (allocates); <see cref="SetSegment"/> is per-frame safe.
    /// </summary>
    public static class HudFactory
    {
        private const int UiLayer = 5;
        private const string CloseGlyph = "×";

        /// <summary>New RectTransform child with anchorMin = anchorMax = <paramref name="anchor"/>.</summary>
        public static RectTransform CreateRect(string name, Transform parent, Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 size)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.layer = parent != null ? parent.gameObject.layer : UiLayer;
            var rt = (RectTransform)go.transform;
            rt.SetParent(parent, false);
            rt.anchorMin = anchor;
            rt.anchorMax = anchor;
            rt.pivot = pivot;
            rt.anchoredPosition = pos;
            rt.sizeDelta = size;
            return rt;
        }

        /// <summary>New full-stretch RectTransform child (anchors 0..1, offsets 0).</summary>
        public static RectTransform CreateStretch(string name, Transform parent)
        {
            RectTransform rt = CreateRect(name, parent, Vector2.zero, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = Vector2.zero;
            rt.offsetMax = Vector2.zero;
            return rt;
        }

        /// <summary>Simple Image; a null sprite draws a white quad tinted by <paramref name="color"/>.</summary>
        public static Image CreateImage(string name, Transform parent, Sprite sprite, Color color,
                                        Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 size)
        {
            RectTransform rt = CreateRect(name, parent, anchor, pivot, pos, size);
            var img = rt.gameObject.AddComponent<Image>();
            img.sprite = sprite != null ? sprite : null;
            img.type = Image.Type.Simple;
            img.color = color;
            img.raycastTarget = false;
            return img;
        }

        /// <summary>
        /// Rounded panel: panelFill, Sliced, fillCenter, corner radius <paramref name="radius"/> px via
        /// pixelsPerUnitMultiplier. Missing sprite: square quad.
        /// </summary>
        public static Image CreatePanel(string name, Transform parent, HudSkin skin, Color color, float radius,
                                        Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 size)
        {
            Sprite sprite = skin != null ? skin.panelFill : null;
            Image img = CreateImage(name, parent, sprite, color, anchor, pivot, pos, size);
            if (img.sprite != null)
            {
                img.type = Image.Type.Sliced;
                img.fillCenter = true;
                img.pixelsPerUnitMultiplier = HudTokens.PanelMultiplier(radius);
            }
            return img;
        }

        /// <summary>Rounded outline: panelOutline, Sliced, fillCenter false. Missing sprite: created disabled.</summary>
        public static Image CreateOutline(string name, Transform parent, HudSkin skin, Color color, float radius,
                                          Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 size)
        {
            Sprite sprite = skin != null ? skin.panelOutline : null;
            Image img = CreateImage(name, parent, sprite, color, anchor, pivot, pos, size);
            if (img.sprite != null)
            {
                img.type = Image.Type.Sliced;
                img.fillCenter = false;
                img.pixelsPerUnitMultiplier = HudTokens.PanelMultiplier(radius);
            }
            else
            {
                img.enabled = false;
            }
            return img;
        }

        /// <summary>Square icon with preserveAspect. Missing sprite: created disabled.</summary>
        public static Image CreateIcon(string name, Transform parent, Sprite sprite, Color color, float size,
                                       Vector2 anchor, Vector2 pivot, Vector2 pos)
        {
            Image img = CreateImage(name, parent, sprite, color, anchor, pivot, pos, new Vector2(size, size));
            img.preserveAspect = true;
            if (img.sprite == null)
            {
                img.enabled = false;
            }
            return img;
        }

        /// <summary>Single-line legacy Text: no rich text, overflow both ways, no best fit.</summary>
        public static Text CreateText(string name, Transform parent, Font font, int size, Color color, TextAnchor align,
                                      Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 boxSize)
        {
            RectTransform rt = CreateRect(name, parent, anchor, pivot, pos, boxSize);
            var t = rt.gameObject.AddComponent<Text>();
            t.font = font;
            t.fontSize = size;
            t.fontStyle = FontStyle.Normal;
            t.color = color;
            t.alignment = align;
            t.supportRichText = false;
            t.horizontalOverflow = HorizontalWrapMode.Overflow;
            t.verticalOverflow = VerticalWrapMode.Overflow;
            t.lineSpacing = 1f;
            t.alignByGeometry = false;
            t.resizeTextForBestFit = false;
            t.raycastTarget = false;
            return t;
        }

        /// <summary>Like <see cref="CreateText"/> but wraps horizontally and truncates vertically to the box.</summary>
        public static Text CreateWrappedText(string name, Transform parent, Font font, int size, Color color,
                                             TextAnchor align, Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 boxSize)
        {
            Text t = CreateText(name, parent, font, size, color, align, anchor, pivot, pos, boxSize);
            t.horizontalOverflow = HorizontalWrapMode.Wrap;
            t.verticalOverflow = VerticalWrapMode.Truncate;
            return t;
        }

        /// <summary>
        /// Dark 1 px keyline (UI Outline, <see cref="HudTokens.Halo"/>) under a bare stroke or text. The offset is exactly
        /// one SCREEN pixel (1 / canvas scale): a 1-canvas-unit offset at a non-integer scale lands the four copies between
        /// pixels and smears the glyphs.
        /// </summary>
        public static void AddHalo(Graphic g)
        {
            if (g == null)
            {
                return;
            }
            Canvas c = g.canvas;
            float scale = c != null ? c.rootCanvas.scaleFactor : 1f;
            float d = scale > 1e-3f ? 1f / scale : 1f;
            var o = g.gameObject.AddComponent<Outline>();
            o.effectColor = HudTokens.Halo;
            o.effectDistance = new Vector2(d, -d);
            o.useGraphicAlpha = true;
        }

        /// <summary>
        /// Vector stroke surface (<see cref="HudLineMesh"/>, raycastTarget false) with anchorMin = anchorMax =
        /// <paramref name="anchor"/>. Its drawing coordinates are local: origin at <paramref name="pivot"/>, y up.
        /// </summary>
        public static HudLineMesh CreateLineMesh(string name, RectTransform parent, Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 size)
        {
            RectTransform rt = CreateRect(name, parent, anchor, pivot, pos, size);
            var mesh = rt.gameObject.AddComponent<HudLineMesh>();
            mesh.raycastTarget = false;
            return mesh;
        }

        /// <summary>Sprite-less line for <see cref="SetSegment"/>: anchors (0,0), pivot (0,0.5), height = thickness.</summary>
        public static Image CreateLine(string name, Transform parent, Color color, float thickness)
        {
            return CreateImage(name, parent, null, color, Vector2.zero, new Vector2(0f, 0.5f), Vector2.zero, new Vector2(0f, thickness));
        }

        /// <summary>
        /// Places a <see cref="CreateLine"/> line from <paramref name="a"/> to <paramref name="b"/> (canvas coordinates of
        /// the parent layer). Allocation-free; a zero-length segment keeps its last rotation.
        /// </summary>
        public static void SetSegment(RectTransform line, Vector2 a, Vector2 b)
        {
            Vector2 d = b - a;
            float len = d.magnitude;
            line.anchoredPosition = a;
            Vector2 size = line.sizeDelta;
            if (size.x != len)
            {
                size.x = len;
                line.sizeDelta = size;
            }
            if (len > 1e-4f)
            {
                line.localRotation = Quaternion.Euler(0f, 0f, Mathf.Atan2(d.y, d.x) * Mathf.Rad2Deg);
            }
        }

        /// <summary>
        /// 32x32 close button (raycast target): panelFill r 8 tinted by ColorTint (transparent at rest, HoverFill on
        /// hover, PressFill on press, fade DurButton) with a 20 px "×" glyph that scales to ButtonPressScale while
        /// pressed. Navigation None. The caller adds the onClick listener.
        /// </summary>
        public static Button CreateCloseButton(string name, Transform parent, HudSkin skin, Font font,
                                               Vector2 anchor, Vector2 pivot, Vector2 pos)
        {
            Image hit = CreatePanel(name, parent, skin, Color.white, HudTokens.RadiusButton, anchor, pivot, pos, new Vector2(32f, 32f));
            hit.raycastTarget = true;

            Font glyphFont = font != null ? font : (skin != null ? skin.Regular : null);
            Text glyph = CreateText(name + "Glyph", hit.rectTransform, glyphFont, 20, HudTokens.InkSecondary, TextAnchor.MiddleCenter,
                                    new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(32f, 32f));
            glyph.text = CloseGlyph;

            var button = hit.gameObject.AddComponent<Button>();
            button.transition = Selectable.Transition.ColorTint;
            button.targetGraphic = hit;
            button.navigation = new Navigation { mode = Navigation.Mode.None };

            Color rest = new Color(1f, 1f, 1f, 0f);
            ColorBlock colors = ColorBlock.defaultColorBlock;
            colors.normalColor = rest;
            colors.highlightedColor = HudTokens.HoverFill;
            colors.pressedColor = HudTokens.PressFill;
            colors.selectedColor = rest;    // no lingering highlight after a click selects the button
            colors.disabledColor = rest;
            colors.colorMultiplier = 1f;
            // Apply once with no fade so the white quad never flashes, then set the real fade.
            colors.fadeDuration = 0f;
            button.colors = colors;
            colors.fadeDuration = HudTokens.DurButton;
            button.colors = colors;

            // Pressed glyph scale (none under reduced motion); reset on release or exit.
            RectTransform glyphRect = glyph.rectTransform;
            var trigger = hit.gameObject.AddComponent<EventTrigger>();
            AddTrigger(trigger, EventTriggerType.PointerDown, _ =>
            {
                if (!HudTokens.ReducedMotion)
                {
                    glyphRect.localScale = new Vector3(HudTokens.ButtonPressScale, HudTokens.ButtonPressScale, 1f);
                }
            });
            AddTrigger(trigger, EventTriggerType.PointerUp, _ => glyphRect.localScale = Vector3.one);
            AddTrigger(trigger, EventTriggerType.PointerExit, _ => glyphRect.localScale = Vector3.one);
            return button;
        }

        private static void AddTrigger(EventTrigger trigger, EventTriggerType type, UnityEngine.Events.UnityAction<BaseEventData> action)
        {
            var entry = new EventTrigger.Entry { eventID = type };
            entry.callback.AddListener(action);
            trigger.triggers.Add(entry);
        }

        /// <summary>18x18 key hint chip: panel r 4 KeycapFill with a 12 px KeycapInk letter (pass the Medium font).</summary>
        public static Image CreateKeycap(string name, Transform parent, HudSkin skin, Font font, string key,
                                         Vector2 anchor, Vector2 pivot, Vector2 pos)
        {
            Image chip = CreatePanel(name, parent, skin, HudTokens.KeycapFill, HudTokens.RadiusKeycap, anchor, pivot, pos, new Vector2(18f, 18f));
            Font letterFont = font != null ? font : (skin != null ? skin.Medium : null);
            Text letter = CreateText(name + "Key", chip.rectTransform, letterFont, HudTokens.SizeFoot, HudTokens.KeycapInk, TextAnchor.MiddleCenter,
                                     new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(18f, 18f));
            letter.text = key;
            return chip;
        }

        /// <summary>Gets or adds a CanvasGroup with the given alpha and raycast blocking.</summary>
        public static CanvasGroup AddGroup(GameObject go, float alpha, bool blocksRaycasts)
        {
            var group = go.GetComponent<CanvasGroup>();
            if (group == null)
            {
                group = go.AddComponent<CanvasGroup>();
            }
            group.alpha = alpha;
            group.blocksRaycasts = blocksRaycasts;
            return group;
        }

        /// <summary>Gets or adds a nested Canvas (overrideSorting false), plus a GraphicRaycaster when requested.</summary>
        public static Canvas AddNestedCanvas(GameObject go, bool raycaster)
        {
            var canvas = go.GetComponent<Canvas>();
            if (canvas == null)
            {
                canvas = go.AddComponent<Canvas>();
            }
            canvas.overrideSorting = false;
            if (raycaster && go.GetComponent<GraphicRaycaster>() == null)
            {
                go.AddComponent<GraphicRaycaster>();
            }
            return canvas;
        }
    }
}

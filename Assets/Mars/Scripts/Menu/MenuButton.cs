using System;
using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// The menu's pill button (main list, Back, panels): bronze Bold label on a rounded scrim. Focus and hover look the
    /// same (pointer enter selects); focused = darker, wider pill, bright label and two bronze diamonds; pressed = the
    /// whole button scales down and springs back. Transition None: every state is eased from the button's own Update
    /// in unscaled time and is interruptible.
    /// </summary>
    public sealed class MenuButton : Selectable, IPointerClickHandler, ISubmitHandler
    {
        private const float MinPillHeight = 36f;
        private const float MinHitHeight = 44f;
        private const float IconGap = 10f;
        private const float IconFontRatio = 0.62f;

        private Action onClick;
        private RectTransform root, body, pill, hit, label, icon, markerLeft, markerRight;
        private Image pillImage, iconImage, markerLeftImage, markerRightImage;
        private Text labelText;

        private float pillHeight, padX, grow, markerSize, markerGap, hitHeight;
        private float labelWidth, iconSize;
        private bool alert, hovered, selected, pointerHeld;
        private float pressPulseUntil;
        private bool dirty = true;

        private Tween focusT, pressT, enabledT;

        /// <summary>True while selected or hovered (and interactable).</summary>
        public bool IsFocused => (selected || hovered) && interactable;

        /// <summary>Current pill width at rest, px.</summary>
        public float Width { get; private set; }

        /// <summary>
        /// Builds a button under <paramref name="parent"/>. The RectTransform is as wide as the pill at rest and as tall as
        /// the pointer target; <paramref name="anchor"/>, <paramref name="pivot"/> and <paramref name="anchoredPosition"/>
        /// place it. <paramref name="fontSize"/> <see cref="MenuTokens.SizeMenuItem"/> gives the full-size pill; smaller
        /// sizes scale height and padding proportionally (never below 36 px tall).
        /// </summary>
        public static MenuButton Create(MenuContext ctx, Transform parent, string label, int fontSize, Vector2 anchor,
                                        Vector2 pivot, Vector2 anchoredPosition, Action onClick)
        {
            float k = Mathf.Max(1, fontSize) / (float)MenuTokens.SizeMenuItem;
            float pillH = Mathf.Max(MinPillHeight, Mathf.Round(MenuTokens.MenuItemHeight * k));
            float s = pillH / MenuTokens.MenuItemHeight;
            float hitH = Mathf.Max(MinHitHeight, Mathf.Round(MenuTokens.MenuItemHitHeight * s), pillH);

            RectTransform rt = HudFactory.CreateRect("Button", parent, anchor, pivot, anchoredPosition, new Vector2(pillH, hitH));
            var b = rt.gameObject.AddComponent<MenuButton>();
            b.root = rt;
            b.onClick = onClick;
            b.pillHeight = pillH;
            b.hitHeight = hitH;
            b.padX = Mathf.Round(MenuTokens.MenuItemPadX * s);
            b.grow = Mathf.Round(MenuTokens.MenuItemFocusGrow * s);
            b.markerSize = Mathf.Max(5f, Mathf.Round(MenuTokens.MarkerSize * s));
            b.markerGap = Mathf.Round(MenuTokens.MarkerGap * s);
            b.iconSize = Mathf.Round(fontSize * IconFontRatio);
            b.transition = Transition.None;
            b.Build(ctx, fontSize);
            b.SetLabel(label);
            b.focusT.Snap(0f);
            b.pressT.Snap(0f);
            b.enabledT.Snap(1f);
            b.Apply();
            return b;
        }

        private void Build(MenuContext ctx, int fontSize)
        {
            var center = new Vector2(0.5f, 0.5f);

            // Transparent pointer target, wider than the focused pill so the grow never leaves its own hit area.
            Image hitImage = HudFactory.CreateImage("Hit", root, null, new Color(0f, 0f, 0f, 0f), center, center, Vector2.zero,
                                                    new Vector2(pillHeight, hitHeight));
            hitImage.raycastTarget = true;
            hit = hitImage.rectTransform;

            body = HudFactory.CreateStretch("Body", root);

            pillImage = MenuUi.Pill("Pill", body, ctx, MenuTokens.Scrim, pillHeight * 0.5f, center, center, Vector2.zero,
                                    new Vector2(pillHeight, pillHeight));
            pill = pillImage.rectTransform;

            markerLeftImage = CreateMarker("MarkerL", body);
            markerRightImage = CreateMarker("MarkerR", body);
            markerLeft = markerLeftImage.rectTransform;
            markerRight = markerRightImage.rectTransform;

            iconImage = HudFactory.CreateImage("Icon", body, null, MenuTokens.Bronze, center, center, Vector2.zero,
                                               new Vector2(iconSize, iconSize));
            iconImage.preserveAspect = true;
            iconImage.enabled = false;
            icon = iconImage.rectTransform;

            Font font = ctx != null && ctx.Assets != null ? ctx.Assets.Bold : null;
            labelText = MenuUi.Label("Label", body, font, fontSize, MenuTokens.Bronze, TextAnchor.MiddleCenter,
                                     center, center, Vector2.zero, new Vector2(0f, pillHeight), string.Empty);
            label = labelText.rectTransform;
        }

        private Image CreateMarker(string name, Transform parent)
        {
            var center = new Vector2(0.5f, 0.5f);
            Image m = HudFactory.CreateImage(name, parent, null, MenuTokens.Alpha(MenuTokens.Bronze, 0f), center, center,
                                             Vector2.zero, new Vector2(markerSize, markerSize));
            m.rectTransform.localRotation = Quaternion.Euler(0f, 0f, 45f);
            return m;
        }

        /// <summary>Sets the (upper-case) label and re-fits the pill to the text.</summary>
        public void SetLabel(string text)
        {
            if (labelText == null)
            {
                return;
            }
            labelText.text = string.IsNullOrEmpty(text) ? string.Empty : text.ToUpperInvariant();
            labelWidth = Mathf.Ceil(labelText.preferredWidth);
            Relayout();
        }

        /// <summary>Enables or disables the button. Disabled: <see cref="MenuTokens.DisabledAlpha"/>, not selectable.</summary>
        public void SetInteractable(bool value)
        {
            if (interactable == value)
            {
                return;
            }
            interactable = value;
            if (!value)
            {
                hovered = false;
                pointerHeld = false;
            }
            dirty = true;
        }

        /// <summary>Label in <see cref="MenuTokens.Alert"/> (confirm state) while true.</summary>
        public void SetAlert(bool value)
        {
            if (alert == value)
            {
                return;
            }
            alert = value;
            dirty = true;
        }

        /// <summary>Optional leading icon tinted like the label; <paramref name="flipX"/> mirrors it. Null = none.</summary>
        public void SetIcon(Sprite sprite, bool flipX)
        {
            if (iconImage == null)
            {
                return;
            }
            iconImage.sprite = sprite;
            iconImage.enabled = sprite != null;
            icon.localScale = new Vector3(flipX ? -1f : 1f, 1f, 1f);
            Relayout();
        }

        /// <summary>Runs the click action; no-op when inactive or not interactable.</summary>
        internal void Activate()
        {
            if (!IsActive() || !IsInteractable())
            {
                return;
            }
            Action a = onClick;
            if (a != null)
            {
                a();
            }
        }

        private void Relayout()
        {
            bool hasIcon = iconImage != null && iconImage.enabled;
            float content = labelWidth + (hasIcon ? iconSize + IconGap : 0f);
            Width = Mathf.Ceil(content + 2f * padX);

            float left = -content * 0.5f;
            if (hasIcon)
            {
                icon.anchoredPosition = new Vector2(left + iconSize * 0.5f, 0f);
                left += iconSize + IconGap;
            }
            label.anchoredPosition = new Vector2(left + labelWidth * 0.5f, 0f);
            label.sizeDelta = new Vector2(labelWidth, pillHeight);

            root.sizeDelta = new Vector2(Width, hitHeight);
            hit.sizeDelta = new Vector2(Width + 2f * grow, hitHeight);
            dirty = true;
        }

        private void Update()
        {
            float now = Time.unscaledTime;
            bool reduced = MenuTokens.ReducedMotion;

            bool focusTarget = IsFocused && IsInteractable();
            bool pressTarget = !reduced && (pointerHeld || now < pressPulseUntil) && IsInteractable();
            bool changed = focusT.SetTarget(focusTarget ? 1f : 0f, MenuTokens.Dur(MenuTokens.DurFocus), now)
                         | pressT.SetTarget(pressTarget ? 1f : 0f, MenuTokens.Dur(MenuTokens.DurPress), now)
                         | enabledT.SetTarget(interactable ? 1f : 0f, MenuTokens.Dur(MenuTokens.DurFocus), now);

            if (changed || dirty || focusT.Running(now) || pressT.Running(now) || enabledT.Running(now))
            {
                focusT.Evaluate(now);
                pressT.Evaluate(now);
                enabledT.Evaluate(now);
                Apply();
            }
        }

        private void Apply()
        {
            dirty = false;
            bool reduced = MenuTokens.ReducedMotion;
            float f = focusT.Value;
            float alpha = Mathf.Lerp(MenuTokens.DisabledAlpha, 1f, enabledT.Value);

            float w = Width + (reduced ? 0f : 2f * grow * f);
            pill.sizeDelta = new Vector2(w, pillHeight);
            pillImage.color = MenuTokens.Alpha(Color.Lerp(MenuTokens.Scrim, MenuTokens.ScrimFocus, f), alpha);

            Color ink = alert ? MenuTokens.Alert : Color.Lerp(MenuTokens.Bronze, MenuTokens.BronzeBright, f);
            ink = MenuTokens.Alpha(ink, alpha);
            labelText.color = ink;
            iconImage.color = ink;

            float mx = w * 0.5f + markerGap + markerSize * 0.5f;
            markerLeft.anchoredPosition = new Vector2(-mx, 0f);
            markerRight.anchoredPosition = new Vector2(mx, 0f);
            Color marker = MenuTokens.Alpha(MenuTokens.Bronze, f * alpha);
            markerLeftImage.color = marker;
            markerRightImage.color = marker;

            float scale = reduced ? 1f : Mathf.Lerp(1f, MenuTokens.PressScale, pressT.Value);
            body.localScale = new Vector3(scale, scale, 1f);
        }

        /// <inheritdoc />
        public override void OnPointerEnter(PointerEventData eventData)
        {
            base.OnPointerEnter(eventData);
            hovered = true;
            if (IsActive() && IsInteractable() && EventSystem.current != null
                && EventSystem.current.currentSelectedGameObject != gameObject)
            {
                Select();
            }
        }

        /// <inheritdoc />
        public override void OnPointerExit(PointerEventData eventData)
        {
            base.OnPointerExit(eventData);
            hovered = false;
            pointerHeld = false;
        }

        /// <inheritdoc />
        public override void OnPointerDown(PointerEventData eventData)
        {
            base.OnPointerDown(eventData);
            if (eventData.button == PointerEventData.InputButton.Left && IsInteractable())
            {
                pointerHeld = true;
            }
        }

        /// <inheritdoc />
        public override void OnPointerUp(PointerEventData eventData)
        {
            base.OnPointerUp(eventData);
            if (eventData.button == PointerEventData.InputButton.Left)
            {
                pointerHeld = false;
            }
        }

        /// <inheritdoc />
        public override void OnSelect(BaseEventData eventData)
        {
            base.OnSelect(eventData);
            selected = true;
        }

        /// <inheritdoc />
        public override void OnDeselect(BaseEventData eventData)
        {
            base.OnDeselect(eventData);
            selected = false;
        }

        /// <summary>Left click: activates the button.</summary>
        public void OnPointerClick(PointerEventData eventData)
        {
            if (eventData.button != PointerEventData.InputButton.Left)
            {
                return;
            }
            Activate();
        }

        /// <summary>Submit (Enter, Space, gamepad South): a short press pulse, then activates the button.</summary>
        public void OnSubmit(BaseEventData eventData)
        {
            if (!IsActive() || !IsInteractable())
            {
                return;
            }
            pressPulseUntil = Time.unscaledTime + MenuTokens.DurPress;
            Activate();
        }

        /// <inheritdoc />
        protected override void OnDisable()
        {
            base.OnDisable();
            hovered = false;
            selected = false;
            pointerHeld = false;
            if (root != null)
            {
                focusT.Snap(0f);
                pressT.Snap(0f);
                enabledT.Snap(interactable ? 1f : 0f);
                Apply();
            }
        }

        // Interruptible ease-out from the current value toward a target.
        private struct Tween
        {
            public float Value;
            private float from, to, start, duration;

            public void Snap(float v)
            {
                Value = from = to = v;
                duration = 0f;
            }

            public bool SetTarget(float target, float dur, float now)
            {
                if (target == to)
                {
                    return false;
                }
                from = Value;
                to = target;
                start = now;
                duration = dur;
                return true;
            }

            public bool Running(float now)
            {
                return Value != to;
            }

            public void Evaluate(float now)
            {
                if (duration <= 0f)
                {
                    Value = to;
                    return;
                }
                float t = (now - start) / duration;
                Value = t >= 1f ? to : Mathf.LerpUnclamped(from, to, MenuTokens.EaseOut(t));
            }
        }
    }
}

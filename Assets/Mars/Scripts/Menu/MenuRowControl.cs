using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Base of the settings controls (<see cref="MenuSlider"/>, <see cref="MenuSwitch"/>, <see cref="MenuStepper"/>,
    /// <see cref="MenuTab"/>). The component sits on the whole row, whose focus fill is the pointer target: hovering
    /// selects, and the fill fades in (<see cref="MenuTokens.RowFocus"/>) while the row is hovered, selected or pressed.
    /// Disabled rows drop to <see cref="MenuTokens.DisabledAlpha"/>. Transition is None; visuals are driven here.
    /// </summary>
    public abstract class MenuRowControl : Selectable
    {
        // The pressed fill is the focus fill made stronger (alpha multiplier on the already linearized token).
        private const float PressBoost = 2.5f;

        private Image m_Focus;
        private CanvasGroup m_Group;
        private float m_Amount, m_From, m_To, m_T = 1f;
        private bool m_Pressed;

        /// <summary>Focus amount 0..1 (eased); subclasses tint their parts with it in <see cref="OnFocusVisual"/>.</summary>
        protected float FocusAmount => m_Amount;

        /// <summary>Wires the row visuals. <paramref name="focus"/> must be a raycast target covering the row.</summary>
        public void InitRow(Image focus, CanvasGroup group)
        {
            m_Focus = focus;
            m_Group = group;
            transition = Transition.None;
            targetGraphic = focus;
            m_Amount = 0f;
            m_To = 0f;
            m_T = 1f;
            ApplyFocus();
        }

        /// <summary>Enables or disables the row (and its pointer / navigation behaviour).</summary>
        public void SetInteractable(bool value)
        {
            if (interactable != value)
            {
                interactable = value;
            }
        }

        /// <summary>Re-reads the shown value from its source without animating.</summary>
        public virtual void Refresh()
        {
        }

        /// <summary>Called whenever the focus amount changes (0 = rest, 1 = focused).</summary>
        protected virtual void OnFocusVisual(float amount)
        {
        }

        protected override void DoStateTransition(SelectionState state, bool instant)
        {
            bool focused = state == SelectionState.Highlighted || state == SelectionState.Selected || state == SelectionState.Pressed;
            m_Pressed = state == SelectionState.Pressed;
            if (m_Group != null)
            {
                m_Group.alpha = state == SelectionState.Disabled ? MenuTokens.DisabledAlpha : 1f;
            }

            float target = focused ? 1f : 0f;
            if (instant || !Application.isPlaying)
            {
                m_Amount = target;
                m_To = target;
                m_T = 1f;
            }
            else if (target != m_To)
            {
                m_From = m_Amount;
                m_To = target;
                m_T = 0f;
            }
            ApplyFocus();
        }

        public override void OnPointerEnter(PointerEventData eventData)
        {
            base.OnPointerEnter(eventData);
            if (IsInteractable() && EventSystem.current != null && EventSystem.current.currentSelectedGameObject != gameObject)
            {
                EventSystem.current.SetSelectedGameObject(gameObject, eventData);
            }
        }

        /// <summary>Advances the focus fade; subclasses that add their own animation call this first.</summary>
        protected virtual void Update()
        {
            if (m_T >= 1f)
            {
                return;
            }
            float dur = MenuTokens.Dur(MenuTokens.DurFocus);
            m_T = dur > 0f ? Mathf.Min(1f, m_T + Time.unscaledDeltaTime / dur) : 1f;
            m_Amount = Mathf.Lerp(m_From, m_To, MenuTokens.EaseOut(m_T));
            ApplyFocus();
        }

        private void ApplyFocus()
        {
            if (m_Focus != null)
            {
                m_Focus.color = MenuTokens.Alpha(MenuTokens.RowFocus, m_Amount * (m_Pressed ? PressBoost : 1f));
            }
            OnFocusVisual(m_Amount);
        }
    }
}

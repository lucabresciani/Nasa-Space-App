using System;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Settings stepper row: the current option between a left and a right chevron. Left / right step through the
    /// options and wrap; a click on the left chevron steps back, a click anywhere else on the row (or Submit) steps
    /// forward. Built by <see cref="MenuWidgets.Stepper"/>.
    /// </summary>
    public sealed class MenuStepper : MenuRowControl, ISubmitHandler, IPointerClickHandler
    {
        private Text m_Value;
        private Image m_Left, m_Right;
        private RectTransform m_LeftHit;
        private string[] m_Options;
        private int m_Index;
        private Func<int> m_Get;
        private Action<int> m_Set;

        /// <summary>
        /// Wires the parts. <paramref name="leftHit"/> is the area that steps back on click; <paramref name="options"/>
        /// are the display strings (upper case).
        /// </summary>
        public void Init(Text value, Image left, Image right, RectTransform leftHit, string[] options,
                         Func<int> get, Action<int> set)
        {
            m_Value = value;
            m_Left = left;
            m_Right = right;
            m_LeftHit = leftHit;
            m_Options = options ?? Array.Empty<string>();
            m_Get = get;
            m_Set = set;
            Refresh();
            OnFocusVisual(FocusAmount);
        }

        public override void Refresh()
        {
            if (m_Get != null)
            {
                m_Index = m_Get();
            }
            Draw();
        }

        public override void OnMove(AxisEventData eventData)
        {
            if (IsInteractable() && (eventData.moveDir == MoveDirection.Left || eventData.moveDir == MoveDirection.Right))
            {
                Step(eventData.moveDir == MoveDirection.Right ? 1 : -1);
                eventData.Use();
                return;
            }
            base.OnMove(eventData);
        }

        public void OnSubmit(BaseEventData eventData)
        {
            if (IsInteractable())
            {
                Step(1);
            }
        }

        public void OnPointerClick(PointerEventData eventData)
        {
            if (!IsInteractable() || eventData.button != PointerEventData.InputButton.Left)
            {
                return;
            }
            bool back = m_LeftHit != null
                && RectTransformUtility.RectangleContainsScreenPoint(m_LeftHit, eventData.position, eventData.pressEventCamera);
            Step(back ? -1 : 1);
        }

        protected override void OnFocusVisual(float amount)
        {
            Color c = Color.Lerp(MenuTokens.SandDim, MenuTokens.BronzeBright, amount);
            if (m_Left != null)
            {
                m_Left.color = c;
            }
            if (m_Right != null)
            {
                m_Right.color = c;
            }
        }

        private void Step(int direction)
        {
            int count = m_Options.Length;
            if (count < 2)
            {
                return;
            }
            m_Index = ((m_Index + direction) % count + count) % count;
            m_Set?.Invoke(m_Index);
            Draw();
        }

        private void Draw()
        {
            if (m_Value == null)
            {
                return;
            }
            m_Value.text = m_Index >= 0 && m_Index < m_Options.Length ? m_Options[m_Index] : string.Empty;
        }
    }
}

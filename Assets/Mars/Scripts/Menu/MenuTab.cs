using System;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// One tab of a <see cref="MenuTabBar"/>. Hover / focus shows the row focus fill; click or Submit activates the
    /// tab, and left / right move to the neighbouring tab and activate it.
    /// </summary>
    public sealed class MenuTab : MenuRowControl, ISubmitHandler, IPointerClickHandler
    {
        private Text m_Label;
        private int m_Index;
        private Action<int> m_Activate;

        /// <summary>The label of the tab.</summary>
        public Text Label => m_Label;

        /// <summary>Wires the label and the activation callback (receives <paramref name="index"/>).</summary>
        public void Init(Text label, int index, Action<int> activate)
        {
            m_Label = label;
            m_Index = index;
            m_Activate = activate;
        }

        /// <summary>Shows the tab as active (BronzeBright) or not (SandDim).</summary>
        public void SetCurrent(bool current)
        {
            if (m_Label != null)
            {
                m_Label.color = current ? MenuTokens.BronzeBright : MenuTokens.SandDim;
            }
        }

        public void OnSubmit(BaseEventData eventData)
        {
            if (IsInteractable())
            {
                m_Activate?.Invoke(m_Index);
            }
        }

        public void OnPointerClick(PointerEventData eventData)
        {
            if (IsInteractable() && eventData.button == PointerEventData.InputButton.Left)
            {
                m_Activate?.Invoke(m_Index);
            }
        }

        public override void OnMove(AxisEventData eventData)
        {
            if (eventData.moveDir == MoveDirection.Left || eventData.moveDir == MoveDirection.Right)
            {
                Selectable next = eventData.moveDir == MoveDirection.Left ? FindSelectableOnLeft() : FindSelectableOnRight();
                if (next is MenuTab tab && tab.IsActive() && tab.IsInteractable())
                {
                    tab.m_Activate?.Invoke(tab.m_Index);
                    if (EventSystem.current != null)
                    {
                        EventSystem.current.SetSelectedGameObject(tab.gameObject, eventData);
                    }
                }
                eventData.Use();
                return;
            }
            base.OnMove(eventData);
        }
    }
}

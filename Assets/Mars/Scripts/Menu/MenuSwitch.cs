using System;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Settings switch row: a 44x24 pill (off: Hairline track, SandDim knob left; on: Bronze track, Void knob right)
    /// with ON / OFF written next to it. Submit or click toggles; the knob slides over DurFocus (jumps under reduced
    /// motion). Built by <see cref="MenuWidgets.Switch"/>.
    /// </summary>
    public sealed class MenuSwitch : MenuRowControl, ISubmitHandler, IPointerClickHandler
    {
        private Image m_Track, m_Knob;
        private Text m_State;
        private float m_OffX, m_OnX;
        private bool m_On;
        private float m_K, m_KFrom, m_KTo, m_KT = 1f;
        private Func<bool> m_Get;
        private Action<bool> m_Set;

        /// <summary>Wires the parts; the knob moves between x = <paramref name="offX"/> and <paramref name="onX"/>.</summary>
        public void Init(Image track, Image knob, Text state, float offX, float onX, Func<bool> get, Action<bool> set)
        {
            m_Track = track;
            m_Knob = knob;
            m_State = state;
            m_OffX = offX;
            m_OnX = onX;
            m_Get = get;
            m_Set = set;
            Refresh();
        }

        public override void Refresh()
        {
            if (m_Get != null)
            {
                m_On = m_Get();
            }
            m_K = m_On ? 1f : 0f;
            m_KTo = m_K;
            m_KT = 1f;
            Draw();
        }

        public void OnSubmit(BaseEventData eventData)
        {
            if (IsInteractable())
            {
                Toggle();
            }
        }

        public void OnPointerClick(PointerEventData eventData)
        {
            if (IsInteractable() && eventData.button == PointerEventData.InputButton.Left)
            {
                Toggle();
            }
        }

        protected override void Update()
        {
            base.Update();
            if (m_KT >= 1f)
            {
                return;
            }
            float dur = MenuTokens.ReducedMotion ? 0f : MenuTokens.Dur(MenuTokens.DurFocus);
            m_KT = dur > 0f ? Mathf.Min(1f, m_KT + Time.unscaledDeltaTime / dur) : 1f;
            m_K = Mathf.Lerp(m_KFrom, m_KTo, MenuTokens.EaseOut(m_KT));
            Draw();
        }

        private void Toggle()
        {
            m_On = !m_On;
            m_Set?.Invoke(m_On);
            m_KFrom = m_K;
            m_KTo = m_On ? 1f : 0f;
            m_KT = 0f;
            if (MenuTokens.ReducedMotion)
            {
                m_K = m_KTo;
                m_KT = 1f;
            }
            Draw();
        }

        private void Draw()
        {
            if (m_Track != null)
            {
                m_Track.color = Color.Lerp(MenuTokens.Hairline, MenuTokens.Bronze, m_K);
            }
            if (m_Knob != null)
            {
                m_Knob.color = Color.Lerp(MenuTokens.SandDim, MenuTokens.Void, m_K);
                RectTransform rt = m_Knob.rectTransform;
                rt.anchoredPosition = new Vector2(Mathf.Lerp(m_OffX, m_OnX, m_K), rt.anchoredPosition.y);
            }
            if (m_State != null)
            {
                m_State.text = m_On ? "ON" : "OFF";
            }
        }
    }
}

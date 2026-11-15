using System;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// A row of <see cref="MenuTab"/>s with a 2 px Bronze underline under the current tab's label that slides between
    /// tabs over DurFocus (jumps under reduced motion). Not a component: the owner drives <see cref="Tick"/>.
    /// Built by <see cref="MenuWidgets.TabBar"/>.
    /// </summary>
    public sealed class MenuTabBar
    {
        private readonly MenuTab[] m_Tabs;
        private readonly RectTransform m_Underline;
        private readonly float[] m_LineX, m_LineW;
        private int m_Current = -1;
        private float m_FromX, m_FromW, m_ToX, m_ToW, m_T = 1f;

        /// <summary>Called with the new index whenever the current tab changes.</summary>
        public Action<int> Changed;

        /// <summary>Creates the bar over already built tabs; <paramref name="lineX"/> / <paramref name="lineW"/> place the underline per tab.</summary>
        public MenuTabBar(MenuTab[] tabs, RectTransform underline, float[] lineX, float[] lineW)
        {
            m_Tabs = tabs;
            m_Underline = underline;
            m_LineX = lineX;
            m_LineW = lineW;
            for (int i = 0; i < m_Tabs.Length; i++)
            {
                m_Tabs[i].SetCurrent(false);
            }
        }

        /// <summary>Index of the current tab (-1 before the first <see cref="Activate"/>).</summary>
        public int Current => m_Current;

        /// <summary>Number of tabs.</summary>
        public int Count => m_Tabs.Length;

        /// <summary>The current tab, or null.</summary>
        public MenuTab CurrentTab => m_Current >= 0 ? m_Tabs[m_Current] : null;

        /// <summary>Tab <paramref name="index"/>.</summary>
        public MenuTab Tab(int index) => m_Tabs[index];

        /// <summary>Makes <paramref name="index"/> current. <paramref name="instant"/> snaps the underline.</summary>
        public void Activate(int index, bool instant)
        {
            if (m_Tabs.Length == 0)
            {
                return;
            }
            index = Mathf.Clamp(index, 0, m_Tabs.Length - 1);
            bool changed = index != m_Current;
            bool first = m_Current < 0;
            if (m_Current >= 0)
            {
                m_Tabs[m_Current].SetCurrent(false);
            }
            m_Current = index;
            m_Tabs[index].SetCurrent(true);

            if (instant || first || MenuTokens.ReducedMotion)
            {
                m_FromX = m_ToX = m_LineX[index];
                m_FromW = m_ToW = m_LineW[index];
                m_T = 1f;
                Place(m_ToX, m_ToW);
            }
            else if (changed)
            {
                Vector2 pos = m_Underline.anchoredPosition;
                m_FromX = pos.x;
                m_FromW = m_Underline.sizeDelta.x;
                m_ToX = m_LineX[index];
                m_ToW = m_LineW[index];
                m_T = 0f;
            }

            if (changed)
            {
                Changed?.Invoke(index);
            }
        }

        /// <summary>Explicit navigation: tabs link left / right to each other and down to <paramref name="down"/>.</summary>
        public void SetNavigation(Selectable down)
        {
            for (int i = 0; i < m_Tabs.Length; i++)
            {
                m_Tabs[i].navigation = new Navigation
                {
                    mode = Navigation.Mode.Explicit,
                    selectOnLeft = i > 0 ? m_Tabs[i - 1] : null,
                    selectOnRight = i < m_Tabs.Length - 1 ? m_Tabs[i + 1] : null,
                    selectOnDown = down,
                };
            }
        }

        /// <summary>Advances the underline slide.</summary>
        public void Tick(float unscaledDeltaTime)
        {
            if (m_T >= 1f)
            {
                return;
            }
            float dur = MenuTokens.ReducedMotion ? 0f : MenuTokens.Dur(MenuTokens.DurFocus);
            m_T = dur > 0f ? Mathf.Min(1f, m_T + unscaledDeltaTime / dur) : 1f;
            float k = MenuTokens.EaseOut(m_T);
            Place(Mathf.Lerp(m_FromX, m_ToX, k), Mathf.Lerp(m_FromW, m_ToW, k));
        }

        private void Place(float x, float width)
        {
            if (m_Underline == null)
            {
                return;
            }
            m_Underline.anchoredPosition = new Vector2(x, m_Underline.anchoredPosition.y);
            m_Underline.sizeDelta = new Vector2(width, m_Underline.sizeDelta.y);
        }
    }
}

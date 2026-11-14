using System;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Settings slider row: Hairline track with a Bronze fill and a BronzeBright knob, numeric readout to the right.
    /// Left / right (keys, d-pad, stick) move it by one step, pressing on the track or dragging sets it continuously,
    /// up / down leave the row through its explicit navigation. Built by <see cref="MenuWidgets.Slider"/>.
    /// </summary>
    public sealed class MenuSlider : MenuRowControl, IDragHandler, IInitializePotentialDragHandler
    {
        private RectTransform m_Track, m_Fill, m_Knob;
        private Text m_Readout;
        private float m_Min, m_Max, m_Step, m_Value;
        private bool m_Whole, m_Dragging;
        private float m_KnobGrab;
        private Func<float> m_Get;
        private Action<float> m_Set;
        private Func<float, string> m_Format;

        /// <summary>Wires the parts and the value source. <paramref name="whole"/> snaps to whole numbers.</summary>
        public void Init(RectTransform track, RectTransform fill, RectTransform knob, Text readout,
                         float min, float max, float step, bool whole,
                         Func<float> get, Action<float> set, Func<float, string> format)
        {
            m_Track = track;
            m_Fill = fill;
            m_Knob = knob;
            m_Readout = readout;
            m_Min = min;
            m_Max = max;
            m_Step = step;
            m_Whole = whole;
            m_Get = get;
            m_Set = set;
            m_Format = format;
            m_KnobGrab = knob != null ? knob.sizeDelta.x : 0f;
            Refresh();
        }

        public override void Refresh()
        {
            if (m_Get != null)
            {
                m_Value = Clamp(m_Get());
            }
            Draw();
        }

        public override void OnMove(AxisEventData eventData)
        {
            if (IsInteractable() && (eventData.moveDir == MoveDirection.Left || eventData.moveDir == MoveDirection.Right))
            {
                SetValue(m_Value + (eventData.moveDir == MoveDirection.Right ? m_Step : -m_Step));
                eventData.Use();
                return;
            }
            base.OnMove(eventData);
        }

        public override void OnPointerDown(PointerEventData eventData)
        {
            base.OnPointerDown(eventData);
            if (!IsInteractable() || eventData.button != PointerEventData.InputButton.Left || m_Track == null)
            {
                return;
            }
            if (TrackFraction(eventData, out float fraction, true))
            {
                m_Dragging = true;
                SetValue(Mathf.Lerp(m_Min, m_Max, fraction));
            }
        }

        public override void OnPointerUp(PointerEventData eventData)
        {
            base.OnPointerUp(eventData);
            m_Dragging = false;
        }

        public void OnInitializePotentialDrag(PointerEventData eventData)
        {
            eventData.useDragThreshold = false;
        }

        public void OnDrag(PointerEventData eventData)
        {
            if (m_Dragging && IsInteractable() && TrackFraction(eventData, out float fraction, false))
            {
                SetValue(Mathf.Lerp(m_Min, m_Max, fraction));
            }
        }

        protected override void OnDisable()
        {
            m_Dragging = false;
            base.OnDisable();
        }

        // Fraction 0..1 of the pointer along the track. With requireNear, false when the press is not over the track
        // (plus the knob's reach), so a click on the row label only selects the row.
        private bool TrackFraction(PointerEventData eventData, out float fraction, bool requireNear)
        {
            fraction = 0f;
            Camera cam = eventData.pressEventCamera != null ? eventData.pressEventCamera : eventData.enterEventCamera;
            if (!RectTransformUtility.ScreenPointToLocalPointInRectangle(m_Track, eventData.position, cam, out Vector2 local))
            {
                return false;
            }
            Rect r = m_Track.rect;
            if (r.width <= 0f)
            {
                return false;
            }
            if (requireNear && (local.x < r.xMin - m_KnobGrab || local.x > r.xMax + m_KnobGrab))
            {
                return false;
            }
            fraction = Mathf.Clamp01((local.x - r.xMin) / r.width);
            return true;
        }

        private void SetValue(float v)
        {
            v = Clamp(v);
            if (v == m_Value)
            {
                return;
            }
            m_Value = v;
            m_Set?.Invoke(v);
            Draw();
        }

        private float Clamp(float v)
        {
            v = Mathf.Clamp(v, m_Min, m_Max);
            return m_Whole ? Mathf.Round(v) : v;
        }

        private void Draw()
        {
            if (m_Track == null)
            {
                return;
            }
            float width = m_Track.rect.width;
            float t = m_Max > m_Min ? Mathf.InverseLerp(m_Min, m_Max, m_Value) : 0f;
            if (m_Fill != null)
            {
                m_Fill.sizeDelta = new Vector2(width * t, m_Fill.sizeDelta.y);
                m_Fill.gameObject.SetActive(t > 0f);
            }
            if (m_Knob != null)
            {
                m_Knob.anchoredPosition = new Vector2(width * t, 0f);
            }
            if (m_Readout != null && m_Format != null)
            {
                m_Readout.text = m_Format(m_Value);
            }
        }
    }
}

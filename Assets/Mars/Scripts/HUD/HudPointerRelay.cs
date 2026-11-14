using System;
using UnityEngine;
using UnityEngine.EventSystems;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Relays pointer hover and left click on a raycast-target Graphic to plain C# listeners (rock card background,
    /// vitals hover areas, suit-strip slots). Pointer events only arrive while the cursor is free.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HudPointerRelay : MonoBehaviour, IPointerEnterHandler, IPointerExitHandler, IPointerClickHandler
    {
        /// <summary>Caller-defined slot index (e.g. suit-strip slot, card index).</summary>
        public int Index;

        /// <summary>True while the pointer is over this element or one of its raycast-target children.</summary>
        public bool Hovered { get; private set; }

        /// <summary>Raised when <see cref="Hovered"/> changes (also false on disable).</summary>
        public event Action<HudPointerRelay, bool> HoverChanged;

        /// <summary>Raised on a left click.</summary>
        public event Action<HudPointerRelay> Clicked;

        public void OnPointerEnter(PointerEventData eventData)
        {
            SetHovered(true);
        }

        public void OnPointerExit(PointerEventData eventData)
        {
            SetHovered(false);
        }

        public void OnPointerClick(PointerEventData eventData)
        {
            if (eventData.button == PointerEventData.InputButton.Left)
            {
                Clicked?.Invoke(this);
            }
        }

        private void OnDisable()
        {
            if (Hovered)
            {
                SetHovered(false);
            }
        }

        private void OnDestroy()
        {
            HoverChanged = null;
            Clicked = null;
        }

        private void SetHovered(bool hovered)
        {
            if (Hovered == hovered)
            {
                return;
            }
            Hovered = hovered;
            HoverChanged?.Invoke(this, hovered);
        }
    }
}

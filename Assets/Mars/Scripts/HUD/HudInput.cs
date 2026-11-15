using System;
using UnityEngine.InputSystem;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Code-only input actions of the HUD (no asset edits): close card (X / gamepad East), free cursor (hold Tab),
    /// debug overlay toggle (F3), map screen toggle (G / gamepad Select) and head lamp (L). M is taken by MarsWeather's
    /// weather cycle; the night sky's star names moved from L to J for the lamp.
    /// <see cref="Poll"/> once per frame, then read the edge flags.
    /// </summary>
    public sealed class HudInput : IDisposable
    {
        private readonly InputAction closeCard;
        private readonly InputAction freeCursor;
        private readonly InputAction debugToggle;
        private readonly InputAction mapToggle;
        private readonly InputAction headlamp;
        private bool disposed;

        /// <summary>True on the frame X or gamepad East was pressed.</summary>
        public bool CloseCardPressed { get; private set; }

        /// <summary>True on the frame Tab was pressed.</summary>
        public bool FreeCursorPressed { get; private set; }

        /// <summary>True on the frame Tab was released.</summary>
        public bool FreeCursorReleased { get; private set; }

        /// <summary>True on the frame F3 was pressed.</summary>
        public bool DebugTogglePressed { get; private set; }

        /// <summary>True on the frame G or gamepad Select (View) was pressed.</summary>
        public bool MapTogglePressed { get; private set; }

        /// <summary>True on the frame L was pressed (head lamp on/off).</summary>
        public bool HeadlampPressed { get; private set; }

        /// <summary>Creates and enables the actions.</summary>
        public HudInput()
        {
            closeCard = new InputAction("HudCloseCard", InputActionType.Button);
            closeCard.AddBinding("<Keyboard>/x");
            closeCard.AddBinding("<Gamepad>/buttonEast");

            freeCursor = new InputAction("HudFreeCursor", InputActionType.Button, "<Keyboard>/tab");
            debugToggle = new InputAction("HudDebugToggle", InputActionType.Button, "<Keyboard>/f3");

            mapToggle = new InputAction("HudMapToggle", InputActionType.Button);
            mapToggle.AddBinding("<Keyboard>/g");
            mapToggle.AddBinding("<Gamepad>/select");

            headlamp = new InputAction("HudHeadlamp", InputActionType.Button, "<Keyboard>/l");

            closeCard.Enable();
            headlamp.Enable();
            freeCursor.Enable();
            debugToggle.Enable();
            mapToggle.Enable();
        }

        /// <summary>Samples this frame's press/release edges into the properties.</summary>
        public void Poll()
        {
            if (disposed)
            {
                CloseCardPressed = FreeCursorPressed = FreeCursorReleased = DebugTogglePressed = MapTogglePressed = HeadlampPressed = false;
                return;
            }
            CloseCardPressed = closeCard.WasPressedThisFrame();
            FreeCursorPressed = freeCursor.WasPressedThisFrame();
            FreeCursorReleased = freeCursor.WasReleasedThisFrame();
            DebugTogglePressed = debugToggle.WasPressedThisFrame();
            MapTogglePressed = mapToggle.WasPressedThisFrame();
            HeadlampPressed = headlamp.WasPressedThisFrame();
        }

        /// <summary>Disables and disposes the actions. Safe to call twice.</summary>
        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            closeCard.Disable();
            freeCursor.Disable();
            debugToggle.Disable();
            mapToggle.Disable();
            headlamp.Disable();
            headlamp.Dispose();
            closeCard.Dispose();
            freeCursor.Dispose();
            debugToggle.Dispose();
            mapToggle.Dispose();
        }
    }
}

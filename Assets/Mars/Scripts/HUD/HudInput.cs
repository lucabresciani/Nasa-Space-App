using System;
using UnityEngine.InputSystem;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Code-only input actions of the HUD (no asset edits): close card (X / gamepad East), free cursor (hold Tab) and
    /// debug overlay toggle (F3). <see cref="Poll"/> once per frame, then read the edge flags.
    /// </summary>
    public sealed class HudInput : IDisposable
    {
        private readonly InputAction closeCard;
        private readonly InputAction freeCursor;
        private readonly InputAction debugToggle;
        private bool disposed;

        /// <summary>True on the frame X or gamepad East was pressed.</summary>
        public bool CloseCardPressed { get; private set; }

        /// <summary>True on the frame Tab was pressed.</summary>
        public bool FreeCursorPressed { get; private set; }

        /// <summary>True on the frame Tab was released.</summary>
        public bool FreeCursorReleased { get; private set; }

        /// <summary>True on the frame F3 was pressed.</summary>
        public bool DebugTogglePressed { get; private set; }

        /// <summary>Creates and enables the three actions.</summary>
        public HudInput()
        {
            closeCard = new InputAction("HudCloseCard", InputActionType.Button);
            closeCard.AddBinding("<Keyboard>/x");
            closeCard.AddBinding("<Gamepad>/buttonEast");

            freeCursor = new InputAction("HudFreeCursor", InputActionType.Button, "<Keyboard>/tab");
            debugToggle = new InputAction("HudDebugToggle", InputActionType.Button, "<Keyboard>/f3");

            closeCard.Enable();
            freeCursor.Enable();
            debugToggle.Enable();
        }

        /// <summary>Samples this frame's press/release edges into the properties.</summary>
        public void Poll()
        {
            if (disposed)
            {
                CloseCardPressed = FreeCursorPressed = FreeCursorReleased = DebugTogglePressed = false;
                return;
            }
            CloseCardPressed = closeCard.WasPressedThisFrame();
            FreeCursorPressed = freeCursor.WasPressedThisFrame();
            FreeCursorReleased = freeCursor.WasReleasedThisFrame();
            DebugTogglePressed = debugToggle.WasPressedThisFrame();
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
            closeCard.Dispose();
            freeCursor.Dispose();
            debugToggle.Dispose();
        }
    }
}

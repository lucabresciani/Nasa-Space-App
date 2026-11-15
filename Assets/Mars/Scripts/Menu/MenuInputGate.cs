using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
using UnityEngine.InputSystem.LowLevel;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Masks gameplay keys at the input layer while the menu is open: every keyboard state event has all keys zeroed
    /// except a small allow-list (menu navigation, Esc, F1, F2, Shift). Scripts that poll <see cref="Keyboard.current"/>
    /// for hotkeys (N, M, H, L, K, P, F3, X, Tab, E, ...) therefore see nothing under the menu.
    /// </summary>
    public static class MenuInputGate
    {
        private static readonly Key[] Allowed =
        {
            Key.Escape, Key.Enter, Key.NumpadEnter, Key.Space,
            Key.UpArrow, Key.DownArrow, Key.LeftArrow, Key.RightArrow,
            Key.W, Key.A, Key.S, Key.D, Key.F1, Key.F2,
            Key.PageUp, Key.PageDown, Key.Home, Key.End, Key.LeftShift, Key.RightShift,
        };

        private static readonly Action<InputEventPtr, InputDevice> Handler = OnEvent;
        private static readonly List<KeyControl> toClear = new List<KeyControl>(128);
        private static Keyboard cachedKeyboard;
        private static bool subscribed;

        /// <summary>True while the gate masks keys.</summary>
        public static bool IsEnabled => subscribed;

        // Domain reload is off: drop the previous session's subscription and cache.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            if (subscribed)
            {
                InputSystem.onEvent -= Handler;
            }
            subscribed = false;
            cachedKeyboard = null;
            toClear.Clear();
        }

        /// <summary>Starts masking. Idempotent.</summary>
        public static void Enable()
        {
            if (subscribed)
            {
                return;
            }
            Rebuild(Keyboard.current);
            InputSystem.onEvent += Handler;
            subscribed = true;
        }

        /// <summary>Stops masking. Idempotent.</summary>
        public static void Disable()
        {
            if (!subscribed)
            {
                return;
            }
            InputSystem.onEvent -= Handler;
            subscribed = false;
        }

        private static void Rebuild(Keyboard keyboard)
        {
            toClear.Clear();
            cachedKeyboard = keyboard;
            if (keyboard == null)
            {
                return;
            }
            var keys = keyboard.allKeys;
            for (int i = 0; i < keys.Count; i++)
            {
                KeyControl key = keys[i];
                if (key != null && Array.IndexOf(Allowed, key.keyCode) < 0)
                {
                    toClear.Add(key);
                }
            }
        }

        private static void OnEvent(InputEventPtr eventPtr, InputDevice device)
        {
            if (!subscribed || !(device is Keyboard keyboard))
            {
                return;
            }
            if (!eventPtr.IsA<StateEvent>() && !eventPtr.IsA<DeltaStateEvent>())
            {
                return;
            }
            if (!ReferenceEquals(keyboard, cachedKeyboard))
            {
                // A different keyboard device (reconnect, second keyboard): allocation only on this rare change.
                Rebuild(keyboard);
            }
            for (int i = 0; i < toClear.Count; i++)
            {
                // Controls outside a delta event's range are skipped by WriteValueIntoEvent itself.
                toClear[i].WriteValueIntoEvent(0f, eventPtr);
            }
        }
    }
}

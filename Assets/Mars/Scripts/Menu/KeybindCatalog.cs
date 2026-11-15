using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using UnityEngine;
using UnityEngine.InputSystem;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// The control reference shown on the settings CONTROLS tab, read from the live game where possible: the
    /// project-wide Player actions (move, run, jump, scan) and the serialized key fields of the scene's DayNightCycle,
    /// MarsWeather and MarsNightSky. Anything it cannot read falls back to the shipped defaults; a row whose component is
    /// missing from the scene, or whose key is Key.None, is left out. Allocates: call it when the panel opens, not per frame.
    /// </summary>
    public static class KeybindCatalog
    {
        /// <summary>One action: its name, its keyboard keys (short, upper case) and its gamepad control (or null).</summary>
        public sealed class Binding
        {
            public string Action;
            public string[] Keys;
            public string Gamepad;
        }

        /// <summary>A titled group of bindings (upper-case title).</summary>
        public sealed class Group
        {
            public string Title;
            public readonly List<Binding> Rows = new List<Binding>();
        }

        private const BindingFlags FieldFlags = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;

        private static readonly Dictionary<string, string> GamepadNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "leftStick", "L STICK" },
            { "rightStick", "R STICK" },
            { "leftStickPress", "L3" },
            { "rightStickPress", "R3" },
            { "buttonSouth", "A" },
            { "buttonEast", "B" },
            { "buttonNorth", "Y" },
            { "buttonWest", "X" },
            { "start", "START" },
            { "select", "SELECT" },
            { "leftShoulder", "LB" },
            { "rightShoulder", "RB" },
            { "leftTrigger", "LT" },
            { "rightTrigger", "RT" },
            { "dpad", "D-PAD" },
        };

        private static readonly Dictionary<string, string> KeyNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "leftShift", "L-SHIFT" },
            { "rightShift", "R-SHIFT" },
            { "shift", "SHIFT" },
            { "leftCtrl", "L-CTRL" },
            { "rightCtrl", "R-CTRL" },
            { "ctrl", "CTRL" },
            { "leftAlt", "L-ALT" },
            { "rightAlt", "R-ALT" },
            { "alt", "ALT" },
            { "space", "SPACE" },
            { "escape", "ESC" },
            { "tab", "TAB" },
            { "enter", "ENTER" },
            { "backspace", "BKSP" },
            { "upArrow", "UP" },
            { "downArrow", "DOWN" },
            { "leftArrow", "LEFT" },
            { "rightArrow", "RIGHT" },
            { "capsLock", "CAPS" },
            { "backquote", "`" },
            { "pageUp", "PG UP" },
            { "pageDown", "PG DN" },
        };

        private static readonly string[] MoveParts = { "up", "left", "down", "right" };

        /// <summary>Reads the current bindings. Never null; groups without rows are left out.</summary>
        public static List<Group> Read()
        {
            InputActionAsset actions = null;
            try
            {
                actions = InputSystem.actions;
            }
            catch (Exception e)
            {
                Debug.LogException(e);
            }

            var groups = new List<Group>(5);

            Group movement = new Group { Title = "MOVEMENT" };
            movement.Rows.Add(new Binding
            {
                Action = "MOVE",
                Keys = MoveKeys(Find(actions, "Player/Move")) ?? new[] { "W", "A", "S", "D" },
                Gamepad = GamepadLabel(Find(actions, "Player/Move"), "L STICK"),
            });
            movement.Rows.Add(new Binding { Action = "LOOK", Keys = new[] { "MOUSE" }, Gamepad = "R STICK" });
            AddAction(movement, actions, "Player/Sprint", "RUN (HOLD)", new[] { "L-SHIFT" }, "L3");
            AddAction(movement, actions, "Player/Jump", "JUMP", new[] { "SPACE" }, "A");
            Add(groups, movement);

            Group science = new Group { Title = "SCIENCE" };
            AddAction(science, actions, "Player/Interact", "SCAN ROCK (HOLD)", new[] { "E" }, "Y");
            science.Rows.Add(new Binding { Action = "CLOSE ROCK CARD", Keys = new[] { "X" }, Gamepad = "B" });
            science.Rows.Add(new Binding { Action = "FREE CURSOR (HOLD)", Keys = new[] { "TAB" } });
            science.Rows.Add(new Binding { Action = "EVA MAP", Keys = new[] { "G" }, Gamepad = "SELECT" });
            Add(groups, science);

            Group environment = new Group { Title = "ENVIRONMENT" };
            DayNightCycle day = UnityEngine.Object.FindAnyObjectByType<DayNightCycle>();
            if (day != null)
            {
                AddKey(environment, "NEXT TIME OF DAY", null, ReadKey(day, "skipKey", Key.N));
            }
            MarsWeather weather = UnityEngine.Object.FindAnyObjectByType<MarsWeather>();
            if (weather != null)
            {
                Key cycle = ReadKey(weather, "cycleKey", Key.M);
                AddKey(environment, "NEXT WEATHER", null, cycle);
                AddKey(environment, "PREVIOUS WEATHER", "SHIFT", cycle);
                AddKey(environment, "HISTORICAL WEATHER", null, ReadKey(weather, "historicalKey", Key.H));
            }
            Add(groups, environment);

            Group sky = new Group { Title = "NIGHT SKY" };
            MarsNightSky night = UnityEngine.Object.FindAnyObjectByType<MarsNightSky>();
            if (night != null)
            {
                AddKey(sky, "STAR NAMES", null, ReadKey(night, "starNamesKey", Key.L));
                AddKey(sky, "CONSTELLATIONS", null, ReadKey(night, "constellationsKey", Key.K));
                AddKey(sky, "PLANETS AND MOONS", null, ReadKey(night, "planetsKey", Key.P));
            }
            Add(groups, sky);

            Group system = new Group { Title = "SYSTEM" };
            system.Rows.Add(new Binding { Action = "PAUSE / MENU", Keys = new[] { "ESC" }, Gamepad = "START" });
            system.Rows.Add(new Binding { Action = "CONTROLS", Keys = new[] { "F1" } });
            system.Rows.Add(new Binding { Action = "DEBUG OVERLAY", Keys = new[] { "F3" } });
            Add(groups, system);

            return groups;
        }

        /// <summary>A string that changes whenever any shown title, action, key or gamepad label changes.</summary>
        public static string Signature(List<Group> groups)
        {
            var b = new StringBuilder(256);
            for (int g = 0; g < groups.Count; g++)
            {
                b.Append('#').Append(groups[g].Title);
                List<Binding> rows = groups[g].Rows;
                for (int r = 0; r < rows.Count; r++)
                {
                    b.Append('|').Append(rows[r].Action).Append(':');
                    for (int k = 0; k < rows[r].Keys.Length; k++)
                    {
                        b.Append(rows[r].Keys[k]).Append('+');
                    }
                    b.Append('/').Append(rows[r].Gamepad);
                }
            }
            return b.ToString();
        }

        /// <summary>Short upper-case label of a keyboard control name or Key enum name ("leftShift" -> "L-SHIFT").</summary>
        public static string KeyLabel(string controlName)
        {
            if (string.IsNullOrEmpty(controlName))
            {
                return null;
            }
            if (KeyNames.TryGetValue(controlName, out string label))
            {
                return label;
            }
            if (controlName.Length == 6 && controlName.StartsWith("Digit", StringComparison.OrdinalIgnoreCase))
            {
                return controlName.Substring(5);
            }
            if (controlName.StartsWith("numpad", StringComparison.OrdinalIgnoreCase) && controlName.Length > 6)
            {
                return "NUM " + controlName.Substring(6).ToUpperInvariant();
            }
            return controlName.ToUpperInvariant();
        }

        // ---------------------------------------------------------------- input actions

        private static InputAction Find(InputActionAsset actions, string path)
        {
            return actions != null ? actions.FindAction(path, false) : null;
        }

        private static void AddAction(Group group, InputActionAsset actions, string path, string name, string[] fallbackKeys, string fallbackPad)
        {
            InputAction action = Find(actions, path);
            group.Rows.Add(new Binding
            {
                Action = name,
                Keys = KeyboardKeys(action) ?? fallbackKeys,
                Gamepad = GamepadLabel(action, fallbackPad),
            });
        }

        // The four keyboard parts of the first composite that has all of them, in the order up, left, down, right.
        private static string[] MoveKeys(InputAction action)
        {
            if (action == null)
            {
                return null;
            }
            var parts = new string[MoveParts.Length];
            var bindings = action.bindings;
            bool inComposite = false;
            for (int i = 0; i <= bindings.Count; i++)
            {
                bool end = i == bindings.Count || !bindings[i].isPartOfComposite;
                if (end && inComposite)
                {
                    if (Array.IndexOf(parts, null) < 0)
                    {
                        return parts;
                    }
                    Array.Clear(parts, 0, parts.Length);
                }
                if (i == bindings.Count)
                {
                    break;
                }
                InputBinding binding = bindings[i];
                inComposite = binding.isComposite || binding.isPartOfComposite;
                if (!binding.isPartOfComposite)
                {
                    continue;
                }
                int slot = Array.IndexOf(MoveParts, binding.name != null ? binding.name.ToLowerInvariant() : null);
                string control = ControlOf(binding.effectivePath, "<Keyboard>/");
                if (slot >= 0 && control != null && parts[slot] == null)
                {
                    parts[slot] = KeyLabel(control);
                }
            }
            return null;
        }

        // Keyboard keys of the action's plain (non-composite) bindings, at most two, without repeats.
        private static string[] KeyboardKeys(InputAction action)
        {
            if (action == null)
            {
                return null;
            }
            var keys = new List<string>(2);
            var bindings = action.bindings;
            for (int i = 0; i < bindings.Count && keys.Count < 2; i++)
            {
                if (bindings[i].isComposite || bindings[i].isPartOfComposite)
                {
                    continue;
                }
                string label = KeyLabel(ControlOf(bindings[i].effectivePath, "<Keyboard>/"));
                if (label != null && !keys.Contains(label))
                {
                    keys.Add(label);
                }
            }
            return keys.Count > 0 ? keys.ToArray() : null;
        }

        private static string GamepadLabel(InputAction action, string fallback)
        {
            if (action == null)
            {
                return fallback;
            }
            var bindings = action.bindings;
            for (int i = 0; i < bindings.Count; i++)
            {
                string control = ControlOf(bindings[i].effectivePath, "<Gamepad>/");
                if (control == null)
                {
                    continue;
                }
                return GamepadNames.TryGetValue(control, out string label) ? label : control.ToUpperInvariant();
            }
            return fallback;
        }

        // "<Keyboard>/leftShift" with prefix "<Keyboard>/" -> "leftShift"; anything else -> null.
        private static string ControlOf(string path, string devicePrefix)
        {
            if (string.IsNullOrEmpty(path) || !path.StartsWith(devicePrefix, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }
            string control = path.Substring(devicePrefix.Length);
            return control.Length > 0 ? control : null;
        }

        // ---------------------------------------------------------------- scene components

        private static Key ReadKey(UnityEngine.Object component, string field, Key fallback)
        {
            FieldInfo f = component.GetType().GetField(field, FieldFlags);
            if (f == null || f.FieldType != typeof(Key))
            {
                return fallback;
            }
            return (Key)f.GetValue(component);
        }

        private static void AddKey(Group group, string name, string modifier, Key key)
        {
            if (key == Key.None)
            {
                return;
            }
            string label = KeyLabel(key.ToString());
            group.Rows.Add(new Binding
            {
                Action = name,
                Keys = modifier != null ? new[] { modifier, label } : new[] { label },
            });
        }

        private static void Add(List<Group> groups, Group group)
        {
            if (group.Rows.Count > 0)
            {
                groups.Add(group);
            }
        }
    }
}

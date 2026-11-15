using UnityEditor;

namespace NasaSpaceApp.Menu
{
    /// <summary>Editor menu items of the MARVIS title screen (Tools/Mars/Title Screen).</summary>
    public static class MarvisMenuEditorTools
    {
        private const string StartPath = "Tools/Mars/Title Screen/Start Simulation Now";
        private const string SkipPath = "Tools/Mars/Title Screen/Skip Title In Editor";

        /// <summary>Starts (or resumes) the simulation right away, bypassing the start interceptor. Play mode only.</summary>
        [MenuItem(StartPath)]
        public static void StartSimulationNow()
        {
            MarvisMenu.StartNow();
        }

        [MenuItem(StartPath, true)]
        private static bool ValidateStartSimulationNow()
        {
            return EditorApplication.isPlaying;
        }

        /// <summary>Toggles <see cref="MarvisMenu.SkipTitleEditorPrefKey"/>: play sessions start with the title skipped.</summary>
        [MenuItem(SkipPath)]
        public static void ToggleSkipTitle()
        {
            bool value = !EditorPrefs.GetBool(MarvisMenu.SkipTitleEditorPrefKey, false);
            EditorPrefs.SetBool(MarvisMenu.SkipTitleEditorPrefKey, value);
            UnityEditor.Menu.SetChecked(SkipPath, value);
        }

        [MenuItem(SkipPath, true)]
        private static bool ValidateToggleSkipTitle()
        {
            UnityEditor.Menu.SetChecked(SkipPath, EditorPrefs.GetBool(MarvisMenu.SkipTitleEditorPrefKey, false));
            return true;
        }
    }
}

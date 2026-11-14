using UnityEditor;

namespace NasaSpaceApp.Menu
{
    /// <summary>Editor menu items of the MARTIS title screen (Tools/Mars/Title Screen).</summary>
    public static class MartisMenuEditorTools
    {
        private const string StartPath = "Tools/Mars/Title Screen/Start Simulation Now";
        private const string SkipPath = "Tools/Mars/Title Screen/Skip Title In Editor";

        /// <summary>Starts (or resumes) the simulation right away, bypassing the start interceptor. Play mode only.</summary>
        [MenuItem(StartPath)]
        public static void StartSimulationNow()
        {
            MartisMenu.StartNow();
        }

        [MenuItem(StartPath, true)]
        private static bool ValidateStartSimulationNow()
        {
            return EditorApplication.isPlaying;
        }

        /// <summary>Toggles <see cref="MartisMenu.SkipTitleEditorPrefKey"/>: play sessions start with the title skipped.</summary>
        [MenuItem(SkipPath)]
        public static void ToggleSkipTitle()
        {
            bool value = !EditorPrefs.GetBool(MartisMenu.SkipTitleEditorPrefKey, false);
            EditorPrefs.SetBool(MartisMenu.SkipTitleEditorPrefKey, value);
            UnityEditor.Menu.SetChecked(SkipPath, value);
        }

        [MenuItem(SkipPath, true)]
        private static bool ValidateToggleSkipTitle()
        {
            UnityEditor.Menu.SetChecked(SkipPath, EditorPrefs.GetBool(MartisMenu.SkipTitleEditorPrefKey, false));
            return true;
        }
    }
}

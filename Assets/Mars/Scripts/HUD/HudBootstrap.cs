using NasaSpaceApp.Science;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Runtime entry point of the helmet HUD: builds one <see cref="HelmetHud"/> after a scene loads, only when the scene
    /// has a <see cref="RockScanner"/>. No scene edits; the HUD lives in the active scene and dies with it.
    /// </summary>
    public static class HudBootstrap
    {
        // Domain reload is off: drop the previous session's subscription.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
        }

        // Runs after scene Awake/OnEnable (scanner action resolved) and before Start (FPC locks the cursor).
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Boot()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
            SceneManager.sceneLoaded += OnSceneLoaded;
            TryBuild();
        }

        private static void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            TryBuild();
        }

        private static void TryBuild()
        {
            if (HelmetHud.Instance)
            {
                return;
            }
            RockScanner scanner = Object.FindAnyObjectByType<RockScanner>();
            if (!scanner)
            {
                return;
            }
            HelmetHud.Create(scanner);
        }
    }
}

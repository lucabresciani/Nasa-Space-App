using System;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Runtime entry point of the title / pause screen: after every scene load it applies the saved settings and builds
    /// one <see cref="MartisMenu"/> when the scene has a <see cref="FirstPersonController"/>. No scene edits; the menu
    /// lives in the active scene and dies with it.
    /// </summary>
    public static class MenuBootstrap
    {
        // Domain reload is off: drop the previous session's subscription.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
        }

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
            try
            {
                MenuSettings.Load();
                MenuSettings.ApplyAll();
            }
            catch (Exception e)
            {
                Debug.LogException(e);
            }

            if (MartisMenu.Instance)
            {
                return;
            }
            if (!UnityEngine.Object.FindAnyObjectByType<FirstPersonController>())
            {
                return;
            }
            MartisMenu.Create();
        }
    }
}

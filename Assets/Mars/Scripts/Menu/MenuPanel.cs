using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>Shared references handed to every part of the title / pause screen.</summary>
    public sealed class MenuContext
    {
        /// <summary>Fonts, textures, shaders and sprites of the menu. Never null; single members may be null.</summary>
        public MenuAssets Assets;

        /// <summary>The helmet HUD skin (panelFill, panelOutline, discSolid, ...). Never null.</summary>
        public HudSkin Skin;

        /// <summary>Root overlay canvas of the menu.</summary>
        public Canvas Canvas;

        /// <summary>RectTransform of <see cref="Canvas"/> (1080 reference height).</summary>
        public RectTransform CanvasRect;

        /// <summary>The menu root.</summary>
        public MarvisMenu Menu;
    }

    /// <summary>
    /// A sub-screen of the menu (settings, credits, quick guide). The host (<see cref="MarvisMenu"/>) draws the panel box, the
    /// header with <see cref="Title"/> and the Back button; the panel only fills the content rect, which is
    /// <see cref="MenuTokens.ContentWidth"/> x <see cref="MenuTokens.ContentHeight"/> px with its pivot at the top-left.
    /// </summary>
    public abstract class MenuPanel
    {
        /// <summary>Header text, upper case (e.g. "SETTINGS").</summary>
        public abstract string Title { get; }

        /// <summary>Builds the panel's UI under <paramref name="content"/>. Called once, the first time it is shown.</summary>
        public abstract void Build(MenuContext ctx, RectTransform content);

        /// <summary>Called every time the panel becomes visible (after <see cref="Build"/>): refresh values here.</summary>
        public virtual void OnShow()
        {
        }

        /// <summary>Called when the panel is hidden.</summary>
        public virtual void OnHide()
        {
        }

        /// <summary>Called every frame while the panel is visible, with unscaled delta time.</summary>
        public virtual void Tick(float unscaledDeltaTime)
        {
        }

        /// <summary>The control that gets keyboard / gamepad focus when the panel opens; null = the Back button.</summary>
        public virtual Selectable DefaultSelection => null;

        /// <summary>Label of the host's close button while this panel is shown, upper case.</summary>
        public virtual string BackLabel => "BACK";
    }
}

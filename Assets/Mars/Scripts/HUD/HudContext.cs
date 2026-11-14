using System.Collections.Generic;
using NasaSpaceApp.Science;
using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>Severity of a HUD reading; drives color (<see cref="HudTokens.Severity"/>) and alerts.</summary>
    public enum HudSeverity { Nominal = 0, Info = 1, Caution = 2, Warning = 3 }

    /// <summary>
    /// Shared state of one helmet HUD instance: scene references, canvas layers, models and per-frame camera values.
    /// Filled by <c>HelmetHud.Create</c>; widgets read it in their constructors and in <c>Tick</c>.
    /// </summary>
    public sealed class HudContext
    {
        public HudSkin Skin;
        public Camera Camera;                      // scanner camera, else Camera.main
        public RockScanner Scanner;                // never null (bootstrap requires it)
        public FirstPersonController Player;       // may be null
        public DayNightCycle DayNight;             // may be null
        public MarsWeather Weather;                // may be null
        public Canvas Canvas;
        public RectTransform CanvasRect;

        // Layers: full-stretch RectTransforms (anchors 0..1, offsets 0). Children that are placed in canvas coordinates use
        // anchorMin = anchorMax = (0,0) so anchoredPosition = canvas position (origin bottom-left, y up).
        public RectTransform StaticLayer;          // nested Canvas: caption, vitals
        public RectTransform DialLayer, ReticleLayer, LeaderLayer, CardLayer, LocatorLayer, AlertLayer, TooltipLayer; // inside nested Canvas "Dynamic"

        public SuitTelemetry Telemetry;            // WP3
        public HudTooltip Tooltip;                 // WP3
        public RockCardSystem Cards;               // WP4 (null-safe consumers)

        public float HeadingDeg;                   // set each frame by HelmetHud: Repeat(atan2(fwd.x, fwd.z), 360), fwd = camera forward on XZ
        public Vector3 CameraPosition;             // set each frame
        public float UnscaledTime;                 // Time.unscaledTime, set each frame

        private readonly List<RectTransform> reservedZones = new List<RectTransform>(8);

        /// <summary>
        /// Screen areas owned by instruments (compass, vitals, caption, alerts...). Rock cards avoid them: the layout solver
        /// converts each rect to canvas space every frame, so moving or resized roots are followed. Inactive or destroyed
        /// entries are ignored.
        /// </summary>
        public IReadOnlyList<RectTransform> ReservedZones => reservedZones;

        /// <summary>Registers <paramref name="rt"/> (a widget root) as a zone rock cards must not cover. Duplicates are ignored.</summary>
        public void ReserveZone(RectTransform rt)
        {
            if (rt != null && !reservedZones.Contains(rt))
            {
                reservedZones.Add(rt);
            }
        }

        /// <summary>True while the cursor is not locked (Esc or Tab hold): pointer UI is live.</summary>
        public bool CursorFree => Cursor.lockState != CursorLockMode.Locked;

        /// <summary>Canvas size in reference units (height 1080).</summary>
        public Vector2 CanvasSize => CanvasRect.rect.size;

        /// <summary>Screen pixels to canvas coordinates (origin bottom-left, y up).</summary>
        public Vector2 ScreenToCanvas(Vector3 screen) => new Vector2(screen.x, screen.y) / Canvas.scaleFactor;
    }
}

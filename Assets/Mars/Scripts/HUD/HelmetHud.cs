using System;
using System.Reflection;
using NasaSpaceApp.Mission;
using NasaSpaceApp.Science;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem.UI;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Root of the helmet HUD: owns the overlay canvas, the widgets and the one deterministic update order (input in
    /// Update, everything else in LateUpdate). Built at runtime by <see cref="HudBootstrap"/> through <see cref="Create"/>.
    /// Owns cursor state (hold Tab), the debug overlay swap (F3), the card close key (X / gamepad East) and the map
    /// screen (G / gamepad Select toggles; X / gamepad East / its × button close it): while the map is open the cursor is
    /// free, player input is off and the other HUD layers fade out.
    /// </summary>
    [DefaultExecutionOrder(100)]
    [DisallowMultipleComponent]
    public sealed class HelmetHud : MonoBehaviour
    {
        private const int UiLayer = 5;
        private const float FallbackAirMinC = -74.5f; // REMS Ls 10-35 daily-min median (MarsHistoricalClimate)
        private const float FallbackAirMaxC = -19.5f; // REMS Ls 10-35 daily-max median
        private const float FallbackDustTau = 0.5f;   // typical non-storm column tau at the rover sites (Lemmon et al. 2015)

        /// <summary>The live HUD, or null. Reset at SubsystemRegistration (domain reload is off).</summary>
        public static HelmetHud Instance { get; private set; }

        /// <summary>Shared state handed to every widget.</summary>
        public HudContext Context { get; private set; }

        private static readonly object s_BoxedTrue = true;   // reflection write without a per-toggle box
        private static FieldInfo s_OverlayVisible;
        private static bool s_OverlayVisibleResolved;

        private SuitTelemetry telemetry;
        private int missionVersion = -1;   // MissionLink.Version the tracker follows
        private Light headlamp;            // helmet lamp (L), a spot on the camera; null without a camera
        private bool headlampOn;
        private readonly EvaLogger evaLog = new EvaLogger();
        private HudTooltip tooltip;
        private MissionCaption caption;
        private MissionPanel missionPanel;
        private VitalsStack vitals;
        private CompassDial dial;
        private HeadingCaret caret;
        private TargetReticle reticle;
        private RockCardSystem cards;
        private AlertBanner alerts;
        private HudInput input;
        private MapScreen mapScreen;

        private RockScanDebugOverlay overlay;
        private CanvasGroup rootGroup;
        private CanvasGroup staticGroup;
        private CanvasGroup dynamicGroup;
        private float layersAlpha = 1f;
        private bool mapOpen;
        private bool mapSavedLocked;      // cursor lock state to restore when the map closes
        private bool mapSavedInput = true; // FirstPersonController.InputEnabled to restore
        private float airMinC = FallbackAirMinC;
        private float airMaxC = FallbackAirMaxC;
        private float darkness;
        private bool heldUnlock;
        private bool pendingDebugToggle;
        private Vector3 lastCameraPosition;
        private bool hasLastCameraPosition;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            Instance = null;
        }

        /// <summary>Builds the whole HUD for <paramref name="scanner"/> (spec §3) and returns its root component.</summary>
        public static HelmetHud Create(RockScanner scanner)
        {
            if (!scanner)
            {
                return null;
            }
            if (Instance)
            {
                return Instance;
            }

            // 1. Motion preference.
            HudTokens.ReducedMotion = PlayerPrefs.GetInt(HudTokens.ReducedMotionPrefKey, 0) == 1;

            // 2. Context and scene references.
            var ctx = new HudContext();
            ctx.Skin = HudSkin.Load();
            ctx.Scanner = scanner;
            ctx.Camera = scanner.GetComponent<Camera>();
            if (ctx.Camera == null)
            {
                ctx.Camera = Camera.main;
            }
            ctx.Player = scanner.GetComponentInParent<FirstPersonController>();
            ctx.DayNight = FindAnyObjectByType<DayNightCycle>();
            ctx.Weather = FindAnyObjectByType<MarsWeather>();

            // 3. The HUD replaces the IMGUI debug overlay (crosshair + box); F3 swaps them back and forth.
            RockScanDebugOverlay debugOverlay = scanner.GetComponent<RockScanDebugOverlay>();
            if (debugOverlay)
            {
                debugOverlay.enabled = false;
            }

            // 4. Root: overlay canvas, scaler, raycaster, night-dimming group.
            var go = new GameObject("HelmetHUD", typeof(RectTransform));
            go.layer = UiLayer;
            var canvas = go.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = HudTokens.SortingOrder;
            canvas.pixelPerfect = true;   // snaps Image/Text quads to screen pixels (nested canvases inherit); HudLineMesh strokes are AA'd instead
            var scaler = go.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(HudTokens.RefWidth, HudTokens.RefHeight);
            scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            scaler.matchWidthOrHeight = HudTokens.MatchWidthOrHeight;
            scaler.referencePixelsPerUnit = HudTokens.ReferencePixelsPerUnit;
            go.AddComponent<GraphicRaycaster>();
            CanvasGroup group = HudFactory.AddGroup(go, 1f, true);
            HelmetHud hud = go.AddComponent<HelmetHud>();

            ctx.Canvas = canvas;
            ctx.CanvasRect = (RectTransform)go.transform;
            hud.Context = ctx;
            hud.overlay = debugOverlay;
            hud.rootGroup = group;
            Instance = hud;

            try
            {
                hud.Build();
            }
            catch (Exception e)
            {
                // A half-built HUD would throw every frame: drop it and give the player the debug crosshair back.
                Debug.LogException(e);
                Instance = null;
                if (debugOverlay)
                {
                    debugOverlay.enabled = true;
                }
                Destroy(go);
                return null;
            }
            return hud;
        }

        private void Build()
        {
            HudContext ctx = Context;

            // Climate medians, read once (guard empty stats).
            MarsWeather weather = ctx.Weather;
            if (weather != null)
            {
                MarsHistoricalClimate climate = weather.Climate;
                if (climate != null)
                {
                    MarsHistoricalClimate.Stat lo = climate.AirTemperatureMinC;
                    MarsHistoricalClimate.Stat hi = climate.AirTemperatureMaxC;
                    if (lo.count > 0)
                    {
                        airMinC = lo.median;
                    }
                    if (hi.count > 0)
                    {
                        airMaxC = hi.median;
                    }
                }
            }

            // 5. Hierarchy (sibling order = draw order). HeadingCaret inserts its own "Caret" layer right after Dial.
            Transform root = transform;
            RectTransform staticLayer = HudFactory.CreateStretch("Static", root);
            HudFactory.AddNestedCanvas(staticLayer.gameObject, true);
            staticGroup = HudFactory.AddGroup(staticLayer.gameObject, 1f, true);   // faded out under the map screen
            ctx.StaticLayer = staticLayer;

            RectTransform dynamicLayer = HudFactory.CreateStretch("Dynamic", root);
            HudFactory.AddNestedCanvas(dynamicLayer.gameObject, true);
            dynamicGroup = HudFactory.AddGroup(dynamicLayer.gameObject, 1f, true);
            ctx.DialLayer = HudFactory.CreateStretch("Dial", dynamicLayer);
            ctx.ReticleLayer = HudFactory.CreateStretch("Reticle", dynamicLayer);
            ctx.LeaderLayer = HudFactory.CreateStretch("Leaders", dynamicLayer);
            ctx.CardLayer = HudFactory.CreateStretch("Cards", dynamicLayer);
            ctx.LocatorLayer = HudFactory.CreateStretch("Locators", dynamicLayer);
            ctx.AlertLayer = HudFactory.CreateStretch("Alert", dynamicLayer);
            ctx.TooltipLayer = HudFactory.CreateStretch("Tooltip", dynamicLayer);

            // 6. Reuse the scene's EventSystem; create one only when there is none at all.
            if (EventSystem.current == null && FindAnyObjectByType<EventSystem>() == null)
            {
                var es = new GameObject("EventSystem (HUD)");
                es.transform.SetParent(root, false);
                es.AddComponent<EventSystem>();
                es.AddComponent<InputSystemUIInputModule>();   // assigns the default UI actions in OnEnable
            }

            // Initial night dimming without a fade at boot.
            darkness = TargetDarkness();
            rootGroup.alpha = Mathf.Lerp(1f, HudTokens.NightGroupAlpha, darkness);

            // 7. Widgets. Telemetry and tooltip first: vitals, caption and alerts read them in their constructors.
            telemetry = new SuitTelemetry();
            ctx.Telemetry = telemetry;
            ctx.Mission = new MissionTracker();
            tooltip = new HudTooltip(ctx);
            ctx.Tooltip = tooltip;
            caption = new MissionCaption(ctx);
            missionPanel = new MissionPanel(ctx);
            vitals = new VitalsStack(ctx);
            dial = new CompassDial(ctx);
            caret = new HeadingCaret(ctx);
            reticle = new TargetReticle(ctx);
            cards = new RockCardSystem(ctx);
            ctx.Cards = cards;
            alerts = new AlertBanner(ctx);
            input = new HudInput();

            // 8. Map screen: its own nested canvas, last sibling (drawn above everything). Optional: a failure here
            //    leaves the rest of the HUD running.
            try
            {
                mapScreen = new MapScreen(ctx, root, CloseMap);
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                mapScreen = null;
            }
        }

        // Input only. Runs after FirstPersonController and the debug overlay (execution order 100).
        private void Update()
        {
            if (input == null)
            {
                return;
            }
            input.Poll();

            // Title/pause menu open: the HUD neither handles input nor touches the cursor (the menu owns it).
            if (MenuGate.IsOpen)
            {
                heldUnlock = false;
                return;
            }

            // Head lamp: L toggles (also with the map open).
            if (input.HeadlampPressed)
            {
                SetHeadlamp(!headlampOn);
            }

            // Map screen: G / Select toggles; X / East close it (and are then consumed: no rock card closes with it).
            bool closeConsumed = false;
            if (input.MapTogglePressed)
            {
                if (mapOpen)
                {
                    CloseMap();
                }
                else
                {
                    OpenMap();
                }
            }
            else if (mapOpen && input.CloseCardPressed)
            {
                CloseMap();
                closeConsumed = true;
            }
            if (mapOpen)
            {
                HoldMapInput();
                if (input.DebugTogglePressed)
                {
                    pendingDebugToggle = true;
                }
                return;
            }

            // Hold Tab = cursor free; releasing relocks only what Tab unlocked (Esc unlocks permanently via FPC).
            if (input.FreeCursorPressed && Cursor.lockState == CursorLockMode.Locked)
            {
                SetCursorLocked(false);
                heldUnlock = true;
            }
            if (input.FreeCursorReleased)
            {
                if (heldUnlock && Cursor.lockState != CursorLockMode.Locked)
                {
                    SetCursorLocked(true);
                }
                heldUnlock = false;
            }

            if (input.CloseCardPressed && !closeConsumed && cards != null)
            {
                cards.CloseFocused(CloseReason.Key);
            }
            if (input.DebugTogglePressed)
            {
                pendingDebugToggle = true;
            }
        }

        private void LateUpdate()
        {
            HudContext ctx = Context;
            if (ctx == null || reticle == null)
            {
                return;
            }
            if (!ctx.Scanner)
            {
                // Scanner gone (its scene unloaded): drop the HUD; the bootstrap rebuilds on the next scene load.
                Destroy(gameObject);
                return;
            }

            // Hidden under the title/pause menu; widgets resume where they were when it closes.
            bool menuOpen = MenuGate.IsOpen;
            if (ctx.Canvas != null && ctx.Canvas.enabled == menuOpen)
            {
                ctx.Canvas.enabled = !menuOpen;
            }
            if (menuOpen)
            {
                return;
            }

            float dt = Time.unscaledDeltaTime;
            float simDt = Time.deltaTime;

            // 0. Debug overlay swap, after the overlay's own Update ran this frame.
            if (pendingDebugToggle)
            {
                pendingDebugToggle = false;
                ApplyDebugToggle();
            }

            // 1. Per-frame camera values.
            ctx.UnscaledTime = Time.unscaledTime;
            Camera cam = ctx.Camera;
            bool hasCamera = cam != null;
            if (hasCamera)
            {
                Transform ct = cam.transform;
                ctx.CameraPosition = ct.position;
                Vector3 fwd = ct.forward;
                if (fwd.x * fwd.x + fwd.z * fwd.z >= 1e-8f)
                {
                    ctx.HeadingDeg = Mathf.Repeat(Mathf.Atan2(fwd.x, fwd.z) * Mathf.Rad2Deg, 360f);
                }
            }

            // 2. Telemetry model, before any widget.
            TelemetryInput ti = default;
            FirstPersonController player = ctx.Player;
            if (player != null)
            {
                Vector3 v = player.Velocity;
                ti.VelocityXZ = new Vector2(v.x, v.z);
                ti.HorizontalSpeed = Mathf.Sqrt(v.x * v.x + v.z * v.z);
                ti.Grounded = player.IsGrounded;
                ti.VerticalSpeed = ti.Grounded ? v.y : 0f;
                ti.Sprinting = player.IsSprinting;
                ti.SlopeDeg = player.GroundSlope;
            }
            else
            {
                ti.Grounded = true;
                if (hasCamera && hasLastCameraPosition && simDt > 1e-5f)
                {
                    float dx = ctx.CameraPosition.x - lastCameraPosition.x;
                    float dz = ctx.CameraPosition.z - lastCameraPosition.z;
                    ti.VelocityXZ = new Vector2(dx / simDt, dz / simDt);
                    ti.HorizontalSpeed = Mathf.Sqrt(dx * dx + dz * dz) / simDt;
                }
            }
            if (hasCamera)
            {
                lastCameraPosition = ctx.CameraPosition;
                hasLastCameraPosition = true;
            }

            bool skyLive = MarsSkyState.Version > 0;
            if (skyLive)
            {
                ti.LocalSolarTime = MarsSkyState.LocalSolarTime;
                ti.Sol = MarsSkyState.Sol;
            }
            else
            {
                ti.LocalSolarTime = ctx.DayNight != null ? ctx.DayNight.TimeOfDay : float.NaN;
                ti.Sol = -1;
            }
            ti.AirTempMinC = airMinC;
            ti.AirTempMaxC = airMaxC;
            ti.CameraPosition = ctx.CameraPosition;
            ti.DustDevilProximity = DustDevilField.ClosePass;
            FillWeather(ref ti);
            float targetDarkness = TargetDarkness();
            ti.Darkness = targetDarkness;
            SyncMission();
            telemetry.HeadlampOn = headlampOn;   // its power draw (a fresh EVA swaps the telemetry instance)
            telemetry.Tick(simDt, in ti);

            // 2b. Web mission: compare the live EVA with the plan (after telemetry: MET and O₂ of this frame).
            if (ctx.Mission != null && ctx.Mission.Active)
            {
                Vector3 feet = player != null ? player.transform.position : ctx.CameraPosition;
                ctx.Mission.Tick(feet, telemetry.MetSeconds / 60f, telemetry.O2LeftL);
                evaLog.Sample();
                float dose = MissionEnvironment.DoseRateMsvH(ctx.Mission.Plan, ctx.Mission.EvaMin, SuitTelemetry.DoseRateGaleMsvH);
                if (!float.IsNaN(dose))
                {
                    telemetry.DoseRateMsvH = dose;   // D39 storm replay on the EVA clock
                }
            }

            // 3. Night dimming: ink and scrim dim together through the root group.
            darkness = Mathf.MoveTowards(darkness, targetDarkness, dt / HudTokens.DayNightSmoothS);
            float alpha = Mathf.Lerp(1f, HudTokens.NightGroupAlpha, darkness);
            if (rootGroup.alpha != alpha)
            {
                rootGroup.alpha = alpha;
            }

            // 4. Widgets. Without a camera, cards and dial keep their last state; the reticle hides itself.
            reticle.Tick(dt);
            if (hasCamera)
            {
                cards.Tick(dt);
                dial.Tick(dt);
            }
            caret.Tick(dt);
            vitals.Tick(dt);
            caption.Tick(dt);
            missionPanel.Tick(dt);
            alerts.Tick(dt);
            tooltip.Tick(dt);

            // 5. Map screen last; the other layers fade by its eased visibility.
            if (mapScreen != null)
            {
                mapScreen.Tick(dt);
                ApplyLayersAlpha(1f - mapScreen.Visibility);
            }
        }

        /// <summary>True while the head lamp (L) is on.</summary>
        public bool HeadlampOn => headlampOn;

        /// <summary>Switches the head lamp: a warm spot light on the helmet, slightly above the eyes so boulders cast shadows.</summary>
        public void SetHeadlamp(bool on)
        {
            headlampOn = on;
            if (headlamp == null && on)
            {
                Camera cam = Context != null ? Context.Camera : null;
                if (cam == null)
                {
                    return;
                }
                var go = new GameObject("Headlamp");
                go.transform.SetParent(cam.transform, false);
                go.transform.localPosition = new Vector3(0f, 0.12f, 0.08f);   // helmet brow, ahead of the near plane
                go.transform.localRotation = Quaternion.Euler(4f, 0f, 0f);     // a little down, where the feet go
                headlamp = go.AddComponent<Light>();
                headlamp.type = LightType.Spot;
                headlamp.color = new Color(1f, 0.95f, 0.86f);                // warm white LED
                headlamp.range = 45f;
                headlamp.spotAngle = 58f;
                headlamp.innerSpotAngle = 30f;
                headlamp.intensity = 40f;                                     // inverse square: ~0.4 at 10 m, ~0.1 at 20 m
                headlamp.shadows = LightShadows.Soft;
                headlamp.shadowStrength = 0.85f;
                headlamp.renderMode = LightRenderMode.ForcePixel;
            }
            if (headlamp != null && headlamp.enabled != on)
            {
                headlamp.enabled = on;
            }
        }

        // A new mission (MissionLink) starts a fresh EVA: new suit model (MET 0, full O₂, battery, cooling water) and a
        // new tracker run. Widgets read ctx.Telemetry every frame, so swapping the instance is enough.
        private void SyncMission()
        {
            HudContext ctx = Context;
            if (ctx.Mission == null || MissionLink.Version == missionVersion)
            {
                return;
            }
            missionVersion = MissionLink.Version;
            MissionPlan plan = MissionLink.Current;
            evaLog.End(plan == null ? "mission cleared" : "another mission loaded");
            if (plan == null)
            {
                ctx.Mission.End();
                return;
            }
            telemetry = new SuitTelemetry();
            ctx.Telemetry = telemetry;
            ctx.Mission.Begin(plan);
            evaLog.Begin(ctx.Mission);
            Debug.Log("[Mission] fresh EVA: suit refilled, mission clock 0");
        }

        private void OnDestroy()
        {
            evaLog.End("scene ended");
            if (mapOpen)
            {
                RestoreAfterMap();
            }
            input?.Dispose();
            reticle?.Dispose();
            cards?.Dispose();
            input = null;
            reticle = null;
            cards = null;
            if (ReferenceEquals(Instance, this))
            {
                Instance = null;
            }
        }

        /// <summary>
        /// Reads NasaSpaceApp.Menu.MartisMenu.IsOpen (the title/pause menu, owned by another module) by reflection, so
        /// the HUD compiles and runs with or without it. One lookup per domain; the getter is a cached delegate (no GC).
        /// </summary>
        private static class MenuGate
        {
            private static bool resolved;
            private static System.Func<bool> isOpen;

            public static bool IsOpen
            {
                get
                {
                    if (!resolved)
                    {
                        resolved = true;
                        System.Type type = System.Type.GetType("NasaSpaceApp.Menu.MartisMenu, Assembly-CSharp");
                        System.Reflection.MethodInfo getter = type?.GetProperty("IsOpen",
                            System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)?.GetGetMethod();
                        if (getter != null && getter.ReturnType == typeof(bool))
                        {
                            isOpen = (System.Func<bool>)System.Delegate.CreateDelegate(typeof(System.Func<bool>), getter);
                        }
                    }
                    return isOpen != null && isOpen();
                }
            }
        }

        private void OpenMap()
        {
            HudContext ctx = Context;
            if (mapScreen == null || ctx == null || mapOpen)
            {
                return;
            }
            mapOpen = true;
            ctx.MapScreenOpen = true;
            // A Tab hold in progress counts as locked: closing the map returns to the locked game view.
            mapSavedLocked = Cursor.lockState == CursorLockMode.Locked || heldUnlock;
            heldUnlock = false;
            FirstPersonController player = ctx.Player;
            mapSavedInput = player == null || player.InputEnabled;
            HoldMapInput();
            SetLayersInteractive(false);
            mapScreen.SetOpen(true);
        }

        private void CloseMap()
        {
            if (!mapOpen)
            {
                return;
            }
            mapOpen = false;
            if (Context != null)
            {
                Context.MapScreenOpen = false;
            }
            RestoreAfterMap();
            SetLayersInteractive(true);
            mapScreen?.SetOpen(false);
        }

        // While the map is open (and the menu is closed): cursor free, player frozen. Re-asserted every frame because
        // the pause menu restores both when it closes over an open map.
        private void HoldMapInput()
        {
            FirstPersonController player = Context != null ? Context.Player : null;
            if (player != null && player.InputEnabled)
            {
                player.InputEnabled = false;
            }
            if (Cursor.lockState != CursorLockMode.None || !Cursor.visible)
            {
                SetCursorLocked(false);
            }
        }

        private void RestoreAfterMap()
        {
            FirstPersonController player = Context != null ? Context.Player : null;
            if (player != null)
            {
                player.InputEnabled = mapSavedInput;
            }
            bool locked = Cursor.lockState == CursorLockMode.Locked;
            if (locked != mapSavedLocked)
            {
                SetCursorLocked(mapSavedLocked);
            }
        }

        private void SetLayersInteractive(bool on)
        {
            if (staticGroup != null)
            {
                staticGroup.blocksRaycasts = on;
                staticGroup.interactable = on;
            }
            if (dynamicGroup != null)
            {
                dynamicGroup.blocksRaycasts = on;
                dynamicGroup.interactable = on;
            }
        }

        private void ApplyLayersAlpha(float a)
        {
            if (a == layersAlpha)
            {
                return;
            }
            layersAlpha = a;
            if (staticGroup != null)
            {
                staticGroup.alpha = a;
            }
            if (dynamicGroup != null)
            {
                dynamicGroup.alpha = a;
            }
        }

        private void SetCursorLocked(bool locked)
        {
            FirstPersonController player = Context != null ? Context.Player : null;
            if (player != null)
            {
                player.SetCursorLocked(locked);
                return;
            }
            Cursor.lockState = locked ? CursorLockMode.Locked : CursorLockMode.None;
            Cursor.visible = !locked;
        }

        // Two clean states: overlay on + HUD reticle hidden, or overlay off + HUD reticle shown.
        private void ApplyDebugToggle()
        {
            if (!overlay)
            {
                return;
            }
            if (!overlay.enabled)
            {
                // The overlay flips its own 'visible' on F3 while enabled; force it on so every enable shows it.
                FieldInfo visibleField = OverlayVisibleField();
                if (visibleField != null)
                {
                    visibleField.SetValue(overlay, s_BoxedTrue);
                }
                overlay.enabled = true;
                reticle.Visible = false;
            }
            else
            {
                overlay.enabled = false;
                reticle.Visible = true;
            }
        }

        private static FieldInfo OverlayVisibleField()
        {
            if (!s_OverlayVisibleResolved)
            {
                s_OverlayVisible = typeof(RockScanDebugOverlay).GetField("visible", BindingFlags.NonPublic | BindingFlags.Instance);
                if (s_OverlayVisible != null && s_OverlayVisible.FieldType != typeof(bool))
                {
                    s_OverlayVisible = null;
                }
                s_OverlayVisibleResolved = true;
            }
            return s_OverlayVisible;
        }

        // Weather now: the published frame (MarsAtmosphere hub, already smoothed), else the MarsWeather component, else
        // calm air with a typical tau. Non-finite values fall back to the neutral defaults.
        private void FillWeather(ref TelemetryInput ti)
        {
            Vector2 wind = Vector2.zero;
            float windSpeed = 0f, gust = 0f, tau = FallbackDustTau, storm = 0f;
            MarsWeather weather = Context.Weather;
            if (MarsAtmosphere.Owner != null)
            {
                WeatherFrame f = MarsAtmosphere.Frame;
                wind = f.wind;
                windSpeed = f.windSpeed;
                gust = f.gust;
                tau = f.opticalDepth;
                storm = f.stormAmount;
            }
            else if (weather != null)
            {
                wind = weather.Wind;
                windSpeed = weather.WindSpeed;
                tau = weather.OpticalDepth;
            }

            ti.WindXZ = Finite(wind.x) && Finite(wind.y) ? wind : Vector2.zero;
            ti.WindSpeed = Finite(windSpeed) ? Mathf.Max(0f, windSpeed) : ti.WindXZ.magnitude;
            ti.Gust = Finite(gust) ? Mathf.Clamp01(gust) : 0f;
            ti.DustTau = Finite(tau) && tau > 0f ? tau : FallbackDustTau;   // tau 0 = no weather published yet
            ti.StormAmount = Finite(storm) ? Mathf.Clamp01(storm) : 0f;
        }

        private static bool Finite(float v)
        {
            return !float.IsNaN(v) && !float.IsInfinity(v);
        }

        private static float TargetDarkness()
        {
            float d = MarsSkyState.Version > 0
                ? MarsSkyState.Darkness
                : 1f - Mathf.InverseLerp(-0.05f, 0.25f, MarsAtmosphere.SunHeight);
            return Mathf.Clamp01(d);
        }
    }
}

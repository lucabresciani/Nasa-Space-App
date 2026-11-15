using System;
using System.Collections.Generic;
using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.UI;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// Root of the MARVIS title / pause screen: one overlay canvas (backdrop, planet, logo, main list, panel host,
    /// footer, boot fade) and the Hidden / Title / Pause state machine. While open the simulation is suspended
    /// (timeScale 0, audio paused, Player map off, cursor free, gameplay keys masked by <see cref="MenuInputGate"/>).
    /// Built at runtime by <see cref="MenuBootstrap"/>; lives in the active scene and dies with it.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public sealed class MarvisMenu : MonoBehaviour
    {
        /// <summary>EditorPrefs bool: start every play session with the title skipped (editor only).</summary>
        public const string SkipTitleEditorPrefKey = "marvis.menu.skipTitleInEditor";

        private const int UiLayer = 5;
        private const float FocusGrace = 0.3f;        // input ignored this long after the window regains focus
        private const float PlanItemY = 552f;         // MISSION PLAN label centre, between RESUME and SETTINGS
        private const float BackBottom = 24f;         // Back pill bottom, px above the panel box bottom
        private const float BackInset = 8f;           // keeps the focused Back pill's left diamond inside the panel box
        private const float ContentGap = 16f;         // header rule to content rect
        private const float FooterGroupGap = 20f;
        private const float AttributionRight = 48f;
        private const float HintArrowSize = 10f;
        private const string Attribution =
            "MARS  NASA / JPL-CALTECH / USGS      STARS  NASA / GSFC SCIENTIFIC VISUALIZATION STUDIO";

        private const string LabelStart = "START SIMULATION", LabelRestart = "RESTART SIMULATION";
        private const string LabelConfirmRestart = "CONFIRM RESTART?", LabelQuit = "QUIT", LabelConfirmQuit = "CONFIRM QUIT?";

        // Entry slots; DisplayOrder is top to bottom.
        private const int EStart = 0, EResume = 1, ESettings = 2, ECredits = 3, EQuit = 4, EPlan = 5, EntryCount = 6;
        private static readonly int[] DisplayOrder = { EStart, EResume, EPlan, ESettings, ECredits, EQuit };

        private enum State
        {
            Hidden,
            Title,
            Pause,
        }

        /// <summary>The menu of the active scene, or null.</summary>
        public static MarvisMenu Instance { get; private set; }

        /// <summary>True while the title or the pause screen is up (simulation suspended).</summary>
        public static bool IsOpen { get; private set; }

        /// <summary>Raised right after the menu opened and the simulation was suspended (title at boot, or pause).</summary>
        public static event Action Opened;

        /// <summary>Raised right after the simulation resumed (START or RESUME).</summary>
        public static event Action Closed;

        /// <summary>
        /// Called when START SIMULATION is activated on the title. True = handled, the caller will call
        /// <see cref="StartNow"/> later (the title stays up and usable); null or false = start now.
        /// </summary>
        public static Func<bool> StartInterceptor;

        /// <summary>When non-null a MISSION PLAN entry is shown; activating it invokes this and the menu stays open.</summary>
        public static Action PlanRequested;

        private static bool skipTitleOnce;

        // Domain reload is off: everything static starts clean each play session (others re-register at BeforeSceneLoad).
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            Instance = null;
            IsOpen = false;
            Opened = null;
            Closed = null;
            StartInterceptor = null;
            PlanRequested = null;
            skipTitleOnce = false;
        }

        /// <summary>
        /// Starts (title) or resumes (pause) the simulation without calling <see cref="StartInterceptor"/>, when a menu
        /// exists and is open; otherwise no-op. Main thread; safe at any time (applied in the menu's next LateUpdate).
        /// </summary>
        public static void StartNow()
        {
            MarvisMenu m = Instance;
            if (m == null || !m.built || !IsOpen || m.state == State.Hidden)
            {
                return;
            }
            m.pendingClose = true;
        }

        /// <summary>
        /// Opens the pause screen as the Esc key does, when a menu exists and is closed; otherwise no-op. Main thread;
        /// safe at any time (applied in the menu's next LateUpdate).
        /// </summary>
        public static void OpenNow()
        {
            MartisMenu m = Instance;
            if (m == null || !m.built || IsOpen || m.state != State.Hidden)
            {
                return;
            }
            m.pendingOpen = true;
        }

        /// <summary>True once the simulation has been started in this scene.</summary>
        public bool SessionStarted => sessionStarted;

        private MenuContext ctx;
        private Canvas canvas;
        private CanvasGroup rootGroup;
        private MenuBackdrop backdrop;
        private MenuLogo logo;
        private RectTransform mainRect;
        private CanvasGroup mainGroup;
        private readonly MenuButton[] entries = new MenuButton[EntryCount];
        private readonly CanvasGroup[] entryGroups = new CanvasGroup[EntryCount];
        private readonly Vector2[] entryPos = new Vector2[EntryCount];
        private readonly MenuButton[] navBuf = new MenuButton[EntryCount];
        private readonly int[] visibleBuf = new int[EntryCount];
        private int navCount, visibleCount;

        private RectTransform panelBox, contentHost;
        private CanvasGroup panelGroup;
        private Text panelTitle;
        private MenuButton backButton;
        private Vector2 panelPos;
        private MenuPanel activePanel;
        private readonly Dictionary<MenuPanel, RectTransform> panelRects = new Dictionary<MenuPanel, RectTransform>();
        private SettingsPanel settings;
        private CreditsPanel credits;
        private MenuButton returnSelection;

        private CanvasGroup footerGroup;
        private Image overlay;

        private FirstPersonController player;
        private InputAction pauseAction, backAction, controlsAction;

        private bool built;
        private State state;
        private bool sessionStarted, suspended, isOpenHere, restarting;
        private bool pendingOpen, pendingClose;
        private float savedTimeScale = 1f;
        private float inputBlockedUntil;

        private Fader rootFade, mainFade, panelFade;
        private bool introRunning;
        private float introT;

        private bool worldHidden, worldHideTried;
        private Camera hiddenCamera;
        private int savedCullingMask;
        private CameraClearFlags savedClearFlags;
        private Color savedBackground;

        private MenuButton confirmButton;
        private string confirmRestoreLabel;
        private float confirmUntil;
        private GameObject lastSelected;

        private SettingsPanel Settings => settings ??= new SettingsPanel();
        private CreditsPanel Credits => credits ??= new CreditsPanel();

        /// <summary>
        /// Builds the menu (title state, unless the title is skipped once after RESTART or by the editor pref). A build
        /// error is logged, nothing stays suspended and null is returned: a broken menu never locks the player out.
        /// </summary>
        internal static MarvisMenu Create()
        {
            if (Instance)
            {
                return Instance;
            }

            bool skip = skipTitleOnce;
            skipTitleOnce = false;
#if UNITY_EDITOR
            skip |= UnityEditor.EditorPrefs.GetBool(SkipTitleEditorPrefKey, false);
#endif

            var go = new GameObject("MarvisMenu", typeof(RectTransform));
            go.layer = UiLayer;
            MarvisMenu menu = null;
            try
            {
                var canvas = go.AddComponent<Canvas>();
                canvas.renderMode = RenderMode.ScreenSpaceOverlay;
                canvas.sortingOrder = MenuTokens.SortingOrder;
                var scaler = go.AddComponent<CanvasScaler>();
                scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
                scaler.referenceResolution = new Vector2(MenuTokens.RefWidth, MenuTokens.RefHeight);
                scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
                scaler.matchWidthOrHeight = MenuTokens.MatchWidthOrHeight;
                scaler.referencePixelsPerUnit = HudTokens.ReferencePixelsPerUnit;
                go.AddComponent<GraphicRaycaster>();
                CanvasGroup group = HudFactory.AddGroup(go, 1f, true);

                menu = go.AddComponent<MarvisMenu>();
                menu.canvas = canvas;
                menu.rootGroup = group;
                Instance = menu;
                menu.Build(skip);
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                if (menu != null)
                {
                    menu.built = false;
                    menu.UndoSuspension();
                    menu.DisposeInput();
                }
                if (ReferenceEquals(Instance, menu))
                {
                    Instance = null;
                }
                Destroy(go);
                return null;
            }
            return menu;
        }

        private void Build(bool skipTitle)
        {
            var skin = HudSkin.Load();
            ctx = new MenuContext
            {
                Skin = skin,
                Assets = MenuAssets.Load(skin),
                Canvas = canvas,
                CanvasRect = (RectTransform)transform,
                Menu = this,
            };
            player = FindAnyObjectByType<FirstPersonController>();

            // Sibling order = draw order.
            backdrop = new MenuBackdrop(ctx, transform);   // 1 + 2
            logo = new MenuLogo(ctx, transform);           // 3
            BuildMainList();                               // 4
            BuildPanelHost();                              // 5
            BuildFooter();                                 // 6
            RectTransform fade = HudFactory.CreateStretch("Fade", transform);   // 7
            overlay = fade.gameObject.AddComponent<Image>();
            overlay.color = MenuTokens.Void;
            overlay.raycastTarget = false;
            overlay.enabled = false;

            EnsureEventSystem();
            CreateInput();
            mainFade.Snap(1f);
            panelFade.Snap(0f);
            built = true;

            if (skipTitle)
            {
                state = State.Hidden;
                sessionStarted = true;
                rootFade.Snap(0f);
                rootGroup.alpha = 0f;
                rootGroup.interactable = false;
                rootGroup.blocksRaycasts = false;
                canvas.enabled = false;
                return;
            }

            state = State.Title;
            rootFade.Snap(1f);
            rootGroup.alpha = 1f;
            RefreshEntries();
            BeginIntro();
            Suspend();
            Select(entries[EStart]);
            Raise(Opened);
        }

        // ---------------------------------------------------------------- build

        private void BuildMainList()
        {
            mainRect = HudFactory.CreateStretch("Main", transform);
            mainGroup = HudFactory.AddGroup(mainRect.gameObject, 1f, true);

            var topLeft = new Vector2(0f, 1f);
            var center = new Vector2(0.5f, 0.5f);
            float[] y = MenuTokens.MenuItemY;
            CreateEntry(EStart, LabelStart, y[0], OnStartEntry);
            CreateEntry(EResume, "RESUME SIMULATION", y[1], OnResumeEntry);
            CreateEntry(EPlan, "MISSION PLAN", PlanItemY, OnPlanEntry);
            CreateEntry(ESettings, "SETTINGS", y[2], () => ShowPanel(Settings));
            CreateEntry(ECredits, "CREDITS", y[3], () => ShowPanel(Credits));
            CreateEntry(EQuit, LabelQuit, y[4], OnQuitEntry);

            void CreateEntry(int slot, string label, float labelY, Action onClick)
            {
                Vector2 pos = new Vector2(MenuTokens.MenuCenterX, -labelY);
                MenuButton b = MenuButton.Create(ctx, mainRect, label, MenuTokens.SizeMenuItem, topLeft, center, pos, onClick);
                b.name = "Entry_" + label.Replace(' ', '_');
                entries[slot] = b;
                entryGroups[slot] = HudFactory.AddGroup(b.gameObject, 1f, true);
                entryPos[slot] = pos;
            }
        }

        private void BuildPanelHost()
        {
            var topLeft = new Vector2(0f, 1f);
            var center = new Vector2(0.5f, 0.5f);
            var size = new Vector2(MenuTokens.PanelWidth, MenuTokens.PanelHeight);
            panelPos = new Vector2(MenuTokens.MarginLeft, -MenuTokens.PanelTop);

            panelBox = HudFactory.CreateRect("Panel", transform, topLeft, topLeft, panelPos, size);
            panelGroup = HudFactory.AddGroup(panelBox.gameObject, 0f, false);
            panelGroup.interactable = false;

            MenuUi.Pill("Box", panelBox, ctx, MenuTokens.ScrimPanel, MenuTokens.PanelRadius, center, center, Vector2.zero, size);

            float inner = MenuTokens.PanelWidth - 2f * MenuTokens.PanelPad;
            panelTitle = MenuUi.Label("Title", panelBox, ctx.Assets.Bold, MenuTokens.SizePanelTitle, MenuTokens.Bronze,
                                      TextAnchor.MiddleLeft, topLeft, new Vector2(0f, 0.5f),
                                      new Vector2(MenuTokens.PanelPad, -MenuTokens.PanelHeaderHeight * 0.5f),
                                      new Vector2(inner, MenuTokens.PanelHeaderHeight), string.Empty);
            HudFactory.CreateImage("Rule", panelBox, null, MenuTokens.Hairline, topLeft, topLeft,
                                   new Vector2(MenuTokens.PanelPad, -MenuTokens.PanelHeaderHeight), new Vector2(inner, 1f));

            contentHost = HudFactory.CreateRect("Content", panelBox, topLeft, topLeft,
                                                new Vector2(MenuTokens.PanelPad, -(MenuTokens.PanelHeaderHeight + ContentGap)),
                                                new Vector2(MenuTokens.ContentWidth, MenuTokens.ContentHeight));

            backButton = MenuButton.Create(ctx, panelBox, "BACK", MenuTokens.SizeMenuItem, Vector2.zero, new Vector2(0f, 0.5f),
                                           new Vector2(MenuTokens.PanelPad + BackInset, BackBottom + MenuTokens.MenuItemHeight * 0.5f), Back);
            backButton.name = "Back";
            backButton.SetIcon(ctx.Assets.Chevron, true);

            panelBox.gameObject.SetActive(false);
        }

        private void BuildFooter()
        {
            RectTransform footer = HudFactory.CreateStretch("Footer", transform);
            footerGroup = HudFactory.AddGroup(footer.gameObject, 1f, false);

            float x = MenuTokens.MarginLeft;
            x = Arrow(footer, x, 90f, "Up");
            x = Arrow(footer, x + MenuTokens.KeycapGap, -90f, "Down");
            x = HintLabel(footer, x, "NAVIGATE") + FooterGroupGap;
            x = Key(footer, x, "ENTER");
            x = HintLabel(footer, x, "SELECT") + FooterGroupGap;
            x = Key(footer, x, "ESC");
            x = HintLabel(footer, x, "BACK") + FooterGroupGap;
            x = Key(footer, x, "F1");
            HintLabel(footer, x, "CONTROLS");

            MenuUi.Label("Attribution", footer, ctx.Assets.Regular, MenuTokens.SizeFine, MenuTokens.SandFaint,
                         TextAnchor.MiddleRight, new Vector2(1f, 0f), new Vector2(1f, 0f),
                         new Vector2(-AttributionRight, MenuTokens.FooterBottom),
                         new Vector2(MenuTokens.RefWidth * 0.5f, MenuTokens.KeycapHeight), Attribution);
        }

        private float Key(Transform parent, float x, string key)
        {
            MenuUi.Keycap("Key_" + key, parent, ctx, key, Vector2.zero, Vector2.zero, new Vector2(x, MenuTokens.FooterBottom));
            return x + MenuUi.KeycapWidth(key);
        }

        // Arrow keycap: the chevron sprite rotated (no Unicode arrows); without the sprite, the mono arrow glyph.
        private float Arrow(Transform parent, float x, float rotation, string name)
        {
            Sprite chevron = ctx.Assets.Chevron;
            string key = chevron != null ? string.Empty : (rotation > 0f ? "↑" : "↓");
            RectTransform chip = MenuUi.Keycap("Key_" + name, parent, ctx, key, Vector2.zero, Vector2.zero,
                                               new Vector2(x, MenuTokens.FooterBottom));
            if (chevron != null)
            {
                var center = new Vector2(0.5f, 0.5f);
                Image arrow = HudFactory.CreateIcon("Arrow", chip, chevron, MenuTokens.Sand, HintArrowSize, center, center, Vector2.zero);
                arrow.rectTransform.localRotation = Quaternion.Euler(0f, 0f, rotation);
            }
            return x + MenuUi.KeycapWidth(key);
        }

        private float HintLabel(Transform parent, float x, string text)
        {
            x += MenuTokens.KeycapGap;
            Text t = MenuUi.Label("Hint_" + text, parent, ctx.Assets.Regular, MenuTokens.SizeHint, MenuTokens.SandFaint,
                                  TextAnchor.MiddleLeft, Vector2.zero, Vector2.zero, new Vector2(x, MenuTokens.FooterBottom),
                                  new Vector2(0f, MenuTokens.KeycapHeight), text);
            float w = Mathf.Ceil(t.preferredWidth);
            t.rectTransform.sizeDelta = new Vector2(w, MenuTokens.KeycapHeight);
            return x + w;
        }

        private void EnsureEventSystem()
        {
            if (EventSystem.current == null && FindAnyObjectByType<EventSystem>() == null)
            {
                var es = new GameObject("EventSystem (Menu)");
                es.transform.SetParent(transform, false);
                es.AddComponent<EventSystem>();
                es.AddComponent<InputSystemUIInputModule>();   // assigns the default UI actions in OnEnable
            }
        }

        private void CreateInput()
        {
            pauseAction = new InputAction("MenuPause", InputActionType.Button);
            pauseAction.AddBinding("<Keyboard>/escape");
            pauseAction.AddBinding("<Gamepad>/start");
            backAction = new InputAction("MenuBack", InputActionType.Button);
            backAction.AddBinding("<Keyboard>/escape");
            backAction.AddBinding("<Gamepad>/buttonEast");
            controlsAction = new InputAction("MenuControls", InputActionType.Button, "<Keyboard>/f1");
            pauseAction.Enable();
            backAction.Enable();
            controlsAction.Enable();
        }

        private void DisposeInput()
        {
            DisposeAction(ref pauseAction);
            DisposeAction(ref backAction);
            DisposeAction(ref controlsAction);
        }

        private static void DisposeAction(ref InputAction action)
        {
            if (action == null)
            {
                return;
            }
            action.Disable();
            action.Dispose();
            action = null;
        }

        // ---------------------------------------------------------------- frame

        // Input only; open / resume are applied in LateUpdate (FirstPersonController.Update would unlock a cursor
        // locked here on the frame Esc resumed the game).
        private void Update()
        {
            if (!built)
            {
                return;
            }
            float now = Time.unscaledTime;
            if (!Application.isFocused)
            {
                inputBlockedUntil = now + FocusGrace;
            }

            if (introRunning && AnyPress())
            {
                FinishIntro();
            }
            if (restarting || now < inputBlockedUntil)
            {
                return;
            }

            bool pause = pauseAction.WasPressedThisFrame();
            bool back = backAction.WasPressedThisFrame();
            bool controls = controlsAction.WasPressedThisFrame();

            if (state == State.Hidden)
            {
                if (pause)
                {
                    pendingOpen = true;
                }
                return;
            }
            if (pendingClose)
            {
                return;
            }
            if (controls)
            {
                ShowControls();
                return;
            }
            if (activePanel != null)
            {
                if (back)
                {
                    Back();
                }
                return;
            }
            if (state == State.Pause && pause)
            {
                pendingClose = true;
            }
        }

        private void OnApplicationFocus(bool hasFocus)
        {
            if (hasFocus)
            {
                inputBlockedUntil = Time.unscaledTime + FocusGrace;
            }
        }

        private void LateUpdate()
        {
            if (!built)
            {
                return;
            }
            float now = Time.unscaledTime;
            float dt = Time.unscaledDeltaTime;

            if (pendingClose)
            {
                pendingClose = false;
                pendingOpen = false;
                if (IsOpen && state != State.Hidden && !restarting)
                {
                    ApplyClose(now);
                }
            }
            if (pendingOpen)
            {
                pendingOpen = false;
                if (state == State.Hidden && !restarting)
                {
                    ApplyOpen(now);
                }
            }

            if (IsOpen)
            {
                FreeCursor();
                KeepSelection();
                if (confirmButton != null && (now >= confirmUntil || !confirmButton.IsFocused))
                {
                    ClearConfirm();
                }
            }

            SetAlpha(rootGroup, rootFade.Evaluate(now));
            if (state == State.Hidden && canvas.enabled && rootFade.Done && rootFade.Value <= 0f)
            {
                canvas.enabled = false;
            }
            if (!canvas.enabled)
            {
                return;
            }
            if (IsOpen && !worldHidden && !worldHideTried && rootFade.Done && rootFade.Value >= 1f)
            {
                HideWorld();
            }

            SetAlpha(mainGroup, mainFade.Evaluate(now));
            SetAlpha(panelGroup, panelFade.Evaluate(now));
            if (panelBox.gameObject.activeSelf)
            {
                float slide = MenuTokens.ReducedMotion ? 0f : (1f - panelFade.Value) * MenuTokens.PanelSlide;
                panelBox.anchoredPosition = panelPos + new Vector2(slide, 0f);
                if (activePanel == null && panelFade.Done)
                {
                    panelBox.gameObject.SetActive(false);
                }
            }

            if (introRunning)
            {
                introT += dt;
                ApplyIntro();
            }
            backdrop.Tick(dt);
            logo.Tick(dt);
            if (activePanel != null)
            {
                activePanel.Tick(dt);
            }
        }

        private void OnDestroy()
        {
            if (ReferenceEquals(Instance, this))
            {
                Instance = null;
            }
            UndoSuspension();
            DisposeInput();
            MenuInputGate.Disable();
            if (backdrop != null)
            {
                backdrop.Dispose();
            }
        }

        // ---------------------------------------------------------------- open / close

        private void ApplyOpen(float now)
        {
            state = State.Pause;
            Suspend();
            canvas.enabled = true;
            rootGroup.interactable = true;
            rootGroup.blocksRaycasts = true;
            rootFade.SetTarget(1f, MenuTokens.Dur(MenuTokens.DurOpenPause), now, 0f);
            ShowMainImmediate();
            RefreshEntries();
            Select(entries[EResume]);
            Raise(Opened);
        }

        private void ApplyClose(float now)
        {
            bool fromTitle = state == State.Title;
            ClearConfirm();
            UndoSuspension();
            SetCursorLocked(true);
            sessionStarted = true;
            state = State.Hidden;
            FinishIntro();

            EventSystem es = EventSystem.current;
            if (es != null && es.currentSelectedGameObject != null && es.currentSelectedGameObject.transform.IsChildOf(transform))
            {
                es.SetSelectedGameObject(null);
            }
            lastSelected = null;

            Raise(Closed);

            rootGroup.interactable = false;
            rootGroup.blocksRaycasts = false;
            rootFade.SetTarget(0f, MenuTokens.Dur(fromTitle ? MenuTokens.DurStartFade : MenuTokens.DurClose), now, 0f);
        }

        private void Suspend()
        {
            if (!suspended)
            {
                float ts = Time.timeScale;
                savedTimeScale = ts > 0f ? ts : 1f;
                Time.timeScale = 0f;
                AudioListener.pause = true;
                SetPlayerMap(false);
                if (player)
                {
                    player.InputEnabled = false;
                }
                suspended = true;
            }
            FreeCursor();
            MenuInputGate.Enable();
            isOpenHere = true;
            IsOpen = true;
        }

        // Everything "resume" does except the cursor lock and the events; idempotent.
        private void UndoSuspension()
        {
            RestoreWorld();
            if (suspended)
            {
                suspended = false;
                Time.timeScale = savedTimeScale;
                AudioListener.pause = false;
                SetPlayerMap(true);
                if (player)
                {
                    player.InputEnabled = true;
                }
            }
            MenuInputGate.Disable();
            if (isOpenHere)
            {
                isOpenHere = false;
                IsOpen = false;
            }
        }

        private static void SetPlayerMap(bool enabled)
        {
            InputActionAsset actions = InputSystem.actions;
            if (actions == null)
            {
                return;
            }
            InputActionMap map = actions.FindActionMap("Player");
            if (map == null)
            {
                return;
            }
            if (enabled)
            {
                map.Enable();
            }
            else
            {
                map.Disable();
            }
        }

        private void FreeCursor()
        {
            if (Cursor.lockState == CursorLockMode.None && Cursor.visible)
            {
                return;
            }
            if (player)
            {
                player.SetCursorLocked(false);
            }
            else
            {
                Cursor.lockState = CursorLockMode.None;
                Cursor.visible = true;
            }
        }

        private void SetCursorLocked(bool locked)
        {
            if (player)
            {
                player.SetCursorLocked(locked);
                return;
            }
            Cursor.lockState = locked ? CursorLockMode.Locked : CursorLockMode.None;
            Cursor.visible = !locked;
        }

        // The menu covers the whole screen once faded in: stop rendering the world behind it.
        private void HideWorld()
        {
            worldHideTried = true;
            Camera cam = null;
            if (player && player.CameraTransform)
            {
                cam = player.CameraTransform.GetComponent<Camera>();
            }
            if (!cam)
            {
                cam = Camera.main;
            }
            if (!cam)
            {
                return;
            }
            hiddenCamera = cam;
            savedCullingMask = cam.cullingMask;
            savedClearFlags = cam.clearFlags;
            savedBackground = cam.backgroundColor;
            cam.cullingMask = 0;
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = Color.black;
            worldHidden = true;
        }

        private void RestoreWorld()
        {
            worldHideTried = false;
            if (!worldHidden)
            {
                return;
            }
            worldHidden = false;
            if (hiddenCamera)
            {
                hiddenCamera.cullingMask = savedCullingMask;
                hiddenCamera.clearFlags = savedClearFlags;
                hiddenCamera.backgroundColor = savedBackground;
            }
            hiddenCamera = null;
        }

        private static void SetAlpha(CanvasGroup group, float alpha)
        {
            if (group.alpha != alpha)
            {
                group.alpha = alpha;
            }
        }

        private static void Raise(Action e)
        {
            if (e == null)
            {
                return;
            }
            try
            {
                e();
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
        }

        // ---------------------------------------------------------------- entries

        private void OnStartEntry()
        {
            if (!CanAct())
            {
                return;
            }
            if (state == State.Title)
            {
                bool handled = false;
                Func<bool> interceptor = StartInterceptor;
                if (interceptor != null)
                {
                    try
                    {
                        handled = interceptor();
                    }
                    catch (Exception e)
                    {
                        Debug.LogException(e);
                        handled = false;
                    }
                }
                if (!handled)
                {
                    pendingClose = true;
                }
                return;
            }
            Confirm(entries[EStart], LabelConfirmRestart, LabelRestart, Restart);
        }

        private void OnResumeEntry()
        {
            if (CanAct() && state == State.Pause)
            {
                pendingClose = true;
            }
        }

        private void OnPlanEntry()
        {
            if (CanAct())
            {
                Raise(PlanRequested);
            }
        }

        private void OnQuitEntry()
        {
            if (!CanAct())
            {
                return;
            }
            if (state == State.Pause)
            {
                Confirm(entries[EQuit], LabelConfirmQuit, LabelQuit, Quit);
            }
            else
            {
                Quit();
            }
        }

        private bool CanAct()
        {
            return built && IsOpen && state != State.Hidden && !pendingClose && !restarting;
        }

        private void Confirm(MenuButton button, string confirmLabel, string normalLabel, Action action)
        {
            if (confirmButton == button && Time.unscaledTime < confirmUntil)
            {
                ClearConfirm();
                action();
                return;
            }
            ClearConfirm();
            confirmButton = button;
            confirmRestoreLabel = normalLabel;
            confirmUntil = Time.unscaledTime + MenuTokens.ConfirmWindow;
            button.SetLabel(confirmLabel);
            button.SetAlert(true);
        }

        private void ClearConfirm()
        {
            if (confirmButton == null)
            {
                return;
            }
            confirmButton.SetLabel(confirmRestoreLabel);
            confirmButton.SetAlert(false);
            confirmButton = null;
        }

        private void Restart()
        {
            restarting = true;
            if (StartInterceptor == null)
            {
                skipTitleOnce = true;
            }
            UndoSuspension();
            Scene scene = SceneManager.GetActiveScene();
#if UNITY_EDITOR
            UnityEditor.SceneManagement.EditorSceneManager.LoadSceneInPlayMode(scene.path, new LoadSceneParameters(LoadSceneMode.Single));
#else
            SceneManager.LoadScene(scene.buildIndex);
#endif
        }

        private void Quit()
        {
            restarting = true;
            UndoSuspension();
#if UNITY_EDITOR
            UnityEditor.EditorApplication.isPlaying = false;
#else
            Application.Quit();
#endif
        }

        // Labels, enabled state, MISSION PLAN visibility and explicit wrap-around navigation over the usable entries.
        private void RefreshEntries()
        {
            ClearConfirm();
            bool title = state == State.Title;
            entries[EStart].SetLabel(title ? LabelStart : LabelRestart);
            entries[EStart].SetAlert(false);
            entries[EResume].SetInteractable(!title);
            entries[EPlan].gameObject.SetActive(PlanRequested != null);

            navCount = 0;
            visibleCount = 0;
            for (int i = 0; i < DisplayOrder.Length; i++)
            {
                int slot = DisplayOrder[i];
                MenuButton b = entries[slot];
                if (!b.gameObject.activeSelf)
                {
                    continue;
                }
                visibleBuf[visibleCount++] = slot;
                if (b.interactable)
                {
                    navBuf[navCount++] = b;
                }
                else
                {
                    b.navigation = new Navigation { mode = Navigation.Mode.None };
                }
            }
            for (int k = 0; k < navCount; k++)
            {
                navBuf[k].navigation = new Navigation
                {
                    mode = Navigation.Mode.Explicit,
                    selectOnUp = navBuf[(k - 1 + navCount) % navCount],
                    selectOnDown = navBuf[(k + 1) % navCount],
                };
            }
        }

        // ---------------------------------------------------------------- panels

        /// <summary>
        /// Shows <paramref name="panel"/> in the panel host (built on first show and kept): the main list fades out, the
        /// panel fades and slides in, and its <see cref="MenuPanel.DefaultSelection"/> (or the Back button) is selected.
        /// Ignored while the menu is closed.
        /// </summary>
        public void ShowPanel(MenuPanel panel)
        {
            if (panel == null || !CanAct() || panel == activePanel)
            {
                return;
            }
            ClearConfirm();
            float now = Time.unscaledTime;

            MenuPanel previous = activePanel;
            if (previous == null)
            {
                GameObject sel = EventSystem.current != null ? EventSystem.current.currentSelectedGameObject : null;
                returnSelection = sel != null && sel.transform.IsChildOf(mainRect) ? sel.GetComponent<MenuButton>() : null;
            }
            else
            {
                previous.OnHide();
                SetPanelContentActive(previous, false);
            }

            bool wasVisible = panelBox.gameObject.activeSelf && panelFade.Value > 0.01f;
            panelBox.gameObject.SetActive(true);
            RectTransform content = GetPanelContent(panel);
            if (content == null)
            {
                activePanel = null;
                BackToMain(now);
                return;
            }
            // Only this panel's content may be live: Back() leaves the last panel's content active under the fading box.
            foreach (KeyValuePair<MenuPanel, RectTransform> pair in panelRects)
            {
                if (pair.Value)
                {
                    pair.Value.gameObject.SetActive(pair.Key == panel);
                }
            }
            activePanel = panel;
            panelTitle.text = panel.Title;

            mainGroup.interactable = false;
            mainGroup.blocksRaycasts = false;
            mainFade.SetTarget(0f, MenuTokens.Dur(MenuTokens.DurPanelOut), now, 0f);
            panelGroup.interactable = true;
            panelGroup.blocksRaycasts = true;
            panelFade.SetTarget(1f, MenuTokens.Dur(MenuTokens.DurPanelIn), now,
                                wasVisible ? 0f : MenuTokens.Dur(MenuTokens.DurPanelOut));

            panel.OnShow();
            Selectable first = panel.DefaultSelection;
            Select(first != null ? first : backButton);
        }

        /// <summary>From a panel: returns to the main list and re-selects the entry that opened the panel.</summary>
        public void Back()
        {
            if (activePanel == null || !built)
            {
                return;
            }
            MenuPanel p = activePanel;
            activePanel = null;
            p.OnHide();
            BackToMain(Time.unscaledTime);
        }

        private void BackToMain(float now)
        {
            panelGroup.interactable = false;
            panelGroup.blocksRaycasts = false;
            panelFade.SetTarget(0f, MenuTokens.Dur(MenuTokens.DurPanelOut), now, 0f);
            mainGroup.interactable = true;
            mainGroup.blocksRaycasts = true;
            mainFade.SetTarget(1f, MenuTokens.Dur(MenuTokens.DurPanelIn), now, MenuTokens.Dur(MenuTokens.DurPanelOut));
            RefreshEntries();

            MenuButton target = returnSelection;
            returnSelection = null;
            if (target == null || !target.gameObject.activeInHierarchy || !target.interactable)
            {
                target = DefaultEntry();
            }
            Select(target);
        }

        // Main list visible at once, no panel (every open starts here).
        private void ShowMainImmediate()
        {
            if (activePanel != null)
            {
                MenuPanel p = activePanel;
                activePanel = null;
                p.OnHide();
            }
            returnSelection = null;
            panelFade.Snap(0f);
            panelGroup.alpha = 0f;
            panelGroup.interactable = false;
            panelGroup.blocksRaycasts = false;
            panelBox.gameObject.SetActive(false);
            mainFade.Snap(1f);
            mainGroup.alpha = 1f;
            mainGroup.interactable = true;
            mainGroup.blocksRaycasts = true;
        }

        private void ShowControls()
        {
            SettingsPanel s = Settings;
            s.SelectTab(SettingsPanel.TabControls);
            ShowPanel(s);
        }

        private RectTransform GetPanelContent(MenuPanel panel)
        {
            if (panelRects.TryGetValue(panel, out RectTransform rt))
            {
                return rt;
            }
            var topLeft = new Vector2(0f, 1f);
            rt = HudFactory.CreateRect(panel.GetType().Name, contentHost, topLeft, topLeft, Vector2.zero,
                                       new Vector2(MenuTokens.ContentWidth, MenuTokens.ContentHeight));
            try
            {
                panel.Build(ctx, rt);
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                Destroy(rt.gameObject);
                return null;
            }
            panelRects.Add(panel, rt);
            foreach (KeyValuePair<MenuPanel, RectTransform> pair in panelRects)
            {
                pair.Value.gameObject.SetActive(pair.Key == panel);
            }
            return rt;
        }

        private void SetPanelContentActive(MenuPanel panel, bool active)
        {
            if (panelRects.TryGetValue(panel, out RectTransform rt) && rt)
            {
                rt.gameObject.SetActive(active);
            }
        }

        // ---------------------------------------------------------------- selection

        private MenuButton DefaultEntry()
        {
            return state == State.Pause ? entries[EResume] : entries[EStart];
        }

        private void Select(Selectable s)
        {
            EventSystem es = EventSystem.current;
            if (es == null || s == null || es.alreadySelecting)
            {
                return;
            }
            es.SetSelectedGameObject(s.gameObject);
            lastSelected = s.gameObject;
        }

        // A gamepad must always have focus: re-select the last control of the current view (or its default) whenever
        // the EventSystem lost its selection (e.g. a click on empty space).
        private void KeepSelection()
        {
            EventSystem es = EventSystem.current;
            if (es == null)
            {
                return;
            }
            GameObject sel = es.currentSelectedGameObject;
            if (sel != null && sel.activeInHierarchy)
            {
                if (!ReferenceEquals(sel, lastSelected) && InCurrentView(sel))
                {
                    lastSelected = sel;
                }
                return;
            }

            Selectable target = null;
            if (lastSelected != null && lastSelected.activeInHierarchy && InCurrentView(lastSelected))
            {
                Selectable s = lastSelected.GetComponent<Selectable>();
                if (s != null && s.IsInteractable())
                {
                    target = s;
                }
            }
            if (target == null)
            {
                if (activePanel != null)
                {
                    Selectable first = activePanel.DefaultSelection;
                    target = first != null ? first : backButton;
                }
                else
                {
                    target = DefaultEntry();
                }
            }
            Select(target);
        }

        private bool InCurrentView(GameObject go)
        {
            Transform view = activePanel != null ? panelBox : mainRect;
            return go.transform.IsChildOf(view);
        }

        // ---------------------------------------------------------------- boot intro

        private void BeginIntro()
        {
            introRunning = true;
            introT = 0f;
            overlay.enabled = true;
            backdrop.BeginIntro();
            logo.BeginIntro();
            ApplyIntro();
        }

        private void FinishIntro()
        {
            if (!introRunning)
            {
                return;
            }
            introT = float.MaxValue;
            backdrop.FinishIntro();
            logo.FinishIntro();
            ApplyIntro();
        }

        private void ApplyIntro()
        {
            bool reduced = MenuTokens.ReducedMotion;

            float fadeDur = MenuTokens.Dur(MenuTokens.DurIntroBackdrop);
            float fade = fadeDur > 0f ? Mathf.Clamp01(introT / fadeDur) : 1f;
            overlay.color = MenuTokens.Alpha(MenuTokens.Void, 1f - MenuTokens.EaseOut(fade));
            overlay.enabled = fade < 1f;

            float itemDur = MenuTokens.Dur(MenuTokens.DurIntroItem);
            bool itemsDone = true;
            for (int k = 0; k < visibleCount; k++)
            {
                int slot = visibleBuf[k];
                float start = MenuTokens.IntroItemsDelay + k * MenuTokens.StaggerItem;
                float t = itemDur > 0f ? Mathf.Clamp01((introT - start) / itemDur) : 1f;
                float e = MenuTokens.EaseOut(t);
                entryGroups[slot].alpha = e;
                float rise = reduced ? 0f : (1f - e) * MenuTokens.IntroItemRise;
                ((RectTransform)entries[slot].transform).anchoredPosition = entryPos[slot] - new Vector2(0f, rise);
                if (t < 1f)
                {
                    itemsDone = false;
                }
            }

            float footerStart = MenuTokens.IntroItemsDelay + visibleCount * MenuTokens.StaggerItem;
            float ft = itemDur > 0f ? Mathf.Clamp01((introT - footerStart) / itemDur) : 1f;
            footerGroup.alpha = MenuTokens.EaseOut(ft);

            if (fade >= 1f && itemsDone && ft >= 1f && !logo.IntroRunning && introT >= MenuTokens.Dur(MenuTokens.DurIntroPlanet))
            {
                introRunning = false;
            }
        }

        private static bool AnyPress()
        {
            Keyboard kb = Keyboard.current;
            if (kb != null && kb.anyKey.wasPressedThisFrame)
            {
                return true;
            }
            Mouse mouse = Mouse.current;
            if (mouse != null && (mouse.leftButton.wasPressedThisFrame || mouse.rightButton.wasPressedThisFrame
                                  || mouse.middleButton.wasPressedThisFrame))
            {
                return true;
            }
            Gamepad pad = Gamepad.current;
            return pad != null && (pad.buttonSouth.wasPressedThisFrame || pad.buttonEast.wasPressedThisFrame
                                   || pad.buttonNorth.wasPressedThisFrame || pad.buttonWest.wasPressedThisFrame
                                   || pad.startButton.wasPressedThisFrame || pad.selectButton.wasPressedThisFrame
                                   || pad.leftShoulder.wasPressedThisFrame || pad.rightShoulder.wasPressedThisFrame
                                   || pad.dpad.up.wasPressedThisFrame || pad.dpad.down.wasPressedThisFrame
                                   || pad.dpad.left.wasPressedThisFrame || pad.dpad.right.wasPressedThisFrame);
        }

        // Interruptible ease-out from the current value toward a target, with an optional start delay.
        private struct Fader
        {
            public float Value;
            private float from, to, start, duration;

            public bool Done => Value == to;

            public void Snap(float v)
            {
                Value = from = to = v;
                duration = 0f;
            }

            public void SetTarget(float target, float dur, float now, float delay)
            {
                from = Value;
                to = target;
                start = now + delay;
                duration = dur;
            }

            public float Evaluate(float now)
            {
                if (Value == to || now < start)
                {
                    return Value;
                }
                float t = duration > 0f ? (now - start) / duration : 1f;
                Value = t >= 1f ? to : Mathf.LerpUnclamped(from, to, MenuTokens.EaseOut(t));
                return Value;
            }
        }
    }
}

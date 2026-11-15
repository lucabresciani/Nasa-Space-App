using System;
using NasaSpaceApp.Science;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>Lifecycle state of a pooled rock card.</summary>
    public enum CardState { Hidden, Entering, Open, Closing }

    /// <summary>
    /// One pooled rock card view (spec §5.2): smoked-glass panel with ID, distance, close button, class line, composition
    /// rows, footers, countdown and timer bar. Built once; <see cref="Open"/>/<see cref="Refresh"/> fill it at scan time,
    /// <see cref="Tick"/> animates it allocation-free. Root carries a nested Canvas, GraphicRaycaster and CanvasGroup.
    /// </summary>
    public sealed class RockCard
    {
        private const float Pad = HudTokens.CardPad;                  // 16
        private const float RightEdge = HudTokens.CardWidth - Pad;   // 224
        private const float ContentWidth = RightEdge - Pad;          // 208
        private const float HeaderTop = 12f, HeaderHeight = 24f;
        private const float RowTop = 110f;
        private const float NoDataHeight = 162f;            // two 14 px lines of the empty message + footer gap
        private const float FocusFlashS = 0.2f;
        private const float DistanceIntervalS = 0.25f;               // 4 Hz distance label
        private const int MaxIdChars = 12;                           // keeps ID + distance clear of the key hint

        private static readonly Vector2 TopLeft = new Vector2(0f, 1f);
        private static readonly Vector2 TopRight = new Vector2(1f, 1f);

        private readonly HudContext ctx;
        private readonly Action<RockCard, CloseReason> onCloseRequested;
        private readonly CanvasGroup group;
        private readonly RectTransform body;
        private readonly HudPointerRelay relay;
        private readonly Image outline;
        private readonly bool hasOutline;
        private readonly Image keycap;
        private readonly Text keycapLetter;
        private readonly Text idText, distanceText, classText, sectionText, sectionRightText;
        private readonly Image divider2;
        private readonly Text[] rowLabels = new Text[RockCardData.MaxRows];
        private readonly Text[] rowValues = new Text[RockCardData.MaxRows];
        private readonly Text[] rowUnits = new Text[RockCardData.MaxRows];
        private readonly Image[] rowLines = new Image[RockCardData.MaxRows];
        private readonly Text footer1Text, footer2Text, countdownText, emptyText;
        private readonly Image timerBar;
        private readonly RectTransform timerRect;

        private float timeout = 1f;
        private float stateTime;
        private float animAlpha;
        private float dim = 1f;
        private float shownGroupAlpha = -1f;
        private float closeStartAlpha, closeStartDraw;
        private bool keyClose;
        private bool focused, keyHint, outlineShown, keycapShown;
        private bool timerPausedShown;
        private float timerScaleShown = -1f;
        private bool countdownShown;
        private int countdownValue = -1;
        private float flashStart = -1f;
        private Vector2 displayPos, velocity;
        private float nextDistanceAt;
        private float bodyScaleShown = -1f;

        /// <summary>Builds the card hierarchy under <c>ctx.CardLayer</c>, inactive (Hidden).</summary>
        public RockCard(HudContext ctx, int index, Action<RockCard, CloseReason> onCloseRequested)
        {
            this.ctx = ctx;
            this.onCloseRequested = onCloseRequested;
            Index = index;
            Data = new RockCardData();
            Size = new Vector2(HudTokens.CardWidth, NoDataHeight);

            HudSkin skin = ctx.Skin;
            Font regular = skin != null ? skin.Regular : null;
            Font medium = skin != null ? skin.Medium : null;

            // Root: anchor (0,0), pivot top-left, so anchoredPosition = canvas position of the card's top-left corner.
            Root = HudFactory.CreateRect("RockCard" + index, ctx.CardLayer, Vector2.zero, TopLeft, Vector2.zero, Size);
            HudFactory.AddNestedCanvas(Root.gameObject, true);
            group = HudFactory.AddGroup(Root.gameObject, 0f, true);

            // Body: full stretch; its pivot is moved to the landing point so the enter scale grows from the leader.
            body = HudFactory.CreateStretch("Body", Root);
            relay = body.gameObject.AddComponent<HudPointerRelay>();
            relay.Index = index;
            relay.Clicked += OnBodyClicked;

            Image background = HudFactory.CreatePanel("Background", body, skin, HudTokens.Scrim, HudTokens.RadiusCard,
                                                      TopLeft, TopLeft, Vector2.zero, Size);
            Stretch(background.rectTransform);
            background.raycastTarget = true;   // hover pause, click = focus (relay on Body)

            outline = HudFactory.CreateOutline("FocusRing", body, skin, HudTokens.AccentRing, HudTokens.RadiusCard,
                                               TopLeft, TopLeft, Vector2.zero, Size);
            Stretch(outline.rectTransform);
            hasOutline = outline.sprite != null;
            outline.enabled = false;

            // Header: ID, distance, key hint, close button.
            idText = HudFactory.CreateText("Id", body, medium, HudTokens.SizeLabel, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                           TopLeft, TopLeft, new Vector2(Pad, -HeaderTop), new Vector2(150f, HeaderHeight));
            distanceText = HudFactory.CreateText("Distance", body, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                                 TopLeft, TopLeft, new Vector2(Pad, -HeaderTop), new Vector2(80f, HeaderHeight));
            keycap = HudFactory.CreateKeycap("KeyHint", body, skin, medium, "X", TopLeft, TopLeft, new Vector2(178f, -13f));
            keycapLetter = keycap.GetComponentInChildren<Text>(true);
            keycap.enabled = false;
            if (keycapLetter != null)
            {
                keycapLetter.enabled = false;
            }
            Button close = HudFactory.CreateCloseButton("Close", body, skin, regular, TopLeft, TopLeft, new Vector2(200f, -6f));
            close.onClick.AddListener(OnCloseClicked);

            // Class line (2 wrapped lines max).
            classText = HudFactory.CreateWrappedText("Class", body, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.UpperLeft,
                                                     TopLeft, TopLeft, new Vector2(Pad, -40f), new Vector2(ContentWidth, 38f));

            // Section header and divider.
            sectionText = HudFactory.CreateText("Section", body, medium, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                                TopLeft, TopLeft, new Vector2(Pad, -82f), new Vector2(120f, 18f));
            sectionRightText = HudFactory.CreateText("SectionRight", body, regular, HudTokens.SizeFoot, HudTokens.InkTertiary, TextAnchor.MiddleRight,
                                                     TopLeft, TopRight, new Vector2(RightEdge, -82f), new Vector2(120f, 18f));
            HudFactory.CreateImage("Divider", body, null, HudTokens.StrokeHair, TopLeft, TopLeft, new Vector2(Pad, -104f),
                                   new Vector2(ContentWidth, HudTokens.Hairline));

            // Pooled rows.
            for (int i = 0; i < RockCardData.MaxRows; i++)
            {
                float y = RowTop + HudTokens.CardRowPitch * i;
                rowLabels[i] = HudFactory.CreateText("RowLabel" + i, body, medium, HudTokens.SizeLabel, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                                     TopLeft, TopLeft, new Vector2(Pad, -y), new Vector2(100f, HudTokens.CardRowPitch));
                rowValues[i] = HudFactory.CreateText("RowValue" + i, body, regular, HudTokens.SizeValue, HudTokens.InkPrimary, TextAnchor.MiddleRight,
                                                     TopLeft, TopRight, new Vector2(206f, -y), new Vector2(80f, HudTokens.CardRowPitch));
                rowUnits[i] = HudFactory.CreateText("RowUnit" + i, body, medium, HudTokens.SizeLabel, HudTokens.InkSecondary, TextAnchor.MiddleRight,
                                                    TopLeft, TopRight, new Vector2(RightEdge, -y), new Vector2(16f, HudTokens.CardRowPitch));
                rowUnits[i].text = "%";
                rowLines[i] = HudFactory.CreateImage("RowLine" + i, body, null, HudTokens.StrokeHair, TopLeft, TopLeft,
                                                     new Vector2(152f, -(y + 21f)), new Vector2(RightEdge - 152f, HudTokens.Hairline));
            }

            // Bottom block (moved per row count on Open).
            divider2 = HudFactory.CreateImage("Divider2", body, null, HudTokens.StrokeHair, TopLeft, TopLeft, Vector2.zero,
                                              new Vector2(ContentWidth, HudTokens.Hairline));
            footer1Text = HudFactory.CreateText("Footer1", body, regular, HudTokens.SizeFoot, HudTokens.InkTertiary, TextAnchor.MiddleLeft,
                                                TopLeft, TopLeft, Vector2.zero, new Vector2(ContentWidth, 18f));
            footer2Text = HudFactory.CreateText("Footer2", body, regular, HudTokens.SizeFoot, HudTokens.InkTertiary, TextAnchor.MiddleLeft,
                                                TopLeft, TopLeft, Vector2.zero, new Vector2(170f, 18f));
            countdownText = HudFactory.CreateText("Countdown", body, regular, HudTokens.SizeFoot, HudTokens.InkTertiary, TextAnchor.MiddleRight,
                                                  TopLeft, TopRight, Vector2.zero, new Vector2(40f, 18f));
            countdownText.enabled = false;
            emptyText = HudFactory.CreateWrappedText("Empty", body, regular, HudTokens.SizeMicro, HudTokens.InkSecondary, TextAnchor.UpperLeft,
                                                     TopLeft, TopLeft, new Vector2(Pad, -RowTop), new Vector2(ContentWidth, 40f));

            timerBar = HudFactory.CreateImage("Timer", body, null, HudTokens.TimerBar, TopLeft, new Vector2(0f, 0.5f), Vector2.zero,
                                              new Vector2(ContentWidth, 2f));
            timerRect = timerBar.rectTransform;

            State = CardState.Hidden;
            Root.gameObject.SetActive(false);
        }

        public int Index { get; }
        public RockSample Rock { get; private set; }
        public RockCardData Data { get; }
        public RectTransform Root { get; }
        public Vector2 Size { get; private set; }
        public CardState State { get; private set; }

        /// <summary>Pointer over the card (background or close button) while it is Entering or Open.</summary>
        public bool Hovered => IsLive && relay != null && relay.Hovered;

        /// <summary>Seconds left before the timeout close (unscaled).</summary>
        public float Remaining { get; private set; }

        /// <summary>Unscaled time of the last spawn, refresh or click; the most recent one is focused.</summary>
        public float LastActivated { get; private set; }

        public Rect TargetRect { get; private set; }
        public Rect DisplayRect => new Rect(displayPos.x, displayPos.y - Size.y, Size.x, Size.y);
        public int Side { get; private set; }   // -1 left of anchor, +1 right, 0 above/below

        /// <summary>Scan point in rock-local space.</summary>
        public Vector3 AnchorLocal { get; private set; }

        /// <summary>Displayed ID (truncated FieldId), also used by the edge locator.</summary>
        public string IdText { get; private set; }

        /// <summary>Current cached distance string (updated at 4 Hz).</summary>
        public string DistanceText { get; private set; }

        /// <summary>Visual alpha of the card (enter/exit fade times sprint dim); the leader uses the same value.</summary>
        public float Alpha { get; private set; }

        /// <summary>Leader reveal 0..1 (grows after the enter delay, retracts on close).</summary>
        public float LeaderDraw { get; private set; }

        private bool IsLive => State == CardState.Entering || State == CardState.Open;

        /// <summary>Fills the card from a scan, sizes it and starts the enter animation.</summary>
        public void Open(RockScanResult r, float timeout)
        {
            Rock = r.Rock;
            AnchorLocal = Rock != null ? Rock.transform.InverseTransformPoint(r.Point) : r.Point;
            Data.Fill(r);
            ApplyData();

            this.timeout = Mathf.Max(0.01f, timeout);
            Remaining = this.timeout;
            LastActivated = Time.unscaledTime;
            State = CardState.Entering;
            stateTime = 0f;
            animAlpha = 0f;
            dim = 1f;
            keyClose = false;
            flashStart = -1f;
            velocity = Vector2.zero;
            LeaderDraw = HudTokens.ReducedMotion ? 1f : 0f;
            Alpha = 0f;

            DistanceText = HudStrings.Distance(r.DistanceM);
            distanceText.text = DistanceText;
            nextDistanceAt = Time.unscaledTime + DistanceIntervalS;

            countdownValue = -1;
            timerScaleShown = -1f;
            UpdateTimerVisuals(false, true);

            group.alpha = 0f;
            shownGroupAlpha = 0f;
            group.blocksRaycasts = true;
            group.interactable = true;
            SetBodyScale(HudTokens.ReducedMotion ? 1f : HudTokens.CardEnterScale);
            Root.gameObject.SetActive(true);
        }

        /// <summary>Rescan of the open rock: refill, timer full, focus flash. Keeps the placement (top edge).</summary>
        public void Refresh(RockScanResult r, float timeout)
        {
            if (!IsLive)
            {
                return;
            }
            float oldHeight = Size.y;
            Data.Fill(r);
            ApplyData();
            if (Size.y != oldHeight)
            {
                Rect t = TargetRect;
                TargetRect = new Rect(t.xMin, t.yMax - Size.y, Size.x, Size.y);
            }
            this.timeout = Mathf.Max(0.01f, timeout);
            Remaining = this.timeout;
            LastActivated = Time.unscaledTime;
            flashStart = Time.unscaledTime;
            timerScaleShown = -1f;
            UpdateTimerVisuals(timerPausedShown, true);
        }

        /// <summary>Focus ring and key hint (the hint only on the focused card while the cursor is locked).</summary>
        public void SetFocused(bool focused, bool showKeyHint)
        {
            this.focused = focused;
            keyHint = showKeyHint;
            bool showKeycap = focused && showKeyHint && IsLive;
            if (showKeycap != keycapShown)
            {
                keycapShown = showKeycap;
                keycap.enabled = showKeycap;
                if (keycapLetter != null)
                {
                    keycapLetter.enabled = showKeycap;
                }
            }
            if (flashStart < 0f)
            {
                SetOutline(focused && IsLive);
            }
        }

        /// <summary>Solver result; <paramref name="snap"/> places the card immediately (open), else it glides.</summary>
        public void SetTarget(Rect rect, int side, bool snap)
        {
            TargetRect = rect;
            Side = side;
            if (snap || HudTokens.ReducedMotion)
            {
                displayPos = new Vector2(rect.xMin, rect.yMax);
                velocity = Vector2.zero;
                ApplyPosition();
            }
        }

        /// <summary>Moves the enter-scale origin to <paramref name="canvasPoint"/> (the leader landing point).</summary>
        public void SetEnterOrigin(Vector2 canvasPoint)
        {
            Rect t = TargetRect;
            float px = t.width > 0f ? Mathf.Clamp01((canvasPoint.x - t.xMin) / t.width) : 0.5f;
            float py = t.height > 0f ? Mathf.Clamp01((canvasPoint.y - t.yMin) / t.height) : 0.5f;
            body.pivot = new Vector2(px, py);
        }

        /// <summary>Starts the exit fade (faster for key closes); the card turns Hidden when it ends.</summary>
        public void BeginClose(CloseReason reason)
        {
            if (!IsLive)
            {
                return;
            }
            keyClose = reason == CloseReason.Key;
            closeStartAlpha = animAlpha;
            closeStartDraw = LeaderDraw;
            State = CardState.Closing;
            stateTime = 0f;
            group.blocksRaycasts = false;
            group.interactable = false;
            flashStart = -1f;
            SetOutline(false);
            SetFocused(false, keyHint);
        }

        /// <summary>Ends any animation and deactivates the card (pool reuse).</summary>
        public void HideNow()
        {
            if (State == CardState.Hidden)
            {
                return;
            }
            State = CardState.Hidden;
            Rock = null;
            Alpha = 0f;
            LeaderDraw = 0f;
            animAlpha = 0f;
            flashStart = -1f;
            SetOutline(false);
            group.blocksRaycasts = false;
            Root.gameObject.SetActive(false);
        }

        /// <summary>4 Hz distance label from the camera-to-anchor distance in meters.</summary>
        public void SetDistance(float meters)
        {
            float now = Time.unscaledTime;
            if (now < nextDistanceAt)
            {
                return;
            }
            nextDistanceAt = now + DistanceIntervalS;
            string s = HudStrings.Distance(meters);
            if (!ReferenceEquals(s, DistanceText))
            {
                DistanceText = s;
                distanceText.text = s;
            }
        }

        /// <summary>Animation, sprint dim, timer (at 0 requests a Timeout close), focus flash and glide to the target.</summary>
        public void Tick(float dt, bool timerPaused, bool dimmed)
        {
            if (State == CardState.Hidden)
            {
                return;
            }
            bool reduced = HudTokens.ReducedMotion;
            stateTime += dt;

            float dimTarget = dimmed ? HudTokens.SprintDimAlpha : 1f;
            if (dim != dimTarget)
            {
                float rate = (1f - HudTokens.SprintDimAlpha) / Mathf.Max(1e-3f, HudTokens.Dur(HudTokens.DurDim));
                dim = Mathf.MoveTowards(dim, dimTarget, rate * dt);
            }

            if (State == CardState.Entering)
            {
                float enterDur = HudTokens.Dur(HudTokens.DurCardEnter);
                float t = Mathf.Clamp01(stateTime / enterDur);
                animAlpha = HudTokens.EaseOut(t);
                if (reduced)
                {
                    SetBodyScale(1f);
                    LeaderDraw = 1f;
                }
                else
                {
                    SetBodyScale(Mathf.LerpUnclamped(HudTokens.CardEnterScale, 1f, HudTokens.EaseOut(t)));
                    LeaderDraw = HudTokens.EaseOutCubic((stateTime - HudTokens.DelayLeaderDraw) / HudTokens.DurLeaderDraw);
                }
                float enterEnd = reduced ? enterDur : Mathf.Max(enterDur, HudTokens.DelayLeaderDraw + HudTokens.DurLeaderDraw);
                if (stateTime >= enterEnd)
                {
                    State = CardState.Open;
                    animAlpha = 1f;
                    LeaderDraw = 1f;
                    SetBodyScale(1f);
                }
            }
            else if (State == CardState.Closing)
            {
                float exitDur = HudTokens.Dur(keyClose ? HudTokens.DurCardExitKey : HudTokens.DurCardExit);
                animAlpha = closeStartAlpha * (1f - HudTokens.EaseOutCubic(stateTime / exitDur));
                if (!reduced)
                {
                    LeaderDraw = closeStartDraw * (1f - HudTokens.EaseOutCubic(stateTime / HudTokens.DurLeaderRetract));
                }
                float exitEnd = reduced ? exitDur : Mathf.Max(exitDur, HudTokens.DurLeaderRetract);
                if (stateTime >= exitEnd)
                {
                    HideNow();
                    return;
                }
            }

            Alpha = animAlpha * dim;
            if (Alpha != shownGroupAlpha)
            {
                shownGroupAlpha = Alpha;
                group.alpha = Alpha;
            }

            TickFlash();
            TickPosition(dt, reduced);

            if (IsLive)
            {
                if (!timerPaused)
                {
                    Remaining = Mathf.Max(0f, Remaining - dt);
                }
                UpdateTimerVisuals(timerPaused, false);
                if (Remaining <= 0f)
                {
                    onCloseRequested?.Invoke(this, CloseReason.Timeout);
                }
            }
        }

        // ---- internals

        private void ApplyData()
        {
            RockCardData d = Data;
            IdText = HudStrings.Truncate(d.FieldId, MaxIdChars);
            idText.text = IdText;
            float distX = Pad + HudTokens.Advance(HudTokens.SizeLabel) * IdText.Length + HudTokens.S2;
            distanceText.rectTransform.anchoredPosition = new Vector2(distX, -HeaderTop);
            classText.text = d.ClassLine;

            bool has = d.HasData;
            int rows = has ? d.RowCount : 0;
            sectionText.enabled = has;
            sectionRightText.enabled = has;
            sectionText.text = d.SectionLabel;
            sectionRightText.text = d.SectionRight;
            for (int i = 0; i < RockCardData.MaxRows; i++)
            {
                bool on = i < rows;
                rowLabels[i].enabled = on;
                rowValues[i].enabled = on;
                rowUnits[i].enabled = on;
                rowLines[i].enabled = on;
                rowLabels[i].text = on ? d.RowLabel[i] : null;
                rowValues[i].text = on ? d.RowValue[i] : null;
            }

            float height;
            if (has)
            {
                float yR = RowTop + HudTokens.CardRowPitch * rows + 6f;
                divider2.rectTransform.anchoredPosition = new Vector2(Pad, -yR);
                footer1Text.rectTransform.anchoredPosition = new Vector2(Pad, -(yR + 9f));     // 18 px line pitch at 14 px
                footer2Text.rectTransform.anchoredPosition = new Vector2(Pad, -(yR + 27f));
                countdownText.rectTransform.anchoredPosition = new Vector2(RightEdge, -(yR + 27f));
                footer1Text.text = d.Footer1;
                footer2Text.text = d.Footer2;
                height = yR + 8f + 32f + 14f;
            }
            else
            {
                height = NoDataHeight;
            }
            divider2.enabled = has;
            footer1Text.enabled = has;
            footer2Text.enabled = has;
            emptyText.enabled = !has;
            emptyText.text = has ? null : d.EmptyMessage;
            countdownShown = false;
            countdownText.enabled = false;

            Size = new Vector2(HudTokens.CardWidth, height);
            Root.sizeDelta = Size;
            timerRect.anchoredPosition = new Vector2(Pad, -(height - 3f));
        }

        private void UpdateTimerVisuals(bool paused, bool force)
        {
            float scale = Mathf.Clamp01(Remaining / timeout);
            if (force || scale != timerScaleShown)
            {
                timerScaleShown = scale;
                timerRect.localScale = new Vector3(scale, 1f, 1f);
            }
            if (force || paused != timerPausedShown)
            {
                timerPausedShown = paused;
                timerBar.color = paused ? HudTokens.TimerBarPaused : HudTokens.TimerBar;
            }

            bool show = Data.HasData && Remaining <= HudTokens.CountdownVisibleBelow;
            if (show)
            {
                int secs = Mathf.CeilToInt(Remaining);
                if (secs != countdownValue)
                {
                    countdownValue = secs;
                    countdownText.text = HudStrings.Seconds(secs);
                }
            }
            if (show != countdownShown)
            {
                countdownShown = show;
                countdownText.enabled = show;
            }
        }

        // Rescan flash: outline from full Accent to AccentRing over 200 ms.
        private void TickFlash()
        {
            if (flashStart < 0f || !hasOutline)
            {
                return;
            }
            float t = (Time.unscaledTime - flashStart) / HudTokens.Dur(FocusFlashS);
            if (t >= 1f)
            {
                flashStart = -1f;
                outline.color = HudTokens.AccentRing;
                SetOutline(focused && IsLive);
                return;
            }
            outline.color = Color.LerpUnclamped(HudTokens.Accent, HudTokens.AccentRing, HudTokens.EaseOut(t));
            SetOutline(true);
        }

        private void TickPosition(float dt, bool reduced)
        {
            Vector2 target = new Vector2(TargetRect.xMin, TargetRect.yMax);
            if (displayPos == target)
            {
                return;
            }
            if (reduced)
            {
                displayPos = target;
                velocity = Vector2.zero;
            }
            else
            {
                displayPos = Vector2.SmoothDamp(displayPos, target, ref velocity, HudTokens.RelayoutSmoothTime, Mathf.Infinity, dt);
                if ((displayPos - target).sqrMagnitude < 0.0025f)
                {
                    displayPos = target;
                    velocity = Vector2.zero;
                }
            }
            ApplyPosition();
        }

        private void ApplyPosition()
        {
            if (Root.anchoredPosition != displayPos)
            {
                Root.anchoredPosition = displayPos;
            }
        }

        private void SetOutline(bool on)
        {
            on &= hasOutline;
            if (on != outlineShown)
            {
                outlineShown = on;
                outline.enabled = on;
            }
        }

        private void SetBodyScale(float s)
        {
            if (s != bodyScaleShown)
            {
                bodyScaleShown = s;
                body.localScale = new Vector3(s, s, 1f);
            }
        }

        private void OnBodyClicked(HudPointerRelay source)
        {
            if (IsLive)
            {
                LastActivated = Time.unscaledTime;
            }
        }

        private void OnCloseClicked()
        {
            if (IsLive)
            {
                onCloseRequested?.Invoke(this, CloseReason.Button);
            }
        }

        private static void Stretch(RectTransform rt)
        {
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.pivot = new Vector2(0.5f, 0.5f);
            rt.offsetMin = Vector2.zero;
            rt.offsetMax = Vector2.zero;
        }
    }
}

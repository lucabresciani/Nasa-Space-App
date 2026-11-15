using System;
using NasaSpaceApp.Science;
using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>Why a rock card closed.</summary>
    public enum CloseReason { Button, Key, Timeout, Evicted, Far, Lost }

    /// <summary>
    /// Rock card manager (spec §5.3-§5.5): opens a card per scan (refreshes on rescan, evicts the oldest beyond
    /// <see cref="HudTokens.CardMax"/>), projects anchors, drives leaders and edge locators, focus, timers and the
    /// sticky re-layout. Pools are built once; <see cref="Tick"/> is allocation-free.
    /// </summary>
    public sealed class RockCardSystem : IDisposable
    {
        // One spare pooled card so an evicted card can fade out while the new one enters.
        private const int PoolSize = CardLayoutSolver.MaxCards;
        private const float OnScreenInset = 24f;
        private const float LocatorInset = 40f;
        private const float SideDeadZone = 40f;
        private const float CheckInterval = 0.25f;    // 4 Hz re-layout check
        private const float MinMoveInterval = 1f;     // per card, except T1
        private const float CrossDwell = 0.5f;        // T4
        private const float LongLeader = 560f;        // T3
        private const float AnchorInflate = 16f;      // T1
        private const float AcceptRatio = 0.75f;

        private readonly HudContext ctx;
        private readonly RockScanner scanner;
        private readonly CardLayoutSolver solver = new CardLayoutSolver();
        private readonly RockCard[] cards = new RockCard[PoolSize];
        private readonly CardLeader[] leaders = new CardLeader[PoolSize];
        private readonly Vector3[] anchorWorld = new Vector3[PoolSize];
        private readonly Vector2[] layoutAnchor = new Vector2[PoolSize];
        private readonly bool[] onScreen = new bool[PoolSize];
        private readonly float[] lastMove = new float[PoolSize];
        private readonly float[] crossSince = new float[PoolSize];
        private readonly Action<RockScanResult> scannedHandler;
        private int focusedIndex = -1;
        private float nextCheck;
        private bool disposed;

        /// <summary>Builds the card and leader pools and subscribes to <c>ctx.Scanner.Scanned</c>.</summary>
        public RockCardSystem(HudContext ctx)
        {
            this.ctx = ctx;
            scanner = ctx.Scanner;
            Action<RockCard, CloseReason> closeHandler = OnCloseRequested;
            for (int i = 0; i < PoolSize; i++)
            {
                cards[i] = new RockCard(ctx, i, closeHandler);
                leaders[i] = new CardLeader(ctx, i);
                crossSince[i] = -1f;
            }
            scannedHandler = OnScanned;
            if (scanner != null)
            {
                scanner.Scanned += scannedHandler;
            }
        }

        /// <summary>Cards in Entering or Open state.</summary>
        public int CardCount
        {
            get
            {
                int n = 0;
                for (int i = 0; i < PoolSize; i++)
                {
                    if (IsLive(cards[i]))
                    {
                        n++;
                    }
                }
                return n;
            }
        }

        /// <summary>The i-th live card (i in [0, CardCount)): world anchor and focus, for the compass pips.</summary>
        public bool TryGetCard(int i, out Vector3 anchorWorld, out bool focused)
        {
            int k = 0;
            for (int j = 0; j < PoolSize; j++)
            {
                if (!IsLive(cards[j]))
                {
                    continue;
                }
                if (k == i)
                {
                    anchorWorld = this.anchorWorld[j];
                    focused = j == focusedIndex;
                    return true;
                }
                k++;
            }
            anchorWorld = default;
            focused = false;
            return false;
        }

        /// <summary>True when a card for <paramref name="rock"/> is Entering or Open.</summary>
        public bool HasOpenCard(RockSample rock)
        {
            return rock != null && FindLive(rock) >= 0;
        }

        /// <summary>Closes the focused card (X key / gamepad East).</summary>
        public void CloseFocused(CloseReason reason)
        {
            if (focusedIndex >= 0 && IsLive(cards[focusedIndex]))
            {
                OnCloseRequested(cards[focusedIndex], reason);
            }
        }

        /// <summary>Per-frame update (unscaled dt). Skipped while there is no camera (keeps the last state).</summary>
        public void Tick(float dt)
        {
            if (disposed)
            {
                return;
            }
            Camera cam = ctx.Camera;
            if (cam == null)
            {
                return;
            }
            float now = Time.unscaledTime;
            solver.BeginFrame(ctx);
            RockSample looked = scanner != null ? scanner.Target : null;
            bool sprinting = ctx.Player != null && ctx.Player.IsSprinting;
            bool keyHint = !ctx.CursorFree;
            UpdateFocus();

            for (int i = 0; i < PoolSize; i++)
            {
                RockCard card = cards[i];
                if (card.State == CardState.Hidden)
                {
                    leaders[i].Hide();
                    solver.SetCard(i, false, default, default, default, default);
                    continue;
                }

                // Anchor follows the rock; a destroyed or inactive rock closes the card (keeps the last anchor).
                RockSample rock = card.Rock;
                if (rock == null || !rock.gameObject.activeInHierarchy)
                {
                    OnCloseRequested(card, CloseReason.Lost);
                }
                else
                {
                    anchorWorld[i] = rock.transform.TransformPoint(card.AnchorLocal);
                }

                float distance = Vector3.Distance(ctx.CameraPosition, anchorWorld[i]);
                if (distance > HudTokens.CardMaxDistance)
                {
                    OnCloseRequested(card, CloseReason.Far);
                }

                bool on = Project(cam, anchorWorld[i], out Vector2 anchor, out float angle);
                onScreen[i] = on;
                layoutAnchor[i] = anchor;

                bool focused = i == focusedIndex;
                card.SetDistance(distance);
                card.SetFocused(focused, keyHint);
                bool paused = card.Hovered || (looked != null && looked == rock);
                card.Tick(dt, paused, sprinting);

                if (card.State == CardState.Hidden)
                {
                    leaders[i].Hide();
                    solver.SetCard(i, false, default, default, default, default);
                    continue;
                }

                // Leaders follow the displayed rect; the solver records the leader of the target rect.
                focused = i == focusedIndex && IsLive(card);
                CardLayoutSolver.Slot shown = CardLayoutSolver.Leader(anchor, card.DisplayRect);
                if (on)
                {
                    leaders[i].SetOnScreen(anchor, shown.Elbow, shown.Landing, focused, card.LeaderDraw, card.Alpha);
                }
                else
                {
                    leaders[i].SetOffScreen(anchor, angle, shown.Elbow, shown.Landing, card.IdText, card.DistanceText,
                                            focused, card.LeaderDraw, card.Alpha);
                }
                CardLayoutSolver.Slot target = CardLayoutSolver.Leader(anchor, card.TargetRect);
                solver.SetCard(i, IsLive(card), card.TargetRect, anchor, target.Elbow, target.Landing);
            }

            Relayout(now);
        }

        /// <summary>Unsubscribes from the scanner. The pooled GameObjects die with the HUD hierarchy.</summary>
        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            if (scanner != null)
            {
                scanner.Scanned -= scannedHandler;
            }
        }

        // ---- scan, close, focus

        private void OnScanned(RockScanResult r)
        {
            if (disposed || r == null || r.Rock == null)
            {
                return;
            }
            float timeout = RockCardData.HasReading(r.Reading) ? HudTokens.CardTimeout : HudTokens.CardTimeoutNoData;

            // Rescan of an open rock: refresh in place, no relayout.
            int existing = FindLive(r.Rock);
            if (existing >= 0)
            {
                cards[existing].Refresh(r, timeout);
                UpdateFocus();
                return;
            }

            // Full: evict the least recently activated card that is not hovered (its slot frees immediately).
            if (CardCount >= HudTokens.CardMax)
            {
                int victim = OldestLive(true);
                if (victim < 0)
                {
                    victim = OldestLive(false);
                }
                if (victim >= 0)
                {
                    OnCloseRequested(cards[victim], CloseReason.Evicted);
                }
            }

            RockCard card = TakeFreeCard();
            if (card == null)
            {
                return;
            }
            int i = card.Index;
            card.Open(r, timeout);

            anchorWorld[i] = r.Point;
            Vector2 anchor;
            bool on = true;
            Camera cam = ctx.Camera;
            if (cam != null)
            {
                on = Project(cam, anchorWorld[i], out anchor, out _);
            }
            else
            {
                anchor = ctx.CanvasSize * 0.5f;
            }
            onScreen[i] = on;
            layoutAnchor[i] = anchor;

            solver.BeginFrame(ctx);
            CardLayoutSolver.Slot slot = solver.Solve(i, anchor, card.Size, PreferredSide(anchor, i));
            card.SetTarget(slot.Rect, slot.Side, true);
            card.SetEnterOrigin(slot.Landing);
            solver.SetCard(i, true, slot.Rect, anchor, slot.Elbow, slot.Landing);
            lastMove[i] = Time.unscaledTime;
            crossSince[i] = -1f;
            card.Root.SetAsLastSibling();
            UpdateFocus();
        }

        private void OnCloseRequested(RockCard card, CloseReason reason)
        {
            if (card == null || !IsLive(card))
            {
                return;
            }
            card.BeginClose(reason);
            solver.SetCard(card.Index, false, default, default, default, default);
            if (card.Index == focusedIndex)
            {
                UpdateFocus();
            }
        }

        // Hovered card if any, else the most recently activated live card.
        private void UpdateFocus()
        {
            int best = -1;
            for (int i = 0; i < PoolSize; i++)
            {
                if (IsLive(cards[i]) && cards[i].Hovered)
                {
                    best = i;
                    break;
                }
            }
            if (best < 0)
            {
                float latest = float.NegativeInfinity;
                for (int i = 0; i < PoolSize; i++)
                {
                    RockCard c = cards[i];
                    if (IsLive(c) && c.LastActivated > latest)
                    {
                        latest = c.LastActivated;
                        best = i;
                    }
                }
            }
            focusedIndex = best;
        }

        private RockCard TakeFreeCard()
        {
            for (int i = 0; i < PoolSize; i++)
            {
                if (cards[i].State == CardState.Hidden)
                {
                    return cards[i];
                }
            }
            // No hidden card: cut short a closing one.
            for (int i = 0; i < PoolSize; i++)
            {
                if (cards[i].State == CardState.Closing)
                {
                    cards[i].HideNow();
                    leaders[i].Hide();
                    return cards[i];
                }
            }
            return null;
        }

        private int OldestLive(bool skipHovered)
        {
            int victim = -1;
            float oldest = float.PositiveInfinity;
            for (int i = 0; i < PoolSize; i++)
            {
                RockCard c = cards[i];
                if (!IsLive(c) || (skipHovered && c.Hovered))
                {
                    continue;
                }
                if (c.LastActivated < oldest)
                {
                    oldest = c.LastActivated;
                    victim = i;
                }
            }
            return victim;
        }

        private int FindLive(RockSample rock)
        {
            for (int i = 0; i < PoolSize; i++)
            {
                RockCard c = cards[i];
                if (IsLive(c) && c.Rock == rock)
                {
                    return i;
                }
            }
            return -1;
        }

        private static bool IsLive(RockCard c)
        {
            return c.State == CardState.Entering || c.State == CardState.Open;
        }

        // ---- projection and placement

        // Canvas position of a world point. On screen iff in front of the camera and inside the canvas inset 24.
        // Otherwise returns the edge locator (canvas inset 40) and the direction angle toward the point.
        private bool Project(Camera cam, Vector3 world, out Vector2 canvasPos, out float angleDeg)
        {
            Vector2 size = ctx.CanvasSize;
            Vector2 center = size * 0.5f;
            Vector3 sp = cam.WorldToScreenPoint(world);
            Vector2 p = ctx.ScreenToCanvas(sp);
            if (sp.z > 0f && p.x >= OnScreenInset && p.x <= size.x - OnScreenInset &&
                p.y >= OnScreenInset && p.y <= size.y - OnScreenInset)
            {
                canvasPos = p;
                angleDeg = 0f;
                return true;
            }

            Vector2 v = p - center;
            if (sp.z < 0f)
            {
                v = -v;
            }
            if (v.sqrMagnitude < 1f)
            {
                v = new Vector2(0f, -1f);
            }
            float hx = Mathf.Max(0f, center.x - LocatorInset);
            float hy = Mathf.Max(0f, center.y - LocatorInset);
            float t = float.MaxValue;
            if (Mathf.Abs(v.x) > 1e-5f)
            {
                t = hx / Mathf.Abs(v.x);
            }
            if (Mathf.Abs(v.y) > 1e-5f)
            {
                t = Mathf.Min(t, hy / Mathf.Abs(v.y));
            }
            canvasPos = center + v * t;
            angleDeg = Mathf.Atan2(v.y, v.x) * Mathf.Rad2Deg;
            return false;
        }

        // Outward from the center; near the center, the side with fewer cards (tie: left, as in the mockup).
        private int PreferredSide(Vector2 anchor, int exclude)
        {
            float cx = ctx.CanvasSize.x * 0.5f;
            if (anchor.x < cx - SideDeadZone)
            {
                return -1;
            }
            if (anchor.x > cx + SideDeadZone)
            {
                return 1;
            }
            int left = 0, right = 0;
            for (int i = 0; i < PoolSize; i++)
            {
                if (i == exclude || !IsLive(cards[i]))
                {
                    continue;
                }
                if (cards[i].TargetRect.center.x < cx)
                {
                    left++;
                }
                else
                {
                    right++;
                }
            }
            return right < left ? 1 : -1;
        }

        // Sticky re-layout: T1 every frame (ignores the per-card dwell), T2-T4 at 4 Hz; at most one move per check,
        // worst card first; a new slot is accepted only when it is clearly better.
        private void Relayout(float now)
        {
            bool periodic = now >= nextCheck;
            if (periodic)
            {
                nextCheck = now + CheckInterval;
            }

            int worst = -1;
            float worstScore = float.NegativeInfinity;
            CardLayoutSolver.Slot worstCurrent = default;

            for (int i = 0; i < PoolSize; i++)
            {
                RockCard card = cards[i];
                if (!IsLive(card))
                {
                    crossSince[i] = -1f;
                    continue;
                }
                Rect rect = card.TargetRect;
                Vector2 anchor = layoutAnchor[i];

                if (periodic)
                {
                    if (onScreen[i] && solver.LeaderCrosses(i))
                    {
                        if (crossSince[i] < 0f)
                        {
                            crossSince[i] = now;
                        }
                    }
                    else
                    {
                        crossSince[i] = -1f;
                    }
                }
                if (card.Hovered)
                {
                    continue;
                }

                Rect near = new Rect(rect.x - AnchorInflate, rect.y - AnchorInflate,
                                     rect.width + 2f * AnchorInflate, rect.height + 2f * AnchorInflate);
                bool t1 = near.Contains(anchor);
                if (!t1 && (!periodic || now - lastMove[i] < MinMoveInterval))
                {
                    continue;
                }

                CardLayoutSolver.Slot current = solver.Evaluate(i, anchor, rect);
                float score;
                if (t1)
                {
                    score = 1e9f;
                }
                else
                {
                    bool t2 = current.Tier >= 2;
                    float leaderLength = Vector2.Distance(anchor, current.Elbow) + Vector2.Distance(current.Elbow, current.Landing);
                    bool t3 = onScreen[i] && leaderLength > LongLeader;
                    bool t4 = onScreen[i] && crossSince[i] >= 0f && now - crossSince[i] >= CrossDwell;
                    if (!t2 && !t3 && !t4)
                    {
                        continue;
                    }
                    score = current.Tier * 1e5f + current.Cost;
                }
                if (score > worstScore)
                {
                    worstScore = score;
                    worst = i;
                    worstCurrent = current;
                }
            }

            if (worst < 0)
            {
                return;
            }
            RockCard moving = cards[worst];
            Vector2 a = layoutAnchor[worst];
            CardLayoutSolver.Slot next = solver.Solve(worst, a, moving.Size, PreferredSide(a, worst));
            bool better = next.Tier < worstCurrent.Tier ||
                          (next.Tier == worstCurrent.Tier && next.Cost < AcceptRatio * worstCurrent.Cost);
            if (!better || next.Rect == moving.TargetRect)
            {
                return;
            }
            moving.SetTarget(next.Rect, next.Side, false);
            solver.SetCard(worst, true, next.Rect, a, next.Elbow, next.Landing);
            lastMove[worst] = now;
            crossSince[worst] = -1f;
        }
    }
}

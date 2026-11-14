using System;
using System.Collections.Generic;
using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Places rock cards next to their anchors (spec §5.5): 28 candidates per card, hard rules relaxed in tiers, cost
    /// minimised within the lowest tier. Canvas coordinates, origin bottom-left, y up. Avoid-zones = the instrument roots
    /// registered with <see cref="HudContext.ReserveZone"/> (converted to canvas space every frame), the night-sky toast
    /// corner and the center reticle zone. Allocation-free after the zone buffer has grown.
    /// </summary>
    public sealed class CardLayoutSolver
    {
        /// <summary>A placement: card rect, leader geometry, side relative to the anchor, cost and rule tier.</summary>
        public struct Slot
        {
            public Rect Rect;
            public Vector2 Landing, Elbow;
            public int Side;      // +1 card right of the anchor, -1 left, 0 above/below
            public float Cost;
            public bool Valid;    // every hard rule holds (tier 0)
            public int Tier;      // lowest relaxation tier that accepts the rect (0..3), 4 = rejected even at tier 3
        }

        /// <summary>Card records the solver can hold (visible cards plus one fading out).</summary>
        public const int MaxCards = HudTokens.CardMax + 1;

        private const int ZoneToast = 0;          // top-left night-sky toast (soft)
        private const int ZoneCenter = 1;         // crosshair and scanned rock (hard: never covered)
        private const int FixedZones = 2;
        private const float CenterZone = 220f;
        private const float ZoneInflate = 8f;     // gap kept around every zone
        private const float CardInflate = 12f;
        private const float AnchorInflate = 24f;
        private const float HeaderOffset = 26f;   // landing y below the card top (header row center)
        private const float ElbowRun = 20f;       // horizontal landing run
        private const float ElbowDrop = 16f;      // vertical landing run (card above/below)
        private const float SideClamp = 24f;      // landing x inset for cards above/below
        private const int RejectTier = 4;
        private const float DiagonalSlope = 1.7320508f; // tan(60°)

        private static readonly float[] s_Distances = { 120f, 220f };
        private static readonly float[] s_Offsets = { 0f, 72f, -72f, 144f, -144f, 232f, -232f };

        private Rect[] zones = new Rect[FixedZones + 8];
        private int zoneCount = FixedZones;
        private readonly Vector3[] corners = new Vector3[4];
        private int zonesFrame = -1;
        private Rect safe;
        private Vector2 canvas = new Vector2(-1f, -1f);

        private readonly bool[] active = new bool[MaxCards];
        private readonly Rect[] rects = new Rect[MaxCards];
        private readonly Vector2[] anchors = new Vector2[MaxCards];
        private readonly Vector2[] elbows = new Vector2[MaxCards];
        private readonly Vector2[] landings = new Vector2[MaxCards];

        /// <summary>
        /// Rebuilds the avoid-zones (fixed zones + <see cref="HudContext.ReservedZones"/> in canvas space, inflated by a
        /// small gap) and the safe rect. Runs at most once per frame unless the canvas size changes.
        /// </summary>
        public void BeginFrame(HudContext ctx)
        {
            if (ctx == null || ctx.CanvasRect == null)
            {
                return;
            }
            Vector2 canvasSize = ctx.CanvasSize;
            int frame = Time.frameCount;
            if (frame == zonesFrame && canvasSize == canvas)
            {
                return;
            }
            zonesFrame = frame;
            canvas = canvasSize;
            float w = canvasSize.x, h = canvasSize.y;
            float cx = w * 0.5f, cy = h * 0.5f;
            zones[ZoneToast] = Zone(0f, h - HudTokens.NightToastHeight, HudTokens.NightToastWidth, HudTokens.NightToastHeight);
            zones[ZoneCenter] = Zone(cx - CenterZone * 0.5f, cy - CenterZone * 0.5f, CenterZone, CenterZone);
            zoneCount = FixedZones;

            RectTransform canvasRect = ctx.CanvasRect;
            Rect cr = canvasRect.rect;
            IReadOnlyList<RectTransform> reserved = ctx.ReservedZones;
            for (int i = 0; i < reserved.Count; i++)
            {
                RectTransform rt = reserved[i];
                if (rt == null || !rt.gameObject.activeInHierarchy)
                {
                    continue;
                }
                rt.GetWorldCorners(corners);
                float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
                for (int k = 0; k < 4; k++)
                {
                    Vector3 p = canvasRect.InverseTransformPoint(corners[k]);
                    float x = p.x - cr.xMin, y = p.y - cr.yMin;
                    x0 = Mathf.Min(x0, x);
                    x1 = Mathf.Max(x1, x);
                    y0 = Mathf.Min(y0, y);
                    y1 = Mathf.Max(y1, y);
                }
                // Empty rects, and full-screen layers registered by mistake (they would push every card to tier 3).
                if (x1 - x0 < 1f || y1 - y0 < 1f || (x1 - x0) * (y1 - y0) > 0.5f * w * h)
                {
                    continue;
                }
                if (zoneCount == zones.Length)
                {
                    Array.Resize(ref zones, zones.Length * 2);
                }
                zones[zoneCount++] = Zone(x0, y0, x1 - x0, y1 - y0);
            }

            float inset = HudTokens.SafeInset;
            safe = new Rect(inset, inset, Mathf.Max(0f, w - 2f * inset), Mathf.Max(0f, h - 2f * inset));
        }

        /// <summary>Records a card's target rect and leader (from that rect) for the rules of the other cards.</summary>
        public void SetCard(int index, bool active, Rect targetRect, Vector2 anchor, Vector2 elbow, Vector2 landing)
        {
            if ((uint)index >= MaxCards)
            {
                return;
            }
            this.active[index] = active;
            rects[index] = targetRect;
            anchors[index] = anchor;
            elbows[index] = elbow;
            landings[index] = landing;
        }

        /// <summary>
        /// Best slot for card <paramref name="index"/> of <paramref name="size"/> at <paramref name="anchor"/>: the
        /// lowest tier with any candidate wins, then the lowest cost. Never fails (falls back to a tier-4 slot).
        /// </summary>
        public Slot Solve(int index, Vector2 anchor, Vector2 size, int preferredSide)
        {
            int pref = preferredSide > 0 ? 1 : -1;
            Slot best = default;
            best.Tier = int.MaxValue;
            best.Cost = float.MaxValue;

            for (int s = 0; s < 2; s++)
            {
                int side = s == 0 ? pref : -pref;
                for (int di = 0; di < s_Distances.Length; di++)
                {
                    float d = s_Distances[di];
                    for (int oi = 0; oi < s_Offsets.Length; oi++)
                    {
                        float dy = s_Offsets[oi];
                        float x = side > 0 ? anchor.x + d : anchor.x - d - size.x;
                        float top = anchor.y + dy + HeaderOffset;
                        Rect rect = new Rect(x, top - size.y, size.x, size.y);
                        float shift = ShiftIntoSafe(ref rect);

                        Slot c = Rate(index, anchor, rect);
                        c.Cost += 0.6f * Mathf.Abs(dy)
                                  + (side != pref ? 240f : 0f)
                                  + (di == 1 ? 80f : 0f)
                                  + 1.5f * shift;

                        if (c.Tier < best.Tier || (c.Tier == best.Tier && c.Cost < best.Cost))
                        {
                            best = c;
                        }
                    }
                }
            }
            return best;
        }

        /// <summary>Cost and validity of an existing rect under the same rules (no side or shift terms).</summary>
        public Slot Evaluate(int index, Vector2 anchor, Rect rect)
        {
            Slot c = Rate(index, anchor, rect);
            float gap = c.Side > 0 ? rect.xMin - anchor.x : c.Side < 0 ? anchor.x - rect.xMax : 0f;
            c.Cost += 0.6f * Mathf.Abs(c.Landing.y - anchor.y) + (gap >= 170f ? 80f : 0f);
            return c;
        }

        /// <summary>True when card <paramref name="index"/>'s recorded leader crosses another active card's leader.</summary>
        public bool LeaderCrosses(int index)
        {
            if ((uint)index >= MaxCards)
            {
                return false;
            }
            Vector2 a = anchors[index], e = elbows[index], l = landings[index];
            for (int j = 0; j < MaxCards; j++)
            {
                if (j != index && active[j] && PathsCross(a, e, l, anchors[j], elbows[j], landings[j]))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// Leader for a rect: landing on the near vertical edge at the header row (horizontal run 20 px), or, for a card
        /// fully above/below the anchor, on the near horizontal edge (vertical run 16 px). Cost = path length.
        /// </summary>
        public static Slot Leader(Vector2 anchor, Rect rect)
        {
            Slot s = default;
            s.Rect = rect;
            s.Valid = true;
            if (anchor.x < rect.xMin)
            {
                s.Side = 1;
                s.Landing = new Vector2(rect.xMin, rect.yMax - HeaderOffset);
                s.Elbow = new Vector2(Mathf.Max(s.Landing.x - ElbowRun, anchor.x), s.Landing.y);
            }
            else if (anchor.x > rect.xMax)
            {
                s.Side = -1;
                s.Landing = new Vector2(rect.xMax, rect.yMax - HeaderOffset);
                s.Elbow = new Vector2(Mathf.Min(s.Landing.x + ElbowRun, anchor.x), s.Landing.y);
            }
            else
            {
                s.Side = 0;
                float lx = rect.width > 2f * SideClamp
                    ? Mathf.Clamp(anchor.x, rect.xMin + SideClamp, rect.xMax - SideClamp)
                    : rect.center.x;
                if (anchor.y <= rect.center.y)
                {
                    s.Landing = new Vector2(lx, rect.yMin);   // card above the anchor
                    s.Elbow = new Vector2(lx, Mathf.Max(rect.yMin - ElbowDrop, Mathf.Min(anchor.y, rect.yMin)));
                }
                else
                {
                    s.Landing = new Vector2(lx, rect.yMax);   // card below the anchor
                    s.Elbow = new Vector2(lx, Mathf.Min(rect.yMax + ElbowDrop, Mathf.Max(anchor.y, rect.yMax)));
                }
            }
            s.Cost = Vector2.Distance(anchor, s.Elbow) + Vector2.Distance(s.Elbow, s.Landing);
            return s;
        }

        /// <summary>Proper crossing of segments ab and cd (collinear overlap counts; shared endpoints do not).</summary>
        public static bool SegmentsIntersect(Vector2 a, Vector2 b, Vector2 c, Vector2 d)
        {
            const float eps = 1e-3f;
            float d1 = Cross(d - c, a - c);
            float d2 = Cross(d - c, b - c);
            float d3 = Cross(b - a, c - a);
            float d4 = Cross(b - a, d - a);
            if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
                ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps)))
            {
                return true;
            }
            // Collinear: overlap along the shared line (more than a touching point).
            if (Mathf.Abs(d1) <= eps && Mathf.Abs(d2) <= eps)
            {
                Vector2 dir = b - a;
                float len2 = dir.sqrMagnitude;
                if (len2 < eps)
                {
                    return false;
                }
                float t0 = Vector2.Dot(c - a, dir) / len2;
                float t1 = Vector2.Dot(d - a, dir) / len2;
                float lo = Mathf.Max(0f, Mathf.Min(t0, t1));
                float hi = Mathf.Min(1f, Mathf.Max(t0, t1));
                return (hi - lo) * Mathf.Sqrt(len2) > 1f;
            }
            return false;
        }

        /// <summary>True when segment ab touches rect <paramref name="r"/> (Liang-Barsky clip).</summary>
        public static bool SegmentHitsRect(Vector2 a, Vector2 b, Rect r)
        {
            float t0 = 0f, t1 = 1f;
            Vector2 d = b - a;
            return Clip(-d.x, a.x - r.xMin, ref t0, ref t1)
                && Clip(d.x, r.xMax - a.x, ref t0, ref t1)
                && Clip(-d.y, a.y - r.yMin, ref t0, ref t1)
                && Clip(d.y, r.yMax - a.y, ref t0, ref t1);
        }

        // ---- internals

        // Leader geometry, tier and the cost terms shared by Solve and Evaluate (path length + diagonal penalty).
        private Slot Rate(int index, Vector2 a, Rect rect)
        {
            Slot s = Leader(a, rect);
            Vector2 e = s.Elbow, l = s.Landing;

            bool anchorClear = !Inflate(rect, AnchorInflate).Contains(a);
            bool zonesHard = !rect.Overlaps(zones[ZoneCenter]);
            bool zonesAll = zonesHard;
            for (int z = 0; z < zoneCount && zonesAll; z++)
            {
                if (rect.Overlaps(zones[z]))
                {
                    zonesAll = false;
                }
            }

            bool cardsClear = true, leadersClear = true, noCross = true;
            for (int j = 0; j < MaxCards; j++)
            {
                if (j == index || !active[j])
                {
                    continue;
                }
                Rect other = rects[j];
                if (rect.Overlaps(Inflate(other, CardInflate)))
                {
                    cardsClear = false;
                }
                // Rule 4, both ways: this leader must not run under another card, and this card must not cover
                // another card's leader.
                if (SegmentHitsRect(a, e, other) || SegmentHitsRect(e, l, other) ||
                    SegmentHitsRect(anchors[j], elbows[j], rect) || SegmentHitsRect(elbows[j], landings[j], rect))
                {
                    leadersClear = false;
                }
                if (PathsCross(a, e, l, anchors[j], elbows[j], landings[j]))
                {
                    noCross = false;
                }
            }

            int tier;
            if (!anchorClear || !leadersClear || !zonesHard)
            {
                tier = RejectTier;
            }
            else if (!zonesAll)
            {
                tier = 3;
            }
            else if (!cardsClear)
            {
                tier = 2;
            }
            else
            {
                tier = noCross ? 0 : 1;
            }
            s.Tier = tier;
            s.Valid = tier == 0;

            // Leader length + steep diagonal penalty (A->E more than 60° from horizontal).
            float dx = Mathf.Abs(e.x - a.x), dyAbs = Mathf.Abs(e.y - a.y);
            s.Cost += dyAbs > dx * DiagonalSlope ? 200f : 0f;
            return s;
        }

        private float ShiftIntoSafe(ref Rect r)
        {
            float dx = 0f, dy = 0f;
            if (r.width > safe.width || r.xMin < safe.xMin)
            {
                dx = safe.xMin - r.xMin;
            }
            else if (r.xMax > safe.xMax)
            {
                dx = safe.xMax - r.xMax;
            }
            if (r.height > safe.height || r.yMax > safe.yMax)
            {
                dy = safe.yMax - r.yMax;   // keep the header visible
            }
            else if (r.yMin < safe.yMin)
            {
                dy = safe.yMin - r.yMin;
            }
            if (dx == 0f && dy == 0f)
            {
                return 0f;
            }
            r.x += dx;
            r.y += dy;
            return Mathf.Sqrt(dx * dx + dy * dy);
        }

        private static bool PathsCross(Vector2 a, Vector2 e, Vector2 l, Vector2 a2, Vector2 e2, Vector2 l2)
        {
            return SegmentsIntersect(a, e, a2, e2) || SegmentsIntersect(a, e, e2, l2)
                || SegmentsIntersect(e, l, a2, e2) || SegmentsIntersect(e, l, e2, l2);
        }

        private static bool Clip(float p, float q, ref float t0, ref float t1)
        {
            if (p == 0f)
            {
                return q >= 0f;
            }
            float t = q / p;
            if (p < 0f)
            {
                if (t > t1)
                {
                    return false;
                }
                if (t > t0)
                {
                    t0 = t;
                }
            }
            else
            {
                if (t < t0)
                {
                    return false;
                }
                if (t < t1)
                {
                    t1 = t;
                }
            }
            return true;
        }

        private static float Cross(Vector2 u, Vector2 v)
        {
            return u.x * v.y - u.y * v.x;
        }

        private static Rect Inflate(Rect r, float by)
        {
            return new Rect(r.x - by, r.y - by, r.width + 2f * by, r.height + 2f * by);
        }

        private static Rect Zone(float x, float y, float w, float h)
        {
            return Inflate(new Rect(x, y, w, h), ZoneInflate);
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Full-screen map display (open/close owned by <see cref="HelmetHud"/>): a top-centre clock pill (LTST | UTC and
    /// date), one large scrim panel with the detailed <see cref="MapView"/>, overlay checkboxes under it and a
    /// right-hand column of readouts (sunset, sunrise, time to dark/light, partner-haul status, daily dose) plus the map
    /// legend. Lives in its own nested canvas drawn above the other HUD layers; laid out on a 1920x1080 frame that is
    /// centred and scaled down on narrower canvases. Fades in/out over <see cref="HudTokens.DurDim"/> with ease-out
    /// (instant under reduced motion). Readouts refresh at 10 Hz and assign text only when the value changes.
    /// </summary>
    public sealed class MapScreen
    {
        // ---- layout: 1920x1080 frame, coordinates from its top-left, y down (mockup "Your paragraph text (2).png")
        private const float FrameW = 1920f, FrameH = 1080f;
        private const float PillY = 22f, PillH = 52f, PillPad = 24f;
        private const float PanelX = 40f, PanelY = 93f, PanelW = 1840f, PanelH = 952f, PanelRadius = 24f;
        private const float MapX = 84f, MapY = 133f, MapW = 1200f, MapH = 742f, MapRadius = 8f;
        private const float CheckRowY = 918f, CheckPitch = 176f, CheckBox = 22f, CheckHitH = 36f, CheckPad = 8f, CheckGap = 12f;
        private const float ColX = 1328f, ColRight = 1832f;
        private const float Row0Y = 165f, RowPitch = 48f, RowH = 24f;
        private const float Divider1Y = 293f, Divider2Y = 405f;
        private const float LegendHeadY = 441f, LegendTop = 465f, LegendPitch = 40f, LegendIconX = 10f, LegendTextX = 26f;
        private const int LegendMaxRows = 13, LegendMaxCols = 3;
        private const float CloseInset = 8f, CloseSize = 32f;
        private const float RefreshPeriod = 0.1f;   // 10 Hz readouts
        private const int SizeRow = HudTokens.SizeValue;        // 18: row labels, values, checkbox labels
        private const int SizeClock = HudTokens.SizeValueLarge; // 22: clock pill
        private const int SizeLegend = HudTokens.SizeLabel;     // 15: legend labels
        private const string ClockLtstPlaceholder = "00:00:00 LTST";              // 13 chars
        private const string ClockUtcPlaceholder = "00:00:00 UTC  01 Mar 2026";   // 25 chars

        // ---- partner haul (HOMELINE F10 / decision D20): cart case, 60-min contour, flat ground, mid-band values of
        // the spec's assumed bands. Haul force F = m_IC g mu (theta = 0); speed v solves v F = eps (P(0.7 VO2max) - P(V0 + a v)),
        // the rescuer's power at 70 % VO2max (band 60-80 %) minus their own suited walking cost (F3 linear model,
        // SuitTelemetry.Vo2Rest / Vo2PerSpeed), capped at the flat safe speed 1.0 m/s (haul never faster than walking).
        // With these values v = 0.45 m/s, range ~1.6 km. A radial approximation: the real F10 line is a terrain field.
        public const float CasualtyMassKg = 179f;   // 75 kg crew + 104 kg suit (HOMELINE D20 drag finding)
        public const float CartFriction = 0.25f;    // cart mu band 0.1-0.4 (assumed)
        public const float HaulVo2Fraction = 0.70f; // rescuer effort band 60-80 % VO2max (assumed)
        public const float HaulMinutes = 60f;       // partner line = 60-min cart haul (D20)
        public const float HaulMaxSpeedMs = 1.0f;   // F3 v_safe on 0-10 deg

        /// <summary>Flat-ground cart-haul speed, m/s (see the constants above).</summary>
        public static readonly float PartnerHaulSpeedMs = HaulSpeed();

        /// <summary>Partner-haul range from home, metres: <see cref="PartnerHaulSpeedMs"/> over <see cref="HaulMinutes"/>.</summary>
        public static readonly float PartnerHaulRangeM = PartnerHaulSpeedMs * HaulMinutes * 60f;

        private static readonly Color NominalGreen = HudTokens.Hex(0x5FD68E, 1f);   // nominal status value
        private static readonly Vector2 TopLeft = new Vector2(0f, 1f);
        private static readonly Vector2 LeftMid = new Vector2(0f, 0.5f);
        private static readonly Vector2 RightMid = new Vector2(1f, 0.5f);
        private static readonly Vector2 Center = new Vector2(0.5f, 0.5f);
        private static readonly string[] Months = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        private static readonly char[] s_Chars = new char[48];
        private static readonly Vector2[] s_Pts = new Vector2[12];

        private sealed class Checkbox
        {
            public MapLayer Layer;
            public HudLineMesh Box;
            public bool Local;     // state when there is no map view
            public int Shown = -1; // 0 off, 1 on, -1 never drawn
        }

        private readonly HudContext ctx;
        private readonly Action closeRequested;
        private readonly RectTransform root, frame;
        private readonly CanvasGroup group;
        private readonly MapView map;
        private readonly Font regular, medium;
        private readonly Text ltst, utc;
        private readonly Text sunsetValue, sunriseValue, lightLabel, lightValue, haulStatus, haulValue, doseValue;
        private readonly float haulRowY;
        private readonly string rangeText;
        private readonly Checkbox[] checks = new Checkbox[4];
        private readonly RectTransform legendRect;
        private readonly HudLineMesh legendMesh;
        private readonly List<Text> legendTexts = new List<Text>(16);

        private bool open, mapBroken, fading;
        private float visibility, fadeFrom, fadeTo, fadeElapsed, fadeDuration;
        private float refreshTimer = RefreshPeriod;
        private float frameScale = -1f;

        // last shown values (text is assigned only on change)
        private int ltstShown = int.MinValue, utcSecShown = int.MinValue, utcDateShown = int.MinValue;
        private int riseShown = int.MinValue, setShown = int.MinValue, lightMinShown = int.MinValue, lightDayShown = int.MinValue;
        private int haulShown = int.MinValue, haulStateShown = int.MinValue, doseShown = int.MinValue;
        private int doseSevShown = int.MinValue;
        private int legendVersionShown = int.MinValue;

        // sun clock cache (recomputed about once per in-game minute)
        private bool sunValid, sunHas, sunReal;
        private double sunAt, sunLat, sunLon, riseDays, setDays;

        /// <summary>True between an open request and the next close request.</summary>
        public bool IsOpen => open;

        /// <summary>Eased visibility 0..1 (the other HUD layers fade by 1 - this).</summary>
        public float Visibility => visibility;

        /// <summary>The hosted map, or null when it failed to build.</summary>
        public MapView View => map;

        /// <summary>Builds the screen (hidden) as the last child of <paramref name="parent"/> (the HUD root).</summary>
        public MapScreen(HudContext ctx, Transform parent, Action closeRequested)
        {
            this.ctx = ctx;
            this.closeRequested = closeRequested;
            HudSkin skin = ctx.Skin != null ? ctx.Skin : HudSkin.Load();
            regular = skin != null ? skin.Regular : null;
            medium = skin != null && skin.Medium != null ? skin.Medium : regular;

            root = HudFactory.CreateStretch("MapScreen", parent);
            HudFactory.AddNestedCanvas(root.gameObject, true);
            group = HudFactory.AddGroup(root.gameObject, 0f, false);
            group.interactable = false;
            frame = HudFactory.CreateRect("Frame", root, Center, Center, Vector2.zero, new Vector2(FrameW, FrameH));

            // Panel first (draw order), then the pill above the panel's top edge.
            HudFactory.CreatePanel("Panel", frame, skin, HudTokens.Scrim, PanelRadius, TopLeft, TopLeft,
                                   new Vector2(PanelX, -PanelY), new Vector2(PanelW, PanelH));

            // ---- clock pill: "HH:MM:SS LTST | HH:MM:SS UTC  DD Mon YYYY"
            int adv = HudTokens.Advance(SizeClock);
            float segL = ClockLtstPlaceholder.Length * adv, segR = ClockUtcPlaceholder.Length * adv;
            float pillW = PillPad * 4f + segL + segR + 1f;
            Image pill = HudFactory.CreatePanel("ClockPill", frame, skin, HudTokens.Scrim, PillH * 0.5f, TopLeft, new Vector2(0.5f, 1f),
                                                new Vector2(FrameW * 0.5f, -PillY), new Vector2(pillW, PillH));
            RectTransform p = pill.rectTransform;
            ltst = HudFactory.CreateText("Ltst", p, regular, SizeClock, HudTokens.InkPrimary, TextAnchor.MiddleCenter,
                                         LeftMid, LeftMid, new Vector2(PillPad, 0f), new Vector2(segL, 28f));
            HudFactory.CreateImage("ClockDivider", p, null, HudTokens.StrokeHair, LeftMid, LeftMid,
                                   new Vector2(PillPad * 2f + segL, 0f), new Vector2(1f, PillH - 20f));
            utc = HudFactory.CreateText("Utc", p, regular, SizeClock, HudTokens.InkPrimary, TextAnchor.MiddleCenter,
                                        LeftMid, LeftMid, new Vector2(PillPad * 3f + segL + 1f, 0f), new Vector2(segR, 28f));

            // ---- map box (clipped) and its hairline frame on top
            Image box = HudFactory.CreatePanel("MapBox", frame, skin, HudTokens.Scrim, MapRadius, TopLeft, TopLeft,
                                               new Vector2(MapX, -MapY), new Vector2(MapW, MapH));
            RectTransform mapBox = box.rectTransform;
            mapBox.gameObject.AddComponent<RectMask2D>();
            try
            {
                map = new MapView(ctx, mapBox);
                map.SetLayer(MapLayer.Terrain, false);
                map.SetLayer(MapLayer.Topology, true);
                map.SetLayer(MapLayer.Mineral, false);
                map.SetLayer(MapLayer.Weather, false);
                map.SetVisible(false);
            }
            catch (Exception e)
            {
                // The screen still works (clock, readouts) without the map.
                Debug.LogException(e);
                map = null;
            }
            HudFactory.CreateOutline("MapBoxFrame", frame, skin, HudTokens.StrokeHair, MapRadius, TopLeft, TopLeft,
                                     new Vector2(MapX, -MapY), new Vector2(MapW, MapH));

            // ---- overlay checkboxes (default: Topology on)
            BuildCheckbox(0, MapLayer.Terrain, "Terrain", skin, false);
            BuildCheckbox(1, MapLayer.Topology, "Topology", skin, true);
            BuildCheckbox(2, MapLayer.Mineral, "Mineral", skin, false);
            BuildCheckbox(3, MapLayer.Weather, "Weather", skin, false);

            // Key hint at the right end of the checkbox row: [G] Close.
            int advFoot = HudTokens.Advance(HudTokens.SizeFoot);
            const string hint = "Close";
            HudFactory.CreateText("HintLabel", frame, regular, HudTokens.SizeFoot, HudTokens.InkTertiary, TextAnchor.MiddleRight,
                                  TopLeft, RightMid, new Vector2(MapX + MapW, -CheckRowY), new Vector2(120f, 20f)).text = hint;
            HudFactory.CreateKeycap("HintKey", frame, skin, medium, "G", TopLeft, RightMid,
                                    new Vector2(MapX + MapW - hint.Length * advFoot - HudTokens.S2, -CheckRowY));

            // ---- right column
            sunsetValue = Row("Sunset", "Sunset (UTC)", Row0Y, out _);
            sunriseValue = Row("Sunrise", "Sunrise (UTC)", Row0Y + RowPitch, out _);
            lightValue = Row("Light", "Dark / light in", Row0Y + 2f * RowPitch, out lightLabel);
            Divider("Divider1", Divider1Y);
            haulRowY = Divider1Y + 32f;
            haulValue = Row("Haul", "Partner haul range", haulRowY, out _);
            haulStatus = HudFactory.CreateText("HaulStatus", frame, regular, SizeRow, NominalGreen, TextAnchor.MiddleRight,
                                               TopLeft, RightMid, new Vector2(ColRight, -haulRowY), new Vector2(120f, RowH));
            doseValue = Row("Dose", "Daily dose rate", haulRowY + RowPitch, out _);
            Divider("Divider2", Divider2Y);
            HudFactory.CreateText("LegendTitle", frame, medium, SizeRow, HudTokens.InkPrimary, TextAnchor.MiddleLeft,
                                  TopLeft, LeftMid, new Vector2(ColX, -LegendHeadY), new Vector2(300f, RowH)).text = "Map legend";
            Vector2 legendSize = new Vector2(ColRight - ColX, LegendMaxRows * LegendPitch);
            legendRect = HudFactory.CreateRect("Legend", frame, TopLeft, TopLeft, new Vector2(ColX, -LegendTop), legendSize);
            legendMesh = HudFactory.CreateLineMesh("LegendIcons", legendRect, TopLeft, TopLeft, Vector2.zero, legendSize);
            rangeText = Km(Mathf.RoundToInt(PartnerHaulRangeM / 100f));

            // ---- close button (32x32) in the panel's top-right corner, last so it is on top
            Button close = HudFactory.CreateCloseButton("Close", frame, skin, regular, TopLeft, TopLeft,
                                                        new Vector2(PanelX + PanelW - CloseInset - CloseSize, -(PanelY + CloseInset)));
            close.onClick.AddListener(OnCloseClicked);

            root.gameObject.SetActive(false);
        }

        /// <summary>Starts the open (true) or close (false) fade. Cursor and player input are HelmetHud's job.</summary>
        public void SetOpen(bool value)
        {
            if (open == value)
            {
                return;
            }
            open = value;
            if (open)
            {
                root.gameObject.SetActive(true);
                CallMap(true);
                refreshTimer = RefreshPeriod;   // refresh in the same frame's Tick
            }
            else
            {
                // Drop a clicked checkbox/close button from the selection so Space/Enter cannot submit it later.
                EventSystem es = EventSystem.current;
                if (es != null && es.currentSelectedGameObject != null && es.currentSelectedGameObject.transform.IsChildOf(root))
                {
                    es.SetSelectedGameObject(null);
                }
            }
            group.interactable = open;
            group.blocksRaycasts = open;
            fadeFrom = visibility;
            fadeTo = open ? 1f : 0f;
            fadeElapsed = 0f;
            fadeDuration = HudTokens.ReducedMotion ? 0f : HudTokens.DurDim;   // 160 ms ease-out, instant when reduced
            fading = true;
        }

        /// <summary>Fade, map and readouts (unscaled <paramref name="dt"/>). Cheap no-op while hidden.</summary>
        public void Tick(float dt)
        {
            if (fading)
            {
                fadeElapsed += dt;
                float t = fadeDuration > 0f ? fadeElapsed / fadeDuration : 1f;
                visibility = t >= 1f ? fadeTo : Mathf.LerpUnclamped(fadeFrom, fadeTo, HudTokens.EaseOut(t));
                if (t >= 1f)
                {
                    fading = false;
                    if (!open)
                    {
                        CallMap(false);
                        root.gameObject.SetActive(false);
                    }
                }
                if (group.alpha != visibility)
                {
                    group.alpha = visibility;
                }
            }
            if (!root.gameObject.activeSelf)
            {
                return;
            }

            UpdateFrameScale();
            if (map != null && !mapBroken)
            {
                try
                {
                    map.Tick(dt);
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                    mapBroken = true;   // one report, then the map stays frozen
                }
            }

            refreshTimer += dt;
            if (refreshTimer < RefreshPeriod)
            {
                return;
            }
            refreshTimer = 0f;
            RefreshClock();
            RefreshSun();
            RefreshStatus();
            if (map != null && !mapBroken)
            {
                try
                {
                    RefreshChecks();
                    RefreshLegend();
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                    mapBroken = true;
                }
            }
        }

        // ------------------------------------------------------------------------------------------------ build

        private Text Row(string name, string label, float y, out Text labelText)
        {
            labelText = HudFactory.CreateText(name + "Label", frame, regular, SizeRow, HudTokens.InkSecondary, TextAnchor.MiddleLeft,
                                              TopLeft, LeftMid, new Vector2(ColX, -y), new Vector2(300f, RowH));
            labelText.text = label;
            Text value = HudFactory.CreateText(name + "Value", frame, regular, SizeRow, HudTokens.InkPrimary, TextAnchor.MiddleRight,
                                               TopLeft, RightMid, new Vector2(ColRight, -y), new Vector2(280f, RowH));
            value.text = "--";
            return value;
        }

        private void Divider(string name, float y)
        {
            HudFactory.CreateImage(name, frame, null, HudTokens.StrokeHair, TopLeft, LeftMid, new Vector2(ColX, -y),
                                   new Vector2(ColRight - ColX, 1f));
        }

        private void BuildCheckbox(int index, MapLayer layer, string label, HudSkin skin, bool defaultOn)
        {
            float labelW = label.Length * HudTokens.Advance(SizeRow);
            float w = CheckPad + CheckBox + CheckGap + labelW + CheckPad;
            float x = MapX - CheckPad + index * CheckPitch;   // the box's left edge aligns with the map box
            Image hit = HudFactory.CreatePanel("Check" + label, frame, skin, Color.white, HudTokens.RadiusButton, TopLeft, LeftMid,
                                               new Vector2(x, -CheckRowY), new Vector2(w, CheckHitH));
            hit.raycastTarget = true;
            RectTransform hr = hit.rectTransform;
            HudLineMesh boxMesh = HudFactory.CreateLineMesh("Box", hr, LeftMid, Center, new Vector2(CheckPad + CheckBox * 0.5f, 0f),
                                                            new Vector2(CheckBox, CheckBox));
            HudFactory.CreateText("Label", hr, regular, SizeRow, HudTokens.InkPrimary, TextAnchor.MiddleLeft, LeftMid, LeftMid,
                                  new Vector2(CheckPad + CheckBox + CheckGap, 0f), new Vector2(labelW + CheckPad, RowH)).text = label;

            var button = hit.gameObject.AddComponent<Button>();
            button.transition = Selectable.Transition.ColorTint;
            button.targetGraphic = hit;
            button.navigation = new Navigation { mode = Navigation.Mode.None };
            Color rest = new Color(1f, 1f, 1f, 0f);
            ColorBlock colors = ColorBlock.defaultColorBlock;
            colors.normalColor = rest;
            colors.highlightedColor = HudTokens.HoverFill;
            colors.pressedColor = HudTokens.PressFill;
            colors.selectedColor = rest;
            colors.disabledColor = rest;
            colors.colorMultiplier = 1f;
            colors.fadeDuration = 0f;           // no white flash on the first apply
            button.colors = colors;
            colors.fadeDuration = HudTokens.DurButton;
            button.colors = colors;

            var c = new Checkbox { Layer = layer, Box = boxMesh, Local = defaultOn };
            checks[index] = c;
            button.onClick.AddListener(() => Toggle(index));
            DrawCheckbox(c, IsOn(c));
        }

        // ------------------------------------------------------------------------------------------------ actions

        private void OnCloseClicked()
        {
            closeRequested?.Invoke();
        }

        private void Toggle(int index)
        {
            Checkbox c = checks[index];
            if (c == null)
            {
                return;
            }
            bool on = !IsOn(c);
            c.Local = on;
            if (map != null && !mapBroken)
            {
                try
                {
                    map.SetLayer(c.Layer, on);
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                }
            }
            DrawCheckbox(c, IsOn(c));
        }

        private bool IsOn(Checkbox c)
        {
            if (map != null && !mapBroken)
            {
                try
                {
                    return map.GetLayer(c.Layer);
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                    mapBroken = true;
                }
            }
            return c.Local;
        }

        private void CallMap(bool visible)
        {
            if (map == null || mapBroken)
            {
                return;
            }
            try
            {
                map.SetVisible(visible);
                if (visible)
                {
                    map.Recenter();
                }
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                mapBroken = true;
            }
        }

        private void UpdateFrameScale()
        {
            Vector2 size = ctx.CanvasRect != null ? ctx.CanvasRect.rect.size : new Vector2(FrameW, FrameH);
            float s = Mathf.Min(1f, Mathf.Min(size.x / FrameW, size.y / FrameH));
            if (s > 1e-3f && Mathf.Abs(s - frameScale) > 1e-4f)
            {
                frameScale = s;
                frame.localScale = new Vector3(s, s, 1f);
            }
        }

        // ------------------------------------------------------------------------------------------------ readouts

        private static bool SkyPublished => MarsSkyState.DaysTT != 0.0 && !double.IsNaN(MarsSkyState.DaysTT) && !double.IsInfinity(MarsSkyState.DaysTT);

        private void RefreshClock()
        {
            bool sky = SkyPublished;
            float lst = sky ? MarsSkyState.LocalSolarTime : (ctx.Telemetry != null ? ctx.Telemetry.LocalSolarTime : float.NaN);
            int lstSec = Finite(lst) ? Mathf.Clamp((int)(Mathf.Repeat(lst, 1f) * 86400f), 0, 86399) : -1;
            if (lstSec != ltstShown)
            {
                ltstShown = lstSec;
                ltst.text = lstSec < 0 ? "--:--:-- LTST" : Hms(lstSec, " LTST");
            }

            int sec = -1, date = -1;
            DateTime u = default;
            if (sky)
            {
                u = MarsEphemeris.UtcFromDaysTT(MarsSkyState.DaysTT);
                sec = u.Hour * 3600 + u.Minute * 60 + u.Second;
                date = u.Year * 10000 + u.Month * 100 + u.Day;
            }
            if (sec != utcSecShown || date != utcDateShown)
            {
                utcSecShown = sec;
                utcDateShown = date;
                utc.text = sec < 0 ? "--:--:-- UTC  -- --- ----" : UtcStamp(u);
            }
        }

        // Sunrise/sunset of the daylight period in progress, else the next one; "Dark in" by day, "Light in" by night.
        private void RefreshSun()
        {
            if (!SkyPublished)
            {
                sunValid = sunHas = false;
            }
            else
            {
                double d = MarsSkyState.DaysTT, lat = MarsSkyState.Latitude, lon = MarsSkyState.Longitude;
                bool real = MarsSkyState.RealSky;
                if (!sunValid || Math.Abs(d - sunAt) >= 1.0 / 1440.0 || lat != sunLat || lon != sunLon || real != sunReal
                    || (sunHas && d >= setDays))
                {
                    sunValid = true;
                    sunAt = d;
                    sunLat = lat;
                    sunLon = lon;
                    sunReal = real;
                    sunHas = real
                        ? MarsSunClock.NextDaylight(d, lat, lon, out riseDays, out setDays)
                        : ArtisticDaylight(d, MarsSkyState.LocalSolarTime, out riseDays, out setDays);
                }
            }

            int rise = sunHas ? UtcSecondOfDay(riseDays) : -1;
            int set = sunHas ? UtcSecondOfDay(setDays) : -1;
            if (rise != riseShown)
            {
                riseShown = rise;
                sunriseValue.text = rise < 0 ? "--:--:--" : Hms(rise, null);
            }
            if (set != setShown)
            {
                setShown = set;
                sunsetValue.text = set < 0 ? "--:--:--" : Hms(set, null);
            }

            double now = MarsSkyState.DaysTT;
            bool day = sunHas && now >= riseDays;
            int dayKey = sunHas ? (day ? 1 : 0) : -1;
            if (dayKey != lightDayShown)
            {
                lightDayShown = dayKey;
                lightLabel.text = dayKey < 0 ? "Dark / light in" : (day ? "Dark in" : "Light in");
            }
            int minutes = sunHas ? Mathf.Max(0, (int)Math.Ceiling(((day ? setDays : riseDays) - now) * 1440.0)) : -1;
            if (minutes != lightMinShown)
            {
                lightMinShown = minutes;
                lightValue.text = minutes < 0 ? "--" : Minutes(minutes);
            }
        }

        private void RefreshStatus()
        {
            SuitTelemetry t = ctx.Telemetry;

            // Partner haul: distance home (world origin) against the cart-haul range.
            float dist = t != null ? t.DistanceHomeM : new Vector2(ctx.CameraPosition.x, ctx.CameraPosition.z).magnitude;
            int key = Finite(dist) ? Mathf.RoundToInt(Mathf.Max(0f, dist) / 100f) : -1;   // tenths of a km
            bool within = dist <= PartnerHaulRangeM;
            int state = key < 0 ? -1 : (within ? 1 : 0);
            bool place = false;
            if (key != haulShown)
            {
                haulShown = key;
                haulValue.text = key < 0 ? "--" : "· " + Km(key) + "/" + rangeText + " km";
                place = true;
            }
            if (state != haulStateShown)
            {
                haulStateShown = state;
                haulStatus.text = state < 0 ? string.Empty : (within ? "within" : "beyond");
                haulStatus.color = within ? NominalGreen : HudTokens.Caution;
                place = true;
            }
            if (place)
            {
                float w = haulValue.preferredWidth;
                haulStatus.rectTransform.anchoredPosition = new Vector2(ColRight - w - HudTokens.S2, -haulRowY);
            }

            // Daily dose rate: mSv/h x 24, two decimals, coloured by the radiation state.
            float rate = t != null ? t.DoseRateMsvH : float.NaN;
            int dose = Finite(rate) && rate >= 0f ? Mathf.RoundToInt(rate * 24f * 100f) : -1;
            if (dose != doseShown)
            {
                doseShown = dose;
                doseValue.text = dose < 0 ? "--" : (dose / 100).ToString(Inv) + "." + (dose % 100).ToString("00", Inv) + " mSv/d";
            }
            int sev = t != null ? (int)t.RadState : 0;
            if (sev != doseSevShown)
            {
                doseSevShown = sev;
                doseValue.color = HudTokens.Severity((HudSeverity)sev, HudTokens.InkPrimary);
            }
        }

        // Follows layer changes made elsewhere (e.g. by the map view itself).
        private void RefreshChecks()
        {
            for (int i = 0; i < checks.Length; i++)
            {
                Checkbox c = checks[i];
                if (c != null)
                {
                    bool on = IsOn(c);
                    if (c.Shown != (on ? 1 : 0))
                    {
                        DrawCheckbox(c, on);
                    }
                }
            }
        }

        private void RefreshLegend()
        {
            int version = map.LegendVersion;
            if (version == legendVersionShown)
            {
                return;
            }
            legendVersionShown = version;

            int count = Mathf.Clamp(map.LegendCount, 0, LegendMaxRows * LegendMaxCols);
            int maxLen = 0;
            for (int i = 0; i < count; i++)
            {
                string label = map.GetLegend(i).Label;
                maxLen = Mathf.Max(maxLen, label != null ? label.Length : 0);
            }

            // Three columns as in the mockup; fewer when labels are long and the entries still fit.
            float width = ColRight - ColX;
            int cols = LegendMaxCols;
            if (maxLen > LabelChars(width / 3f) && count <= 2 * LegendMaxRows)
            {
                cols = 2;
            }
            if (maxLen > LabelChars(width / 2f) && count <= LegendMaxRows)
            {
                cols = 1;
            }
            float colW = width / cols;
            int rows = Mathf.Max(1, (count + cols - 1) / cols);
            int chars = LabelChars(colW);

            legendMesh.Clear();
            for (int i = 0; i < count; i++)
            {
                MapLegendEntry e = map.GetLegend(i);
                int c = i / rows, r = i % rows;
                float x = c * colW;
                float y = -(LegendPitch * 0.5f + r * LegendPitch);
                DrawShape(legendMesh, e.Shape, new Vector2(x + LegendIconX, y), e.Color);
                Text t = LegendText(i);
                t.rectTransform.anchoredPosition = new Vector2(x + LegendTextX, y);
                t.rectTransform.sizeDelta = new Vector2(colW - LegendTextX - HudTokens.S1, 20f);
                t.color = HudTokens.InkPrimary;
                t.text = HudStrings.Truncate(e.Label, chars);
            }
            int used = count;
            if (count == 0)
            {
                Text t = LegendText(0);
                t.rectTransform.anchoredPosition = new Vector2(0f, -LegendPitch * 0.5f);
                t.rectTransform.sizeDelta = new Vector2(width, 20f);
                t.color = HudTokens.InkTertiary;
                t.text = "No overlay shown";
                used = 1;
            }
            for (int i = 0; i < legendTexts.Count; i++)
            {
                GameObject go = legendTexts[i].gameObject;
                if (go.activeSelf != (i < used))
                {
                    go.SetActive(i < used);
                }
            }
            legendMesh.Commit();
        }

        private Text LegendText(int i)
        {
            while (legendTexts.Count <= i)
            {
                legendTexts.Add(HudFactory.CreateText("LegendLabel" + legendTexts.Count, legendRect, regular, SizeLegend,
                                                      HudTokens.InkPrimary, TextAnchor.MiddleLeft, TopLeft, LeftMid,
                                                      Vector2.zero, new Vector2(100f, 20f)));
            }
            return legendTexts[i];
        }

        private static int LabelChars(float colW)
        {
            return Mathf.Max(4, Mathf.FloorToInt((colW - LegendTextX - HudTokens.S1) / HudTokens.Advance(SizeLegend)));
        }

        // ------------------------------------------------------------------------------------------------ drawing

        // Unchecked: 1.5 px outline. Checked: solid ink box with a dark check mark.
        private static void DrawCheckbox(Checkbox c, bool on)
        {
            c.Shown = on ? 1 : 0;
            HudLineMesh m = c.Box;
            if (m == null)
            {
                return;
            }
            m.Clear();
            float h = CheckBox * 0.5f;
            if (on)
            {
                m.Rect(new Rect(-h, -h, CheckBox, CheckBox), HudTokens.InkPrimary);
                s_Pts[0] = new Vector2(-5.5f, 0.5f);
                s_Pts[1] = new Vector2(-1.5f, -4f);
                s_Pts[2] = new Vector2(6f, 4.5f);
                m.Polyline(s_Pts, 3, 2.5f, HudTokens.KeycapInk);
            }
            else
            {
                const float w = 1.5f;
                Color32 col = HudTokens.InkSecondary;
                m.Rect(new Rect(-h, -h, CheckBox, w), col);
                m.Rect(new Rect(-h, h - w, CheckBox, w), col);
                m.Rect(new Rect(-h, -h + w, w, CheckBox - 2f * w), col);
                m.Rect(new Rect(h - w, -h + w, w, CheckBox - 2f * w), col);
            }
            m.Commit();
        }

        private static void DrawShape(HudLineMesh m, MapLegendShape shape, Vector2 c, Color color)
        {
            Color32 col = color;
            switch (shape)
            {
                case MapLegendShape.Star:
                    DrawStar(m, c, 7.5f, col);
                    break;
                case MapLegendShape.Dot:
                    m.Ring(c, 2.5f, 5f, col, 20);   // filled disc of radius 5
                    break;
                case MapLegendShape.Arrow:
                    m.Line(new Vector2(c.x - 8f, c.y), new Vector2(c.x + 5f, c.y), 2f, col);
                    s_Pts[0] = new Vector2(c.x + 0.5f, c.y + 5f);
                    s_Pts[1] = new Vector2(c.x + 7f, c.y);
                    s_Pts[2] = new Vector2(c.x + 0.5f, c.y - 5f);
                    m.Polyline(s_Pts, 3, 2f, col);
                    break;
                case MapLegendShape.Line:
                    m.Line(new Vector2(c.x - 9f, c.y), new Vector2(c.x + 9f, c.y), 3f, col);
                    break;
                default:   // Swatch
                    m.Rect(new Rect(c.x - 7f, c.y - 7f, 14f, 14f), col);
                    break;
            }
        }

        // Filled four-point star: nested outlines 0.7 px apart (closer than the 1.2 px stroke) plus a centre disc.
        private static void DrawStar(HudLineMesh m, Vector2 c, float r, Color32 col)
        {
            for (float s = 1f; s > 0.2f; s -= 0.25f)
            {
                float outer = r * s, inner = r * 0.3f * s;
                for (int k = 0; k < 9; k++)
                {
                    int j = (k + 1) % 8;   // start on a concave vertex so the seam hides
                    float a = (90f + j * 45f) * Mathf.Deg2Rad;
                    float rad = (j & 1) == 0 ? outer : inner;
                    s_Pts[k] = new Vector2(c.x + Mathf.Cos(a) * rad, c.y + Mathf.Sin(a) * rad);
                }
                m.Polyline(s_Pts, 9, 1.2f, col);
            }
            m.Ring(c, 1f, 2f, col, 8);
        }

        // ------------------------------------------------------------------------------------------------ helpers

        private static float HaulSpeed()
        {
            float force = CasualtyMassKg * SuitTelemetry.MarsGravity * CartFriction;                      // N
            float wattsPerVo2 = SuitTelemetry.BodyMassKg * SuitTelemetry.JoulesPerMlO2 / 60f;              // W per mL/kg/min
            float budget = HaulVo2Fraction * SuitTelemetry.Vo2Max - SuitTelemetry.Vo2Rest;                  // mL/kg/min
            float k = SuitTelemetry.WorkEfficiency * wattsPerVo2;
            float v = k * budget / (force + k * SuitTelemetry.Vo2PerSpeed);
            return Mathf.Clamp(v, 0f, HaulMaxSpeedMs);
        }

        // Artistic sky (no ephemeris sun): the sun rides the celestial equator, so it rises at 0.25 and sets at 0.75 of
        // the sol; converted to TT days through the published clock.
        private static bool ArtisticDaylight(double d, float lst, out double rise, out double set)
        {
            rise = set = double.NaN;
            if (!Finite(lst))
            {
                return false;
            }
            double f = Mathf.Repeat(lst, 1f);
            double sol = MarsEphemeris.SolDays;
            double baseRise = f < 0.75 ? 0.25 : 1.25;
            rise = d + (baseRise - f) * sol;
            set = d + (baseRise + 0.5 - f) * sol;
            return true;
        }

        private static int UtcSecondOfDay(double days)
        {
            if (double.IsNaN(days) || double.IsInfinity(days))
            {
                return -1;
            }
            DateTime u = MarsEphemeris.UtcFromDaysTT(days);
            return u.Hour * 3600 + u.Minute * 60 + u.Second;
        }

        private static string Minutes(int minutes)
        {
            if (minutes < 60)
            {
                return minutes.ToString(Inv) + " min";
            }
            return (minutes / 60).ToString(Inv) + " h " + (minutes % 60).ToString("00", Inv) + " min";
        }

        private static string Km(int tenths)
        {
            return (tenths / 10).ToString(Inv) + "." + (tenths % 10).ToString(Inv);
        }

        // "HH:MM:SS" + suffix, from one reused char buffer (one string per change).
        private static string Hms(int seconds, string suffix)
        {
            int i = PutHms(s_Chars, 0, seconds);
            i = Put(s_Chars, i, suffix);
            return new string(s_Chars, 0, i);
        }

        // "HH:MM:SS UTC  DD Mon YYYY"
        private static string UtcStamp(DateTime u)
        {
            char[] b = s_Chars;
            int i = PutHms(b, 0, u.Hour * 3600 + u.Minute * 60 + u.Second);
            i = Put(b, i, " UTC  ");
            i = Put2(b, i, u.Day);
            b[i++] = ' ';
            i = Put(b, i, Months[Mathf.Clamp(u.Month - 1, 0, 11)]);
            b[i++] = ' ';
            int y = Mathf.Clamp(u.Year, 0, 9999);
            i = Put2(b, i, y / 100);
            i = Put2(b, i, y % 100);
            return new string(b, 0, i);
        }

        private static int PutHms(char[] b, int i, int seconds)
        {
            i = Put2(b, i, seconds / 3600 % 100);
            b[i++] = ':';
            i = Put2(b, i, seconds / 60 % 60);
            b[i++] = ':';
            return Put2(b, i, seconds % 60);
        }

        private static int Put2(char[] b, int i, int v)
        {
            b[i] = (char)('0' + v / 10 % 10);
            b[i + 1] = (char)('0' + v % 10);
            return i + 2;
        }

        private static int Put(char[] b, int i, string s)
        {
            if (s == null)
            {
                return i;
            }
            for (int k = 0; k < s.Length && i < b.Length; k++)
            {
                b[i++] = s[k];
            }
            return i;
        }

        private static bool Finite(float v)
        {
            return !float.IsNaN(v) && !float.IsInfinity(v);
        }
    }
}

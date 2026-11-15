using System;
using System.Collections.Generic;
using System.Globalization;
using NasaSpaceApp.Homeline.Sim;
using NasaSpaceApp.HUD;
using NasaSpaceApp.Menu;
using UnityEngine;
using UnityEngine.InputSystem;

namespace NasaSpaceApp.Mission
{
    /// <summary>
    /// Walks the route of a web mission by itself: the same thing as the replay of the built-in plans
    /// (Homeline/Sim/EvaDriver.cs), for a mission that comes from the planner (<see cref="MissionLink"/>).
    ///
    /// AUTO WALK (the state a mission starts in): the crew is carried along the planned route at the planned times,
    /// with the planned stop at each waypoint. The EVA clock runs at 1, 30, 60 or 300 times real time; the suit model
    /// follows it through <see cref="SuitTelemetry.MissionTimeScale"/> and takes the planned oxygen rate of the leg
    /// through <see cref="SuitTelemetry.MissionActivityVo2"/>, so the mission HUD compares the plan with a walk that is
    /// on time. The player can look around; walking input has no effect.
    /// FREE WALK: nothing here touches the player; the mission is tracked as before.
    /// Keys: V switches between the two, T pauses or resumes the auto walk, [ and ] change its speed. Going back to
    /// the auto walk resumes from the point of the route the crew is nearest to.
    ///
    /// Nothing of the mission link, the tracker or the HUD is changed: on rails this component re-places the player
    /// every LateUpdate, before the HUD (execution order 100) reads the position. Started from code, once per run.
    /// Off with -noAutoWalk; under -homelineSelfTest a mission starts in free walk.
    /// </summary>
    [DefaultExecutionOrder(-10)]
    public sealed class MissionAutoWalk : MonoBehaviour
    {
        static readonly double[] Speeds = { 1, 30, 60, 300 };
        const double DefaultSpeed = 60;            // as the replay of the built-in plans
        const float FeetLift = 0.08f;              // keeps the capsule clear of the terrain when placed
        const float YawRateDegPerSec = 120f, YawSmoothSeconds = 0.30f;
        const float LookHoldSeconds = 2.5f;        // after a mouse look, the camera is left alone this long
        const float BumpEaseSeconds = 0.12f, BumpDipM = 0.25f;
        const float FallbackPaceMPerMin = MissionTracker.FallbackPaceMPerMin;

        public static MissionAutoWalk Instance { get; private set; }

        /// <summary>True while the crew is carried along the route; false in free walk and without a mission.</summary>
        public bool Following { get; private set; }
        /// <summary>False while the auto walk is paused (key T).</summary>
        public bool Playing { get; private set; }
        public double Speed { get; private set; }
        /// <summary>Where the auto walk is on the planned timeline, EVA minutes; and the planned minute of the return.</summary>
        public double RouteMin { get { return tau; } }
        public double EndMin { get { return endMin; } }
        /// <summary>A mission with a route to follow is loaded.</summary>
        public bool HasRoute { get { return plan != null && count >= 2; } }

        MissionPlan plan;
        bool startFollowing = true, keysOff;
        double tau, endMin;
        // The planned walk as knots in time: position and oxygen used at each. A stop is two knots at one place.
        double[] knotT = new double[0];
        Vector3[] knotP = new Vector3[0];
        float[] knotO2 = new float[0];
        int count, cursor;

        FirstPersonController player;
        CharacterController body;
        GroundSampler ground;
        DayNightCycle sky;
        bool skyOnEvaClock;
        double skyFlow = 1;
        Func<float?> activityHook;
        float lastSetYaw, lookHeldUntil, yawVelocity, easedY;
        bool hasEasedY;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            Instance = null;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot()
        {
            if (Instance != null) return;
            string[] args = Environment.GetCommandLineArgs();
            if (Array.IndexOf(args, "-noAutoWalk") >= 0 || Application.isBatchMode) return;
            var go = new GameObject("MissionAutoWalk");
            DontDestroyOnLoad(go);
            MissionAutoWalk walk = go.AddComponent<MissionAutoWalk>();
            // Unattended runs: keys typed by someone at the PC must not change the run. The planner self-test drives the
            // player itself, so a mission starts in free walk there.
            bool selfTest = Array.IndexOf(args, "-homelineSelfTest") >= 0;
            walk.keysOff = selfTest || Array.IndexOf(args, "-marvisWebTest") >= 0;
            walk.startFollowing = !selfTest;
            Instance = walk;
        }

        void Awake()
        {
            Speed = DefaultSpeed;
            Playing = true;
            activityHook = ActivityVo2;
            MissionLink.Changed += OnMissionChanged;
        }

        void Start()
        {
            if (plan == null && MissionLink.Current != null) OnMissionChanged(MissionLink.Current);
        }

        void OnDestroy()
        {
            MissionLink.Changed -= OnMissionChanged;
            ReleaseSuit();
            if (Instance == this) Instance = null;
        }

        // A mission was loaded (or re-built for a new scene), or cleared (null).
        void OnMissionChanged(MissionPlan loaded)
        {
            plan = loaded;
            player = null;
            body = null;
            ground = null;
            hasEasedY = false;
            lookHeldUntil = 0f;
            tau = 0;
            cursor = 0;
            Speed = DefaultSpeed;
            Playing = true;
            if (loaded == null)
            {
                count = 0;
                Following = false;
                ReleaseSuit();
                return;   // the mission link has already given the sky back to the scene's own clock
            }
            BuildSchedule(loaded);
            Following = startFollowing && count >= 2;
            SuitTelemetry.MissionActivityVo2 = activityHook;
            sky = FindAnyObjectByType<DayNightCycle>();
            // The mission link put the sky on a real-time sol: then it can follow the EVA clock at the walk's speed.
            skyOnEvaClock = sky != null && Mathf.Abs(sky.SolDuration - (float)MarsClock.SolSeconds) < 1f;
            skyFlow = 1;
            Debug.Log(string.Format(CultureInfo.InvariantCulture,
                "[Mission] auto walk: route of {0} points, planned return at EVA minute {1:0.0}; {2}",
                count, endMin, Following ? "following at " + Speed.ToString("0", CultureInfo.InvariantCulture) + "x (V = free walk)" : "free walk"));
        }

        void ReleaseSuit()
        {
            if (SuitTelemetry.MissionActivityVo2 == activityHook) SuitTelemetry.MissionActivityVo2 = null;
            SuitTelemetry.MissionTimeScale = 1f;
        }

        // ---------------------------------------------------------------- control

        /// <summary>Switches between the auto walk and the free walk. The auto walk resumes where the crew is on the route.</summary>
        public void SetFollowing(bool on)
        {
            if (plan == null || count < 2 || on == Following) return;
            Following = on;
            Playing = true;
            hasEasedY = false;
            lookHeldUntil = 0f;
            if (on)
            {
                MissionTracker tracker = Tracker();
                if (tracker != null && !float.IsNaN(tracker.PlannedMin))
                    tau = Math.Max(0, Math.Min(endMin, tracker.PlannedMin));
                cursor = 0;
            }
            Debug.Log("[Mission] auto walk " + (on ? "on, from EVA minute " + tau.ToString("0.0", CultureInfo.InvariantCulture) + " of the plan" : "off: free walk"));
        }

        public void SetSpeed(double speed)
        {
            Speed = Math.Max(1, speed);
        }

        public void SetPlaying(bool playing)
        {
            Playing = playing;
        }

        void ReadKeys()
        {
            if (keysOff) return;
            Keyboard k = Keyboard.current;
            if (k == null) return;
            if (k.vKey.wasPressedThisFrame) SetFollowing(!Following);
            if (!Following) return;
            if (k.tKey.wasPressedThisFrame) Playing = !Playing;
            if (k.rightBracketKey.wasPressedThisFrame) StepSpeed(1);
            if (k.leftBracketKey.wasPressedThisFrame) StepSpeed(-1);
        }

        void StepSpeed(int dir)
        {
            int at = 0;
            for (int i = 0; i < Speeds.Length; i++)
                if (Speeds[i] <= Speed) at = i;
            Speed = Speeds[Mathf.Clamp(at + dir, 0, Speeds.Length - 1)];
        }

        static MissionTracker Tracker()
        {
            HelmetHud hud = HelmetHud.Instance;
            return hud != null && hud.Context != null ? hud.Context.Mission : null;
        }

        bool Complete()
        {
            MissionTracker tracker = Tracker();
            return tracker != null && tracker.Plan == plan && tracker.Complete;
        }

        // ---------------------------------------------------------------- per frame

        void Update()
        {
            if (plan == null || count < 2 || MarvisMenu.IsOpen) return;   // scaled time stands still under the menu
            ReadKeys();

            bool complete = Complete();
            bool running = Following && Playing && !complete && tau < endMin;
            if (running) tau = Math.Min(endMin, tau + Time.deltaTime / 60.0 * Speed);
            // The suit and the mission clock run at the walk's speed; a paused walk stops them. At the end of the route,
            // in free walk and after the EVA they run in real time.
            float scale = !Following || complete || tau >= endMin ? 1f : (running ? (float)Speed : 0f);
            SuitTelemetry.MissionTimeScale = scale;
            SetSkyFlow(scale > 1f ? scale : 1.0);
        }

        void LateUpdate()
        {
            if (plan == null || !Following || count < 2 || Complete()) return;
            if (player == null)
            {
                player = FindAnyObjectByType<FirstPersonController>();
                body = player != null ? player.GetComponent<CharacterController>() : null;
                if (player == null) return;
                lastSetYaw = player.transform.eulerAngles.y;
            }
            Vector3 p;
            float bearing;
            bool moving = Sample(tau, out p, out bearing);
            Place(p);
            if (!MarvisMenu.IsOpen && moving) FollowHeading(bearing);
        }

        // The sky follows the EVA clock: a sol passes Speed times faster while the walk runs faster than real time.
        void SetSkyFlow(double flow)
        {
            if (!skyOnEvaClock || sky == null || flow == skyFlow) return;
            skyFlow = flow;
            sky.SolDuration = (float)(MarsClock.SolSeconds / flow);
        }

        /// <summary>
        /// The planned oxygen rate of what the crew is doing now on the route, as mL of O2 per kg of body mass per
        /// minute, for the helmet's physiology: on rails the helmet sees no steps. Null = the helmet's own estimate.
        /// </summary>
        float? ActivityVo2()
        {
            if (plan == null || !Following || count < 2 || tau >= endMin) return null;
            int i = Segment(tau);
            double dt = knotT[i + 1] - knotT[i];
            double rate;
            if (dt > 1e-6 && !float.IsNaN(knotO2[i]) && !float.IsNaN(knotO2[i + 1])) rate = (knotO2[i + 1] - knotO2[i]) / dt;
            else if (Flat(knotP[i], knotP[i + 1]) < 0.05f) rate = plan.Constants.StationRateLMin;   // a stop
            else return null;
            if (!(rate >= 0)) return null;
            return (float)(rate * 1000.0 / SuitTelemetry.BodyMassKg);
        }

        // ---------------------------------------------------------------- the planned walk in time

        void BuildSchedule(MissionPlan p)
        {
            var t = new List<double>();
            var pos = new List<Vector3>();
            var o2 = new List<float>();
            Vector3[] route = p.Route;
            int n = route != null ? route.Length : 0;
            double clock = 0;
            Vector3 at = p.PadWorld;
            float used = 0f;

            void Add(double time, Vector3 where, float oxygen)
            {
                if (double.IsNaN(time) || time < clock) time = clock;   // never backwards
                t.Add(time);
                pos.Add(where);
                o2.Add(oxygen);
                clock = time;
                at = where;
                if (!float.IsNaN(oxygen)) used = oxygen;
            }

            Add(0, at, 0f);
            foreach (MissionLeg leg in p.Legs)
            {
                // The leg leaves when the plan says: until then the crew stays where the last leg ended (the stop).
                double start = float.IsNaN(leg.StartMin) ? clock : Math.Max(clock, leg.StartMin);
                bool routed = leg.Routed && leg.FirstPoint >= 0 && leg.PointCount >= 2 && leg.FirstPoint + 1 < n;
                int first = leg.FirstPoint, last = routed ? Math.Min(n - 1, leg.FirstPoint + leg.PointCount - 1) : -1;
                Vector3 from = routed ? route[first] : at;
                Vector3 to = routed ? route[last] : TargetOf(p, leg.To);
                float length = routed ? p.RouteS[last] - p.RouteS[first] : Flat(from, to);
                double end = !float.IsNaN(leg.EndMin) ? leg.EndMin
                           : !float.IsNaN(leg.TimeMin) ? start + leg.TimeMin
                           : start + length / FallbackPaceMPerMin;
                if (end < start) end = start;

                if (start > clock + 1e-6)
                {
                    // Oxygen used at the end of the stop: the plan's value, else the station rate for the time stood.
                    float leaving = float.NaN;
                    MissionWaypoint w = WaypointOf(p, leg.From);
                    if (w != null && !float.IsNaN(w.O2UsedAtLeaveL)) leaving = w.O2UsedAtLeaveL;
                    else if (routed && !float.IsNaN(p.RouteO2Used[first])) leaving = p.RouteO2Used[first];
                    else leaving = used + (float)((start - clock) * p.Constants.StationRateLMin);
                    Add(start, at, leaving);
                }
                if (routed)
                {
                    for (int i = first; i <= last; i++)
                    {
                        double time = p.RouteT[i];
                        if (float.IsNaN(p.RouteT[i]) || time < start - 1e-3 || time > end + 1e-3)
                            time = length > 0.01f ? start + (end - start) * (p.RouteS[i] - p.RouteS[first]) / length : start;
                        Add(time, route[i], p.RouteO2Used[i]);
                    }
                    if (end > clock + 1e-6) Add(end, route[last], float.NaN);
                }
                else
                {
                    Add(end, to, !float.IsNaN(leg.O2L) ? used + leg.O2L : float.NaN);
                }
            }

            count = t.Count;
            knotT = t.ToArray();
            knotP = pos.ToArray();
            knotO2 = o2.ToArray();
            endMin = count > 0 ? knotT[count - 1] : 0;
            cursor = 0;
            if (endMin <= 0) count = 0;   // no times and no distance: nothing to follow
        }

        static MissionWaypoint WaypointOf(MissionPlan p, string id)
        {
            if (string.IsNullOrEmpty(id) || !id.StartsWith("wp", StringComparison.Ordinal)) return null;
            int index;
            if (!int.TryParse(id.Substring(2), NumberStyles.Integer, CultureInfo.InvariantCulture, out index)) return null;
            foreach (MissionWaypoint w in p.Waypoints)
                if (w.Index == index) return w;
            return null;
        }

        static Vector3 TargetOf(MissionPlan p, string id)
        {
            MissionWaypoint w = WaypointOf(p, id);
            return w != null ? w.World : p.PadWorld;
        }

        static float Flat(Vector3 a, Vector3 b)
        {
            float dx = a.x - b.x, dz = a.z - b.z;
            return Mathf.Sqrt(dx * dx + dz * dz);
        }

        // Index i of the knots i, i+1 that hold time t (count >= 2).
        int Segment(double t)
        {
            int i = Mathf.Clamp(cursor, 0, count - 2);
            while (i > 0 && t < knotT[i]) i--;
            while (i < count - 2 && t >= knotT[i + 1]) i++;
            cursor = i;
            return i;
        }

        // Where the crew is at EVA minute t of the plan, and the bearing of the walk there (false while standing).
        bool Sample(double t, out Vector3 p, out float bearingDeg)
        {
            int i = Segment(t);
            double span = knotT[i + 1] - knotT[i];
            float u = span > 1e-9 ? Mathf.Clamp01((float)((t - knotT[i]) / span)) : 1f;
            Vector3 a = knotP[i], b = knotP[i + 1];
            p = Vector3.Lerp(a, b, u);
            bearingDeg = 0f;
            float dx = b.x - a.x, dz = b.z - a.z;
            if (dx * dx + dz * dz < 0.04f || t >= endMin) return false;
            bearingDeg = Mathf.Repeat(Mathf.Atan2(dx, dz) * Mathf.Rad2Deg, 360f);
            return true;
        }

        // ---------------------------------------------------------------- the player on rails (as EvaDriver does)

        void Place(Vector3 p)
        {
            if (ground == null) ground = new GroundSampler();
            float groundY;
            bool detailed;
            if (!ground.TryHeight(p.x, p.z, out groundY, out detailed)) groundY = p.y;
            // Faster than real time the ground passes several metres per frame: the eye height is eased over the bumps
            // (never more than BumpDipM below the ground); at 1x it is exact.
            float y = groundY;
            if (Speed > 1.5 && Playing && hasEasedY)
            {
                easedY += (groundY - easedY) * (1f - Mathf.Exp(-Time.unscaledDeltaTime / BumpEaseSeconds));
                y = Mathf.Max(groundY - BumpDipM, easedY);
            }
            easedY = y;
            hasEasedY = true;
            bool was = body != null && body.enabled;
            if (body != null) body.enabled = false;
            player.transform.position = new Vector3(p.x, y + FeetLift, p.z);
            if (body != null) body.enabled = was;
        }

        // Turns the player towards the direction of travel, unless they are looking around with the mouse.
        void FollowHeading(float bearingDeg)
        {
            float yaw = player.transform.eulerAngles.y;
            if (Mathf.Abs(Mathf.DeltaAngle(yaw, lastSetYaw)) > 0.05f) lookHeldUntil = Time.unscaledTime + LookHoldSeconds;
            if (Time.unscaledTime >= lookHeldUntil)
            {
                yaw = Mathf.SmoothDampAngle(yaw, bearingDeg, ref yawVelocity, YawSmoothSeconds, YawRateDegPerSec, Time.unscaledDeltaTime);
                player.transform.rotation = Quaternion.Euler(0f, yaw, 0f);
            }
            lastSetYaw = player.transform.eulerAngles.y;
        }

        // ---------------------------------------------------------------- the hint on screen

        GUIStyle titleStyle, textStyle, keyStyle;
        Texture2D white;
        int styledFor;

        void OnGUI()
        {
            if (plan == null || count < 2 || MarvisMenu.IsOpen || Event.current.type != EventType.Repaint) return;
            HelmetHud hud = HelmetHud.Instance;
            if (hud == null || hud.Context == null || hud.Context.MapScreenOpen || Complete()) return;
            float s = Mathf.Max(0.75f, Screen.height / 1080f);
            EnsureStyles(hud.Context.Skin, s);

            string title = !Following ? "FREE WALK"
                         : tau >= endMin ? "AUTO WALK · END OF ROUTE"
                         : Playing ? "AUTO WALK · " + Speed.ToString("0", CultureInfo.InvariantCulture) + "x"
                         : "AUTO WALK · PAUSED";
            // Pairs: key cap, what it does.
            string[] hints = Following
                ? new[] { "V", "walk yourself", "T", Playing ? "pause" : "resume", "[ ]", "speed" }
                : new[] { "V", "follow the route" };

            float pad = 10f * s, gap = 8f * s, capPad = 6f * s, height = 30f * s;
            float width = pad + titleStyle.CalcSize(new GUIContent(title)).x + gap * 1.5f;
            for (int i = 0; i < hints.Length; i += 2)
                width += keyStyle.CalcSize(new GUIContent(hints[i])).x + capPad * 2f + gap * 0.6f
                       + textStyle.CalcSize(new GUIContent(hints[i + 1])).x + gap * 1.4f;
            width += pad - gap * 1.4f;
            var box = new Rect((Screen.width - width) * 0.5f, Screen.height - height - 28f * s, width, height);
            GUI.DrawTexture(box, white, ScaleMode.StretchToFill, true, 0f, HudTokens.Scrim, 0f, 8f * s);

            float x = box.x + pad;
            var c = new GUIContent(title);
            float w = titleStyle.CalcSize(c).x;
            GUI.Label(new Rect(x, box.y, w, height), c, titleStyle);
            x += w + gap * 1.5f;
            for (int i = 0; i < hints.Length; i += 2)
            {
                c = new GUIContent(hints[i]);
                w = keyStyle.CalcSize(c).x + capPad * 2f;
                var cap = new Rect(x, box.y + 6f * s, w, height - 12f * s);
                GUI.DrawTexture(cap, white, ScaleMode.StretchToFill, true, 0f, HudTokens.KeycapFill, 0f, 4f * s);
                GUI.Label(cap, c, keyStyle);
                x += w + gap * 0.6f;
                c = new GUIContent(hints[i + 1]);
                w = textStyle.CalcSize(c).x;
                GUI.Label(new Rect(x, box.y, w, height), c, textStyle);
                x += w + gap * 1.4f;
            }
        }

        void EnsureStyles(HudSkin skin, float s)
        {
            int size = Mathf.RoundToInt(14f * s);
            if (titleStyle != null && styledFor == size) return;
            styledFor = size;
            if (white == null)
            {
                white = new Texture2D(1, 1, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
                white.SetPixel(0, 0, Color.white);
                white.Apply();
            }
            Font medium = skin != null ? skin.Medium : null, regular = skin != null ? skin.Regular : null;
            titleStyle = new GUIStyle { font = medium, fontSize = size, alignment = TextAnchor.MiddleLeft, wordWrap = false };
            titleStyle.normal.textColor = HudTokens.InkPrimary;
            textStyle = new GUIStyle { font = regular, fontSize = size, alignment = TextAnchor.MiddleLeft, wordWrap = false };
            textStyle.normal.textColor = HudTokens.InkSecondary;
            keyStyle = new GUIStyle { font = medium, fontSize = Mathf.RoundToInt(12f * s), alignment = TextAnchor.MiddleCenter, wordWrap = false };
            keyStyle.normal.textColor = HudTokens.KeycapInk;
        }
    }
}

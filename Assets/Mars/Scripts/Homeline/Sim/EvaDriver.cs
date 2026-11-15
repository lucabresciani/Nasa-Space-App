using System.Collections.Generic;
using System.Globalization;
using NasaSpaceApp.Homeline.Flow;
using NasaSpaceApp.Homeline.World;
using NasaSpaceApp.HUD;
using NasaSpaceApp.Menu;
using UnityEngine;
using UnityEngine.InputSystem;

namespace NasaSpaceApp.Homeline.Sim
{
    /// <summary>
    /// Runs the EVA of the plan chosen on the planning screen.
    ///
    /// REPLAY: the crew is carried along the planner's route at the planner's times (positions and times are the
    /// engine's; nothing is re-routed). O2 and margin are the planner's timeline values. The EVA clock runs at 1, 30,
    /// 60 or 300 times real time on scaled game time, so it stops while the menu is open. The player can look around;
    /// walking input has no effect.
    /// FREE WALK: the player walks from where they are, at real time, no faster than the planner's governed speed
    /// for the slope. O2 is accounted with the planner's model from the ground actually walked
    /// (<see cref="LiveState"/>), starting from the plan's state at the moment the player took over.
    ///
    /// The helmet HUD is fed through SuitTelemetry.AfterTick: home is the plan's pad, O2 left, O2 minutes to reserve
    /// and mission time are the plan's (replay) or the live model's (free walk). Heart rate, CO2, battery, weather
    /// and dose rate stay the game's own simulation.
    /// The player controller is not modified: on rails this component re-places the player every LateUpdate, and the
    /// speed cap is written to the controller's serialized speeds.
    /// Keys: [ and ] replay speed, T play/pause, V switch between replay and free walk.
    /// </summary>
    [DefaultExecutionOrder(0)]
    public sealed class EvaDriver : MonoBehaviour
    {
        static readonly double[] Speeds = { 1, 30, 60, 300 };
        const double DefaultSpeed = 60;          // the planner's config/hud.yaml default_speed
        const float FeetLift = 0.08f;            // keeps the capsule clear of the terrain when placed
        const float YawRateDegPerSec = 120f;
        const float LookHoldSeconds = 2.5f;      // after a mouse look, the camera is left alone this long
        const float FallGuardDrop = 40f;         // free walk: this far below the ground = fell through
        const float CapRefreshSeconds = 0.25f;
        const double AssumedNoGoCrawlMs = 0.3;   // ASSUMPTION: speed left to the player on a slope the variant forbids

        public MissionPlan Plan { get; private set; }
        public EvaMode Mode { get; private set; }
        /// <summary>EVA clock, minutes since the start of the EVA.</summary>
        public double TMin { get; private set; }
        public double Speed { get; private set; }
        public bool Playing { get; private set; }
        /// <summary>True once the replay has reached the planned return to the pad.</summary>
        public bool ReplayFinished { get; private set; }
        /// <summary>The player in the plan's frame (metres east and north of the official pad); valid while a mission runs.</summary>
        public double LocalX { get; private set; }
        public double LocalY { get; private set; }
        public bool OnDetailedTerrain { get; private set; }
        public bool Active { get { return Plan != null && Mode != EvaMode.None; } }

        /// <summary>The free-walk O2 accounting; null when the planner's model is not available (no official bundle).</summary>
        public LiveState Live { get; private set; }
        /// <summary>True while O2 comes from the live planner model (free walk with the model available).</summary>
        public bool LiveO2 { get { return Mode == EvaMode.FreeWalk && Live != null; } }

        /// <summary>O2 left now, litres: the plan's (replay), the live model's (free walk), or null (free walk without the model).</summary>
        public double? O2LeftL
        {
            get
            {
                if (!Active) return null;
                if (Mode == EvaMode.Replay) return Plan.O2LeftAt(TMin);
                return Live != null ? (double?)Live.O2LeftL : null;
            }
        }

        /// <summary>Time and O2 to get home from where the player stands (planner return fields); null off the official plan.</summary>
        public double? THomeMin { get; private set; }
        public double? O2HomeL { get; private set; }
        /// <summary>Free walk on the official plan: min of the O2, daylight and EVA-duration terms (the dose term is not modelled live).</summary>
        public double? LiveMarginMin { get; private set; }
        public string LiveBinding { get; private set; }

        FirstPersonController player;
        CharacterController body;
        GroundSampler ground;
        RouteWorldView view;
        float lastSetYaw;
        float lookHeldUntil;
        Vector3 lastSafe;
        float groundY;
        float nextCapAt;
        double originalWalk = -1, originalSprint = -1;
        double appliedCap = -1;
        readonly SkySync sky = new SkySync();
        bool skyForce;

        void Awake()
        {
            Speed = DefaultSpeed;
        }

        public void StartMission(MissionPlan plan, EvaMode mode)
        {
            if (plan == null || mode == EvaMode.None) return;
            if (Active) StopMission();
            player = FindAnyObjectByType<FirstPersonController>();
            body = player != null ? player.GetComponent<CharacterController>() : null;
            if (player == null)
            {
                Debug.LogError("[HOMELINE] no player in the scene: the EVA cannot start");
                return;
            }
            ground = new GroundSampler();
            if (view == null) view = RouteWorldView.Create(transform);
            view.Show(plan, ground);

            Plan = plan;
            Mode = mode;
            TMin = plan.Track.StartMin;
            Speed = DefaultSpeed;
            Playing = true;
            ReplayFinished = false;
            originalWalk = originalSprint = -1;
            ReadOriginalSpeeds();

            HomelineApp app = HomelineApp.Instance;
            Live = null;
            if (app != null && app.Physio != null && app.Config != null)
            {
                var stations = new List<LiveStation>();
                foreach (Waypoint w in plan.Waypoints.Main)
                    if (w.Kind == WaypointKind.Station && w.LeaveMin.HasValue)
                        stations.Add(new LiveStation { Id = w.Id, X = w.X, Y = w.Y, DwellMin = w.LeaveMin.Value - w.ArriveMin });
                Live = new LiveState(app.Physio, app.Config.O2CapacityL, app.Config.TaskRateLMin, stations);
                ResetLiveFromPlan();
            }

            RoutePose pose = plan.Track.PoseAt(TMin);
            Place(pose.X, pose.Y);
            if (pose.HeadingDeg.HasValue) SetYaw((float)pose.HeadingDeg.Value);

            // Home for the helmet HUD and the map: this plan's pad.
            double hx, hz;
            plan.Frame.LocalToWorld(plan.Route.PadX, plan.Route.PadY, out hx, out hz);
            SuitTelemetry.HomeXZ = new Vector2((float)hx, (float)hz);
            SuitTelemetry.AfterTick = FeedHelmet;
            skyForce = true;
            Debug.Log("[HOMELINE] EVA started: plan " + plan.Entry.Id + ", mode " + mode + ", live O2 model " + (Live != null ? "yes" : "no"));
        }

        public void StopMission()
        {
            RestoreSpeeds();
            if (Plan != null)
            {
                sky.Release();
                SuitTelemetry.AfterTick = null;
                SuitTelemetry.HomeXZ = Vector2.zero;
            }
            Plan = null;
            Mode = EvaMode.None;
            Live = null;
            player = null;
            body = null;
            THomeMin = O2HomeL = LiveMarginMin = null;
            LiveBinding = null;
            if (view != null) view.Clear();
        }

        public void SetMode(EvaMode mode)
        {
            if (!Active || mode == EvaMode.None || mode == Mode) return;
            Mode = mode;
            Playing = true;
            if (mode == EvaMode.FreeWalk) ResetLiveFromPlan();
            else RestoreSpeeds();
        }

        public void SetSpeed(double speed)
        {
            Speed = speed;
        }

        public void Seek(double tMin)
        {
            if (Plan == null) return;
            TMin = System.Math.Max(Plan.Track.StartMin, System.Math.Min(Plan.EndMin, tMin));
            ReplayFinished = TMin >= Plan.EndMin;
            skyForce = true;
        }

        /// <summary>The sun of this minute of the plan: the scene's sky follows the EVA clock, at the EVA's speed.</summary>
        void SyncSky()
        {
            HomelineApp app = HomelineApp.Instance;
            if (app == null || !app.EvaStartUtc.HasValue) return;
            double flow = Mode == EvaMode.Replay ? (Playing && !ReplayFinished ? Speed : 0) : 1;
            sky.Apply(app.EvaStartUtc.Value, TMin, flow, skyForce);
            skyForce = false;
        }

        /// <summary>The free walk starts from the plan's state at the current EVA time: O2 used so far, stations already left.</summary>
        void ResetLiveFromPlan()
        {
            if (Live == null || Plan == null) return;
            HomelineApp app = HomelineApp.Instance;
            double capacity = app.Config.O2CapacityL;
            double? planned = Plan.O2LeftAt(TMin);
            double t = TMin;
            var leftAt = new Dictionary<string, double>();
            foreach (Waypoint w in Plan.Waypoints.Main)
                if (w.Kind == WaypointKind.Station && w.LeaveMin.HasValue) leftAt[w.Id] = w.LeaveMin.Value;
            Live.Reset(t, planned.HasValue ? capacity - planned.Value : 0, st =>
            {
                double leave;
                return leftAt.TryGetValue(st.Id, out leave) && leave <= t + 1e-9;
            });
        }

        void Update()
        {
            if (!Active || MartisMenu.IsOpen) return;
            if (player == null)
            {
                StopMission();
                return;
            }
            ReadKeys();

            // Scaled time: the menu sets Time.timeScale to 0 while it is open.
            if (Mode == EvaMode.Replay)
            {
                if (Playing && !ReplayFinished)
                {
                    TMin += Time.deltaTime / 60.0 * Speed;
                    if (TMin >= Plan.EndMin)
                    {
                        TMin = Plan.EndMin;
                        ReplayFinished = true;
                        Playing = false;
                    }
                }
            }
            else if (Live == null)
            {
                TMin += Time.deltaTime / 60.0;
            }
        }

        void LateUpdate()
        {
            if (!Active || player == null) return;
            SyncSky();
            if (Mode == EvaMode.Replay)
            {
                RoutePose pose = Plan.Track.PoseAt(TMin);
                Place(pose.X, pose.Y);
                if (!MartisMenu.IsOpen && pose.HeadingDeg.HasValue) FollowHeading((float)pose.HeadingDeg.Value);
                THomeMin = Plan.THomeAt(LocalX, LocalY);
                O2HomeL = Plan.O2HomeAt(LocalX, LocalY);
                LiveMarginMin = null;
                LiveBinding = null;
                return;
            }

            Vector3 p = player.transform.position;
            double x, y;
            Plan.Frame.WorldToLocal(p.x, p.z, out x, out y);
            LocalX = x;
            LocalY = y;
            bool detailed;
            if (ground.TryHeight(p.x, p.z, out groundY, out detailed))
            {
                OnDetailedTerrain = detailed;
                if (p.y < groundY - FallGuardDrop) MoveBody(lastSafe);
                else if (body == null || body.isGrounded) lastSafe = p;
            }

            if (Live != null && !MartisMenu.IsOpen && Time.deltaTime > 0f)
            {
                Live.Step(Time.deltaTime, x, y, groundY);
                TMin = Live.TMin;
                if (Time.unscaledTime >= nextCapAt)
                {
                    nextCapAt = Time.unscaledTime + CapRefreshSeconds;
                    ApplySpeedCap();
                }
            }
            UpdateLiveMargin();
        }

        /// <summary>
        /// The planner's margin terms that can be evaluated from the live state (pipeline/engine/margin.py):
        /// O2 = (O2 left - O2 home - station work left - reserve) / effort rate; daylight = t_dark - t - T_home;
        /// EVA duration = budget - t - T_home. The dose term needs the storm replay and is not evaluated live.
        /// </summary>
        void UpdateLiveMargin()
        {
            THomeMin = Plan.THomeAt(LocalX, LocalY);
            O2HomeL = Plan.O2HomeAt(LocalX, LocalY);
            LiveMarginMin = null;
            LiveBinding = null;
            HomelineApp app = HomelineApp.Instance;
            if (Live == null || app == null || app.Config == null || !THomeMin.HasValue || !O2HomeL.HasValue) return;

            double tasksLeft = Live.AtStation != null ? (Live.AtStation.DwellMin - Live.AtStation.WorkedMin) * app.Config.TaskRateLMin : 0;
            double best = (Live.O2LeftL - O2HomeL.Value - tasksLeft - app.Config.O2ReserveL) / app.Config.EffortRateLMin;
            string binding = "O2";
            if (app.TDarkMin.HasValue)
            {
                double daylight = app.TDarkMin.Value - TMin - THomeMin.Value;
                if (daylight < best)
                {
                    best = daylight;
                    binding = "daylight";
                }
            }
            double duration = app.Config.EvaBudgetMin - TMin - THomeMin.Value;
            if (duration < best)
            {
                best = duration;
                binding = "EVA duration";
            }
            LiveMarginMin = best;
            LiveBinding = binding;
        }

        /// <summary>Mission layer of the helmet HUD: overwrites the suit simulation's O2 and mission time with the plan's.</summary>
        void FeedHelmet(SuitTelemetry t)
        {
            if (!Active) return;
            t.MetSeconds = (float)(TMin * 60.0);
            t.MetState = t.MetSeconds >= SuitTelemetry.MetWarningS ? HudSeverity.Warning
                       : t.MetSeconds >= SuitTelemetry.MetCautionS ? HudSeverity.Caution
                       : HudSeverity.Nominal;

            double? o2 = O2LeftL;
            if (!o2.HasValue) return; // free walk without the planner's model: the suit simulation stays in charge
            HomelineApp app = HomelineApp.Instance;
            bool cfg = app != null && app.Config != null;
            double capacity = cfg ? app.Config.O2CapacityL : SuitTelemetry.O2CapacityL;
            double reserve = cfg ? app.Config.O2ReserveL : SuitTelemetry.O2ReserveL;
            double effort = cfg ? app.Config.EffortRateLMin : 1.35;
            double rate;
            if (Mode == EvaMode.Replay)
            {
                // The plan's consumption rate around now, from its timeline.
                double? ahead = Plan.O2LeftAt(System.Math.Min(Plan.EndMin, TMin + 1.0));
                rate = ahead.HasValue ? System.Math.Max(0, o2.Value - ahead.Value) : 0;
            }
            else
            {
                rate = Live.RateLMin;
            }
            t.O2LeftL = (float)o2.Value;
            t.O2FlowLpm = (float)rate;
            t.O2PercentDisplay = Mathf.Clamp(Mathf.CeilToInt((float)(o2.Value / capacity * 100.0)), 0, 100);
            // "Minutes to reserve" at the planner's effort-capped rate: the O2 term only. The full margin and its
            // binding term are shown in the plan panel.
            t.O2MinutesToReserve = (float)System.Math.Max(0, (o2.Value - reserve) / effort);
            t.O2State = o2.Value <= reserve ? HudSeverity.Warning
                      : t.O2MinutesToReserve < SuitTelemetry.O2CautionMinutes ? HudSeverity.Caution
                      : HudSeverity.Nominal;
        }

        void ReadKeys()
        {
            Keyboard k = Keyboard.current;
            if (k == null) return;
            if (k.vKey.wasPressedThisFrame) SetMode(Mode == EvaMode.Replay ? EvaMode.FreeWalk : EvaMode.Replay);
            if (Mode != EvaMode.Replay) return;
            if (k.tKey.wasPressedThisFrame && !ReplayFinished) Playing = !Playing;
            if (k.rightBracketKey.wasPressedThisFrame) StepSpeed(1);
            if (k.leftBracketKey.wasPressedThisFrame) StepSpeed(-1);
        }

        void StepSpeed(int dir)
        {
            int at = 0;
            for (int i = 0; i < Speeds.Length; i++)
                if (Speeds[i] <= Speed) at = i;
            at = Mathf.Clamp(at + dir, 0, Speeds.Length - 1);
            Speed = Speeds[at];
        }

        /// <summary>Puts the player on the ground at a point of the plan's frame.</summary>
        void Place(double localX, double localY)
        {
            double wx, wz;
            Plan.Frame.LocalToWorld(localX, localY, out wx, out wz);
            bool detailed;
            ground.TryHeight((float)wx, (float)wz, out groundY, out detailed);
            OnDetailedTerrain = detailed;
            LocalX = localX;
            LocalY = localY;
            var p = new Vector3((float)wx, groundY + FeetLift, (float)wz);
            MoveBody(p);
            lastSafe = p;
        }

        void MoveBody(Vector3 p)
        {
            bool was = body != null && body.enabled;
            if (body != null) body.enabled = false;
            player.transform.position = p;
            if (body != null) body.enabled = was;
        }

        void SetYaw(float bearingDeg)
        {
            player.transform.rotation = Quaternion.Euler(0f, bearingDeg, 0f);
            lastSetYaw = player.transform.eulerAngles.y;
            lookHeldUntil = 0f;
        }

        /// <summary>Turns the player towards the direction of travel, unless they are looking around with the mouse.</summary>
        void FollowHeading(float bearingDeg)
        {
            float yaw = player.transform.eulerAngles.y;
            if (Mathf.Abs(Mathf.DeltaAngle(yaw, lastSetYaw)) > 0.05f) lookHeldUntil = Time.unscaledTime + LookHoldSeconds;
            if (Time.unscaledTime >= lookHeldUntil)
            {
                // Unscaled: at 300x the route turns faster than a comfortable camera could follow in scaled time.
                yaw = Mathf.MoveTowardsAngle(yaw, bearingDeg, YawRateDegPerSec * Time.unscaledDeltaTime);
                player.transform.rotation = Quaternion.Euler(0f, yaw, 0f);
            }
            lastSetYaw = player.transform.eulerAngles.y;
        }

        // ---- speed cap: the planner's governed speed, written to the controller's serialized speeds (no code edit there)

        void ReadOriginalSpeeds()
        {
            if (player == null || originalWalk > 0) return;
            try
            {
                Newtonsoft.Json.Linq.JToken j = HlJson.Parse(JsonUtility.ToJson(player));
                originalWalk = HlJson.NumOrNull(j, "walkSpeed") ?? -1;
                originalSprint = HlJson.NumOrNull(j, "sprintSpeed") ?? -1;
            }
            catch (System.Exception)
            {
                originalWalk = originalSprint = -1;
            }
        }

        void ApplySpeedCap()
        {
            if (player == null || Live == null || originalWalk <= 0) return;
            // The controller multiplies its level speed by 1 / 0.6 / 0.3 on slopes under 10 / 17 / 20 degrees
            // (FirstPersonController.SafeSpeedFactor): divide it out so the result is the planner's governed speed.
            double cap = Live.SpeedCapMs ?? AssumedNoGoCrawlMs;
            float slope = player.GroundSlope;
            double factor = slope < 10f ? 1.0 : slope < 17f ? 0.6 : 0.3;
            double level = System.Math.Min(3.0, cap / factor);
            if (System.Math.Abs(level - appliedCap) < 0.01) return;
            appliedCap = level;
            WriteSpeeds(level, level);
        }

        void RestoreSpeeds()
        {
            if (player != null && originalWalk > 0 && appliedCap > 0) WriteSpeeds(originalWalk, originalSprint > 0 ? originalSprint : originalWalk);
            appliedCap = -1;
        }

        void WriteSpeeds(double walk, double sprint)
        {
            string json = "{\"walkSpeed\":" + walk.ToString("0.###", CultureInfo.InvariantCulture) +
                          ",\"sprintSpeed\":" + sprint.ToString("0.###", CultureInfo.InvariantCulture) + "}";
            JsonUtility.FromJsonOverwrite(json, player);
        }
    }
}

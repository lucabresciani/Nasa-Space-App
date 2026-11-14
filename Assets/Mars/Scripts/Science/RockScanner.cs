using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;

namespace NasaSpaceApp.Science
{
    /// <summary>
    /// Raycasts from the center of the view and fetches the science data of the rock being looked at.
    /// UI-agnostic: a HUD panel subscribes to the events below (or polls the properties) and decides
    /// how to show <see cref="RockReading"/>s.
    ///
    /// Two steps:
    ///  - Targeting: every frame, the rock under the crosshair (within <see cref="Range"/>) becomes
    ///    <see cref="Target"/>; <see cref="TargetChanged"/> fires when it changes (null = no rock).
    ///  - Scanning: performing the "Player/Interact" action (E / gamepad north; Hold by default) on a
    ///    target fires <see cref="Scanned"/> and records the result in <see cref="ScanLog"/>.
    ///    Code can also call <see cref="ScanTarget"/>.
    /// </summary>
    [DisallowMultipleComponent]
    public class RockScanner : MonoBehaviour
    {
        [SerializeField, Tooltip("Ray origin and direction. Defaults to this object's Camera, or the main camera.")]
        Camera viewCamera;
        [SerializeField, Min(0.1f), Tooltip("Maximum scan distance in meters (Curiosity's ChemCam LIBS reaches ~7 m).")]
        float range = 7f;
        [SerializeField, Tooltip("Layers the ray can hit. Non-rock hits (terrain) block the ray.")]
        LayerMask layers = Physics.DefaultRaycastLayers;
        [SerializeField, Tooltip("Input action that triggers a scan of the current target.")]
        string scanActionPath = "Player/Interact";

        /// <summary>The rock under the crosshair, or null.</summary>
        public RockSample Target { get; private set; }
        /// <summary>Science values of <see cref="Target"/> (null when there is no target or no data).</summary>
        public RockReading TargetReading { get; private set; }
        /// <summary>Last ray hit on the target (point, normal, distance). Only meaningful while <see cref="Target"/> is set.</summary>
        public RaycastHit TargetHit { get; private set; }
        public float Range { get => range; set => range = Mathf.Max(0.1f, value); }

        /// <summary>0-1 progress of the scan action's hold interaction on the current target (0 when idle).</summary>
        public float ScanHoldProgress =>
            Target != null && scanAction != null && scanAction.IsInProgress() ? scanAction.GetTimeoutCompletionPercentage() : 0f;

        /// <summary>Every completed scan, oldest first.</summary>
        public IReadOnlyList<RockScanResult> ScanLog => scanLog;

        /// <summary>True if this rock has been scanned at least once.</summary>
        public bool HasScanned(RockSample rock) => rock != null && scannedRocks.Contains(rock);

        /// <summary>Fires when the targeted rock changes; the argument is the new target or null.</summary>
        public event Action<RockSample> TargetChanged;
        /// <summary>Fires when a scan completes.</summary>
        public event Action<RockScanResult> Scanned;

        readonly List<RockScanResult> scanLog = new List<RockScanResult>();
        readonly HashSet<RockSample> scannedRocks = new HashSet<RockSample>();
        InputAction scanAction;

        void Awake()
        {
            if (viewCamera == null) viewCamera = GetComponent<Camera>();
            if (viewCamera == null) viewCamera = Camera.main;
            if (!string.IsNullOrEmpty(scanActionPath)) scanAction = InputSystem.actions?.FindAction(scanActionPath);
            if (scanAction == null && !string.IsNullOrEmpty(scanActionPath))
                Debug.LogWarning($"[RockScanner] Input action '{scanActionPath}' not found; scanning only via ScanTarget().", this);
        }

        void OnEnable() => scanAction?.Enable();

        void OnDisable() => SetTarget(null, default);

        void Update()
        {
            UpdateTarget();
            if (Target != null && scanAction != null && scanAction.WasPerformedThisFrame()) ScanTarget();
        }

        void UpdateTarget()
        {
            if (viewCamera == null)
            {
                SetTarget(null, default);
                return;
            }
            Transform cam = viewCamera.transform;
            var ray = new Ray(cam.position, cam.forward);
            // Small rocks carry trigger colliders (so the player does not trip on pebbles): include triggers.
            if (Physics.Raycast(ray, out RaycastHit hit, range, layers, QueryTriggerInteraction.Collide))
            {
                SetTarget(hit.collider.GetComponentInParent<RockSample>(), hit);
            }
            else
            {
                SetTarget(null, default);
            }
        }

        void SetTarget(RockSample rock, RaycastHit hit)
        {
            if (rock != null) TargetHit = hit;
            if (rock == Target) return;
            Target = rock;
            TargetReading = rock != null ? rock.Read() : null;
            TargetChanged?.Invoke(rock);
        }

        /// <summary>Scans the current target. Returns null when nothing is targeted.</summary>
        public RockScanResult ScanTarget()
        {
            if (Target == null) return null;
            bool first = scannedRocks.Add(Target);
            var result = new RockScanResult(Target, TargetReading, TargetHit.point, TargetHit.distance, Time.time, first);
            scanLog.Add(result);
            Scanned?.Invoke(result);
            return result;
        }
    }

    /// <summary>One completed scan.</summary>
    public sealed class RockScanResult
    {
        public RockSample Rock { get; }
        /// <summary>The rock's science values; null if the rock has no data in the database.</summary>
        public RockReading Reading { get; }
        /// <summary>World point the ray hit.</summary>
        public Vector3 Point { get; }
        public float DistanceM { get; }
        /// <summary>Time.time of the scan.</summary>
        public float Time { get; }
        /// <summary>True the first time this rock is scanned.</summary>
        public bool IsFirstScan { get; }

        public RockScanResult(RockSample rock, RockReading reading, Vector3 point, float distanceM, float time, bool isFirstScan)
        {
            Rock = rock;
            Reading = reading;
            Point = point;
            DistanceM = distanceM;
            Time = time;
            IsFirstScan = isFirstScan;
        }
    }
}

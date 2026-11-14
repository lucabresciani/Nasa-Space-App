using System;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;

namespace NasaSpaceApp
{
    /// <summary>
    /// First-person controller tuned for Mars gravity (3.721 m/s²).
    /// Reads the project-wide Input System actions: Player/Move, Look, Jump, Sprint
    /// (keyboard + mouse and gamepad both work).
    ///
    /// Cursor handling is built for UI testing: Esc frees the cursor and stops mouse-look,
    /// clicking the game view (anywhere that is not UI) locks it again.
    /// UI code can also call <see cref="SetCursorLocked"/> or toggle <see cref="InputEnabled"/>.
    /// </summary>
    [RequireComponent(typeof(CharacterController))]
    public class FirstPersonController : MonoBehaviour
    {
        [Header("References")]
        [SerializeField] Transform cameraTransform;

        [Header("Movement")]
        [SerializeField] float walkSpeed = 4f;
        [SerializeField] float sprintSpeed = 8f;
        [SerializeField, Tooltip("How fast ground speed changes, in m/s².")] float acceleration = 25f;
        [SerializeField, Range(0f, 1f), Tooltip("Fraction of ground acceleration available in the air.")] float airControl = 0.3f;

        [Header("Jump & Gravity")]
        [SerializeField, Tooltip("Mars surface gravity is 3.721 m/s² (Earth is 9.81).")] float gravity = 3.721f;
        [SerializeField, Tooltip("Peak jump height in meters.")] float jumpHeight = 1.5f;

        [Header("Look")]
        [SerializeField, Tooltip("Degrees of rotation per pixel of mouse movement.")] float mouseSensitivity = 0.1f;
        [SerializeField, Tooltip("Degrees per second at full right-stick deflection.")] float gamepadLookSpeed = 160f;
        [SerializeField, Range(0f, 90f)] float pitchLimit = 85f;
        [SerializeField] bool invertY;

        [Header("Cursor")]
        [SerializeField] bool lockCursorOnStart = true;

        [Header("Safety")]
        [SerializeField, Tooltip("Below this height the player is sent back to the spawn point.")] float respawnBelowY = -150f;

        /// <summary>When false, movement and look input are ignored (e.g. while a menu is open).</summary>
        public bool InputEnabled { get; set; } = true;
        public bool IsGrounded => controller.isGrounded;
        public bool IsSprinting { get; private set; }
        public Vector3 Velocity => velocity;
        public bool CursorLocked => Cursor.lockState == CursorLockMode.Locked;
        public Transform CameraTransform => cameraTransform;

        /// <summary>Raised whenever the cursor is locked (true) or released (false).</summary>
        public event Action<bool> CursorLockChanged;

        CharacterController controller;
        InputAction moveAction, lookAction, jumpAction, sprintAction;
        Vector3 velocity;
        float pitch;
        Vector3 spawnPosition;
        Quaternion spawnRotation;

        void Awake()
        {
            controller = GetComponent<CharacterController>();
            if (cameraTransform == null)
            {
                var cam = GetComponentInChildren<Camera>();
                if (cam != null) cameraTransform = cam.transform;
            }

            var actions = InputSystem.actions;
            if (actions == null)
            {
                Debug.LogError("FirstPersonController needs project-wide input actions (Project Settings > Input System Package).", this);
                enabled = false;
                return;
            }
            moveAction = actions.FindAction("Player/Move", true);
            lookAction = actions.FindAction("Player/Look", true);
            jumpAction = actions.FindAction("Player/Jump", true);
            sprintAction = actions.FindAction("Player/Sprint", true);

            spawnPosition = transform.position;
            spawnRotation = transform.rotation;
            if (cameraTransform != null) pitch = NormalizeAngle(cameraTransform.localEulerAngles.x);
        }

        void OnEnable() => InputSystem.actions?.FindActionMap("Player")?.Enable();

        void Start()
        {
            if (lockCursorOnStart) SetCursorLocked(true);
        }

        void Update()
        {
            HandleCursorToggle();
            if (InputEnabled && CursorLocked) Look();
            Move(InputEnabled);
            if (transform.position.y < respawnBelowY) Respawn();
        }

        public void SetCursorLocked(bool locked)
        {
            Cursor.lockState = locked ? CursorLockMode.Locked : CursorLockMode.None;
            Cursor.visible = !locked;
            CursorLockChanged?.Invoke(locked);
        }

        public void Respawn()
        {
            controller.enabled = false;
            transform.SetPositionAndRotation(spawnPosition, spawnRotation);
            controller.enabled = true;
            velocity = Vector3.zero;
        }

        void HandleCursorToggle()
        {
            var keyboard = Keyboard.current;
            var mouse = Mouse.current;
            if (CursorLocked)
            {
                if (keyboard != null && keyboard.escapeKey.wasPressedThisFrame) SetCursorLocked(false);
            }
            else if (InputEnabled && mouse != null && mouse.leftButton.wasPressedThisFrame && !IsPointerOverUI())
            {
                SetCursorLocked(true);
            }
        }

        static bool IsPointerOverUI() =>
            EventSystem.current != null && EventSystem.current.IsPointerOverGameObject();

        void Look()
        {
            Vector2 look = lookAction.ReadValue<Vector2>();
            // Mouse delta is already "per frame" (pixels); stick input is a rate and needs deltaTime.
            bool fromPointer = lookAction.activeControl?.device is Pointer;
            look *= fromPointer ? mouseSensitivity : gamepadLookSpeed * Time.deltaTime;

            transform.Rotate(0f, look.x, 0f, Space.Self);
            pitch = Mathf.Clamp(pitch + (invertY ? look.y : -look.y), -pitchLimit, pitchLimit);
            if (cameraTransform != null) cameraTransform.localRotation = Quaternion.Euler(pitch, 0f, 0f);
        }

        void Move(bool readInput)
        {
            float dt = Time.deltaTime;
            bool grounded = controller.isGrounded;

            Vector2 input = readInput ? Vector2.ClampMagnitude(moveAction.ReadValue<Vector2>(), 1f) : Vector2.zero;
            IsSprinting = readInput && input.sqrMagnitude > 0.01f && sprintAction.IsPressed();

            Vector3 wish = (transform.right * input.x + transform.forward * input.y) * (IsSprinting ? sprintSpeed : walkSpeed);
            Vector3 horizontal = new Vector3(velocity.x, 0f, velocity.z);
            horizontal = Vector3.MoveTowards(horizontal, wish, acceleration * (grounded ? 1f : airControl) * dt);

            if (grounded && velocity.y < 0f) velocity.y = -1f; // keep a little pressure on the ground
            bool jumped = false;
            if (grounded && readInput && jumpAction.WasPressedThisFrame())
            {
                velocity.y = Mathf.Sqrt(2f * gravity * jumpHeight);
                jumped = true;
            }
            velocity.y -= gravity * dt;
            velocity.x = horizontal.x;
            velocity.z = horizontal.z;

            Vector3 motion = velocity * dt;
            // Low gravity makes you "skip" down hills; push down by up to a 45° slope's drop to stay grounded.
            if (grounded && !jumped) motion.y -= horizontal.magnitude * dt;

            CollisionFlags flags = controller.Move(motion);
            if ((flags & CollisionFlags.Above) != 0 && velocity.y > 0f) velocity.y = 0f;
        }

        static float NormalizeAngle(float degrees) => degrees > 180f ? degrees - 360f : degrees;
    }
}

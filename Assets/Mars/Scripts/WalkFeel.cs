using System;
using NasaSpaceApp.Homeline.Flow;
using NasaSpaceApp.HUD;
using NasaSpaceApp.Menu;
using NasaSpaceApp.Mission;
using UnityEngine;

namespace NasaSpaceApp
{
    /// <summary>
    /// What walking feels like when the player walks: a small sway of the eye with every step, and the sound of the
    /// crew's own breathing inside the helmet.
    ///
    /// Both are there only while the player walks by themselves. While the crew is carried along a route (the auto
    /// walk of a planner mission, Mission/MissionAutoWalk.cs, or the replay of a built-in plan, Homeline/Sim/EvaDriver.cs)
    /// and under the menu there is neither.
    ///
    /// Step sway: the camera's local position gets a few centimetres of offset that follows the distance walked on
    /// the ground. The player controller is not modified, and whatever else moves the camera is kept.
    /// Breathing: synthesized live from noise, like the wind (Weather/MarsWindAudio.cs), on a clip-less AudioSource.
    /// Its rate and depth follow the helmet's physiology model (<see cref="SuitTelemetry.RespirationRate"/>,
    /// <see cref="SuitTelemetry.Activity"/>): slow and soft at rest, faster and louder with effort. No recording is used.
    ///
    /// Started from code, once per run. Off with -noWalkFeel and during -homelineSelfTest.
    /// </summary>
    [RequireComponent(typeof(AudioSource)), DisallowMultipleComponent]
    public sealed class WalkFeel : MonoBehaviour
    {
        // Step sway. One cycle is a stride (two steps); the eye dips twice in it and leans once to each side.
        const float StrideM = 1.5f;
        const float SwayUpM = 0.020f, SwaySideM = 0.011f;
        const float FullSwayAtMs = 1.1f;          // the sway is at its full size from this walking speed
        const float SwayEasePerSec = 4f;
        // Breathing loudness (linear gain of the synthesized breath) at rest and at full effort.
        const float BreathGainRest = 0.11f, BreathGainEffort = 0.24f;
        const float PlayerSearchSeconds = 1f;

        public static WalkFeel Instance { get; private set; }

        /// <summary>How much of the step sway is applied now, 0..1.</summary>
        public float SwayAmount { get; private set; }
        /// <summary>Recent peak of the breathing sound at the output, 0 = silent (linear).</summary>
        public float BreathLevel { get { return synth.Peak; } }
        /// <summary>True while the breathing is meant to be heard.</summary>
        public bool Breathing { get; private set; }

        readonly BreathSynth synth = new BreathSynth();
        AudioSource source;
        FirstPersonController player;
        Transform eye;
        Vector3 lastOffset;
        float stride, nextSearch;
        volatile bool audioConfigChanged;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            Instance = null;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot()
        {
            if (Instance != null || Application.isBatchMode) return;
            string[] args = Environment.GetCommandLineArgs();
            if (Array.IndexOf(args, "-noWalkFeel") >= 0 || Array.IndexOf(args, "-homelineSelfTest") >= 0) return;
            var go = new GameObject("WalkFeel");
            DontDestroyOnLoad(go);
            AudioSource s = go.AddComponent<AudioSource>();
            // A clip-less, looping 2D source: the filter below is the sound.
            s.clip = null;
            s.playOnAwake = false;
            s.loop = true;
            s.spatialBlend = 0f;
            s.volume = 1f;
            Instance = go.AddComponent<WalkFeel>();
        }

        void Awake()
        {
            source = GetComponent<AudioSource>();
        }

        void OnEnable()
        {
            synth.SampleRate = AudioSettings.outputSampleRate;
            AudioSettings.OnAudioConfigurationChanged += OnAudioConfigurationChanged;
        }

        void OnDisable()
        {
            AudioSettings.OnAudioConfigurationChanged -= OnAudioConfigurationChanged;
            RemoveSway();
        }

        void OnDestroy()
        {
            if (Instance == this) Instance = null;
        }

        void OnAudioConfigurationChanged(bool deviceWasChanged)
        {
            audioConfigChanged = true;
        }

        void OnAudioFilterRead(float[] data, int channels)
        {
            synth.Render(data, channels);
        }

        /// <summary>True while something else walks for the player: the auto walk of a mission or the replay of a plan.</summary>
        public static bool Carried
        {
            get
            {
                MissionAutoWalk walk = MissionAutoWalk.Instance;
                if (walk != null && walk.Carrying) return true;
                HomelineApp app = HomelineApp.Instance;
                return app != null && app.Driver != null && app.Driver.Active && app.Driver.Mode == EvaMode.Replay;
            }
        }

        void Update()
        {
            if (audioConfigChanged)
            {
                audioConfigChanged = false;
                synth.SampleRate = AudioSettings.outputSampleRate;
            }
            if (source != null && source.isActiveAndEnabled && !source.isPlaying) source.Play();

            // The breath of the suit model: only in the simulation (a helmet exists), not under the menu, not carried.
            HelmetHud hud = HelmetHud.Instance;
            SuitTelemetry suit = hud != null && hud.Context != null ? hud.Context.Telemetry : null;
            Breathing = suit != null && !MarvisMenu.IsOpen && !Carried;
            if (Breathing)
            {
                synth.RatePerMin = Mathf.Clamp(suit.RespirationRate, 6f, 60f);
                synth.Gain = Mathf.Lerp(BreathGainRest, BreathGainEffort, Mathf.Clamp01(suit.Activity));
            }
            else
            {
                synth.Gain = 0f;
            }
        }

        // After the player controller moved (Update) and after a route placed the player (LateUpdate, earlier order).
        void LateUpdate()
        {
            if (player == null || eye == null)
            {
                if (Time.unscaledTime < nextSearch) return;
                nextSearch = Time.unscaledTime + PlayerSearchSeconds;
                player = FindAnyObjectByType<FirstPersonController>();
                eye = player != null ? player.CameraTransform : null;
                lastOffset = Vector3.zero;
                SwayAmount = 0f;
                if (player == null || eye == null) return;
            }

            float dt = Time.deltaTime;
            Vector3 v = player.Velocity;
            float speed = Mathf.Sqrt(v.x * v.x + v.z * v.z);
            bool walking = dt > 0f && !MarvisMenu.IsOpen && !Carried && player.IsGrounded && speed > 0.15f;
            float target = walking ? Mathf.Clamp01(speed / FullSwayAtMs) : 0f;
            SwayAmount = Mathf.MoveTowards(SwayAmount, target, SwayEasePerSec * Time.unscaledDeltaTime);
            if (walking) stride = Mathf.Repeat(stride + speed * dt / StrideM, 1f);

            Vector3 offset = Vector3.zero;
            if (SwayAmount > 0.0005f)
            {
                float a = stride * 2f * Mathf.PI;
                offset = new Vector3(Mathf.Sin(a) * SwaySideM, -Mathf.Abs(Mathf.Sin(a)) * SwayUpM, 0f) * SwayAmount;
            }
            // Take the last offset out and put the new one in: what anything else did to the camera stays.
            eye.localPosition += offset - lastOffset;
            lastOffset = offset;
        }

        void RemoveSway()
        {
            if (eye != null) eye.localPosition -= lastOffset;
            lastOffset = Vector3.zero;
            SwayAmount = 0f;
        }
    }

    /// <summary>
    /// The breath as sound: noise through a resonant band-pass, shaped by one breathing cycle. Inhale (the first two
    /// fifths of the cycle): higher and airy, swelling and fading. A short hold. Exhale: lower, starting at once and
    /// dying away. A rest before the next breath. Render runs on the audio thread: no Unity API, no allocation; the
    /// main thread writes the two targets and the output gain is ramped per sample, so nothing clicks.
    /// </summary>
    internal sealed class BreathSynth
    {
        public volatile int SampleRate = 48000;
        /// <summary>Breaths per minute and output gain (0 = silent), written by the main thread.</summary>
        public volatile float RatePerMin = 12f;
        public volatile float Gain;
        /// <summary>Recent peak of the output (decays over about half a second).</summary>
        public float Peak { get { return peak; } }

        const float InhaleEnd = 0.38f, ExhaleStart = 0.45f, ExhaleEnd = 0.92f;
        const float GainSlewPerSec = 2.5f;
        const float Damping = 0.55f;        // band-pass width (state-variable filter)

        volatile float peak;
        float phase, gain, low, band;
        uint seed = 0x9E3779B9u;

        public void Render(float[] data, int channels)
        {
            int fs = SampleRate > 0 ? SampleRate : 48000;
            float rate = RatePerMin, target = Gain;
            float step = rate / 60f / fs;
            float slew = GainSlewPerSec / fs;
            float decay = (float)Math.Exp(-1.0 / (0.5 * fs));
            float p = peak;
            int frames = channels > 0 ? data.Length / channels : 0;
            for (int i = 0; i < frames; i++)
            {
                phase += step;
                if (phase >= 1f) phase -= 1f;
                if (gain < target) gain = Math.Min(target, gain + slew);
                else if (gain > target) gain = Math.Max(target, gain - slew);

                float env, centre;
                if (phase < InhaleEnd)
                {
                    float u = phase / InhaleEnd, s = (float)Math.Sin(Math.PI * u);
                    env = 0.7f * s * s;
                    centre = 1500f + 650f * s;
                }
                else if (phase >= ExhaleStart && phase < ExhaleEnd)
                {
                    float u = (phase - ExhaleStart) / (ExhaleEnd - ExhaleStart);
                    float attack = u < 0.12f ? u / 0.12f : 1f;
                    float fall = 1f - u;
                    env = attack * fall * (float)Math.Sqrt(fall);
                    centre = 880f - 330f * u;
                }
                else
                {
                    env = 0f;
                    centre = 900f;
                }

                // White noise (xorshift), then a state-variable band-pass around the breath's colour.
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                float noise = (seed & 0xFFFFFF) / 8388608f - 1f;
                float f = 2f * (float)Math.Sin(Math.PI * centre / fs);
                low += f * band;
                float high = noise - low - Damping * band;
                band += f * high;
                float sample = band * 0.5f * env * gain;

                float a = sample < 0f ? -sample : sample;
                p = a > p ? a : p * decay;
                int o = i * channels;
                for (int c = 0; c < channels; c++) data[o + c] = sample;
            }
            peak = p;
        }
    }
}

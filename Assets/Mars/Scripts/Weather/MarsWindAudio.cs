using System;
using UnityEngine;

namespace NasaSpaceApp
{
    /// <summary>
    /// Martian wind, synthesized live from noise. The AudioSource has no clip: this filter IS the sound.
    ///
    /// Why it sounds like this. Perseverance's SuperCam microphone made the first recordings on Mars (Maurice et al.
    /// 2022, Nature 605, 653-658, "In situ recording of Mars soundscape"). In the thin CO2 air (about 0.6 kPa at the
    /// surface, under 1% of Earth's) sound is much quieter than on Earth, and CO2 relaxation damps high frequencies
    /// strongly; the paper even measured two speeds of sound, about 240 m/s below 240 Hz and 250 m/s above. The
    /// recorded wind is a low, muffled rumble. Hence: low-passed noise over a rumble bed, slow gust swells, and only
    /// in storms a faint high hiss of blowing grains.
    /// Everything else is an artistic choice tuned by ear, not a measurement: the level law, every filter frequency,
    /// and the grain hiss (sand striking the suit, heard through it). A game has no calibrated playback level anyway.
    /// A public-domain SuperCam wind recording could replace this synth later.
    ///
    /// Threads. Update (main thread) reads <see cref="MarsAtmosphere.Frame"/>, whose channels are already sprung,
    /// rounds off the gust noise and camera turns, and hands plain float targets to <see cref="MarsWindSynth"/>.
    /// OnAudioFilterRead runs on the audio thread: no Unity API, no allocation, and per-sample ramps so that no
    /// parameter change ever clicks. Play mode only: in edit mode nothing runs and the source stays silent.
    /// </summary>
    [RequireComponent(typeof(AudioSource)), DisallowMultipleComponent, DefaultExecutionOrder(20)]
    public class MarsWindAudio : MonoBehaviour
    {
        [SerializeField, Range(0f, 1f), Tooltip("Overall level. Conservative on purpose: Mars is quiet, and a gusting storm still peaks well below clipping.")]
        float masterVolume = 0.35f;

        // Rounds off the gust noise in windSpeed and fast camera turns before the audio thread's own ramps.
        // The weather channels are already sprung, so this adds almost no lag to what the dust shows.
        const float InputSmoothing = 0.15f;
        // The wind rises out of silence when play starts, after a device change and on re-enable.
        const float FadeInSeconds = 2.5f;
        // Pan toward the upwind ear (-1..1). Subtle: wind comes from everywhere at once.
        const float PanAmount = 0.25f;
        // Storms sit a little above the wind-speed law (artistic, by ear).
        const float StormBoost = 0.2f;

        readonly MarsWindSynth synth = new MarsWindSynth();
        AudioSource source;
        float speed, storm, dust, gust, pan, fade;
        bool primed;                      // the smoothed inputs hold real values
        bool playRequested;               // (re)start the source from the main thread
        volatile bool audioConfigChanged; // set by Unity's audio-reset callback

        void Reset()
        {
            // A clip-less, looping 2D source; the weather setup configures the same.
            AudioSource s = GetComponent<AudioSource>();
            s.clip = null;
            s.playOnAwake = true;
            s.loop = true;
            s.spatialBlend = 0f;
            s.volume = 1f;
        }

        void Awake() => source = GetComponent<AudioSource>();

        void OnEnable()
        {
            synth.sampleRate = AudioSettings.outputSampleRate;
            synth.Restart();
            fade = 0f;
            primed = false;
            playRequested = true;
            AudioSettings.OnAudioConfigurationChanged += OnAudioConfigurationChanged;
        }

        void OnDisable()
        {
            AudioSettings.OnAudioConfigurationChanged -= OnAudioConfigurationChanged;
            synth.Restart();
        }

        void Start() => EnsurePlaying(false);

        void Update()
        {
            if (audioConfigChanged)
            {
                // The audio system restarted (new device or sample rate): retune and rise from silence again.
                // Unity's own example restarts the source here unconditionally.
                audioConfigChanged = false;
                synth.sampleRate = AudioSettings.outputSampleRate;
                synth.Restart();
                fade = 0f;
                EnsurePlaying(true);
            }
            else if (playRequested)
            {
                EnsurePlaying(false);
            }

            // Unscaled: audio is not time-scaled, and a paused game keeps its frozen wind instead of stalling the ramps.
            float dt = Time.unscaledDeltaTime;
            WeatherFrame f = MarsAtmosphere.Frame;
            float tSpeed = Sanitize(f.windSpeed, 60f);
            float tStorm = Sanitize(f.stormAmount, 1f);
            float tDust = Sanitize(f.localDust, 1f);
            float tGust = Sanitize(f.gust, 1f);
            float tPan = UpwindPan(f.wind);

            if (!primed)
            {
                speed = tSpeed;
                storm = tStorm;
                dust = tDust;
                gust = tGust;
                pan = tPan;
                primed = true;
            }
            else
            {
                float k = 1f - Mathf.Exp(-dt / InputSmoothing); // frame-rate independent one-pole
                speed += (tSpeed - speed) * k;
                storm += (tStorm - storm) * k;
                dust += (tDust - dust) * k;
                gust += (tGust - gust) * k;
                pan += (tPan - pan) * k;
            }
            fade = Mathf.MoveTowards(fade, 1f, dt / FadeInSeconds);
            Publish();
        }

        void OnAudioFilterRead(float[] data, int channels) => synth.Render(data, channels);

        void OnAudioConfigurationChanged(bool deviceWasChanged) => audioConfigChanged = true;

        void EnsurePlaying(bool force)
        {
            playRequested = false;
            if (source != null && source.isActiveAndEnabled && (force || !source.isPlaying)) source.Play();
        }

        void Publish()
        {
            // Level law from the weather contract (wind audio), 0.15 + 0.6 smoothstep(3, 20, speed): artistic, not measured.
            float windNorm = Smooth(3f, 20f, speed);
            float level = (0.15f + 0.6f * windNorm) * (1f + StormBoost * storm);
            // Brightness follows speed linearly, so a gust is heard as the wind opening up even near 3 m/s,
            // where the level law is flat.
            float bright = Mathf.InverseLerp(2.5f, 22f, speed);
            float rise = fade * fade * (3f - 2f * fade);

            synth.gain = masterVolume * level * rise;
            synth.hiss = storm * Mathf.Lerp(0.4f, 1f, dust) * windNorm; // grains fly only in strong, dusty wind
            synth.rumbleHz = Mathf.Lerp(60f, 130f, bright);
            synth.bodyHz = Mathf.Lerp(150f, 520f, bright);
            // The final ceiling (CO2 absorption) spans the design's 1.5-4 kHz; below it the noise colours already
            // keep the wind dark, so the ceiling mostly shapes the storm hiss.
            synth.ceilingHz = Mathf.Lerp(1500f, 4000f, Mathf.Max(windNorm, storm));
            synth.swellDepth = 0.12f + 0.3f * gust;
            synth.flutterDepth = (0.05f + 0.2f * gust) * Mathf.Lerp(0.5f, 1f, bright);
            synth.flutterHz = Mathf.Lerp(1.5f, 4.5f, bright);
            // Constant-power law, rescaled so the upwind ear stays at 1 and only the far ear drops (-3.5 dB at the
            // full 0.25): turning toward the wind never raises the peak level.
            float angle = (pan + 1f) * (Mathf.PI * 0.25f);
            float left = Mathf.Cos(angle), right = Mathf.Sin(angle);
            float loudest = Mathf.Max(left, right);
            synth.panLeft = left / loudest;
            synth.panRight = right / loudest;
        }

        // -1..1 toward the ear that faces the wind; 'wind' is the air's velocity on world X/Z, so the sound arrives
        // from -wind. Centred in calm air, where the direction means nothing.
        static float UpwindPan(Vector2 wind)
        {
            float w = wind.magnitude;
            Camera cam = Camera.main;
            if (cam == null || !(w > 0.1f && w < 1000f)) return 0f; // calm, NaN or nonsense: centred
            Vector3 right = cam.transform.right;
            float r = Mathf.Sqrt(right.x * right.x + right.z * right.z);
            if (r < 1e-3f) return 0f; // a rolled camera with no horizontal ear axis
            float side = -(right.x * wind.x + right.z * wind.y) / (r * w);
            return Mathf.Clamp(side, -1f, 1f) * PanAmount * Smooth(0.5f, 3f, w);
        }

        // 0..max, and NaN becomes 0: a NaN reaching the filters would silence them until they are reset.
        static float Sanitize(float x, float max) => x > 0f ? (x < max ? x : max) : 0f;

        static float Smooth(float from, float to, float x) => Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(from, to, x));
    }

    /// <summary>
    /// The audio-thread half of <see cref="MarsWindAudio"/>. It never touches the Unity API (it runs inside
    /// OnAudioFilterRead) and never allocates after construction. The main thread writes the targets below as plain
    /// volatile fields; a buffer may see some updated and some not, which the per-sample ramps make inaudible.
    /// </summary>
    internal sealed class MarsWindSynth
    {
        /// <summary>Output sample rate. 0 means not running (edit mode): <see cref="Render"/> leaves the buffer alone.</summary>
        public volatile int sampleRate;
        /// <summary>Overall linear gain: master volume x level law x fade-in.</summary>
        public volatile float gain;
        /// <summary>0..1 storm grain hiss.</summary>
        public volatile float hiss;
        public volatile float rumbleHz = 60f, bodyHz = 150f, ceilingHz = 1500f;
        /// <summary>Depth of the slow gust swells (amplitude and pitch of the whoosh).</summary>
        public volatile float swellDepth;
        /// <summary>Depth and rate of the faster buffeting.</summary>
        public volatile float flutterDepth, flutterHz = 1.5f;
        /// <summary>Pan gains: 1 for the upwind ear, a little less for the other (both 1 when centred).</summary>
        public volatile float panLeft = 1f, panRight = 1f;
        volatile bool resetPending = true;

        // Each layer has unit RMS at its reference cutoff (see Prepare), scaled by these levels, tuned by ear:
        // the rumble is felt more than heard, the body (a muffled whoosh) carries the wind, the hiss stays faint.
        const float RumbleLevel = 0.16f, BodyLevel = 0.22f, HissLevel = 0.04f;
        const float RumbleRefHz = 100f, BodyRefHz = 300f; // above these a layer gets louder: brighter wind is louder
        const float RumbleQ = 0.707f, BodyQ = 1.3f, HissQ = 0.8f, ButterworthQ = 0.707f; // BodyQ: a soft whoosh peak
        const float HissHz = 2400f;
        const float PatterHz = 30f;      // bandwidth of the random envelope that turns the hiss into grains
        const float SubHz = 25f;         // high-pass: nothing below hearing, it would only eat headroom and woofer travel
        const float RampSeconds = 0.03f; // per-sample ramps of every gain: no zipper noise, no clicks
        const float CutoffSeconds = 0.08f;
        const int ControlBlock = 32;     // frames between filter retunes (0.7 ms at 48 kHz): far below audibility
        const float SwellMinSeconds = 2.5f, SwellMaxSeconds = 6.5f;
        const float LimitKnee = 0.6f, LimitCeiling = 0.9f; // a safety net only: normal peaks stay below the knee
        const int MaxChannels = 16;

        readonly float[] routeLeft = new float[MaxChannels];
        readonly float[] routeRight = new float[MaxChannels];
        int routedChannels;
        int preparedRate;

        // Per-sample-rate constants.
        float invFs, ramp, cutoffRamp, patterCoef, patterNorm, rumbleNorm, bodyNorm, hissNorm;

        uint rng = 0x9E3779B9u; // xorshift32 state (never 0): deterministic, lock-free, allocation-free

        // Ramped values (g*) and smoothed cutoffs (c*).
        float gGain, gHiss, gSwell, gFlutter, gPanL, gPanR;
        float cRumbleHz, cBodyHz, cCeilingHz;
        int blockLeft;

        Svf rumbleF, bodyL, bodyR, hissL, hissR, subL, subR, ceilL, ceilR;
        ValueNoise swellLfo, flutterLfo;
        float patter;

        /// <summary>Restarts from silence on the next buffer (ramps and filters from zero). Main thread.</summary>
        public void Restart()
        {
            gain = 0f;
            hiss = 0f;
            resetPending = true;
        }

        /// <summary>Fills an interleaved buffer of any channel count. Audio thread.</summary>
        public void Render(float[] data, int channels)
        {
            int fs = sampleRate;
            if (fs <= 0 || channels <= 0 || data == null) return;
            if (fs != preparedRate)
            {
                Prepare(fs);
                resetPending = true;
            }
            if (resetPending)
            {
                resetPending = false;
                ClearState();
            }
            if (channels != routedChannels) Route(channels);

            // Targets, read once: the main thread may change them while this buffer renders.
            float tGain = gain, tHiss = hiss, tSwell = swellDepth, tFlutter = flutterDepth;
            float tPanL = panLeft, tPanR = panRight;
            float tRumbleHz = rumbleHz, tBodyHz = bodyHz, tCeilingHz = ceilingHz;
            float flutterPeriod = 1f / Math.Max(flutterHz, 0.1f);
            int used = Math.Min(channels, MaxChannels);
            int frames = data.Length / channels;

            for (int i = 0, o = 0; i < frames; i++, o += channels)
            {
                gGain += (tGain - gGain) * ramp;
                gHiss += (tHiss - gHiss) * ramp;
                gSwell += (tSwell - gSwell) * ramp;
                gFlutter += (tFlutter - gFlutter) * ramp;
                gPanL += (tPanL - gPanL) * ramp;
                gPanR += (tPanR - gPanR) * ramp;

                // Two smooth random LFOs: slow gust swells (seconds) and faster buffeting (fractions of a second).
                float swell = swellLfo.Next(ref rng, SwellMinSeconds, SwellMaxSeconds, invFs);
                float flutter = flutterLfo.Next(ref rng, 0.6f * flutterPeriod, 1.4f * flutterPeriod, invFs);

                if (--blockLeft <= 0)
                {
                    blockLeft = ControlBlock;
                    cRumbleHz += (tRumbleHz - cRumbleHz) * cutoffRamp;
                    cBodyHz += (tBodyHz - cBodyHz) * cutoffRamp;
                    cCeilingHz += (tCeilingHz - cCeilingHz) * cutoffRamp;
                    // A gust opens the wind up: the whoosh rises in pitch as it swells.
                    rumbleF.Tune(cRumbleHz, RumbleQ, invFs);
                    bodyL.Tune(cBodyHz * (1f + 0.6f * gSwell * swell + 0.15f * gFlutter * flutter), BodyQ, invFs);
                    bodyR.CopyTuning(bodyL);
                    ceilL.Tune(cCeilingHz, ButterworthQ, invFs);
                    ceilR.CopyTuning(ceilL);
                }

                // Rumble: mono, since low frequencies carry no direction; the buffeting shakes it most.
                float rumbleGain = rumbleNorm * RumbleLevel * (1f + 1.5f * gFlutter * flutter);
                float rumble = rumbleF.Low(Bipolar(ref rng)) * rumbleGain;

                // Body: low-passed noise with a soft resonance, the muffled whoosh. The ears share 64% of it
                // (0.8 shared + 0.6 own): wide, but not hollow.
                float shared = 0.8f * Bipolar(ref rng);
                float bodyGain = bodyNorm * BodyLevel * (1f + gFlutter * flutter);
                float left = bodyL.Low(shared + 0.6f * Bipolar(ref rng)) * bodyGain;
                float right = bodyR.Low(shared + 0.6f * Bipolar(ref rng)) * bodyGain;

                // Storm hiss: band-passed noise under a random envelope, so it patters like grains instead of
                // hissing like a radio. The envelope averages 1 and is capped, so no single grain stands out.
                patter += (Bipolar(ref rng) - patter) * patterCoef;
                float grains = Math.Min(patter * patter * patterNorm, 5f);
                float hissGain = gHiss * (hissNorm * HissLevel) * (0.4f + 0.6f * grains);
                left += hissL.Band(Bipolar(ref rng)) * hissGain;
                right += hissR.Band(Bipolar(ref rng)) * hissGain;

                // Everything ends between the sub high-pass and the ceiling low-pass: the CO2 air takes the highs.
                float amp = gGain * (1f + gSwell * swell);
                left = Limit(ceilL.Low(subL.High(left + rumble)) * (amp * gPanL));
                right = Limit(ceilR.Low(subR.High(right + rumble)) * (amp * gPanR));

                for (int c = 0; c < used; c++) data[o + c] = routeLeft[c] * left + routeRight[c] * right;
                for (int c = used; c < channels; c++) data[o + c] = 0f;
            }

            // A NaN can only come from a bad input; it would latch in the filters forever. Start over instead.
            float check = ceilL.State + ceilR.State + gGain + gHiss + gSwell + gFlutter + gPanL + gPanR;
            if (float.IsNaN(check) || float.IsInfinity(check)) resetPending = true;
        }

        void Prepare(int fs)
        {
            preparedRate = fs;
            invFs = 1f / fs;
            ramp = 1f - MathF.Exp(-invFs / RampSeconds);
            cutoffRamp = 1f - MathF.Exp(-ControlBlock * invFs / CutoffSeconds);
            patterCoef = 1f - MathF.Exp(-2f * MathF.PI * PatterHz * invFs);
            // A one-pole low-pass y += c (x - y) passes white noise of variance 1/3 as variance (1/3) c / (2 - c):
            // this makes the squared envelope average 1.
            patterNorm = 3f * (2f - patterCoef) / patterCoef;
            // A 2-pole low- or band-pass (equivalent noise bandwidth pi Q f / 2) passes white noise of variance 1/3
            // as variance pi Q f / (3 fs). These gains give unit RMS at the reference cutoff, at any sample rate.
            rumbleNorm = MathF.Sqrt(3f * fs / (MathF.PI * RumbleQ * RumbleRefHz));
            bodyNorm = MathF.Sqrt(3f * fs / (MathF.PI * BodyQ * BodyRefHz));
            float hissHz = Math.Min(HissHz, 0.4f * fs);
            hissNorm = MathF.Sqrt(3f * fs / (MathF.PI * HissQ * hissHz));
            hissL.Tune(hissHz, HissQ, invFs);
            hissR.CopyTuning(hissL);
            subL.Tune(SubHz, ButterworthQ, invFs);
            subR.CopyTuning(subL);
        }

        void ClearState()
        {
            gGain = gHiss = gSwell = gFlutter = 0f;
            gPanL = panLeft;
            gPanR = panRight;
            cRumbleHz = rumbleHz;
            cBodyHz = bodyHz;
            cCeilingHz = ceilingHz;
            blockLeft = 0; // retune on the first frame
            rumbleF.Clear();
            bodyL.Clear();
            bodyR.Clear();
            hissL.Clear();
            hissR.Clear();
            subL.Clear();
            subR.Clear();
            ceilL.Clear();
            ceilR.Clear();
            swellLfo.Restart();
            flutterLfo.Restart();
            patter = 0f;
        }

        // Interleaving as Unity delivers it: mono; stereo; quad FL FR BL BR; 5.0 FL FR C BL BR;
        // 5.1 FL FR C LFE SL SR; 7.1 FL FR C LFE SL SR BL BR. Wind is ambience: fronts and surrounds,
        // never the centre (dialogue) or the LFE.
        void Route(int channels)
        {
            routedChannels = channels;
            bool centre = channels == 5 || channels >= 6;
            bool lfe = channels >= 6;
            int firstSurround = 2 + (centre ? 1 : 0) + (lfe ? 1 : 0);
            int used = Math.Min(channels, MaxChannels);
            for (int c = 0; c < used; c++)
            {
                float l = 0f, r = 0f;
                if (channels == 1) l = r = 0.5f;
                else if (c == 0) l = 1f;
                else if (c == 1) r = 1f;
                else if (c >= firstSurround)
                {
                    if (((c - firstSurround) & 1) == 0) l = 1f;
                    else r = 1f;
                }
                routeLeft[c] = l;
                routeRight[c] = r;
            }
        }

        // Soft safety limiter: transparent below the knee, then bends smoothly (C1) toward the ceiling.
        // NaN or infinity becomes silence.
        static float Limit(float x)
        {
            float a = Math.Abs(x);
            if (a <= LimitKnee) return x;
            if (!(a < float.MaxValue)) return 0f;
            float e = a - LimitKnee;
            float y = LimitKnee + e / (1f + e / (LimitCeiling - LimitKnee));
            return x < 0f ? -y : y;
        }

        static uint NextRandom(ref uint s)
        {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            return s;
        }

        // Uniform in [-1, 1), variance 1/3.
        static float Bipolar(ref uint s) => unchecked((int)NextRandom(ref s)) * (1f / 2147483648f);

        // Uniform in [0, 1).
        static float Unit(ref uint s) => (NextRandom(ref s) >> 8) * (1f / 16777216f);

        /// <summary>
        /// Trapezoidal (zero-delay-feedback) state-variable filter, after Andrew Simper (Cytomic, "Linear Trapezoidal
        /// Integrated SVF"). Chosen because it stays stable and click-free while its cutoff moves, which a direct-form
        /// biquad does not guarantee.
        /// </summary>
        struct Svf
        {
            float k, a1, a2, a3, ic1, ic2;

            public float State => ic1 + ic2;

            public void Tune(float hz, float q, float invFs)
            {
                float g = MathF.Tan(MathF.PI * Math.Min(Math.Max(hz, 10f) * invFs, 0.45f)); // below Nyquist at any rate
                k = 1f / q;
                a1 = 1f / (1f + g * (g + k));
                a2 = g * a1;
                a3 = g * a2;
            }

            public void CopyTuning(in Svf other)
            {
                k = other.k;
                a1 = other.a1;
                a2 = other.a2;
                a3 = other.a3;
            }

            public void Clear() => ic1 = ic2 = 0f;

            /// <summary>Low-pass output (unit gain below the cutoff).</summary>
            public float Low(float x)
            {
                Step(x, out _, out float low);
                return low;
            }

            /// <summary>Band-pass output (gain Q at the centre).</summary>
            public float Band(float x)
            {
                Step(x, out float band, out _);
                return band;
            }

            /// <summary>High-pass output (unit gain above the cutoff).</summary>
            public float High(float x)
            {
                Step(x, out float band, out float low);
                return x - k * band - low;
            }

            void Step(float x, out float band, out float low)
            {
                float v3 = x - ic2;
                band = a1 * ic1 + a2 * v3;
                low = ic2 + a2 * ic1 + a3 * v3;
                ic1 = 2f * band - ic1;
                ic2 = 2f * low - ic2;
            }
        }

        /// <summary>
        /// Smooth random LFO in [-1, 1]: a new random level at the end of each segment of random length, joined by
        /// smoothstep, so it has no corners (C1) and no regular rhythm, like real gusts.
        /// </summary>
        struct ValueNoise
        {
            float from, to, t, step;

            public void Restart()
            {
                from = to = 0f;
                t = 1f; // pick the first segment on the next call, starting from 0
                step = 0f;
            }

            public float Next(ref uint rng, float minSeconds, float maxSeconds, float invFs)
            {
                t += step;
                if (t >= 1f)
                {
                    t = 0f;
                    from = to;
                    to = Bipolar(ref rng);
                    step = invFs / (minSeconds + (maxSeconds - minSeconds) * Unit(ref rng));
                }
                return from + (to - from) * (t * t * (3f - 2f * t));
            }
        }
    }
}

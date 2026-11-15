using System;
using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Lead-II-like ECG of the BPM card, drawn like a patient monitor: a SWEEP at fixed paper speed (the trace is
    /// written left to right and overwrites the previous sweep, with a short erase gap ahead of the write head), as one
    /// crisp <see cref="HudLineMesh"/> polyline in white ink on its own nested Canvas.
    /// <para>
    /// Morphology: sum of Gaussians per beat for P, Q, R, S and an asymmetric T (two Gaussians), the closed form of the
    /// McSharry ECGSYN model (McSharry, Clifford, Tarassenko &amp; Smith 2003, IEEE Trans Biomed Eng 50(3):289-294), in
    /// the time domain. Each beat takes its RR interval from <see cref="SuitTelemetry.RrIntervalS"/> (heart rate with
    /// respiratory sinus arrhythmia), so the rhythm follows effort and weather. QT shortens with rate (Bazett: QT = QTc
    /// sqrt(RR), QTc 0.40 s), PR shortens slightly, P and T grow and R shrinks a little with effort; breathing modulates
    /// the R amplitude and the baseline; muscle noise rises with activity and is low-passed like a monitor filter.
    /// </para>
    /// Point buffers are preallocated: no GC per frame. Frozen (static trace) under reduced motion.
    /// </summary>
    public sealed class PulseStrip
    {
        private const float WindowS = 3.2f;          // seconds across the strip (sweep period)
        private const int SampleRate = 200;          // Hz
        private const int Points = 640;             // WindowS * SampleRate
        private const float SampleDt = 1f / SampleRate;
        private const float EraseGapS = 0.2f;
        private const int GapPoints = 40;            // EraseGapS * SampleRate
        private const float Stroke = 1.5f;           // px
        private const float BaselineFrac = 0.30f;    // baseline height from the strip bottom
        private const float TopPad = 6f, BottomPad = 2f;
        private const float FullScaleMv = 1.4f;      // R peak + margin maps to the top pad
        private const float FallbackBpm = 79f;       // resting heart rate of the suit model
        private const float MinRr = 0.28f, MaxRr = 2f;
        private const int Beats = 4;                 // beats kept around the write head (P of the next, T of the previous)

        // Wave constants (seconds relative to the R peak, amplitude mV, lead II adult at 60 bpm).
        private const float QMu = -0.028f, QSigma = 0.0075f, QAmp = -0.09f;
        private const float RSigma = 0.0095f, RAmp = 1.25f;
        private const float SMu = 0.026f, SSigma = 0.0085f, SAmp = -0.28f;
        private const float QtcS = 0.40f;            // corrected QT (Bazett)
        private const float T1Amp = 0.12f, T2Amp = 0.24f;
        private const float WanderMv = 0.035f;       // respiratory baseline wander
        private const float NoiseRestMv = 0.006f, NoiseWorkMv = 0.018f;
        private const float NoiseLowPass = 0.35f;    // one-pole low-pass per 5 ms sample (~40 Hz monitor bandwidth)

        private readonly HudLineMesh mesh;
        private readonly Vector2[] pts = new Vector2[Points];
        private readonly Vector2[] tail = new Vector2[Points];
        private readonly float width, height, baselineY, pxPerMv;

        // beat ring (index 0 = oldest)
        private readonly double[] beatR = new double[Beats];
        private readonly float[] beatRr = new float[Beats];
        private readonly float[] beatAct = new float[Beats];
        private readonly float[] beatResp = new float[Beats];

        private double clock;          // ECG time of the next sample
        private float pending;         // simulated time not yet sampled
        private int cursor;            // next column to write
        private uint rng = 0x9E3779B9u;
        private float noise;
        private HudSeverity colorState = (HudSeverity)(-1);

        /// <summary>
        /// Builds the strip under <paramref name="parent"/>; <paramref name="pos"/> is the strip's top-left corner in the
        /// parent's local coordinates (from the parent's top-left, y down).
        /// </summary>
        public PulseStrip(HudContext ctx, RectTransform parent, Vector2 pos, Vector2 size)
        {
            width = size.x;
            height = size.y;
            Vector2 topLeft = new Vector2(0f, 1f);
            RectTransform root = HudFactory.CreateRect("PulseStrip", parent, topLeft, topLeft, new Vector2(pos.x, -pos.y), size);
            HudFactory.AddNestedCanvas(root.gameObject, false);
            mesh = HudFactory.CreateLineMesh("Trace", root, topLeft, topLeft, Vector2.zero, size);

            // Local space: origin at the strip's top-left, y up (so the strip spans y in [-height, 0]).
            baselineY = -height + BottomPad + (height - BottomPad) * BaselineFrac;
            pxPerMv = (-TopPad - baselineY) / FullScaleMv;
            float step = width / (Points - 1);
            for (int i = 0; i < Points; i++)
            {
                pts[i] = new Vector2(i * step, baselineY);
            }

            // Seed the beat ring so the first R lands a little after the start, then pre-sweep one full window.
            float rr = 60f / FallbackBpm;
            SuitTelemetry t = ctx != null ? ctx.Telemetry : null;
            if (t != null)
            {
                rr = Mathf.Clamp(t.RrIntervalS, MinRr, MaxRr);
            }
            for (int i = 0; i < Beats; i++)
            {
                beatR[i] = 0.25 + (i - (Beats - 2)) * rr;
                beatRr[i] = rr;
                beatAct[i] = t != null ? t.Activity : 0.08f;
                beatResp[i] = 0f;
            }
            for (int i = 0; i < Points; i++)
            {
                WriteSample(t);
            }
            cursor = 0;
            ApplyColor(HudSeverity.Nominal);
            Rebuild();
        }

        /// <summary>
        /// Advances the sweep by <paramref name="simDt"/> (simulation time: the heart pauses with the game) and tints the
        /// trace by <paramref name="state"/>.
        /// </summary>
        public void Tick(float simDt, SuitTelemetry t, HudSeverity state)
        {
            ApplyColor(state);
            if (HudTokens.ReducedMotion || !(simDt > 0f))
            {
                return;   // frozen: the last sweep stays on screen
            }

            pending += Mathf.Min(simDt, 0.25f);
            int written = 0;
            while (pending >= SampleDt && written < Points)
            {
                pending -= SampleDt;
                WriteSample(t);
                written++;
            }
            if (written > 0)
            {
                Rebuild();
            }
        }

        private void ApplyColor(HudSeverity state)
        {
            if (state == colorState)
            {
                return;
            }
            colorState = state;
            mesh.color = state >= HudSeverity.Caution ? HudTokens.Severity(state, HudTokens.InkPrimary) : HudTokens.InkPrimary;
        }

        // ---- synthesis

        private void WriteSample(SuitTelemetry t)
        {
            double ts = clock;
            clock += SampleDt;

            // Keep a scheduled beat ahead of the write head (its P wave starts ~0.25 s before R).
            while (beatR[Beats - 1] < ts + 0.35)
            {
                ScheduleBeat(t);
            }

            float act = t != null ? t.Activity : 0.08f;
            float respRate = t != null ? t.RespirationRate : 14f;
            // Breathing phase at this sample: the model's phase now, shifted back by the time still pending this frame.
            float respNow = t != null ? t.RespirationPhase : 0f;
            float resp = respNow - pending * respRate / 60f;

            float mv = 0f;
            for (int b = 0; b < Beats; b++)
            {
                mv += Beat((float)(ts - beatR[b]), beatRr[b], beatAct[b], beatResp[b]);
            }
            mv += WanderMv * Mathf.Sin(2f * Mathf.PI * resp + 0.6f);

            // Muscle (EMG) noise: white, low-passed like the monitor's 40 Hz filter, larger with effort.
            float white = (Rand() + Rand() - 1f) * 1.7f;
            noise += (white - noise) * NoiseLowPass;
            mv += noise * Mathf.Lerp(NoiseRestMv, NoiseWorkMv, act);

            float y = Mathf.Clamp(baselineY + mv * pxPerMv, -height + 1f, -1f);
            pts[cursor].y = y;
            cursor++;
            if (cursor >= Points)
            {
                cursor = 0;
            }
        }

        private void ScheduleBeat(SuitTelemetry t)
        {
            float rr = t != null ? t.RrIntervalS : 60f / FallbackBpm;
            if (float.IsNaN(rr) || float.IsInfinity(rr))
            {
                rr = 60f / FallbackBpm;
            }
            rr = Mathf.Clamp(rr, MinRr, MaxRr);
            double next = beatR[Beats - 1] + rr;
            for (int i = 0; i < Beats - 1; i++)
            {
                beatR[i] = beatR[i + 1];
                beatRr[i] = beatRr[i + 1];
                beatAct[i] = beatAct[i + 1];
                beatResp[i] = beatResp[i + 1];
            }
            beatR[Beats - 1] = next;
            beatRr[Beats - 1] = rr;
            beatAct[Beats - 1] = t != null ? t.Activity : 0.08f;
            beatResp[Beats - 1] = t != null ? t.RespirationPhase : 0f;
        }

        /// <summary>ECG contribution (mV) of one beat at time <paramref name="dt"/> from its R peak.</summary>
        private static float Beat(float dt, float rr, float act, float resp)
        {
            if (dt < -0.4f || dt > 0.75f)
            {
                return 0f;
            }
            float sq = Mathf.Sqrt(rr);

            // P: PR shortens with rate; P grows a little with effort.
            float pMu = -(0.10f + 0.07f * sq);
            float pSigma = 0.022f + 0.006f * sq;
            float pAmp = 0.14f + 0.04f * act;

            // R: smaller with effort, modulated by breathing (electrical axis shift).
            float rAmp = RAmp * (1f - 0.12f * act) * (1f + 0.05f * Mathf.Sin(2f * Mathf.PI * resp));

            // T: Bazett QT; T end ~ Tpeak + 2 sigma, Q onset ~ R - 0.04 s.
            float qt = QtcS * sq;
            float t2Sigma = 0.032f * sq;
            float t2Mu = qt - 0.04f - 2f * t2Sigma;
            float t1Sigma = 0.045f * sq;
            float t1Mu = t2Mu - 0.035f * sq;
            float tGain = 1f + 0.1f * act;

            return G(dt, pMu, pSigma, pAmp)
                 + G(dt, QMu, QSigma, QAmp)
                 + G(dt, 0f, RSigma, rAmp)
                 + G(dt, SMu, SSigma, SAmp)
                 + G(dt, t1Mu, t1Sigma, T1Amp * tGain)
                 + G(dt, t2Mu, t2Sigma, T2Amp * tGain);
        }

        private static float G(float x, float mu, float sigma, float amp)
        {
            float u = (x - mu) / sigma;
            return u > 4f || u < -4f ? 0f : amp * Mathf.Exp(-0.5f * u * u);
        }

        // xorshift32 in [0, 1): deterministic, allocation-free.
        private float Rand()
        {
            uint x = rng;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            rng = x;
            return (x >> 8) * (1f / 16777216f);
        }

        // ---- drawing: [0, cursor) is the current sweep, (cursor + gap, end] the previous one.

        private void Rebuild()
        {
            mesh.Clear();
            Color32 ink = Color.white;   // tinted by mesh.color
            if (cursor >= 2)
            {
                mesh.Polyline(pts, cursor, Stroke, ink);
            }
            int start = cursor + GapPoints;
            int count = Points - start;
            if (count >= 2)
            {
                Array.Copy(pts, start, tail, 0, count);
                mesh.Polyline(tail, count, Stroke, ink);
            }
            mesh.Commit();
        }
    }
}

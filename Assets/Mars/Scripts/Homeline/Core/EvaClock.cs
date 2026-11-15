using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// The EVA clock: EVA minutes driven by real time x speed. Port of PlaybackClock in web/src/hud/clock.ts (F18):
    /// play / pause / toggle / seek / tick, with the allowed speeds and the default speed of config/hud.yaml
    /// (config_snapshot.json files["hud.yaml"]: playback_speeds 1, 30, 60, 300 and default_speed 60 in the official
    /// bundle). 1x is real time: one real second advances the EVA by one second. The clock stops at the EVA length.
    /// <see cref="Reset"/> is an addition for the simulator (clock.ts has none).
    /// </summary>
    public sealed class EvaClock
    {
        readonly double[] speeds;
        readonly double defaultSpeed;

        /// <summary>EVA time, minutes since the EVA start, within [0, TMaxMin].</summary>
        public double TMin { get; private set; }
        /// <summary>Length of the EVA, minutes (the planned end); the clock never passes it.</summary>
        public double TMaxMin { get; set; }
        /// <summary>EVA seconds per real second; always one of <see cref="Speeds"/>.</summary>
        public double Speed { get; private set; }
        public bool Playing { get; private set; }
        public IReadOnlyList<double> Speeds { get { return speeds; } }
        public double DefaultSpeed { get { return defaultSpeed; } }
        /// <summary>True once the clock has reached the EVA length.</summary>
        public bool AtEnd { get { return TMin >= TMaxMin; } }

        public EvaClock(double tMaxMin, IEnumerable<double> speeds, double defaultSpeed)
        {
            this.speeds = new List<double>(speeds).ToArray();
            if (Array.IndexOf(this.speeds, defaultSpeed) < 0)
                throw new ArgumentException("default speed " + Text(defaultSpeed) + " not in " + Text(this.speeds));
            TMaxMin = tMaxMin;
            this.defaultSpeed = defaultSpeed;
            Speed = defaultSpeed;
        }

        /// <summary>
        /// A clock with the speeds of the bundle: config_snapshot.json files["hud.yaml"] playback_speeds and
        /// default_speed. <paramref name="tMaxMin"/> is the planned end (Timeline.EndMin).
        /// </summary>
        public static EvaClock FromConfig(JToken configSnapshot, double tMaxMin)
        {
            JToken files = configSnapshot != null && configSnapshot.Type == JTokenType.Object ? configSnapshot["files"] : null;
            JToken hud = files != null && files.Type == JTokenType.Object ? files["hud.yaml"] : null;
            if (hud == null || hud.Type != JTokenType.Object) throw new InvalidDataException("config snapshot has no hud.yaml");
            double[] speeds = HlJson.Doubles(hud["playback_speeds"]);
            if (speeds == null || speeds.Length == 0) throw new InvalidDataException("hud.yaml has no playback_speeds");
            return new EvaClock(tMaxMin, speeds, HlJson.Num(hud, "default_speed"));
        }

        /// <summary>Starts or resumes; from the end it starts again at 0 (clock.ts).</summary>
        public void Play()
        {
            if (TMin >= TMaxMin) TMin = 0;
            Playing = true;
        }

        public void Pause()
        {
            Playing = false;
        }

        public void Toggle()
        {
            if (Playing) Pause();
            else Play();
        }

        /// <summary>Sets the speed; it must be one of <see cref="Speeds"/>.</summary>
        public void SetSpeed(double speed)
        {
            if (Array.IndexOf(speeds, speed) < 0)
                throw new ArgumentException("speed " + Text(speed) + " not in " + Text(speeds));
            Speed = speed;
        }

        /// <summary>Jumps to an EVA minute, clamped to [0, TMaxMin]. Does not change playing or speed.</summary>
        public void Seek(double tMin)
        {
            TMin = Math.Min(TMaxMin, Math.Max(0.0, tMin));
        }

        /// <summary>
        /// Advances by a real-time step in SECONDS (clock.ts takes milliseconds): adds dt / 60 x speed EVA minutes,
        /// clamped to the EVA length, where it stops playing. Returns true when the time changed.
        /// </summary>
        public bool Tick(double dtSeconds)
        {
            if (!Playing || !(dtSeconds > 0)) return false;
            double before = TMin;
            TMin = Math.Min(TMaxMin, TMin + dtSeconds / 60.0 * Speed);
            if (TMin >= TMaxMin) Playing = false;
            return TMin != before;
        }

        /// <summary>Back to the state of a new clock: time 0, paused, default speed.</summary>
        public void Reset()
        {
            TMin = 0;
            Playing = false;
            Speed = defaultSpeed;
        }

        static string Text(double v)
        {
            return v.ToString("R", CultureInfo.InvariantCulture);
        }

        static string Text(double[] vs)
        {
            var parts = new string[vs.Length];
            for (int i = 0; i < vs.Length; i++) parts[i] = Text(vs[i]);
            return "[" + string.Join(", ", parts) + "]";
        }
    }
}

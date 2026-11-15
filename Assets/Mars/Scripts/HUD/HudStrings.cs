using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Zero-GC display strings: per-frame callers get cached instances (allocation only the first time a value is seen),
    /// so <c>Text.text</c> can be assigned by reference comparison. Negative numbers use U+2212, never ASCII '-'.
    /// <see cref="Chem"/>, <see cref="Wt"/> and <see cref="Truncate"/> are spawn/event-time helpers and may allocate.
    /// </summary>
    public static class HudStrings
    {
        public const char Minus = '−';                 // never ASCII '-' for negative values

        private const string MinusString = "−";
        private const string Ellipsis = "…";
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        private const int IntMin = -999, IntMax = 9999;
        private const int SignedMin = -200, SignedMax = 200;
        private const int MetMaxMinutes = 99 * 60 + 59;
        private const int SolMax = 9999;
        private const int SecondsMax = 99;
        private const int MinutesPerSol = 1440;

        private static string[] s_Int;
        private static string[] s_Signed;
        private static string[] s_Heading;
        private static string[] s_Ltst;
        private static string[] s_Met;
        private static string[] s_Sol;
        private static string[] s_Seconds;
        private static Dictionary<int, string> s_Distance;

        /// <summary>Integer, cached for -999..9999 (U+2212 minus); other values allocate.</summary>
        public static string Int(int v)
        {
            if (v < IntMin || v > IntMax)
            {
                return Format(v);
            }
            if (s_Int == null)
            {
                s_Int = new string[IntMax - IntMin + 1];
            }
            int i = v - IntMin;
            return s_Int[i] ??= Format(v);
        }

        /// <summary>
        /// Signed quantity (e.g. temperature), cached for -200..200: U+2212 for negatives, no sign for zero/positives.
        /// </summary>
        public static string SignedInt(int v)
        {
            if (v < SignedMin || v > SignedMax)
            {
                return Format(v);
            }
            if (s_Signed == null)
            {
                s_Signed = new string[SignedMax - SignedMin + 1];
            }
            int i = v - SignedMin;
            return s_Signed[i] ??= Format(v);
        }

        /// <summary>Heading "000°".."359°" (input wrapped into 0..359), prebuilt.</summary>
        public static string Heading(int deg)
        {
            if (s_Heading == null)
            {
                s_Heading = new string[360];
                for (int d = 0; d < 360; d++)
                {
                    s_Heading[d] = d.ToString("000", Inv) + "°";
                }
            }
            return s_Heading[Wrap(deg, 360)];
        }

        /// <summary>"LTST 14:32" for minute 0..1439 of the sol (wrapped); negative input gives "LTST --:--".</summary>
        public static string Ltst(int minuteOfSol)
        {
            if (minuteOfSol < 0)
            {
                return "LTST --:--";
            }
            if (s_Ltst == null)
            {
                s_Ltst = new string[MinutesPerSol];
            }
            int m = minuteOfSol % MinutesPerSol;
            return s_Ltst[m] ??= "LTST " + (m / 60).ToString("00", Inv) + ":" + (m % 60).ToString("00", Inv);
        }

        /// <summary>"MET 0:42" .. "MET 99:59" (minutes clamped to 0..5999).</summary>
        public static string Met(int minutes)
        {
            if (s_Met == null)
            {
                s_Met = new string[MetMaxMinutes + 1];
            }
            int m = Mathf.Clamp(minutes, 0, MetMaxMinutes);
            return s_Met[m] ??= "MET " + (m / 60).ToString(Inv) + ":" + (m % 60).ToString("00", Inv);
        }

        /// <summary>"SOL 12" for 0..9999 (clamped above); negative (unknown) gives "SOL --".</summary>
        public static string Sol(int sol)
        {
            if (sol < 0)
            {
                return "SOL --";
            }
            if (s_Sol == null)
            {
                s_Sol = new string[SolMax + 1];
            }
            int s = Mathf.Min(sol, SolMax);
            return s_Sol[s] ??= "SOL " + s.ToString(Inv);
        }

        /// <summary>
        /// Distance: below 10 m "4.2 m" (0.1 m), below 1000 m "42 m" (1 m), else "1.3 km" (0.1 km). Cached per bucket.
        /// Negative or NaN reads as 0.
        /// </summary>
        public static string Distance(float meters)
        {
            if (!(meters > 0f))
            {
                meters = 0f;
            }
            if (meters > 9.9e6f)
            {
                meters = 9.9e6f;
            }
            if (s_Distance == null)
            {
                s_Distance = new Dictionary<int, string>(256);
            }

            int key;
            int tenths = Mathf.RoundToInt(meters * 10f);
            if (tenths < 100)
            {
                key = tenths;                                   // 0..99: 0.0..9.9 m
            }
            else
            {
                int m = Mathf.RoundToInt(meters);
                if (m < 1000)
                {
                    key = 100000 + m;                           // 10..999 m
                }
                else
                {
                    key = 200000 + Mathf.RoundToInt(meters * 0.01f); // tenths of a km
                }
            }

            if (s_Distance.TryGetValue(key, out string text))
            {
                return text;
            }
            if (key < 100)
            {
                text = (key / 10).ToString(Inv) + "." + (key % 10).ToString(Inv) + " m";
            }
            else if (key < 200000)
            {
                text = (key - 100000).ToString(Inv) + " m";
            }
            else
            {
                int kmTenths = key - 200000;
                text = (kmTenths / 10).ToString(Inv) + "." + (kmTenths % 10).ToString(Inv) + " km";
            }
            s_Distance.Add(key, text);
            return text;
        }

        /// <summary>"0 s".."99 s" (clamped).</summary>
        public static string Seconds(int s)
        {
            if (s_Seconds == null)
            {
                s_Seconds = new string[SecondsMax + 1];
            }
            int v = Mathf.Clamp(s, 0, SecondsMax);
            return s_Seconds[v] ??= v.ToString(Inv) + " s";
        }

        /// <summary>Chemical formula with subscript digits after the first char: "Al2O3" -> "Al₂O₃". Spawn-time only.</summary>
        public static string Chem(string key)
        {
            if (string.IsNullOrEmpty(key))
            {
                return string.Empty;
            }
            char[] chars = null;
            for (int i = 1; i < key.Length; i++)
            {
                char c = key[i];
                if (c >= '0' && c <= '9')
                {
                    if (chars == null)
                    {
                        chars = key.ToCharArray();
                    }
                    chars[i] = (char)('₀' + (c - '0'));
                }
            }
            return chars == null ? key : new string(chars);
        }

        /// <summary>Weight percent right-aligned in 5 chars: v &gt;= 1 "45.7", below 1 "0.85". Spawn-time only.</summary>
        public static string Wt(float v)
        {
            if (float.IsNaN(v) || float.IsInfinity(v))
            {
                return "--".PadLeft(5);
            }
            string s = v >= 1f ? v.ToString("0.0", Inv) : v.ToString("0.00", Inv);
            if (s.Length > 0 && s[0] == '-')
            {
                s = MinusString + s.Substring(1);
            }
            return s.PadLeft(5);
        }

        /// <summary>Cuts <paramref name="s"/> to at most <paramref name="maxChars"/> chars, ending in "…" (U+2026) when cut.</summary>
        public static string Truncate(string s, int maxChars)
        {
            if (string.IsNullOrEmpty(s) || maxChars <= 0)
            {
                return string.Empty;
            }
            if (s.Length <= maxChars)
            {
                return s;
            }
            return s.Substring(0, maxChars - 1).TrimEnd() + Ellipsis;
        }

        private static string Format(int v)
        {
            return v < 0 ? MinusString + (-(long)v).ToString(Inv) : v.ToString(Inv);
        }

        private static int Wrap(int v, int n)
        {
            int r = v % n;
            return r < 0 ? r + n : r;
        }
    }
}

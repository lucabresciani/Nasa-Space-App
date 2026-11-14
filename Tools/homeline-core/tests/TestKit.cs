using System;
using System.Collections.Generic;
using System.Globalization;

namespace NasaSpaceApp.Homeline.Tests
{
    /// <summary>Minimal check helper: counts passes and failures, prints one line per failure.</summary>
    public static class T
    {
        public static int Passed;
        public static readonly List<string> Failures = new List<string>();
        static string group = "";

        public static void Group(string name)
        {
            group = name;
        }

        public static void True(bool ok, string what)
        {
            if (ok)
            {
                Passed++;
                return;
            }
            string line = "[" + group + "] " + what;
            Failures.Add(line);
            Console.WriteLine("  FAIL " + line);
        }

        public static void Eq(string got, string want, string what)
        {
            True(string.Equals(got, want, StringComparison.Ordinal), what + ": got '" + got + "', want '" + want + "'");
        }

        public static void Near(double got, double want, double tol, string what)
        {
            bool ok = !double.IsNaN(got) && Math.Abs(got - want) <= tol;
            True(ok, what + ": got " + N(got) + ", want " + N(want) + " (tol " + N(tol) + ")");
        }

        public static void Near(double? got, double want, double tol, string what)
        {
            if (!got.HasValue)
            {
                True(false, what + ": got null, want " + N(want));
                return;
            }
            Near(got.Value, want, tol, what);
        }

        /// <summary>The tolerance rule of physio/golden.json: |got - want| &lt;= abs + rel * |want|.</summary>
        public static void Golden(double got, double want, double abs, double rel, string what)
        {
            bool ok = !double.IsNaN(got) && Math.Abs(got - want) <= abs + rel * Math.Abs(want);
            True(ok, what + ": got " + N(got) + ", want " + N(want));
        }

        public static string N(double v)
        {
            return v.ToString("R", CultureInfo.InvariantCulture);
        }
    }
}

using System.Globalization;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>
    /// JSON access for planner files. Culture-invariant (this app runs on machines that write decimal commas) and
    /// date strings stay strings (the planner's UTC texts must not be re-formatted).
    /// </summary>
    public static class HlJson
    {
        public static JToken Parse(string text)
        {
            using (var sr = new StringReader(text))
            using (var jr = new JsonTextReader(sr))
            {
                jr.DateParseHandling = DateParseHandling.None;
                jr.FloatParseHandling = FloatParseHandling.Double;
                jr.Culture = CultureInfo.InvariantCulture;
                return JToken.ReadFrom(jr);
            }
        }

        static JToken Get(JToken obj, string key)
        {
            return obj == null || obj.Type != JTokenType.Object ? null : obj[key];
        }

        public static bool IsNull(JToken t)
        {
            return t == null || t.Type == JTokenType.Null || t.Type == JTokenType.Undefined;
        }

        public static string Str(JToken obj, string key)
        {
            JToken t = Get(obj, key);
            if (IsNull(t)) return null;
            return t.Type == JTokenType.String ? (string)t : t.ToString(Formatting.None);
        }

        public static double Num(JToken obj, string key)
        {
            JToken t = Get(obj, key);
            if (IsNull(t)) throw new InvalidDataException("missing number: " + key);
            return ToDouble(t);
        }

        public static double? NumOrNull(JToken obj, string key)
        {
            JToken t = Get(obj, key);
            return IsNull(t) ? (double?)null : ToDouble(t);
        }

        public static bool Bool(JToken obj, string key, bool fallback)
        {
            JToken t = Get(obj, key);
            return IsNull(t) ? fallback : (bool)t;
        }

        public static double? Nullable(JToken t)
        {
            return IsNull(t) ? (double?)null : ToDouble(t);
        }

        public static double ToDouble(JToken t)
        {
            if (t.Type == JTokenType.Float || t.Type == JTokenType.Integer) return t.Value<double>();
            if (t.Type == JTokenType.String) return double.Parse((string)t, NumberStyles.Float, CultureInfo.InvariantCulture);
            throw new InvalidDataException("not a number: " + t.ToString(Formatting.None));
        }

        public static double[] Doubles(JToken arr)
        {
            if (IsNull(arr)) return null;
            var a = (JArray)arr;
            var r = new double[a.Count];
            for (int i = 0; i < r.Length; i++) r[i] = ToDouble(a[i]);
            return r;
        }

        /// <summary>Culture-invariant number text for logs and HUD strings.</summary>
        public static string F(double v, int decimals)
        {
            return v.ToString("F" + decimals.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
        }
    }
}

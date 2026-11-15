using System;
using System.Collections.Generic;
using System.Globalization;
using Newtonsoft.Json.Linq;

namespace NasaSpaceApp.Homeline
{
    /// <summary>A landmark the planner lists for a station: where to look for it from there.</summary>
    public sealed class CardLandmark
    {
        public string Name;
        public double BearingDeg, DistKm;
        /// <summary>True when the planner computed that it rises above the skyline; false = bearing only.</summary>
        public bool AboveSkyline;
    }

    /// <summary>
    /// What the planner knows about a science station (planner/cards/{id}.json of the official plan bundle): what
    /// is there, which landmarks lie in which direction, the way home, what to do if the partner goes down, and
    /// the latest departure. The texts are the planner's own; nothing is invented here.
    /// </summary>
    public sealed class StationCard
    {
        public string Id;
        /// <summary>The science target, in the planner's words.</summary>
        public string Name;
        public string Contingency;
        public double? THomeMin, O2HomeL, TurnBackMin;
        public string TurnBackBinding;
        public int? NavcamSol;
        public string NavcamCredit;
        public readonly List<CardLandmark> Landmarks = new List<CardLandmark>();
    }

    public static class StationCards
    {
        /// <summary>Every card of a plan bundle, by station id. Unreadable cards are skipped.</summary>
        public static Dictionary<string, StationCard> FromBundle(BundleReader plan)
        {
            var cards = new Dictionary<string, StationCard>(StringComparer.Ordinal);
            foreach (BundleFile f in plan.Index.Files.Values)
            {
                string p = f.Path;
                if (p == null || !p.StartsWith("planner/cards/", StringComparison.Ordinal) || !p.EndsWith(".json", StringComparison.Ordinal)) continue;
                try
                {
                    StationCard c = Parse(plan.ReadJson(p));
                    if (c != null && !string.IsNullOrEmpty(c.Id)) cards[c.Id] = c;
                }
                catch (Exception)
                {
                    // A damaged card must not hide the others.
                }
            }
            return cards;
        }

        public static StationCard Parse(JToken j)
        {
            var c = new StationCard();
            c.Id = HlJson.Str(j, "station");
            JToken observer = j["observer"];
            c.Name = HlJson.IsNull(observer) ? null : HlJson.Str(observer, "name");
            c.Contingency = HlJson.Str(j, "contingency");
            c.THomeMin = HlJson.NumOrNull(j, "t_home_min");
            c.O2HomeL = HlJson.NumOrNull(j, "o2_home_L");
            JToken timeline = j["timeline"];
            if (!HlJson.IsNull(timeline)) c.TurnBackMin = HlJson.NumOrNull(timeline, "turn_back");
            c.TurnBackBinding = HlJson.Str(j, "turn_back_binding");
            JToken navcam = j["navcam"];
            if (!HlJson.IsNull(navcam))
            {
                double? sol = HlJson.NumOrNull(navcam, "sol");
                if (sol.HasValue) c.NavcamSol = (int)sol.Value;
                c.NavcamCredit = HlJson.Str(navcam, "credit");
            }
            JArray landmarks = j["landmarks"] as JArray;
            if (landmarks != null)
            {
                foreach (JToken l in landmarks)
                {
                    double? bearing = HlJson.NumOrNull(l, "bearing_deg"), dist = HlJson.NumOrNull(l, "dist_km");
                    string name = HlJson.Str(l, "name");
                    if (string.IsNullOrEmpty(name) || !bearing.HasValue || !dist.HasValue) continue;
                    c.Landmarks.Add(new CardLandmark { Name = name, BearingDeg = bearing.Value, DistKm = dist.Value, AboveSkyline = HlJson.Bool(l, "above_skyline", false) });
                }
                c.Landmarks.Sort((a, b) => a.DistKm.CompareTo(b.DistKm));
            }
            return c;
        }

        /// <summary>
        /// The card as a few lines of text. <paramref name="planSpecific"/>: include the lines that hold only on the
        /// official, unedited plan (contingency from this point, latest departure). <paramref name="movedM"/>: how
        /// far the station was moved by hand from the planner's point (0 = not moved).
        /// </summary>
        public static string Text(StationCard c, bool planSpecific, double movedM, int maxLandmarks, EditStop activity = null)
        {
            var sb = new System.Text.StringBuilder(320);
            sb.Append(c.Id).Append(": ").Append(string.IsNullOrEmpty(c.Name) ? "science station" : c.Name);
            if (activity != null && activity.HasActivity)
            {
                sb.Append("\nPlanned here");
                if (activity.Tags != null && activity.Tags.Length > 0) sb.Append(": ").Append(string.Join(", ", activity.Tags));
                sb.Append(" (stop ").Append(HlJson.F(activity.DwellMin, 0)).Append("\u00a0min).");
                if (!string.IsNullOrEmpty(activity.Note)) sb.Append(" Note: ").Append(activity.Note);
            }
            if (movedM >= 1.0)
                sb.Append("\nMoved ").Append(HlJson.F(movedM, 0)).Append(" m by hand: the science target stays at the planner's point.");
            if (c.Landmarks.Count > 0)
            {
                sb.Append("\nLandmarks (bearing from the planner's point): ");
                int n = Math.Min(maxLandmarks, c.Landmarks.Count);
                for (int i = 0; i < n; i++)
                {
                    CardLandmark l = c.Landmarks[i];
                    if (i > 0) sb.Append(", ");
                    sb.Append(l.Name).Append(' ').Append(Math.Round(l.BearingDeg).ToString("000", CultureInfo.InvariantCulture)).Append("° ")
                      .Append(HlJson.F(l.DistKm, 1)).Append(" km").Append(l.AboveSkyline ? "" : " (below the skyline)");
                }
                sb.Append('.');
            }
            if (planSpecific && movedM < 1.0)
            {
                if (!string.IsNullOrEmpty(c.Contingency)) sb.Append('\n').Append(c.Contingency);
                if (c.TurnBackMin.HasValue)
                {
                    int total = (int)Math.Floor(c.TurnBackMin.Value + 0.5);
                    sb.Append("\nLatest departure ").Append((total / 60).ToString("0", CultureInfo.InvariantCulture)).Append('h')
                      .Append((total % 60).ToString("00", CultureInfo.InvariantCulture));
                    if (!string.IsNullOrEmpty(c.TurnBackBinding)) sb.Append(" (limit: ").Append(c.TurnBackBinding).Append(')');
                    sb.Append('.');
                }
            }
            sb.Append("\nStation card: HOMELINE planner");
            if (c.NavcamSol.HasValue) sb.Append("; skyline from Curiosity Navcam, sol ").Append(c.NavcamSol.Value.ToString(CultureInfo.InvariantCulture)).Append(" (NASA/JPL-Caltech)");
            sb.Append('.');
            return sb.ToString();
        }
    }
}

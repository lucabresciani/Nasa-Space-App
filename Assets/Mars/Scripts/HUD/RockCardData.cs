using System;
using System.Collections.Generic;
using System.Globalization;
using NasaSpaceApp.Science;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Display strings of one rock card, mapped from a scan result (spec §5.1). <see cref="Fill"/> runs once per scan
    /// and may allocate; the card view only reads the fields.
    /// </summary>
    public sealed class RockCardData
    {
        public const int MaxRows = 8;

        private const int MaxOxideRows = 7;
        private const int MaxMetalRows = 6;
        private const int FooterChars = 26;    // 208 px content width / 8 px advance at 14 px
        private const float OtherMinWt = 0.05f;
        private const string Sep = " · ";        // " · "
        private const string Dash = "—";         // "—"
        private const string NoDataMessage = "No reference data for this rock.";

        public bool HasData;
        public string FieldId, ClassLine, SectionLabel, SectionRight, Footer1, Footer2, EmptyMessage;
        public int RowCount;
        public readonly string[] RowLabel = new string[MaxRows];
        public readonly string[] RowValue = new string[MaxRows];   // already padded to 5 chars

        // Scratch list for the measured values of one Fill (strings only, no scene objects).
        private static readonly List<Measurement> s_Measured = new List<Measurement>(16);

        /// <summary>True when <paramref name="reading"/> yields at least one measured oxide or metal row.</summary>
        public static bool HasReading(RockReading reading)
        {
            return reading != null && (CountMeasured(reading.Oxides) > 0 || CountMeasured(reading.Metals) > 0);
        }

        /// <summary>Maps a scan to card rows: oxides (top 7 + OTH), else metals (+ derived Fe balance), else no data.</summary>
        public void Fill(RockScanResult r)
        {
            RockSample rock = r != null ? r.Rock : null;
            RockReading reading = r != null ? r.Reading : null;

            FieldId = ResolveFieldId(rock, reading);
            ClassLine = ResolveClassLine(reading != null ? reading.Class : null);

            RockAnalysis analog = reading != null ? reading.Analog : null;
            string inst = InstrumentShort(analog != null ? analog.Instrument : null);
            string target = analog != null ? analog.Target : null;
            Footer1 = HudStrings.Truncate("Analog: " + (string.IsNullOrEmpty(target) ? Dash : target), FooterChars);
            Footer2 = analog != null && analog.Sol.HasValue
                ? inst + Sep + "sol " + analog.Sol.Value.ToString(CultureInfo.InvariantCulture)
                : inst;

            SectionLabel = null;
            SectionRight = null;
            EmptyMessage = null;
            RowCount = 0;
            for (int i = 0; i < MaxRows; i++)
            {
                RowLabel[i] = null;
                RowValue[i] = null;
            }

            if (reading != null && CountMeasured(reading.Oxides) > 0)
            {
                FillOxides(reading, inst);
            }
            else if (reading != null && CountMeasured(reading.Metals) > 0)
            {
                FillMetals(reading, inst);
            }

            HasData = RowCount > 0;
            if (!HasData)
            {
                EmptyMessage = NoDataMessage;
            }
        }

        private void FillOxides(RockReading reading, string inst)
        {
            SectionLabel = "MAT COMP";
            SectionRight = "wt%" + Sep + inst;

            CollectSorted(reading.Oxides);
            int count = s_Measured.Count;
            int n = Math.Min(MaxOxideRows, count);
            float top = 0f;
            for (int i = 0; i < n; i++)
            {
                Measurement m = s_Measured[i];
                RowLabel[i] = HudStrings.Chem(m.Key);
                RowValue[i] = HudStrings.Wt(m.Value);
                top += m.Value;
            }
            float rest = 0f;
            for (int i = n; i < count; i++)
            {
                rest += s_Measured[i].Value;
            }

            // OTH: measured total minus the shown rows (the unreported 100 - total gap is not shown).
            float total = reading.OxideTotal;
            bool totalKnown = total > 0f && IsFinite(total);
            if (count > n || (totalKnown && total - top >= OtherMinWt))
            {
                float oth = totalKnown ? total - top : rest;
                RowLabel[n] = "OTH";
                RowValue[n] = HudStrings.Wt(Math.Max(0f, oth));
                n++;
            }
            RowCount = n;
            s_Measured.Clear();
        }

        private void FillMetals(RockReading reading, string inst)
        {
            SectionLabel = "METAL";
            SectionRight = "wt%" + Sep + inst;

            CollectSorted(reading.Metals);
            int count = s_Measured.Count;
            int n = Math.Min(MaxMetalRows, count);
            float sum = 0f;
            for (int i = 0; i < count; i++)
            {
                sum += s_Measured[i].Value;
            }
            for (int i = 0; i < n; i++)
            {
                Measurement m = s_Measured[i];
                RowLabel[i] = HudStrings.Chem(m.Key);
                RowValue[i] = HudStrings.Wt(m.Value);
            }
            // Iron is the balance (derived, labelled with "*").
            if (sum < 100f)
            {
                RowLabel[n] = "Fe*";
                RowValue[n] = HudStrings.Wt(100f - sum);
                n++;
                Footer2 += Sep + "*bal.";
            }
            RowCount = n;
            s_Measured.Clear();
        }

        // Measured = finite, not an upper limit, positive. Stable insertion sort, descending (ties keep database order).
        private static void CollectSorted(IReadOnlyList<Measurement> list)
        {
            s_Measured.Clear();
            for (int i = 0; i < list.Count; i++)
            {
                Measurement m = list[i];
                if (IsMeasured(m))
                {
                    s_Measured.Add(m);
                }
            }
            for (int i = 1; i < s_Measured.Count; i++)
            {
                Measurement m = s_Measured[i];
                int j = i - 1;
                while (j >= 0 && s_Measured[j].Value < m.Value)
                {
                    s_Measured[j + 1] = s_Measured[j];
                    j--;
                }
                s_Measured[j + 1] = m;
            }
        }

        private static int CountMeasured(IReadOnlyList<Measurement> list)
        {
            if (list == null)
            {
                return 0;
            }
            int n = 0;
            for (int i = 0; i < list.Count; i++)
            {
                if (IsMeasured(list[i]))
                {
                    n++;
                }
            }
            return n;
        }

        private static bool IsMeasured(in Measurement m)
        {
            return !m.IsUpperLimit && IsFinite(m.Value) && m.Value > 0f;
        }

        private static bool IsFinite(float v)
        {
            return !float.IsNaN(v) && !float.IsInfinity(v);
        }

        private static string ResolveFieldId(RockSample rock, RockReading reading)
        {
            if (reading != null && !string.IsNullOrEmpty(reading.FieldId))
            {
                return reading.FieldId;
            }
            if (rock != null)
            {
                return !string.IsNullOrEmpty(rock.FieldId) ? rock.FieldId : rock.name;
            }
            return Dash;
        }

        private static string ResolveClassLine(RockClass cls)
        {
            if (cls == null)
            {
                return "Unclassified";
            }
            string name = cls.Name ?? string.Empty;
            int cut = name.IndexOf(" (", StringComparison.Ordinal);
            if (cut > 0)
            {
                name = name.Substring(0, cut);
            }
            bool hasUnit = !string.IsNullOrEmpty(cls.UnitSymbol);
            if (name.Length == 0)
            {
                return hasUnit ? cls.UnitSymbol : "Unclassified";
            }
            return hasUnit ? cls.UnitSymbol + Sep + name : name;
        }

        private static string InstrumentShort(string instrument)
        {
            if (string.IsNullOrEmpty(instrument))
            {
                return Dash;
            }
            if (instrument.IndexOf("LIBS", StringComparison.Ordinal) >= 0)
            {
                return "LIBS";
            }
            if (instrument.IndexOf("APXS", StringComparison.Ordinal) >= 0)
            {
                return "APXS";
            }
            string trimmed = instrument.Trim();
            int space = trimmed.IndexOf(' ');
            return space > 0 ? trimmed.Substring(0, space) : trimmed;
        }
    }
}

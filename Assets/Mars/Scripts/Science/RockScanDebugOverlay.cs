using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.InputSystem;

namespace NasaSpaceApp.Science
{
    /// <summary>
    /// Developer readout for <see cref="RockScanner"/>: a crosshair and a plain text dump of the targeted
    /// rock's data. Temporary scaffolding to verify the raycast and the dataset until the real HUD
    /// panel exists. It is also the only crosshair for now, so it is drawn in every build; remove this
    /// component when the HUD replaces it (Assign Rock Data does not add it back). F3 toggles it.
    /// </summary>
    [RequireComponent(typeof(RockScanner))]
    public class RockScanDebugOverlay : MonoBehaviour
    {
        const float Width = 600f;

        [SerializeField] bool visible = true;

        RockScanner scanner;
        GUIStyle style;
        readonly StringBuilder text = new StringBuilder(2048);

        void Awake() => scanner = GetComponent<RockScanner>();

        void Update()
        {
            if (Keyboard.current != null && Keyboard.current.f3Key.wasPressedThisFrame) visible = !visible;
        }

        static string Num(float value, string format) => float.IsNaN(value) ? "n/a" : value.ToString(format);

        void AppendList(string label, IReadOnlyList<Measurement> values)
        {
            if (values.Count == 0) return;
            text.Append(label);
            foreach (Measurement m in values) text.Append(m.ToString()).Append("   ");
            text.AppendLine();
        }

        void OnGUI()
        {
            if (!visible) return;
            style ??= new GUIStyle(GUI.skin.box) { alignment = TextAnchor.UpperLeft, fontSize = 13, richText = false, wordWrap = true };

            var center = new Vector2(Screen.width * 0.5f, Screen.height * 0.5f);
            GUI.Label(new Rect(center.x - 6f, center.y - 10f, 24f, 20f), scanner.Target != null ? "[+]" : "+");

            text.Clear();
            RockReading r = scanner.TargetReading;
            if (scanner.Target == null)
            {
                text.Append("Rock scanner (debug, F3): aim at a rock within ").Append(scanner.Range.ToString("0.#")).Append(" m");
            }
            else if (r == null)
            {
                text.Append(scanner.Target.name).Append(": no science data (check the rock's class / analysis ids)");
            }
            else
            {
                text.Append(r.FieldId).Append("   ").Append(r.Class?.Name ?? r.Analog?.ClassId).Append("   ")
                    .Append(scanner.TargetHit.distance.ToString("0.0")).Append(" m   ")
                    .Append(scanner.HasScanned(scanner.Target) ? "[SCANNED]" : $"hold E to scan {Mathf.RoundToInt(scanner.ScanHoldProgress * 100f)}%")
                    .AppendLine();
                if (r.Analog != null)
                    text.Append("Analog: ").Append(r.Analog.Target).Append(" (").Append(r.Analog.Mission).Append(", ")
                        .Append(r.Analog.Instrument).Append(r.Analog.Sol.HasValue ? $", sol {r.Analog.Sol}" : "").Append(")").AppendLine();
                if (r.Class != null)
                    text.Append(r.Class.Epoch).Append(" ").Append(r.Class.AgeGa).Append(" Ga   ").Append(r.Class.Summary).AppendLine();

                AppendList("Oxides (wt%): ", r.Oxides);
                if (r.Oxides.Count > 0) text.Append("Total ").Append(r.OxideTotal.ToString("0.0")).Append(" wt%").AppendLine();
                AppendList("Metals (wt%): ", r.Metals);
                AppendList("Traces (ppm): ", r.Traces);
                AppendList("Minerals (wt%): ", r.Minerals);
                text.Append("Size ").Append(r.SizeM.x.ToString("0.00")).Append(" x ").Append(r.SizeM.y.ToString("0.00")).Append(" x ")
                    .Append(r.SizeM.z.ToString("0.00")).Append(" m   density ").Append(Num(r.DensityGcm3, "0.00"))
                    .Append(" g/cm3   est. mass ").Append(Num(r.MassKg, "0.#")).Append(" kg").AppendLine();
                text.Append("R(0.75um) ").Append(Num(r.Reflectance(0.75f), "0.000")).Append("   R(1.05um) ")
                    .Append(Num(r.Reflectance(1.05f), "0.000")).Append("   R(2.3um) ").Append(Num(r.Reflectance(2.3f), "0.000"));
            }
            text.AppendLine().Append("Scans: ").Append(scanner.ScanLog.Count);

            string s = text.ToString();
            var content = new GUIContent(s);
            GUI.Box(new Rect(16f, 16f, Width, style.CalcHeight(content, Width) + 8f), content, style);
        }
    }
}

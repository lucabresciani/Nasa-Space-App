using System.Text;
using UnityEngine;
using UnityEngine.InputSystem;

namespace NasaSpaceApp.Science
{
    /// <summary>
    /// Developer readout for <see cref="RockScanner"/>: a crosshair and a plain text dump of the targeted
    /// rock's data. Temporary scaffolding to verify the raycast and the dataset until the real HUD
    /// panel exists; remove this component (or untick it) then. F3 toggles it.
    /// </summary>
    [RequireComponent(typeof(RockScanner))]
    public class RockScanDebugOverlay : MonoBehaviour
    {
        [SerializeField] bool visible = true;

        RockScanner scanner;
        RockScanResult lastScan;
        GUIStyle style;
        readonly StringBuilder text = new StringBuilder(1024);

        void Awake() => scanner = GetComponent<RockScanner>();
        void OnEnable() => scanner.Scanned += OnScanned;
        void OnDisable() => scanner.Scanned -= OnScanned;
        void OnScanned(RockScanResult result) => lastScan = result;

        void Update()
        {
            if (Keyboard.current != null && Keyboard.current.f3Key.wasPressedThisFrame) visible = !visible;
        }

        void OnGUI()
        {
            if (!visible) return;
            style ??= new GUIStyle(GUI.skin.box) { alignment = TextAnchor.UpperLeft, fontSize = 13, richText = false, wordWrap = true };

            var center = new Vector2(Screen.width * 0.5f, Screen.height * 0.5f);
            GUI.Label(new Rect(center.x - 6f, center.y - 10f, 20f, 20f), scanner.Target != null ? "[+]" : "+");

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
                bool scanned = lastScan != null && lastScan.Rock == scanner.Target;
                text.Append(r.FieldId).Append("   ").Append(r.Class?.Name ?? r.Analog?.ClassId).Append("   ")
                    .Append(scanner.TargetHit.distance.ToString("0.0")).Append(" m");
                text.Append(scanned ? "   [SCANNED]" : $"   hold E to scan {Mathf.RoundToInt(scanner.ScanHoldProgress * 100f)}%").AppendLine();
                if (r.Analog != null)
                    text.Append("Analog: ").Append(r.Analog.Target).Append(" (").Append(r.Analog.Mission).Append(", ")
                        .Append(r.Analog.Instrument).Append(r.Analog.Sol.HasValue ? $", sol {r.Analog.Sol}" : "").Append(")").AppendLine();
                if (r.Class != null)
                    text.Append(r.Class.Epoch).Append("  ").Append(r.Class.Summary).AppendLine();

                int n = 0;
                foreach (Measurement m in r.Oxides)
                {
                    text.Append(m.Key).Append(' ').Append(m.Value.ToString("0.0")).Append(n % 4 == 3 ? "\n" : "    ");
                    n++;
                }
                text.Append("Total ").Append(r.OxideTotal.ToString("0.0")).Append(" wt%").AppendLine();
                if (r.Minerals.Count > 0)
                {
                    text.Append("Minerals: ");
                    foreach (Measurement m in r.Minerals) text.Append(m.Key).Append(' ').Append(m.Value.ToString("0.#")).Append("  ");
                    text.AppendLine();
                }
                text.Append("Size ").Append(r.SizeM.x.ToString("0.00")).Append(" x ").Append(r.SizeM.y.ToString("0.00")).Append(" x ")
                    .Append(r.SizeM.z.ToString("0.00")).Append(" m   density ").Append(r.DensityGcm3.ToString("0.00"))
                    .Append(" g/cm3   est. mass ").Append(r.MassKg.ToString("0.#")).Append(" kg").AppendLine();
                text.Append("R(0.75um) ").Append(r.Reflectance(0.75f).ToString("0.000")).Append("   R(1.05um) ")
                    .Append(r.Reflectance(1.05f).ToString("0.000")).Append("   R(2.3um) ").Append(r.Reflectance(2.3f).ToString("0.000"));
            }
            text.AppendLine().Append("Scans: ").Append(scanner.ScanLog.Count);

            GUI.Box(new Rect(16f, 16f, 560f, scanner.TargetReading != null ? 190f : 52f), text.ToString(), style);
        }
    }
}

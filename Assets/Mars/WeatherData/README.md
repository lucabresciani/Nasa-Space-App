# Historical weather data (Gale crater)

Used by `MarsWeather` historical mode (key H) through `MarsHistoricalClimate`. Both files are kept byte-for-byte as published.

| File | What | Source |
|---|---|---|
| `rems.json` | REMS seasonal statistics: daily min/max air temperature and pressure (median, p10, p90 over sols), Ls 10-35°, Mars years 36-38 | HOMELINE `web/public/data/conditions/rems.json` (github.com/LuxKaiwalker/home-line, commit 14a64c7), contract `contracts/rems.schema.json`, built from PDS `mslrem_1001` MODRDR |
| `msl_tau_880.csv` | Dust optical depth at 880 nm from Mastcam solar imaging; columns: image id, sol, Ls (deg), tau, sigma | PDS Atmospheres Node, `msl_mmm_tau_bundle/data_derived/msl_tau_880.csv` (Lemmon et al., doi:10.17189/fjh0-2978), downloaded 2026-11-14 |

Notes:
- Only air temperature and pressure are used from `rems.json` (HOMELINE decision D37: ground temperature and UV dropped).
- The tau record is filtered to the same Ls window and Mars years as `rems.json`. It ends at sol 3953 (MY 37), so MY 38 has no tau in this window: the season statistics use MY 36-37 (56 measurements, median tau 0.69).
- To update: re-run HOMELINE's `pipeline/conditions/rems.py` and copy the new `rems.json` here; re-download the PDS csv. No code change is needed as long as the formats stay the same.

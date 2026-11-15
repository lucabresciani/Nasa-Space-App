# ☢️ WS4 brief — Conditions

**Mission:** radiation, weather and clock. RAD current rate, the 20 May 2024 storm replay with the local tripwire and the dose-budget leash; REMS climatology; Mars time, sun and light time; DONKI context.

**Human owner / reviewer:** G · **Features:** F14 · **SPEC:** §2.2 F14, §3 fix 2, §5.1 items 10–13

## Owns

`pipeline/conditions/`, `config/conditions.yaml`, `tests/test_rad.py`, `tests/test_clock.py`, `data/raw/conditions/`

## Produces

| File | Content |
| --- | --- |
| `conditions/rad.json` | Per contract: latest rate and lag, baseline, storm series, peak, excess, onset, tripwire time, leash |
| `conditions/rems.json` | Same-season (Ls 10–35°) climatology: temperature, pressure, UV daily ranges; latest sol marked stale |
| `conditions/clock.json` | Event-weekend LMST at Gale, Ls, sunrise/sunset; light time (Horizons) |
| `conditions/sun.py` API | Sun azimuth/elevation at any LMST, for WS2 (daylight margin), WS8 (lighting), WS7 (HUD) |
| `conditions/donki.json` | Cached records, labelled "context only, not a trigger" |

## Tasks (target time)

1. **H0–H1:** cache RAD L2 (storm window + last 30 days), DONKI, Horizons, REMS feed; variable names from `discovery.md`.
2. **H1–H4:** RAD parser with units; storm numbers by midpoint interpolation; tripwire; leash; KATs.
3. **H4–H6:** Mars24 clock and sun; clock KAT against 3 Navcam image labels (frames from WS3).
4. **G1 (H10):** `rad.json` final; RAD chart data for WS5.
5. **H10–H14:** REMS climatology; sun API delivered to WS2/WS7/WS8.

## Tests (write first)

- Peak of 20 May 2024 within 8.1–8.4 mGy/day; event excess within 1.7–1.9 mGy; Q = 1 for the SEP.
- Tripwire fires before the peak, on two consecutive samples > 3× baseline.
- τ_dose = 60 · D_allow / Ḋ recomputes for 0.35 mGy/h → ≈ 85 min at 0.5 mGy.
- Mars24 LMST vs image label ≤ 10 s on 3 frames; Ls on 2026-08-25 = 341.6° ± 0.2°.
- Every output value carries units.

## Don't

Trigger anything from DONKI; apply Q ≈ 3 to the SEP; present the REMS feed as current.

## Fallback

If CDAWeb is down: use the PDS RAD RDR archive for the storm; mark the "latest" rate as unavailable.

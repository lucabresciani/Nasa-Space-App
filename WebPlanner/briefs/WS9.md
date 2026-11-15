# 🧭 WS9 brief — Navigation

> ⏸️ **Suspended softly, 2026-11-14 14:19 CET (user): optional add-on.** F21 and F22 are no longer core (SPEC §2.4, D19). No new sessions start on this brief. Merged work stays in place and keeps working (nav outputs, `/nav`, the HUD ellipse, `nav.yaml`), labelled as an optional add-on. The core uses F19's flat drift rule + uncertainty circle and fixes at the rover pad and surveyed stations only.

**Mission:** the navigation layer. Simulated suit dead reckoning with Monte Carlo error ellipses and fix events, the fix-interval map, skyline-matching fixes on Curiosity's real Navcam frames, and the HUD and `/nav` integration.

**Human reviewers:** N (model), C (skyline fix), D (HUD) · **Features:** F21, F22 · **SPEC:** §2.4, §6.2

## Owns

`pipeline/navigation/deadreckon.py`, `montecarlo.py`, `fixinterval.py`, `skylinefix.py`, `web/src/nav/`, `config/nav.yaml`, `tests/test_nav.py`

## Reads

Route + timeline and slope (WS2/WS1), worst-case fields (WS7), the horizon engine API, sky detector and `navcam_frames.json` (WS3), the calibrated parameter set from WS10 if it lands.

## Produces

`nav/montecarlo_{set}.json`, `nav/tracks_{set}.geojson`, `nav/fixes.json`, `fields/fix_interval_{set}.png` + `nav/fix_interval_summary.json`, `localisation/{image_id}.json`, the `/nav` page and HUD nav components.

## Tasks (target time)

1. **H1–H4 (synthetic straight route):** error model per `nav.yaml` (step scale and noise, heading bias and random walk, slip); Monte Carlo (500 runs, seed fixed); 95% ellipses; r95(D) fit; KATs.
2. **H4–H8:** fix events and resets; HUD nav panel and ellipse on dummy data (with WS7).
3. **H10–H16 (after G1):** fix-interval map on real worst-case fields, per set; headline numbers (compute only, never quote earlier).
4. **H16–H20:** Monte Carlo on the real route and timeline; tracks; sample estimated track.
5. **H20–H23:** F22 skyline fixes at each station frame (coarse 50 m / 1° rays, far field ≥ 500 m; refine 10 m; σ from the score surface); feed fixes into playback; report every frame tried.
6. **G2:** F21 + F22 complete; else tell WS7 to keep the fallback drift rule and station fixes.

## Tests (write first)

- Zero-error parameters: estimate = truth.
- Heading bias only, straight route: lateral error matches the analytic value within 1%.
- 95% ellipse covers 93–97% of runs.
- Error resets at fixes.
- D_max smaller near the homeline edge and 0 outside it.
- Skyline fix on a synthetic DEM with a known observer: recovered within one grid step.

## Don't

Present the odometry as a real system; compare our fix accuracy favourably with MGL; quote fix-interval numbers that aren't in the manifest; run X8/X9 code (that's WS10).

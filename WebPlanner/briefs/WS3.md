# 🌄 WS3 brief — Horizon and camera

**Mission:** point horizons, panoramas, CAHVOR projection of the predicted skyline onto Curiosity's Navcam frames, and the skyline validation V2. Also provides the horizon engine and sky detector that WS9 uses for the navigation fix _(optional add-on since 2026-11-14, D19)_.

**Human owner / reviewer:** C · **Features:** F12, F13 (V2) · **SPEC:** §2.2 F12/F13, §5.1 items 4, 5, 9

## Owns

`pipeline/horizon/`, `pipeline/validation/v2_skyline.py`, `config/horizon.yaml`, `tests/test_horizon.py`, `tests/test_cahvor.py`, `data/interim/horizon/`, `data/raw/navcam/` cache

## Reads

`dem_1m.tif`, `coreg.json` (WS1), CTX and MOLA–HRSC windows, raw-image API (field names from `discovery.md`), MMGIS drive ends, `stations.json`, `pad.json` (contract in SPEC §6), `config/landmarks.yaml` + landmark coordinates in `docs/discovery.md`

## Produces

| File | Content |
| --- | --- |
| `navcam_frames.json` | Selected frames: image id, sol, site/drive, co-registered position, CAHVOR, attitude, LMST, local path; shared with WS9/WS10 |
| `horizons/{observer_id}.json` | 1,440 azimuths: elevation angle, distance to horizon point, source band |
| `cards/{station}/panorama.png`, `overlay.png` | Predicted panorama strip; transparent skyline overlay on the Navcam frame |
| `validation/v2.json` | Per frame and column: predicted vs detected angle; median and P90 by distance class; manual-check flags |
| `horizon_ring.json` | Far skyline ring for WS8 |

## Tasks (target time)

1. **H0–H2:** horizon ray engine (Numba) on the dummy DEM, with KATs; start caching Navcam frames for drive ends in the focus area.
2. **H2–H4:** CAHVOR projection + attitude transform; KATs (round trip, A-vector, yaw) on 3 real frames; record Navcam height (C-vector).
3. **H4–H8:** first real overlay at one station (MVP fallback frame), hand-checked by C.
4. **H8–H12:** frame selection for ≥ 30 stops (skyline visible, in the focus area); sky detector; manual check of 20% (D7: switch to fully manual if the detector fails by 23:00).
5. **Overnight:** horizons at stations, pads and all validation stops; V2 statistics by distance class; panoramas and overlays for every station card.
6. **By H20:** hand the horizon engine API, sky detector and `navcam_frames.json` to WS9 for F22. _(2026-11-14, D19: F22 is an optional add-on, so this hand-off is optional too.)_

## Tests (write first)

- Curvature drop at 20 km = 58.9 m (R = 3,396.19 km).
- A 100 m wall at 1 km seen from 1.7 m eye height = 5.61°.
- CAHVOR projection round trip < 0.5 px on synthetic points.
- Projected A-vector azimuth and rover yaw within 1° of the image label on 3 frames.
- Horizon on a flat infinite plane = −(curvature dip) within 0.01°.

## Don't

Use Mastcam (no camera model); quote near-field error in any summary meant for the video; drop frames that fail (report them).

## Fallback

If the attitude chain can't be made to pass KATs by Sat 23:00: hand-align one frame per station by yaw only, label it "hand-aligned", and report V2 as not available.

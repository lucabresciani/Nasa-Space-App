# 🧾 WS6 brief — Provenance and validation

**Mission:** make every number traceable and the build reproducible. Provenance manifest, the H0 check, CI, V1 tilt validation and the final clean-run regeneration.

**Human owner / reviewer:** G (CI jointly with C) · **Features:** F13 (V1), F16 · **SPEC:** §2.2 F13/F16, §9, Agent kit CI section

## Owns

`pipeline/provenance/`, `pipeline/validation/v1_tilt.py`, `pipeline/validation/figures.py`, `.github/workflows/` (with C), `tests/test_provenance.py`

## Produces

| File | Content |
| --- | --- |
| `manifest.py` API | `record(key, value, units, file, script)` adds commit hash and UTC time; used by every workstream |
| `manifest.json` | Merged manifest for the web app |
| `check_h0.py` | Fails if any manifest time or any data file mtime in `web/public/data/` is before 2026-11-14 09:00 local |
| `validation/v1.json`  • figure | DEM slope over the rover's ≈ 3 m footprint vs IMU tilt at every drive end in the focus area: bias, RMSE, r, confusion matrix at 10°/20° |
| CI workflow | ruff, pytest, tsc, vite build, schema validation, H0 check, no-dummy check, size check |

## Tasks (target time)

1. **H0–H1:** `manifest.py` API and `check_h0.py` (first, so everyone can use them); CI workflow with C.
2. **H4–H8:** V1 tilt validation on WS1 slope + co-registered drive ends; deliver the slope RMSE to WS1 for the conservative limit.
3. **Every 4 h:** the reviewer audit: units, CRS, nodata handling and manifest coverage across workstreams; findings into `STATUS.md`.
4. **Sun 12:00 freeze:** `make clean all` from scratch on a clean checkout; compare outputs with the live site; provenance audit; sign-off.

## Tests

H0 check fails on a planted pre-H0 timestamp and passes otherwise; manifest merge keeps keys unique; V1 on a synthetic 10% plane gives bias ≈ 0.

## Don't

Let any number reach the web app without a manifest key; skip the clean run because "it worked before".

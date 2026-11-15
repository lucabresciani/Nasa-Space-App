# 🔎 H0 discovery checklist

> 🔎 **Owner: N**, with one agent session. **When:** Sat 09:00–10:30. Every check writes its finding into `docs/discovery.md` (URL, status, field names, CRS, nodata, sizes, surprises). Downstream agents read `discovery.md`, never guesses. If a check fails, note the fallback taken and tell the owning workstream.

## Rules and portal (G, 09:00–09:20)

- [ ] Read the 2026 Project Submission Guide and Judging & Awards Guide; note any change from the 2025 gates in SPEC §10.3
- [ ] Read the challenge Resources tab; map each item in SPEC §5.1 to a listed resource where one exists (prefer listed equivalents)
- [ ] Confirm demo limits (video ≤ 30 s or ≤ 7 slides), the SI-use field, team size limit, and the submission deadline in local time

## Terrain and imagery (for WS1, WS3, WS8)

- [ ] **Merged DEM** `MSL_Gale_DEM_Mosaic_1m_v3.vrt` (URL in `config/site.yaml`): `gdalinfo /vsicurl/…` → CRS, pixel size, nodata, band type, extent; time a 512 × 512 window read
- [ ] Does the mosaic publish source footprints (HiRISE / CTX / HRSC)? If not, record that D3 falls back to STAC footprints
- [ ] **USGS STAC** `mro_hirise_socet_dtms`: search the planning bbox; record item IDs and DTM asset hrefs for 009149 and 019698, and their footprints
- [ ] **USGS STAC** `mro_ctx_controlled_usgs_dtms`: items covering a 30 km radius; asset hrefs
- [ ] **MOLA–HRSC blended DEM 200 m**: direct COG/VRT URL; windowed read works
- [ ] **HiRISE ortho** `ESP_019698_1750_RED` and the Gale LRGB COG: URLs, CRS, coverage of the focus area
- [ ] **CRISM MTRDR** via PDS ODE (query URL in SPEC §12 sources of the panel report): product URLs for `FRT000058A3`, `FRT0000B6F1`; band names for SINDEX2 and D2300
- [ ] **THEMIS TI** tile 30S120E: URL

## Rover data (for WS1, WS3, WS9, WS10)

- [ ] **MMGIS** `MSL_waypoints.json`: field names for sol, site, drive, lon, lat, elevation, and tilt (roll/pitch/yaw or tilt); count drive ends in the focus area; read the 2025–26 boxwork drive ends; compute nothing else yet
- [ ] Find the drive end nearest sol 4200 (S4) and record it
- [ ] **Raw-image API** `mars.nasa.gov/api/v1/raw_image_items/`: working query for MSL Navcam (left/right) by sol; record the field names for the camera model (CAHVOR components), rover attitude (quaternion or angles), site/drive, LMST, image URL; check whether frames exist *during* drives (for the X8 probe)
- [ ] Record the Navcam C-vector height above ground on 3 frames (for `navcam_height_m`)

## Landmarks (for WS3, added 13 Nov)

- [ ] **IAU Gazetteer of Planetary Nomenclature** (Mars): download the feature list or shapefile; record centre coordinates for every official name in `config/landmarks.yaml` within 80 km of the pad
- [ ] Informal names (Boxwork unit, Vera Rubin Ridge, Greenheugh Pediment): find a coordinate in an MMGIS layer or a JPL release; if none is verifiable, drop the name

## Conditions (for WS4)

- [ ] **CDAWeb HAPI** info for `MSL_RAD_OBS-L2`: variable name and units for dose rate; time coverage end date; sample cadence
- [ ] **REMS** feed URL and latest sol; PDS `mslrem_1001` file layout for the Ls 10–35° window
- [ ] **DONKI** with the personal key: CME, ENLIL and notification endpoints for 2024-05-13 to 2024-05-22
- [ ] **JPL Horizons API**: Earth–Mars light time for 14–15 Nov 2026

## Environment

- [ ] Venue bandwidth test (download 100 MB from the ASC S3 bucket); if under ~5 MB/s, switch WS1 to windowed reads only and start the phone-hotspot fallback
- [ ] `NASA_API_KEY` set in every agent environment
- [ ] Every machine's clock NTP-synced with `TZ=Europe/Zurich`; `date -u` shows the same UTC time everywhere (a build log already showed a wrong future timestamp)
- [ ] GDAL ≥ 3.8 with `/vsicurl/` works on every laptop running a pipeline agent

## Output

`docs/discovery.md` with one section per item above, then a summary table: item · OK / changed / failed · consequence · workstream told. N posts "discovery complete" in `STATUS.md` by 10:30, and D3 is decided at G0 from it.

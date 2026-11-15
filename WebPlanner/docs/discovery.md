# H0 discovery findings (D0, post-H0 run)

> **Run:** agent session D0, Sat 2026-11-14, 09:31–09:45 UTC (10:31–10:45 CET), after H0. Every finding below comes from a check run in this session. The deprecated pre-H0 report (`~/coding/homeline/docs/discovery.md`) was read only for which endpoints and commands to try. Where today's result differs from it, the line says **"differs from old report"**.
> **Evidence:** raw responses are in `raw/` next to this file. The byte ledger is `raw/_ledger.tsv`, with one row per request and the API key redacted. Analysis scripts are in `tools/`: `env.sh` (fetch helpers plus the ledger), `cov.py`, `rawapi_fetch.py`, `vo_probe.py` and `conventions.py`.
> **Download total: 38.96 MB** over 93 logged requests. That is under the 50 MB budget. HEAD-only probes and two 2 KB partial probes are not in the ledger, and together they come to less than 0.1 MB. The largest single item is a deliberate 8 MB bandwidth sample.
> **Coordinates:** "pad" means `site.yaml pad_default` (137.382 E, −4.806). The planning bbox is pad ± 3,700 m: lon 137.3194–137.4446, lat −4.8684 to −4.7436. The 30 km bbox is 136.8741–137.8899, −5.3121 to −4.2999. "Focus" means `aoi_focus` (137.37–137.42, −4.82 to −4.77). Sphere R = 3,396,190 m, so 1° = 59,274.70 m.
> **Honesty:** values are what the endpoints returned. Inferences are labelled as such. Unknown stays unknown.

## 1. Rules and portal: skipped

Per the instructions, a human (G) checks these. D0 did not.

## 2. Terrain and imagery (WS1, WS3, WS8)

### 2.1 Merged DEM `MSL_Gale_DEM_Mosaic_1m_v3.vrt`: **changed (not a COG; striped rows)**

- **URL:** `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.vrt`. This is a 1,799 B VRT with one SimpleSource, `MSL_Gale_DEM_Mosaic_1m_v3.tif` (3,868,256,546 B, Last-Modified 2022-11-09). Beside it sit `…tif.ovr` (649,622,735 B) and `…_v3_deg.vrt`, a geographic lon/lat wrapper at 1.68706e-5°/px.
- **CRS:** `Mars_Equirectangular_clon0` on the Mars 2000 sphere, R = 3,396,190; central meridian 0, standard parallel 0. This is **not** the analysis CRS (`lat_ts −4.8, lon_0 137.39`), so WS1 must reproject.
- **Grid:** 32,980 × 57,440 at 1.000 m. Origin (8,127,993.493, −244,781.075). Extent 137°07′27″–137°40′50″ E, 4°07′47″–5°05′55″ S. `AREA_OR_POINT=Point`, whereas the HiRISE and CTX COGs say `Area`: mind the half-pixel offset.
- **Band:** Float32, nodata −32767, LZW, `INTERLEAVE=BAND`. Stored statistics: min −4625.9, max −322.6, mean −3641.8 m. These are areoid heights, consistent with HiRISE and CTX geoid-adjusted (2.3, 2.4).
- **Block = 32980 × 1:** every row is one LZW strip across the full width. **Window cost:** a 512 × 32 read at the pad (pad pixel col 15283, row 40093) fetched 2.62 MB; a 512 × 16 read fetched 1.35 MB in 4.2 s. That is about 80 KB per row, so **a 512 × 512 window ≈ 41 MB (estimated, not run, to stay in budget)**, and the full planning window (about 7,400 rows) ≈ 0.6 GB.
- **The 4 m overview is tiled:** the `.ovr` is 8,245 × 14,360 Float32 in 128 × 128 tiles, with sub-levels down to 129 × 225. A 512 × 512 window (about 2 km) cost 1.85 MB in 6.0 s. The old report did not say the `.ovr` is tiled.
- **Pad value:** −3627.68 m.
- **Fallback / advice:** pull the 1 m rows once with `gdal_translate -srcwin` into `data/raw/` and never tile-read repeatedly. Use the `.ovr` for anything coarser than 4 m.
- Evidence: `dem_v3.vrt`, `dem_v3_deg.vrt`, `dem_v3_gdalinfo.out`, `dem_v3_tif_gdalinfo.out`, `dem_v3_ovr_gdalinfo.out`, `dem_v3_win512x{32,16}_pad.tif`, `dem_v3_ovr4m_win{128,512}_pad.tif`, `*.out` (network statistics).

### 2.2 Merged-DEM source footprints: **changed (not published)**

- The S3 listing of `mosaic/Mars/MSL/` (15 keys, not truncated) contains the DEM, the ortho, colour-shade legend files, the LRGB COG and a `.prj`. It has **no footprint vector**.
- The Astropedia page `https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m` says HRSC + CTX + HiRISE are tied to MOLA, and lists 12 HiRISE stereo pairs as text only, e.g. "PSP_009149_1755, PSP_009294_1755 'Traverse'" and "ESP_019698_1755, ESP_019988_1755 'T3'". The page uses `_1755` suffixes where STAC uses `_1750` IDs. CTX and HRSC have no IDs.
- **Fallback (D3):** use the STAC footprints from 2.3 and 2.4. Those are 4–5-vertex quads, not valid-data outlines.
- Evidence: `s3_list_mosaic_MSL.xml`, `astrogeo_mars_msl_gale_merged_dem_1m.html`, `astrogeo_dem_text.txt`.

### 2.3 USGS STAC `mro_hirise_socet_dtms`: **OK**

- **Query:** `https://stac.astrogeology.usgs.gov/api/search?collections=mro_hirise_socet_dtms&bbox=137.3194,-4.8684,137.4446,-4.7436&limit=100` returned `numberMatched` = 5.

| Item | Footprint coverage of focus / planning | Pad inside |
| --- | --- | --- |
| `DTEEC_009149_1750_009294_1750_U01` | 100% / 61.6% | yes |
| `DTEEC_019698_1750_019988_1750_U01` | 80.2% / 71.8% | yes |
| `DTEEC_040770_1755_039280_1755_A01` | 35.5% / 23.2% | no |
| `DTEEC_009650_1755_009716_1755_U01` | 9.4% / 25.7% | no |
| `DTEEC_001488_1750_001752_1750_U02` | 0% / 15.5% | no |

  The union of the five covers 100% of both, by footprint polygons.
- **DTM hrefs:**
  - `https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/PSP_009149_1750_PSP_009294_1750/DTEEC_009149_1750_009294_1750_U01.tif`
  - `…/ESP_019698_1750_ESP_019988_1750/DTEEC_019698_1750_019988_1750_U01.tif`
  - 040770 sits at the folder root: `…/controlled/dtm/DTEEC_040770_1755_039280_1755_A01.tif`.
- **Footprints (lon, lat):**
  - 009149: (137.353, −4.6898) (137.443, −4.6764) (137.468, −4.9115) (137.382, −4.923)
  - 019698: (137.312, −4.7396) (137.402, −4.7294) (137.439, −5.0298) (137.348, −5.0398)
- **Format:** COG (`LAYOUT=COG`), Float32, DEFLATE, 512² blocks, 5–6 overviews. Nodata −3.4028227e+38. Pixel 1.011746795 m (not exactly 1 m). CRS "Mars (2015) – Sphere / Ocentric / Equirectangular, clon = 0", R = 3,396,190. Sizes: 009149 is 6,749 × 14,466; 019698 is 7,426 × 18,270.
- **Window read:** 507 × 507 (512 m) at the pad from 019698 cost 2.11 MB in 4.2 s. Heights −3636.6 to −3533.9 m, so areoid-referenced. **Pad −3611.54 m**.
- **Raw offset against the merged DEM** (512 × 32 pad strip, 16,384 cells, bilinear, no co-registration): HiRISE − merged has median **+11.6 m** (p5 7.0, p95 14.3), and +16 m at the pad pixel. The old report found +13.0 m on a different strip, 240 m north. This is input for WS1 coreg, not a coreg result.
- **Surprises:**
  - Every item's `datetime` is the placeholder 2006-09-29, so don't use it.
  - Only the 040770 item lists ORTHO assets. The 009149 and 019698 orthos exist (2.6) but are not STAC assets.
- Evidence: `stac_hirise_dtms_planning_bbox.json`, `stac_hirise_summary.txt`, `gdalinfo_DTEEC_*.out`, `hirise019698_dtm_win512m_pad.tif`.

### 2.4 USGS STAC `mro_ctx_controlled_usgs_dtms`: **OK (thousands of overlapping pair items)**

- **Counts** (`numberMatched`): 30 km bbox **6,059**; pad point (`intersects`) **3,263**; whole collection **44,628**. The collection's temporal extent is 2023-04-18 to 2025-07-04.
- **Assets per item:** `geoid_adjusted_dem` (`-DEM-geoid-adj.tif`), `dem` (`-DEM.tif`), `hillshade`, `intersection_error`, `orthoimage` (`-DRG.tif`), `final_offsets` (CSV), `provenance`, `qa_metrics`, `thumbnail`.
  - Example: `https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/T01_000815_1749_XN_05S222W__P22_009716_1773_XI_02S223W/T01_000815_1749_XN_05S222W__P22_009716_1773_XI_02S223W-DEM-geoid-adj.tif`
- **Format** (that item): COG, Float32, LZW, 512² blocks, 20 m, nodata −32767, 1,558 × 3,697 px (137.09–137.62 E, −4.14 to −5.39). Same clon 0 sphere CRS.
- **Critical:** at the pad, `geoid_adjusted_dem` = **−3608.9 m** while raw `dem` = **−4176.1 m**, a 567 m gap. **Use `geoid_adjusted_dem`.** The values differ from the old report because the item differs; the conclusion is the same.
- **Coverage of the 30 km bbox:** the first 500 of the 3,263 pad items were fetched with `fields=id,bbox,geometry`. The best single footprint polygon covers **46.1%** (`P21_009149_1752…__K10_057108_1747…`, `P22_009650_1772…__P22_009716_1773…`).
  - **This differs from the old report's 75%.** It measured bboxes; this run intersected polygons.
  - **WS3 should plan on a mosaic of several CTX items, or MOLA–HRSC (2.5), beyond about 15 km.**
- **Window reads:** a 2.56 km window of geoid-adj cost 1.05 MB in 3.7 s; a 0.4 km window of raw dem cost 1.02 MB in 2.7 s.
- Evidence: `stac_ctx_30km_bbox_first10.json`, `stac_ctx_pad_point_first10.json`, `stac_ctx_pad_point_idbbox.json` (500 items), `stac_ctx_all_count.json`, `stac_ctx_collection.json`, `gdalinfo_ctx_T01_000815_geoidadj.out`, `ctx_T01_000815_*_pad.tif`.

### 2.5 MOLA–HRSC blended DEM 200 m: **changed (cheap to window with direct IO)**

- **URL:** `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif`. 11,384,463,908 B, Last-Modified 2022-11-09. The folder also has a `.vrt`, a `.tif.ovr` (3.8 GB) and the v1 files.
- **CRS:** **geographic** lon/lat, GCS_Mars_2000_Sphere (R = 3,396,190). Pixel 0.003374120830641° (200 m). 106,694 × 53,347 px, Int16, nodata −32768, uncompressed, **Block = 106694 × 1**, `AREA_OR_POINT=Area`.
- **Window cost:**
  - **Default reads fetch whole rows:** a 32 × 4 window cost 0.93 MB, about 217 KB per row.
  - **With `--config GTIFF_DIRECT_IO YES`, GDAL range-reads only the needed bytes of each uncompressed strip:** a 128 × 128 window cost 0.90 MB, of which about 0.85 MB is the strip-offset table read once. **The full 80 km radius window (804 × 801 px, lon 136.028–138.736, lat −3.456 to −6.156) cost 2.16 MB in 15.9 s.**
  - **This differs from the old report**, which paid 171.7 MB for the same window.
- **Values:** heights −4688 to +813 m; **pad −3615 m**.
- **Advice:** WS3 sets `GTIFF_DIRECT_IO=YES` for this file and fetches its own window. This works because the file is uncompressed. It does **not** help the LZW-compressed merged DEM (2.1).
- Evidence: `gdalinfo_mola_hrsc.out`, `s3_list_HRSC_MOLA_Blend.xml`, `mola_hrsc_200m_win80km.tif`, `mola_*.out`.

### 2.6 HiRISE ortho `ESP_019698_1750_RED` and the Gale LRGB COG: **changed (names), OK**

- **HiRISE ortho:** the name in config is not a file. The controlled products are:
  - `…/controlled/dtm/ESP_019698_1750_ESP_019988_1750/ESP_019698_1750_RED_A_01_ORTHO.tif`: 0.2529 m, 29,704 × 73,081
  - `…_RED_C_01_ORTHO.tif`: 1.0117 m, 7,426 × 18,270
  - Both are UInt16 COG DEFLATE, nodata 0, in the DTM's CRS.
  - **Valid-data coverage of the focus area** (measured on an overview): 019698 **84.6%** (its east edge misses part of the box), and `PSP_009149_1750_RED_A_01_ORTHO.tif` (0.2529 m, 26,998 × 57,863) **99.9%**. The old report gave 80% by quad, not by valid pixels.
- **Gale LRGB COG:** `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif`. It is 1,030,625,379 B, a COG with YCbCr JPEG compression and 3 Byte bands plus a per-dataset mask, 36,000 × 76,000 at 0.25 m.
  - CRS: equirectangular clon 0, R = 3,396,190. UL (8,140,000, −270,000), LR (8,149,000, −289,000), which is 137.327–137.479 E, −4.555 to −4.876.
  - **Focus valid coverage 100%** (4 m overview).
  - A companion `…_cog.txt` credits Parker & Calef: HiRISE colour strips fused to the RED ortho mosaic, sharpened.
  - **Differs from the old report:** this key now **does** appear in the bucket listing.
- **Also present:** the grey 25 cm mosaic `MSL_Gale_Orthophoto_Mosaic_25cm_v3.tif` (24.4 GB, with an `.ovr` of 4.2 GB).
- Evidence: `gdalinfo_*_ORTHO.out`, `gdalinfo_lrgb.out`, `lrgb_cog.txt`, `cov_*.out`.

### 2.7 CRISM MTRDR via PDS ODE: **OK**

- **Query:** `https://oderest.rsl.wustl.edu/live2/?query=product&results=fp&output=JSON&target=mars&ihid=MRO&iid=CRISM&pt=MTRDR&productid=<ID>*` returned Status Success for both.
- **FRT000058A3** (pdsid `frt000058a3_07_if165j_mtr3`), summary parameters: `https://pds-geosciences.wustl.edu/mro/mro-m-crism-5-rdr-mptargeted-v1/mrocr_4001/mtrdr/2007/2007_112/frt000058a3/frt000058a3_07_su165j_mtr3.img` (139,003,200 B), with `.hdr`, `.lbl` and `.xml` beside it. 788 × 735 × 60 bands.
- **FRT0000B6F1:** `…/mtrdr/2008/2008_191/frt0000b6f1/frt0000b6f1_07_su165j_mtr3.img` (about 132.8 MB). 775 × 714 × 60.
- **Band names** (ENVI `.hdr`, 1-based): **`D2300` = band 40**, **`SINDEX2` = band 42**. Identical in both products.
- **Format:** BSQ, Float32 (`data type = 4`), little-endian (`byte order = 0`), header offset 0, ignore value 65535. Map: MRO Mars Equirectangular [IAU 2000] clon 0, **18 m**.
  - UL: 58A3 (8,139,847.9, −277,771.17); B6F1 (8,138,478.6, −278,195.96).
  - The pad lies inside both rasters: 58A3 col 190, row 394; B6F1 col 266, row 371.
- **Byte ranges work** (HTTP 206). Pad values were read with 4-byte ranges: 58A3 D2300 −0.00187, SINDEX2 0.00459; B6F1 D2300 −0.00191, SINDEX2 0.01074. **WS1 can fetch just bands 40 and 42**: offset = (band−1) × samples × lines × 4, about 2.3 MB per band.
- Evidence: `ode_crism_mtrdr_*.json`, `crism_*_su.hdr`, `crism_range_test.*`.

### 2.8 THEMIS TI tile 30S120E: **OK**

- **Page:** `https://astrogeology.usgs.gov/search/map/themis_thermal_inertia_mosaic_quantitative_30s120e_100mpp`
- **File:** `https://asc-astropedia.s3.us-west-2.amazonaws.com/Mars/Odyssey/THEMIS-Global-Thermal-Inertia-Mosaic/Quantitative-32-Bit/THEMIS_TI_Mosaic_Quant_30S120E_100mpp.cub`. An ISIS3 cube, 2,532,510,196 B, Last-Modified 2023-06-17.
- **Grid:** 35,565 × 17,782 at 100 m, Float32, 128² tiles, nodata −3.4028227e+38. SimpleCylindrical, R = 3,396,190. Covers 120–180 E, 0 to 30 S.
- **Window read:** GDAL reads it directly over `/vsicurl/`. An 8 km window at the pad cost 0.15 MB. TI at the pad is **391.5** (window 211–682).
- Evidence: `astrogeo_themis_ti_30s120e.html`, `gdalinfo_themis_ti.out`, `themis_ti_win8km_pad.tif`.

## 3. Rover data (WS1, WS3, WS6, WS9, WS10)

### 3.1 MMGIS `MSL_waypoints.json`: **OK**

- **URL:** `https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json`. 665,124 B, Last-Modified 2026-11-13 19:13 UTC. GeoJSON FeatureCollection of 1,389 Point features, **sols 3–5073**, with **no new sol since the old run**.
- **Fields:** `RMC` ("site_drive"), `site`, `drive`, `sol`, `easting`, `northing`, `elev_geoid` (m, areoid), `lon`, `lat`, `roll`, `pitch`, `yaw` (deg), `yaw_rad`, `tilt` (deg), `dist_m`, `dist_total_m`, `dist_km`, `dist_mi`, `drive_type`.
  - `easting`/`northing` = lon/lat × 59,274.70 m/deg to within 0.02 m, i.e. equirectangular clon 0, R = 3,396,190.
  - The geometry is [lon, lat, elev_geoid].
  - No nulls. Every `drive_type` is `final`, so the file holds **drive ends only**.
- **Tilt:** `tilt` = acos(cos roll · cos pitch) within 0.02° for 1,382 of 1,389 records. Seven differ, by up to 5.06°: sols 574, 1346, 1438, 1489, 1630, 4064, 4616. The minimum tilt is −2.24 (sol 1630, an anomaly).
- **Focus area:** 290 drive ends, sols 3898–4959. Tilt median 8.64°, max 22.37°; 104 records ≥ 10°, 3 ≥ 20°.
- **2025–26 drive ends:** sol ≥ 4410, where sol 4409.6 ≈ 2025-01-01 by elapsed time since landing (approximate). There are 176, spanning lon 137.3791–137.3970, lat −4.8260 to −4.7836; 148 are inside focus. **Since sol ~4960 the rover has been just south of the focus box:** sols 5014–5073 sit at lat −4.8246 to −4.8260.
- **Pad check** (`pad_default` 137.382, −4.806):
  - Mean of the 176: (137.384939, −4.805652), **175 m** away.
  - Median: (137.383194, −4.806744), **83 m** away. The old report said ≈ 75 m; the coordinates are identical, so the distance arithmetic differs.
  - Mean of the 148 in focus: **265 m** away.
  - No definition reproduces `pad_default` exactly. **C/WS1 decide; D0 changes no config.**
- **Other layers:** the MMGIS configuration is public at `https://mars.nasa.gov/maps/location/api/configure/get?mission=MSL`. **This differs from the old report**, which found `config.json` returned 403; it still does, but this API path works.
  - Layers: `MSL_waypoints_current.json` (the latest drive end), `MSL_waypoints.json`, `MSL_SurfaceSites.json` (4 drill-site features: `Name`, `site`, `pos`), `MSL_traverse.json`, and the tile layers Labels (`MSL_WebGIS_PlaceText/{z}/{x}/{y}.png`, **a raster**), LRGB basemap and CTX 6 m.
- Evidence: `mmgis_MSL_waypoints.json`, `mmgis_summary.txt`, `mmgis_api_config_MSL.json`, `mmgis_MSL_SurfaceSites.json`, `mmgis_MSL_waypoints_current.json`.

### 3.2 S4: drive end nearest sol 4200: **OK**

An exact sol match: **RMC 107_2484**, lon **137.408864**, lat **−4.78570678**, elev_geoid −3688.38 m, tilt 14.30°, dist_m 9.11. It is inside the focus area. The neighbours are 107_2394 (sol 4197) and 107_2054 (sol 4193).

### 3.3 Raw-image API: **OK** (one improvement over the old report)

- **Working query** (no key needed):

  ```
  https://mars.nasa.gov/api/v1/raw_image_items/?order=date_taken+asc&per_page=200&page=N&condition_1=msl:mission&condition_2=<SOL>:sol:in&search=NAV_LEFT_B|NAV_RIGHT_B
  ```

  Paginate while `more` is true.
  - `per_page=200` works.
  - **`search=NAV_LEFT_B|NAV_RIGHT_B` now returns both cameras** (sol 5069: 652 = 318 + 334). **This differs from the old report**, which got 0. A space-separated search returns 0.
  - The total across all MSL items is 1,519,190 (at 09:3x UTC). The latest sol is 5073.
- **Fields per item:**
  - Identity: `id`, `imageid`, `instrument` (`NAV_LEFT_B`/`NAV_RIGHT_B`), `sol`, `site`, `drive`, `spacecraft_clock`
  - Times: `date_taken` (UTC, whole seconds), `date_received`, `created_at`, `updated_at`
  - Geometry: `subframe_rect` "(x,y,w,h)", **1-based, in output pixels**: (1,1,256,256) for downsampled and (1,1,64,64) for thumbnails, verified on one JPG (256 × 256). `scale_factor` is 1, 4 or 16.
  - Camera model: `camera_model_type` (`CAHVOR` for Navcam) and `camera_model_component_list`, six ";"-separated triples C;A;H;V;O;R.
  - Pose: `camera_position` (= C), `camera_vector` (= O direction), `attitude` (4-tuple), `xyz` (rover position in the site frame, m)
  - Image links: `url` and `https_url` (JPG)
  - `extended.{lmst "Sol-05073M14:40:19.749", mast_az, mast_el, sample_type full|downsampled|thumbnail|subframe, filter_name, bucket, contributor, url_list}`
  - Also `title`, `description`, `link`, `image_credit`.
- **Camera models in downsampled frames are in downsampled pixels:** the focal length |H×A| has median 1224.7 px at full resolution, 306.2 at 256², and 76.5 at 64². Do not rescale them.
- Conventions (attitude and CAHVOR): see 3.3a.
- Evidence: `rawapi_msl_latest5.json`, `rawapi_msl_sol{5073,5070,5069,5045,5041}_NAV_{LEFT,RIGHT}_B.json`, `rawapi_combined_search_test*.json`, `d0_conventions.txt`.

#### 3.3a Conventions verified

- **Attitude** = quaternion **(w, x, y, z)**, rover → site frame (North, East, Down). Its ZYX Euler angles match MMGIS yaw/pitch/roll at all 5 drive ends tested.
  - 125_2274: (146.49, 14.69, −0.36) against MMGIS (146.5, 14.67, −0.34).
  - 125_1194: (−140.35, 7.65, 7.93) against (−140.35, 7.67, 7.89).
  - 125_2490 is off by 0.2° in pitch. That stop has 2 distinct quaternions, and the first one was used.
- **CAHVOR frame** = rover frame, **+X forward, +Y right, +Z down**. For 6 full frames, A matches (cos el·cos az, cos el·sin az, −sin el) from `mast_az`/`mast_el` within 0.53°. Example: az 340°, el −30° gives A = (0.816, −0.300, 0.494).
- The constant 0.53° is probably the mast/rover tilt between the mast angles and the camera model. That is an inference.

#### 3.3b Navcam frames during drives (input for the X8 / WS10 probe)

The 5 most recent drives were used: sols 5041, 5045, 5069, 5070 and 5073, all at site 125. Their drive ends are about 270–360 m south of the focus box's south edge (−4.82), in the current boxwork traverse. "During" means `prev_end_drive < drive < end_drive` at the same site.

| Sol | Drive (prev → end) | MMGIS m | **256² L/R pairs during** | Poses | Pair spacing median (max) | Drive-count step | Longest run ≤ 2 m | Full-res pairs during | CAHVOR + attitude |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5073 | 125_2274 → 125_2490 | 27.9 | **35** | 35 | 0.946 m (1.13) | 6 | 35 | 2 (1 pose) | yes, all |
| 5070 | 125_2082 → 125_2274 | 28.7 | **31** | 31 | 0.945 m (1.02) | 6 | 31 | 2 (1 pose) | yes, all |
| 5069 | 125_1326 → 125_2082 | 101.3 | **124** | 124 | 0.953 m (1.20) | 6 | 124 | 2 (1 pose) | yes, all |
| 5045 | 125_1194 → 125_1326 | 12.6 | **21** | 21 | 0.933 m (1.19) | 6 | 21 | 4 (2 poses, 4.96 m apart) | yes, all |
| 5041 | 125_558 → 125_1194 | 83.9 | **106** | 103 | 0.985 m (1.29) | 6 | 103 | 2 (1 pose) | yes, all |

- **Yes, Navcam L/R frames exist during drives, not only at stops.** They are the `TRAVxx` sequence: one stereo pair every 6 drive counts, about **0.95 m**, roughly every 50–59 s.
  - The frames are **downsampled 256 × 256** (scale 4), plus 64 × 64 thumbnails of the same poses.
  - Each pose has its own `xyz` and `attitude`: on sol 5069, 124 distinct of each, with yaw drifting from 141.6° to 147.0°.
  - Each pose has a CAHVOR model.
  - Only 1–2 full-resolution (1024²) pairs per drive are taken mid-drive (`NCAM`, az 340°/10°, el −30°).
- **Pointing during the drive:**
  - The mast is fixed at **az 90°, el −29°**, looking right and down, on sols 5073, 5069, 5045 and 5041.
  - On **sol 5070 it is az 0°, el −29°** (forward).
  - Expect a near-field ground view, not the skyline.
- **Differs from the old report:** sol 5073 now has its 35 downsampled pairs. Before, it had only thumbnails, because the frames had not yet been downlinked. Sol 5045 replaces 5018 in the set.
- **Against `nav.yaml vo_probe.go_rule`** (≥ 2 drives with ≥ 10 consecutive stereo pairs at ≤ 2 m spacing, with camera models):
  - **met on 5 of 5 drives at 256²;**
  - not met at full resolution on any drive.
  - **D16 (go/no-go) is N's decision.**
- Evidence: `d0_vo_probe.txt`, `d0_vo_probe_summary.json`, `navcam_sample_downsampled_NLB_847487372.jpg`.

### 3.4 Navcam C-vector height (`navcam_height_m`): **changed (frame origin unknown)**

`-C_z` (rover frame, +Z down) on full frames:

| Frame | Mast el | `-C_z` |
| --- | --- | --- |
| `NRB_847595044EDR_F1252274NCAM00279M_` | −3.3° | 1.934 m |
| `NLB_847595044EDR_F1252274NCAM00279M_` | −3.4° | 1.933 m |
| `NRB_847852920EDR_F1252490NCAM00282M_` | −4.6° | 1.931 m |
| `NLB_845014724EDR_F1251194NCAM00353M_` | −52.8° | 1.836 m |

- Across 48 full frames with |el| < 12°, the median is **1.924 m**. All 2,287 frames range 1.835–2.026 m, because C moves with mast elevation.
- **Caveat:** this is the height above the **rover-frame origin**. The API does not give that origin's height above the ground. Config `1.9` is within range; C/WS3 decide.

### 3.5 Landmarks (WS3)

- **IAU Gazetteer: OK.** `https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.zip`, 5,421,247 B, **Last-Modified 2026-11-14 09:07 UTC** (regenerated today). It is a 2,055-point shapefile.
  - Fields: `name, clean_name, approvaldt, origin, diameter, center_lon, center_lat, type, code, approval, min_lon, max_lon, min_lat, max_lat, ethnicity, continent, quad_name, quad_code, link`.
  - The metadata says **planetocentric, 0–360, positive East**. Surprise: the `.prj` declares an ellipsoid with 1/169.89 flattening. Treat the coordinates as planetocentric per the metadata.
- **Within 80 km of the pad** (great circle, R = 3,396,190; all "Adopted by IAU"):

| Name | Type | center_lon E | center_lat | Diameter (km) | Distance | Bearing |
| --- | --- | --- | --- | --- | --- | --- |
| Gediz Vallis | Vallis | 137.4362 | −4.8537 | 8.3 | 4.3 km | 131.5° |
| Yellowknife | Crater | 137.44 | −4.58 | 0.12 | 13.8 km | 14.3° |
| Sakarya Vallis | Vallis | 137.33 | −5.10 | 26.0 | 17.7 km | 190.0° |
| Aeolis Palus | Palus | 137.4215 | −4.4652 | 111.6 | 20.3 km | 6.6° |
| Aeolis Mons | Mons | 137.8453 | −5.0834 | 89.0 | 31.9 km | 121.0° |
| Peace Vallis | Vallis | 137.2273 | −4.2057 | 35.2 | 36.7 km | 345.6° |
| Gale | Crater | 137.811 | −5.3672 | 154.1 | 41.8 km | 142.7° |
| Dulce Vallis | Vallis | 136.5395 | −4.8185 | 32.5 | 49.8 km | 269.1° |

  All five official candidates in `landmarks.yaml` are present. A large feature's centre is not its summit or rim.
- **Informal names** (Boxwork unit, Vera Rubin Ridge, Greenheugh Pediment): **failed / not verified.**
  - MMGIS labels are a **raster** tile layer (PlaceText PNGs), so there is no vector coordinate.
  - `MSL_SurfaceSites.json` holds only 4 drill sites.
  - No JPL release coordinate was checked.
  - Per `drop_if`, these names drop unless WS3/C find a verifiable coordinate.
- Evidence: `MARS_nomenclature_center_pts.zip`, `iau_mars_center_pts/`, `iau_mars.csv`, `d0_iau_within_80km.txt`.

## 4. Conditions (WS4)

### 4.1 CDAWeb RAD `MSL_RAD_OBS-L2`: **changed (not on HAPI; CDAS REST works)**

- **HAPI:** `https://cdaweb.gsfc.nasa.gov/hapi/info?id=MSL_RAD_OBS-L2` returns **HTTP 400, code 1406 "unknown dataset id"**. The HAPI catalog has 3,651 ids, and its only MSL id is `MSL_HELIO1HR_POSITION`.
- **Working fallback, the CDAS REST API:**
  - `https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets?idPattern=MSL.*` lists `MSL_RAD_OBS-L1`, `MSL_RAD_OBS-L2` and `MSL_HELIO1HR_POSITION`. L2 coverage is **2011-11-20T18:29:59Z → 2026-11-11T16:37:16Z**. The latest record was confirmed in data: 11-11-2026 16:37:16, a lag of about 2.7 days.
  - Data: `…/datasets/MSL_RAD_OBS-L2/data/<YYYYMMDDTHHMMSSZ>,<…>/DOSIMETRY_TOTAL_f?format=text` (send `Accept: application/json`). This returns `FileDescription[0].Name`, a temporary URL to the text file.
- **Variables:** `ALIVE_TIME[_f]`, `DOSIMETRY_TOTAL[_f]`, `DOSIMETRY_TIMESLICE[_f]`, `LET_A1A2[_f]`, `HISTOGRAM_NEUTRAL_{DE,D,E}[_f]`, `FLAGGED_DATA`. `_f` means quality filtered.
- **Dose rate:** **`DOSIMETRY_TOTAL_f`** has 3 columns, **`TOTAL_DOSE_B`, `RTG_CORRECTED_DOSE_B`, `TOTAL_DOSE_E`**, all in **`uGray/day_(good_Q)`** (µGy/day). B is silicon; E is tissue-equivalent plastic. Fill is −1.0E+31, with 81 fill values in 12–22 May 2024.
- **Cadence:** median spacing 1026 s (about 17 min); p5 546 s, minimum 170 s. 185 intervals are under 700 s, during the storm (8-minute mode).
- **Time tag:** **inferred to be observation START.** The daily `START_TIME` (20240512_00:03:44) equals the first EPOCH. `STOP_TIME` (2024-05-13 00:02:09) is 961 s after the last EPOCH (23:46:08), which is about one 16-minute observation. The metadata does not say this explicitly.
- **Cross-check** (D0 only, not the WS4 product). Baseline = median of 2024-05-12 to 19; window = 19–23 May; trapezoid on epochs, positive part only:

| Column | Baseline µGy/d | Peak µGy/d (2024-05-20 06:15:19) | Excess mGy |
| --- | --- | --- | --- |
| `TOTAL_DOSE_B` | 165.3 | 7354.3 | 1.574 |
| `RTG_CORRECTED_DOSE_B` | 106.8 | 7295.7 | 1.574 |
| `TOTAL_DOSE_E` | 152.3 | **8377.9** | **1.735** |

  **Only `TOTAL_DOSE_E` falls in `conditions.yaml expected`** (peak 8.1–8.4 mGy/day, excess 1.7–1.9 mGy). This agrees with the old report.
- Evidence: `hapi_info_MSL_RAD_OBS-L2.json`, `hapi_catalog.json`, `cdas_datasets_MSL.json`, `cdas_RAD_L2_variables.json`, `cdas_rad_l2_DOSIMETRY_TOTAL_f_20240512_20240523.txt`, `cdas_rad_l2_latest_20261110_14.txt`, `d0_rad_crosscheck.txt`.

### 4.2 REMS feed and PDS `mslrem_1001`: **changed (feed stale, as configured)**

- **Feed:** `https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json`, returning `{descriptions, soles[4745]}`.
  - **Latest: sol 4995, 2026-08-25, Ls 341.** This matches `feed_stale_since`.
  - Fields: `id, terrestrial_date, sol, ls, season, min_temp, max_temp, pressure, pressure_string, abs_humidity, wind_speed, wind_direction, atmo_opacity, sunrise, sunset, local_uv_irradiance_index, min_gts_temp, max_gts_temp`. All are strings, with `--` for missing.
  - The disclaimer says "intended for outreach purposes only. Any other use is discouraged."
- **Ls 10–35° windows** (from the feed's sol/ls):
  - MY38: sols **4382–4435** (2024-12-03 … 2025-01-27). **The feed has gaps** at 4397–4403 and 4416–4424.
  - MY37: 3714–3767. MY36: 3045–3098. Earlier years are in the feed.
- **PDS layout:** `https://atmos.nmsu.edu/PDS/data/mslrem_1001/DATA/SOL_aaaaa_bbbbb/SOLnnnnn/RME_<sclk>{ADR,RMD,RNV,RTL}<sol>…_P1.{TAB,LBL,xml}`.
  - The latest folder is `SOL_04710_04843`, so the latest PDS sol is **4843**.
  - MY38's window sits in `SOL_04355_04488`.
- **RMD (MODRDR):** fixed-length ASCII CSV, `RECORD_BYTES` 372, **40 columns** (`LABEL/MODRDR6.FMT`), about 1 Hz (**34,580 rows** for sol 4400), −999.00 for missing.
  - Columns: `TIMESTAMP, LMST, LTST, HORIZONTAL_WIND_SPEED, VERTICAL_WIND_SPEED, WIND_DIRECTION, WS_CONFIDENCE_LEVEL, BRIGHTNESS_TEMP, …, BOOM1_LOCAL_AIR_TEMP, …, AMBIENT_TEMP, AMBIENT_TEMP_CONFIDENCE_LEVEL, UV_A…UV_E (+ uncertainties), LOCAL_RELATIVE_HUMIDITY, HS_TEMP, …, VOLUME_MIXING_RATIO, …, PS_CONFIGURATION, PRESSURE, PRESSURE_UNCERTAINTY, PS_CONFIDENCE_LEVEL`.
- **File sizes for sol 4400:** ADR 5.0 MB, **RMD 12 MB**, RNV 22 MB, RTL 27 MB. A Mars-year window of RMD (54 sols) ≈ 650 MB, so subset it or stream and aggregate.
- Evidence: `rems_feed_msl_weather.json`, `pds_mslrem_*.html`, `pds_mslrem_SOL04400_RMD.LBL`, `pds_mslrem_MODRDR6.FMT`, `pds_mslrem_SOL04400_RMD_head.TAB`.

### 4.3 DONKI with the personal key, 2024-05-13 to 2024-05-22: **OK**

| Endpoint | HTTP | Items | Fields |
| --- | --- | --- | --- |
| `https://api.nasa.gov/DONKI/CME?startDate=…&endDate=…&api_key=…` | 200 | 55 | `activityID, catalog, startTime, instruments, sourceLocation, activeRegionNum, note, cmeAnalyses, linkedEvents, sentNotifications, link, submissionTime, versionId` |
| `/DONKI/WSAEnlilSimulations` | 200 | 53 | `simulationID, modelCompletionTime, au, cmeInputs, estimatedShockArrivalTime, isEarthGB, isEarthMinorImpact, rmin_re, kp_18/90/135/180, estimatedDuration, impactList, link`; 24 runs list Mars in `impactList` |
| `/DONKI/notifications?type=all` | 200 | 56 | `messageType, messageID, messageURL, messageIssueTime, messageBody` |
| `/DONKI/SEP` | 200 | 6 | all on **2024-05-13** (STEREO A, GOES, SOHO, models); **none on 2024-05-20** |
| `/DONKI/IPS` | 200 | 5 | `catalog, activityID, location, eventTime, …` |
| `/DONKI/FLR` | 404 | – | not needed |

- The rate limit showed 2,499 remaining at the first call.
- The key was read from `~/.config/nasa_api_key` into the environment. It was never printed or saved; the ledger redacts it, and a grep of `raw/` for the key found nothing.

### 4.4 JPL Horizons: Earth–Mars light time, 14–16 Nov 2026: **OK**

- **Query:** `https://ssd.jpl.nasa.gov/api/horizons.api?format=json&COMMAND='499'&EPHEM_TYPE='OBSERVER'&CENTER='500@399'&START_TIME='2026-11-14 00:00'&STOP_TIME='2026-11-16 00:00'&STEP_SIZE='6 h'&QUANTITIES='20,21'` (API v1.2).
- **1-way down light time** (geocentre to Mars):

| UTC | Light time (min) | delta (au) |
| --- | --- | --- |
| 14 Nov 00:00 | 11.0144 | 1.32436 |
| 14 Nov 12:00 | 10.9790 | |
| 15 Nov 00:00 | 10.9436 | |
| 15 Nov 12:00 | 10.9082 | |
| 16 Nov 00:00 | 10.8727 | 1.30733 |

- Evidence: `horizons_mars_lighttime_20261114_16.json`.

### 4.5 Clock: LMST longitude of the MSL labels (for WS4)

- **Method:** for all 2,287 Navcam frames on the 5 sols, compare `extended.lmst` with Mars24 MST + lon_E/15, using TT − UTC = 69.184 s. Script: `tools/conventions.py`.

| Longitude used | Median error | Median \|error\| | Max \|error\| |
| --- | --- | --- | --- |
| **137.4085° E** (best fit) | −0.05 s | 0.23 s | 0.55 s |
| 137.39 (`clock.gale_lon_east_deg`) | +4.39 s | 4.39 s | 4.86 s |
| 137.4417 (landing site) | −8.02 s | 8.02 s | 8.52 s |

- `date_taken` has 1 s resolution. The old report found 137.4083, so the two agree within that resolution.

## 5. Environment

- **Bandwidth:** the 100 MB test was **not run** (budget). Instead, one 8 MB range GET from the ASC S3 DEM gave **1.75 MB/s** (single stream). The IAU zip from a different S3 bucket ran at 0.79 MB/s, and small COG windows take about 2–6 s each because latency dominates.
  - **Under the 5 MB/s threshold:** use windowed reads only, avoid whole-row reads on striped LZW sources (2.1), and keep the hotspot fallback ready.
  - This was measured from this machine; whether it is at the venue is unknown.
- **`NASA_API_KEY`:** present on this machine (`~/.config/nasa_api_key`), and DONKI returns 200. Other agents' environments were not checked.
- **GDAL:** 3.12.4 with `/vsicurl/` works on this machine. uv-managed CPython 3.11.15 with rasterio works. Other laptops were not checked.
  - Surprise: uv's CPython has no CA bundle for `urllib` (SSL CERTIFICATE_VERIFY_FAILED). The Nix `python3` works, and rasterio's GDAL HTTPS works.
- **Clock:** `timedatectl` reports "System clock synchronized: yes, NTP service: active". `date -u` (09:42:51Z) matches the S3 `Date` header (09:42:53 GMT) within the request time.
- **TZ surprise (confirmed again):** on this NixOS host, `TZ=Europe/Zurich` silently gives **UTC labelled "Europe" (+0000)**. This happens in `date`, in Python `time.strftime`, and even in `timedatectl`'s display "(Europe, +0000)", because zoneinfo lives in `/etc/zoneinfo` and there is no `/usr/share/zoneinfo`.
  - With TZ unset (`/etc/localtime` → Zurich), or with `TZDIR=/etc/zoneinfo`, it correctly gives CET +0100. Python `zoneinfo.ZoneInfo('Europe/Zurich')` is also correct.
  - **Fix:** leave TZ unset or export `TZDIR=/etc/zoneinfo`; always write timestamps in UTC.

## 6. Summary

| Item | Status | Consequence | Tell |
| --- | --- | --- | --- |
| Rules and portal (3) | skipped | A human checks these | G |
| Merged DEM 1 m v3 | changed | Not a COG: 1-row LZW strips, about 80 KB/row; a 512² window ≈ 41 MB and the planning window ≈ 0.6 GB. Clon-0 CRS, not the analysis CRS. `AREA_OR_POINT=Point`. The 4 m `.ovr` is **tiled** (cheap) | WS1 |
| DEM source footprints | changed | Not published; D3 falls back to STAC quads | WS1, C (D3) |
| HiRISE DTMs (STAC) | OK | 009149 (100% focus) and 019698 (80%) are COGs at 1.0117 m; areoid; HiRISE − merged ≈ +11.6 m raw at the pad; STAC datetimes are placeholders | WS1 |
| CTX DTMs (STAC) | OK | 3,263 items at the pad; use `geoid_adjusted_dem` (raw is 567 m lower); best single polygon covers **46%** of the 30 km bbox (old report: 75% by bbox), so mosaic several | WS3, WS1 |
| MOLA–HRSC 200 m | changed | Geographic CRS, uncompressed 1-row strips; **with `GTIFF_DIRECT_IO=YES` the 80 km window costs 2.2 MB, not 172 MB** | WS3 |
| HiRISE ortho + LRGB | changed | Config name is not a file: use `…_RED_A_01_ORTHO` (0.25 m) or `_C_01` (1 m). 019698 covers 84.6% of focus (valid pixels), 009149 99.9%, LRGB COG 100% | WS1, WS8 |
| CRISM MTRDR | OK | SU `.img` URLs; D2300 = band 40, SINDEX2 = band 42; BSQ little-endian; byte ranges allow 2.3 MB per band | WS1 |
| THEMIS TI 30S120E | OK | ISIS3 `.cub` readable over `/vsicurl/`; pad TI 391.5 | WS1 |
| MMGIS waypoints | OK | Drive ends only (sols 3–5073); has `tilt` and roll/pitch/yaw; 290 in focus; pad centroid is off by 83–265 m depending on definition; MMGIS config API is public; labels are raster only | WS1, WS6, C |
| S4 (sol 4200) | OK | 107_2484 at 137.408864, −4.785707, −3688.38 m | WS1 |
| Raw-image API | OK | `search=NAV_LEFT_B\|NAV_RIGHT_B` now works; CAHVOR in rover frame (+X fwd, +Y right, +Z down); attitude (w,x,y,z) rover→NED matches MMGIS; downsampled models already scaled | WS3, WS9, WS10 |
| Frames during drives (X8) | OK | L/R pairs every ~0.95 m with CAHVOR and per-pose attitude, **256² only**; go rule met on 5/5 drives at 256² (0/5 at full res); mast looks right and down (az 90°, el −29°) | WS10, N (D16) |
| Navcam C height | changed | −C_z 1.924 m median near-horizontal (range 1.835–2.026), measured above the rover-frame origin, not the ground | WS3, WS9, C |
| Landmarks: IAU | OK | 8 official names within 80 km (table 3.5); gazetteer regenerated today | WS3 |
| Landmarks: informal | failed | No verifiable coordinate (MMGIS labels are raster); drop per rule | WS3, C |
| RAD L2 | changed | Not on HAPI; use CDAS REST; `DOSIMETRY_TOTAL_f` (µGy/day; B, B_rtg, E); epoch = start (inferred); data end 2026-11-11 16:37; **E matches the expected numbers** | WS4, G |
| REMS | changed | Feed stale at sol 4995 (2026-08-25); PDS to sol 4843; RMD 12 MB per sol at 1 Hz; MY38 Ls 10–35 = sols 4382–4435 (feed has gaps) | WS4 |
| DONKI | OK | CME, ENLIL, notifications, SEP and IPS work with the key; no SEP on 2024-05-20 | WS4 |
| Horizons light time | OK | 11.014 → 10.873 min over 14–16 Nov 2026 | WS4 |
| Bandwidth | changed | 1.75 MB/s single stream (100 MB test not run); windowed reads only | WS1, all |
| `NASA_API_KEY` / GDAL 3.12.4 | OK | This machine only; uv CPython's urllib lacks CA certificates | C |
| Clock / TZ | changed | NTP synced; `TZ=Europe/Zurich` gives UTC labelled "Europe" on NixOS; use `TZDIR=/etc/zoneinfo` or leave TZ unset | C, WS6 |

## 7. Answers for workstreams

- **RAD variable names (WS4):**
  - Dataset `MSL_RAD_OBS-L2`, served by CDAS REST and **not HAPI**.
  - Variable **`DOSIMETRY_TOTAL_f`** (quality filtered; unfiltered is `DOSIMETRY_TOTAL`). Its components are `TOTAL_DOSE_B`, `RTG_CORRECTED_DOSE_B` and **`TOTAL_DOSE_E`**, in `uGray/day_(good_Q)`. Fill is −1e31.
  - `rad.dose_variable` should be **`DOSIMETRY_TOTAL_f` / `TOTAL_DOSE_E`**: it alone reproduces 8.38 mGy/day and 1.74 mGy. G to confirm.
  - The time tag is the observation **start** (inferred).
  - Cadence is about 17 min, or about 8 min during events.
- **CAHVOR frame convention (WS3, WS9, WS10):**
  - `camera_model_component_list` = "C;A;H;V;O;R" triples, in the **rover frame +X forward, +Y right, +Z down** (A matches mast az/el within 0.53°).
  - `camera_position` = C, and `camera_vector` ≈ O.
  - The models are already in the delivered image's pixel units: focal length about 1225 px at full resolution, 306 at 256², 77 at 64².
  - `subframe_rect` is 1-based, in output pixels.
  - `attitude` = quaternion **(w, x, y, z)**, rover → site frame (N, E, Down); its ZYX Euler = MMGIS yaw/pitch/roll. `xyz` = rover position in the site frame (m).
  - **Not verified:** the pixel-origin convention (0- or 1-based) inside CAHVOR, and the rover-frame origin's height above the ground.
- **LMST longitude (WS4):**
  - The MSL label LMST matches Mars24 at **137.4085° E** (median |error| 0.23 s over 2,287 frames).
  - With `clock.gale_lon_east_deg: 137.39` the error is a systematic +4.4 s (inside a 10 s tolerance, but biased). The landing site 137.4417 gives −8.0 s.
  - The label format is `Sol-NNNNNMhh:mm:ss.sss`.
- **MMGIS fields (WS1, WS6, WS9):**
  - Fields: `RMC, site, drive, sol, easting, northing, elev_geoid, lon, lat, roll, pitch, yaw, yaw_rad, tilt, dist_m, dist_total_m, dist_km, dist_mi, drive_type`. All are drive ends (`final`).
  - Easting and northing are in clon 0 equirectangular on R = 3,396,190; `elev_geoid` is areoid metres.
  - `tilt` is present and equals acos(cos roll·cos pitch), except for 7 records (one negative).
  - The current position is in `MSL_waypoints_current.json`.
  - The layer list comes from `https://mars.nasa.gov/maps/location/api/configure/get?mission=MSL`.
- **Light time (WS4):** 11.014 min (14 Nov 00:00 UTC) to 10.873 min (16 Nov 00:00 UTC).
- **`navcam_height_m` (config, WS3):** −C_z ≈ 1.92 m for near-horizontal pointing, measured above the rover-frame origin; whether 1.9 is right above the ground stays unknown.
- **`stations.S4` (config):** 107_2484, sol 4200, 137.408864, −4.785707.
- **`site.pad_default` (config):** not reproduced exactly; the 2025–26 median is 83 m away and the mean 175 m. For C/WS1.
- **`variants.ist2`:** not a discovery item; not checked.

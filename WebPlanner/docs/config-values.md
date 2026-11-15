# ⚙️ Config values (config/*.yaml)

> ⚙️ Paste each block into the named file at H0. Every value is either cited, decided (SPEC §11) or marked `assumed: true`. Values marked `verify_at_h0` are checked by the owner in the first hours and corrected in a PR. Agents never hard-code a constant that belongs here.

## config/site.yaml (WS1)

```yaml
crs:
  geographic: "Mars 2000 planetocentric, sphere R = 3396190 m"
  analysis_proj: "+proj=eqc +lat_ts=-4.8 +lat_0=0 +lon_0=137.39 +x_0=0 +y_0=0 +R=3396190 +units=m +no_defs"
  mars_radius_m: 3396190
aoi_focus: {west: 137.37, east: 137.42, south: -4.82, north: -4.77}
planning_radius_m: 3700          # flat 60-min disc at 0.98 m/s = 3528 m, plus margin
pad_default:
  lon: 137.382
  lat: -4.806
  rule: "centroid of Curiosity 2025-26 boxwork drive ends from MMGIS"
  verify_at_h0: true
grids_m: {dem: 1, route: 3, fields: 5, web: 10, siting_block: 20}
siting:                            # added 13 Nov (gap found by WS2); F8 rule
  block_m: 20
  max_slope_deg: 5
  require_assessed: true
  score: "sum of station values with conservative T_home <= 30 min"
  tiebreak: "lower elevation than the value-weighted station centroid"
  top_k: 3
coverage:
  pad_disc_assessed_min_pct: 90  # else move pad by the F8 rule
  source_edge_buffer_m: 20       # edges this close to a source boundary are labelled "data"
coreg: {search_m: 200, step_m: 2, metric: MAD}
slope:
  method: horn_3x3
  compare_window_m: 5
  nogo_deg: {optimistic: 25, nominal: 20, conservative: "20 - v1_rmse_deg"}
  flag_beyond_tested_deg: 17
ridge: {median_window_m: 15, threshold_m: 0.75, assumed: true}
roughness_window_m: 5
sources:
  merged_dem_vrt: "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.vrt"
  hirise_dtms: [DTEEC_009149_1750_009294_1750_U01, DTEEC_019698_1750_019988_1750_U01]
  hirise_ortho: ESP_019698_1750_RED
  crism_mtrdr: [FRT000058A3, FRT0000B6F1]
  themis_tile: 30S120E
```

## config/stations.yaml (WS1)

```yaml
scoring_weights: {crism: 0.4, ridge_density: 0.4, manual: 0.2}
ridge_density_radius_m: 25
crism_indices: {sulfate: SINDEX2, clay: D2300}
dwell_min: 30
max_stations_siting: 8
max_stations_dp: 12
stations:
  - id: S1
    name: "Boxwork ridge-hollow transect"
    rule: "highest (ridge_density + clay index) 25 m cell inside the focus area and inside the flat 30-min disc"
    manual_priority: 0.5
  - id: S2
    name: "Fracture-network survey"
    rule: "highest ridge_density cell at least 300 m from S1"
    manual_priority: 0.5
  - id: S3
    name: "Nodule census"
    rule: "hand pick by S on HiRISE ortho before H2; record lon/lat and the image used"
    manual_priority: 0.5
  - id: S4
    name: "Gediz Vallis sulfur field"
    rule: "Curiosity drive end nearest sol 4200 from MMGIS"
    manual_priority: 1.0
    verify_at_h0: true
  - id: S5
    name: "Debris-flow boulders"
    rule: "hand pick by S on HiRISE ortho before H2"
    manual_priority: 0.5
extra_from_scoring: {max: 3, decide_by: "Sat 23:00 (D8)"}
```

## config/crew.yaml (WS2)

```yaml
crew_size: 2
eva_h: 6.5
reserve_min: 30
o2_reserve_frac: 0.2              # r in the route margin, assumed
vo2max_ml_kg_min: 36
effort_cap_frac: 0.5
body_mass_kg: 75                  # assumed (D10)
suit_masses_kg: [80, 104, 120]    # 80 = our sensitivity value, labelled as such
default_suit_kg: 104
tools_kg: 10
g_mars: 3.71
anchor:
  vo2_ml_kg_min: 19.0             # ICES-2026-127, level walking, Mars offload
  speed_ms: 0.98                  # 2.2 mph
  carried_kg: 120
o2_energy_j_per_ml: 20.1
v_safe_ms:                        # assumed
  - {max_deg: 10, v: 1.0}
  - {max_deg: 17, v: 0.6}
  - {max_deg: 25, v: 0.3}
walkback_budgets_min: [30, 60]
heat_reference_btu_h: {average: 1200, peak: 3000}
o2_budget:                        # added 13 Nov (gap found by WS2); derived, see notes
  basis: "metabolic O2 only (no leakage or venting); NASA does not publish a single Mars-suit O2 capacity"
  primary_design_eva_h: 8          # NASA EVA-EXP-0075: surface EVAs up to 8 h (6 +/- 2)
  primary_design_rate_btu_h: 1200  # ICES-2026-127 average metabolic design rate
  secondary_eva_h: 1               # ICES-2026 Mars PLSS study: secondary sized 1 h for 4-8 h EVAs
  secondary_design_rate_btu_h: 3000
  formula: "O2_L = hours * rate_btu_h * 0.29307 * 3600 / 20.1 / 1000"
  primary_L: 504                   # = 8 h x 63.0 L/h (derived)
  secondary_L: 157                 # = 1 h x 157 L/h at 3000 BTU/h (derived)
  margin_uses: primary_L           # O2_left = primary_L - consumed; secondary is shown, never planned against
  assumed: true
```

## config/variants.yaml (WS2)

```yaml
formulas:
  level_slope_a: "a(M) = a_anchor * a_mult + alpha * (M - anchor.carried_kg)"
  a_anchor: "a_anchor = (anchor.vo2 - V0) / anchor.speed      # mL/kg/min per m/s"
  alpha: "alpha = ist2.level_increment / (ist2.delta_mass_kg * anchor.speed)"
  uphill_k: "k = (m_b + M) * g * sin(theta) / (eta * m_b) * 60 / 20.1   # theta > 0"
  vo2_uphill: "VO2 = V0 + a(M) * v + k * v"
  vo2_downhill: "VO2 = V0 + a(M) * v * clamp(f(i) / f(0), 0.4, 3.0)    # i = tan(theta) < 0"
  minetti_f: "f(i) = 280.5 i^5 - 58.7 i^4 - 76.8 i^3 + 51.9 i^2 + 19.6 i + 2.5   # Minetti 2002, Earth shape only"
  governor: "v* = min(v_safe(theta), (effort_cap * VO2max - V0) / (a(M) + k))   # downhill: divide by a(M)*f(i)/f(0)"
  o2_litres: "O2 = integral(VO2 * m_b dt) / 1000"
ist2:
  level_increment_ml_kg_min: 1.9  # lightest -> heaviest weight condition, 0% grade
  delta_mass_kg: 60               # mass span of those conditions
  verify_at_h0: true              # S reads the IST-2 table; correct delta_mass_kg
  uphill_check_ml_kg_min: {grade_20pct: 8.7, grade_30pct: 17.0}
variants:
  optimistic:   {eta: 0.25,  V0: 5, a_mult: 1.0, nogo_deg: 25}
  nominal:      {eta: 0.225, V0: 6, a_mult: 1.0, nogo_deg: 20}
  conservative: {eta: 0.20,  V0: 7, a_mult: 1.1, nogo_deg: "20 - v1_rmse_deg"}
scenarios:
  ids: [opt_80, opt_104, opt_120, nom_80, nom_104, nom_120, con_80, con_104, con_120]
  default: nom_104
  freeze: "Sat 23:00"
outputs:                           # added 13 Nov (gap found by WS2)
  isochrone_minutes: {min: 1, max: 60, step: 1}
  isochrone_fallback_step_min: 2   # if a scenario's isochrones exceed the size budget
  isochrone_size_budget_mb_gz: 1.5
  simplify_tolerance_m: 2
  band_budgets_min: [30, 60]
```

## config/haul.yaml (WS2)

```yaml
casualty_kg:
  suited: "body_mass + suit_mass (179 at the 104 kg suit)"
  bound: 343                       # NASA 2024 Lunar Rescue System challenge
cases:
  cart: {mu_range: [0.1, 0.4], mu_nominal: 0.2}
  drag: {mu_range: [0.5, 0.7], mu_nominal: 0.6}   # 2026-11-14, D20: infeasibility finding only, no drag fields
efficiency_eps: {range: [0.20, 0.25], nominal: 0.225}
rescuer_effort_frac: {range: [0.6, 0.8], nominal: 0.7}
boot_mu: 0.5
formulas:
  force: "F = m_IC * g * (mu * cos(theta) + sin(theta))"
  p_avail_w: "P = (effort_frac * VO2max - VO2_walk_self) * m_b * 20.1 / 60"
  speed: "v_haul = min(v_safe(theta), eps * P / F); downhill: min(v_haul, 0.5 * v_safe)"
  infeasible: "v_haul < 0.1 m/s or F > boot_mu * (m_b + suit + tools) * g * cos(theta)"
contour_min: 60                    # Scoville, Artemis III 1 h benchmark
mask_ridges: true
assumed: true
```

## config/horizon.yaml (WS3)

```yaml
az_step_deg: 0.25
az_step_coarse_deg: 1.0            # F22 coarse search
sampling:
  - {to_m: 2000,  step_m: 1,   source: dem_1m}
  - {to_m: 30000, step_m: 20,  source: ctx_20m}
  - {to_m: 80000, step_m: 200, source: mola_hrsc_200m}
curvature: "drop = d^2 / (2 R)"
eye_height_m: 1.7
navcam_height_m: 1.9               # verify_at_h0 from camera model C-vector
distance_classes_km: [0.5, 2.0]
v2: {min_stops: 10, target_stops: 30, manual_check_frac: 0.2}
sky_detector: "per column, top-down: first pixel where vertical gradient > 3x the median gradient of the top 10% rows"
```

## config/conditions.yaml (WS4)

```yaml
rad:
  dataset: MSL_RAD_OBS-L2
  dose_variable: verify_at_h0
  storm_window_utc: ["2024-05-19T00:00:00Z", "2024-05-23T00:00:00Z"]
  baseline: "median of the 7 days before the storm window"
  tripwire: {factor: 3.0, consecutive_samples: 2}
  q_sep: 1.0                       # never 3 for the SEP
  interpolation: "linear between sample midpoints"
  expected: {peak_mgy_day: [8.1, 8.4], excess_mgy: [1.7, 1.9]}
leash:
  d_allow_mgy: 0.5                 # decided (D9), slider 0.25-1.0
  formula: "tau_dose_min = 60 * D_allow / Ddot_mGy_per_h"
rems:
  ls_window_deg: [10, 35]
  feed_stale_since: "2026-08-25"
clock:
  algorithm: "Mars24 (Allison and McEwen 2000)"
  gale_lon_east_deg: 137.39
event_weekend: {ls_deg: 22, mars_year: 39}
```

## config/hud.yaml (WS7)

```yaml
playback_speeds: [1, 30, 60, 300]
default_speed: 60                  # decided (D13)
default_level: minimal             # decided (D14)
margin_amber_min: 10
worst_case_radii_m: [10, 50, 100]
fallback_drift:                    # used only if F21 misses G2 (2026-11-14, D19: now the core default)
  pct_of_distance: 2               # decided (D12)
  sigma_floor_m: 5
fix_sigma_m: {rover: 2, station: 5}
field_png: {res_m: 5, encoding: "value = R*256 + G; A = 0 unknown"}
field_scales:
  t_home: {per_count: 0.1, units: min}
  o2_home: {per_count: 0.01, units: L}
  home_bearing: {per_count: 0.01, units: deg}
  slope: {per_count: 0.01, units: deg}
  fix_interval: {per_count: 1, units: m}
labels: {simulated: "Simulated EVA · real terrain and data"}
eye_height_m: 1.7
performance: {fps_2d_min: 60, fps_3d_min: 30, fps_3d_fallback_below: 20, budget_3d_mb: 30}
```

## config/nav.yaml (WS9)

> ⏸️ **2026-11-14 (D19):** the F21 (sets, Monte Carlo, ellipses), F22 (skyline search) and `vo_probe` blocks serve an **optional add-on**. The core uses `fallback_drift` with the uncertainty circle and fix σ at the rover pad and stations.

```yaml
sets:                              # decided (D15), all assumed
  low:    {sigma_s: 0.01, sigma_b_deg_h: 1,  psi0_deg: 1, psi_rw_deg_sqrt_min: 0.05, slip: 0.02}
  medium: {sigma_s: 0.03, sigma_b_deg_h: 5,  psi0_deg: 3, psi_rw_deg_sqrt_min: 0.10, slip: 0.05}
  high:   {sigma_s: 0.05, sigma_b_deg_h: 20, psi0_deg: 5, psi_rw_deg_sqrt_min: 0.30, slip: 0.10}
default_set: medium
step_m: 0.7
step_noise_frac: 0.05
slip_min_slope_deg: 10
monte_carlo: {runs: 500, dt_s: 1, seed: 20261114}
ellipse_conf: 0.95
r95_fit: "r95(D) = a*D + b*D^2"
fix_sigma_m: {rover: 2, station: 5}
fix_interval:
  criterion: "r95(D) <= margin radius"   # D17 default 95%
  classes_m: [100, 300, 1000]
skyline_fix:
  coarse_grid_m: 50
  search_extent_m: 1000
  refine_grid_m: 10
  refine_top_k: 3
  far_field_min_m: 500
  column_weights: {far: 2.0, mid: 1.0, near: 0.5}
  sigma_rule: "region with RMS <= 1.5 x minimum RMS"
  standalone_prior_offset_m: 300
vo_probe:                          # WS10
  drives: 5
  go_rule: ">= 2 drives with >= 10 consecutive stereo pairs at <= 2 m spacing, with camera models"
```

## config/landmarks.yaml (WS3; added 13 Nov, gap found by WS3)

```yaml
rule: "per station card: 3-6 landmarks that rise above the computed skyline or are within 5 km; label = name, bearing_deg, dist_km"
sources:
  official: "IAU Gazetteer of Planetary Nomenclature (Mars), features within 80 km of the pad; coordinates read at H0 (discovery)"
  informal: "rover-team names from JPL/NASA releases or MMGIS layers; labelled 'informal'"
candidates:                        # names only; never type coordinates by hand
  - {name: "Aeolis Mons (Mount Sharp)", kind: official}
  - {name: "Gale crater rim", kind: official}
  - {name: "Peace Vallis", kind: official}
  - {name: "Aeolis Palus", kind: official}
  - {name: "Gediz Vallis", kind: official}
  - {name: "Boxwork unit", kind: informal}
  - {name: "Vera Rubin Ridge", kind: informal}
  - {name: "Greenheugh Pediment", kind: informal}
drop_if: "no verified coordinate at H0, or not visible from the station (below the skyline and > 5 km)"
```

## config/event.yaml (C; added 13 Nov, after a wrong timestamp in the build log)

```yaml
timezone: Europe/Zurich            # UTC+01:00 on 14-15 Nov 2026
h0_local: "2026-11-14T09:00:00+01:00"
h0_utc: "2026-11-14T08:00:00Z"     # the H0 provenance check compares against this
submit_target_local: "2026-11-15T21:00:00+01:00"
deadline_local: "2026-11-15T23:59:00+01:00"
gates_local: {G0: "2026-11-14T11:00:00+01:00", G1: "2026-11-14T19:00:00+01:00", G2: "2026-11-15T08:00:00+01:00", freeze: "2026-11-15T12:00:00+01:00"}
clock_rules:
  - "all machines NTP-synced with TZ=Europe/Zurich; check with `timedatectl` / `date -u` at arrival"
  - "manifest, logs and STATUS.md timestamps in UTC (ISO 8601 with Z)"
```

**Sources for the O₂ budget:** [NASA EVA-EXP-0075 surface suit capabilities](https://ntrs.nasa.gov/api/citations/20200001071/downloads/20200001071.pdf) (EVAs up to 8 h) · [ICES-2026-127 slides](https://ntrs.nasa.gov/api/citations/20260005410/downloads/Mars_Mass_ICES2026_Presentation_Final.pdf) (1,200 BTU/h average) · [ICES 2026 Mars PLSS presentation](https://ntrs.nasa.gov/api/citations/20260005204/downloads/ICES_Mars_PLSS_Presentation_2026_1.pdf) (secondary sized 1 h for 4–8 h EVAs).

// TypeScript shapes of the web-facing files, from contracts/*.schema.json v1.1.x (SPEC §6, §6.1,
// §6.2). Optional members are producer extras that open schemas allow (noted per field). The loader validates every file against its schema before these types are trusted.
import type { Feature, FeatureCollection, LineString, MultiLineString, MultiPolygon, Point, Polygon } from 'geojson'

export type Variant = 'optimistic' | 'nominal' | 'conservative'
export type EdgeCause = 'physiology' | 'slope' | 'data'

export interface ScenarioEntry {
  id: string
  variant: Variant
  suit_kg: number
  files: { isochrones: string; bands: string; edges: string; partner: string }
  headline: { budget_min: number; reachable_pct: number | null; range_pct: [number | null, number | null] }
  /** D43 (WS2 session 8): the 60-min share over the part of the circle inside the terrain data. */
  headline_60?: { budget_min: number; reachable_pct: number | null; range_pct: [number | null, number | null]; basis?: string; in_data_pct?: number | null; label?: string | null }
}

export interface ScenariosIndex {
  dummy: boolean
  default: string
  scenarios: ScenarioEntry[]
}

type FC<G extends Polygon | MultiPolygon | LineString | MultiLineString | Point, P> = FeatureCollection<G, P> & { dummy?: boolean }

export type IsochroneFC = FC<Polygon | MultiPolygon, { minutes: number }>
export type BandsFC = FC<Polygon | MultiPolygon, { budget: number; variant: Variant; [k: string]: unknown }>
export type EdgesFC = FC<LineString | MultiLineString, { budget: number; cause: EdgeCause; [k: string]: unknown }>
export type PartnerFC = FC<Polygon | MultiPolygon | LineString | MultiLineString, Record<string, unknown>> & { drag_finding?: DragFinding }

/** partner.geojson `drag_finding` (WS2, D20): dragging a suited crewmate on flat ground. Open member. */
export interface DragFinding {
  case?: string
  theta_deg?: number
  suit_kg?: number
  casualty_kg?: number
  rescuer_system_kg?: number
  mu?: number
  boot_mu?: number
  g_ms2?: number
  force_N: number | null
  traction_limit_N: number | null
  max_mass_kg: number | null
  feasible: boolean | null
  reason?: string
  note?: string
}
export type RouteFC = FC<LineString | MultiLineString | Point, Record<string, unknown>>
export type AnyFC = FeatureCollection & { dummy?: boolean }
export type AnyFeature = Feature

export interface Station {
  id: string
  name: string
  lon: number
  lat: number
  value: number | null
  objective: string
  tasks: string[]
  dwell_min: number
  t_home_min: Record<string, number | null>
  in_partner_line: boolean | null
  card: string
  /** WS2 extras (access-cell rule, user 11:40; open stations schema): per scenario. */
  access_radius_m?: number
  access?: Record<string, StationAccess>
  /** D26: false when no scenario reaches the station; then reachability_label (config label). */
  reachable_on_foot?: boolean
  reachability_label?: string | null
  /** D44 (WS1 session 5): stations sharing a name get a compass suffix from the official pad. */
  name_base?: string
  name_suffix?: { compass?: string; bearing_deg?: number; distance_m?: number; distance_rank?: string } | null
}

/** Walk-in from the access cell to the science point: straight line, not modelled (WS2). */
export interface WalkIn {
  dist_m: number | null
  modelled?: boolean
  rise_m?: number | null
  mean_slope_deg?: number | null
  max_slope_deg?: number | null
  max_terrain_slope_deg?: number | null
}

/** Access cell of a station in one scenario; lon/lat null when no access cell exists (reason says why). */
export interface StationAccess {
  lon: number | null
  lat: number | null
  dist_m: number | null
  t_home_min?: number | null
  o2_home_L?: number | null
  reason: string | null
  walk_in: WalkIn | null
  radius_m?: number
  rule?: string
}

export interface Card {
  dummy?: boolean
  navcam: { sol: number | null; image_id: string | null; url_local: string | null; overlay_png: string | null; credit?: string; dist_to_observer_m?: number }
  skyline_error_deg: { near: number | null; mid: number | null; far: number | null }
  panorama_png: string | null
  /** D33: `display` "label" (above the skyline) or "bearing_tick" (below it, bearing only). */
  landmarks: { name: string; bearing_deg: number; dist_km: number; kind?: string; above_skyline?: boolean; display?: 'label' | 'bearing_tick' }[]
  timeline: { arrive: number | null; leave: number | null; turn_back: number | null }
  /** null when the station has no route (contract v1.1.1; WS2 Q11). */
  margin_binding: 'O2' | 'daylight' | 'dose' | 'EVA duration' | null
  contingency: string
  /** D28 (contract v1.1.3): the term that sets the latest turn-back, e.g. "EVA duration". */
  turn_back_binding?: string | null
  // Extras merged by make web (WS3 fragment + WS2 timeline part; C 11:42):
  station?: string
  scenario?: string
  on_route?: boolean
  margin_min?: number | null
  t_home_min?: number | null
  o2_home_L?: number | null
  science?: { lon: number; lat: number }
  access?: StationAccess
  /** D20 note (WS2 card part). */
  drag_note?: string
  landmarks_note?: string
  skyline_error_scope?: string
  provisional?: boolean
  observer?: { position?: string; note?: string; lon?: number; lat?: number; [k: string]: unknown }
}

export interface TimelineEvent {
  t_min: number
  event: string
  station: string | null
  o2_left_L: number | null
  t_home_min: number | null
  margin_min: number | null
  /** Binding margin term of the row (WS2); "EVA duration" on turn-back rows (D28). */
  margin_binding?: string | null
}

export interface TradeCell {
  science_value: number | null
  reachable_pct: number | null
  partner_area_km2: number | null
  /** D43: 60-min row, share of the circle inside the terrain data. */
  in_data_pct?: number | null
}

export interface TradeTable {
  dummy?: boolean
  rows: number[]
  cols: number[]
  cells: TradeCell[][]
}

/** siting_png.json (v1.1.0): placement of the F8 siting heatmap siting.png (4 corners, MapLibre order). */
export interface SitingPng {
  dummy?: boolean
  image: string
  coordinates: [number, number][]
  corner_order: string
  grey_max_score: number | null
  rule: string
}

export interface PadChecks {
  assessed_pct_30min: number | null
  max_slope_deg: number | null
  rule_passed: boolean | null
}

export interface PadPoint {
  lon: number
  lat: number
  elev_m: number | null
  score: number | null
  checks: PadChecks
}

export interface PadAlternative {
  rank: number
  lon: number
  lat: number
  elev_m: number | null
  score: number | null
}

export interface PadFile {
  dummy: boolean
  /** The pad in use (contract v1.1.2, C 14:58): config/site.yaml pad_default, with the F8 rule evaluated there. */
  pad: PadPoint & { source?: string; score_kind?: string; f8_score?: number | null; id?: string; tiebreak?: Record<string, number | null> }
  alternatives: PadAlternative[]
  hop_options: { pads: number[][]; note: string }[]
  site_rule_version: string | number
  /** Optional F8 siting proposal (contract v1.1.2): never the pad in use. */
  proposal?: PadProposalBlock
}

/** pad.json `proposal` (contract v1.1.2; `tie`, `stations`, `no_access`, `checks_note` are WS2 extras). */
export interface PadProposalBlock {
  adopted?: false
  note?: string
  pad: PadPoint
  alternatives?: PadAlternative[]
  hop_options?: { pads: number[][]; note: string }[]
  site_rule_version?: string | number
  tie?: { top_score?: number | null; n_blocks_at_top_score?: number | null; n_candidate_blocks?: number | null; tiebreak?: string; note?: string }
  stations?: string[]
  no_access?: Record<string, string>
  checks_note?: string
  [k: string]: unknown
}

export interface Rad {
  dummy?: boolean
  latest: { utc: string | null; dose_rate_uGy_day: number | null; lag_days: number | null }
  baseline_uGy_day: number | null
  storm_2024: {
    series: [string, number | null][]
    peak_uGy_day: number | null
    excess_mGy: number | null
    onset_utc: string | null
    tripwire_utc: string | null
    // WS4 session 2 (D35, D36), optional on older trees:
    tripwire_halfwidth_min?: number | null
    tripwire_halfwidth_label?: string | null
    tripwire_halfwidth_rule?: string | null
    excess_is_lower_bound?: boolean | null
    excess_label?: string | null
    end_of_window_utc?: string | null
    end_of_window_rate_uGy_day?: number | null
    end_of_window_rate_minus_baseline_uGy_day?: number | null
    end_of_window_rate_over_baseline_ratio?: number | null
    dose_equivalent_mSv?: number | null
    q_note?: string | null
  }
  /** WS4 session 2 (D34, D35): dose column label and its status; time tag. */
  source?: { component?: string; component_label?: string; component_status?: string; time_tag_status?: string; series_time?: string; [k: string]: unknown }
  leash: {
    D_allow_mGy: number | null
    tau_min_at_peak: number | null
    // v1.1.0 (optional): one table row per D9 slider step.
    tau_min_at_latest?: number | null
    formula?: string
    D_allow_note?: string
    table?: LeashRow[]
    d_allow_range_mgy?: [number, number]
    d_allow_step_mgy?: number
  }
}

export interface LeashRow {
  D_allow_mGy: number
  tau_min_at_peak: number | null
  tau_min_at_latest: number | null
}

/** tiles/basemap/tilejson.json (v1.1.0). Tile URLs are relative to the data root. */
export interface TileJson {
  dummy?: boolean
  tilejson: '3.0.0'
  scheme: 'xyz'
  format?: string
  tileSize: number
  tiles: string[]
  minzoom: number
  maxzoom: number
  bounds: [number, number, number, number]
  attribution?: string
  zoom_bounds?: Record<string, [number, number, number, number]>
}

/** terrain/cellstate.json (v1.1.0): F1 cell states, PNG alpha 0 = unknown. */
export interface CellState {
  dummy?: boolean
  image: string
  bounds: [number, number, number, number]
  width: number
  height: number
  res_m: number
  variant?: string
  codes?: Record<string, string>
  pct?: Record<string, number | null>
}

export interface Localisation {
  true: { lon: number; lat: number }
  recovered: { lon: number; lat: number }
  error_m: number | null
  rms_deg: number | null
  sigma_m?: number | null
  [k: string]: unknown
}

export interface Fix {
  t_eva_min: number
  station: string | null
  type: string
  sigma_m: number | null
  error_m: number | null
  image_id: string | null
}

export interface VoDriftRow {
  sol: number
  drive: number
  length_m: number
  endpoint_error_m: number | null
  drift_pct: number | null
  heading_drift_deg: number | null
  label?: string
  status?: string
  truth?: string
  [k: string]: unknown
}

export interface ManifestEntry {
  value: unknown
  units: string | null
  file: string
  script: string
  commit: string
  utc: string
}
export type Manifest = { dummy?: boolean } & Record<string, ManifestEntry | boolean | undefined>

export interface FieldInfo {
  file: string
  scale: number
  units: string
  scenario: string | null
}
export interface FieldsIndex {
  dummy: boolean
  bounds: [number, number, number, number]
  width: number
  height: number
  res_m: number
  fields: Record<string, FieldInfo>
}

export interface V1 {
  n: number
  bias_deg: number | null
  rmse_deg: number | null
  r: number | null
  thresholds_deg: number[]
  confusion: unknown
  [k: string]: unknown
}

export interface V2 {
  summary: Record<string, unknown>
  frames: Record<string, unknown>[]
  [k: string]: unknown
}

export interface Coreg {
  dx_m: number | null
  dy_m: number | null
  residual_median_m: number | null
  residual_mad_m: number | null
  residuals: Record<string, unknown>[]
  [k: string]: unknown
}

/** Loose contracts (structure not fixed by SPEC; the producer proposes it to C). */
export type Coverage = Record<string, unknown>
export type Rems = Record<string, unknown>
export type Clock = Record<string, unknown>
export interface Donki {
  label: 'context only, not a trigger'
  records: Record<string, unknown>[]
  [k: string]: unknown
}

export interface FixIntervalSummary {
  set: 'low' | 'medium' | 'high'
  median_m: number | null
  edge_p10_m: number | null
  class_area_pct: Record<'<100' | '100-300' | '300-1000' | '>1000', number | null>
}

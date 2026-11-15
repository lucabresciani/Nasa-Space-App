// Data shapes the HUD reads (contracts v1.1.0, SPEC §6, §6.1). Local and minimal on purpose: the
// HUD is a self-contained module (WS7).

export type LonLat = [number, number]

export type Bounds = [number, number, number, number] // [w, s, e, n] lon/lat deg, pixel-edge extent

/**
 * One fields/index.json entry (contracts/fields_index.schema.json). The optional grid keys and
 * `stencil` (contracts v1.1.1) exist only on `{scenario}/pointer` (WS2's 3 m route grid).
 */
export interface FieldMeta {
  file: string
  scale: number
  units: string
  scenario: string | null
  bounds?: Bounds
  width?: number
  height?: number
  res_m?: number
  stencil?: number[][]
}

/** The grid a field PNG lives on. */
export interface GridSpec {
  bounds: Bounds
  width: number
  height: number
  res_m: number
}

/** fields/index.json. Keys: `{scenario}/{name}`, `slope` (shared). */
export interface FieldsIndex extends GridSpec {
  dummy: boolean
  fields: Record<string, FieldMeta>
}

/** margin / turn-back binding term (timeline + card contract v1.1.3: "EVA duration", D28) */
export type Binding = 'O2' | 'daylight' | 'dose' | 'EVA duration' | null

/** timeline_{scenario}.json row (contracts/timeline.schema.json v1.1.0). */
export interface TimelineEvent {
  t_min: number
  event: string
  station: string | null
  o2_left_L: number | null
  t_home_min: number | null
  margin_min: number | null
  margin_binding?: Binding
  in_partner_line?: boolean | null
}

export interface LineFeature {
  type: 'Feature'
  properties: Record<string, unknown> & { leg?: number; times_min?: number[] }
  geometry:
    | { type: 'LineString'; coordinates: number[][] }
    | { type: 'MultiLineString'; coordinates: number[][][] }
    | { type: 'Point'; coordinates: number[] }
}
export interface RouteFC {
  type: 'FeatureCollection'
  features: LineFeature[]
}

export interface PolygonGeometry {
  type: 'Polygon' | 'MultiPolygon'
  coordinates: number[][][] | number[][][][]
}
export interface PolygonFC {
  type: 'FeatureCollection'
  features: { type: 'Feature'; properties: Record<string, unknown>; geometry: PolygonGeometry }[]
}

export interface Station {
  id: string
  name: string
  lon: number | null
  lat: number | null
  tasks: string[]
  dwell_min: number
}

export interface ScenarioEntry {
  id: string
  variant: string
  suit_kg: number
  files: { partner?: string; [k: string]: string | undefined }
}
export interface ScenariosIndex {
  dummy: boolean
  default: string
  scenarios: ScenarioEntry[]
}

/** pad.json (subset; contracts/pad.schema.json). */
export interface PadFile {
  pad: { lon: number; lat: number }
}

/** conditions/rad.json (subset the HUD shows; contracts/rad.schema.json). */
export interface Rad {
  latest: { utc: string | null; dose_rate_uGy_day: number | null; lag_days: number | null }
  baseline_uGy_day: number | null
  storm_2024?: {
    series: [string, number][]
    onset_utc: string | null
    tripwire_utc: string | null
    peak_utc?: string | null
    /** "± 9 min" (D35, WS4 session 2); absent in older files */
    tripwire_halfwidth_label?: string | null
  }
  leash: { D_allow_mGy: number | null; tau_min_at_peak: number | null }
}

/**
 * The one position interface (SPEC F19). Everything in the HUD reads this object.
 * sigma_m = radius of the uncertainty circle (0 = exact).
 */
export interface HudPosition {
  lon: number
  lat: number
  sigma_m: number
  source: 'playback' | 'drag' | 'drift' | 'fix'
  t_eva_min: number
  last_fix: { source: 'rover' | 'station' | 'skyline'; t_eva_min: number } | null
}

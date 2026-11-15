// Navigation data shapes (SPEC §6.2; contracts/montecarlo, fixes, tracks, fix_interval_summary).
// Optional fields are the non-required extras WS9's pipeline writes (contracts allow extra keys).

export type LonLat = [number, number]

/** 95% error ellipse: semi-axes in metres, theta = major-axis azimuth clockwise from grid north. */
export interface Ellipse {
  a_m: number
  b_m: number
  theta_deg: number
}

export interface PerMinute {
  t_eva_min: number
  dist_since_fix_m: number
  ellipse: Ellipse
  r95_m: number
}

/** nav/montecarlo_{set}.json */
export interface MonteCarlo {
  set: string
  params: Record<string, unknown>
  runs: number
  per_minute: PerMinute[]
  r95_fit: { a: number; b: number }
  seed?: number
  dt_s?: number
  simulated?: boolean
  dummy?: boolean
}

export type FixType = 'rover' | 'station' | 'skyline'

/** nav/fixes.json item */
export interface Fix {
  t_eva_min: number
  station: string | null
  type: FixType
  sigma_m: number
  error_m?: number | null
  image_id?: string | null
}

export interface TrackFeature {
  type: 'Feature'
  geometry:
    | { type: 'LineString'; coordinates: number[][] }
    | { type: 'MultiLineString'; coordinates: number[][][] }
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] }
    | { type: 'Point'; coordinates: number[] }
  properties: {
    t_eva_min: number
    kind?: string // "true" | "estimated" | "ellipse95"
    t_eva_min_vertices?: number[] // lines: time of every vertex (WS9 pipeline; not in the dummy)
    a_m?: number
    b_m?: number
    theta_deg?: number
    r95_m?: number
    dist_since_fix_m?: number
    [k: string]: unknown
  }
}

/** nav/tracks_{set}.geojson */
export interface TracksFC {
  type: 'FeatureCollection'
  features: TrackFeature[]
  properties?: Record<string, unknown>
}

/** nav/fix_interval_summary.json (contracts v1.0.0: one file, one set named in `set`) */
export interface FixIntervalSummary {
  set: string
  median_m: number | null
  edge_p10_m: number | null
  class_area_pct: Record<string, number | null>
  limit_min?: number
  cells_inside?: number
  scenario?: string
  dummy?: boolean
}

/** localisation/{image_id}.json (SPEC §6.1, F22) */
export interface Localisation {
  true: { lon: number; lat: number }
  recovered: { lon: number; lat: number }
  error_m: number
  rms_deg: number
  candidates_evaluated: number
  sigma_m?: number
}

// Hand-written types for the parts of contracts/backend/openapi.yaml (v1.2.0) the live
// client uses. contract.test.ts checks every key map and enum below against the schema, so a
// contract change that these types miss fails the tests.

export type HeavyJobs = 'on' | 'off'

/** components.schemas.Health */
export interface Health {
  ok: boolean
  engine_warm: boolean
  queue_length: number
  heavy_jobs: HeavyJobs
}

/** components.schemas.Error */
export interface ApiErrorBody {
  error: string
  detail?: unknown
  retry_after_s?: number | null
  allowed?: Record<string, unknown> | null
  /** v1.2.0 (D97): index into inputs.route.stops of the stop a route 422 names; null = whole route. */
  stop?: number | null
}

export const JOB_TYPES = ['plan', 'siting', 'replan'] as const
export type JobType = (typeof JOB_TYPES)[number]

export const JOB_STATUSES = ['queued', 'running', 'done', 'error', 'timeout', 'refused'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
/** Statuses after which the server never changes the job again. */
export const JOB_FAILED_STATUSES: readonly JobStatus[] = ['error', 'timeout', 'refused']

/** contracts/backend/job.schema.json */
export interface Job {
  id: string
  type: JobType
  hash: string
  status: JobStatus
  /** Stage now running (a free string in the contract); null when queued or finished. */
  stage?: string | null
  progress: number
  /** Finished stages in order; their files are already readable under result_url. */
  stages_done: string[]
  queue_position?: number | null
  result_url?: string | null
  attached?: boolean
  error?: string | null
  retry_after_s?: number | null
}

/** contracts/backend/plan_inputs.schema.json (opaque here; the pad tool and crew panel own its shape). */
export type PlanInputs = Record<string, unknown>

/** components.schemas.ReplanInputs (opaque here; F32 owns it). */
export type ReplanInputs = Record<string, unknown>

/** components.schemas.JobRequest */
export interface JobRequest {
  type: JobType
  inputs: PlanInputs
  replan?: ReplanInputs
}

/** components.schemas.LonLat */
export interface LonLat {
  lon: number
  lat: number
}

export const PAD_REASONS = [null, 'slope', 'unknown_terrain', 'disc_off_grid', 'outside_grid'] as const
export type PadReason = (typeof PAD_REASONS)[number]

/** components.schemas.PadCheck */
export interface PadCheck {
  valid: boolean
  reason: PadReason
  detail?: string
  nearest_valid?: { lon: number; lat: number; distance_m: number } | null
}

/** components.schemas.PadScreen */
export interface PadScreen {
  pad: LonLat
  stations: { id: string; reachable: boolean; t_out_min?: number | null; t_home_min?: number | null }[]
  feasible_evas: number
  best_route?: { order: string[]; total_min: number } | null
  label: string
}

/** components.schemas.EngineVersion */
export interface EngineVersion {
  engine_tree: string
  commit: string
  config_hash: string
  web_contract_version: string
  backend_contract_version: string
  bundle_contract_version?: string
  terrain_hash: string
  world_version?: string
}

/** One entry of components.schemas.Defaults.ranges: config/backend.yaml ranges with defaults resolved. */
export interface RangeSpec {
  min: number
  max: number
  default?: number | number[]
  precomputed?: number[]
  assumed?: boolean
}

/** components.schemas.Defaults (GET /defaults): default plan inputs, ranges, stations, pads. */
export interface Defaults {
  /** plan_inputs with every default filled (crew, eva, stations, conditions, the official pad). */
  inputs: PlanInputs
  /** config/backend.yaml ranges with defaults resolved (crew fields, walkback, dose, reserve_min ...). */
  ranges: Record<string, unknown>
  stations: Record<string, unknown>[]
  pads: Record<string, unknown>[]
}

/** components.schemas.ImportResult */
export interface ImportResult {
  hash: string
  inputs: PlanInputs
  computed?: boolean
  range_flags?: Record<string, unknown>[]
}

// Exhaustive key maps (a missing or extra key is a type error); contract.test.ts compares them to
// the schema's properties and required lists.
type KeyMap<T> = { [K in keyof Required<T>]: undefined extends T[K] ? 'optional' : 'required' }

export const HEALTH_KEYS: KeyMap<Health> = { ok: 'required', engine_warm: 'required', queue_length: 'required', heavy_jobs: 'required' }
export const JOB_KEYS: KeyMap<Job> = {
  id: 'required', type: 'required', hash: 'required', status: 'required', stage: 'optional', progress: 'required',
  stages_done: 'required', queue_position: 'optional', result_url: 'optional', attached: 'optional', error: 'optional',
  retry_after_s: 'optional',
}
export const ERROR_KEYS: KeyMap<ApiErrorBody> = { error: 'required', detail: 'optional', retry_after_s: 'optional', allowed: 'optional', stop: 'optional' }
export const JOB_REQUEST_KEYS: KeyMap<JobRequest> = { type: 'required', inputs: 'required', replan: 'optional' }
export const PAD_CHECK_KEYS: KeyMap<PadCheck> = { valid: 'required', reason: 'required', detail: 'optional', nearest_valid: 'optional' }
export const PAD_SCREEN_KEYS: KeyMap<PadScreen> = { pad: 'required', stations: 'required', feasible_evas: 'required', best_route: 'optional', label: 'required' }
export const ENGINE_VERSION_KEYS: KeyMap<EngineVersion> = {
  engine_tree: 'required', commit: 'required', config_hash: 'required', web_contract_version: 'required',
  backend_contract_version: 'required', bundle_contract_version: 'optional', terrain_hash: 'required', world_version: 'optional',
}
export const DEFAULTS_KEYS: KeyMap<Defaults> = { inputs: 'required', ranges: 'required', stations: 'required', pads: 'required' }
export const IMPORT_RESULT_KEYS: KeyMap<ImportResult> = { hash: 'required', inputs: 'required', computed: 'optional', range_flags: 'optional' }

// --- results and provenance (F28, F35) ---

export const RUN_ORIGINS = ['computed_live', 'precomputed'] as const
export type RunOrigin = (typeof RUN_ORIGINS)[number]

export const RUN_STATUSES = ['done', 'partial', 'error', 'timeout'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** contracts/backend/run_record.schema.json: GET /results/{hash}/provenance. */
export interface RunRecord {
  contract_version: string
  hash: string
  origin: RunOrigin
  label: string
  inputs: PlanInputs
  engine: { tree: string; commit: string; config_hash: string; web_contract_version?: string; backend_contract_version?: string }
  terrain_hash: string
  status: RunStatus
  started_utc: string
  finished_utc?: string
  stages: { name: string; started_utc?: string; seconds: number; files?: string[] }[]
  files: { path: string; sha256: string; bytes: number; contract?: string | null }[]
  range_flags?: { key: string; value?: number; note: string }[]
  /** v1.2.0 (D97): inputs.route.mode; absent in older records. */
  route_mode?: RouteMode
  /** v1.2.0 (D97): the answer for the route as given; absent in older records. */
  feasibility?: Feasibility
  infeasible?: { leg: number; from: string; to: string; margin_min?: number; binding: string } | null
  error?: string | null
  dummy: boolean
}

/** plan_inputs route.mode (v1.2.0, D97); a missing route = auto. */
export type RouteMode = 'auto' | 'ordered'
/** plan_inputs route.stops[i]: a station of stations.json or a free point (named W1, W2, ... in order). */
export type RouteStop = { station: string } | { lon: number; lat: number; label?: string }
/** run_record.feasibility (v1.2.0, D97): leg 0 = pad -> stops[0], len(stops) = last stop -> pad. */
export type Feasibility =
  | { feasible: true }
  | { feasible: false; leg: number; from: string; to: string; limit: 'O2' | 'daylight' | 'dose' | 'EVA duration'; shortfall_min: number; legs_planned?: number }

/** One run-record range flag (F26): an input outside its config range, flagged and never clamped. */
export type RangeFlag = NonNullable<RunRecord['range_flags']>[number]

export const RUN_RECORD_KEYS: KeyMap<RunRecord> = {
  contract_version: 'required', hash: 'required', origin: 'required', label: 'required', inputs: 'required', engine: 'required',
  terrain_hash: 'required', status: 'required', started_utc: 'required', finished_utc: 'optional', stages: 'required', files: 'required',
  range_flags: 'optional', route_mode: 'optional', feasibility: 'optional', infeasible: 'optional', error: 'optional', dummy: 'required',
}

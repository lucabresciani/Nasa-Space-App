// Canonical plan inputs and the D57 result hash, in the browser (WS18 task 1). A port of
// server/engine/hashing.py (read only; contracts/backend/README.md "Result hash"), so a hash the
// client computes for a plan step equals the one the server gives the same inputs:
//
//   hash = sha256(canonical_inputs + "\0" + engine_tree + "\0" + config_hash + "\0" + terrain_hash)[:16]
//
// canonical_inputs = plan_inputs with every default filled in (server/engine/defaults.py:
// config/backend.yaml ranges, crew.yaml, conditions.yaml, the official pad, every station's dwell,
// custom: []), `title` and `pad.id` removed (D57; team-lead decision 11: the pad's lon/lat stay),
// every number a float rounded to 6 decimals (-0.0 -> 0.0) written as Python's float repr, JSON
// with sorted keys and no spaces, UTF-8.
import backendRaw from '../../../config/backend.yaml'
import conditionsRaw from '../../../config/conditions.yaml'
import crewRaw from '../../../config/crew.yaml'
import stationsCfgRaw from '../../../config/stations.yaml'
import { cfg } from '../config'
import { sha256Hex } from './sha256'

/** contracts/backend/plan_inputs.schema.json (the fields the browser writes or fills). */
export interface PlanInputs {
  contract_version: string
  title?: string
  pad: { id?: string; lon: number; lat: number }
  crew?: Partial<Record<'body_mass_kg' | 'suit_kg' | 'tools_kg' | 'vo2max_ml_kg_min' | 'effort_cap_frac', number>>
  eva?: { duration_h?: number; reserve_min?: number; start_lmst_h?: number; walkback_budgets_min?: number[] }
  stations?: { mode: 'best' | 'set' | 'order'; ids?: string[]; dwell_min?: Record<string, number>; custom?: { id: string; name?: string; lon: number; lat: number }[] }
  conditions?: { storm?: 'none' | '2024-05-20'; tripwire_at?: 'route_max_t_home' | number; d_allow_mgy?: number }
}

/** The engine identity of /engine/version that enters the hash (each part as the server reports it). */
export interface EngineIdentity {
  engine_tree: string
  config_hash: string
  terrain_hash: string
}

/** Rows of web/public/data the defaults read (scenarios/pads/index.json, stations.json). */
export interface PadRow {
  id: string
  lon: number
  lat: number
  official?: boolean
  picker?: boolean
}
export interface StationRow {
  id: string
  dwell_min?: number
}

export class InvalidPlanInputs extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super(`invalid plan_inputs: ${errors.join('; ')}`)
    this.errors = errors
    this.name = 'InvalidPlanInputs'
  }
}

const DECIMALS = 6 // contracts/backend/README.md "Result hash"
const SEP = '\0'
/** config/backend.yaml compute.hash */
export const HASH_ALGO = cfg<string>(backendRaw, 'compute.hash.algo')
export const HASH_HEX_CHARS = cfg<number>(backendRaw, 'compute.hash.hex_chars')
if (HASH_ALGO !== 'sha256') throw new Error(`config/backend.yaml compute.hash.algo ${HASH_ALGO}: the browser hash implements sha256 only`)
/** config/backend.yaml contract_version: what the browser writes into plan_inputs. */
export const CONTRACT_VERSION = cfg<string>(backendRaw, 'contract_version')

// server/engine/defaults.py constants that are not in config (mirrored, pinned by the known-answer test).
/** DEFAULT_STORM: the timed storm replay of 20 May 2024 (D39). */
const DEFAULT_STORM = '2024-05-20'
/** DEFAULT_STATION_MODE: exact DP over all stations (F25, F9). */
const DEFAULT_STATION_MODE = 'best'

const CFG_FILES: Record<string, unknown> = { crew: crewRaw, conditions: conditionsRaw, stations: stationsCfgRaw }
function ref<T>(r: string): T {
  const [file, ...path] = r.split('.')
  if (!(file in CFG_FILES)) throw new Error(`config ref ${r}: unknown file`)
  return cfg<T>(CFG_FILES[file], path.join('.'))
}
function rangeDefault<T>(key: string): T {
  const r = cfg<{ default?: T; default_ref?: string }>(backendRaw, `ranges.${key}`)
  if (r.default !== undefined) return r.default
  if (r.default_ref) return ref<T>(r.default_ref)
  throw new Error(`config/backend.yaml ranges.${key} has no default`)
}

/** The official pad (pads index row with official: true). */
export function officialPad(pads: readonly PadRow[]): PadRow {
  const rows = pads.filter((p) => p.official)
  if (rows.length !== 1) throw new Error(`scenarios/pads/index.json must have exactly one official pad, found ${rows.length}`)
  return rows[0]
}

/** server/engine/defaults.py default_inputs(): plan_inputs with every default filled in (= GET /defaults inputs). */
export function defaultInputs(pads: readonly PadRow[]): PlanInputs {
  const off = officialPad(pads)
  return {
    contract_version: CONTRACT_VERSION,
    pad: { id: off.id, lon: off.lon, lat: off.lat },
    crew: {
      body_mass_kg: rangeDefault('body_mass_kg'),
      suit_kg: rangeDefault('suit_kg'),
      tools_kg: rangeDefault('tools_kg'),
      vo2max_ml_kg_min: rangeDefault('vo2max_ml_kg_min'),
      effort_cap_frac: rangeDefault('effort_cap_frac'),
    },
    eva: {
      walkback_budgets_min: [...rangeDefault<number[]>('walkback_budget_min')],
      duration_h: ref('crew.eva_h'),
      reserve_min: ref('crew.o2_margin.reserve_min_at_effort_cap'),
      start_lmst_h: ref('conditions.clock.eva_start_lmst_h'),
    },
    stations: { mode: DEFAULT_STATION_MODE },
    conditions: { storm: DEFAULT_STORM, d_allow_mgy: rangeDefault('d_allow_mgy'), tripwire_at: ref('conditions.storm_replay.tripwire_at') },
  }
}

/** Default dwell per station (stations.json dwell_min, else stations.yaml dwell_min), and for each user point. */
export function defaultDwell(stations: readonly StationRow[], custom: readonly { id: string }[] = []): Record<string, number> {
  const fallback = ref<number>('stations.dwell_min')
  const out: Record<string, number> = {}
  for (const s of stations) out[s.id] = s.dwell_min ?? fallback
  for (const p of custom) out[p.id] = fallback
  return out
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function merge(def: Record<string, unknown>, given: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...def }
  for (const [k, v] of Object.entries(given)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k] as Record<string, unknown>, v) : v
  return out
}

/**
 * Python's round(x, 6): correctly rounded on the exact binary value, ties to even. toFixed rounds
 * the exact value too but sends ties away from zero, so exact ties are detected and fixed.
 */
export function round6(x: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 2 ** 52) return x
  const a = Math.abs(x)
  let s = a.toFixed(DECIMALS)
  const wide = a.toFixed(25) // exact enough to see a tie: any non-tie differs by >= 1 ulp
  const dot = wide.indexOf('.')
  if (wide.slice(dot + 1 + DECIMALS) === `5${'0'.repeat(25 - DECIMALS - 1)}`) {
    const trunc = wide.slice(0, dot + 1 + DECIMALS)
    if (Number(trunc.at(-1)) % 2 === 0) s = trunc
  }
  const r = Number(s)
  return (x < 0 ? -r : r) + 0 // + 0 turns -0 into 0
}

/** Python's repr() of a finite float (what json.dumps writes): shortest round trip, ".0" on integers. */
export function pyFloatRepr(x: number): string {
  if (!Number.isFinite(x)) throw new InvalidPlanInputs([`${x} is not a finite number`])
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  const sign = x < 0 ? '-' : ''
  const [mant, expS] = Math.abs(x).toExponential().split('e')
  const digits = mant.replace('.', '')
  const e = Number(expS)
  if (e < -4 || e >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    return `${sign}${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
  }
  const point = e + 1
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}.0`
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

/** Numbers are kept as their Python text so 75 and 75.0 serialise alike. */
class PyNum {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}
type Norm = null | boolean | string | PyNum | Norm[] | { [k: string]: Norm }

function normalise(node: unknown, path: string): Norm {
  if (node === null || typeof node === 'boolean' || typeof node === 'string') return node
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) throw new InvalidPlanInputs([`${path || '(root)'}: ${node} is not a finite number`])
    return new PyNum(pyFloatRepr(round6(node)))
  }
  if (Array.isArray(node)) return node.map((v, i) => normalise(v, `${path}/${i}`))
  if (isObj(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, normalise(v, path ? `${path}/${k}` : k)]))
  throw new InvalidPlanInputs([`${path || '(root)'}: unsupported value ${String(node)}`])
}

/** json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False). */
function dumps(v: Norm): string {
  if (v instanceof PyNum) return v.text
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(dumps).join(',')}]`
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${dumps(v[k])}`)
    .join(',')}}`
}

/** Structural checks the server's schema validation would refuse (the subset the browser can get wrong). */
function check(p: PlanInputs): void {
  const errs: string[] = []
  if (typeof p.contract_version !== 'string') errs.push('contract_version: required string')
  if (!p.pad || typeof p.pad.lon !== 'number' || typeof p.pad.lat !== 'number') errs.push('pad: lon and lat required')
  const st = p.stations
  if (st && (st.mode === 'set' || st.mode === 'order') && !st.ids?.length) errs.push(`stations: ids required for mode ${st.mode}`)
  if (errs.length) throw new InvalidPlanInputs(errs)
}

/** Everything canonicalisation needs besides the inputs. */
export interface CanonicalContext {
  /** default_inputs() (defaultInputs(pads) or GET /defaults inputs) */
  defaults: PlanInputs
  /** stations.json rows (their dwell_min) */
  stations: readonly StationRow[]
}

/** server canonical_inputs(): defaults filled, title and pad.id removed, numbers normalised. */
export function canonicalInputs(given: PlanInputs, ctx: CanonicalContext): Record<string, Json> {
  check(given)
  const def = structuredClone(ctx.defaults) as unknown as Record<string, unknown>
  delete def.pad // the given pad replaces it whole (never inherits an id)
  const doc = merge(def, structuredClone(given) as unknown as Record<string, unknown>) as unknown as PlanInputs
  const st = (doc.stations ??= { mode: DEFAULT_STATION_MODE })
  st.custom ??= []
  st.dwell_min = { ...defaultDwell(ctx.stations, st.custom), ...(st.dwell_min ?? {}) }
  delete doc.title
  delete doc.pad.id
  return doc as unknown as Record<string, Json>
}

/** server canonical_json(): the exact text that enters the hash. */
export function canonicalJson(given: PlanInputs, ctx: CanonicalContext): string {
  return dumps(normalise(canonicalInputs(given, ctx), ''))
}

/** The D57 result hash of canonical JSON text under an engine identity. */
export function hashCanonical(canonical: string, id: EngineIdentity): string {
  const parts = [id.engine_tree, id.config_hash, id.terrain_hash]
  for (const p of parts) if (typeof p !== 'string' || !p || p.includes(SEP)) throw new Error('engine identity parts must be non-empty strings without NUL')
  return sha256Hex([canonical, ...parts].join(SEP)).slice(0, HASH_HEX_CHARS)
}

/** server result_hash(inputs, identity). */
export function resultHash(given: PlanInputs, ctx: CanonicalContext, id: EngineIdentity): string {
  return hashCanonical(canonicalJson(given, ctx), id)
}

/** Identity-free key of canonical inputs (same length as a result hash); equal inputs, equal key. */
export function inputsKey(canonical: string): string {
  return sha256Hex(canonical).slice(0, HASH_HEX_CHARS)
}

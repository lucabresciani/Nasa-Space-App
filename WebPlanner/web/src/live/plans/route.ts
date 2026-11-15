// The route a plan carries (D97): plan_inputs v1.2.0 `route` (contracts/backend/plan_inputs.schema.json
// properties.route; types RouteMode and RouteStop in ../types.ts). plan_inputs.schema.json checks it;
// checkRoute here turns its errors into readable ones that name the stop (planio.ts import).
//
//   route: { mode: "auto" | "ordered", stops: [ {station: "S4"} | {lon, lat, label?} ] }
//   missing route = auto (old files stay valid); auto: stops absent or empty; ordered: >= 1 stop
//   free points are W1, W2, ... in their order among the stops (run_record.feasibility from/to)
//
// Structure and names only, like the schema: stop counts, spacing and validity on the terrain are
// the server's (config/backend.yaml route.* limits, R0/R3).
import { TITLE_MAX_CHARS } from '../config'
import type { RouteMode, RouteStop } from '../types'

export type { RouteMode, RouteStop }
export const ROUTE_MODES: readonly RouteMode[] = ['auto', 'ordered']

/** plan_inputs.route (v1.2.0). */
export interface RouteSpec {
  mode: RouteMode
  stops?: RouteStop[]
}

/** Station ids a route may name (stations.json ids; user points are {lon, lat}, not U ids). */
export const STATION_ID_RE = /^S[0-9]+$/

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const extra = (o: Record<string, unknown>, allowed: string[], path: string) =>
  Object.keys(o)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${path}.${k}: unknown field "${k}"`)

/** Readable errors for a `route` value; [] = valid. `path` prefixes each message. */
export function checkRoute(v: unknown, path = 'route'): string[] {
  if (!isObj(v)) return [`${path}: must be an object {mode, stops}`]
  const out = extra(v, ['mode', 'stops'], path)
  if (!ROUTE_MODES.includes(v.mode as RouteMode)) out.push(`${path}.mode: must be "auto" or "ordered", not ${JSON.stringify(v.mode)}`)
  if (v.stops !== undefined && !Array.isArray(v.stops)) out.push(`${path}.stops: must be a list`)
  const stops = Array.isArray(v.stops) ? v.stops : []
  if (v.mode === 'ordered' && stops.length === 0) out.push(`${path}.stops: an ordered route needs at least one stop`)
  if (v.mode === 'auto' && stops.length > 0) out.push(`${path}.stops: an auto route has no stops (the engine chooses them); use mode "ordered"`)
  stops.forEach((s, i) => out.push(...checkStop(s, `${path}.stops[${i}]`)))
  return out
}

function checkStop(s: unknown, path: string): string[] {
  if (!isObj(s)) return [`${path}: must be {station} or {lon, lat, label?}`]
  if ('station' in s) {
    const out = extra(s, ['station'], path)
    if (typeof s.station !== 'string' || !STATION_ID_RE.test(s.station)) out.push(`${path}.station: ${JSON.stringify(s.station)} is not a station id (S1, S2, …)`)
    return out
  }
  const out = extra(s, ['lon', 'lat', 'label'], path)
  if (!isNum(s.lon) || s.lon < -180 || s.lon > 360) out.push(`${path}.lon: must be a number from -180 to 360`)
  if (!isNum(s.lat) || s.lat < -90 || s.lat > 90) out.push(`${path}.lat: must be a number from -90 to 90`)
  if (s.label !== undefined) {
    if (typeof s.label !== 'string') out.push(`${path}.label: must be text`)
    else if ([...s.label].length > TITLE_MAX_CHARS) out.push(`${path}.label: longer than ${TITLE_MAX_CHARS} characters (limits.title_max_chars)`)
  }
  return out
}

/** The route of plan inputs (missing = auto). Assumes `inputs` passed checkRoute. */
export function routeOf(inputs: Record<string, unknown> | null | undefined): RouteSpec {
  const r = inputs?.route
  return isObj(r) && ROUTE_MODES.includes(r.mode as RouteMode) ? (r as unknown as RouteSpec) : { mode: 'auto' }
}

/** Text of each stop: "S4", or "W1 Crater rim (77.512000, 18.401000)" for a free point (W1, W2, … as the contract names them). */
export function stopTexts(stops: readonly RouteStop[]): string[] {
  let w = 0
  return stops.map((s) => {
    if ('station' in s) return s.station
    const at = `${s.lon.toFixed(6)}, ${s.lat.toFixed(6)}`
    return `W${++w}${s.label ? ` ${s.label}` : ''} (${at})`
  })
}

/** Short text of a route for lists: "auto (the engine chooses …)" or "ordered: S4 → W1 Crater rim (…) → S1". */
export function routeText(r: RouteSpec): string {
  if (r.mode === 'auto') return 'auto (the engine chooses stations and order)'
  return `ordered: ${stopTexts(r.stops ?? []).join(' → ')}`
}

// Route model of the Edit-route panel (R5, D97; waypoint block §3, §4.2 draft contract). Pure: no
// DOM, no fetch, nothing from src/live (live/isolation.test.ts). The live side (live/route/types.ts)
// holds the typed copy of the draft contract and checks at compile time that these shapes fit it.
//
//   route   { mode: 'auto' | 'ordered', stops }; auto = the engine chooses stations and order (the
//           official behaviour, sent as no route at all); ordered = legs pad -> stops[0] -> … -> pad
//           in exactly the given order, never reordered (waypoint rule 2)
//   list    the six stations: the checked ones first, in route order (draggable), then the rest
//   hash    the D57 hash covers the route: order matters, a free point's label is dropped, an auto
//           route hashes as absent (R0 server/engine/hashing.py note, so v1.1 hashes stay)
import backendRaw from '../../../../config/backend.yaml'
import { CONFIG } from '../../config'

export type RouteMode = 'auto' | 'ordered'
export interface StationStop {
  station: string
}
export interface PointStop {
  lon: number
  lat: number
  label?: string
}
export type RouteStop = StationStop | PointStop
export interface PlanRoute {
  mode: RouteMode
  stops: readonly RouteStop[]
}

export const AUTO_ROUTE: PlanRoute = { mode: 'auto', stops: [] }

export const isStationStop = (s: RouteStop): s is StationStop => typeof (s as StationStop).station === 'string'

/**
 * Route limits. config/backend.yaml route.* once R0 (contract v1.2.0) is merged; until then the
 * values of the draft (§4.2, D97 item 6), all marked assumed.
 */
function limit(key: string, draft: number): number {
  const r = (backendRaw as { route?: Record<string, unknown> }).route
  const v = r?.[key]
  return typeof v === 'number' && v > 0 ? v : draft
}
export const ROUTE_LIMITS = {
  maxStops: limit('max_stops', 8),
  maxFreePoints: limit('max_free_points', 4),
  minStopSpacingM: limit('min_stop_spacing_m', 50),
  assumed: true,
} as const

/** Great-circle distance in metres on the Mars sphere (spacing check only; never shown). */
export function distanceM(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * CONFIG.marsRadiusM * Math.asin(Math.min(1, Math.sqrt(h)))
}

// ---- list operations (each one is one undo step in the route store) ------------------------------

const stopKey = (s: RouteStop) => (isStationStop(s) ? s.station : `${s.lon},${s.lat}`)

/** Check or uncheck a station: checking appends it to the end of the route; unchecking removes it. */
export function toggleStation(r: PlanRoute, id: string, on: boolean): PlanRoute {
  const has = r.stops.some((s) => isStationStop(s) && s.station === id)
  if (on === has) return r
  return { ...r, stops: on ? [...r.stops, { station: id }] : r.stops.filter((s) => !(isStationStop(s) && s.station === id)) }
}

/** Move the stop at `from` to index `to` (drag and drop, Alt+Up/Down). Out of range: unchanged. */
export function moveStop(r: PlanRoute, from: number, to: number): PlanRoute {
  const n = r.stops.length
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return r
  const stops = [...r.stops]
  const [s] = stops.splice(from, 1)
  stops.splice(to, 0, s)
  return { ...r, stops }
}

export function setMode(r: PlanRoute, mode: RouteMode): PlanRoute {
  return r.mode === mode ? r : { ...r, mode }
}

export const sameRoute = (a: PlanRoute, b: PlanRoute): boolean => a.mode === b.mode && a.stops.length === b.stops.length && a.stops.every((s, i) => JSON.stringify(s) === JSON.stringify(b.stops[i]))

// ---- payload and hash view ----------------------------------------------------------------------

/** plan_inputs.route as sent to POST /jobs: auto = no route (missing route = auto, §4.2). */
export function routePayload(r: PlanRoute): { mode: 'ordered'; stops: RouteStop[] } | undefined {
  if (r.mode !== 'ordered') return undefined
  return { mode: 'ordered', stops: r.stops.map((s) => (isStationStop(s) ? { station: s.station } : { lon: s.lon, lat: s.lat, ...(s.label ? { label: s.label } : {}) })) }
}

/** The route as it enters the result hash: auto absent, order kept, labels dropped (D57). */
export function routeForHash(r: PlanRoute): { mode: 'ordered'; stops: RouteStop[] } | undefined {
  const p = routePayload(r)
  return p && { mode: 'ordered', stops: p.stops.map((s) => (isStationStop(s) ? s : { lon: s.lon, lat: s.lat })) }
}

// ---- validity -----------------------------------------------------------------------------------

/** Where a station is (stations.json: access point if any, else the station). */
export interface StationGeo {
  id: string
  name?: string
  lon: number
  lat: number
}

/** Field lookups at a stop (fieldAt / stations.json); null = not known in this browser. */
export interface StopProbe {
  inGrid: boolean | null
  assessed: boolean | null
  /** walkable at the 20° limit: an assessed, not blocked cell */
  walkable: boolean | null
  /** reachable from the pad: a walkback time home exists */
  reachable: boolean | null
}

export type StopProblem = 'unknownStation' | 'duplicate' | 'outsideGrid' | 'unassessed' | 'notWalkable' | 'unreachable' | 'spacing' | 'tooMany'
export interface StopCheck {
  index: number
  key: string
  /** true valid, false refused, null unknown (no field here: never shown as invalid) */
  valid: boolean | null
  problems: StopProblem[]
}
export type RouteProblem = 'noStops' | 'tooManyStops' | 'tooManyFreePoints'
export interface RouteCheck {
  /** Compute plan may be pressed (auto, or ordered with every stop not refused) */
  ok: boolean
  route: RouteProblem[]
  stops: StopCheck[]
}

export interface RouteCheckContext {
  stations: readonly StationGeo[]
  pad: { lon: number; lat: number }
  probe?: (lon: number, lat: number) => StopProbe
}

const UNKNOWN_PROBE: StopProbe = { inGrid: null, assessed: null, walkable: null, reachable: null }

/** Position of a stop (station: stations.json; free point: itself); null = unknown station. */
export function stopAt(s: RouteStop, stations: readonly StationGeo[]): { lon: number; lat: number } | null {
  if (!isStationStop(s)) return { lon: s.lon, lat: s.lat }
  const g = stations.find((x) => x.id === s.station)
  return g ? { lon: g.lon, lat: g.lat } : null
}

/** Validity per stop and of the whole route (the server answers 422 for the same rules, naming the stop). */
export function checkRoute(r: PlanRoute, ctx: RouteCheckContext): RouteCheck {
  if (r.mode === 'auto') return { ok: true, route: [], stops: [] }
  const route: RouteProblem[] = []
  if (!r.stops.length) route.push('noStops')
  if (r.stops.length > ROUTE_LIMITS.maxStops) route.push('tooManyStops')
  if (r.stops.filter((s) => !isStationStop(s)).length > ROUTE_LIMITS.maxFreePoints) route.push('tooManyFreePoints')
  const seen = new Set<string>()
  const stops = r.stops.map((s, i): StopCheck => {
    const key = stopKey(s)
    const problems: StopProblem[] = []
    let unknown = false
    if (i >= ROUTE_LIMITS.maxStops) problems.push('tooMany')
    if (seen.has(key)) problems.push('duplicate')
    seen.add(key)
    const at = stopAt(s, ctx.stations)
    if (!at) problems.push('unknownStation')
    else {
      const p = ctx.probe ? ctx.probe(at.lon, at.lat) : UNKNOWN_PROBE
      if (p.inGrid === false) problems.push('outsideGrid')
      else if (p.assessed === false) problems.push('unassessed')
      else if (p.walkable === false) problems.push('notWalkable')
      else if (p.reachable === false) problems.push('unreachable')
      unknown = p.inGrid === null || p.assessed === null || p.walkable === null || p.reachable === null
      // WP6: every stop keeps route.min_stop_spacing_m from the pad and from every EARLIER stop
      // (WP2a stop_spacing_violations: all pairs; the later stop of a pair is the one named)
      const near = (b: { lon: number; lat: number } | null) => !!b && distanceM(b, at) < ROUTE_LIMITS.minStopSpacingM
      if (near(ctx.pad) || r.stops.slice(0, i).some((x) => near(stopAt(x, ctx.stations)))) problems.push('spacing')
    }
    return { index: i, key, valid: problems.length ? false : unknown ? null : true, problems }
  })
  return { ok: !route.length && stops.every((s) => s.valid !== false), route, stops }
}

// ---- legs ---------------------------------------------------------------------------------------

/** Name of a stop as the run record writes it: a station id, or W1, W2, … in order among the free points. */
export function stopNames(r: PlanRoute): string[] {
  let w = 0
  return r.stops.map((s) => (isStationStop(s) ? s.station : `W${++w}`))
}

/** Legs of an ordered route: leg 0 = pad -> stops[0], leg i = stops[i-1] -> stops[i], last = back to the pad. */
export function routeLegs(r: PlanRoute): { leg: number; from: string; to: string }[] {
  if (r.mode !== 'ordered' || !r.stops.length) return []
  const names = ['pad', ...stopNames(r), 'pad']
  return names.slice(1).map((to, i) => ({ leg: i, from: names[i], to }))
}

/** End points of leg `leg` (for the map highlight); null when a stop is unknown. */
export function legCoords(r: PlanRoute, leg: number, ctx: Pick<RouteCheckContext, 'stations' | 'pad'>): [number, number][] | null {
  const pts = [ctx.pad, ...r.stops.map((s) => stopAt(s, ctx.stations)), ctx.pad]
  const a = pts[leg]
  const b = pts[leg + 1]
  return a && b ? [[a.lon, a.lat], [b.lon, b.lat]] : null
}

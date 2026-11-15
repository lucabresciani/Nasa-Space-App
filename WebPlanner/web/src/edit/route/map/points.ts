// WP6 (D97): free waypoints of an ordered route (contract v1.2.0 "Route"): {lon, lat, label?} stops
// next to the stations, named W1, W2, ... in their order among the free stops. Pure list operations
// on PlanRoute (R5 model.ts); each one is ONE undo step when applied through the route controller
// (controller.edit -> store.apply). Limits: config/backend.yaml route.max_free_points (4) and
// route.max_stops (8) (ROUTE_LIMITS), limits.title_max_chars for a label (the server's 422
// route_label_too_long). Nothing here is computed while a marker is dragged (D85): the map applies
// movePoint once, on the drop.
import backendRaw from '../../../../../config/backend.yaml'
import { cfg } from '../../../config'
import { isStationStop, ROUTE_LIMITS, stopNames, type PlanRoute, type PointStop, type RouteStop } from '../model'

/** config/backend.yaml limits.title_max_chars (assumed there): a free point's label is capped to it. */
export const LABEL_MAX_CHARS = cfg<number>(backendRaw, 'limits.title_max_chars')

/** Decimal places kept for a clicked or dropped point (1e-6 deg ~ 6 cm on Mars: far below a 5 m cell). */
const LONLAT_DECIMALS = 6
const round = (x: number) => Number(x.toFixed(LONLAT_DECIMALS))

export const isPointStop = (s: RouteStop): s is PointStop => !isStationStop(s)

export function freePointCount(r: PlanRoute): number {
  return r.stops.filter(isPointStop).length
}

/** Why no point can be added now (null = it can). */
export function addBlocked(r: PlanRoute): 'auto' | 'tooManyFreePoints' | 'tooManyStops' | null {
  if (r.mode !== 'ordered') return 'auto'
  if (freePointCount(r) >= ROUTE_LIMITS.maxFreePoints) return 'tooManyFreePoints'
  if (r.stops.length >= ROUTE_LIMITS.maxStops) return 'tooManyStops'
  return null
}

/** Append a free point at the end of the route (unchanged when the limits forbid it). */
export function addPoint(r: PlanRoute, at: { lon: number; lat: number }): PlanRoute {
  if (addBlocked(r) || !Number.isFinite(at.lon) || !Number.isFinite(at.lat)) return r
  return { ...r, stops: [...r.stops, { lon: round(at.lon), lat: round(at.lat) }] }
}

/** Move the free point at route index `i` (its label stays). Not a free point: unchanged. */
export function movePoint(r: PlanRoute, i: number, at: { lon: number; lat: number }): PlanRoute {
  const s = r.stops[i]
  if (!s || !isPointStop(s) || !Number.isFinite(at.lon) || !Number.isFinite(at.lat)) return r
  const lon = round(at.lon)
  const lat = round(at.lat)
  if (lon === s.lon && lat === s.lat) return r
  return { ...r, stops: r.stops.map((x, k) => (k === i ? { ...s, lon, lat } : x)) }
}

/** Trimmed and capped label; empty = no label. */
export function cleanLabel(label: string): string | undefined {
  const t = label.trim().slice(0, LABEL_MAX_CHARS).trim()
  return t ? t : undefined
}

/** Rename the free point at route index `i` (empty label removes it). */
export function renamePoint(r: PlanRoute, i: number, label: string): PlanRoute {
  const s = r.stops[i]
  if (!s || !isPointStop(s)) return r
  const l = cleanLabel(label)
  if (l === s.label) return r
  const next: PointStop = l === undefined ? { lon: s.lon, lat: s.lat } : { lon: s.lon, lat: s.lat, label: l }
  return { ...r, stops: r.stops.map((x, k) => (k === i ? next : x)) }
}

/** Delete the free point at route index `i`; the W names after it close up. */
export function deletePoint(r: PlanRoute, i: number): PlanRoute {
  const s = r.stops[i]
  if (!s || !isPointStop(s)) return r
  return { ...r, stops: r.stops.filter((_, k) => k !== i) }
}

/** W name of the stop at each route index (null for a station). */
export function pointNames(r: PlanRoute): (string | null)[] {
  const names = stopNames(r)
  return r.stops.map((s, i) => (isPointStop(s) ? names[i] : null))
}

/** Free points with their route index and W name, in route order. */
export function freePoints(r: PlanRoute): { index: number; name: string; stop: PointStop }[] {
  const names = stopNames(r)
  const out: { index: number; name: string; stop: PointStop }[] = []
  r.stops.forEach((s, i) => {
    if (isPointStop(s)) out.push({ index: i, name: names[i], stop: s })
  })
  return out
}

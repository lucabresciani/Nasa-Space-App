// WP6 (D97): validity of a stop from field lookups the browser already has (U15 honesty rule: never
// computed, unknown stays unknown), and the contract codes (v1.2.0 Error.stop) of R5's StopProblem.
// A stop is judged over its ACCESS DISC (config/variants.yaml route.access_radius_m, 50 m, D27), as
// the engine does (WP2a point_validity), so the browser never refuses what the engine accepts:
//   inGrid     the stop's own cell is inside the field grid (fields/index.json bounds)
//   assessed   some cell within the disc has known terrain (cell state assessed or blocked)
//   walkable   some cell within the disc is assessed and not blocked at the 20° no-go (cell state)
//   reachable  some cell within the disc has a known T_home of the plan's variant (the browser's
//              stand-in for "a walk to the main terrain"; WP2a's code 4)
// The 422 of the live job stays the answer.
import { CONFIG } from '../../../config'
import { STATE } from '../../../map/field/constants'
import type { Bounds, DecodedGrid, StateGrid } from '../../../map/field/decode'
import type { Variant } from '../../../map/field'
import type { StopProbe, StopProblem } from '../model'

/** The D27 access radius (config/variants.yaml route.access_radius_m). */
export const ACCESS_RADIUS_M = CONFIG.accessRadiusM

/** The decoded fields a disc probe reads (FieldData satisfies it). */
export interface DiscFields {
  t: Record<Variant, DecodedGrid>
  state: StateGrid | null
}

const DEG = Math.PI / 180

/**
 * Does any pixel of `g` whose centre lies within `radiusM` of (lon, lat), or the pixel containing
 * (lon, lat), satisfy `ok(index)`? Local equirectangular metres on the Mars sphere (site.yaml).
 */
export function anyInDisc(g: { width: number; height: number; bounds: Bounds }, lon: number, lat: number, radiusM: number, ok: (i: number) => boolean): boolean {
  const [w, s, e, n] = g.bounds
  const mPerDegLat = CONFIG.marsRadiusM * DEG
  const mPerDegLon = mPerDegLat * Math.cos(lat * DEG)
  const dLon = (e - w) / g.width
  const dLat = (n - s) / g.height
  const own = { col: Math.floor((lon - w) / dLon), row: Math.floor((n - lat) / dLat) }
  const c0 = Math.max(0, Math.floor((lon - radiusM / mPerDegLon - w) / dLon))
  const c1 = Math.min(g.width - 1, Math.floor((lon + radiusM / mPerDegLon - w) / dLon))
  const r0 = Math.max(0, Math.floor((n - (lat + radiusM / mPerDegLat)) / dLat))
  const r1 = Math.min(g.height - 1, Math.floor((n - (lat - radiusM / mPerDegLat)) / dLat))
  for (let r = r0; r <= r1; r++) {
    const dy = (n - (r + 0.5) * dLat - lat) * mPerDegLat
    for (let c = c0; c <= c1; c++) {
      const dx = (w + (c + 0.5) * dLon - lon) * mPerDegLon
      if (!(dx * dx + dy * dy <= radiusM * radiusM || (r === own.row && c === own.col))) continue
      if (ok(r * g.width + c)) return true
    }
  }
  return false
}

/** Validity lookups at a stop over its access disc (null where the browser has no field). */
export function discProbe(f: DiscFields | null, lon: number, lat: number, v: Variant, radiusM = ACCESS_RADIUS_M): StopProbe {
  if (!f) return { inGrid: null, assessed: null, walkable: null, reachable: null }
  const t = f.t[v]
  const [w, s, e, n] = t.bounds
  if (!(lon >= w && lon < e && lat > s && lat <= n)) return { inGrid: false, assessed: null, walkable: null, reachable: null }
  const st = f.state
  return {
    inGrid: true,
    assessed: st ? anyInDisc(st, lon, lat, radiusM, (i) => st.code[i] !== STATE.unknown) : null,
    walkable: st ? anyInDisc(st, lon, lat, radiusM, (i) => st.code[i] === STATE.assessed) : null,
    reachable: anyInDisc(t, lon, lat, radiusM, (i) => t.known[i] === 1),
  }
}

/** The contract's 422 code for each stop problem (openapi v1.2.0 Error.stop; R5 text.ts ROUTE_ERROR_TEXT). */
export const STOP_PROBLEM_CODE: Record<StopProblem, string> = {
  unknownStation: 'route_station_unknown',
  duplicate: 'route_station_duplicate',
  outsideGrid: 'route_point_outside_grid',
  unassessed: 'route_point_unassessed',
  notWalkable: 'route_point_not_walkable',
  unreachable: 'route_point_unreachable',
  spacing: 'route_stop_spacing',
  tooMany: 'route_too_many_stops',
}

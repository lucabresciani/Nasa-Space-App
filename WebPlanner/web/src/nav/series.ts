// Time lookups over the navigation files. Values are held or looked up, never recomputed:
// the per-minute ellipse in force at time t is the last row at or before t (no interpolation of
// numbers); only positions along a timed line are interpolated (presentation).
import type { Fix, FixType, LonLat, PerMinute, TrackFeature, TracksFC } from './types'

/** Per-minute row in force at t: last row with t_eva_min <= t; clamped to the first row before it. */
export function rowAt(rows: readonly PerMinute[], t: number): PerMinute | null {
  if (!rows.length) return null
  let sorted = true
  for (let i = 1; i < rows.length && sorted; i++) if (rows[i].t_eva_min < rows[i - 1].t_eva_min) sorted = false
  const rs = sorted ? rows : [...rows].sort((a, b) => a.t_eva_min - b.t_eva_min)
  if (t < rs[0].t_eva_min) return rs[0]
  // binary search for the last row with t_eva_min <= t
  let lo = 0
  let hi = rs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (rs[mid].t_eva_min <= t + 1e-9) lo = mid
    else hi = mid - 1
  }
  return rs[lo]
}

/** Position at t along a line with one time per vertex; clamped at the ends. */
export function interpAlong(coords: readonly LonLat[], times: readonly number[], t: number): LonLat {
  if (!coords.length || coords.length !== times.length) throw new Error('interpAlong: coords and times differ in length')
  if (t <= times[0]) return [coords[0][0], coords[0][1]]
  const last = coords.length - 1
  if (t >= times[last]) return [coords[last][0], coords[last][1]]
  let i = 1
  while (i < last && times[i] < t) i++
  // repeated times: jump to the last vertex at that time
  while (i < last && times[i + 1] === times[i] && times[i] <= t) i++
  const t0 = times[i - 1]
  const t1 = times[i]
  if (t1 <= t0 || t >= t1) return [coords[i][0], coords[i][1]]
  const f = (t - t0) / (t1 - t0)
  return [coords[i - 1][0] + f * (coords[i][0] - coords[i - 1][0]), coords[i - 1][1] + f * (coords[i][1] - coords[i - 1][1])]
}

export interface TrackLine {
  feature: TrackFeature
  parts: LonLat[][]
}

/** The line feature of a kind ("true" | "estimated"), as parts. */
export function trackLine(fc: TracksFC, kind: string): TrackLine | null {
  const f = fc.features.find((x) => x.properties.kind === kind && (x.geometry.type === 'LineString' || x.geometry.type === 'MultiLineString'))
  if (!f) return null
  const g = f.geometry as { type: 'LineString'; coordinates: number[][] } | { type: 'MultiLineString'; coordinates: number[][][] }
  const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates
  return { feature: f, parts: lines.map((l) => l.map((c) => [c[0], c[1]] as LonLat)) }
}

/** Flattened coordinates and per-vertex times, if the feature carries a matching t_eva_min_vertices. */
export function lineWithTimes(line: TrackLine): { coords: LonLat[]; times: number[] } | null {
  const times = line.feature.properties.t_eva_min_vertices
  const coords = line.parts.flat()
  if (!Array.isArray(times) || times.length !== coords.length || !times.every((v) => typeof v === 'number')) return null
  return { coords, times }
}

/** Ellipse polygons (kind ellipse95) with t_eva_min <= t, in time order. */
export function ellipsesUpTo(fc: TracksFC, t: number): TrackFeature[] {
  return fc.features
    .filter((f) => f.properties.kind === 'ellipse95' && f.properties.t_eva_min <= t + 1e-9)
    .sort((a, b) => a.properties.t_eva_min - b.properties.t_eva_min)
}

const byTime = (a: Fix, b: Fix) => a.t_eva_min - b.t_eva_min

export function filterFixes(fixes: readonly Fix[], types: ReadonlySet<FixType>): Fix[] {
  return fixes.filter((f) => types.has(f.type)).sort(byTime)
}

export function fixesUpTo(fixes: readonly Fix[], t: number): Fix[] {
  return fixes.filter((f) => f.t_eva_min <= t + 1e-9).sort(byTime)
}

/** Most recent fix at or before t (a fix at exactly t counts as taken). */
export function lastFix(fixes: readonly Fix[], t: number): Fix | null {
  const up = fixesUpTo(fixes, t)
  return up.length ? up[up.length - 1] : null
}

/** First fix strictly after t. */
export function nextFix(fixes: readonly Fix[], t: number): Fix | null {
  return [...fixes].sort(byTime).find((f) => f.t_eva_min > t + 1e-9) ?? null
}

interface RouteLegLike {
  geometry: { type: string; coordinates: unknown }
  properties?: Record<string, unknown> | null
}

/**
 * Timed knots of a planned route (route_{scenario}.geojson, WS2 leg format): a leg with
 * `times_min` (one per vertex) uses them, else uniform speed along the leg between `t_start_min`
 * and `t_end_min`. Legs in time order; gaps between legs are dwells (held at the last vertex).
 * `metric` converts lon/lat steps to metres for the uniform-speed case.
 */
export function routeKnots(features: readonly RouteLegLike[], metric: { mPerDegLon: number; mPerDegLat: number }): { coords: LonLat[]; times: number[] } {
  const legs: { t0: number; coords: LonLat[]; times: number[] }[] = []
  for (const f of features) {
    const p = f.properties ?? {}
    const g = f.geometry
    let coords: LonLat[]
    if (g.type === 'LineString') coords = (g.coordinates as number[][]).map((c) => [c[0], c[1]])
    else if (g.type === 'MultiLineString') coords = (g.coordinates as number[][][]).flat().map((c) => [c[0], c[1]])
    else continue
    if (coords.length < 2) continue
    let times: number[]
    const tm = p.times_min
    if (Array.isArray(tm) && tm.length === coords.length && tm.every((v) => typeof v === 'number')) times = tm as number[]
    else {
      const t0 = p.t_start_min
      const t1 = p.t_end_min
      if (typeof t0 !== 'number' || typeof t1 !== 'number') continue
      const s = [0]
      for (let i = 1; i < coords.length; i++) {
        const de = (coords[i][0] - coords[i - 1][0]) * metric.mPerDegLon
        const dn = (coords[i][1] - coords[i - 1][1]) * metric.mPerDegLat
        s.push(s[i - 1] + Math.hypot(de, dn))
      }
      const L = s[s.length - 1]
      times = s.map((v) => t0 + (L > 0 ? (v / L) * (t1 - t0) : 0))
    }
    legs.push({ t0: times[0], coords, times })
  }
  legs.sort((a, b) => a.t0 - b.t0)
  return { coords: legs.flatMap((l) => l.coords), times: legs.flatMap((l) => l.times) }
}

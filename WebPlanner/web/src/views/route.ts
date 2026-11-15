// Route summary (F9) from route_{scenario}.geojson leg properties (contract v1.1.0, WS2 traverse.py):
// stop order and leg times as written; nothing recomputed.
import type { RouteFC } from '../data/types'

export interface RouteLeg {
  leg: number
  from: string
  to: string
  t_min: number | null
  length_m: number | null
  o2_L: number | null
  t_start_min: number | null
  t_end_min: number | null
  to_access_dist_m: number | null
}

export interface RouteSummary {
  stops: string[]
  legs: RouteLeg[]
  /** End of the last leg (min into the EVA). */
  endMin: number | null
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function routeSummary(route: RouteFC | null): RouteSummary | null {
  if (!route) return null
  const legs: RouteLeg[] = []
  for (const f of route.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>
    if (typeof p.leg !== 'number' || typeof p.from !== 'string' || typeof p.to !== 'string') continue
    legs.push({
      leg: p.leg,
      from: p.from,
      to: p.to,
      t_min: n(p.t_min),
      length_m: n(p.length_m),
      o2_L: n(p.o2_L),
      t_start_min: n(p.t_start_min),
      t_end_min: n(p.t_end_min),
      to_access_dist_m: n(p.to_access_dist_m),
    })
  }
  if (!legs.length) return null
  legs.sort((a, b) => a.leg - b.leg)
  return { stops: [legs[0].from, ...legs.map((l) => l.to)], legs, endMin: legs[legs.length - 1].t_end_min }
}

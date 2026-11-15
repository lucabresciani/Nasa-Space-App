// WP6 (D97): the leg cache of the ghost route, ported from origin/waypoint-routing
// web/src/mission/plan.ts (N0CEO, Mission Planer): legPairs and routeLegs unchanged (moving one
// waypoint re-routes only its two legs); closedPairs adds the walk back to the pad, since a route
// here is pad -> stops[0] -> ... -> pad (contract v1.2.0 leg numbering).
import type { Leg } from './router'

export interface Waypoint {
  /** cell index on the routing grid */
  cell: number
}

/** Cell pairs of the legs: pad -> w1, w1 -> w2, ... (ported) */
export function legPairs(padCell: number, wps: Pick<Waypoint, 'cell'>[]): [number, number][] {
  const out: [number, number][] = []
  let prev = padCell
  for (const w of wps) {
    out.push([prev, w.cell])
    prev = w.cell
  }
  return out
}

/** Route every leg, reusing cached ones (key "from-to"); the cache is updated in place. (ported) */
export function routeLegs(pairs: [number, number][], route: (a: number, b: number) => Leg | null, cache: Map<string, Leg | null>): (Leg | null)[] {
  return pairs.map(([a, b]) => {
    const k = `${a}-${b}`
    if (!cache.has(k)) cache.set(k, route(a, b))
    return cache.get(k)!
  })
}

/** pad -> w1 -> ... -> wn -> pad (leg i of the contract = pair i). No stop: no legs. */
export function closedPairs(padCell: number, wps: Pick<Waypoint, 'cell'>[]): [number, number][] {
  if (!wps.length) return []
  return [...legPairs(padCell, wps), [wps[wps.length - 1].cell, padCell]]
}

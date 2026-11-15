import { describe, expect, it } from 'vitest'
import type { RouteFC } from '../data/types'
import { routeSummary } from './route'

const leg = (leg: number, from: string, to: string, t_min: number, length_m: number, t_start_min: number, t_end_min: number) => ({
  type: 'Feature' as const,
  geometry: { type: 'LineString' as const, coordinates: [] },
  properties: { leg, from, to, t_min, length_m, t_start_min, t_end_min, o2_L: 1 },
})
// route_nom_104.geojson legs (WS2 12:01 CET): pad -> S4 -> S2 -> pad, 209.74 min.
const ROUTE: RouteFC = {
  type: 'FeatureCollection',
  features: [leg(2, 'S4', 'S2', 30.29, 1741.3, 78.44, 108.73), leg(1, 'pad', 'S4', 48.44, 2357.0, 0.0, 48.44), leg(3, 'S2', 'pad', 71.01, 2122.4, 138.73, 209.74)],
}

describe('route summary', () => {
  it('orders legs by `leg` and lists the stops', () => {
    const r = routeSummary(ROUTE)!
    expect(r.stops).toEqual(['pad', 'S4', 'S2', 'pad'])
    expect(r.legs.map((l) => l.leg)).toEqual([1, 2, 3])
  })
  it('end time is the last leg end (equals the manifest route total)', () => {
    expect(routeSummary(ROUTE)!.endMin).toBe(209.74)
  })
  it('empty route or legs without properties: null (no route to show)', () => {
    expect(routeSummary({ type: 'FeatureCollection', features: [] })).toBeNull()
    expect(routeSummary(null)).toBeNull()
  })
})

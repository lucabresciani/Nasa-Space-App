// WP6 (D97 §3.3): the ghost route while a route is edited: pad -> stops -> pad on the browser's 5 m
// grid with the ported A* router (router.ts, engine move rules) and its leg cache (legs.ts: moving
// one stop re-routes only its two legs). Every time here is an ESTIMATE (honesty rule): coarser
// terrain than the engine's 3 m graph, walking time only, no dwell and no margin. The live job's run
// record (feasibility, legs) is the answer; the ghost is hidden once a computed result is shown.
import { stopAt, stopNames, type PlanRoute, type StationGeo } from '../model'
import { closedPairs, routeLegs } from './legs'
import type { Leg } from './router'

export interface GhostLeg {
  /** contract leg number: 0 = pad -> stops[0], len(stops) = last stop -> pad */
  leg: number
  from: string
  to: string
  /** walking time on the browser grid (s); null = no path on this grid (no estimate) */
  timeS: number | null
  distM: number | null
  /** routed cells as lon/lat, or the straight line between the two stops when not routed */
  coords: [number, number][]
  routed: boolean
}

export interface Ghost {
  legs: GhostLeg[]
  /** sum of the leg times; null when a leg has no estimate */
  totalS: number | null
}

/** What the ghost needs from the grid (tests pass a small synthetic one). */
export interface GhostGrid {
  /** cell a stop is routed from (own cell, else the nearest walkable one within the access radius), null = none */
  cellOf(lon: number, lat: number): number | null
  lonLatOf(cell: number): [number, number]
  route(from: number, to: number): Leg | null
}

/** null when there is nothing to draw (auto mode, or no stop yet). */
export function ghostRoute(r: PlanRoute, ctx: { stations: readonly StationGeo[]; pad: { lon: number; lat: number } }, g: GhostGrid, cache: Map<string, Leg | null>): Ghost | null {
  if (r.mode !== 'ordered' || !r.stops.length) return null
  const at = [ctx.pad, ...r.stops.map((s) => stopAt(s, ctx.stations)), ctx.pad]
  const names = ['pad', ...stopNames(r), 'pad']
  // -1 = no cell: the cache keys it like any other pair and the router is never asked
  const cells = at.map((p) => (p ? (g.cellOf(p.lon, p.lat) ?? -1) : -1))
  const pairs = closedPairs(cells[0], cells.slice(1, -1).map((cell) => ({ cell })))
  const legs = routeLegs(pairs, (a, b) => (a < 0 || b < 0 ? null : g.route(a, b)), cache)
  const out: GhostLeg[] = legs.map((leg, i) => {
    const a = at[i]
    const b = at[i + 1]
    const straight: [number, number][] = a && b ? [[a.lon, a.lat], [b.lon, b.lat]] : []
    return leg
      ? { leg: i, from: names[i], to: names[i + 1], timeS: leg.timeS, distM: leg.distM, coords: leg.cells.length > 1 ? leg.cells.map((c) => g.lonLatOf(c)) : straight, routed: true }
      : { leg: i, from: names[i], to: names[i + 1], timeS: null, distM: null, coords: straight, routed: false }
  })
  const totalS = out.every((l) => l.timeS !== null) ? out.reduce((s, l) => s + (l.timeS ?? 0), 0) : null
  return { legs: out, totalS }
}

/** The ghost as GeoJSON for the map layer (one line per leg). */
export function ghostData(g: Ghost | null): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: (g?.legs ?? [])
      .filter((l) => l.coords.length >= 2)
      .map((l) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l.coords }, properties: { leg: l.leg, routed: l.routed, state: 'estimate' } })),
  }
}

/** The access radius a stop is routed from (variants.yaml route.access_radius_m, D27). */
export { ACCESS_RADIUS_M } from './validity'

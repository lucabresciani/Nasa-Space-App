// WS16 task 5 (M5): the planned route on the map (DESIGN U4 "Route"), pure part.
// The route draws itself along its length when a plan loads (tokens motion.routeDrawMs, 1.5 s);
// done legs solid, coming legs at 50 % opacity; turn-back points as short ticks across the route.
// Geometry and timing are WS7's Plan (hud/plan.ts: route legs, per-vertex times_min, turn-back
// rows); nothing is recomputed. Reduced motion: no draw-on (the route is there at once).
import type { Plan } from '../hud/plan'
import type { LonLat } from '../hud/types'
import { TOKENS } from '../ui/tokens'

/** The whole walk as one polyline with cumulative metres (legs joined in walk order). */
export interface RouteLine {
  coords: LonLat[]
  cum: number[]
  length: number
}

export function routeLine(plan: Plan): RouteLine {
  const coords: LonLat[] = []
  const cum: number[] = []
  let base = 0
  for (const leg of plan.legs) {
    leg.coords.forEach((c, i) => {
      const d = base + leg.cum[i]
      const last = coords[coords.length - 1]
      if (i === 0 && last && last[0] === c[0] && last[1] === c[1]) return // leg joins the previous one
      coords.push(c)
      cum.push(d)
    })
    base += leg.length
  }
  return { coords, cum, length: cum.length ? cum[cum.length - 1] : 0 }
}

/** The part of the line between a and b metres along it (clamped); null when shorter than a point. */
export function subLine(l: RouteLine, a: number, b: number): LonLat[] | null {
  const lo = Math.max(0, Math.min(a, l.length))
  const hi = Math.max(0, Math.min(b, l.length))
  if (!(hi > lo) || l.coords.length < 2) return null
  const at = (d: number): LonLat => {
    let i = 1
    while (i < l.cum.length - 1 && l.cum[i] < d) i++
    const [d0, d1] = [l.cum[i - 1], l.cum[i]]
    const f = d1 > d0 ? (d - d0) / (d1 - d0) : 0
    const [p, q] = [l.coords[i - 1], l.coords[i]]
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]
  }
  const out: LonLat[] = [at(lo)]
  for (let i = 0; i < l.coords.length; i++) if (l.cum[i] > lo && l.cum[i] < hi) out.push(l.coords[i])
  out.push(at(hi))
  return out
}

/** Draw-on progress 0..1 at `elapsedMs` (linear along the length). Reduced motion: 1 at once. */
export function drawOnFraction(elapsedMs: number, durationMs: number = TOKENS.motion.routeDrawMs, reduced = false): number {
  if (reduced || !(durationMs > 0)) return 1
  return Math.min(1, Math.max(0, elapsedMs / durationMs))
}

type LineFeature = GeoJSON.Feature<GeoJSON.LineString, { part: 'done' | 'coming' | 'tick'; station?: string }>
export type RouteFeatures = GeoJSON.FeatureCollection<GeoJSON.LineString, LineFeature['properties']>

/**
 * Route features at draw-on progress `frac` and walked distance `walkedM` (Plan.stateAt(t)
 * .distanceWalkedM): `done` = walked (solid), `coming` = still ahead (50 %), and the turn-back ticks
 * once the line has reached them.
 */
export function routeFeatures(l: RouteLine, frac: number, walkedM: number, ticks: TurnBackTick[] = []): RouteFeatures {
  const shown = l.length * Math.min(1, Math.max(0, frac))
  const features: LineFeature[] = []
  const done = subLine(l, 0, Math.min(walkedM, shown))
  const coming = subLine(l, Math.max(0, walkedM), shown)
  if (done) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: done }, properties: { part: 'done' } })
  if (coming) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coming }, properties: { part: 'coming' } })
  for (const k of ticks) {
    if (k.alongM <= shown) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: k.coords }, properties: { part: 'tick', station: k.station } })
  }
  return { type: 'FeatureCollection', features }
}

export interface TurnBackTick {
  station: string
  /** WS2 turn_back time (the latest time to start home from this station), min */
  tMin: number
  /** metres along the route where the station's dwell sits */
  alongM: number
  /** a short segment across the route, centred on the station */
  coords: [LonLat, LonLat]
}

/**
 * Turn-back ticks: one per WS2 `turn_back` row, at its station's dwell point on the route, across
 * the arriving leg's last direction. `halfM` = half the tick length in metres.
 */
export function turnBackTicks(plan: Plan, halfM: number): TurnBackTick[] {
  const out: TurnBackTick[] = []
  let base = 0
  const arriveAt = new Map<string, { at: number; from: LonLat; to: LonLat }>()
  for (const leg of plan.legs) {
    const n = leg.coords.length
    if (leg.to && n >= 2) arriveAt.set(leg.to, { at: base + leg.length, from: leg.coords[n - 2], to: leg.coords[n - 1] })
    base += leg.length
  }
  const one = plan.dist([0, 0], [1, 0]) // metres per degree of longitude (planar metric)
  const oneLat = plan.dist([0, 0], [0, 1])
  for (const tb of plan.turnBacks) {
    const a = tb.station ? arriveAt.get(tb.station) : undefined
    if (!a || !tb.station) continue
    const dx = (a.to[0] - a.from[0]) * one
    const dy = (a.to[1] - a.from[1]) * oneLat
    const len = Math.hypot(dx, dy) || 1
    const [nx, ny] = [-dy / len, dx / len] // unit normal, metres
    const c = a.to
    out.push({
      station: tb.station,
      tMin: tb.t_min,
      alongM: a.at,
      coords: [
        [c[0] - (nx * halfM) / one, c[1] - (ny * halfM) / oneLat],
        [c[0] + (nx * halfM) / one, c[1] + (ny * halfM) / oneLat],
      ],
    })
  }
  return out
}

/**
 * Draw-on driver with an injectable clock (tests, storyboards). `onFrame(frac)` runs on every frame
 * until 1; under reduced motion it runs once with 1 and asks for no frame at all.
 */
export function playDrawOn(
  onFrame: (frac: number) => void,
  opts: { durationMs?: number; reduced?: boolean; now?: () => number; raf?: (cb: () => void) => number; caf?: (id: number) => void } = {},
): () => void {
  const durationMs = opts.durationMs ?? TOKENS.motion.routeDrawMs
  if (opts.reduced || !(durationMs > 0)) {
    onFrame(1)
    return () => {}
  }
  const now = opts.now ?? (() => performance.now())
  const raf = opts.raf ?? ((cb) => requestAnimationFrame(cb))
  const caf = opts.caf ?? ((id) => cancelAnimationFrame(id))
  const t0 = now()
  let id = 0
  let stopped = false
  const step = (): void => {
    if (stopped) return
    const f = drawOnFraction(now() - t0, durationMs)
    onFrame(f)
    if (f < 1) id = raf(step)
  }
  step()
  return () => {
    stopped = true
    caf(id)
  }
}

/** The route straight from its file (legs in `leg` order) when no timeline belongs to it. */
export function routeLineFromFC(fc: { features: { geometry: { type: string; coordinates: unknown }; properties?: Record<string, unknown> | null }[] }, metric: { mPerDegLon: number; mPerDegLat: number }): RouteLine {
  const feats = [...fc.features].sort((a, b) => Number(a.properties?.leg ?? 0) - Number(b.properties?.leg ?? 0))
  const coords: LonLat[] = []
  const cum: number[] = []
  for (const f of feats) {
    const lines = (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : []) as number[][][]
    for (const l of lines) {
      for (const p of l) {
        const c: LonLat = [p[0], p[1]]
        const last = coords[coords.length - 1]
        if (last && last[0] === c[0] && last[1] === c[1]) continue
        cum.push(last ? cum[cum.length - 1] + Math.hypot((c[0] - last[0]) * metric.mPerDegLon, (c[1] - last[1]) * metric.mPerDegLat) : 0)
        coords.push(c)
      }
    }
  }
  return { coords, cum, length: cum.length ? cum[cum.length - 1] : 0 }
}

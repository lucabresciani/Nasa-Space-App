// The planned EVA (F9 outputs) as a function of EVA time: where the marker is, how much headroom
// the plan leaves, O2 left. Lookups and interpolation only, no science (brief WS7 "Don't").
//
// Timing comes from timeline_{scenario}.json: a walk segment runs from a `depart`/`leave` event
// to the next `arrive`/`return` (`arrive_home` in the M0 dummy) event; a dwell runs from `arrive`
// to `leave`. Walk segment k follows route feature k (sorted by its `leg` property when present).
// Within a leg the marker follows the route's per-vertex `times_min` (contracts v1.1.0, WS2) when
// present; otherwise it moves at uniform speed along the line (assumption A-WS7-1).
// An empty route (no reachable station) is a plan that stays at the pad.
import type { Binding, LonLat, RouteFC, TimelineEvent } from './types'

const START_EVENTS = new Set(['depart', 'leave'])
const END_EVENTS = new Set(['arrive', 'return', 'arrive_home'])
const ANNOTATION_EVENTS = new Set(['turn_back'])

export interface Metric {
  mPerDegLon: number
  mPerDegLat: number
}

export interface Leg {
  from: string | null
  to: string | null
  t0: number
  t1: number
  coords: LonLat[]
  cum: number[] // cumulative metres at each vertex
  length: number
  /** EVA minute at each vertex (route times_min), or null = uniform speed */
  times: number[] | null
}

export interface Dwell {
  station: string
  t0: number
  t1: number
  at: LonLat
}

export interface PlanState {
  lon: number
  lat: number
  phase: 'before' | 'walk' | 'dwell' | 'after'
  headingDeg: number | null // direction of travel, clockwise from north
  leg: number | null
  station: string | null // station during a dwell
  dwellFrac: number | null // 0..1 progress through the dwell
  distanceWalkedM: number // along the route since EVA start
}

/** Piecewise-linear interpolation over (t, v) points with non-null v; held at the ends. */
export function interpSeries(points: [number, number][], t: number): number | null {
  if (points.length === 0) return null
  if (t <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i]
    if (t <= t1) {
      const [t0, v0] = points[i - 1]
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)
    }
  }
  return points[points.length - 1][1]
}

/** Vertices of a leg (and their times, if given), consecutive duplicates removed. */
function flatten(geom: RouteFC['features'][number]['geometry'], times?: number[]): { coords: LonLat[]; times: number[] | null } {
  const lines = geom.type === 'Point' ? [[geom.coordinates]] : geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates
  const all = (lines as number[][][]).flat()
  const useT = Array.isArray(times) && times.length === all.length
  const coords: LonLat[] = []
  const ts: number[] = []
  all.forEach((c, k) => {
    const p: LonLat = [c[0], c[1]]
    const last = coords[coords.length - 1]
    if (last && last[0] === p[0] && last[1] === p[1]) {
      if (useT) ts[ts.length - 1] = Math.max(ts[ts.length - 1], times![k])
      return
    }
    coords.push(p)
    if (useT) ts.push(times![k])
  })
  return { coords, times: useT ? ts : null }
}

export class Plan {
  readonly legs: Leg[] = []
  readonly dwells: Dwell[] = []
  readonly events: TimelineEvent[]
  /**
   * WS2 `turn_back` rows: the latest time to leave each station (margin 0). They are annotations
   * after the return, not steps of the walk, so they never enter the walk, the series or tEnd.
   */
  readonly turnBacks: TimelineEvent[]
  readonly tEnd: number
  readonly start: LonLat
  private readonly headroom: [number, number][]
  private readonly o2Left: [number, number][]
  private readonly metric: Metric

  /** `home` = where an empty plan stays (the pad); defaults to the first route vertex. */
  constructor(route: RouteFC, timeline: TimelineEvent[], metric: Metric, home?: LonLat) {
    this.metric = metric
    const sorted = [...timeline].sort((a, b) => a.t_min - b.t_min)
    this.events = sorted.filter((e) => !ANNOTATION_EVENTS.has(e.event))
    this.turnBacks = sorted.filter((e) => e.event === 'turn_back')
    const feats = [...route.features]
    if (feats.every((f) => typeof f.properties?.leg === 'number')) {
      feats.sort((a, b) => (a.properties.leg as number) - (b.properties.leg as number))
    }
    // walk segments from the timeline
    const segs: { t0: number; t1: number; from: string | null; to: string | null }[] = []
    let open: TimelineEvent | null = null
    let arrived: TimelineEvent | null = null
    for (const ev of this.events) {
      if (START_EVENTS.has(ev.event)) {
        if (ev.event === 'leave' && arrived && arrived.station) {
          this.dwells.push({ station: arrived.station, t0: arrived.t_min, t1: ev.t_min, at: [0, 0] })
        }
        open = ev
        arrived = null
      } else if (END_EVENTS.has(ev.event) && open) {
        segs.push({ t0: open.t_min, t1: ev.t_min, from: open.station, to: ev.station })
        open = null
        arrived = ev
      }
    }
    if (feats.length === 0) segs.length = 0 // empty route: no walk, the crew stays at the pad
    if (segs.length !== feats.length) {
      throw new Error(`timeline has ${segs.length} walk segments but the route has ${feats.length} legs`)
    }
    segs.forEach((s, i) => {
      const { coords, times } = flatten(feats[i].geometry, feats[i].properties?.times_min)
      if (coords.length < 1) throw new Error(`route leg ${i} has no coordinates`)
      const cum = [0]
      for (let k = 1; k < coords.length; k++) cum.push(cum[k - 1] + this.dist(coords[k - 1], coords[k]))
      this.legs.push({ ...s, coords, cum, length: cum[cum.length - 1], times })
    })
    for (const d of this.dwells) {
      const leg = this.legs.find((l) => l.t1 === d.t0)
      d.at = leg ? leg.coords[leg.coords.length - 1] : this.legs[0].coords[0]
    }
    this.start = this.legs[0]?.coords[0] ?? home ?? [NaN, NaN]
    this.tEnd = this.events.length ? this.events[this.events.length - 1].t_min : 0
    this.headroom = this.events
      .filter((e) => e.margin_min !== null && e.t_home_min !== null)
      .map((e) => [e.t_min, (e.margin_min as number) + (e.t_home_min as number)])
    this.o2Left = this.events.filter((e) => e.o2_left_L !== null).map((e) => [e.t_min, e.o2_left_L as number])
  }

  dist(a: LonLat, b: LonLat): number {
    return Math.hypot((b[0] - a[0]) * this.metric.mPerDegLon, (b[1] - a[1]) * this.metric.mPerDegLat)
  }

  private walkedBefore(legIdx: number): number {
    let s = 0
    for (let i = 0; i < legIdx; i++) s += this.legs[i].length
    return s
  }

  /** Planned position at EVA time t (minutes). */
  stateAt(t: number): PlanState {
    const legs = this.legs
    if (!legs.length) {
      return { lon: this.start[0], lat: this.start[1], phase: 'before', headingDeg: null, leg: null, station: null, dwellFrac: null, distanceWalkedM: 0 }
    }
    const first = legs[0]
    if (t <= first.t0) {
      return { lon: first.coords[0][0], lat: first.coords[0][1], phase: 'before', headingDeg: null, leg: null, station: null, dwellFrac: null, distanceWalkedM: 0 }
    }
    for (let i = 0; i < legs.length; i++) {
      const L = legs[i]
      if (t >= L.t0 && t <= L.t1) {
        let k = 1
        let u = 0
        let target: number
        if (L.times) {
          // per-vertex EVA times (WS2): find the vertex interval holding t
          while (k < L.times.length - 1 && L.times[k] < t) k++
          const t0 = L.times[k - 1] ?? L.t0
          const t1 = L.times[k] ?? t0
          u = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1
          target = (L.cum[k - 1] ?? 0) + u * ((L.cum[k] ?? 0) - (L.cum[k - 1] ?? 0))
        } else {
          const f = L.t1 > L.t0 ? (t - L.t0) / (L.t1 - L.t0) : 1
          target = f * L.length
          while (k < L.cum.length - 1 && L.cum[k] < target) k++
          const segLen = (L.cum[k] ?? 0) - (L.cum[k - 1] ?? 0)
          u = segLen > 0 ? (target - L.cum[k - 1]) / segLen : 0
        }
        const a = L.coords[k - 1] ?? L.coords[0]
        const b = L.coords[k] ?? a
        const lon = a[0] + (b[0] - a[0]) * u
        const lat = a[1] + (b[1] - a[1]) * u
        const dx = (b[0] - a[0]) * this.metric.mPerDegLon
        const dy = (b[1] - a[1]) * this.metric.mPerDegLat
        const heading = dx || dy ? ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 : null
        return { lon, lat, phase: 'walk', headingDeg: heading, leg: i, station: null, dwellFrac: null, distanceWalkedM: this.walkedBefore(i) + target }
      }
      const next = legs[i + 1]
      if (next && t > L.t1 && t < next.t0) {
        const d = this.dwells.find((x) => x.t0 <= t && t <= x.t1)
        const end = L.coords[L.coords.length - 1]
        return {
          lon: end[0], lat: end[1], phase: 'dwell', headingDeg: this.arrivalHeading(L), leg: null,
          station: d?.station ?? L.to, dwellFrac: d && d.t1 > d.t0 ? (t - d.t0) / (d.t1 - d.t0) : null,
          distanceWalkedM: this.walkedBefore(i + 1),
        }
      }
    }
    const last = legs[legs.length - 1]
    const end = last.coords[last.coords.length - 1]
    return { lon: end[0], lat: end[1], phase: 'after', headingDeg: null, leg: null, station: null, dwellFrac: null, distanceWalkedM: this.walkedBefore(legs.length) }
  }

  /** Heading of the last non-degenerate segment of a leg (the way the crew faced on arrival). */
  private arrivalHeading(L: Leg): number | null {
    for (let k = L.coords.length - 1; k > 0; k--) {
      const dx = (L.coords[k][0] - L.coords[k - 1][0]) * this.metric.mPerDegLon
      const dy = (L.coords[k][1] - L.coords[k - 1][1]) * this.metric.mPerDegLat
      if (dx || dy) return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
    }
    return null
  }

  /** Headroom H(t) = margin_min + t_home_min from the timeline, interpolated; null if absent. */
  headroomAt(t: number): number | null {
    return interpSeries(this.headroom, t)
  }

  /** O2 left (L) from the timeline, interpolated; null if the timeline has none. */
  o2LeftAt(t: number): number | null {
    return interpSeries(this.o2Left, t)
  }

  /**
   * Binding term of the margin (O2 / daylight / dose / EVA duration, D28) from the timeline row in force at t (the
   * last row at or before t; held, never interpolated). undefined = the timeline has no
   * margin_binding at all (optional in v1.1.0; the M0 dummy has none); null = unknown at that row.
   */
  bindingAt(t: number): Binding | undefined {
    if (!this.events.some((e) => e.margin_binding !== undefined)) return undefined
    let b: Binding = null
    for (const e of this.events) {
      if (e.t_min > t + 1e-9) break
      b = e.margin_binding ?? null
    }
    return b
  }

  /**
   * WS2's turn_back row for a station (D28): the latest time to leave it and the binding term
   * (incl. "EVA duration", contract v1.1.3); null = no row for that station.
   */
  turnBackAt(station: string): { station: string; t_min: number; binding: Binding } | null {
    const e = this.turnBacks.find((x) => x.station === station)
    return e ? { station, t_min: e.t_min, binding: e.margin_binding ?? null } : null
  }

  /** Next planned station arrival strictly after t. */
  nextArrival(t: number): { station: string; t_min: number } | null {
    const ev = this.events.find((e) => e.event === 'arrive' && e.station && e.t_min > t)
    return ev ? { station: ev.station as string, t_min: ev.t_min } : null
  }
}

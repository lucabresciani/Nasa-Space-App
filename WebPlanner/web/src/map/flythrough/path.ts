// WS16 task 10 (M10): the flythrough camera path (DESIGN U6 item 2, config/design.yaml camera.flythrough).
// Pure: no map, no DOM. The route (WS7 Plan legs joined, map/route.ts routeLine) is resampled every
// sample_m metres along its own length, and a centripetal Catmull-Rom spline (alpha 0.5, Barry-Goldman
// form) runs through those samples in local metres. Parameter s = metres along the route, so the clock
// maps straight onto it through Plan.stateAt(t).distanceWalkedM (the timeline scrubs the camera).
//
// The camera (followPose): the look-at point is lookahead_m ahead of the crew on the smoothed route;
// the camera sits behind_m behind and above_m above the look-at point (above_m is true metres before
// exaggeration; the map conversion scales it, camera.ts). Expressed as (target, alt, bearing, pitch),
// the same shape as a storyboard camera keyframe, so the director treats both alike.
import type { LonLat } from '../../hud/types'

export interface Metric {
  mPerDegLon: number
  mPerDegLat: number
}

export interface RouteLike {
  coords: LonLat[]
  /** cumulative metres along the route at each vertex (same metric) */
  cum: number[]
  length: number
}

/** A storyboard-style camera: look at `target` from `altM` above it, `pitch` deg from straight down. */
export interface CameraPose {
  target: LonLat
  /** camera height above the target, true metres before exaggeration */
  altM: number
  /** deg clockwise from north */
  bearing: number
  /** deg from straight down */
  pitch: number
}

export interface FollowConfig {
  behindM: number
  aboveM: number
  lookaheadM: number
}

type XY = [number, number]

/** Point at `d` metres along a polyline with cumulative metres (clamped). */
export function pointAlong(line: RouteLike, d: number): LonLat {
  const { coords, cum } = line
  if (coords.length === 0) throw new Error('empty route')
  if (coords.length === 1 || d <= 0) return coords[0]
  if (d >= line.length) return coords[coords.length - 1]
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= d) lo = mid
    else hi = mid
  }
  const seg = cum[hi] - cum[lo]
  const f = seg > 0 ? (d - cum[lo]) / seg : 0
  const a = coords[lo]
  const b = coords[hi]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
}

/** Samples every `stepM` metres along the route, plus the exact end point. */
export function resample(line: RouteLike, stepM: number): { pts: LonLat[]; s: number[] } {
  if (!(stepM > 0)) throw new Error('sample step must be > 0')
  const pts: LonLat[] = []
  const s: number[] = []
  const n = Math.floor(line.length / stepM)
  for (let k = 0; k <= n; k++) {
    s.push(k * stepM)
    pts.push(pointAlong(line, k * stepM))
  }
  if (line.length - s[s.length - 1] > 1e-6) {
    s.push(line.length)
    pts.push(pointAlong(line, line.length))
  }
  return { pts, s }
}

const EPS = 1e-6

/** Centripetal Catmull-Rom (alpha 0.5) between p1 and p2 at u in [0, 1] (Barry-Goldman). */
export function catmullRom(p0: XY, p1: XY, p2: XY, p3: XY, u: number): XY {
  const knot = (a: XY, b: XY): number => Math.max(EPS, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])))
  const t0 = 0
  const t1 = t0 + knot(p0, p1)
  const t2 = t1 + knot(p1, p2)
  const t3 = t2 + knot(p2, p3)
  const t = t1 + (t2 - t1) * u
  const lerp = (a: XY, b: XY, ta: number, tb: number): XY => {
    const w = (t - ta) / (tb - ta)
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]
  }
  const a1 = lerp(p0, p1, t0, t1)
  const a2 = lerp(p1, p2, t1, t2)
  const a3 = lerp(p2, p3, t2, t3)
  const b1 = lerp(a1, a2, t0, t2)
  const b2 = lerp(a2, a3, t1, t3)
  return lerp(b1, b2, t1, t2)
}

/** The smoothed route: position at s metres along it (lon/lat), through the 20 m samples. */
export class SmoothPath {
  readonly length: number
  readonly samples: { pts: LonLat[]; s: number[] }
  private readonly xy: XY[]
  private readonly origin: LonLat
  private readonly metric: Metric

  constructor(line: RouteLike, metric: Metric, stepM: number) {
    if (line.coords.length === 0) throw new Error('empty route')
    this.metric = metric
    this.length = line.length
    this.samples = resample(line, stepM)
    this.origin = this.samples.pts[0]
    this.xy = this.samples.pts.map((p) => this.toXY(p))
  }

  toXY(p: LonLat): XY {
    return [(p[0] - this.origin[0]) * this.metric.mPerDegLon, (p[1] - this.origin[1]) * this.metric.mPerDegLat]
  }

  toLonLat(q: XY): LonLat {
    return [this.origin[0] + q[0] / this.metric.mPerDegLon, this.origin[1] + q[1] / this.metric.mPerDegLat]
  }

  /** Local metres at s (clamped to the route). */
  xyAt(s: number): XY {
    const { s: ss } = this.samples
    const P = this.xy
    const n = P.length
    if (n === 1 || s <= 0) return P[0]
    if (s >= this.length) return P[n - 1]
    let k = 0
    let hi = n - 1
    while (hi - k > 1) {
      const mid = (k + hi) >> 1
      if (ss[mid] <= s) k = mid
      else hi = mid
    }
    const seg = ss[k + 1] - ss[k]
    const u = seg > 0 ? (s - ss[k]) / seg : 0
    // end tangents: reflect the neighbour so the spline starts and ends on the route
    const p1 = P[k]
    const p2 = P[k + 1]
    const p0 = k > 0 ? P[k - 1] : ([2 * p1[0] - p2[0], 2 * p1[1] - p2[1]] as XY)
    const p3 = k + 2 < n ? P[k + 2] : ([2 * p2[0] - p1[0], 2 * p2[1] - p1[1]] as XY)
    return catmullRom(p0, p1, p2, p3, u)
  }

  at(s: number): LonLat {
    return this.toLonLat(this.xyAt(s))
  }
}

const deg = (r: number): number => (r * 180) / Math.PI

/** Bearing (deg clockwise from north, 0..360) of the vector (dx east, dy north). */
export function bearingOf(dx: number, dy: number): number {
  return (deg(Math.atan2(dx, dy)) + 360) % 360
}

/**
 * Follow camera at s metres along the route: look at the point `lookaheadM` ahead, from `behindM`
 * behind it (along the crew → look-at direction) and `aboveM` above it. Near the end the direction
 * comes from the stretch just walked; on a degenerate route it faces north.
 */
export function followPose(path: SmoothPath, s: number, cfg: FollowConfig): CameraPose {
  const sc = Math.min(Math.max(0, s), path.length)
  const P = path.xyAt(sc)
  const L = path.xyAt(sc + cfg.lookaheadM)
  let dx = L[0] - P[0]
  let dy = L[1] - P[1]
  if (Math.hypot(dx, dy) < 1) {
    const B = path.xyAt(sc - cfg.lookaheadM)
    dx = P[0] - B[0]
    dy = P[1] - B[1]
  }
  const bearing = Math.hypot(dx, dy) < 1 ? 0 : bearingOf(dx, dy)
  return { target: path.toLonLat(L), altM: cfg.aboveM, bearing, pitch: deg(Math.atan2(cfg.behindM, cfg.aboveM)) }
}

/**
 * Where the camera sits for a pose: `altM · tan(pitch)` metres behind the target along the bearing
 * (true metres), `altM` above it. The map conversion scales heights (camera.ts).
 */
export function cameraOffset(pose: CameraPose, metric: Metric): { cam: LonLat; horizM: number } {
  const p = (Math.min(85, Math.max(0, pose.pitch)) * Math.PI) / 180
  const h = pose.altM * Math.tan(p)
  const b = (pose.bearing * Math.PI) / 180
  const dx = -h * Math.sin(b)
  const dy = -h * Math.cos(b)
  return { cam: [pose.target[0] + dx / metric.mPerDegLon, pose.target[1] + dy / metric.mPerDegLat], horizM: h }
}

/** Shortest signed difference b - a in degrees (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = (((b - a) % 360) + 360) % 360
  if (d > 180) d -= 360
  return d
}

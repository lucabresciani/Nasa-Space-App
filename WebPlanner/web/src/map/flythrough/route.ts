// WS16 task 10 (M10): the flight path of the plan on show: WS7's Plan (route + timeline of the
// published scenario) -> routeLine (M5) -> SmoothPath. The clock maps to metres along the route by
// Plan.stateAt(t).distanceWalkedM, so the flythrough follows the timeline exactly (dwells hold still).
import { data } from '../../data/loader'
import { Plan } from '../../hud/plan'
import type { TimelineEvent } from '../../hud/types'
import { resolvePlanScenario } from '../../state'
import { FLYTHROUGH, FOLLOW_TABLE_STEP_MIN, FOLLOW_TURN_DEG_PER_MIN } from '../../story/config'
import { routeLine } from '../route'
import { angleDiff, followPose, SmoothPath, type CameraPose, type Metric } from './path'

export interface FlightPath {
  scenario: string
  plan: Plan
  path: SmoothPath
  /** follow-camera pose at an EVA minute */
  poseAt(tMin: number): CameraPose
}

/** Metres per degree of the field grid (fields/index.json), the metric the HUD and the route use. */
export function gridMetric(ix: { bounds: number[]; width: number; height: number; res_m: number }): Metric {
  const [w, s, e, n] = ix.bounds
  return { mPerDegLon: (ix.width * ix.res_m) / (e - w), mPerDegLat: (ix.height * ix.res_m) / (n - s) }
}

/**
 * Follow-camera bearing over EVA time: the crew -> look-ahead direction, turned at most
 * `degPerMin` per EVA minute (a forward pass over a fixed table, so it is a pure function of t and
 * scrubbing anywhere gives the same picture as playing there).
 */
export function bearingTable(raw: (t: number) => number, tEnd: number, stepMin: number, degPerMin: number): (t: number) => number {
  const n = Math.max(1, Math.ceil(tEnd / stepMin))
  const tab = new Float64Array(n + 1)
  tab[0] = raw(0)
  const maxStep = degPerMin * stepMin
  for (let i = 1; i <= n; i++) {
    const d = angleDiff(tab[i - 1], raw(Math.min(tEnd, i * stepMin)))
    tab[i] = (((tab[i - 1] + Math.max(-maxStep, Math.min(maxStep, d))) % 360) + 360) % 360
  }
  return (t) => {
    const x = Math.min(n, Math.max(0, t / stepMin))
    const i = Math.floor(x)
    if (i >= n) return tab[n]
    const f = x - i
    return (((tab[i] + angleDiff(tab[i], tab[i + 1]) * f) % 360) + 360) % 360
  }
}

export function flightPath(plan: Plan, metric: Metric, scenario: string): FlightPath {
  const path = new SmoothPath(routeLine(plan), metric, FLYTHROUGH.sampleM)
  const cfg = { behindM: FLYTHROUGH.behindM, aboveM: FLYTHROUGH.aboveM, lookaheadM: FLYTHROUGH.lookaheadM }
  const raw = (t: number): CameraPose => followPose(path, plan.stateAt(t).distanceWalkedM, cfg)
  // run the table on past the walk's end until any turn has finished (at most 180 deg)
  const bearing = bearingTable((t) => raw(t).bearing, plan.tEnd + 180 / FOLLOW_TURN_DEG_PER_MIN, FOLLOW_TABLE_STEP_MIN, FOLLOW_TURN_DEG_PER_MIN)
  return { scenario, plan, path, poseAt: (t) => ({ ...raw(t), bearing: bearing(t) }) }
}

/** The plan scenario's flight path; null when it has no route or timeline (only published ones do). */
export async function loadFlightPath(): Promise<FlightPath | null> {
  const L = data()
  const idx = await L.scenarios()
  const sc = resolvePlanScenario(idx)
  const [route, timeline, fix] = await Promise.all([L.optional(() => L.route(sc.id)), L.optional(() => L.timeline(sc.id)), L.optional(() => L.fieldsIndex())])
  if (!route || !timeline || !fix || !route.features.length) return null
  const metric = gridMetric(fix as unknown as { bounds: number[]; width: number; height: number; res_m: number })
  const plan = new Plan(route as never, timeline as unknown as TimelineEvent[], metric)
  return flightPath(plan, metric, sc.id)
}

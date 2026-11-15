// Mission Planer EVA clock and route margin: the engine's four-term margin (pipeline/engine/
// margin.py, traverse.py; SPEC F4, F9; D28, D39) on the planner's own route.
//
//   m(t)    = min( O2 term , t_dark - t - T_home , tau_dose(t) - T_home , EVA_budget - t - T_home )
//   O2 term = (O2_capacity - O2_used - O2_home - O2_tasks_left - O2_reserve) / effort_rate
//
// Binding term names and their tie order are the engine's: "O2", "daylight", "dose",
// "EVA duration" (D28). A term whose input is missing is left out, as in margin.py.
//
// The track (buildTrack) is the planner's walk on the EVA clock (minutes since EVA start, 09:00
// LMST, D31): pad -> waypoint legs (one sample per route cell) -> a stop at each waypoint (planned
// stop minutes at the station task rate; the O2 still to do there counts as O2_tasks_left, as
// in traverse.py) -> the walk home from the last waypoint. The walk home is not routed in the
// browser: it is WS2's fastest way home, so T_home falls 1 min per minute and O2_home is taken
// as linear in time from O2_home(last waypoint) to 0 (an estimate; O2 is a cell sum in WS2).
//
// Dose (D39, conditions.yaml storm_replay): the 20 May 2024 RAD storm series (WS4 rad.json) is
// shifted onto the EVA clock so its tripwire fires at t* = the EVA minute of the route's largest
// T_home (first sample on a tie); tau_dose(t) = 60 D_allow / Ddot(t), Ddot linear between sample
// midpoints, clamped outside the series (numpy.interp). Because t* depends on the route, the
// storm moves with the plan: it always arrives when the way home is longest.
//
// Where the margin is evaluated: at every track sample (the engine checks its route vertices),
// plus, inside stops and on the walk home, at every storm-series knot and at the exact interior
// minimum of the dose term on the walk home. Between knots tau_dose is monotone, so inside a stop
// (T_home constant) the dose term is lowest at a knot or an end; on the walk home tau_dose - T_home
// is convex between knots and its minimum is found in closed form. No sampling step is needed.
import conditionsRaw from '../../../config/conditions.yaml'
import variantsRaw from '../../../config/variants.yaml'
import { cfg } from '../config'
import type { Rad } from '../data/types'
import { BUDGET_CONSTANTS, stopMinutes } from './budget'
import type { Leg } from './router'

export type Term = 'O2' | 'daylight' | 'dose' | 'EVA duration'
/** Engine order (margin.margin builds its dict in this order; min() keeps the first on a tie). */
export const TERMS: readonly Term[] = ['O2', 'daylight', 'dose', 'EVA duration']

// ------------------------------------------------------------------ config checks (as margin.py)

function check(text: string, expected: string, key: string): void {
  if (text.replace(/\s/g, '') !== expected.replace(/\s/g, '')) throw new Error(`${key} changed: ${text}; update mission/margin.ts`)
}

check(cfg<string>(variantsRaw, 'route.eva_term'), 'crew.eva_h * 60 - t - T_home', 'variants.yaml route.eva_term')
check(cfg<string>(variantsRaw, 'route.dose_timing'), 'conditions.storm_replay', 'variants.yaml route.dose_timing')

export interface StormReplay {
  tripwire_at: string
  anchor_event?: string
  tie_break?: string
}

/** conditions.yaml storm_replay (D39), the one shared storm-timing key. */
export const STORM_REPLAY: StormReplay = cfg<StormReplay>(conditionsRaw, 'storm_replay')

// ------------------------------------------------------------------ dose timing (D39)

export interface DoseTiming {
  /** EVA minute where the tripwire fires (the route's largest T_home) */
  tStarMin: number
  /** storm-series sample midpoints on the EVA clock, minutes (valid samples only, ascending) */
  evaMin: number[]
  /** dose rate at those samples, mGy/h */
  rateMgyH: number[]
  dAllowMgy: number
  source: string
}

/** numpy.interp: linear between knots, clamped to the end values outside them. */
export function interp(x: number, xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  const n = xs.length
  if (n === 0) throw new Error('interp: no knots')
  if (x <= xs[0]) return ys[0]
  if (x >= xs[n - 1]) return ys[n - 1]
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid
    else hi = mid
  }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo])
  return ys[lo] + f * (ys[hi] - ys[lo])
}

/** tau_dose = 60 D_allow / Ddot (minutes until D_allow at a constant rate Ddot in mGy/h). */
export const tauDoseFromRate = (dAllowMgy: number, rateMgyH: number): number => (60 * dAllowMgy) / rateMgyH

/** RAD rates are uGy/day; the leash uses mGy/h. */
export const uGyDayToMgyH = (v: number): number => v / 1000 / 24

/** tau_dose(t) of a timed dose leash. */
export function tauDoseAt(dt: DoseTiming, tMin: number): number {
  return tauDoseFromRate(dt.dAllowMgy, interp(tMin, dt.evaMin, dt.rateMgyH))
}

/** margin.dose_timing_from_ws4: the storm series shifted so its tripwire fires at EVA minute t*. */
export function doseTimingFromRad(tStarMin: number, rad: Rad, sr: StormReplay = STORM_REPLAY): DoseTiming {
  if (sr.tripwire_at !== 'route_max_t_home') throw new Error(`storm_replay.tripwire_at ${sr.tripwire_at} not implemented (route_max_t_home only)`)
  if ((sr.anchor_event ?? 'tripwire') !== 'tripwire') throw new Error("storm_replay.anchor_event must be 'tripwire'")
  if ((sr.tie_break ?? 'first') !== 'first') throw new Error("storm_replay.tie_break must be 'first'")
  const st = rad.storm_2024
  if (!st.tripwire_utc) throw new Error('rad.json storm_2024.tripwire_utc missing')
  const d = rad.leash.D_allow_mGy
  if (typeof d !== 'number' || !(d > 0)) throw new Error('rad.json leash.D_allow_mGy missing')
  const trip = Date.parse(st.tripwire_utc) / 1000
  const evaMin: number[] = []
  const rateMgyH: number[] = []
  for (const [utc, v] of st.series) {
    if (v === null) continue
    evaMin.push(tStarMin + (Date.parse(utc) / 1000 - trip) / 60)
    rateMgyH.push(uGyDayToMgyH(v))
  }
  if (evaMin.length === 0) throw new Error('rad.json storm_2024.series has no valid sample')
  return { tStarMin, evaMin, rateMgyH, dAllowMgy: d, source: 'conditions.yaml storm_replay (D39) + rad.json' }
}

// ------------------------------------------------------------------ margin terms

export interface MarginInputs {
  o2CapacityL: number
  reserveL: number
  effortRateLMin: number
  stationRateLMin: number
  /** D28 EVA budget (crew.eva_h x 60); null leaves the term out */
  evaBudgetMin: number | null
  /** minutes from EVA start to darkness (WS4 clock.json eva.t_dark_min); null leaves it out */
  tDarkMin: number | null
  /** static dose leash (minutes); ignored when `dose` is set */
  tauDoseMin: number | null
  /** timed dose leash (D39 storm replay) */
  dose: DoseTiming | null
}

/** Margin inputs from config (crew.yaml via budget.ts) plus the conditions the caller has. */
export function marginInputs(o: { tDarkMin?: number | null; tauDoseMin?: number | null; dose?: DoseTiming | null; eva?: boolean } = {}): MarginInputs {
  const C = BUDGET_CONSTANTS
  return {
    o2CapacityL: C.o2CapacityL,
    reserveL: C.reserveL,
    effortRateLMin: C.effortRateLMin,
    stationRateLMin: C.stationRateLMin,
    evaBudgetMin: o.eva === false ? null : C.evaLimitMin,
    tDarkMin: o.tDarkMin ?? null,
    tauDoseMin: o.dose ? null : (o.tauDoseMin ?? null),
    dose: o.dose ?? null,
  }
}

/** Walker state at one EVA minute. */
export interface State {
  tMin: number
  o2UsedL: number
  tHomeMin: number
  o2HomeL: number
  /** station work still to do where the walker is (0 while walking) */
  tasksLeftL: number
}

export type Terms = Partial<Record<Term, number>>

/** Every margin term present in `mi`, in the engine's order (margin.margin). */
export function marginTerms(mi: MarginInputs, s: State): Terms {
  const out: Terms = {}
  out.O2 = (mi.o2CapacityL - s.o2UsedL - s.o2HomeL - s.tasksLeftL - mi.reserveL) / mi.effortRateLMin
  if (mi.tDarkMin !== null) out.daylight = mi.tDarkMin - s.tMin - s.tHomeMin
  const tau = mi.dose ? tauDoseAt(mi.dose, s.tMin) : mi.tauDoseMin
  if (tau !== null) out.dose = tau - s.tHomeMin
  if (mi.evaBudgetMin !== null) out['EVA duration'] = mi.evaBudgetMin - s.tMin - s.tHomeMin
  return out
}

/** (margin, binding term): the smallest term, the first in engine order on a tie. */
export function bindingOf(terms: Terms): { marginMin: number; binding: Term } {
  let best: Term | null = null
  for (const k of TERMS) {
    const v = terms[k]
    if (v === undefined) continue
    if (best === null || v < terms[best]!) best = k
  }
  if (best === null) throw new Error('no margin term')
  return { marginMin: terms[best]!, binding: best }
}

// ------------------------------------------------------------------ the track

/** One leg as the walker meets it: per vertex, cumulative from the leg start. */
export interface LegProfile {
  tMin: ArrayLike<number>
  o2L: ArrayLike<number>
  tHomeMin: ArrayLike<number>
  o2HomeL: ArrayLike<number>
}

/**
 * depart: t = 0 at the pad · walk: a route vertex · arrive: at waypoint `wp` (stop starts) ·
 * leave: stop over · return: back at the pad. Between a sample and the one before it every state
 * value is linear in t; `leave` closes a stop, `return` closes the walk home.
 */
export type Phase = 'depart' | 'walk' | 'arrive' | 'leave' | 'return'

export interface TrackSample extends State {
  phase: Phase
  /** waypoint index (0-based) for arrive / leave */
  wp: number | null
}

const finite = (v: number) => Number.isFinite(v)

/** A planner leg (router.ts) on the clock, with WS2's T_home / O2_home at each cell. */
export function legProfile(leg: Leg, homeAt: (cell: number) => { tHomeMin: number | null; o2HomeL: number | null }): LegProfile | null {
  const n = leg.cells.length
  const tHomeMin = new Float64Array(n)
  const o2HomeL = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const h = homeAt(leg.cells[k])
    if (h.tHomeMin === null || h.o2HomeL === null) return null
    tHomeMin[k] = h.tHomeMin
    o2HomeL[k] = h.o2HomeL
  }
  return { tMin: leg.tauS.map((s) => s / 60), o2L: leg.o2CumL, tHomeMin, o2HomeL }
}

/**
 * The EVA track: legs pad -> #1 -> #2 ..., stopsMin[i] at waypoint i, then the walk home.
 * null when a leg is missing (could not be routed) or a value along it is unknown.
 */
export function buildTrack(legs: (LegProfile | null)[], stopsMin: number[], stationRateLMin = BUDGET_CONSTANTS.stationRateLMin): TrackSample[] | null {
  const out: TrackSample[] = [{ tMin: 0, o2UsedL: 0, tHomeMin: 0, o2HomeL: 0, tasksLeftL: 0, phase: 'depart', wp: null }]
  let t = 0
  let used = 0
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    if (!leg) return null
    const n = leg.tMin.length
    if (n === 0 || leg.o2L.length !== n || leg.tHomeMin.length !== n || leg.o2HomeL.length !== n) return null
    for (let k = 0; k < n; k++) {
      if (![leg.tMin[k], leg.o2L[k], leg.tHomeMin[k], leg.o2HomeL[k]].every(finite)) return null
    }
    for (let k = 1; k < n - 1; k++) {
      out.push({ tMin: t + leg.tMin[k], o2UsedL: used + leg.o2L[k], tHomeMin: leg.tHomeMin[k], o2HomeL: leg.o2HomeL[k], tasksLeftL: 0, phase: 'walk', wp: null })
    }
    t += leg.tMin[n - 1]
    used += leg.o2L[n - 1]
    const th = leg.tHomeMin[n - 1]
    const oh = leg.o2HomeL[n - 1]
    const stop = stopMinutes(stopsMin[i])
    out.push({ tMin: t, o2UsedL: used, tHomeMin: th, o2HomeL: oh, tasksLeftL: stop * stationRateLMin, phase: 'arrive', wp: i })
    if (stop > 0) {
      t += stop
      used += stop * stationRateLMin
      out.push({ tMin: t, o2UsedL: used, tHomeMin: th, o2HomeL: oh, tasksLeftL: 0, phase: 'leave', wp: i })
    }
  }
  const last = out[out.length - 1]
  out.push({ tMin: t + last.tHomeMin, o2UsedL: used + last.o2HomeL, tHomeMin: 0, o2HomeL: 0, tasksLeftL: 0, phase: 'return', wp: null })
  return out
}

/** margin.t_star: EVA minute of the track's largest T_home (first sample on a tie). */
export function tStar(track: TrackSample[]): number {
  let j = 0
  for (let i = 1; i < track.length; i++) if (track[i].tHomeMin > track[j].tHomeMin) j = i
  return track[j].tMin
}

// ------------------------------------------------------------------ the margin profile

export interface MarginPoint extends State {
  marginMin: number
  binding: Term
  terms: Terms
  /** the track sample's phase, or 'stop' / 'home' for a point inside a stop / the walk home */
  phase: Phase | 'stop' | 'home'
  wp: number | null
}

export interface MarginProfile {
  points: MarginPoint[]
  /** lowest margin over the points (first on a tie) */
  lowest: MarginPoint
  /** lowest value of each term over the points, and when */
  lowestByTerm: Partial<Record<Term, { marginMin: number; tMin: number }>>
  /** terms in use (engine: margin_terms) */
  terms: Term[]
  /** D39 storm replay details when the dose term is timed */
  dose: null | { tStarMin: number; tauAtTStarMin: number; tauMinOnRouteMin: number; lowestDoseMarginMin: number; lowestDoseMarginAtMin: number; violation: boolean }
}

function lerpState(a: State, b: State, t: number): State {
  const f = b.tMin === a.tMin ? 0 : (t - a.tMin) / (b.tMin - a.tMin)
  const l = (x: number, y: number) => x + f * (y - x)
  return { tMin: t, o2UsedL: l(a.o2UsedL, b.o2UsedL), tHomeMin: l(a.tHomeMin, b.tHomeMin), o2HomeL: l(a.o2HomeL, b.o2HomeL), tasksLeftL: l(a.tasksLeftL, b.tasksLeftL) }
}

/** Extra times inside (a, b) where the dose term can be lowest (see the header). */
function doseCandidates(dt: DoseTiming, a: State, b: State): number[] {
  const out: number[] = []
  const { evaMin: xs, rateMgyH: ys } = dt
  for (const x of xs) if (x > a.tMin && x < b.tMin) out.push(x)
  const k = (b.tHomeMin - a.tHomeMin) / (b.tMin - a.tMin) // dT_home/dt, <= 0 on the walk home
  if (k < 0) {
    // tau(t) - T_home(t) with tau = 60 D / r, r = r0 + s (t - x0): stationary where tau' = k, i.e.
    // 60 D s / r^2 = -k  ->  r = sqrt(60 D s / -k); a minimum (convex) when s > 0.
    const lo = Math.max(a.tMin, xs[0])
    const hi = Math.min(b.tMin, xs[xs.length - 1])
    for (let i = 0; i + 1 < xs.length; i++) {
      if (xs[i + 1] <= lo || xs[i] >= hi) continue
      const s = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i])
      if (!(s > 0)) continue
      const r = Math.sqrt((60 * dt.dAllowMgy * s) / -k)
      const t = xs[i] + (r - ys[i]) / s
      if (t > Math.max(lo, xs[i]) && t < Math.min(hi, xs[i + 1])) out.push(t)
    }
  }
  return out.sort((x, y) => x - y)
}

/** The margin along a track (see the header for where it is evaluated). */
export function marginProfile(track: TrackSample[], mi: MarginInputs): MarginProfile {
  if (track.length === 0) throw new Error('empty track')
  const points: MarginPoint[] = []
  const add = (s: State, phase: MarginPoint['phase'], wp: number | null) => {
    const terms = marginTerms(mi, s)
    points.push({ ...s, ...bindingOf(terms), terms, phase, wp })
  }
  for (let i = 0; i < track.length; i++) {
    const b = track[i]
    if (i > 0 && mi.dose && (b.phase === 'leave' || b.phase === 'return')) {
      const a = track[i - 1]
      const inner: MarginPoint['phase'] = b.phase === 'leave' ? 'stop' : 'home'
      for (const t of doseCandidates(mi.dose, a, b)) add(lerpState(a, b, t), inner, b.phase === 'leave' ? b.wp : null)
    }
    add(b, b.phase, b.wp)
  }
  let lowest = points[0]
  for (const p of points) if (p.marginMin < lowest.marginMin) lowest = p
  const lowestByTerm: MarginProfile['lowestByTerm'] = {}
  const terms = TERMS.filter((k) => points[0].terms[k] !== undefined)
  for (const k of terms) {
    let best = points[0]
    for (const p of points) if (p.terms[k]! < best.terms[k]!) best = p
    lowestByTerm[k] = { marginMin: best.terms[k]!, tMin: best.tMin }
  }
  let dose: MarginProfile['dose'] = null
  if (mi.dose) {
    const low = lowestByTerm.dose!
    let tauMin = Infinity
    for (const p of points) tauMin = Math.min(tauMin, tauDoseAt(mi.dose, p.tMin))
    dose = {
      tStarMin: mi.dose.tStarMin,
      tauAtTStarMin: tauDoseAt(mi.dose, mi.dose.tStarMin),
      tauMinOnRouteMin: tauMin,
      lowestDoseMarginMin: low.marginMin,
      lowestDoseMarginAtMin: low.tMin,
      violation: low.marginMin < 0,
    }
  }
  return { points, lowest, lowestByTerm, terms, dose }
}

/**
 * Everything in one call: the track's margin with the storm replay on (D39: t* from this track)
 * or off (no dose term). Returns null when the track is unknown.
 */
export function missionMargin(track: TrackSample[] | null, cond: { tDarkMin: number | null; rad: Rad | null; storm: boolean }): MarginProfile | null {
  if (!track) return null
  const dose = cond.storm && cond.rad ? doseTimingFromRad(tStar(track), cond.rad) : null
  return marginProfile(track, marginInputs({ tDarkMin: cond.tDarkMin, dose }))
}

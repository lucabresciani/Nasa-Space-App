// WS16 task 3 (M3): margin mode of the field layer, CPU side (DESIGN U2 "Margin per pixel",
// contracts/field_shader.md §3.1). The shader (shader.ts, u_mode = 1) computes exactly this, and
// fieldAt() returns it, so the picture, the readouts and the tests share one formula.
//
// The formula is a port of WS2's margin code, not a re-derivation (pipeline/engine/physio_core.py
// `margin`, `o2_slack_l`, `o2_margin_min`, `DoseTiming`; SPEC F4 with D24, D28, D39):
//
//   m(x) = min( (O2_left - O2_home(x) - O2_station_tasks - O2_reserve) / 1.35 L/min,   "O2"
//               t_dark - t - T_home(x),                                                "daylight"
//               tau_dose(t) - T_home(x),                                               "dose"
//               EVA_budget - t - T_home(x) )                                           "EVA duration"
//
// * Terms are checked in that order; ties go to the first (Python `min(terms, key=terms.get)`).
// * A term whose input is missing is left out (WS2: "a term that is missing is left out").
// * O2_station_tasks: task O2 still to do at the station the crew is working at (0 while walking).
//   WS2 subtracts it in every timeline row (o2_tasks_left_L); without it the shader would read up to
//   18.6 min high at an arrival. It is a helper uniform (u_o2Tasks), derived from the timeline.
// * tau_dose(t): WS2's timed leash (D39). The 20 May 2024 RAD series is shifted so its tripwire fires
//   at t* (manifest route.{scenario}.dose.t_star_min = the timeline's largest T_home), Ddot linear
//   between sample midpoints, tau = 60 D_allow / Ddot. The published timeline uses it on every row,
//   so the field does too unless the mission state carries an explicit storm tau (storm switch on).
import { FIELD_LAYER } from './constants'

export type Binding = 'O2' | 'daylight' | 'dose' | 'EVA duration'
export const BINDINGS: readonly Binding[] = ['O2', 'daylight', 'dose', 'EVA duration']

/** Margin class drawn in margin mode (contracts/field_shader.md §3.1, DESIGN §3.1 colour meanings). */
export type MarginClass = 'safe' | 'caution' | 'limit'
export type FieldClass = MarginClass | 'none' | 'unknown'

/** The scalars of one moment (DESIGN §6.4 uniforms). null = term not modelled -> left out. */
export interface MarginInputs {
  t: number // EVA minute (u_t)
  o2LeftL: number // O2 left now, L (u_o2Left)
  reserveL: number // fixed O2 reserve, L (u_reserve, D24: 40.5)
  o2TasksL: number // station task O2 still to do, L (u_o2Tasks; 0 while walking)
  o2RateLMin: number // effort-cap rate, L/min (u_o2Rate, 1.35)
  tDarkMin: number | null // u_tDark
  tauDoseMin: number | null // u_tauDose at t
  tEvaMin: number | null // u_tEva (EVA budget, crew.eva_h x 60)
}

/** Shader stand-in for a term that is left out (contract: "very large", >= 1e6). */
export const VERY_LARGE = 1e9

export interface Margin {
  margin: number
  binding: Binding
}

/** WS2 `margin()` for one point: (margin_min, binding). */
export function marginAt(inp: MarginInputs, tHomeMin: number, o2HomeL: number): Margin {
  // o2_slack_l / rate (reserve_frac = 0 in the current formula)
  let margin = (inp.o2LeftL - o2HomeL - inp.o2TasksL - inp.reserveL) / inp.o2RateLMin
  let binding: Binding = 'O2'
  const take = (v: number, b: Binding): void => {
    if (v < margin) {
      margin = v
      binding = b
    }
  }
  if (inp.tDarkMin !== null) take(inp.tDarkMin - inp.t - tHomeMin, 'daylight')
  if (inp.tauDoseMin !== null) take(inp.tauDoseMin - tHomeMin, 'dose')
  if (inp.tEvaMin !== null) take(inp.tEvaMin - inp.t - tHomeMin, 'EVA duration')
  return { margin, binding }
}

/**
 * Margin colour class, the HUD's rule (hud/alarms.ts marginBand: red < 0, amber <= amber_min,
 * green above), so the field and the HUD panel never disagree at a point.
 */
export function marginClass(m: number, amberMin: number = FIELD_LAYER.amberMin): MarginClass {
  if (m < 0) return 'limit'
  if (m <= amberMin) return 'caution'
  return 'safe'
}

/** Class drawn at a point in margin mode, the shader's branch order (contract §3.1). */
export function marginFieldClass(terrainUnknown: boolean, tHome: number | null, o2Home: number | null, inp: MarginInputs, amberMin: number = FIELD_LAYER.amberMin): FieldClass {
  if (terrainUnknown) return 'unknown' // grey hatch, never a warning colour
  if (tHome === null || o2Home === null) return 'none'
  return marginClass(marginAt(inp, tHome, o2Home).margin, amberMin)
}

// ---- WS2 DoseTiming (D39) -------------------------------------------------------------------------

export interface RadStorm {
  storm_2024?: { series: [string, number | null][]; tripwire_utc: string | null }
  leash: { D_allow_mGy: number | null }
}

/** tau_dose(t) on the EVA clock, as physio_core.DoseTiming / dose_timing_from_ws4. */
export class DoseTiming {
  readonly tStarMin: number
  readonly evaMin: number[]
  readonly rateMgyH: number[]

  constructor(tStarMin: number, evaMin: number[], rateMgyH: number[]) {
    if (evaMin.length !== rateMgyH.length || evaMin.length === 0) throw new Error('DoseTiming: empty or mismatched series')
    this.tStarMin = tStarMin
    this.evaMin = evaMin
    this.rateMgyH = rateMgyH
  }

  /** rad.json storm series shifted so the tripwire fires at EVA minute t*; null samples dropped. */
  static fromRad(rad: RadStorm, tStarMin: number): DoseTiming | null {
    const st = rad.storm_2024
    const trip = st?.tripwire_utc ? Date.parse(st.tripwire_utc) : NaN
    if (!st || !Number.isFinite(trip)) return null
    const eva: number[] = []
    const rate: number[] = []
    for (const [u, v] of st.series) {
      if (v === null || v === undefined) continue
      eva.push(tStarMin + (Date.parse(u) - trip) / 60000)
      rate.push(v / 1000 / 24) // uGy/day -> mGy/h
    }
    return eva.length ? new DoseTiming(tStarMin, eva, rate) : null
  }

  /** Ddot (mGy/h) at t: numpy.interp (linear, clamped to the first/last sample). */
  rate(t: number): number {
    const x = this.evaMin
    const y = this.rateMgyH
    if (t <= x[0]) return y[0]
    const n = x.length - 1
    if (t >= x[n]) return y[n]
    let lo = 0
    let hi = n
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (x[mid] <= t) lo = mid
      else hi = mid
    }
    const f = x[hi] > x[lo] ? (t - x[lo]) / (x[hi] - x[lo]) : 0
    return y[lo] + (y[hi] - y[lo]) * f
  }

  /** tau_dose(t) = 60 D_allow / Ddot(t), min. */
  tauMin(t: number, dAllowMgy: number): number {
    return (60 * dAllowMgy) / this.rate(t)
  }
}

// ---- the flown plan at the clock minute (timeline_*.json) ---------------------------------------

export interface TimelineRow {
  t_min: number
  event: string
  station: string | null
  o2_left_L: number | null
  t_home_min: number | null
  margin_min?: number | null
  margin_binding?: Binding | null
  o2_tasks_left_L?: number | null
}

/** Annotation rows: not steps of the walk (hud/plan.ts ANNOTATION_EVENTS). */
const ANNOTATIONS = new Set(['turn_back'])

/**
 * The plan-side inputs of the margin at any clock minute, read from WS2's timeline:
 * O2 left (linear between rows, as hud/plan.ts o2LeftAt), task O2 still to do (linear inside a
 * station dwell, 0 while walking: WS2 tasks_left), and t* (largest timeline T_home, first on a tie,
 * as hud/storm.ts tripwireTargetMin and manifest route.*.dose.t_star_min).
 */
export class PlanTimeline {
  readonly rows: TimelineRow[]
  readonly tStarMin: number | null
  private readonly o2: [number, number][]
  private readonly dwells: { t0: number; t1: number; tasks0: number }[] = []

  constructor(timeline: readonly TimelineRow[]) {
    this.rows = [...timeline].filter((r) => !ANNOTATIONS.has(r.event)).sort((a, b) => a.t_min - b.t_min)
    this.o2 = this.rows.filter((r) => r.o2_left_L !== null).map((r) => [r.t_min, r.o2_left_L as number])
    let best: [number, number] | null = null
    for (const r of this.rows) if (r.t_home_min !== null && (best === null || r.t_home_min > best[1])) best = [r.t_min, r.t_home_min]
    this.tStarMin = best ? best[0] : null
    let arrive: TimelineRow | null = null
    for (const r of this.rows) {
      if (r.event === 'arrive') arrive = r
      else if (r.event === 'leave' && arrive && arrive.station === r.station) {
        this.dwells.push({ t0: arrive.t_min, t1: r.t_min, tasks0: arrive.o2_tasks_left_L ?? 0 })
        arrive = null
      }
    }
  }

  /** O2 left (L) at t; clamped to the first / last row. null = no O2 in the timeline. */
  o2LeftAt(t: number): number | null {
    const p = this.o2
    if (!p.length) return null
    if (t <= p[0][0]) return p[0][1]
    for (let i = 1; i < p.length; i++) {
      if (t <= p[i][0]) {
        const [t0, v0] = p[i - 1]
        const [t1, v1] = p[i]
        return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1
      }
    }
    return p[p.length - 1][1]
  }

  /** Task O2 (L) still to do at t: linear from the arrival value to 0 at leave, inside [arrive, leave). */
  tasksAt(t: number): number {
    for (const d of this.dwells) {
      if (d.t0 - 1e-9 <= t && t < d.t1) return d.t1 > d.t0 ? (d.tasks0 * (d.t1 - t)) / (d.t1 - d.t0) : 0
    }
    return 0
  }
}

// ---- inputs from the mission state ---------------------------------------------------------------

/** The mission-state scalars (state/mission.ts fieldUniforms), as far as the margin reads them. */
export interface MissionScalars {
  t: number
  tDark: number | undefined
  tauDose: number | undefined
  tEva: number | undefined
  o2Left: number | undefined
  reserve: number | undefined
}

export interface PlanInputs {
  timeline: PlanTimeline
  dose: DoseTiming | null
  /** dose allowance (mGy): mission.budgets.doseAllowMgy (the D9 slider) */
  dAllowMgy: number
}

/**
 * Resolve the margin inputs at the clock minute. Mission-state values win where they are set; the
 * flown plan's timeline fills what the store does not carry (task O2, the planned D39 dose leash).
 * Returns null when no O2 figure is known (the margin is then unknown, never guessed).
 */
export function resolveMarginInputs(u: MissionScalars, plan: PlanInputs | null, o2RateLMin: number = FIELD_LAYER.o2RateLMin): MarginInputs | null {
  const t = u.t
  const o2Left = u.o2Left ?? plan?.timeline.o2LeftAt(t) ?? null
  if (o2Left === null || u.reserve === undefined) return null
  const planTau = plan?.dose ? plan.dose.tauMin(t, plan.dAllowMgy) : null
  return {
    t,
    o2LeftL: o2Left,
    reserveL: u.reserve,
    o2TasksL: plan ? plan.timeline.tasksAt(t) : 0,
    o2RateLMin,
    tDarkMin: u.tDark ?? null,
    tauDoseMin: u.tauDose ?? planTau,
    tEvaMin: u.tEva ?? null,
  }
}

/** Shader uniform values: a left-out term becomes VERY_LARGE (never binds). */
export function shaderScalars(inp: MarginInputs): { t: number; o2Left: number; reserve: number; o2Tasks: number; o2Rate: number; tDark: number; tauDose: number; tEva: number } {
  return {
    t: inp.t,
    o2Left: inp.o2LeftL,
    reserve: inp.reserveL,
    o2Tasks: inp.o2TasksL,
    o2Rate: inp.o2RateLMin,
    tDark: inp.tDarkMin ?? VERY_LARGE,
    tauDose: inp.tauDoseMin ?? VERY_LARGE,
    tEva: inp.tEvaMin ?? VERY_LARGE,
  }
}

/** Short label of a binding term, for the edge label and readouts. */
export const BINDING_LABEL: Record<Binding, string> = { O2: 'O₂', daylight: 'Daylight', dose: 'Dose', 'EVA duration': 'EVA length' }

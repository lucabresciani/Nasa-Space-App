// Mission Planer time and O2 budget, with the engine's terms (pipeline/engine/margin.py):
//   O2 capacity  = primary_design_eva_h * primary_design_rate_btu_h * j_per_btu / o2_energy_j_per_ml / 1000
//                  (crew.yaml o2_budget.formula, margin_uses = primary_L; computed, not the rounded 482)
//   effort rate  = effort_cap_frac * vo2max_ml_kg_min * body_mass_kg / 1000          (L/min)
//   reserve      = reserve_min_at_effort_cap * effort rate                            (D24, L)
//   station rate = station_task_rate_btu_h * j_per_btu / 60 / o2_energy_j_per_ml / 1000   (L/min, D29;
//                  margin.station_task_rate_l_min: 0.8373)
//   O2 used      = leg O2 + planned stop minutes * station rate   (time at a waypoint is station work)
//   O2 margin    = (O2 left - O2 home - reserve) / effort rate      (crew.yaml o2_margin.formula; all stop
//                  O2 is in O2 used, so O2_station_tasks still to do is 0)
//   EVA          = walk out (legs) + stops + T_home;  time margin = eva_h * 60 - EVA
// Legs come from the browser router (estimates); T_home and O2 home from WS2's fields at the last waypoint.
import crewRaw from '../../../config/crew.yaml'
import { cfg, effortRateLMin } from '../config'

function n(path: string): number {
  const v = cfg<unknown>(crewRaw, path)
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`config/crew.yaml: ${path} is not a number`)
  return v
}

function o2Capacity(): number {
  const formula = cfg<string>(crewRaw, 'o2_budget.formula').split('#', 1)[0].replace(/\s/g, '')
  if (formula !== 'O2_L=hours*rate_btu_h*j_per_btu/o2_energy_j_per_ml/1000') throw new Error(`o2_budget.formula changed: ${formula}`)
  if (cfg<string>(crewRaw, 'o2_budget.margin_uses') !== 'primary_L') throw new Error('o2_budget.margin_uses is not primary_L')
  return (n('o2_budget.primary_design_eva_h') * n('o2_budget.primary_design_rate_btu_h') * n('o2_budget.j_per_btu')) / n('o2_energy_j_per_ml') / 1000
}

function stationRate(): number {
  const formula = cfg<string>(crewRaw, 'o2_margin.station_task_rate_formula').replace(/\s/g, '')
  if (formula !== 'station_task_rate_btu_h*o2_budget.j_per_btu/60/o2_energy_j_per_ml/1000') throw new Error(`station_task_rate_formula changed: ${formula}`)
  return (n('o2_margin.station_task_rate_btu_h') * n('o2_budget.j_per_btu')) / 60 / n('o2_energy_j_per_ml') / 1000
}

const effortRate = effortRateLMin({ effortCapFrac: n('effort_cap_frac'), vo2max: n('vo2max_ml_kg_min'), bodyMassKg: n('body_mass_kg') })

export const BUDGET_CONSTANTS = {
  o2CapacityL: o2Capacity(),
  effortRateLMin: effortRate,
  stationRateLMin: stationRate(),
  reserveL: n('o2_margin.reserve_min_at_effort_cap') * effortRate,
  evaLimitMin: n('eva_h') * 60,
} as const

export interface LegCost {
  timeMin: number
  o2L: number
}

export interface MissionBudget {
  /** false when a leg could not be routed: every downstream number is null */
  legsKnown: boolean
  walkMin: number | null
  /** planned time at the waypoints (always known) */
  stopMin: number
  /** O2 for that time at the station task rate */
  o2StopsL: number
  tHomeMin: number | null
  evaMin: number | null
  evaLimitMin: number
  timeMarginMin: number | null
  o2CapacityL: number
  o2UsedL: number | null
  o2LeftL: number | null
  o2HomeL: number | null
  reserveL: number
  /** O2 still needed: way home + reserve */
  o2NeedL: number | null
  o2MarginL: number | null
  /** margin in minutes at the effort cap (crew.yaml o2_margin.label) */
  o2MarginMin: number | null
}

/** Planned minutes at a waypoint; anything not a positive finite number counts as 0. */
export const stopMinutes = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export function missionBudget(legs: (LegCost | null)[], home: { tHomeMin: number | null; o2HomeL: number | null }, stops: number[] = []): MissionBudget {
  const C = BUDGET_CONSTANTS
  const legsKnown = legs.every((l) => l !== null)
  const stopMin = stops.reduce((s, v) => s + stopMinutes(v), 0)
  const o2StopsL = stopMin * C.stationRateLMin
  const walkMin = legsKnown ? legs.reduce((s, l) => s + l!.timeMin, 0) : null
  const o2UsedL = legsKnown ? legs.reduce((s, l) => s + l!.o2L, 0) + o2StopsL : null
  const o2LeftL = o2UsedL === null ? null : C.o2CapacityL - o2UsedL
  const tHomeMin = legsKnown ? home.tHomeMin : null
  const o2HomeL = legsKnown ? home.o2HomeL : null
  const evaMin = walkMin !== null && tHomeMin !== null ? walkMin + stopMin + tHomeMin : null
  const o2NeedL = o2HomeL !== null ? o2HomeL + C.reserveL : null
  const o2MarginL = o2LeftL !== null && o2NeedL !== null ? o2LeftL - o2NeedL : null
  return {
    legsKnown,
    walkMin,
    stopMin,
    o2StopsL,
    tHomeMin,
    evaMin,
    evaLimitMin: C.evaLimitMin,
    timeMarginMin: evaMin === null ? null : C.evaLimitMin - evaMin,
    o2CapacityL: C.o2CapacityL,
    o2UsedL,
    o2LeftL,
    o2HomeL,
    reserveL: C.reserveL,
    o2NeedL,
    o2MarginL,
    o2MarginMin: o2MarginL === null ? null : o2MarginL / C.effortRateLMin,
  }
}

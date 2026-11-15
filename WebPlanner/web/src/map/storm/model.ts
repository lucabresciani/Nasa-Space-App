// WS16 task 12 (M12): storm mode, pure model (DESIGN §2.2 U9, U5 storm window; D35, D36, D39).
//
// One shared storm-timing key (D39): the replayed 20 May 2024 storm is placed on the EVA clock by the
// HUD's own function (hud/storm.ts stormReplay: the tripwire fires at t* = the minute of the route's
// largest T_home, first on a tie, timeline turn_back annotations excluded). Nothing here re-derives
// a storm number: the tripwire, its ± label, the leash (rad.json leash.tau_min_at_peak) and the dose
// budget left after the tripwire (hud/storm.ts stormState) are the HUD's values, so the map, the
// timeline overlay, the banner and the HUD panel always agree. Every placement is "hypothetical
// timing" (D39): the panel shows that note whenever a storm visual is on (stormVisuals()).
//
//   ring leash L(t)   = tau_peak before the tripwire (the leash that will apply), then the dose
//                       budget left max(0, tau_peak - (t - t*)): the dose ring tightens with the clock
//   field dose term   = the dose budget left after the tripwire (mission.conditions.tauDoseMin with
//                       the storm on: M3's storm override); before the tripwire the plan's D39 tau(t)
//   thread red        = HUD alarm 2: tripwire fired and T_home >= dose budget left (hud/alarms.ts)
//   dose-rate curve   = rad.json storm_2024.series on the EVA clock (null samples are gaps)
import { evaluateAlarm } from '../../hud/alarms'
import { evaMinOf, radiationInput, stormReplay, stormState, type StormReplay, type StormState } from '../../hud/storm'
import type { Rad } from '../../hud/types'

/** rad.json as storm mode reads it (subset; contracts/rad.schema.json). */
export interface StormRad extends Rad {
  storm_2024?: Rad['storm_2024'] & {
    series: [string, number | null][]
    end_utc?: string | null
    peak_uGy_day?: number | null
    tripwire_threshold_uGy_day?: number | null
  }
}

/** timeline_{scenario}.json rows, as far as the placement needs them. */
export interface StormTimelineRow {
  t_min: number
  event: string
  t_home_min?: number | null
}

/** Annotation rows: not steps of the walk (hud/plan.ts ANNOTATION_EVENTS, timeline/model.ts). */
const ANNOTATION = 'turn_back'

/** Manifest keys of every storm number shown (DESIGN §3.6: a chip on every number). */
export const STORM_KEYS = {
  file: 'conditions/rad.json',
  leash: 'rad.leash.tau_min_at_peak',
  tripwireUtc: 'rad.storm_2024.tripwire_utc',
  halfwidth: 'rad.storm_2024.tripwire_halfwidth_label',
  peak: 'rad.storm_2024.peak_uGy_day',
  threshold: 'rad.storm_2024.tripwire_threshold_uGy_day',
  baseline: 'rad.baseline_uGy_day',
  /** t* on the EVA clock (WS2 publishes the same minute for the plan's route) */
  tStar: (scenario: string): string => `route.${scenario}.dose.t_star_min`,
  tStarFile: (scenario: string): string => `timeline_${scenario}.json`,
} as const

export interface StormModel {
  scenario: string
  /** the HUD's placement (hud/storm.ts), the one shared storm-timing key */
  replay: StormReplay
  /** EVA minute the tripwire fires (t*) */
  tFire: number
  /** rad.json leash.tau_min_at_peak (min) */
  leashMin: number
  /** rad.json storm_2024.tripwire_halfwidth_label ("± 9 min", D35); null when absent */
  halfwidthLabel: string | null
  /** EVA minutes of onset, peak and the storm-window end (D36); null when not in rad.json */
  onset: number | null
  peak: number | null
  end: number | null
  /** dose-rate series on the EVA clock: [EVA min, uGy/day | null (gap)] */
  curve: [number, number | null][]
  peakUGyDay: number | null
  thresholdUGyDay: number | null
  baselineUGyDay: number | null
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const v = Date.parse(iso)
  return Number.isFinite(v) ? v : null
}

/**
 * Storm placement for one plan (rad.json + its timeline). null = unknown (no tripwire, no leash or
 * no route T_home): storm mode then stays off and says so (copy tooltips.stormUnavailable).
 */
export function buildStormModel(rad: StormRad | null, scenario: string, timeline: readonly StormTimelineRow[]): StormModel | null {
  const walk = timeline.filter((r) => r.event !== ANNOTATION)
  const replay = stormReplay(
    rad,
    walk.map((r) => r.t_min),
    walk.map((r) => r.t_home_min ?? null),
  )
  const s = rad?.storm_2024
  const trip = ms(s?.tripwire_utc)
  if (!replay || !s || trip === null) return null
  const at = (iso: string | null | undefined): number | null => {
    const v = ms(iso)
    return v === null ? null : evaMinOf(v, trip, replay.tripwireEvaMin)
  }
  const curve: [number, number | null][] = (s.series ?? []).map(([u, v]) => [evaMinOf(Date.parse(u), trip, replay.tripwireEvaMin), v ?? null])
  return {
    scenario,
    replay,
    tFire: replay.tripwireEvaMin,
    leashMin: replay.tauDoseMin,
    halfwidthLabel: replay.halfwidthLabel,
    onset: replay.onsetEvaMin,
    peak: replay.peakEvaMin,
    end: at(s.end_utc),
    curve,
    peakUGyDay: s.peak_uGy_day ?? null,
    thresholdUGyDay: s.tripwire_threshold_uGy_day ?? null,
    baselineUGyDay: rad?.baseline_uGy_day ?? null,
  }
}

export interface StormView {
  /** the HUD's storm state at t (hud/storm.ts stormState) */
  hud: StormState
  fired: boolean
  /** dose budget left (min) after the tripwire (may go below 0, as the HUD); null before it */
  doseLeftMin: number | null
  /** leash of the dose ring: tau_peak before the tripwire, max(0, dose budget left) after */
  ringLeashMin: number
  /** the alarm banner shows (from the tripwire on) */
  banner: boolean
  /** mission.conditions.tauDoseMin with the storm on (M3 override); undefined = the plan's D39 tau(t) */
  tauOverride: number | undefined
}

export function stormView(m: StormModel, t: number): StormView {
  const hud = stormState(m.replay, t)
  const left = hud.doseLeftMin
  return {
    hud,
    fired: hud.fired,
    doseLeftMin: left,
    ringLeashMin: hud.fired && left !== null ? Math.max(0, left) : m.leashMin,
    banner: hud.fired,
    tauOverride: hud.fired && left !== null ? left : undefined,
  }
}

/** Thread turns red (DESIGN U9) exactly when the HUD's alarm 2 would fire for this T_home. */
export function threadRed(v: StormView, tHomeMin: number | null): boolean {
  const r = radiationInput(v.hud)
  const a = evaluateAlarm({ marginMin: null, tripwireFired: r.tripwireFired, tHomeMin, tauDoseMin: r.tauDoseMin, circleCrossesHomeline: false, outsidePartner: null }, 0)
  return a?.rule === 2
}

/**
 * The storm visuals on screen and the rule that binds them: no storm visual without the timing note.
 * Every renderer asks this one function; `note` is true whenever anything else is.
 */
export interface StormVisuals {
  note: boolean
  ring: boolean
  curve: boolean
  banner: boolean
  thread: boolean
}

export function stormVisuals(on: boolean, m: StormModel | null, v: StormView | null): StormVisuals {
  const any = on && m !== null && v !== null
  return { note: any, ring: any, curve: any, banner: any && v!.banner, thread: any && v!.fired }
}

/**
 * Dose-rate curve for the timeline overlay, clipped to [0, tMax]: runs of [x, y] in 0..1 (x = t / tMax,
 * y = log10 of the rate between floor and the peak; the peak is the top). Null samples split runs
 * (never bridged). Log scale: the 2024 peak is 55× the baseline; on a linear axis the baseline and
 * the tripwire threshold would sit on the floor.
 */
export function curveRuns(m: StormModel, tMax: number): { runs: [number, number][][]; yOf: (uGyDay: number) => number } {
  const vals = m.curve.map((p) => p[1]).filter((v): v is number => v !== null && v > 0)
  const top = m.peakUGyDay ?? Math.max(...vals)
  const bottom = Math.min(...vals, m.baselineUGyDay ?? Infinity)
  const lo = Math.log10(bottom)
  const hi = Math.log10(top)
  const yOf = (u: number): number => (hi > lo ? (Math.log10(Math.max(u, bottom)) - lo) / (hi - lo) : 0)
  const runs: [number, number][][] = []
  let cur: [number, number][] = []
  const flush = (): void => {
    if (cur.length) runs.push(cur)
    cur = []
  }
  for (let i = 0; i < m.curve.length; i++) {
    const [t, v] = m.curve[i]
    if (v === null || v <= 0) {
      flush()
      continue
    }
    if (t < 0 || t > tMax) {
      // keep one point beyond each axis end so the line reaches the edge (clipped by the SVG)
      const next = m.curve[i + 1]?.[0]
      const prev = m.curve[i - 1]?.[0]
      const edge = (t < 0 && next !== undefined && next >= 0) || (t > tMax && prev !== undefined && prev <= tMax)
      if (!edge) {
        flush()
        continue
      }
    }
    cur.push([t / tMax, yOf(v)])
  }
  flush()
  return { runs, yOf }
}

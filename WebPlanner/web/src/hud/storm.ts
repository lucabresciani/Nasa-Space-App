// Storm switch (F18): "replay the 20 May 2024 storm during this EVA", placed on the EVA clock by the
// shared D39 rule (config/conditions.yaml storm_replay, also read by WS2). TypeScript port of WS4's
// pipeline/conditions/storm_replay.py (KATs mirrored in storm.test.ts):
//
//   t* = the EVA minute where the route's T_home is largest (first sample on a tie; unknown skipped)
//   storm_utc(eva_min) = tripwire_utc + (eva_min - t*) min
//
// so the tripwire (rad.json storm_2024.tripwire_utc) fires at t*, the onset sits at
// t* - (tripwire_utc - onset_utc) and the peak at t* + (peak_utc - tripwire_utc). The switch only
// turns the replay on or off; it never moves it. After the tripwire the dose budget counts down from
// tau_dose at the storm peak (rad.json leash.tau_min_at_peak); alarm 2 when T_home >= budget left.
// The HUD's route T_home samples are WS2's timeline rows along the walk (t_min, t_home_min; the
// turn_back annotations excluded), the same numbers WS2 uses (assumption A-WS7-4, STATUS.md).
// Unknown stays unknown: no route T_home, no tripwire or no tau -> no replay (switch disabled).
import type { FieldGrid } from './fields'
import type { Plan } from './plan'
import type { Rad } from './types'

export const TRIPWIRE_AT = 'route_max_t_home'
const WANT = { tripwire_at: TRIPWIRE_AT, anchor_event: 'tripwire', eva_clock_units: 'min', tie_break: 'first' } as const
const MIN_MS = 60000

export interface StormReplayConfig {
  tripwireAt: string // storm_replay.tripwire_at
  anchorEvent: string // storm_replay.anchor_event
  evaClockUnits: string // storm_replay.eva_clock_units
  tieBreak: string // storm_replay.tie_break
}

/** conditions.yaml storm_replay, refused unless it names the rule implemented here (as check_config). */
export function parseStormReplayConfig(conditions: unknown): StormReplayConfig {
  const s = (conditions as { storm_replay?: Record<string, unknown> } | null)?.storm_replay
  if (!s || typeof s !== 'object') throw new Error('config/conditions.yaml: missing storm_replay')
  for (const [k, v] of Object.entries(WANT)) {
    if (String(s[k]) !== v) throw new Error(`config/conditions.yaml: storm_replay.${k} = ${JSON.stringify(s[k])}; storm.ts implements "${v}"`)
  }
  return { tripwireAt: WANT.tripwire_at, anchorEvent: WANT.anchor_event, evaClockUnits: WANT.eva_clock_units, tieBreak: WANT.tie_break }
}

/** t*: the EVA minute of the largest T_home along the route (first on a tie; null skipped). */
export function tripwireTargetMin(evaMin: readonly number[], tHomeMin: readonly (number | null)[]): number | null {
  if (evaMin.length !== tHomeMin.length) throw new Error('evaMin and tHomeMin differ in length')
  let best: [number, number] | null = null
  for (let i = 0; i < evaMin.length; i++) {
    const th = tHomeMin[i]
    if (th !== null && Number.isFinite(th) && (best === null || th > best[1])) best = [evaMin[i], th]
  }
  return best === null ? null : best[0]
}

/** Storm UTC (ms) that coincides with EVA minute 0. */
export function stormOffsetUtcMs(tripwireMs: number, targetMin: number): number {
  return tripwireMs - targetMin * MIN_MS
}

/** Storm UTC (ms) shown at EVA minute `evaMin`. */
export function stormUtcAtMs(evaMin: number, tripwireMs: number, targetMin: number): number {
  return stormOffsetUtcMs(tripwireMs, targetMin) + evaMin * MIN_MS
}

/** EVA minute at which the storm instant `stormMs` is replayed. */
export function evaMinOf(stormMs: number, tripwireMs: number, targetMin: number): number {
  return (stormMs - stormOffsetUtcMs(tripwireMs, targetMin)) / MIN_MS
}

/**
 * Route T_home samples: WS2's timeline rows (t_min, t_home_min) along the walk, turn_back
 * annotations excluded (plan.events). These are the numbers WS2 reads for the same key, so both
 * place the tripwire at the same minute (a 5 m field lookup along the route vertices can reach a
 * station's value one vertex early). `_tHome` kept for callers; unused.
 */
export function routeTHomeSeries(plan: Plan, _tHome?: FieldGrid): { evaMin: number[]; tHomeMin: (number | null)[] } {
  if (!plan.legs.length) return { evaMin: [], tHomeMin: [] } // no route: no placement (unknown)
  return { evaMin: plan.events.map((e) => e.t_min), tHomeMin: plan.events.map((e) => e.t_home_min) }
}

export interface StormReplay {
  rule: string // storm_replay.tripwire_at
  tripwireEvaMin: number // t*
  onsetEvaMin: number | null
  peakEvaMin: number | null
  stormUtcAtEvaStartMs: number
  tauDoseMin: number // leash.tau_min_at_peak
  /** rad.json storm_2024.tripwire_halfwidth_label ("± 9 min", D35); null = not in rad.json */
  halfwidthLabel: string | null
}

export interface StormState {
  on: boolean
  fired: boolean
  /** EVA minute the tripwire fires (null = switch off) */
  tFire: number | null
  tauDoseMin: number | null
  /** dose budget left at t (min of exposure at peak rate); null before the tripwire */
  doseLeftMin: number | null
  halfwidthLabel: string | null
}

const parseMs = (s: string | null | undefined): number | null => {
  if (!s) return null
  const v = Date.parse(s)
  return Number.isFinite(v) ? v : null
}

/** EVA-clock placement of the storm for one route (rad.json + route T_home); null = unknown. */
export function stormReplay(rad: Rad | null, evaMin: readonly number[], tHomeMin: readonly (number | null)[]): StormReplay | null {
  const s = rad?.storm_2024
  const tau = rad?.leash.tau_min_at_peak
  const trip = parseMs(s?.tripwire_utc)
  const tStar = tripwireTargetMin(evaMin, tHomeMin)
  if (!s || trip === null || tStar === null || tau === null || tau === undefined) return null
  const at = (iso: string | null | undefined) => {
    const v = parseMs(iso)
    return v === null ? null : evaMinOf(v, trip, tStar)
  }
  return {
    rule: TRIPWIRE_AT,
    tripwireEvaMin: tStar,
    onsetEvaMin: at(s.onset_utc),
    peakEvaMin: at(s.peak_utc),
    stormUtcAtEvaStartMs: stormOffsetUtcMs(trip, tStar),
    tauDoseMin: tau,
    halfwidthLabel: s.tripwire_halfwidth_label ?? null,
  }
}

export function stormState(r: StormReplay | null, t: number): StormState {
  if (!r) return { on: false, fired: false, tFire: null, tauDoseMin: null, doseLeftMin: null, halfwidthLabel: null }
  const tFire = r.tripwireEvaMin
  const fired = t >= tFire
  return { on: true, fired, tFire, tauDoseMin: r.tauDoseMin, doseLeftMin: fired ? r.tauDoseMin - (t - tFire) : null, halfwidthLabel: r.halfwidthLabel }
}

/** Readout input for alarm 2: tripwire fired, compared against the dose budget left. */
export function radiationInput(s: StormState): { tripwireFired: boolean; tauDoseMin: number | null } {
  return { tripwireFired: s.fired, tauDoseMin: s.fired ? s.doseLeftMin : null }
}

// WS16 task 3 (M3): margin-mode driver. Reads the mission state (state/mission.ts fieldUniforms)
// and the flown plan (timeline, D39 storm placement, time to dark), and hands the field layer the
// margin inputs at the clock minute. Also writes the two mission-state values A3 left to their
// reader: budgets.o2LeftL (timeline at clock.t) and conditions.tDarkMin (conditions/clock.json).
//
// Mode switch until the shell exists: `?field=margin` | `?field=bands` (ui.fieldMode), and
// `?field=play` = margin mode with the shared clock ticking here (RR checks; the timeline dock U5
// replaces it). Without a query, fieldUniforms' U2 rule applies (margin in Fly or while playing).
import { data } from '../../data/loader'
import { effect, fieldUniforms, mission, missionClock, ui } from '../../state'
import { FIELD_QUERY_KEY } from './constants'
import { DoseTiming, PlanTimeline, resolveMarginInputs, type MarginInputs, type PlanInputs, type RadStorm, type TimelineRow } from './margin'

export type FieldQueryMode = 'margin' | 'bands' | 'play' | null

/** `?field=margin|bands|play` in the search or the hash query (others: M2's `off`, or nothing). */
export function fieldModeQuery(search: string, hash: string): FieldQueryMode {
  const q = new URLSearchParams(search)
  const h = hash.split('?')[1]
  if (h) new URLSearchParams(h).forEach((v, k) => q.set(k, v))
  const v = q.get(FIELD_QUERY_KEY)
  return v === 'margin' || v === 'bands' || v === 'play' ? v : null
}

export interface FlownPlan {
  scenario: string
  suitKg: number
  timeline: PlanTimeline
  dose: DoseTiming | null
}

let flown: Promise<FlownPlan | null> | null = null

/**
 * The flown plan: the scenario the HUD flies (scenarios/index.json default, hud.ts rule), its
 * timeline, the D39 storm placement (t* = the timeline's largest T_home) and t_dark. null when the
 * timeline is missing (then margin mode has no O2 figure and stays in bands mode).
 */
export function loadFlownPlan(): Promise<FlownPlan | null> {
  if (!flown) {
    flown = (async () => {
      const L = data()
      const idx = await L.scenarios()
      const entry = idx.scenarios.find((s) => s.id === idx.default) ?? idx.scenarios[0]
      const [tl, rad, clock] = await Promise.all([
        L.optional(() => L.timeline(entry.id)),
        L.optional(() => L.rad()),
        L.optional(() => L.clock()),
      ])
      if (!tl) return null
      const timeline = new PlanTimeline(tl as unknown as TimelineRow[])
      const dose = rad && timeline.tStarMin !== null ? DoseTiming.fromRad(rad as unknown as RadStorm, timeline.tStarMin) : null
      const tDark = (clock as { eva?: { t_dark_min?: number | null } } | null)?.eva?.t_dark_min
      if (typeof tDark === 'number' && mission.conditions.tDarkMin.peek() === undefined) mission.conditions.tDarkMin.value = tDark
      return { scenario: entry.id, suitKg: entry.suit_kg, timeline, dose }
    })()
    flown.catch(() => (flown = null))
  }
  return flown
}

export interface MarginState {
  /** margin inputs at the clock minute; null = bands mode (or margin unknown) */
  inputs: MarginInputs | null
  /** margin mode asked for (by query, UI store or the U2 default rule) */
  marginMode: boolean
}

/**
 * Follow the mission state: calls `onChange` whenever the margin inputs or the mode change.
 * `suitKg` = the suit mass of the field on the map; margin mode needs the flown plan's suit mass
 * (its O2 state belongs to that walker). Returns a dispose function.
 */
export function driveMargin(suitKg: () => number | null, onChange: (s: MarginState) => void, query: FieldQueryMode): () => void {
  if (query === 'margin' || query === 'play') ui.fieldMode.value = 'margin'
  else if (query === 'bands') ui.fieldMode.value = 'bands'
  let plan: FlownPlan | null = null
  let disposed = false
  let stopEffect: () => void = () => {}
  let raf = 0
  void loadFlownPlan().then((p) => {
    if (disposed) return
    plan = p
    stopEffect = effect(() => {
      const u = fieldUniforms.value
      const want = u.mode === 'margin'
      const pi: PlanInputs | null = plan && plan.suitKg === suitKg() ? { timeline: plan.timeline, dose: plan.dose, dAllowMgy: mission.budgets.doseAllowMgy.value } : null
      // budgets.o2LeftL: the flown plan's O2 left at the clock minute (A3: written by its reader)
      const o2 = plan ? plan.timeline.o2LeftAt(u.t) : null
      if (o2 !== null && mission.budgets.o2LeftL.peek() !== o2) queueMicrotask(() => (mission.budgets.o2LeftL.value = o2))
      const inputs = want && pi ? resolveMarginInputs({ ...u, o2Left: o2 ?? u.o2Left }, pi) : null
      onChange({ inputs, marginMode: want })
    })
  })
  if (query === 'play') {
    // RR scaffolding until the timeline dock (U5): tick the shared clock from this view only
    let last = performance.now()
    const tick = (now: number): void => {
      missionClock.tick(now - last)
      last = now
      raf = requestAnimationFrame(tick)
    }
    if (!missionClock.playing) missionClock.play()
    raf = requestAnimationFrame(tick)
  }
  return () => {
    disposed = true
    stopEffect()
    if (raf) cancelAnimationFrame(raf)
  }
}

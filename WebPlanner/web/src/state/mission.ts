// Mission state (DESIGN §5.2): plan, clock, position, budgets, conditions. One source of truth for
// the field shader, map, 3D, HUD, timeline, gauges and report. Defaults come from config/ (cited
// next to each); a value without a published source stays undefined until a loader writes it.
import crewRaw from '../../../config/crew.yaml'
import hudRaw from '../../../config/hud.yaml'
import { CONFIG, cfg } from '../config'
import { o2Reserve } from '../views/o2'
import { ClockDriver, clockSignals } from './clock'
import { batch, computed, signal } from './signal'
import { ui } from './ui'

export interface MissionPosition {
  lon: number
  lat: number
  /** 1σ horizontal uncertainty (m) */
  sigmaM: number
  source: string
}

/** A scenarios/index.json entry, as far as the plan needs it. */
export interface PlanScenario {
  id: string
  variant: string
  suit_kg: number
}

const clock = clockSignals(
  cfg<number>(crewRaw, 'eva_h') * 60, // crew.yaml eva_h × 60 (playback / scrubber length)
  cfg<number[]>(hudRaw, 'playback_speeds'), // hud.yaml playback_speeds
  cfg<number>(hudRaw, 'default_speed'), // hud.yaml default_speed (D13: 60×)
)

export const mission = {
  plan: {
    /** scenario id (scenarios/index.json); undefined = not chosen yet (views use the index default) */
    scenario: signal<string | undefined>(undefined),
    variant: signal<string | undefined>(undefined),
    suitKg: signal<number | undefined>(undefined),
    /** walkback budget (min): crew.yaml walkback_budgets_min[0] */
    budgetMin: signal<number>(CONFIG.walkbackBudgetsMin[0]),
    /** D21 parking option id; null = the official pad (pad.json) */
    pad: signal<string | null>(null),
    /** plan hash and live result root (#/plan/{hash}); undefined = the static data tree */
    hash: signal<string | undefined>(undefined),
    resultBase: signal<string | undefined>(undefined),
  },
  clock,
  position: signal<MissionPosition | undefined>(undefined),
  budgets: {
    /** O₂ left now (L): from the timeline at the clock minute; written by its reader */
    o2LeftL: signal<number | undefined>(undefined),
    /** crew.yaml o2_budget.primary_L (margin_uses: primary_L) */
    o2PrimaryL: signal<number>(CONFIG.o2PrimaryL),
    /** crew.yaml o2_margin reserve_min_at_effort_cap × effort rate (D24), as on the scorecard */
    o2ReserveL: signal<number>(o2Reserve().litres),
    /** conditions.yaml leash.d_allow_mgy (D9 slider default) */
    doseAllowMgy: signal<number>(CONFIG.dAllowMgy),
    /** EVA length (min) = the clock's tMax (one signal) */
    evaMin: clock.tMax,
  },
  conditions: {
    /** minutes to dark (conditions/clock.json); undefined until loaded */
    tDarkMin: signal<number | undefined>(undefined),
    /** τ_dose (min) of the active storm; undefined = no storm */
    tauDoseMin: signal<number | undefined>(undefined),
    storm: signal<boolean>(false),
  },
} as const

/** The one shared playback clock (PlaybackClock API). Survives route changes. */
export const missionClock = new ClockDriver(mission.clock)

/**
 * The plan scenario to show: the stored choice if the index has it, else the index default, else
 * the first entry (the console's original rule).
 */
export function resolvePlanScenario<S extends { id: string }>(idx: { default: string; scenarios: S[] }, chosen = mission.plan.scenario.peek()): S {
  return idx.scenarios.find((s) => s.id === chosen) ?? idx.scenarios.find((s) => s.id === idx.default) ?? idx.scenarios[0]
}

export function choosePlanScenario(s: PlanScenario): void {
  batch(() => {
    mission.plan.scenario.value = s.id
    mission.plan.variant.value = s.variant
    mission.plan.suitKg.value = s.suit_kg
  })
}

/**
 * Scalars the field shader reads (DESIGN §6.4, contracts/field_shader.md). undefined = not known
 * yet; the shader package decides its fallback (e.g. u_tauDose "very large when no storm").
 */
export const fieldUniforms = computed(() => ({
  t: mission.clock.t.value,
  tDark: mission.conditions.tDarkMin.value,
  tauDose: mission.conditions.storm.value ? mission.conditions.tauDoseMin.value : undefined,
  tEva: mission.budgets.evaMin.value,
  o2Left: mission.budgets.o2LeftL.value,
  reserve: mission.budgets.o2ReserveL.value,
  budget: mission.plan.budgetMin.value,
  variant: mission.plan.variant.value,
  // DESIGN U2: margin mode is the default in Fly and when the clock runs; bands otherwise
  mode: ui.fieldMode.value ?? (ui.mode.value === 'fly' || mission.clock.playing.value ? 'margin' : 'bands'),
  k: ui.collapseK.value,
}))

// Typed view of the config/*.yaml values the web app uses. AGENTS rule 2: every constant comes
// from config/; this module only reads it (parsed at build time, see vite.config.ts). A missing
// key throws at import time, so a renamed config value fails the build and the tests.
import siteRaw from '../../config/site.yaml'
import crewRaw from '../../config/crew.yaml'
import variantsRaw from '../../config/variants.yaml'
import hudRaw from '../../config/hud.yaml'
import haulRaw from '../../config/haul.yaml'
import conditionsRaw from '../../config/conditions.yaml'
import stationsRaw from '../../config/stations.yaml'
import horizonRaw from '../../config/horizon.yaml'
import eventRaw from '../../config/event.yaml'
import navRaw from '../../config/nav.yaml'

type Obj = Record<string, unknown>

/** Read a dotted path from a parsed YAML object; throw if it is missing. */
export function cfg<T = unknown>(root: unknown, path: string): T {
  let cur: unknown = root
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in (cur as Obj))) {
      throw new Error(`config value missing: ${path}`)
    }
    cur = (cur as Obj)[part]
  }
  return cur as T
}

/** Like cfg, but undefined when the key is absent (for values that config/ may add later). */
export function cfgOpt<T = unknown>(root: unknown, path: string): T | undefined {
  try {
    return cfg<T>(root, path)
  } catch {
    return undefined
  }
}

function num(root: unknown, path: string): number {
  const v = cfg(root, path)
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`config value not a number: ${path}`)
  return v
}

/** A config value with the file and key it came from, so the UI can cite it. */
export interface CfgValue<T> {
  value: T
  source: string // e.g. "config/site.yaml: crs.mars_radius_m"
}

function cite<T>(file: string, root: unknown, path: string): CfgValue<T> {
  return { value: cfg<T>(root, path), source: `config/${file}: ${path}` }
}

export interface IsochroneMinutes {
  min: number
  max: number
  step: number
}

export const CONFIG = {
  marsRadiusM: num(siteRaw, 'crs.mars_radius_m'),
  /** the analysis projection (eqc), = the simulator bundle's pad-local frame (contracts/bundle/README.md); Mission Planer export */
  analysisProj: cfg<string>(siteRaw, 'crs.analysis_proj'),
  /** SPEC F18 band colouring: green > this, amber 0..this, red < 0; Mission Planer export */
  marginAmberMin: num(hudRaw, 'margin_amber_min'),
  aoiFocus: cfg<{ west: number; east: number; south: number; north: number }>(siteRaw, 'aoi_focus'),
  padDefault: cfg<{ lon: number; lat: number; rule: string; verify_at_h0?: boolean }>(siteRaw, 'pad_default'),
  planningRadiusM: num(siteRaw, 'planning_radius_m'),
  walkbackBudgetsMin: cfg<number[]>(crewRaw, 'walkback_budgets_min'),
  bandBudgetsMin: cfg<number[]>(variantsRaw, 'outputs.band_budgets_min'),
  suitMassesKg: cfg<number[]>(crewRaw, 'suit_masses_kg'),
  defaultSuitKg: num(crewRaw, 'default_suit_kg'),
  defaultScenario: cfg<string>(variantsRaw, 'scenarios.default'),
  scenarioIds: cfg<string[]>(variantsRaw, 'scenarios.ids'),
  variantNames: Object.keys(cfg<Obj>(variantsRaw, 'variants')),
  isochroneMinutes: cfg<IsochroneMinutes>(variantsRaw, 'outputs.isochrone_minutes'),
  simulatedLabel: cfg<string>(hudRaw, 'labels.simulated'),
  haulContourMin: num(haulRaw, 'contour_min'),
  /** D20 (SPEC F10): partner line cases, label template, caption and the drag note. */
  haulPartnerCases: cfg<string[]>(haulRaw, 'partner_cases'),
  haulPartnerLabel: cfg<string>(haulRaw, 'partner_label'),
  haulPartnerCaption: cfg<string>(haulRaw, 'partner_caption'),
  haulDragNote: cfg<string>(haulRaw, 'drag_note'),
  dAllowMgy: num(conditionsRaw, 'leash.d_allow_mgy'),
  /** D9 slider range and step (config/conditions.yaml, WS4; C answer 10:35Z). */
  dAllowRangeMgy: cfg<[number, number]>(conditionsRaw, 'leash.d_allow_range_mgy'),
  dAllowStepMgy: num(conditionsRaw, 'leash.d_allow_step_mgy'),
  tripwireFactor: num(conditionsRaw, 'rad.tripwire.factor'),
  tripwireSamples: num(conditionsRaw, 'rad.tripwire.consecutive_samples'),
  remsStaleSince: cfg<string>(conditionsRaw, 'rems.feed_stale_since'),
  distanceClassesKm: cfg<number[]>(horizonRaw, 'distance_classes_km'),
  stationsPlan: cfg<{ id: string; name: string; rule: string }[]>(stationsRaw, 'stations').map((s) => ({ id: s.id, name: s.name, rule: s.rule })),
  h0Utc: cfg<string>(eventRaw, 'h0_utc'),
  timezone: cfg<string>(eventRaw, 'timezone'),
  o2PrimaryL: num(crewRaw, 'o2_budget.primary_L'),
  accessRadiusM: num(variantsRaw, 'route.access_radius_m'),
  isochroneFallbackStepMin: num(variantsRaw, 'outputs.isochrone_fallback_step_min'),
  /** F22 gate tolerance: config/nav.yaml skyline_fix_gate.tolerance_from names the key (C 11:58). */
  skylineFixGate: (() => {
    const from = cfg<string>(navRaw, 'real_run_ws9.skyline_fix_gate.tolerance_from')
    return { toleranceM: num(navRaw, from), source: `config/nav.yaml: ${from}`, rule: cfg<string>(navRaw, 'real_run_ws9.skyline_fix_gate.rule') }
  })(),
} as const

/** O2 effort rate (L/min) per config/crew.yaml o2_margin.effort_rate_L_min (a formula string there). */
export function effortRateLMin(c: { effortCapFrac: number; vo2max: number; bodyMassKg: number }): number {
  return (c.effortCapFrac * c.vo2max * c.bodyMassKg) / 1000
}

/** Config values shown on screen (assumptions table, labels), each with its source. */
export const CITED = {
  bodyMassKg: cite<number>('crew.yaml', crewRaw, 'body_mass_kg'),
  vo2maxMlKgMin: cite<number>('crew.yaml', crewRaw, 'vo2max_ml_kg_min'),
  effortCapFrac: cite<number>('crew.yaml', crewRaw, 'effort_cap_frac'),
  evaH: cite<number>('crew.yaml', crewRaw, 'eva_h'),
  reserveMin: cite<number>('crew.yaml', crewRaw, 'reserve_min'),
  o2ReserveMinAtEffortCap: cite<number>('crew.yaml', crewRaw, 'o2_margin.reserve_min_at_effort_cap'),
  o2EffortRateFormula: cite<string>('crew.yaml', crewRaw, 'o2_margin.effort_rate_L_min'),
  stationTaskRateLMin: cite<number>('crew.yaml', crewRaw, 'o2_margin.station_task_rate_L_min'),
  accessRadiusM: cite<number>('variants.yaml', variantsRaw, 'route.access_radius_m'),
  dwellMin: cite<number>('stations.yaml', stationsRaw, 'dwell_min'),
  walkbackBudgetsMin: cite<number[]>('crew.yaml', crewRaw, 'walkback_budgets_min'),
  suitMassesKg: cite<number[]>('crew.yaml', crewRaw, 'suit_masses_kg'),
  anchorVo2: cite<number>('crew.yaml', crewRaw, 'anchor.vo2_ml_kg_min'),
  anchorSpeed: cite<number>('crew.yaml', crewRaw, 'anchor.speed_ms'),
  o2PrimaryL: cite<number>('crew.yaml', crewRaw, 'o2_budget.primary_L'),
  o2SecondaryL: cite<number>('crew.yaml', crewRaw, 'o2_budget.secondary_L'),
  /** F8 siting rule (site.yaml siting): steepest cell allowed in a pad block, block size, routing grid. */
  sitingMaxSlopeDeg: cite<number>('site.yaml', siteRaw, 'siting.max_slope_deg'),
  sitingBlockM: cite<number>('site.yaml', siteRaw, 'siting.block_m'),
  routeGridM: cite<number>('site.yaml', siteRaw, 'grids_m.route'),
  nogoNominalDeg: cite<number>('site.yaml', siteRaw, 'slope.nogo_deg.nominal'),
  nogoOptimisticDeg: cite<number>('site.yaml', siteRaw, 'slope.nogo_deg.optimistic'),
  flagBeyondTestedDeg: cite<number>('site.yaml', siteRaw, 'slope.flag_beyond_tested_deg'),
  dAllowMgy: cite<number>('conditions.yaml', conditionsRaw, 'leash.d_allow_mgy'),
  tripwireFactor: cite<number>('conditions.yaml', conditionsRaw, 'rad.tripwire.factor'),
  tripwireSamples: cite<number>('conditions.yaml', conditionsRaw, 'rad.tripwire.consecutive_samples'),
  qSep: cite<number>('conditions.yaml', conditionsRaw, 'rad.q_sep'),
  radExpected: cite<{ peak_mgy_day: [number, number]; excess_mgy: [number, number] }>('conditions.yaml', conditionsRaw, 'rad.expected'),
  remsStaleSince: cite<string>('conditions.yaml', conditionsRaw, 'rems.feed_stale_since'),
  fixSigmaRoverM: cite<number>('hud.yaml', hudRaw, 'fix_sigma_m.rover'),
  fixSigmaStationM: cite<number>('hud.yaml', hudRaw, 'fix_sigma_m.station'),
  driftPct: cite<number>('hud.yaml', hudRaw, 'fallback_drift.pct_of_distance'),
  haulBootMu: cite<number>('haul.yaml', haulRaw, 'boot_mu'),
  casualtyBoundKg: cite<number>('haul.yaml', haulRaw, 'casualty_kg.bound'),
  haulContourMin: cite<number>('haul.yaml', haulRaw, 'contour_min'),
  /** D26: label of a station nobody can reach on foot. */
  unreachableLabel: cite<string>('stations.yaml', stationsRaw, 'placement.unreachable_label'),
  /** D29: the one O₂ energy equivalent (uphill term, heat, haul, O₂ budget). */
  o2EnergyJPerMl: cite<number>('crew.yaml', crewRaw, 'o2_energy_j_per_ml'),
  /** D22: 30° step guard (assumed) on top of the 3 m plane-fit cell slope. */
  stepGuardDeg: cite<number>('site.yaml', siteRaw, 'slope.step_guard_deg'),
  stepGuardAssumed: cite<boolean>('site.yaml', siteRaw, 'slope.step_guard_assumed'),
  cellSlopeMethod: cite<string>('site.yaml', siteRaw, 'slope.cell_slope'),
  /** D23: conservative no-go (replaces "20 − V1 RMSE"). */
  nogoConservativeDeg: cite<number>('site.yaml', siteRaw, 'slope.nogo_deg.conservative'),
} as const

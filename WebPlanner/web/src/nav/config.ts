// Navigation constants, read from config/nav.yaml (and crew.yaml / hud.yaml via src/config.ts) at
// build time. AGENTS rule 2: no copies. Since D98 the /nav view is removed; what remains in src/nav/
// (config, loader, types, ellipse geometry, series, position line) serves the 2D HUD only.
import navRaw from '../../../config/nav.yaml'
import hudRaw from '../../../config/hud.yaml'
import { cfg, CONFIG } from '../config'

const sets = cfg<Record<string, Record<string, number>>>(navRaw, 'sets')
const classesM = cfg<number[]>(navRaw, 'fix_interval.classes_m')
if (!Array.isArray(classesM) || !classesM.every((v, i) => typeof v === 'number' && (i === 0 || v > classesM[i - 1]))) {
  throw new Error('config/nav.yaml: fix_interval.classes_m must be ascending numbers')
}
const defaultSet = cfg<string>(navRaw, 'default_set')
if (!(defaultSet in sets)) throw new Error('config/nav.yaml: default_set is not in sets')

/** "crew.yaml walkback_budgets_min[0]" -> index 0 (the only form nav.yaml uses today). */
export function budgetFrom(spec: string, budgets: readonly number[] = CONFIG.walkbackBudgetsMin): number {
  const m = /^crew\.yaml walkback_budgets_min\[(\d+)\]$/.exec(spec.trim())
  if (!m) throw new Error(`config/nav.yaml: fix_interval_ws9.budget_from "${spec}" not understood`)
  const v = budgets[Number(m[1])]
  if (typeof v !== 'number') throw new Error(`config/nav.yaml: ${spec} does not exist`)
  return v
}

export const NAV = {
  /** Parameter-set names in config order (low, medium, high; a calibrated set may be added by WS10). */
  sets: Object.keys(sets),
  setParams: sets,
  defaultSet,
  ellipseConf: cfg<number>(navRaw, 'ellipse_conf'),
  classesM,
  fixSigmaM: cfg<{ rover: number; station: number }>(navRaw, 'fix_sigma_m'),
  ellipseEveryMin: cfg<number>(navRaw, 'tracks.ellipse_every_min'),
  ellipseVertices: cfg<number>(navRaw, 'tracks.ellipse_vertices'),
  /** Homeline budget the fix-interval map uses (SPEC F21: the 30-min homeline). */
  homelineBudgetMin: budgetFrom(cfg<string>(navRaw, 'fix_interval_ws9.budget_from')),
  reserveMin: cfg<number>(navRaw, 'fix_interval_ws9.reserve_min'),
  edgePercentile: cfg<number>(navRaw, 'fix_interval_ws9.edge_percentile'),
  r95FitText: cfg<string>(navRaw, 'r95_fit'),
  criterion: cfg<string>(navRaw, 'fix_interval.criterion'),
  runs: cfg<number>(navRaw, 'monte_carlo.runs'),
  skylineStandaloneOffsetM: cfg<number>(navRaw, 'skyline_fix.standalone_prior_offset_m'),
  /** HUD playback (hud.yaml). */
  playbackSpeeds: cfg<number[]>(hudRaw, 'playback_speeds'),
  defaultSpeed: cfg<number>(hudRaw, 'default_speed'),
} as const

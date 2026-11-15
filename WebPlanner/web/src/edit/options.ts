// What a plan edit may change, and which changes work without the server (U15 "With the backend
// off"; design-agents rule 6: static first). Static mode offers only choices that have a
// precomputed result: the official pad with any scenario (variant × suit) and walkback budget, and
// the D21 parking options at the scenario they were computed for with the band budgets. A custom
// pad spot and station dwell need the live plan job; they are listed with needsServer so the UI
// hides them (or says why) when live planning is off.
import backendRaw from '../../../config/backend.yaml'
import variantsRaw from '../../../config/variants.yaml'
import { cfg } from '../config'
import { dataUrl } from '../env'
import type { CopyKey } from '../ui/copy'
import { officialPad, type PadRow, type StationRow } from './canonical'

export interface ScenarioRow {
  id: string
  variant: string
  suit_kg: number
}

/** The static choices a plan can be built from (scenarios/index.json, scenarios/pads/index.json, stations.json, config). */
export interface EditCatalog {
  scenarios: readonly ScenarioRow[]
  defaultScenario: string
  /** official pad and picker pads (D21), as GET /defaults lists them */
  pads: readonly PadRow[]
  officialPadId: string
  /** the scenario the parking options were computed for (pads index `scenario`) */
  padScenario: string
  stations: readonly StationRow[]
  /** variants.yaml outputs.isochrone_minutes: budgets with an isochrone (official pad) */
  isochroneMinutes: { min: number; max: number; step: number }
  /** variants.yaml outputs.band_budgets_min: budgets with a band (every precomputed pad) */
  bandBudgetsMin: readonly number[]
}

interface ScenariosIndex {
  default: string
  scenarios: ScenarioRow[]
}
interface PadsIndex {
  scenario: string
  pads: PadRow[]
}

export function buildCatalog(scenarios: ScenariosIndex, pads: PadsIndex, stations: readonly StationRow[]): EditCatalog {
  const rows = pads.pads.filter((p) => p.official || p.picker)
  return {
    scenarios: scenarios.scenarios.map(({ id, variant, suit_kg }) => ({ id, variant, suit_kg })),
    defaultScenario: scenarios.default,
    pads: rows.map(({ id, lon, lat, official, picker }) => ({ id, lon, lat, official, picker })),
    officialPadId: officialPad(rows).id,
    padScenario: pads.scenario,
    stations: stations.map(({ id, dwell_min }) => ({ id, dwell_min })),
    isochroneMinutes: cfg(variantsRaw, 'outputs.isochrone_minutes'),
    bandBudgetsMin: cfg(variantsRaw, 'outputs.band_budgets_min'),
  }
}

export type FetchJson = (path: string) => Promise<unknown>
const fetchStatic: FetchJson = async (path) => {
  const res = await fetch(dataUrl(path))
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

/** Load the catalog from the static data tree (or any loader with the same paths). */
export async function loadEditCatalog(fetchJson: FetchJson = fetchStatic): Promise<EditCatalog> {
  const [s, p, st] = await Promise.all([fetchJson('scenarios/index.json'), fetchJson('scenarios/pads/index.json'), fetchJson('stations.json')])
  return buildCatalog(s as ScenariosIndex, p as PadsIndex, st as StationRow[])
}

// ---- The plan an edit works on ----------------------------------------------------------------

/** A custom pad spot (live only): Mars 2000 planetocentric degrees. */
export interface LonLat {
  lon: number
  lat: number
}

/** What one undo step holds. Variant and budget are display choices (one plan job computes every variant and both bands). */
export interface EditPlan {
  /** scenarios/index.json id (variant × suit) */
  scenario: string
  /** walkback budget shown (min) */
  budgetMin: number
  /** a precomputed pad id (official or D21 parking option) or a custom spot (live) */
  pad: string | LonLat
  /** station dwell overrides (min); empty = the stations' own dwell */
  dwell: Readonly<Record<string, number>>
}

export const isCustomPad = (p: EditPlan['pad']): p is LonLat => typeof p === 'object'

// ---- Availability -------------------------------------------------------------------------------

export type Availability = { ok: true } | { ok: false; needsServer: boolean; reason?: CopyKey; detail: string }

const RANGES = {
  dwell: cfg<{ min: number; max: number }>(backendRaw, 'ranges.dwell_min'),
}
const NEEDS_SERVER: CopyKey = 'states.offline.unavailableHere'
const no = (needsServer: boolean, detail: string): Availability => ({ ok: false, needsServer, reason: needsServer ? NEEDS_SERVER : undefined, detail })

const onGrid = (v: number, r: { min: number; max: number; step: number }) => v >= r.min && v <= r.max && Number.isInteger((v - r.min) / r.step)

/** Whether `plan` can be shown: from precomputed files (static), or with the live plan job too. */
export function planAvailability(plan: EditPlan, c: EditCatalog, live: boolean): Availability {
  const sc = c.scenarios.find((s) => s.id === plan.scenario)
  if (!sc) return no(false, `scenario ${plan.scenario} is not in scenarios/index.json`)
  const dwellIds = Object.keys(plan.dwell)
  for (const id of dwellIds) {
    if (!c.stations.some((s) => s.id === id)) return no(false, `dwell for unknown station ${id}`)
    const v = plan.dwell[id]
    if (!(v >= RANGES.dwell.min && v <= RANGES.dwell.max)) return no(false, `dwell ${v} min outside config/backend.yaml ranges.dwell_min [${RANGES.dwell.min}, ${RANGES.dwell.max}]`)
  }
  const custom = isCustomPad(plan.pad)
  const pad = custom ? undefined : c.pads.find((p) => p.id === plan.pad)
  if (!custom && !pad) return no(false, `pad ${String(plan.pad)} is not an official or picker pad`)
  const official = !custom && plan.pad === c.officialPadId
  // budgets: isochrones exist for the official pad's scenarios; every other pad has the bands only
  if (official ? !onGrid(plan.budgetMin, c.isochroneMinutes) : !c.bandBudgetsMin.includes(plan.budgetMin)) {
    return no(false, `walkback budget ${plan.budgetMin} min has no ${official ? 'isochrone' : 'band'} (variants.yaml outputs)`)
  }
  // D81 / D21: a pad other than the official one is computed at the pads index scenario's suit only
  if (!official && sc.suit_kg !== c.scenarios.find((s) => s.id === c.padScenario)?.suit_kg) {
    return no(false, `pads other than the official one are computed at the ${c.padScenario} suit only`)
  }
  if (live) return { ok: true }
  if (custom) return no(true, 'a custom pad spot needs the live plan job')
  if (dwellIds.some((id) => plan.dwell[id] !== stationDwell(c, id))) return no(true, 'a changed station dwell needs the live plan job')
  if (!official && plan.scenario !== c.padScenario) return no(true, `parking options are precomputed for ${c.padScenario} only`)
  return { ok: true }
}

/** Has `plan` a precomputed result in the static tree (no job needed)? */
export const isPrecomputed = (plan: EditPlan, c: EditCatalog): boolean => planAvailability(plan, c, false).ok

/** The dwell the static plan used (stations.json, the config fallback is filled by canonical.ts). */
function stationDwell(c: EditCatalog, id: string): number | undefined {
  return c.stations.find((s) => s.id === id)?.dwell_min
}

/**
 * Snap a spot to the nearest precomputed pad (static drag-the-rover, U15). Ranking only: degrees with
 * longitude scaled by cos(latitude), so no planet radius is needed.
 */
export function nearestPad(c: EditCatalog, at: LonLat): PadRow {
  const k = Math.cos((at.lat * Math.PI) / 180)
  let best = c.pads[0]
  let bestD = Infinity
  for (const p of c.pads) {
    const d = ((p.lon - at.lon) * k) ** 2 + (p.lat - at.lat) ** 2
    if (d < bestD) [best, bestD] = [p, d]
  }
  return best
}

// ---- Options the UI may offer ---------------------------------------------------------------

export type EditOption =
  | { kind: 'pad'; id: string; needsServer: false }
  | { kind: 'customPad'; needsServer: true }
  | { kind: 'scenario'; id: string; needsServer: false }
  | { kind: 'budget'; min: number; needsServer: false }
  | { kind: 'dwell'; station: string; needsServer: true }

/** Every edit option; needsServer marks the live-only ones. */
export function allOptions(c: EditCatalog): EditOption[] {
  const { min, max, step } = c.isochroneMinutes
  const budgets: number[] = []
  for (let b = min; b <= max; b += step) budgets.push(b)
  return [
    ...c.pads.map((p) => ({ kind: 'pad' as const, id: p.id, needsServer: false as const })),
    { kind: 'customPad', needsServer: true },
    ...c.scenarios.map((s) => ({ kind: 'scenario' as const, id: s.id, needsServer: false as const })),
    ...budgets.map((b) => ({ kind: 'budget' as const, min: b, needsServer: false as const })),
    ...c.stations.map((s) => ({ kind: 'dwell' as const, station: s.id, needsServer: true as const })),
  ]
}

/** The options to show: static mode drops every live-only one (U15 acceptance). */
export function offeredOptions(c: EditCatalog, live: boolean): EditOption[] {
  return allOptions(c).filter((o) => live || !o.needsServer)
}

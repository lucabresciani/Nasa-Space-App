// Staged results (F24): after each finished stage, read what the result tree holds so far through
// the existing contract-checking loader (kit rule 7: liveLoader = createLoader(browserFetcher('real',
// base), 'real')). Stage names are opaque (job.schema.json leaves them free), so nothing here maps a
// stage to files: every renderable file is tried and a file not written yet (404) is simply absent.
// A file that fails its contract is reported, never rendered, and never stops the other files.
import { DataError, type Loader } from '../data/loader'
import type { BandsFC, EdgesFC, IsochroneFC, Manifest, PartnerFC, RouteFC, ScenarioEntry, ScenariosIndex } from '../data/types'
import { liveLoader } from './result'

export interface StageError {
  path: string
  message: string
}

export interface StageResult {
  /** Result base URL the files were read from. */
  base: string
  /** Stages finished when this snapshot was read. */
  stages: string[]
  index: ScenariosIndex | null
  /** The index's default scenario (else its first). */
  scenario: ScenarioEntry | null
  bands: BandsFC | null
  isochrones: IsochroneFC | null
  edges: EdgesFC | null
  partner: PartnerFC | null
  route: RouteFC | null
  /** The result's own manifest.json: every live number resolves against it (brief rule 4). */
  manifest: Manifest | null
  errors: StageError[]
}

export type LoaderFor = (resultBase: string) => Loader

/** A missing file is null; any other failure is recorded in errors and also gives null. */
async function soft<T>(errors: StageError[], path: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof DataError && e.kind === 'missing') return null
    errors.push({ path: e instanceof DataError ? e.path : path, message: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/**
 * Snapshot of the result tree after `stages`. A fresh loader per snapshot: a file may be replaced by
 * a later stage (the manifest grows), so the previous snapshot's cache must not be reused.
 */
export async function loadStage(base: string, stages: readonly string[], loaderFor: LoaderFor = liveLoader): Promise<StageResult> {
  const L = loaderFor(base)
  const errors: StageError[] = []
  const [index, manifest] = await Promise.all([soft(errors, 'scenarios/index.json', () => L.scenarios()), soft(errors, 'manifest.json', () => L.manifest())])
  const scenario = index ? (index.scenarios.find((s) => s.id === index.default) ?? index.scenarios[0] ?? null) : null
  let bands: BandsFC | null = null
  let isochrones: IsochroneFC | null = null
  let edges: EdgesFC | null = null
  let partner: PartnerFC | null = null
  let route: RouteFC | null = null
  if (scenario) {
    ;[bands, isochrones, edges, partner, route] = await Promise.all([
      soft(errors, scenario.files.bands, () => L.bands(scenario)),
      soft(errors, scenario.files.isochrones, () => L.isochrones(scenario)),
      soft(errors, scenario.files.edges, () => L.edges(scenario)),
      soft(errors, scenario.files.partner, () => L.partner(scenario)),
      soft(errors, `route_${scenario.id}.geojson`, () => L.route(scenario.id)),
    ])
  }
  return { base, stages: [...stages], index, scenario, bands, isochrones, edges, partner, route, manifest, errors }
}

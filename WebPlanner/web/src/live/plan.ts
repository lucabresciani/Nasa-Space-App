// Permalinks (F28, D69): #/plan/{hash} opens any computed result read-only, logged out. The result
// tree loads through the existing contract-checking loader with base = the API's
// /results/{hash} (S6 dataUrl base; kit rule 7, one rendering path), and its run record from
// GET /results/{hash}/provenance (F35). Routes, all handled inside src/live (the app router does
// not know them; see planmount.tsx):
//   #/plan                     import a plan_inputs.json
//   #/plan/{hash}              the result (headline, route, export, play, simulator slot)
//   #/plan/{hash}/provenance   the verify view (F35)
//   #/plan/{hash}/play         the result in the 2D HUD playback ("Play this plan", F24)
import { DataError } from '../data/loader'
import type { TimelineEvent } from '../data/types'
import { ApiError, type ApiClient } from './client'
import { HASH_HEX_CHARS } from './config'
import { startJob, type JobOptions, type JobOutcome } from './jobs'
import { checkPlanInputsFile, type FileLike } from './planio'
import { routeOf, type RouteSpec } from './plans/route'
import { liveLoader } from './result'
import { validateRunRecord } from './schemacheck'
import { loadStage, type LoaderFor, type StageResult } from './stage'
import type { Job, PlanInputs, RunRecord } from './types'

export const HASH_RE = new RegExp(`^[0-9a-f]{${HASH_HEX_CHARS}}$`)

export type PlanView = 'result' | 'provenance' | 'play'
export type PlanRoute = { view: 'import' } | { view: PlanView; hash: string }

/** The live plan route of a location hash, or null when the hash belongs to the app router. */
export function parsePlanRoute(locationHash: string): PlanRoute | null {
  const path = locationHash.replace(/^#/, '').split('?', 1)[0]
  const segs = path.split('/').filter(Boolean)
  if (segs[0] !== 'plan') return null
  if (segs.length === 1) return { view: 'import' }
  const hash = decodeURIComponent(segs[1])
  if (segs.length === 2) return { view: 'result', hash }
  if (segs.length === 3 && (segs[2] === 'provenance' || segs[2] === 'play')) return { view: segs[2], hash }
  return { view: 'result', hash: `${segs.slice(1).join('/')}` } // unknown sub-path: shown as not found
}

export function planUrl(hash: string, view: PlanView = 'result'): string {
  return view === 'result' ? `#/plan/${hash}` : `#/plan/${hash}/${view}`
}

/** Absolute permalink for sharing (no share codes, D69). */
export function permalink(hash: string, loc: { origin: string; pathname: string }): string {
  return `${loc.origin}${loc.pathname}${planUrl(hash)}`
}

export interface PlanTree extends StageResult {
  timeline: TimelineEvent[] | null
}

export type PlanLoad =
  | { state: 'ok'; hash: string; base: string; record: RunRecord; tree: PlanTree }
  | { state: 'notfound'; hash: string; reason: string }
  | { state: 'offline'; hash: string; message: string }
  | { state: 'error'; hash: string; message: string }

export interface LoadPlanOptions {
  loaderFor?: LoaderFor
  signal?: AbortSignal
  /** Called once the run record has passed its checks, before the result tree loads (origin label). */
  onRecord?: (record: RunRecord) => void
}

// --- route in the run record (D97, contracts v1.2.0) ---

/** Contract errors of a run record (run_record.schema.json v1.2.0: route_mode, feasibility, inputs.route). [] = valid. */
export const checkRunRecord = (record: unknown): string[] => validateRunRecord(record)

/** The route a result was computed with: the record's route_mode, else its inputs' route (missing = auto). */
export function recordRoute(record: RunRecord): RouteSpec {
  const r = routeOf(record.inputs)
  const mode = record.route_mode
  return mode && mode !== r.mode ? { ...r, mode } : r
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Run record + result tree of `hash`. Never rejects: unknown, offline and broken answers are states. */
export async function loadPlan(client: ApiClient, hash: string, opts: LoadPlanOptions = {}): Promise<PlanLoad> {
  if (!HASH_RE.test(hash)) return { state: 'notfound', hash, reason: `"${hash}" is not a result hash (${HASH_HEX_CHARS} lower-case hex characters)` }
  let record: RunRecord
  try {
    record = await client.provenance(hash, { signal: opts.signal })
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { state: 'notfound', hash, reason: `the server knows no result ${hash} (${e.code})` }
    if (e instanceof ApiError && e.transient) return { state: 'offline', hash, message: msg(e) }
    return { state: 'error', hash, message: msg(e) }
  }
  const errs = checkRunRecord(record)
  if (errs.length) return { state: 'error', hash, message: `run record fails run_record.schema.json: ${errs.slice(0, 3).join('; ')}` }
  if (record.hash !== hash) return { state: 'error', hash, message: `run record is for ${record.hash}, not ${hash}` }
  opts.onRecord?.(record)
  const base = client.resultBase({ hash, result_url: null })
  const loaderFor = opts.loaderFor ?? liveLoader
  const tree = await loadStage(base, record.stages.map((s) => s.name), loaderFor)
  let timeline: TimelineEvent[] | null = null
  if (tree.scenario) {
    const path = `timeline_${tree.scenario.id}.json`
    try {
      timeline = await loaderFor(base).timeline(tree.scenario.id)
    } catch (e) {
      if (!(e instanceof DataError && e.kind === 'missing')) tree.errors.push({ path, message: msg(e) })
    }
  }
  return { state: 'ok', hash, base, record, tree: { ...tree, timeline } }
}

// --- import (F28): file -> checked inputs -> the known result, or a new plan job ---

export type ImportState =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'rejected'; errors: string[] }
  | { kind: 'checking'; inputs: PlanInputs }
  /** API down: the inputs are still shown (F28: import works with the server down for viewing). */
  | { kind: 'offline'; inputs: PlanInputs; message: string }
  | { kind: 'computing'; inputs: PlanInputs; job: Job | null }
  | { kind: 'failed'; inputs: PlanInputs; message: string }
  | { kind: 'opened'; hash: string; computed: boolean }

export interface ImportDeps {
  client: ApiClient
  /** Open a location hash (default: location.hash = h). */
  navigate: (hash: string) => void
  onState: (s: ImportState) => void
  /** Job polling options (tests pass short sleeps). */
  job?: JobOptions
  signal?: AbortSignal
}

/**
 * Import a picked plan_inputs.json. Refused client-side when oversize or not the contract; then
 * POST /plans/import gives its hash: a known result opens #/plan/{hash}, otherwise the plan job is
 * submitted (startJob, the pad tool's job flow) and its result opens when done.
 */
export async function importPlanFile(file: FileLike, deps: ImportDeps): Promise<ImportState> {
  const set = (s: ImportState) => {
    deps.onState(s)
    return s
  }
  set({ kind: 'reading' })
  const check = await checkPlanInputsFile(file)
  if (!check.ok) return set({ kind: 'rejected', errors: check.errors })
  const inputs = check.inputs
  set({ kind: 'checking', inputs })
  let known: { hash: string; computed: boolean }
  try {
    const r = await deps.client.importPlan(inputs, { signal: deps.signal })
    known = { hash: r.hash, computed: r.computed === true }
  } catch (e) {
    if (e instanceof ApiError && e.transient) return set({ kind: 'offline', inputs, message: msg(e) })
    return set({ kind: 'failed', inputs, message: msg(e) })
  }
  if (known.computed) {
    deps.navigate(planUrl(known.hash))
    return set({ kind: 'opened', hash: known.hash, computed: true })
  }
  set({ kind: 'computing', inputs, job: null })
  const handle = startJob(deps.client, { type: 'plan', inputs }, { ...deps.job, onUpdate: (job) => set({ kind: 'computing', inputs, job }) })
  deps.signal?.addEventListener('abort', () => handle.cancel(), { once: true })
  const out: JobOutcome = await handle.promise
  if (out.status === 'cancelled') return set({ kind: 'idle' })
  if (out.status === 'failed') return set({ kind: 'failed', inputs, message: out.error })
  const hash = out.job.hash || known.hash
  deps.navigate(planUrl(hash))
  return set({ kind: 'opened', hash, computed: false })
}

// Route job (R5, D97 §3.5–3.6): the RouteJobs port of edit/route/controller.ts over the live client.
// Submit + poll is jobs.ts (startJob); each finished stage is read through stage.ts (loadStage, the
// contract-checking loader: one rendering path), and once done the run record answers whether the
// route as given is feasible (types.ts readFeasibility). A refused submit (422 for a bad stop, 429,
// 503) keeps its HTTP status, code and the stop it names, so the panel can say what is wrong.
import type { Feasibility as EditFeasibility, RouteFailure, RouteJobs, RouteOutcome, RouteStageView } from '../../edit/route/controller'
import { ApiError, type ApiClient } from '../client'
import { LIVE_LABEL } from '../config'
import { startJob, type JobOptions } from '../jobs'
import { planUrl } from '../plan'
import { loadStage, type LoaderFor, type StageResult } from '../stage'
import type { Job, PlanInputs } from '../types'
import { errorStop, readFeasibility, type Feasibility } from './types'

export interface RouteJobsOptions {
  client: ApiClient
  loaderFor?: LoaderFor
  job?: Pick<JobOptions, 'pollInitialMs' | 'pollFactor' | 'pollMaxMs'>
}

/** Layers present in a staged snapshot, in the order the panel reports them. */
export function stageLayers(r: StageResult): string[] {
  const out: string[] = []
  if (r.bands) out.push('bands')
  if (r.route) out.push('route')
  if (r.isochrones?.features.length) out.push('isochrones')
  if (r.edges?.features.length) out.push('edges')
  if (r.partner?.features.length) out.push('partner')
  return out
}

export function toEditFeasibility(f: Feasibility | null): EditFeasibility | null {
  if (!f) return null
  if (f.feasible) return { feasible: true }
  return { feasible: false, leg: f.leg, from: f.from, to: f.to, limit: f.limit, shortfallMin: Number.isFinite(f.shortfall_min) ? f.shortfall_min : null, legsPlanned: f.legs_planned ?? null }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A failed submit or poll as the panel shows it. */
export function failureOf(e: unknown, fallbackCode: string): RouteFailure {
  if (e instanceof ApiError) {
    const detail = typeof e.detail === 'string' ? e.detail : e.detail ? JSON.stringify(e.detail) : ''
    return { status: e.status, code: e.code, message: detail || e.message, stop: e.status === 422 ? errorStop({ stop: e.stop, detail: e.detail }) : null, retryAfterS: e.retryAfterS }
  }
  return { status: 0, code: fallbackCode, message: msg(e), stop: null, retryAfterS: null }
}

export function createRouteJobs(o: RouteJobsOptions): RouteJobs {
  return {
    run(inputs, cb) {
      // keep the submit's ApiError (status, detail): startJob reports only its code
      let submitError: unknown = null
      const client: ApiClient = {
        ...o.client,
        submitJob: (req, ro) =>
          o.client.submitJob(req, ro).catch((e: unknown) => {
            submitError = e
            throw e
          }),
      }
      let chain = Promise.resolve()
      let latest: StageResult | null = null
      const handle = startJob(
        client,
        { type: 'plan', inputs: inputs as unknown as PlanInputs },
        {
          ...o.job,
          onUpdate: (j: Job) => cb.onUpdate({ status: j.status, stage: j.stage ?? null, progress: j.progress, stagesDone: [...j.stages_done], hash: j.hash }),
          onStage: (_s, j, base) => {
            const stages = [...j.stages_done]
            chain = chain.then(async () => {
              const r = await loadStage(base, stages, o.loaderFor)
              latest = r
              cb.onStage(view(r))
            })
          },
        },
      )
      const promise = handle.promise.then(async (out): Promise<RouteOutcome> => {
        await chain.catch(() => {})
        if (out.status === 'cancelled') return { status: 'cancelled' }
        if (out.status === 'failed') {
          if (!out.job && submitError) return { status: 'failed', failure: failureOf(submitError, out.error) }
          return { status: 'failed', failure: { status: 0, code: out.error, message: out.job?.error ?? out.error, stop: null, retryAfterS: out.retryAfterS } }
        }
        // the done state may list no new stage: read the final tree once more
        if (!latest || latest.stages.length !== out.job.stages_done.length) {
          try {
            cb.onStage(view(await loadStage(out.resultBase, out.job.stages_done, o.loaderFor)))
          } catch {
            /* the run record still answers */
          }
        }
        let feasibility: EditFeasibility | null = null
        let recordError: string | null = null
        let label = LIVE_LABEL
        let engineCommit: string | null = null
        try {
          const rec = await o.client.provenance(out.job.hash)
          const f = readFeasibility(rec)
          feasibility = toEditFeasibility(f.value)
          recordError = f.error
          if (typeof rec.label === 'string' && rec.label) label = rec.label
          engineCommit = rec.engine?.commit ?? null
        } catch (e) {
          recordError = `run record unavailable: ${failureOf(e, 'network').message}`
        }
        return { status: 'done', result: { hash: out.job.hash, feasibility, label, provenanceHref: planUrl(out.job.hash, 'provenance'), engineCommit, recordError } }
      })
      return { promise, cancel: () => handle.cancel() }
    },
  }
}

function view(r: StageResult): RouteStageView {
  return { stages: r.stages, layers: stageLayers(r), errors: r.errors.map((e) => `${e.path}: ${e.message}`), data: r }
}

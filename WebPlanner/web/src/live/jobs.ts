// Heavy jobs (POST /jobs, GET /jobs/{id}): submit, then poll with backoff until the job is done,
// failed or out of time. Every request is short (CLIENT.requestTimeoutMs); nothing is held open.
// Staged results (F24): each stage in job.stages_done fires onStage once, in order, and its files
// are already readable under resultBase, so a view can load them while later stages run.
import { ApiError, type ApiClient } from './client'
import { CLIENT, JOB_TIMEOUT_MS } from './config'
import { JOB_FAILED_STATUSES, type Job, type JobRequest } from './types'

export type JobOutcome =
  | { status: 'done'; job: Job; resultBase: string }
  /** job: the last job state seen (null when the submit itself failed). */
  | { status: 'failed'; job: Job | null; error: string; retryAfterS: number | null }
  | { status: 'cancelled'; job: Job | null }

export interface JobCallbacks {
  /** Every job state seen (submit answer and each poll). */
  onUpdate?(job: Job): void
  /** A newly finished stage; its files are readable under resultBase. */
  onStage?(stage: string, job: Job, resultBase: string): void
}

export interface JobOptions extends JobCallbacks {
  signal?: AbortSignal
  pollInitialMs?: number
  pollFactor?: number
  pollMaxMs?: number
  /**
   * Client-side limit on a running job, counted from the first non-queued state. Default
   * compute.job_timeout_s plus one poll cap: the server reports 'timeout' itself before that.
   */
  runningTimeoutMs?: number
}

export interface JobHandle {
  readonly promise: Promise<JobOutcome>
  /** Stop polling and abort the request in flight (call on unmount). */
  cancel(): void
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function startJob(client: ApiClient, req: JobRequest, opts: JobOptions = {}): JobHandle {
  const ctl = new AbortController()
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort()
    else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true })
  }
  const promise = run(client, req, opts, ctl.signal)
  return { promise, cancel: () => ctl.abort() }
}

async function run(client: ApiClient, req: JobRequest, opts: JobOptions, signal: AbortSignal): Promise<JobOutcome> {
  const factor = opts.pollFactor ?? CLIENT.pollFactor
  const maxMs = opts.pollMaxMs ?? CLIENT.pollMaxMs
  const runningLimit = opts.runningTimeoutMs ?? JOB_TIMEOUT_MS + maxMs
  const seen = new Set<string>()
  const last: { job: Job | null } = { job: null }
  let runningSince: number | null = null

  const emit = (j: Job): Job => {
    last.job = j
    opts.onUpdate?.(j)
    if (runningSince === null && j.status !== 'queued') runningSince = Date.now()
    const base = j.stages_done.length || j.status === 'done' ? client.resultBase(j) : ''
    for (const st of j.stages_done) {
      if (seen.has(st)) continue
      seen.add(st)
      opts.onStage?.(st, j, base)
    }
    return j
  }
  const cancelled = (): JobOutcome => ({ status: 'cancelled', job: last.job })

  let j: Job
  try {
    j = emit(await client.submitJob(req, { signal }))
  } catch (e) {
    if (signal.aborted) return cancelled()
    const err = e instanceof ApiError ? e : new ApiError(0, 'network', String(e))
    return { status: 'failed', job: null, error: err.code, retryAfterS: err.retryAfterS }
  }

  let delay = opts.pollInitialMs ?? CLIENT.pollInitialMs
  let errors = 0
  for (;;) {
    if (j.status === 'done') return { status: 'done', job: j, resultBase: client.resultBase(j) }
    if (JOB_FAILED_STATUSES.includes(j.status)) {
      return { status: 'failed', job: j, error: j.error ?? j.status, retryAfterS: j.retry_after_s ?? null }
    }
    if (runningSince !== null && Date.now() - runningSince > runningLimit) {
      return { status: 'failed', job: j, error: 'client_timeout', retryAfterS: null }
    }
    const wait = Math.max(delay, (j.retry_after_s ?? 0) * 1000)
    await sleep(wait, signal)
    if (signal.aborted) return cancelled()
    delay = Math.min(delay * factor, maxMs)
    try {
      j = emit(await client.getJob(j.id, { signal }))
      errors = 0
    } catch (e) {
      if (signal.aborted) return cancelled()
      const err = e instanceof ApiError ? e : new ApiError(0, 'network', String(e))
      if (!err.transient || ++errors >= CLIENT.pollMaxErrors) {
        return { status: 'failed', job: j, error: err.code, retryAfterS: err.retryAfterS }
      }
      if (err.retryAfterS) delay = Math.max(delay, err.retryAfterS * 1000)
    }
  }
}

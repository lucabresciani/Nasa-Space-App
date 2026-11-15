// Fetch stub that answers like the live API from the mock fixtures (no msw, no dependency). Used by
// the vitest suites and, with VITE_LIVE_MOCK=1, as a tiny in-browser dev mock (index.ts).
import { API_PREFIX, UPLOAD_MAX_BYTES } from '../config'
import { canonicalJson } from '../planio'
import { validatePlanInputs } from '../schemacheck'
import type { ApiErrorBody, Defaults, Health, ImportResult, Job, JobRequest, LonLat, PadCheck, PadScreen, PlanInputs } from '../types'
import { crewJobScript, HEALTH_WARM, jobScript, mockDefaults, PLAN_INPUTS_OFFICIAL, RUN_RECORD_LIVE, RUN_RECORD_OFFICIAL, runRecordCrew } from './fixtures'
import { MOCK_OFFICIAL_HASH } from './hashes'
import { mockPadCheck, mockPadScreen } from './pads'
import { mockResultFile } from './result'

/**
 * Health behaviour: a Health body, a list of bodies served in turn (the last repeats), 'hang'
 * (never answers; only an abort ends it), 'down' (network error) or an HTTP error status.
 */
export type MockHealth = Health | Health[] | 'hang' | 'down' | { status: number }

export interface MockOptions {
  health?: MockHealth
  /** POST /jobs answers job[0]; each GET /jobs/{id} answers the next one (the last repeats). */
  job?: Job[]
  /** The script per request (ignored when `job` is set). Default jobScript() for every request. */
  jobFor?: (req: JobRequest) => Job[]
  /**
   * Crew jobs (F26; the dev mock turns this on): without `job`/`jobFor`, a request whose inputs carry
   * a crew block gets crewJobScript under a hash derived from its inputs (a new crew, a new hash)
   * and a run record with its range flags (runRecordCrew). Any other request gets jobScript().
   */
  crewJobs?: boolean
  /** GET /defaults answer (default mockDefaults(): config ranges, official inputs), or an HTTP error. */
  defaults?: Defaults | { status: number; body: ApiErrorBody }
  /** Answer POST /jobs with this HTTP error (e.g. 429 rate limited). */
  submitError?: { status: number; body: ApiErrorBody; retryAfter?: number }
  /** POST /pads/validate answer (default mockPadCheck: refused north of a latitude, else valid). */
  validate?: PadCheck | ((pad: LonLat) => PadCheck)
  /** POST /pads/screen answer (default mockPadScreen for the request's pad). */
  screen?: PadScreen | ((inputs: PlanInputs) => PadScreen)
  /** Answer POST /pads/* with this HTTP error instead (e.g. 503). */
  padError?: { status: number; body: ApiErrorBody }
  /**
   * GET /results/{hash}/{path}: the file once `stagesDone` (of the job state served last) have
   * finished, or null (404). Default: the staged mock tree (result.ts).
   */
  resultFile?: (path: string, stagesDone: readonly string[]) => unknown | null
  /**
   * GET /results/{hash}/provenance: run record per hash; any other hash answers 404 unknown_result.
   * Default: the live example's hash and MOCK_OFFICIAL_HASH (RUN_RECORD_OFFICIAL).
   */
  provenance?: Record<string, unknown>
  /**
   * Complete result trees served by hash (permalinks), ahead of the staged job tree. A file is a
   * document (sent as JSON), a string (sent as is) or null (404). E.g. the official hash -> the
   * static data tree.
   */
  trees?: Record<string, (path: string) => unknown | null | Promise<unknown | null>>
  /** POST /plans/import answer for a valid body (default: official inputs -> MOCK_OFFICIAL_HASH computed, else the job hash, not computed). */
  importAnswer?: (inputs: PlanInputs) => ImportResult
}

function isLonLat(v: unknown): v is LonLat {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o === 'object' && typeof o.lon === 'number' && typeof o.lat === 'number' && Object.keys(o).length === 2
}

export interface MockCall {
  method: string
  path: string
  body: unknown
}

export type MockFetch = ((input: string, init?: RequestInit) => Promise<Response>) & { calls: MockCall[] }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

const notFound = (path: string) => json(404, { error: 'not_found', detail: path } satisfies ApiErrorBody)

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
}

export function createMockFetch(opts: MockOptions = {}): MockFetch {
  const health = opts.health ?? HEALTH_WARM
  let script = opts.job ?? jobScript()
  const provenance: Record<string, unknown> = { ...(opts.provenance ?? { [(RUN_RECORD_LIVE as { hash: string }).hash]: RUN_RECORD_LIVE, [MOCK_OFFICIAL_HASH]: RUN_RECORD_OFFICIAL }) }
  const submitted = new Set<string>() // canonical inputs posted before: E7 attaches the same inputs
  const scriptFor = (req: JobRequest): Job[] => {
    if (opts.job) return opts.job
    if (opts.jobFor) return opts.jobFor(req)
    if (!opts.crewJobs || !req.inputs || typeof req.inputs.crew !== 'object') return jobScript()
    const hash = mockHash(canonicalJson({ ...req.inputs, title: undefined }))
    provenance[hash] ??= runRecordCrew(hash, filled(req.inputs))
    return crewJobScript(hash)
  }
  let healthIdx = 0
  let jobIdx = 0
  const calls: MockCall[] = []

  const fn = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase()
    const url = new URL(input, 'http://mock.invalid')
    const i = url.pathname.indexOf(`${API_PREFIX}/`)
    const path = i >= 0 ? url.pathname.slice(i + API_PREFIX.length) : url.pathname
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ method, path, body })

    if (method === 'GET' && path === '/health') {
      if (health === 'hang') return hang(init.signal)
      if (health === 'down') throw new TypeError('Failed to fetch')
      if (Array.isArray(health)) return json(200, health[Math.min(healthIdx++, health.length - 1)])
      if ('status' in health) return json(health.status, { error: 'unavailable' } satisfies ApiErrorBody)
      return json(200, health)
    }
    if (method === 'POST' && path === '/jobs') {
      if (opts.submitError) {
        const { status, body: eb, retryAfter } = opts.submitError
        return json(status, eb, retryAfter ? { 'Retry-After': String(retryAfter) } : {})
      }
      jobIdx = 0
      const req = body as JobRequest
      script = scriptFor(req)
      const key = canonicalJson({ ...(req?.inputs ?? {}), title: undefined })
      const again = submitted.has(key)
      submitted.add(key)
      return json(202, again ? { ...script[0], attached: true } : script[0])
    }
    const jm = /^\/jobs\/([^/]+)$/.exec(path)
    if (method === 'GET' && jm) {
      if (decodeURIComponent(jm[1]) !== script[0].id) return notFound(path)
      jobIdx = Math.min(jobIdx + 1, script.length - 1)
      return json(200, script[jobIdx])
    }
    if (method === 'GET' && path === '/defaults') {
      const d = opts.defaults ?? mockDefaults()
      return 'status' in d ? json(d.status, d.body) : json(200, d)
    }
    if (method === 'POST' && (path === '/pads/validate' || path === '/pads/screen')) {
      if (opts.padError) return json(opts.padError.status, opts.padError.body)
      if (path === '/pads/validate') {
        if (!isLonLat(body)) return json(422, { error: 'invalid_input', detail: 'body must be LonLat {lon, lat}' } satisfies ApiErrorBody)
        const v = opts.validate ?? mockPadCheck
        return json(200, typeof v === 'function' ? v(body) : v)
      }
      const pad = (body as { pad?: unknown } | null)?.pad as Record<string, unknown> | undefined
      if (!pad || typeof pad.lon !== 'number' || typeof pad.lat !== 'number') {
        return json(422, { error: 'invalid_input', detail: 'plan_inputs.pad {lon, lat} is required' } satisfies ApiErrorBody)
      }
      const sc = opts.screen ?? ((inp: PlanInputs) => mockPadScreen(inp.pad as LonLat))
      return json(200, typeof sc === 'function' ? sc(body as PlanInputs) : sc)
    }
    if (method === 'POST' && path === '/plans/import') {
      const raw = typeof init.body === 'string' ? init.body : ''
      if (new TextEncoder().encode(raw).length > UPLOAD_MAX_BYTES) return json(413, { error: 'too_large', detail: `limit ${UPLOAD_MAX_BYTES} bytes` } satisfies ApiErrorBody)
      const errs = validatePlanInputs(body)
      if (errs.length) return json(422, { error: 'invalid_input', detail: errs } satisfies ApiErrorBody)
      const inputs = body as PlanInputs
      const answer = opts.importAnswer ?? defaultImport((inp) => (opts.crewJobs ? scriptFor({ type: 'plan', inputs: inp })[0].hash : script[0].hash))
      return json(200, answer(inputs))
    }
    const pm = /^\/results\/([^/]+)\/provenance$/.exec(path)
    if (method === 'GET' && pm) {
      const rec = provenance[decodeURIComponent(pm[1])]
      return rec ? json(200, rec) : json(404, { error: 'unknown_result', detail: pm[1] } satisfies ApiErrorBody)
    }
    const rm = /^\/results\/([0-9a-f]{16})\/(.+)$/.exec(path)
    if (method === 'GET' && rm && opts.trees?.[rm[1]]) {
      const doc = await opts.trees[rm[1]](decodeURIComponent(rm[2]))
      if (doc === null || doc === undefined) return json(404, { error: 'file_not_found', detail: rm[2] } satisfies ApiErrorBody)
      return typeof doc === 'string' ? new Response(doc, { status: 200 }) : json(200, doc)
    }
    if (method === 'GET' && rm) {
      const job = script[jobIdx]
      if (rm[1] !== job.hash) return notFound(path)
      const doc = (opts.resultFile ?? mockResultFile)(decodeURIComponent(rm[2]), job.stages_done)
      return doc === null ? notFound(path) : json(200, doc)
    }
    return notFound(path)
  }
  return Object.assign(fn, { calls })
}

/** Default import answer: the official inputs (title ignored, as in the hash) are the precomputed official plan; anything else needs a job. */
function defaultImport(jobHash: (inputs: PlanInputs) => string): (inputs: PlanInputs) => ImportResult {
  const untitled = (p: PlanInputs) => canonicalJson({ ...p, title: undefined })
  const official = [untitled(RUN_RECORD_OFFICIAL.inputs), untitled(PLAN_INPUTS_OFFICIAL)]
  return (inputs) => (official.includes(untitled(inputs)) ? { hash: MOCK_OFFICIAL_HASH, inputs, computed: true } : { hash: jobHash(inputs), inputs, computed: false })
}

/** A placeholder 16-hex hash of a text (two FNV-1a 32-bit passes); the server's real hash is sha256 (E2). */
export function mockHash(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/** The inputs with the mock defaults filled, as a run record carries them. */
function filled(inputs: PlanInputs): PlanInputs {
  const d = mockDefaults().inputs
  return { ...d, ...inputs, crew: { ...(d.crew as object), ...(inputs.crew as object) } }
}

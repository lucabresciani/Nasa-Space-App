// Mock responses for the live API. Recorded ones are the contract examples themselves
// (contracts/backend/examples, referenced by openapi.yaml externalValue); the rest are derived
// from them or written to the schema where the contract has no example (Health). contract.test.ts
// validates every fixture against openapi.yaml. Hashes and numbers are placeholders, not results.
import jobQueuedExample from '../../../../contracts/backend/examples/job.queued.json'
import jobRunningExample from '../../../../contracts/backend/examples/job.running.json'
import planInputsOfficial from '../../../../contracts/backend/examples/plan_inputs.official.json'
import runRecordLive from '../../../../contracts/backend/examples/run_record.live.json'
import backendRaw from '../../../../config/backend.yaml'
import crewRaw from '../../../../config/crew.yaml'
import { cfg } from '../../config'
import { BACKEND_CONTRACT_VERSION, PRECOMPUTED_LABEL } from '../config'
import { CREW_FIELDS } from '../crew'
import type { Defaults, Health, Job, PlanInputs, RangeSpec, RunRecord } from '../types'
import { MOCK_CREW_HASH, MOCK_OFFICIAL_HASH } from './hashes'

export const HEALTH_WARM: Health = { ok: true, engine_warm: true, queue_length: 0, heavy_jobs: 'on' }
export const HEALTH_COLD: Health = { ok: true, engine_warm: false, queue_length: 0, heavy_jobs: 'on' }
export const HEALTH_NOT_OK: Health = { ok: false, engine_warm: false, queue_length: 0, heavy_jobs: 'on' }

/** Recorded: contracts/backend/examples/job.queued.json (POST /jobs 202 example). */
export const JOB_QUEUED = jobQueuedExample as Job
/** Recorded: contracts/backend/examples/job.running.json (GET /jobs/{id} 200 example). */
export const JOB_RUNNING = jobRunningExample as Job

/**
 * Stage names of the mock plan job. The contract leaves stage names free (job.schema.json); the
 * first two are the examples' ('nominal', 'bands'), the third stands for F24's last stage (HUD
 * fields, partner line, horizon). The client treats stage names as opaque strings.
 */
export const MOCK_STAGES = ['nominal', 'bands', 'hud'] as const

const RESULT_URL = JOB_RUNNING.result_url ?? null

/** Derived from the examples: queued -> one running state per stage -> done. */
export function jobScript(stages: readonly string[] = MOCK_STAGES): Job[] {
  const out: Job[] = [{ ...JOB_QUEUED }]
  stages.forEach((stage, i) => {
    out.push({
      ...JOB_RUNNING,
      stage,
      progress: i / stages.length,
      stages_done: stages.slice(0, i),
      result_url: i > 0 ? RESULT_URL : null,
    })
  })
  out.push({ ...JOB_RUNNING, status: 'done', stage: null, progress: 1, stages_done: [...stages], result_url: RESULT_URL })
  return out
}

/** Derived: a job that fails during its second stage. */
export function failedJobScript(error = 'engine_error: no route within the walkback budget'): Job[] {
  const s = jobScript()
  return [s[0], s[1], s[2], { ...s[2], status: 'error', stage: null, error }]
}

export const PLAN_INPUTS_OFFICIAL = planInputsOfficial as PlanInputs
export const RUN_RECORD_LIVE: unknown = runRecordLive

/**
 * Derived: the run record of the official (precomputed) tree, as E3 synthesises it
 * (server/engine/results.py precomputed_run_record): origin precomputed, labels.precomputed, the
 * official inputs, no stages. Engine ids and hashes are the example's placeholders.
 */
export const RUN_RECORD_OFFICIAL: RunRecord = {
  ...(runRecordLive as RunRecord),
  hash: MOCK_OFFICIAL_HASH,
  origin: 'precomputed',
  label: PRECOMPUTED_LABEL,
  inputs: { ...(planInputsOfficial as PlanInputs), stations: { mode: 'best' } },
  stages: [],
  files: [],
  range_flags: [],
  infeasible: null,
  error: null,
  dummy: false,
}

// --- crew panel (F26): GET /defaults and a custom-crew job ---

type RawRange = { min: number; max: number; default?: number | number[]; default_ref?: string; precomputed?: number[]; assumed?: boolean }
const CONFIG_FILES: Record<string, unknown> = { crew: crewRaw, backend: backendRaw }

/** config/backend.yaml ranges with each default_ref resolved, as server/engine/defaults.py ranges() does. */
function resolvedRanges(): Record<string, unknown> {
  const raw = cfg<Record<string, unknown>>(backendRaw, 'ranges')
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') {
      out[k] = v
      continue
    }
    const { default_ref, ...r } = v as RawRange
    let def = r.default
    if (default_ref) {
      const [file, ...path] = default_ref.split('.')
      def = cfg<number>(CONFIG_FILES[file], path.join('.'))
    }
    out[k] = { ...r, ...(def !== undefined ? { default: def } : {}) } satisfies RangeSpec
  }
  return out
}

/**
 * GET /defaults, written to the openapi Defaults schema from config (no contract example exists):
 * ranges as the server resolves them, inputs = the official example with the crew and EVA defaults
 * filled. stations and pads are left empty (the crew panel does not read them).
 */
export function mockDefaults(): Defaults {
  const ranges = resolvedRanges()
  const def = (k: string) => (ranges[k] as RangeSpec).default as number
  const crew = Object.fromEntries([...CREW_FIELDS, 'suit_kg'].map((f) => [f, def(f)]))
  const { title: _t, ...official } = PLAN_INPUTS_OFFICIAL as PlanInputs & { title?: string }
  void _t
  return {
    inputs: {
      ...official,
      contract_version: BACKEND_CONTRACT_VERSION,
      crew,
      eva: { reserve_min: def('reserve_min'), walkback_budgets_min: (ranges.walkback_budget_min as RangeSpec).default },
    },
    ranges,
    stations: [],
    pads: [],
  }
}

/** The mock's custom crew: carried tools 5 kg above the config range (flagged, never clamped). */
export function mockCrewInputs(): PlanInputs {
  const tools = (resolvedRanges().tools_kg as RangeSpec).max + 5
  return { ...mockDefaults().inputs, crew: { ...(mockDefaults().inputs.crew as object), tools_kg: tools } }
}

/** The custom-crew job: the plan script under another hash and job id. */
export function crewJobScript(hash = MOCK_CREW_HASH, id = `job-${hash}`): Job[] {
  return jobScript().map((j) => ({ ...j, id, hash, result_url: j.result_url ? j.result_url.replace(JOB_RUNNING.hash, hash) : j.result_url }))
}

/** Derived from the live example: the run record of the custom-crew job, with its range flag. */
export function runRecordCrew(hash = MOCK_CREW_HASH, inputs: PlanInputs = mockCrewInputs()): RunRecord {
  const note = cfg<string>(backendRaw, 'ranges.anchored_flag_note')
  const ranges = resolvedRanges()
  const crew = (inputs.crew ?? {}) as Record<string, number>
  const range_flags = Object.entries(crew)
    .filter(([k, v]) => {
      const r = ranges[k] as RangeSpec | undefined
      return r && (v < r.min || v > r.max)
    })
    .map(([k, v]) => ({ key: `crew.${k}`, value: v, note }))
  return { ...(runRecordLive as RunRecord), hash, inputs, range_flags }
}

// The hand-written API types and every mock response checked against contracts/backend/openapi.yaml
// (v1.0.1, frozen). Light check: $refs are inlined, then the app's own JSON Schema subset checker
// (src/data/schema.ts) runs; a keyword it does not know fails the test instead of passing silently.
import { describe, expect, it } from 'vitest'
import openapi from '../../../contracts/backend/openapi.yaml'
import jobSchema from '../../../contracts/backend/job.schema.json'
import planInputsSchema from '../../../contracts/backend/plan_inputs.schema.json'
import runRecordSchema from '../../../contracts/backend/run_record.schema.json'
import telemetrySchema from '../../../contracts/backend/telemetry.schema.json'
import { checkSchema, SUPPORTED_KEYWORDS, type JsonSchema } from '../data/schema'
import { validate } from './schemacheck'
import { createApiClient } from './client'
import { HEALTH_COLD, HEALTH_NOT_OK, HEALTH_WARM, failedJobScript, jobScript, PLAN_INPUTS_OFFICIAL, RUN_RECORD_LIVE, RUN_RECORD_OFFICIAL } from './mock/fixtures'
import { MOCK_OFFICIAL_HASH } from './mock/hashes'
import { MOCK_RESULT_SCENARIO, mockFinishedTree, withSimPlan } from './mock/result'
import customExample from '../../../contracts/backend/examples/plan_inputs.custom.json'
import runRecordSchemaRaw from '../../../contracts/backend/run_record.schema.json'
import { RUN_RECORD_SCHEMA, validatePlanInputs, validateRunRecord } from './schemacheck'
import { createMockFetch } from './mock/fetch'
import { MOCK_PAD_INVALID, MOCK_PAD_VALID, mockPadScreen, PAD_CHECK_INVALID, PAD_CHECK_VALID } from './mock/pads'
import { MOCK_RESULT_STAGES, mockResultDocs } from './mock/result'
import { planInputsFor } from './padtool'
import { schemaFor } from '../data/contracts'
import { MOCK_STAGES } from './mock/fixtures'
import { crewJobScript, mockCrewInputs, mockDefaults, runRecordCrew } from './mock/fixtures'
import { MOCK_CREW_HASH } from './mock/hashes'
import { jobPlanInputs } from './padtool'
import {
  DEFAULTS_KEYS, ENGINE_VERSION_KEYS, ERROR_KEYS, HEALTH_KEYS, IMPORT_RESULT_KEYS, JOB_KEYS, JOB_REQUEST_KEYS, JOB_STATUSES, JOB_TYPES,
  PAD_CHECK_KEYS, PAD_REASONS, PAD_SCREEN_KEYS, RUN_ORIGINS, RUN_RECORD_KEYS, RUN_STATUSES,
} from './types'

type Doc = Record<string, unknown>
const DOCS: Record<string, Doc> = {
  'openapi.yaml': openapi as Doc,
  'job.schema.json': jobSchema as Doc,
  'plan_inputs.schema.json': planInputsSchema as Doc,
  'run_record.schema.json': runRecordSchema as Doc,
  'telemetry.schema.json': telemetrySchema as Doc,
}

function pointer(doc: Doc, ptr: string): unknown {
  let cur: unknown = doc
  for (const part of ptr.replace(/^\//, '').split('/').filter(Boolean)) cur = (cur as Doc)[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  if (cur === undefined) throw new Error(`unresolved pointer ${ptr}`)
  return cur
}

/** Inline every $ref (local and to the sibling contract files); siblings of a $ref are kept via allOf. */
function deref(node: unknown, file: string, depth = 0): unknown {
  if (depth > 50) throw new Error('$ref cycle')
  if (Array.isArray(node)) return node.map((n) => deref(n, file, depth))
  if (!node || typeof node !== 'object') return node
  const o = node as Doc
  if (typeof o.$ref === 'string') {
    const [target, frag = ''] = o.$ref.split('#')
    const tfile = target || file
    const doc = DOCS[tfile]
    if (!doc) throw new Error(`unknown $ref file ${tfile}`)
    const resolved = deref(frag ? pointer(doc, frag) : doc, tfile, depth + 1)
    const { $ref: _ignored, ...rest } = o
    void _ignored
    return Object.keys(rest).length ? { ...(deref(rest, file, depth) as Doc), allOf: [resolved] } : resolved
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'properties' ? derefMap(v, file, depth) : deref(v, file, depth)]))
}
function derefMap(v: unknown, file: string, depth: number): unknown {
  return Object.fromEntries(Object.entries(v as Doc).map(([k, s]) => [k, deref(s, file, depth)]))
}

function keywordsIn(s: unknown, out = new Set<string>(), namesOnly = false): Set<string> {
  if (Array.isArray(s)) s.forEach((x) => keywordsIn(x, out))
  else if (s && typeof s === 'object') {
    for (const [k, v] of Object.entries(s as Doc)) {
      if (namesOnly) keywordsIn(v, out)
      else {
        out.add(k)
        // property names and $defs names are not keywords; enum/const values are data
        if (k === 'enum' || k === 'const' || k === 'examples') continue
        keywordsIn(v, out, k === 'properties' || k === '$defs')
      }
    }
  }
  return out
}

// Keywords plan_inputs/run_record use beyond the app checker's subset, checked here (test only).
const EXTRA = new Set(['oneOf', 'uniqueItems', 'propertyNames'])
const OPENAPI_ANNOTATIONS = new Set(['$defs', 'contentMediaType'])
function assertKnown(s: JsonSchema, what: string): JsonSchema {
  const unknown = [...keywordsIn(s)].filter((k) => !SUPPORTED_KEYWORDS.has(k) && !OPENAPI_ANNOTATIONS.has(k) && !EXTRA.has(k))
  expect(unknown, `${what} uses keywords this light check does not support`).toEqual([])
  return s
}
function schemaOf(ref: string): JsonSchema {
  return assertKnown(deref({ $ref: ref }, 'openapi.yaml') as JsonSchema, ref)
}
function responseSchema(method: string, path: string, status: number): JsonSchema {
  const op = pointer(openapi as Doc, `/paths/${path.replace(/\//g, '~1')}/${method.toLowerCase()}`) as Doc
  const resp = deref((op.responses as Doc)[String(status)], 'openapi.yaml') as Doc
  return assertKnown(pointer(resp, '/content/application~1json/schema') as JsonSchema, `${method} ${path} ${status}`)
}

const valid = (v: unknown, s: JsonSchema) => expect(validate(v, s)).toEqual([])

describe('hand-written types match openapi.yaml', () => {
  const cases: [string, Record<string, 'required' | 'optional'>][] = [
    ['Health', HEALTH_KEYS], ['Job', JOB_KEYS], ['Error', ERROR_KEYS], ['JobRequest', JOB_REQUEST_KEYS],
    ['PadCheck', PAD_CHECK_KEYS], ['PadScreen', PAD_SCREEN_KEYS], ['EngineVersion', ENGINE_VERSION_KEYS],
    ['ImportResult', IMPORT_RESULT_KEYS], ['Defaults', DEFAULTS_KEYS],
  ]
  it.each(cases)('%s: same properties and required list', (name, keys) => {
    const s = schemaOf(`#/components/schemas/${name}`) as Doc
    expect(Object.keys(keys).sort()).toEqual(Object.keys(s.properties as Doc).sort())
    const required = Object.entries(keys).filter(([, r]) => r === 'required').map(([k]) => k).sort()
    expect(required).toEqual([...((s.required as string[]) ?? [])].sort())
  })
  it('enums: job type, job status, pad reason', () => {
    const job = schemaOf('#/components/schemas/Job') as { properties: Record<string, { enum: unknown[] }> }
    expect([...JOB_TYPES]).toEqual(job.properties.type.enum)
    expect([...JOB_STATUSES]).toEqual(job.properties.status.enum)
    const pad = schemaOf('#/components/schemas/PadCheck') as { properties: Record<string, { enum: unknown[] }> }
    expect([...PAD_REASONS]).toEqual(pad.properties.reason.enum)
  })
  it('the check is not vacuous: bad documents fail', () => {
    const job = schemaOf('#/components/schemas/Job')
    expect(validate({ ...jobScript()[0], status: 'finished' }, job)).not.toEqual([])
    expect(validate({ ...jobScript()[0], extra: 1 }, job)).not.toEqual([])
    const req = schemaOf('#/components/schemas/JobRequest')
    expect(validate({ type: 'plan', inputs: { ...PLAN_INPUTS_OFFICIAL, pad: 'x' } }, req)).not.toEqual([])
    expect(validate({ type: 'plan' }, req)).not.toEqual([])
  })
  it('contract version is 1.2.0 (additive bump: route, D97)', () => {
    expect((openapi as { info: { version: string } }).info.version).toBe('1.2.0')
  })
})

describe('every mock response validates against openapi.yaml', () => {
  it('health fixtures (GET /health 200)', () => {
    const s = responseSchema('GET', '/health', 200)
    for (const h of [HEALTH_WARM, HEALTH_COLD, HEALTH_NOT_OK]) valid(h, s)
  })
  it('job scripts (POST /jobs 202, GET /jobs/{id} 200)', () => {
    const post = responseSchema('POST', '/jobs', 202)
    const get = responseSchema('GET', '/jobs/{id}', 200)
    for (const script of [jobScript(), failedJobScript()]) {
      valid(script[0], post)
      for (const j of script.slice(1)) valid(j, get)
    }
  })
  it('run record (GET /results/{hash}/provenance 200)', () => {
    valid(RUN_RECORD_LIVE, responseSchema('GET', '/results/{hash}/provenance', 200))
  })
  it('error answers of the mock (404, 429, 503) are Error documents', () => {
    const err = schemaOf('#/components/schemas/Error')
    valid({ error: 'not_found', detail: '/x' }, err)
    valid({ error: 'rate_limited', retry_after_s: 42 }, responseSchema('POST', '/jobs', 429))
    valid({ error: 'unavailable' }, err)
  })

  it('live mock answers over HTTP, and the client request bodies, validate', async () => {
    const fetch = createMockFetch()
    const client = createApiClient({ base: 'http://api.test', fetch })
    valid(await client.health(), responseSchema('GET', '/health', 200))
    const req = { type: 'plan' as const, inputs: PLAN_INPUTS_OFFICIAL }
    const job = await client.submitJob(req)
    valid(job, responseSchema('POST', '/jobs', 202))
    valid(await client.getJob(job.id), responseSchema('GET', '/jobs/{id}', 200))
    // request body: JobRequest (with the plan_inputs contract inlined)
    valid(fetch.calls[1].body, schemaOf('#/components/schemas/JobRequest'))
    // unknown paths answer an Error 404
    await expect(client.engineVersion()).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })
})

describe('pad tool mocks (F24) validate against openapi.yaml', () => {
  it('PadCheck answers (POST /pads/validate 200): valid and one per reason code', () => {
    const s = responseSchema('POST', '/pads/validate', 200)
    valid(PAD_CHECK_VALID, s)
    const reasons = Object.keys(PAD_CHECK_INVALID)
    expect(reasons.sort()).toEqual(PAD_REASONS.filter((r) => r !== null).sort())
    for (const c of Object.values(PAD_CHECK_INVALID)) valid(c, s)
    expect(validate({ valid: false, reason: 'too_steep' }, s)).not.toEqual([])
  })
  it('PadScreen answer (POST /pads/screen 200)', () => {
    valid(mockPadScreen(MOCK_PAD_VALID), responseSchema('POST', '/pads/screen', 200))
  })
  it('the pad tool request bodies: LonLat, plan_inputs, JobRequest', async () => {
    const fetch = createMockFetch()
    const client = createApiClient({ base: 'http://api.test', fetch })
    valid(await client.validatePad(MOCK_PAD_INVALID), responseSchema('POST', '/pads/validate', 200))
    valid(await client.screenPad(planInputsFor(MOCK_PAD_VALID)), responseSchema('POST', '/pads/screen', 200))
    valid(fetch.calls[0].body, schemaOf('#/components/schemas/LonLat'))
    valid(fetch.calls[1].body, schemaOf('#/components/schemas/PlanInputs'))
    valid({ type: 'plan', inputs: planInputsFor(MOCK_PAD_VALID, PLAN_INPUTS_OFFICIAL) }, schemaOf('#/components/schemas/JobRequest'))
  })
  it('bad pad requests get 422 Error documents', async () => {
    const fetch = createMockFetch()
    const res = await fetch('http://api.test/api/v1/pads/validate', { method: 'POST', body: JSON.stringify({ lon: 1 }) })
    expect(res.status).toBe(422)
    valid(await res.json(), responseSchema('POST', '/pads/validate', 422))
    const res2 = await fetch('http://api.test/api/v1/pads/screen', { method: 'POST', body: JSON.stringify({ contract_version: '1.0.1' }) })
    expect(res2.status).toBe(422)
    valid(await res2.json(), responseSchema('POST', '/pads/screen', 422))
  })
  it('every staged result file validates against its static contract (contracts/*.schema.json)', () => {
    expect(Object.keys(MOCK_RESULT_STAGES)).toEqual([...MOCK_STAGES])
    const docs = mockResultDocs()
    expect(docs.length).toBeGreaterThanOrEqual(9)
    for (const { stage, path, doc } of docs) {
      const s = schemaFor(path)
      expect(s, `${stage}: ${path} has a contract`).toBeDefined()
      expect(checkSchema(doc, s!), `${stage}: ${path}`).toEqual([])
    }
  })
  it('result files are served only once their stage is done', async () => {
    const fetch = createMockFetch()
    const client = createApiClient({ base: 'http://api.test', fetch })
    const get = (p: string) => fetch(`http://api.test/api/v1/results/0123456789abcdef/${p}`)
    expect((await get('scenarios/index.json')).status).toBe(404)
    const job = await client.submitJob({ type: 'plan', inputs: planInputsFor(MOCK_PAD_VALID) })
    await client.getJob(job.id) // running 'nominal', nothing done
    expect((await get('manifest.json')).status).toBe(404)
    await client.getJob(job.id) // 'nominal' done
    expect((await get('manifest.json')).status).toBe(200)
    expect((await get('scenarios/nom_104/partner.geojson')).status).toBe(404)
    await client.getJob(job.id)
    await client.getJob(job.id) // done
    expect((await get('scenarios/nom_104/partner.geojson')).status).toBe(200)
    expect((await fetch('http://api.test/api/v1/results/ffffffffffffffff/manifest.json')).status).toBe(404)
  })
})

describe('permalink, provenance and import mocks (U3: F28, F35, D76) validate', () => {
  it('RunRecord type matches run_record.schema.json (properties, required, enums)', () => {
    const rs = runRecordSchemaRaw as { properties: Record<string, { enum?: unknown[] }>; required: string[] }
    expect(Object.keys(RUN_RECORD_KEYS).sort()).toEqual(Object.keys(rs.properties).sort())
    expect(Object.entries(RUN_RECORD_KEYS).filter(([, r]) => r === 'required').map(([k]) => k).sort()).toEqual([...rs.required].sort())
    expect([...RUN_ORIGINS]).toEqual(rs.properties.origin.enum)
    expect([...RUN_STATUSES]).toEqual(rs.properties.status.enum)
  })
  it('both run records (GET /results/{hash}/provenance 200), also with the client-side check', () => {
    const s = responseSchema('GET', '/results/{hash}/provenance', 200)
    for (const r of [RUN_RECORD_LIVE, RUN_RECORD_OFFICIAL]) {
      valid(r, s)
      expect(validateRunRecord(r)).toEqual([])
    }
    assertKnown(RUN_RECORD_SCHEMA, 'run_record (client-side)')
    expect(validateRunRecord({ ...RUN_RECORD_OFFICIAL, origin: 'guessed' })).not.toEqual([])
    expect(validateRunRecord({ ...RUN_RECORD_OFFICIAL, inputs: { ...RUN_RECORD_OFFICIAL.inputs, extra: 1 } })).not.toEqual([])
  })
  it('provenance 404, import 200 / 422 / 413 answers', async () => {
    const fetch = createMockFetch()
    const client = createApiClient({ base: 'http://api.test', fetch })
    const nf = await fetch('http://api.test/api/v1/results/ffffffffffffffff/provenance')
    expect(nf.status).toBe(404)
    valid(await nf.json(), responseSchema('GET', '/results/{hash}/provenance', 404))
    const known = await client.importPlan(PLAN_INPUTS_OFFICIAL)
    valid(known, responseSchema('POST', '/plans/import', 200))
    expect(known).toMatchObject({ hash: MOCK_OFFICIAL_HASH, computed: true })
    const fresh = await client.importPlan(customExample)
    valid(fresh, responseSchema('POST', '/plans/import', 200))
    expect(fresh.computed).toBe(false)
    valid(fetch.calls[1].body, schemaOf('#/components/schemas/PlanInputs'))
    const bad = await fetch('http://api.test/api/v1/plans/import', { method: 'POST', body: JSON.stringify({ ...PLAN_INPUTS_OFFICIAL, x: 1 }) })
    expect(bad.status).toBe(422)
    valid(await bad.json(), responseSchema('POST', '/plans/import', 422))
    const big = await fetch('http://api.test/api/v1/plans/import', { method: 'POST', body: JSON.stringify({ ...PLAN_INPUTS_OFFICIAL, title: 'x'.repeat(1_100_000) }) })
    expect(big.status).toBe(413)
    valid(await big.json(), responseSchema('POST', '/plans/import', 413))
  })
  it('the client-side plan_inputs check agrees with the openapi PlanInputs schema on the examples', () => {
    const s = schemaOf('#/components/schemas/PlanInputs')
    for (const x of [PLAN_INPUTS_OFFICIAL, customExample, RUN_RECORD_OFFICIAL.inputs]) {
      valid(x, s)
      expect(validatePlanInputs(x)).toEqual([])
    }
  })
  it('result manifest with and without a sim_plan entry validates against manifest.schema.json', () => {
    const s = schemaFor('manifest.json')!
    for (const sim of [false, true]) {
      const m = mockFinishedTree(sim)('manifest.json')
      expect(checkSchema(m, s)).toEqual([])
      const kinds = Object.values(m as Record<string, { kind?: string }>).map((e) => e.kind)
      expect(kinds.includes('sim_plan')).toBe(sim)
    }
    expect(Object.keys(withSimPlan({} as never))).toEqual([`sim.${MOCK_RESULT_SCENARIO}.export`])
  })
})

describe('crew panel mocks (U4: F26) validate against openapi.yaml v1.1.0', () => {
  it('GET /defaults 200: the mock body, also over HTTP', async () => {
    const s = responseSchema('GET', '/defaults', 200)
    valid(mockDefaults(), s)
    const client = createApiClient({ base: 'http://api.test', fetch: createMockFetch() })
    valid(await client.defaults(), s)
    expect(validatePlanInputs(mockDefaults().inputs)).toEqual([])
  })
  it('the check is not vacuous: a Defaults body without ranges fails', () => {
    const { ranges: _r, ...rest } = mockDefaults()
    void _r
    expect(validate(rest, responseSchema('GET', '/defaults', 200))).not.toEqual([])
  })
  it('crew job script (POST /jobs 202, GET /jobs/{id} 200)', () => {
    const s = crewJobScript()
    valid(s[0], responseSchema('POST', '/jobs', 202))
    for (const j of s.slice(1)) valid(j, responseSchema('GET', '/jobs/{id}', 200))
  })
  it('crew run record with its range flag (GET /results/{hash}/provenance 200), also client-side', () => {
    const rec = runRecordCrew()
    expect(rec.hash).toBe(MOCK_CREW_HASH)
    expect(rec.range_flags!.length).toBeGreaterThan(0)
    valid(rec, responseSchema('GET', '/results/{hash}/provenance', 200))
    expect(validateRunRecord(rec)).toEqual([])
  })
  it('the crew job request body (only changed fields) is a JobRequest and a plan_inputs', async () => {
    const f = createMockFetch({ crewJobs: true })
    const client = createApiClient({ base: 'http://api.test', fetch: f })
    const inputs = jobPlanInputs(MOCK_PAD_VALID, {}, { crew: { tools_kg: (mockCrewInputs().crew as { tools_kg: number }).tools_kg } })
    const job = await client.submitJob({ type: 'plan', inputs })
    valid(job, responseSchema('POST', '/jobs', 202))
    valid(f.calls[0].body, schemaOf('#/components/schemas/JobRequest'))
    expect(validatePlanInputs(inputs)).toEqual([])
    valid(await client.provenance(job.hash), responseSchema('GET', '/results/{hash}/provenance', 200))
  })
})

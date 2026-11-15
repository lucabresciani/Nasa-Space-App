// Known answers for the crew panel (F26, WS13 brief task 6; U4): defaults and ranges come from
// GET /defaults (never typed in the client); an out-of-range value is flagged before submit and sent
// unclamped; the job gets only the changed crew fields, in U3's canonical key order; suit mass and
// O2 reserve are not editable; the run record's range flags show on the result and in the
// provenance view; the panel hides while offline; export/import keeps the crew block byte for byte;
// a new crew gives a new hash and job, the same inputs attach (E7).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { LIVE_LABEL } from './config'
import { checkField, createCrew, CREW_FIELDS, crewBlock, crewSpecFrom, EXTRAPOLATION_TEXT, FIXED_TEXT, type CrewModel } from './crew'
import { CrewPanel, crewBlockedText } from './crewview'
import type { LiveState } from './health'
import type { MapPort } from './mapPort'
import { crewJobScript, HEALTH_WARM, mockCrewInputs, mockDefaults, PLAN_INPUTS_OFFICIAL, runRecordCrew } from './mock/fixtures'
import { createMockFetch, type MockFetch, type MockOptions } from './mock/fetch'
import { MOCK_CREW_HASH } from './mock/hashes'
import { MOCK_PAD_VALID } from './mock/pads'
import { mockFinishedTree } from './mock/result'
import { createPadTool, type PadTool } from './padtool'
import { importPlanFile, loadPlan } from './plan'
import { checkPlanInputsText, exportPlanInputs } from './planio'
import { PlanPage, ProvenancePage } from './planview'
import { mockLiveLoader } from './result'
import { textOf, toHtml } from './testing/html'
import type { Defaults, JobRequest, PlanInputs } from './types'
import { PadToolPanel } from './view'

const READY: LiveState = { kind: 'ready', health: HEALTH_WARM }
const OFFLINE: LiveState = { kind: 'offline', reason: 'unreachable' }
const ENGINE_HREF = 'http://api.test/api/v1/engine/version'

/** A /defaults body with ranges no config file has: if the panel shows these, nothing is hard-coded. */
function oddDefaults(): Defaults {
  const d = mockDefaults()
  return {
    ...d,
    inputs: { ...d.inputs, crew: { body_mass_kg: 77, suit_kg: 104, tools_kg: 12, vo2max_ml_kg_min: 41, effort_cap_frac: 0.55 }, eva: { reserve_min: 30 } },
    ranges: {
      ...d.ranges,
      body_mass_kg: { min: 41, max: 99, default: 77 },
      tools_kg: { min: 2, max: 22, default: 12 },
      vo2max_ml_kg_min: { min: 31, max: 59, default: 41 },
      effort_cap_frac: { min: 0.42, max: 0.68, default: 0.55 },
    },
  }
}

const port: MapPort = { onClick: () => () => {}, setLivePad: () => {}, setScenarioData: async () => {}, setRoute: async () => {}, restoreStatic: () => {} }

let fetch: MockFetch
function setup(mock: MockOptions = {}) {
  fetch = createMockFetch({ crewJobs: true, ...mock })
  vi.stubGlobal('fetch', fetch) // liveLoader reads result files with the global fetch
  const client = createApiClient({ base: 'http://api.test', fetch })
  const crew = createCrew({ client })
  const tool = createPadTool({ client, port, jobInputs: () => crew.jobInputs(), job: { pollInitialMs: 20, pollFactor: 1, pollMaxMs: 20 } })
  crew.setLive(READY)
  tool.setLive(READY)
  return { client, crew, tool }
}

const crewText = (crew: CrewModel) => textOf(<CrewPanel state={crew.state} actions={crew} engineHref={ENGINE_HREF} />)
const crewHtml = (crew: CrewModel) => toHtml(<CrewPanel state={crew.state} actions={crew} engineHref={ENGINE_HREF} />)
const toolText = (tool: PadTool, crew: CrewModel) =>
  textOf(<PadToolPanel state={tool.state} actions={tool} engineHref={ENGINE_HREF} computeBlocked={crewBlockedText(crew.state)} />)
const posts = (path: string) => fetch.calls.filter((c) => c.method === 'POST' && c.path === path)
const jobBodies = () => posts('/jobs').map((c) => c.body as JobRequest)

async function until(pred: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}
async function ready(crew: CrewModel) {
  await until(() => crew.state.defaults.kind === 'ready')
}
async function validPad(tool: PadTool) {
  tool.click(MOCK_PAD_VALID)
  await until(() => tool.state.preview.kind === 'done')
}
async function plan(tool: PadTool, n: number) {
  tool.computePlan()
  await until(() => posts('/jobs').length === n && tool.state.plan.kind === 'done' && tool.state.record.kind !== 'loading' && tool.state.record.kind !== 'idle')
}

afterEach(() => vi.unstubAllGlobals())

describe('crew panel: defaults and ranges come from GET /defaults', () => {
  it('shows the /defaults ranges and default values, not any typed in the client', async () => {
    const { crew } = setup({ defaults: oddDefaults() })
    await ready(crew)
    expect(fetch.calls.filter((c) => c.path === '/defaults')).toHaveLength(1)
    if (crew.state.defaults.kind !== 'ready') throw new Error('not ready')
    const spec = crew.state.defaults.spec
    expect(spec.fields.body_mass_kg).toEqual({ min: 41, max: 99, default: 77 })
    expect(spec.fields.effort_cap_frac).toEqual({ min: 0.42, max: 0.68, default: 0.55 })
    const t = crewText(crew)
    expect(t).toContain('Validated range 41 to 99 kg, default 77')
    expect(t).toContain('Validated range 2 to 22 kg, default 12')
    expect(t).toContain('Validated range 31 to 59 mL/kg/min, default 41')
    expect(t).toContain('Validated range 0.42 to 0.68 fraction of VO2max, default 0.55')
    const h = crewHtml(crew)
    expect(h).toContain('name="body_mass_kg" type="number" step="any" inputMode="decimal" value="77"')
    expect(h).toContain('name="effort_cap_frac" type="number" step="any" inputMode="decimal" value="0.55"')
  })

  it('the default mock /defaults is config/backend.yaml ranges with crew.yaml defaults', () => {
    const spec = crewSpecFrom(mockDefaults())
    expect(spec.fields.body_mass_kg).toEqual({ min: 50, max: 100, default: 75 })
    expect(spec.fields.tools_kg).toEqual({ min: 0, max: 30, default: 10 })
    expect(spec.suitKg).toBe(104)
    expect(spec.reserveMin).toBe(30)
  })

  it('an incomplete /defaults is an error, never a guessed range', () => {
    const d = mockDefaults()
    const { tools_kg: _t, ...ranges } = d.ranges
    void _t
    expect(() => crewSpecFrom({ ...d, ranges })).toThrow('GET /defaults has no range for crew.tools_kg')
  })

  it('/defaults failing: the panel says so and plans use the server defaults (no crew block)', async () => {
    const { crew, tool } = setup({ defaults: { status: 503, body: { error: 'server_data_missing' } } })
    await until(() => crew.state.defaults.kind === 'error')
    expect(crewText(crew)).toContain('No crew defaults from the server (server_data_missing (HTTP 503))')
    expect(crewHtml(crew)).not.toContain('<input')
    await validPad(tool)
    await plan(tool, 1)
    expect(jobBodies()[0].inputs).not.toHaveProperty('crew')
  })
})

describe('crew panel: out-of-range values are flagged, not clamped', () => {
  it('flags the value before submit and sends it as typed', async () => {
    const { crew, tool } = setup()
    await ready(crew)
    crew.set('tools_kg', '45') // config range 0..30
    expect(crewHtml(crew)).toContain('data-field="tools_kg" data-check="outside"')
    expect(crewText(crew)).toContain(EXTRAPOLATION_TEXT)
    expect(EXTRAPOLATION_TEXT).toBe('outside the validated range: result is an extrapolation')
    crew.set('body_mass_kg', '49.5') // below 50
    expect(crewHtml(crew)).toContain('data-field="body_mass_kg" data-check="outside"')
    await validPad(tool)
    await plan(tool, 1)
    expect(jobBodies()[0].inputs.crew).toEqual({ body_mass_kg: 49.5, tools_kg: 45 })
  })

  it('checkField: inside, at the edges, outside, not a number', () => {
    const s = { min: 0, max: 30, default: 10 }
    expect(checkField(s, '10')).toEqual({ kind: 'default', value: 10 })
    expect(checkField(s, '10.0')).toEqual({ kind: 'default', value: 10 })
    expect(checkField(s, '0')).toEqual({ kind: 'changed', value: 0 })
    expect(checkField(s, '30')).toEqual({ kind: 'changed', value: 30 })
    expect(checkField(s, '30.01')).toEqual({ kind: 'outside', value: 30.01 })
    expect(checkField(s, '-1')).toEqual({ kind: 'outside', value: -1 })
    expect(checkField(s, '')).toEqual({ kind: 'invalid', text: '' })
    expect(checkField(s, 'abc')).toEqual({ kind: 'invalid', text: 'abc' })
  })

  it('a field that is not a number blocks the job and says which', async () => {
    const { crew, tool } = setup()
    await ready(crew)
    await validPad(tool)
    crew.set('vo2max_ml_kg_min', 'abc')
    expect(crew.jobInputs()).toBeNull()
    const t = toolText(tool, crew)
    expect(t).toContain('Crew: vo2max is not a number.')
    expect(toHtml(<PadToolPanel state={tool.state} actions={tool} engineHref={ENGINE_HREF} computeBlocked={crewBlockedText(crew.state)} />)).toMatch(/<button type="button" class="live-btn live-compute" disabled>/)
    tool.computePlan()
    await new Promise((r) => setTimeout(r, 30))
    expect(posts('/jobs')).toEqual([])
  })
})

describe('crew panel: only the changed fields, canonical order, through the job flow', () => {
  it('the default crew sends no crew block; the preview never gets one', async () => {
    const { crew, tool } = setup()
    await ready(crew)
    await validPad(tool)
    await plan(tool, 1)
    expect(jobBodies()[0].inputs).not.toHaveProperty('crew')
    crew.set('body_mass_kg', '80')
    tool.click(MOCK_PAD_VALID)
    await until(() => posts('/pads/screen').length === 2 && tool.state.preview.kind === 'done')
    for (const c of posts('/pads/screen')) expect(c.body).not.toHaveProperty('crew')
  })

  it('a field set back to its default is not sent', async () => {
    const { crew, tool } = setup()
    await ready(crew)
    crew.set('body_mass_kg', '80')
    crew.set('vo2max_ml_kg_min', '40')
    crew.set('vo2max_ml_kg_min', '36') // crew.yaml default
    crew.set('effort_cap_frac', '0.50') // same number as the default 0.5
    expect(crew.jobInputs()).toEqual({ crew: { body_mass_kg: 80 } })
    await validPad(tool)
    await plan(tool, 1)
    const inputs = jobBodies()[0].inputs
    expect(inputs.crew).toEqual({ body_mass_kg: 80 })
    expect(Object.keys(inputs.crew as object)).toEqual(['body_mass_kg'])
    // canonical as U3's export: the request's inputs serialise exactly as the exported file
    expect(`${JSON.stringify(inputs, null, 2)}\n`).toBe(exportPlanInputs(inputs).text)
    expect(Object.keys(inputs)).toEqual([...Object.keys(inputs)].sort())
  })

  it('crewBlock: keys sorted, unclamped, null when nothing changed', () => {
    const spec = crewSpecFrom(mockDefaults())
    const text = { body_mass_kg: '75', tools_kg: '10', vo2max_ml_kg_min: '36', effort_cap_frac: '0.5' }
    expect(crewBlock(spec, text)).toBeNull()
    expect(crewBlock(spec, { ...text, vo2max_ml_kg_min: '70', effort_cap_frac: '0.45' })).toEqual({ effort_cap_frac: 0.45, vo2max_ml_kg_min: 70 })
    expect(Object.keys(crewBlock(spec, { ...text, vo2max_ml_kg_min: '70', body_mass_kg: '60' })!)).toEqual(['body_mass_kg', 'vo2max_ml_kg_min'])
  })

  it('a crew change gives a new hash and a new job; the same inputs attach (E7)', async () => {
    const { crew, tool } = setup()
    await ready(crew)
    await validPad(tool)
    crew.set('tools_kg', '20')
    await plan(tool, 1)
    const first = tool.state.plan.kind === 'done' ? tool.state.plan.job.hash : ''
    crew.set('tools_kg', '25')
    await plan(tool, 2)
    const second = tool.state.plan.kind === 'done' ? tool.state.plan.job.hash : ''
    expect(second).not.toBe(first)
    expect(jobBodies().map((b) => (b.inputs.crew as { tools_kg: number }).tools_kg)).toEqual([20, 25])
    expect(toolText(tool, crew)).toContain(`provenance of plan ${second}`)
    expect(toolText(tool, crew)).not.toContain('attached to plan')
    // the same inputs again: the server attaches to the existing run (same hash, job.attached)
    await plan(tool, 3)
    const p = tool.state.plan
    expect(p.kind === 'done' && p.job.hash).toBe(second)
    expect(p.kind === 'done' && p.attached).toBe(true)
    expect(toolText(tool, crew)).toContain(`Same inputs as an earlier run: attached to plan ${second}`)
  })
})

describe('crew panel: suit mass and O2 reserve are fixed', () => {
  it('shows them from /defaults without an input, with one line saying why', async () => {
    const { crew } = setup()
    await ready(crew)
    const h = crewHtml(crew)
    expect(h).toContain('data-field="suit_kg" data-check="fixed"')
    expect(h).not.toContain('name="suit_kg"')
    expect(h).not.toMatch(/name="reserve/)
    expect(h.match(/<input /g)).toHaveLength(CREW_FIELDS.length)
    const t = crewText(crew)
    expect(t).toContain('Suit mass 104 kg fixed tonight')
    expect(t).toContain('O2 reserve 30 min at the effort cap fixed tonight')
    expect(t).toContain(FIXED_TEXT)
  })

  it('setting them through the model does nothing; they are never sent', async () => {
    const { crew, tool } = setup()
    await ready(crew)
    crew.set('suit_kg' as never, '120')
    crew.set('reserve_min' as never, '45')
    expect(crew.jobInputs()).toEqual({})
    crew.set('tools_kg', '15')
    await validPad(tool)
    await plan(tool, 1)
    const inputs = jobBodies()[0].inputs
    expect(inputs.crew).toEqual({ tools_kg: 15 })
    expect(inputs).not.toHaveProperty('eva')
  })
})

describe('crew panel: range flags from the run record', () => {
  it('show on the live result after the job is done', async () => {
    const { crew, tool } = setup()
    await ready(crew)
    await validPad(tool)
    crew.set('tools_kg', '35')
    await plan(tool, 1)
    expect(tool.state.record.kind).toBe('done')
    const hash = tool.state.plan.kind === 'done' ? tool.state.plan.job.hash : ''
    expect(fetch.calls.some((c) => c.path === `/results/${hash}/provenance`)).toBe(true)
    const t = toolText(tool, crew)
    expect(t).toContain('Range flags (run record)')
    expect(t).toContain('crew.tools_kg = 35: outside the anchored range (ICES-2026-127, IST-2)')
    expect(t).toContain(LIVE_LABEL)
    expect(toHtml(<PadToolPanel state={tool.state} actions={tool} engineHref={ENGINE_HREF} />)).toContain(`href="#/plan/${hash}"`)
  })

  it('a result without flags says so', async () => {
    const { crew, tool } = setup()
    await ready(crew)
    await validPad(tool)
    crew.set('tools_kg', '15')
    await plan(tool, 1)
    expect(toolText(tool, crew)).toContain('No range flags: every input is inside its validated range.')
  })

  it('show on the permalink result and in the provenance view', async () => {
    const rec = runRecordCrew()
    expect(rec.range_flags).toEqual([{ key: 'crew.tools_kg', value: 35, note: 'outside the anchored range (ICES-2026-127, IST-2)' }])
    const f = createMockFetch({ provenance: { [MOCK_CREW_HASH]: rec }, trees: { [MOCK_CREW_HASH]: mockFinishedTree(false) } })
    const client = createApiClient({ base: 'http://api.test', fetch: f })
    const load = await loadPlan(client, MOCK_CREW_HASH, { loaderFor: mockLiveLoader(f) })
    expect(load.state).toBe('ok')
    if (load.state !== 'ok') return
    const page = textOf(<PlanPage load={load} permalink="https://x.test/#/plan/c4e3c4e3c4e3c4e3" simEnabled={false} importState={{ kind: 'idle' }} onImportFile={() => {}} />)
    expect(page).toContain('crew.tools_kg = 35: outside the anchored range (ICES-2026-127, IST-2)')
    expect(page).toContain(EXTRAPOLATION_TEXT)
    expect(page).toContain(`provenance of plan ${MOCK_CREW_HASH}`)
    const prov = textOf(<ProvenancePage load={load} />)
    expect(prov).toContain('Range flags')
    expect(prov).toContain('crew.tools_kg = 35: outside the anchored range (ICES-2026-127, IST-2)')
  })
})

describe('crew panel: hidden while offline', () => {
  it.each<[string, LiveState]>([
    ['offline', OFFLINE],
    ['warming', { kind: 'warming', health: { ...HEALTH_WARM, engine_warm: false } } as LiveState],
    ['checking', { kind: 'checking' }],
  ])('%s: renders nothing and asks nothing', async (_name, live) => {
    const f = createMockFetch()
    const crew = createCrew({ client: createApiClient({ base: 'http://api.test', fetch: f }) })
    crew.setLive(live)
    expect(crewHtml(crew)).toBe('')
    await new Promise((r) => setTimeout(r, 10))
    expect(f.calls).toEqual([])
  })

  it('going offline after load hides the panel; coming back shows the typed crew again', async () => {
    const { crew } = setup()
    await ready(crew)
    crew.set('tools_kg', '35')
    crew.setLive(OFFLINE)
    expect(crewHtml(crew)).toBe('')
    crew.setLive(READY)
    expect(crewHtml(crew)).toContain('value="35"')
  })
})

describe('crew panel: export/import keeps the crew block byte for byte', () => {
  const withCrew: PlanInputs = { ...PLAN_INPUTS_OFFICIAL, crew: { effort_cap_frac: 0.45, tools_kg: 35, body_mass_kg: 82.5 } }

  it('export -> import -> export gives the same bytes and the same crew', () => {
    const a = exportPlanInputs(withCrew)
    const back = checkPlanInputsText(a.text)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.inputs.crew).toEqual(withCrew.crew)
    expect(exportPlanInputs(back.inputs).text).toBe(a.text)
    expect(a.text).toContain('"crew": {\n    "body_mass_kg": 82.5,\n    "effort_cap_frac": 0.45,\n    "tools_kg": 35\n  }')
  })

  it('the run record of a crew plan exports and re-imports unchanged', () => {
    const rec = runRecordCrew(MOCK_CREW_HASH, mockCrewInputs())
    const a = exportPlanInputs(rec.inputs)
    const back = checkPlanInputsText(a.text)
    expect(back.ok && exportPlanInputs(back.inputs).text).toBe(a.text)
  })

  it('import sends the crew block as in the file, and the job runs with it', async () => {
    const f = createMockFetch({ crewJobs: true })
    vi.stubGlobal('fetch', f)
    const client = createApiClient({ base: 'http://api.test', fetch: f })
    const text = exportPlanInputs(withCrew).text
    const file = { size: new TextEncoder().encode(text).length, text: async () => text }
    let to = ''
    const out = await importPlanFile(file, { client, navigate: (h) => (to = h), onState: () => {}, job: { pollInitialMs: 10, pollFactor: 1, pollMaxMs: 10 } })
    expect(out.kind).toBe('opened')
    const imp = f.calls.find((c) => c.method === 'POST' && c.path === '/plans/import')!
    expect(`${JSON.stringify(imp.body, null, 2)}\n`).toBe(text)
    const job = f.calls.find((c) => c.method === 'POST' && c.path === '/jobs')!.body as JobRequest
    expect(job.inputs.crew).toEqual(withCrew.crew)
    expect(to).toContain('#/plan/')
  })
})

describe('mock crew job', () => {
  it('crewJobScript keeps the plan stages under the crew hash', () => {
    const s = crewJobScript()
    expect(new Set(s.map((j) => j.hash))).toEqual(new Set([MOCK_CREW_HASH]))
    expect(s.at(-1)!.result_url).toBe(`/api/v1/results/${MOCK_CREW_HASH}/`)
  })
})

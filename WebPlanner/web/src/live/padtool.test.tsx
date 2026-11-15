// Known answers for the pad tool (F24, WS13 task 2): invalid click -> reason + nearest valid block;
// valid click -> instant preview with the mock numbers; staged job -> partial results on the map
// without errors, numbers through the result's manifest; LIVE_LABEL + provenance link on every live
// view; offline -> no controls (U1's banner shows instead).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { LIVE_LABEL, OFFLINE_LABEL } from './config'
import { bannerFor, type LiveState } from './health'
import type { LivePadMark, MapPort, ScenarioLayers } from './mapPort'
import { failedJobScript, HEALTH_WARM } from './mock/fixtures'
import { createMockFetch, type MockFetch, type MockOptions } from './mock/fetch'
import { mockResultFile } from './mock/result'
import { MOCK_PAD_INVALID, MOCK_PAD_NEAREST, MOCK_PAD_VALID, PAD_CHECK_INVALID, PAD_CHECK_VALID } from './mock/pads'
import { createPadTool, planInputsFor, type PadTool, type PadToolState } from './padtool'
import { textOf, toHtml } from './testing/html'
import type { LonLat } from './types'
import { PadToolPanel, REASON_TEXT } from './view'
import type { RouteFC } from '../data/types'

const READY: LiveState = { kind: 'ready', health: HEALTH_WARM }
const HASH = '0123456789abcdef'
const ENGINE_HREF = 'http://api.test/api/v1/engine/version'

function fakePort() {
  const calls = { pads: [] as (LivePadMark | null)[], scenario: [] as ScenarioLayers[], route: [] as (RouteFC | null)[], restored: 0 }
  let clickCb: ((p: LonLat) => void) | null = null
  const port: MapPort = {
    onClick(cb) {
      clickCb = cb
      return () => (clickCb = null)
    },
    setLivePad: (p) => void calls.pads.push(p),
    setScenarioData: async (d) => void calls.scenario.push(d),
    setRoute: async (r) => void calls.route.push(r),
    restoreStatic: () => void calls.restored++,
  }
  return { port, calls, click: (p: LonLat) => clickCb?.(p) }
}

let fetch: MockFetch
function setup(mock: MockOptions = {}) {
  fetch = createMockFetch(mock)
  vi.stubGlobal('fetch', fetch) // liveLoader -> browserFetcher reads result files with the global fetch
  const client = createApiClient({ base: 'http://api.test', fetch })
  const p = fakePort()
  const tool = createPadTool({ client, port: p.port, job: { pollInitialMs: 25, pollFactor: 1, pollMaxMs: 25 } })
  const states: PadToolState[] = []
  tool.subscribe((s) => states.push(s))
  tool.setLive(READY)
  return { tool, ...p, states }
}

const html = (tool: PadTool) => toHtml(<PadToolPanel state={tool.state} actions={tool} engineHref={ENGINE_HREF} />)
const text = (tool: PadTool) => textOf(<PadToolPanel state={tool.state} actions={tool} engineHref={ENGINE_HREF} />)
const callsTo = (path: string) => fetch.calls.filter((c) => c.path === path)

async function until(pred: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.unstubAllGlobals())

describe('pad tool: validation', () => {
  it('an invalid click shows the reason and the nearest valid block, and never a preview', async () => {
    const { tool, calls } = setup()
    tool.click(MOCK_PAD_INVALID)
    await until(() => tool.state.check.kind === 'done')
    expect(callsTo('/pads/validate').map((c) => c.body)).toEqual([MOCK_PAD_INVALID])
    const t = text(tool)
    expect(t).toContain(REASON_TEXT.slope)
    expect(t).toContain('Nearest valid block: 137.409200°E -4.761800°N, 112.5 m away')
    expect(t).toContain('Use the nearest valid block')
    expect(t).not.toContain('Instant preview')
    expect(t).not.toContain('Compute full plan')
    expect(callsTo('/pads/screen')).toEqual([])
    expect(calls.pads.at(-1)).toEqual({ ...MOCK_PAD_INVALID, valid: false })
  })

  it.each(Object.entries(PAD_CHECK_INVALID))('reason %s has its own text', async (reason, answer) => {
    const { tool } = setup({ validate: answer })
    tool.click(MOCK_PAD_INVALID)
    await until(() => tool.state.check.kind === 'done')
    const h = html(tool)
    expect(h).toContain(`data-reason="${reason}"`)
    expect(text(tool)).toContain(REASON_TEXT[reason as keyof typeof REASON_TEXT])
    if (!answer.nearest_valid) expect(text(tool)).toContain('No valid block nearby.')
  })

  it('a pad on an unknown cell is refused with "no 1 m terrain here" (F24 acceptance)', async () => {
    const { tool } = setup({ validate: PAD_CHECK_INVALID.unknown_terrain })
    tool.click(MOCK_PAD_INVALID)
    await until(() => tool.state.check.kind === 'done')
    expect(text(tool).toLowerCase()).toContain('no 1 m terrain here')
  })

  it('"use the nearest valid block" re-validates there and opens the preview', async () => {
    const { tool } = setup({ validate: (p) => (p.lon === MOCK_PAD_NEAREST.lon && p.lat === MOCK_PAD_NEAREST.lat ? PAD_CHECK_VALID : PAD_CHECK_INVALID.slope) })
    tool.click(MOCK_PAD_INVALID)
    await until(() => tool.state.check.kind === 'done')
    tool.useNearest()
    await until(() => tool.state.preview.kind === 'done')
    expect(tool.state.pad).toEqual({ lon: MOCK_PAD_NEAREST.lon, lat: MOCK_PAD_NEAREST.lat })
    expect(callsTo('/pads/screen')).toHaveLength(1)
  })

  it('a stale answer from an earlier click is dropped', async () => {
    const { tool } = setup()
    tool.click(MOCK_PAD_INVALID)
    tool.click(MOCK_PAD_VALID)
    await until(() => tool.state.preview.kind === 'done')
    expect(tool.state.pad).toEqual(MOCK_PAD_VALID)
    expect(tool.state.check).toEqual({ kind: 'done', result: PAD_CHECK_VALID })
  })

  it('an API error is shown, not thrown', async () => {
    const { tool } = setup({ padError: { status: 503, body: { error: 'unavailable' } } })
    tool.click(MOCK_PAD_VALID)
    await until(() => tool.state.check.kind === 'error')
    expect(text(tool)).toContain('Could not check the pad: unavailable (HTTP 503)')
  })
})

describe('pad tool: instant preview', () => {
  it('a valid click shows the preview with the mock numbers', async () => {
    const { tool, calls } = setup()
    tool.click(MOCK_PAD_VALID)
    await until(() => tool.state.preview.kind === 'done')
    expect(callsTo('/pads/screen').map((c) => c.body)).toEqual([planInputsFor(MOCK_PAD_VALID)])
    const t = text(tool)
    expect(t).toContain('Valid pad (D21 rule)')
    expect(t).toContain('Instant preview')
    expect(t).toContain('Feasible EVAs (D21 score): 3')
    expect(t).toContain('S1 yes 21.4 min 23 min')
    expect(t).toContain('S2 yes 34.2 min 36.9 min')
    expect(t).toContain('S4 no unknown unknown')
    expect(t).toContain('Best route estimate: pad → S1 → S2 → S6 → pad, 212.5 min')
    expect(t).toContain('Compute full plan')
    // preview numbers are flagged as screening estimates (no manifest in the PadScreen contract)
    expect(html(tool)).toContain('class="num num-screen"')
    expect(calls.pads.at(-1)).toEqual({ ...MOCK_PAD_VALID, valid: true })
  })

  it('heavy jobs off: the preview shows, the compute button is disabled', async () => {
    const { tool } = setup()
    tool.setLive({ kind: 'ready', health: { ...HEALTH_WARM, heavy_jobs: 'off' } })
    tool.click(MOCK_PAD_VALID)
    await until(() => tool.state.preview.kind === 'done')
    expect(html(tool)).toMatch(/<button[^>]*disabled[^>]*>Compute full plan/)
    tool.computePlan()
    expect(callsTo('/jobs')).toEqual([])
  })
})

describe('pad tool: full plan with staged results', () => {
  it('a staged job renders partial results without errors, then the whole plan', async () => {
    const { tool, calls, states } = setup()
    tool.click(MOCK_PAD_VALID)
    await until(() => tool.state.preview.kind === 'done')
    tool.computePlan()
    await until(() => tool.state.plan.kind === 'done')

    expect(callsTo('/jobs').map((c) => c.body)).toEqual([{ type: 'plan', inputs: planInputsFor(MOCK_PAD_VALID) }])
    // partial snapshots, in stage order, each rendered without errors
    const partial = states.filter((s) => s.plan.kind === 'running' && s.plan.result)
    expect(partial.length).toBeGreaterThanOrEqual(2)
    const snapshots = [...new Set(partial.map((s) => (s.plan.kind === 'running' ? s.plan.result! : null)))]
    const stagesSeen = snapshots.map((r) => r!.stages)
    // one snapshot per finished stage, in order (the last may arrive with the done state)
    expect(stagesSeen).toEqual(stagesSeen.map((_, i) => ['nominal', 'bands', 'hud'].slice(0, i + 1)))
    expect(stagesSeen[1]).toEqual(['nominal', 'bands'])
    for (const s of partial) {
      if (s.plan.kind !== 'running') continue
      expect(s.plan.result!.errors).toEqual([])
      const t = textOf(<PadToolPanel state={s} actions={tool} engineHref={ENGINE_HREF} />)
      expect(t).toContain(LIVE_LABEL)
      expect(t).toMatch(/Running stage|Queued/)
      expect(t).not.toContain('not shown')
    }
    const first = textOf(<PadToolPanel state={partial[0]} actions={tool} engineHref={ENGINE_HREF} />)
    expect(first).toContain('Stages on the map: nominal')
    expect(first).toContain('Reachable within a 30-min walk home (nom_104): 24.1%')
    expect(first).not.toContain('range') // bands not done yet: range_pct is [null, null]

    // the map got the stages through the console map's own setters
    expect(calls.scenario[0].bands.features.map((f) => f.properties.variant)).toEqual(['nominal', 'nominal'])
    expect(calls.scenario[0].partner.features).toEqual([])
    expect(calls.scenario.at(-1)!.bands.features).toHaveLength(4)
    expect(calls.scenario.at(-1)!.partner.features).toHaveLength(1)
    expect(calls.route.at(-1)!.features).toHaveLength(2)

    // final card: numbers resolve against the result's own manifest and link to its provenance view
    const h = html(tool)
    expect(h).toContain(`<a class="num num-ok num-live" href="#/plan/${HASH}"`)
    const t = text(tool)
    expect(t).toContain('All stages done.')
    expect(t).toContain('Stages on the map: nominal, bands, hud')
    expect(t).toMatch(/24\.1% \(range 12\.3% to 31% ?\)/)
    expect(t).not.toContain('not in manifest yet')
    expect(tool.state.plan.kind === 'done' && tool.state.plan.result!.errors).toEqual([])
  })

  it('a job that fails after a stage keeps the partial result and says why', async () => {
    const { tool } = setup({ job: failedJobScript() })
    tool.click(MOCK_PAD_VALID)
    await until(() => tool.state.preview.kind === 'done')
    tool.computePlan()
    await until(() => tool.state.plan.kind === 'failed')
    const p = tool.state.plan
    expect(p.kind === 'failed' && p.result?.stages).toEqual(['nominal'])
    const t = text(tool)
    expect(t).toContain('The plan failed: engine_error: no route within the walkback budget')
    expect(t).toContain(LIVE_LABEL)
    expect(t).toContain('24.1%')
  })

  it('a file that breaks its contract is reported, never drawn, and the rest still renders', async () => {
    const { tool, calls } = setup({
      resultFile: (path, done) => (path === 'scenarios/nom_104/edges.geojson' ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }] } : mockResultFile(path, done)),
    })
    tool.click(MOCK_PAD_VALID)
    await until(() => tool.state.preview.kind === 'done')
    tool.computePlan()
    await until(() => tool.state.plan.kind === 'done')
    expect(calls.scenario.at(-1)!.edges.features).toEqual([])
    expect(text(tool)).toContain('scenarios/nom_104/edges.geojson: not shown')
    expect(text(tool)).toContain('24.1%')
  })

  it('a new click cancels the running job and gives the map back', async () => {
    const { tool, calls } = setup()
    tool.click(MOCK_PAD_VALID)
    await until(() => tool.state.preview.kind === 'done')
    tool.computePlan()
    await until(() => tool.state.plan.kind === 'running' && !!tool.state.plan.result)
    tool.click(MOCK_PAD_INVALID)
    await until(() => tool.state.check.kind === 'done')
    expect(tool.state.plan).toEqual({ kind: 'idle' })
    expect(calls.restored).toBe(1)
    const polls = callsTo('/jobs/j_01').length
    await new Promise((r) => setTimeout(r, 80))
    expect(callsTo('/jobs/j_01').length).toBe(polls)
  })
})

describe('label everything live', () => {
  it('LIVE_LABEL and a provenance link are on every live view', async () => {
    const seen = new Map<string, PadToolState>()
    const keep = (s: PadToolState) => {
      const k = `${s.check.kind}/${s.preview.kind}/${s.plan.kind}`
      if (!seen.has(k)) seen.set(k, s)
    }
    for (const mock of [{}, { job: failedJobScript() }]) {
      const { tool, states } = setup(mock)
      tool.click(MOCK_PAD_INVALID)
      await until(() => tool.state.check.kind === 'done')
      tool.click(MOCK_PAD_VALID)
      await until(() => tool.state.preview.kind === 'done')
      tool.computePlan()
      await until(() => tool.state.plan.kind === 'done' || tool.state.plan.kind === 'failed')
      states.forEach(keep)
    }
    const { tool } = setup({ padError: { status: 503, body: { error: 'unavailable' } } })
    tool.click(MOCK_PAD_VALID)
    await until(() => tool.state.check.kind === 'error')
    keep(tool.state)

    const shown = [...seen.values()].filter((s) => bannerFor(s.live).controls)
    expect(shown.length).toBeGreaterThanOrEqual(8)
    for (const s of shown) {
      const h = toHtml(<PadToolPanel state={s} actions={tool} engineHref={ENGINE_HREF} />)
      expect(h, `${s.check.kind}/${s.preview.kind}/${s.plan.kind}`).toContain(LIVE_LABEL)
      expect(h).toContain(`<a class="live-prov" href="${ENGINE_HREF}">`)
      if (s.plan.kind !== 'idle' && s.plan.job) expect(h).toContain(`<a class="live-prov" href="#/plan/${HASH}">`)
    }
  })
})

describe('static first: offline', () => {
  it.each<LiveState>([{ kind: 'offline', reason: 'timeout' }, { kind: 'offline', reason: 'unreachable' }, { kind: 'checking' }, { kind: 'warming', health: { ...HEALTH_WARM, engine_warm: false } }])(
    'no controls while %o; clicks do nothing',
    (live) => {
      const { tool } = setup()
      tool.setLive(live)
      expect(toHtml(<PadToolPanel state={tool.state} actions={tool} engineHref={ENGINE_HREF} />)).toBe('')
      tool.click(MOCK_PAD_VALID)
      expect(fetch.calls).toEqual([])
      if (live.kind === 'offline') expect(bannerFor(live).text).toBe(OFFLINE_LABEL)
    },
  )

  it('going offline mid-plan hides the tool, stops the job and gives the map back', async () => {
    const { tool, calls } = setup()
    tool.click(MOCK_PAD_VALID)
    await until(() => tool.state.preview.kind === 'done')
    tool.computePlan()
    await until(() => tool.state.plan.kind === 'running' && !!tool.state.plan.result)
    tool.setLive({ kind: 'offline', reason: 'unreachable' })
    expect(tool.state.pad).toBeNull()
    expect(tool.state.plan).toEqual({ kind: 'idle' })
    expect(calls.restored).toBe(1)
    expect(text(tool)).toBe('')
  })
})

// Known answers for WS13 tasks 3-4 and D76 (F28, F35, F24): the official hash opened as a permalink
// shows the static console's numbers; unknown hash -> not found; API down -> offline message, no
// crash; export -> import round trip byte for byte; import refuses unknown fields and oversize files;
// the provenance view shows the label of the result's origin; the simulator slot appears only with
// VITE_SIM_EXPORT on and a sim_plan manifest entry; "Play this plan" mounts the HUD on the result tree.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Num } from '../components/Num'
import type { Manifest, ScenariosIndex } from '../data/types'
import { formatValue } from '../prov/provenance'
import { setManifest } from '../prov/store'
import { routeSummary } from '../views/route'
import { tightestMargin } from '../views/decisions'
import { createApiClient } from './client'
import { LIVE_LABEL, OFFLINE_LABEL, PRECOMPUTED_LABEL, SIM_EXPORT_ENABLED, TITLE_MAX_CHARS, UPLOAD_MAX_BYTES } from './config'
import { PLAN_INPUTS_OFFICIAL, RUN_RECORD_LIVE, RUN_RECORD_OFFICIAL } from './mock/fixtures'
import { createMockFetch, type MockOptions } from './mock/fetch'
import { MOCK_OFFICIAL_HASH } from './mock/hashes'
import { MOCK_SIM_FILE, mockFinishedTree } from './mock/result'
import customExample from '../../../contracts/backend/examples/plan_inputs.custom.json'
import { importPlanFile, loadPlan, parsePlanRoute, planUrl, type ImportState, type PlanLoad } from './plan'
import { canonicalJson, checkPlanInputsFile, checkPlanInputsText, exportPlanInputs } from './planio'
import { planLayers, playPlan, resultDataUrl, type HudModule } from './planmount'
import { labelFor, PlanPage, PlanProblem, ProvenancePage, PlayHeader } from './planview'
import { mockLiveLoader } from './result'
import { simPlanFiles, SimSlot } from './simslot'
import { textOf, toHtml } from './testing/html'
import type { PlanInputs, RunRecord } from './types'

const DATA = resolve(__dirname, '../../public/data')
const LIVE_HASH = (RUN_RECORD_LIVE as RunRecord).hash
const API = 'http://api.test'

/** The committed official tree, file by file, as the server serves it under the official hash (E3). */
const staticTree = (path: string): string | null => {
  const f = resolve(DATA, path)
  return f.startsWith(DATA) && existsSync(f) ? readFileSync(f, 'utf8') : null
}

function setup(opts: MockOptions = {}) {
  const fetch = createMockFetch({ trees: { [MOCK_OFFICIAL_HASH]: staticTree, [LIVE_HASH]: mockFinishedTree(false) }, ...opts })
  const client = createApiClient({ base: API, fetch })
  return { fetch, client, loaderFor: mockLiveLoader(fetch) }
}

type Ok = Extract<PlanLoad, { state: 'ok' }>
const pageText = (load: Ok, sim = false) =>
  toHtml(<PlanPage load={load} permalink={`https://x.test/${planUrl(load.hash)}`} simEnabled={sim} importState={{ kind: 'idle' }} onImportFile={() => {}} />)

afterEach(() => setManifest(null))

/** Same document, keys in reverse order at every level. */
function reversed(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reversed)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)]))
  return v
}

describe('routes', () => {
  it('parses #/plan, #/plan/{hash}, provenance and play; other routes belong to the app router', () => {
    expect(parsePlanRoute('#/plan')).toEqual({ view: 'import' })
    expect(parsePlanRoute('#/plan/0123456789abcdef')).toEqual({ view: 'result', hash: '0123456789abcdef' })
    expect(parsePlanRoute('#/plan/0123456789abcdef/provenance')).toEqual({ view: 'provenance', hash: '0123456789abcdef' })
    expect(parsePlanRoute('#/plan/0123456789abcdef/play')).toEqual({ view: 'play', hash: '0123456789abcdef' })
    expect(parsePlanRoute('#/')).toBeNull()
    expect(parsePlanRoute('#/scorecard?key=plan')).toBeNull()
    expect(parsePlanRoute('#/planet')).toBeNull()
    expect(planUrl('0123456789abcdef', 'play')).toBe('#/plan/0123456789abcdef/play')
  })
})

describe('#/plan/{hash} permalink (F28)', () => {
  it.skipIf(!existsSync(resolve(DATA, 'scenarios/index.json')))('the official hash shows the static console numbers (same file, same key, same text)', async () => {
    const { client, fetch, loaderFor } = setup()
    const load = await loadPlan(client, MOCK_OFFICIAL_HASH, { loaderFor })
    expect(load.state).toBe('ok')
    const ok = load as Ok
    expect(ok.base).toBe(`${API}/api/v1/results/${MOCK_OFFICIAL_HASH}`)
    expect(fetch.calls.some((c) => c.path === `/results/${MOCK_OFFICIAL_HASH}/scenarios/index.json`)).toBe(true)
    expect(ok.tree.errors).toEqual([])

    // What the static console shows: its own Num on the static manifest, for the default scenario.
    const idx = JSON.parse(staticTree('scenarios/index.json')!) as ScenariosIndex
    setManifest(JSON.parse(staticTree('manifest.json')!) as Manifest)
    const sc = idx.scenarios.find((s) => s.id === idx.default)!
    const h = sc.headline
    const hb = h.budget_min
    const F = 'scenarios/index.json'
    const h60 = (sc as unknown as { headline_60: { budget_min: number; reachable_pct: number; range_pct: [number, number] } }).headline_60
    const route = routeSummary(JSON.parse(staticTree(`route_${sc.id}.geojson`)!))!
    const tl = JSON.parse(staticTree(`timeline_${sc.id}.json`)!)
    const tight = tightestMargin(tl)!
    const tf = `timeline_${sc.id}.json`
    const staticNums = [
      <Num v={h.reachable_pct} units="%" file={F} k={`reachable_pct.${sc.id}.${hb}`} />,
      <Num v={h.range_pct[0]} units="%" file={F} k={`reachable_pct_range.${sc.id}.${hb}.low`} />,
      <Num v={h.range_pct[1]} units="%" file={F} k={`reachable_pct_range.${sc.id}.${hb}.high`} />,
      <Num v={h60.reachable_pct} units="%" file={F} k={`reachable_pct.${sc.id}.${h60.budget_min}`} />,
      <Num v={h60.range_pct[0]} units="%" file={F} k={`reachable_pct_range.${sc.id}.${h60.budget_min}.low`} />,
      <Num v={h60.range_pct[1]} units="%" file={F} k={`reachable_pct_range.${sc.id}.${h60.budget_min}.high`} />,
      <Num v={route.endMin} units="min" file={tf} k={`route.${sc.id}.total_min`} />,
      <Num v={tight.e.margin_min} units="min" file={tf} k={`timeline.${sc.id}.${tight.i}.margin_min`} />,
    ].map((n) => {
      const html = toHtml(n)
      expect(html, 'the static console backs this number').toContain('num-ok')
      return textOf(n)
    })
    // the known answer itself (web/public/data, D42 frozen): 30-min headline of the default scenario
    expect(staticNums[0]).toBe(formatValue(h.reachable_pct, '%'))
    expect(h.reachable_pct).toBe(23)

    const html = pageText(ok)
    const liveNums = [...html.matchAll(/<a class="num num-ok num-live"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1])
    expect(liveNums).toEqual(staticNums)
    expect(html).not.toContain('num-withheld')
    // the official tree carries its own label, never the live one
    expect(textOf(<PlanPage load={ok} permalink="" simEnabled={false} importState={{ kind: 'idle' }} onImportFile={() => {}} />)).toContain(PRECOMPUTED_LABEL)
    expect(html).not.toContain(LIVE_LABEL)
    expect(html).toContain(`href="#/plan/${MOCK_OFFICIAL_HASH}/provenance"`)
  })

  it('a computed live result renders with LIVE_LABEL and the provenance link', async () => {
    const { client, loaderFor } = setup()
    const load = (await loadPlan(client, LIVE_HASH, { loaderFor })) as Ok
    expect(load.state).toBe('ok')
    const text = textOf(<PlanPage load={load} permalink="p" simEnabled={false} importState={{ kind: 'idle' }} onImportFile={() => {}} />)
    expect(text).toContain(LIVE_LABEL)
    expect(text).toContain(formatValue(24.1, '%'))
    expect(pageText(load)).toContain(`href="#/plan/${LIVE_HASH}/provenance"`)
  })

  it('unknown hash: a clear not-found message', async () => {
    const { client, loaderFor } = setup()
    const load = await loadPlan(client, 'ffffffffffffffff', { loaderFor })
    expect(load.state).toBe('notfound')
    const text = textOf(<PlanProblem load={load as Exclude<PlanLoad, { state: 'ok' }>} />)
    expect(text).toMatch(/Plan not found/)
    expect(text).toContain('ffffffffffffffff')
  })

  it('a malformed hash is not found without asking the server', async () => {
    const { client, fetch, loaderFor } = setup()
    const load = await loadPlan(client, 'not-a-hash', { loaderFor })
    expect(load.state).toBe('notfound')
    expect(fetch.calls).toEqual([])
  })

  it('API offline: the offline text, no crash', async () => {
    const client = createApiClient({
      base: API,
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const load = await loadPlan(client, MOCK_OFFICIAL_HASH)
    expect(load.state).toBe('offline')
    expect(textOf(<PlanProblem load={load as Exclude<PlanLoad, { state: 'ok' }>} />)).toContain(OFFLINE_LABEL)
  })

  it('a run record that breaks its contract is an error, not a page', async () => {
    const { client, loaderFor } = setup({ provenance: { [LIVE_HASH]: { ...(RUN_RECORD_LIVE as object), origin: 'guessed' } } })
    const load = await loadPlan(client, LIVE_HASH, { loaderFor })
    expect(load.state).toBe('error')
  })
})

describe('provenance view (F35)', () => {
  it('computed_live: labels.live, engine tree and commit, config and terrain hash, inputs, timings', async () => {
    const { client, loaderFor } = setup()
    const load = (await loadPlan(client, LIVE_HASH, { loaderFor })) as Ok
    const r = RUN_RECORD_LIVE as RunRecord
    const text = textOf(<ProvenancePage load={load} />)
    expect(text).toContain(LIVE_LABEL)
    expect(text).not.toContain(PRECOMPUTED_LABEL)
    for (const s of ['computed_live', r.engine.tree, r.engine.commit, r.engine.config_hash, r.terrain_hash, r.started_utc, r.finished_utc!]) expect(text).toContain(s)
    for (const st of r.stages) expect(text).toContain(`${st.name} ${st.started_utc} ${st.seconds}`)
    expect(text).toContain('"body_mass_kg": 60') // inputs block
    expect(text).toContain(r.range_flags![0].note)
  })

  it('precomputed: labels.precomputed "Precomputed · official plan"', async () => {
    const { client, loaderFor } = setup()
    const load = (await loadPlan(client, MOCK_OFFICIAL_HASH, { loaderFor })) as Ok
    const text = textOf(<ProvenancePage load={load} />)
    expect(PRECOMPUTED_LABEL).toBe('Precomputed · official plan')
    expect(text).toContain(PRECOMPUTED_LABEL)
    expect(text).not.toContain(LIVE_LABEL)
    expect(labelFor('precomputed')).toBe(PRECOMPUTED_LABEL)
    expect(labelFor('computed_live')).toBe(LIVE_LABEL)
  })
})

describe('JSON export and import (F28, D52)', () => {
  const samples: [string, PlanInputs][] = [
    ['official example', PLAN_INPUTS_OFFICIAL],
    ['custom example', customExample as PlanInputs],
    ['live run record inputs (defaults filled)', (RUN_RECORD_LIVE as RunRecord).inputs],
  ]
  it.each(samples)('round trip, %s: import(export(x)) == x, and export(import(bytes)) == bytes', (_n, x) => {
    const ex = exportPlanInputs(x)
    expect(ex.fileName).toBe('plan_inputs.json')
    expect(decodeURIComponent(ex.href.replace(/^data:application\/json;charset=utf-8,/, ''))).toBe(ex.text)
    const back = checkPlanInputsText(ex.text)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.inputs).toEqual(x)
    expect(exportPlanInputs(back.inputs).text).toBe(ex.text) // byte for byte
    // key order of the source does not matter: the export is canonical
    const shuffled = reversed(x)
    expect(canonicalJson(shuffled)).toBe(ex.text)
  })

  it('the export is canonical: sorted keys at every level', () => {
    expect(canonicalJson({ pad: { lon: 1, lat: 2 }, contract_version: '1.0.1' })).toBe('{\n  "contract_version": "1.0.1",\n  "pad": {\n    "lat": 2,\n    "lon": 1\n  }\n}\n')
  })

  it('refuses unknown fields, at the top and nested', () => {
    const top = checkPlanInputsText(JSON.stringify({ ...PLAN_INPUTS_OFFICIAL, share_code: 'HL-7K2Q9M' }))
    expect(top.ok).toBe(false)
    expect(!top.ok && top.errors.join()).toMatch(/share_code/)
    const nested = checkPlanInputsText(JSON.stringify({ ...PLAN_INPUTS_OFFICIAL, crew: { suit_kg: 104, helmet_colour: 'red' } }))
    expect(nested.ok).toBe(false)
    expect(!nested.ok && nested.errors.join()).toMatch(/helmet_colour/)
  })

  it('refuses a file over limits.upload_max_bytes without reading it', async () => {
    const text = vi.fn(async () => JSON.stringify(PLAN_INPUTS_OFFICIAL))
    const r = await checkPlanInputsFile({ size: UPLOAD_MAX_BYTES + 1, text })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors[0]).toMatch(String(UPLOAD_MAX_BYTES))
    expect(text).not.toHaveBeenCalled()
    // at the limit is fine
    expect((await checkPlanInputsFile({ size: UPLOAD_MAX_BYTES, text })).ok).toBe(true)
    // the text check counts bytes too
    const padded = JSON.stringify(PLAN_INPUTS_OFFICIAL) + ' '.repeat(UPLOAD_MAX_BYTES)
    expect(checkPlanInputsText(padded).ok).toBe(false)
  })

  it('refuses non-JSON, a missing pad, a wrong type and an over-long title', () => {
    expect(checkPlanInputsText('{').ok).toBe(false)
    expect(checkPlanInputsText(JSON.stringify({ contract_version: '1.0.1' })).ok).toBe(false)
    expect(checkPlanInputsText(JSON.stringify({ ...PLAN_INPUTS_OFFICIAL, pad: { lon: 'x', lat: 1 } })).ok).toBe(false)
    expect(checkPlanInputsText(JSON.stringify({ ...PLAN_INPUTS_OFFICIAL, title: 'x'.repeat(TITLE_MAX_CHARS + 1) })).ok).toBe(false)
    expect(checkPlanInputsText(JSON.stringify({ ...PLAN_INPUTS_OFFICIAL, title: 'x'.repeat(TITLE_MAX_CHARS) })).ok).toBe(true)
  })

  const file = (doc: unknown) => {
    const text = canonicalJson(doc)
    return { size: new TextEncoder().encode(text).length, text: async () => text }
  }
  const JOB = { pollInitialMs: 5, pollFactor: 1, pollMaxMs: 5 }

  it('a plan the server knows opens #/plan/{hash}', async () => {
    const { client, fetch } = setup()
    const navigate = vi.fn()
    const states: ImportState[] = []
    const out = await importPlanFile(file(PLAN_INPUTS_OFFICIAL), { client, navigate, onState: (s) => states.push(s), job: JOB })
    expect(out).toEqual({ kind: 'opened', hash: MOCK_OFFICIAL_HASH, computed: true })
    expect(navigate).toHaveBeenCalledWith(`#/plan/${MOCK_OFFICIAL_HASH}`)
    expect(fetch.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /plans/import'])
    expect(fetch.calls[0].body).toEqual(PLAN_INPUTS_OFFICIAL)
  })

  it('an unknown plan submits the plan job and opens its result when done', async () => {
    const { client, fetch } = setup()
    const navigate = vi.fn()
    const states: ImportState[] = []
    const out = await importPlanFile(file(customExample), { client, navigate, onState: (s) => states.push(s), job: JOB })
    expect(out).toEqual({ kind: 'opened', hash: LIVE_HASH, computed: false })
    expect(fetch.calls.find((c) => c.method === 'POST' && c.path === '/jobs')?.body).toEqual({ type: 'plan', inputs: customExample })
    expect(states.some((s) => s.kind === 'computing' && s.job?.stage)).toBe(true)
    expect(navigate).toHaveBeenCalledWith(`#/plan/${LIVE_HASH}`)
  })

  it('a refused file never reaches the server', async () => {
    const { client, fetch } = setup()
    const out = await importPlanFile(file({ ...PLAN_INPUTS_OFFICIAL, extra: 1 }), { client, navigate: vi.fn(), onState: () => {} })
    expect(out.kind).toBe('rejected')
    expect(fetch.calls).toEqual([])
  })

  it('server down: the valid inputs are still shown', async () => {
    const down = createApiClient({
      base: API,
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const out = await importPlanFile(file(PLAN_INPUTS_OFFICIAL), { client: down, navigate: vi.fn(), onState: () => {} })
    expect(out.kind).toBe('offline')
    expect(out.kind === 'offline' && out.inputs).toEqual(PLAN_INPUTS_OFFICIAL)
  })
})

describe('D76 "Send to simulator" slot', () => {
  it('VITE_SIM_EXPORT is off in this environment', () => {
    expect(SIM_EXPORT_ENABLED).toBe(false)
  })

  it('hidden without a sim_plan entry, hidden with the flag off, lists the file with both', async () => {
    const withSim = setup({ trees: { [LIVE_HASH]: mockFinishedTree(true) } })
    const withoutSim = setup()
    const a = (await loadPlan(withSim.client, LIVE_HASH, { loaderFor: withSim.loaderFor })) as Ok
    const b = (await loadPlan(withoutSim.client, LIVE_HASH, { loaderFor: withoutSim.loaderFor })) as Ok
    expect(a.tree.errors).toEqual([]) // the manifest with a sim_plan entry passes its contract
    expect(simPlanFiles(a.tree.manifest)).toEqual([{ key: 'sim.nom_104.export', file: MOCK_SIM_FILE }])
    expect(simPlanFiles(b.tree.manifest)).toEqual([])

    expect(toHtml(<SimSlot enabled={false} manifest={a.tree.manifest} base={a.base} />)).toBe('')
    expect(toHtml(<SimSlot enabled={true} manifest={b.tree.manifest} base={b.base} />)).toBe('')
    expect(toHtml(<SimSlot enabled={true} manifest={null} base={b.base} />)).toBe('')
    const html = toHtml(<SimSlot enabled={true} manifest={a.tree.manifest} base={a.base} />)
    expect(html).toContain('Send to simulator')
    expect(html).toContain(`href="${a.base}/${MOCK_SIM_FILE}"`)
    expect(html).toContain('download="mock_sim_export.dat"')

    // in the page: only with both
    expect(pageText(a, false)).not.toContain('Send to simulator')
    expect(pageText(b, true)).not.toContain('Send to simulator')
    expect(pageText(a, true)).toContain('Send to simulator')
  })

  it('every sim_plan entry is listed once, other kinds are ignored', () => {
    const e = (file: string, kind?: string) => ({ value: null, units: null, file, script: 's', commit: 'c', utc: 'u', ...(kind ? { kind } : {}) })
    const m = { b: e('z/b.bin', 'sim_plan'), a: e('a.any', 'sim_plan'), dup: e('a.any', 'sim_plan'), other: e('x.json', 'figure'), plain: e('y.json') } as unknown as Manifest
    expect(simPlanFiles(m).map((f) => f.file)).toEqual(['a.any', 'z/b.bin'])
  })
})

describe('"Play this plan" (F24)', () => {
  it('the plan page links to the play view; the HUD mounts with file URLs under the result base', async () => {
    const { client, loaderFor } = setup()
    const load = (await loadPlan(client, LIVE_HASH, { loaderFor })) as Ok
    expect(pageText(load)).toContain(`href="#/plan/${LIVE_HASH}/play"`)
    const mount = vi.fn((_el: HTMLElement, _ctx: { dataUrl: (p: string) => string }) => () => {})
    const hud: HudModule = { mount }
    const el = {} as HTMLElement
    const cleanup = await playPlan(el, load, async () => hud)
    expect(mount).toHaveBeenCalledTimes(1)
    const ctx = mount.mock.calls[0][1]
    expect(ctx.dataUrl('route_nom_104.geojson')).toBe(`${API}/api/v1/results/${LIVE_HASH}/route_nom_104.geojson`)
    expect(resultDataUrl(load.base)('fields/index.json')).toBe(`${load.base}/fields/index.json`)
    expect(typeof cleanup).toBe('function')
    const head = textOf(<PlayHeader load={load} />)
    expect(head).toContain(LIVE_LABEL)
  })

  it('the map gets the result through the console layers (bands required, others may be empty)', async () => {
    const { client, loaderFor } = setup()
    const load = (await loadPlan(client, LIVE_HASH, { loaderFor })) as Ok
    const layers = planLayers(load.tree)!
    expect(layers.variant).toBe('nominal')
    expect(layers.bands.features.length).toBeGreaterThan(0)
    expect(planLayers({ ...load.tree, bands: null })).toBeNull()
  })
})

describe('mock answers used here', () => {
  it('provenance: the live example and the official record; unknown hashes 404', async () => {
    const { fetch } = setup()
    expect((await fetch(`${API}/api/v1/results/${MOCK_OFFICIAL_HASH}/provenance`)).status).toBe(200)
    expect((await fetch(`${API}/api/v1/results/ffffffffffffffff/provenance`)).status).toBe(404)
    expect(RUN_RECORD_OFFICIAL.origin).toBe('precomputed')
  })
})

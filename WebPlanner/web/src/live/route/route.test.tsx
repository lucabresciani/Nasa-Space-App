// R5 (D97) acceptance against the mocks (mock/route.ts over mock/fetch.ts): the Edit-route panel in
// the Plan rail; checkbox + reorder (drag and Alt+Up/Down) give the submitted route; Compute plan
// shows the staged result (nominal band and route first) labelled "Computed live · your route" with a
// provenance link; an infeasible order names the first failing leg, the limit and the time short, and
// that leg is marked in the list and drawn on the map; a 422 reads as text naming the stop; with
// VITE_LIVE off nothing of this is in the static bundle path.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { render, type ComponentChildren } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCatalog } from '../../edit/options'
import type { StationGeo, StopProbe } from '../../edit/route/model'
import { ROUTE_TEXT } from '../../edit/route/text'
import type { RouteFC } from '../../data/types'
import { all, byClass, hasClass, installDom, type FakeNode } from '../../ui/testing/dom'
import { dockContent, setDockContent, type RailSection } from '../../ui/shell/store'
import { TOKENS } from '../../ui/tokens'
import { createApiClient } from '../client'
import { LIVE_LABEL } from '../config'
import type { LiveState } from '../health'
import { HEALTH_WARM } from '../mock/fixtures'
import { createMockFetch } from '../mock/fetch'
import { MOCK_INFEASIBLE_LEG, routeFeasibility, routeRefusal, routeRunRecord, RUN_RECORD_ROUTE_INFEASIBLE, withRouteMock } from '../mock/route'
import { validatePlanInputs, validateRunRecord } from '../schemacheck'
import orderedExample from '../../../../contracts/backend/examples/plan_inputs.route_ordered.json'
import { mockLiveLoader } from '../result'
import { createRouteJobs } from './jobs'
import { FAILING_LEG_ID, type RouteConsoleMap } from './map'
import { mountRoutePanel, ROUTE_SECTION_ID } from './mount'
import { readFeasibility } from './types'

const PUB = resolve(__dirname, '../../../public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(PUB, p), 'utf8'))
const catalog = buildCatalog(json('scenarios/index.json'), json('scenarios/pads/index.json'), json('stations.json'))
const stations: StationGeo[] = (json('stations.json') as StationGeo[]).map(({ id, name, lon, lat }) => ({ id, name, lon, lat }))
const probe = (): StopProbe => ({ inGrid: true, assessed: true, walkable: true, reachable: true })
const FAST = { pollInitialMs: 1, pollFactor: 1, pollMaxMs: 1 }

function fakeConsoleMap() {
  const data = new Map<string, unknown>()
  const layers: Record<string, unknown>[] = []
  const calls: { scenario: number; route: (RouteFC | null)[] } = { scenario: 0, route: [] }
  const box = { dataset: {} as Record<string, string> }
  const cm: RouteConsoleMap = {
    map: {
      getSource: (id) => (data.has(id) ? { setData: (d: unknown) => data.set(id, d) } : undefined),
      addSource: (id, spec) => data.set(id, spec.data),
      addLayer: (spec) => layers.push(spec),
      getLayer: (id) => layers.find((l) => l.id === id),
      getContainer: () => box as unknown as HTMLElement,
    },
    whenReady: async () => {},
    setScenarioData: async () => void calls.scenario++,
    setRoute: async (r) => void calls.route.push(r),
  }
  return { cm, data, layers, calls, box }
}

let root: FakeNode
let cleanup: (() => void) | null = null
beforeEach(() => {
  ;({ container: root } = installDom())
})
afterEach(() => {
  act(() => {
    cleanup?.()
    render(null, root as unknown as Element)
  })
  cleanup = null
})

const flush = () => new Promise((r) => setTimeout(r, 2))
async function until(fn: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (fn()) return
    await act(async () => {
      await flush()
    })
  }
  throw new Error(`timed out waiting for ${what}`)
}
const text = (n: FakeNode) => n.textContent.replace(/\s+/g, ' ').trim()

async function setup() {
  const fetch = withRouteMock(createMockFetch())
  const client = createApiClient({ base: 'http://api.test', fetch })
  const map = fakeConsoleMap()
  let section: RailSection | null = null
  let live: ((s: LiveState) => void) | null = null
  const restored = { n: 0 }
  cleanup = mountRoutePanel({
    client,
    loaderFor: mockLiveLoader(fetch),
    onLiveState: (fn) => {
      live = fn
      fn({ kind: 'ready', health: HEALTH_WARM } as LiveState)
      return () => {}
    },
    cmap: map.cm,
    restore: async () => void restored.n++,
    catalog,
    stations,
    probe,
    job: FAST,
    register: (s) => {
      section = s
      return () => (section = null)
    },
  })
  await until(() => section !== null, 'the rail section')
  const s = section as unknown as RailSection
  act(() => render(s.render() as ComponentChildren, root as unknown as Element))
  await until(() => byClass(root, 'hl-route__hash')[0]?.textContent.includes(ROUTE_TEXT.hashPending) === false, 'the engine identity')
  return { fetch, map, restored, section: s, setLive: (st: LiveState) => act(() => live!(st)) }
}

const q = (cls: string) => byClass(root, cls)
const row = (id: string) => all(root, (n) => n.getAttribute('data-station') === id)[0]
const click = (n: FakeNode) => act(() => void n.dispatch('click'))
function check(id: string, on = true) {
  const cb = all(row(id), (n) => hasClass(n, 'hl-route__check'))[0] as FakeNode & { checked?: boolean }
  cb.checked = on
  act(() => void cb.dispatch('change'))
}
const mode = (m: 'auto' | 'ordered') => click(all(root, (n) => n.getAttribute('data-value') === m)[0])
const order = () => all(root, (n) => hasClass(n, 'hl-route__stop') && hasClass(n, 'is-checked')).map((n) => n.getAttribute('data-station'))
const posted = (fetch: ReturnType<typeof withRouteMock>) => fetch.calls.filter((c) => c.method === 'POST' && c.path === '/jobs').map((c) => (c.body as { inputs: { route?: unknown } }).inputs.route)

describe('Edit-route panel (Plan rail, live builds)', () => {
  it('registers one Plan-mode rail section and lists the six stations, unchecked, in auto mode', async () => {
    const { section } = await setup()
    expect(section).toMatchObject({ id: ROUTE_SECTION_ID, modes: ['plan'] })
    expect(all(root, (n) => hasClass(n, 'hl-route__stop')).map((n) => n.getAttribute('data-station'))).toEqual(['S1', 'S2', 'S4', 'S6', 'S7', 'S8'])
    expect(order()).toEqual([])
    expect(text(root)).toContain(ROUTE_TEXT.autoNote)
  })

  it('checkbox + drag + Alt+Up/Down give the route payload in that order; the hash changes with the order; undo restores', async () => {
    const { fetch } = await setup()
    const hash = () => text(q('hl-route__hash')[0])
    const autoHash = hash()
    mode('ordered')
    check('S4')
    check('S1')
    check('S2')
    expect(order()).toEqual(['S4', 'S1', 'S2'])
    const h412 = hash()
    expect(h412).not.toBe(autoHash)
    // drag S2 onto the first row: nothing changes until the drop
    act(() => void row('S2').dispatch('dragstart', { dataTransfer: { setData() {} } }))
    expect(order()).toEqual(['S4', 'S1', 'S2'])
    act(() => void row('S4').dispatch('drop'))
    expect(order()).toEqual(['S2', 'S4', 'S1'])
    const h241 = hash()
    expect(h241).not.toBe(h412)
    // keyboard: Alt+Down on S2
    act(() => void row('S2').dispatch('keydown', { key: 'ArrowDown', altKey: true }))
    expect(order()).toEqual(['S4', 'S2', 'S1'])
    act(() => void row('S1').dispatch('keydown', { key: 'ArrowUp', altKey: true }))
    expect(order()).toEqual(['S4', 'S1', 'S2'])
    expect(hash()).toBe(h412) // same order, same hash
    // undo (Ctrl+Z in the panel) walks back exactly: S4,S2,S1 -> S2,S4,S1
    act(() => void q('hl-route')[0].dispatch('keydown', { key: 'z', ctrlKey: true }))
    expect(order()).toEqual(['S4', 'S2', 'S1'])
    act(() => void q('hl-route')[0].dispatch('keydown', { key: 'z', ctrlKey: true }))
    expect(order()).toEqual(['S2', 'S4', 'S1'])
    expect(hash()).toBe(h241)
    act(() => void q('hl-route')[0].dispatch('keydown', { key: 'z', ctrlKey: true, shiftKey: true }))
    expect(order()).toEqual(['S4', 'S2', 'S1'])
    expect(posted(fetch)).toEqual([]) // D85: no job without Compute plan
  })

  it('Compute plan: the job carries the route as ordered; staged result labelled "Computed live · your route" with provenance', async () => {
    const { fetch, map } = await setup()
    mode('ordered')
    check('S2')
    check('S4')
    click(q('hl-route__compute')[0])
    await until(() => q('hl-route__result').length > 0, 'the result')
    expect(posted(fetch)).toEqual([{ mode: 'ordered', stops: [{ station: 'S2' }, { station: 'S4' }] }])
    const stages = q('hl-route__stage')
    expect(stages.map((s) => s.getAttribute('data-stage'))).toEqual(['first', 'rest'])
    expect(stages.every((s) => hasClass(s, 'is-shown'))).toBe(true)
    expect(map.calls.scenario).toBeGreaterThan(0) // drawn through the console map's own setters
    expect(map.calls.route.at(-1)).not.toBeNull()
    const res = text(q('hl-route__result')[0])
    expect(res).toContain(ROUTE_TEXT.computedLabel)
    expect(res).toContain(ROUTE_TEXT.feasible)
    const prov = q('hl-route__prov')[0]
    expect(prov.getAttribute('href')).toMatch(/^#\/plan\/[0-9a-f]{16}\/provenance$/)
    expect(prov.getAttribute('href')).toContain(q('hl-route__result')[0].getAttribute('data-hash'))
    expect(q('hl-route__infeasible')).toHaveLength(0)
    expect(map.data.get(FAILING_LEG_ID) ?? null).toBeNull() // no highlight for a feasible route
    expect(q('hl-route__result')[0].getAttribute('data-trust')).toBe('live')
    expect(LIVE_LABEL).toBeTruthy()
  })

  it('staged rendering: the nominal band and route are shown before the job is done', async () => {
    const { map } = await setup()
    mode('ordered')
    check('S6')
    click(q('hl-route__compute')[0])
    await until(() => q('hl-route__stage').some((s) => s.getAttribute('data-stage') === 'first' && hasClass(s, 'is-shown')), 'the first stage')
    // either still running with the first stage shown, or done; in both cases bands + route arrived first
    expect(map.calls.route.length).toBeGreaterThan(0)
    expect(map.calls.scenario).toBeGreaterThan(0)
  })

  it('infeasible order: names the first failing leg, the limit and the time short; marks the leg; map highlights it; order unchanged', async () => {
    const { map, restored } = await setup()
    mode('ordered')
    for (const id of ['S4', 'S1', 'S2']) check(id)
    click(q('hl-route__compute')[0])
    await until(() => q('hl-route__infeasible').length > 0, 'the infeasible answer')
    const box = q('hl-route__infeasible')[0]
    expect(box.getAttribute('data-leg')).toBe('2')
    expect(box.getAttribute('data-limit')).toBe('O2')
    const s = text(box)
    expect(s).toContain('Leg 3: S1 → S2')
    expect(s).toContain('O₂ at the effort-cap rate (D45)')
    expect(s).toContain(`Short by ${MOCK_INFEASIBLE_LEG.shortfall_min.toFixed(1)} min`)
    const legs = q('hl-route__leg')
    expect(legs.map((l) => l.getAttribute('data-state'))).toEqual(['planned', 'planned', 'failing', 'not-planned'])
    expect(hasClass(legs[2], 'is-failing')).toBe(true)
    await until(() => !!map.data.get(FAILING_LEG_ID), 'the map highlight')
    const fc = map.data.get(FAILING_LEG_ID) as GeoJSON.FeatureCollection
    const s1 = stations.find((x) => x.id === 'S1')!
    const s2 = stations.find((x) => x.id === 'S2')!
    expect((fc.features[0].geometry as GeoJSON.LineString).coordinates).toEqual([[s1.lon, s1.lat], [s2.lon, s2.lat]])
    expect(map.layers.find((l) => l.id === FAILING_LEG_ID)).toMatchObject({ type: 'line', paint: { 'line-color': TOKENS.color.limit } })
    expect(order()).toEqual(['S4', 'S1', 'S2']) // nothing reordered
    expect(map.box.dataset.failingLeg).toBe('2')
    expect(q('hl-route')[0].getAttribute('data-state')).toBe('done')
    expect(q('hl-route')[0].getAttribute('data-feasible')).toBe('false')
    // the answer sits at the top of the panel, before the mode switch and the list (R5-C)
    const kids = q('hl-route')[0].childNodes.map((n) => n.getAttribute?.('class') ?? '')
    expect(kids.indexOf('hl-route__result')).toBeLessThan(kids.findIndex((k) => k.startsWith('hl-route__mode')))
    // the next edit clears the answer and the highlight
    act(() => void row('S2').dispatch('keydown', { key: 'ArrowUp', altKey: true }))
    expect(q('hl-route__infeasible')).toHaveLength(0)
    await until(() => (map.data.get(FAILING_LEG_ID) as GeoJSON.FeatureCollection).features.length === 0, 'the highlight cleared')
    expect(map.box.dataset.failingLeg).toBeUndefined()
    expect(restored.n).toBe(1) // the console's static plan is put back
  })

  it('API unreachable (kit rule 4 / F23): the panel is hidden behind the offline banner, comes back with the server, keeps the route; no errors', async () => {
    const errs: unknown[] = []
    const spy = [vi.spyOn(console, 'error').mockImplementation((...a) => void errs.push(a)), vi.spyOn(console, 'warn').mockImplementation((...a) => void errs.push(a))]
    let up = false
    const real = withRouteMock(createMockFetch())
    const flaky = (async (input: string, init?: RequestInit) => {
      if (!up) throw new TypeError('Failed to fetch')
      return real(input, init)
    }) as unknown as typeof fetch
    const client = createApiClient({ base: 'http://api.test', fetch: flaky })
    let section: RailSection | null = null
    let registrations = 0
    let live: ((s: LiveState) => void) | null = null
    cleanup = mountRoutePanel({
      client,
      onLiveState: (fn) => {
        live = fn
        fn({ kind: 'offline' } as LiveState)
        return () => {}
      },
      cmap: fakeConsoleMap().cm,
      catalog,
      stations,
      probe,
      register: (s) => {
        section = s
        registrations++
        return () => (section = null)
      },
    })
    for (let i = 0; i < 20; i++) await act(async () => void (await flush()))
    expect(live).not.toBeNull()
    expect(section).toBeNull() // hidden while offline: nothing half-done, no disabled shell
    for (const st of [{ kind: 'checking' }, { kind: 'warming' }] as LiveState[]) {
      act(() => live!(st))
      expect(section).toBeNull()
    }
    up = true
    act(() => live!({ kind: 'ready', health: HEALTH_WARM } as LiveState))
    expect(section).not.toBeNull()
    act(() => render((section as unknown as RailSection).render() as ComponentChildren, root as unknown as Element))
    await until(() => !text(q('hl-route__hash')[0]).includes(ROUTE_TEXT.hashPending), 'the identity asked again on recovery')
    mode('ordered')
    check('S4')
    act(() => live!({ kind: 'offline' } as LiveState))
    expect(section).toBeNull()
    act(() => live!({ kind: 'ready', health: HEALTH_WARM } as LiveState))
    expect(registrations).toBe(2)
    act(() => render((section as unknown as RailSection).render() as ComponentChildren, root as unknown as Element))
    expect(order()).toEqual(['S4']) // the route survives the outage
    expect(errs).toEqual([])
    spy.forEach((s) => s.mockRestore())
  })

  it('heavy jobs off: shown, Compute disabled with the reason', async () => {
    const { setLive } = await setup()
    mode('ordered')
    check('S1')
    setLive({ kind: 'ready', health: { ...HEALTH_WARM, heavy_jobs: 'off' } } as LiveState)
    expect(q('hl-route__compute')[0].hasAttribute('disabled')).toBe(true)
    expect(text(q('hl-route__reason')[0])).toContain(ROUTE_TEXT.heavyJobsOff)
  })

  it('leaving the console after a result: no restore or draw into the gone map, no warning (R5-B)', async () => {
    const warns: unknown[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a) => void warns.push(a))
    const { restored } = await setup()
    mode('ordered')
    check('S2')
    click(q('hl-route__compute')[0])
    await until(() => q('hl-route__result').length > 0, 'the result')
    act(() => {
      cleanup?.()
      cleanup = null
    })
    await act(async () => void (await flush()))
    expect(restored.n).toBe(0)
    expect(warns).toEqual([])
    spy.mockRestore()
  })

  it('the dock never shows the official timeline under a route result: a note with the result link, the old dock back after an edit (R5-C)', async () => {
    const before = () => 'official-dock'
    setDockContent(before)
    await setup()
    mode('ordered')
    for (const id of ['S4', 'S1', 'S2']) check(id)
    click(q('hl-route__compute')[0])
    await until(() => q('hl-route__result').length > 0, 'the result')
    const note = dockContent.peek()
    expect(note).not.toBe(before)
    const box = installDom().container
    act(() => render(note!() as ComponentChildren, box as unknown as Element))
    const hash = q('hl-route__result')[0].getAttribute('data-hash')!
    expect(text(box)).toContain(ROUTE_TEXT.dockNote)
    expect(all(box, (n) => n.localName === 'a')[0].getAttribute('href')).toBe(`#/plan/${hash}`)
    act(() => void row('S2').dispatch('keydown', { key: 'ArrowUp', altKey: true }))
    expect(dockContent.peek()).toBe(before)
    setDockContent(undefined)
  })
})

describe('422 for a bad stop', () => {
  it('the refusal keeps status, code and stop, and the panel text names the stop', async () => {
    const fetch = withRouteMock(createMockFetch())
    const client = createApiClient({ base: 'http://api.test', fetch })
    const jobs = createRouteJobs({ client, loaderFor: mockLiveLoader(fetch), job: FAST })
    const inputs = { contract_version: '1.1.0', pad: { lon: 137.4, lat: -4.78 }, route: { mode: 'ordered' as const, stops: [{ station: 'S4' }, { station: 'S4' }] } }
    const out = await jobs.run(inputs, { onUpdate() {}, onStage() {} }).promise
    expect(out).toMatchObject({ status: 'failed', failure: { status: 422, code: 'route_station_duplicate', stop: 1 } })
    // the panel's failure view
    const { failureText } = await import('../../edit/route/text')
    if (out.status !== 'failed') throw new Error('expected a failure')
    expect(failureText(out.failure, (i) => ['S4', 'S4'][i])).toBe('Stop 2 (S4): a station is in the route twice')
    expect(routeRefusal({ mode: 'ordered', stops: [] })).toMatchObject({ error: 'invalid_input' })
  })
})

describe('contract v1.2.0 (R0 #105): what the panel sends and the mocks answer', () => {
  it('the submitted inputs and every mock run record validate against the v1.2.0 schemas', async () => {
    const { fetch } = await setup()
    mode('ordered')
    for (const id of ['S4', 'S1', 'S2']) check(id)
    click(q('hl-route__compute')[0])
    await until(() => q('hl-route__infeasible').length > 0, 'the answer')
    const sent = (fetch.calls.find((c) => c.method === 'POST' && c.path === '/jobs')!.body as { inputs: unknown }).inputs as Record<string, unknown>
    expect(validatePlanInputs(sent)).toEqual([])
    expect(sent.route).toEqual(orderedExample.route) // the R0 example's route, built by checkbox
    expect(validateRunRecord(RUN_RECORD_ROUTE_INFEASIBLE)).toEqual([])
    for (const f of [routeFeasibility({ mode: 'ordered', stops: [{ station: 'S2' }] }), routeFeasibility(orderedExample.route as never)])
      expect(validateRunRecord(routeRunRecord('0123456789abcdef', sent, f))).toEqual([])
    expect(routeFeasibility(orderedExample.route as never)).toEqual(RUN_RECORD_ROUTE_INFEASIBLE.feasibility)
  })
})

describe('feasibility reading', () => {
  it('feasibility: v1.2.0 block, v1.1 infeasible fallback, malformed = error, never guessed', () => {
    expect(readFeasibility({ feasibility: { feasible: true } })).toEqual({ value: { feasible: true }, error: null })
    const inf = { feasible: false, leg: 2, from: 'S1', to: 'S2', limit: 'O2', shortfall_min: 12.4, legs_planned: 2 }
    expect(readFeasibility({ feasibility: inf }).value).toEqual(inf)
    expect(readFeasibility({ infeasible: { leg: 2, from: 'S1', to: 'S2', margin_min: -12.4, binding: 'O2' } }).value).toMatchObject({ feasible: false, leg: 2, limit: 'O2', shortfall_min: 12.4 })
    expect(readFeasibility({ feasibility: { ...inf, limit: 'fuel' } }).error).toMatch(/malformed/)
    expect(routeFeasibility({ mode: 'ordered', stops: [{ station: 'S4' }, { station: 'S1' }, { station: 'S2' }] })).toEqual(inf)
  })
})

// VITE_LIVE off: the static entry never reaches edit/route or live/route (same walk as isolation.test.ts).
describe('VITE_LIVE off: nothing mounts', () => {
  const SRC = resolve(__dirname, '../..')
  const STATIC_RE = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g
  const resolveImport = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const base = resolve(dirname(from), spec.replace(/\?.*$/, ''))
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (existsSync(c) && statSync(c).isFile()) return c
    return null
  }
  const ROUTE_DIRS = [resolve(SRC, 'edit', 'route'), resolve(SRC, 'live', 'route'), resolve(SRC, 'live')]
  const inRoute = (f: string) => ROUTE_DIRS.some((d) => f === d || f.startsWith(d + sep))

  it('the static module graph (static and unguarded dynamic imports) holds no route module', () => {
    const seen = new Set<string>()
    const stack = [resolve(SRC, 'main.ts')]
    while (stack.length) {
      const f = stack.pop()!
      if (seen.has(f) || !/\.(ts|tsx)$/.test(f)) continue
      seen.add(f)
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(STATIC_RE)) {
        const to = resolveImport(f, m[1])
        if (to) stack.push(to)
      }
      for (const m of src.matchAll(DYNAMIC_RE)) {
        const to = resolveImport(f, m[1])
        const guarded = /import\.meta\.env\.VITE_LIVE\b/.test(src.slice(0, m.index).split('\n').slice(-4).join('\n'))
        if (to && !guarded) stack.push(to)
      }
    }
    expect([...seen].filter(inRoute).map((f) => relative(SRC, f))).toEqual([])
  })

  it('edit/route is imported only from src/live (and itself)', () => {
    const offenders: string[] = []
    const visit = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) visit(p)
        else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) && !inRoute(p)) {
          const src = readFileSync(p, 'utf8')
          for (const m of src.matchAll(STATIC_RE)) {
            const to = resolveImport(p, m[1])
            if (to && to.startsWith(resolve(SRC, 'edit', 'route') + sep)) offenders.push(`${relative(SRC, p)}: ${m[1]}`)
          }
        }
      }
    }
    visit(SRC)
    expect(offenders).toEqual([])
  })
})

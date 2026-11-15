// WP14 (D116): VITE_ROUTE_EDIT=0 hides route editing on a build (the published Pages site until the
// team lead's OK): padTool never mounts the Edit-route panel, so no rail entry, no route DOM and no
// map waypoints (WP6 installs those with the panel). Unset (the localhost demo, every other build)
// mounts it as before. Also: a route 422's Error.stop (contract v1.2.0) reaches the panel's text.
import type { ComponentChildren } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildCatalog } from '../edit/options'
import type { StationGeo, StopProbe } from '../edit/route/model'
import { GHOST_LAYER_ID } from '../edit/route/map/layer'
import { failureText } from '../edit/route/text'
import { all, hasClass, installDom, type FakeNode } from '../ui/testing/dom'
import { ApiError, createApiClient, type FetchLike } from './client'
import { isRouteEditFlag } from './config'
import type { LiveState } from './health'
import type { MapPort } from './mapPort'
import { HEALTH_WARM } from './mock/fixtures'
import { createMockFetch } from './mock/fetch'
import { withRouteMock } from './mock/route'
import { mockLiveLoader } from './result'
import { createRouteJobs, failureOf } from './route/jobs'
import { errorStop } from './route/types'

const PUB = resolve(__dirname, '../../public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(PUB, p), 'utf8'))
const catalog = buildCatalog(json('scenarios/index.json'), json('scenarios/pads/index.json'), json('stations.json'))
const stations: StationGeo[] = (json('stations.json') as StationGeo[]).map(({ id, name, lon, lat }) => ({ id, name, lon, lat }))
const probe = (): StopProbe => ({ inGrid: true, assessed: true, walkable: true, reachable: true })
const FAST = { pollInitialMs: 1, pollFactor: 1, pollMaxMs: 1 }
const ROUTE_ID = 'edit-route'

/** A console map that records what is put on it: sources, layers, DOM listeners (WP6 waypoints). */
function fakeConsoleMap() {
  const sources = new Map<string, unknown>()
  const layers = new Map<string, Record<string, unknown>>()
  const listeners: string[] = []
  const classes = new Set<string>()
  const container = {
    dataset: {} as Record<string, string>,
    addEventListener: (t: string) => void listeners.push(t),
    removeEventListener: (t: string) => void listeners.splice(listeners.indexOf(t), 1),
    classList: { toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)), contains: (c: string) => classes.has(c) },
  }
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0 }) }
  const map = {
    on: () => {},
    off: () => {},
    getContainer: () => container as unknown as HTMLElement,
    getCanvas: () => canvas as unknown as HTMLElement,
    project: ([x, y]: [number, number]) => ({ x, y }),
    unproject: ([x, y]: [number, number]) => ({ lng: x, lat: y }),
    getSource: (id: string) => (sources.has(id) ? { setData: (d: unknown) => sources.set(id, d) } : undefined),
    addSource: (id: string, spec: { data: unknown }) => sources.set(id, spec.data),
    addLayer: (spec: Record<string, unknown>) => layers.set(spec.id as string, spec),
    getLayer: (id: string) => layers.get(id),
  }
  const cm = { map, whenReady: async () => {}, setScenarioData: async () => {}, setRoute: async () => {} }
  return { cm, sources, layers, listeners }
}

const fakePort = (consoleMap: unknown): MapPort & { consoleMap: unknown } => ({
  onClick: () => () => {},
  setLivePad: () => {},
  setScenarioData: async () => {},
  setRoute: async () => {},
  restoreStatic: () => {},
  consoleMap,
})

const flush = () => new Promise((r) => setTimeout(r, 2))
const routeDom = (n: FakeNode) => all(n, (x) => [...(x.getAttribute('class') ?? '').split(/\s+/)].some((c) => c.startsWith('hl-route')))

describe('VITE_ROUTE_EDIT parsing', () => {
  it('on unless 0 or false', () => {
    for (const v of [undefined, '', '1', 'true', 'yes', true]) expect(isRouteEditFlag(v)).toBe(true)
    for (const v of ['0', 'false', false]) expect(isRouteEditFlag(v)).toBe(false)
  })
})

describe('padTool and VITE_ROUTE_EDIT (D116)', () => {
  let root: FakeNode
  let panel: FakeNode
  let off: (() => void) | null = null
  const spy = vi.fn()

  beforeEach(() => {
    ;({ container: root } = installDom())
    panel = (globalThis as unknown as { document: { createElement(t: string): FakeNode } }).document.createElement('div')
    spy.mockReset()
    vi.resetModules()
    // the real panel, with the test's catalog and an engine that is ready
    vi.doMock('./route/mount', async (importOriginal) => {
      const m = await importOriginal<typeof import('./route/mount')>()
      const ready = (fn: (s: LiveState) => void) => (fn({ kind: 'ready', health: HEALTH_WARM } as LiveState), () => {})
      spy.mockImplementation((o: Parameters<typeof m.mountRoutePanel>[0]) => m.mountRoutePanel({ ...o, onLiveState: ready, catalog, stations, probe, job: FAST }))
      return { ...m, mountRoutePanel: spy }
    })
  })
  afterEach(() => {
    off?.()
    off = null
    vi.doUnmock('./route/mount')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  // index.ts, the shell store and preact from one fresh module graph (the flag is read at import)
  async function mountWith(flag: string | undefined) {
    if (flag !== undefined) vi.stubEnv('VITE_ROUTE_EDIT', flag)
    const live = await import('./index')
    const { railSections } = await import('../ui/shell/store')
    const { render: draw } = await import('preact')
    const { act: step } = await import('preact/test-utils')
    const fetch = withRouteMock(createMockFetch())
    const client = createApiClient({ base: 'http://api.test', fetch })
    const cmap = fakeConsoleMap()
    off = live.padTool(panel as unknown as Element, fakePort(cmap.cm), client)
    const tick = async (n: number, done: () => boolean = () => false) => {
      for (let i = 0; i < n && !done(); i++) await step(async () => void (await flush()))
    }
    const renderRail = () => {
      for (const s of railSections.peek()) step(() => draw(s.render() as ComponentChildren, root as unknown as Element))
    }
    return { live, cmap, railSections, tick, renderRail, unmount: () => step(() => draw(null, root as unknown as Element)) }
  }

  it('unset: the Edit-route panel mounts as before (rail entry, route DOM, map waypoint layer)', async () => {
    const t = await mountWith(undefined)
    expect(t.live.ROUTE_EDIT_ENABLED).toBe(true)
    const has = () => t.railSections.peek().some((s) => s.id === ROUTE_ID)
    await t.tick(400, has)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(has()).toBe(true)
    t.renderRail()
    await t.tick(400, () => all(root, (n) => hasClass(n, 'hl-route__stop')).length > 0)
    expect(all(root, (n) => hasClass(n, 'hl-route__stop')).length).toBeGreaterThan(0)
    // WP6: the waypoint layer (ghost route) and the armed-click listeners are on the console map
    await t.tick(50, () => t.cmap.layers.has(GHOST_LAYER_ID))
    expect(t.cmap.layers.has(GHOST_LAYER_ID)).toBe(true)
    expect(t.cmap.listeners).toEqual(expect.arrayContaining(['click', 'pointerdown']))
    t.unmount()
  })

  for (const flag of ['0', 'false']) {
    it(`"${flag}": mountRoutePanel is never called, no Edit-route entry, no route DOM, no map waypoints`, async () => {
      const t = await mountWith(flag)
      expect(t.live.ROUTE_EDIT_ENABLED).toBe(false)
      await t.tick(50)
      expect(spy).not.toHaveBeenCalled()
      expect(t.railSections.peek().some((s) => s.id === ROUTE_ID)).toBe(false)
      t.renderRail()
      expect(routeDom(root)).toEqual([])
      expect(routeDom(panel)).toEqual([])
      // WP6: no waypoint layer, no markers, no armed-click listeners, nothing at all on the console map
      expect(t.cmap.layers.has(GHOST_LAYER_ID)).toBe(false)
      expect([...t.cmap.sources.keys(), ...t.cmap.layers.keys()]).toEqual([])
      expect(t.cmap.listeners).toEqual([])
      t.unmount()
    })
  }
})

describe('Error.stop reaches the panel (contract v1.2.0, W1 scenario c)', () => {
  const BODY = { error: 'route_station_unknown', stop: 1, detail: 'stop 1 (S99): unknown station' }
  const refusing =
    (body: Record<string, unknown>): FetchLike =>
    async (input, init) => {
      const inner = withRouteMock(createMockFetch())
      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && input.endsWith('/jobs'))
        return new Response(JSON.stringify(body), { status: 422, headers: { 'Content-Type': 'application/json' } })
      return inner(input, init)
    }
  const inputs = { contract_version: '1.2.0', pad: { lon: 137.4, lat: -4.78 }, route: { mode: 'ordered' as const, stops: [{ station: 'S4' }, { station: 'S99' }] } }
  const names = ['S4', 'S99']

  it('the client carries Error.stop into ApiError.stop', async () => {
    const client = createApiClient({ base: 'http://api.test', fetch: refusing(BODY) })
    const e = await client.submitJob({ type: 'plan', inputs: inputs as never }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).stop).toBe(1)
    expect((e as ApiError).detail).toBe(BODY.detail)
    const none = await createApiClient({ base: 'http://api.test', fetch: refusing({ error: 'invalid_input', stop: null }) })
      .submitJob({ type: 'plan', inputs: inputs as never })
      .catch((x: unknown) => x)
    expect((none as ApiError).stop).toBeNull()
  })

  it('a 422 {route_station_unknown, stop: 1} reads "Stop 2 (S99): …" in the panel', async () => {
    const fetch = refusing(BODY)
    const client = createApiClient({ base: 'http://api.test', fetch })
    const jobs = createRouteJobs({ client, loaderFor: mockLiveLoader(fetch), job: FAST })
    const out = await jobs.run(inputs as never, { onUpdate() {}, onStage() {} }).promise
    expect(out).toMatchObject({ status: 'failed', failure: { status: 422, code: 'route_station_unknown', stop: 1 } })
    if (out.status !== 'failed') throw new Error('expected a failure')
    expect(failureText(out.failure, (i) => names[i] ?? null)).toBe('Stop 2 (S99): not a station of this site')
  })

  it('ApiError.stop wins over the detail; without it the server detail "stop i (Sx)" and the mock "stops[i]" still name the stop', () => {
    expect(failureOf(new ApiError(422, 'route_station_unknown', 'm', 'stop 0 (S99): unknown station', null, 1), 'x').stop).toBe(1)
    expect(failureOf(new ApiError(422, 'route_station_unknown', 'm', 'stop 1 (S99): unknown station'), 'x').stop).toBe(1)
    expect(errorStop({ detail: 'stops[3]: S9 is not in stations.json' })).toBe(3)
    expect(errorStop({ detail: 'stop 2 (S7): too steep' })).toBe(2)
    expect(errorStop({ detail: 'two stops are too close' })).toBeNull()
    expect(failureOf(new ApiError(400, 'invalid_input', 'm', 'stop 1 (S99)', null, 1), 'x').stop).toBeNull() // only a 422 names a stop
  })
})

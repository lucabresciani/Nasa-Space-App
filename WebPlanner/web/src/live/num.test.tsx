// LiveNum / ScreenNum (brief rule 4) and the console-map adapter (MapPort) with a fake map.
import { describe, expect, it, vi } from 'vitest'
import type { Manifest } from '../data/types'
import { formatValue } from '../prov/provenance'
import { consoleMapPort, LIVE_PAD_SOURCE, type ConsoleMapLike, type MlMapLike } from './mapPort'
import { createMockFetch } from './mock/fetch'
import { MOCK_RESULT_STAGES } from './mock/result'
import { LiveNum, ScreenNum } from './num'
import { mockLiveLoader } from './result'
import { loadStage } from './stage'
import { toHtml } from './testing/html'

const M = MOCK_RESULT_STAGES.bands['manifest.json'] as Manifest
const HASH = '0123456789abcdef'

describe('LiveNum: numbers through the result manifest', () => {
  it('a backed value prints as Num prints it and links to the plan provenance view', () => {
    const h = toHtml(<LiveNum v={24.1} units="%" file="scenarios/index.json" k="reachable_pct.nom_104.30" manifest={M} hash={HASH} />)
    expect(h).toMatch(new RegExp(`^<a class="num num-ok num-live" href="#/plan/${HASH}" title="live manifest: reachable_pct.nom_104.30\\n`))
    expect(h).toContain(`>${formatValue(24.1, '%')}</a>`)
  })
  it('found by file + value when the key differs', () => {
    expect(toHtml(<LiveNum v={31} units="%" file="scenarios/index.json" k="nope" manifest={M} hash={HASH} />)).toContain('live manifest: reachable_pct_range.nom_104.30.high')
  })
  it('a value the manifest lacks (or holds differently) is withheld, never shown', () => {
    for (const [v, m] of [[99.9, M], [24.1, null], [25, M]] as const) {
      const h = toHtml(<LiveNum v={v} units="%" file="scenarios/index.json" k="reachable_pct.nom_104.30" manifest={m} hash={HASH} />)
      expect(h).toContain('not in manifest yet')
      expect(h).not.toContain(String(v))
    }
  })
  it('null is "unknown", as in Num', () => {
    expect(toHtml(<LiveNum v={null} file="scenarios/index.json" manifest={M} hash={HASH} />)).toContain('>unknown<')
  })
  it('ScreenNum flags a preview estimate', () => {
    const h = toHtml(<ScreenNum v={21.4} units="min" />)
    expect(h).toContain('class="num num-screen"')
    expect(h).toContain('>21.4 min<')
    expect(h).toContain('no manifest entry')
  })
})

describe('consoleMapPort (fake ConsoleMap)', () => {
  function fakeConsoleMap() {
    const handlers = new Set<(e: { lngLat: { lng: number; lat: number } }) => void>()
    const sources = new Map<string, { data: unknown; setData(d: unknown): void }>()
    const layers: unknown[] = []
    const map: MlMapLike = {
      on: (_t, fn) => handlers.add(fn),
      off: (_t, fn) => handlers.delete(fn),
      getSource: (id) => sources.get(id),
      addSource: (id, spec) => {
        const s = { data: spec.data as unknown, setData(d: unknown) { this.data = d } }
        sources.set(id, s)
      },
      addLayer: (spec) => layers.push(spec),
      getLayer: (id) => layers.find((l) => (l as { id: string }).id === id),
    }
    const cm: ConsoleMapLike = { map, whenReady: async () => {}, setScenarioData: vi.fn(async () => {}), setRoute: vi.fn(async () => {}) }
    return { cm, handlers, sources, layers }
  }

  it('clicks come out as lon/lat and unsubscribe', () => {
    const f = fakeConsoleMap()
    const port = consoleMapPort(f.cm)
    const got: unknown[] = []
    const off = port.onClick((p) => got.push(p))
    f.handlers.forEach((h) => h({ lngLat: { lng: 137.4, lat: -4.78 } }))
    expect(got).toEqual([{ lon: 137.4, lat: -4.78 }])
    off()
    expect(f.handlers.size).toBe(0)
  })

  it('the live pad is one circle layer; restoreStatic clears it and calls the console back', async () => {
    const f = fakeConsoleMap()
    const restore = vi.fn()
    const port = consoleMapPort(f.cm, restore)
    port.setLivePad({ lon: 1, lat: 2, valid: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(f.layers).toHaveLength(1)
    expect((f.sources.get(LIVE_PAD_SOURCE)!.data as { features: { properties: { state: string } }[] }).features[0].properties.state).toBe('invalid')
    port.restoreStatic()
    await new Promise((r) => setTimeout(r, 0))
    expect((f.sources.get(LIVE_PAD_SOURCE)!.data as { features: unknown[] }).features).toEqual([])
    expect(restore).toHaveBeenCalledOnce()
    expect(f.layers).toHaveLength(1)
  })

  it('scenario layers and the route go to the console map setters unchanged (one rendering path)', async () => {
    const f = fakeConsoleMap()
    const port = consoleMapPort(f.cm)
    const d = { bands: { type: 'FeatureCollection', features: [] }, isochrones: { type: 'FeatureCollection', features: [] }, edges: { type: 'FeatureCollection', features: [] }, partner: { type: 'FeatureCollection', features: [] }, variant: 'nominal' } as never
    await port.setScenarioData(d)
    await port.setRoute(null)
    expect(f.cm.setScenarioData).toHaveBeenCalledWith(d)
    expect(f.cm.setRoute).toHaveBeenCalledWith(null)
  })
})

describe('dev mock loader', () => {
  it('reads the staged tree through the same contract-checking loader', async () => {
    const fetch = createMockFetch()
    const base = 'http://mock.invalid/api/v1/results/0123456789abcdef'
    expect((await loadStage(base, [], mockLiveLoader(fetch))).index).toBeNull()
    await fetch('http://mock.invalid/api/v1/jobs', { method: 'POST', body: '{}' })
    for (let i = 0; i < 4; i++) await fetch('http://mock.invalid/api/v1/jobs/j_01')
    const r = await loadStage(base, ['nominal', 'bands', 'hud'], mockLiveLoader(fetch))
    expect(r.errors).toEqual([])
    expect(r.scenario?.id).toBe('nom_104')
    expect(r.bands?.features).toHaveLength(4)
    expect(r.partner?.features).toHaveLength(1)
  })
})

// A5s acceptance (WS15, D76): the "Send to simulator" slot on the plan / route-summary card and the
// Report view placeholder, behind VITE_SIM_EXPORT (default off).
//  - flag off → nothing rendered, and the slot compiles to a few hundred bytes (its body is dropped);
//  - flag on + no sim_plan manifest entry → nothing;
//  - flag on + two sim_plan entries → two download links named from the manifest, no fetch of them;
//  - format-agnostic: any path / extension is listed as the manifest gives it, nothing is parsed.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, type VNode } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { build, type Plugin } from 'vite'
import type { Manifest } from '../../data/types'
import { dataUrl } from '../../env'
import { setManifest } from '../../prov/store'
import { ReportSimSlot } from '../../report'
import { t } from '../copy'
import { all, byTag, installDom, type FakeNode } from '../testing/dom'
import { RouteSummaryCard } from './cards'
import type { CardData } from './data'
import { SimSlot, simExportOn, simPlanFiles } from './simslot'

const entry = (file: string, kind?: string) => ({ value: file, units: null, file, script: 'x', commit: 'c', utc: 'u', ...(kind ? { kind } : {}) })
/** A result manifest with two sim_plan files (neutral names: the format is open), a duplicate and other kinds. */
const TWO = {
  'export.a.first/plan.any': entry('first/plan.any', 'sim_plan'),
  'export.b.z_second': entry('z_second', 'sim_plan'),
  'export.b.dup': entry('z_second', 'sim_plan'),
  'figure.x': entry('figures/x.json', 'figure'),
  'route.nom_104': entry('route_nom_104.geojson'),
} as unknown as Manifest
const NONE = { 'figure.x': entry('figures/x.json', 'figure'), 'route.nom_104': entry('route_nom_104.geojson') } as unknown as Manifest

let root: FakeNode
const mount = (v: VNode): FakeNode => {
  act(() => render(v, root as unknown as Element))
  return root
}
const links = (n: FakeNode) => byTag(n, 'a')

beforeEach(() => {
  root = installDom().container
})
afterEach(() => {
  act(() => render(null, root as unknown as Element))
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  setManifest(null)
})

describe('VITE_SIM_EXPORT off (default)', () => {
  it('the test environment runs with the flag off; only 1 or true turn it on', () => {
    expect(simExportOn()).toBe(false)
    for (const v of ['', '0', 'false', 'yes']) {
      vi.stubEnv('VITE_SIM_EXPORT', v)
      expect(simExportOn()).toBe(false)
    }
    for (const v of ['1', 'true']) {
      vi.stubEnv('VITE_SIM_EXPORT', v)
      expect(simExportOn()).toBe(true)
    }
  })

  it('renders nothing, even with sim_plan files in the manifest', () => {
    expect(mount(<SimSlot manifest={TWO} />).childNodes).toEqual([])
    setManifest(TWO)
    expect(mount(<SimSlot />).childNodes).toEqual([])
    expect(mount(<ReportSimSlot />).childNodes).toEqual([])
  })

  it('the plan card shows no slot', () => {
    setManifest(TWO)
    const n = mount(<RouteSummaryCard d={NO_ROUTE} />)
    expect(all(n, (x) => x.getAttribute('data-slot') === 'sim')).toEqual([])
    expect(n.textContent).not.toContain(t('simulator.sendSlot'))
  })

  it('compiles to a few hundred bytes: the slot body and its manifest reader are dropped', async () => {
    const off = await bundleOfSlot(undefined)
    const on = await bundleOfSlot('1')
    expect(off.length).toBeLessThan(400)
    expect(off).not.toContain('sim_plan')
    expect(on).toContain('sim_plan') // the measurement is not vacuous
    expect(on.length).toBeGreaterThan(off.length)
  }, 30_000)
})

describe('VITE_SIM_EXPORT on', () => {
  beforeEach(() => vi.stubEnv('VITE_SIM_EXPORT', '1'))

  it('no sim_plan entry (or no manifest) → nothing', () => {
    expect(mount(<SimSlot manifest={NONE} />).childNodes).toEqual([])
    expect(mount(<SimSlot manifest={null} />).childNodes).toEqual([])
    setManifest(NONE)
    expect(mount(<SimSlot />).childNodes).toEqual([])
    expect(mount(<ReportSimSlot />).childNodes).toEqual([])
    expect(all(mount(<RouteSummaryCard d={NO_ROUTE} />), (x) => x.getAttribute('data-slot') === 'sim')).toEqual([])
  })

  it('two sim_plan entries → two download links with the manifest file names, no fetch of their contents', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no fetch expected')))
    vi.stubGlobal('fetch', fetchSpy)
    const n = mount(<SimSlot manifest={TWO} />)
    const a = links(n)
    expect(a.length).toBe(2)
    expect(a.map((x) => x.getAttribute('href'))).toEqual([dataUrl('first/plan.any'), dataUrl('z_second')])
    expect(a.map((x) => x.getAttribute('download'))).toEqual(['plan.any', 'z_second'])
    expect(a.map((x) => x.textContent.trim())).toEqual(['first/plan.any', 'z_second'])
    expect(n.textContent).toContain(t('simulator.sendSlot'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('links point into the loaded result tree when a result base URL is given', () => {
    const base = 'https://example.test/api/v1/results/abc123'
    const a = links(mount(<SimSlot manifest={TWO} base={base} />))
    expect(a.map((x) => x.getAttribute('href'))).toEqual([`${base}/first/plan.any`, `${base}/z_second`])
  })

  it('reads the loaded manifest by default, on the plan card and in the Report placeholder', () => {
    setManifest(TWO)
    expect(links(mount(<SimSlot />)).length).toBe(2)
    expect(links(mount(<ReportSimSlot />)).length).toBe(2)
    const card = mount(<RouteSummaryCard d={NO_ROUTE} />)
    const slot = all(card, (x) => x.getAttribute('data-slot') === 'sim')
    expect(slot.length).toBe(1)
    expect(links(slot[0]).map((x) => x.getAttribute('download'))).toEqual(['plan.any', 'z_second'])
  })

  it('is format-agnostic: lists exactly the kind/file pairs, ignores malformed entries', () => {
    const m = {
      a: { kind: 'sim_plan', file: 'deep/dir/no-extension' },
      b: { kind: 'sim_plan', file: '' },
      c: { kind: 'sim_plan' },
      d: { kind: 'SIM_PLAN', file: 'x' },
      e: null,
      f: { kind: 'sim_plan', file: 'w.zip' },
    } as unknown as Manifest
    expect(simPlanFiles(m).map((f) => f.file)).toEqual(['deep/dir/no-extension', 'w.zip'])
    expect(simPlanFiles(null)).toEqual([])
  })
})

describe('format-agnostic source (D76)', () => {
  it('the slot never fetches, parses or names a compiled-plan file', () => {
    const src = readFileSync(resolve(__dirname, 'simslot.tsx'), 'utf8').replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '')
    expect(src).not.toMatch(/fetch\(|JSON\.parse|\.json\b|route_package|compiled_plan|contracts\/sim/)
  })
})

// ------------------------------------------------------------ helpers

/** Route summary card data with no route (the card's "no route" branch; enough to host the slot). */
const NO_ROUTE = {
  stations: [],
  official: { route: null, timeline: null, routeFile: 'route_x.geojson', timelineFile: 'timeline_x.json', routeKey: 'route.x', timelineKey: 'timeline.x' },
} as unknown as CardData

/**
 * Minified size of what a caller of <SimSlot/> ships, with VITE_SIM_EXPORT as given. Everything the
 * app already ships (preact, the manifest store, env, copy, components) is external; only the slot's
 * own code is measured. In-memory build of one tiny module (no output written).
 */
async function bundleOfSlot(flag: string | undefined): Promise<string> {
  const SLOT = resolve(__dirname, 'simslot.tsx')
  const virtual: Plugin = {
    name: 'simslot-entry',
    enforce: 'pre',
    resolveId: (id) => (id.endsWith('virtual:entry') ? '\0entry' : null),
    load: (id) => (id === '\0entry' ? `import { SimSlot } from ${JSON.stringify(SLOT)}\nexport default SimSlot\n` : null),
  }
  const out = await build({
    configFile: false,
    mode: 'production',
    root: resolve(__dirname, '../../..'),
    logLevel: 'silent',
    plugins: [virtual],
    define: { 'import.meta.env.VITE_SIM_EXPORT': flag === undefined ? 'undefined' : JSON.stringify(flag) },
    build: {
      write: false,
      minify: true,
      lib: { entry: 'virtual:entry', formats: ['es'], fileName: 'slot' },
      rollupOptions: { external: (id) => /^preact/.test(id) || /\/(prov\/store|env|copy|components)(\.tsx?)?$/.test(id) },
    },
  })
  const res = Array.isArray(out) ? out[0] : out
  const chunk = (res as { output: { type: string; code?: string }[] }).output.find((o) => o.type === 'chunk')
  return chunk?.code ?? ''
}

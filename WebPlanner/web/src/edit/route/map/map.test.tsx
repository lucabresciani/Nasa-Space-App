// WP6 (D97): the panel rows and the map binding with the selectors the e2e harness reads (WP8a #118
// drive-route.mjs scenario d), and rule 4 (static first): with VITE_LIVE off nothing of the route
// panel or of these waypoints is in the static module graph, so the static build stays byte-identical.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { signal } from '../../../state/signal'
import { all, byClass, installDom, type FakeNode } from '../../../ui/testing/dom'
import { buildCatalog } from '../../options'
import { createRouteController, type RouteJobs } from '../controller'
import { stopNames, type StationGeo } from '../model'
import { RoutePanel } from '../panel'
import { createRouteStore } from '../store'
import { disposeEditor, editorOf } from './editor'
import { GHOST_LAYER_ID, GHOST_SOURCE_ID, attachWaypointMap, type PointMarker, type WaypointConsoleMap } from './layer'
import { TOKENS } from '../../../ui/tokens'

const SRC = resolve(__dirname, '../../..')
const PUB = resolve(SRC, '../public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(PUB, p), 'utf8'))
const catalog = buildCatalog(json('scenarios/index.json'), json('scenarios/pads/index.json'), json('stations.json'))
const stations: StationGeo[] = (json('stations.json') as StationGeo[]).map(({ id, name, lon, lat }) => ({ id, name, lon, lat }))
const PAD = { lon: 137.401783, lat: -4.77748 }
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

// ---- fakes: a MapLibre-like map and markers (structural, no WebGL) -------------------------------

class FakeEl {
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  classes = new Set<string>()
  listeners = new Map<string, Set<(e: unknown) => void>>()
  textContent = ''
  title = ''
  tabIndex = -1
  className = ''
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    toggle: (c: string, on?: boolean) => ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v
  }
  addEventListener(t: string, fn: (e: unknown) => void) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set())
    this.listeners.get(t)!.add(fn)
  }
  removeEventListener(t: string, fn: (e: unknown) => void) {
    this.listeners.get(t)?.delete(fn)
  }
  fire(t: string, e: Record<string, unknown> = {}) {
    let stopped = false
    for (const fn of this.listeners.get(t) ?? []) fn({ ...e, stopPropagation: () => (stopped = true) })
    return stopped
  }
}
class FakeMarker implements PointMarker {
  ll: [number, number] = [0, 0]
  draggable = false
  added = false
  handlers = new Map<string, () => void>()
  readonly el: FakeEl
  constructor(el: FakeEl) {
    this.el = el
  }
  getElement() {
    return this.el as unknown as HTMLElement
  }
  getLngLat() {
    return { lng: this.ll[0], lat: this.ll[1] }
  }
  setLngLat(ll: [number, number]) {
    this.ll = ll
  }
  setDraggable(on: boolean) {
    this.draggable = on
  }
  on(t: 'dragstart' | 'dragend', fn: () => void) {
    this.handlers.set(t, fn)
  }
  addTo() {
    this.added = true
  }
  remove() {
    this.added = false
  }
}
function fakeMap() {
  const sources = new Map<string, { data: unknown; setData(d: unknown): void }>()
  const layers = new Map<string, Record<string, unknown>>()
  const container = new FakeEl()
  const canvas = Object.assign(new FakeEl(), { getBoundingClientRect: () => ({ left: 0, top: 0 }) })
  const map = {
    getCanvas: () => canvas as unknown as HTMLElement,
    // 1 px = 1e-6 deg from (137, -4): the test clicks at lon/lat directly
    unproject: ([x, y]: [number, number]) => ({ lng: 137 + x * 1e-6, lat: -4 - y * 1e-6 }),
    project: ([lng, lat]: [number, number]) => ({ x: (lng - 137) * 1e6, y: (-4 - lat) * 1e6 }),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: { data: unknown }) => {
      const s = { data: spec.data, setData(d: unknown) { s.data = d } } // prettier-ignore
      sources.set(id, s)
    },
    addLayer: (spec: Record<string, unknown>) => layers.set(spec.id as string, spec),
    getLayer: (id: string) => layers.get(id),
    getContainer: () => container as unknown as HTMLElement,
  }
  const cm: WaypointConsoleMap = { map, whenReady: () => Promise.resolve() }
  /** px of a lon/lat on the fake canvas */
  const px = (lon: number, lat: number) => ({ clientX: Math.round((lon - 137) * 1e6), clientY: Math.round((-4 - lat) * 1e6) })
  /** a press on the empty canvas (off every marker) at lon/lat; true when someone stopped it */
  const press = (lon: number, lat: number) => container.fire('pointerdown', { target: canvas, button: 0, pointerType: 'mouse', ...px(lon, lat) })
  /** a DOM click on the canvas at lon/lat; true when the point took it (MapLibre would not see it) */
  const click = (lon: number, lat: number) => container.fire('click', { target: canvas, clientX: Math.round((lon - 137) * 1e6), clientY: Math.round((-4 - lat) * 1e6), preventDefault() {} })
  return { cm, sources, layers, container, canvas, click, press }
}

function setup() {
  const store = createRouteStore({ catalog })
  const run = vi.fn(() => ({ promise: new Promise<never>(() => {}), cancel: () => {} }))
  const ctl = createRouteController({ store, jobs: { run } as unknown as RouteJobs, stations, pad: () => PAD })
  return { store, ctl }
}

// a grid-free ghost for these tests: every leg routed straight at 1 s/m (the router has its own KATs)
function straightGhost(ctl: ReturnType<typeof setup>['ctl']) {
  return editorOf(ctl, {
    defer: (f) => f(),
    loadGrid: async () => {
      throw new Error('no grid in this test')
    },
  })
}

let root: FakeNode | null = null
afterEach(() => {
  if (root) render(null, root as unknown as Element)
  root = null
})

describe('map binding: markers, armed click, ghost layer', () => {
  it('"Add waypoint" then a map click adds W1 with a draggable .hl-route-marker[data-point="W1"]; Escape disarms', async () => {
    const { store, ctl } = setup()
    ctl.setMode('ordered')
    const ed = straightGhost(ctl)
    const fm = fakeMap()
    const made: FakeMarker[] = []
    const win = new FakeEl()
    const off = attachWaypointMap(ed, fm.cm, { makeMarker: (el) => (made.push(new FakeMarker(el as unknown as FakeEl)), made.at(-1)!), doc: { createElement: () => new FakeEl() as unknown as HTMLElement } as never, win: win as never })
    await flush()
    expect(fm.layers.get(GHOST_LAYER_ID)).toMatchObject({ type: 'line', source: GHOST_SOURCE_ID })
    // tokens only: the ghost line colours are token values (muted = estimate, unknown grey)
    expect(JSON.stringify(fm.layers.get(GHOST_LAYER_ID))).toContain(TOKENS.color.textMuted)
    expect(fm.click(137.404, -4.776)).toBe(false) // not armed: nothing, and MapLibre gets the click
    expect(store.route.value.stops).toHaveLength(0)
    ed.startAdd()
    expect(fm.container.classes.has('hl-route-adding')).toBe(true)
    expect(fm.click(137.404, -4.776)).toBe(true) // armed: taken before MapLibre (no selection, no live pad)
    expect(stopNames(store.route.value)).toEqual(['W1'])
    expect(fm.container.classes.has('hl-route-adding')).toBe(false)
    expect(made).toHaveLength(1)
    expect(made[0].el.className).toBe('hl-route-marker')
    expect(made[0].el.dataset.point).toBe('W1')
    expect(made[0].draggable).toBe(true)
    expect(made[0].added).toBe(true)
    expect(made[0].ll).toEqual([137.404, -4.776])
    ed.startAdd()
    win.fire('keydown', { key: 'Escape' })
    expect(ed.adding.value).toBe(false)
    off()
    expect(made[0].added).toBe(false)
    disposeEditor(ctl)
  })

  it('drag: dragstart changes nothing; dragend = one undo step at the dropped spot; undo moves the marker back', async () => {
    const { store, ctl } = setup()
    ctl.setMode('ordered')
    const ed = straightGhost(ctl)
    const fm = fakeMap()
    const made: FakeMarker[] = []
    const win = new FakeEl()
    attachWaypointMap(ed, fm.cm, { makeMarker: (el) => (made.push(new FakeMarker(el as unknown as FakeEl)), made.at(-1)!), doc: { createElement: () => new FakeEl() as unknown as HTMLElement } as never, win: win as never })
    ed.startAdd()
    fm.click(137.404, -4.776)
    ed.startAdd()
    fm.click(137.406, -4.778)
    const steps = store.past.value.length
    const m = made[0]
    m.handlers.get('dragstart')!()
    expect(ed.dragging.value).toBe('W1')
    m.ll = [137.405, -4.7765]
    expect(store.past.value).toHaveLength(steps)
    m.handlers.get('dragend')!()
    expect(store.past.value).toHaveLength(steps + 1)
    expect(store.route.value.stops[0]).toEqual({ lon: 137.405, lat: -4.7765 })
    // the browser's click after the drop lands on the map: swallowed (no selection, no live pad); the next one is real
    expect(fm.click(137.405, -4.7765)).toBe(true)
    fm.container.fire('pointerdown')
    expect(fm.click(137.405, -4.7765)).toBe(false)
    ctl.undo()
    expect(m.ll).toEqual([137.404, -4.776])
    expect(m.el.fire('click')).toBe(true) // a click on a marker never reaches the map (no add, no select)
    // I1: a right-button press makes the marker non-draggable until the release
    m.el.fire('pointerdown', { button: 2, pointerType: 'mouse' })
    expect(m.draggable).toBe(false)
    win.fire('pointerup')
    expect(m.draggable).toBe(true)
    disposeEditor(ctl)
  })
})

describe('pointer model (I1 as built, D114): only a left press ON a marker moves a waypoint; 4 px slop (H2b)', () => {
  async function two() {
    const { store, ctl } = setup()
    ctl.setMode('ordered')
    const loadGrid = vi.fn(async () => {
      throw new Error('no grid in this test')
    })
    const ed = editorOf(ctl, { defer: (f) => f(), loadGrid })
    const fm = fakeMap()
    const made: FakeMarker[] = []
    attachWaypointMap(ed, fm.cm, { makeMarker: (el) => (made.push(new FakeMarker(el as unknown as FakeEl)), made.at(-1)!), doc: { createElement: () => new FakeEl() as unknown as HTMLElement } as never, win: new FakeEl() as never })
    for (const [lon, lat] of [[137.404, -4.776], [137.406, -4.778]]) {
      ed.startAdd()
      fm.press(lon, lat)
      fm.click(lon, lat)
    }
    await flush()
    return { store, ctl, ed, fm, made, loadGrid }
  }

  it('a left press off every marker + move moves no waypoint and starts no drag; an armed press that moves > 4 px adds nothing', async () => {
    const { store, ed, fm, made } = await two()
    const before = store.route.value
    const steps = store.past.value.length
    // left press on the empty map, move, release: the map's own (I1: nothing; panning is the right button); no marker hears it
    expect(fm.press(137.41, -4.77)).toBe(false) // not stopped: it reaches MapLibre
    fm.container.fire('pointermove', { target: fm.canvas, ...{ clientX: 10400, clientY: 7700 } })
    expect(fm.click(137.4105, -4.7705)).toBe(false) // the browser's click after that drag is MapLibre's
    expect(store.route.value).toBe(before)
    expect(store.past.value).toHaveLength(steps)
    expect(ed.dragging.value).toBeNull()
    expect(made.map((m) => m.ll)).toEqual([[137.404, -4.776], [137.406, -4.778]])
    // armed: a press that moves beyond the slop is a drag, not the armed click; it stays armed
    ed.startAdd()
    fm.press(137.41, -4.77)
    expect(fm.click(137.41 + 5e-6, -4.77)).toBe(false) // 5 px
    expect(store.route.value.stops).toHaveLength(2)
    expect(ed.adding.value).toBe(true)
    fm.press(137.41, -4.77)
    expect(fm.click(137.41 + 3e-6, -4.77)).toBe(true) // 3 px: a click
    expect(stopNames(store.route.value)).toEqual(['W1', 'W2', 'W3'])
  })

  it('a press ON a marker + move + up moves only that waypoint, routed on the drop (D85); within 4 px it is a click', async () => {
    const { store, ed, made, loadGrid } = await two()
    const [m1, m2] = made
    // within the slop: no move, no undo step
    const steps = store.past.value.length
    m2.el.fire('pointerdown', { button: 0, pointerType: 'mouse' })
    m2.handlers.get('dragstart')!()
    m2.ll = [137.406 + 3e-6, -4.778]
    m2.handlers.get('dragend')!()
    expect(store.past.value).toHaveLength(steps)
    expect(m2.ll).toEqual([137.406, -4.778])
    // a real drag of W2
    const calls = loadGrid.mock.calls.length
    m2.el.fire('pointerdown', { button: 0, pointerType: 'mouse' })
    m2.handlers.get('dragstart')!()
    m2.ll = [137.4065, -4.7785]
    await flush()
    expect(loadGrid.mock.calls.length).toBe(calls) // nothing routed while dragging
    expect(store.past.value).toHaveLength(steps)
    m2.handlers.get('dragend')!()
    await flush()
    expect(store.past.value).toHaveLength(steps + 1)
    expect(loadGrid.mock.calls.length).toBeGreaterThan(calls) // the ghost reroutes on the drop
    expect(store.route.value.stops).toEqual([{ lon: 137.404, lat: -4.776 }, { lon: 137.4065, lat: -4.7785 }])
    expect(m1.ll).toEqual([137.404, -4.776])
    void ed
  })
})

describe('panel rows (R5 list) with free points: the e2e selectors', () => {
  it('rows .hl-route__stop[data-point="W{n}"] with validity, input[name="label"], delete; [data-route-action="add-point"]; ghost "estimate"', async () => {
    const { container } = installDom()
    root = container
    const { store, ctl } = setup()
    ctl.setMode('ordered')
    const ed = editorOf(ctl, {
      defer: (f) => f(),
      loadGrid: async () => {
        throw new Error('no grid here')
      },
    })
    ed.setMapAttached(true)
    act(() => render(<RoutePanel ctl={ctl} live={signal(true)} />, container as unknown as Element))
    const add = all(container, (n) => n.getAttribute('data-route-action') === 'add-point')
    expect(add).toHaveLength(1)
    act(() => void add[0].dispatch('click'))
    expect(ed.adding.value).toBe(true)
    act(() => void ed.add(137.404, -4.776))
    await act(flush)
    const rowOf = (n: number) => all(container, (x) => x.getAttribute('data-point') === `W${n}`)[0]
    const r1 = rowOf(1)
    expect(r1).toBeTruthy()
    expect(r1.getAttribute('class')).toContain('hl-route__stop')
    expect(all(r1, (x) => x.getAttribute('data-validity') !== null).length).toBeGreaterThan(0)
    // rename: the field, then Enter (one undo step)
    const input = all(r1, (x) => x.localName === 'input' && x.getAttribute('name') === 'label')[0] as FakeNode & { value?: string }
    expect(input).toBeTruthy()
    input.value = 'Dark sand edge'
    act(() => void input.dispatch('keydown', { key: 'Enter' }))
    expect(store.route.value.stops[0]).toMatchObject({ label: 'Dark sand edge' })
    expect(store.step.value.inputs.route?.stops[0]).toMatchObject({ label: 'Dark sand edge' })
    // the label field owns its presses: a drag that starts in it never starts R5's row drag
    const heard: string[] = []
    r1.addEventListener('pointerdown', () => heard.push('pointerdown'))
    r1.addEventListener('dragstart', () => heard.push('dragstart'))
    act(() => void input.dispatch('pointerdown', { button: 0 }))
    const ds = input.dispatch('dragstart', { dataTransfer: { setData() {} } })
    expect(ds.defaultPrevented).toBe(true)
    expect(heard).toEqual([])
    expect(ctl.dragging.value).toBeNull()
    // the ghost summary says "estimate" (here: no grid in the browser, so no times at all)
    const ghost = all(container, (x) => x.getAttribute('data-route-ghost') !== null)
    expect(ghost).toHaveLength(1)
    expect(ghost[0].textContent).toMatch(/estimate/)
    // delete
    const del = all(rowOf(1), (x) => x.getAttribute('data-route-action') === 'delete-point')[0]
    act(() => void del.dispatch('click'))
    expect(rowOf(1)).toBeUndefined()
    expect(byClass(container, 'hl-route__stop').every((x) => x.getAttribute('data-station') !== null)).toBe(true)
    disposeEditor(ctl)
  })
})

// ---- static first: the static module graph never reaches the route panel ----------------------

const STATIC_RE = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec.replace(/\?.*$/, ''))
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (existsSync(c) && statSync(c).isFile()) return c
  return null
}
/** Every module reachable from main.ts without passing an import.meta.env.VITE_LIVE-guarded dynamic import. */
function staticGraph(): Set<string> {
  const seen = new Set<string>()
  const stack = [resolve(SRC, 'main.ts')]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    if (!/\.(ts|tsx)$/.test(f)) continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(STATIC_RE)) {
      const to = resolveImport(f, m[1])
      if (to && !new RegExp(`import\\s+type\\s[^;]*from\\s+['"]${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(src)) stack.push(to)
    }
    for (const m of src.matchAll(DYNAMIC_RE)) {
      const to = resolveImport(f, m[1])
      const before = src.slice(0, m.index).split('\n').slice(-4).join('\n')
      if (to && !/import\.meta\.env\.VITE_LIVE\b/.test(before)) stack.push(to)
    }
  }
  return seen
}

describe('static first (VITE_LIVE off): the static build does not contain the route panel or the waypoints', () => {
  const ROUTE = resolve(SRC, 'edit/route') + sep
  it('no module of edit/route/ (panel, store, waypoints, ghost, router) is reachable from the static entry', () => {
    const g = staticGraph()
    expect(g.size).toBeGreaterThan(20)
    expect([...g].filter((f) => f.startsWith(ROUTE)).map((f) => relative(SRC, f))).toEqual([])
  })
  it('edit/route/map/ is imported only by the route panel, its own files and the live route mount', () => {
    const importers: string[] = []
    const MAP = resolve(SRC, 'edit/route/map') + sep
    const visit = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) visit(p)
        else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) && !p.startsWith(resolve(SRC, 'edit/route/map'))) {
          const src = readFileSync(p, 'utf8')
          const hits = [...src.matchAll(STATIC_RE), ...src.matchAll(DYNAMIC_RE)].some((m) => resolveImport(p, m[1])?.startsWith(MAP))
          if (hits) importers.push(relative(SRC, p))
        }
      }
    }
    visit(SRC)
    expect(importers.sort()).toEqual(['edit/route/panel.tsx', 'live/route/mount.tsx'])
  })
})

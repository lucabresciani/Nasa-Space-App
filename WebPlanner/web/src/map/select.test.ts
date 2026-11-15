// U14 acceptance on the map side (WS16 task 9, M9), on the real data tree (web/public/data):
//  - a click on S7's marker (ring), its label pill or its DOM button, and S7 in the list give the same ref;
//  - a terrain-cell click gives a cell ref whose card numbers are fieldAt values (the real nom_104 field);
//  - route legs and the homeline edge are pickable; hover writes objects only;
//  - the selected object is highlighted (label pill, ring + legs, leg/edge glow, cell crosshair);
//  - isolation dims every other layer and restores it; no network requests.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readJson, readPngRGBA, REPO } from '../hud/testutil'
import type { FieldsIndex } from '../hud/types'
import { actionsFor, refKey, resetSelection, select, selection, selectionActions } from '../state/selection'
import { activeFieldLookup } from '../ui/cards/data'
import { decodeGrid, decodeState, FieldData, setActiveField, valueAtPixel, type Bounds } from './field/decode'
import { domRef, highlightFeatures, inMarker, labelCodeFor, MapSelection, SELECT_LINE, SELECT_RING, SELECT_ROUTE_HIT, type LabelRow, type SelectMap } from './select'

const PUB = resolve(REPO, 'web/public/data')
const LABELS = (JSON.parse(readFileSync(resolve(PUB, 'labels.json'), 'utf8')) as { labels: LabelRow[] }).labels
const STATIONS = JSON.parse(readFileSync(resolve(PUB, 'stations.json'), 'utf8')) as { stations?: { id: string; lon: number; lat: number }[] } | { id: string; lon: number; lat: number }[]
const STATION_LIST = Array.isArray(STATIONS) ? STATIONS : STATIONS.stations!
const ROUTE = JSON.parse(readFileSync(resolve(PUB, 'route_nom_104.geojson'), 'utf8'))

/** A DOM-ish element: closest() over a parent chain, attributes, listeners. */
class El {
  attrs: Record<string, string>
  classes: Set<string>
  parent: El | null
  style = { cursor: '', props: {} as Record<string, string>, setProperty(k: string, v: string) { this.props[k] = v } }
  private l = new Map<string, Set<(e: Event) => void>>()
  constructor(cls: string[] = [], attrs: Record<string, string> = {}, parent: El | null = null) {
    this.classes = new Set(cls)
    this.attrs = attrs
    this.parent = parent
  }
  get classList() {
    return { toggle: (c: string, on: boolean) => void (on ? this.classes.add(c) : this.classes.delete(c)), contains: (c: string) => this.classes.has(c) }
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  private matches(sel: string): boolean {
    // the selectors select.ts uses: '.a', '.a[data-x]', '[data-x]'
    const m = /^(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/.exec(sel)
    if (!m) return false
    return (!m[1] || this.classes.has(m[1])) && (!m[2] || m[2] in this.attrs)
  }
  closest(sel: string): El | null {
    for (let e: El | null = this; e; e = e.parent) if (e.matches(sel)) return e
    return null
  }
  addEventListener(t: string, fn: (e: Event) => void): void {
    if (!this.l.has(t)) this.l.set(t, new Set())
    this.l.get(t)!.add(fn)
  }
  removeEventListener(t: string, fn: (e: Event) => void): void {
    this.l.get(t)?.delete(fn)
  }
  dispatch(t: string, target: El, extra: Record<string, unknown> = {}): void {
    for (const fn of [...(this.l.get(t) ?? [])]) fn({ type: t, target, ...extra } as unknown as Event)
  }
}

/** A pill as labels/layer.ts builds it: marker wrap .hl-label[data-code][data-kind] > button > span. */
function pill(code: string, kind: string): El {
  const wrap = new El(['maplibregl-marker', 'hl-label'], { 'data-code': code, 'data-kind': kind })
  const btn = new El(['hl-label__pill'], {}, wrap)
  return new El(['hl-label__code'], {}, btn)
}

function fakeMap(features: () => Record<string, unknown>[] = () => []) {
  const container = new El(['maplibregl-map'])
  const canvas = { style: { cursor: '' } }
  const handlers = new Map<string, (e: unknown) => void>()
  const layers = new Map<string, { id: string; type: string; paint: Record<string, unknown>; spec?: Record<string, unknown> }>()
  const sources = new Map<string, { data?: unknown; setData(d: unknown): void }>()
  const m = {
    container,
    canvas,
    layers,
    sources,
    handlers,
    on: (t: string, fn: (e: unknown) => void) => void handlers.set(t, fn),
    off: (t: string) => void handlers.delete(t),
    queryRenderedFeatures: () => features().map((properties) => ({ properties })),
    getContainer: () => container,
    getCanvas: () => canvas,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, s: { data?: unknown }) => {
      const src = { data: s.data, setData(d: unknown) { this.data = d } }
      sources.set(id, src)
    },
    getLayer: (id: string) => layers.get(id),
    addLayer: (l: { id: string; type: string; paint?: Record<string, unknown> }) => void layers.set(l.id, { id: l.id, type: l.type, paint: { ...(l.paint ?? {}) }, spec: l as never }),
    getStyle: () => ({ layers: [...layers.values()].map(({ id, type }) => ({ id, type })) }),
    getPaintProperty: (id: string, p: string) => layers.get(id)?.paint[p],
    setPaintProperty: (id: string, p: string, v: unknown) => void (layers.get(id)!.paint[p] = v),
    click: (props: Record<string, unknown>[], lngLat = { lng: 137.39, lat: -4.79 }, target: unknown = canvas) => {
      const save = features
      features = () => props
      handlers.get('click')!({ point: { x: 1, y: 1 }, lngLat, originalEvent: { target } })
      features = save
    },
  }
  return m
}

const sources = () => ({ labels: LABELS, stations: STATION_LIST, pad: { lon: 137.401783, lat: -4.77748 }, route: ROUTE })

let ms: MapSelection | null = null
beforeEach(() => resetSelection())
afterEach(() => {
  ms?.destroy()
  ms = null
  vi.unstubAllGlobals()
})

describe('I1: a left drag is no click', () => {
  it('a left press that moves beyond the click slop and ends on the S7 pill selects nothing; a still one selects', () => {
    const m = fakeMap()
    ms = new MapSelection(m as unknown as SelectMap, sources)
    const p = pill('S7', 'route_station')
    m.container.dispatch('pointerdown', p, { button: 0, clientX: 100, clientY: 100 })
    m.container.dispatch('click', p, { clientX: 140, clientY: 100 })
    expect(selection.selected.value).toBeNull()
    m.container.dispatch('pointerdown', p, { button: 0, clientX: 100, clientY: 100 })
    m.container.dispatch('click', p, { clientX: 102, clientY: 101 })
    expect(selection.selected.value).toEqual({ kind: 'station', id: 'S7' })
  })
})

describe('click on the map, a pill, a marker and the list give the same ref (U14)', () => {
  it('S7: ring feature, label pill, DOM button and list -> one ref', () => {
    const m = fakeMap()
    ms = new MapSelection(m as unknown as SelectMap, sources)
    const keys: string[] = []
    // the station ring layer (furniture stations-m5: {id: 'S7', …})
    m.click([{ id: 'S7', state: 'route', scored: false }])
    keys.push(refKey(selection.selected.value!))
    expect(selection.source.value).toBe('map')
    // the U13 pill (labels.json row S7: route_station, stations.json#S7)
    resetSelection()
    m.container.dispatch('click', pill('S7', 'route_station'))
    keys.push(refKey(selection.selected.value!))
    // the console's station button for a station the labels do not cover
    resetSelection()
    m.container.dispatch('click', new El(['maplibregl-marker', 'station-marker'], { 'data-select-station': 'S7' }))
    keys.push(refKey(selection.selected.value!))
    // the list (views/console.tsx)
    resetSelection()
    select({ kind: 'station', id: 'S7' }, 'list')
    keys.push(refKey(selection.selected.value!))
    expect(keys).toEqual(['station:S7', 'station:S7', 'station:S7', 'station:S7'])
  })

  it('every labels.json pill resolves to the adapter ref; a map click inside a marker is left to the marker', () => {
    expect(domRef(pill('PAD', 'pad'), LABELS)).toEqual({ kind: 'pad', id: 'rank1' })
    expect(domRef(pill('P2', 'pad'), LABELS)).toEqual({ kind: 'pad', id: 'rank2' })
    expect(domRef(pill('S8', 'scored_site'), LABELS)).toEqual({ kind: 'station', id: 'S8' })
    expect(domRef(pill('MSH', 'landmark'), LABELS)).toEqual({ kind: 'landmark', code: 'MSH' })
    expect(domRef(new El(['pad-marker'], { 'data-select-pad': 'rank1' }), LABELS)).toEqual({ kind: 'pad', id: 'rank1' })
    expect(domRef(new El(['maplibregl-canvas']), LABELS)).toBeNull()
    for (const l of LABELS) expect(domRef(pill(l.code, l.kind), LABELS), l.code).not.toBeNull()
    const m = fakeMap()
    ms = new MapSelection(m as unknown as SelectMap, sources)
    const target = pill('S7', 'route_station')
    expect(inMarker(target)).toBe(true)
    m.click([], { lng: 137.39, lat: -4.79 }, target)
    expect(selection.selected.value).toBeNull() // no cell under the pill
  })

  it('route legs (hit layer on the route source) and homeline edges', () => {
    const m = fakeMap()
    ms = new MapSelection(m as unknown as SelectMap, sources)
    m.addSource('route', { data: ROUTE })
    ms.addLayers()
    expect(m.layers.get(SELECT_ROUTE_HIT)!.paint['line-opacity']).toBe(0)
    const leg2 = ROUTE.features[1].properties
    m.click([{ part: 'coming' }, leg2])
    expect(selection.selected.value).toEqual({ kind: 'leg', leg: 2 })
    m.click([{ budget: 30, cause: 'physiology' }], { lng: 137.395, lat: -4.785 })
    expect(selection.selected.value).toEqual({ kind: 'edge', cause: 'physiology', budget: 30, lon: 137.395, lat: -4.785 })
  })
})

describe('terrain cell click -> cell ref with fieldAt values (real nom_104 field)', () => {
  it('the cell card reads fieldAt at the clicked lon/lat', () => {
    const index = readJson<FieldsIndex>('fields/index.json', PUB)
    const grid = (key: string) => {
      const meta = index.fields[key]
      const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
      return decodeGrid(rgba, width, height, meta.scale, index.bounds as Bounds)
    }
    const cs = readJson<{ image: string; bounds: Bounds }>('terrain/cellstate.json', PUB)
    const csPng = readPngRGBA(resolve(PUB, cs.image))
    const t = { opt: grid('opt_104/t_home'), nom: grid('nom_104/t_home'), con: grid('con_104/t_home') }
    const fd = new FieldData(104, t, grid('nom_104/o2_home'), decodeState(csPng.rgba, csPng.width, csPng.height, cs.bounds), [])
    setActiveField(fd)
    const [w, s, e, n] = index.bounds
    const lon = w + ((1173 + 0.5) / index.width) * (e - w)
    const lat = n - ((401 + 0.5) / index.height) * (n - s)
    const m = fakeMap()
    ms = new MapSelection(m as unknown as SelectMap, sources)
    // basemap / field / band features name no object: the click is a terrain cell
    m.click([{ minutes: 30 }, { budget: 30, variant: 'nominal' }], { lng: lon, lat })
    const ref = selection.selected.value!
    expect(ref).toEqual({ kind: 'cell', lon, lat })
    if (ref.kind !== 'cell') throw new Error('cell')
    const look = activeFieldLookup(ref.lon, ref.lat)!
    expect(look.suitKg).toBe(104)
    expect(look.sample.tHome).toEqual({ opt: valueAtPixel(t.opt, 401, 1173), nom: valueAtPixel(t.nom, 401, 1173), con: valueAtPixel(t.con, 401, 1173) })
    expect(look.sample.tHome.nom).toBe(40.2) // field.test.ts known pixel
    setActiveField(null)
  })
})

describe('hover (objects only)', () => {
  it('map objects and pills hover; a bare cell clears it; the cursor follows', () => {
    let feats: Record<string, unknown>[] = [{ id: 'S6' }]
    const m = fakeMap(() => feats)
    ms = new MapSelection(m as unknown as SelectMap, sources)
    expect(ms.hoverAt({ point: {}, lngLat: { lng: 137.39, lat: -4.79 }, originalEvent: { target: m.canvas } })).toEqual({ kind: 'station', id: 'S6' })
    expect(selection.hovered.value).toEqual({ kind: 'station', id: 'S6' })
    expect(m.canvas.style.cursor).toBe('pointer')
    ms.hoverAt({ point: {}, lngLat: { lng: 137.39, lat: -4.79 }, originalEvent: { target: pill('MSH', 'landmark') } })
    expect(selection.hovered.value).toEqual({ kind: 'landmark', code: 'MSH' })
    feats = []
    ms.hoverAt({ point: {}, lngLat: { lng: 137.39, lat: -4.79 }, originalEvent: { target: m.canvas } })
    expect(selection.hovered.value).toBeNull()
    expect(selection.selected.value).toBeNull() // hover never selects
    expect(m.canvas.style.cursor).toBe('')
  })
})

describe('highlight of the selected object', () => {
  it('label pill, ring + legs for a station, glow for a leg, crosshair for a cell', () => {
    const m = fakeMap()
    const setSelectedLabel = vi.fn()
    const made: { ll?: [number, number]; removed: boolean; cls: string }[] = []
    const marker = (el: HTMLElement) => {
      const rec = { ll: undefined as [number, number] | undefined, removed: false, cls: el.className }
      made.push(rec)
      const pm = { setLngLat: (ll: [number, number]) => ((rec.ll = ll), pm), addTo: () => pm, remove: () => void (rec.removed = true) }
      return pm
    }
    const doc = { createElement: () => ({ className: '', setAttribute() {} }) } as unknown as Document
    ms = new MapSelection(m as unknown as SelectMap, sources, { setSelectedLabel, marker, doc })
    m.addSource('route', { data: ROUTE })
    ms.addLayers()
    expect([SELECT_LINE, SELECT_RING].every((id) => m.layers.has(id))).toBe(true)
    select({ kind: 'station', id: 'S7' }, 'list')
    expect(setSelectedLabel).toHaveBeenLastCalledWith('S7')
    const fc = m.sources.get('hl-select')!.data as { features: { geometry: { type: string }; properties: { hl: string } }[] }
    expect(fc.features.filter((f) => f.properties.hl === 'ring').length).toBe(1)
    expect(fc.features.filter((f) => f.properties.hl === 'line').length).toBe(2) // pad -> S7 and S7 -> S6
    select({ kind: 'pad', id: 'rank2' }, 'map')
    expect(setSelectedLabel).toHaveBeenLastCalledWith('P2')
    select({ kind: 'leg', leg: 3 }, 'map')
    expect(setSelectedLabel).toHaveBeenLastCalledWith(null)
    const leg = highlightFeatures({ kind: 'leg', leg: 3 }, sources())
    expect(leg.features.map((f) => f.properties.hl)).toEqual(['line'])
    select({ kind: 'cell', lon: 137.39, lat: -4.79 }, 'map')
    expect(made.at(-1)).toMatchObject({ ll: [137.39, -4.79], removed: false, cls: 'hl-select-cross' })
    select({ kind: 'landmark', code: 'MSH' }, 'map')
    expect(made.at(-1)!.removed).toBe(true)
    expect(setSelectedLabel).toHaveBeenLastCalledWith('MSH')
    expect(labelCodeFor({ kind: 'pad', id: 'rank1' }, LABELS)).toBe('PAD')
  })
})

describe('isolation ("Show only this", DESIGN U16)', () => {
  it('dims every other layer to 20 % and restores it; Escape (clear) ends it; offered as a card action', () => {
    const m = fakeMap()
    m.addLayer({ id: 'basemap-0', type: 'raster', paint: { 'raster-opacity': 0.9 } })
    m.addLayer({ id: 'edges-line', type: 'line', paint: {} })
    m.addLayer({ id: 'band-opt', type: 'fill', paint: { 'fill-opacity': 0.4 } })
    m.addLayer({ id: 'station-rings', type: 'circle', paint: { 'circle-stroke-width': ['get', 'ring'] } })
    m.addLayer({ id: 'zoomy', type: 'line', paint: { 'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 14, 1] } })
    ms = new MapSelection(m as unknown as SelectMap, sources)
    m.addSource('route', { data: ROUTE })
    ms.addLayers()
    ms.setIsolated(true)
    expect(ms.isIsolated).toBe(false) // nothing selected: nothing to isolate
    select({ kind: 'station', id: 'S7' }, 'map')
    const act = actionsFor({ kind: 'station', id: 'S7' }).find((a) => a.id === 'map.isolate')!
    expect(act.label).toBe('buttons.showOnlyThis')
    act.run({ kind: 'station', id: 'S7' })
    expect(ms.isIsolated).toBe(true)
    const p = (id: string, k: string) => m.layers.get(id)!.paint[k]
    expect(p('basemap-0', 'raster-opacity')).toBe(0.9)
    expect(p('edges-line', 'line-opacity')).toBeCloseTo(0.2)
    expect(p('band-opt', 'fill-opacity')).toBeCloseTo(0.08)
    expect(p('station-rings', 'circle-opacity')).toBeCloseTo(0.2)
    expect(p(SELECT_LINE, 'line-opacity')).toBe(0.9)
    expect(m.container.classes.has('hl-map-isolated')).toBe(true)
    expect(m.container.style.props['--hl-isolation-opacity']).toBe('0.2')
    expect(selectionActions.value.find((a) => a.id === 'map.isolate')!.label).toBe('buttons.showAll')
    // another selection keeps the isolation; clearing (Escape) ends it and restores every value
    select({ kind: 'leg', leg: 2 }, 'map')
    expect(ms.isIsolated).toBe(true)
    select(null)
    expect(ms.isIsolated).toBe(false)
    expect(p('edges-line', 'line-opacity')).toBeUndefined()
    expect(p('band-opt', 'fill-opacity')).toBe(0.4)
    expect(m.container.classes.has('hl-map-isolated')).toBe(false)
  })
})

describe('no network', () => {
  it('picking, hover, highlight and isolation never fetch', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network')))
    vi.stubGlobal('fetch', fetchSpy)
    const m = fakeMap(() => [{ id: 'S7' }])
    ms = new MapSelection(m as unknown as SelectMap, sources)
    m.addSource('route', { data: ROUTE })
    ms.addLayers()
    m.click([{ id: 'S7' }])
    ms.hoverAt({ point: {}, lngLat: { lng: 1, lat: 1 }, originalEvent: { target: m.canvas } })
    ms.setIsolated(true)
    ms.setIsolated(false)
    m.click([], { lng: 137.39, lat: -4.79 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

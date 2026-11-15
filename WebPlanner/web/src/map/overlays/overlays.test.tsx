// U7 acceptance (WS16 task 11, M11), written first, on the real data tree (web/public/data, P3 #88):
//  - every layer's source exists in overlays/index.json / on disk, and its numbers in the manifest;
//  - every legend range equals its manifest range; colours are the P3 tokens;
//  - the panel shows groups, a trust chip and a legend row per layer; highlights say "preliminary" (D87);
//  - toggling adds / shows / hides the map layers; opacity stays in tokens.overlayOpacity;
//  - default view unchanged (all off, nothing fetched); cap of two thematic overlays with a notice;
//  - reduced motion: no paint transitions; highlight hover outline + "preliminary" title.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REPO } from '../../hud/testutil'
import { setManifest } from '../../prov/store'
import type { Manifest } from '../../data/types'
import { ui } from '../../state'
import { t } from '../../ui/copy'
import { byClass, installDom, type FakeNode } from '../../ui/testing/dom'
import { color, TOKENS } from '../../ui/tokens'
import { railSections } from '../../ui/shell/store'
import { DEFAULT_OPACITY, OPACITY, OVERLAY_CFG, OVERLAYS, ROUGH_MIN_DEG, SLOPE_TOKENS, type OverlayId } from './catalog'
import { installOverlays } from './index'
import { LayerPanel, legendText } from './LayerPanel'
import { CONTOUR_LABEL_MINZOOM, contourLabelPoints, layerIds, OverlayLayers, type OverlayMap } from './layers'
import { capNotice, overlayOn, overlayOpacity, resetOverlays, setOverlay, setOverlayOpacity } from './state'

const PUB = resolve(REPO, 'web/public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(PUB, p), 'utf8'))
const INDEX = json('overlays/index.json')
const MANIFEST = json('manifest.json') as Manifest
const mval = (k: string) => (MANIFEST[k] as { value: unknown }).value

class FakeEl {
  attrs: Record<string, string> = {}
  className = ''
  textContent = ''
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  getAttribute(k: string) { return this.attrs[k] ?? null }
  hasAttribute(k: string) { return k in this.attrs }
  removeAttribute(k: string) { delete this.attrs[k] }
}

class FakeMap implements OverlayMap {
  sources = new Map<string, Record<string, unknown>>()
  layers = new Map<string, { spec: Record<string, unknown>; layout: Record<string, unknown>; paint: Record<string, unknown>; filter: unknown; before?: string }>()
  order: string[] = ['iso-lines', 'edges-line']
  zoom = 13
  container = new FakeEl()
  hits: { layer: { id: string }; properties: Record<string, unknown> }[] = []
  ls = new Map<string, Set<(e: never) => void>>()
  addSource(id: string, spec: Record<string, unknown>) { if (this.sources.has(id)) throw new Error(`dup source ${id}`); this.sources.set(id, spec) }
  getSource(id: string) { return this.sources.get(id) }
  addLayer(spec: Record<string, unknown>, before?: string) {
    const id = spec.id as string
    if (this.layers.has(id)) throw new Error(`dup layer ${id}`)
    this.layers.set(id, { spec, layout: { ...(spec.layout as object) }, paint: { ...(spec.paint as object) }, filter: spec.filter, before })
    const i = before ? this.order.indexOf(before) : -1
    if (i >= 0) this.order.splice(i, 0, id)
    else this.order.push(id)
  }
  getLayer(id: string) { return this.layers.has(id) || this.order.includes(id) ? {} : undefined }
  removeLayer(id: string) { this.layers.delete(id) }
  removeSource(id: string) { this.sources.delete(id) }
  setLayoutProperty(id: string, k: string, v: unknown) { this.layers.get(id)!.layout[k] = v }
  setPaintProperty(id: string, k: string, v: unknown) { this.layers.get(id)!.paint[k] = v }
  setFilter(id: string, f: unknown) { this.layers.get(id)!.filter = f }
  getZoom() { return this.zoom }
  getContainer() { return this.container as unknown as HTMLElement }
  queryRenderedFeatures(_p: unknown, o?: { layers?: string[] }) { return this.hits.filter((h) => !o?.layers || o.layers.includes(h.layer.id)) }
  on(ev: string, fn: (e: never) => void) { (this.ls.get(ev) ?? this.ls.set(ev, new Set()).get(ev)!).add(fn) }
  off(ev: string, fn: (e: never) => void) { this.ls.get(ev)?.delete(fn) }
  fire(ev: string, e: unknown = {}) { for (const f of this.ls.get(ev) ?? []) f(e as never) }
  visible(id: string) { return this.layers.get(id)?.layout.visibility === 'visible' }
}

const fetched: string[] = []
const fetchJson = async (p: string) => (fetched.push(p), json(p))
class FakeMarker {
  static live = 0
  el: FakeEl
  constructor(el: FakeEl) { this.el = el }
  setLngLat() { return this }
  addTo() { FakeMarker.live++; return this }
  remove() { FakeMarker.live-- }
}
const deps = { fetchJson, url: (p: string) => `http://x/data/${p}`, marker: (el: HTMLElement) => new FakeMarker(el as unknown as FakeEl), createElement: () => new FakeEl() as unknown as HTMLElement }

beforeEach(() => {
  resetOverlays()
  fetched.length = 0
  FakeMarker.live = 0
  ui.reducedMotion.value = false
})

describe('sources: every layer is published (P3 #88) and backed by the manifest', () => {
  for (const o of OVERLAYS) {
    it(`${o.id}: ${o.source}`, () => {
      if (o.kind === 'raster-tiles') {
        const meta = INDEX[o.indexKey!]
        expect(meta.tiles).toEqual([o.source])
        for (const [z, n] of Object.entries(meta.tile_count as Record<string, number>)) {
          expect(n).toBeGreaterThan(0)
          expect(existsSync(resolve(PUB, `overlays/${o.indexKey}/${z}`)), `z${z}`).toBe(true)
        }
        expect(meta.minzoom).toBe(10)
        expect(meta.maxzoom).toBe(15)
      } else if (o.kind === 'image') {
        expect(INDEX[o.indexKey!].image).toBe(o.source)
        expect(existsSync(resolve(PUB, o.source))).toBe(true)
      } else {
        expect(existsSync(resolve(PUB, o.source))).toBe(true)
        if (o.kind === 'vector-lines') expect(INDEX.contours).toBe(o.source)
      }
      for (const k of o.manifest) expect(MANIFEST[k], k).toBeTruthy()
    })
  }
})

describe('legends equal their manifest ranges and P3 colours', () => {
  it('slope classes: breaks = manifest = index.json; tokens none / safe / caution / limit (> 20° in limit)', () => {
    expect(OVERLAY_CFG.slopeBreaksDeg).toEqual(mval('overlays.slope_class.breaks_deg'))
    expect(OVERLAY_CFG.slopeBreaksDeg).toEqual(INDEX.slope_class.breaks_deg)
    expect(SLOPE_TOKENS).toEqual(INDEX.slope_class.legend.map((l: { token: string | null }) => l.token))
    const o = OVERLAYS.find((x) => x.id === 'slopeClass')!
    expect(o.legend.map(legendText)).toEqual(['0–10°', '10–17°', '17–20°', '> 20°'])
    expect(o.legend[3].color).toBe('limit')
    expect(o.legend[0].swatch).toBe('none')
  })
  it('rough footing: one colour (caution), > manifest min_deg', () => {
    expect(ROUGH_MIN_DEG).toBe(mval('overlays.rough.min_deg'))
    const o = OVERLAYS.find((x) => x.id === 'rough')!
    expect(o.legend).toHaveLength(1)
    expect(o.legend[0].color).toBe(INDEX.rough.legend[0].token)
  })
  it('contours: 10 m and 50 m index = manifest; index lines labelled', () => {
    expect(OVERLAY_CFG.contourMinorM).toBe(mval('overlays.contours.interval_m'))
    expect(OVERLAY_CFG.contourIndexM).toBe(mval('overlays.contours.index_m'))
    const o = OVERLAYS.find((x) => x.id === 'contours')!
    expect(o.legend.map(legendText)).toEqual(['10 m', '50 m'])
    const pts = contourLabelPoints(json('overlays/contours.geojson'))
    expect(pts.length).toBeGreaterThan(0)
    for (const p of pts) expect(Math.abs(Math.round(Number(p.text.replace('−', '-').replace(' m', ''))) % 50)).toBe(0)
  })
  it('mineral hints: science colour and the copy "Orbital hint, not an identification"', () => {
    for (const id of ['mineralSulfate', 'mineralClay', 'mineralPatches'] as const) {
      const o = OVERLAYS.find((x) => x.id === id)!
      expect(o.legend[0].color).toBe('science')
      expect(o.legend.map(legendText)).toContain(t('layers.mineral.what'))
    }
    expect(INDEX.mineral_sulfate.caption).toBe(t('layers.mineral.what'))
  })
  it('groups: Terrain / Science / Evidence; chips per U7 table', () => {
    const g = Object.fromEntries(OVERLAYS.map((o) => [o.id, [o.group, o.chip]]))
    expect(g).toEqual({
      contours: ['terrain', 'real'], slopeClass: ['terrain', 'modelled'], rough: ['terrain', 'modelled'],
      mineralSulfate: ['science', 'real'], mineralClay: ['science', 'real'], ridges: ['science', 'modelled'], mineralPatches: ['science', 'real'],
      blocked: ['evidence', 'modelled'],
    })
  })
  it('highlights are preliminary (D87; P3 thresholds not confirmed)', () => {
    expect(OVERLAYS.filter((o) => o.preliminary).map((o) => o.id)).toEqual(['ridges', 'mineralPatches', 'blocked'])
    expect(json('highlights/ridges.geojson').preliminary).toBe(true)
    expect(json('highlights/mineral.geojson').preliminary).toBe(true)
  })
  it('opacity range = tokens overlayOpacity (35–55 %)', () => {
    expect([OPACITY.min, OPACITY.max]).toEqual([TOKENS.overlayOpacity.min, TOKENS.overlayOpacity.max])
    expect(DEFAULT_OPACITY).toBeGreaterThanOrEqual(OPACITY.min)
    expect(DEFAULT_OPACITY).toBeLessThanOrEqual(OPACITY.max)
  })
})

describe('layer manager panel', () => {
  let root: FakeNode
  beforeEach(() => {
    ;({ container: root } = installDom())
    setManifest(MANIFEST)
    act(() => render(<LayerPanel />, root as unknown as Element))
  })
  afterEach(() => {
    act(() => render(null, root as unknown as Element))
    setManifest(null)
  })
  const row = (id: OverlayId) => byClass(root, 'hl-ovl__layer').find((n) => n.getAttribute('data-overlay') === id)!
  const txt = (n: FakeNode) => n.textContent.replace(/\s+/g, ' ').trim()

  it('groups in order with copy titles; empty-state line while nothing is on', () => {
    expect(byClass(root, 'hl-ovl__group').map((n) => n.getAttribute('data-group'))).toEqual(['terrain', 'science', 'evidence'])
    expect(byClass(root, 'hl-ovl__group-title').map(txt)).toEqual([t('layers.groups.terrain'), t('layers.groups.science'), t('layers.groups.evidence')])
    expect(txt(byClass(root, 'hl-ovl__notice')[0])).toBe(t('states.empty.noLayers'))
  })
  for (const o of OVERLAYS) {
    it(`${o.id}: toggle, trust chip (${o.chip}), legend rows${o.preliminary ? ', "preliminary" in header and every legend row' : ''}`, () => {
      const r = row(o.id)
      expect(byClass(r, 'hl-toggle')).toHaveLength(1)
      expect(byClass(r, `hl-chip--${o.chip}`)).toHaveLength(1)
      const legend = byClass(r, 'hl-ovl__legend-row')
      expect(legend.map((n) => txt(byClass(n, 'hl-legend-row__label')[0]))).toEqual(o.legend.map(legendText))
      const prelim = t('tags.preliminary.label')
      const headTags = byClass(byClass(r, 'hl-ovl__head')[0], 'hl-tag--preliminary')
      expect(headTags.length).toBe(o.preliminary ? 1 : 0)
      for (const l of legend) expect(byClass(l, 'hl-tag--preliminary').map(txt)).toEqual(o.preliminary ? [prelim] : [])
      // the "what" line, or a legend row saying the same (mineral caption, not repeated)
      const what = byClass(r, 'hl-ovl__what').map(txt)
      expect(what.length ? what : legend.map((n) => txt(byClass(n, 'hl-legend-row__label')[0])).filter((x) => x === t(o.what))).toEqual([t(o.what)])
    })
  }
  it('clicking a toggle turns the layer on and shows its opacity slider; the cap notice names the layer turned off', () => {
    const click = (id: OverlayId) => act(() => void byClass(row(id), 'hl-toggle')[0].dispatch('click', {}))
    click('slopeClass')
    expect(overlayOn.peek().slopeClass).toBe(true)
    expect(byClass(row('slopeClass'), 'hl-slider')).toHaveLength(1)
    expect(byClass(row('rough'), 'hl-slider')).toHaveLength(0)
    click('rough')
    click('mineralSulfate')
    expect(overlayOn.peek().slopeClass).toBe(false)
    expect(txt(byClass(root, 'hl-ovl__notice')[0])).toBe(t('tooltips.layerCap', { max: 2, layer: t('layers.slopeClass.name') }))
  })
})

describe('state: default off, cap of thematic overlays', () => {
  it('everything is off by default (default view unchanged)', () => {
    expect(Object.values(overlayOn.peek()).every((v) => v === false)).toBe(true)
  })
  it(`at most ${OVERLAY_CFG.maxThematicOn} thematic overlays; the oldest turns off with a notice; lines/highlights do not count`, () => {
    setOverlay('contours', true)
    setOverlay('ridges', true)
    setOverlay('slopeClass', true)
    setOverlay('mineralClay', true)
    expect(capNotice.peek()).toBe(null)
    setOverlay('rough', true)
    expect(overlayOn.peek()).toMatchObject({ contours: true, ridges: true, slopeClass: false, mineralClay: true, rough: true })
    expect(capNotice.peek()).toEqual({ turnedOff: 'slopeClass' })
  })
  it('opacity is clamped to tokens overlayOpacity', () => {
    setOverlayOpacity('slopeClass', 0.9)
    setOverlayOpacity('rough', 0.1)
    expect(overlayOpacity.peek().slopeClass).toBe(OPACITY.max)
    expect(overlayOpacity.peek().rough).toBe(OPACITY.min)
  })
})

describe('map layers', () => {
  let map: FakeMap
  let ov: OverlayLayers
  beforeEach(() => {
    map = new FakeMap()
    ov = new OverlayLayers(map, deps)
  })
  afterEach(() => ov.destroy())

  it('default: no overlay layer added, nothing fetched', async () => {
    await ov.settled()
    expect(map.layers.size).toBe(0)
    expect(fetched).toEqual([])
    expect(map.container.attrs['data-overlays-on']).toBe('')
  })
  for (const o of OVERLAYS) {
    it(`${o.id}: on adds its layers below the homeline lines and shows them; off hides them`, async () => {
      setOverlay(o.id, true)
      await ov.settled()
      await Promise.resolve()
      const ids = layerIds(o.id)
      for (const id of ids) {
        expect(map.layers.has(id), id).toBe(true)
        expect(map.visible(id), id).toBe(true)
        expect(map.order.indexOf(id)).toBeLessThan(map.order.indexOf('iso-lines'))
        for (const [k, v] of Object.entries(map.layers.get(id)!.paint))
          if (k.endsWith('-opacity') && !(k === 'fill-opacity' && v === 0)) {
            expect(v as number, `${id} ${k}`).toBeGreaterThanOrEqual(OPACITY.min)
            expect(v as number, `${id} ${k}`).toBeLessThanOrEqual(OPACITY.max)
          }
      }
      expect(map.container.attrs['data-overlays-on']).toBe(o.id)
      const src = map.sources.get(`ovl-${o.id}`)!
      if (o.kind === 'raster-tiles') expect(src).toMatchObject({ type: 'raster', tiles: [`http://x/data/${o.source}`], minzoom: 10, maxzoom: 15, tileSize: 256 })
      if (o.kind === 'image') expect(src).toMatchObject({ type: 'image', url: `http://x/data/${o.source}`, coordinates: INDEX[o.indexKey!].coordinates })
      setOverlay(o.id, false)
      await ov.settled()
      await Promise.resolve()
      for (const id of ids) expect(map.visible(id), id).toBe(false)
      setOverlay(o.id, true)
      await ov.settled()
      await Promise.resolve()
      for (const id of ids) expect(map.visible(id), id).toBe(true) // re-shown, not re-added (addLayer throws on dup)
    })
  }
  it('colours are tokens: slope tiles are pre-coloured by P3; contours text; ridges science; blocked limit', async () => {
    for (const id of ['contours', 'ridges', 'blocked'] as const) setOverlay(id, true)
    await ov.settled()
    expect(map.layers.get('ovl-contours-index')!.paint['line-color']).toBe(color('text'))
    expect(map.layers.get('ovl-ridges-line')!.paint['line-color']).toBe(color('science'))
    expect(map.layers.get('ovl-blocked-fill')!.paint['fill-color']).toBe(color('limit'))
    expect(map.layers.get('ovl-mineralPatches-line')).toBeUndefined()
  })
  it('opacity slider changes the paint opacity within range', async () => {
    setOverlay('slopeClass', true)
    await ov.settled()
    setOverlayOpacity('slopeClass', 0.55)
    await Promise.resolve()
    expect(map.layers.get('ovl-slopeClass-raster')!.paint['raster-opacity']).toBe(0.55)
    setOverlayOpacity('slopeClass', 2)
    await Promise.resolve()
    expect(map.layers.get('ovl-slopeClass-raster')!.paint['raster-opacity']).toBe(OPACITY.max)
  })
  it('reduced motion: opacity changes are cuts (transition 0)', async () => {
    ui.reducedMotion.value = true
    setOverlay('rough', true)
    await ov.settled()
    await Promise.resolve()
    expect(map.layers.get('ovl-rough-raster')!.paint['raster-opacity-transition']).toEqual({ duration: 0, delay: 0 })
    expect(map.layers.get('ovl-rough-raster')!.paint['raster-fade-duration']).toBe(0)
  })
  it(`contour index labels (DOM pills) from z${CONTOUR_LABEL_MINZOOM}, removed when off`, async () => {
    setOverlay('contours', true)
    await ov.settled()
    await Promise.resolve()
    expect(FakeMarker.live).toBe(0)
    map.zoom = CONTOUR_LABEL_MINZOOM
    map.fire('zoomend')
    expect(FakeMarker.live).toBe(contourLabelPoints(json('overlays/contours.geojson')).length)
    setOverlay('contours', false)
    await ov.settled()
    await Promise.resolve()
    expect(FakeMarker.live).toBe(0)
  })
  it('hover on a highlight polygon: select outline on that polygon, title with its label and "preliminary"', async () => {
    setOverlay('ridges', true)
    await ov.settled()
    await Promise.resolve()
    map.hits = [{ layer: { id: 'ovl-ridges-fill' }, properties: { id: 'R1', label: 'Boxwork ridge R1' } }]
    map.fire('mousemove', { point: { x: 1, y: 1 } })
    await new Promise((r) => setTimeout(r, 30))
    expect(map.layers.get('ovl-ridges-hover')!.filter).toEqual(['==', ['get', 'id'], 'R1'])
    expect(map.layers.get('ovl-ridges-hover')!.paint['line-color']).toBe(color('select'))
    expect(map.container.attrs.title).toBe(`Boxwork ridge R1 · ${t('tags.preliminary.label')}`)
    map.hits = []
    map.fire('mouseout')
    await new Promise((r) => setTimeout(r, 30))
    expect(map.layers.get('ovl-ridges-hover')!.filter).toEqual(['==', ['get', 'id'], ''])
    expect(map.container.attrs.title).toBeUndefined()
  })
})

describe('install', () => {
  it('registers the layer manager in the left rail (plan mode) inside the shell and removes it on destroy', () => {
    const stop = installOverlays(new FakeMap(), deps, true)
    const s = railSections.peek().find((x) => x.id === 'layers')!
    expect(s).toBeTruthy()
    expect(s.modes).toEqual(['plan'])
    expect(s.title).toBe('nav.rail.layers')
    stop()
    expect(railSections.peek().find((x) => x.id === 'layers')).toBeUndefined()
  })
  it('outside the shell (legacy): no rail section', () => {
    const stop = installOverlays(new FakeMap(), deps, false)
    expect(railSections.peek().find((x) => x.id === 'layers')).toBeUndefined()
    stop()
  })
})

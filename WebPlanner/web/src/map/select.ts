// WS16 task 9 (M9): the planning map as the selection interface (DESIGN U14, U16 isolation).
//  - Clicks on map features (station rings, route legs, the homeline edge, any terrain cell) go through
//    A5's adapter (selectFromMap); clicks on the DOM objects drawn over the map (U13 label pills, the
//    station / pad / parking-option markers) resolve to the same refs (refFromLabel), so the sidebar
//    opens the same card as the list and search. Hover -> hoverFromMap (objects only).
//  - The selected object is highlighted: its label pill (setSelectedLabel), a yellow ring on points,
//    a glow on its leg or edge, a yellow crosshair on a cell.
//  - Isolation ("Show only this", a card action): every other map layer and marker dims to 20 %.
import { refFromLabel, hoverFromMap, selectFromMap, type PickedFeature } from '../state/selectionAdapter'
import { effect } from '../state'
import { hover, registerSelectionAction, select, selection, type SelectionRef } from '../state/selection'
import { TOKENS } from '../ui/tokens'
import { ISOLATION_OPACITY } from './camera/config'
import { locate, type FocusSources } from './camera/focus'
import { isDragMove } from '../edit/drag'
import './select.css'

/** A labels.json row as the label layer keeps it (code + the file's kind/ref). */
export interface LabelRow {
  code: string
  kind: string
  ref?: string
  lon: number
  lat: number
}

export interface SelectSources extends FocusSources {
  labels?: readonly LabelRow[] | null
}

/** Layers this module adds: the route-leg pick target and the highlight. */
export const SELECT_ROUTE_HIT = 'hl-select-route-hit'
export const SELECT_LINE = 'hl-select-line'
export const SELECT_RING = 'hl-select-ring'
const SELECT_SRC = 'hl-select'
/** Route legs are thin; this transparent line makes them easy to click (px). */
const ROUTE_HIT_PX = 14

interface Elish {
  closest?(sel: string): Elish | null
  getAttribute?(k: string): string | null
}

/** The DOM object under the pointer (a label pill or a marker the console draws), or null for the map itself. */
export function domRef(target: unknown, labels: readonly LabelRow[] | null | undefined): SelectionRef | null {
  const el = target as Elish | null
  if (!el?.closest) return null
  const pill = el.closest('.hl-label[data-code]')
  if (pill) {
    const code = pill.getAttribute?.('data-code') ?? ''
    const row = labels?.find((l) => l.code === code)
    const r = row ? refFromLabel(row as unknown as Record<string, unknown>) : null
    if (r) return r
    return pill.getAttribute?.('data-kind') === 'landmark' && code ? { kind: 'landmark', code } : null
  }
  const st = el.closest('[data-select-station]')?.getAttribute?.('data-select-station')
  if (st) return { kind: 'station', id: st }
  const pad = el.closest('[data-select-pad]')?.getAttribute?.('data-select-pad')
  if (pad) return { kind: 'pad', id: pad }
  return null
}

/** True when the event target sits in a DOM marker over the map (its own click handling applies). */
export function inMarker(target: unknown): boolean {
  return !!(target as Elish | null)?.closest?.('.maplibregl-marker')
}

/** The label code that names a ref (the label layer's selected pill), or null. */
export function labelCodeFor(ref: SelectionRef | null, labels: readonly LabelRow[] | null | undefined): string | null {
  if (!ref || !labels) return null
  for (const l of labels) {
    const r = refFromLabel(l as unknown as Record<string, unknown>)
    if (!r || r.kind !== ref.kind) continue
    if ((r.kind === 'station' && ref.kind === 'station' && r.id === ref.id) || (r.kind === 'pad' && ref.kind === 'pad' && r.id === ref.id) || (r.kind === 'landmark' && ref.kind === 'landmark' && r.code === ref.code))
      return l.code
  }
  return null
}

type GeoFC = { type: 'FeatureCollection'; features: { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[] }

/** Highlight geometry of a ref (DESIGN U14 "Highlight" column): ring on the point, glow on its leg / edge lines. */
export function highlightFeatures(ref: SelectionRef | null, s: SelectSources): GeoFC {
  const fc: GeoFC = { type: 'FeatureCollection', features: [] }
  if (!ref) return fc
  const { point, lines } = locate(ref, s)
  // a station / pad: its legs; a leg: itself; an edge: the edge line of that cause; a cell: crosshair (DOM)
  for (const c of lines) fc.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: { hl: 'line' } })
  if (point && ref.kind !== 'cell') fc.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: { hl: 'ring' } })
  return fc
}

/** The part of the MapLibre map this module uses (a fake in tests). */
export interface SelectMap {
  on(type: string, fn: (e: never) => void): unknown
  off(type: string, fn: (e: never) => void): unknown
  queryRenderedFeatures(p: unknown): PickedFeature[]
  getContainer(): HTMLElement
  getCanvas(): { style: { cursor: string } }
  getSource(id: string): unknown
  addSource(id: string, s: unknown): unknown
  getLayer(id: string): unknown
  addLayer(l: unknown, before?: string): unknown
  getStyle(): { layers?: { id: string; type: string }[] } | undefined
  getPaintProperty(id: string, p: string): unknown
  setPaintProperty(id: string, p: string, v: unknown): unknown
}

interface MouseEv {
  point: unknown
  lngLat: { lng: number; lat: number }
  originalEvent?: { target?: unknown }
}

/** A point marker (MapLibre Marker in the app). */
export interface PointMarker {
  setLngLat(ll: [number, number]): PointMarker
  addTo(map: never): PointMarker
  remove(): void
}

export interface SelectOptions {
  /** the label layer's selected-pill hook (labels/layer.ts setSelectedLabel) */
  setSelectedLabel?: (code: string | null) => void
  /** cell crosshair marker factory (MapLibre Marker); none = no crosshair */
  marker?: (el: HTMLElement) => PointMarker
  doc?: Document
}

const OPACITY_PROPS: Record<string, string[]> = {
  fill: ['fill-opacity'],
  line: ['line-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
  raster: ['raster-opacity'],
  symbol: ['icon-opacity', 'text-opacity'],
  'fill-extrusion': ['fill-extrusion-opacity'],
}
/** Kept at full strength while isolated: the basemap and relief (the ground itself) and the highlight. */
const NEVER_DIM = /^(background|basemap|relief|hl-select)/

export class MapSelection {
  private readonly map: SelectMap
  private readonly sources: () => SelectSources
  private readonly opts: SelectOptions
  private readonly stops: (() => void)[] = []
  private hoverRaf = 0
  private lastMove: MouseEv | null = null
  private cross: PointMarker | null = null
  private dimmed: { id: string; prop: string; set: unknown; orig: unknown }[] = []
  /** where the last left press went down (I1: a left drag is not a click on a DOM object) */
  private press: { x: number; y: number } | null = null
  private isolated = false

  constructor(map: SelectMap, sources: () => SelectSources, opts: SelectOptions = {}) {
    this.map = map
    this.sources = sources
    this.opts = opts
    map.on('click', this.onClick)
    map.on('mousemove', this.onMove)
    map.on('mouseout', this.onOut)
    const c = map.getContainer()
    // capture: label pills stop their click from bubbling (their own handlers still run after this)
    c.addEventListener('click', this.onDomClick, true)
    c.addEventListener('pointerdown', this.onPress, { capture: true })
    this.stops.push(
      () => {
        map.off('click', this.onClick)
        map.off('mousemove', this.onMove)
        map.off('mouseout', this.onOut)
        c.removeEventListener('click', this.onDomClick, true)
        c.removeEventListener('pointerdown', this.onPress, { capture: true })
        if (this.hoverRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.hoverRaf)
      },
      effect(() => {
        const ref = selection.selected.value
        this.highlight(ref)
        if (!ref && this.isolated) this.setIsolated(false)
        else if (this.isolated) this.applyIsolation()
      }),
    )
    this.registerIsolate()
  }

  /** Route-leg pick target and highlight layers; call once the style has the 'route' source. */
  addLayers(): void {
    const m = this.map
    if (!m.getSource(SELECT_SRC)) m.addSource(SELECT_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (m.getSource('route') && !m.getLayer(SELECT_ROUTE_HIT))
      m.addLayer({ id: SELECT_ROUTE_HIT, type: 'line', source: 'route', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': TOKENS.color.select, 'line-width': ROUTE_HIT_PX, 'line-opacity': 0 } })
    const sel = TOKENS.color.select
    if (!m.getLayer(SELECT_LINE))
      m.addLayer({ id: SELECT_LINE, type: 'line', source: SELECT_SRC, filter: ['==', ['get', 'hl'], 'line'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': sel, 'line-width': 5, 'line-blur': 2, 'line-opacity': 0.9 } })
    if (!m.getLayer(SELECT_RING))
      m.addLayer({ id: SELECT_RING, type: 'circle', source: SELECT_SRC, filter: ['==', ['get', 'hl'], 'ring'], paint: { 'circle-radius': 14, 'circle-opacity': 0, 'circle-stroke-color': sel, 'circle-stroke-width': 2 } })
    this.highlight(selection.selected.peek())
  }

  /** Re-draw the highlight (the map's data changed: route, stations, labels). */
  refresh(): void {
    this.highlight(selection.selected.peek())
  }

  private readonly onClick = (e: never): void => {
    const ev = e as MouseEv
    if (inMarker(ev.originalEvent?.target)) return // the DOM objects: onDomClick
    selectFromMap(this.map.queryRenderedFeatures(ev.point), ev.lngLat)
  }

  private readonly onPress = (e: Event): void => {
    const p = e as PointerEvent
    this.press = p.button === 0 ? { x: p.clientX, y: p.clientY } : null
  }

  private readonly onDomClick = (e: Event): void => {
    // I1: the left button only interacts; a left drag that ends on the object it began on is no click
    // (map features: MapLibre fires no map click past its click tolerance)
    const m = e as MouseEvent
    if (this.press && typeof m.clientX === 'number' && isDragMove(this.press, { x: m.clientX, y: m.clientY })) return
    const r = domRef(e.target, this.sources().labels)
    if (r) select(r, 'map')
  }

  private readonly onMove = (e: never): void => {
    this.lastMove = e as MouseEv
    if (this.hoverRaf) return
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0
      const ev = this.lastMove
      if (ev) this.hoverAt(ev)
    })
  }

  /** Hover now (tests call it directly; the app throttles to one per frame). */
  hoverAt(ev: MouseEv): SelectionRef | null {
    const t = ev.originalEvent?.target
    let h: SelectionRef | null
    if (inMarker(t)) {
      h = domRef(t, this.sources().labels)
      hover(h)
    } else h = hoverFromMap(this.map.queryRenderedFeatures(ev.point), ev.lngLat)
    this.map.getCanvas().style.cursor = h ? 'pointer' : ''
    return h
  }

  private readonly onOut = (): void => {
    hover(null)
    this.map.getCanvas().style.cursor = ''
  }

  private highlight(ref: SelectionRef | null): void {
    const s = this.sources()
    this.opts.setSelectedLabel?.(labelCodeFor(ref, s.labels))
    const src = this.map.getSource(SELECT_SRC) as { setData?(d: unknown): void } | undefined
    src?.setData?.(highlightFeatures(ref, s))
    this.cross?.remove()
    this.cross = null
    if (ref?.kind === 'cell' && this.opts.marker) {
      const d = this.opts.doc ?? document
      const el = d.createElement('div')
      el.className = 'hl-select-cross'
      el.setAttribute('aria-hidden', 'true')
      this.cross = this.opts.marker(el).setLngLat([ref.lon, ref.lat]).addTo(this.map as never)
    }
  }

  get isIsolated(): boolean {
    return this.isolated
  }

  /** "Show only this" (DESIGN U16): everything but the selected object at 20 %. Needs a selection. */
  setIsolated(on: boolean): void {
    const next = on && selection.selected.peek() !== null
    if (next === this.isolated) return
    this.isolated = next
    if (next) this.applyIsolation()
    else this.restore()
    this.map.getContainer().classList.toggle('hl-map-isolated', next)
    this.map.getContainer().style.setProperty('--hl-isolation-opacity', String(ISOLATION_OPACITY))
    this.registerIsolate()
  }

  private applyIsolation(): void {
    if (this.dimmed.length) return
    for (const l of this.map.getStyle()?.layers ?? []) {
      if (NEVER_DIM.test(l.id)) continue
      for (const prop of OPACITY_PROPS[l.type] ?? []) {
        const orig = this.map.getPaintProperty(l.id, prop)
        let set: unknown
        if (orig === undefined || typeof orig === 'number') set = (orig ?? 1) * ISOLATION_OPACITY
        else if (Array.isArray(orig) && !JSON.stringify(orig).includes('"zoom"')) set = ['*', ISOLATION_OPACITY, orig]
        else continue
        this.map.setPaintProperty(l.id, prop, set)
        this.dimmed.push({ id: l.id, prop, set, orig })
      }
    }
  }

  private restore(): void {
    for (const d of this.dimmed) {
      // another module may have set the value since (pulse, story): then theirs stands
      if (this.map.getLayer(d.id) && JSON.stringify(this.map.getPaintProperty(d.id, d.prop)) === JSON.stringify(d.set)) this.map.setPaintProperty(d.id, d.prop, d.orig)
    }
    this.dimmed = []
  }

  private registerIsolate(): void {
    const off = registerSelectionAction({
      id: 'map.isolate',
      label: this.isolated ? 'buttons.showAll' : 'buttons.showOnlyThis',
      applies: () => true,
      run: () => this.setIsolated(!this.isolated),
    })
    this.unregisterIsolate = off
  }
  private unregisterIsolate: (() => void) | null = null

  destroy(): void {
    this.setIsolated(false)
    this.unregisterIsolate?.()
    for (const s of this.stops) s()
    this.cross?.remove()
    this.opts.setSelectedLabel?.(null)
    hover(null)
  }
}

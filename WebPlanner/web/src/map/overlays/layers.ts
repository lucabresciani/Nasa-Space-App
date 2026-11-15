// WS16 task 11 (M11, U7): the map side of the overlays. Follows overlays/state.ts: adds each
// layer's source and MapLibre layers on its first "on" (lazy: nothing is fetched in the default
// view), then only flips visibility and opacity. All layers sit under the homeline lines
// ('iso-lines'), so with every overlay on the homeline edge stays visible (U7 acceptance).
// 3D: these are ordinary raster / line / fill layers, so MapLibre drapes them on the terrain (M8).
// Highlight polygons are hover-only (A5 has no ridge / mineral / blocked selection refs yet, M9).
import { DATA_MODE, dataUrl } from '../../env'
import { formatValue } from '../../prov/provenance'
import { ui } from '../../state'
import { effect } from '../../state/signal'
import { t } from '../../ui/copy'
import { color } from '../../ui/tokens'
import { overlayById, OVERLAYS, type OverlayDef, type OverlayId } from './catalog'
import { overlayOn, overlayOpacity } from './state'

/** Layers are inserted below this one (homeline isochrone lines; edges and route stay above). */
export const OVERLAY_BEFORE = 'iso-lines'
/** Contour index labels from this zoom (assumed: true; DOM pills, the style has no glyphs, M6). */
export const CONTOUR_LABEL_MINZOOM = 14

export const sourceId = (id: OverlayId): string => `ovl-${id}`
/** MapLibre layer ids per overlay (the test checks add / remove through these). */
export function layerIds(id: OverlayId): string[] {
  const o = overlayById(id)
  if (o.kind === 'vector-lines') return [`ovl-${id}-minor`, `ovl-${id}-index`]
  if (o.kind === 'highlight') return [`ovl-${id}-fill`, `ovl-${id}-line`, `ovl-${id}-hover`]
  return [`ovl-${id}-raster`]
}

/** The subset of MapLibre's Map the overlays use (a fake in the tests). */
export interface OverlayMap {
  addSource(id: string, spec: unknown): unknown
  getSource(id: string): unknown
  addLayer(spec: unknown, before?: string): unknown
  getLayer(id: string): unknown
  removeLayer(id: string): unknown
  removeSource(id: string): unknown
  setLayoutProperty(id: string, k: string, v: unknown): unknown
  setPaintProperty(id: string, k: string, v: unknown): unknown
  setFilter(id: string, f: unknown): unknown
  getZoom(): number
  getContainer(): HTMLElement
  queryRenderedFeatures(p: unknown, o?: unknown): { layer: { id: string }; properties: Record<string, unknown> }[]
  on(ev: string, fn: (e: never) => void): unknown
  off(ev: string, fn: (e: never) => void): unknown
}

export interface MarkerLike {
  setLngLat(ll: [number, number]): MarkerLike
  addTo(m: never): MarkerLike
  remove(): void
}

/** Raster/image metadata from overlays/index.json (P3). */
export interface OverlayIndex {
  slope_class: { tiles: string[]; tile_px: number; minzoom: number; maxzoom: number; bounds: [number, number, number, number]; breaks_deg: number[] }
  rough: { tiles: string[]; tile_px: number; minzoom: number; maxzoom: number; bounds: [number, number, number, number]; min_deg: number }
  mineral_sulfate: { image: string; coordinates: [number, number][] }
  mineral_clay: { image: string; coordinates: [number, number][] }
}

type Feature = { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }

/** Index contour label anchors: the middle vertex of every index line, with its text. */
export function contourLabelPoints(fc: { features: Feature[] }): { lon: number; lat: number; text: string }[] {
  const out: { lon: number; lat: number; text: string }[] = []
  for (const f of fc.features) {
    if (!f.properties.index) continue
    const g = f.geometry
    const lines = (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []) as [number, number][][]
    for (const c of lines) {
      if (c.length < 2) continue
      const [lon, lat] = c[Math.floor(c.length / 2)]
      out.push({ lon, lat, text: formatValue(Number(f.properties.elev_m), 'm') })
    }
  }
  return out
}

/** Absolute URL (MapLibre fetches tiles from a worker); keeps the {z}/{x}/{y} template braces. */
function absUrl(path: string): string {
  const u = dataUrl(path, DATA_MODE)
  try {
    return typeof document !== 'undefined' && document.baseURI ? new URL(u, document.baseURI).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}') : u
  } catch {
    return u
  }
}

export interface OverlayDeps {
  /** fetch JSON from the data tree (default: fetch(dataUrl)) */
  fetchJson?: (path: string) => Promise<unknown>
  url?: (path: string) => string
  marker?: (el: HTMLElement) => MarkerLike
  createElement?: (tag: string) => HTMLElement
}

export class OverlayLayers {
  private added = new Map<OverlayId, Promise<boolean>>()
  private index: Promise<OverlayIndex | null> | null = null
  private stop: (() => void)[] = []
  private labels: MarkerLike[] = []
  private labelPoints: { lon: number; lat: number; text: string }[] = []
  private hoverRaf = 0
  private destroyed = false
  private readonly fetchJson: (path: string) => Promise<unknown>
  private readonly url: (path: string) => string

  private readonly map: OverlayMap
  private readonly deps: OverlayDeps

  constructor(map: OverlayMap, deps: OverlayDeps = {}) {
    this.map = map
    this.deps = deps
    this.fetchJson = deps.fetchJson ?? (async (p) => (await fetch(dataUrl(p, DATA_MODE))).json())
    this.url = deps.url ?? absUrl
    this.stop.push(effect(() => this.sync(overlayOn.value, overlayOpacity.value)))
    const onZoom = () => this.syncLabels()
    const onMove = (e: { point: unknown }) => this.hover(e.point)
    const onOut = () => this.hover(null)
    map.on('zoomend', onZoom)
    map.on('mousemove', onMove as (e: never) => void)
    map.on('mouseout', onOut)
    this.stop.push(() => {
      map.off('zoomend', onZoom)
      map.off('mousemove', onMove as (e: never) => void)
      map.off('mouseout', onOut)
    })
  }

  /** Resolves when every requested overlay is on the map (tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.added.values()])
  }

  private sync(on: Readonly<Record<OverlayId, boolean>>, opacity: Readonly<Record<OverlayId, number>>): void {
    const c = this.map.getContainer()
    c.setAttribute('data-overlays-on', OVERLAYS.filter((o) => on[o.id]).map((o) => o.id).join(' '))
    for (const o of OVERLAYS) {
      if (on[o.id] && !this.added.has(o.id)) this.added.set(o.id, this.add(o))
      if (!this.added.has(o.id)) continue
      void this.added.get(o.id)!.then((ok) => ok && !this.destroyed && this.apply(o, overlayOn.peek()[o.id], overlayOpacity.peek()[o.id]))
    }
    void opacity
  }

  private apply(o: OverlayDef, on: boolean, opacity: number): void {
    const reduced = ui.reducedMotion.peek()
    for (const id of layerIds(o.id)) {
      if (!this.map.getLayer(id)) continue
      this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
      for (const [k, v] of Object.entries(paintOpacity(o, id, opacity))) {
        if (reduced) this.map.setPaintProperty(id, `${k}-transition`, { duration: 0, delay: 0 })
        this.map.setPaintProperty(id, k, v)
      }
    }
    if (o.id === 'contours') this.syncLabels()
  }

  private loadIndex(): Promise<OverlayIndex | null> {
    return (this.index ??= this.fetchJson('overlays/index.json').then(
      (j) => j as OverlayIndex,
      () => null,
    ))
  }

  private before(): string | undefined {
    return this.map.getLayer(OVERLAY_BEFORE) ? OVERLAY_BEFORE : undefined
  }

  private async add(o: OverlayDef): Promise<boolean> {
    try {
      const src = sourceId(o.id)
      const [l0, l1, l2] = layerIds(o.id)
      const hidden = { visibility: 'none' }
      if (o.kind === 'raster-tiles' || o.kind === 'image') {
        const ix = await this.loadIndex()
        if (!ix || this.destroyed) return false
        if (o.kind === 'raster-tiles') {
          const meta = ix[o.indexKey as 'slope_class' | 'rough']
          this.map.addSource(src, { type: 'raster', tiles: meta.tiles.map((p) => this.url(p)), tileSize: meta.tile_px, minzoom: meta.minzoom, maxzoom: meta.maxzoom, bounds: meta.bounds })
        } else {
          const meta = ix[o.indexKey as 'mineral_sulfate' | 'mineral_clay']
          this.map.addSource(src, { type: 'image', url: this.url(meta.image), coordinates: meta.coordinates })
        }
        // nearest: one 3 m class per pixel, no blended classes at z13-15
        this.map.addLayer({ id: l0, type: 'raster', source: src, layout: hidden, paint: { 'raster-opacity': 0, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, this.before())
        return true
      }
      const fc = (await this.fetchJson(o.source)) as { features: Feature[] }
      if (this.destroyed) return false
      this.map.addSource(src, { type: 'geojson', data: fc })
      if (o.kind === 'vector-lines') {
        const line = color('text')
        this.map.addLayer({ id: l0, type: 'line', source: src, filter: ['!=', ['get', 'index'], true], layout: hidden, paint: { 'line-color': line, 'line-width': 0.75, 'line-opacity': 0 } }, this.before())
        this.map.addLayer({ id: l1, type: 'line', source: src, filter: ['==', ['get', 'index'], true], layout: hidden, paint: { 'line-color': line, 'line-width': 1.5, 'line-opacity': 0 } }, this.before())
        this.labelPoints = contourLabelPoints(fc)
        return true
      }
      const tint = color(o.legend[0].color ?? 'science')
      const dashed = o.legend[0].swatch === 'dashed'
      // fill: visible for blocked areas only; the ridge / mineral fills are transparent hover targets
      this.map.addLayer({ id: l0, type: 'fill', source: src, layout: hidden, paint: { 'fill-color': tint, 'fill-opacity': 0 } }, this.before())
      this.map.addLayer({ id: l1, type: 'line', source: src, layout: hidden, paint: { 'line-color': tint, 'line-width': 1.5, 'line-opacity': 0, ...(dashed ? { 'line-dasharray': [2, 1.5] } : {}) } }, this.before())
      this.map.addLayer({ id: l2, type: 'line', source: src, filter: ['==', ['get', 'id'], ''], layout: hidden, paint: { 'line-color': color('select'), 'line-width': 2 } }, this.before())
      return true
    } catch (e) {
      console.warn(`overlay ${o.id} not available`, e)
      return false
    }
  }

  private syncLabels(): void {
    const show = overlayOn.peek().contours && this.map.getZoom() >= CONTOUR_LABEL_MINZOOM && !!this.deps.marker
    if (!show) {
      for (const m of this.labels) m.remove()
      this.labels = []
      return
    }
    if (this.labels.length || !this.labelPoints.length) return
    const mk = this.deps.marker!
    const make = this.deps.createElement ?? ((tag: string) => document.createElement(tag))
    this.labels = this.labelPoints.map((p) => {
      const el = make('span')
      el.className = 'hl-contour-label'
      el.textContent = p.text
      return mk(el).setLngLat([p.lon, p.lat]).addTo(this.map as never)
    })
  }

  /** Hover over a highlight polygon: select-coloured outline + its label (and "preliminary") as the title. */
  private hover(point: unknown): void {
    if (this.hoverRaf) return
    const run = () => {
      this.hoverRaf = 0
      if (this.destroyed) return
      const on = overlayOn.peek()
      const hl = OVERLAYS.filter((o) => o.kind === 'highlight' && on[o.id] && this.map.getLayer(layerIds(o.id)[0]))
      const hits = point && hl.length ? this.map.queryRenderedFeatures(point, { layers: hl.map((o) => layerIds(o.id)[0]) }) : []
      const hit = hits[0]
      for (const o of hl) {
        const [fill, , hov] = layerIds(o.id)
        this.map.setFilter(hov, ['==', ['get', 'id'], hit && hit.layer.id === fill ? String(hit.properties.id) : ''])
      }
      const c = this.map.getContainer()
      if (hit) {
        const o = hl.find((x) => layerIds(x.id)[0] === hit.layer.id)!
        c.setAttribute('title', `${String(hit.properties.label ?? '')}${o.preliminary ? ` · ${t('tags.preliminary.label')}` : ''}`)
        c.setAttribute('data-overlay-hover', String(hit.properties.id))
      } else if (c.hasAttribute('data-overlay-hover')) {
        c.removeAttribute('title')
        c.removeAttribute('data-overlay-hover')
      }
    }
    if (typeof requestAnimationFrame === 'function') this.hoverRaf = requestAnimationFrame(run)
    else run()
  }

  destroy(): void {
    this.destroyed = true
    if (this.hoverRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.hoverRaf)
    for (const s of this.stop) s()
    for (const m of this.labels) m.remove()
    this.labels = []
  }
}

/** The opacity paint properties of one MapLibre layer of an overlay (tokens overlayOpacity range). */
export function paintOpacity(o: OverlayDef, layerId: string, opacity: number): Record<string, number> {
  if (o.kind === 'raster-tiles' || o.kind === 'image') return { 'raster-opacity': opacity }
  if (o.kind === 'vector-lines') return { 'line-opacity': opacity }
  if (layerId.endsWith('-fill')) return { 'fill-opacity': o.id === 'blocked' ? opacity : 0 }
  if (layerId.endsWith('-line')) return { 'line-opacity': opacity }
  return {}
}

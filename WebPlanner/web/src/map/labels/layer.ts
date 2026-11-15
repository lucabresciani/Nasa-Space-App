// WS16 task 6 (M6): the U13 label layer on the console map.
//
// Why DOM pills and not MapLibre symbol layers: symbol text needs a `glyphs` PBF source, the style
// has none (offline by construction, docs/web-architecture.md), and building SDF glyph PBFs from
// the self-hosted JetBrains Mono needs a font rasteriser this repo does not have (no new
// dependency allowed). So each label is a small HTML pill (the self-hosted WOFF2 face, tokens
// only) on a MapLibre Marker, and the placement (zoom ranges, sort key, variable anchors,
// collision, selected label ignoring collisions, route stations never dropped, leader lift) is
// model.ts layoutLabels, re-run on every map move. The pill is "stretchable" by construction: CSS
// fits it to its text, and on hover it expands to the full name and naming status.
import type { Map as MlMap } from 'maplibre-gl'
import { Marker } from 'maplibre-gl'
import { DataError, data } from '../../data/loader'
import { DATA_MODE, dataUrl } from '../../env'
import { expandedText, labelFeatures, layoutLabels, parseLabels, yieldOverlays, type Box, type LabelFeature, type MapLabel, type Placement } from './model'
import './labels.css'

/** Trust hook (DESIGN §3.6): label positions come from the IAU gazetteer, stations.json, pad.json and the pads index. */
export const LABELS_TRUST = { attr: 'data-trust-labels', chip: 'real', sourceAttr: 'data-trust-labels-source', source: 'labels.json' } as const

/** labels.json from the active data tree; null when the tree has none (data-dummy, older trees). */
export async function loadLabels(): Promise<MapLabel[] | null> {
  try {
    // the loader validates against contracts/labels.schema.json where the contract map has it
    return parseLabels(await data().geojson('labels.json'))
  } catch (e) {
    if (e instanceof DataError && e.kind === 'missing') return null
    if (!(e instanceof DataError && e.kind === 'no-contract')) throw e
  }
  const res = await fetch(dataUrl('labels.json', DATA_MODE))
  if (!res.ok) return null
  return parseLabels(await res.json())
}

/** The console's free overlay labels (edge causes, zero-margin bindings; HTML markers outside labels.json). */
export const OVERLAY_SELECTOR = '.edge-label'
/** An overlay label with no clear spot next to the pills (labels.css: visibility hidden, keeps its layout box). */
export const YIELD_CLASS = 'hl-label-yield'

export interface LabelBinding {
  /** tooltip for the pill (e.g. the station's access note) */
  title?: string
  /** click / Enter on the pill */
  onActivate?: () => void
}

let selectedCode: string | null = null
const layers = new Set<LabelLayer>()

/**
 * M10c: while a story camera move runs (intro, kiosk), the placement is throttled to at most
 * PLACEMENT_PAUSED_HZ (the markers themselves still follow their points every frame; only anchors,
 * collisions and the overlay labels lag by up to one interval), and runs once more when it ends.
 */
export const PLACEMENT_PAUSED_HZ = 4
let placementPaused = false

/** Throttle (true) or resume (false) the label placement on every label layer (story camera moves). */
export function setLabelPlacementPaused(on: boolean): void {
  if (placementPaused === on) return
  placementPaused = on
  if (!on) for (const l of layers) l.relayout()
}

export function labelPlacementPaused(): boolean {
  return placementPaused
}

/** Selection hook for A5's selection store: the selected label is drawn above all, ignoring collisions and zoom ranges. */
export function setSelectedLabel(code: string | null): void {
  selectedCode = code
  for (const l of layers) l.relayout()
}

export function selectedLabel(): string | null {
  return selectedCode
}

interface Entry {
  f: LabelFeature
  marker: Marker
  wrap: HTMLElement
  pill: HTMLButtonElement
  binding: LabelBinding
}

export class LabelLayer {
  private entries = new Map<string, Entry>()
  private groupVisible = true
  private readonly onMove = () => this.relayout()
  private raf = 0
  private timer = 0
  private lastLayout = -Infinity
  /** placements run so far (tests, measurements) */
  layouts = 0
  private refs = new Map<string, string>()
  private readonly map: MlMap
  private readonly added: MutationObserver | null

  constructor(map: MlMap) {
    this.map = map
    layers.add(this)
    map.on('move', this.onMove)
    map.on('resize', this.onMove)
    // 3D (M8): the points sit on the terrain (map.project uses its elevation), so a terrain change or
    // an exaggeration change moves them without a camera move; the pitch drives the leader lines
    map.on('terrain', this.onMove)
    map.on('idle', this.onMove)
    // overlay labels (edge causes, zero-margin bindings) are re-created as HTML markers by the console;
    // place them against the pills as soon as they appear, not on the next camera move
    this.added = typeof MutationObserver === 'undefined' ? null : new MutationObserver(this.onMove)
    this.added?.observe(map.getCanvasContainer(), { childList: true })
    const c = map.getContainer()
    c.setAttribute(LABELS_TRUST.attr, LABELS_TRUST.chip)
    c.setAttribute(LABELS_TRUST.sourceAttr, LABELS_TRUST.source)
  }

  /** Codes this layer draws (the console drops its old HTML label for these). */
  covers(code: string): boolean {
    return this.entries.has(code)
  }

  /** The label whose labels.json `ref` ends in `#id` (pads index ids: rank2 … pad_default). */
  codeForRef(id: string): string | null {
    for (const code of this.entries.keys()) if (this.refs.get(code)?.endsWith(`#${id}`)) return code
    return null
  }

  setLabels(labels: MapLabel[], routeStations?: ReadonlySet<string>): void {
    for (const e of this.entries.values()) e.marker.remove()
    this.entries.clear()
    this.refs = new Map(labels.map((l) => [l.code, l.ref ?? '']))
    for (const f of labelFeatures(labels, routeStations).features) {
      const p = f.properties
      const wrap = document.createElement('div')
      wrap.className = 'hl-label'
      wrap.dataset.kind = p.kind
      wrap.dataset.code = p.code
      const pill = document.createElement('button')
      pill.type = 'button'
      pill.className = 'hl-label__pill'
      const code = document.createElement('span')
      code.className = 'hl-label__code'
      code.textContent = p.code
      const more = document.createElement('span')
      more.className = 'hl-label__more'
      more.textContent = ` · ${expandedText(p)}`
      pill.append(code, more)
      pill.setAttribute('aria-label', `${p.code}: ${expandedText(p)}`)
      const leader = document.createElement('div')
      leader.className = 'hl-label__leader'
      wrap.append(leader, pill)
      const entry: Entry = { f, wrap, pill, binding: {}, marker: new Marker({ element: wrap, anchor: 'center' }).setLngLat(f.geometry.coordinates as [number, number]) }
      pill.addEventListener('click', (ev) => {
        ev.stopPropagation()
        entry.binding.onActivate?.()
      })
      entry.marker.addTo(this.map)
      this.entries.set(p.code, entry)
    }
    this.relayout()
  }

  /** Attach a tooltip / click action to a label (stations open their card, parking options select). */
  bind(code: string, b: LabelBinding): void {
    const e = this.entries.get(code)
    if (!e) return
    e.binding = b
    e.pill.title = b.title ?? ''
    e.pill.classList.toggle('is-active', !!b.onActivate)
  }

  /** The `stations` layer group hides pads, stations and sites; landmarks stay. */
  setGroupVisible(on: boolean): void {
    this.groupVisible = on
    this.relayout()
  }

  /**
   * Re-run the placement (on move, resize, selection, data); batched to one per frame, and to at most
   * PLACEMENT_PAUSED_HZ while a story camera move runs (setLabelPlacementPaused).
   */
  relayout(): void {
    if (this.raf || this.timer) return
    if (placementPaused) {
      const wait = this.lastLayout + 1000 / PLACEMENT_PAUSED_HZ - performance.now()
      if (wait > 0) {
        this.timer = window.setTimeout(() => {
          this.timer = 0
          this.relayout()
        }, wait)
        return
      }
    }
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.layoutNow()
    })
  }

  private layoutNow(): void {
    this.layouts++
    this.lastLayout = performance.now()
    const m = this.map
    const items = [...this.entries.values()]
      .filter((e) => this.groupVisible || !e.f.properties.marker)
      .map((e) => {
        const pt = m.project(e.f.geometry.coordinates as [number, number])
        return { props: e.f.properties, x: pt.x, y: pt.y }
      })
    const { placed } = layoutLabels(items, { zoom: m.getZoom(), selected: selectedCode, pitch: m.getPitch() })
    // read the overlay labels' boxes before any write (one layout per frame)
    const overlays = this.overlayBoxes()
    const at = new Map(placed.map((p) => [p.code, p]))
    for (const [code, e] of this.entries) {
      const p = at.get(code)
      e.wrap.hidden = !p
      if (p) this.place(e, p, items.find((i) => i.props.code === code)!)
    }
    const shifts = yieldOverlays(
      overlays.map((o) => o.box),
      placed.map((p) => p.box),
    )
    overlays.forEach(({ el }, i) => {
      const dy = shifts[i]
      el.classList.toggle(YIELD_CLASS, dy === null)
      el.dataset.hlYieldDy = String(dy ?? 0)
      el.style.translate = dy ? `0 ${dy}px` : ''
    })
  }

  /** On-screen boxes of the visible overlay labels in map-container px, without the shift this layer gave them. */
  private overlayBoxes(): { el: HTMLElement; box: Box }[] {
    const c = this.map.getContainer().getBoundingClientRect()
    const out: { el: HTMLElement; box: Box }[] = []
    for (const el of this.map.getCanvasContainer().querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
      if (el.hidden) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      out.push({ el, box: { x: r.left - c.left, y: r.top - c.top - Number(el.dataset.hlYieldDy ?? 0), w: r.width, h: r.height } })
    }
    return out
  }

  private place(e: Entry, p: Placement, pt: { x: number; y: number }): void {
    // box relative to the point (the marker's 0 × 0 wrapper sits on it)
    const dx = p.box.x - pt.x
    const dy = p.box.y - pt.y
    e.wrap.dataset.anchor = p.anchor
    e.wrap.classList.toggle('is-selected', p.selected)
    e.wrap.classList.toggle('has-leader', p.lift > 0)
    const s = e.pill.style
    // the pill grows away from its point on hover: left-anchored to the right, right-anchored to the left, others both ways
    s.left = p.anchor === 'left' ? `${dx}px` : p.anchor === 'right' ? '' : '0px'
    s.right = p.anchor === 'right' ? `${-(dx + p.box.w)}px` : ''
    s.top = `${dy}px`
    e.wrap.style.setProperty('--hl-leader', `${p.lift}px`)
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    clearTimeout(this.timer)
    this.map.off('move', this.onMove)
    this.map.off('resize', this.onMove)
    this.map.off('terrain', this.onMove)
    this.map.off('idle', this.onMove)
    this.added?.disconnect()
    for (const e of this.entries.values()) e.marker.remove()
    this.entries.clear()
    layers.delete(this)
  }
}

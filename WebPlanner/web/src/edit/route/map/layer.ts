// WP6 (D97): free waypoints and the ghost route on the console map. Marker and drag patterns ported
// from origin/waypoint-routing web/src/mission/missionMap.ts (N0CEO, Mission Planer: numbered
// draggable markers, click to add, dashed line), adapted to the design map and its tokens.
//
// Pointer model, I1 as built (D114: the left button interacts, right drag pans, Ctrl/Shift+right or
// middle rotates / tilts): a waypoint moves only with a LEFT press that starts ON its marker element
// (MapLibre's marker drag); a right / middle press on a marker belongs to the map (pan, rotate); a
// press that starts off a marker reaches MapLibre unchanged and never moves a waypoint. Both the
// marker drop and the armed click use the rover's click slop (H2b, edit/drag.ts CLICK_SLOP_PX = 4 px):
// less movement is a click, more is a drag.
//
//   markers  one MapLibre Marker per free point, .hl-route-marker[data-point="W{n}"], draggable;
//            the drag changes nothing until the drop (D85), then one undo step (editor.drop); a
//            drop within the slop is a click (the point stays, no undo step)
//   add      while "Add waypoint" is armed, the next left CLICK on the map appends W{n} (a left
//            press that moves beyond the slop is a drag, not a click: it adds nothing and stays
//            armed); Escape disarms
//   ghost    one dashed line layer (muted: an estimate), hidden once a computed result is drawn
import type { FeatureCollection } from 'geojson'
import { effect } from '../../../state/signal'
import { isDragMove } from '../../drag'
import { TOKENS } from '../../../ui/tokens'
import { fill } from '../text'
import type { WaypointEditor } from './editor'
import { ghostData } from './ghost'
import { freePoints } from './points'
import { WAYPOINT_TEXT as W } from './text'

export const GHOST_LAYER_ID = 'hl-route-ghost'
export const GHOST_SOURCE_ID = 'hl-route-ghost'

/** The part of a MapLibre Marker used here (tests pass a fake). */
export interface PointMarker {
  getElement(): HTMLElement
  getLngLat(): { lng: number; lat: number }
  setLngLat(ll: [number, number]): unknown
  setDraggable(on: boolean): unknown
  on(type: 'dragstart' | 'dragend', fn: () => void): unknown
  addTo(map: never): unknown
  remove(): unknown
}

interface GeoJsonSourceLike {
  setData(d: unknown): unknown
}
/** The parts of maplibre-gl's Map used here. */
export interface WaypointMlMap {
  getSource(id: string): unknown
  addSource(id: string, spec: { type: 'geojson'; data: FeatureCollection }): unknown
  addLayer(spec: Record<string, unknown>): unknown
  getLayer(id: string): unknown
  getContainer(): HTMLElement
  getCanvas(): HTMLElement
  unproject(p: [number, number]): { lng: number; lat: number }
  project(ll: [number, number]): { x: number; y: number }
}
export interface WaypointConsoleMap {
  readonly map: WaypointMlMap
  whenReady(): Promise<void>
}

export interface AttachOptions {
  /** new marker for an element (default: maplibre-gl Marker, loaded with this lazy chunk) */
  makeMarker: (el: HTMLElement) => PointMarker
  doc?: Pick<Document, 'createElement'>
  /** where Escape and a right / middle release are heard (default window) */
  win?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

/** Put the editor's points and ghost on the console map. Returns the disposer. */
export function attachWaypointMap(ed: WaypointEditor, cm: WaypointConsoleMap, o: AttachOptions): () => void {
  const { ctl } = ed
  const doc = o.doc ?? document
  const win = o.win !== undefined ? o.win : typeof window === 'undefined' ? null : window
  let alive = true
  const offs: (() => void)[] = []
  const markers = new Map<string, { m: PointMarker; el: HTMLElement; off: () => void }>()
  /** after a marker drag the browser's click lands on the map (MapLibre took the pointer): swallow it */
  let swallowClick = false

  // ---- ghost layer --------------------------------------------------------------------------
  let ghostReady = false
  const drawGhost = () => {
    if (!ghostReady) return
    const g = ed.ghost.peek()
    const data = ed.ghostShown.peek() && g.kind === 'ready' ? ghostData(g.ghost) : EMPTY
    ;(cm.map.getSource(GHOST_SOURCE_ID) as GeoJsonSourceLike | undefined)?.setData(data)
  }
  void cm.whenReady().then(() => {
    if (!alive) return
    const m = cm.map
    if (!m.getSource(GHOST_SOURCE_ID)) m.addSource(GHOST_SOURCE_ID, { type: 'geojson', data: EMPTY })
    if (!m.getLayer(GHOST_LAYER_ID))
      m.addLayer({
        id: GHOST_LAYER_ID,
        type: 'line',
        source: GHOST_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          // an estimate: muted and dashed; a leg without a path on the browser grid in the unknown grey
          'line-color': ['case', ['get', 'routed'], TOKENS.color.textMuted, TOKENS.color.unknown],
          'line-width': TOKENS.line.threadPx * 1.5,
          'line-dasharray': [2, 1.5],
        },
      })
    ghostReady = true
    drawGhost()
  })
  offs.push(
    effect(() => {
      void ed.ghost.value
      void ed.ghostShown.value
      drawGhost()
    }),
  )

  // ---- markers --------------------------------------------------------------------------------
  function makePointMarker(name: string, at: [number, number]): { m: PointMarker; el: HTMLElement; off: () => void } {
    const el = doc.createElement('div')
    el.className = 'hl-route-marker'
    el.dataset.point = name
    el.textContent = name
    el.tabIndex = 0
    el.setAttribute('role', 'button')
    const m = o.makeMarker(el)
    m.setLngLat(at) // MapLibre needs the position before addTo
    m.setDraggable(true)
    let index = -1
    /** where the marker was when the left press went down (the slop is measured from there) */
    let pressAt: { lng: number; lat: number } | null = null
    m.on('dragstart', () => {
      el.classList.add('is-dragging')
      ed.dragStart(el.dataset.point ?? name)
    })
    m.on('dragend', () => {
      swallowClick = true
      el.classList.remove('is-dragging')
      const p = m.getLngLat()
      const from = pressAt
      pressAt = null
      const cur = freePoints(ctl.store.route.peek()).find((f) => f.name === el.dataset.point)
      index = cur ? cur.index : -1
      const moved = !from || isDragMove(cm.map.project([from.lng, from.lat]), cm.map.project([p.lng, p.lat]))
      if (index < 0 || !moved) ed.dragCancel() // within the slop: a click, the point stays where it was
      else ed.drop(index, p.lng, p.lat)
      place()
    })
    // a click on a marker never adds a point or selects what is under it (missionMap pattern)
    const stop = (e: Event) => e.stopPropagation()
    el.addEventListener('click', stop)
    // I1: points move with the LEFT button only; a right / middle press belongs to the map
    let release: (() => void) | null = null
    const onPress = (e: Event): void => {
      const p = e as PointerEvent
      if (p.pointerType === 'touch' || p.button === 0) {
        pressAt = m.getLngLat()
        return
      }
      if (release) return
      m.setDraggable(false)
      const back = (): void => {
        win?.removeEventListener('pointerup', back)
        win?.removeEventListener('pointercancel', back)
        release = null
        m.setDraggable(true)
      }
      release = back
      win?.addEventListener('pointerup', back)
      win?.addEventListener('pointercancel', back)
    }
    el.addEventListener('pointerdown', onPress)
    m.addTo(cm.map as never)
    return {
      m,
      el,
      off: () => {
        el.removeEventListener('click', stop)
        el.removeEventListener('pointerdown', onPress)
        release?.()
        m.remove()
      },
    }
  }

  /** Markers follow the route (added, moved by undo, renamed, deleted, renumbered). */
  function place(): void {
    if (!alive) return
    const pts = freePoints(ctl.store.route.peek())
    const check = ctl.check.peek()
    const names = new Set(pts.map((p) => p.name))
    for (const [n, mk] of markers) {
      if (!names.has(n)) {
        mk.off()
        markers.delete(n)
      }
    }
    const dragging = ed.dragging.peek()
    for (const p of pts) {
      let mk = markers.get(p.name)
      if (!mk) markers.set(p.name, (mk = makePointMarker(p.name, [p.stop.lon, p.stop.lat])))
      if (dragging !== p.name) mk.m.setLngLat([p.stop.lon, p.stop.lat])
      const c = check.stops[p.index]
      mk.el.dataset.validity = !c ? 'unknown' : c.valid === false ? 'invalid' : c.valid ? 'valid' : 'unknown'
      mk.el.title = fill(W.markerTitle, { name: p.name, label: p.stop.label ? ` · ${p.stop.label}` : '' })
      mk.el.setAttribute('aria-label', mk.el.title)
    }
  }
  offs.push(
    effect(() => {
      void ctl.store.route.value
      void ctl.check.value
      void ed.dragging.value
      place()
    }),
  )

  // ---- add: the armed map click --------------------------------------------------------------
  // Taken in the CAPTURE phase on the map container, before MapLibre turns it into a map click: the
  // armed click places the point and nothing else (no selection card, no live pad from the pad tool).
  const container = cm.map.getContainer()
  const onDomClick = (e: Event): void => {
    const canvas = cm.map.getCanvas()
    if (swallowClick) {
      swallowClick = false
      if (e.target === canvas) {
        e.stopPropagation() // the end of a marker drag is not a click on the map (no selection, no live pad)
        return
      }
    }
    if (!ed.adding.peek()) return
    if (e.target !== canvas) return // controls, markers, popups keep their clicks
    const me = e as MouseEvent
    // a left press that moved beyond the slop was a drag, not the armed click (H2b): stay armed
    if (press && isDragMove(press, { x: me.clientX, y: me.clientY })) return
    const r = canvas.getBoundingClientRect()
    const ll = cm.map.unproject([me.clientX - r.left, me.clientY - r.top])
    e.stopPropagation()
    e.preventDefault()
    ed.add(ll.lng, ll.lat)
  }
  let press: { x: number; y: number } | null = null
  const onPress = (e: Event): void => {
    swallowClick = false // a new press: whatever follows is a real click
    const pe = e as PointerEvent
    press = typeof pe.clientX === 'number' ? { x: pe.clientX, y: pe.clientY } : null
  }
  container.addEventListener('click', onDomClick, true)
  container.addEventListener('pointerdown', onPress, true)
  offs.push(() => {
    container.removeEventListener('click', onDomClick, true)
    container.removeEventListener('pointerdown', onPress, true)
  })
  const onKey = (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape' && ed.adding.peek()) {
      ed.cancelAdd()
      e.stopPropagation()
    }
  }
  // capture: Escape disarms adding before the shell's own Escape (selection, ghost) hears it
  win?.addEventListener('keydown', onKey, true)
  offs.push(() => win?.removeEventListener('keydown', onKey, true))
  offs.push(
    effect(() => {
      const on = ed.adding.value
      container.classList.toggle('hl-route-adding', on)
    }),
  )

  ed.setMapAttached(true)
  return () => {
    alive = false
    ed.setMapAttached(false)
    for (const f of offs.reverse()) f()
    for (const mk of markers.values()) mk.off()
    markers.clear()
    if (ghostReady) (cm.map.getSource(GHOST_SOURCE_ID) as GeoJsonSourceLike | undefined)?.setData(EMPTY)
  }
}

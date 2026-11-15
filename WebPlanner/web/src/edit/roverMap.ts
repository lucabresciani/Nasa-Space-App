// Drag the rover on the planning map (WS18 task 2, U15 flagship; static mode). Loaded lazily by
// ConsoleMap in the shell frame only (the legacy frame stays as it was).
//
//   pointer   the rover marker is draggable (left button only, I1); while dragging, a readout under
//             it shows exact field lookups at the dragged cell (validity, elevation "—", slope) and
//             ghost rows ("computing…"); on release it snaps to the nearest valid precomputed pad
//   map       on release the console shows that pad's precomputed homeline (mission.plan written
//             without an undo step) and the previous homeline fades out over it (reduced motion: no
//             fade); Escape / Discard puts the committed plan back, Enter / Keep commits (H1 undo step)
//   sidebar   the delta strip sits above the selection card while a released draft is open
//   keyboard  the rover marker is focusable; with the rover selected, arrow keys cycle the pads
//   click     a press that moves no farther than CLICK_SLOP_PX is a click, not a drag (H2b): it
//             selects the pad through the A5 map adapter, exactly as M9's map wiring and the pad's
//             label pill do, and touches no plan (no draft, no undo step); while the press is still
//             inside the slop the rover stays on its pad
//
// Static mode only: no fetch happens during a drag (fields, pads index and slope are loaded at
// install, through the shared loader cache), and no server-only option is offered.
import { Marker, type Map as MlMap } from 'maplibre-gl'
import { h, render } from 'preact'
import { data } from '../data/loader'
import { parsePadsIndex, PADS_INDEX, padFiles, type PadsIndexView } from '../data/pads'
import type { BandsFC, ScenariosIndex } from '../data/types'
import { dataUrl } from '../env'
import { FieldGrid, loadField } from '../hud/fields'
import { fieldAt, loadFieldData, type FieldData } from '../map/field'
import { mission } from '../state/mission'
import { selection } from '../state/selection'
import { selectFromMap } from '../state/selectionAdapter'
import { effect } from '../state/signal'
import { ui } from '../state/ui'
import { t } from '../ui/copy'
import { isTypingTarget } from '../ui/shell/keys'
import { openSidebar, setSidebarContent, sidebarContent, type Render } from '../ui/shell/store'
import { applyToMission, installPlanEdit, missionApply } from './bind'
import { crossfadeFrom, crossfadeMs } from './crossfade'
import { isDragMove, type DragFields } from './drag'
import { isCustomPad, loadEditCatalog, planAvailability, type EditCatalog, type EditPlan, type LonLat } from './options'
import { createRoverDrag, type RoverDrag } from './rover'
import { createPlanEditStore, type PlanEditStore, type PlanStep } from './store'
import { DeltaStrip, DragReadout } from './ui'
import './edit.css'

export interface RoverHandle {
  attach(marker: Marker): void
  destroy(): void
  /** for tests and RR: the controller once loaded */
  readonly rover: RoverDrag | null
}

/** The plan the console shows now, if it is a precomputed one (else the store's default). */
function initialPlan(c: EditCatalog): EditPlan | undefined {
  const p: EditPlan = { scenario: mission.plan.scenario.peek() ?? c.defaultScenario, budgetMin: mission.plan.budgetMin.peek(), pad: mission.plan.pad.peek() ?? c.officialPadId, dwell: {} }
  return planAvailability(p, c, false).ok ? p : undefined
}

async function loadDragFields(suitKg: number): Promise<{ fields: DragFields; fd: FieldData }> {
  const L = data()
  const [idx, fd, cs] = await Promise.all([L.fieldsIndex(), loadFieldData(suitKg), L.optional(() => L.cellstate())])
  const slope: FieldGrid | null = idx.fields.slope ? await loadField(idx, 'slope', (p) => dataUrl(p)).catch(() => null) : null
  const cellM = Math.min(idx.res_m, cs?.res_m ?? idx.res_m)
  return {
    fd,
    fields: {
      // fieldAt is the published field the map shows; with a parking option shown it is cleared, so
      // the same decoded FieldData (identical lookups) answers instead
      sample: (lon, lat) => fieldAt(lon, lat) ?? fd.at(lon, lat),
      slope: (lon, lat) => (slope ? slope.valueAt(lon, lat) : null),
      grid: slope ? { bounds: [slope.w, slope.s, slope.e, slope.n], mPerDegLon: slope.mPerDegLon, mPerDegLat: slope.mPerDegLat, cellM } : null,
    },
  }
}

/** The part of a MapLibre Marker the rover wiring uses. */
export interface RoverMarker {
  getElement(): HTMLElement
  getLngLat(): { lng: number; lat: number }
  setLngLat(ll: [number, number]): unknown
  setDraggable(on: boolean): unknown
  on(type: 'dragstart' | 'drag' | 'dragend', fn: () => void): unknown
}

export interface RoverWire {
  rover: RoverDrag
  store: PlanEditStore
  /** lon/lat → screen px (map.project) */
  project(ll: { lng: number; lat: number }): { x: number; y: number }
  /** put the marker where the rover rests (after a release) */
  place(): void
  frame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
  /** where the release of a right / middle press is heard (default window) */
  win?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
}

/** Where the rover rests when it is not being dragged: a released draft's pad, else the committed pad. */
export function restAt(rover: RoverDrag): LonLat {
  const s = rover.state.peek()
  return s?.phase === 'released' ? s.at : rover.committedAt()
}

/** Select a pad through the A5 map adapter (M9's path): the same ref its labels.json pill gives. */
export function selectPad(id: string, officialId: string): void {
  selectFromMap([{ properties: { kind: 'pad', ref: id === officialId ? 'pad.json' : `${PADS_INDEX}#${id}` } }], null)
}

/** Arrow keys with the rover (a pad) selected: Right/Down next valid pad, Left/Up previous; the map does not pan. */
export function arrowKeyHandler(rover: () => RoverDrag | null): (e: KeyboardEvent) => void {
  return (e) => {
    const rd = rover()
    if (!rd || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTypingTarget(e.target)) return
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!dir || selection.selected.peek()?.kind !== 'pad') return
    rd.cycle(dir)
    e.preventDefault()
    e.stopPropagation() // the map would pan
  }
}

/**
 * Make the pad marker the rover's handle. MapLibre fires dragstart once the pointer is 3 px from the
 * press; the drag itself starts only beyond CLICK_SLOP_PX (until then the marker is held on its
 * pad), and a release inside the slop is a click. A still click never reaches dragstart: the
 * browser's click lands on the marker (M9's capture listener selects first, then this one).
 * Returns the disposer.
 */
export function wireRoverMarker(m: RoverMarker, w: RoverWire): () => void {
  const { rover, store } = w
  const frame = w.frame ?? ((cb: () => void) => requestAnimationFrame(cb))
  const cancelFrame = w.cancelFrame ?? ((id: number) => cancelAnimationFrame(id))
  const el = m.getElement()
  el.tabIndex = 0
  el.setAttribute('role', 'button')
  el.setAttribute('aria-label', t('buttons.moveRover'))
  el.title = t('tooltips.dragRover')
  el.classList.add('hl-edit-rover')
  m.setDraggable(true)

  const pick = () => {
    const id = rover.committedPadId()
    if (id) selectPad(id, store.catalog.officialPadId)
  }

  let raf = 0
  let press: { at: LonLat; px: { x: number; y: number } } | null = null
  let dragging = false
  m.on('dragstart', () => {
    const at = restAt(rover)
    press = { at, px: w.project({ lng: at.lon, lat: at.lat }) }
    dragging = false
  })
  m.on('drag', () => {
    if (!press) return
    const p = m.getLngLat()
    if (!dragging) {
      if (!isDragMove(press.px, w.project(p))) {
        m.setLngLat([press.at.lon, press.at.lat]) // inside the slop: the rover stays on its pad
        return
      }
      dragging = true
      el.classList.add('is-dragging')
      rover.begin({ lon: p.lng, lat: p.lat })
      return
    }
    if (raf) return
    raf = frame(() => {
      raf = 0
      const q = m.getLngLat()
      rover.move({ lon: q.lng, lat: q.lat })
    })
  })
  m.on('dragend', () => {
    const pr = press
    press = null
    if (raf) cancelFrame(raf)
    raf = 0
    if (!pr) return
    if (!dragging) {
      // released inside the slop: a click (MapLibre took the pointer, so the browser's click went to the map)
      m.setLngLat([pr.at.lon, pr.at.lat])
      w.place()
      pick()
      return
    }
    dragging = false
    el.classList.remove('is-dragging')
    const p = m.getLngLat()
    rover.move({ lon: p.lng, lat: p.lat })
    rover.end()
    w.place()
  })
  el.addEventListener('click', (e) => {
    e.stopPropagation()
    pick()
  })
  // I1: the rover moves with the LEFT button only. A right / middle press on it belongs to the map
  // (pan, rotate / tilt: map/input); MapLibre's marker drag takes any button, so it is off until release.
  const win = w.win !== undefined ? w.win : typeof window === 'undefined' ? null : window
  let release: (() => void) | null = null
  const onPress = (e: Event): void => {
    const p = e as PointerEvent
    if (p.pointerType === 'touch' || p.button === 0 || release) return
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
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ' || (e.key === 'Enter' && !store.draft.peek())) {
      e.preventDefault()
      pick()
    }
  })
  // M9's capture click reads data-select-pad: keep it on the pad the rover is committed to
  const sync = effect(() => {
    void store.committed.value
    const id = rover.committedPadId()
    if (id) el.dataset.selectPad = id
  })
  return () => {
    sync()
    if (raf) cancelFrame(raf)
    raf = 0
    el.removeEventListener('pointerdown', onPress)
    release?.()
  }
}

const sameStep = (a: PlanStep | null, b: PlanStep): boolean => !!a && a.key === b.key && JSON.stringify(a.plan) === JSON.stringify(b.plan)

export function installRoverDrag(map: MlMap): RoverHandle {
  let alive = true
  let marker: Marker | null = null
  let rover: RoverDrag | null = null
  let store: PlanEditStore | null = null
  let pads: PadsIndexView | null = null
  const offs: (() => void)[] = []

  // readout under the rover while dragging
  const readoutEl = document.createElement('div')
  readoutEl.className = 'hl-edit-drag-host'
  const readout = new Marker({ element: readoutEl, anchor: 'top', offset: [0, 18] })
  let readoutOn = false

  // what the map shows: the committed plan, or a released draft's precomputed plan
  let shown: PlanStep | null = null
  let stopFade: (() => void) | null = null

  const L = data()
  const scenarioIndex = () => L.scenarios() as Promise<ScenariosIndex>
  async function bandsOf(plan: EditPlan): Promise<BandsFC | null> {
    try {
      const idx = await scenarioIndex()
      if (isCustomPad(plan.pad)) return null
      if (plan.pad === store!.catalog.officialPadId) {
        const s = idx.scenarios.find((x) => x.id === plan.scenario)
        return s ? await L.bands(s) : null
      }
      const nominal = idx.scenarios.find((x) => x.id === idx.default)
      return nominal ? await L.json<BandsFC>(padFiles(plan.pad, nominal).bands) : null
    } catch {
      return null
    }
  }

  /** Show `step` on the map (no undo step); the homeline shown so far fades out over it. */
  function show(step: PlanStep): void {
    if (!store || sameStep(shown, step)) return
    const from = shown
    shown = step
    const ms = crossfadeMs(ui.reducedMotion.peek())
    stopFade?.()
    stopFade = null
    if (from && ms > 0) {
      const variant = store.catalog.scenarios.find((s) => s.id === from.plan.scenario)?.variant ?? 'nominal'
      void bandsOf(from.plan).then((b) => {
        if (alive && b) stopFade = crossfadeFrom(map, b, from.plan.budgetMin, variant, ms)
      })
    }
    applyToMission(store, step, store.resultOf(step))
    placeRover()
  }

  function placeRover(): void {
    if (!marker || !rover || !store) return
    const s = rover.state.peek()
    if (s?.phase === 'dragging') return
    const at = restAt(rover)
    marker.setLngLat([at.lon, at.lat])
  }

  // ---- sidebar: the delta strip above whatever the sidebar shows (A5 selection card) -----------
  let base: Render | undefined
  let mine: Render | null = null
  function mountStrip(on: boolean): void {
    if (on && !mine && store && rover && pads) {
      base = sidebarContent.peek()
      const st = store
      const rd = rover
      const pd = pads
      const b = base
      mine = () => [h(DeltaStrip, { store: st, rover: rd, pads: pd, key: 'hl-edit-delta' }), b ? h('div', { key: 'base' }, b()) : null]
      setSidebarContent(mine)
      openSidebar()
    } else if (!on && mine) {
      if (sidebarContent.peek() === mine) setSidebarContent(base)
      mine = null
    }
  }

  // ---- keyboard alternative ----------------------------------------------------------------
  const onKey = arrowKeyHandler(() => rover)
  window.addEventListener('keydown', onKey, { capture: true })
  offs.push(() => window.removeEventListener('keydown', onKey, { capture: true }))

  // ---- pointer (wireRoverMarker) -------------------------------------------------------------
  let unwire: (() => void) | null = null
  function wire(m: Marker): void {
    if (!rover || !store) return
    unwire?.()
    unwire = wireRoverMarker(m, { rover, store, project: (ll) => map.project([ll.lng, ll.lat]), place: placeRover })
  }

  // ---- load --------------------------------------------------------------------------------
  void (async () => {
    try {
      const catalog = await loadEditCatalog((p) => L.json(p))
      const padScenarioSuit = catalog.scenarios.find((s) => s.id === catalog.padScenario)?.suit_kg ?? 104
      const [{ fields }, rawPads] = await Promise.all([loadDragFields(padScenarioSuit), L.json<unknown>(PADS_INDEX)])
      if (!alive) return
      pads = parsePadsIndex(rawPads)
      store = createPlanEditStore({ catalog, initial: initialPlan(catalog), onApply: missionApply })
      offs.push(installPlanEdit(store))
      rover = createRoverDrag(store, fields)
      const st = store
      const rd = rover
      shown = st.committed.peek()
      // map follows the store: released draft = its precomputed plan; otherwise the committed plan
      offs.push(
        effect(() => {
          const d = st.draft.value
          const c = st.committed.value
          void rd.state.value
          if (d && d.phase === 'released' && d.availability.ok) show(d.step)
          else if (!d) {
            show(c)
            placeRover()
          }
          mountStrip(!!d && d.phase === 'released')
        }),
      )
      // readout follows the dragged spot
      offs.push(
        effect(() => {
          const s = rd.state.value
          if (s?.phase === 'dragging' && s.values) {
            const target = s.target ? (pads!.options.find((o) => o.id === s.target!.id) ?? null) : null
            render(h(DragReadout, { values: s.values, target }), readoutEl)
            readout.setLngLat([s.at.lon, s.at.lat])
            if (!readoutOn) readout.addTo(map)
            readoutOn = true
          } else if (readoutOn) {
            readout.remove()
            render(null, readoutEl)
            readoutOn = false
          }
        }),
      )
      if (marker) wire(marker)
      placeRover()
    } catch (e) {
      console.warn('drag the rover unavailable:', e)
    }
  })()

  return {
    get rover() {
      return rover
    },
    attach(m: Marker) {
      marker = m
      if (rover) {
        wire(m)
        placeRover()
      }
    },
    destroy() {
      alive = false
      unwire?.()
      unwire = null
      stopFade?.()
      mountStrip(false)
      readout.remove()
      render(null, readoutEl)
      for (const f of offs.reverse()) f()
      marker?.setDraggable(false)
    },
  }
}

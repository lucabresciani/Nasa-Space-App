// H2b (WS18 regression before the freeze): the rover drag handle on the official Pad marker must
// not swallow a plain click. A press that moves no farther than CLICK_SLOP_PX is a click: it selects
// the pad through the same A5 adapter the M9 map wiring uses (selection ref = official pad) and
// leaves the plan-edit store untouched (no draft, no undo step). Only movement beyond the slop
// starts the U15 drag. Keyboard (Space/Enter select, arrows cycle) is unchanged.
// Real tree, as drag.test.ts: cell state through FieldData.at (= fieldAt), the shared slope PNG,
// the D21 pads index through the H1 catalog. The MapLibre marker is a stand-in that fires the
// same dragstart / drag / dragend events MapLibre fires (MapLibre starts its drag at 3 px).
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeRGBA, FieldGrid, fieldGrid } from '../hud/fields'
import { readJson, readPngRGBA, REPO } from '../hud/testutil'
import type { FieldsIndex } from '../hud/types'
import { decodeGrid, decodeState, FieldData, fieldAt, setActiveField, type Bounds } from '../map/field/decode'
import { domRef } from '../map/select'
import { refFromLabel } from '../state/selectionAdapter'
import { resetSelection, select, selection } from '../state/selection'
import { CLICK_SLOP_PX, type DragFields } from './drag'
import { buildCatalog } from './options'
import { createRoverDrag, type RoverDrag } from './rover'
import { arrowKeyHandler, wireRoverMarker, type RoverMarker } from './roverMap'
import { createPlanEditStore, type PlanEditStore } from './store'

const PUB = resolve(REPO, 'web/public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(PUB, p), 'utf8'))
const catalog = buildCatalog(json('scenarios/index.json'), json('scenarios/pads/index.json'), json('stations.json'))
const labels = json('labels.json').labels as { code: string; kind: string; ref: string }[]
const index = readJson<FieldsIndex>('fields/index.json', PUB)
const grid = (key: string) => {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return decodeGrid(rgba, width, height, meta.scale, index.bounds as Bounds)
}
const cs = readJson<{ image: string; bounds: Bounds; res_m: number }>('terrain/cellstate.json', PUB)
const csPng = readPngRGBA(resolve(PUB, cs.image))
const field = new FieldData(104, { opt: grid('opt_104/t_home'), nom: grid('nom_104/t_home'), con: grid('con_104/t_home') }, grid('nom_104/o2_home'), decodeState(csPng.rgba, csPng.width, csPng.height, cs.bounds), [], index.res_m)
const slopeMeta = index.fields.slope
const slopePng = readPngRGBA(resolve(PUB, slopeMeta.file))
const slope = new FieldGrid(fieldGrid(index, 'slope'), decodeRGBA(slopePng.rgba, slopePng.width, slopePng.height, slopeMeta.scale), slopeMeta.units)
setActiveField(field)
const fields: DragFields = {
  sample: (lon, lat) => fieldAt(lon, lat),
  slope: (lon, lat) => slope.valueAt(lon, lat),
  grid: { bounds: index.bounds as Bounds, mPerDegLon: slope.mPerDegLon, mPerDegLat: slope.mPerDegLat, cellM: Math.min(cs.res_m, index.res_m) },
}
const OFFICIAL = catalog.officialPadId
const padRow = (id: string) => catalog.pads.find((p) => p.id === id)!
/** The ref every other path gives the official pad: the PAD label pill (M9 / search, refFromLabel). */
const OFFICIAL_REF = refFromLabel(labels.find((l) => l.code === 'PAD')! as unknown as Record<string, unknown>)

// ---- stand-ins: the marker element and the MapLibre marker ------------------------------------
type Fn = (e: unknown) => void
class FakeEl {
  tabIndex = -1
  title = ''
  dataset: Record<string, string> = { selectPad: 'rank1' } // as ConsoleMap.setPad creates it
  attrs: Record<string, string> = {}
  classes = new Set<string>(['pad-marker'])
  listeners: Record<string, Fn[]> = {}
  classList = { add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c), contains: (c: string) => this.classes.has(c) }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v
  }
  getAttribute(k: string): string | null {
    if (k === 'data-select-pad') return this.dataset.selectPad ?? null
    return this.attrs[k] ?? null
  }
  closest(sel: string): FakeEl | null {
    return sel === '[data-select-pad]' && this.dataset.selectPad ? this : null
  }
  addEventListener(type: string, fn: Fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  removeEventListener(type: string, fn: Fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn)
  }
  fire(type: string, init: Record<string, unknown> = {}) {
    let prevented = false
    let stopped = false
    const ev = { type, target: this, ...init, preventDefault: () => (prevented = true), stopPropagation: () => (stopped = true) }
    for (const f of this.listeners[type] ?? []) f(ev)
    return { prevented, stopped }
  }
}

/** px per degree of the stand-in projection (~1.1 m per px, a close planning zoom) */
const K = 100_000
const LON0 = 137.4
const LAT0 = -4.777
const project = (ll: { lng: number; lat: number }) => ({ x: (ll.lng - LON0) * K, y: -(ll.lat - LAT0) * K })
const unproject = (p: { x: number; y: number }) => ({ lng: LON0 + p.x / K, lat: LAT0 - p.y / K })

class FakeMarker implements RoverMarker {
  el = new FakeEl()
  ll = { lng: 0, lat: 0 }
  draggable = false
  handlers: Record<string, (() => void)[]> = {}
  getElement() {
    return this.el as unknown as HTMLElement
  }
  getLngLat() {
    return { ...this.ll }
  }
  setLngLat(ll: [number, number]) {
    this.ll = { lng: ll[0], lat: ll[1] }
    return this
  }
  setDraggable(on: boolean) {
    this.draggable = on
    return this
  }
  on(type: 'dragstart' | 'drag' | 'dragend', fn: () => void) {
    ;(this.handlers[type] ??= []).push(fn)
    return this
  }
  emit(type: string) {
    for (const f of this.handlers[type] ?? []) f()
  }
  /**
   * A mouse press at the marker that moves by (dx, dy) px in `steps` moves, as MapLibre handles it:
   * the marker follows the pointer and fires dragstart / drag only once the pointer is 3 px or more
   * from the press (map clickTolerance), and dragend on release only after a drag; with no drag the
   * browser's click reaches the marker element. M9's capture-phase click on the map container
   * (domRef → select) runs before the marker's own click listener, as in the app.
   */
  press(dx: number, dy: number, steps = 4) {
    const path: [number, number][] = []
    for (let i = 1; i <= steps; i++) path.push([(dx * i) / steps, (dy * i) / steps])
    this.gesture(path)
  }
  /** pointer offsets (px from the press point), then release */
  gesture(path: readonly (readonly [number, number])[]) {
    const start = project(this.ll)
    let active = false
    for (const [dx, dy] of path) {
      if (!active && Math.hypot(dx, dy) < 3) continue
      const ll = unproject({ x: start.x + dx, y: start.y + dy })
      this.ll = { lng: ll.lng, lat: ll.lat }
      if (!active) {
        active = true
        this.emit('dragstart')
      }
      this.emit('drag')
    }
    if (active) this.emit('dragend')
    else {
      const r = domRef(this.el, labels as never)
      if (r) select(r, 'map')
      this.el.fire('click')
    }
  }
}

let frames = new Map<number, () => void>()
let nextFrame = 1
const frame = (cb: () => void) => {
  frames.set(nextFrame, cb)
  return nextFrame++
}
const cancelFrame = (id: number) => void frames.delete(id)
const flush = () => {
  const f = [...frames.values()]
  frames = new Map()
  for (const cb of f) cb()
}

function setup(): { store: PlanEditStore; rover: RoverDrag; m: FakeMarker; dispose: () => void } {
  const store = createPlanEditStore({ catalog })
  const rover = createRoverDrag(store, fields)
  const m = new FakeMarker()
  const at = rover.committedAt()
  m.setLngLat([at.lon, at.lat])
  const dispose = wireRoverMarker(m, { rover, store, project, place: () => {}, frame, cancelFrame })
  return { store, rover, m, dispose }
}

beforeEach(() => {
  resetSelection()
  frames = new Map()
})
afterEach(() => vi.restoreAllMocks())

describe('a plain click on the rover (official Pad marker) opens the pad card', () => {
  it('the PAD pill ref is the official pad', () => {
    expect(OFFICIAL).toBe('rank1')
    expect(OFFICIAL_REF).toEqual({ kind: 'pad', id: OFFICIAL })
  })

  for (const [name, dx, dy] of [
    ['no movement', 0, 0],
    ['2 px jitter (below MapLibre\'s drag start)', 2, 0],
    ['3 px jitter (MapLibre starts its drag)', 3, 0],
    ['3.9 px jitter (just inside the click slop)', 0, CLICK_SLOP_PX - 0.1],
    ['2.8 px diagonal jitter', 2, 2],
  ] as const) {
    it(`${name}: selection = official pad; no draft, no undo step, rover back on its pad`, () => {
      const { store, rover, m } = setup()
      const rest = { ...m.ll }
      m.press(dx, dy)
      flush()
      expect(selection.selected.value).toEqual(OFFICIAL_REF)
      expect(selection.source.value).toBe('map')
      expect(selection.history.value).toEqual([OFFICIAL_REF]) // one selection, not two
      expect(store.draft.value).toBeNull()
      expect(store.past.value).toHaveLength(0)
      expect(store.canUndo.value).toBe(false)
      expect(store.committed.value.plan.pad).toBe(OFFICIAL)
      expect(rover.state.value).toBeNull()
      expect(m.ll).toEqual(rest)
      expect(m.el.classes.has('is-dragging')).toBe(false)
    })
  }

  it('the marker stays draggable and keeps its role, label and data-select-pad', () => {
    const { m } = setup()
    expect(m.draggable).toBe(true)
    expect(m.el.attrs.role).toBe('button')
    expect(m.el.tabIndex).toBe(0)
    expect(m.el.dataset.selectPad).toBe(OFFICIAL)
  })

  it('after Keep moved the rover to another pad, a click selects that pad (one ref, as its pill)', () => {
    const { store, rover, m } = setup()
    expect(rover.cycle(-1)!.step.plan.pad).toBe('rank4')
    expect(rover.keep()).toBe(true)
    const at = rover.committedAt()
    m.setLngLat([at.lon, at.lat])
    const pastBefore = store.past.value.length
    m.press(0, 0)
    const p4 = refFromLabel(labels.find((l) => l.code === 'P4')! as unknown as Record<string, unknown>)
    expect(p4).toEqual({ kind: 'pad', id: 'rank4' })
    expect(selection.selected.value).toEqual(p4)
    expect(selection.history.value).toEqual([p4])
    expect(store.past.value).toHaveLength(pastBefore)
  })
})

describe('I1: the rover moves with the left button only', () => {
  it('a right or middle press on the rover leaves it to the map (no marker drag until release)', () => {
    for (const button of [2, 1]) {
      const store = createPlanEditStore({ catalog })
      const rover = createRoverDrag(store, fields)
      const m = new FakeMarker()
      const win = new EventTarget()
      const dispose = wireRoverMarker(m, { rover, store, project, place: () => {}, frame, cancelFrame, win })
      expect(m.draggable).toBe(true)
      m.el.fire('pointerdown', { button, pointerType: 'mouse' })
      expect(m.draggable).toBe(false)
      win.dispatchEvent(new Event('pointerup'))
      expect(m.draggable).toBe(true)
      expect(store.draft.value).toBeNull()
      expect(selection.selected.value).toBeNull()
      dispose()
    }
  })

  it('a left press (mouse or touch) keeps the marker draggable', () => {
    const { m } = setup()
    m.el.fire('pointerdown', { button: 0, pointerType: 'mouse' })
    expect(m.draggable).toBe(true)
    m.el.fire('pointerdown', { button: 0, pointerType: 'touch' })
    expect(m.draggable).toBe(true)
  })
})

describe('movement beyond the slop still drags the rover', () => {
  it('a drag just beyond the slop runs the U15 drag (begin, moves, release); it selects nothing', () => {
    const { store, rover, m } = setup()
    const begin = vi.spyOn(rover, 'begin')
    const move = vi.spyOn(rover, 'move')
    const end = vi.spyOn(rover, 'end')
    m.press(CLICK_SLOP_PX + 1, 0, 5)
    flush()
    expect(begin).toHaveBeenCalledTimes(1)
    expect(move).toHaveBeenCalled()
    expect(end).toHaveBeenCalledTimes(1)
    expect(selection.selected.value).toBeNull()
    expect(store.past.value).toHaveLength(0)
    expect(m.el.classes.has('is-dragging')).toBe(false)
  })

  it('dragging to parking option #4 releases there; Keep is the one undo step', () => {
    const { store, rover, m } = setup()
    const from = project(m.ll)
    const to = project({ lng: padRow('rank4').lon, lat: padRow('rank4').lat })
    const states: (string | undefined)[] = []
    const move = rover.move.bind(rover)
    vi.spyOn(rover, 'move').mockImplementation((at) => {
      const s = move(at)
      states.push(s.phase)
      return s
    })
    m.gesture(Array.from({ length: 20 }, (_, i) => [((to.x - from.x) * (i + 1)) / 20, ((to.y - from.y) * (i + 1)) / 20] as const).flatMap((p) => [p, p]))
    flush()
    expect(states.length).toBeGreaterThan(0)
    expect(states.every((s) => s === 'dragging')).toBe(true)
    expect(m.el.classes.has('is-dragging')).toBe(false)
    expect(rover.state.value?.phase).toBe('released')
    expect(rover.state.value?.target?.id).toBe('rank4')
    expect(store.draft.value?.phase).toBe('released')
    expect(store.draft.value?.step.plan.pad).toBe('rank4')
    expect(store.past.value).toHaveLength(0)
    expect(selection.selected.value).toBeNull()
    expect(rover.keep()).toBe(true)
    expect(store.past.value).toHaveLength(1)
    expect(store.committed.value.plan.pad).toBe('rank4')
  })

  it('while the press is within the slop the rover does not move; beyond it, it follows', () => {
    const { rover, m } = setup()
    const rest = { ...m.ll }
    const begin = vi.spyOn(rover, 'begin')
    const end = vi.spyOn(rover, 'end')
    m.emit('dragstart') // MapLibre at 3 px
    m.ll = unproject({ x: project(rest).x + 3.5, y: project(rest).y })
    m.emit('drag')
    expect(begin).not.toHaveBeenCalled()
    expect(m.ll).toEqual(rest) // held on its pad
    m.ll = unproject({ x: project(rest).x + 9, y: project(rest).y })
    m.emit('drag')
    expect(begin).toHaveBeenCalledTimes(1)
    expect(m.ll).not.toEqual(rest)
    // back inside the slop: still a drag (latched), released as a drag, never a click
    m.ll = unproject({ x: project(rest).x + 1, y: project(rest).y })
    m.emit('drag')
    m.emit('dragend')
    flush()
    expect(end).toHaveBeenCalledTimes(1)
    expect(selection.selected.value).toBeNull()
    expect(rover.state.value?.phase).not.toBe('dragging') // released (or no draft: back on the committed pad)
  })

  it('no fetch during a click or a drag', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('network')))
    const { m } = setup()
    m.press(0, 0)
    m.press(40, 25, 10)
    flush()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('keyboard flow unchanged', () => {
  it('Space selects the rover (official pad), no edit step', () => {
    const { store, m } = setup()
    const r = m.el.fire('keydown', { key: ' ' })
    expect(r.prevented).toBe(true)
    expect(selection.selected.value).toEqual(OFFICIAL_REF)
    expect(store.draft.value).toBeNull()
    expect(store.past.value).toHaveLength(0)
  })

  it('Enter selects when no draft is open; with a draft open Enter is left to Keep', () => {
    const { rover, m } = setup()
    expect(m.el.fire('keydown', { key: 'Enter' }).prevented).toBe(true)
    expect(selection.selected.value).toEqual(OFFICIAL_REF)
    rover.cycle(1)
    expect(m.el.fire('keydown', { key: 'Enter' }).prevented).toBe(false)
  })

  it('with the rover selected, arrows cycle the valid pads (Right/Down next, Left/Up previous)', () => {
    const { store, rover, m } = setup()
    const onKey = arrowKeyHandler(() => rover)
    const key = (k: string) => {
      let prevented = false
      onKey({ key: k, defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: null, preventDefault: () => (prevented = true), stopPropagation: () => {} } as unknown as KeyboardEvent)
      return prevented
    }
    expect(key('ArrowRight')).toBe(false) // nothing selected: arrows are the map's
    m.el.fire('keydown', { key: ' ' })
    expect(key('ArrowRight')).toBe(true)
    expect(store.draft.value?.step.plan.pad).toBe('rank2')
    expect(key('ArrowDown')).toBe(true)
    expect(store.draft.value?.step.plan.pad).toBe('rank3')
    expect(key('ArrowUp')).toBe(true)
    expect(key('ArrowLeft')).toBe(true)
    expect(store.draft.value).toBeNull() // back at the committed pad
    expect(store.past.value).toHaveLength(0)
  })
})

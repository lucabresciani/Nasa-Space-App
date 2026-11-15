// U16 acceptance (WS16 task 9, M9): preset poses equal config/design.yaml; moves ease within tokens
// cameraMs and any input cancels them; reduced motion = cuts; focus on selection from any source;
// presets 2–3 turn 3D on through the ui store; 5 = M10's follow camera; no network requests.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ui } from '../../state'
import { resetSelection, select, selection } from '../../state/selection'
import tokens from '../../ui/tokens.json'
import { CameraController, type ControllerMap } from './index'
import { focusBounds, focusPoints, type FocusSources } from './focus'
import { preset } from './presets'
import { CANCEL_INPUTS, CameraMover, easeInOut, moveDurationMs } from './transition'

const DESIGN = parse(readFileSync(resolve(__dirname, '../../../../config/design.yaml'), 'utf8')) as {
  camera: { presets: { overhead: { pitch: number; bearing: number }; isometric: { pitch: number }; low: { pitch: number }; focus: { padding_px: number } } }
}

class Target {
  private l = new Map<string, Set<(e: Event) => void>>()
  clientWidth = 1440
  clientHeight = 900
  addEventListener(t: string, fn: (e: Event) => void): void {
    if (!this.l.has(t)) this.l.set(t, new Set())
    this.l.get(t)!.add(fn)
  }
  removeEventListener(t: string, fn: (e: Event) => void): void {
    this.l.get(t)?.delete(fn)
  }
  emit(t: string, detail?: unknown): Event {
    const ev = { type: t, detail, defaultPrevented: false, preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true } } as unknown as Event
    for (const fn of [...(this.l.get(t) ?? [])]) fn(ev)
    return ev
  }
  count(t: string): number {
    return this.l.get(t)?.size ?? 0
  }
  getAttribute(): string | null {
    return null
  }
  querySelector(): null {
    return null
  }
}

function fakeMap() {
  const el = new Target()
  const cam = { lng: 137.4, lat: -4.78, zoom: 13, pitch: 0, bearing: 0 }
  const calls: { op: string; o?: Record<string, unknown> }[] = []
  let moveend: (() => void) | null = null
  const m = {
    calls,
    el,
    finish: () => moveend?.(),
    getContainer: () => el,
    getCenter: () => ({ lng: cam.lng, lat: cam.lat }),
    getZoom: () => cam.zoom,
    getPitch: () => cam.pitch,
    getBearing: () => cam.bearing,
    getMaxZoom: () => 18,
    // 1 px = 1e-4 deg at any zoom (enough for the duration maths)
    project: ([lng, lat]: [number, number]) => ({ x: lng / 1e-4, y: -lat / 1e-4 }),
    easeTo: (o: Record<string, unknown>) => void calls.push({ op: 'easeTo', o }),
    jumpTo: (o: Record<string, unknown>) => void calls.push({ op: 'jumpTo', o }),
    stop: () => void calls.push({ op: 'stop' }),
    once: (_t: string, fn: () => void) => void (moveend = fn),
    cameraForBounds: (b: [[number, number], [number, number]], o: Record<string, unknown>) => {
      calls.push({ op: 'cameraForBounds', o: { b, ...o } })
      return { center: { lng: (b[0][0] + b[1][0]) / 2, lat: (b[0][1] + b[1][1]) / 2 }, zoom: 15 }
    },
  }
  return m
}

const S7 = { id: 'S7', lon: 137.392, lat: -4.79 }
const ROUTE = {
  features: [
    { geometry: { type: 'LineString', coordinates: [[137.4017, -4.7775], [137.392, -4.79]] }, properties: { leg: 1, from: 'pad', to: 'S7' } },
    { geometry: { type: 'LineString', coordinates: [[137.392, -4.79], [137.38, -4.795]] }, properties: { leg: 2, from: 'S7', to: 'S6' } },
    { geometry: { type: 'LineString', coordinates: [[137.38, -4.795], [137.37, -4.80]] }, properties: { leg: 3, from: 'S6', to: 'S1' } },
  ],
}
const SOURCES: FocusSources = { stations: [S7, { id: 'S6', lon: 137.38, lat: -4.795 }], pad: { lon: 137.4017, lat: -4.7775 }, route: ROUTE }

let follow: { on: boolean; toggles: number }
let ready: boolean
function controller(m = fakeMap(), win = new Target()) {
  const c = new CameraController(m as unknown as ControllerMap, () => SOURCES, {
    win,
    terrainReady: async () => ready,
    follow: { on: () => follow.on, toggle: () => ((follow.on = !follow.on), follow.toggles++, true) },
  })
  return { c, m, win }
}

beforeEach(() => {
  resetSelection()
  ui.reducedMotion.value = false
  ui.view.value = '2d'
  follow = { on: false, toggles: 0 }
  ready = true
})
afterEach(() => vi.unstubAllGlobals())

describe('presets (design.yaml camera.presets)', () => {
  it('poses equal config', () => {
    const p = DESIGN.camera.presets
    expect(preset(1)).toMatchObject({ kind: 'pose', pitch: p.overhead.pitch, bearing: p.overhead.bearing, needs3d: false })
    expect(preset(2)).toMatchObject({ kind: 'pose', pitch: p.isometric.pitch, needs3d: true })
    expect(preset(3)).toMatchObject({ kind: 'pose', pitch: p.low.pitch, needs3d: true })
    expect(preset(1)).toMatchObject({ pitch: 0, bearing: 0 })
    expect([preset(2), preset(3)].map((x) => (x.kind === 'pose' ? x.pitch : null))).toEqual([45, 60])
    expect(preset(4)).toEqual({ kind: 'focus' })
    expect(preset(5)).toEqual({ kind: 'follow' })
  })

  it('keys 1–3: the shell shortcut moves the camera to the preset pose; 2–3 turn 3D on first', async () => {
    const { c, m, win } = controller()
    const ev = win.emit('hl:shortcut', { action: 'camera', preset: 1 })
    expect(ev.defaultPrevented).toBe(true)
    await Promise.resolve()
    expect(m.calls.find((x) => x.op === 'easeTo')!.o).toMatchObject({ pitch: 0, bearing: 0 })
    expect(await c.applyPreset(3)).toBe(true)
    expect(ui.view.value).toBe('3d')
    expect(m.calls.filter((x) => x.op === 'easeTo').at(-1)!.o).toMatchObject({ pitch: 60 })
    expect(m.calls.filter((x) => x.op === 'easeTo').at(-1)!.o).not.toHaveProperty('bearing')
    c.destroy()
  })

  it('no 3D available: presets 2–3 leave the camera alone', async () => {
    ready = false
    const { c, m } = controller()
    expect(await c.applyPreset(2)).toBe(false)
    expect(m.calls.some((x) => x.op === 'easeTo' || x.op === 'jumpTo')).toBe(false)
    c.destroy()
  })

  it('4 focuses on the selection (nothing selected: nothing); 5 starts the follow camera; 1 stops it', async () => {
    const { c, m } = controller()
    expect(await c.applyPreset(4)).toBe(false)
    expect(await c.applyPreset(5)).toBe(true)
    expect(follow).toEqual({ on: true, toggles: 1 })
    expect(await c.applyPreset(5)).toBe(true) // already following: stays on
    expect(follow.toggles).toBe(1)
    await c.applyPreset(1)
    expect(follow.on).toBe(false)
    select({ kind: 'station', id: 'S7' }, 'map')
    m.calls.length = 0
    expect(await c.applyPreset(4)).toBe(true)
    expect(m.calls.some((x) => x.op === 'easeTo')).toBe(true)
    c.destroy()
  })

  it('other shortcuts are not taken', () => {
    const { c, win } = controller()
    expect(win.emit('hl:shortcut', { action: 'search' }).defaultPrevented).toBe(false)
    expect(win.emit('hl:shortcut', { action: 'camera', preset: 6 }).defaultPrevented).toBe(false)
    c.destroy()
  })
})

describe('transitions (DESIGN §3.4: 1.2–2.5 s ease-in-out, any input cancels; reduced motion = cut)', () => {
  it('duration stays in tokens cameraMs and grows with the change', () => {
    const m = fakeMap()
    const [lo, hi] = tokens.motion.cameraMs
    expect(moveDurationMs(m as never, { pitch: 0 })).toBe(lo)
    const small = moveDurationMs(m as never, { center: [137.41, -4.78] })
    const big = moveDurationMs(m as never, { center: [139, -4.78] })
    expect(small).toBeGreaterThan(lo)
    expect(small).toBeLessThan(big)
    expect(big).toBe(hi)
    expect(moveDurationMs(m as never, { pitch: 70 })).toBe(hi)
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5)
    expect(easeInOut(0.25)).toBeLessThan(0.25)
  })

  it.each([...CANCEL_INPUTS])('%s on the map cancels the move at once', (input) => {
    const m = fakeMap()
    const win = new Target()
    const mv = new CameraMover(m as never, win)
    const r = mv.move({ pitch: 45 }, false)
    expect(r.kind).toBe('eased')
    expect(m.calls[0].o!.duration).toBe(r.durationMs)
    expect(mv.active).toBe(true)
    m.el.emit(input)
    expect(mv.active).toBe(false)
    expect(m.calls.at(-1)!.op).toBe('stop')
    // listeners are gone: later input does nothing more
    expect(CANCEL_INPUTS.every((t) => m.el.count(t) === 0)).toBe(true)
    expect(win.count('keydown')).toBe(0)
  })

  it('a key anywhere cancels; a finished move detaches its listeners', () => {
    const m = fakeMap()
    const win = new Target()
    const mv = new CameraMover(m as never, win)
    mv.move({ pitch: 45 }, false)
    win.emit('keydown')
    expect(mv.active).toBe(false)
    mv.move({ pitch: 45 }, false)
    m.finish()
    expect(mv.active).toBe(false)
    expect(win.count('keydown') + m.el.count('pointerdown')).toBe(0)
    const stops = m.calls.filter((x) => x.op === 'stop').length
    m.el.emit('pointerdown')
    expect(m.calls.filter((x) => x.op === 'stop').length).toBe(stops)
  })

  it('reduced motion: no animation (a cut), for presets and focus', async () => {
    ui.reducedMotion.value = true
    const { c, m } = controller()
    await c.applyPreset(1)
    select({ kind: 'station', id: 'S7' }, 'search')
    expect(m.calls.some((x) => x.op === 'easeTo')).toBe(false)
    expect(m.calls.filter((x) => x.op === 'jumpTo').length).toBe(2)
    expect(c.mover.active).toBe(false)
    c.destroy()
  })
})

describe('focus transition on selection (any source)', () => {
  it('search, list, map and history selections ease to frame the object and its legs', () => {
    const { c, m } = controller()
    for (const src of ['search', 'list', 'map'] as const) {
      resetSelection()
      m.calls.length = 0
      select({ kind: 'station', id: 'S7' }, src)
      const fit = m.calls.find((x) => x.op === 'cameraForBounds')!.o as { b: [[number, number], [number, number]]; padding: number }
      expect(fit.padding).toBe(DESIGN.camera.presets.focus.padding_px)
      // S7 plus its legs (pad -> S7, S7 -> S6): the box reaches the pad and S6, not S1's leg
      expect(fit.b[0][0]).toBeCloseTo(137.38, 6)
      expect(fit.b[1][0]).toBeCloseTo(137.4017, 6)
      expect(fit.b[0][0]).toBeGreaterThan(137.37)
      const ease = m.calls.find((x) => x.op === 'easeTo')!.o!
      expect(ease.zoom).toBe(15)
      expect((ease.duration as number) >= 1200 && (ease.duration as number) <= 2500).toBe(true)
    }
    c.destroy()
  })

  it('a cell or an edge picked on the map does not move the camera; search coordinates do', () => {
    const { c, m } = controller()
    select({ kind: 'cell', lon: 137.39, lat: -4.79 }, 'map')
    select({ kind: 'edge', cause: 'slope', budget: 30, lon: 137.39, lat: -4.79 }, 'map')
    expect(m.calls.length).toBe(0)
    select({ kind: 'cell', lon: 137.395, lat: -4.785 }, 'search')
    expect(m.calls.some((x) => x.op === 'easeTo')).toBe(true)
    c.destroy()
  })

  it('a selection made before the map existed does not move the camera on mount; focus stops the follow camera', () => {
    select({ kind: 'station', id: 'S7' }, 'list')
    follow.on = true
    const { c, m } = controller()
    expect(m.calls.length).toBe(0)
    expect(follow.on).toBe(true)
    select({ kind: 'pad', id: 'rank1' }, 'list')
    expect(follow.on).toBe(false)
    expect(m.calls.some((x) => x.op === 'easeTo')).toBe(true)
    c.destroy()
  })

  it('unknown objects have no place to frame', () => {
    expect(focusPoints({ kind: 'station', id: 'S99' }, SOURCES)).toEqual([])
    expect(focusBounds([], 400, 3389500)).toBeNull()
    const b = focusBounds([[137.39, -4.79]], 400, 3389500)!
    expect((b[3] - b[1]) * ((3389500 * Math.PI) / 180)).toBeCloseTo(400, 3)
  })
})

describe('no network', () => {
  it('presets, focus and transitions never fetch', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network')))
    vi.stubGlobal('fetch', fetchSpy)
    const { c } = controller()
    for (const k of [1, 2, 3, 4, 5] as const) await c.applyPreset(k)
    select({ kind: 'station', id: 'S7' }, 'search')
    select({ kind: 'leg', leg: 2 }, 'map')
    c.destroy()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(selection.selected.value).toEqual({ kind: 'leg', leg: 2 })
  })
})

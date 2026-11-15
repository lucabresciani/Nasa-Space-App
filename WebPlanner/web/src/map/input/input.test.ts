// I1 (WS16-map, team lead Sun 10:50): the planning map's mouse model. Right button drags the map,
// left button interacts (click selects, drag on the rover moves the rover, drag on empty map does
// nothing); Ctrl/Shift + right drag or middle drag rotates and tilts (pitch clamped to the map's
// current maxPitch: 0 in 2D); no context menu on the map; any such press cancels a running camera
// move; MapLibre's own left-button pan, right-button rotate and box zoom stay off, touch stays on.
import { describe, expect, it } from 'vitest'
import { CameraMover } from '../camera/transition'
import { INERTIA, installMapInput, PITCH_DEG_PER_PX, pressMode, ROTATE_DEG_PER_PX, type InputMap } from './index'

type Ev = Event & Record<string, unknown>
const ev = (type: string, o: Record<string, unknown> = {}): Ev => Object.assign(new Event(type, { cancelable: true }), { pointerType: 'mouse', pointerId: 1, button: -1, clientX: 0, clientY: 0, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...o }) as unknown as Ev

class ClassList {
  s = new Set<string>()
  add(...c: string[]) {
    for (const x of c) this.s.add(x)
  }
  remove(...c: string[]) {
    for (const x of c) this.s.delete(x)
  }
  toggle(c: string, on?: boolean) {
    if (on ?? !this.s.has(c)) this.s.add(c)
    else this.s.delete(c)
  }
  contains(c: string) {
    return this.s.has(c)
  }
}

function toggle(on = true) {
  return {
    on,
    enable() {
      this.on = true
    },
    disable() {
      this.on = false
    },
    isEnabled() {
      return this.on
    },
  }
}

function fakeMap(o: { maxPitch?: number; privatePan?: boolean } = {}) {
  const canvas = Object.assign(new EventTarget(), { classList: new ClassList() })
  const container = Object.assign(new EventTarget(), { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v }, clientWidth: 1440, clientHeight: 900 })
  const cam = { lng: 137.4, lat: -4.78, zoom: 15, pitch: 0, bearing: 0, maxPitch: o.maxPitch ?? 0 }
  const mousePan = toggle()
  const touchPan = toggle()
  const dragPan = {
    _mousePan: o.privatePan === false ? undefined : mousePan,
    enable() {
      mousePan.enable()
      touchPan.enable()
    },
    disable() {
      mousePan.disable()
      touchPan.disable()
    },
    isEnabled: () => mousePan.on && touchPan.on,
  }
  const dragRotate = toggle(false)
  const boxZoom = toggle()
  const moveend = new Set<() => void>()
  const calls: { op: string; a?: unknown; b?: unknown }[] = []
  const m = {
    calls,
    canvas,
    container,
    cam,
    mousePan,
    touchPan,
    dragPanBox: dragPan,
    dragRotateBox: dragRotate,
    dragPan,
    dragRotate,
    boxZoom,
    getContainer: () => container,
    getCanvasContainer: () => canvas,
    getCenter: () => ({ lng: cam.lng, lat: cam.lat }),
    getZoom: () => cam.zoom,
    getPitch: () => cam.pitch,
    getBearing: () => cam.bearing,
    getMinPitch: () => 0,
    getMaxPitch: () => cam.maxPitch,
    // 1 px = 1e-5 deg in this fake; panBy([x, y]) moves the centre east/south by x/y px
    panBy(off: [number, number], opt?: { duration?: number }) {
      calls.push({ op: 'panBy', a: off, b: opt })
      cam.lng += off[0] * 1e-5
      cam.lat -= off[1] * 1e-5
      for (const f of moveend) f()
    },
    jumpTo(j: { bearing?: number; pitch?: number }) {
      calls.push({ op: 'jumpTo', a: j })
      if (j.bearing !== undefined) cam.bearing = j.bearing
      if (j.pitch !== undefined) cam.pitch = Math.min(cam.maxPitch, j.pitch)
      for (const f of moveend) f()
    },
    easeTo(j: unknown) {
      calls.push({ op: 'easeTo', a: j })
    },
    project: () => ({ x: 0, y: 0 }),
    stop() {
      calls.push({ op: 'stop' })
    },
    once(t: string, fn: () => void) {
      if (t === 'moveend') moveend.add(fn)
    },
    on(t: string, fn: () => void) {
      if (t === 'moveend') moveend.add(fn)
    },
    off(t: string, fn: () => void) {
      if (t === 'moveend') moveend.delete(fn)
    },
  }
  return m
}

function setup(o: { maxPitch?: number; reduced?: boolean; privatePan?: boolean } = {}) {
  const map = fakeMap(o)
  const win = new EventTarget()
  let now = 0
  const input = installMapInput(map as unknown as InputMap, { reduced: () => !!o.reduced, win, frame: (cb) => (cb(), 1), cancelFrame: () => {}, now: () => now })
  const tick = (ms: number) => (now += ms)
  const down = (x: number, y: number, mods: Record<string, unknown> = {}) => {
    const e = ev('pointerdown', { clientX: x, clientY: y, ...mods })
    map.canvas.dispatchEvent(e)
    return e
  }
  const move = (x: number, y: number, mods: Record<string, unknown> = {}) => win.dispatchEvent(ev('pointermove', { clientX: x, clientY: y, ...mods }))
  const up = (x: number, y: number, button = 2) => win.dispatchEvent(ev('pointerup', { clientX: x, clientY: y, button }))
  return { map, win, input, down, move, up, tick }
}

const ops = (m: ReturnType<typeof fakeMap>, op: string) => m.calls.filter((c) => c.op === op)

describe('I1 map input: MapLibre handlers', () => {
  it('turns off MapLibre left-button pan and box zoom, keeps touch pan on', () => {
    const { map } = setup()
    expect(map.mousePan.on).toBe(false)
    expect(map.touchPan.on).toBe(true)
    expect(map.boxZoom.on).toBe(false)
  })

  it('without the private mouse-pan handle it still turns pan off (touch then off too)', () => {
    const { map } = setup({ privatePan: false })
    expect(map.mousePan.on).toBe(false)
  })

  it("re-enabling dragPan never brings MapLibre's left-button pan back", () => {
    const { map } = setup()
    map.dragPan.enable()
    expect(map.mousePan.on).toBe(false)
    expect(map.touchPan.on).toBe(true)
  })

  it("map.dragRotate (M8 turns it on in 3D) is the 'rotation allowed' switch; MapLibre's own rotate stays off", () => {
    const { map, input } = setup({ maxPitch: 70 })
    const box = map.dragRotate
    expect(input.rotateAllowed).toBe(false)
    map.dragRotate.enable()
    expect(input.rotateAllowed).toBe(true)
    expect(map.dragRotate.isEnabled()).toBe(true)
    expect(box.on).toBe(false) // MapLibre's handler itself never enabled
    map.dragRotate.disable()
    expect(input.rotateAllowed).toBe(false)
  })

  it('destroy restores the handlers and removes every listener', () => {
    const { map, input, down, move } = setup()
    input.destroy()
    expect(map.mousePan.on).toBe(true)
    down(100, 100, { button: 2 })
    move(150, 100)
    expect(ops(map, 'panBy')).toHaveLength(0)
  })
})

describe('I1 map input: right drag pans', () => {
  it('pressMode: right = pan; Ctrl/Shift + right or middle = rotate; left and touch = none', () => {
    expect(pressMode({ button: 2, pointerType: 'mouse' })).toBe('pan')
    expect(pressMode({ button: 2, pointerType: 'mouse', ctrlKey: true })).toBe('rotate')
    expect(pressMode({ button: 2, pointerType: 'mouse', shiftKey: true })).toBe('rotate')
    expect(pressMode({ button: 1, pointerType: 'mouse' })).toBe('rotate')
    expect(pressMode({ button: 2, pointerType: 'pen' })).toBe('pan')
    expect(pressMode({ button: 0, pointerType: 'mouse' })).toBeNull()
    expect(pressMode({ button: 0, pointerType: 'mouse', ctrlKey: true })).toBeNull()
    expect(pressMode({ button: 2, pointerType: 'touch' })).toBeNull()
  })

  it('moves the map with the pointer: panBy(-dx, -dy) per frame, no animation', () => {
    const { map, down, move, up } = setup()
    const e = down(100, 100, { button: 2 })
    expect(e.defaultPrevented).toBe(true) // no compatibility mousedown: no marker drag, no MapLibre handler
    move(130, 90)
    move(160, 120)
    up(160, 120)
    const p = ops(map, 'panBy')
    expect(p.map((c) => c.a)).toEqual([
      [-30, 10],
      [-30, -30],
    ])
    expect(p.every((c) => (c.b as { duration: number }).duration === 0)).toBe(true)
    // the content under the pointer followed it: 60 px right, 20 px down -> centre 60 px west, 20 px north
    expect(map.cam.lng).toBeCloseTo(137.4 - 60e-5, 9)
    expect(map.cam.lat).toBeCloseTo(-4.78 + 20e-5, 9)
  })

  it('left drag on the map does nothing (no pan, no rotate, default not prevented)', () => {
    const { map, down, move, up } = setup({ maxPitch: 70 })
    map.dragRotate.enable()
    const e = down(100, 100, { button: 0 })
    move(200, 50)
    up(200, 50, 0)
    expect(e.defaultPrevented).toBe(false)
    expect(ops(map, 'panBy')).toHaveLength(0)
    expect(ops(map, 'jumpTo')).toHaveLength(0)
  })

  it('touch pointers are left to MapLibre (one finger pans, two fingers rotate / tilt / zoom)', () => {
    const { map, down, move } = setup()
    down(100, 100, { button: 0, pointerType: 'touch' })
    move(150, 100, { pointerType: 'touch' })
    expect(ops(map, 'panBy')).toHaveLength(0)
  })

  it('moves after release do nothing; a second pointer does not hijack the drag', () => {
    const { map, down, move, up } = setup()
    down(100, 100, { button: 2 })
    move(110, 100, { pointerId: 7 })
    up(100, 100)
    move(200, 100)
    expect(ops(map, 'panBy')).toHaveLength(0)
  })

  it('a right drag sets the grabbing cursor while it lasts', () => {
    const { map, down, move, up } = setup()
    expect(map.canvas.classList.contains('hl-input')).toBe(true)
    down(100, 100, { button: 2 })
    move(120, 100)
    expect(map.canvas.classList.contains('hl-input--pan')).toBe(true)
    up(120, 100)
    expect(map.canvas.classList.contains('hl-input--pan')).toBe(false)
  })

  it('a fast flick glides on (MapLibre inertia defaults); none under reduced motion or after a pause', () => {
    for (const reduced of [false, true]) {
      const { map, down, move, up, tick } = setup({ reduced })
      down(100, 100, { button: 2 })
      tick(16)
      move(140, 100)
      tick(16)
      move(180, 100)
      up(180, 100)
      const glide = ops(map, 'panBy').filter((c) => (c.b as { duration: number }).duration > 0)
      if (reduced) expect(glide).toHaveLength(0)
      else {
        expect(glide).toHaveLength(1)
        const [x, y] = glide[0].a as [number, number]
        expect(x).toBeLessThan(0) // keeps going the same way (map content right = centre west)
        expect(y).toBeCloseTo(0, 6)
        expect((glide[0].b as { duration: number }).duration).toBeLessThanOrEqual((INERTIA.maxSpeed / (INERTIA.deceleration * INERTIA.linearity)) * 1000)
      }
    }
    const { map, down, move, up, tick } = setup()
    down(100, 100, { button: 2 })
    move(180, 100)
    tick(400) // held still before release
    up(180, 100)
    expect(ops(map, 'panBy').filter((c) => (c.b as { duration: number }).duration > 0)).toHaveLength(0)
  })
})

describe('I1 map input: rotate and tilt', () => {
  it('Ctrl + right drag in 3D: dx -> bearing, dy -> pitch (drag up tilts toward the horizon)', () => {
    const { map, down, move, up } = setup({ maxPitch: 70 })
    map.dragRotate.enable()
    down(100, 100, { button: 2, ctrlKey: true })
    move(150, 80, { ctrlKey: true })
    up(150, 80)
    expect(map.cam.bearing).toBeCloseTo(50 * ROTATE_DEG_PER_PX, 9)
    expect(map.cam.pitch).toBeCloseTo(20 * PITCH_DEG_PER_PX, 9)
    expect(ops(map, 'panBy')).toHaveLength(0)
  })

  it('Shift + right drag and middle drag rotate too', () => {
    for (const mods of [{ button: 2, shiftKey: true }, { button: 1 }]) {
      const { map, down, move } = setup({ maxPitch: 70 })
      map.dragRotate.enable()
      const e = down(100, 100, mods)
      expect(e.defaultPrevented).toBe(true) // middle: no autoscroll
      move(90, 100, mods)
      expect(map.cam.bearing).toBeCloseTo(-10 * ROTATE_DEG_PER_PX, 9)
      expect(ops(map, 'panBy')).toHaveLength(0)
    }
  })

  it('pitch is clamped to the current maxPitch (M8: 70 in 3D) and to >= minPitch', () => {
    const { map, down, move } = setup({ maxPitch: 70 })
    map.dragRotate.enable()
    down(100, 500, { button: 1 })
    move(100, 0)
    expect(map.cam.pitch).toBe(70)
    const j = ops(map, 'jumpTo').at(-1)!.a as { pitch: number }
    expect(j.pitch).toBe(70)
    move(100, 1000)
    expect(map.cam.pitch).toBe(0)
  })

  it('2D (maxPitch 0, rotation locked by M8): Ctrl + right drag changes neither pitch nor bearing', () => {
    const { map, down, move } = setup({ maxPitch: 0 })
    down(100, 100, { button: 2, ctrlKey: true })
    move(200, 0, { ctrlKey: true })
    expect(map.cam.pitch).toBe(0)
    expect(map.cam.bearing).toBe(0)
    // even if rotation were allowed, the pitch stays at the 2D clamp
    map.dragRotate.enable()
    move(300, -200, { ctrlKey: true })
    expect(map.cam.pitch).toBe(0)
    expect(map.cam.bearing).not.toBe(0)
  })

  it('pressing Ctrl in the middle of a right drag switches from pan to rotate', () => {
    const { map, down, move } = setup({ maxPitch: 70 })
    map.dragRotate.enable()
    down(100, 100, { button: 2 })
    move(110, 100)
    move(120, 100, { ctrlKey: true })
    expect(ops(map, 'panBy')).toHaveLength(1)
    expect(map.cam.bearing).toBeCloseTo(10 * ROTATE_DEG_PER_PX, 9)
  })
})

describe('I1 map input: context menu and camera moves', () => {
  it('suppresses the context menu on the map canvas only', () => {
    const { map, win } = setup()
    const c = ev('contextmenu')
    map.canvas.dispatchEvent(c)
    expect(c.defaultPrevented).toBe(true)
    const w = ev('contextmenu')
    win.dispatchEvent(w)
    expect(w.defaultPrevented).toBe(false)
  })

  it('a right or middle press stops a running camera move (focus ease, flythrough jump) at once', () => {
    for (const mods of [{ button: 2 }, { button: 2, ctrlKey: true }, { button: 1 }]) {
      const { map, down } = setup({ maxPitch: 70 })
      down(10, 10, mods)
      expect(ops(map, 'stop')).toHaveLength(1)
    }
  })

  it("M9's CameraMover listening on the same map is cancelled by a right press", () => {
    const { map } = setup()
    // the mover listens on the map container; the canvas container sits inside it and the press bubbles
    const mover = new CameraMover(map as never, null)
    mover.move({ zoom: 17 }, false)
    expect(mover.active).toBe(true)
    map.container.dispatchEvent(ev('pointerdown', { button: 2 }))
    expect(mover.active).toBe(false)
  })

  it('a left press during a pan glide stops the glide', () => {
    const { map, down, move, up, tick } = setup()
    down(100, 100, { button: 2 })
    tick(16)
    move(200, 100)
    up(200, 100)
    const before = ops(map, 'stop').length
    down(300, 300, { button: 0 })
    expect(ops(map, 'stop').length).toBe(before + 1)
  })

  it('writes the camera to the map container for RR / e2e (data-camera-*)', () => {
    const { map, down, move } = setup({ maxPitch: 70 })
    map.dragRotate.enable()
    down(0, 0, { button: 2 })
    move(10, 0)
    expect(map.container.attrs['data-camera-center']).toBe(`${map.cam.lng.toFixed(6)},${map.cam.lat.toFixed(6)}`)
    expect(map.container.attrs['data-camera-bearing']).toBe('0.0')
    expect(map.container.attrs['data-camera-pitch']).toBe('0.0')
  })
})

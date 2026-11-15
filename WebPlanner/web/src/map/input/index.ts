// I1 (WS16-map, team lead Sun 10:50): the planning map's mouse model.
//
//   left button    interacts: click selects (M9, map/select.ts), a drag on the rover moves the
//                  rover (H2/H2b, edit/roverMap.ts), a drag on the empty map does nothing
//   right drag     pans the map (the ground under the pointer follows it; a flick glides on with
//                  MapLibre's inertia defaults, never under reduced motion)
//   Ctrl / Shift + right drag, or middle drag
//                  rotates (dx -> bearing) and tilts (dy -> pitch, clamped to the map's current
//                  maxPitch: 0 in 2D, M8's limit in 3D). Rotation follows map.dragRotate, which M8's
//                  TerrainController turns on in 3D and off in 2D (north up)
//   wheel, keyboard, the on-map controls, touch (one finger pans, two fingers rotate / tilt / zoom)
//                  stay MapLibre's
//   context menu   suppressed on the map canvas only
//
// MapLibre's own left-button pan (dragPan's mouse half), right-button rotate (dragRotate) and box
// zoom (Shift + left drag) are off. A right or middle press stops any running camera move at once
// (the focus ease and the flythrough also cancel themselves on that pointerdown).
//
// Rotation and pitch speeds and the inertia numbers are MapLibre 6.18's defaults (handler/mouse.ts,
// handler_inertia.ts), so the feel matches what MapLibre did before, only on other buttons.

import './input.css'

/** MapLibre's mouse rotate speed (deg of bearing per px of horizontal drag). */
export const ROTATE_DEG_PER_PX = 0.8
/** MapLibre's mouse pitch speed (deg of pitch per px of vertical drag; up tilts toward the horizon). */
export const PITCH_DEG_PER_PX = 0.5
/** MapLibre's pan inertia defaults (px/s, px/s², window ms). */
export const INERTIA = { linearity: 0.3, maxSpeed: 1400, deceleration: 2500, windowMs: 160 } as const

export type PressMode = 'pan' | 'rotate'

interface PointerLike {
  button?: number
  pointerType?: string
  ctrlKey?: boolean
  shiftKey?: boolean
}

/** What a press (or, for the modifiers, a move of a held press) does; null = not ours. */
export function pressMode(e: PointerLike, button = e.button): PressMode | null {
  if (e.pointerType === 'touch') return null
  if (button === 1) return 'rotate'
  if (button === 2) return e.ctrlKey || e.shiftKey ? 'rotate' : 'pan'
  return null
}

interface Listenable {
  addEventListener(type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, fn: (e: Event) => void, opts?: boolean | EventListenerOptions): void
}

interface Toggle {
  enable(o?: unknown): void
  disable(): void
  isEnabled(): boolean
}

/** The part of a MapLibre map the controller uses (a fake in tests). */
export interface InputMap {
  getContainer(): Listenable & { setAttribute(k: string, v: string): void }
  getCanvasContainer(): Listenable & { classList: { add(...c: string[]): void; remove(...c: string[]): void } }
  getCenter(): { lng: number; lat: number }
  getPitch(): number
  getBearing(): number
  getMinPitch(): number
  getMaxPitch(): number
  panBy(offset: [number, number], o?: { duration?: number; easing?: (t: number) => number; essential?: boolean }): unknown
  jumpTo(o: { bearing?: number; pitch?: number }): unknown
  stop(): unknown
  on(type: 'moveend', fn: () => void): unknown
  off(type: 'moveend', fn: () => void): unknown
  once(type: 'moveend', fn: () => void): unknown
  dragPan: Toggle
  dragRotate: Toggle
  boxZoom?: Toggle
}

export interface InputOptions {
  /** reduced motion (ui.reducedMotion): no glide after a flick */
  reduced: () => boolean
  win?: Listenable
  frame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
  now?: () => number
}

export interface MapInput {
  /** Rotation allowed (map.dragRotate as M8 sets it: 3D on). */
  readonly rotateAllowed: boolean
  destroy(): void
}

/** Ease-out for the glide (close to MapLibre's bezier(0, 0, 0.3, 1)). */
const glideEasing = (t: number): number => 1 - Math.pow(1 - t, 3)

const CAPTURE = { capture: true } as const

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function installMapInput(map: InputMap, opts: InputOptions): MapInput {
  const win: Listenable | null = opts.win ?? (typeof window === 'undefined' ? null : window)
  const frame = opts.frame ?? ((cb: () => void) => requestAnimationFrame(cb))
  const cancelFrame = opts.cancelFrame ?? ((id: number) => cancelAnimationFrame(id))
  const now = opts.now ?? (() => performance.now())
  const canvas = map.getCanvasContainer()
  const container = map.getContainer()

  // ---- MapLibre handlers --------------------------------------------------------------------
  // dragPan = mouse pan (left button) + touch pan; only the mouse half goes. Its handle is private
  // in MapLibre 6.18; without it the whole dragPan goes off (touch pan lost, but no left-button pan).
  const dragPan = map.dragPan as Toggle & { _mousePan?: Toggle }
  const mousePan = dragPan._mousePan
  const panEnable = dragPan.enable
  if (mousePan) mousePan.disable()
  else dragPan.disable()
  dragPan.enable = (o?: unknown) => {
    if (!mousePan) return
    panEnable.call(dragPan, o)
    mousePan.disable()
  }
  // dragRotate: M8 switches it with the 3D view; that switch now means "rotation allowed" here and
  // MapLibre's own right-button / Ctrl+left rotate never runs.
  const dr = map.dragRotate
  const drOrig = { enable: dr.enable, disable: dr.disable, isEnabled: dr.isEnabled }
  let rotateOn = dr.isEnabled()
  drOrig.disable.call(dr)
  dr.enable = () => {
    rotateOn = true
  }
  dr.disable = () => {
    rotateOn = false
  }
  dr.isEnabled = () => rotateOn
  const boxWasOn = map.boxZoom?.isEnabled() ?? false
  map.boxZoom?.disable()
  canvas.classList.add('hl-input')

  // ---- camera attributes for RR / e2e --------------------------------------------------------
  const writeCamera = (): void => {
    const c = map.getCenter()
    container.setAttribute('data-camera-center', `${c.lng.toFixed(6)},${c.lat.toFixed(6)}`)
    container.setAttribute('data-camera-bearing', map.getBearing().toFixed(1))
    container.setAttribute('data-camera-pitch', map.getPitch().toFixed(1))
  }
  map.on('moveend', writeCamera)
  writeCamera()

  // ---- drag state -----------------------------------------------------------------------------
  let drag: { id: number; button: number; x: number; y: number } | null = null
  let pan = { x: 0, y: 0 }
  let rot = { x: 0, y: 0 }
  let samples: { t: number; x: number; y: number }[] = []
  let scheduled = false
  let raf = 0
  let gliding = false

  const flush = (): void => {
    if (pan.x || pan.y) {
      map.panBy([-pan.x, -pan.y], { duration: 0 })
      pan = { x: 0, y: 0 }
    }
    if (rot.x || rot.y) {
      const b0 = map.getBearing()
      const p0 = map.getPitch()
      const bearing = rotateOn ? b0 + rot.x * ROTATE_DEG_PER_PX : b0
      const pitch = clamp(p0 - rot.y * PITCH_DEG_PER_PX, map.getMinPitch(), map.getMaxPitch())
      rot = { x: 0, y: 0 }
      if (bearing !== b0 || pitch !== p0) map.jumpTo({ bearing, pitch })
    }
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    const id = frame(() => {
      scheduled = false
      raf = 0
      flush()
    })
    if (scheduled) raf = id
  }

  const setCursor = (mode: PressMode | null): void => {
    canvas.classList.remove('hl-input--pan', 'hl-input--rotate')
    if (mode) canvas.classList.add(`hl-input--${mode}`)
  }

  /** Take the pointer's movement since the last event into the pending pan / rotate. */
  const take = (p: PointerEvent): void => {
    if (!drag) return
    const dx = p.clientX - drag.x
    const dy = p.clientY - drag.y
    drag.x = p.clientX
    drag.y = p.clientY
    if (!dx && !dy) return
    const mode = pressMode(p, drag.button)
    if (mode === 'pan') {
      pan.x += dx
      pan.y += dy
      samples.push({ t: now(), x: dx, y: dy })
    } else {
      rot.x += dx
      rot.y += dy
      samples = []
    }
    setCursor(mode)
    schedule()
  }

  const onMove = (e: Event): void => {
    const p = e as PointerEvent
    if (!drag || p.pointerId !== drag.id) return
    if (p.buttons === 0) return end(p) // released where we did not hear it
    take(p)
  }

  const glide = (): void => {
    const t = now()
    const s = samples.filter((x) => x.t >= t - INERTIA.windowMs)
    samples = []
    if (opts.reduced() || s.length < 2) return
    const dt = s[s.length - 1].t - s[0].t
    if (dt <= 0) return
    let x = 0
    let y = 0
    for (const q of s.slice(1)) {
      x += q.x
      y += q.y
    }
    const mag = Math.hypot(x, y)
    if (!mag) return
    const speed = clamp((mag * INERTIA.linearity) / (dt / 1000), 0, INERTIA.maxSpeed)
    const durS = speed / (INERTIA.deceleration * INERTIA.linearity)
    const amount = speed * (durS / 2)
    if (amount < 1) return
    map.panBy([(-x / mag) * amount, (-y / mag) * amount], { duration: durS * 1000, easing: glideEasing, essential: false })
    gliding = true
    map.once('moveend', () => (gliding = false))
  }

  const detach = (): void => {
    win?.removeEventListener('pointermove', onMove)
    win?.removeEventListener('pointerup', onUp)
    win?.removeEventListener('pointercancel', onCancel)
    win?.removeEventListener('blur', onCancel)
  }

  function end(p: PointerEvent | null, withGlide = true): void {
    if (!drag) return
    if (p) take(p)
    drag = null
    detach()
    if (raf) cancelFrame(raf)
    raf = 0
    scheduled = false
    flush()
    setCursor(null)
    if (withGlide) glide()
    else samples = []
  }
  const onUp = (e: Event): void => {
    const p = e as PointerEvent
    if (drag && p.pointerId === drag.id) end(p)
  }
  const onCancel = (): void => end(null, false)

  const onDown = (e: Event): void => {
    const p = e as PointerEvent
    if (p.pointerType === 'touch') return
    const mode = pressMode(p)
    if (!mode) {
      // left press: interaction (select / rover); only a glide of ours is stopped
      if (gliding) {
        gliding = false
        map.stop()
      }
      return
    }
    // no compatibility mousedown: no marker drag, no MapLibre mouse handler, no middle autoscroll
    p.preventDefault()
    map.stop() // any input cancels a running camera move (DESIGN §3.4)
    gliding = false
    if (drag) end(null, false)
    drag = { id: p.pointerId, button: p.button, x: p.clientX, y: p.clientY }
    samples = [{ t: now(), x: 0, y: 0 }]
    win?.addEventListener('pointermove', onMove)
    win?.addEventListener('pointerup', onUp)
    win?.addEventListener('pointercancel', onCancel)
    win?.addEventListener('blur', onCancel)
  }
  const onMouseDown = (e: Event): void => {
    if ((e as MouseEvent).button === 1) e.preventDefault() // middle-click autoscroll
  }
  const onContext = (e: Event): void => e.preventDefault()

  canvas.addEventListener('pointerdown', onDown, CAPTURE)
  canvas.addEventListener('mousedown', onMouseDown, CAPTURE)
  canvas.addEventListener('contextmenu', onContext)

  return {
    get rotateAllowed() {
      return rotateOn
    },
    destroy() {
      end(null, false)
      canvas.removeEventListener('pointerdown', onDown, CAPTURE)
      canvas.removeEventListener('mousedown', onMouseDown, CAPTURE)
      canvas.removeEventListener('contextmenu', onContext)
      canvas.classList.remove('hl-input')
      map.off('moveend', writeCamera)
      dragPan.enable = panEnable
      if (mousePan) mousePan.enable()
      else dragPan.enable()
      dr.enable = drOrig.enable
      dr.disable = drOrig.disable
      dr.isEnabled = drOrig.isEnabled
      if (rotateOn) dr.enable()
      if (boxWasOn) map.boxZoom?.enable()
    },
  }
}

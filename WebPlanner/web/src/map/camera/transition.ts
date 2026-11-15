// WS16 task 9 (M9): eased camera moves (DESIGN §3.4 "Camera move 1.2–2.5 s, ease-in-out, any input
// cancels at once"; reduced motion: camera moves become cuts). One move at a time per map: a new move
// replaces the running one. MapLibre animates (easeTo); this module picks the duration, the easing,
// the cut under reduced motion and the cancel on input.
import { CAMERA_MS } from './config'

export interface CameraTarget {
  center?: [number, number]
  zoom?: number
  pitch?: number
  bearing?: number
}

interface Listenable {
  addEventListener(type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, fn: (e: Event) => void, opts?: boolean | EventListenerOptions): void
}

/** The part of a MapLibre map the mover uses (a fake in tests). */
export interface CameraMap {
  getContainer(): Listenable & { clientWidth: number; clientHeight: number }
  getCenter(): { lng: number; lat: number }
  getZoom(): number
  getPitch(): number
  getBearing(): number
  project(ll: [number, number]): { x: number; y: number }
  easeTo(o: CameraTarget & { duration: number; easing: (t: number) => number; essential?: boolean }): unknown
  jumpTo(o: CameraTarget): unknown
  stop(): unknown
  once(type: 'moveend', fn: () => void): unknown
}

/** Inputs that cancel a camera move (DESIGN §3.4 "any input cancels at once"). */
export const CANCEL_INPUTS = ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const

/** Cubic ease-in-out (§3.4 camera easing). */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

const angle = (a: number, b: number): number => Math.abs(((((b - a) % 360) + 540) % 360) - 180)

/**
 * Duration of a move from the current camera to `to`, within tokens cameraMs [1200, 2500] ms: the
 * shortest for a small change, the longest for a pan of a screen diagonal or more, 4 zoom levels,
 * 70° of tilt or 180° of turn (whichever is largest).
 */
export function moveDurationMs(map: CameraMap, to: CameraTarget, range: readonly [number, number] = CAMERA_MS): number {
  const c = map.getContainer()
  const diag = Math.hypot(c.clientWidth, c.clientHeight) || 1
  let pan = 0
  if (to.center) {
    const a = map.project([map.getCenter().lng, map.getCenter().lat])
    const b = map.project(to.center)
    pan = Math.hypot(b.x - a.x, b.y - a.y) / diag
  }
  const dz = to.zoom === undefined ? 0 : Math.abs(to.zoom - map.getZoom()) / 4
  const dp = to.pitch === undefined ? 0 : Math.abs(to.pitch - map.getPitch()) / 70
  const db = to.bearing === undefined ? 0 : angle(map.getBearing(), to.bearing) / 180
  const f = Math.min(1, Math.max(pan, dz, dp, db))
  return Math.round(range[0] + (range[1] - range[0]) * f)
}

export interface MoveResult {
  /** 'cut' = jumped (reduced motion), 'eased' = animation started */
  kind: 'cut' | 'eased'
  durationMs: number
}

export class CameraMover {
  private cleanup: (() => void) | null = null
  private readonly map: CameraMap
  private readonly win: Listenable | null

  constructor(map: CameraMap, win: Listenable | null = typeof window === 'undefined' ? null : window) {
    this.map = map
    this.win = win
  }

  /** True while an eased move runs. */
  get active(): boolean {
    return this.cleanup !== null
  }

  move(to: CameraTarget, reduced: boolean): MoveResult {
    this.cancel()
    if (reduced) {
      this.map.jumpTo(to)
      return { kind: 'cut', durationMs: 0 }
    }
    const durationMs = moveDurationMs(this.map, to)
    const el = this.map.getContainer()
    const onInput = (): void => this.cancel()
    const opts = { capture: true, passive: true }
    for (const ev of CANCEL_INPUTS) el.addEventListener(ev, onInput, opts)
    this.win?.addEventListener('keydown', onInput, true)
    const done = (): void => {
      for (const ev of CANCEL_INPUTS) el.removeEventListener(ev, onInput, opts)
      this.win?.removeEventListener('keydown', onInput, true)
    }
    this.cleanup = done
    this.map.easeTo({ ...to, duration: durationMs, easing: easeInOut, essential: false })
    this.map.once('moveend', () => {
      if (this.cleanup === done) {
        this.cleanup = null
        done()
      }
    })
    return { kind: 'eased', durationMs }
  }

  /** Stop the running move where it is (input, a new move, destroy). */
  cancel(): void {
    const c = this.cleanup
    if (!c) return
    this.cleanup = null
    c()
    this.map.stop()
  }
}

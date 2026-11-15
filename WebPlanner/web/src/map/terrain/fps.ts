// WS16 task 8 (M8): the 3D frame-rate watch (DESIGN U1 item 6: below 30 fps for 3 s in 3D -> flat
// with relief shading and a one-line notice). Pure state machine fed with frame times (ms); the map
// side (index.ts) feeds it MapLibre 'render' events while 3D is on.
//
// MapLibre renders on demand, so a still map produces no frames: a gap longer than idleGapMs is an
// idle map, not a slow frame, and restarts the measurement.
import { TERRAIN, TERRAIN_PENDING } from './config'

export interface FpsWatchOptions {
  minFps: number
  windowMs: number
  slowForMs: number
  idleGapMs: number
}

export const FPS_WATCH: FpsWatchOptions = {
  minFps: TERRAIN.fps3dMin,
  windowMs: TERRAIN_PENDING.fpsWindowMs,
  slowForMs: TERRAIN_PENDING.slowWindowMs,
  idleGapMs: TERRAIN_PENDING.idleGapMs,
}

export type FpsState = 'ok' | 'slow' | 'tripped'

// M10d: a story (descent intro, kiosk, capture) suspends every watch from its start to its end
// (StoryStage constructor / restore()): its frame rate is the storyboard's, and a slow GPU must not
// drop the descent to flat mid-intro. Every resume bumps `epoch`, so each watch starts a fresh window.
let suspended = false
let epoch = 0

/** Suspend (true) or resume (false) the 3D frame-rate watch; the story stage calls it. */
export function setFpsWatchSuspended(on: boolean): void {
  if (on === suspended) return
  suspended = on
  epoch++
}

export function fpsWatchSuspended(): boolean {
  return suspended
}

export class FpsWatch {
  private frames: number[] = []
  private slowSince: number | null = null
  private tripped = false
  private epoch = epoch
  private readonly o: FpsWatchOptions
  constructor(o: FpsWatchOptions = FPS_WATCH) {
    this.o = o
  }

  /** Frames per second over the trailing window, null until the window holds two frames. */
  fps(): number | null {
    const f = this.frames
    if (f.length < 2) return null
    return ((f.length - 1) * 1000) / (f[f.length - 1] - f[0])
  }

  /** Feed one rendered frame at time `t` (ms); returns the state after it. Once tripped, stays tripped. */
  frame(t: number): FpsState {
    if (this.tripped) return 'tripped'
    if (this.epoch !== epoch) {
      // suspended or resumed since the last frame: measurements across a story never count
      this.epoch = epoch
      this.reset()
    }
    if (suspended) return 'ok'
    const last = this.frames[this.frames.length - 1]
    if (last !== undefined && t - last > this.o.idleGapMs) this.reset()
    const f = this.frames
    f.push(t)
    while (f.length > 2 && t - f[0] > this.o.windowMs) f.shift()
    // judge only after half a window of continuous rendering
    const fps = t - f[0] >= this.o.windowMs / 2 ? this.fps() : null
    if (fps === null) return this.slowSince === null ? 'ok' : 'slow'
    if (fps >= this.o.minFps - 1e-6) {  // frame times are floats: exactly the minimum is not slow
      this.slowSince = null
      return 'ok'
    }
    this.slowSince ??= f[0]
    if (t - this.slowSince >= this.o.slowForMs) {
      this.tripped = true
      return 'tripped'
    }
    return 'slow'
  }

  /** Forget the measurement (3D switched off and on again, or an idle gap). */
  reset(): void {
    this.frames = []
    this.slowSince = null
  }

  /** Start over completely, including a trip (the user asks for 3D again). */
  rearm(): void {
    this.reset()
    this.tripped = false
  }

  get isTripped(): boolean {
    return this.tripped
  }
}

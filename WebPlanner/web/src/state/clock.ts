// Playback clock (F18) on signals. The behaviour is the original hud/clock.ts PlaybackClock, line
// for line: EVA minutes driven by real time × speed (speeds from config/hud.yaml, default 60×, D13);
// 1× is real time. The state lives in signals so several views (and route changes) can share it:
// `new PlaybackClock(...)` keeps a private state as before; mission.ts's sharedClock() drives the
// one mission clock.
import { batch, signal, type Signal } from './signal'

export interface ClockSignals {
  /** EVA minute */
  t: Signal<number>
  speed: Signal<number>
  playing: Signal<boolean>
  /** end of the scrubber (min); the mission clock shares this with budgets.evaMin */
  tMax: Signal<number>
  speeds: readonly number[]
}

export function clockSignals(tMax: number, speeds: readonly number[], defaultSpeed: number): ClockSignals {
  if (!speeds.includes(defaultSpeed)) throw new Error(`default speed ${defaultSpeed} not in ${speeds}`)
  return { t: signal(0), speed: signal(defaultSpeed), playing: signal(false), tMax: signal(tMax), speeds }
}

/** The PlaybackClock API over a set of clock signals. */
export class ClockDriver {
  readonly s: ClockSignals
  constructor(s: ClockSignals) {
    this.s = s
  }
  get t(): number {
    return this.s.t.peek()
  }
  set t(v: number) {
    this.s.t.value = v
  }
  get speed(): number {
    return this.s.speed.peek()
  }
  set speed(v: number) {
    this.s.speed.value = v
  }
  get playing(): boolean {
    return this.s.playing.peek()
  }
  set playing(v: boolean) {
    this.s.playing.value = v
  }
  get tMax(): number {
    return this.s.tMax.peek()
  }
  set tMax(v: number) {
    this.s.tMax.value = v
  }
  get speeds(): readonly number[] {
    return this.s.speeds
  }

  play(): void {
    batch(() => {
      if (this.t >= this.tMax) this.t = 0
      this.playing = true
    })
  }
  pause(): void {
    this.playing = false
  }
  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }
  setSpeed(s: number): void {
    if (!this.speeds.includes(s)) throw new Error(`speed ${s} not in ${this.speeds}`)
    this.speed = s
  }
  seek(tMin: number): void {
    this.t = Math.min(this.tMax, Math.max(0, tMin))
  }

  /** Advance by a real-time step (ms). Returns true when t changed. Stops at the end. */
  tick(dtMs: number): boolean {
    if (!this.playing || dtMs <= 0) return false
    const before = this.t
    return batch(() => {
      this.t = Math.min(this.tMax, this.t + (dtMs / 60000) * this.speed)
      if (this.t >= this.tMax) this.playing = false
      return this.t !== before
    })
  }
}

/** A clock with its own state (one per view, the pre-store behaviour). */
export class PlaybackClock extends ClockDriver {
  constructor(tMax: number, speeds: readonly number[], defaultSpeed: number) {
    super(clockSignals(tMax, speeds, defaultSpeed))
  }
}

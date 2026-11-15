// Playback ticker of the timeline dock (DESIGN U5, D13): while the mission clock plays, advance it by
// real time × speed. Other views tick the same shared clock themselves (the HUD and the 3D view in
// their frame loops, the field driver with ?field=play); two tickers would run the clock at double
// speed. So the dock only ticks when nobody else does: if the clock moved since the dock's own last
// write, another ticker (or a seek) is active and the dock skips frames for a short grace period.
import type { ClockDriver } from '../../state/clock'

export interface TickerEnv {
  now: () => number
  raf: (cb: (now: number) => void) => number
  caf: (id: number) => void
}

/** A frame step longer than this (ms) is a hidden tab or a stall, not playback: it is dropped. */
const MAX_STEP_MS = 1000
/** After someone else moved the clock, the dock stays idle this long (ms). */
const YIELD_MS = 250

export class DockTicker {
  private raf = 0
  private last = 0
  private seen: number | null = null
  private idleUntil = 0
  /** true while the user drags the scrubber: no ticking under the pointer */
  scrubbing = false

  private readonly clock: ClockDriver
  private readonly env: TickerEnv

  constructor(clock: ClockDriver, env: TickerEnv) {
    this.clock = clock
    this.env = env
  }

  get running(): boolean {
    return this.raf !== 0
  }

  start(): void {
    if (this.raf) return
    this.last = this.env.now()
    this.seen = this.clock.t
    this.raf = this.env.raf(this.frame)
  }

  stop(): void {
    if (this.raf) this.env.caf(this.raf)
    this.raf = 0
  }

  /** One frame (exposed for tests). */
  readonly frame = (now: number): void => {
    const dt = now - this.last
    this.last = now
    const t = this.clock.t
    if (this.seen !== null && t !== this.seen) this.idleUntil = now + YIELD_MS
    if (!this.scrubbing && now >= this.idleUntil && dt > 0 && dt <= MAX_STEP_MS) this.clock.tick(dt)
    this.seen = this.clock.t
    if (!this.clock.playing) {
      this.raf = 0
      return
    }
    this.raf = this.env.raf(this.frame)
  }
}

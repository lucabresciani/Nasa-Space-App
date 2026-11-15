// Frame-rate meter for the spike: browser frames (requestAnimationFrame) over a sliding window.
// rAF fps drops whenever the main thread or the GPU cannot keep up, whatever the map is doing.

export interface FpsStats {
  fps: number
  /** 95th-percentile frame interval, ms */
  p95Ms: number
  /** worst frame interval in the window, ms */
  maxMs: number
}

export class FpsMeter {
  private times: number[] = []
  private readonly windowMs: number
  constructor(windowMs = 1000) {
    this.windowMs = windowMs
  }

  frame(nowMs: number): void {
    this.times.push(nowMs)
    const cut = nowMs - this.windowMs
    while (this.times.length > 2 && this.times[0] < cut) this.times.shift()
  }

  stats(): FpsStats {
    const t = this.times
    if (t.length < 2) return { fps: 0, p95Ms: 0, maxMs: 0 }
    const dts = t.slice(1).map((v, i) => v - t[i])
    const span = t[t.length - 1] - t[0]
    const sorted = [...dts].sort((a, b) => a - b)
    return {
      fps: span > 0 ? (dts.length * 1000) / span : 0,
      p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      maxMs: sorted[sorted.length - 1],
    }
  }
}

/** Counts events per second (map renders, field updates, uploads) over the same window. */
export class RateCounter {
  private times: number[] = []
  private readonly windowMs: number
  constructor(windowMs = 1000) {
    this.windowMs = windowMs
  }
  tick(nowMs: number): void {
    this.times.push(nowMs)
    this.trim(nowMs)
  }
  rate(nowMs: number): number {
    this.trim(nowMs)
    return (this.times.length * 1000) / this.windowMs
  }
  private trim(nowMs: number): void {
    const cut = nowMs - this.windowMs
    while (this.times.length && this.times[0] <= cut) this.times.shift()
  }
}

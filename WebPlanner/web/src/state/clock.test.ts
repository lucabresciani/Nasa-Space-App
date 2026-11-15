// WS15 task 3 (A3): the signal-backed clock replays the original PlaybackClock exactly, and the HUD
// numbers at each minute are identical whichever clock drives them.
import { describe, expect, it } from 'vitest'
import { PlaybackClock as HudPlaybackClock } from '../hud/clock'
import { Plan } from '../hud/plan'
import { computeReadout, playbackPosition, type HudContext } from '../hud/readout'
import { dummyGrid, loadConfig, readJson } from '../hud/testutil'
import type { PolygonFC, RouteFC, TimelineEvent } from '../hud/types'
import { ClockDriver, clockSignals, PlaybackClock } from './clock'
import { mission, missionClock } from './mission'

// ---- the original web/src/hud/clock.ts at origin/main b657dc7, verbatim (reference) ----
class LegacyPlaybackClock {
  t = 0
  speed: number
  playing = false
  readonly speeds: readonly number[]
  tMax: number

  constructor(tMax: number, speeds: readonly number[], defaultSpeed: number) {
    if (!speeds.includes(defaultSpeed)) throw new Error(`default speed ${defaultSpeed} not in ${speeds}`)
    this.tMax = tMax
    this.speeds = speeds
    this.speed = defaultSpeed
  }

  play(): void {
    if (this.t >= this.tMax) this.t = 0
    this.playing = true
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
    this.t = Math.min(this.tMax, this.t + (dtMs / 60000) * this.speed)
    if (this.t >= this.tMax) this.playing = false
    return this.t !== before
  }
}
// ---- end of reference ----

type Clockish = { t: number; speed: number; playing: boolean; tMax: number; play(): void; pause(): void; toggle(): void; setSpeed(s: number): void; seek(t: number): void; tick(dt: number): boolean }

// a fixed time source: rAF-like frame steps (ms) with jitter, and user actions between frames
const FRAMES = [16.7, 16.6, 17.1, 33.4, 0, -3, 16.7, 250, 16.6, 1000, 16.7, 5000]
type Op = ['tick', number] | ['play'] | ['pause'] | ['toggle'] | ['speed', number] | ['seek', number]
const SCRIPT: Op[] = [
  ['tick', 16.7], ['play'], ...FRAMES.map((f) => ['tick', f] as Op), ['speed', 300], ...FRAMES.map((f) => ['tick', f] as Op),
  ['pause'], ['tick', 1000], ['seek', 123.456], ['toggle'], ['speed', 1], ['tick', 60000], ['speed', 30], ['tick', 777],
  ['seek', -5], ['seek', 9999], ['play'], ['tick', 16.7], ['speed', 300], ['seek', 389.9], ['play'], ['tick', 1000], ['tick', 1000], ['toggle'], ['tick', 16.7],
]
function replay(c: Clockish): { t: number; speed: number; playing: boolean; changed: boolean | null }[] {
  return SCRIPT.map((op) => {
    let changed: boolean | null = null
    if (op[0] === 'tick') changed = c.tick(op[1])
    else if (op[0] === 'play') c.play()
    else if (op[0] === 'pause') c.pause()
    else if (op[0] === 'toggle') c.toggle()
    else if (op[0] === 'speed') c.setSpeed(op[1])
    else c.seek(op[1])
    return { t: c.t, speed: c.speed, playing: c.playing, changed }
  })
}

const cfg = loadConfig()

describe('clock on signals = the original PlaybackClock', () => {
  it('same minute sequence for play / pause / seek / speed under a fixed time source', () => {
    const ref = replay(new LegacyPlaybackClock(cfg.evaMin, cfg.playbackSpeeds, cfg.defaultSpeed))
    expect(replay(new PlaybackClock(cfg.evaMin, cfg.playbackSpeeds, cfg.defaultSpeed))).toEqual(ref)
    expect(replay(new ClockDriver(clockSignals(cfg.evaMin, cfg.playbackSpeeds, cfg.defaultSpeed)))).toEqual(ref)
    expect(ref.some((r) => r.playing)).toBe(true)
    expect(ref.some((r) => r.t === cfg.evaMin && !r.playing)).toBe(true) // reached the end and stopped
    expect(ref.at(-1)!.t).toBeLessThan(1) // play() at the end restarts from 0
  })
  it('same errors', () => {
    expect(() => new PlaybackClock(10, [1, 60], 7)).toThrow('default speed 7 not in 1,60')
    expect(() => new PlaybackClock(10, [1, 60], 60).setSpeed(7)).toThrow('speed 7 not in 1,60')
  })
  it('hud/clock.ts still exports the same class (the HUD, the spike and tests import it there)', () => {
    expect(HudPlaybackClock).toBe(PlaybackClock)
  })
  it('a private clock keeps its own state', () => {
    const a = new PlaybackClock(10, [60], 60)
    const b = new PlaybackClock(10, [60], 60)
    a.seek(5)
    expect(b.t).toBe(0)
  })
})

describe('the shared mission clock', () => {
  it('starts exactly like the HUD clock did (config/hud.yaml, crew.yaml; D13)', () => {
    const fresh = new LegacyPlaybackClock(cfg.evaMin, cfg.playbackSpeeds, cfg.defaultSpeed)
    expect({ t: missionClock.t, speed: missionClock.speed, playing: missionClock.playing, tMax: missionClock.tMax, speeds: missionClock.speeds }).toEqual({
      t: fresh.t, speed: fresh.speed, playing: fresh.playing, tMax: fresh.tMax, speeds: fresh.speeds,
    })
    expect(missionClock.speed).toBe(60)
    expect(mission.budgets.evaMin).toBe(mission.clock.tMax) // one signal for the EVA length
  })
  it('survives a remount: a second driver (next mount) sees the same minute, speed and play state', () => {
    const first = new ClockDriver(mission.clock)
    first.setSpeed(300)
    first.play()
    first.tick(1000)
    const second = new ClockDriver(mission.clock)
    expect(second.t).toBe(5)
    expect(second.playing).toBe(true)
    expect(second.speed).toBe(300)
    second.pause()
    second.seek(0)
    second.setSpeed(cfg.defaultSpeed)
    expect(missionClock.t).toBe(0)
  })
  it('notifies subscribers of the minute', () => {
    const seen: number[] = []
    const off = mission.clock.t.subscribe((v) => seen.push(v))
    missionClock.seek(12)
    missionClock.seek(12)
    missionClock.seek(0)
    off()
    expect(seen).toEqual([12, 0])
  })
})

describe('HUD numbers at the same minute: legacy clock vs mission clock', () => {
  const route = readJson<RouteFC>('route_nom_104.geojson')
  const timeline = readJson<TimelineEvent[]>('timeline_nom_104.json')
  const tHome = dummyGrid('nom_104/t_home')
  const fields = {
    tHome,
    tHomeCons: dummyGrid('con_104/t_home'),
    o2Home: dummyGrid('nom_104/o2_home'),
    homeBearing: dummyGrid('nom_104/home_bearing'),
    slope: dummyGrid('slope'),
    worst: new Map(cfg.worstCaseRadiiM.map((r) => [r, { tHome: dummyGrid(`nom_104/t_home_worst_${r}`), o2Home: dummyGrid(`nom_104/o2_home_worst_${r}`) }])),
  }
  const plan = new Plan(route, timeline, tHome)
  const ctx: HudContext = { cfg, fields, plan, budgetMin: cfg.walkbackBudgetsMin[0], pad: plan.start, partner: readJson<PolygonFC>('scenarios/nom_104/partner.geojson') }
  const frame = (t: number) => {
    const pos = playbackPosition(plan, t)
    return { label: t.toFixed(1), state: plan.stateAt(t), pos, readout: computeReadout(pos, ctx) }
  }
  it('every frame of the script renders the same readout', () => {
    const legacy = new LegacyPlaybackClock(cfg.evaMin, cfg.playbackSpeeds, cfg.defaultSpeed)
    missionClock.seek(0)
    const a = replay(legacy).map((r) => frame(r.t))
    const b = replay(missionClock).map((r) => frame(r.t))
    expect(b).toEqual(a)
    missionClock.pause()
    missionClock.seek(0)
    missionClock.setSpeed(cfg.defaultSpeed)
  })
})

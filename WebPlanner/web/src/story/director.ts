// WS16 task 10 (M10): the director (DESIGN U6, §6.3). A pure function of storyboard time: stateAt(t)
// gives the whole picture (camera, layers, field mode / variant / collapse, clock, selection, caption,
// UI visibility) at t seconds, with no wall clock and no hidden state. Capture mode calls it at
// t = frame / fps (a fixed frame step), so two runs give the same state sequence; live playback calls
// it with the elapsed time of its own rAF loop.
//
// Rules:
// - Camera keyframes are reached at their t; between two keyframes the camera eases (ease-in-out:
//   target lon/lat linear, height in log space, bearing along the shorter arc, pitch linear). Missing
//   alt/bearing/pitch keep the previous keyframe's. Before the first keyframe: the first; after the
//   last: the last. Reduced motion: cuts (the latest keyframe at or before t, no in-between).
// - Target codes resolve through `targets` (labels.json); FOLLOW_TARGET ("CREW") is the flythrough
//   follow camera at the storyboard clock (`follow`).
// - field.collapse eases from the value in force over duration_s (default collapse.duration_s,
//   0 = jump; no value in force = jump). Reduced motion: the M4 cross-fade (collapseFrame).
// - clock: t_min sets the EVA minute, playing/speed run it on (speed = simulated minutes per second),
//   clamped to [0, tMax]; the value in force carries over when t_min is absent.
// - layers accumulate; selection, caption and ui are the latest given (with the time they were set).
import { collapseFrame, easeInOut, type CollapseFrame } from '../map/field/collapseMath'
import type { LonLat } from '../hud/types'
import type { CameraPose } from '../map/flythrough/path'
import { angleDiff } from '../map/flythrough/path'
import { COLLAPSE_S } from './config'
import { FOLLOW_TARGET, type StoryCamera, type Storyboard } from './storyboard'

export interface ClockState {
  tMin: number
  playing: boolean
  /** simulated minutes per real second */
  speed: number
}

export interface DirectorState {
  /** storyboard seconds */
  t: number
  camera: CameraPose | null
  layers: Record<string, boolean>
  field: { mode?: 'bands' | 'margin'; variant?: 'opt' | 'nom' | 'con'; collapse?: CollapseFrame }
  clock: ClockState | null
  /** undefined = the storyboard never touches the selection */
  selection: string | null | undefined
  /** copy.json key; null/undefined = none */
  caption: string | null | undefined
  /** seconds since the caption was set (fades) */
  captionAge: number
  ui: 'hide' | 'reveal' | undefined
  uiAge: number
  done: boolean
}

export interface DirectorOptions {
  /** label code -> lon/lat (labels.json) */
  targets: (code: string) => LonLat | null
  /** follow-camera pose at an EVA minute (the flythrough); null when there is no route */
  follow?: (tMin: number) => CameraPose | null
  /** EVA clock length (min) */
  tMax: number
  reduced: boolean
  /** default camera height (m) when the first keyframe gives none */
  defaultAltM?: number
}

/** Sentinel for "no camera keyframe resolved". */
const DEFAULT_ALT_M = 4000

type PoseFn = (clock: ClockState | null) => CameraPose | null

export class Director {
  readonly sb: Storyboard
  readonly duration: number
  private readonly o: DirectorOptions
  private readonly keys: { t: number; pose: PoseFn }[] = []

  constructor(sb: Storyboard, o: DirectorOptions) {
    this.sb = sb
    this.o = o
    let end = 0
    for (const s of sb.steps) {
      end = Math.max(end, s.t)
      if (s.field && (s.field.collapse !== undefined || s.field.duration_s !== undefined)) end = Math.max(end, s.t + (s.field.duration_s ?? COLLAPSE_S))
    }
    this.duration = end
    // camera keyframes: fill alt/bearing/pitch from the previous keyframe
    let prev: Required<Pick<StoryCamera, 'alt_m' | 'bearing' | 'pitch'>> = { alt_m: o.defaultAltM ?? DEFAULT_ALT_M, bearing: 0, pitch: 0 }
    for (const s of sb.steps) {
      if (!s.camera) continue
      const c = s.camera
      const filled = { alt_m: c.alt_m ?? prev.alt_m, bearing: c.bearing ?? prev.bearing, pitch: c.pitch ?? prev.pitch }
      prev = filled
      this.keys.push({ t: s.t, pose: this.poseFn(c, filled) })
    }
  }

  private poseFn(c: StoryCamera, f: { alt_m: number; bearing: number; pitch: number }): PoseFn {
    if (c.target === FOLLOW_TARGET) {
      return (clock) => (clock && this.o.follow ? this.o.follow(clock.tMin) : null)
    }
    const at: LonLat | null = c.target !== undefined ? this.o.targets(c.target) : [c.lon as number, c.lat as number]
    if (!at) throw new Error(`storyboard ${this.sb.id}: unknown camera target "${c.target}"`)
    const pose: CameraPose = { target: at, altM: f.alt_m, bearing: f.bearing, pitch: f.pitch }
    return () => pose
  }

  /** Number of frames at the storyboard's fixed step (frame n is at t = n / fps). */
  get frames(): number {
    return Math.floor(this.duration * this.sb.fps + 1e-9) + 1
  }

  frameTime(n: number): number {
    return n / this.sb.fps
  }

  stateAtFrame(n: number): DirectorState {
    return this.stateAt(this.frameTime(n))
  }

  stateAt(t: number): DirectorState {
    const steps = this.sb.steps
    const layers: Record<string, boolean> = {}
    let mode: 'bands' | 'margin' | undefined
    let variant: 'opt' | 'nom' | 'con' | undefined
    let seg: { from: number; to: number; t0: number; dur: number } | undefined
    const frameOf = (g: NonNullable<typeof seg>, now: number): CollapseFrame => collapseFrame((now - g.t0) * 1000, g.dur * 1000, this.o.reduced, g.from, g.to)
    let clock: ClockState | null = null
    let clockAt = 0
    let selection: string | null | undefined
    let caption: string | null | undefined
    let captionAt = 0
    let uiv: 'hide' | 'reveal' | undefined
    let uiAt = 0
    const clockNow = (c: ClockState, since: number, now: number): ClockState => ({
      ...c,
      tMin: Math.min(this.o.tMax, Math.max(0, c.tMin + (c.playing ? c.speed * (now - since) : 0))),
    })
    for (const s of steps) {
      if (s.t > t) break
      if (s.layers) Object.assign(layers, s.layers)
      if (s.field) {
        if (s.field.mode) mode = s.field.mode
        if (s.field.variant) variant = s.field.variant
        if (s.field.collapse !== undefined) {
          const to = s.field.collapse
          const from = seg ? frameOf(seg, s.t).k : undefined
          seg = { from: from ?? to, to, t0: s.t, dur: from === undefined ? 0 : (s.field.duration_s ?? COLLAPSE_S) }
        }
      }
      if (s.clock) {
        const cur: ClockState = clock ? clockNow(clock, clockAt, s.t) : { tMin: 0, playing: false, speed: 1 }
        clock = { tMin: s.clock.t_min ?? cur.tMin, playing: s.clock.playing ?? cur.playing, speed: s.clock.speed ?? cur.speed }
        clockAt = s.t
      }
      if (s.selection !== undefined) selection = s.selection
      if (s.caption !== undefined) {
        caption = s.caption
        captionAt = s.t
      }
      if (s.ui !== undefined) {
        uiv = s.ui
        uiAt = s.t
      }
    }
    const clk = clock ? clockNow(clock, clockAt, t) : null
    const collapse = seg ? frameOf(seg, t) : undefined
    return {
      t,
      camera: this.cameraAt(t, clk),
      layers,
      field: { ...(mode ? { mode } : {}), ...(variant ? { variant } : {}), ...(collapse ? { collapse } : {}) },
      clock: clk,
      selection,
      caption,
      captionAge: t - captionAt,
      ui: uiv,
      uiAge: t - uiAt,
      done: t >= this.duration,
    }
  }

  private cameraAt(t: number, clock: ClockState | null): CameraPose | null {
    const K = this.keys
    if (!K.length) return null
    let i = -1
    for (let j = 0; j < K.length; j++) if (K[j].t <= t) i = j
    if (i < 0) return K[0].pose(clock)
    const a = K[i]
    const b = K[i + 1]
    if (!b || this.o.reduced) return a.pose(clock)
    const span = b.t - a.t
    const pa = a.pose(clock)
    const pb = b.pose(clock)
    if (!pa || !pb || !(span > 0)) return pb ?? pa
    return lerpPose(pa, pb, easeInOut((t - a.t) / span))
  }
}

/** Eased in-between of two camera poses (e = eased fraction 0..1). */
export function lerpPose(a: CameraPose, b: CameraPose, e: number): CameraPose {
  if (e <= 0) return a
  if (e >= 1) return b
  const lin = (x: number, y: number): number => x + (y - x) * e
  return {
    target: [lin(a.target[0], b.target[0]), lin(a.target[1], b.target[1])],
    altM: Math.exp(lin(Math.log(a.altM), Math.log(b.altM))),
    bearing: (((a.bearing + angleDiff(a.bearing, b.bearing) * e) % 360) + 360) % 360,
    pitch: lin(a.pitch, b.pitch),
  }
}

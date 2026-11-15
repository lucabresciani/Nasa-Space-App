// WS16 task 5 (M5): the thread home (DESIGN U4), pure part.
//
// A thin line from a point (cursor, dragged marker, crew position in playback) to the rover pad
// along the best way back. The path is WS7's pointer follower over WS2's pointer field
// (hud/wayhome.ts PointerField.pathFrom): the browser follows the published next-move per 3 m
// cell, it never routes. Every number on the thread (time home, margin, binding, colour) comes from
// fieldAt at the start point; nothing is re-derived here.
//
//   threadPath(lon, lat, t)   -> ThreadPath | null   (WS17 3D reuses this; same path, same numbers)
//   threadPathWith(src, ...)  -> the same on explicit inputs (tests, a second map)
import type { PointerField } from '../hud/wayhome'
import type { LonLat } from '../hud/types'
import { mission } from '../state'
import { fieldAt, marginClass, type Binding, type FieldSample, type Variant } from './field'
import { TOKENS } from '../ui/tokens'
import { bindingText, COPY_PENDING, fill, fmt1, t as copy, THREAD } from './furniture/text'

export type ThreadClass = 'safe' | 'caution' | 'limit' | 'none'

export interface ThreadPath {
  /** EVA minute the thread was computed for (the margin belongs to this minute). */
  t: number
  /** Start (the point itself), then the centre of every pointer cell, ending on the pad. */
  coords: LonLat[]
  /** Variant of the plan (= the pointer field's scenario variant and fieldAt's variant). */
  variant: Variant
  /** T_home at the start, min: fieldAt(start).tHome[variant] (nearest pixel = the published value). */
  tHomeMin: number
  /** Margin at the start, min (fieldAt, at the mission clock); null outside margin mode or when t is not the clock minute. */
  margin: number | null
  binding: Binding | null
  /** Colour class = the margin at its start (green / orange / red); none = no margin known. */
  cls: ThreadClass
}

/** What threadPathWith needs: the plan's pointer field and pad, fieldAt, the clock minute. */
export interface ThreadSources {
  pointer: PointerField
  pad: LonLat
  /** fieldAt (or FieldData.at) for the plan's field. */
  sample: (lon: number, lat: number) => FieldSample | null
  /** The minute fieldAt's margin belongs to (the mission clock). */
  clockT: () => number
}

/**
 * The thread from (lon, lat) at EVA minute t. null when there is no way home to draw: outside the
 * pointer grid, on unknown or blocked terrain, where fieldAt has no T_home, or where the follower
 * does not end on the pad.
 */
export function threadPathWith(src: ThreadSources, lon: number, lat: number, t: number): ThreadPath | null {
  const s = src.sample(lon, lat)
  if (!s || !s.inside || s.unknown || s.state === 'blocked') return null
  const tHome = s.tHome[s.variant]
  if (tHome === null) return null
  const w = src.pointer.pathFrom(lon, lat, src.pad)
  if (!w || !w.startKnown || !w.reachesPad || w.coords.length < 2) return null
  // point -> centre of its own 3 m cell first: the follower's moves run centre to centre (they
  // never cut a blocked cell), and a straight line from an off-centre point could clip one.
  const [r0, c0] = w.pixels[0]
  const centre = src.pointer.grid.lonLatOf(r0, c0)
  const coords: LonLat[] = centre[0] === lon && centre[1] === lat ? w.coords : [w.coords[0], centre, ...w.coords.slice(1)]
  const sameMinute = Math.abs(t - src.clockT()) < 1e-9
  const margin = sameMinute ? s.margin : null
  const binding = sameMinute ? s.binding : null
  return {
    t,
    coords,
    variant: s.variant,
    tHomeMin: tHome,
    margin,
    binding,
    cls: margin === null ? 'none' : marginClass(margin),
  }
}

// ---- the active sources (set by the planning map's thread layer once the pointer is loaded) ----
let active: { pointer: PointerField; pad: LonLat } | null = null

export function setThreadSources(s: { pointer: PointerField; pad: LonLat } | null): void {
  active = s
}

/**
 * threadPath(lon, lat, t): the thread home from (lon, lat) at EVA minute t, on the plan the
 * planning map shows (its pointer field, pad and fieldAt). For WS17 (3D): call it with the crew
 * position and the mission clock minute; the margin is fieldAt's, which is at the mission clock, so
 * for any other t the margin is null. null before the map has loaded the pointer field.
 */
export function threadPath(lon: number, lat: number, t: number): ThreadPath | null {
  if (!active) return null
  return threadPathWith({ ...active, sample: fieldAt, clockT: () => mission.clock.t.peek() }, lon, lat, t)
}

/** Line colour of a thread class (DESIGN §3.1: green / orange / red; no margin -> text colour). */
export function threadColor(cls: ThreadClass): string {
  const c = TOKENS.color
  return cls === 'safe' ? c.safe : cls === 'caution' ? c.caution : cls === 'limit' ? c.limit : c.text
}

/** Tooltip, config template "Home in {t_home} min · margin {margin} min ({binding})", fieldAt values only. */
export function threadTooltip(p: ThreadPath | null): string {
  if (!p) return copy('tooltips.threadUnknown')
  if (p.margin === null || p.binding === null) return fill(COPY_PENDING.threadNoMargin, { t_home: fmt1(p.tHomeMin) })
  return fill(THREAD.tooltip, { t_home: fmt1(p.tHomeMin), margin: fmt1(p.margin), binding: bindingText(p.binding) })
}

/**
 * Dash flow toward the rover (the library has no dash-offset animation): `steps` dash patterns,
 * each the base pattern [dash, gap] moved `step / steps` of a period forward along the line (the
 * line runs start -> pad, so forward = toward the rover). Lengths in line widths; every pattern
 * sums to one period, so stepping through them reads as continuous motion.
 */
export function dashPattern(step: number, steps: number = THREAD.dashSteps, dash = 2, gap = 2): number[] {
  const period = dash + gap
  const o = (((step % steps) + steps) % steps) * (period / steps)
  if (o <= gap) return [0, o, dash, gap - o]
  return [o - gap, gap, dash - (o - gap), 0]
}

/** Interval between thread recomputations (config thread.update_hz). */
export const THREAD_INTERVAL_MS = 1000 / THREAD.updateHz

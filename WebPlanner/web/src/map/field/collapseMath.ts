// WS16 task 4 (M4): pure math of the collapse (DESIGN U3; contracts/field_shader.md §3.1). No state,
// no DOM: decode.ts (fieldAt), the layer and the tests share it. The shader mirrors it per pixel.
//   T(x) = mix(d(x) / u_flatSpeed / 60, T_home(x), k), d = distance from the pad in grid metres.
import { TOKENS } from '../../ui/tokens'
import { COLLAPSE, FIELD_LAYER, type Variant } from './constants'
import type { BandClass, Bounds } from './decode'

/** Continuous pixel coordinates (decode.ts gridXY, repeated here so this module has no runtime import of decode.ts). */
function gridXY(g: { width: number; height: number; bounds: Bounds }, lon: number, lat: number): [number, number] {
  const [w, s, e, n] = g.bounds
  return [((lon - w) / (e - w)) * g.width, ((n - lat) / (n - s)) * g.height]
}

// ---- easing (DESIGN §3.4 "ease-in-out" = the CSS keyword: cubic-bezier(0.42, 0, 0.58, 1)) -------
export const EASE_IN_OUT: readonly [number, number, number, number] = [0.42, 0, 0.58, 1]

/** CSS cubic-bezier timing function: x (time) -> y (progress). Deterministic (fixed bisection). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const bx = (t: number): number => ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t * t + 3 * x1 * t
  const by = (t: number): number => ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t * t + 3 * y1 * t
  return (x: number): number => {
    if (!(x > 0)) return 0
    if (x >= 1) return 1
    let lo = 0
    let hi = 1
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (bx(mid) < x) lo = mid
      else hi = mid
    }
    return by((lo + hi) / 2)
  }
}
export const easeInOut = cubicBezier(...EASE_IN_OUT)

/** Collapse duration (ms): tokens motion.collapseMs (= config/design.yaml collapse.duration_s x 1000). */
export const COLLAPSE_MS: number = TOKENS.motion.collapseMs
if (COLLAPSE_MS !== COLLAPSE.durationS * 1000) throw new Error('tokens motion.collapseMs != design.yaml collapse.duration_s')

// ---- the blended threshold field (contract §3.1) ---------------------------------------------------
/** Flat walk time (min) of a distance (m) at the D25 flat speed. */
export function flatMinutes(distM: number, speedMs: number = FIELD_LAYER.flatSpeedMs): number {
  return distM / speedMs / 60
}

/** D25 flat-circle radius (m) of a budget (min): config value, = flat speed x budget. */
export function flatRadiusM(budgetMin: number): number {
  const r = FIELD_LAYER.flatRadiusM[budgetMin]
  return r ?? FIELD_LAYER.flatSpeedMs * budgetMin * 60
}

/**
 * T(x) for one variant: mix(flat, T_home, k). Exact at the ends: k <= 0 -> flat, k >= 1 -> T_home
 * (the M2 value, bit for bit; GLSL mix could round). T_home without a value (no route home) counts
 * as infinite time: mix(flat, inf, k) regularised to flat / (1 - k), so those cells leave the flat
 * disc smoothly from the rim inwards and are gone (null) at k = 1.
 */
export function collapseT(flat: number, tHome: number | null, k: number): number | null {
  if (k >= 1) return tHome
  if (k <= 0) return flat
  if (tHome === null) return flat / (1 - k)
  return flat + (tHome - flat) * k
}

/** Pad position in field-grid metres (x east of the west edge, y south of the north edge): u_pad. */
export function padGridMetres(g: { width: number; height: number; bounds: Bounds }, resM: number, lon: number, lat: number): [number, number] {
  const [x, y] = gridXY(g, lon, lat)
  return [x * resM, y * resM]
}

/** Distance (grid metres) from the pad, as the shader computes it: length(uv * size * cell - pad). */
export function padDistance(g: { width: number; height: number; bounds: Bounds }, resM: number, pad: [number, number], lon: number, lat: number): number {
  const [x, y] = gridXY(g, lon, lat)
  return Math.hypot(x * resM - pad[0], y * resM - pad[1])
}

export interface CollapseGeom {
  /** u_pad, grid metres */
  pad: [number, number]
  /** u_cell, fields/index.json res_m */
  resM: number
}

/**
 * Bands-mode class during the collapse (the shader's order). k >= 1: exactly M2 `bandClass`.
 * k < 1: every pixel inside the field grid is in NASA's flat world (no terrain), so unknown terrain
 * is classed from the flat time too; its hatch fades in with k (`hatchWeight`).
 */
export function collapseBandClass(drawn: Record<Variant, number | null>, flat: number, terrainUnknown: boolean, budget: number, k: number): BandClass {
  if (k >= 1 && terrainUnknown) return 'unknown'
  for (const v of ['con', 'nom', 'opt'] as const) {
    const t = collapseT(flat, drawn[v], k)
    if (t !== null && t <= budget) return v
  }
  return 'none'
}

/** Opacity of the unknown-terrain hatch during the collapse: fades in with k (DESIGN U3). */
export function hatchWeight(k: number): number {
  return Math.min(1, Math.max(0, k))
}

// ---- animation state ------------------------------------------------------------------------------
/** One picture of the collapse: the shader draws mix(picture(kFrom), picture(k), xfade). */
export interface CollapseFrame {
  k: number
  kFrom: number
  xfade: number
}

/**
 * The frame at `elapsedMs` of an animation from `from` to `to`. Normal: k eases from -> to, xfade 1.
 * Reduced motion (DESIGN §3.4 "the collapse cross-fades"): k is `to` from the first frame and the
 * picture of `from` cross-fades out; no intermediate k is ever drawn.
 */
export function collapseFrame(elapsedMs: number, durationMs: number, reduced: boolean, from = 0, to = 1): CollapseFrame {
  const p = durationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / durationMs)) : 1
  const e = easeInOut(p)
  if (reduced) return p >= 1 ? { k: to, kFrom: to, xfade: 1 } : { k: to, kFrom: from, xfade: e }
  return { k: p >= 1 ? to : from + (to - from) * e, kFrom: to, xfade: 1 }
}

// CPU mirror of the spike's field shader (shader.ts). Same decode, same manual bilinear, same
// classification, so the GLSL can be checked against known pixels of the real field PNGs.
// Encoding (contracts/README.md "Field PNGs"): counts = R*256 + G, A = 0 unknown, value = counts * scale.

/** One texel: null = unknown (A = 0). */
export function decodeTexel(r: number, g: number, a: number, scale: number): number | null {
  if (a === 0) return null
  return (r * 256 + g) * scale
}

/** What the shader does with a normalised RGBA8 channel: back to the exact byte. */
export function byteOfNormalized(x: number): number {
  return Math.floor(x * 255 + 0.5)
}

export interface RgbaField {
  rgba: ArrayLike<number>
  width: number
  height: number
  scale: number
}

/** Texel (col, row), clamped to the grid edge like the shader's clamp(). */
export function texel(f: RgbaField, col: number, row: number): number | null {
  const c = Math.min(f.width - 1, Math.max(0, col))
  const r = Math.min(f.height - 1, Math.max(0, row))
  const j = (r * f.width + c) * 4
  return decodeTexel(f.rgba[j], f.rgba[j + 1], f.rgba[j + 3], f.scale)
}

/**
 * Manual bilinear at grid uv (0..1, v = 0 north; pixel centres at (i + 0.5) / size), as in the
 * shader: decode the four neighbours first, interpolate decoded values; any unknown -> unknown.
 */
export function sampleBilinear(f: RgbaField, u: number, v: number): number | null {
  const px = u * f.width - 0.5
  const py = v * f.height - 0.5
  const c0 = Math.floor(px)
  const r0 = Math.floor(py)
  const fx = px - c0
  const fy = py - r0
  const a = texel(f, c0, r0)
  const b = texel(f, c0 + 1, r0)
  const c = texel(f, c0, r0 + 1)
  const d = texel(f, c0 + 1, r0 + 1)
  if (a === null || b === null || c === null || d === null) return null
  const top = a + (b - a) * fx
  const bot = c + (d - c) * fx
  return top + (bot - top) * fy
}

export type FieldMode = 'bands' | 'margin'
/** Colour classes; tokens: safe / caution / limit; `none` = transparent; `unknown` = grey hatch. */
export type FieldClass = 'safe' | 'caution' | 'limit' | 'none' | 'unknown'

/** Spike margin (simple version): EVA-duration term only, m = T_EVA - t - T_home (DESIGN U2). */
export function simpleMargin(tHome: number, tMin: number, tEvaMin: number): number {
  return tEvaMin - tMin - tHome
}

export interface ClassifyInput {
  mode: FieldMode
  tHome: number | null // decoded (bilinear) T_home, min; null = no value
  terrainUnknown: boolean // the hatch source says "no terrain data"
  budget: number // 30 | 60
  tMin: number // EVA clock
  tEvaMin: number
  amberMin: number
}

/**
 * Per-pixel class, identical to the shader's branch order. Unknown terrain is always `unknown`
 * (hatch, never a warning colour). Known terrain without a T_home value (blocked or unreached) is
 * `none`: not coloured and not hatched.
 */
export function classify(p: ClassifyInput): FieldClass {
  if (p.terrainUnknown) return 'unknown'
  if (p.tHome === null) return 'none'
  if (p.mode === 'bands') return p.tHome <= p.budget ? 'safe' : 'none'
  const m = simpleMargin(p.tHome, p.tMin, p.tEvaMin)
  if (m < 0) return 'limit'
  if (m < p.amberMin) return 'caution'
  return 'safe'
}

/** '#RRGGBB' -> [r, g, b] in 0..1 (token colours to shader uniforms). */
export function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`)
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Field-grid uv -> uv on another grid (e.g. the 3 m cell-state grid): [offU, offV, scaleU, scaleV]. */
export function gridXform(from: [number, number, number, number], to: [number, number, number, number]): [number, number, number, number] {
  const [fw, fs, fe, fn] = from
  const [tw, ts, te, tn] = to
  return [(fw - tw) / (te - tw), (tn - fn) / (tn - ts), (fe - fw) / (te - tw), (fn - fs) / (tn - ts)]
}

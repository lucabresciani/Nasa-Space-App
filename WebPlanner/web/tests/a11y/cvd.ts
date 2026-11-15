// Colour-vision deficiency simulation and colour difference (DESIGN §9 "Colour vision"; package Q1).
// Simulation: Machado, Oliveira & Fernandes (2009), "A physiologically-based model for simulation of
// color vision deficiency", IEEE TVCG 15(6), severity 1.0 matrices, applied in linear sRGB (the same
// model as Chromium DevTools' "Emulate vision deficiencies" and colorspacious). Difference: CIEDE2000
// (ΔE00) in CIELAB, D65 white. No dependency: about 100 lines of arithmetic.

export type Vision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia'
type M3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]]
type V3 = [number, number, number]

/** Machado et al. 2009, Table "severity 1.0" (linear RGB → linear RGB). */
export const MACHADO: Record<Exclude<Vision, 'normal'>, M3> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/** #RRGGBB → linear sRGB in 0..1. */
export function hexToLinear(hex: string): V3 {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`cvd: not a #RRGGBB colour: ${hex}`)
  return [m[1], m[2], m[3]].map((h) => toLinear(parseInt(h, 16) / 255)) as V3
}

/** Simulated linear sRGB for a vision type (clamped to the displayable gamut). */
export function simulate(hex: string, vision: Vision): V3 {
  const c = hexToLinear(hex)
  if (vision === 'normal') return c
  const m = MACHADO[vision]
  return m.map((row) => clamp01(row[0] * c[0] + row[1] * c[1] + row[2] * c[2])) as V3
}

/** Linear sRGB → CIELAB (D65). */
export function linearToLab([r, g, b]: V3): V3 {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIEDE2000 colour difference (Sharma, Wu & Dalal 2005 implementation notes). */
export function deltaE2000(lab1: V3, lab2: V3): number {
  const [L1, a1, b1] = lab1
  const [L2, a2, b2] = lab2
  const rad = Math.PI / 180
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const hp = (a: number, b: number) => (a === 0 && b === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360)
  const h1p = hp(a1p, b1)
  const h2p = hp(a2p, b2)
  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad)
  const Lbp = (L1 + L2) / 2
  const Cbp = (C1p + C2p) / 2
  let hbp = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2
    else hbp = (h1p + h2p) / 2
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2)
  const Sc = 1 + 0.045 * Cbp
  const Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(2 * dTheta * rad) * Rc
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}

/** ΔE00 between two colours as seen with the given vision. */
export function simulatedDeltaE(a: string, b: string, vision: Vision): number {
  return deltaE2000(linearToLab(simulate(a, vision)), linearToLab(simulate(b, vision)))
}

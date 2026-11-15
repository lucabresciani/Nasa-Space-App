// Topography and material-composition rasters for the Mission Planer "Maps" switcher, ported from
// the team's Unity map (Nasa-Space-App, Assets/Mars/Scripts/HUD/MarsElevationMap.cs and MapView.cs
// MapPalette, commit e5a40ad) so both apps draw the same map:
//   topo:     muted ochre hypsometric tint (min..max of the grid) x soft multi-directional hillshade,
//             contour lines (interval from the median slope, index contour every 5th);
//   material: the same hillshade on neutral grey, tinted by the geologic unit of Mount Sharp's
//             flat-lying layers inferred from elevation (mountSharpUnits.json: Curiosity sample
//             elevations; band rule in that file). Not a mineral survey.
// Pure functions on a row-major elevation grid (row 0 north, square cells of mpp metres).
import unitsFile from './mountSharpUnits.json'

export const UNITS_FILE = unitsFile as {
  source: string
  rule: string
  band_margin_m: number
  band_falloff_m: number
  min_fade: number
  classes: { id: string; name: string; unitSymbol: string | null; abundance: number; setting: string | null; summary?: string }[]
  samples: { classId: string; target: string; instrument: string | null; sol: number | null; elevationM: number | null; useAsAnalog: boolean; citation: string | null }[]
}

// ---------------------------------------------------------------- Unity constants (MarsElevationMap)
const INTERVALS = [5, 10, 20, 50, 100, 200, 500]
const INDEX_EVERY = 5
const MIN_CONTOUR_SPACING_CELLS = 6
const SHADE_EXAGGERATION = 1.25
const SHADE_STRENGTH = 0.9
const MINOR_STRENGTH = 0.22
const INDEX_STRENGTH = 0.5
export const BASE_GREY = 70
export const RAMP: { t: number; rgb: [number, number, number] }[] = [
  { t: 0, rgb: [30, 25, 22] },
  { t: 0.3, rgb: [52, 40, 31] },
  { t: 0.65, rgb: [78, 60, 44] },
  { t: 1, rgb: [106, 90, 72] },
]
const CONTOUR_RGB: [number, number, number] = [226, 214, 196]
const LIGHT_AZ_DEG = [315, 270, 0]
const LIGHT_W = [0.5, 0.25, 0.25]
const LIGHT_ALT_DEG = 45
/** Unity MapPalette.UnitOverlayAlpha (perceptual; blended in sRGB here) */
export const UNIT_OVERLAY_ALPHA = 0.5

/** Unity MapPalette.ClassColor and ClassLabel. */
const CLASS_STYLE: Record<string, { hex: number; label: string }> = {
  'murray-mudstone': { hex: 0x8fa6bf, label: 'Mm mudstone' },
  'vera-rubin-ridge': { hex: 0xb8705e, label: 'Mvr hematite' },
  'glen-torridon-clay': { hex: 0x5e93d9, label: 'Cs clay' },
  'mirador-sulfate': { hex: 0xb394e6, label: 'Msu sulfate' },
  'amapari-iron': { hex: 0xe07fb8, label: 'Ma Fe bed' },
  'stimson-sandstone': { hex: 0xd9b77e, label: 'Ss sandstone' },
  'silica-alteration': { hex: 0xa6e0c8, label: 'Si silica' },
  'iron-meteorite': { hex: 0x9da3aa, label: 'Fe meteorite' },
}
const FALLBACK_HEX = [0x8fbf6a, 0xd9906a, 0xa0a0e0, 0xc0c070]

function classStyle(id: string, unitSymbol: string | null): { rgb: [number, number, number]; label: string } {
  let hex = CLASS_STYLE[id]?.hex
  if (hex === undefined) {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0
    hex = FALLBACK_HEX[(h & 0x7fffffff) % FALLBACK_HEX.length]
  }
  return { rgb: [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255], label: CLASS_STYLE[id]?.label ?? unitSymbol ?? id }
}

// ---------------------------------------------------------------- units

export interface Unit {
  id: string
  name: string
  label: string
  lo: number
  hi: number
  abundance: number
  rgb: [number, number, number]
}

/** Layered units that can reach elevations [minE, maxE] (Unity BuildUnits). */
export function unitBands(minE: number, maxE: number): Unit[] {
  const { band_margin_m: margin, band_falloff_m: falloff, min_fade: minFade } = UNITS_FILE
  const reach = margin + falloff * Math.log(1 / minFade)
  const out: Unit[] = []
  for (const c of UNITS_FILE.classes) {
    if (!c.id || !(c.abundance > 0) || c.setting === 'caprock') continue
    let lo = Infinity
    let hi = -Infinity
    for (const s of UNITS_FILE.samples) {
      if (s.classId !== c.id || !s.useAsAnalog || s.elevationM === null) continue
      lo = Math.min(lo, s.elevationM)
      hi = Math.max(hi, s.elevationM)
    }
    if (lo > hi || hi + reach < minE || lo - reach > maxE) continue
    const st = classStyle(c.id, c.unitSymbol)
    out.push({ id: c.id, name: c.name, label: st.label, lo, hi, abundance: c.abundance, rgb: st.rgb })
  }
  return out
}

/** Unit of highest abundance x band fade at elevation e (Unity PickUnit); index -1 without units. */
export function pickUnit(units: Unit[], e: number): { index: number; fade: number } {
  const { band_margin_m: margin, band_falloff_m: falloff } = UNITS_FILE
  let best = -1
  let bestScore = 0
  let bestOutside = 0
  units.forEach((u, i) => {
    const lo = u.lo - margin
    const hi = u.hi + margin
    const outside = e < lo ? lo - e : e > hi ? e - hi : 0
    const score = outside > 0 ? u.abundance * Math.exp(-outside / falloff) : u.abundance
    if (best < 0 || score > bestScore) {
      best = i
      bestScore = score
      bestOutside = outside
    }
  })
  return { index: best, fade: best < 0 ? 0 : bestOutside > 0 ? Math.exp(-bestOutside / falloff) : 1 }
}

// ---------------------------------------------------------------- relief

/** Contour interval: the finest of INTERVALS whose spacing at the median slope is >= 6 cells. */
export function contourInterval(elev: Float32Array, w: number, h: number, mpp: number): number {
  const hist = new Uint32Array(91)
  let count = 0
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 8192)))
  for (let r = 1; r < h - 1; r += step)
    for (let c = 1; c < w - 1; c += step) {
      const i = r * w + c
      const gx = (elev[i + 1] - elev[i - 1]) / (2 * mpp)
      const gz = (elev[i - w] - elev[i + w]) / (2 * mpp)
      const deg = Math.round((Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI)
      if (!Number.isFinite(deg)) continue
      hist[deg]++
      count++
    }
  let median = 0
  for (let d = 0, acc = 0; d <= 90; d++) {
    acc += hist[d]
    if (acc > count / 2) {
      median = d
      break
    }
  }
  const slope = Math.tan((Math.min(median, 85) * Math.PI) / 180)
  for (const k of INTERVALS) if (slope <= 1e-4 || k / slope / mpp >= MIN_CONTOUR_SPACING_CELLS) return k
  return INTERVALS[INTERVALS.length - 1]
}

/** Line coverage of the nearest contour level (Unity Coverage): q = h / interval. */
export function coverage(q: number, interval: number, cellsPerMetre: number, width: number): number {
  const fr = q - Math.floor(q)
  const dm = (fr < 0.5 ? fr : 1 - fr) * interval
  const c = width - dm * cellsPerMetre
  return c < 0 ? 0 : c > 1 ? 1 : c
}

export type ReliefMode = 'topo' | 'material'

export interface Relief {
  rgba: Uint8ClampedArray
  width: number
  height: number
  minE: number
  maxE: number
  contourM: number
  /** cells drawn per unit at half weight or more (Unity unitTexels), by unit id */
  unitCells: Map<string, number>
}

const clamp255 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v))

export function renderRelief(elev: Float32Array, w: number, h: number, mpp: number, mode: ReliefMode, units: Unit[] | null): Relief {
  let minE = Infinity
  let maxE = -Infinity
  for (const v of elev)
    if (Number.isFinite(v)) {
      if (v < minE) minE = v
      if (v > maxE) maxE = v
    }
  const range = maxE - minE || 1
  const ci = contourInterval(elev, w, h, mpp)
  const idx = ci * INDEX_EVERY
  const alt = (LIGHT_ALT_DEG * Math.PI) / 180
  const lz = Math.sin(alt)
  const lx = LIGHT_AZ_DEG.map((a) => Math.cos(alt) * Math.sin((a * Math.PI) / 180))
  const ly = LIGHT_AZ_DEG.map((a) => Math.cos(alt) * Math.cos((a * Math.PI) / 180))
  const lut = new Float32Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let s = 0
    while (s < RAMP.length - 2 && t > RAMP[s + 1].t) s++
    const f = (t - RAMP[s].t) / (RAMP[s + 1].t - RAMP[s].t)
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = RAMP[s].rgb[k] + (RAMP[s + 1].rgb[k] - RAMP[s].rgb[k]) * Math.min(1, Math.max(0, f))
  }

  const rgba = new Uint8ClampedArray(w * h * 4)
  const unitCells = new Map<string, number>()
  const minFade = UNITS_FILE.min_fade
  const inv2 = 0.5 / mpp
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c
      const e = elev[i]
      if (!Number.isFinite(e)) continue
      const nb = (j: number) => (Number.isFinite(elev[j]) ? elev[j] : e)
      const gx = (nb(i + 1) - nb(i - 1)) * inv2 // east
      const gz = (nb(i - w) - nb(i + w)) * inv2 // north (row 0 is north)
      const ex = gx * SHADE_EXAGGERATION
      const ez = gz * SHADE_EXAGGERATION
      const invLen = 1 / Math.sqrt(ex * ex + ez * ez + 1)
      let shade = 0
      for (let l = 0; l < lx.length; l++) {
        const d = (lz - ex * lx[l] - ez * ly[l]) * invLen
        if (d > 0) shade += d * LIGHT_W[l]
      }
      let f = 1 + SHADE_STRENGTH * (shade / lz - 1)
      f = f < 0.3 ? 0.3 : f > 1.45 ? 1.45 : f
      const o = i * 4
      let cr: number, cg: number, cb: number
      if (mode === 'topo') {
        const ti = Math.min(255, Math.max(0, Math.floor(((e - minE) * 255) / range)))
        cr = lut[ti * 3] * f
        cg = lut[ti * 3 + 1] * f
        cb = lut[ti * 3 + 2] * f
        const g = Math.hypot(gx, gz)
        if (g > 1e-4) {
          const cpm = 1 / (g * mpp)
          let a = coverage(e / ci, ci, cpm, 1)
          const fade = (ci * cpm - 2.5) * 0.5
          a *= (fade < 0 ? 0 : fade > 1 ? 1 : fade) * MINOR_STRENGTH
          const ai = coverage(e / idx, idx, cpm, 1.25) * INDEX_STRENGTH
          if (ai > a) a = ai
          if (a > 0) {
            cr += (CONTOUR_RGB[0] - cr) * a
            cg += (CONTOUR_RGB[1] - cg) * a
            cb += (CONTOUR_RGB[2] - cb) * a
          }
        }
      } else {
        cr = cg = cb = BASE_GREY * f
        if (units && units.length) {
          const p = pickUnit(units, e)
          if (p.index >= 0 && p.fade >= minFade) {
            const u = units[p.index]
            const a = UNIT_OVERLAY_ALPHA * p.fade
            cr += (u.rgb[0] - cr) * a
            cg += (u.rgb[1] - cg) * a
            cb += (u.rgb[2] - cb) * a
            if (p.fade >= 0.5) unitCells.set(u.id, (unitCells.get(u.id) ?? 0) + 1)
          }
        }
      }
      rgba[o] = clamp255(cr)
      rgba[o + 1] = clamp255(cg)
      rgba[o + 2] = clamp255(cb)
      rgba[o + 3] = 255
    }
  }
  return { rgba, width: w, height: h, minE, maxE, contourM: ci, unitCells }
}

// WS16 task 2 (M2): CPU side of the GPU field layer. The same decode, manual bilinear and band
// classification as the shader (shader.ts), on the same decoded arrays, so `fieldAt(lon, lat)`
// (WS15 cards and readouts, WS18 pad validity) and the picture can never disagree.
// Encoding (contracts/README.md "Field PNGs", "Cell states"): counts = R*256 + G, A = 0 no value;
// value = counts * scale. Bounds are the outer pixel edges [w, s, e, n]; rows run north to south.
import { STATE, VARIANTS, type CellState, type Variant } from './constants'
import { collapseBandClass, collapseT, flatMinutes } from './collapseMath'
import { marginAt, marginClass, type Binding, type FieldClass, type MarginInputs } from './margin'

export type Bounds = [number, number, number, number]

/** One decoded field grid (t_home, o2_home). `known[i]` = 0 where the PNG has A = 0. */
export interface DecodedGrid {
  width: number
  height: number
  bounds: Bounds
  scale: number
  counts: Uint16Array
  known: Uint8Array
}

/** Cell-state grid (3 m routing cells on the real tree): code 0 assessed, 1 blocked, 2 unknown. */
export interface StateGrid {
  width: number
  height: number
  bounds: Bounds
  code: Uint8Array
}

/** RGBA bytes (row-major) -> decoded grid. Bit-identical to hud/fields.ts decodeRGBA. */
export function decodeGrid(rgba: ArrayLike<number>, width: number, height: number, scale: number, bounds: Bounds): DecodedGrid {
  const n = width * height
  if (rgba.length !== n * 4) throw new Error(`RGBA length ${rgba.length} != ${n} * 4`)
  if (!(scale > 0)) throw new Error(`bad scale ${scale}`)
  const counts = new Uint16Array(n)
  const known = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (rgba[j + 3] === 0) continue
    counts[i] = rgba[j] * 256 + rgba[j + 1]
    known[i] = 1
  }
  return { width, height, bounds, scale, counts, known }
}

/** Cell-state PNG -> codes (A = 0 -> unknown; otherwise the count: 0 assessed, 1 blocked). */
export function decodeState(rgba: ArrayLike<number>, width: number, height: number, bounds: Bounds): StateGrid {
  const n = width * height
  if (rgba.length !== n * 4) throw new Error(`RGBA length ${rgba.length} != ${n} * 4`)
  const code = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (rgba[j + 3] === 0) code[i] = STATE.unknown
    else {
      const c = rgba[j] * 256 + rgba[j + 1]
      if (c !== STATE.assessed && c !== STATE.blocked) throw new Error(`cell state ${c} at pixel ${i} is not 0 or 1`)
      code[i] = c
    }
  }
  return { width, height, bounds, code }
}

/** Continuous pixel coordinates of (lon, lat): x, y in pixels from the NW outer corner. */
export function gridXY(g: { width: number; height: number; bounds: Bounds }, lon: number, lat: number): [number, number] {
  const [w, s, e, n] = g.bounds
  return [((lon - w) / (e - w)) * g.width, ((n - lat) / (n - s)) * g.height]
}

/** Pixel containing (lon, lat), or null outside the grid. */
export function pixelOf(g: { width: number; height: number; bounds: Bounds }, lon: number, lat: number): { row: number; col: number } | null {
  const [x, y] = gridXY(g, lon, lat)
  const col = Math.floor(x)
  const row = Math.floor(y)
  if (col < 0 || row < 0 || col >= g.width || row >= g.height) return null
  return { row, col }
}

/** Counts at a pixel, clamped to the grid edge like the shader's clamp(); null = no value. */
function countsAt(g: DecodedGrid, col: number, row: number): number | null {
  const c = Math.min(g.width - 1, Math.max(0, col))
  const r = Math.min(g.height - 1, Math.max(0, row))
  const i = r * g.width + c
  return g.known[i] ? g.counts[i] : null
}

/** Value of pixel (row, col); null = no value (A = 0) or outside. */
export function valueAtPixel(g: DecodedGrid, row: number, col: number): number | null {
  if (row < 0 || col < 0 || row >= g.height || col >= g.width) return null
  const i = row * g.width + col
  return g.known[i] ? g.counts[i] * g.scale : null
}

/** Nearest pixel: exactly what the pipeline computed there (cards and readouts quote this). */
export function nearest(g: DecodedGrid, lon: number, lat: number): number | null {
  const p = pixelOf(g, lon, lat)
  return p ? valueAtPixel(g, p.row, p.col) : null
}

/**
 * Manual bilinear on decoded values at pixel coordinates (x, y) (pixel centres at i + 0.5), as the
 * shader does: decode the four neighbours first, interpolate counts, then scale. Any neighbour
 * without a value -> null. Outside the grid -> null (the shader draws nothing there).
 */
export function bilinearXY(g: DecodedGrid, x: number, y: number): number | null {
  if (!(x >= 0 && y >= 0 && x <= g.width && y <= g.height)) return null
  const px = x - 0.5
  const py = y - 0.5
  const c0 = Math.floor(px)
  const r0 = Math.floor(py)
  const fx = px - c0
  const fy = py - r0
  const a = countsAt(g, c0, r0)
  const b = countsAt(g, c0 + 1, r0)
  const c = countsAt(g, c0, r0 + 1)
  const d = countsAt(g, c0 + 1, r0 + 1)
  if (a === null || b === null || c === null || d === null) return null
  const top = a + (b - a) * fx
  const bot = c + (d - c) * fx
  return (top + (bot - top) * fy) * g.scale
}

export function bilinear(g: DecodedGrid, lon: number, lat: number): number | null {
  const [x, y] = gridXY(g, lon, lat)
  return bilinearXY(g, x, y)
}

/** Cell state under (lon, lat), nearest cell (no interpolation); outside the state grid -> 'outside'. */
export function stateAt(s: StateGrid, lon: number, lat: number): CellState {
  const p = pixelOf(s, lon, lat)
  if (!p) return 'outside'
  const c = s.code[p.row * s.width + p.col]
  return c === STATE.unknown ? 'unknown' : c === STATE.blocked ? 'blocked' : 'assessed'
}

/**
 * Band class of one pixel in bands mode, the shader's branch order:
 * - `unknown`: no terrain data under the pixel (cell state unknown, or outside the cell-state grid):
 *   grey hatch, never a warning colour;
 * - `con` / `nom` / `opt`: the innermost variant whose drawn (bilinear) T_home <= budget
 *   (conservative = densest fill);
 * - `none`: not in any band, including known terrain with no route home (t_home A = 0): unfilled.
 */
export type BandClass = 'unknown' | Variant | 'none'

export function bandClass(drawn: Record<Variant, number | null>, terrainUnknown: boolean, budget: number): BandClass {
  if (terrainUnknown) return 'unknown'
  for (const v of ['con', 'nom', 'opt'] as const) {
    const t = drawn[v]
    if (t !== null && t <= budget) return v
  }
  return 'none'
}

export interface FieldSample {
  lon: number
  lat: number
  /** Inside the field grid (fields/index.json bounds). */
  inside: boolean
  /** Cell state under the point; null when no cell-state grid is published. */
  state: CellState | null
  /** No terrain data (cell state unknown or outside its grid): hatched, never coloured. */
  unknown: boolean
  /** T_home in min per variant, nearest pixel (= the published field value); null = no value. */
  tHome: Record<Variant, number | null>
  /** O2 needed to get home, L (nominal variant), nearest pixel; null = no value. */
  o2Home: number | null
  /** Known terrain but t_home has no value (A = 0): no route home (blocked or unreached), per variant. */
  noRouteHome: Record<Variant, boolean>
  /** T_home as the shader draws it (manual bilinear; null if any neighbour has no value). */
  drawn: Record<Variant, number | null>
  /** O2 home as the margin shader draws it (manual bilinear), L; null = no value. */
  o2Drawn: number | null
  // ---- margin mode (M3, contracts/field_shader.md §5), at the current clock minute ----
  /** The variant used for t, margin and cls (the plan's variant). */
  variant: Variant
  /** T(x), min: drawn T_home of `variant` blended with the flat time by the collapse k (M4, contract §3.1). */
  t: number | null
  /** Flat walk time from the pad, min (D25, distance in grid metres / 0.98 m/s); null when the pad is not set. */
  flat: number | null
  /** Collapse k used for t (1 = the real field). */
  k: number
  /** m(x), min, for the current mission state; null when an input is missing or margin mode has no inputs. */
  margin: number | null
  /** The term that sets the margin; null when margin is null. */
  binding: Binding | null
  /** Class drawn in margin mode: safe / caution / limit, none, or unknown (hatch). */
  cls: FieldClass
}

/** The decoded inputs of one scenario family (one suit mass): three t_home, o2_home nominal, cell state. */
export class FieldData {
  /** Suit mass (scenario id suffix, e.g. 104 for opt_104 / nom_104 / con_104). */
  readonly suitKg: number
  readonly t: Record<Variant, DecodedGrid>
  readonly o2: DecodedGrid | null
  readonly state: StateGrid | null
  /** Files read, for the provenance popover. */
  readonly sources: string[]

  /** Margin-mode inputs at the current clock (set by the field driver); null = not known. */
  private marginInputs: MarginInputs | null = null
  private marginVariant: Variant = 'nom'
  /** Collapse (M4): pad in grid metres and k; null pad = no flat field (k ignored, T = T_home). */
  private collapsePad: [number, number] | null = null
  private collapseK = 1
  /** fields/index.json res_m (u_cell); null = unknown (no collapse). */
  readonly resM: number | null

  constructor(suitKg: number, t: Record<Variant, DecodedGrid>, o2: DecodedGrid | null, state: StateGrid | null, sources: string[], resM: number | null = null) {
    this.suitKg = suitKg
    this.resM = resM
    this.t = t
    this.o2 = o2
    this.state = state
    this.sources = sources
    const g = t.nom
    for (const v of VARIANTS) {
      const o = t[v]
      if (o.width !== g.width || o.height !== g.height || o.scale !== g.scale || o.bounds.some((b, i) => b !== g.bounds[i])) throw new Error(`t_home ${v} is not on the nominal grid`)
    }
  }

  get bounds(): Bounds {
    return this.t.nom.bounds
  }

  /** Margin inputs at the current clock (the same scalars the shader gets) and the plan variant. */
  setMargin(inputs: MarginInputs | null, variant: Variant): void {
    this.marginInputs = inputs
    this.marginVariant = variant
  }

  /** Collapse inputs (M4): the pad in grid metres (u_pad) and k (u_k). */
  setCollapse(pad: [number, number] | null, k: number): void {
    this.collapsePad = pad
    this.collapseK = pad ? k : 1
  }

  /** Flat walk time (min) from the pad, as the shader computes it; null without pad or res_m. */
  flatAt(lon: number, lat: number): number | null {
    const pad = this.collapsePad
    if (!pad || this.resM === null) return null
    const [x, y] = gridXY(this.t.nom, lon, lat)
    return flatMinutes(Math.hypot(x * this.resM - pad[0], y * this.resM - pad[1]))
  }

  /** Bands-mode class drawn at (lon, lat) for a budget at the current collapse k (shader order). */
  bandClassAt(lon: number, lat: number, budget: number): BandClass {
    if (pixelOf(this.t.nom, lon, lat) === null) return 'none'
    const st = this.state ? stateAt(this.state, lon, lat) : null
    const unknown = st === 'unknown' || st === 'outside'
    const drawn = { opt: bilinear(this.t.opt, lon, lat), nom: bilinear(this.t.nom, lon, lat), con: bilinear(this.t.con, lon, lat) }
    const flat = this.flatAt(lon, lat)
    if (flat === null || this.collapseK >= 1) return bandClass(drawn, unknown, budget)
    return collapseBandClass(drawn, flat, unknown, budget, this.collapseK)
  }

  /** CPU lookup from the same decoded arrays the GPU layer uses. */
  at(lon: number, lat: number): FieldSample {
    const inside = pixelOf(this.t.nom, lon, lat) !== null
    const state = this.state ? stateAt(this.state, lon, lat) : null
    const unknown = state === 'unknown' || state === 'outside'
    const tHome = { opt: nearest(this.t.opt, lon, lat), nom: nearest(this.t.nom, lon, lat), con: nearest(this.t.con, lon, lat) }
    const drawn = { opt: bilinear(this.t.opt, lon, lat), nom: bilinear(this.t.nom, lon, lat), con: bilinear(this.t.con, lon, lat) }
    const noRoute = (v: Variant): boolean => inside && !unknown && tHome[v] === null
    const variant = this.marginVariant
    const o2Drawn = this.o2 ? bilinear(this.o2, lon, lat) : null
    const flat = this.flatAt(lon, lat)
    const k = flat === null ? 1 : this.collapseK
    const tv = flat === null ? drawn[variant] : drawn[variant] === null ? null : collapseT(flat, drawn[variant], k)
    const m = this.marginInputs && tv !== null && o2Drawn !== null ? marginAt(this.marginInputs, tv, o2Drawn) : null
    // class drawn in margin mode, the shader's order: outside the grid nothing is drawn; unknown
    // terrain is hatched (never a colour); no T_home / O2_home value -> none (contract §3.1)
    const cls: FieldClass = !inside ? 'none' : unknown ? 'unknown' : m === null ? 'none' : marginClass(m.margin)
    return {
      lon,
      lat,
      inside,
      state,
      unknown,
      tHome,
      o2Home: this.o2 ? nearest(this.o2, lon, lat) : null,
      noRouteHome: { opt: noRoute('opt'), nom: noRoute('nom'), con: noRoute('con') },
      drawn,
      o2Drawn,
      variant,
      t: tv,
      flat,
      k,
      margin: m ? m.margin : null,
      binding: m ? m.binding : null,
      cls,
    }
  }
}

/** Field uv -> uv on another grid (e.g. the 3 m cell-state grid): [offU, offV, scaleU, scaleV]. */
export function gridXform(from: Bounds, to: Bounds): [number, number, number, number] {
  const [fw, fs, fe, fn] = from
  const [tw, ts, te, tn] = to
  return [(fw - tw) / (te - tw), (tn - fn) / (tn - ts), (fe - fw) / (te - tw), (fn - fs) / (tn - ts)]
}

/** '#RRGGBB' token -> [r, g, b] in 0..1 (shader uniforms). */
export function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`)
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// ---- the app-wide active field (set by the planning map once loaded) --------------------------
let active: FieldData | null = null
const listeners = new Set<(f: FieldData | null) => void>()

export function setActiveField(f: FieldData | null): void {
  active = f
  listeners.forEach((l) => l(f))
}
export function activeField(): FieldData | null {
  return active
}
/** Subscribe to field changes (returns the unsubscribe function). */
export function onFieldChange(l: (f: FieldData | null) => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * fieldAt(lon, lat): decoded T_home (all three variants), O2 home (nominal), cell state and the
 * unknown flag at a point, from the field the planning map shows. null until a field is loaded.
 * WS15 (cards, readouts) and WS18 (pad validity) use this; never re-derive values elsewhere.
 */
export function fieldAt(lon: number, lat: number): FieldSample | null {
  return active ? active.at(lon, lat) : null
}

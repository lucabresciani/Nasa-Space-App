// WS16 task 12 (M12): the dose ring (DESIGN U9): where home is still reachable within the dose
// budget. From fieldAt values only: a lattice of cells over the field grid, each cell's T_home is
// fieldAt(cell centre).tHome[plan variant] (nearest pixel = the published value); a cell is in the
// ring when that T_home <= the ring leash (model.ts stormView().ringLeashMin). Unknown terrain and
// cells with no route home are never in the ring (unknown stays unknown). The ring is drawn as the
// exact boundary of that cell set (cell edges between an inside and an outside cell), chained into
// lines so the dash pattern runs continuously.
import designRaw from '../../../../config/design.yaml'
import { CONFIG, cfg } from '../../config'
import type { FieldSample } from '../field'

export type Bounds = [number, number, number, number]
export type LonLat = [number, number]

/** design.yaml storm.ring_cell_m: the dose-ring lattice cell, ground metres (assumed: true, M12; RR judges the staircase at z15-17). */
export const RING_CELL_M = cfg<number>(designRaw, 'storm.ring_cell_m')

/**
 * Lattice step in field pixels for RING_CELL_M cells: the field's res_m (fields/index.json; 5 m, so
 * 20 m = stride 4: 370 × 370 fieldAt lookups once per field, then a threshold per clock change). Without
 * res_m the pixel size comes from the grid's latitude span on the Mars sphere.
 */
export function ringStride(grid: { height: number; bounds: Bounds; resM?: number | null }): number {
  const [, s, , n] = grid.bounds
  const resM = grid.resM && grid.resM > 0 ? grid.resM : (((n - s) * Math.PI) / 180) * CONFIG.marsRadiusM / grid.height
  return Math.max(1, Math.round(RING_CELL_M / resM))
}

export interface RingLattice {
  cols: number
  rows: number
  bounds: Bounds
  /** cell T_home (min) of the plan variant; NaN = not reachable (unknown terrain, outside, no route home) */
  tHome: Float64Array
  /** cell centre (lon, lat) */
  centre(col: number, row: number): LonLat
}

/** Sample `at` (fieldAt or FieldData.at) at the centre of every lattice cell over the field grid. */
export function ringLattice(at: (lon: number, lat: number) => FieldSample | null, grid: { width: number; height: number; bounds: Bounds; resM?: number | null }, stride = ringStride(grid)): RingLattice {
  const cols = Math.floor(grid.width / stride)
  const rows = Math.floor(grid.height / stride)
  const [w, s, e, n] = grid.bounds
  const dx = ((e - w) / grid.width) * stride
  const dy = ((n - s) / grid.height) * stride
  const centre = (c: number, r: number): LonLat => [w + (c + 0.5) * dx, n - (r + 0.5) * dy]
  const tHome = new Float64Array(cols * rows).fill(NaN)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [lon, lat] = centre(c, r)
      const f = at(lon, lat)
      if (!f || !f.inside || f.unknown || f.state === 'blocked') continue
      const v = f.tHome[f.variant]
      if (v !== null && Number.isFinite(v)) tHome[r * cols + c] = v
    }
  }
  // the lattice spans whole cells only: its east / south edge is at cols * dx / rows * dy
  return { cols, rows, bounds: [w, n - rows * dy, w + cols * dx, n], tHome, centre }
}

/** 1 = in the ring (T_home <= leash), 0 = outside or not reachable. */
export function ringMask(l: RingLattice, leashMin: number): Uint8Array {
  const out = new Uint8Array(l.tHome.length)
  for (let i = 0; i < out.length; i++) {
    const v = l.tHome[i]
    out[i] = v === v && v <= leashMin ? 1 : 0 // v === v: not NaN
  }
  return out
}

/**
 * Boundary of the masked cell set as polylines (lon, lat): every cell edge with an inside cell on
 * one side and an outside cell (or the lattice edge) on the other, chained end to end.
 */
export function ringBoundary(l: RingLattice, mask: Uint8Array): LonLat[][] {
  const { cols, rows } = l
  const [w, , e, n] = l.bounds
  const dx = (e - w) / cols
  const dy = (n - l.bounds[1]) / rows
  const inside = (c: number, r: number): boolean => c >= 0 && r >= 0 && c < cols && r < rows && mask[r * cols + c] === 1
  // lattice vertices are (i, j) with i in 0..cols, j in 0..rows; key = j * (cols + 1) + i
  const W = cols + 1
  const adj = new Map<number, number[]>()
  const link = (a: number, b: number): void => {
    let x = adj.get(a)
    if (!x) adj.set(a, (x = []))
    x.push(b)
    let y = adj.get(b)
    if (!y) adj.set(b, (y = []))
    y.push(a)
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inside(c, r)) continue
      if (!inside(c, r - 1)) link(r * W + c, r * W + c + 1) // north edge
      if (!inside(c, r + 1)) link((r + 1) * W + c, (r + 1) * W + c + 1) // south edge
      if (!inside(c - 1, r)) link(r * W + c, (r + 1) * W + c) // west edge
      if (!inside(c + 1, r)) link(r * W + c + 1, (r + 1) * W + c + 1) // east edge
    }
  }
  const pt = (k: number): LonLat => [w + (k % W) * dx, n - Math.floor(k / W) * dy]
  const used = new Set<string>()
  const ek = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`)
  const lines: LonLat[][] = []
  // start chains at odd-degree vertices first (none on a closed boundary), then anywhere
  const starts = [...adj.keys()].sort((a, b) => (adj.get(b)!.length % 2) - (adj.get(a)!.length % 2) || a - b)
  for (const s of starts) {
    for (;;) {
      const nb = adj.get(s)!.find((x) => !used.has(ek(s, x)))
      if (nb === undefined) break
      const chain = [s]
      let a = s
      let b: number | undefined = nb
      while (b !== undefined) {
        used.add(ek(a, b))
        chain.push(b)
        a = b
        b = adj.get(a)!.find((x) => !used.has(ek(a, x)))
      }
      lines.push(chain.map(pt))
    }
  }
  return lines
}

/** Number of ring cells (for the tests and the legend's data attribute). */
export function ringCount(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) n += mask[i]
  return n
}

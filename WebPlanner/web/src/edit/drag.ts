// Drag the rover, static mode (WS18 task 2, DESIGN U15 "Drag the rover"; design-agents rules 5, 6).
//
// While dragging, only exact values from fields already in the browser are shown (U15 rule):
//   cell state   fieldAt(lon, lat).state (nearest 3 m cell of terrain/cellstate.png)
//   slope        fields/shared/slope.png, nearest pixel (the same lookup as the cursor readout)
//   elevation    no elevation field is loaded in the browser: "—" (never estimated)
//   validity     the U15 spot rule on those fields (config/design.yaml pad_validity):
//                every cell of the 20 × 20 m block around the spot assessed, max slope ≤ 5°,
//                and the flat 30-min disc (1764 m) inside the field grid.
// Everything else (feasible EVAs, reachable area) is a ghost marked "computing…"; with the backend
// off nothing is computed for the dragged spot: on release the rover snaps to the nearest
// precomputed pad (official + D21 parking options) whose spot is valid, and that pad's precomputed
// values are shown. Nothing here fetches or estimates anything.
import designRaw from '../../../config/design.yaml'
import { cfg } from '../config'
import type { CellState, FieldSample } from '../map/field'
import type { PadRow } from './canonical'
import type { LonLat } from './options'

/** config/design.yaml pad_validity */
export const PAD_VALIDITY = {
  maxSlopeDeg: cfg<number>(designRaw, 'pad_validity.max_slope_deg'),
  blockM: cfg<number>(designRaw, 'pad_validity.block_m'),
  discM: cfg<number>(designRaw, 'pad_validity.disc_inside_grid_m'),
} as const

/**
 * Click vs drag on the rover marker (H2b): a press whose pointer moves no farther than this many CSS
 * px from where it went down is a click (it selects the pad, as every other marker does); only
 * movement beyond it starts the drag. No drag threshold exists in config/design.yaml or tokens, so
 * this is the platform default (~4 px; assumed, see notes/H2b.md). MapLibre starts its own marker
 * drag at 3 px (map clickTolerance), below this.
 */
export const CLICK_SLOP_PX = 4

/** True when the pointer has moved beyond the click slop from the press point (screen px). */
export function isDragMove(from: { x: number; y: number }, to: { x: number; y: number }, slop = CLICK_SLOP_PX): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > slop
}

/** The field grid the disc must stay inside (fields/index.json bounds) and its metric. */
export interface DragGrid {
  bounds: readonly [number, number, number, number]
  mPerDegLon: number
  mPerDegLat: number
  /** finest cell size of the fields the block scan reads (m); the scan step is half of it */
  cellM: number
}

/** The browser fields a drag reads. All lookups, no computation of planning values. */
export interface DragFields {
  /** fieldAt(lon, lat), or the same FieldData.at() when the map shows a parking option */
  sample(lon: number, lat: number): FieldSample | null
  /** slope in degrees, nearest pixel of fields/shared/slope.png; null = no value */
  slope(lon: number, lat: number): number | null
  grid: DragGrid | null
}

export type SpotFail = 'steep' | 'unknown' | 'outside'
export type Validity = 'valid' | 'invalid' | 'unknown'

/** What the drag shows at the dragged cell: exact lookups and the rule result. */
export interface SpotValues {
  lon: number
  lat: number
  validity: Validity
  /** the checks that failed (invalid), in copy order: steep, unknown terrain, disc off the grid */
  failed: SpotFail[]
  /** cell state at the spot = fieldAt(lon, lat).state */
  state: CellState | null
  /** slope at the spot (nearest pixel) = the slope field value */
  slopeDeg: number | null
  /** max slope over the 20 × 20 m block (the rule's input) */
  maxSlopeDeg: number | null
  /** no elevation field in the browser: always null ("—") */
  elevationM: null
}

/**
 * The U15 spot rule at (lon, lat). "unknown" when a field the rule needs is missing (never shown as
 * invalid: unknown stays unknown).
 */
export function spotValues(f: DragFields, at: LonLat, rule = PAD_VALIDITY): SpotValues {
  const s = f.sample(at.lon, at.lat)
  const out: SpotValues = { lon: at.lon, lat: at.lat, validity: 'unknown', failed: [], state: s?.state ?? null, slopeDeg: f.slope(at.lon, at.lat), maxSlopeDeg: null, elevationM: null }
  const g = f.grid
  if (!g) return out
  let missing = !s || s.state === null
  // block scan: every 3 m cell and 5 m pixel of the block centred on the spot
  const half = rule.blockM / 2
  const step = g.cellM / 2
  const n = Math.max(1, Math.ceil(rule.blockM / step))
  let maxSlope: number | null = null
  let notAssessed = false
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const dx = -half + (i * rule.blockM) / n
      const dy = -half + (j * rule.blockM) / n
      const lon = at.lon + dx / g.mPerDegLon
      const lat = at.lat + dy / g.mPerDegLat
      const c = f.sample(lon, lat)
      if (!c || c.state === null) missing = true
      else if (c.state !== 'assessed') notAssessed = true
      const sl = f.slope(lon, lat)
      if (sl === null) missing = true
      else if (maxSlope === null || sl > maxSlope) maxSlope = sl
    }
  }
  out.maxSlopeDeg = maxSlope
  const [w, so, e, no] = g.bounds
  const inside = Math.min((at.lon - w) * g.mPerDegLon, (e - at.lon) * g.mPerDegLon, (at.lat - so) * g.mPerDegLat, (no - at.lat) * g.mPerDegLat) >= rule.discM
  if (maxSlope !== null && maxSlope > rule.maxSlopeDeg) out.failed.push('steep')
  if (notAssessed) out.failed.push('unknown')
  if (!inside) out.failed.push('outside')
  out.validity = out.failed.length ? 'invalid' : missing ? 'unknown' : 'valid'
  return out
}

/**
 * Snap target (static drag-the-rover): the nearest precomputed pad whose spot is not invalid.
 * A precomputed pad the browser cannot check (fields missing) still counts: D21 screened it with
 * the same rule. null = no valid pad (the rover stays where it is).
 */
export function snapTarget(pads: readonly PadRow[], at: LonLat, valid: (p: PadRow) => boolean): PadRow | null {
  const k = Math.cos((at.lat * Math.PI) / 180)
  let best: PadRow | null = null
  let bestD = Infinity
  for (const p of pads) {
    if (!valid(p)) continue
    const d = ((p.lon - at.lon) * k) ** 2 + (p.lat - at.lat) ** 2
    if (d < bestD) [best, bestD] = [p, d]
  }
  return best
}

/** Keyboard alternative: the next (dir 1) or previous (dir -1) precomputed pad, wrapping. */
export function cyclePad(pads: readonly PadRow[], current: string, dir: 1 | -1): PadRow | null {
  if (!pads.length) return null
  const i = pads.findIndex((p) => p.id === current)
  return pads[(((i < 0 ? 0 : i + dir) % pads.length) + pads.length) % pads.length]
}

// ---- display rows (exact values only; everything else a ghost) -------------------------------

export type DragRowKey = 'validity' | 'elevation' | 'slope' | 'feasibleEvas' | 'reachable'
export interface DragRow {
  key: DragRowKey
  /** exact = a field lookup; ghost = not computed during a drag ("computing…") */
  kind: 'exact' | 'ghost'
  /** the looked-up value (exact rows) */
  value: number | string | null
}

/** The rows the drag readout shows. Planning values never get a number while dragging. */
export function dragRows(v: SpotValues): DragRow[] {
  return [
    { key: 'validity', kind: 'exact', value: v.validity },
    { key: 'elevation', kind: 'exact', value: v.elevationM },
    { key: 'slope', kind: 'exact', value: v.slopeDeg },
    { key: 'feasibleEvas', kind: 'ghost', value: null },
    { key: 'reachable', kind: 'ghost', value: null },
  ]
}

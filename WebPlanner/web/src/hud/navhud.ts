// F21 navigation in the HUD (SPEC §2.4 "HUD integration"): when WS9's Monte Carlo files exist, the
// 95 % ellipse replaces F19's circle, worst-case lookups use the smallest precomputed radius >= the
// ellipse's semi-major axis, alarm 3 fires when the ellipse reaches the homeline (text "Position
// uncertain: take a fix or head toward rover"), and the position line reads
// "Odometry ±N m · next fix due in M m · last fix: type, K min ago" (WS9's navReading / navLine).
// Every number is a row of nav/montecarlo_{set}.json, nav/fixes.json or a D_max field lookup.
import { ellipseRingLonLat, insideEllipse } from '../nav/geom'
import { navLine, navReading, type NavReading } from '../nav/navstate'
import { nextFix } from '../nav/series'
import type { Ellipse, Fix as NavFix, MonteCarlo } from '../nav/types'
import type { FieldGrid } from './fields'
import { evaluateAlarm } from './alarms'
import { computeReadout, type HudContext, type Readout } from './readout'
import type { HudPosition, LonLat } from './types'

export const NAV_ALARM3_TEXT = 'POSITION UNCERTAIN: TAKE A FIX OR HEAD TOWARD ROVER'

export interface HudNav {
  set: string
  mc: MonteCarlo
  fixes: NavFix[]
  /** fields/fix_interval_{set}.png (D_max, m); null = not exported */
  dMax: FieldGrid | null
  ellipseVertices: number
}

export interface HudFrame {
  pos: HudPosition
  readout: Readout
  reading: NavReading | null
  ring: LonLat[] | null
  line: string | null
}

/**
 * Max of a field over the pixels whose centres lie inside the ellipse around (lon, lat) (the pixel
 * under the position always counts); unknown pixels skipped (as FieldGrid.discMax); null if the
 * ellipse leaves the grid or holds no known pixel.
 */
export function ellipseMax(g: FieldGrid, lon: number, lat: number, ell: Ellipse): number | null {
  const p = g.pixelOf(lon, lat)
  if (!p) return null
  const x0 = (lon - g.w) * g.mPerDegLon
  const y0 = (g.n - lat) * g.mPerDegLat
  const r = Math.max(ell.a_m, ell.b_m)
  const res = g.resM
  const rowMin = Math.floor((y0 - r) / res)
  const rowMax = Math.floor((y0 + r) / res)
  const colMin = Math.floor((x0 - r) / res)
  const colMax = Math.floor((x0 + r) / res)
  if (rowMin < 0 || colMin < 0 || rowMax >= g.height || colMax >= g.width) return null
  let best = -Infinity
  for (let row = rowMin; row <= rowMax; row++) {
    const dn = y0 - (row + 0.5) * res // north is up: rows grow southwards
    for (let col = colMin; col <= colMax; col++) {
      const de = (col + 0.5) * res - x0
      if (!(row === p.row && col === p.col) && !insideEllipse(de, dn, ell)) continue
      const v = g.valueAtPixel(row, col)
      if (v !== null && v > best) best = v
    }
  }
  return best === -Infinity ? null : best
}

/** Does the ellipse reach the homeline (a reachable pixel inside it beyond the budget, or nothing known)? */
export function ellipseCrossesHomeline(tHome: FieldGrid, lon: number, lat: number, ell: Ellipse, budgetMin: number): boolean {
  const m = ellipseMax(tHome, lon, lat, ell)
  return m === null || m > budgetMin
}

/**
 * One HUD frame with F21 navigation. `base` is the playback (or drag) position; with nav data and
 * a non-drag source, sigma = the ellipse semi-major axis and last_fix comes from nav/fixes.json.
 */
export function hudFrame(base: HudPosition, ctx: HudContext, nav: HudNav | null): HudFrame {
  if (!nav || base.source === 'drag') {
    return { pos: base, readout: computeReadout(base, ctx), reading: null, ring: null, line: null }
  }
  const dmax = nav.dMax ? nav.dMax.valueAt(base.lon, base.lat) : null
  const reading = navReading(base.t_eva_min, nav.mc, nav.fixes, dmax)
  const ell = reading.ellipse
  const lf = reading.lastFix
  const pos: HudPosition = {
    ...base,
    sigma_m: ell ? ell.a_m : base.sigma_m,
    source: reading.distSinceFixM ? 'drift' : 'fix',
    last_fix: lf ? { source: lf.type, t_eva_min: lf.t_eva_min } : null,
  }
  const readout = computeReadout(pos, ctx)
  if (ell) {
    // alarm 3 by the ellipse instead of the circle; the rule order is unchanged
    const crosses = ellipseCrossesHomeline(ctx.fields.tHome, pos.lon, pos.lat, ell, ctx.budgetMin)
    readout.circleCrossesHomeline = crosses
    const rad = ctx.radiation ?? { tripwireFired: false, tauDoseMin: null }
    const a = evaluateAlarm(
      { marginMin: readout.marginMin, tripwireFired: rad.tripwireFired, tHomeMin: readout.tHomeMin, tauDoseMin: rad.tauDoseMin, circleCrossesHomeline: crosses, outsidePartner: readout.outsidePartner },
      ctx.cfg.marginAmberMin,
    )
    readout.alarm = a && a.rule === 3 ? { ...a, text: NAV_ALARM3_TEXT } : a
  }
  const ring = ell ? ellipseRingLonLat([pos.lon, pos.lat], ell, ctx.fields.tHome, nav.ellipseVertices) : null
  return { pos, readout, reading, ring, line: navLine(reading) }
}

/** "Take fix": the EVA minute of the next fix event after t (null = none left). */
export function takeFixTime(nav: HudNav | null, t: number): number | null {
  if (!nav) return null
  const f = nextFix(nav.fixes, t)
  return f ? f.t_eva_min : null
}

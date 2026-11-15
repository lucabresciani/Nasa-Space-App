// Navigation reading at EVA time t (F21 HUD integration, SPEC §2.4): the ellipse in force, the
// distance walked since the last fix, the last and next fix, and the fix interval D_max at the
// estimated position. Every number is read from the nav files (held per-minute rows), except
// "next fix due in M m" = D_max - distance since fix (SPEC §2.4), computed here and labelled so.
// Pure functions: the /nav page uses them, and WS7 can mount the same reading in the HUD.
import { lastFix, nextFix, rowAt } from './series'
import type { Ellipse, Fix, MonteCarlo, PerMinute } from './types'

export interface NavReading {
  t: number
  /** per-minute row in force (null: no Monte Carlo file) */
  row: PerMinute | null
  ellipse: Ellipse | null
  r95M: number | null
  distSinceFixM: number | null
  lastFix: Fix | null
  minSinceFix: number | null
  nextFix: Fix | null
  /** D_max at the estimated position (null: no field or unknown cell; 0 = outside the homeline) */
  dmaxM: number | null
  /** D_max - distance since fix (derived); <= 0 means a fix is due now */
  dueInM: number | null
  due: boolean
}

export function navReading(t: number, mc: MonteCarlo | null, fixes: readonly Fix[], dmaxM: number | null): NavReading {
  const row = mc ? rowAt(mc.per_minute, t) : null
  const lf = lastFix(fixes, t)
  const dist = row ? row.dist_since_fix_m : null
  const dueIn = dmaxM !== null && dist !== null ? dmaxM - dist : null
  return {
    t,
    row,
    ellipse: row ? row.ellipse : null,
    r95M: row ? row.r95_m : null,
    distSinceFixM: dist,
    lastFix: lf,
    minSinceFix: lf ? t - lf.t_eva_min : null,
    nextFix: nextFix(fixes, t),
    dmaxM,
    dueInM: dueIn,
    due: dueIn !== null && dueIn <= 0,
  }
}

/** EVA time as h:mm. */
export function fmtEva(tMin: number): string {
  const m = Math.max(0, Math.floor(tMin + 1e-9))
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

/** The HUD position line (SPEC §2.4): "Odometry ±N m · next fix due in M m · last fix: type, K min ago". */
export function navLine(r: NavReading): string {
  const parts = [r.r95M === null ? 'Odometry ±? m' : `Odometry ±${Math.round(r.r95M)} m`]
  if (r.dueInM !== null) parts.push(r.due ? 'fix due now' : `next fix due in ${Math.round(r.dueInM)} m`)
  if (r.lastFix) parts.push(`last fix: ${r.lastFix.type}, ${Math.round(r.minSinceFix ?? 0)} min ago`)
  else parts.push('no fix yet')
  return parts.join(' · ')
}

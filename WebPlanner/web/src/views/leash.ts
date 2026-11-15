import type { LeashRow } from '../data/types'
// Dose-budget leash (F14, D9): tau_dose = D_allow / Ddot. The pipeline writes tau at the storm peak
// for the default allowance (rad.json leash.tau_min_at_peak). The D9 slider changes D_allow, so the
// page recomputes tau with the formula from config/conditions.yaml leash.formula:
//   tau_dose_min = 60 * D_allow / Ddot_mGy_per_h
// from the manifest-backed rate in rad.json; values off the default are labelled "computed in the browser".

/** µGy/day -> mGy/h. */
export function uGyDayToMGyH(rate: number): number {
  return rate / 1000 / 24
}

/** Minutes on a dose allowance D (mGy) at a dose rate (µGy/day); null when the rate is unknown or <= 0. */
export function tauMin(dAllowMgy: number, rateUGyDay: number | null): number | null {
  if (rateUGyDay === null || !(rateUGyDay > 0)) return null
  return (60 * dAllowMgy) / uGyDayToMGyH(rateUGyDay)
}

/** Slider stops between lo and hi (inclusive) at `step`, without float drift. */
export function sliderStops(lo: number, hi: number, step: number): number[] {
  const n = Math.round((hi - lo) / step)
  return Array.from({ length: n + 1 }, (_, i) => +(lo + i * step).toFixed(6))
}

export interface LeashStep {
  d: number
  /** The rad.json leash.table row for this allowance, or null when the table lacks it. */
  row: LeashRow | null
  /** Index of that row in leash.table (manifest key rad.leash.table.{i}.*), -1 when absent. */
  rowIndex: number
}

/**
 * D9 slider stops: range and step from config/conditions.yaml (leash.d_allow_range_mgy,
 * leash.d_allow_step_mgy, read at build time), each matched to rad.json leash.table by D_allow.
 */
export function leashSteps(range: [number, number], step: number, table: LeashRow[] | undefined): LeashStep[] {
  return sliderStops(range[0], range[1], step).map((d) => {
    const rowIndex = (table ?? []).findIndex((r) => Math.abs(r.D_allow_mGy - d) < 1e-6)
    return { d, row: rowIndex >= 0 ? table![rowIndex] : null, rowIndex }
  })
}

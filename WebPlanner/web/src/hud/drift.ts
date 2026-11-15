// Drift circle (F19; the core position uncertainty since D19, the F21 ellipse is an optional
// add-on). Mars has no GPS: the position is an input with uncertainty. The circle radius is
// D39's rule, both numbers from config/hud.yaml fallback_drift:
//   sigma(d) = max(sigma_floor_m (5 m), pct_of_distance (2 %) / 100 * d)
// with d = distance walked since the last fix (rover pad at the start, then each surveyed station
// on arrival). A fix resets d to 0; a fix sigma above the floor (fix_sigma_m) would still hold,
// none is today (rover 2 m, station 5 m), so at a fix the circle is the 5 m floor. sigma never
// decreases between fixes. The marker stays on the planned route.
import type { HudConfig } from './config'
import type { Plan } from './plan'
import type { HudPosition } from './types'

export interface Fix {
  t_eva_min: number
  source: 'rover' | 'station'
  sigma_m: number
  station: string | null
}

/** Fix events of the plan: the rover pad at the start, then every station arrival. */
export function planFixes(plan: Plan, cfg: HudConfig): Fix[] {
  const t0 = plan.legs[0]?.t0 ?? 0
  const out: Fix[] = [{ t_eva_min: t0, source: 'rover', sigma_m: cfg.fixSigmaM.rover, station: null }]
  for (const d of plan.dwells) out.push({ t_eva_min: d.t0, source: 'station', sigma_m: cfg.fixSigmaM.station, station: d.station })
  return out.sort((a, b) => a.t_eva_min - b.t_eva_min)
}

/** Last fix at or before t (the start fix before the walk). */
export function lastFixAt(fixes: Fix[], t: number): Fix {
  let f = fixes[0]
  for (const x of fixes) if (x.t_eva_min <= t + 1e-9) f = x
  return f
}

/** D39: max(floor, pct % of the distance since the last fix), never below the fix's own sigma. */
export function driftSigma(cfg: HudConfig, fixSigmaM: number, distSinceFixM: number): number {
  const { pctOfDistance, sigmaFloorM } = cfg.fallbackDrift
  const d = distSinceFixM > 0 ? distSinceFixM : 0
  return Math.max(fixSigmaM, sigmaFloorM, (pctOfDistance / 100) * d)
}

/** Position object (source "drift") at EVA time t. */
export function driftPosition(plan: Plan, cfg: HudConfig, fixes: Fix[], t: number): HudPosition & { distSinceFixM: number } {
  const s = plan.stateAt(t)
  const fix = lastFixAt(fixes, t)
  const d = s.distanceWalkedM - plan.stateAt(fix.t_eva_min).distanceWalkedM
  return {
    lon: s.lon,
    lat: s.lat,
    sigma_m: driftSigma(cfg, fix.sigma_m, d),
    source: d > 0 ? 'drift' : 'fix',
    t_eva_min: t,
    last_fix: { source: fix.source, t_eva_min: fix.t_eva_min },
    distSinceFixM: Math.max(0, d),
  }
}

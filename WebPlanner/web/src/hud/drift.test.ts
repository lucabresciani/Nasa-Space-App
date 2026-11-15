// F19 drift circle (core, D19; radius D39) (brief WS7 tests: "sigma monotonic between fixes,
// reset at fixes"). The storm switch KATs live in storm.test.ts (D39 placement).
import { describe, expect, it } from 'vitest'
import { driftPosition, driftSigma, lastFixAt, planFixes } from './drift'
import { Plan } from './plan'
import { computeReadout, type HudContext } from './readout'
import { dummyGrid, loadConfig, readJson } from './testutil'
import type { RouteFC, TimelineEvent } from './types'

const cfg = loadConfig()
const route = readJson<RouteFC>('route_nom_104.geojson')
const timeline = readJson<TimelineEvent[]>('timeline_nom_104.json')
const tHome = dummyGrid('nom_104/t_home')
const plan = new Plan(route, timeline, tHome)
const fixes = planFixes(plan, cfg)

describe('drift circle (D19 core, D39 radius, config/hud.yaml)', () => {
  it('D39: radius = max(5 m, 2 % of distance since the last fix), both from hud.yaml', () => {
    expect(cfg.fallbackDrift.sigmaFloorM).toBe(5)
    expect(cfg.fallbackDrift.pctOfDistance).toBe(2)
    for (const d of [0, 1, 100, 249.9, 250, 251, 600, 5000]) {
      expect(driftSigma(cfg, cfg.fixSigmaM.rover, d)).toBeCloseTo(Math.max(5, 0.02 * d), 12)
      expect(driftSigma(cfg, cfg.fixSigmaM.station, d)).toBeCloseTo(Math.max(5, 0.02 * d), 12)
    }
  })
  it('fixes: rover at the start, one per station arrival', () => {
    expect(fixes.map((f) => [f.t_eva_min, f.source, f.sigma_m])).toEqual([
      [0, 'rover', cfg.fixSigmaM.rover],
      [11.1, 'station', cfg.fixSigmaM.station],
      [61.1, 'station', cfg.fixSigmaM.station],
      [122, 'station', cfg.fixSigmaM.station],
    ])
    expect(lastFixAt(fixes, 30).station).toBe('S1')
  })
  it('sigma = pct of distance since the fix, never below the floor (also at the fix, D39)', () => {
    const pct = cfg.fallbackDrift.pctOfDistance / 100
    expect(driftSigma(cfg, 2, 0)).toBe(cfg.fallbackDrift.sigmaFloorM)
    expect(driftSigma(cfg, 2, 10)).toBe(cfg.fallbackDrift.sigmaFloorM)
    // a fix sigma above the floor still holds (none in hud.yaml today)
    expect(driftSigma(cfg, 8, 10)).toBe(8)
    expect(driftSigma(cfg, 2, 1000)).toBeCloseTo(1000 * pct, 9)
    // 600 m walked to S1 at 2% -> 12 m just before the S1 fix
    expect(driftPosition(plan, cfg, fixes, 11.09).sigma_m).toBeCloseTo(600 * pct * (11.09 / 11.1), 1)
  })
  it('sigma is monotonic between fixes and resets at each fix', () => {
    let prev = -1
    let prevFix = fixes[0].t_eva_min
    for (let t = 0; t <= plan.tEnd; t += 0.1) {
      const p = driftPosition(plan, cfg, fixes, t)
      const fix = lastFixAt(fixes, t)
      if (fix.t_eva_min !== prevFix) {
        expect(p.sigma_m).toBe(Math.max(fix.sigma_m, cfg.fallbackDrift.sigmaFloorM)) // reset at the fix
        prevFix = fix.t_eva_min
      } else {
        expect(p.sigma_m).toBeGreaterThanOrEqual(prev - 1e-12)
      }
      expect(p.last_fix?.t_eva_min).toBe(fix.t_eva_min)
      prev = p.sigma_m
    }
  })
  it('during a station dwell sigma stays at the station fix', () => {
    const p = driftPosition(plan, cfg, fixes, 30) // S1 dwell
    expect(p.sigma_m).toBe(Math.max(cfg.fixSigmaM.station, cfg.fallbackDrift.sigmaFloorM))
    expect(p.source).toBe('fix')
    expect(driftPosition(plan, cfg, fixes, 0).sigma_m).toBe(5) // at the rover pad: max(5 m, 0)
  })
  it('the drift readout uses the worst case within sigma (>= point value)', () => {
    const fields = {
      tHome,
      worst: new Map(cfg.worstCaseRadiiM.map((r) => [r, { tHome: dummyGrid(`nom_104/t_home_worst_${r}`) }])),
    }
    const ctx: HudContext = { cfg, fields, plan, budgetMin: cfg.walkbackBudgetsMin[0], pad: plan.start }
    for (const t of [5, 50, 100, 170]) {
      const d = driftPosition(plan, cfg, fixes, t)
      const point = computeReadout({ ...d, sigma_m: 0 }, ctx)
      const r = computeReadout(d, ctx)
      if (r.tHomeMin !== null) expect(r.tHomeMin).toBeGreaterThanOrEqual(point.tHomeMin!)
    }
  })
})

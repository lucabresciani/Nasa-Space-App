// F21 in the HUD (SPEC §2.4): ellipse replaces the circle, worst case by the semi-major axis,
// alarm 3 by the ellipse, nav position line, take-fix. On the committed M0 dummy nav files.
import { describe, expect, it } from 'vitest'
import type { Fix as NavFix, MonteCarlo } from '../nav/types'
import { decodeRGBA, FieldGrid } from './fields'
import { ellipseCrossesHomeline, ellipseMax, hudFrame, NAV_ALARM3_TEXT, takeFixTime, type HudNav } from './navhud'
import { Plan } from './plan'
import { playbackPosition, type HudContext } from './readout'
import { dummyGrid, loadConfig, readJson } from './testutil'
import type { RouteFC, TimelineEvent } from './types'

const cfg = loadConfig()
const route = readJson<RouteFC>('route_nom_104.geojson')
const timeline = readJson<TimelineEvent[]>('timeline_nom_104.json')
const tHome = dummyGrid('nom_104/t_home')
const plan = new Plan(route, timeline, tHome)
const worst = new Map(cfg.worstCaseRadiiM.map((r) => [r, { tHome: dummyGrid(`nom_104/t_home_worst_${r}`) }]))
const ctx: HudContext = { cfg, fields: { tHome, worst }, plan, budgetMin: cfg.walkbackBudgetsMin[0], pad: plan.start }
const nav: HudNav = {
  set: 'medium',
  mc: readJson<MonteCarlo>('nav/montecarlo_medium.json'),
  fixes: readJson<NavFix[]>('nav/fixes.json'),
  dMax: dummyGrid('fix_interval_medium'),
  ellipseVertices: 32,
}

describe('F21 HUD frame (dummy nav files)', () => {
  it('without nav data or while dragging, the frame is the plain readout', () => {
    const p = playbackPosition(plan, 20)
    expect(hudFrame(p, ctx, null).reading).toBeNull()
    expect(hudFrame({ ...p, source: 'drag' }, ctx, nav).ring).toBeNull()
  })
  it('sigma = ellipse semi-major axis of the row in force; last fix from nav/fixes.json', () => {
    const f = hudFrame(playbackPosition(plan, 100), ctx, nav)
    const row = nav.mc.per_minute.filter((r) => r.t_eva_min <= 100).pop()!
    expect(f.pos.sigma_m).toBe(row.ellipse.a_m)
    expect(f.pos.last_fix).toEqual({ source: 'station', t_eva_min: 61.1 })
    expect(f.ring!.length).toBe(33)
    expect(f.line).toMatch(/^Odometry ±\d+ m · /)
    expect(f.line).toContain('last fix: station')
  })
  it('worst case by the semi-major axis: >= the point value', () => {
    for (const t of [5, 50, 100, 150]) {
      const p = playbackPosition(plan, t)
      const f = hudFrame(p, ctx, nav)
      const point = hudFrame({ ...p }, ctx, null).readout.tHomeMin!
      if (f.readout.tHomeMin !== null) expect(f.readout.tHomeMin).toBeGreaterThanOrEqual(point)
      expect(f.readout.worstRadiusM === null || f.readout.worstRadiusM >= f.pos.sigma_m).toBe(true)
    }
  })
  it('take fix jumps to the next fix event', () => {
    expect(takeFixTime(nav, 20)).toBe(61.1)
    expect(takeFixTime(nav, 177.9)).toBeNull()
    expect(takeFixTime(null, 0)).toBeNull()
  })
})

describe('alarm 3 by the ellipse (synthetic, exact)', () => {
  // value = distance east of the centre column in m (scale 0.1), 1 m pixels
  const N = 201
  const c0 = 100
  const rgba = new Uint8Array(N * N * 4)
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const d = Math.abs(c - c0) * 10
      const j = (r * N + c) * 4
      rgba[j] = d >> 8
      rgba[j + 1] = d & 255
      rgba[j + 3] = 255
    }
  const g = new FieldGrid({ bounds: [0, 0, N, N], width: N, height: N, res_m: 1 }, decodeRGBA(rgba, N, N, 0.1))
  const [lon, lat] = g.lonLatOf(c0, c0)
  const budget = 30
  it('an east-west ellipse reaches the band at a = budget; a north-south one does not', () => {
    expect(ellipseMax(g, lon, lat, { a_m: 29, b_m: 5, theta_deg: 90 })).toBe(29)
    expect(ellipseCrossesHomeline(g, lon, lat, { a_m: 29, b_m: 5, theta_deg: 90 }, budget)).toBe(false)
    expect(ellipseCrossesHomeline(g, lon, lat, { a_m: 31, b_m: 5, theta_deg: 90 }, budget)).toBe(true)
    // same size, major axis north-south: the east extent is only b = 5 m
    expect(ellipseCrossesHomeline(g, lon, lat, { a_m: 31, b_m: 5, theta_deg: 0 }, budget)).toBe(false)
    expect(ellipseMax(g, lon, lat, { a_m: 31, b_m: 5, theta_deg: 0 })).toBe(5)
  })
  it('the nav alarm-3 text replaces the circle text', () => {
    expect(NAV_ALARM3_TEXT).toBe('POSITION UNCERTAIN: TAKE A FIX OR HEAD TOWARD ROVER')
  })
})

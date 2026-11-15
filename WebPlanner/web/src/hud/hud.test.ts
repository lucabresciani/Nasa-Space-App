// HUD logic KATs (SPEC §9 "HUD logic", brief WS7 "Tests"), on the committed M0 dummy data.
import { describe, expect, it } from 'vitest'
import { ALARM_TEXT, evaluateAlarm, marginBand, turnBackText, type AlarmInput } from './alarms'
import { PlaybackClock } from './clock'
import { decodeRGBA, FieldGrid } from './fields'
import { interpSeries, Plan } from './plan'
import { bindingLabel, turnBackSub } from './panel'
import { circleCrossesHomeline, computeReadout, insidePolygons, pickWorstRadius, playbackPosition, type HudContext } from './readout'
import { dummyGrid, loadConfig, readJson } from './testutil'
import type { PolygonFC, RouteFC, TimelineEvent } from './types'

const cfg = loadConfig()
const route = readJson<RouteFC>('route_nom_104.geojson')
const timeline = readJson<TimelineEvent[]>('timeline_nom_104.json')
const tHome = dummyGrid('nom_104/t_home')
const fields = {
  tHome,
  tHomeCons: dummyGrid('con_104/t_home'),
  o2Home: dummyGrid('nom_104/o2_home'),
  homeBearing: dummyGrid('nom_104/home_bearing'),
  slope: dummyGrid('slope'),
  worst: new Map(cfg.worstCaseRadiiM.map((r) => [r, { tHome: dummyGrid(`nom_104/t_home_worst_${r}`), o2Home: dummyGrid(`nom_104/o2_home_worst_${r}`) }])),
}
const partner = readJson<PolygonFC>('scenarios/nom_104/partner.geojson')

function ctxFor(tl: TimelineEvent[]): HudContext {
  const plan = new Plan(route, tl, tHome)
  return { cfg, fields, plan, budgetMin: cfg.walkbackBudgetsMin[0], pad: plan.start, partner }
}

describe('config (config/hud.yaml, crew.yaml)', () => {
  it('reads the decided values', () => {
    expect(cfg.playbackSpeeds).toEqual([1, 30, 60, 300])
    expect(cfg.defaultSpeed).toBe(60) // D13
    expect(cfg.defaultLevel).toBe('minimal') // D14
    expect(cfg.evaMin).toBe(390)
  })
})

describe('playback clock (F18)', () => {
  it('1x is real time, 60x is one EVA minute per real second', () => {
    const c = new PlaybackClock(390, cfg.playbackSpeeds, cfg.defaultSpeed)
    expect(c.speed).toBe(60)
    c.play()
    c.tick(1000)
    expect(c.t).toBeCloseTo(1, 12)
    c.setSpeed(1)
    c.tick(60000)
    expect(c.t).toBeCloseTo(2, 12)
    c.setSpeed(300)
    c.tick(1000)
    expect(c.t).toBeCloseTo(7, 12)
  })
  it('paused clock does not move; stops at the end; seek clamps', () => {
    const c = new PlaybackClock(10, cfg.playbackSpeeds, 60)
    expect(c.tick(5000)).toBe(false)
    c.play()
    c.tick(60000)
    expect(c.t).toBe(10)
    expect(c.playing).toBe(false)
    c.seek(-3)
    expect(c.t).toBe(0)
    c.seek(99)
    expect(c.t).toBe(10)
    expect(() => c.setSpeed(7)).toThrow()
  })
})

describe('plan (route + timeline)', () => {
  const plan = new Plan(route, timeline, tHome)
  it('starts at the pad and ends there', () => {
    expect(plan.start).toEqual([137.382, -4.806])
    const end = plan.stateAt(plan.tEnd + 5)
    expect(end.phase).toBe('after')
    expect(tHome.distanceM([end.lon, end.lat], plan.start)).toBeLessThan(1)
  })
  it('is at each station on arrival and stays there through the dwell', () => {
    const stations = readJson<{ id: string; lon: number; lat: number }[]>('stations.json')
    for (const ev of timeline.filter((e) => e.station)) {
      const st = stations.find((s) => s.id === ev.station)!
      const p = plan.stateAt(ev.t_min)
      expect(tHome.distanceM([p.lon, p.lat], [st.lon, st.lat])).toBeLessThan(1)
    }
    const mid = plan.stateAt(26.1) // S1 dwell 11.1..41.1
    expect(mid.phase).toBe('dwell')
    expect(mid.station).toBe('S1')
    expect(mid.dwellFrac).toBeCloseTo(0.5, 6)
    expect(mid.headingDeg).toBeCloseTo(0, 3) // faces the way it arrived (walking north)
  })
  it('walks north on leg 1 at uniform speed', () => {
    const p = plan.stateAt(11.1 / 2)
    expect(p.phase).toBe('walk')
    expect(p.headingDeg).toBeCloseTo(0, 3)
    expect(tHome.distanceM([p.lon, p.lat], plan.start)).toBeCloseTo(300, -1)
  })
  it('interpolates series and holds the ends', () => {
    expect(interpSeries([[0, 10], [10, 0]], 2.5)).toBeCloseTo(7.5)
    expect(interpSeries([[0, 10], [10, 0]], -1)).toBe(10)
    expect(interpSeries([[0, 10], [10, 0]], 11)).toBe(0)
    expect(interpSeries([], 1)).toBeNull()
  })
  it('refuses a route/timeline mismatch', () => {
    expect(() => new Plan({ ...route, features: route.features.slice(1) }, timeline, tHome)).toThrow()
  })
  it('an empty route (no reachable station) stays at the pad', () => {
    const tl: TimelineEvent[] = [
      { t_min: 0, event: 'depart', station: null, o2_left_L: 504, t_home_min: 0, margin_min: 85.9, margin_binding: 'dose' },
      { t_min: 0, event: 'return', station: null, o2_left_L: 504, t_home_min: 0, margin_min: 85.9, margin_binding: 'dose' },
    ]
    const p = new Plan({ type: 'FeatureCollection', features: [] }, tl, tHome, [137.382, -4.806])
    expect(p.legs).toEqual([])
    const s = p.stateAt(100)
    expect([s.lon, s.lat]).toEqual([137.382, -4.806])
    expect(p.bindingAt(10)).toBe('dose')
    expect(p.headroomAt(50)).toBeCloseTo(85.9, 9)
  })
  it('follows per-vertex times_min (WS2 v1.1.0) instead of uniform speed', () => {
    // leg 1: 61 vertices over 600 m; make the first half take 9 of the 11.1 min
    const f0 = route.features[0]
    const n = (f0.geometry.coordinates as number[][]).length
    const times = Array.from({ length: n }, (_, k) => (k <= 30 ? (9 * k) / 30 : 9 + (2.1 * (k - 30)) / (n - 1 - 30)))
    const r2: RouteFC = { ...route, features: [{ ...f0, properties: { ...f0.properties, times_min: times } }, ...route.features.slice(1)] }
    const p = new Plan(r2, timeline, tHome)
    expect(tHome.distanceM(...[[p.stateAt(9).lon, p.stateAt(9).lat], p.start] as [[number, number], [number, number]])).toBeCloseTo(300, 0)
    expect(tHome.distanceM([p.stateAt(4.5).lon, p.stateAt(4.5).lat], p.start)).toBeCloseTo(150, 0)
    // a times_min of the wrong length is ignored (uniform speed)
    const r3: RouteFC = { ...route, features: [{ ...f0, properties: { ...f0.properties, times_min: [0, 1] } }, ...route.features.slice(1)] }
    expect(new Plan(r3, timeline, tHome).legs[0].times).toBeNull()
  })
  it('binding is undefined when the timeline has no margin_binding (M0 dummy)', () => {
    expect(new Plan(route, timeline, tHome).bindingAt(20)).toBeUndefined()
  })
})

describe('HUD logic KATs (SPEC §9)', () => {
  const ctx = ctxFor(timeline)
  it('T_home = 0 at the pad', () => {
    const r = computeReadout(playbackPosition(ctx.plan, 0), ctx)
    expect(r.tHomeMin).toBe(0)
    expect(r.distanceM).toBe(0)
  })
  it('along the route, HUD T_home and margin equal the timeline within 0.5 min', () => {
    for (const ev of timeline) {
      const r = computeReadout(playbackPosition(ctx.plan, ev.t_min), ctx)
      expect(Math.abs(r.tHomeMin! - ev.t_home_min!)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(r.marginMin! - ev.margin_min!)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(r.o2LeftL! - ev.o2_left_L!)).toBeLessThanOrEqual(1e-9)
    }
  })
  it('home bearing at S1 (due north of the pad) points south', () => {
    const r = computeReadout(playbackPosition(ctx.plan, 20), ctx)
    expect(r.bearingDeg).toBeCloseTo(180, 0)
    expect(r.distanceM).toBeCloseTo(600, 0)
    expect(r.nextStation).toEqual({ station: 'S2', etaMin: expect.closeTo(41.1, 6) })
  })
  it('the dummy EVA raises only alarm 5, exactly while beyond the partner line (S3)', () => {
    // dummy partner line: circle of 0.4 x 60-min radius = 0.4 * 0.9 m/s * 3600 s = 1296 m
    const stations = readJson<{ id: string; in_partner_line: boolean }[]>('stations.json')
    expect(stations.find((s) => s.id === 'S3')!.in_partner_line).toBe(false)
    let fired = 0
    for (let t = 0; t <= ctx.plan.tEnd; t += 0.5) {
      const r = computeReadout(playbackPosition(ctx.plan, t), ctx)
      if (r.alarm && r.alarm.rule !== 5) throw new Error(`unexpected alarm at t=${t}: ${r.alarm.text}`)
      if (r.distanceM < 1290) expect(r.alarm).toBeNull()
      if (r.distanceM > 1302) expect(r.alarm?.rule).toBe(5)
      if (r.alarm) fired++
    }
    expect(fired).toBeGreaterThan(0)
    const atS3 = computeReadout(playbackPosition(ctx.plan, 130), ctx)
    expect(atS3.outsidePartner).toBe(true)
  })

  it('alarms fire at the times the timeline predicts (synthetic tight timeline)', () => {
    // Dummy headroom is 360 - t; shift it by -340 -> margin_min goes 20 -> -2.2 over leg 1.
    // Timeline interpolation predicts margin < 10 after t = 5.0 and < 0 after t = 10.0.
    const tight = timeline.map((e) => ({ ...e, margin_min: e.margin_min! - 340 }))
    const c = ctxFor(tight)
    const first = (rule: number) => {
      for (let t = 0; t <= 11.1; t += 0.01) {
        if (computeReadout(playbackPosition(c.plan, t), c).alarm?.rule === rule) return t
      }
      return null
    }
    expect(first(4)).toBeCloseTo(5.0, 0)
    expect(Math.abs(first(4)! - 5.0)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(first(1)! - 10.0)).toBeLessThanOrEqual(0.5)
    const r = computeReadout(playbackPosition(c.plan, 7), c)
    expect(r.alarm?.text).toBe(turnBackText(r.marginMin!))
    expect(r.band).toBe('amber')
  })
})

describe('alarm rules (first match wins)', () => {
  const base: AlarmInput = { marginMin: 60, tripwireFired: false, tHomeMin: 10, tauDoseMin: null, circleCrossesHomeline: false, outsidePartner: false }
  const amber = 10
  it('each rule alone', () => {
    expect(evaluateAlarm(base, amber)).toBeNull()
    expect(evaluateAlarm({ ...base, marginMin: -0.1 }, amber)).toMatchObject({ rule: 1, level: 'red', text: ALARM_TEXT[1] })
    expect(evaluateAlarm({ ...base, tripwireFired: true, tauDoseMin: 10 }, amber)).toMatchObject({ rule: 2, level: 'red' })
    expect(evaluateAlarm({ ...base, tripwireFired: true, tauDoseMin: 10.1 }, amber)).toBeNull()
    expect(evaluateAlarm({ ...base, circleCrossesHomeline: true }, amber)).toMatchObject({ rule: 3, level: 'amber' })
    expect(evaluateAlarm({ ...base, marginMin: 9.9 }, amber)).toMatchObject({ rule: 4, level: 'amber', text: 'TURN-BACK IN 9 MIN' })
    expect(evaluateAlarm({ ...base, marginMin: 10 }, amber)).toBeNull()
    expect(evaluateAlarm({ ...base, outsidePartner: true }, amber)).toMatchObject({ rule: 5, level: 'info' })
  })
  it('order 1 > 2 > 3 > 4 > 5', () => {
    const all: AlarmInput = { marginMin: -1, tripwireFired: true, tHomeMin: 20, tauDoseMin: 5, circleCrossesHomeline: true, outsidePartner: true }
    expect(evaluateAlarm(all, amber)?.rule).toBe(1)
    expect(evaluateAlarm({ ...all, marginMin: 5 }, amber)?.rule).toBe(2)
    expect(evaluateAlarm({ ...all, marginMin: 5, tripwireFired: false }, amber)?.rule).toBe(3)
    expect(evaluateAlarm({ ...all, marginMin: 5, tripwireFired: false, circleCrossesHomeline: false }, amber)?.rule).toBe(4)
    expect(evaluateAlarm({ ...all, marginMin: 50, tripwireFired: false, circleCrossesHomeline: false }, amber)?.rule).toBe(5)
  })
  it('unknown inputs never fire', () => {
    expect(evaluateAlarm({ ...base, marginMin: null, outsidePartner: null }, amber)).toBeNull()
  })
  it('band colours', () => {
    expect(marginBand(10.1, amber)).toBe('green')
    expect(marginBand(10, amber)).toBe('amber')
    expect(marginBand(0, amber)).toBe('amber')
    expect(marginBand(-0.1, amber)).toBe('red')
    expect(marginBand(null, amber)).toBe('unknown')
  })
})

describe('position uncertainty (F19)', () => {
  it('picks the smallest precomputed radius >= sigma', () => {
    const radii = cfg.worstCaseRadiiM // [10, 50, 100]
    expect(pickWorstRadius(0, radii)).toBe(0)
    expect(pickWorstRadius(4, radii)).toBe(10)
    expect(pickWorstRadius(10, radii)).toBe(10)
    expect(pickWorstRadius(10.5, radii)).toBe(50)
    expect(pickWorstRadius(100, radii)).toBe(100)
    expect(pickWorstRadius(101, radii)).toBeNull()
  })
  it('worst-case readout >= point readout and unknown beyond the largest radius', () => {
    const ctx = ctxFor(timeline)
    const p = playbackPosition(ctx.plan, 100)
    const point = computeReadout(p, ctx)
    let prev = point.tHomeMin!
    for (const s of [5, 30, 80]) {
      const r = computeReadout({ ...p, sigma_m: s }, ctx)
      expect(r.tHomeMin!).toBeGreaterThanOrEqual(prev)
      prev = r.tHomeMin!
    }
    expect(computeReadout({ ...p, sigma_m: 150 }, ctx).tHomeMin).toBeNull()
  })

  it('alarm 3 fires exactly when the circle crosses the band (synthetic, 1 m pixels)', () => {
    // field value = distance (m) from the centre pixel; homeline budget 30 -> circle of 30 m
    const N = 121
    const c0 = 60
    const rgba = new Uint8Array(N * N * 4)
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const d = Math.round(Math.hypot(r - c0, c - c0) * 10)
        const j = (r * N + c) * 4
        rgba[j] = d >> 8
        rgba[j + 1] = d & 255
        rgba[j + 3] = 255
      }
    const g = new FieldGrid({ bounds: [0, 0, N, N], width: N, height: N, res_m: 1 }, decodeRGBA(rgba, N, N, 0.1))
    const budget = 30
    for (const d of [0, 12, 20, 27]) {
      const [lon, lat] = g.lonLatOf(c0, c0 + d) // d metres east of the centre
      const cross = budget - d // analytic: the circle touches the homeline at sigma = budget - d
      expect(circleCrossesHomeline(g, lon, lat, cross - 1, budget)).toBe(false)
      expect(circleCrossesHomeline(g, lon, lat, cross + 1, budget)).toBe(true)
    }
    const [lon, lat] = g.lonLatOf(c0, c0 + 20)
    expect(circleCrossesHomeline(g, lon, lat, 0, budget)).toBe(false) // exact position: no circle
  })
})

describe('partner polygon', () => {
  it('pad inside, far corner outside', () => {
    expect(insidePolygons(partner, 137.382, -4.806)).toBe(true)
    expect(insidePolygons(partner, 137.32, -4.75)).toBe(false)
  })
})

describe('D28 turn-back binding (contract v1.1.3: margin_binding may be "EVA duration")', () => {
  // the dummy timeline with WS2-style bindings: EVA duration binds late in the walk, plus the
  // turn_back annotation rows (latest leave per station, margin 0)
  const bound: TimelineEvent[] = [
    ...timeline.map((e) => ({ ...e, margin_binding: (e.t_min >= 122 ? 'EVA duration' : e.t_min >= 61.1 ? 'O2' : 'dose') as TimelineEvent['margin_binding'] })),
    { t_min: 378.9, event: 'turn_back', station: 'S1', o2_left_L: 140, t_home_min: 11.1, margin_min: 0, margin_binding: 'EVA duration' },
    { t_min: 364.1, event: 'turn_back', station: 'S3', o2_left_L: 150, t_home_min: 25.9, margin_min: 0, margin_binding: 'O2' },
  ]
  const ctx = ctxFor(bound)
  it('the binding row reads the term in force, incl. "EVA duration"', () => {
    expect(ctx.plan.bindingAt(5)).toBe('dose')
    expect(ctx.plan.bindingAt(70)).toBe('O2')
    expect(ctx.plan.bindingAt(130)).toBe('EVA duration')
    expect(computeReadout(playbackPosition(ctx.plan, 130), ctx).binding).toBe('EVA duration')
    expect(bindingLabel('EVA duration')).toBe('EVA duration')
    expect(bindingLabel('O2')).toBe('O₂')
    expect(bindingLabel('dose')).toBe('dose')
    expect(bindingLabel('daylight')).toBe('daylight')
    expect(bindingLabel(null)).toBe('unknown')
    expect(bindingLabel(undefined)).toBe('—')
  })
  it('turn_back rows are per-station annotations: latest leave and its binding', () => {
    expect(ctx.plan.turnBackAt('S1')).toEqual({ station: 'S1', t_min: 378.9, binding: 'EVA duration' })
    expect(ctx.plan.turnBackAt('S3')).toEqual({ station: 'S3', t_min: 364.1, binding: 'O2' })
    expect(ctx.plan.turnBackAt('S2')).toBeNull()
    // still never steps of the walk
    expect(ctx.plan.tEnd).toBe(177.9)
  })
  it('readout: during a dwell the station turn-back row is shown, else none', () => {
    const atS1 = computeReadout(playbackPosition(ctx.plan, 20), ctx) // S1 dwell 11.1-41.1
    expect(atS1.latestLeave).toEqual({ station: 'S1', t_min: 378.9, binding: 'EVA duration' })
    expect(computeReadout(playbackPosition(ctx.plan, 50), ctx).latestLeave).toBeNull() // walking
    expect(computeReadout(playbackPosition(ctx.plan, 100), ctx).latestLeave).toBeNull() // S2: no row
  })
  it('turn-back sub-line names the binding term (D28)', () => {
    const r = computeReadout(playbackPosition(ctx.plan, 20), ctx)
    expect(turnBackSub(r)).toBe('bound by dose · S1 latest leave T+6:18:54 (EVA duration)')
    const w = computeReadout(playbackPosition(ctx.plan, 160), ctx) // walking home after S3
    expect(turnBackSub(w)).toBe('bound by EVA duration')
    const none = computeReadout(playbackPosition(ctxFor(timeline).plan, 20), ctxFor(timeline))
    expect(turnBackSub(none)).toBe('')
  })
})

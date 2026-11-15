// D39 storm placement (config/conditions.yaml storm_replay; F14, F18). Mirrors WS4's KATs in
// pipeline/conditions/test_storm_replay.py one for one (same invented inputs, same answers), then
// checks the HUD's use of it: the tripwire fires at t* whenever the switch is turned on.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tripRowText } from './panel'
import { readoutSources } from './provenance'
import { computeReadout, type HudContext } from './readout'
import { Plan } from './plan'
import {
  evaMinOf,
  parseStormReplayConfig,
  radiationInput,
  routeTHomeSeries,
  stormOffsetUtcMs,
  stormReplay,
  stormState,
  stormUtcAtMs,
  tripwireTargetMin,
} from './storm'
import { dummyGrid, loadConditionsYaml, loadConfig, readJson, REPO } from './testutil'
import type { Rad, RouteFC, TimelineEvent } from './types'

const TRIP = Date.parse('2024-05-20T05:57:07Z')
const ONSET = Date.parse('2024-05-20T05:15:52Z')
const PEAK = Date.parse('2024-05-20T06:19:52Z')
const MIN = 60000

describe('D39 storm_replay key (mirrors test_storm_replay.py)', () => {
  it('config key is the D39 rule', () => {
    const s = parseStormReplayConfig(loadConditionsYaml())
    expect(s.tripwireAt).toBe('route_max_t_home')
    expect(s.anchorEvent).toBe('tripwire')
    expect(s.evaClockUnits).toBe('min')
    expect(s.tieBreak).toBe('first')
    expect(loadConfig().stormReplay).toEqual(s)
  })
  it('other rules are refused', () => {
    const bad = structuredClone(loadConditionsYaml()) as { storm_replay: Record<string, unknown> }
    bad.storm_replay.tripwire_at = 'eva_start'
    expect(() => parseStormReplayConfig(bad)).toThrow(/storm_replay.tripwire_at/)
    const bad2 = structuredClone(loadConditionsYaml()) as { storm_replay: Record<string, unknown> }
    bad2.storm_replay.tie_break = 'last'
    expect(() => parseStormReplayConfig(bad2)).toThrow(/tie_break/)
    expect(() => parseStormReplayConfig({})).toThrow(/storm_replay/)
  })
  it('target is argmax T_home', () => {
    const t = [0, 30, 60, 90, 120, 150, 180, 210, 240]
    const th = [0, 20, 45, 70, 95, 120, 100, 60, 0]
    expect(tripwireTargetMin(t, th)).toBe(150)
  })
  it('tie takes the first; unknown skipped; all unknown -> null; length mismatch refused', () => {
    expect(tripwireTargetMin([0, 10, 20, 30], [5, 9, 9, 1])).toBe(10)
    expect(tripwireTargetMin([0, 10, 20], [null, 3, null])).toBe(10)
    expect(tripwireTargetMin([0, 10], [null, null])).toBeNull()
    expect(() => tripwireTargetMin([0, 10], [1])).toThrow()
  })
  it('offset and mapping round trip', () => {
    const tStar = 150
    const z = stormOffsetUtcMs(TRIP, tStar) // storm UTC at EVA minute 0
    expect(z).toBe(TRIP - 150 * MIN)
    expect(stormUtcAtMs(tStar, TRIP, tStar)).toBe(TRIP) // tripwire fires at t*
    expect(stormUtcAtMs(0, TRIP, tStar)).toBe(z)
    expect(evaMinOf(TRIP, TRIP, tStar)).toBeCloseTo(tStar, 9)
    // onset 41.25 min before the tripwire -> EVA minute 108.75
    expect(evaMinOf(ONSET, TRIP, tStar)).toBeCloseTo(150 - 41.25, 9)
    expect(evaMinOf(PEAK, TRIP, tStar)).toBeCloseTo(150 + 22.75, 9)
  })
  it('replay from a rad dict', () => {
    const rad = { storm_2024: { series: [], tripwire_utc: '2024-05-20T05:57:07Z', onset_utc: '2024-05-20T05:15:52Z', peak_utc: '2024-05-20T06:19:52Z' }, leash: { D_allow_mGy: 0.5, tau_min_at_peak: 85.9 } } as unknown as Rad
    const r = stormReplay(rad, [0, 60, 120, 180], [0, 50, 80, 10])!
    expect(r.tripwireEvaMin).toBe(120)
    expect(r.onsetEvaMin).toBeCloseTo(120 - 41.25, 9)
    expect(r.peakEvaMin).toBeCloseTo(120 + 22.75, 9)
    expect(new Date(r.stormUtcAtEvaStartMs).toISOString()).toBe('2024-05-20T03:57:07.000Z')
    expect(r.rule).toBe('route_max_t_home')
    expect(r.tauDoseMin).toBe(85.9)
  })
  it('unknown stays unknown', () => {
    const none = { storm_2024: { series: [], tripwire_utc: null, onset_utc: null }, leash: { D_allow_mGy: 0.5, tau_min_at_peak: 85.9 } } as unknown as Rad
    expect(stormReplay(none, [0, 60], [0, 50])).toBeNull()
    const trip = { storm_2024: { series: [], tripwire_utc: '2024-05-20T05:57:07Z', onset_utc: null }, leash: { D_allow_mGy: 0.5, tau_min_at_peak: 85.9 } } as unknown as Rad
    expect(stormReplay(trip, [0], [null])).toBeNull() // no route T_home -> no t*
    const r = stormReplay(trip, [0, 60], [0, 50])!
    expect(r.tripwireEvaMin).toBe(60)
    expect(r.onsetEvaMin).toBeNull()
    expect(r.peakEvaMin).toBeNull()
    expect(stormReplay(null, [0], [0])).toBeNull()
    const noTau = { ...trip, leash: { D_allow_mGy: 0.5, tau_min_at_peak: null } } as Rad
    expect(stormReplay(noTau, [0, 60], [0, 50])).toBeNull()
  })
})

describe('HUD storm replay on the EVA clock (D39)', () => {
  const cfg = loadConfig()
  const route = readJson<RouteFC>('route_nom_104.geojson')
  const timeline = readJson<TimelineEvent[]>('timeline_nom_104.json')
  const tHome = dummyGrid('nom_104/t_home')
  const plan = new Plan(route, timeline, tHome)
  const rad = readJson<Rad>('conditions/rad.json')
  const series = routeTHomeSeries(plan, tHome)
  const rep = stormReplay(rad, series.evaMin, series.tHomeMin)!

  it("samples WS2's timeline rows along the walk (turn_back annotations excluded)", () => {
    expect(series.evaMin).toEqual(plan.events.map((e) => e.t_min))
    expect(series.tHomeMin).toEqual(plan.events.map((e) => e.t_home_min))
    expect(plan.events.some((e) => e.event === 'turn_back')).toBe(false)
  })
  it('t* = the EVA minute of the largest route T_home (first on a tie)', () => {
    // M0 dummy: T_home 25.9 at S3 from arrive (122) to leave (152) -> the first, 122
    expect(rep.tripwireEvaMin).toBe(122)
    const max = Math.max(...series.tHomeMin.filter((v): v is number => v !== null))
    expect(series.tHomeMin[series.evaMin.indexOf(rep.tripwireEvaMin)]).toBe(max)
  })
  it('the tripwire fires at t* whenever the switch is turned on', () => {
    const t = rep.tripwireEvaMin
    expect(stormState(rep, t - 0.01).fired).toBe(false)
    expect(stormState(rep, t).fired).toBe(true)
    expect(stormState(rep, t).tFire).toBe(t)
    const s = stormState(rep, t + 10)
    expect(s.doseLeftMin).toBeCloseTo(rad.leash.tau_min_at_peak! - 10, 9)
    expect(stormState(null, 100).on).toBe(false)
  })
  it('the onset sits at t* - (tripwire - onset) on the EVA clock', () => {
    const delay = (Date.parse(rad.storm_2024!.tripwire_utc!) - Date.parse(rad.storm_2024!.onset_utc!)) / MIN
    expect(rep.onsetEvaMin!).toBeCloseTo(rep.tripwireEvaMin - delay, 9)
  })
  it('alarm 2 fires exactly when T_home >= dose budget left (after the tripwire)', () => {
    const ctx: HudContext = { cfg, fields: { tHome }, plan, budgetMin: cfg.walkbackBudgetsMin[0], pad: plan.start }
    const at = (pos: { lon: number; lat: number }, t: number) =>
      computeReadout({ ...pos, sigma_m: 0, source: 'playback', t_eva_min: t, last_fix: null }, { ...ctx, radiation: radiationInput(stormState(rep, t)) })
    const p = plan.stateAt(rep.tripwireEvaMin + 1) // dwell at the t* station
    const th = tHome.valueAt(p.lon, p.lat)!
    const tPred = rep.tripwireEvaMin + rad.leash.tau_min_at_peak! - th
    expect(at(p, tPred - 0.05).alarm?.rule).not.toBe(2)
    expect(at(p, tPred + 0.05).alarm?.rule).toBe(2)
    expect(at(p, tPred + 0.05).alarm?.text).toBe('RADIATION: HEAD HOME')
  })
  it('carries the tripwire ± label from rad.json (D35), null when absent', () => {
    expect(rep.halfwidthLabel).toBeNull() // the M0 dummy rad.json has none
    const withLabel = { ...rad, storm_2024: { ...rad.storm_2024!, tripwire_halfwidth_label: '± 9 min' } }
    expect(stormReplay(withLabel, series.evaMin, series.tHomeMin)!.halfwidthLabel).toBe('± 9 min')
  })
  it('tripwire row: fire time on the EVA clock with the ± label, then the dose budget', () => {
    const r = { ...rep, tripwireEvaMin: 108.86, halfwidthLabel: '± 9 min', tauDoseMin: 85.9 }
    expect(tripRowText(stormState(r, 50), rad)).toEqual({ value: 'armed: fires T+1:48:52 ± 9 min', sub: "storm replay at the route's largest T_home · τ at 2024 peak 86 min", band: '' })
    expect(tripRowText(stormState(r, 118.86), rad)).toEqual({ value: 'FIRED T+1:48:52 ± 9 min', sub: 'dose budget left 76 min (τ at 2024 peak 86 min)', band: 'red' })
    expect(tripRowText(stormState({ ...r, halfwidthLabel: null }, 50), rad).value).toBe('armed: fires T+1:48:52') // no label in rad.json: none shown
    expect(tripRowText(stormState(null, 50), rad).value).toBe('not fired')
  })
  it('trip row provenance cites the tripwire, ± label and route T_home when the replay is on', () => {
    const r0 = computeReadout({ lon: plan.start[0], lat: plan.start[1], sigma_m: 0, source: 'playback', t_eva_min: 0, last_fix: null }, { cfg, fields: { tHome }, plan, budgetMin: 60, pad: plan.start })
    expect(readoutSources(r0, { scenario: 'nom_104' }).trip.keys).toEqual(['rad.leash.tau_min_at_peak'])
    const on = readoutSources(r0, { scenario: 'nom_104', storm: stormState({ ...rep, halfwidthLabel: '± 9 min' }, 0) }).trip
    expect(on.keys).toEqual(['rad.storm_2024.tripwire_utc', 'rad.storm_2024.tripwire_halfwidth_label', 'rad.leash.tau_min_at_peak', 'fields.nom_104/t_home.sha256'])
    expect(on.files).toContain('config/conditions.yaml')
    expect(readoutSources(r0, { scenario: 'nom_104', storm: stormState(rep, 0) }).trip.keys).not.toContain('rad.storm_2024.tripwire_halfwidth_label')
  })
  it('an empty route gives no placement (unknown, switch disabled)', () => {
    const tl: TimelineEvent[] = [
      { t_min: 0, event: 'depart', station: null, o2_left_L: 504, t_home_min: 0, margin_min: 85.9 },
      { t_min: 0, event: 'return', station: null, o2_left_L: 504, t_home_min: 0, margin_min: 85.9 },
    ]
    const p = new Plan({ type: 'FeatureCollection', features: [] }, tl, tHome, plan.start)
    const s = routeTHomeSeries(p, tHome)
    expect(s.evaMin).toEqual([])
    expect(stormReplay(rad, s.evaMin, s.tHomeMin)).toBeNull()
  })
})

const REAL_RAD = resolve(REPO, 'data/interim/conditions/rad.json')
describe.skipIf(!existsSync(REAL_RAD))('real rad.json (WS4 session 2): ± label', () => {
  it('shows "± 9 min" from storm_2024.tripwire_halfwidth_label', () => {
    const rad = readJson<Rad>('conditions/rad.json', resolve(REPO, 'data/interim'))
    const r = stormReplay(rad, [0, 60, 120], [0, 50, 10])!
    expect(r.halfwidthLabel).toBe(rad.storm_2024!.tripwire_halfwidth_label)
    expect(r.halfwidthLabel).toBe('± 9 min')
    expect(r.onsetEvaMin!).toBeCloseTo(60 - 41.25, 9)
    expect(r.peakEvaMin!).toBeCloseTo(60 + 22.75, 9)
  })
})

const REAL_TL = resolve(REPO, 'data/interim/engine/public/timeline_nom_104.json')
const REAL_ROUTE = resolve(REPO, 'data/interim/engine/public/route_nom_104.geojson')
describe.skipIf(!existsSync(REAL_TL) || !existsSync(REAL_ROUTE) || !existsSync(REAL_RAD))('real nom_104: D39 t* from WS2 timeline', () => {
  it('t* = first maximum of the real timeline T_home (WS2 session 7: 44.39 min, arrive S7)', () => {
    const pub = resolve(REPO, 'data/interim/engine/public')
    const tl = readJson<TimelineEvent[]>('timeline_nom_104.json', pub)
    const plan = new Plan(readJson<RouteFC>('route_nom_104.geojson', pub), tl, dummyGrid('nom_104/t_home'))
    const s = routeTHomeSeries(plan)
    const rows = tl.filter((e) => e.event !== 'turn_back' && e.t_home_min !== null)
    const max = Math.max(...rows.map((e) => e.t_home_min!))
    const first = rows.find((e) => e.t_home_min === max)!
    const r = stormReplay(readJson<Rad>('conditions/rad.json', resolve(REPO, 'data/interim')), s.evaMin, s.tHomeMin)!
    expect(r.tripwireEvaMin).toBe(first.t_min)
  })
})

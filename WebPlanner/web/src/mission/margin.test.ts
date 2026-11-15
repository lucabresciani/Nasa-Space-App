import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Rad } from '../data/types'
import { decodeRGBA, fieldGrid, FieldGrid } from '../hud/fields'
import type { FieldsIndex, TimelineEvent } from '../hud/types'
import { BUDGET_CONSTANTS } from './budget'
import { tDarkOf } from './data'
import {
  bindingOf,
  buildTrack,
  doseTimingFromRad,
  interp,
  legProfile,
  marginInputs,
  marginProfile,
  marginTerms,
  missionMargin,
  STORM_REPLAY,
  tauDoseAt,
  tauDoseFromRate,
  tStar,
  uGyDayToMgyH,
  type DoseTiming,
  type LegProfile,
  type MarginInputs,
  type Term,
} from './margin'
import { decodePngRGBA } from './pngNode'

const PUB = resolve(__dirname, '../../public/data')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const J = (p: string): any => JSON.parse(readFileSync(resolve(PUB, p), 'utf8'))
const golden = J('physio/golden.json')
const rad = J('conditions/rad.json') as Rad
const STATION_RATE = BUDGET_CONSTANTS.stationRateLMin

describe('margin terms: engine golden vectors (physio/golden.json cases.margin, margin.py)', () => {
  for (const c of golden.cases.margin) {
    it(c.id, () => {
      const g = c.inputs.margin_inputs
      const mi: MarginInputs = {
        o2CapacityL: g.o2_capacity_L,
        reserveL: g.reserve_L,
        effortRateLMin: g.effort_rate_L_min,
        stationRateLMin: g.task_rate_L_min,
        evaBudgetMin: g.eva_budget_min,
        tDarkMin: g.t_dark_min,
        tauDoseMin: g.tau_dose_min,
        dose: null,
      }
      const terms = marginTerms(mi, { tMin: c.inputs.t_min, o2UsedL: c.inputs.o2_used_L, tHomeMin: c.inputs.t_home_min, o2HomeL: c.inputs.o2_home_L, tasksLeftL: c.inputs.tasks_left_L })
      const tol = golden.tolerances.margin.abs
      for (const [k, v] of Object.entries(c.expected.terms_min)) expect(Math.abs(terms[k as Term]! - (v as number))).toBeLessThanOrEqual(tol)
      const b = bindingOf(terms)
      expect(b.binding).toBe(c.expected.binding)
      expect(Math.abs(b.marginMin - c.expected.margin_min)).toBeLessThanOrEqual(tol)
    })
  }

  it('config inputs equal the golden ones (crew.yaml via budget.ts)', () => {
    const g = golden.cases.margin[0].inputs.margin_inputs
    const mi = marginInputs()
    expect(mi.o2CapacityL).toBeCloseTo(g.o2_capacity_L, 6)
    expect(mi.reserveL).toBeCloseTo(g.reserve_L, 9)
    expect(mi.effortRateLMin).toBeCloseTo(g.effort_rate_L_min, 9)
    expect(mi.stationRateLMin).toBeCloseTo(g.task_rate_L_min, 6)
    expect(mi.evaBudgetMin).toBe(g.eva_budget_min)
  })

  it('a missing input leaves its term out; ties keep the engine order', () => {
    const mi = marginInputs({ eva: false })
    const t = marginTerms(mi, { tMin: 0, o2UsedL: 0, tHomeMin: 0, o2HomeL: 0, tasksLeftL: 0 })
    expect(Object.keys(t)).toEqual(['O2'])
    expect(bindingOf({ O2: 5, dose: 5, 'EVA duration': 5 }).binding).toBe('O2')
    expect(bindingOf({ dose: 5, 'EVA duration': 5 }).binding).toBe('dose')
  })
})

describe('dose leash (golden.json cases.dose_leash; tau = 60 D_allow / Ddot)', () => {
  for (const c of golden.cases.dose_leash) {
    it(c.id, () => {
      const r = uGyDayToMgyH(c.inputs.Ddot_uGy_per_day)
      expect(r).toBeCloseTo(c.expected.Ddot_mGy_per_h, 8)
      const tau = tauDoseFromRate(c.inputs.D_allow_mGy, r)
      expect(Math.abs(tau - c.expected.tau_dose_min) / c.expected.tau_dose_min).toBeLessThanOrEqual(1e-9)
    })
  }

  it('interp is numpy.interp: linear inside, clamped outside', () => {
    expect(interp(5, [0, 10], [1, 3])).toBe(2)
    expect(interp(-1, [0, 10], [1, 3])).toBe(1)
    expect(interp(99, [0, 10], [1, 3])).toBe(3)
    expect(interp(10, [0, 10, 20], [1, 3, 0])).toBe(3)
    expect(interp(15, [0, 10, 20], [1, 3, 0])).toBe(1.5)
  })
})

describe('storm replay (D39, conditions.yaml storm_replay + WS4 rad.json)', () => {
  it('reads the shared key as the engine does', () => {
    expect(STORM_REPLAY.tripwire_at).toBe('route_max_t_home')
    expect(() => doseTimingFromRad(0, rad, { tripwire_at: 'fixed' })).toThrow(/not implemented/)
    expect(() => doseTimingFromRad(0, rad, { tripwire_at: 'route_max_t_home', tie_break: 'last' })).toThrow(/tie_break/)
  })

  it('tau at t* is the engine value for the official route (manifest route.nom_104.dose)', () => {
    const m = J('manifest.json')
    const tStarMin = m['route.nom_104.dose.t_star_min'].value
    const dt = doseTimingFromRad(tStarMin, rad)
    expect(dt.dAllowMgy).toBe(rad.leash.D_allow_mGy)
    expect(dt.evaMin.length).toBe(rad.storm_2024.series.filter(([, v]) => v !== null).length)
    expect(tauDoseAt(dt, tStarMin)).toBeCloseTo(m['route.nom_104.dose.tau_at_t_star_min'].value, 2)
  })

  it('the tripwire always lands at t*, so tau(t*) does not depend on the route (picker pad, same value)', () => {
    const s = J('scenarios/pads/pad_default/summary.json').route.dose
    expect(tauDoseAt(doseTimingFromRad(s.t_star_min, rad), s.t_star_min)).toBeCloseTo(s.tau_at_t_star_min, 2)
    expect(tauDoseAt(doseTimingFromRad(10, rad), 10)).toBeCloseTo(tauDoseAt(doseTimingFromRad(200, rad), 200), 9)
  })

  it('the storm peak gives the published shortest leash (rad.json leash.tau_min_at_peak)', () => {
    const dt = doseTimingFromRad(0, rad)
    const shortest = Math.min(...dt.rateMgyH.map((r) => tauDoseFromRate(dt.dAllowMgy, r)))
    expect(shortest).toBeCloseTo(rad.leash.tau_min_at_peak!, 1)
  })
})

/** A leg on the clock with constant T_home / O2_home deltas (synthetic). */
function leg(tMin: number[], o2L: number[], tHome: number[], o2Home: number[]): LegProfile {
  return { tMin, o2L, tHomeMin: tHome, o2HomeL: o2Home }
}

describe('EVA track (pad -> legs -> stops -> walk home)', () => {
  const legs = [leg([0, 5, 10], [0, 6, 12], [5, 8, 12], [6, 9, 14]), leg([0, 4], [0, 5], [12, 15], [14, 18])]

  it('samples, stops and the walk home', () => {
    const tr = buildTrack(legs, [20, 0])!
    expect(tr.map((s) => s.phase)).toEqual(['depart', 'walk', 'arrive', 'leave', 'arrive', 'return'])
    expect(tr.map((s) => s.tMin)).toEqual([0, 5, 10, 30, 34, 49])
    const arrive1 = tr[2]
    expect(arrive1.wp).toBe(0)
    expect(arrive1.tasksLeftL).toBeCloseTo(20 * STATION_RATE, 12) // station work still to do
    expect(tr[3].tasksLeftL).toBe(0)
    expect(tr[3].o2UsedL).toBeCloseTo(12 + 20 * STATION_RATE, 12)
    expect(tr[4].o2UsedL).toBeCloseTo(17 + 20 * STATION_RATE, 12)
    const ret = tr[5]
    expect(ret.tHomeMin).toBe(0)
    expect(ret.o2UsedL).toBeCloseTo(17 + 20 * STATION_RATE + 18, 12) // + O2_home of the last waypoint
  })

  it('no waypoints: depart and return at the pad', () => {
    expect(buildTrack([], []))!.toEqual([
      { tMin: 0, o2UsedL: 0, tHomeMin: 0, o2HomeL: 0, tasksLeftL: 0, phase: 'depart', wp: null },
      { tMin: 0, o2UsedL: 0, tHomeMin: 0, o2HomeL: 0, tasksLeftL: 0, phase: 'return', wp: null },
    ])
  })

  it('a missing leg or an unknown value makes the track unknown', () => {
    expect(buildTrack([legs[0], null], [0, 0])).toBeNull()
    expect(buildTrack([leg([0, 1], [0, 1], [1, NaN], [1, 1])], [0])).toBeNull()
  })

  it('t* is the first sample with the largest T_home (tie_break first)', () => {
    const tr = buildTrack([leg([0, 5, 10], [0, 1, 2], [3, 9, 9], [1, 1, 1])], [10])!
    expect(tStar(tr)).toBe(5)
  })

  it('legProfile: router cells -> minutes, cumulative O2, WS2 values per cell', () => {
    const lp = legProfile({ cells: [1, 2, 3], timeS: 120, o2L: 3, distM: 10, tauS: [0, 60, 120], o2CumL: [0, 1, 3] }, (c) => ({ tHomeMin: c * 10, o2HomeL: c }))!
    expect(Array.from(lp.tMin)).toEqual([0, 1, 2])
    expect(Array.from(lp.o2L)).toEqual([0, 1, 3])
    expect(Array.from(lp.tHomeMin)).toEqual([10, 20, 30])
    expect(legProfile({ cells: [1], timeS: 0, o2L: 0, distM: 0, tauS: [0], o2CumL: [0] }, () => ({ tHomeMin: 1, o2HomeL: null }))).toBeNull()
  })
})

describe('margin profile: dose inside stops and on the walk home', () => {
  // Storm: rate rises 0.1 -> 0.5 mGy/h from minute 20 to 40, falls back by minute 60.
  const dose: DoseTiming = { tStarMin: 30, evaMin: [0, 20, 40, 60], rateMgyH: [0.1, 0.1, 0.5, 0.1], dAllowMgy: 0.5, source: 'test' }
  const brute = (f: (t: number) => number, a: number, b: number) => {
    let m = Infinity
    for (let i = 0; i <= 200000; i++) m = Math.min(m, f(a + ((b - a) * i) / 200000))
    return m
  }

  it('inside a stop the dose term is checked at the storm knots, not only at arrive / leave', () => {
    const tr = buildTrack([leg([0, 10], [0, 10], [0, 30], [0, 30])], [50])! // stop 10 -> 60 at T_home 30
    const p = marginProfile(tr, marginInputs({ dose }))
    expect(p.points.some((q) => q.phase === 'stop' && q.tMin === 40)).toBe(true)
    expect(p.lowestByTerm.dose!.tMin).toBe(40)
    expect(p.lowestByTerm.dose!.marginMin).toBeCloseTo(60 - 30, 9) // tau(40) = 60 * 0.5 / 0.5 = 60 min
    expect(p.dose!.violation).toBe(false)
  })

  it('on the walk home the closed-form minimum equals a brute-force search', () => {
    // leave the waypoint at 25 with T_home 30: home at 55, T_home falls 1 min / min.
    const tr = buildTrack([leg([0, 25], [0, 20], [0, 30], [0, 25])], [0])!
    const p = marginProfile(tr, marginInputs({ dose }))
    const want = brute((t) => tauDoseAt(dose, t) - (30 - (t - 25)), 25, 55)
    expect(p.lowestByTerm.dose!.marginMin).toBeCloseTo(want, 6)
    expect(p.points.some((q) => q.phase === 'home')).toBe(true)
  })

  it('storm off: no dose term; storm on without rad.json: no dose term either', () => {
    const tr = buildTrack([leg([0, 10], [0, 10], [0, 30], [0, 30])], [5])!
    expect(missionMargin(tr, { tDarkMin: 500, rad, storm: false })!.terms).toEqual(['O2', 'daylight', 'EVA duration'])
    expect(missionMargin(tr, { tDarkMin: null, rad: null, storm: true })!.terms).toEqual(['O2', 'EVA duration'])
    expect(missionMargin(null, { tDarkMin: null, rad, storm: true })).toBeNull()
  })

  it('t_dark from WS4 clock.json', () => {
    expect(tDarkOf(J('conditions/clock.json'))).toBe(J('manifest.json')['clock.eva.t_dark_min'].value)
    expect(tDarkOf({})).toBeNull()
  })
})

// ------------------------------------------------------------------ parity with the engine

/** The official nominal route (WS2) on the planner's clock, with T_home / O2_home looked up in the
 *  5 m field PNGs the planner uses. The engine routes on its 3 m graph, so ~2 % of its vertices fall
 *  on 5 m cells with no value (narrow passages); those take the largest known value within 10 m
 *  (the HUD's cautious rule, hud.yaml worst_case_radii_m smallest radius). */
function officialRouteTrack() {
  const fi = J('fields/index.json') as FieldsIndex
  const field = (k: string) => {
    const { rgba, width, height } = decodePngRGBA(readFileSync(resolve(PUB, fi.fields[k].file)))
    return new FieldGrid(fieldGrid(fi, k), decodeRGBA(rgba, width, height, fi.fields[k].scale))
  }
  const th = field('nom_104/t_home')
  const oh = field('nom_104/o2_home')
  const look = (f: FieldGrid, [lo, la]: [number, number]) => f.valueAt(lo, la) ?? f.discMax(lo, la, 10) ?? NaN
  const route = J('route_nom_104.geojson')
  const tl = J('timeline_nom_104.json') as TimelineEvent[]
  const out = route.features.filter((f: { properties: { to: string } }) => f.properties.to !== 'pad')
  const names: string[] = out.map((f: { properties: { to: string } }) => f.properties.to)
  const legs: LegProfile[] = out.map((f: { geometry: { coordinates: [number, number][] }; properties: { times_min: number[]; o2_L: number } }) => {
    const c = f.geometry.coordinates
    const t = f.properties.times_min.map((v) => v - f.properties.times_min[0])
    const T = t[t.length - 1]
    // the route file has leg O2 totals only: spread over the leg in proportion to time
    return { tMin: t, o2L: t.map((v) => (f.properties.o2_L * v) / T), tHomeMin: c.map((p) => look(th, p)), o2HomeL: c.map((p) => look(oh, p)) }
  })
  const at = (ev: string, s: string) => tl.find((e) => e.event === ev && e.station === s)!.t_min
  const stops = names.map((s) => at('leave', s) - at('arrive', s))
  return { track: buildTrack(legs, stops), names, tl }
}

describe('parity: the official nominal route reproduces the engine timeline (timeline_nom_104.json)', () => {
  const { track, names, tl } = officialRouteTrack()
  const prof = missionMargin(track, { tDarkMin: tDarkOf(J('conditions/clock.json')), rad, storm: true })!
  const manifest = J('manifest.json')

  it('the track is complete and the terms are the engine terms', () => {
    expect(track).not.toBeNull()
    expect(prof.terms).toEqual(manifest['route.nom_104.margin_terms'].value)
  })

  it('t* within 0.2 min of the engine (5 m field vs 3 m graph)', () => {
    expect(Math.abs(prof.dose!.tStarMin - manifest['route.nom_104.dose.t_star_min'].value)).toBeLessThanOrEqual(0.2)
  })

  // Tolerances: times and O2 come from the engine's own route, so they match to its 0.01 rounding;
  // T_home is the 5 m field (0.1 min PNG steps); margins differ by at most the t* shift times the
  // storm slope plus the field step.
  const rows = tl.filter((e) => e.event === 'arrive' || e.event === 'leave' || e.event === 'return')
  for (const e of rows) {
    it(`${e.event} ${e.station ?? 'pad'} at ${e.t_min} min: ${e.margin_binding}, ${e.margin_min} min`, () => {
      const p = prof.points.find((q) => q.phase === e.event && (e.station === null ? q.wp === null : names[q.wp!] === e.station))!
      expect(p).toBeDefined()
      expect(Math.abs(p.tMin - e.t_min)).toBeLessThanOrEqual(0.1)
      expect(Math.abs(BUDGET_CONSTANTS.o2CapacityL - p.o2UsedL - e.o2_left_L!)).toBeLessThanOrEqual(0.1)
      expect(Math.abs(p.tHomeMin - e.t_home_min!)).toBeLessThanOrEqual(0.1)
      expect(p.binding).toBe(e.margin_binding)
      expect(Math.abs(p.marginMin - e.margin_min!)).toBeLessThanOrEqual(1.0)
    })
  }

  it('dose binds from S7 to S6, O2 after (engine: D39 storm over the longest way home)', () => {
    const bind = (ev: string, s: string) => prof.points.find((q) => q.phase === ev && q.wp !== null && names[q.wp] === s)!.binding
    expect([bind('arrive', 'S7'), bind('leave', 'S7'), bind('arrive', 'S6'), bind('leave', 'S6')]).toEqual(['dose', 'dose', 'dose', 'dose'])
    expect([bind('arrive', 'S1'), bind('arrive', 'S4')]).toEqual(['O2', 'O2'])
  })

  it('the turn-back rows satisfy the same EVA-duration term (390 - t - T_home = 0)', () => {
    const mi = marginInputs()
    const tb = tl.filter((x) => x.event === 'turn_back' && x.margin_binding === 'EVA duration')
    expect(tb.length).toBeGreaterThan(0)
    for (const e of tb) {
      expect(Math.abs(mi.evaBudgetMin! - e.t_min - e.t_home_min! - e.margin_min!)).toBeLessThanOrEqual(0.02)
    }
  })

  it('the lowest margin is in the storm, at or below the engine lowest event row (stops are checked between rows)', () => {
    const engineLow = Math.min(...rows.map((e) => e.margin_min!))
    expect(prof.lowest.binding).toBe('dose')
    expect(prof.lowest.marginMin).toBeLessThanOrEqual(engineLow + 1.0)
    expect(prof.dose!.violation).toBe(false)
  })
})

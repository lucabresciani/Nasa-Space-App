// Session 6 labels for D21–D47 (set A): pure helpers, known answers first.
import { describe, expect, it } from 'vitest'
import { CITED } from '../config'
import type { Manifest, Station, TimelineEvent } from '../data/types'
import {
  STORM_TIMING_NOTE,
  compassTick,
  headline60,
  homeFor,
  isHiddenLandmark,
  ist2Rows,
  landmarkNote,
  planningRuleNote,
  stationNameParts,
  tightestMargin,
  turnBacks,
} from './decisions'
import { marginLabel } from './station'

const ev = (t_min: number, event: string, station: string | null, margin_min: number | null, margin_binding?: string): TimelineEvent =>
  ({ t_min, event, station, o2_left_L: 1, t_home_min: 1, margin_min, margin_binding }) as TimelineEvent

// Shape of WS2's timeline_nom_104.json at the official pad (values here are fixture numbers).
const TL: TimelineEvent[] = [
  ev(0, 'depart', null, 327.27, 'O2'),
  ev(44.39, 'arrive', 'S7', 68.26, 'dose'),
  ev(74.39, 'leave', 'S7', 41.21, 'dose'),
  ev(201.94, 'arrive', 'S1', 101.13, 'O2'),
  ev(325.94, 'return', null, 62.5, 'O2'),
  ev(344.58, 'turn_back', 'S7', 0, 'EVA duration'),
  ev(347.71, 'turn_back', 'S1', 0, 'EVA duration'),
]

describe('D28: turn-back binding term incl. "EVA duration"', () => {
  it('marginLabel names the EVA-duration term', () => {
    expect(marginLabel('EVA duration')).toBe('EVA duration')
    expect(marginLabel('dose')).toBe('radiation dose')
    expect(marginLabel(null)).toMatch(/no route/)
  })
  it('turn-back rows of the timeline, with their index (manifest key) and binding', () => {
    expect(turnBacks(TL)).toEqual([
      { i: 5, station: 'S7', t_min: 344.58, binding: 'EVA duration' },
      { i: 6, station: 'S1', t_min: 347.71, binding: 'EVA duration' },
    ])
    expect(turnBacks(null)).toEqual([])
  })
})

describe('D47 / D39: tightest margin of the route and the storm-timing note', () => {
  it('lowest margin over the route rows (turn-back rows are 0 by definition and left out)', () => {
    const t = tightestMargin(TL)!
    expect(t.i).toBe(2)
    expect(t.e.margin_min).toBe(41.21)
    expect(t.dose).toBe(true)
  })
  it('no rows with a margin -> null', () => {
    expect(tightestMargin([ev(0, 'depart', null, null)])).toBeNull()
    expect(tightestMargin(null)).toBeNull()
  })
  it('note text (D47)', () => {
    expect(STORM_TIMING_NOTE).toBe('hypothetical storm timing (tripwire placed where time home is largest)')
  })
})

describe('D45: planning-rule note', () => {
  it('names the effort-cap rate and says HUD and timeline show the modelled use', () => {
    expect(planningRuleNote('1.35 L/min')).toBe(
      'Route planning counts O₂ before each leg at the effort-cap rate (1.35 L/min), a conservative rule; the HUD and timeline show the modelled use.',
    )
  })
})

describe('D43: 60-min headline over the part of the circle inside the terrain data', () => {
  it('reads headline_60 with its in-data share', () => {
    const h = headline60({ headline_60: { budget_min: 60, reachable_pct: 31.5, range_pct: [16.2, 43.8], basis: 'in_data', in_data_pct: 75.8, label: 'x' } })!
    expect(h).toEqual({ budget: 60, reachablePct: 31.5, range: [16.2, 43.8], inDataPct: 75.8, inData: true })
  })
  it('absent on older trees', () => {
    expect(headline60({})).toBeNull()
  })
})

describe('D44 / D26 / D46: station names and "not reachable on foot"', () => {
  const st = (over: Partial<Station>): Station => ({
    id: 'S7',
    name: 'dense ridge network + high SINDEX2 sulfate signal (south-west, farther)',
    lon: 0,
    lat: 0,
    value: 1,
    objective: '',
    tasks: [],
    dwell_min: 30,
    t_home_min: { nom_104: 45.42, con_104: null },
    in_partner_line: false,
    card: 'cards/S7.json',
    access: { con_104: { lon: null, lat: null, dist_m: null, reason: '512 assessed cells within 50 m, none with a walk home in this scenario', walk_in: null } },
    ...over,
  })
  it('name with its suffix; base and suffix when WS1 wrote them', () => {
    const s = st({ name_base: 'dense ridge network + high SINDEX2 sulfate signal', name_suffix: { compass: 'south-west', distance_rank: 'farther' } })
    expect(stationNameParts(s)).toEqual({ full: s.name, base: 'dense ridge network + high SINDEX2 sulfate signal', suffix: 'south-west, farther' })
    expect(stationNameParts(st({}))).toEqual({ full: st({}).name, base: st({}).name, suffix: null })
  })
  it('a null walk home is "not reachable on foot" (config label), with WS2 reason', () => {
    expect(CITED.unreachableLabel.value).toBe('not reachable on foot')
    expect(homeFor(st({}), 'con_104')).toEqual({ kind: 'unreachable', label: 'not reachable on foot', reason: '512 assessed cells within 50 m, none with a walk home in this scenario' })
    expect(homeFor(st({}), 'nom_104')).toEqual({ kind: 'time', v: 45.42 })
  })
  it('a scenario the station has no entry for stays unknown', () => {
    expect(homeFor(st({}), 'opt_80')).toEqual({ kind: 'unknown' })
  })
})

describe('D33: hidden landmarks as bearing ticks on a compass', () => {
  it('display == bearing_tick (or above_skyline false on older cards) is hidden', () => {
    expect(isHiddenLandmark({ name: 'a', bearing_deg: 1, dist_km: 1, display: 'bearing_tick' })).toBe(true)
    expect(isHiddenLandmark({ name: 'a', bearing_deg: 1, dist_km: 1, display: 'label', above_skyline: true })).toBe(false)
    expect(isHiddenLandmark({ name: 'a', bearing_deg: 1, dist_km: 1, above_skyline: false })).toBe(true)
    expect(landmarkNote({ name: 'a', bearing_deg: 1, dist_km: 30, display: 'bearing_tick' })).toBe('below skyline')
    expect(landmarkNote({ name: 'a', bearing_deg: 1, dist_km: 3, display: 'label' })).toBeNull()
  })
  it('tick end points: north up, clockwise', () => {
    const r = (n: number) => Math.round(n * 1e6) / 1e6
    const t = (b: number) => compassTick(b, 50, 40, 10).map((p) => p.map(r))
    expect(t(0)).toEqual([[50, 10], [50, 0]])
    expect(t(90)).toEqual([[90, 50], [100, 50]])
    expect(t(180)).toEqual([[50, 90], [50, 100]])
    expect(t(270)).toEqual([[10, 50], [0, 50]])
  })
})

describe('D30: IST-2 pass/miss per variant from physio.ist2.* manifest keys', () => {
  const e = (value: unknown) => ({ value, units: null, file: 'scenarios/index.json', script: 's', commit: 'c', utc: '2026-11-14T16:00:00Z' })
  const m = {
    dummy: false,
    'physio.ist2.nominal.20.pass': e(true),
    'physio.ist2.nominal.20.band_lo': e(7.922),
    'physio.ist2.nominal.20.band_hi': e(13.722),
    'physio.ist2.nominal.20.reported': e(8.7),
    'physio.ist2.conservative.20.pass': e(false),
    'physio.ist2.conservative.20.band_lo': e(8.777),
    'physio.ist2.conservative.20.band_hi': e(15.203),
    'physio.ist2.conservative.20.reported': e(8.7),
    'physio.ist2.conservative.30.pass': e(true),
    'other.key': e(1),
  } as unknown as Manifest
  it('one row per variant and grade, variants in config order, grades ascending', () => {
    const rows = ist2Rows(m)
    expect(rows.map((r) => `${r.variant}.${r.grade}`)).toEqual(['nominal.20', 'conservative.20', 'conservative.30'])
    expect(rows[1]).toMatchObject({ pass: false, bandLo: 8.777, bandHi: 15.203, reported: 8.7, keyPrefix: 'physio.ist2.conservative.20', file: 'scenarios/index.json' })
    expect(rows[2]).toMatchObject({ pass: true, bandLo: null, reported: null })
  })
  it('no keys -> no rows', () => {
    expect(ist2Rows({ dummy: true } as Manifest)).toEqual([])
    expect(ist2Rows(null)).toEqual([])
  })
})

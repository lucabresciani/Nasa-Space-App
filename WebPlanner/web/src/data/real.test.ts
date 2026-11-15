// Real data tree (web/public/data, committed by C's make web): every file the app reads loads
// through the loader (contract check, no dummy flag), and the G1 numbers the console shows are the
// ones WS2/WS4 reported. Skipped when the real tree is not there.
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CITED, CONFIG } from '../config'
import { basemapSources } from '../map/basemap'
import { isochroneMinutes, uniformStep } from '../map/slider'
import { leashSteps } from '../views/leash'
import { routeSummary } from '../views/route'
import type { Rad, TimelineEvent } from './types'
import { f22Rows, f22Verdict } from '../views/f22'
import { accessFor } from './access'
import { dragFinding, drawnPartner, partnerLabel } from './partner'
import { citesD21, padInUse, padMarker } from '../map/pad'
import { allScienceZero } from '../views/trade'
import { headline60, homeFor, ist2Rows, isHiddenLandmark, tightestMargin, turnBacks } from '../views/decisions'
import { cellStateDisc, katAreas, v1Context, v2Classes } from '../views/validation'
import { createLoader, type TextFetcher } from './loader'
import { schemaFor } from './contracts'
import { loadPadsIndex, padFiles, padKey, PADS_INDEX, parsePadSummary } from './pads'
import type { Localisation, ManifestEntry } from './types'

// HOMELINE_REAL_DATA points the checks at another real tree (e.g. a scratch `make web` output).
const REAL = process.env.HOMELINE_REAL_DATA ? resolve(process.env.HOMELINE_REAL_DATA) : resolve(__dirname, '../../public/data')
const fsFetcher: TextFetcher = async (path) => {
  try {
    return await readFile(resolve(REAL, path), 'utf8')
  } catch {
    return null
  }
}
const has = existsSync(resolve(REAL, 'scenarios/index.json'))

describe.skipIf(!has)('real data tree (web/public/data)', () => {
  const L = createLoader(fsFetcher, 'real')

  it('every scenario file loads; isochrone steps come from the data (2-min fallback)', async () => {
    const idx = await L.scenarios()
    expect(idx.dummy).toBe(false)
    for (const s of idx.scenarios) {
      const mins = isochroneMinutes(await L.isochrones(s))
      expect(mins.length).toBeGreaterThan(0)
      await L.bands(s)
      await L.edges(s)
      await L.partner(s)
    }
    const nom = idx.scenarios.find((s) => s.id === 'nom_104')!
    const step = uniformStep(isochroneMinutes(await L.isochrones(nom)))
    const m = await L.manifest()
    expect(step).toBe((m['isochrone_step_min.nom_104'] as ManifestEntry).value)
  }, 60_000)

  it('stations and cards: an access cell lies within the radius; none comes with the producer reason', async () => {
    const st = await L.stations()
    for (const s of st) {
      const card = await L.card(s)
      const a = accessFor(s, 'nom_104', card)
      if (a.state === 'access') expect(a.dist_m!).toBeLessThanOrEqual(CONFIG.accessRadiusM)
      else expect(a.reason).toBeTruthy()
    }
  })

  it('D9: every config slider step has a rad.json leash.table row', async () => {
    const rad = await L.rad()
    const steps = leashSteps(CONFIG.dAllowRangeMgy, CONFIG.dAllowStepMgy, rad.leash.table)
    expect(steps.every((s) => s.row !== null)).toBe(true)
    expect(steps.find((s) => s.d === rad.leash.D_allow_mGy)!.row!.tau_min_at_peak).toBe(rad.leash.tau_min_at_peak)
  })

  it('basemap tilejson and cell states load; cell-state PNG named by the json exists', async () => {
    const tj = await L.tilejson()
    expect(basemapSources(tj, (p) => p).length).toBeGreaterThan(0)
    const cs = await L.cellstate()
    expect(existsSync(resolve(REAL, cs.image))).toBe(true)
  })

  it('F22: no station frame passes the gate (C 11:58); VO drift loads', async () => {
    const st = await L.stations()
    const frames = []
    const locs: Record<string, Localisation | null> = {}
    for (const s of st) {
      const id = (await L.card(s)).navcam.image_id
      frames.push({ station: s.id, image_id: id })
      if (id) locs[id] = await L.optional(() => L.localisation(id))
    }
    const v = f22Verdict(f22Rows(frames, locs, CONFIG.skylineFixGate.toleranceM))
    expect(v.kind).toBe('none-pass')
    expect((await L.voDrift()).length).toBeGreaterThan(0)
    expect((await L.fixes()).some((f) => f.type === 'station')).toBe(true)
  })
})

// Session-3 tree (C's make web after WS2 session 4 + WS6 V1): con_*, D20 partner, pad proposal, V1, KATs.
const S3 = has && existsSync(resolve(REAL, 'validation/v1.json'))

describe.skipIf(!S3)('real data tree, session-3 publish (D19, D20, V1, F8)', () => {
  const L = createLoader(fsFetcher, 'real')
  const entry = async (k: string) => (await L.manifest())[k] as ManifestEntry | undefined

  it('D20: partner line is cart only, labelled from the file; drag finding 398 N vs 351 N, max 157 kg (manifest)', async () => {
    const idx = await L.scenarios()
    const nom = idx.scenarios.find((s) => s.id === idx.default)!
    const p = await L.partner(nom)
    expect(partnerLabel(p)).toBe('Partner line (cart haul, 60 min)')
    expect(p.features.every((f) => f.properties?.case !== 'drag')).toBe(true)
    expect(drawnPartner(p).features.length).toBe(p.features.length)
    const d = dragFinding(p)!
    expect(d.feasible).toBe(false)
    expect(d.force_N).toBeGreaterThan(d.traction_limit_N!)
    for (const f of ['force_N', 'traction_limit_N', 'max_mass_kg'] as const) {
      const e = (await entry(`haul.drag.flat.${f}`))!
      expect(e.value).toBe(d[f])
      expect(e.file).toBe(nom.files.partner)
    }
    expect(Math.round(d.force_N!)).toBe(398)
    expect(Math.round(d.traction_limit_N!)).toBe(351)
    expect(Math.round(d.max_mass_kg!)).toBe(158) // 157.5 kg
  })

  it('cards carry the D20 drag note', async () => {
    for (const s of await L.stations()) expect((await L.card(s)).drag_note).toMatch(/cannot drag a suited crewmate/)
  })

  it('D7: V2 has near/mid/far; far is reported (not validated) with manifest keys', async () => {
    const v = await L.v2()
    const rows = v2Classes(v.summary)
    expect(rows.map((r) => r.cls)).toEqual(['near', 'mid', 'far'])
    for (const r of rows) expect((await entry(`${r.keyPrefix}.median_abs_deg`))?.value).toBe(r.median_abs_deg)
  })

  it('route legs: every displayed leg number has its route.nom_104.leg.{i}.* key', async () => {
    const r = routeSummary(await L.route('nom_104'))!
    for (const l of r.legs)
      for (const f of ['t_min', 'length_m', 'o2_L'] as const) expect((await entry(`route.nom_104.leg.${l.leg}.${f}`))?.value, `leg ${l.leg} ${f}`).toBe(l[f])
    for (const l of r.legs.filter((x) => x.to !== 'pad')) expect((await entry(`route.nom_104.leg.${l.leg}.to_access_dist_m`))?.value).toBe(l.to_access_dist_m)
  })

  it('station values keyed stations.{S}.value on stations.json (WS1 fix)', async () => {
    for (const s of await L.stations()) {
      const e = await entry(`stations.${s.id}.value`)
      expect(e?.value).toBe(s.value)
      expect(e?.file).toBe('stations.json')
    }
  })

  it('V1: n 290, bias +1.31, RMSE 5.45, r 0.50 (the no-go is not derived from V1: D23)', async () => {
    const v = await L.v1()
    expect(v.n).toBe(290)
    expect(v.bias_deg!.toFixed(2)).toBe('1.31')
    expect(v.rmse_deg!.toFixed(2)).toBe('5.45')
    expect(v.r!.toFixed(2)).toBe('0.50')
    expect(existsSync(resolve(REAL, 'validation/v1.svg'))).toBe(true)
  })

  it('KAT list loads; area counts add up to the summary total', async () => {
    const k = await L.json<{ summary: { total: number }; tests: { id: string; area: string; features: string[]; outcome: string; reason: string | null }[] }>('validation/kats.json')
    expect(katAreas(k.tests).reduce((a, b) => a + b.total, 0)).toBe(k.summary.total)
  })
})

// D21 parking options (C 16:17 layout): on once WS2 publishes scenarios/pads/ and C's contract rows cover it.
const hasPads = has && existsSync(resolve(REAL, PADS_INDEX)) && !!schemaFor(PADS_INDEX)
describe.skipIf(!hasPads)('real tree: D21 rover parking options', () => {
  const L = createLoader(fsFetcher, 'real')

  it('index: one official row = pad.json; every option loads its files; numbers keyed pads.{id}.*', async () => {
    const r = await loadPadsIndex(L)
    expect(r.state).toBe('ok')
    if (r.state !== 'ok') return
    const pf = await L.pad()
    expect([r.index.official.lon, r.index.official.lat]).toEqual([pf.pad.lon, pf.pad.lat])
    expect(Math.max(...r.index.options.map((o) => o.score ?? -1))).toBe(r.index.official.score)
    const m = await L.manifest()
    const idx = await L.scenarios()
    const nominal = idx.scenarios.find((s) => s.id === idx.default)!
    for (const o of r.index.options) {
      expect((m[padKey(o.id, 'score')] as ManifestEntry | undefined)?.value).toBe(o.score)
      if (o.excluded !== null) expect((m[padKey(o.id, 'feasible', 'excluded_by_effort_cap_rule')] as ManifestEntry | undefined)?.value).toBe(o.excluded)
      if (o.official) continue
      const f = padFiles(o.id, nominal)
      const s = parsePadSummary(await L.json(f.summary), o.id)
      expect(s.score).toBe(o.score)
      expect(s.headlines.map((h) => h.budget)).toEqual(expect.arrayContaining(CONFIG.bandBudgetsMin))
      for (const h of s.headlines.filter((x) => x.inData && x.inDataPct !== null)) expect((m[padKey(o.id, 'headline', h.budget, 'in_data_pct')] as ManifestEntry | undefined)?.value).toBe(h.inDataPct)
      await L.json(f.bands)
      await L.json(f.edges)
      await L.json(f.partner)
      await L.json(f.route)
      await L.json(f.timeline)
    }
  }, 60_000)
})

// D21 official-pad tree (WS2 session 7/8 + WS1/WS3/WS4/WS6 re-runs; checked against a scratch make web
// of the interim data at 18:00 CET). Skipped on a tree whose pad.json predates D21.
const padSrc = (() => {
  try {
    return (JSON.parse(readFileSync(resolve(REAL, 'pad.json'), 'utf8')) as { pad?: { source?: string } }).pad?.source ?? null
  } catch {
    return null
  }
})()
const D21 = has && citesD21(padSrc)

describe.skipIf(!D21)('real tree, D21 official pad (D21–D47 set A)', () => {
  const L = createLoader(fsFetcher, 'real')
  const entry = async (k: string) => (await L.manifest())[k] as ManifestEntry | undefined
  const nomTimeline = async () => (await L.timeline('nom_104')) as TimelineEvent[]

  it('D21/D42: pad in use = the official pad rank1, 38 feasible EVAs, F8 score and rule at the pad keyed', async () => {
    const pf = await L.pad()
    const u = padInUse(pf)!
    expect(u.official).toBe(true)
    expect([pf.pad.lon, pf.pad.lat]).toEqual([137.401783, -4.77748])
    expect(padMarker(pf, CONFIG.padDefault).sourceLabel).toMatch(/official/)
    expect([u.feasibleEvas, u.rulePassed]).toEqual([38, true])
    expect(u.maxSlopeDeg!).toBeLessThanOrEqual(CITED.sitingMaxSlopeDeg.value)
    for (const [k, v] of [
      ['pad.score', u.feasibleEvas],
      [u.f8Key, u.score],
      ['pad.checks.max_slope_deg', u.maxSlopeDeg],
      ['pad.checks.assessed_pct_30min', u.assessedPct],
    ] as const)
      expect((await entry(k))?.value, k).toBe(v)
  })

  it('D21: the picker offers ranks 2-3, rank4 and pad_default; official rank1; D45 excluded counts 14/13/13/13/19', async () => {
    const r = await loadPadsIndex(L)
    expect(r.state).toBe('ok')
    if (r.state !== 'ok') return
    expect(r.index.official.id).toBe('rank1')
    expect(r.index.options.filter((o) => !o.official).map((o) => o.id)).toEqual(['rank2', 'rank3', 'rank4', 'pad_default'])
    expect(r.index.options.map((o) => o.excluded)).toEqual([14, 13, 13, 13, 19])
  })

  it('headline nom_104 30 min: 23.0 % [15.2, 28.7], both ends keyed; D43 60 min 31.5 % [16.2, 43.8] of the 75.8 % inside the data', async () => {
    const nom = (await L.scenarios()).scenarios.find((s) => s.id === 'nom_104')!
    const h = nom.headline
    expect([h.budget_min, h.reachable_pct, ...h.range_pct]).toEqual([30, 23.0, 15.2, 28.7])
    expect((await entry('reachable_pct_range.nom_104.30.low'))?.value).toBe(15.2)
    const h60 = headline60(nom)!
    expect([h60.budget, h60.reachablePct, ...h60.range!, h60.inDataPct, h60.inData]).toEqual([60, 31.5, 16.2, 43.8, 75.8, true])
    expect((await entry('headline.nom_104.disc_60.in_data_pct'))?.value).toBe(75.8)
    expect((await entry('reachable_pct.nom_104.60'))?.value).toBe(31.5)
    const t = await L.trade()
    const c = t.cells[t.rows.indexOf(60)][t.cols.indexOf(104)]
    expect(c.in_data_pct).toBe(75.8)
    expect((await entry('trade.60.104.in_data_pct'))?.value).toBe(75.8)
  })

  it('route nom_104: pad -> S7 -> S6 -> S1 -> S4 -> pad, total = manifest; tightest margin 41.21 min (dose, leave S7)', async () => {
    const r = routeSummary(await L.route('nom_104'))!
    expect(r.stops).toEqual(['pad', 'S7', 'S6', 'S1', 'S4', 'pad'])
    expect(r.endMin).toBe((await entry('route.nom_104.total_min'))?.value)
    const tm = tightestMargin(await nomTimeline())!
    expect([tm.e.margin_min, tm.e.margin_binding, tm.e.event, tm.e.station, tm.dose]).toEqual([41.21, 'dose', 'leave', 'S7', true])
    expect((await entry(`timeline.nom_104.${tm.i}.margin_min`))?.value).toBe(41.21)
  })

  it('D28: turn-back rows S7, S1, S6, S4 all bound by EVA duration, keyed; cards carry turn_back_binding', async () => {
    const tb = turnBacks(await nomTimeline())
    expect(tb.map((t) => [t.station, t.binding])).toEqual([
      ['S7', 'EVA duration'],
      ['S1', 'EVA duration'],
      ['S6', 'EVA duration'],
      ['S4', 'EVA duration'],
    ])
    for (const t of tb) expect((await entry(`timeline.nom_104.${t.i}.t_min`))?.value).toBe(t.t_min)
    for (const s of await L.stations()) {
      const c = await L.card(s)
      if (c.on_route) {
        expect(c.turn_back_binding).toBe('EVA duration')
        expect((await entry(`card.${s.id}.turn_back_binding`))?.value).toBe('EVA duration')
      }
    }
  })

  it('D44: stations S1, S2, S4, S6, S7, S8 (S3/S5 gone); S6/S7 names carry their compass suffix when WS2 copied it', async () => {
    const st = await L.stations()
    expect(st.map((s) => s.id)).toEqual(['S1', 'S2', 'S4', 'S6', 'S7', 'S8'])
    const s6 = st.find((s) => s.id === 'S6')!
    const s7 = st.find((s) => s.id === 'S7')!
    if (s6.name_suffix) {
      expect(s6.name).toMatch(/\(south-west, nearer\)$/)
      expect(s7.name).toMatch(/\(south-west, farther\)$/)
    }
    expect(s6.name).not.toBe('')
  })

  it('D46: con_104 S7 "not reachable on foot" (with reason); S2 143.46 and S8 127.32 min home, keyed', async () => {
    const st = await L.stations()
    const by = (id: string) => st.find((s) => s.id === id)!
    const h7 = homeFor(by('S7'), 'con_104')
    expect(h7.kind).toBe('unreachable')
    if (h7.kind === 'unreachable') expect([h7.label, !!h7.reason]).toEqual(['not reachable on foot', true])
    expect(homeFor(by('S2'), 'con_104')).toEqual({ kind: 'time', v: 143.46 })
    expect(homeFor(by('S8'), 'con_104')).toEqual({ kind: 'time', v: 127.32 })
    for (const id of ['S2', 'S8']) expect((await entry(`t_home_min.${id}.con_104`))?.value).toBe(by(id).t_home_min.con_104)
  })

  it('D33: every card lists its hidden landmarks as bearing ticks, each bearing keyed', async () => {
    for (const s of await L.stations()) {
      const c = await L.card(s)
      const hidden = c.landmarks.filter(isHiddenLandmark)
      expect(hidden.length).toBeGreaterThan(0)
      expect(hidden.every((l) => l.display === 'bearing_tick')).toBe(true)
      for (const l of hidden) expect((await entry(`landmark.${s.id}.${l.name.replace(/\s+/g, '_')}.bearing_deg`))?.value).toBe(l.bearing_deg)
    }
  })

  it('D23: v1.json role + nogo_context (17 deg = config); no conservative_nogo; con disc 30 min blocked % keyed', async () => {
    const v = await L.v1()
    const ctx = v1Context(v)
    expect(ctx.role).toBe('V1 = validation of the slope model, not a safety margin')
    expect(ctx.nogoText).toMatch(/17/)
    expect([ctx.nogoDeg, ctx.derivedFromV1, ctx.agreesWithConfig]).toEqual([17, false, true])
    expect(v.conservative_nogo).toBeUndefined()
    expect(await entry('v1.conservative_nogo.nogo_deg')).toBeUndefined()
    const cov = await L.coverage()
    const d = cellStateDisc(cov.terrain_checks, 'conservative', 30)!
    expect(d.nogoDeg).toBe(17)
    for (const f of ['blocked_pct', 'maxslope_rule_blocked_pct'] as const) {
      const val = f === 'blocked_pct' ? d.blockedPct : d.maxSlopeRulePct
      expect((await entry(`${d.keyPrefix}.${f}`))?.value).toBe(val)
    }
  })

  it('D30: IST-2 pass/miss for 3 variants x 2 grades in the manifest (conservative 20 % is a miss)', async () => {
    const rows = ist2Rows(await L.manifest())
    expect(rows.map((r) => `${r.variant}.${r.grade}`)).toEqual(['optimistic.20', 'optimistic.30', 'nominal.20', 'nominal.30', 'conservative.20', 'conservative.30'])
    expect(rows.find((r) => r.variant === 'conservative' && r.grade === 20)!.pass).toBe(false)
    expect(rows.every((r) => r.bandLo !== null && r.bandHi !== null && r.reported !== null)).toBe(true)
    expect(CITED.o2EnergyJPerMl.value).toBe(21.0)
  })

  it('D34-D37: RAD label and status, tripwire ± 9 min, excess >= 1.73 mGy lower bound, end-of-window rate; REMS air T + pressure at 0/1', async () => {
    const r = (await L.rad()) as Rad
    expect(r.source?.component_label).toBe('dose in plastic (E)')
    expect(r.source?.component_status).toMatch(/G to check/)
    const s = r.storm_2024
    expect(s.tripwire_halfwidth_label).toBe('± 9 min')
    expect([s.excess_is_lower_bound, s.excess_mGy!.toFixed(2), s.dose_equivalent_mSv!.toFixed(1)]).toEqual([true, '1.73', '1.7'])
    for (const k of ['tripwire_halfwidth_label', 'end_of_window_rate_uGy_day', 'end_of_window_rate_over_baseline_ratio', 'end_of_window_rate_minus_baseline_uGy_day', 'dose_equivalent_mSv'] as const)
      expect((await entry(`rad.storm_2024.${k}`))?.value, k).toBe(s[k])
    const rems = (await L.rems()) as { variables: { name: string }[] }
    expect(rems.variables.map((v) => v.name.split(' ')[0])).toEqual(['air', 'pressure'])
    expect(await entry('rems.variables.2.daily_min.median')).toBeUndefined()
  })

  it('trade: science value no longer 0 (official pad)', async () => {
    expect(allScienceZero(await L.trade())).toBe(false)
  })
})

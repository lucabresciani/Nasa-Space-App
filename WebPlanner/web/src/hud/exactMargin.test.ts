// X2 (D89): the HUD margin uses the exact margin function, the same one as the field (map/field/margin.ts,
// M3's port of WS2 physio_core.margin), with the same inputs as the field at the crew position on the
// route at that minute. Exact until the return; from the return on (crew back at the pad) the margin
// and binding are held at their value at arrival and no alarm fires (user decision, X2 go message).
// Acceptance tests on the REAL published tree (web/public/data, committed), written first:
//  1. every 5 min up to the return: HUD margin and binding = margin.ts at the field's own lookup
//     (FieldData nearest pixel, as fieldAt quotes it), storm off and storm on (M12 tauOverride);
//  2. every timeline row: HUD margin within 0.5 min of timeline_nom_104.json, binding equal;
//  3. after the return: held value = exact value at arrival, no alarm, no red band;
//  4. without margin inputs in the context the HUD keeps the old headroom path (dummy tree, callers
//     that build their own context).
/// <reference types="node" />
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONFIG } from '../config'
import { decodeGrid, decodeState, FieldData, type Bounds, type DecodedGrid } from '../map/field/decode'
import { marginAt, resolveMarginInputs, type MarginInputs, type TimelineRow } from '../map/field/margin'
import { buildStormModel, stormView, type StormRad } from '../map/storm/model'
import { o2Reserve } from '../views/o2'
import { decodeRGBA, FieldGrid, fieldGrid } from './fields'
import { Plan } from './plan'
import { computeReadout, hudMarginInputs, playbackPosition, type HudContext } from './readout'
import { radiationInput, routeTHomeSeries, stormReplay, stormState } from './storm'
import { loadConfig, readJson, readPngRGBA, REPO } from './testutil'
import type { FieldsIndex, Rad, RouteFC, TimelineEvent } from './types'

const PUB = resolve(REPO, 'web/public/data')
const SC = 'nom_104'
const SUIT = 104
const index = readJson<FieldsIndex>('fields/index.json', PUB)
const timeline = readJson<TimelineEvent[]>(`timeline_${SC}.json`, PUB)
const route = readJson<RouteFC>(`route_${SC}.geojson`, PUB)
const rad = readJson<Rad>('conditions/rad.json', PUB)
const clockFile = readJson<{ eva: { t_dark_min: number; eva_min: number } }>('conditions/clock.json', PUB)

function hudGrid(key: string): FieldGrid {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return new FieldGrid(fieldGrid(index, key), decodeRGBA(rgba, width, height, meta.scale), meta.units)
}
function grid(key: string): DecodedGrid {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return decodeGrid(rgba, width, height, meta.scale, index.bounds as Bounds)
}

const cfg = loadConfig()
const tHome = hudGrid(`${SC}/t_home`)
const plan = new Plan(route, timeline, tHome)
const fields = { tHome, o2Home: hudGrid(`${SC}/o2_home`) }
const base: HudContext = { cfg, fields, plan, budgetMin: cfg.walkbackBudgetsMin[0], pad: plan.start }
// the mission-state values the field reads (state/mission.ts defaults)
const RESERVE = o2Reserve().litres
const D_ALLOW = CONFIG.dAllowMgy
const margin = hudMarginInputs(plan, rad, clockFile.eva.t_dark_min, cfg, { reserveL: RESERVE, dAllowMgy: D_ALLOW })
const ctx: HudContext = { ...base, margin }

// the field: M3's FieldData on the same tree, its PlanTimeline / DoseTiming built as drive.ts does
const cs = readJson<{ image: string; bounds: Bounds }>('terrain/cellstate.json', PUB)
const csPng = readPngRGBA(resolve(PUB, cs.image))
const field = new FieldData(SUIT, { opt: grid(`opt_${SUIT}/t_home`), nom: grid(`nom_${SUIT}/t_home`), con: grid(`con_${SUIT}/t_home`) }, grid(`nom_${SUIT}/o2_home`), decodeState(csPng.rgba, csPng.width, csPng.height, cs.bounds), [])
function fieldInputs(t: number, tauOverride?: number): MarginInputs {
  const r = resolveMarginInputs(
    { t, tDark: clockFile.eva.t_dark_min, tauDose: tauOverride, tEva: clockFile.eva.eva_min, o2Left: undefined, reserve: RESERVE },
    { timeline: margin.timeline, dose: margin.dose, dAllowMgy: D_ALLOW },
  )
  if (!r) throw new Error('no inputs')
  return r
}
/** The field's margin at the crew position at t (fieldAt quotes the nearest pixel). */
function fieldMargin(t: number, tauOverride?: number) {
  const p = plan.stateAt(t)
  const s = field.at(p.lon, p.lat)
  if (s.tHome.nom === null || s.o2Home === null) return null
  return marginAt(fieldInputs(t, tauOverride), s.tHome.nom, s.o2Home)
}

const replay = stormReplay(rad, routeTHomeSeries(plan).evaMin, routeTHomeSeries(plan).tHomeMin)!
const model = buildStormModel(rad as StormRad, SC, timeline as unknown as TimelineRow[])!
const stormCtx = (t: number): HudContext => ({ ...ctx, radiation: radiationInput(stormState(replay, t)) })

const T_RETURN = plan.legs[plan.legs.length - 1].t1
const walk: number[] = []
for (let t = 0; t <= T_RETURN + 1e-9; t += 5) walk.push(t)
const after: number[] = []
for (let t = 330; t <= cfg.evaMin + 1e-9; t += 5) after.push(t)

describe('inputs are the field inputs', () => {
  it('margin inputs come from the published files (t*, rad, clock.json t_dark, crew eva length)', () => {
    expect(margin.timeline.tStarMin).toBe(replay.tripwireEvaMin)
    expect(margin.dose).not.toBeNull()
    expect(margin.tDarkMin).toBe(clockFile.eva.t_dark_min)
    expect(margin.tEvaMin).toBe(clockFile.eva.eva_min)
    expect(T_RETURN).toBeCloseTo(325.94, 2)
  })
})

describe('HUD margin = field margin (margin.ts) every 5 min up to the return', () => {
  it.each(walk)('storm off, t=%f', (t) => {
    const ro = computeReadout(playbackPosition(plan, t), ctx)
    const f = fieldMargin(t)
    if (f === null) {
      expect(ro.marginMin).toBeNull()
      return
    }
    expect(ro.marginMin).toBeCloseTo(f.margin, 9)
    expect(ro.turnBackInMin).toBeCloseTo(f.margin, 9)
    expect(ro.binding).toBe(f.binding)
  })
  it.each(walk)('storm on (M12 tauOverride after the tripwire), t=%f', (t) => {
    const ro = computeReadout(playbackPosition(plan, t), stormCtx(t))
    const f = fieldMargin(t, stormView(model, t).tauOverride)
    if (f === null) {
      expect(ro.marginMin).toBeNull()
      return
    }
    expect(ro.marginMin).toBeCloseTo(f.margin, 9)
    expect(ro.binding).toBe(f.binding)
  })
  it('the storm changes the margin after the tripwire (the override is used)', () => {
    const t = 150
    expect(computeReadout(playbackPosition(plan, t), stormCtx(t)).marginMin!).toBeLessThan(computeReadout(playbackPosition(plan, t), ctx).marginMin! - 1)
  })
  it('between rows the exact margin differs from the old row interpolation (D89 changes numbers)', () => {
    const at40 = computeReadout(playbackPosition(plan, 40), ctx).marginMin!
    const old40 = computeReadout(playbackPosition(plan, 40), base).marginMin!
    expect(Math.abs(at40 - old40)).toBeGreaterThan(20)
  })
})

describe('timeline rows: within 0.5 min of timeline_nom_104.json, binding equal', () => {
  const rows = plan.events.filter((e) => e.margin_min !== null && e.t_min <= T_RETURN + 1e-9)
  const moved: number[] = []
  it.each(rows.map((r) => [r.event, r.station ?? '', r.t_min, r] as const))('%s %s t=%f', (_e, _s, t, r) => {
    const ro = computeReadout(playbackPosition(plan, t), ctx)
    expect(Math.abs((ro.marginMin as number) - (r.margin_min as number))).toBeLessThanOrEqual(0.5)
    expect(ro.binding).toBe(r.margin_binding)
    const old = computeReadout(playbackPosition(plan, t), base).marginMin as number
    if (old.toFixed(1) !== (ro.marginMin as number).toFixed(1)) moved.push(Math.round(t * 100) / 100)
  })
  it('rows whose 0.1-min display moves are exactly the listed ones (accepted, within 0.5 min)', () => {
    expect(moved).toEqual([30, 150, 240, 270, 284.59, 300, 314.59])
  })
})

describe('after the return: held at the arrival value, no alarm, no red band', () => {
  const atArrival = computeReadout(playbackPosition(plan, T_RETURN), ctx)
  const exactArrival = fieldMargin(T_RETURN)!
  it('the held value is the exact value at arrival', () => {
    expect(atArrival.marginMin).toBeCloseTo(exactArrival.margin, 9)
    expect(atArrival.binding).toBe(exactArrival.binding)
  })
  it.each(after)('storm off, t=%f', (t) => {
    const ro = computeReadout(playbackPosition(plan, t), ctx)
    expect(ro.marginMin).toBeCloseTo(exactArrival.margin, 9)
    expect(ro.turnBackInMin).toBeCloseTo(exactArrival.margin, 9)
    expect(ro.binding).toBe(exactArrival.binding)
    expect(ro.alarm).toBeNull()
    expect(ro.band).not.toBe('red')
    // the exact function would count down on "EVA duration" (to -0.1 at 390): that is not shown
    if (t === cfg.evaMin) expect(fieldMargin(t)!.margin).toBeLessThan(0)
  })
  it.each(after)('storm on, t=%f: held at the stormed arrival value, no alarm', (t) => {
    const arr = fieldMargin(T_RETURN, stormView(model, T_RETURN).tauOverride)!
    const ro = computeReadout(playbackPosition(plan, t), stormCtx(t))
    expect(ro.marginMin).toBeCloseTo(arr.margin, 9)
    expect(ro.binding).toBe(arr.binding)
    expect(ro.alarm).toBeNull()
  })
})

describe('no margin inputs in the context: unchanged headroom path', () => {
  it.each([10, 40, 97.5, 200, 390])('t=%f: H(t) - T_home and the timeline row binding', (t) => {
    const p = plan.stateAt(t)
    const ro = computeReadout(playbackPosition(plan, t), base)
    const th = tHome.valueAt(p.lon, p.lat)
    if (th === null) expect(ro.marginMin).toBeNull()
    else expect(ro.marginMin).toBeCloseTo((plan.headroomAt(t) as number) - th, 9)
    expect(ro.binding).toBe(plan.bindingAt(t))
  })
})

describe('provenance: the margin rows cite every input of the exact function', () => {
  it('margin, turn-back and binding rows cite the fields, the timeline, rad.json and clock.json', async () => {
    const { readoutSources } = await import('./provenance')
    const manifest = readJson<Record<string, unknown>>('manifest.json', PUB)
    const src = readoutSources(computeReadout(playbackPosition(plan, 100), ctx), { scenario: SC })
    for (const row of [src.margin, src.turn, src.binding]) {
      expect(row.files).toEqual(expect.arrayContaining([`timeline_${SC}.json`, `fields/${SC}/t_home.png`, `fields/${SC}/o2_home.png`, 'conditions/rad.json', 'conditions/clock.json']))
      for (const k of row.keys) expect(manifest[k], k).toBeDefined()
    }
    // the timeline reading keeps its sources
    const old = readoutSources(computeReadout(playbackPosition(plan, 100), base), { scenario: SC })
    expect(old.margin.files).toEqual([`timeline_${SC}.json`, `fields/${SC}/t_home.png`])
    expect(old.binding.files).toEqual([`timeline_${SC}.json`])
  })
})

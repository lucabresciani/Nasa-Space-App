// WS16 task 3 (M3) acceptance tests, written first (brief WS16 "Acceptance tests", DESIGN U2
// acceptance, contracts/field_shader.md §3.1). CPU mirror of the margin-mode shader on the REAL
// published tree (web/public/data, committed):
//  1. the margin equals timeline_nom_104.json within 0.5 min at every station row (and every other
//     timeline row, incl. WS2's turn_back rows), with T_home / O2_home read from the field as the
//     shader draws them (manual bilinear) at the route position;
//  2. every 5 min of the route, the margin equals the timeline (HUD headroom H(t) - T_home, the
//     WS7 reading of the same timeline) within 0.5 min, and equals hud/readout.ts for the same inputs;
//  3. unknown terrain is never coloured; no T_home / O2_home -> not coloured either.
/// <reference types="node" />
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FieldGrid, fieldGrid } from '../../hud/fields'
import { decodeRGBA } from '../../hud/fields'
import { Plan } from '../../hud/plan'
import { computeReadout, hudMarginInputs, playbackPosition, type HudContext } from '../../hud/readout'
import { loadConfig, readJson, readPngRGBA, REPO } from '../../hud/testutil'
import type { FieldsIndex, Rad, RouteFC, TimelineEvent } from '../../hud/types'
import { o2Reserve } from '../../views/o2'
import { CONFIG } from '../../config'
import { FIELD_LAYER } from './constants'
import { decodeGrid, decodeState, FieldData, fieldAt, setActiveField, type Bounds, type DecodedGrid } from './decode'
import {
  DoseTiming,
  marginAt,
  marginClass,
  marginFieldClass,
  PlanTimeline,
  resolveMarginInputs,
  shaderScalars,
  VERY_LARGE,
  type MarginInputs,
  type RadStorm,
  type TimelineRow,
} from './margin'
import { FS } from './shader'
import { zeroEdgeLabels } from './edgeLabels'

const PUB = resolve(REPO, 'web/public/data')
const SC = 'nom_104'
const SUIT = 104
const index = readJson<FieldsIndex>('fields/index.json', PUB)
const timeline = readJson<TimelineRow[]>(`timeline_${SC}.json`, PUB)
const route = readJson<RouteFC>(`route_${SC}.geojson`, PUB)
const rad = readJson<RadStorm>('conditions/rad.json', PUB)
const clockFile = readJson<{ eva: { t_dark_min: number; eva_min: number } }>('conditions/clock.json', PUB)
const manifest = readJson<Record<string, { value: number }>>('manifest.json', PUB)
const TSTAR_KEY = `route.${SC}.dose.t_star_min`
const TAU_KEY = `route.${SC}.dose.tau_at_t_star_min`

function grid(key: string): DecodedGrid {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return decodeGrid(rgba, width, height, meta.scale, index.bounds as Bounds)
}
function hudGrid(key: string): FieldGrid {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return new FieldGrid(fieldGrid(index, key), decodeRGBA(rgba, width, height, meta.scale), meta.units)
}
const cs = readJson<{ image: string; bounds: Bounds; width: number; height: number }>('terrain/cellstate.json', PUB)
const csPng = readPngRGBA(resolve(PUB, cs.image))
const field = new FieldData(SUIT, { opt: grid(`opt_${SUIT}/t_home`), nom: grid(`nom_${SUIT}/t_home`), con: grid(`con_${SUIT}/t_home`) }, grid(`nom_${SUIT}/o2_home`), decodeState(csPng.rgba, csPng.width, csPng.height, cs.bounds), [])

const hudT = hudGrid(`${SC}/t_home`)
const plan = new Plan(route, timeline as TimelineEvent[], hudT)
const cfg = loadConfig()

const pt = new PlanTimeline(timeline)
const tStar = manifest[TSTAR_KEY].value
const dose = DoseTiming.fromRad(rad, tStar)!
// The mission-state scalars as the app has them (state/mission.ts defaults + conditions/clock.json)
const RESERVE = o2Reserve().litres
const T_EVA = clockFile.eva.eva_min
const T_DARK = clockFile.eva.t_dark_min
const D_ALLOW = CONFIG.dAllowMgy
// the HUD context as hud/hud.ts loadHudData builds it, incl. the exact margin inputs (X2, D89)
const ctx: HudContext = {
  cfg, fields: { tHome: hudT, o2Home: hudGrid(`${SC}/o2_home`) }, plan, budgetMin: cfg.walkbackBudgetsMin[0], pad: plan.start,
  margin: hudMarginInputs(plan, rad as unknown as Rad, T_DARK, cfg, { reserveL: RESERVE, dAllowMgy: D_ALLOW }),
}

function inputsAt(t: number, o2Left?: number): MarginInputs {
  const r = resolveMarginInputs({ t, tDark: T_DARK, tauDose: undefined, tEva: T_EVA, o2Left, reserve: RESERVE }, { timeline: pt, dose, dAllowMgy: D_ALLOW })
  if (!r) throw new Error('no inputs')
  return r
}

/** Margin as the shader draws it at a point (bilinear T_home of the plan's variant and O2_home). */
function drawnMargin(lon: number, lat: number, inp: MarginInputs) {
  const s = field.at(lon, lat)
  const th = s.drawn.nom
  const oh = s.o2Drawn
  if (th === null || oh === null) return null
  return marginAt(inp, th, oh)
}

describe('inputs mirror WS2 (config and published values)', () => {
  it('O2 term rate = design.yaml o2_rate_l_min = the effort-cap rate of the scorecard (1.35)', () => {
    expect(FIELD_LAYER.o2RateLMin).toBe(1.35)
    expect(o2Reserve().rateLMin).toBe(FIELD_LAYER.o2RateLMin)
    expect(RESERVE).toBeCloseTo(40.5, 9)
  })
  it('amber threshold = hud.yaml margin_amber_min', () => {
    expect(FIELD_LAYER.amberMin).toBe(cfg.marginAmberMin)
  })
  it('t* from the timeline = manifest t_star_min; tau(t*) = manifest tau_at_t_star_min', () => {
    expect(pt.tStarMin).toBe(tStar)
    expect(dose.tauMin(tStar, D_ALLOW)).toBeCloseTo(manifest[TAU_KEY].value, 2)
  })
  it('tasks left: arrival value at arrive, 0 at leave and while walking (WS2 tasks_left)', () => {
    for (const r of pt.rows) {
      if (r.o2_tasks_left_L === undefined || r.o2_tasks_left_L === null) continue
      expect(pt.tasksAt(r.t_min)).toBeCloseTo(r.o2_tasks_left_L, 1)
    }
  })
})

// Station pixels where the shader's bilinear has no value (one of the four 5 m neighbours has
// t_home A = 0; M2 notes: the 5 m pixel can sample another 3 m cell than the access cell). The
// shader leaves that sub-pixel uncoloured; fieldAt quotes the nearest pixel, checked here.
const DRAWN_NULL_ROWS = ['arrive S6', 'o2_checkpoint 150', 'leave S6', 'arrive S1', 'o2_checkpoint 210', 'leave S1', 'o2_checkpoint 240']

// 5-min minutes where hud/readout.ts differs from the WS2 formula by > 0.5 min. Until X2 the HUD
// interpolated H(t) linearly between timeline rows (A-WS7-3) and differed at 29 of these points
// (up to 31 min at t = 40). Since X2 (D89) the HUD computes this same function (marginAt with the
// field's inputs), so the list is empty; pinned so any divergence is seen.
const HUD_INTERP_DIFFERS: number[] = []
// 5-min points where the route position has no nominal t_home pixel (no field value; HUD null too)
const NO_VALUE_5MIN = [35, 195]

describe('margin equals timeline_nom_104.json within 0.5 min (DESIGN U2 acceptance)', () => {
  const walkRows = pt.rows
  const drawnNull: string[] = []
  it.each(walkRows.map((r) => [r.event, r.station ?? '', r.t_min, r] as const))('%s %s t=%f: field margin and binding = timeline row; = hud/readout.ts', (e, st, t, r) => {
    const p = plan.stateAt(t)
    const inp = inputsAt(t)
    expect(inp.o2LeftL).toBeCloseTo(r.o2_left_L as number, 6)
    const s = field.at(p.lon, p.lat)
    // nearest pixel (fieldAt quote) and the shader's bilinear value where it has one
    const near = marginAt(inp, s.tHome.nom as number, s.o2Home as number)
    expect(Math.abs(near.margin - (r.margin_min as number))).toBeLessThanOrEqual(0.5)
    expect(near.binding).toBe(r.margin_binding)
    const drawn = drawnMargin(p.lon, p.lat, inp)
    if (drawn === null) drawnNull.push(`${e} ${st || t}`)
    else {
      expect(Math.abs(drawn.margin - (r.margin_min as number))).toBeLessThanOrEqual(0.5)
      expect(drawn.binding).toBe(r.margin_binding)
    }
    // the CPU mirror equals the HUD readout for the same moment (same timeline, same field)
    const ro = computeReadout(playbackPosition(plan, t), ctx)
    expect(Math.abs(near.margin - (ro.marginMin as number))).toBeLessThanOrEqual(0.5)
    expect(marginClass(near.margin, cfg.marginAmberMin)).toBe(({ green: 'safe', amber: 'caution', red: 'limit' } as const)[ro.band as 'green'])
  })
  it('station pixels without a bilinear value are exactly the listed ones', () => {
    expect(drawnNull).toEqual(DRAWN_NULL_ROWS)
  })

  // WS2's turn_back rows: the latest time to leave each station (margin 0). Their O2 left is the
  // hypothetical one at that minute, so it is passed in (as the store would carry it then).
  const turnBacks = timeline.filter((r) => r.event === 'turn_back')
  it.each(turnBacks.map((r) => [r.station, r.t_min, r] as const))('turn_back %s t=%f', (st, t, r) => {
    const dw = plan.dwells.find((d) => d.station === st)!
    const inp = { ...inputsAt(t, r.o2_left_L as number), o2TasksL: r.o2_tasks_left_L ?? 0 }
    const s = field.at(dw.at[0], dw.at[1])
    const m = marginAt(inp, s.tHome.nom as number, s.o2Home as number)
    expect(Math.abs(m.margin - (r.margin_min as number))).toBeLessThanOrEqual(0.5)
    expect(m.binding).toBe(r.margin_binding)
  })

  it('has every station of the route (arrive and leave rows)', () => {
    const st = new Set(walkRows.filter((r) => r.event === 'arrive' || r.event === 'leave').map((r) => r.station))
    expect([...st].sort()).toEqual(['S1', 'S4', 'S6', 'S7'])
  })

  const fiveMin: number[] = []
  for (let t = 0; t <= plan.tEnd + 1e-9; t += 5) fiveMin.push(t)
  const differs: number[] = []
  const noValue: number[] = []
  it.each(fiveMin)('every 5 min of the route: t=%f', (t) => {
    const p = plan.stateAt(t)
    const inp = inputsAt(t)
    const s = field.at(p.lon, p.lat)
    const ro = computeReadout(playbackPosition(plan, t), ctx)
    if (s.tHome.nom === null) {
      noValue.push(t)
      expect(ro.marginMin).toBeNull() // unknown stays unknown in both
      expect(fieldAt).toBeDefined()
      return
    }
    const near = marginAt(inp, s.tHome.nom, s.o2Home as number)
    // the shader picture (bilinear) agrees with the quoted value (nearest) within 0.5 min
    const drawn = drawnMargin(p.lon, p.lat, inp)
    if (drawn) expect(Math.abs(drawn.margin - near.margin)).toBeLessThanOrEqual(0.5)
    // the HUD readout for the same moment
    if (Math.abs(near.margin - (ro.marginMin as number)) > 0.5) differs.push(t)
    // the margin at t sits between the WS2 terms evaluated from the timeline at t: it IS WS2's min
    expect(near.margin).toBeLessThanOrEqual((inp.tEvaMin as number) - t - s.tHome.nom + 1e-9)
  })
  it('5-min points: no-value and HUD-interpolation lists are exactly the documented ones', () => {
    expect(noValue).toEqual(NO_VALUE_5MIN)
    expect(differs).toEqual(HUD_INTERP_DIFFERS)
  })
})

describe('classification (contract §3.1, DESIGN §3.1)', () => {
  const inp = inputsAt(100)
  it('unknown terrain is hatched, never coloured, whatever the margin', () => {
    for (const th of [0, 5, 200, null]) for (const oh of [0, 1000, null]) expect(marginFieldClass(true, th, oh, inp)).toBe('unknown')
  })
  it('no T_home or no O2_home -> none (neither coloured nor hatched)', () => {
    expect(marginFieldClass(false, null, 10, inp)).toBe('none')
    expect(marginFieldClass(false, 10, null, inp)).toBe('none')
  })
  it('limit < 0 <= caution <= amber < safe (HUD marginBand)', () => {
    expect(marginClass(-0.01)).toBe('limit')
    expect(marginClass(0)).toBe('caution')
    expect(marginClass(10)).toBe('caution')
    expect(marginClass(10.01)).toBe('safe')
  })
  it('no field pixel with unknown terrain gets a margin colour (whole grid, fieldAt)', () => {
    setActiveField(field)
    field.setMargin(inputsAt(100), 'nom')
    const [w, s, e, n] = index.bounds
    let unknown = 0
    for (let i = 0; i < 120; i++) {
      for (let j = 0; j < 120; j++) {
        // include points just outside the cell-state grid (unknown there)
        const lon = w - 0.001 + ((e - w + 0.002) * (i + 0.5)) / 120
        const lat = s - 0.001 + ((n - s + 0.002) * (j + 0.5)) / 120
        const f = fieldAt(lon, lat)!
        if (f.unknown) {
          unknown++
          expect(['safe', 'caution', 'limit']).not.toContain(f.cls)
          expect(f.cls).toBe(f.inside ? 'unknown' : 'none')
        } else expect(f.cls).not.toBe('unknown')
      }
    }
    expect(unknown).toBeGreaterThan(0)
    field.setMargin(null, 'nom')
    setActiveField(null)
  })
  it('left-out terms are very large in the shader, so they never bind', () => {
    const sc = shaderScalars({ ...inp, tDarkMin: null, tauDoseMin: null })
    expect(sc.tDark).toBe(VERY_LARGE)
    expect(sc.tauDose).toBe(VERY_LARGE)
    expect(marginAt({ ...inp, tDarkMin: null, tauDoseMin: null }, 10, 10).binding).not.toBe('dose')
  })
  it('ties: the first term in the order O2, daylight, dose, EVA duration binds (WS2)', () => {
    const tie: MarginInputs = { t: 0, o2LeftL: 100, reserveL: 0, o2TasksL: 0, o2RateLMin: 1, tDarkMin: 100, tauDoseMin: 100, tEvaMin: 100 }
    expect(marginAt(tie, 0, 0)).toEqual({ margin: 100, binding: 'O2' })
    expect(marginAt({ ...tie, o2LeftL: 200 }, 0, 0).binding).toBe('daylight')
  })
})

describe('fieldAt in margin mode (contract §5)', () => {
  it('returns margin, binding and class at the current clock for the plan variant', () => {
    setActiveField(field)
    const p = plan.stateAt(100)
    field.setMargin(inputsAt(100), 'nom')
    const f = fieldAt(p.lon, p.lat)!
    const want = drawnMargin(p.lon, p.lat, inputsAt(100))!
    expect(f.margin).toBeCloseTo(want.margin, 9)
    expect(f.binding).toBe(want.binding)
    expect(f.cls).toBe(marginClass(want.margin))
    expect(f.variant).toBe('nom')
    expect(f.t).toBe(f.drawn.nom)
    field.setMargin(null, 'nom')
    const g = fieldAt(p.lon, p.lat)!
    expect(g.margin).toBeNull()
    expect(g.binding).toBeNull()
    setActiveField(null)
  })
})

describe('shader source (margin mode)', () => {
  it('has the margin uniforms and the four terms in WS2 order', () => {
    for (const u of ['u_mode', 'u_t', 'u_o2Left', 'u_reserve', 'u_o2Tasks', 'u_o2Rate', 'u_tDark', 'u_tauDose', 'u_tEva', 'u_amber', 'u_o2']) expect(FS).toContain(u)
    const i = ['(u_o2Left - u_o2Tasks - u_reserve', 'u_tDark - u_t', 'u_tauDose -', 'u_tEva - u_t'].map((s) => FS.indexOf(s))
    expect(i.every((x) => x > 0)).toBe(true)
    expect([...i].sort((a, b) => a - b)).toEqual(i)
  })
  it('caution uses <= amber and limit < 0 (HUD marginBand)', () => {
    expect(FS).toMatch(/m < 0\.0/)
    expect(FS).toMatch(/m <= u_amber/)
  })
})

describe('binding labels on the zero edge', () => {
  it('late in the EVA the zero edge exists; each label sits on it and names the binding there', () => {
    const inp = inputsAt(330)
    field.setMargin(inp, 'nom')
    const labels = zeroEdgeLabels(field, inp, 'nom')
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.length).toBeLessThanOrEqual(4)
    for (const l of labels) {
      const f = field.at(l.lon, l.lat)
      expect(f.margin).not.toBeNull()
      expect(Math.abs(f.margin as number)).toBeLessThan(3) // within a lattice step of the edge
      expect(['O2', 'daylight', 'dose', 'EVA duration']).toContain(l.binding)
    }
    field.setMargin(null, 'nom')
  })
})

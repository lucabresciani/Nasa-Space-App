// HUD acceptance KATs on the REAL pipeline outputs (SPEC F18 acceptance, brief WS7 tests):
// T_home = 0 at the pad; along the route the HUD's T_home and margin match the timeline within
// +-0.5 min; alarms fire where the timeline predicts. Reads data/interim/ (WS2 route/timeline,
// WS7 export/fields); skipped where those files are absent (CI has no data/).
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeRGBA, FieldGrid, fieldGrid } from './fields'
import { Plan } from './plan'
import { computeReadout, playbackPosition, type HudContext } from './readout'
import { loadConfig, readJson, readPngRGBA, REPO } from './testutil'
import type { FieldsIndex, RouteFC, TimelineEvent } from './types'

const INTERIM = resolve(REPO, 'data/interim')
const FIELDS = resolve(INTERIM, 'export')
const PUB = resolve(INTERIM, 'engine/public')
const SC = 'nom_104'
const have = existsSync(resolve(FIELDS, 'fields/index.json')) && existsSync(resolve(PUB, `route_${SC}.geojson`)) && existsSync(resolve(PUB, `timeline_${SC}.json`))

function grid(index: FieldsIndex, key: string): FieldGrid {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(FIELDS, meta.file))
  return new FieldGrid(fieldGrid(index, key), decodeRGBA(rgba, width, height, meta.scale), meta.units)
}

describe.skipIf(!have)(`real ${SC}: HUD vs WS2 timeline`, () => {
  const cfg = loadConfig()
  const index = have ? readJson<FieldsIndex>('fields/index.json', FIELDS) : (null as unknown as FieldsIndex)
  const route = have ? readJson<RouteFC>(`route_${SC}.geojson`, PUB) : (null as unknown as RouteFC)
  const timeline = have ? readJson<TimelineEvent[]>(`timeline_${SC}.json`, PUB) : []
  const tHome = have ? grid(index, `${SC}/t_home`) : (null as unknown as FieldGrid)
  const plan = have ? new Plan(route, timeline, tHome) : (null as unknown as Plan)
  const ctx: HudContext = have ? { cfg, fields: { tHome, o2Home: grid(index, `${SC}/o2_home`) }, plan, budgetMin: cfg.walkbackBudgetsMin[0], pad: plan.start } : (null as unknown as HudContext)

  it('index is the real one (dummy false) on the 5 m grid', () => {
    expect(index.dummy).toBe(false)
    expect(index.res_m).toBe(5)
  })
  it('T_home at the pad (route start) = 0 within the timeline tolerance (0.5 min)', () => {
    // Since D21 the pad is not the grid anchor, so no 5 m pixel centre falls on WS2's single
    // T_home = 0 cell: the pad's pixel shows the 3 m cell under its centre (a few metres away).
    const r = computeReadout(playbackPosition(plan, 0), ctx).tHomeMin
    expect(r).not.toBeNull()
    expect(r!).toBeGreaterThanOrEqual(0)
    expect(r!).toBeLessThanOrEqual(0.5)
  })
  it('T_home and margin match every timeline row within 0.5 min', () => {
    const rows = plan.events.filter((e) => e.t_home_min !== null && e.margin_min !== null)
    expect(rows.length).toBeGreaterThan(3)
    for (const ev of rows) {
      const r = computeReadout(playbackPosition(plan, ev.t_min), ctx)
      expect(r.tHomeMin, `t=${ev.t_min} ${ev.event} ${ev.station}`).not.toBeNull()
      expect(Math.abs(r.tHomeMin! - ev.t_home_min!), `t=${ev.t_min} ${ev.event}`).toBeLessThanOrEqual(0.5)
      expect(Math.abs(r.marginMin! - ev.margin_min!), `t=${ev.t_min} ${ev.event}`).toBeLessThanOrEqual(0.5)
    }
  })
  it('alarms 1 and 4 fire exactly where the timeline margin is below 0 / the amber threshold', () => {
    const minRow = Math.min(...plan.events.filter((e) => e.margin_min !== null).map((e) => e.margin_min!))
    let worst = Infinity
    for (let t = 0; t <= plan.tEnd; t += 0.25) {
      const r = computeReadout(playbackPosition(plan, t), ctx)
      if (r.marginMin !== null) worst = Math.min(worst, r.marginMin)
      if (r.alarm?.rule === 1) expect(r.marginMin!).toBeLessThan(0)
      if (r.alarm?.rule === 4) expect(r.marginMin!).toBeLessThan(cfg.marginAmberMin)
    }
    // the HUD's tightest margin along the walk is the timeline's tightest row (+-0.5 min)
    expect(Math.abs(worst - minRow)).toBeLessThanOrEqual(0.5)
  })
  it('turn_back rows are annotations: the plan ends at the return', () => {
    const ret = timeline.filter((e) => e.event === 'return').map((e) => e.t_min)
    expect(plan.tEnd).toBe(Math.max(...ret))
  })
})

// WP6 (D97) known answers: free waypoints through R5's route store (add / move / rename / delete,
// each one undo step), W numbering among the free stops, max route.max_free_points, validity per
// contract code on a small synthetic field, spacing (pad and every earlier stop), the ghost route on
// a synthetic grid with "estimate" times, and D85 (nothing routed while a marker is dragged).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FieldGrid } from '../../../hud/fields'
import { STATE } from '../../../map/field/constants'
import { FieldData, type DecodedGrid } from '../../../map/field/decode'
import { buildCatalog } from '../../options'
import { createRouteController, type RouteJobs } from '../controller'
import { checkRoute, distanceM, routeForHash, routePayload, ROUTE_LIMITS, stopNames, type PlanRoute, type StationGeo } from '../model'
import { createRouteStore } from '../store'
import { ROUTE_ERROR_TEXT, STOP_PROBLEM_TEXT } from '../text'
import { createWaypointEditor } from './editor'
import { ghostRoute, type GhostGrid } from './ghost'
import { accessCell, cellOf, lonLatOfCell, routeGridOf, type RouteGridData } from './grid'
import { gradeModel, scenarioParams } from './physio'
import { addBlocked, addPoint, cleanLabel, deletePoint, freePoints, LABEL_MAX_CHARS, movePoint, pointNames, renamePoint } from './points'
import { LegRouter, type Leg } from './router'
import { estimateMin } from './text'
import { ACCESS_RADIUS_M, discProbe, STOP_PROBLEM_CODE } from './validity'
import { CONFIG } from '../../../config'

const PUB = resolve(__dirname, '../../../../public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(PUB, p), 'utf8'))
const catalog = buildCatalog(json('scenarios/index.json'), json('scenarios/pads/index.json'), json('stations.json'))
const stations: StationGeo[] = (json('stations.json') as StationGeo[]).map(({ id, name, lon, lat }) => ({ id, name, lon, lat }))
const PAD = { lon: 137.401783, lat: -4.77748 }
/** metres -> degrees near the pad (the spacing check's own great-circle metric, R5 distanceM) */
const DEG_PER_M_LAT = 1 / distanceM({ lon: 0, lat: 0 }, { lon: 0, lat: 1 })
const at = (eastM: number, northM: number) => ({ lon: PAD.lon + (eastM * DEG_PER_M_LAT) / Math.cos((PAD.lat * Math.PI) / 180), lat: PAD.lat + northM * DEG_PER_M_LAT })

const fakeJobs = () => {
  const run = vi.fn(() => ({ promise: new Promise<never>(() => {}), cancel: () => {} }))
  return { run } as unknown as RouteJobs & { run: typeof run }
}
function setup() {
  const store = createRouteStore({ catalog })
  const jobs = fakeJobs()
  const ctl = createRouteController({ store, jobs, stations, pad: () => PAD })
  ctl.setMode('ordered')
  return { store, jobs, ctl }
}

describe('free points: list operations (pure)', () => {
  const base: PlanRoute = { mode: 'ordered', stops: [{ station: 'S4' }] }

  it('add appends {lon, lat} rounded to 1e-6 deg; W1..Wn in order among the free stops (stations keep their ids)', () => {
    let r = addPoint(base, { lon: 137.39621234, lat: -4.77814444 })
    r = { ...r, stops: [...r.stops, { station: 'S1' }] }
    r = addPoint(r, at(300, 0))
    expect(r.stops[1]).toEqual({ lon: 137.396212, lat: -4.778144 })
    expect(stopNames(r)).toEqual(['S4', 'W1', 'S1', 'W2'])
    expect(pointNames(r)).toEqual([null, 'W1', null, 'W2'])
    expect(freePoints(r).map((p) => [p.index, p.name])).toEqual([[1, 'W1'], [3, 'W2']])
  })

  it('at most route.max_free_points (4) and route.max_stops (8); auto mode adds nothing', () => {
    expect(ROUTE_LIMITS.maxFreePoints).toBe(4)
    let r: PlanRoute = { mode: 'ordered', stops: [] }
    for (let i = 0; i < 6; i++) r = addPoint(r, at(100 * (i + 1), 0))
    expect(r.stops).toHaveLength(4)
    expect(addBlocked(r)).toBe('tooManyFreePoints')
    const full: PlanRoute = { mode: 'ordered', stops: [...stations.map((s) => ({ station: s.id })), { lon: 1, lat: 1 }, { lon: 2, lat: 2 }] }
    expect(addBlocked(full)).toBe('tooManyStops')
    expect(addPoint(full, at(0, 500))).toBe(full)
    expect(addBlocked({ mode: 'auto', stops: [] })).toBe('auto')
    expect(addPoint(base, { lon: NaN, lat: 0 })).toBe(base)
  })

  it('move keeps the label; rename trims and caps at limits.title_max_chars; empty removes the label; stations are untouched', () => {
    let r = addPoint(base, at(200, 0))
    r = renamePoint(r, 1, '  Dark sand edge  ')
    expect(r.stops[1]).toMatchObject({ label: 'Dark sand edge' })
    r = movePoint(r, 1, at(250, 10))
    expect(r.stops[1]).toMatchObject({ label: 'Dark sand edge', lon: Number(at(250, 10).lon.toFixed(6)) })
    expect(LABEL_MAX_CHARS).toBe(120)
    expect(cleanLabel('x'.repeat(200))).toHaveLength(120)
    r = renamePoint(r, 1, '   ')
    expect(r.stops[1]).not.toHaveProperty('label')
    expect(movePoint(r, 0, at(0, 0))).toBe(r) // a station is not moved here
    expect(renamePoint(r, 0, 'x')).toBe(r)
    expect(deletePoint(r, 0)).toBe(r)
  })

  it('delete closes up the W names', () => {
    let r: PlanRoute = { mode: 'ordered', stops: [] }
    for (let i = 0; i < 3; i++) r = addPoint(r, at(100 * (i + 1), 0))
    r = renamePoint(r, 2, 'third')
    r = deletePoint(r, 0)
    expect(stopNames(r)).toEqual(['W1', 'W2'])
    expect(r.stops[1]).toMatchObject({ label: 'third' })
  })
})

describe('free points through the route store: one undo step each', () => {
  it('add, move, rename, delete; undo walks back exactly; the payload and hash view follow the contract', () => {
    const { store, ctl } = setup()
    ctl.toggle('S4', true)
    const steps = store.past.value.length
    expect(ctl.edit(addPoint(store.route.value, at(200, 0)))).toBe(true)
    expect(ctl.edit(addPoint(store.route.value, at(0, 300)))).toBe(true)
    const afterAdd = store.route.value
    expect(ctl.edit(movePoint(store.route.value, 1, at(220, 40)))).toBe(true)
    expect(ctl.edit(renamePoint(store.route.value, 1, 'Dark sand edge'))).toBe(true)
    expect(ctl.edit(renamePoint(store.route.value, 1, 'Dark sand edge'))).toBe(false) // no change, no step
    expect(store.past.value).toHaveLength(steps + 4)
    expect(store.step.value.inputs.route).toEqual({
      mode: 'ordered',
      stops: [{ station: 'S4' }, { lon: Number(at(220, 40).lon.toFixed(6)), lat: Number(at(220, 40).lat.toFixed(6)), label: 'Dark sand edge' }, store.route.value.stops[2]],
    })
    expect(routeForHash(store.route.value)?.stops[1]).not.toHaveProperty('label') // D57: labels are not hashed
    const named = store.route.value
    expect(ctl.edit(deletePoint(store.route.value, 1))).toBe(true)
    expect(stopNames(store.route.value)).toEqual(['S4', 'W1'])
    expect(ctl.undo()).toBe(true)
    expect(store.route.value).toBe(named)
    ctl.undo() // rename
    ctl.undo() // move
    expect(store.route.value).toBe(afterAdd)
    ctl.undo()
    ctl.undo()
    expect(store.past.value).toHaveLength(steps)
    expect(routePayload(store.route.value)?.stops).toEqual([{ station: 'S4' }])
    expect(ctl.redo()).toBe(true)
    expect(stopNames(store.route.value)).toEqual(['S4', 'W1'])
  })

  it('reorder works with stations through R5 list (moveStop): names follow the order', () => {
    const { store, ctl } = setup()
    ctl.toggle('S4', true)
    ctl.edit(addPoint(store.route.value, at(200, 0)))
    ctl.edit(addPoint(store.route.value, at(0, 300)))
    ctl.move(2, 0)
    expect(stopNames(store.route.value)).toEqual(['W1', 'S4', 'W2'])
    expect(store.route.value.stops[0]).toEqual({ lon: Number(at(0, 300).lon.toFixed(6)), lat: Number(at(0, 300).lat.toFixed(6)) })
  })
})

// ---- validity on a small synthetic field ------------------------------------------------------

/** 4 x 1 field around the pad: col 0 assessed + T_home, col 1 assessed without T_home, col 2 blocked, col 3 unknown terrain. */
function syntheticField(): { field: FieldData; lonOf: (col: number) => number; lat: number } {
  const W = 4
  const cellDeg = 100 * DEG_PER_M_LAT
  const bounds: [number, number, number, number] = [PAD.lon, PAD.lat - cellDeg / 2, PAD.lon + W * cellDeg, PAD.lat + cellDeg / 2]
  const t = (known: number[]): DecodedGrid => ({ width: W, height: 1, bounds, scale: 0.1, counts: new Uint16Array(known.map((k) => k * 100)), known: Uint8Array.from(known) })
  const grid = t([1, 0, 0, 0])
  const state = { width: W, height: 1, bounds, code: Uint8Array.from([STATE.assessed, STATE.assessed, STATE.blocked, STATE.unknown]) }
  const field = new FieldData(104, { opt: grid, nom: grid, con: grid }, null, state, [])
  return { field, lonOf: (c) => PAD.lon + (c + 0.5) * cellDeg, lat: PAD.lat }
}

describe('validity per contract code (field lookups only)', () => {
  const { field, lonOf, lat } = syntheticField()
  const probe = (lon: number, la: number) => discProbe(field, lon, la, 'nom')
  const one = (lon: number) => checkRoute({ mode: 'ordered', stops: [{ lon, lat }] }, { stations, pad: { lon: 0, lat: 0 }, probe }).stops[0]

  it('valid; unreachable (no T_home); not walkable (blocked at 20°); unassessed; outside the grid', () => {
    expect(one(lonOf(0))).toMatchObject({ valid: true, problems: [] })
    expect(one(lonOf(1)).problems).toEqual(['unreachable'])
    expect(one(lonOf(2)).problems).toEqual(['notWalkable'])
    expect(one(lonOf(3)).problems).toEqual(['unassessed'])
    expect(one(lonOf(6)).problems).toEqual(['outsideGrid'])
  })

  it('no field in the browser: unknown (null), never shown as invalid', () => {
    expect(discProbe(null, 0, 0, 'nom')).toEqual({ inGrid: null, assessed: null, walkable: null, reachable: null })
    const c = checkRoute({ mode: 'ordered', stops: [{ lon: lonOf(0), lat }] }, { stations, pad: { lon: 0, lat: 0 }, probe: () => discProbe(null, 0, 0, 'nom') })
    expect(c.stops[0].valid).toBeNull()
    expect(c.ok).toBe(true)
  })

  it('every stop problem maps to a contract 422 code with text, and has its own panel text', () => {
    for (const [p, code] of Object.entries(STOP_PROBLEM_CODE)) {
      expect(code).toMatch(/^route_/)
      expect(ROUTE_ERROR_TEXT[code], code).toBeTruthy()
      expect(STOP_PROBLEM_TEXT[p as keyof typeof STOP_PROBLEM_TEXT], p).toBeTruthy()
    }
    expect(Object.values(STOP_PROBLEM_CODE)).toEqual(expect.arrayContaining(['route_point_outside_grid', 'route_point_unassessed', 'route_point_not_walkable', 'route_point_unreachable', 'route_stop_spacing']))
  })
})

/**
 * 5 m cells, 41 x 41, the point at the centre of cell (20, 20). Every cell has `base` terrain and no
 * T_home; `cells` lists [east offset in cells, state, T_home known] overrides on the point's row.
 */
function discField(base: number, cells: [number, number, boolean][]) {
  const N = 41
  const RES = 5
  const P = { lon: 137.4, lat: -4.78 }
  const mPerDegLat = (CONFIG.marsRadiusM * Math.PI) / 180
  const dLat = RES / mPerDegLat
  const dLon = RES / (mPerDegLat * Math.cos((P.lat * Math.PI) / 180))
  const bounds: [number, number, number, number] = [P.lon - 20.5 * dLon, P.lat - 20.5 * dLat, P.lon + 20.5 * dLon, P.lat + 20.5 * dLat]
  const code = new Uint8Array(N * N).fill(base)
  const known = new Uint8Array(N * N)
  for (const [dc, st, t] of cells) {
    code[20 * N + 20 + dc] = st
    known[20 * N + 20 + dc] = t ? 1 : 0
  }
  const g: DecodedGrid = { width: N, height: N, bounds, scale: 0.1, counts: new Uint16Array(N * N), known }
  const field = { t: { opt: g, nom: g, con: g }, state: { width: N, height: N, bounds, code } }
  const check = () => checkRoute({ mode: 'ordered', stops: [P] }, { stations, pad: { lon: 0, lat: 0 }, probe: (lon, lat) => discProbe(field, lon, lat, 'nom') }).stops[0]
  return { field, P, check }
}

describe('validity over the access disc (variants.yaml route.access_radius_m, D27): never stricter than the engine', () => {
  it('the radius comes from config: 50 m', () => {
    expect(ACCESS_RADIUS_M).toBe(CONFIG.accessRadiusM)
    expect(ACCESS_RADIUS_M).toBe(50)
  })
  it('a point on a steep cell with a walkable cell 30 m away is VALID', () => {
    expect(discField(STATE.blocked, [[6, STATE.assessed, true]]).check()).toMatchObject({ valid: true, problems: [] })
  })
  it('the same with the nearest walkable cell 60 m away is not walkable', () => {
    expect(discField(STATE.blocked, [[12, STATE.assessed, true]]).check().problems).toEqual(['notWalkable'])
  })
  it('walkable within the disc but no known T_home within it: unreachable', () => {
    expect(discField(STATE.blocked, [[6, STATE.assessed, false], [12, STATE.assessed, true]]).check().problems).toEqual(['unreachable'])
  })
  it('unknown terrain everywhere in the disc: unassessed; one known (blocked) cell 30 m away makes it assessed', () => {
    expect(discField(STATE.unknown, []).check().problems).toEqual(['unassessed'])
    expect(discField(STATE.unknown, [[6, STATE.blocked, false]]).check().problems).toEqual(['notWalkable'])
  })
  it('outside the grid is the point\'s own cell only', () => {
    const { field, P } = discField(STATE.assessed, [[0, STATE.assessed, true]])
    expect(discProbe(field, P.lon, P.lat, 'nom').inGrid).toBe(true)
    expect(discProbe(field, P.lon + 1, P.lat, 'nom').inGrid).toBe(false)
  })
})

describe('spacing: route.min_stop_spacing_m to the pad and to every other stop (shown before submit)', () => {
  const ctx = { stations, pad: PAD }
  const m = ROUTE_LIMITS.minStopSpacingM
  it('50 m', () => expect(m).toBe(50))
  it('a point closer than 50 m to the pad is refused, at 60 m it is fine', () => {
    expect(checkRoute({ mode: 'ordered', stops: [at(m - 10, 0)] }, ctx).stops[0].problems).toEqual(['spacing'])
    expect(checkRoute({ mode: 'ordered', stops: [at(m + 10, 0)] }, ctx).stops[0].problems).toEqual([])
  })
  it('the later stop of a close pair is named, also when the pair is not adjacent and not the last', () => {
    const r: PlanRoute = { mode: 'ordered', stops: [at(300, 0), at(0, 300), at(320, 0), at(0, 600)] }
    const c = checkRoute(r, ctx)
    expect(c.stops.map((s) => s.problems)).toEqual([[], [], ['spacing'], []])
    expect(c.ok).toBe(false)
  })
  it('a middle stop near the pad is refused too', () => {
    const c = checkRoute({ mode: 'ordered', stops: [at(300, 0), at(20, 0), at(0, 300)] }, ctx)
    expect(c.stops[1].problems).toEqual(['spacing'])
  })
})

// ---- ghost route ---------------------------------------------------------------------------------

/** 5 m grid, 240 x 240 cells around the pad, flat; a wall east of the pad with a gap in the south. */
function syntheticGrid(wall = true): RouteGridData {
  const N = 240
  const res = 5
  const half = (N * res * DEG_PER_M_LAT) / 2
  const k = Math.cos((PAD.lat * Math.PI) / 180)
  const bounds: [number, number, number, number] = [PAD.lon - half / k, PAD.lat - half, PAD.lon + half / k, PAD.lat + half]
  const known = new Uint8Array(N * N).fill(1)
  if (wall) for (let r = 0; r < N; r++) if (r < 200) known[r * N + 160] = 0
  const tHome = new FieldGrid({ bounds, width: N, height: N, res_m: res }, { width: N, height: N, scale: 0.1, counts: new Uint16Array(N * N), known })
  return { scenario: 'nom_104', tHome, grid: routeGridOf(tHome, new Float32Array(N * N)), model: gradeModel(scenarioParams('nom_104')) }
}
function countingGrid(d: RouteGridData) {
  const router = new LegRouter(d.grid, d.model)
  const calls: string[] = []
  const g: GhostGrid = {
    cellOf: (lon, lat) => accessCell(d.grid, cellOf(d.tHome, lon, lat), ROUTE_LIMITS.minStopSpacingM),
    lonLatOf: (c) => lonLatOfCell(d.tHome, c),
    route: (a, b) => {
      calls.push(`${a}-${b}`)
      return router.route(a, b)
    },
  }
  return { g, calls }
}

describe('ghost route (estimate) on the browser grid', () => {
  const d = syntheticGrid()
  const pace0 = d.model.lookup(0).pace

  it('pad -> W1 -> W2 -> pad: three legs in contract numbering, times from the ported router', () => {
    const { g } = countingGrid(d)
    const r: PlanRoute = { mode: 'ordered', stops: [at(200, 0), at(200, 200)] }
    const out = ghostRoute(r, { stations, pad: PAD }, g, new Map())!
    expect(out.legs.map((l) => [l.leg, l.from, l.to, l.routed])).toEqual([
      [0, 'pad', 'W1', true],
      [1, 'W1', 'W2', true],
      [2, 'W2', 'pad', true],
    ])
    // flat ground, 200 m east on the grid: about 200 m at the level pace (cell snapping: ±1 cell)
    expect(out.legs[0].distM!).toBeGreaterThanOrEqual(195)
    expect(out.legs[0].distM!).toBeLessThanOrEqual(205)
    expect(out.legs[0].timeS).toBeCloseTo(out.legs[0].distM! * pace0, 6)
    expect(out.totalS).toBeCloseTo(out.legs.reduce((s, l) => s + l.timeS!, 0), 9)
    expect(out.legs[0].coords[0][0]).toBeCloseTo(PAD.lon, 4)
  })

  it('moving one waypoint re-routes only its two legs (leg cache, ported from plan.ts)', () => {
    const { g, calls } = countingGrid(d)
    const cache = new Map<string, Leg | null>()
    const r1: PlanRoute = { mode: 'ordered', stops: [at(200, 0), at(200, 200), at(0, 250)] }
    ghostRoute(r1, { stations, pad: PAD }, g, cache)
    expect(calls).toHaveLength(4)
    calls.length = 0
    const r2 = movePoint(r1, 1, at(150, 220))
    ghostRoute(r2, { stations, pad: PAD }, g, cache)
    expect(calls).toHaveLength(2)
    calls.length = 0
    ghostRoute(r2, { stations, pad: PAD }, g, cache)
    expect(calls).toHaveLength(0)
  })

  it('a wall forces the detour through its gap; a stop beyond the grid has no estimate (straight, unrouted)', () => {
    const { g } = countingGrid(d)
    const across = ghostRoute({ mode: 'ordered', stops: [at(250, 0)] }, { stations, pad: PAD }, g, new Map())!
    expect(across.legs[0].distM!).toBeGreaterThan(260) // goes around the wall
    const far = ghostRoute({ mode: 'ordered', stops: [at(5000, 0)] }, { stations, pad: PAD }, g, new Map())!
    expect(far.legs.map((l) => l.routed)).toEqual([false, false])
    expect(far.totalS).toBeNull()
    expect(far.legs[0].coords).toHaveLength(2)
  })

  it('auto mode or no stop: no ghost', () => {
    const { g } = countingGrid(d)
    expect(ghostRoute({ mode: 'auto', stops: [] }, { stations, pad: PAD }, g, new Map())).toBeNull()
    expect(ghostRoute({ mode: 'ordered', stops: [] }, { stations, pad: PAD }, g, new Map())).toBeNull()
  })

  it('estimates are whole minutes, "< 1" under a minute', () => {
    expect(estimateMin(20)).toBe('< 1')
    expect(estimateMin(89)).toBe('1')
    expect(estimateMin(151)).toBe('3')
  })
})

describe('editor: add on the armed click, drop = one undo step, nothing routed while dragging (D85)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const grid = syntheticGrid(false)
  function editor() {
    const s = setup()
    // the real pad of the catalog's plan is where the synthetic grid is centred
    const pad = s.store.step.value.inputs.pad
    const loadGrid = vi.fn(async () => grid)
    const ed = createWaypointEditor(s.ctl, { loadGrid, defer: (f) => f() })
    ed.setMapAttached(true)
    return { ...s, ed, loadGrid, pad }
  }

  it('a map click adds nothing until "Add waypoint" is armed; one click adds one point and disarms', async () => {
    const { ed, store } = editor()
    expect(ed.add(at(200, 0).lon, at(200, 0).lat)).toBe(false)
    expect(store.route.value.stops).toHaveLength(0)
    expect(ed.startAdd()).toBe(true)
    expect(ed.add(at(200, 0).lon, at(200, 0).lat)).toBe(true)
    expect(ed.adding.value).toBe(false)
    expect(stopNames(store.route.value)).toEqual(['W1'])
    await flush()
    expect(ed.ghost.value.kind).toBe('ready')
  })

  it('max 4: "Add waypoint" is blocked with the reason; without a map it is blocked too', () => {
    const { ed } = editor()
    for (let i = 0; i < 4; i++) {
      ed.startAdd()
      ed.add(at(100 * (i + 1), 0).lon, at(100 * (i + 1), 0).lat)
    }
    expect(ed.blocked.value).toBe('tooManyFreePoints')
    expect(ed.startAdd()).toBe(false)
    const { ed: e2 } = editor()
    e2.setMapAttached(false)
    expect(e2.blocked.value).toBe('noMap')
  })

  it('drag: no store change and no routing until the drop; the drop is one undo step and reroutes', async () => {
    const { ed, store } = editor()
    ed.startAdd()
    ed.add(at(200, 0).lon, at(200, 0).lat)
    ed.startAdd()
    ed.add(at(200, 200).lon, at(200, 200).lat)
    await flush()
    const runs = ed.runs
    const steps = store.past.value.length
    ed.dragStart('W1')
    await flush()
    expect(ed.runs).toBe(runs) // D85: held while dragging
    expect(store.past.value).toHaveLength(steps)
    expect(ed.drop(0, at(150, -50).lon, at(150, -50).lat)).toBe(true)
    await flush()
    expect(store.past.value).toHaveLength(steps + 1)
    expect(ed.runs).toBeGreaterThan(runs)
    expect(ed.dragging.value).toBeNull()
    const g = ed.ghost.value
    expect(g.kind === 'ready' && g.ghost.legs.length).toBe(3)
  })

  it('the ghost is hidden once a computed live result is shown; an edit brings it back', async () => {
    const { ed, store } = editor()
    ed.startAdd()
    ed.add(at(200, 0).lon, at(200, 0).lat)
    await flush()
    expect(ed.ghostShown.value).toBe(true)
    // a finished job (the controller's own state machine, through a fake jobs port answering done)
    const done = { status: 'done' as const, result: { hash: 'h', feasibility: { feasible: true as const }, label: 'x', provenanceHref: '#', engineCommit: null, recordError: null } }
    const c2 = createRouteController({ store, jobs: { run: () => ({ promise: Promise.resolve(done), cancel: () => {} }) }, stations, pad: () => PAD })
    const ed2 = createWaypointEditor(c2, { loadGrid: async () => grid, defer: (f) => f() })
    await flush()
    expect(ed2.ghostShown.value).toBe(true)
    expect(c2.computePlan()).toBe(true)
    await flush()
    expect(c2.compute.value.kind).toBe('done')
    expect(ed2.ghostShown.value).toBe(false)
    c2.edit(renamePoint(store.route.value, 0, 'again'))
    await flush()
    expect(ed2.ghostShown.value).toBe(true)
  })

  it('rename and delete through the editor are undo steps; nothing while a plan is computed', () => {
    const { ed, store, ctl } = editor()
    ed.startAdd()
    ed.add(at(200, 0).lon, at(200, 0).lat)
    expect(ed.rename(0, 'Dark sand edge')).toBe(true)
    expect(store.route.value.stops[0]).toMatchObject({ label: 'Dark sand edge' })
    expect(ed.remove(0)).toBe(true)
    expect(store.route.value.stops).toHaveLength(0)
    expect(ctl.undo()).toBe(true)
    expect(store.route.value.stops[0]).toMatchObject({ label: 'Dark sand edge' })
  })
})

// R5 (D97) known answers for the route model and store: checkbox and reorder give the route payload
// in the user's order; the D57 hash covers the route (order matters, labels dropped, auto = no route,
// so the official hash is unchanged); every edit is one undo step and undo restores the exact
// previous payload and hash; a drag changes nothing until the drop and never starts a job (D85).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildCatalog } from '../options'
import { createPlanEditStore } from '../store'
import { createRouteController, type RouteJobs } from './controller'
import { AUTO_ROUTE, checkRoute, legCoords, moveStop, routeForHash, routeLegs, routePayload, ROUTE_LIMITS, toggleStation, type PlanRoute, type StationGeo } from './model'
import { createRouteStore } from './store'

const PUB = resolve(__dirname, '../../../public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(PUB, p), 'utf8'))
const catalog = buildCatalog(json('scenarios/index.json'), json('scenarios/pads/index.json'), json('stations.json'))
const stations: StationGeo[] = (json('stations.json') as { id: string; name: string; lon: number; lat: number }[]).map(({ id, name, lon, lat }) => ({ id, name, lon, lat }))
const ID = { engine_tree: '0123456789abcdef0123456789abcdef01234567', config_hash: 'sha256:1fef9c5747acbd487e0a3090f6e9617eba1c8627e25095db683e18ab7589099d', terrain_hash: `sha256:${'0'.repeat(64)}` }
const ordered = (...ids: string[]): PlanRoute => ({ mode: 'ordered', stops: ids.map((station) => ({ station })) })

describe('the six stations', () => {
  it('stations.json holds S1, S2, S4, S6, S7, S8', () => {
    expect(stations.map((s) => s.id)).toEqual(['S1', 'S2', 'S4', 'S6', 'S7', 'S8'])
  })
})

describe('route payload', () => {
  it('checkbox appends in click order, uncheck removes; reorder moves one stop', () => {
    let r: PlanRoute = { mode: 'ordered', stops: [] }
    for (const id of ['S4', 'S1', 'S2']) r = toggleStation(r, id, true)
    expect(routePayload(r)).toEqual({ mode: 'ordered', stops: [{ station: 'S4' }, { station: 'S1' }, { station: 'S2' }] })
    r = moveStop(r, 2, 0)
    expect(routePayload(r)?.stops).toEqual([{ station: 'S2' }, { station: 'S4' }, { station: 'S1' }])
    r = toggleStation(r, 'S4', false)
    expect(routePayload(r)?.stops).toEqual([{ station: 'S2' }, { station: 'S1' }])
    expect(toggleStation(r, 'S2', true)).toBe(r) // already in: unchanged, no duplicate
    expect(moveStop(r, 0, 5)).toBe(r)
  })

  it('auto sends no route (missing route = auto); labels are sent but not hashed', () => {
    expect(routePayload({ mode: 'auto', stops: [{ station: 'S1' }] })).toBeUndefined()
    const r: PlanRoute = { mode: 'ordered', stops: [{ station: 'S2' }, { lon: 137.3962, lat: -4.7781, label: 'Dark sand' }] }
    expect(routePayload(r)?.stops[1]).toEqual({ lon: 137.3962, lat: -4.7781, label: 'Dark sand' })
    expect(routeForHash(r)?.stops[1]).toEqual({ lon: 137.3962, lat: -4.7781 })
  })

  it('legs: pad -> stops in order -> pad, named as the run record names them', () => {
    expect(routeLegs(ordered('S4', 'S1', 'S2'))).toEqual([
      { leg: 0, from: 'pad', to: 'S4' },
      { leg: 1, from: 'S4', to: 'S1' },
      { leg: 2, from: 'S1', to: 'S2' },
      { leg: 3, from: 'S2', to: 'pad' },
    ])
    const s1 = stations.find((s) => s.id === 'S1')!
    const s2 = stations.find((s) => s.id === 'S2')!
    expect(legCoords(ordered('S4', 'S1', 'S2'), 2, { stations, pad: { lon: 0, lat: 0 } })).toEqual([[s1.lon, s1.lat], [s2.lon, s2.lat]])
  })
})

describe('validity per stop', () => {
  const pad = { lon: 137.401783, lat: -4.77748 }
  it('ordered needs a stop; unknown station refused; a field "no" names the reason; no field = unknown, never invalid', () => {
    expect(checkRoute({ mode: 'ordered', stops: [] }, { stations, pad }).route).toEqual(['noStops'])
    expect(checkRoute(AUTO_ROUTE, { stations, pad }).ok).toBe(true)
    const c = checkRoute(ordered('S1', 'X9'), { stations, pad })
    expect(c.stops.map((s) => s.valid)).toEqual([null, false])
    expect(c.stops[1].problems).toEqual(['unknownStation'])
    expect(c.ok).toBe(false)
    const steep = checkRoute(ordered('S1', 'S2'), { stations, pad, probe: (lon) => ({ inGrid: true, assessed: true, walkable: lon !== stations[1].lon, reachable: true }) })
    expect(steep.stops.map((s) => s.valid)).toEqual([true, false])
    expect(steep.stops[1].problems).toEqual(['notWalkable'])
  })
  it('limits: at most max_stops; stops closer than min_stop_spacing_m are refused', () => {
    expect(ROUTE_LIMITS).toMatchObject({ maxStops: 8, maxFreePoints: 4, minStopSpacingM: 50 })
    const many: PlanRoute = { mode: 'ordered', stops: Array.from({ length: 9 }, (_, i) => ({ lon: 137.38 + i * 0.01, lat: -4.78 })) }
    expect(checkRoute(many, { stations, pad }).route).toEqual(['tooManyStops', 'tooManyFreePoints'])
    const s1 = stations[0]
    const close: PlanRoute = { mode: 'ordered', stops: [{ station: 'S1' }, { lon: s1.lon + 0.0001, lat: s1.lat }] }
    expect(checkRoute(close, { stations, pad }).stops[1].problems).toContain('spacing')
  })
})

describe('route store: hash and undo (through the H1 plan-edit store)', () => {
  it('auto route = the H1 plan: same inputs, same canonical text, same D57 hash', () => {
    const rs = createRouteStore({ catalog, identity: ID })
    const h1 = createPlanEditStore({ catalog, identity: ID })
    expect(rs.step.value.inputs).toEqual(h1.committed.value.inputs)
    expect(rs.step.value.canonical).toBe(h1.committed.value.canonical)
    expect(rs.hash.value).toBe(h1.committedHash.value)
  })

  it('the hash covers the route: order changes it, labels do not; the route enters the canonical text in order', () => {
    const rs = createRouteStore({ catalog, identity: ID })
    const auto = rs.hash.value
    rs.apply(ordered('S4', 'S1', 'S2'))
    const a = rs.hash.value
    expect(rs.step.value.inputs.route).toEqual({ mode: 'ordered', stops: [{ station: 'S4' }, { station: 'S1' }, { station: 'S2' }] })
    expect(rs.step.value.canonical).toContain('"route":{"mode":"ordered","stops":[{"station":"S4"},{"station":"S1"},{"station":"S2"}]}')
    rs.apply(ordered('S2', 'S1', 'S4'))
    const b = rs.hash.value
    expect(new Set([auto, a, b]).size).toBe(3)
    const p = { lon: 137.3962, lat: -4.7781 }
    rs.apply({ mode: 'ordered', stops: [{ station: 'S2' }, p] })
    const plain = rs.hash.value
    rs.apply({ mode: 'ordered', stops: [{ station: 'S2' }, { ...p, label: 'Dark sand' }] })
    expect(rs.hash.value).toBe(plain)
    expect(rs.step.value.inputs.route?.stops[1]).toEqual({ ...p, label: 'Dark sand' })
  })

  it('every edit is one undo step; undo restores the exact previous payload and hash; redo returns', () => {
    const rs = createRouteStore({ catalog, identity: ID })
    const seen: { route: unknown; hash?: string }[] = [{ route: rs.step.value.inputs.route, hash: rs.hash.value }]
    for (const r of [ordered('S4'), ordered('S4', 'S1'), ordered('S1', 'S4')]) {
      expect(rs.apply(r)).toBe(true)
      seen.push({ route: rs.step.value.inputs.route, hash: rs.hash.value })
    }
    expect(rs.apply(ordered('S1', 'S4'))).toBe(false) // no change, no step
    expect(rs.past.value).toHaveLength(3)
    for (let i = seen.length - 2; i >= 0; i--) {
      expect(rs.undo()).toBe(true)
      expect({ route: rs.step.value.inputs.route, hash: rs.hash.value }).toEqual(seen[i])
    }
    expect(rs.undo()).toBe(false)
    expect(rs.redo()).toBe(true)
    expect(rs.hash.value).toBe(seen[1].hash)
    rs.apply(ordered('S8'))
    expect(rs.canRedo.value).toBe(false)
  })

  it('undo keeps at most edit.undo_max steps', () => {
    const rs = createRouteStore({ catalog, undoMax: 2 })
    for (const id of ['S1', 'S2', 'S4', 'S6']) rs.apply(ordered(id))
    expect(rs.past.value).toHaveLength(2)
  })

  it('the console plan (pad) enters the inputs and the hash without an undo step', () => {
    let pad = catalog.officialPadId
    const rs = createRouteStore({ catalog, identity: ID, plan: () => ({ scenario: catalog.padScenario, budgetMin: catalog.bandBudgetsMin[0], pad, dwell: {} }) })
    rs.apply(ordered('S1'))
    const before = rs.hash.value
    pad = catalog.pads.find((p) => !p.official)!.id
    rs.planChanged()
    expect(rs.hash.value).not.toBe(before)
    expect(rs.past.value).toHaveLength(1)
    expect(rs.step.value.inputs.route).toEqual({ mode: 'ordered', stops: [{ station: 'S1' }] })
  })
})

describe('controller: drag (D85) and compute', () => {
  const fakeJobs = () => {
    const run = vi.fn(() => ({ promise: new Promise<never>(() => {}), cancel: () => {} }))
    return { run } as unknown as RouteJobs & { run: typeof run }
  }
  it('dragging changes nothing and starts no job; the drop is one undo step', () => {
    const jobs = fakeJobs()
    const store = createRouteStore({ catalog })
    const c = createRouteController({ store, jobs, stations, pad: () => ({ lon: 137.401783, lat: -4.77748 }) })
    c.setMode('ordered')
    for (const id of ['S4', 'S1', 'S2']) c.toggle(id, true)
    const steps = store.past.value.length
    c.dragStart(2)
    expect(c.computePlan()).toBe(false) // no compute while dragging
    expect(store.past.value).toHaveLength(steps)
    expect(c.dragDrop(0)).toBe(true)
    expect(store.past.value).toHaveLength(steps + 1)
    expect(routePayload(store.route.value)?.stops).toEqual([{ station: 'S2' }, { station: 'S4' }, { station: 'S1' }])
    expect(jobs.run).not.toHaveBeenCalled()
    expect(c.computePlan()).toBe(true)
    expect(jobs.run).toHaveBeenCalledTimes(1)
    expect((jobs.run.mock.calls[0] as unknown[])[0]).toMatchObject({ route: { mode: 'ordered', stops: [{ station: 'S2' }, { station: 'S4' }, { station: 'S1' }] } })
  })
  it('an ordered route without stops cannot be computed; live off blocks compute', () => {
    const jobs = fakeJobs()
    const store = createRouteStore({ catalog })
    const c = createRouteController({ store, jobs, stations, pad: () => ({ lon: 137.401783, lat: -4.77748 }) })
    c.setMode('ordered')
    expect(c.computePlan()).toBe(false)
    expect(jobs.run).not.toHaveBeenCalled()
  })
})

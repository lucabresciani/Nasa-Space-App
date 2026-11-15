// WS16 task 5 (M5): route draw-on, done / coming legs, turn-back ticks (DESIGN U4 "Route").
// Acceptance: the reduced-motion draw-on path is instant. Real route + timeline (nom_104).
/// <reference types="node" />
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Plan } from '../hud/plan'
import { dummyGrid, readJson, REPO } from '../hud/testutil'
import type { RouteFC, TimelineEvent } from '../hud/types'
import { TOKENS } from '../ui/tokens'
import { drawOnFraction, playDrawOn, routeFeatures, routeLine, routeLineFromFC, subLine, turnBackTicks } from './route'

const PUB = resolve(REPO, 'web/public/data')
const route = readJson<RouteFC>('route_nom_104.geojson', PUB)
const timeline = readJson<TimelineEvent[]>('timeline_nom_104.json', PUB)
const metric = dummyGrid('nom_104/t_home') // planar metric only (m per degree)
const plan = new Plan(route, timeline, metric)
const line = routeLine(plan)

describe('route draw-on (tokens motion.routeDrawMs)', () => {
  it('takes routeDrawMs = 1500 ms, linear along the length', () => {
    expect(TOKENS.motion.routeDrawMs).toBe(1500)
    expect(drawOnFraction(0)).toBe(0)
    expect(drawOnFraction(750)).toBeCloseTo(0.5, 9)
    expect(drawOnFraction(1500)).toBe(1)
    expect(drawOnFraction(4000)).toBe(1)
  })

  it('reduced motion: instant (one frame at 1, no animation frame requested)', () => {
    expect(drawOnFraction(0, 1500, true)).toBe(1)
    const frames: number[] = []
    let rafCalls = 0
    playDrawOn((f) => frames.push(f), { reduced: true, raf: () => ++rafCalls, now: () => 0 })
    expect(frames).toEqual([1])
    expect(rafCalls).toBe(0)
    // and the route is complete in that one frame
    const fc = routeFeatures(line, frames[0], 0)
    const coming = fc.features.find((f) => f.properties.part === 'coming')!
    expect(coming.geometry.coordinates[0]).toEqual(line.coords[0])
    expect(coming.geometry.coordinates[coming.geometry.coordinates.length - 1]).toEqual(line.coords[line.coords.length - 1])
  })

  it('full motion: frames run from 0 to 1 over 1.5 s, then stop', () => {
    let now = 0
    const queue: (() => void)[] = []
    const frames: number[] = []
    playDrawOn((f) => frames.push(f), { now: () => now, raf: (cb) => queue.push(cb) })
    while (queue.length) {
      now += 100
      queue.shift()!()
    }
    expect(frames[0]).toBe(0)
    expect(frames[frames.length - 1]).toBe(1)
    expect(frames.length).toBe(16)
    for (let i = 1; i < frames.length; i++) expect(frames[i]).toBeGreaterThan(frames[i - 1])
  })

  it('the shown length grows with the fraction', () => {
    const len = (f: number): number => {
      const fc = routeFeatures(line, f, 0)
      const c = fc.features.find((x) => x.properties.part === 'coming')
      if (!c) return 0
      let s = 0
      const g = c.geometry.coordinates
      for (let i = 1; i < g.length; i++) s += plan.dist(g[i - 1] as [number, number], g[i] as [number, number])
      return s
    }
    expect(len(0)).toBe(0)
    expect(len(0.5)).toBeCloseTo(line.length / 2, 3)
    expect(len(1)).toBeCloseTo(line.length, 3)
  })
})

describe('done legs solid, coming legs 50 %', () => {
  it('splits at the walked distance of the clock minute (Plan.stateAt)', () => {
    for (const t of [0, 20, 44.39, 60, 100, 200, 330]) {
      const walked = plan.stateAt(t).distanceWalkedM
      const fc = routeFeatures(line, 1, walked)
      const done = fc.features.find((f) => f.properties.part === 'done')
      const coming = fc.features.find((f) => f.properties.part === 'coming')
      if (walked <= 0) expect(done).toBeUndefined()
      if (walked >= line.length - 1e-6) expect(coming).toBeUndefined()
      if (done && coming) expect(done.geometry.coordinates[done.geometry.coordinates.length - 1]).toEqual(coming.geometry.coordinates[0])
    }
  })
  it('the whole route = the legs of the plan, joined', () => {
    expect(line.length).toBeCloseTo(plan.legs.reduce((a, l) => a + l.length, 0), 6)
    const fromFile = routeLineFromFC(route, metric)
    expect(fromFile.length).toBeCloseTo(line.length, 3)
    expect(subLine(line, 10, 10)).toBeNull()
  })
})

describe('turn-back ticks', () => {
  const ticks = turnBackTicks(plan, 15)
  it('one tick per WS2 turn_back row, at its station, across the route', () => {
    const rows = timeline.filter((r) => r.event === 'turn_back')
    expect(ticks.map((k) => k.station).sort()).toEqual(rows.map((r) => r.station).sort())
    for (const k of ticks) {
      const leg = plan.legs.find((l) => l.to === k.station)!
      const end = leg.coords[leg.coords.length - 1]
      const mid: [number, number] = [(k.coords[0][0] + k.coords[1][0]) / 2, (k.coords[0][1] + k.coords[1][1]) / 2]
      expect(plan.dist(mid, end)).toBeLessThan(1e-6)
      expect(plan.dist(k.coords[0], k.coords[1])).toBeCloseTo(30, 6)
      expect(k.tMin).toBe(rows.find((r) => r.station === k.station)!.t_min)
    }
  })
  it('ticks appear once the draw-on has reached them', () => {
    const n = (f: number): number => routeFeatures(line, f, 0, ticks).features.filter((x) => x.properties.part === 'tick').length
    expect(n(0)).toBe(0)
    expect(n(1)).toBe(ticks.length)
  })
})

// WS16 task 5 (M5): markers (DESIGN U4): ring = science value, fill = state, only the next station
// pulses every 3 s, no pulse under reduced motion; ghost route data; copy / config cross-checks.
/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { Plan } from '../hud/plan'
import { dummyGrid, readJson, REPO } from '../hud/testutil'
import type { RouteFC, TimelineEvent } from '../hud/types'
import { TOKENS } from '../ui/tokens'
import { COPY, THREAD } from './furniture/text'
import { ghostData, ghostLabelAt } from './ghostRoute'
import { pulseFrame, RING_PX, ringWidth, SCORED_SITE_IDS, stationFeatures, type MarkerStation } from './markers'
import { compassAngles } from './compass'
import { parseClockSun, type ClockFile } from '../hud/sun'

const PUB = resolve(REPO, 'web/public/data')
const stations = readJson<MarkerStation[]>('stations.json', PUB)
const plan = new Plan(readJson<RouteFC>('route_nom_104.geojson', PUB), readJson<TimelineEvent[]>('timeline_nom_104.json', PUB), dummyGrid('nom_104/t_home'))

describe('station markers', () => {
  const onRoute = new Set(plan.legs.map((l) => l.to).filter((x): x is string => !!x))
  it('ring thickness grows with the science value', () => {
    expect(ringWidth(0)).toBe(RING_PX.min)
    expect(ringWidth(1)).toBe(RING_PX.max)
    expect(ringWidth(null)).toBe(RING_PX.min)
    const fc = stationFeatures(stations, onRoute, null)
    const byValue = [...fc.features].sort((a, b) => a.properties.value - b.properties.value)
    for (let i = 1; i < byValue.length; i++) expect(byValue[i].properties.ring).toBeGreaterThanOrEqual(byValue[i - 1].properties.ring)
  })
  it('fill = state: on route / reachable / not reachable (stations.json reachable_on_foot)', () => {
    const extra: MarkerStation = { id: 'SX', lon: 0, lat: 0, value: 0.5, reachable_on_foot: false }
    const fc = stationFeatures([...stations, extra], onRoute, null)
    const st = Object.fromEntries(fc.features.map((f) => [f.properties.id, f.properties]))
    for (const id of onRoute) {
      expect(st[id].state).toBe('route')
      expect(st[id].fill).toBe(TOKENS.color.science)
    }
    for (const s of stations.filter((x) => !onRoute.has(x.id))) expect(st[s.id].state).toBe(s.reachable_on_foot === false ? 'unreachable' : 'reachable')
    expect(st.SX.state).toBe('unreachable')
    expect(new Set(fc.features.map((f) => f.properties.fill + f.properties.stroke)).size).toBe(3)
  })
  it('scored sites are config/stations.yaml extras.ids', () => {
    expect(SCORED_SITE_IDS).toEqual(['S6', 'S7', 'S8'])
    const fc = stationFeatures(stations, onRoute, null)
    expect(fc.features.filter((f) => f.properties.scored).map((f) => f.properties.id).sort()).toEqual(['S6', 'S7', 'S8'])
  })
  it('only the next station on the route is marked to pulse', () => {
    for (const t of [0, 50, 130, 250]) {
      const next = plan.nextArrival(t)!.station
      const fc = stationFeatures(stations, onRoute, next)
      expect(fc.features.filter((f) => f.properties.next).map((f) => f.properties.id)).toEqual([next])
    }
    expect(stationFeatures(stations, onRoute, null).features.some((f) => f.properties.next)).toBe(false)
  })
  it('pulses once every tokens motion.pulseEveryMs (3 s); never under reduced motion', () => {
    const every = TOKENS.motion.pulseEveryMs
    expect(every).toBe(3000)
    const active = (ms: number) => pulseFrame(ms, false).active
    let starts = 0
    for (let ms = 0; ms < 3 * every; ms += 10) if (active(ms) && !active(ms - 10)) starts++
    expect(starts).toBe(3)
    for (let ms = 0; ms < 3 * every; ms += 37) expect(pulseFrame(ms, true)).toEqual({ active: false, grow: 0, opacity: 0 })
  })
})

describe('compass', () => {
  const clock = readJson<ClockFile>('conditions/clock.json', PUB)
  const sun = parseClockSun(clock)!
  it('north arrow turns against the bearing; sun at its azimuth from clock.json', () => {
    expect(compassAngles(0, sun, 0).north).toBe(0)
    expect(compassAngles(30, sun, 0).north).toBe(330)
    const a = compassAngles(0, sun, sun.tMin[0])
    expect(a.sunAzDeg).toBeCloseTo(sun.azDeg[0], 9)
    expect(a.sun).toBeCloseTo(sun.azDeg[0], 9)
    expect(compassAngles(0, sun, sun.tMin[sun.tMin.length - 1] + 100).sun).toBeNull()
    expect(compassAngles(0, null, 10).sun).toBeNull()
  })
})

describe('ghost route layer data (WS18)', () => {
  it('accepts coords, a feature or a collection; label at the middle vertex', () => {
    const c: [number, number][] = [[0, 0], [1, 1], [2, 2]]
    expect(ghostData(c).features).toHaveLength(1)
    expect(ghostData(null).features).toHaveLength(0)
    expect(ghostData([[0, 0]]).features).toHaveLength(0)
    expect(ghostLabelAt(ghostData(c))).toEqual([1, 1])
    const pt: GeoJSON.Feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }
    expect(ghostData({ type: 'FeatureCollection', features: [pt] }).features).toHaveLength(0)
    expect(ghostLabelAt(ghostData(null))).toBeNull()
  })
})

describe('config/design.yaml and ui/copy.json cross-check (when present on this branch)', () => {
  const yml = resolve(REPO, 'config/design.yaml')
  const copy = resolve(REPO, 'web/src/ui/copy.json')
  it.skipIf(!existsSync(yml))('thread block equals config/design.yaml', () => {
    const d = parse(readFileSync(yml, 'utf8')) as { thread: { update_hz: number; dash_steps: number; tooltip: string } }
    expect({ updateHz: THREAD.updateHz, dashSteps: THREAD.dashSteps, tooltip: THREAD.tooltip }).toEqual({ updateHz: d.thread.update_hz, dashSteps: d.thread.dash_steps, tooltip: d.thread.tooltip })
  })
  it.skipIf(!existsSync(copy))('every local text equals copy.json', () => {
    const raw = JSON.parse(readFileSync(copy, 'utf8')) as Record<string, unknown>
    for (const [k, v] of Object.entries(COPY)) {
      const got = k.split('.').reduce<unknown>((n, p) => (n as Record<string, unknown>)?.[p], raw)
      expect(got, k).toBe(v)
    }
  })
  it('tokens used by the thread and route', () => {
    expect(TOKENS.line.threadPx).toBe(2.0)
    expect(THREAD).toEqual({ updateHz: 30, dashSteps: 14, tooltip: 'Home in {t_home} min · margin {margin} min ({binding})' })
  })
})

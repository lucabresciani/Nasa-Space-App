// M10 acceptance (WS16 task 10, DESIGN U6 item 2): the flythrough path is smooth and stays on the route.
// Real tree: route_nom_104.geojson + timeline_nom_104.json through WS7's Plan, as the app does.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Plan } from '../../hud/plan'
import { FLYTHROUGH, FOLLOW_TURN_DEG_PER_MIN } from '../../story/config'
import { routeLine } from '../route'
import { angleDiff, cameraOffset, catmullRom, resample, SmoothPath } from './path'
import { flightPath, gridMetric } from './route'

const DATA = new URL('../../../public/data/', import.meta.url)
const have = existsSync(new URL('route_nom_104.geojson', DATA))
const read = (p: string) => JSON.parse(readFileSync(new URL(p, DATA), 'utf8'))

/** distance (m) from point q to the polyline (local metres) */
function distToPolyline(q: [number, number], pts: [number, number][]): number {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const L2 = dx * dx + dy * dy
    const u = L2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2)) : 0
    best = Math.min(best, Math.hypot(q[0] - a[0] - u * dx, q[1] - a[1] - u * dy))
  }
  return best
}

describe('config (design.yaml camera.flythrough)', () => {
  it('reads the DESIGN U6 values', () => {
    expect(FLYTHROUGH).toEqual({ sampleM: 20, spline: 'centripetal_catmull_rom', behindM: 250, aboveM: 175, lookaheadM: 150 })
  })
})

describe('centripetal Catmull-Rom', () => {
  it('passes through its control points and is straight on a line', () => {
    const p: [number, number][] = [[0, 0], [10, 0], [20, 0], [30, 0]]
    expect(catmullRom(p[0], p[1], p[2], p[3], 0)).toEqual([10, 0])
    const end = catmullRom(p[0], p[1], p[2], p[3], 1)
    expect(end[0]).toBeCloseTo(20, 9)
    for (let u = 0; u <= 1; u += 0.1) expect(catmullRom(p[0], p[1], p[2], p[3], u)[1]).toBeCloseTo(0, 9)
  })
  it('does not loop or overshoot on uneven spacing (centripetal)', () => {
    const p: [number, number][] = [[0, 0], [1, 0], [1, 30], [2, 30]]
    for (let u = 0; u <= 1; u += 0.05) {
      const q = catmullRom(p[0], p[1], p[2], p[3], u)
      expect(q[1]).toBeGreaterThanOrEqual(-1e-9)
      expect(q[1]).toBeLessThanOrEqual(30 + 1e-9)
    }
  })
})

describe.skipIf(!have)('flythrough path on the real route (nom_104)', () => {
  const metric = gridMetric(read('fields/index.json'))
  const plan = new Plan(read('route_nom_104.geojson'), read('timeline_nom_104.json'), metric)
  const line = routeLine(plan)
  const path = new SmoothPath(line, metric, FLYTHROUGH.sampleM)
  const routeXY = line.coords.map((c) => path.toXY(c))

  it('samples every 20 m along the route', () => {
    const { s } = resample(line, 20)
    expect(s[0]).toBe(0)
    expect(s[s.length - 1]).toBeCloseTo(line.length, 6)
    for (let i = 1; i < s.length - 1; i++) expect(s[i] - s[i - 1]).toBeCloseTo(20, 9)
    expect(path.samples.pts.length).toBeGreaterThan(100)
  })

  it('stays on the route within one field cell (5 m) everywhere', () => {
    let worst = 0
    for (let s = 0; s <= path.length; s += 2) worst = Math.max(worst, distToPolyline(path.xyAt(s), routeXY))
    expect(worst).toBeLessThan(5)
  })

  it('starts at the pad end of the route and ends at its last point', () => {
    const a = path.at(0)
    const b = path.at(path.length)
    expect(a[0]).toBeCloseTo(line.coords[0][0], 9)
    expect(b[1]).toBeCloseTo(line.coords[line.coords.length - 1][1], 9)
  })

  it('is smooth: the path never jumps', () => {
    const ds = 1
    let maxStep = 0
    for (let s = ds; s <= path.length; s += ds) {
      const q0 = path.xyAt(s - ds)
      const q1 = path.xyAt(s)
      maxStep = Math.max(maxStep, Math.hypot(q1[0] - q0[0], q1[1] - q0[1]))
    }
    // position moves at most ~ds per metre of route (no teleport, no loop)
    expect(maxStep).toBeLessThan(ds * 1.5)
  })

  it('the follow camera never snaps: bearing turns <= FOLLOW_TURN_DEG_PER_MIN, look-at and camera move continuously', () => {
    const fp = flightPath(plan, metric, 'nom_104')
    const dt = 0.01 // EVA minutes (0.6 s): finer than any playback frame at speed <= 1 min/frame
    let prev = fp.poseAt(0)
    let maxTurn = 0
    let maxMove = 0
    let maxCamMove = 0
    for (let t = dt; t <= plan.tEnd + 1; t += dt) {
      const p = fp.poseAt(t)
      maxTurn = Math.max(maxTurn, Math.abs(angleDiff(prev.bearing, p.bearing)))
      const a = path.toXY(prev.target)
      const b = path.toXY(p.target)
      maxMove = Math.max(maxMove, Math.hypot(b[0] - a[0], b[1] - a[1]))
      const ca = path.toXY(cameraOffset(prev, metric).cam)
      const cb = path.toXY(cameraOffset(p, metric).cam)
      maxCamMove = Math.max(maxCamMove, Math.hypot(cb[0] - ca[0], cb[1] - ca[1]))
      prev = p
    }
    expect(maxTurn).toBeLessThanOrEqual(FOLLOW_TURN_DEG_PER_MIN * dt + 1e-6)
    // walking 0.98 m/s for 0.6 s; the look-at point moves at most a few metres per step
    expect(maxMove).toBeLessThan(3)
    // the camera swings on a 250 m arm: <= 250 m x turn (rad) + the look-at move
    expect(maxCamMove).toBeLessThan(250 * ((FOLLOW_TURN_DEG_PER_MIN * dt * Math.PI) / 180) + 3)
  })

  it('places the camera 250 m behind and 175 m above (pitch 55°) the look-at point 150 m ahead', () => {
    const fp = flightPath(plan, metric, 'nom_104')
    const t = 20 // walking to S7
    const st = plan.stateAt(t)
    expect(st.phase).toBe('walk')
    const pose = fp.poseAt(t)
    const crew = path.xyAt(st.distanceWalkedM)
    const look = path.toXY(pose.target)
    const ahead = path.xyAt(st.distanceWalkedM + 150)
    expect(Math.hypot(look[0] - ahead[0], look[1] - ahead[1])).toBeLessThan(1e-6)
    expect(pose.altM).toBe(175)
    expect(pose.pitch).toBeCloseTo(55, 0)
    const { cam, horizM } = cameraOffset(pose, metric)
    expect(horizM).toBeCloseTo(250, 6)
    const c = path.toXY(cam)
    expect(Math.hypot(c[0] - look[0], c[1] - look[1])).toBeCloseTo(250, 3)
    // the camera is behind: closer to the crew than the look-at point is
    expect(Math.hypot(c[0] - crew[0], c[1] - crew[1])).toBeLessThan(250)
  })

  it('the timeline scrubs it: dwells hold the look-at point (the camera may swing round), the clock end parks it', () => {
    const fp = flightPath(plan, metric, 'nom_104')
    const dwell = plan.dwells[0]
    expect(fp.poseAt(dwell.t0 + 1).target).toEqual(fp.poseAt(dwell.t1 - 1).target)
    expect(fp.poseAt(plan.tEnd + 15)).toEqual(fp.poseAt(plan.tEnd + 60))
    // scrubbing is a pure function of t: the same minute twice gives the same pose
    expect(flightPath(plan, metric, 'nom_104').poseAt(123.456)).toEqual(fp.poseAt(123.456))
  })
})

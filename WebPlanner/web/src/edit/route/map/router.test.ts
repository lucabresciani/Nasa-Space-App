// WP6 (D97): ported from origin/waypoint-routing web/src/mission/router.test.ts (N0CEO, Mission Planer), unchanged
// except import paths. Feeds the ghost route and its leg-time estimates (labelled "estimate").
import { describe, expect, it } from 'vitest'
import { gradeModel, scenarioParams } from './physio'
import { LegRouter, type RouteGrid } from './router'

const M = gradeModel(scenarioParams('nom_104'))
const RES = 5

function grid(w: number, h: number, elev: (r: number, c: number) => number = () => 0, blocked: (r: number, c: number) => boolean = () => false): RouteGrid {
  const e = new Float32Array(w * h)
  const p = new Uint8Array(w * h)
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      e[r * w + c] = elev(r, c)
      p[r * w + c] = blocked(r, c) ? 0 : 1
    }
  return { width: w, height: h, resM: RES, elev: e, passable: p }
}
const idx = (g: RouteGrid, r: number, c: number) => r * g.width + c

describe('A* leg router (16-neighbour, engine move rules)', () => {
  it('flat ground, straight east: 30 cells = 150 m at the level pace', () => {
    const g = grid(50, 50)
    const leg = new LegRouter(g, M).route(idx(g, 10, 10), idx(g, 10, 40))!
    expect(leg.distM).toBeCloseTo(150, 9)
    expect(leg.timeS).toBeCloseTo(150 * M.lookup(0).pace, 9)
    expect(leg.o2L).toBeCloseTo(150 * M.lookup(0).o2, 12)
    expect(leg.cells[0]).toBe(idx(g, 10, 10))
    expect(leg.cells[leg.cells.length - 1]).toBe(idx(g, 10, 40))
    expect(leg.cells.every((i) => Math.floor(i / g.width) === 10)).toBe(true)
  })

  it('cumulative time and O2 per cell: one entry per cell, rising, ending at the leg totals', () => {
    const g = grid(50, 50)
    const leg = new LegRouter(g, M).route(idx(g, 10, 10), idx(g, 30, 40))!
    expect(leg.tauS).toHaveLength(leg.cells.length)
    expect(leg.o2CumL).toHaveLength(leg.cells.length)
    expect(leg.tauS[0]).toBe(0)
    expect(leg.o2CumL[0]).toBe(0)
    for (let s = 1; s < leg.cells.length; s++) {
      expect(leg.tauS[s]).toBeGreaterThan(leg.tauS[s - 1])
      expect(leg.o2CumL[s]).toBeGreaterThan(leg.o2CumL[s - 1])
    }
    expect(leg.tauS[leg.tauS.length - 1]).toBe(leg.timeS)
    expect(leg.o2CumL[leg.o2CumL.length - 1]).toBe(leg.o2L)
  })

  it('flat ground, (0,0) -> (20,10): ten knight moves, 10 * sqrt(5) * 5 m', () => {
    const g = grid(30, 30)
    const leg = new LegRouter(g, M).route(idx(g, 0, 0), idx(g, 20, 10))!
    expect(leg.distM).toBeCloseTo(10 * Math.sqrt(5) * RES, 9)
    expect(leg.cells.length).toBe(11)
  })

  it('same start and end: an empty leg', () => {
    const g = grid(5, 5)
    const leg = new LegRouter(g, M).route(idx(g, 2, 2), idx(g, 2, 2))!
    expect(leg).toEqual({ cells: [idx(g, 2, 2)], timeS: 0, o2L: 0, distM: 0, tauS: [0], o2CumL: [0] })
  })

  it('uphill and downhill differ: 5 deg ramp, 150 m east up, back down', () => {
    const t5 = Math.tan((5 * Math.PI) / 180)
    const g = grid(50, 20, (_r, c) => c * RES * t5)
    const R = new LegRouter(g, M)
    const up = R.route(idx(g, 10, 5), idx(g, 10, 35))!
    const down = R.route(idx(g, 10, 35), idx(g, 10, 5))!
    // Edge length is horizontal (engine: length / v*(theta), theta from dz over horizontal length).
    expect(up.distM).toBeCloseTo(150, 6)
    // Elevations are float32 (as the real grid), so the grade is 5 deg to ~1e-8: 4 decimals on ~300 s.
    expect(up.timeS).toBeCloseTo(150 * M.lookup((5 * Math.PI) / 180).pace, 4)
    expect(down.timeS).toBeCloseTo(150 * M.lookup((-5 * Math.PI) / 180).pace, 4)
    expect(up.timeS).toBeGreaterThan(down.timeS)
  })

  it('a wall with one gap: detour through the gap, never through a blocked cell', () => {
    const g = grid(40, 40, () => 0, (r, c) => c === 20 && r !== 35)
    const leg = new LegRouter(g, M).route(idx(g, 5, 5), idx(g, 5, 35))!
    expect(leg.cells.some((i) => i === idx(g, 35, 20))).toBe(true)
    expect(leg.cells.every((i) => g.passable[i] === 1)).toBe(true)
    expect(leg.distM).toBeGreaterThan(150)
  })

  it('no corner cutting: a diagonal between two blocked cells is not a move', () => {
    // Only (1,1) -> (0,0)... blocked orthogonals (0,1) and (1,0) around the corner of the goal.
    const g = grid(3, 3, () => 0, (r, c) => (r === 0 && c === 1) || (r === 1 && c === 0) || (r === 2 && c === 0) || (r === 0 && c === 2))
    expect(new LegRouter(g, M).route(idx(g, 1, 1), idx(g, 0, 0))).toBeNull()
  })

  it('a knight move may not jump a one-cell wall', () => {
    // (0,0) -> (1,2) crosses (0,1) and (1,1); block (0,1): no knight move, but the path around is fine.
    const g = grid(3, 2, () => 0, (r, c) => r === 0 && c === 1)
    const leg = new LegRouter(g, M).route(idx(g, 0, 0), idx(g, 1, 2))!
    expect(leg.cells.length).toBeGreaterThan(2)
  })

  it('target walled off or impassable: null', () => {
    const g = grid(20, 20, () => 0, (r, c) => r === 10 || c === 10)
    const R = new LegRouter(g, M)
    expect(R.route(idx(g, 2, 2), idx(g, 15, 15))).toBeNull()
    expect(R.route(idx(g, 2, 2), idx(g, 10, 3))).toBeNull()
  })

  it('slopes beyond the no-go limit are not walkable (step of 25 deg)', () => {
    const t25 = Math.tan((25 * Math.PI) / 180)
    const g = grid(10, 1, (_r, c) => (c >= 5 ? RES * t25 : 0))
    expect(new LegRouter(g, M).route(idx(g, 0, 0), idx(g, 0, 9))).toBeNull()
  })

  it('reuses its buffers: repeated queries give the same answer', () => {
    const g = grid(40, 40, () => 0, (r, c) => c === 20 && r !== 35)
    const R = new LegRouter(g, M)
    const a = R.route(idx(g, 5, 5), idx(g, 5, 35))!
    R.route(idx(g, 30, 30), idx(g, 2, 2))
    const b = R.route(idx(g, 5, 5), idx(g, 5, 35))!
    expect(b.timeS).toBe(a.timeS)
    expect(b.cells).toEqual(a.cells)
  })
})

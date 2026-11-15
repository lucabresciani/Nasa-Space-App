// A* leg router for the Mission Planer (waypoint A -> waypoint B). Same move rules as the engine's
// graph (pipeline/engine/graph.py, SPEC F4, D6): 8 neighbours + 8 knight moves; a move is allowed
// only if both end cells and every cell its straight segment crosses are passable (no corner
// cutting, no knight jump over a one-cell wall). Edge time = horizontal length * pace(theta), theta
// from the elevation difference over the horizontal length; O2 the same with the O2 per metre.
// Heuristic: straight-line length * minimum pace (admissible, so the leg is the fastest one on
// this grid). The grid is the browser's estimate, not WS2's 3 m graph: see data.ts.
import type { GradeModel } from './physio'

export interface RouteGrid {
  width: number
  height: number
  /** cell size, metres (square cells) */
  resM: number
  /** elevation per cell, metres, row-major, row 0 north */
  elev: Float32Array
  /** 1 = walkable, 0 = not */
  passable: Uint8Array
}

export interface Leg {
  /** cell indices from start to end, both included */
  cells: number[]
  timeS: number
  o2L: number
  /** horizontal length, metres */
  distM: number
  /** time from the leg start to each cell, seconds (same length as cells; last = timeS) */
  tauS: number[]
  /** O2 from the leg start to each cell, litres (same length as cells; last = o2L) */
  o2CumL: number[]
}

// (drow, dcol), rows grow southwards (graph.OFFSETS).
const OFFSETS: [number, number][] = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [-1, 1], [1, -1], [1, 1],
  [-2, -1], [-2, 1], [2, -1], [2, 1],
  [-1, -2], [-1, 2], [1, -2], [1, 2],
] // prettier-ignore

/** Cells (relative to the origin) each move's segment crosses (graph._crossings). */
export const CROSSINGS: [number, number][][] = OFFSETS.map(([di, dj]) => {
  if (Math.abs(di) === 1 && Math.abs(dj) === 1) return [[di, 0], [0, dj]]
  if (Math.abs(di) === 2) return [[di / 2, 0], [di / 2, dj]]
  if (Math.abs(dj) === 2) return [[0, dj / 2], [di, dj / 2]]
  return []
})

/** Binary min-heap of (key, node) in typed arrays, grown on demand. */
class Heap {
  keys = new Float64Array(1024)
  nodes = new Int32Array(1024)
  size = 0
  clear(): void {
    this.size = 0
  }
  push(key: number, node: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2)
      k.set(this.keys)
      this.keys = k
      const n = new Int32Array(this.size * 2)
      n.set(this.nodes)
      this.nodes = n
    }
    let i = this.size++
    const { keys, nodes } = this
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= key) break
      keys[i] = keys[p]
      nodes[i] = nodes[p]
      i = p
    }
    keys[i] = key
    nodes[i] = node
  }
  /** Pop the minimum node (caller checks size > 0). */
  pop(): number {
    const { keys, nodes } = this
    const top = nodes[0]
    const last = --this.size
    const k = keys[last]
    const nd = nodes[last]
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= last) break
      if (c + 1 < last && keys[c + 1] < keys[c]) c++
      if (keys[c] >= k) break
      keys[i] = keys[c]
      nodes[i] = nodes[c]
      i = c
    }
    keys[i] = k
    nodes[i] = nd
    return top
  }
}

export class LegRouter {
  private readonly g: RouteGrid
  private readonly m: GradeModel
  private readonly cost: Float64Array
  private readonly parent: Int32Array
  private readonly stamp: Uint32Array // visit generation: cost/parent valid iff stamp === gen
  private readonly closed: Uint32Array
  private gen = 0
  private readonly heap = new Heap()
  private readonly unit: number[]

  constructor(grid: RouteGrid, model: GradeModel) {
    const n = grid.width * grid.height
    if (grid.elev.length !== n || grid.passable.length !== n) throw new Error('RouteGrid arrays do not match width x height')
    this.g = grid
    this.m = model
    this.cost = new Float64Array(n)
    this.parent = new Int32Array(n)
    this.stamp = new Uint32Array(n)
    this.closed = new Uint32Array(n)
    this.unit = OFFSETS.map(([a, b]) => Math.hypot(a, b) * grid.resM)
  }

  /** Allowed move k from (r, c)? Returns the target index or -1. */
  private target(r: number, c: number, k: number): number {
    const { width: W, height: H, passable } = this.g
    const [di, dj] = OFFSETS[k]
    const r2 = r + di
    const c2 = c + dj
    if (r2 < 0 || c2 < 0 || r2 >= H || c2 >= W) return -1
    const j = r2 * W + c2
    if (!passable[j]) return -1
    for (const [xi, xj] of CROSSINGS[k]) if (!passable[(r + xi) * W + (c + xj)]) return -1
    return j
  }

  private edge(i: number, j: number, k: number): { pace: number; o2: number; len: number } {
    const len = this.unit[k]
    const theta = Math.atan((this.g.elev[j] - this.g.elev[i]) / len)
    const p = this.m.lookup(theta)
    return { pace: p.pace, o2: p.o2, len }
  }

  /** Fastest leg from cell `from` to cell `to`, or null when there is none. */
  route(from: number, to: number): Leg | null {
    const { width: W, passable } = this.g
    if (!passable[from] || !passable[to]) return null
    if (from === to) return { cells: [from], timeS: 0, o2L: 0, distM: 0, tauS: [0], o2CumL: [0] }
    if (++this.gen === 0xffffffff) {
      this.stamp.fill(0)
      this.closed.fill(0)
      this.gen = 1
    }
    const gen = this.gen
    const { cost, parent, stamp, closed, heap } = this
    const tr = Math.floor(to / W)
    const tc = to % W
    const hf = this.m.minPace * this.g.resM
    const h = (r: number, c: number) => Math.hypot(r - tr, c - tc) * hf
    heap.clear()
    cost[from] = 0
    parent[from] = -1
    stamp[from] = gen
    heap.push(h(Math.floor(from / W), from % W), from)
    while (heap.size > 0) {
      const i = heap.pop()
      if (closed[i] === gen) continue
      closed[i] = gen
      if (i === to) return this.build(from, to)
      const r = Math.floor(i / W)
      const c = i - r * W
      const ci = cost[i]
      for (let k = 0; k < 16; k++) {
        const j = this.target(r, c, k)
        if (j < 0 || closed[j] === gen) continue
        const e = this.edge(i, j, k)
        if (e.pace === Infinity) continue
        const cj = ci + e.len * e.pace
        if (stamp[j] !== gen || cj < cost[j]) {
          stamp[j] = gen
          cost[j] = cj
          parent[j] = i
          heap.push(cj + h(r + OFFSETS[k][0], c + OFFSETS[k][1]), j)
        }
      }
    }
    return null
  }

  private build(from: number, to: number): Leg {
    const W = this.g.width
    const cells: number[] = []
    for (let i = to; i !== -1; i = this.parent[i]) cells.push(i)
    cells.reverse()
    let timeS = 0
    let o2L = 0
    let distM = 0
    const tauS = [0]
    const o2CumL = [0]
    for (let s = 1; s < cells.length; s++) {
      const a = cells[s - 1]
      const b = cells[s]
      const di = Math.floor(b / W) - Math.floor(a / W)
      const dj = (b % W) - (a % W)
      const k = OFFSETS.findIndex(([x, y]) => x === di && y === dj)
      const e = this.edge(a, b, k)
      timeS += e.len * e.pace
      o2L += e.len * e.o2
      distM += e.len
      tauS.push(timeS)
      o2CumL.push(o2L)
    }
    if (cells[0] !== from) throw new Error('A* path does not start at the start cell')
    return { cells, timeS, o2L, distM, tauS, o2CumL }
  }
}

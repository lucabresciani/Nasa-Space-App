// WS16 task 3 (M3): where to put the binding-limit labels on the zero-margin edge (DESIGN U2: "a
// crisp line where the margin crosses zero and a label naming the limit that binds there").
// CPU scan of the same margin the shader draws (FieldData.at -> margin.ts marginAt) on a coarse
// lattice; a label goes where the margin changes sign between two lattice neighbours, named by the
// binding term on the inside (m >= 0) side. Greedy spacing keeps labels apart.
import type { Variant } from './constants'
import { bilinearXY, type FieldData } from './decode'
import { marginAt, type Binding, type MarginInputs } from './margin'

export interface EdgeLabel {
  lon: number
  lat: number
  binding: Binding
}

export interface EdgeLabelOptions {
  /** lattice step in field pixels (8 px = 40 m on the 5 m grid) */
  stepPx?: number
  maxLabels?: number
  /** minimum spacing between labels, field pixels */
  minSepPx?: number
}

/** Zero-margin crossings on a lattice, one label per binding first, then spaced fill-in. */
export function zeroEdgeLabels(fd: FieldData, inp: MarginInputs, variant: Variant, opts: EdgeLabelOptions = {}): EdgeLabel[] {
  const step = opts.stepPx ?? 8
  const maxLabels = opts.maxLabels ?? 4
  const minSep = opts.minSepPx ?? 120
  const g = fd.t[variant]
  const o2 = fd.o2
  if (!o2) return []
  const nx = Math.floor(g.width / step)
  const ny = Math.floor(g.height / step)
  const m = new Float64Array(nx * ny).fill(NaN)
  const b: (Binding | null)[] = new Array(nx * ny).fill(null)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * step
      const y = (j + 0.5) * step
      const th = bilinearXY(g, x, y)
      const oh = th === null ? null : bilinearXY(o2, x, y)
      if (th === null || oh === null) continue
      const r = marginAt(inp, th, oh)
      m[j * nx + i] = r.margin
      b[j * nx + i] = r.binding
    }
  }
  const [w, s, e, n] = g.bounds
  const cand: { x: number; y: number; binding: Binding }[] = []
  const add = (k0: number, k1: number, x0: number, y0: number, x1: number, y1: number): void => {
    const a = m[k0]
    const c = m[k1]
    if (!(a >= 0 && c < 0) && !(a < 0 && c >= 0)) return // NaN fails both
    const f = a / (a - c)
    cand.push({ x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, binding: (a >= 0 ? b[k0] : b[k1]) as Binding })
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const x = (i + 0.5) * step
      const y = (j + 0.5) * step
      if (i + 1 < nx) add(k, k + 1, x, y, x + step, y)
      if (j + 1 < ny) add(k, k + nx, x, y, x, y + step)
    }
  }
  const out: { x: number; y: number; binding: Binding }[] = []
  const far = (c: { x: number; y: number }): boolean => out.every((o) => Math.hypot(o.x - c.x, o.y - c.y) >= minSep)
  // first the northernmost crossing of each binding (every binding on the edge gets named) ...
  const byBinding = new Map<Binding, (typeof cand)[number]>()
  for (const c of cand) if (!byBinding.has(c.binding)) byBinding.set(c.binding, c)
  for (const c of byBinding.values()) if (out.length < maxLabels && far(c)) out.push(c)
  // ... then spaced fill-in along the edge
  for (const c of cand) if (out.length < maxLabels && far(c)) out.push(c)
  return out.map((c) => ({ lon: w + (c.x / g.width) * (e - w), lat: n - (c.y / g.height) * (n - s), binding: c.binding }))
}

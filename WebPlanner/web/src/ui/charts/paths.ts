// Chart primitives (DESIGN §3.7 "Line, area, bar, step", §5.5: hand-written SVG, no chart library).
// Pure path builders: they place stored values on screen and never invent a value. A null y breaks a
// line (unknown stays a gap). Pieces split at thresholds carry the crossing point of the straight
// segment drawn between two stored points, so a fill colour never disagrees with the line it fills.

export type Pt = readonly [number, number]
export type Scale = (v: number) => number

export function linear([d0, d1]: readonly [number, number], [r0, r1]: readonly [number, number]): Scale {
  const span = d1 - d0
  return (v: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0))
}

const f = (v: number): string => String(+v.toFixed(3))

/** SVG path of a polyline ("M x,y L x,y …"); empty for no points. */
export function linePath(pts: readonly Pt[], x: Scale, y: Scale): string {
  return pts.map(([a, b], i) => `${i ? 'L' : 'M'}${f(x(a))},${f(y(b))}`).join(' ')
}

/** Closed area between the polyline and the baseline y0 (domain units). */
export function areaPath(pts: readonly Pt[], x: Scale, y: Scale, y0: number): string {
  if (!pts.length) return ''
  const first = pts[0]
  const last = pts[pts.length - 1]
  return `M${f(x(first[0]))},${f(y(y0))} ${pts.map(([a, b]) => `L${f(x(a))},${f(y(b))}`).join(' ')} L${f(x(last[0]))},${f(y(y0))} Z`
}

/**
 * Split a polyline into runs whose points all lie in one class (cls(y)); where a straight segment
 * crosses a class boundary (a threshold), the crossing point is inserted and shared by both runs.
 * `thresholds` are the y values where cls changes.
 */
export function splitByClass<C>(pts: readonly Pt[], thresholds: readonly number[], cls: (y: number) => C): { cls: C; pts: Pt[] }[] {
  const out: { cls: C; pts: Pt[] }[] = []
  const push = (p: Pt): void => {
    const c = cls(p[1])
    const cur = out[out.length - 1]
    if (cur && cur.cls === c) cur.pts.push(p)
    else {
      const prev = cur?.pts[cur.pts.length - 1]
      out.push({
        cls: c,
        pts: prev && prev[0] === p[0] && prev[1] === p[1] ? [p] : prev ? [prev, p] : [p],
      })
    }
  }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (i > 0) {
      const q = pts[i - 1]
      // crossings strictly between q and p, in order along the segment
      const xs: Pt[] = []
      for (const th of thresholds) {
        if ((q[1] - th) * (p[1] - th) < 0) {
          const k = (th - q[1]) / (p[1] - q[1])
          xs.push([q[0] + k * (p[0] - q[0]), th])
        }
      }
      xs.sort((a, b) => (p[0] >= q[0] ? a[0] - b[0] : b[0] - a[0]))
      for (const c of xs) {
        // the crossing closes the current run and opens the next one
        const cur = out[out.length - 1]
        cur.pts.push(c)
        out.push({ cls: cls(c[1] + (p[1] > q[1] ? 1e-9 : -1e-9)), pts: [c] })
      }
    }
    push(p)
  }
  return out.filter((r) => r.pts.length > 1 || out.length === 1)
}

/** Ticks every `step` from lo to hi inclusive (domain units). */
export function stepTicks(lo: number, hi: number, step: number): number[] {
  if (!(step > 0)) return []
  const out: number[] = []
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(9))
  return out
}

/** Percent of the domain [d0, d1] (for HTML overlays positioned with left: %). */
export const pct = (v: number, d0: number, d1: number): number => (d1 === d0 ? 0 : ((v - d0) / (d1 - d0)) * 100)

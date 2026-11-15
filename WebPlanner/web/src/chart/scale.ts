// Minimal chart scales for SVG charts. These only place stored values on screen.

export function linear([d0, d1]: [number, number], [r0, r1]: [number, number]) {
  const span = d1 - d0
  return (v: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0))
}

export function log10Scale([d0, d1]: [number, number], range: [number, number]) {
  const s = linear([Math.log10(d0), Math.log10(d1)], range)
  return (v: number) => s(Math.log10(v))
}

export function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / Math.max(1, count)
  const p = 10 ** Math.floor(Math.log10(raw))
  const f = raw / p
  const step = (f > 5 ? 10 : f > 2 ? 5 : f > 1 ? 2 : 1) * p
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12))
  return out
}

export function logTicks(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let e = Math.ceil(Math.log10(lo) - 1e-12); 10 ** e <= hi * (1 + 1e-12); e++) out.push(10 ** e)
  return out
}

/** SVG polyline point strings; a null y breaks the line (unknown stays a gap, never interpolated). */
export function polyline(pts: [number, number | null][], x: (v: number) => number, y: (v: number) => number): string[] {
  const out: string[] = []
  let cur: string[] = []
  for (const [px, py] of pts) {
    if (py === null) {
      if (cur.length) out.push(cur.join(' '))
      cur = []
    } else cur.push(`${+x(px).toFixed(2)},${+y(py).toFixed(2)}`)
  }
  if (cur.length) out.push(cur.join(' '))
  return out
}

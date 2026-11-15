// Legend binning (presentation only). Isochrone minutes are integers 1..60 (contract), so bins are
// (lo, hi] and the MapLibre step stops sit at lo + 1.

export function binEdges(max: number, step: number): number[] {
  const e: number[] = []
  for (let v = 0; v < max; v += step) e.push(v)
  e.push(max)
  return e
}

/** Index of the (lo, hi] bin holding v, or -1 outside. */
export function binIndex(v: number, edges: number[]): number {
  for (let i = 0; i < edges.length - 1; i++) if (v > edges[i] && v <= edges[i + 1]) return i
  return -1
}

export function binLabels(edges: number[], units = 'min'): string[] {
  return edges.slice(0, -1).map((lo, i) => `${lo + 1}–${edges[i + 1]} ${units}`)
}

/**
 * Labels for the bins that hold at least one contour, from the minutes actually present
 * (isochrones.geojson): 5-min contours give "5–10 min", 1-min contours "1–10 min". `i` is the bin
 * index (colour ramp position).
 */
export function binLabelsFor(edges: number[], minutes: number[], units = 'min'): { i: number; label: string }[] {
  const out: { i: number; label: string }[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const inBin = minutes.filter((m) => binIndex(m, edges) === i)
    if (!inBin.length) continue
    const lo = Math.min(...inBin)
    const hi = Math.max(...inBin)
    out.push({ i, label: lo === hi ? `${lo} ${units}` : `${lo}–${hi} ${units}` })
  }
  return out
}

export function stepColorExpression(prop: string, edges: number[], colors: string[]): unknown[] {
  const n = edges.length - 1
  if (colors.length < n) throw new Error(`need ${n} colours for ${n} bins, got ${colors.length}`)
  const expr: unknown[] = ['step', ['get', prop], colors[0]]
  for (let i = 1; i < n; i++) expr.push(edges[i] + 1, colors[i])
  return expr
}

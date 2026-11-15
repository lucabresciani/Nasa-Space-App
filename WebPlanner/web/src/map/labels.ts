// Where to put edge-cause labels: the midpoint of the longest parts of each edge feature.
// HTML markers carry the text, so MapLibre needs no glyph server (offline, no external requests).
import type { EdgeCause, EdgesFC } from '../data/types'

type Pos = number[]

function seg(a: Pos, b: Pos): number {
  // planar length in degrees with longitude scaled by cos(lat): good enough for placing a label
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180))
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1])
}

function partLength(line: Pos[]): number {
  let L = 0
  for (let i = 1; i < line.length; i++) L += seg(line[i - 1], line[i])
  return L
}

export function lineMidpoint(line: Pos[]): [number, number] | null {
  const total = partLength(line)
  if (!(total > 0)) return null
  let acc = 0
  for (let i = 1; i < line.length; i++) {
    const d = seg(line[i - 1], line[i])
    if (acc + d >= total / 2 && d > 0) {
      const t = (total / 2 - acc) / d
      const [x0, y0] = line[i - 1]
      const [x1, y1] = line[i]
      return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)]
    }
    acc += d
  }
  return null
}

export interface LabelLimits {
  /** At most this many labels in total (real edges come as thousands of small features). */
  maxTotal: number
  /** Minimum distance between two labels, degrees (lon scaled by cos lat). */
  minSepDeg: number
}

type LabelPt = { lng: number; lat: number; cause: EdgeCause }

/**
 * Label points for the selected budget: the midpoints of the longest parts of each feature (at
 * most maxPerFeature each). With `limits`, candidates are ranked by part length over the whole
 * layer: first the longest label of each cause present (so a rare cause is never crowded out),
 * then the rest in length order, skipping any closer than minSepDeg to one already placed.
 */
export function edgeLabelPoints(fc: EdgesFC, budget: number, maxPerFeature: number, limits?: LabelLimits): LabelPt[] {
  const cands: (LabelPt & { L: number })[] = []
  for (const f of fc.features) {
    if (f.properties.budget !== budget) continue
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates
    const ranked = parts
      .map((p) => ({ p, L: partLength(p) }))
      .filter((x) => x.L > 0)
      .sort((a, b) => b.L - a.L)
      .slice(0, maxPerFeature)
    for (const { p, L } of ranked) {
      const m = lineMidpoint(p)
      if (m) cands.push({ lng: m[0], lat: m[1], cause: f.properties.cause, L })
    }
  }
  const strip = ({ lng, lat, cause }: LabelPt): LabelPt => ({ lng, lat, cause })
  if (!limits) return cands.map(strip)

  const byLength = [...cands].sort((a, b) => b.L - a.L)
  const out: LabelPt[] = []
  const free = (c: LabelPt) => out.every((o) => seg([o.lng, o.lat], [c.lng, c.lat]) >= limits.minSepDeg)
  const take = (c: LabelPt) => {
    if (out.length < limits.maxTotal && free(c)) out.push(strip(c))
  }
  const seen = new Set<string>()
  for (const c of byLength) {
    if (seen.has(c.cause)) continue
    const before = out.length
    take(c)
    if (out.length > before) seen.add(c.cause)
  }
  for (const c of byLength) if (!out.some((o) => o.lng === c.lng && o.lat === c.lat)) take(c)
  return out
}

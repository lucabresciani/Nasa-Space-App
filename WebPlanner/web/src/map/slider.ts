// Budget slider (F5, D2): its stops are the `minutes` values actually present in the scenario's
// isochrones.geojson (1-min steps per config/variants.yaml outputs.isochrone_minutes, or the 2-min
// fallback step if a scenario exceeds its size budget), so the slider never assumes a step.
// The map filters on `minutes` with a MapLibre expression. Presentation only: list lookups.

interface MinutesFC {
  features: { properties?: { minutes?: unknown } | null }[]
}

/** Distinct finite `minutes` values, ascending. */
export function isochroneMinutes(fc: MinutesFC): number[] {
  const s = new Set<number>()
  for (const f of fc.features) {
    const m = f.properties?.minutes
    if (typeof m === 'number' && Number.isFinite(m)) s.add(m)
  }
  return [...s].sort((a, b) => a - b)
}

/** The common difference of an evenly spaced list (>= 2 values), else null. */
export function uniformStep(values: number[]): number | null {
  if (values.length < 2) return null
  const d = values[1] - values[0]
  for (let i = 2; i < values.length; i++) if (Math.abs(values[i] - values[i - 1] - d) > 1e-9) return null
  return d
}

/** Index of the value nearest to v (ties go to the shorter budget); -1 when empty. */
function nearestIndex(values: number[], v: number): number {
  let best = -1
  for (let i = 0; i < values.length; i++) {
    if (best < 0 || Math.abs(values[i] - v) < Math.abs(values[best] - v)) best = i
  }
  return best
}

/** The contour minute nearest to v, or null when there are no contours. */
export function snapMinutes(values: number[], v: number): number | null {
  const i = nearestIndex(values, v)
  return i < 0 ? null : values[i]
}

/**
 * Keyboard stepping over the present contours: arrows move one contour, Home/End go to the ends,
 * PageUp/PageDown jump to the next/previous present multiple of `pageMin` (the legend bin), or the
 * end of the list. Returns null for keys it does not handle (leave them to the browser).
 */
export function keyStep(values: number[], current: number, key: string, pageMin = 10): number | null {
  if (!values.length) return null
  const i = nearestIndex(values, current)
  const v = values[i]
  const last = values.length - 1
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return values[Math.min(last, current < v ? i : i + 1)]
    case 'ArrowLeft':
    case 'ArrowDown':
      return values[Math.max(0, current > v ? i : i - 1)]
    case 'Home':
      return values[0]
    case 'End':
      return values[last]
    case 'PageUp':
      return values.find((x) => x > v && x % pageMin === 0) ?? values[last]
    case 'PageDown':
      return [...values].reverse().find((x) => x < v && x % pageMin === 0) ?? values[0]
    default:
      return null
  }
}

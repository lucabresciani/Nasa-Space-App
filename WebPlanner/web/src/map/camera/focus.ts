// WS16 task 9 (M9): what "focus on the selection" frames (DESIGN U16 "eases the camera to frame it and
// its legs"). Pure: a selection ref + the map's loaded data -> the points to frame -> a lon/lat box.
// The same lookup gives the highlight geometry (map/select.ts), so what is framed is what is lit.
import type { SelectionRef } from '../../state/selection'

type Coords = [number, number]
interface Feat {
  geometry: { type: string; coordinates: unknown } | null
  properties?: Record<string, unknown> | null
}
interface FC {
  features: readonly Feat[]
}

/** The map's loaded objects (ConsoleMap's last data); every field may be missing. */
export interface FocusSources {
  stations?: readonly { id: string; lon: number; lat: number }[] | null
  pad?: { lon: number; lat: number } | null
  padOptions?: readonly { id: string; lon: number; lat: number }[] | null
  labels?: readonly { code: string; lon: number; lat: number }[] | null
  /** route_{scenario}.geojson as shown (legs: {leg, from, to}) */
  route?: FC | null
  edges?: FC | null
}

/** Every [lon, lat] of a (Multi)LineString / Point geometry. */
export function coordsOf(g: Feat['geometry']): Coords[] {
  if (!g) return []
  const c = g.coordinates as unknown
  if (g.type === 'Point') return [c as Coords]
  if (g.type === 'LineString' || g.type === 'MultiPoint') return c as Coords[]
  if (g.type === 'MultiLineString' || g.type === 'Polygon') return (c as Coords[][]).flat()
  return []
}

/** Route legs that start or end at a stop (route files name the official pad 'pad'). */
export function legsAt(route: FC | null | undefined, stop: string): Feat[] {
  return (route?.features ?? []).filter((f) => f.properties?.from === stop || f.properties?.to === stop)
}

export function legFeature(route: FC | null | undefined, leg: number): Feat | null {
  return route?.features.find((f) => f.properties?.leg === leg) ?? null
}

export function edgeFeatures(edges: FC | null | undefined, cause: string, budget: number): Feat[] {
  return (edges?.features ?? []).filter((f) => f.properties?.cause === cause && f.properties?.budget === budget)
}

/** Where the selected object is: its point (null for lines) and its lines (legs, the edge). */
export function locate(ref: SelectionRef, s: FocusSources): { point: Coords | null; lines: Coords[][] } {
  const lines = (fs: Feat[]): Coords[][] => fs.map((f) => coordsOf(f.geometry)).filter((c) => c.length > 0)
  switch (ref.kind) {
    case 'station': {
      const st = s.stations?.find((x) => x.id === ref.id) ?? s.labels?.find((l) => l.code === ref.id)
      return { point: st ? [st.lon, st.lat] : null, lines: lines(legsAt(s.route, ref.id)) }
    }
    case 'pad': {
      if (ref.id === 'rank1') return { point: s.pad ? [s.pad.lon, s.pad.lat] : null, lines: lines(legsAt(s.route, 'pad')) }
      const o = s.padOptions?.find((x) => x.id === ref.id)
      return { point: o ? [o.lon, o.lat] : null, lines: [] }
    }
    case 'leg': {
      const f = ref.pad ? null : legFeature(s.route, ref.leg)
      return { point: null, lines: f ? lines([f]) : [] }
    }
    case 'landmark': {
      const l = s.labels?.find((x) => x.code === ref.code)
      return { point: l ? [l.lon, l.lat] : null, lines: [] }
    }
    case 'cell':
      return { point: [ref.lon, ref.lat], lines: [] }
    case 'edge': {
      const at: Coords | null = ref.lon !== undefined && ref.lat !== undefined ? [ref.lon, ref.lat] : null
      return { point: at, lines: lines(edgeFeatures(s.edges, ref.cause, ref.budget)) }
    }
  }
}

/** Points to frame: the object and its legs. A picked edge segment frames the place it was picked. */
export function focusPoints(ref: SelectionRef, s: FocusSources): Coords[] {
  const { point, lines } = locate(ref, s)
  if (ref.kind === 'edge' && point) return [point]
  return [...(point ? [point] : []), ...lines.flat()]
}

/**
 * Lon/lat box [west, south, east, north] around the points, at least `minSpanM` wide and tall
 * (on a sphere of `radiusM`), so a single point frames its surroundings. null without points.
 */
export function focusBounds(pts: readonly Coords[], minSpanM: number, radiusM: number): [number, number, number, number] | null {
  if (!pts.length) return null
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [lon, lat] of pts) {
    w = Math.min(w, lon)
    e = Math.max(e, lon)
    s = Math.min(s, lat)
    n = Math.max(n, lat)
  }
  const mPerDegLat = (radiusM * Math.PI) / 180
  const mPerDegLon = mPerDegLat * Math.cos((((s + n) / 2) * Math.PI) / 180)
  const halfLat = minSpanM / 2 / mPerDegLat
  const halfLon = minSpanM / 2 / mPerDegLon
  if ((n - s) * mPerDegLat < minSpanM) {
    const c = (s + n) / 2
    ;[s, n] = [c - halfLat, c + halfLat]
  }
  if ((e - w) * mPerDegLon < minSpanM) {
    const c = (w + e) / 2
    ;[w, e] = [c - halfLon, c + halfLon]
  }
  return [w, s, e, n]
}

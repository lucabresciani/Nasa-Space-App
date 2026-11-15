// Access-cell rule (user decision 2026-11-14 11:40): each station keeps its science coordinate; the
// route goes to the nearest walkable cell within access_radius_m. The app shows both points, the
// walk-in line and its distance, exactly as WS2 wrote them (card access block, else stations.json
// `access[scenario]`). No snapping, no invented access point.
import type { FeatureCollection, LineString } from 'geojson'
import type { Card, Station, WalkIn } from './types'

export interface AccessView {
  science: { lon: number; lat: number }
  access: { lon: number; lat: number } | null
  dist_m: number | null
  reason: string | null
  walkIn: WalkIn | null
  radius_m: number | null
  rule: string | null
  /** access: an access cell exists; none: the producer says there is none; unknown: no access data. */
  state: 'access' | 'none' | 'unknown'
  /** File the values were read from, and the manifest key prefix for its numbers. */
  file: string
  keyPrefix: string
}

export function accessFor(s: Station, scenarioId: string, card?: Card | null): AccessView {
  const science = { lon: s.lon, lat: s.lat }
  const fromCard = card?.access
  const a = fromCard ?? s.access?.[scenarioId]
  const file = fromCard ? s.card : 'stations.json'
  const keyPrefix = fromCard ? `card.${s.id}.access` : `access.${s.id}.${scenarioId}`
  const radius = fromCard?.radius_m ?? s.access_radius_m ?? null
  if (!a) return { science, access: null, dist_m: null, reason: null, walkIn: null, radius_m: radius, rule: null, state: 'unknown', file, keyPrefix }
  const has = a.lon !== null && a.lat !== null
  return {
    science,
    access: has ? { lon: a.lon!, lat: a.lat! } : null,
    dist_m: has ? a.dist_m : null,
    reason: a.reason,
    walkIn: a.walk_in,
    radius_m: radius,
    rule: a.rule ?? null,
    state: has ? 'access' : 'none',
    file,
    keyPrefix,
  }
}

/** Straight science->access lines (walk-in, not modelled) for stations whose access cell is apart. */
export function walkInLines(stations: Station[], scenarioId: string): FeatureCollection<LineString, { station: string; dist_m: number | null }> {
  const features = []
  for (const s of stations) {
    const a = accessFor(s, scenarioId)
    if (!a.access || !(a.dist_m !== null && a.dist_m > 0)) continue
    features.push({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: [[a.science.lon, a.science.lat], [a.access.lon, a.access.lat]] },
      properties: { station: s.id, dist_m: a.dist_m },
    })
  }
  return { type: 'FeatureCollection', features }
}

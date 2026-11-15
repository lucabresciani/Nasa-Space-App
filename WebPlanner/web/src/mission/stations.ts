// Science station -> Mission Planer waypoint (#/mission?add=S1, station popup on the planner map).
// The waypoint goes to WS2's access cell for the scenario (data/access.ts: no snapping, no invented
// point), else the science point when there is no access data; it stops for the station's dwell time.
import { accessFor } from '../data/access'
import type { Station } from '../data/types'
import type { SharedWaypoint } from './share'

export function stationWaypoint(s: Station, scenarioId: string): SharedWaypoint | null {
  const a = accessFor(s, scenarioId)
  if (a.state === 'none') return null
  const p = a.access ?? a.science
  return { lon: p.lon, lat: p.lat, stopMin: s.dwell_min, tags: [], note: `${s.id} · ${s.name}`, station: s.id }
}

// Mission Planer plan link: the waypoints (position, stop time, tags, note, station) packed into a
// short URL-safe string for `#/mission?plan=…` and the per-browser saved plan. Grid cells are not
// stored: the page snaps each position again on load, so a link stays valid if the grid changes.
// Format v1: base64url(UTF-8 JSON [1, [[lon, lat, stopMin, tagMask, note, station?], …]]).
import { stopMinutes } from './budget'
import { WAYPOINT_TAGS } from './plan'

export interface SharedWaypoint {
  lon: number
  lat: number
  stopMin: number
  tags: string[]
  note: string
  /** science station id when the waypoint was added from a station */
  station?: string
}

const VERSION = 1
const round6 = (v: number) => Math.round(v * 1e6) / 1e6

function toB64Url(s: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64Url(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export function encodePlan(wps: SharedWaypoint[]): string {
  if (!wps.length) return ''
  const rows = wps.map((w) => {
    const mask = WAYPOINT_TAGS.reduce((m, t, i) => (w.tags.includes(t) ? m | (1 << i) : m), 0)
    const row: (number | string)[] = [round6(w.lon), round6(w.lat), stopMinutes(w.stopMin), mask, w.note]
    if (w.station) row.push(w.station)
    return row
  })
  return toB64Url(JSON.stringify([VERSION, rows]))
}

/** The waypoints of a plan string, [] for '', null when it is not a valid v1 plan. */
export function decodePlan(s: string): SharedWaypoint[] | null {
  if (!s) return []
  try {
    const v: unknown = JSON.parse(fromB64Url(s))
    if (!Array.isArray(v) || v[0] !== VERSION || !Array.isArray(v[1])) return null
    const out: SharedWaypoint[] = []
    for (const r of v[1] as unknown[]) {
      if (!Array.isArray(r)) return null
      const [lon, lat, stop, mask, note, station] = r
      if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) return null
      const m = typeof mask === 'number' ? mask : 0
      const w: SharedWaypoint = {
        lon,
        lat,
        stopMin: stopMinutes(typeof stop === 'number' ? stop : 0),
        tags: WAYPOINT_TAGS.filter((_, i) => m & (1 << i)),
        note: typeof note === 'string' ? note : '',
      }
      if (typeof station === 'string' && station) w.station = station
      out.push(w)
    }
    return out
  } catch {
    return null
  }
}

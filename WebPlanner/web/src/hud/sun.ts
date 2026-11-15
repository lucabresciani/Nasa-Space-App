// Sun / time-to-dark row of the expanded panel (F18; C decision 12:20: no sun.json, WS7 reads
// WS4's conditions/clock.json). Lookups only: eva.sun_series is WS4's Mars24 sun position every
// 5 min of the simulated EVA (columns named in eva.sun_series_columns); eva.t_dark_min is minutes
// from the EVA start to sunset on a flat horizon at the pad; eva.t_dark_min_by_observer is the
// same against each WS3 point horizon (null = horizon unknown toward the sun). The browser only
// interpolates the series (never extrapolates) and subtracts the EVA clock.
import type { RowSource } from './provenance'

export interface ClockFile {
  eva?: {
    sun_series_columns: string[]
    sun_series: number[][]
    t_dark_min: number | null
    t_dark_min_by_observer?: Record<string, number | null>
    t_dark_definition?: string
  }
}

export interface SunData {
  tMin: number[]
  lmstH: number[]
  azDeg: number[]
  elDeg: number[]
  tDarkMin: number | null
  byObserver: Record<string, number | null>
}

export interface SunReading {
  /** sun position at the EVA minute; null outside WS4's series */
  azDeg: number | null
  elDeg: number | null
  lmstH: number | null
  /** minutes until the sun is below a flat horizon at the pad (negative = after) */
  darkInMin: number | null
  /** range over the WS3 horizons with a known value; null = none */
  local: { minId: string; min: number; maxId: string; max: number; n: number; nUnknown: number } | null
  /** the station's own horizon when the HUD is at that station and WS4 has it */
  station: { id: string; darkInMin: number } | null
}

const COLS = ['t_eva_min', 'lmst_h', 'sun_azimuth_deg', 'sun_elevation_deg'] as const

/** clock.json -> SunData; null when the file has no EVA sun series. */
export function parseClockSun(clock: ClockFile): SunData | null {
  const eva = clock.eva
  if (!eva || !Array.isArray(eva.sun_series) || !Array.isArray(eva.sun_series_columns)) return null
  const idx = COLS.map((c) => eva.sun_series_columns.indexOf(c))
  if (idx.some((i) => i < 0)) return null
  const col = (k: number) => eva.sun_series.map((r) => r[idx[k]])
  const tMin = col(0)
  for (let i = 1; i < tMin.length; i++) {
    if (!(tMin[i] > tMin[i - 1])) throw new Error(`clock.json eva.sun_series: t_eva_min not increasing at row ${i}`)
  }
  return {
    tMin,
    lmstH: col(1),
    azDeg: col(2),
    elDeg: col(3),
    tDarkMin: eva.t_dark_min ?? null,
    byObserver: eva.t_dark_min_by_observer ?? {},
  }
}

function lerpAngle(a: number, b: number, f: number): number {
  const d = ((b - a + 540) % 360) - 180
  return (((a + f * d) % 360) + 360) % 360
}

export function sunAt(sun: SunData, tEvaMin: number, stationId?: string | null): SunReading {
  const t = sun.tMin
  let azDeg: number | null = null
  let elDeg: number | null = null
  let lmstH: number | null = null
  if (t.length && tEvaMin >= t[0] && tEvaMin <= t[t.length - 1]) {
    let i = 0
    while (i < t.length - 2 && t[i + 1] <= tEvaMin) i++
    const f = t.length > 1 ? (tEvaMin - t[i]) / (t[i + 1] - t[i]) : 0
    const j = Math.min(i + 1, t.length - 1)
    if (f === 0 || j === i) {
      azDeg = sun.azDeg[i]
      elDeg = sun.elDeg[i]
      lmstH = sun.lmstH[i]
    } else if (f === 1) {
      azDeg = sun.azDeg[j]
      elDeg = sun.elDeg[j]
      lmstH = sun.lmstH[j]
    } else {
      azDeg = lerpAngle(sun.azDeg[i], sun.azDeg[j], f)
      elDeg = sun.elDeg[i] + f * (sun.elDeg[j] - sun.elDeg[i])
      lmstH = sun.lmstH[i] + f * (sun.lmstH[j] - sun.lmstH[i])
    }
  }
  let local: SunReading['local'] = null
  let nUnknown = 0
  for (const [id, v] of Object.entries(sun.byObserver)) {
    if (v === null || !Number.isFinite(v)) {
      nUnknown++
      continue
    }
    const left = v - tEvaMin
    if (!local) local = { minId: id, min: left, maxId: id, max: left, n: 0, nUnknown: 0 }
    if (left < local.min) Object.assign(local, { minId: id, min: left })
    if (left > local.max) Object.assign(local, { maxId: id, max: left })
    local.n++
  }
  if (local) local.nUnknown = nUnknown
  const own = stationId ? sun.byObserver[stationId] : undefined
  return {
    azDeg,
    elDeg,
    lmstH,
    darkInMin: sun.tDarkMin === null ? null : sun.tDarkMin - tEvaMin,
    local,
    station: stationId && typeof own === 'number' && Number.isFinite(own) ? { id: stationId, darkInMin: own - tEvaMin } : null,
  }
}

const DASH = '—'
/** Minutes left, floored: never shows more time than WS4's number. */
const minLeft = (v: number) => `${Math.floor(v)}`

export function sunRowText(r: SunReading): { value: string; sub: string } {
  const value = r.darkInMin === null ? DASH : r.darkInMin <= 0 ? 'DARK' : `dark in ${minLeft(r.darkInMin)} min`
  const parts = [
    r.elDeg === null || r.azDeg === null ? `sun position ${DASH}` : `sun el ${r.elDeg.toFixed(1)}°, az ${Math.round(r.azDeg) % 360}°`,
    'flat horizon at pad',
  ]
  if (r.local) {
    parts.push(`local horizons ${minLeft(r.local.min)}–${minLeft(r.local.max)} min (${r.local.n} stops${r.local.nUnknown ? `, ${r.local.nUnknown} unknown` : ''})`)
  }
  if (r.station) parts.push(`at ${r.station.id}: ${minLeft(r.station.darkInMin)} min`)
  return { value, sub: parts.join(' · ') }
}

/** Manifest keys (WS4 pipeline__conditions__clockfile.json) behind the numbers on the row. */
export function sunSources(r: SunReading): RowSource {
  const keys = ['clock.eva.t_dark_min', 'clock.eva.sun_series']
  const obs = new Set<string>()
  if (r.station) obs.add(r.station.id)
  if (r.local) {
    obs.add(r.local.minId)
    obs.add(r.local.maxId)
  }
  for (const id of obs) keys.push(`clock.eva.t_dark_min_by_observer.${id}`)
  return { keys, files: ['conditions/clock.json'] }
}

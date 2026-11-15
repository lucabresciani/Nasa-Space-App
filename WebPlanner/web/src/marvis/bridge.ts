// MARVIS bridge: the page side of the small HTTP API the MARVIS simulator (Unity) serves next to
// this app when it embeds it. Page and API share one origin (http://127.0.0.1:<port>/), so plain
// fetch works. Everything here is inert on the public site and on any plain static host:
// detect() answers false and nothing else is called.
//   GET  /marvis/api/hello    {"app":"MARVIS","bridge":1,"version":"..."}
//   GET  /marvis/api/state    {"seq","planner_visible","eva","mission_id","eva_log_seq","last_error"}
//   POST /marvis/api/mission  mission.json text (header X-Marvis: 1) -> {"ok":true,"mission_id"} | 422 {"ok":false,"error"}
//   GET  /marvis/api/eva-log  the latest eva_log document (contracts/bundle/eva_log.schema.json) | 404
//   POST /marvis/api/close    (header X-Marvis: 1) -> {"ok":true}
const API = '/marvis/api'
const POST_HEADERS = { 'Content-Type': 'application/json', 'X-Marvis': '1' }

export interface MarvisState {
  /** increases on every change */
  seq: number
  planner_visible: boolean
  /** idle = no web mission loaded; running = loaded, no log yet; complete / ended = its log is in */
  eva: 'idle' | 'running' | 'complete' | 'ended'
  mission_id: string | null
  /** 0 = no log yet; increases with each new log */
  eva_log_seq: number
  last_error: string | null
}

/** The parts of eva_log.json the debrief shows (contracts/bundle/eva_log.schema.json). */
export interface EvaLog {
  kind: 'homeline_eva_log'
  mission_id: string | null
  title: string
  label: string
  /** where the log comes from, in words (the simulator, or a test tool that says so) */
  origin_label?: string
  o2_model: string
  summary: {
    complete: boolean
    eva_min: number | null
    planned_eva_min: number | null
    waypoints_done: number
    waypoints_skipped: number
    stops_left_early: number
    lowest_margin_min: number | null
    lowest_binding: string | null
    max_cross_track_m: number | null
    o2_used_l: number | null
    planned_o2_used_l: number | null
  }
  events: { t_min: number; kind: string; wp: number | null; detail?: string }[]
  track: { columns: string[]; rows: (number | string | null)[][] }
}

let detected: Promise<boolean> | undefined

async function probe(): Promise<boolean> {
  // MARVIS serves the app on the loopback address only: anywhere else, do not even ask.
  if (typeof location === 'undefined' || !/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return false
  // Any answer is final. Only a timeout is tried again, with more patience: the simulator can be
  // busy while it starts, and a wrong "no" would hide its controls for the whole session.
  for (const ms of [800, 2000, 5000]) {
    try {
      const res = await fetch(`${API}/hello`, { cache: 'no-store', signal: AbortSignal.timeout(ms) })
      if (!res.ok) return false
      return ((await res.json()) as { app?: unknown } | null)?.app === 'MARVIS'
    } catch (e) {
      if (!(e instanceof Error && e.name === 'TimeoutError')) return false
    }
  }
  return false
}

/** True when this page is served by MARVIS. Asked once, then cached; never throws. */
export function detect(): Promise<boolean> {
  return (detected ??= probe())
}

/** Hand a finalized mission document to the simulator; it then hides the planner and starts the EVA. */
export async function sendMission(doc: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API}/mission`, { method: 'POST', headers: POST_HEADERS, body: JSON.stringify(doc) })
    const j = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null
    if (res.ok && j?.ok === true) return { ok: true }
    return { ok: false, error: typeof j?.error === 'string' && j.error ? j.error : `HTTP ${res.status}` }
  } catch {
    return { ok: false, error: 'MARVIS did not answer' }
  }
}

/** Hide the planner and return to the simulator's own menu. False when MARVIS did not answer. */
export async function closePlanner(): Promise<boolean> {
  try {
    return (await fetch(`${API}/close`, { method: 'POST', headers: POST_HEADERS })).ok
  } catch {
    return false
  }
}

/** Call `cb` with the simulator state about once per second while the page is visible. Returns the unsubscribe function. */
export function watchState(cb: (s: MarvisState) => void): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    clearTimeout(timer)
    if (stopped || document.hidden) return // a hidden page starts again on visibilitychange
    try {
      const res = await fetch(`${API}/state`, { cache: 'no-store' })
      if (res.ok && !stopped) cb((await res.json()) as MarvisState)
    } catch {
      /* no answer this time: the next tick asks again */
    }
    if (!stopped) timer = setTimeout(() => void tick(), 1000)
  }
  const onVisible = () => void tick()
  document.addEventListener('visibilitychange', onVisible)
  void tick()
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

/** The latest EVA log, or null when there is none (404) or it is not an eva_log document. */
export async function fetchEvaLog(): Promise<EvaLog | null> {
  try {
    const res = await fetch(`${API}/eva-log`, { cache: 'no-store' })
    if (!res.ok) return null
    const j = (await res.json()) as EvaLog | null
    return j?.kind === 'homeline_eva_log' && !!j.summary && Array.isArray(j.track?.rows) ? j : null
  } catch {
    return null
  }
}

/** The walked track as [lon, lat] points: track.rows by its "lon" and "lat" columns, unknown positions left out. */
export function trackLonLat(log: EvaLog): [number, number][] {
  const iLon = log.track.columns.indexOf('lon')
  const iLat = log.track.columns.indexOf('lat')
  if (iLon < 0 || iLat < 0) return []
  const out: [number, number][] = []
  for (const r of log.track.rows) {
    const lon = r[iLon]
    const lat = r[iLat]
    if (typeof lon === 'number' && typeof lat === 'number') out.push([lon, lat])
  }
  return out
}

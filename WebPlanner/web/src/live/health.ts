// Health check and the live/offline state (F23, kit rule 4). /health must answer ok within
// api.health_timeout_s (2 s) or the app stays static and shows OFFLINE_LABEL in place of the live
// controls. While engine_warm is false the state is 'warming'. The check repeats in every state
// (watchHealth), so the banner follows a server that dies or returns mid-session.
import type { ApiClient } from './client'
import { CLIENT, HEALTH_TIMEOUT_MS, OFFLINE_LABEL, WARMING_LABEL } from './config'
import type { Health } from './types'

export type OfflineReason = 'timeout' | 'unreachable' | 'not-ok' | 'invalid'

export type LiveState =
  | { kind: 'checking' }
  | { kind: 'offline'; reason: OfflineReason }
  | { kind: 'warming'; health: Health }
  | { kind: 'ready'; health: Health }

function isHealth(v: unknown): v is Health {
  if (!v || typeof v !== 'object') return false
  const h = v as Record<string, unknown>
  return (
    typeof h.ok === 'boolean' &&
    typeof h.engine_warm === 'boolean' &&
    typeof h.queue_length === 'number' &&
    (h.heavy_jobs === 'on' || h.heavy_jobs === 'off')
  )
}

/** One health check: never takes longer than timeoutMs, never throws. */
export async function checkHealth(client: ApiClient, timeoutMs = HEALTH_TIMEOUT_MS, signal?: AbortSignal): Promise<LiveState> {
  let h: unknown
  try {
    h = await client.health({ timeoutMs, signal })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'timeout') return { kind: 'offline', reason: 'timeout' }
    // An HTTP error answer (5xx, 404 ...) is a not-ok server; no answer at all is unreachable.
    const status = (e as { status?: number }).status ?? 0
    return { kind: 'offline', reason: status > 0 ? 'not-ok' : 'unreachable' }
  }
  if (!isHealth(h)) return { kind: 'offline', reason: 'invalid' }
  if (!h.ok) return { kind: 'offline', reason: 'not-ok' }
  return h.engine_warm ? { kind: 'ready', health: h } : { kind: 'warming', health: h }
}

/** The page's visibility (the global document): polling pauses while hidden. */
export interface VisibilitySource {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', fn: () => void): void
  removeEventListener(type: 'visibilitychange', fn: () => void): void
}

export interface WatchOptions {
  timeoutMs?: number
  /** Re-check interval while warming (default CLIENT.warmPollMs). */
  warmPollMs?: number
  /** Re-check interval while ready or offline (default CLIENT.healthPollMs). */
  pollMs?: number
  /** Default: the global document when there is one; null: always visible. */
  visibility?: VisibilitySource | null
}

/** Stop function (call it on unmount) that can also ask for a check now. */
export type HealthWatch = (() => void) & {
  /** Check now instead of at the next poll (a live request just failed). */
  check(): void
}

function pageVisibility(): VisibilitySource | null {
  const d = (globalThis as { document?: Partial<VisibilitySource> }).document
  return d && typeof d.addEventListener === 'function' && typeof d.removeEventListener === 'function' ? (d as VisibilitySource) : null
}

/**
 * Check health now and keep checking (kit rule 4, H2 step 3): every warmPollMs while warming,
 * every pollMs while ready or offline, so a server that dies mid-session shows the offline banner
 * within pollMs + timeoutMs and a server that comes back shows the controls again. Polling pauses
 * while the page is hidden and checks at once when it is shown again. One check at a time; a
 * check() during a check runs one more right after it.
 */
export function watchHealth(client: ApiClient, onState: (s: LiveState) => void, opts: WatchOptions = {}): HealthWatch {
  const vis = opts.visibility === undefined ? pageVisibility() : opts.visibility
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: AbortController | null = null
  let again = false

  const run = async (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    if (stopped) return
    if (inflight) {
      again = true
      return
    }
    const ctl = (inflight = new AbortController())
    const s = await checkHealth(client, timeoutMs, ctl.signal)
    if (inflight === ctl) inflight = null
    if (stopped || ctl.signal.aborted) return
    onState(s)
    if (again) {
      again = false
      return run()
    }
    if (vis?.hidden) return
    timer = setTimeout(run, s.kind === 'warming' ? (opts.warmPollMs ?? CLIENT.warmPollMs) : (opts.pollMs ?? CLIENT.healthPollMs))
  }
  const onVisibility = () => {
    if (!vis || stopped) return
    if (vis.hidden) {
      clearTimeout(timer)
      timer = undefined
    } else void run()
  }

  vis?.addEventListener('visibilitychange', onVisibility)
  onState({ kind: 'checking' })
  void run()
  const stop = () => {
    stopped = true
    inflight?.abort()
    clearTimeout(timer)
    vis?.removeEventListener('visibilitychange', onVisibility)
  }
  return Object.assign(stop, {
    check() {
      void run()
    },
  })
}

export interface Banner {
  /** Banner text, or null when no banner is shown. */
  text: string | null
  tone: 'muted' | 'warn' | 'ok'
  /** Live controls (pad tool, compute) are shown only when the engine is ready. */
  controls: boolean
  /** Heavy jobs (POST /jobs) are allowed: false when the kill switch HL_HEAVY_JOBS_OFF is on. */
  heavyJobs: boolean
}

export function bannerFor(s: LiveState): Banner {
  switch (s.kind) {
    case 'checking':
      return { text: null, tone: 'muted', controls: false, heavyJobs: false }
    case 'offline':
      return { text: OFFLINE_LABEL, tone: 'muted', controls: false, heavyJobs: false }
    case 'warming':
      return { text: WARMING_LABEL, tone: 'warn', controls: false, heavyJobs: false }
    case 'ready':
      return { text: null, tone: 'ok', controls: true, heavyJobs: s.health.heavy_jobs === 'on' }
  }
}

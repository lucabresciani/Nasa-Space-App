// Nav file loader on WS5's loader (data/loader.ts): caching, missing vs invalid, the dummy-in-real
// guard and the contract check (data/contracts.ts covers every nav and localisation path).
import { createLoader, DataError, type TextFetcher } from '../data/loader'
import type { DataMode } from '../env'
import type { Fix, FixIntervalSummary, Localisation, MonteCarlo, TracksFC } from './types'

/** contracts v1.0.0: one summary file with a `set` field (the pipeline writes the default set). */
export const SUMMARY_PATH = 'nav/fix_interval_summary.json'

/** Text fetcher on the slot's dataUrl (same rules as WS5's browserFetcher). */
export function slotFetcher(dataUrl: (p: string) => string): TextFetcher {
  return async (path) => {
    const res = await fetch(dataUrl(path))
    if (res.status === 404) return null
    if (!res.ok) throw new DataError(path, 'missing', `HTTP ${res.status}`)
    const text = await res.text()
    if (/^\s*<!doctype html/i.test(text)) return null
    return text
  }
}

export function createNavLoader(fetchText: TextFetcher, mode: DataMode) {
  const base = createLoader(fetchText, mode)
  const json = base.json

  /** The summary for `set`, or null when the single file describes another set. */
  async function summary(set: string): Promise<FixIntervalSummary | null> {
    const s = await json<FixIntervalSummary>(SUMMARY_PATH)
    return s.set === set ? s : null
  }

  return {
    mode,
    montecarlo: (set: string) => json<MonteCarlo>(`nav/montecarlo_${set}.json`),
    fixes: () => json<Fix[]>('nav/fixes.json'),
    tracks: (set: string) => json<TracksFC>(`nav/tracks_${set}.geojson`),
    summary,
    summaryAny: () => json<FixIntervalSummary>(SUMMARY_PATH),
    localisation: (imageId: string) => json<Localisation>(`localisation/${imageId}.json`),
    optional: base.optional,
    base,
  }
}

export type NavLoader = ReturnType<typeof createNavLoader>

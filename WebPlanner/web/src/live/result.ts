// A live result is a data tree in the static contracts (kit rule 7: one rendering path). Load it
// through the existing contract-checking loader with the result's base URL; no second renderer.
import { browserFetcher, createLoader, type Loader, type TextFetcher } from '../data/loader'
import { dataUrl } from '../env'
import type { FetchLike } from './client'

/** resultBase: ApiClient.resultBase(job) or JobOutcome.resultBase. */
export function liveLoader(resultBase: string): Loader {
  return createLoader(browserFetcher('real', resultBase), 'real')
}

/**
 * Dev mock only (VITE_LIVE_MOCK=1): the same loader, reading through the mock fetch instead of the
 * network. Same URL (dataUrl with base) and the same 404 -> missing rule as browserFetcher.
 */
export function mockLiveLoader(fetch: FetchLike): (resultBase: string) => Loader {
  return (resultBase) => {
    const text: TextFetcher = async (path) => {
      const res = await fetch(dataUrl(path, 'real', resultBase))
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
      return res.text()
    }
    return createLoader(text, 'real')
  }
}

// App-wide provenance state: the loaded manifest and the numbers shown without a manifest entry.
import { IS_DEV } from '../env'
import type { Manifest } from '../data/types'
import { resolveProvenance, type ProvQuery, type ProvResult } from './provenance'

let manifest: Manifest | null = null
const unbacked = new Map<string, ProvQuery & { status: string }>()
const listeners = new Set<() => void>()

export function setManifest(m: Manifest | null): void {
  manifest = m
}
export function getManifest(): Manifest | null {
  return manifest
}

export function lookup(q: ProvQuery): ProvResult {
  const r = resolveProvenance(manifest, q)
  if (r.status === 'missing' || r.status === 'mismatch' || r.status === 'no-manifest') {
    const id = `${q.file}|${JSON.stringify(q.value)}|${q.key ?? ''}`
    if (!unbacked.has(id)) {
      unbacked.set(id, { ...q, status: r.status })
      if (IS_DEV) console.warn(`[provenance] ${r.status}: ${JSON.stringify(q.value)} from ${q.file}`, q.key ?? '')
      queueMicrotask(() => listeners.forEach((f) => f()))
    }
  }
  return r
}

export function unbackedNumbers(): (ProvQuery & { status: string })[] {
  return [...unbacked.values()]
}
export function clearUnbacked(): void {
  unbacked.clear()
  listeners.forEach((f) => f())
}
export function onUnbackedChange(f: () => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}

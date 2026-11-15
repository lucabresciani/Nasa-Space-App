// D76 "Send to simulator" slot (behind VITE_SIM_EXPORT, default off). It lists every file the loaded
// result's manifest marks with kind "sim_plan" and offers it as a download. The simulator's plan
// format is still open, so nothing here names, parses or assumes such a file: it only reads the
// manifest's `kind` and `file` fields. With the flag off, or with no sim_plan entry, it renders nothing.
import type { Manifest } from '../data/types'
import { dataUrl } from '../env'

export const SIM_PLAN_KIND = 'sim_plan'

export interface SimFile {
  /** Manifest key of the entry. */
  key: string
  /** Path under the result tree, as the manifest gives it. */
  file: string
}

/** Every manifest entry of kind sim_plan (one per file, sorted by path). */
export function simPlanFiles(manifest: Manifest | null | undefined): SimFile[] {
  if (!manifest) return []
  const out = new Map<string, SimFile>()
  for (const [key, e] of Object.entries(manifest as Record<string, unknown>)) {
    const entry = e as { kind?: unknown; file?: unknown } | null
    if (!entry || typeof entry !== 'object' || entry.kind !== SIM_PLAN_KIND || typeof entry.file !== 'string' || !entry.file) continue
    if (!out.has(entry.file)) out.set(entry.file, { key, file: entry.file })
  }
  return [...out.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/** Last path segment, used as the suggested download name (taken from the manifest, never invented). */
const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

export interface SimSlotProps {
  /** SIM_EXPORT_ENABLED (VITE_SIM_EXPORT). */
  enabled: boolean
  manifest: Manifest | null
  /** Result base URL (files resolve as dataUrl(file, 'real', base)). */
  base: string
}

export function SimSlot({ enabled, manifest, base }: SimSlotProps) {
  if (!enabled) return null
  const files = simPlanFiles(manifest)
  if (!files.length) return null
  return (
    <section class="live-card live-sim">
      <h3>Send to simulator</h3>
      <ul class="live-sim-files">
        {files.map((f) => (
          <li>
            <a class="live-sim-file" href={dataUrl(f.file, 'real', base)} download={baseName(f.file)} title={`manifest: ${f.key}`}>
              {f.file}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

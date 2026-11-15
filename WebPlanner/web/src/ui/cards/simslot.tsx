// D76 "Send to simulator" slot (package A5s), on the plan / route-summary card and (later) in the
// Report view. Behind VITE_SIM_EXPORT, default off. It lists every file the loaded result's manifest
// marks with kind "sim_plan" and offers each as a download from the result tree. The simulator's
// plan format is still open, so this reads only the manifest entries' `kind` and `file` fields: it
// never names, fetches, parses or validates such a file. With the flag off, or with no sim_plan
// entry, it renders nothing.
//
// Independent of src/live/simslot.tsx on purpose: the static app may not import src/live/
// (live/isolation.test.ts). Same rule, a few lines.
import type { Manifest } from '../../data/types'
import { DATA_MODE, dataUrl } from '../../env'
import { getManifest } from '../../prov/store'
import { t } from '../copy'
import { Icon } from '../components'

const SIM_PLAN_KIND = 'sim_plan'

/**
 * VITE_SIM_EXPORT, read like VITE_LIVE ('1' or 'true' = on, anything else or unset = off). Vite inlines
 * the value at build time, so with the flag off the slot's body folds away.
 */
export function simExportOn(): boolean {
  return import.meta.env.VITE_SIM_EXPORT === '1' || import.meta.env.VITE_SIM_EXPORT === 'true'
}

export interface SimPlanFile {
  /** Manifest key of the entry. */
  key: string
  /** Path in the result tree, exactly as the manifest gives it. */
  file: string
}

/** Every manifest entry of kind sim_plan, one per file, sorted by path. */
export function simPlanFiles(manifest: Manifest | null | undefined): SimPlanFile[] {
  const out = new Map<string, SimPlanFile>()
  for (const [key, e] of Object.entries((manifest ?? {}) as Record<string, unknown>)) {
    const x = e as { kind?: unknown; file?: unknown } | null
    if (x && x.kind === SIM_PLAN_KIND && typeof x.file === 'string' && x.file && !out.has(x.file)) out.set(x.file, { key, file: x.file })
  }
  return [...out.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

export interface SimSlotProps {
  /** The loaded result's manifest (default: the app's loaded manifest, prov/store). */
  manifest?: Manifest | null
  /** Root URL of the loaded result tree (e.g. a live result); default: the static data tree. */
  base?: string
}

export function SimSlot({ manifest, base }: SimSlotProps) {
  // Same test as simExportOn(), written inline so the minifier folds it and drops the rest when off.
  if (!(import.meta.env.VITE_SIM_EXPORT === '1' || import.meta.env.VITE_SIM_EXPORT === 'true')) return null
  const files = simPlanFiles(manifest === undefined ? getManifest() : manifest)
  if (!files.length) return null
  return (
    <section class="hl-simslot" data-slot="sim" aria-label={t('simulator.sendSlot')}>
      <h4 class="hl-cardx__h">{t('simulator.sendSlot')}</h4>
      <p class="hl-cardx__muted">{t('simulator.sendSlotHint')}</p>
      <ul class="hl-cardx__list">
        {files.map((f) => (
          <li>
            <a class="hl-simslot__file" href={dataUrl(f.file, DATA_MODE, base)} download={f.file.split('/').filter(Boolean).pop() ?? f.file} title={`manifest: ${f.key}`}>
              <Icon name="download" />
              <span>{f.file}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

// Labelling components (brief WS5 task 2): "Simulated EVA" and "assumed" tags, real / modelled /
// simulated tags, dummy notice, data-state boxes. Label text comes from config/ where it exists
// there (hud.yaml labels.simulated).
import type { ComponentChildren } from 'preact'
import { CONFIG } from '../config'
import { DATA_MODE } from '../env'
import { DataError } from '../data/loader'

export function SimulatedLabel() {
  return <span class="tag tag-simulated">{CONFIG.simulatedLabel}</span>
}

export function AssumedTag({ note }: { note?: string }) {
  return (
    <span class="tag tag-assumed" title={note ?? 'Assumed value, not measured; see the assumptions table on the scorecard'}>
      assumed
    </span>
  )
}

export function StatusTag({ kind }: { kind: 'real' | 'modelled' | 'simulated' }) {
  return <span class={`tag tag-${kind}`}>{kind}</span>
}

export function DummyNote() {
  if (DATA_MODE !== 'dummy') return null
  return <p class="dummy-note">Dummy data: synthetic world, not Mars results. Never capture.</p>
}

export function DataProblem({ error, what }: { error: unknown; what: string }) {
  if (error instanceof DataError && error.kind === 'missing') {
    return (
      <div class="data-problem">
        <b>{what}: not available yet.</b> <code>{error.path}</code> is not in the {DATA_MODE === 'dummy' ? 'dummy' : 'real'} data tree.
      </div>
    )
  }
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <div class="data-problem error">
      <b>{what}: cannot be shown.</b> {msg}
    </div>
  )
}

export function Caption({ children }: { children: ComponentChildren }) {
  return <p class="caption">{children}</p>
}

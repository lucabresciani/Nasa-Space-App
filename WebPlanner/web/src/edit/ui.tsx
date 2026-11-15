// Drag-the-rover UI (U15): the readout that follows the rover while dragging (exact lookups + ghost
// rows) and the delta strip shown on release (what changes against the committed plan, from the
// precomputed pads index only: every number goes through <Num> with its manifest key).
import { Num } from '../components/Num'
import { padKey, PADS_INDEX, type PadOption, type PadsIndexView } from '../data/pads'
import { useSignalValue } from '../state/signal'
import { FieldReadout } from '../ui/cards/cards'
import { Button, TrustChip } from '../ui/components'
import { t, type CopyKey } from '../ui/copy'
import { editButtons } from './bind'
import { dragRows, type SpotFail, type SpotValues } from './drag'
import { isCustomPad } from './options'
import type { RoverDrag } from './rover'
import type { DeltaRow, PlanEditStore } from './store'

export const DASH = '—'
const SLOPE_FILE = 'fields/shared/slope.png'

const FAIL_COPY: Record<SpotFail, CopyKey> = { steep: 'cards.pad.invalidSteep', unknown: 'cards.pad.invalidUnknown', outside: 'cards.pad.invalidOutside' }

/** Validity line (copy only; no number). */
export function validityText(v: SpotValues): string {
  if (v.validity === 'valid') return t('cards.pad.validSpot')
  if (v.validity === 'invalid') return t('cards.pad.invalidSpot', { reason: v.failed.map((f) => t(FAIL_COPY[f])).join(', ') })
  return DASH
}

function GhostRow({ label }: { label: string }) {
  return (
    <div class="hl-readout hl-edit-ghost" data-state="ghost" data-trust="live">
      <div class="hl-readout__label">
        <span>{label}</span>
      </div>
      <div class="hl-readout__value" title={t('edit.ghost')}>
        {t('edit.computing')}
      </div>
    </div>
  )
}

/** While dragging: validity, elevation ("—": no elevation field), slope (field lookup); the rest a ghost. */
export function DragReadout({ values, target }: { values: SpotValues; target: PadOption | null }) {
  const rows = dragRows(values)
  return (
    <div class="hl-edit-drag" role="status" aria-live="polite" data-validity={values.validity}>
      <div class="hl-edit-drag__validity" data-source="field">
        {validityText(values)}
      </div>
      {rows.map((r) =>
        r.key === 'elevation' ? (
          <div class="hl-readout" data-state="unknown" key={r.key}>
            <div class="hl-readout__label">
              <span>{t('cards.pad.elevation')}</span>
            </div>
            <div class="hl-readout__value" title={t('tooltips.elevationNone')}>
              {DASH}
            </div>
          </div>
        ) : r.key === 'slope' ? (
          <FieldReadout key={r.key} label={t('cards.pad.slope')} v={values.slopeDeg} file={SLOPE_FILE} units="deg" />
        ) : r.key === 'feasibleEvas' ? (
          <GhostRow key={r.key} label={t('cards.pad.feasibleEvas')} />
        ) : r.key === 'reachable' ? (
          <GhostRow key={r.key} label={t('cards.pad.reachable')} />
        ) : null,
      )}
      <div class="hl-edit-drag__snap">
        {t('edit.snapStatic')}
        {target ? ` · ${target.label}` : ''}
      </div>
    </div>
  )
}

// ---- delta strip ---------------------------------------------------------------------------------

/** One precomputed fact of a pad: value and manifest key (pads index). */
export interface PadFact {
  key: 'feasibleEvas' | 'reachable' | 'elevation'
  label: CopyKey
  units?: string
  dp?: number
  chip: 'modelled' | 'real'
  v: (o: PadOption) => number | null
  k: (id: string) => string
}

export const PAD_FACTS: readonly PadFact[] = [
  { key: 'feasibleEvas', label: 'cards.pad.feasibleEvas', chip: 'modelled', v: (o) => o.score, k: (id) => padKey(id, 'score') },
  { key: 'reachable', label: 'cards.pad.reachable', units: '%', chip: 'modelled', v: (o) => o.tiebreak.find(([n]) => n === 'reachable_pct_30')?.[1] ?? null, k: (id) => padKey(id, 'tiebreak', 'reachable_pct_30') },
  { key: 'elevation', label: 'cards.pad.elevation', units: 'm', chip: 'real', v: (o) => o.elevM, k: (id) => padKey(id, 'elev_m') },
]

export interface FactRow {
  fact: PadFact
  from: { v: number | null; k: string }
  to: { v: number | null; k: string }
}

/** Precomputed facts of the committed pad and the draft pad (pads index values, never computed). */
export function factRows(pads: PadsIndexView, fromId: string, toId: string): FactRow[] {
  const a = pads.options.find((o) => o.id === fromId)
  const b = pads.options.find((o) => o.id === toId)
  if (!a || !b) return []
  return PAD_FACTS.map((f) => ({ fact: f, from: { v: f.v(a), k: f.k(a.id) }, to: { v: f.v(b), k: f.k(b.id) } }))
}

const padName = (pads: PadsIndexView, id: unknown) => (typeof id === 'string' ? (pads.options.find((o) => o.id === id)?.label ?? id) : DASH)

function InputRow({ row, pads }: { row: DeltaRow; pads: PadsIndexView }) {
  if (row.field === 'pad') {
    return (
      <div class="hl-edit-delta__row" data-field="pad">
        <span class="hl-edit-delta__label">{t('cards.pad.title')}</span>
        <span class="hl-edit-delta__from">{padName(pads, row.from)}</span>
        <span class="hl-edit-delta__arrow" aria-hidden="true">→</span>
        <span class="hl-edit-delta__to">{padName(pads, row.to)}</span>
      </div>
    )
  }
  return (
    <div class="hl-edit-delta__row" data-field={row.field}>
      <span class="hl-edit-delta__label">{row.field === 'budgetMin' ? t('tooltips.budgetSlider') : row.field === 'scenario' ? t('stepper.stages.variants') : row.field}</span>
      <span class="hl-edit-delta__from">{String(row.from ?? DASH)}</span>
      <span class="hl-edit-delta__arrow" aria-hidden="true">→</span>
      <span class="hl-edit-delta__to">{String(row.to ?? DASH)}</span>
    </div>
  )
}

/** The delta strip (DESIGN §5.2 sidebar): what the released draft changes, Keep / Discard. */
export function DeltaStrip({ store, rover, pads }: { store: PlanEditStore; rover: RoverDrag; pads: PadsIndexView }) {
  const d = useSignalValue(store.draft)
  useSignalValue(store.canUndo)
  if (!d || d.phase !== 'released') return null
  const from = store.committed.peek().plan.pad
  const to = d.step.plan.pad
  const facts = !isCustomPad(from) && !isCustomPad(to) ? factRows(pads, from, to) : []
  const buttons = editButtons(store).filter((b) => b.id === 'keep' || b.id === 'discard')
  return (
    <section class="hl-edit-delta" aria-label={t('edit.deltaTitle')} data-ghost={d.ghost.status} data-ghost-source={d.ghost.source}>
      <h3 class="hl-edit-delta__title">
        {t('edit.deltaTitle')} <TrustChip kind="modelled" />
      </h3>
      {d.delta.map((r) => (
        <InputRow key={`${r.field}${r.station ?? ''}`} row={r} pads={pads} />
      ))}
      {facts.map((r) => (
        <div class="hl-edit-delta__row" data-fact={r.fact.key} key={r.fact.key}>
          <span class="hl-edit-delta__label">
            {t(r.fact.label)} <TrustChip kind={r.fact.chip} prov={r.to.v === null ? undefined : { key: r.to.k, file: PADS_INDEX, value: r.to.v }} />
          </span>
          <span class="hl-edit-delta__from">
            <Num v={r.from.v} file={PADS_INDEX} k={r.from.k} units={r.fact.units} />
          </span>
          <span class="hl-edit-delta__arrow" aria-hidden="true">→</span>
          <span class="hl-edit-delta__to">
            <Num v={r.to.v} file={PADS_INDEX} k={r.to.k} units={r.fact.units} />
          </span>
        </div>
      ))}
      {!store.live.value && <p class="hl-edit-delta__note">{t('edit.snapStatic')}</p>}
      {!d.availability.ok && <p class="hl-edit-delta__note">{t(d.availability.reason ?? 'states.offline.unavailableHere')}</p>}
      <div class="hl-edit-delta__actions">
        {buttons.map((b) => (
          <Button key={b.id} variant={b.id === 'keep' ? 'primary' : 'secondary'} disabled={!b.enabled} title={t(b.hint ?? b.label)} onClick={() => (b.id === 'keep' ? rover.keep() : rover.discard())}>
            {t(b.label)}
          </Button>
        ))}
      </div>
      <p class="hl-edit-delta__hint">{t('edit.keepOrDiscard')}</p>
    </section>
  )
}

// Trust chip and provenance popover (DESIGN §3.6). Five kinds; text from copy.json; the mark is a
// small SVG (● Real, ◐ Modelled, ○ Simulated, ◆ Live, ✦ Visual) because the self-hosted font subsets
// carry no geometric-shape glyphs. Colour per §3.1: only Live has a colour (purple); the others are
// neutral, so the chip never competes with the safety colours. Clicking opens the provenance popover:
// value, units, source file, script, commit, UTC time, read from the manifest (prov/store).
import { getManifest } from '../../prov/store'
import { resolveProvenance, type ProvQuery } from '../../prov/provenance'
import { href } from '../../router'
import { t } from '../copy'
import { cx, type ForcedState } from './Icon'
import { Popover } from './overlay'

export const CHIP_KINDS = ['real', 'modelled', 'simulated', 'live', 'visual'] as const
export type ChipKind = (typeof CHIP_KINDS)[number]

/** The chip's mark alone (non-interactive), e.g. inside a list row that is itself a button. */
export function ChipMark({ kind }: { kind: ChipKind }) {
  return (
    <svg class={cx('hl-chip__mark', `hl-chip__mark--${kind}`)} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {kind === 'real' && <circle cx="6" cy="6" r="4" fill="currentColor" />}
      {kind === 'modelled' && (
        <>
          <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="M6 2a4 4 0 0 1 0 8z" fill="currentColor" />
        </>
      )}
      {kind === 'simulated' && <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.5" />}
      {kind === 'live' && <path d="M6 1.5 10.5 6 6 10.5 1.5 6z" fill="currentColor" />}
      {kind === 'visual' && <path d="M6 1 7.2 4.8 11 6 7.2 7.2 6 11 4.8 7.2 1 6 4.8 4.8z" fill="currentColor" />}
    </svg>
  )
}

/** The provenance rows for one value, or the copy.json "missing" line when no entry backs it. */
export function ProvenanceTable({ prov }: { prov: ProvQuery }) {
  const r = resolveProvenance(getManifest(), prov)
  if (r.status !== 'ok' && r.status !== 'matched') return <p class="hl-prov__missing">{t('chips.popover.missing')}</p>
  const e = r.entry
  const rows: [string, string][] = [
    [t('chips.popover.value'), typeof e.value === 'object' ? JSON.stringify(e.value) : String(e.value)],
    [t('chips.popover.units'), e.units ?? '—'],
    [t('chips.popover.sourceFile'), e.file],
    [t('chips.popover.script'), e.script],
    [t('chips.popover.commit'), e.commit],
    [t('chips.popover.time'), e.utc],
  ]
  return (
    <div class="hl-prov">
      <a class="hl-prov__key" href={href({ name: 'scorecard', key: r.key })}>
        {r.key}
      </a>
      <dl class="hl-prov__rows">
        {rows.map(([k, v]) => (
          <div class="hl-prov__row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export interface TrustChipProps {
  kind: ChipKind
  /** The value this chip stands for (manifest key, data file, value). Without it (layer groups) the popover explains the kind only. */
  prov?: ProvQuery
  /** Show the kind's label next to the mark (default: mark only, as on cards and readouts). */
  labelled?: boolean
  /** Popover initially open (style guide). */
  open?: boolean
  force?: ForcedState
  align?: 'start' | 'end'
}

export function TrustChip({ kind, prov, labelled, open, force, align }: TrustChipProps) {
  const name = t(`chips.${kind}.label`)
  return (
    <Popover
      label={
        <>
          <ChipMark kind={kind} />
          {labelled && <span class="hl-chip__label">{name}</span>}
        </>
      }
      title={t('chips.popover.title')}
      open={open}
      force={force}
      align={align}
      buttonClass={cx('hl-chip', `hl-chip--${kind}`, labelled && 'hl-chip--labelled')}
      buttonProps={{ 'aria-label': `${name}: ${t('tooltips.chip')}` }}
    >
      <p class="hl-prov__kind">
        <ChipMark kind={kind} />
        <span>
          <strong>{name}</strong> · {t(`chips.${kind}.explanation`)}
        </span>
      </p>
      {prov && <ProvenanceTable prov={prov} />}
    </Popover>
  )
}

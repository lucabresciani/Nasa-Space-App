// Card (default, selected, dimmed, loading), the sidebar card skeleton (§U14 card structure: title
// row → key numbers → details → actions) and the list row. DESIGN §3.7.
import type { ComponentChildren } from 'preact'
import { t } from '../copy'
import { Badge } from './Banner'
import { cx, type ForcedState } from './Icon'
import { ChipMark, TrustChip, type ChipKind } from './TrustChip'
import type { ProvQuery } from '../../prov/provenance'

export type CardState = 'default' | 'selected' | 'dimmed' | 'loading'

export interface CardProps {
  title: string
  code?: string
  chip?: ChipKind
  chipProv?: ProvQuery
  /** Short line under the title. */
  subtitle?: ComponentChildren
  state?: CardState
  /** Right side of the title row (e.g. a close icon button). */
  headerEnd?: ComponentChildren
  actions?: ComponentChildren
  children?: ComponentChildren
}

function Skeleton({ readouts = 0, lines = 3 }: { readouts?: number; lines?: number }) {
  return (
    <>
      {readouts > 0 && (
        <div class="hl-card__readouts">
          {Array.from({ length: readouts }, () => (
            <span class="hl-skel hl-skel--readout" />
          ))}
        </div>
      )}
      {Array.from({ length: lines }, (_, i) => (
        <span class={cx('hl-skel', 'hl-skel--line', i === lines - 1 && 'hl-skel--short')} />
      ))}
    </>
  )
}

export function Card({ title, code, chip, chipProv, subtitle, state = 'default', headerEnd, actions, children }: CardProps) {
  const loading = state === 'loading'
  return (
    <section class="hl-card" data-state={state} aria-busy={loading ? 'true' : undefined} aria-current={state === 'selected' ? 'true' : undefined}>
      <header class="hl-card__head">
        {code && <Badge>{code}</Badge>}
        <div class="hl-card__titles">
          <h3 class="hl-card__title">{title}</h3>
          {subtitle && <div class="hl-card__subtitle">{subtitle}</div>}
        </div>
        {chip && <TrustChip kind={chip} prov={chipProv} align="end" />}
        {headerEnd}
      </header>
      {loading ? (
        <div class="hl-card__body" role="status" aria-label={t('states.loading.generic', { what: title })}>
          <Skeleton />
        </div>
      ) : (
        children && <div class="hl-card__body">{children}</div>
      )}
      {!loading && actions && <footer class="hl-card__actions">{actions}</footer>}
    </section>
  )
}

/** Placeholder of a sidebar selection card while its data loads (no text, so nothing flickers). */
export function CardSkeleton({ label }: { label?: string }) {
  return (
    <section class="hl-card hl-card-skeleton" aria-busy="true" role="status" aria-label={label ?? t('states.loading.generic', { what: t('cards.common.keyNumbers') })}>
      <header class="hl-card__head">
        <span class="hl-skel hl-skel--code" />
        <span class="hl-skel hl-skel--title" />
      </header>
      <Skeleton readouts={4} lines={3} />
      <footer class="hl-card__actions">
        <span class="hl-skel hl-skel--button" />
        <span class="hl-skel hl-skel--button" />
      </footer>
    </section>
  )
}

export interface ListRowProps {
  label: string
  code?: string
  /** Right-aligned mono text (time, distance); numbers here must come from <Num> by the caller. */
  meta?: ComponentChildren
  /** Static chip mark (the row itself is the button; the provenance popover lives on the card). */
  chip?: ChipKind
  selected?: boolean
  disabled?: boolean
  force?: ForcedState
  onClick?: () => void
}

export function ListRow({ label, code, meta, chip, selected, disabled, force, onClick }: ListRowProps) {
  return (
    <button type="button" class="hl-row" aria-current={selected ? 'true' : undefined} disabled={disabled} data-force={force} onClick={onClick}>
      {code && <Badge>{code}</Badge>}
      <span class="hl-row__label">{label}</span>
      {meta !== undefined && <span class="hl-row__meta">{meta}</span>}
      {chip && <ChipMark kind={chip} />}
    </button>
  )
}

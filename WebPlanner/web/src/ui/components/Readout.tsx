// Number readout (DESIGN §3.7: value, range, unit, chip; stale; unknown; tabular figures).
// Every value is rendered by the existing manifest number component <Num> (components/Num.tsx), so it
// keeps its manifest key, scorecard link, tooltip and unbacked-number flag, and its formatting is
// unchanged. The readout only adds the label, the trust chip (provenance popover) and the layout.
import type { ComponentChildren } from 'preact'
import { Num } from '../../components/Num'
import { cx, Icon, type IconName } from './Icon'
import { TrustChip, type ChipKind } from './TrustChip'

export interface NumSpec {
  v: number | null
  /** Manifest key of this end of the range. */
  k?: string
  /** Data file (defaults to the readout's file). */
  file?: string
  dp?: number
}

/** Margin state colours (§3.1) or the live / science meanings; never decorative. */
export type ReadoutTone = 'safe' | 'caution' | 'limit' | 'live' | 'science'

export interface ReadoutProps {
  label: string
  icon?: IconName
  v: number | string | boolean | null | undefined
  /** Data file the value was read from (as for <Num>). */
  file: string
  /** Manifest key (as for <Num>). */
  k?: string
  units?: string | null
  dp?: number
  signed?: boolean
  range?: { low: NumSpec; high: NumSpec }
  chip: ChipKind
  tone?: ReadoutTone
  /** The value no longer matches the current inputs (dimmed, dashed). */
  stale?: boolean
  size?: 'default' | 'large'
  /** A short line under the value (caller supplies copy). */
  note?: ComponentChildren
}

export function Readout({ label, icon, v, file, k, units, dp, signed, range, chip, tone, stale, size = 'default', note }: ReadoutProps) {
  const unknown = v === null || v === undefined
  return (
    <div class={cx('hl-readout', size === 'large' && 'hl-readout--large')} data-state={unknown ? 'unknown' : stale ? 'stale' : undefined} data-tone={unknown ? undefined : tone}>
      <div class="hl-readout__label">
        {icon && <Icon name={icon} />}
        <span>{label}</span>
        <TrustChip kind={chip} prov={unknown ? undefined : { key: k, file, value: v }} />
      </div>
      <div class="hl-readout__value">
        <Num v={v} file={file} k={k} units={units} dp={dp} signed={signed} />
        {range && (
          <span class="hl-readout__range">
            (<Num v={range.low.v} file={range.low.file ?? file} k={range.low.k} dp={range.low.dp} />–
            <Num v={range.high.v} file={range.high.file ?? file} k={range.high.k} dp={range.high.dp} />)
          </span>
        )}
        {stale && <Icon name="clock" class="hl-readout__stale" />}
      </div>
      {note && <div class="hl-readout__note">{note}</div>}
    </div>
  )
}

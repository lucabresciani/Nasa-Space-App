// Legend swatch row (DESIGN §3.1 second cues: nominal solid, conservative denser fill, optimistic
// dashed, unknown grey hatch). The colour is a token variable, never a literal.
import { colorVar, type ColorToken } from '../tokens'
import { TrustChip, type ChipKind } from './TrustChip'

export type SwatchKind = 'fill' | 'dense' | 'dashed' | 'line' | 'hatch'

export interface LegendRowProps {
  swatch: SwatchKind
  color: ColorToken
  label: string
  chip?: ChipKind
}

export function LegendRow({ swatch, color, label, chip }: LegendRowProps) {
  return (
    <div class="hl-legend-row">
      <span class={`hl-swatch hl-swatch--${swatch}`} style={{ '--sw': colorVar(color) }} aria-hidden="true" />
      <span class="hl-legend-row__label">{label}</span>
      {chip && <TrustChip kind={chip} />}
    </div>
  )
}

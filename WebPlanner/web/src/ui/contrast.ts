// WCAG 2.x contrast for the colour tokens (DESIGN §9 "Contrast": text ≥ 4.5:1, large text and UI
// parts ≥ 3:1, on every token pair used). USED_PAIRS lists every foreground/background pair the
// components in ./components use; contrast.test.ts checks them and /styleguide prints the table.
import { TOKENS, type ColorToken } from './tokens'

export type PairUse = 'text' | 'large' | 'ui'

/** Minimum ratio per use (WCAG 1.4.3 / 1.4.11). Large = ≥ 24 px regular or ≥ 18.66 px bold. */
export const MIN_RATIO: Record<PairUse, number> = { text: 4.5, large: 3, ui: 3 }

function channel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** Relative luminance of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`contrast: not a #RRGGBB colour: ${hex}`)
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => channel(parseInt(h, 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

export function tokenContrast(fg: ColorToken, bg: ColorToken): number {
  return contrastRatio(TOKENS.color[fg], TOKENS.color[bg])
}

/** Surfaces text sits on. */
export const SURFACES: readonly ColorToken[] = ['bg', 'sidebar', 'card']
/** Tokens used for running text in any size. `textFaint` is not one of them (see FAINT_RULE). */
export const TEXT_TOKENS: readonly ColorToken[] = ['text', 'textMuted']
/**
 * `textFaint` reaches only 3.2–4.1:1 on the surfaces, so it is never used for text the user must read:
 * components use it only for disabled controls (WCAG 1.4.3 exempts inactive components) and as a UI part.
 */
export const FAINT_RULE = 'textFaint: disabled controls and UI parts only (≥ 3:1), never readable text'

export interface UsedPair {
  fg: ColorToken
  bg: ColorToken
  use: PairUse
  where: string
}

/** Every pair the components use (keep in sync with components/components.css). */
export const USED_PAIRS: readonly UsedPair[] = [
  ...(['bg', 'sidebar', 'card'] as const).flatMap((bg) => [
    { fg: 'text' as const, bg, use: 'text' as const, where: 'body text, labels, button text' },
    { fg: 'textMuted' as const, bg, use: 'text' as const, where: 'secondary text, chip labels, row meta' },
  ]),
  { fg: 'text', bg: 'cardBorder', use: 'text', where: 'selected segment, hovered row' },
  { fg: 'textMuted', bg: 'cardBorder', use: 'text', where: 'hovered row meta' },
  { fg: 'select', bg: 'bg', use: 'ui', where: 'focus ring on the page' },
  { fg: 'select', bg: 'sidebar', use: 'ui', where: 'focus ring in rails' },
  { fg: 'select', bg: 'card', use: 'ui', where: 'focus ring and selected card outline' },
  { fg: 'textMuted', bg: 'card', use: 'ui', where: 'toggle (off) thumb, slider track fill, input borders' },
  { fg: 'text', bg: 'card', use: 'ui', where: 'toggle (on) thumb, slider thumb' },
  { fg: 'textFaint', bg: 'card', use: 'ui', where: 'disabled control outline' },
  { fg: 'live', bg: 'card', use: 'text', where: 'Live chip and live button text' },
  { fg: 'live', bg: 'sidebar', use: 'text', where: 'Live chip in rails' },
  { fg: 'limit', bg: 'card', use: 'ui', where: 'danger button border and icon' },
  { fg: 'caution', bg: 'card', use: 'ui', where: 'caution banner border and icon' },
  { fg: 'textMuted', bg: 'card', use: 'ui', where: 'info and offline banner icon' },
  { fg: 'bg', bg: 'limit', use: 'text', where: 'alarm (limit) banner text on its fill' },
  ...(['safe', 'caution', 'limit', 'live', 'science'] as const).map((fg) => ({ fg, bg: 'bg' as const, use: 'text' as const, where: 'coloured readout value (readouts sit on bg)' })),
  ...(['safe', 'caution', 'limit', 'science', 'unknown', 'select', 'live'] as const).map((fg) => ({ fg, bg: 'card' as const, use: 'ui' as const, where: 'legend swatch' })),
]

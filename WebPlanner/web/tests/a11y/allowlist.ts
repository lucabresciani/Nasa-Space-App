// Declared contrast exceptions (DESIGN §9 "Contrast"; package Q1). A token pair listed here is below
// its WCAG minimum, so it may only be used in the restricted way the justification states. The
// colour test fails if (a) a listed pair is actually used by a component (contrast.ts USED_PAIRS, or a
// CSS rule that sets both colours), or (b) a listed pair meets its minimum after a token change
// (remove the entry then). Add an entry only with a justification and the enforcing check.
import type { ColorToken } from '../../src/ui/tokens'

/** Backgrounds beyond the token surfaces: the map label pill composited over the brightest and darkest imagery. */
export type Surface = ColorToken | 'pillOverWhite' | 'pillOverBlack'
export type Use = 'text' | 'ui'

export interface Exception {
  fg: ColorToken
  bg: Surface
  use: Use
  why: string
}

export const CONTRAST_EXCEPTIONS: readonly Exception[] = [
  ...(['bg', 'sidebar', 'card', 'cardBorder', 'pillOverWhite'] as const).map((bg) => ({
    fg: 'textFaint' as const,
    bg,
    use: 'text' as const,
    why: 'textFaint is for disabled controls only (WCAG 1.4.3 exempts inactive components) and UI parts on bg/sidebar/card; A2 finding 1, enforced by the textFaint CSS scan',
  })),
  { fg: 'limit', bg: 'card', use: 'text', why: 'limit-coloured values sit on bg (5.15:1); on cards the danger button uses text + limit border (A2 finding 2); enforced by the CSS scan' },
  { fg: 'limit', bg: 'cardBorder', use: 'text', why: 'limit text never sits on a hover fill; only on bg' },
  { fg: 'limit', bg: 'pillOverWhite', use: 'text', why: 'map labels are select (yellow) or text on the pill, never limit' },
  { fg: 'live', bg: 'cardBorder', use: 'text', why: 'live text belongs on card/sidebar; on a hovered row only the live chip mark (UI part, 4.48:1 ≥ 3:1). Known violation: the hovered live button (.hl-btn--live, cardBorder fill) shows live text at 4.48:1, recorded in baseline.json (styleguide) for A2/A4' },
  { fg: 'textMuted', bg: 'pillOverWhite', use: 'text', why: 'map labels use select or text on the pill (§3.1, U13), never textMuted' },
  { fg: 'caution', bg: 'pillOverWhite', use: 'text', why: 'map labels use select or text on the pill (§3.1, U13); state colours never label text' },
  { fg: 'science', bg: 'pillOverWhite', use: 'text', why: 'map labels use select or text on the pill (§3.1, U13); science targets are marked by symbol, not label colour' },
  { fg: 'live', bg: 'pillOverWhite', use: 'text', why: 'map labels use select or text on the pill (§3.1, U13), never live' },
]

/**
 * Colour-vision pairs that are allowed to fall below the ΔE threshold, with the second cue that keeps
 * them apart (DESIGN §3.1 "every state has a second cue"). Empty today: all pairs pass.
 */
export const CVD_EXCEPTIONS: readonly { a: ColorToken; b: ColorToken; vision: string; secondCue: string }[] = []

/**
 * Components where colour carries meaning but no second cue exists yet (static check over A2
 * components). Known gaps for the migration packages; the second-cue test warns when one is fixed.
 */
export const SECOND_CUE_GAPS: readonly { component: string; state: string; note: string }[] = [
  {
    component: 'Readout',
    state: 'tone safe / caution / limit',
    note: 'tone only recolours the value (components.css data-tone); no icon or text tag per margin state. A4/A6 should add e.g. a check / triangle-alert / circle-alert icon (DESIGN §3.1 "alarms with an icon").',
  },
]

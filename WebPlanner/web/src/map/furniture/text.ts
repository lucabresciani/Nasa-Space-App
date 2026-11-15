// WS16 task 5 (M5): thread / readout / compass settings and interface text (DESIGN U4, §3.8).
//
// ======================= TEMPORARY HOME (this stack has no config/design.yaml, no ui/copy.json) ====
// config/design.yaml `thread:` and the copy deck (web/src/ui/copy.json, A1/D73) are on `design` but
// not on the M2 → M3 → M4 stack this package sits on. The values below are copied verbatim from
// them (design.yaml: /tmp/hl-design/notes/D1-design.yaml = origin/design config/design.yaml;
// copy.json: origin/design web/src/ui/copy.json). text.test.ts cross-checks both files whenever
// they are present, so a rebase onto design turns the check on. After the rebase, replace COPY/t()
// with `import { t } from '../../ui/copy'` and THREAD with the design.yaml loader.
// ==================================================================================================
import type { Binding } from '../field/margin'

/** config/design.yaml `thread:` (DESIGN U4). */
export const THREAD = {
  updateHz: 30, // cursor updates throttled to 30 Hz
  dashSteps: 14, // frames per dash cycle (dash flow by stepping dash patterns)
  tooltip: 'Home in {t_home} min · margin {margin} min ({binding})',
} as const

/** copy.json keys used here, verbatim (dotted path -> text). */
export const COPY = {
  'tooltips.thread': 'Home in {t_home} min · margin {margin} min ({binding})',
  'tooltips.threadUnknown': 'No way home known from here',
  'tooltips.cursor.longitude': 'Longitude',
  'tooltips.cursor.latitude': 'Latitude',
  'tooltips.cursor.elevation': 'Elevation',
  'tooltips.cursor.slope': 'Slope',
  'tooltips.cursor.timeHome': 'Time home',
  'tooltips.compass': 'North arrow and sun direction',
  'glossary.turnBackHint': 'The latest time to start home',
  'binding.oxygen': 'O₂',
  'binding.daylight': 'daylight',
  'binding.dose': 'dose',
  'binding.evaDuration': 'EVA duration',
  'cards.station.onRoute': 'On the route',
  'cards.station.reachable': 'Reachable on foot',
  'cards.station.notReachable': 'Not reachable on foot',
  'cards.station.next': 'Next station',
  'cards.scoredSite.title': 'Scored site',
  'cards.pad.title': 'Rover pad',
  'edit.computing': 'computing…',
  'edit.ghost': 'Ghost: not yet computed',
} as const

/**
 * Text this package needs that copy.json does not have yet (asked for in notes/M5.md). Kept apart
 * so the cross-check never mistakes them for copy-deck text.
 */
export const COPY_PENDING = {
  // the thread in bands mode: fieldAt has no margin there (margin mode only, M3)
  threadNoMargin: 'Home in {t_home} min',
  // the field has no elevation: the readout shows a dash with this note
  elevationNone: 'Not in the field data (no elevation layer on this map yet)',
  // where the compass has no sun (clock outside WS4's sun series)
  sunNone: 'Sun direction unknown at this minute',
  northArrow: 'North',
  sun: 'Sun',
} as const

export type CopyKey = keyof typeof COPY
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g

/** Fill {placeholders}; throws when one has no value (copy.ts rule: no half-filled text). */
export function fill(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(PLACEHOLDER, (_, name: string) => {
    const v = vars[name]
    if (v === undefined || v === null) throw new Error(`text "${text}" needs a value for {${name}}`)
    return String(v)
  })
}

/** copy.json text for `key` (the local mirror until ui/copy.ts is on this stack). */
export function t(key: CopyKey, vars: Record<string, string | number> = {}): string {
  return fill(COPY[key], vars)
}

/** Binding term (field/margin.ts) -> copy.json `binding.*` text. */
export function bindingText(b: Binding): string {
  return t(b === 'O2' ? 'binding.oxygen' : b === 'daylight' ? 'binding.daylight' : b === 'dose' ? 'binding.dose' : 'binding.evaDuration')
}

/** Minutes and degrees as the HUD panel prints them (hud/panel.ts fmt: one decimal). */
export function fmt1(v: number): string {
  return v.toFixed(1)
}

/** Shown where a value does not exist (the HUD's DASH). */
export const DASH = '—'

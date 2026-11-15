// WS16 task 6 (M6): label settings (DESIGN U13, §3.2) and the font metric the CPU collision uses.
//
// ======================= TEMPORARY HOME (this stack has no config/design.yaml) =====================
// config/design.yaml `labels:` is on `design` but not on the M2 → M5 stack this package sits on. The
// values below are copied verbatim from origin/design config/design.yaml. model.test.ts cross-checks
// them whenever config/design.yaml is present, so the rebase onto design turns the check on. After
// the rebase, replace LABELS with the design.yaml loader.
// ==================================================================================================
import { TOKENS } from '../../ui/tokens'

/** config/design.yaml `labels:` (DESIGN U13). */
export const LABELS = {
  /** placement order; 'selected' is a runtime state, never a kind (contracts/labels.schema.json) */
  priority: ['selected', 'pad', 'route_station', 'station', 'scored_site', 'user_point', 'landmark', 'overlay'],
  minzoom: { landmark: 6, pad: 10, station: 13, overlay: 15 },
  leaderLineMinPitchDeg: 30,
  /** [x, y] padding inside the pill */
  pillPaddingPx: [4, 2] as [number, number],
} as const

/**
 * JetBrains Mono (the map-label face, DESIGN §3.2, self-hosted WOFF2 in ui/fonts): every glyph
 * advances 600 units on a 1000-unit em. A font metric, not a design value: it turns a code into
 * a pill width for the CPU collision check without a canvas.
 */
export const MONO_ADVANCE_EM = 0.6

/** Map-label type (tokens.json font: JetBrains Mono 11 / 14, weight mapLabel). */
export const LABEL_TYPE = {
  sizePx: TOKENS.font.size.label,
  lineHeightPx: TOKENS.font.lineHeight.label,
} as const

/** Gap from a marker's point to its label pill (clears the M5 station ring), tokens space[3]. */
export const MARKER_CLEARANCE_PX = TOKENS.space[3]
/** Minimum free space between two pills (U13 "padding"), tokens space[1]. */
export const COLLISION_GAP_PX = TOKENS.space[1]
/** Height a label floats above its point when the view is tilted past the leader-line pitch, tokens space[5]. */
export const LEADER_LIFT_PX = TOKENS.space[5]

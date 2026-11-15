// WS16 task 2 (M2): constants of the GPU field layer (DESIGN U2, §6.4).
//
// ======================= FIELD LAYER CONSTANTS (temporary home) ===================================
// config/design.yaml is not merged yet. These values are copied verbatim from
// /tmp/hl-design/notes/D1-design.yaml `field_layer` (export of the Notion page "Design config
// values", design bootstrap D1), as the M1 spike did (map/spike/constants.ts). Once
// config/design.yaml lands, read them from there and delete this block.
export const FIELD_LAYER = {
  sampling: 'nearest_then_manual_bilinear', // encoded values must not be filtered
  updateHzPlaying: 30,
  halfResAbovePx: 1024,
  amberMin: 10, // = config/hud.yaml margin_amber_min (margin mode, task 3)
  o2RateLMin: 1.35, // D24/D45 (margin mode, task 3)
  flatSpeedMs: 0.98, // D25 (collapse, task 4)
  flatRadiusM: { 30: 1764, 60: 3528 } as Record<number, number>, // D25: flat circle = flat_speed x budget (collapse k = 0)
  hatchPx: 6, // period of the screen-space unknown hatch (and of the optimistic dash, see shader)
} as const
/** config/design.yaml `collapse` (DESIGN U3, §3.4): 3 s, ease-in-out, once per trigger. */
export const COLLAPSE = { durationS: 3, easing: 'ease-in-out' } as const
// =================================================================================================

/** Variant order of the three t_home textures (u_variant index, DESIGN §6.4). */
export const VARIANTS = ['opt', 'nom', 'con'] as const
export type Variant = (typeof VARIANTS)[number]

/** scenarios/index.json `variant` -> field key prefix. */
export const VARIANT_OF: Record<string, Variant> = { optimistic: 'opt', nominal: 'nom', conservative: 'con' }

/** Cell-state codes (contracts/README.md "Cell states": counts 0 assessed, 1 blocked; A = 0 unknown). */
export const STATE = { assessed: 0, blocked: 1, unknown: 2 } as const
export type CellState = keyof typeof STATE | 'outside'

/** Query switch: `?field=off` (search or hash query) forces the polygon bands (fallback path). */
export const FIELD_QUERY_KEY = 'field'

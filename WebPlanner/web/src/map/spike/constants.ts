// WS16 M1 field-shader spike: constants. Throw-away code behind the unlinked #/spike route.
//
// ======================= SPIKE CONSTANTS (temporary) ==============================================
// config/design.yaml is not merged yet. These values are copied verbatim from
// /tmp/hl-design/notes/D1-design.yaml `field_layer` (export of the Notion page "Design config
// values", design bootstrap D1). Task 2 must read them from config/design.yaml instead.
export const FIELD_LAYER = {
  sampling: 'nearest_then_manual_bilinear', // encoded values must not be filtered
  updateHzPlaying: 30,
  halfResAbovePx: 1024,
  amberMin: 10, // = config/hud.yaml margin_amber_min
  o2RateLMin: 1.35, // D24/D45 (not used by the spike's simple margin)
  flatSpeedMs: 0.98, // D25 (collapse, not in the spike)
  hatchPx: 6,
} as const
// =================================================================================================

/** Brief WS16 task 1: measure at 60 deg tilt. */
export const SPIKE_TILT_DEG = 60

/** Variant order of the three t_home textures (u_variant index). */
export const VARIANTS = ['opt', 'nom', 'con'] as const
export type Variant = (typeof VARIANTS)[number]

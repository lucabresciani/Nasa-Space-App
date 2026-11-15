// WS16 task 8 (M8): 3D terrain settings and interface text (DESIGN U1, §5.4).
//
// Every number is read from config/design.yaml at build time (T1: the M8-era verbatim copy is gone,
// so the default exaggeration, 1.0 = true shape, lives only in `exaggeration.default`). Interface text
// comes from the copy deck (web/src/ui/copy.json) through ui/copy's t(); COPY_PENDING holds the two
// strings copy.json has no key for yet (asked for in notes/M8.md).
import designRaw from '../../../../config/design.yaml'
import { cfg } from '../../config'

/** config/design.yaml values U1 uses. */
export const TERRAIN = {
  /** scale.elevation_factor: baked into the tiles (P2), so exaggeration 1 = true shape. Never applied at runtime. */
  elevationFactor: cfg<number>(designRaw, 'scale.elevation_factor'),
  /** exaggeration: {min, max, default} */
  exaggeration: {
    min: cfg<number>(designRaw, 'exaggeration.min'),
    max: cfg<number>(designRaw, 'exaggeration.max'),
    default: cfg<number>(designRaw, 'exaggeration.default'),
  },
  /** camera.presets.isometric.pitch: the tilt 3D opens with */
  pitch3d: cfg<number>(designRaw, 'camera.presets.isometric.pitch'),
  /**
   * terrain_3d.max_pitch_deg: maxPitch while 3D is on (manual tilt cap). Above ~60° MapLibre 6.18 selects
   * no tiles at the pad's −7 km map elevation and draws only the background (T1).
   */
  maxPitch3d: cfg<number>(designRaw, 'terrain_3d.max_pitch_deg'),
  /** performance.fps_3d_min */
  fps3dMin: cfg<number>(designRaw, 'performance.fps_3d_min'),
} as const

/**
 * The values M8 asked for, now in config/design.yaml (D6b: `terrain_3d`, `exaggeration.step`).
 * The name is kept so the callers did not change.
 */
export const TERRAIN_PENDING = {
  /** terrain_3d.fallback_window_s (DESIGN U1 item 6): the low frame rate must last this long before the flat fallback */
  slowWindowMs: cfg<number>(designRaw, 'terrain_3d.fallback_window_s') * 1000,
  /** terrain_3d.idle_gap_s: frame gaps longer than this are an idle map (MapLibre renders on demand), never a slow frame */
  idleGapMs: cfg<number>(designRaw, 'terrain_3d.idle_gap_s') * 1000,
  /** terrain_3d.fps_window_s: the frame rate is the count of frames over this trailing window */
  fpsWindowMs: cfg<number>(designRaw, 'terrain_3d.fps_window_s') * 1000,
  /** exaggeration.step: slider step (one decimal on the factor label) */
  exaggerationStep: cfg<number>(designRaw, 'exaggeration.step'),
} as const

export { t } from '../../ui/copy'

/** Text copy.json does not have yet (asked for in notes/M8.md). */
export const COPY_PENDING = {
  noTiles: '3D terrain is not published in this data tree',
  trustNote: 'Measured: 1 m DEM (CTX 20 m, MOLA-HRSC 200 m at the edges); heights ×{factor} in the tiles for the Earth-sized map, so 1× is true shape',
} as const

/** The factor as the slider shows it: one decimal and the × sign ("1.0×"). */
export function factorText(x: number): string {
  return `${x.toFixed(1)}×`
}

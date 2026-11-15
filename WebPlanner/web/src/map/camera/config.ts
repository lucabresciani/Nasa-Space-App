// WS16 task 9 (M9): the camera settings U16 reads. Poses from config/design.yaml (camera.presets),
// durations from tokens.json (motion.cameraMs, DESIGN §3.4). Nothing typed by hand except the values
// DESIGN states in prose and config has no key for yet (marked assumed, asked for in notes/M9.md).
import designRaw from '../../../../config/design.yaml'
import { cfg } from '../../config'
import { TOKENS } from '../../ui/tokens'

export const PRESETS = {
  overhead: { pitch: cfg<number>(designRaw, 'camera.presets.overhead.pitch'), bearing: cfg<number>(designRaw, 'camera.presets.overhead.bearing') },
  isometric: { pitch: cfg<number>(designRaw, 'camera.presets.isometric.pitch') },
  low: { pitch: cfg<number>(designRaw, 'camera.presets.low.pitch') },
  focus: { paddingPx: cfg<number>(designRaw, 'camera.presets.focus.padding_px') },
} as const

/** tokens motion.cameraMs: a camera move lasts 1.2–2.5 s (DESIGN §3.4) */
export const CAMERA_MS: readonly [number, number] = TOKENS.motion.cameraMs as unknown as [number, number]

/** DESIGN U16 "Isolation": everything except the selected object dims to 20 % (assumed: true, no config key yet). */
export const ISOLATION_OPACITY = 0.2

/** A point object is framed as a box this wide (metres on Mars), so focus never zooms to the max (assumed: true). */
export const FOCUS_MIN_SPAN_M = 400

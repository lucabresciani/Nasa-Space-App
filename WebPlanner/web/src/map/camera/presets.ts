// WS16 task 9 (M9): camera presets, keys 1–5 (DESIGN U16), as pure data. The controller (index.ts)
// turns a preset into a camera move: 1 overhead (north up, 0° tilt); 2 isometric (45°); 3 low (60°, = the 3D tilt cap);
// 4 focus on the selection; 5 follow the crew (M10's flythrough follow camera, not a copy of it).
import { PRESETS } from './config'

export type PresetId = 1 | 2 | 3 | 4 | 5

export type Preset =
  /** a fixed tilt (and bearing when given) at the current centre and zoom; needs3d = the 3D view must be on */
  | { kind: 'pose'; name: 'overhead' | 'isometric' | 'low'; pitch: number; bearing?: number; needs3d: boolean }
  | { kind: 'focus' }
  | { kind: 'follow' }

export function isPresetId(n: unknown): n is PresetId {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5
}

export function preset(id: PresetId): Preset {
  switch (id) {
    case 1:
      return { kind: 'pose', name: 'overhead', pitch: PRESETS.overhead.pitch, bearing: PRESETS.overhead.bearing, needs3d: false }
    case 2:
      return { kind: 'pose', name: 'isometric', pitch: PRESETS.isometric.pitch, needs3d: true }
    case 3:
      return { kind: 'pose', name: 'low', pitch: PRESETS.low.pitch, needs3d: true }
    case 4:
      return { kind: 'focus' }
    case 5:
      return { kind: 'follow' }
  }
}

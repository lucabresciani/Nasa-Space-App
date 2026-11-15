// Field index helpers (SPEC §6.1). The web shell only reads the alpha channel of one shared field
// to hatch unknown terrain (A = 0 unknown); WS7 owns the value decoding for the HUD.
import type { FieldsIndex } from './types'

export interface FieldGrid {
  name: string
  file: string
  width: number
  height: number
  bounds: [number, number, number, number]
}

/**
 * The field whose alpha marks unknown terrain for the hatch layer: the shared `slope` field
 * (scenario null). Contracts v1.0 have no cell-state or source-mask image for the web (gap noted in
 * STATUS); slope is the scenario-independent field whose A = 0 means "no terrain value".
 */
export function unknownMaskField(fi: FieldsIndex): FieldGrid | null {
  const hit = Object.entries(fi.fields).find(([k, f]) => f.scenario === null && (k === 'slope' || k.endsWith('/slope')))
  if (!hit) return null
  return { name: hit[0], file: hit[1].file, width: fi.width, height: fi.height, bounds: fi.bounds }
}

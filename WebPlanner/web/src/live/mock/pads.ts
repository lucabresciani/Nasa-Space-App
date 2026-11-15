// Mock answers for the pad tool (F24): POST /pads/validate, POST /pads/screen. The contract has no
// examples for these two, so they are written to the openapi.yaml schemas (PadCheck, PadScreen);
// contract.test.ts validates every one. Coordinates, distances and minutes are placeholders, NOT
// results: they only exercise the UI until WS11 serves the endpoints (E6).
import planInputsCustom from '../../../../contracts/backend/examples/plan_inputs.custom.json'
import { LIVE_LABEL } from '../config'
import type { LonLat, PadCheck, PadReason, PadScreen } from '../types'

/** The pad of contracts/backend/examples/plan_inputs.custom.json: the mock's valid custom pad. */
export const MOCK_PAD_VALID: LonLat = { lon: planInputsCustom.pad.lon, lat: planInputsCustom.pad.lat }
/** A click the mock refuses (slope); its nearest valid block is MOCK_PAD_NEAREST. */
export const MOCK_PAD_INVALID: LonLat = { lon: 137.41, lat: -4.76 }
export const MOCK_PAD_NEAREST = { lon: 137.4092, lat: -4.7618, distance_m: 112.5 }
/** Default mock rule (dev only): clicks north of this latitude are refused. */
export const MOCK_INVALID_NORTH_OF_LAT = -4.77

export const PAD_CHECK_VALID: PadCheck = { valid: true, reason: null, nearest_valid: null }

/** One invalid answer per reason code of the PadCheck enum. */
export const PAD_CHECK_INVALID: Record<Exclude<PadReason, null>, PadCheck> = {
  slope: { valid: false, reason: 'slope', detail: 'mock: the block is steeper than the D21 slope limit', nearest_valid: MOCK_PAD_NEAREST },
  unknown_terrain: { valid: false, reason: 'unknown_terrain', detail: 'mock: no 1 m terrain here', nearest_valid: MOCK_PAD_NEAREST },
  disc_off_grid: { valid: false, reason: 'disc_off_grid', nearest_valid: MOCK_PAD_NEAREST },
  outside_grid: { valid: false, reason: 'outside_grid', nearest_valid: null },
}

/** Default mock rule: refuse (slope) north of MOCK_INVALID_NORTH_OF_LAT, else valid. */
export function mockPadCheck(p: LonLat): PadCheck {
  return p.lat > MOCK_INVALID_NORTH_OF_LAT ? PAD_CHECK_INVALID.slope : PAD_CHECK_VALID
}

/** Instant preview for a pad (placeholder minutes; station ids of stations.json). */
export function mockPadScreen(pad: LonLat): PadScreen {
  return {
    pad: { lon: pad.lon, lat: pad.lat },
    stations: [
      { id: 'S1', reachable: true, t_out_min: 21.4, t_home_min: 23 },
      { id: 'S2', reachable: true, t_out_min: 34.2, t_home_min: 36.9 },
      { id: 'S4', reachable: false, t_out_min: null, t_home_min: null },
      { id: 'S6', reachable: true, t_out_min: 41, t_home_min: 44.5 },
      { id: 'S7', reachable: false, t_out_min: null, t_home_min: null },
      { id: 'S8', reachable: false, t_out_min: null, t_home_min: null },
    ],
    feasible_evas: 3,
    best_route: { order: ['S1', 'S2', 'S6'], total_min: 212.5 },
    label: LIVE_LABEL,
  }
}

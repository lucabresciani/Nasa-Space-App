// HUD alarm rules (SPEC F18), first match wins:
//   1. margin_min < 0                                   -> red   "TURN BACK NOW"
//   2. tripwire fired and t_home >= tau_dose             -> red   "RADIATION: HEAD HOME"
//   3. uncertainty circle crosses the homeline           -> amber "POSITION UNCERTAIN: HEAD TOWARD ROVER"
//   4. margin_min < margin_amber_min (config/hud.yaml)   -> amber "TURN-BACK IN N MIN"
//   5. outside the partner line                          -> info  "Beyond partner-haul range"
// Unknown inputs (null) never fire a rule; the panel shows them as unknown instead.

export type AlarmLevel = 'red' | 'amber' | 'info'

export interface Alarm {
  rule: 1 | 2 | 3 | 4 | 5
  level: AlarmLevel
  text: string
}

export interface AlarmInput {
  marginMin: number | null
  tripwireFired: boolean
  tHomeMin: number | null
  tauDoseMin: number | null
  circleCrossesHomeline: boolean
  outsidePartner: boolean | null
}

export const ALARM_TEXT = {
  1: 'TURN BACK NOW',
  2: 'RADIATION: HEAD HOME',
  3: 'POSITION UNCERTAIN: HEAD TOWARD ROVER',
  5: 'Beyond partner-haul range',
} as const

/** "TURN-BACK IN N MIN": N rounded down so the HUD never overstates the time left. */
export function turnBackText(marginMin: number): string {
  return `TURN-BACK IN ${Math.max(0, Math.floor(marginMin))} MIN`
}

export function evaluateAlarm(a: AlarmInput, marginAmberMin: number): Alarm | null {
  if (a.marginMin !== null && a.marginMin < 0) return { rule: 1, level: 'red', text: ALARM_TEXT[1] }
  if (a.tripwireFired && a.tHomeMin !== null && a.tauDoseMin !== null && a.tHomeMin >= a.tauDoseMin) {
    return { rule: 2, level: 'red', text: ALARM_TEXT[2] }
  }
  if (a.circleCrossesHomeline) return { rule: 3, level: 'amber', text: ALARM_TEXT[3] }
  if (a.marginMin !== null && a.marginMin < marginAmberMin) {
    return { rule: 4, level: 'amber', text: turnBackText(a.marginMin) }
  }
  if (a.outsidePartner === true) return { rule: 5, level: 'info', text: ALARM_TEXT[5] }
  return null
}

/** Band colour while playing (F18): green margin > amber threshold, amber 0..threshold, red < 0. */
export function marginBand(marginMin: number | null, marginAmberMin: number): 'green' | 'amber' | 'red' | 'unknown' {
  if (marginMin === null) return 'unknown'
  if (marginMin < 0) return 'red'
  if (marginMin <= marginAmberMin) return 'amber'
  return 'green'
}

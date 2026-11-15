// O₂ reserve of the route margin (crew.yaml o2_margin, S review; D24): minutes at the effort cap, and
// in litres. The effort-cap rate is derived from config (crew.yaml o2_margin.effort_rate_L_min formula).
import { CITED, effortRateLMin } from '../config'

export function o2Reserve(): { min: number; rateLMin: number; litres: number } {
  const rateLMin = effortRateLMin({ effortCapFrac: CITED.effortCapFrac.value, vo2max: CITED.vo2maxMlKgMin.value, bodyMassKg: CITED.bodyMassKg.value })
  const min = CITED.o2ReserveMinAtEffortCap.value
  return { min, rateLMin: Math.round(rateLMin * 1000) / 1000, litres: Math.round(min * rateLMin * 100) / 100 }
}

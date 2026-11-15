import { describe, expect, it } from 'vitest'
import { cellStateDisc, confusionThresholds, katAreas, v1Context, v1Sensitivities } from './validation'
import { allScienceZero } from './trade'
import type { TradeTable } from '../data/types'

// validation/v1.json (WS6 13:14Z) shape, trimmed.
const V1 = {
  n: 290,
  bias_deg: 1.3098175914666925,
  rmse_deg: 5.447021418084812,
  r: 0.5025571598604971,
  thresholds_deg: [10, 20],
  confusion: { '10': { tp: 84, fp: 55, fn: 20, tn: 131 }, '20': { tp: 1, fp: 15, fn: 2, tn: 272 } },
  sensitivity: {
    footprint_5m: { n: 290, bias_deg: 0.776, rmse_deg: 4.907, r: 0.521, confusion: { '10': { tp: 76, fp: 50, fn: 28, tn: 136 } }, footprint_m: 5 },
    imu_roll_pitch: { n: 290, bias_deg: 1.312, rmse_deg: 5.451, r: 0.502, confusion: {} },
    all_in_dem: { n: 537, bias_deg: 0.595, rmse_deg: 4.905, r: 0.578, confusion: {}, set: 'all drive ends, no focus filter' },
  },
}

describe('V1 scorecard helpers', () => {
  it('confusion thresholds in numeric order, as the file keys them', () => {
    expect(confusionThresholds(V1.confusion)).toEqual(['10', '20'])
    expect(confusionThresholds(null)).toEqual([])
  })
  it('the 2 x 2 matrix at 10 deg is TP 84, FP 55, FN 20, TN 131 (sums to n 290)', () => {
    const c = V1.confusion['10']
    expect(c.tp + c.fp + c.fn + c.tn).toBe(V1.n)
  })
  it('sensitivities with labels and manifest key prefixes', () => {
    const s = v1Sensitivities(V1)
    expect(s.map((x) => x.name)).toEqual(['footprint_5m', 'imu_roll_pitch', 'all_in_dem'])
    expect(s[0].keyPrefix).toBe('v1.sensitivity.footprint_5m')
    expect(s[0].label).toBe('5 m footprint')
    expect(s[2].label).toBe('all drive ends, no focus filter')
    expect(v1Sensitivities({})).toEqual([])
  })
})

describe('KAT list by area', () => {
  it('counts outcomes per area, largest first', () => {
    const t = (area: string, outcome: string) => ({ id: `${area}-${outcome}-${Math.random()}`, area, features: [], outcome, reason: null })
    const a = katAreas([t('Router', 'passed'), t('Router', 'passed'), t('3D', 'skipped'), t('Router', 'failed')])
    expect(a).toEqual([
      { area: 'Router', total: 3, passed: 2, failed: 1, skipped: 0 },
      { area: '3D', total: 1, passed: 0, failed: 0, skipped: 1 },
    ])
  })
})

describe('trade table: science value', () => {
  const t = (v: (number | null)[]): TradeTable => ({ rows: [30], cols: [80, 104, 120], cells: [v.map((x) => ({ science_value: x, reachable_pct: 1, partner_area_km2: 1 }))] })
  it('all zero (WS2 con_*: no station within 60 min) is detected', () => expect(allScienceZero(t([0, 0, 0]))).toBe(true))
  it('any non-zero or all null is not', () => {
    expect(allScienceZero(t([0, 0.475, 0]))).toBe(false)
    expect(allScienceZero(t([null, null, null]))).toBe(false)
  })
})

import { FAR_NOT_VALIDATED, scopeText, v2Classes } from './validation'

describe('D7 (user 15:01): automatic detection only; far class not validated', () => {
  const summary = {
    near: { n: 2018, median_deg: -0.00745, median_abs_deg: 0.0939, p90_abs_deg: 0.52875 },
    mid: { n: 952, median_deg: 0.16975, median_abs_deg: 0.19675, p90_abs_deg: 0.36676 },
    far: { n: 26858, median_deg: -4.30765, median_abs_deg: 4.30765, p90_abs_deg: 7.89236 },
  }
  it('near and mid are quoted as validated; far is shown but marked not validated', () => {
    const r = v2Classes(summary)
    expect(r.map((x) => [x.cls, x.validated])).toEqual([
      ['near', true],
      ['mid', true],
      ['far', false],
    ])
    expect(r[2].median_abs_deg).toBe(4.30765)
    expect(r[0].keyPrefix).toBe('v2.near')
  })
  it('the far note says not validated and why, with no "pending"', () => {
    expect(FAR_NOT_VALIDATED).toMatch(/^Not validated: the far rim/)
    expect(FAR_NOT_VALIDATED).toMatch(/haze/)
    expect(FAR_NOT_VALIDATED).not.toMatch(/pending/i)
  })
  it('card scope text: the superseded "pending the D7 manual check" clause is dropped', () => {
    const s = "median |detected - predicted| skyline elevation per distance class on this card's Navcam frame (automatic sky detector; far class pending the D7 manual check)"
    expect(scopeText(s)).toBe("median |detected - predicted| skyline elevation per distance class on this card's Navcam frame (automatic sky detector)")
    expect(scopeText('plain scope')).toBe('plain scope')
    expect(scopeText(undefined)).toBeNull()
  })
})

// D23 (WS6 session 3): V1 is a validation, not a margin; the conservative no-go is cited from config.
describe('V1 role and no-go context (D23)', () => {
  const v = {
    ...V1,
    role: 'V1 = validation of the slope model, not a safety margin',
    nogo_context: { conservative_nogo_deg: 17.0, source: 'config/site.yaml slope.nogo_deg.conservative', decision: 'D23', derived_from_v1: false, text: 'conservative no-go = 17° (D23, config)', note: 'x' },
  }
  it('role and context text as written; the 17 deg agrees with config', () => {
    expect(v1Context(v)).toEqual({ role: 'V1 = validation of the slope model, not a safety margin', nogoText: 'conservative no-go = 17° (D23, config)', nogoDeg: 17, derivedFromV1: false, agreesWithConfig: true })
  })
  it('older v1.json (conservative_nogo, no role): nothing to show, no 14.55', () => {
    expect(v1Context({ ...V1, conservative_nogo: { nogo_deg: 14.553 } })).toEqual({ role: null, nogoText: null, nogoDeg: null, derivedFromV1: null, agreesWithConfig: null })
  })
})

// coverage.json terrain_checks.cell_states (WS1 session 4, D22/D23), trimmed.
describe('cell states per variant and disc (D22)', () => {
  const tc = {
    cell_states: {
      step_guard_deg: 30.0,
      variants: {
        nominal: { nogo_deg: 20.0, discs: [{ budget_min: 30, blocked_pct: 29.22, blocked_stepguard_only_pct: 1.03, maxslope_rule_blocked_pct: 41.23 }] },
        conservative: { nogo_deg: 17.0, discs: [{ budget_min: 30, blocked_pct: 36.3, blocked_stepguard_only_pct: 0.9, maxslope_rule_blocked_pct: 52.0 }, { budget_min: 60, blocked_pct: 30.0 }] },
      },
    },
  }
  it('reads one variant at one budget with its key prefix', () => {
    expect(cellStateDisc(tc, 'conservative', 30)).toEqual({ variant: 'conservative', budget: 30, nogoDeg: 17, blockedPct: 36.3, stepGuardOnlyPct: 0.9, maxSlopeRulePct: 52.0, keyPrefix: 'terrain.cellstates.conservative.disc_30' })
    expect(cellStateDisc(tc, 'nominal', 60)).toBeNull()
    expect(cellStateDisc(undefined, 'nominal', 30)).toBeNull()
  })
})

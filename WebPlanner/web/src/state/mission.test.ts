// WS15 task 3 (A3): mission-state defaults come from config; the console's plan choice rule.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONFIG } from '../config'
import { REPO } from '../hud/testutil'
import { o2Reserve } from '../views/o2'
import { choosePlanScenario, fieldUniforms, mission, missionClock, resolvePlanScenario } from './mission'
import { ui } from './ui'

type Idx = { default: string; scenarios: { id: string; variant: string; suit_kg: number }[] }
const idxOf = (tree: string): Idx => JSON.parse(readFileSync(resolve(REPO, 'web/public', tree, 'scenarios/index.json'), 'utf8')) as Idx

describe('mission defaults (config only, unknowns undefined)', () => {
  it('plan, budgets, conditions', () => {
    expect(mission.plan.scenario.value).toBeUndefined()
    expect(mission.plan.budgetMin.value).toBe(CONFIG.walkbackBudgetsMin[0])
    expect(mission.plan.pad.value).toBeNull()
    expect(mission.budgets.o2PrimaryL.value).toBe(CONFIG.o2PrimaryL)
    expect(mission.budgets.o2ReserveL.value).toBe(o2Reserve().litres)
    expect(mission.budgets.doseAllowMgy.value).toBe(CONFIG.dAllowMgy)
    expect(mission.budgets.evaMin.value).toBe(390)
    expect(mission.budgets.o2LeftL.value).toBeUndefined()
    expect(mission.conditions.tDarkMin.value).toBeUndefined()
    expect(mission.conditions.tauDoseMin.value).toBeUndefined()
    expect(mission.conditions.storm.value).toBe(false)
    expect(mission.position.value).toBeUndefined()
  })
  it('ui defaults', () => {
    expect(ui.mode.value).toBeUndefined()
    expect([ui.panels.leftRail.value, ui.panels.sidebar.value, ui.panels.timeline.value]).toEqual([320, 360, 120])
    expect(ui.exaggeration.value).toBeUndefined()
    expect(ui.view.value).toBe('2d')
    expect(ui.reducedMotion.value).toBe(false) // no matchMedia in node
  })
})

describe('console plan rule (was useState + index default)', () => {
  for (const tree of ['data', 'data-dummy']) {
    const idx = idxOf(tree)
    const original = (idx.scenarios.find((s) => s.id === idx.default) ?? idx.scenarios[0]).id
    it(`${tree}: no stored choice → the same scenario as before`, () => {
      expect(resolvePlanScenario(idx, undefined).id).toBe(original)
    })
    it(`${tree}: a stored choice survives the remount; an unknown one falls back`, () => {
      const other = idx.scenarios.find((s) => s.id !== original)!
      expect(resolvePlanScenario(idx, other.id).id).toBe(other.id)
      expect(resolvePlanScenario(idx, 'no_such').id).toBe(original)
    })
  }
})

describe('field-shader uniforms (DESIGN §6.4)', () => {
  it('follow the stores', () => {
    const seen: unknown[] = []
    const off = fieldUniforms.subscribe((u) => seen.push(u.variant))
    expect(fieldUniforms.value).toMatchObject({ t: 0, tEva: 390, budget: 30, mode: 'bands', tauDose: undefined, k: undefined })
    choosePlanScenario({ id: 'con_80', variant: 'conservative', suit_kg: 80 })
    expect(seen).toEqual(['conservative'])
    missionClock.play()
    expect(fieldUniforms.value.mode).toBe('margin') // U2: margin mode while the clock runs
    missionClock.pause()
    mission.conditions.tauDoseMin.value = 42
    expect(fieldUniforms.value.tauDose).toBeUndefined() // only with the storm on
    mission.conditions.storm.value = true
    expect(fieldUniforms.value.tauDose).toBe(42)
    off()
  })
})

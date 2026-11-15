// Acceptance tests (WS18 brief task 1, DESIGN U15 "Commit and undo", §4.4): written before the store.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { mission } from '../state/mission'
import { actionsFor, resetSelection, selectionActions } from '../state/selection'
import { shell } from '../ui/shell/store'
import { shortcutFor } from '../ui/shell/keys'
import { applyToMission, editButtons, followMission, handleEditKey, handleEditShortcut, installPlanEdit, registerEditActions } from './bind'
import { defaultInputs, resultHash, type EngineIdentity } from './canonical'
import { allOptions, buildCatalog, offeredOptions, planAvailability, type EditPlan } from './options'
import { createPlanEditStore, STORAGE_KEY, UNDO_MAX, type PlanEditStore } from './store'

const DATA = resolve(__dirname, '../../public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'))
const catalog = buildCatalog(json('scenarios/index.json'), json('scenarios/pads/index.json'), json('stations.json'))
const ID: EngineIdentity = {
  engine_tree: '0123456789abcdef0123456789abcdef01234567',
  config_hash: 'sha256:1fef9c5747acbd487e0a3090f6e9617eba1c8627e25095db683e18ab7589099d',
  terrain_hash: `sha256:${'0'.repeat(64)}`,
}
const OFFICIAL = catalog.officialPadId
const OPTION = catalog.pads.find((p) => !p.official)!.id
const live = () => createPlanEditStore({ catalog, identity: ID })
const stat = () => createPlanEditStore({ catalog })
const scenarioWithSuit = (kg: number) => catalog.scenarios.find((s) => s.suit_kg === kg && s.variant === 'nominal')!.id

beforeEach(() => {
  resetSelection()
  shell.helpOpen.value = false
  shell.focusMode.value = false
})

describe('catalog and config', () => {
  it('undo cap from config/design.yaml edit.undo_max', () => {
    expect(UNDO_MAX).toBe(50)
  })
  it('the official pad is the pads index official row', () => {
    expect(OFFICIAL).toBe('rank1')
    expect(catalog.padScenario).toBe('nom_104')
  })
})

describe('undo restores the exact previous plan hash; redo returns', () => {
  it('pad move, undo, redo (live identity)', () => {
    const s = live()
    const h0 = s.committedHash.peek()!
    expect(h0).toMatch(/^[0-9a-f]{16}$/)
    s.propose({ pad: { lon: 137.39, lat: -4.79 } })
    expect(s.commit()).toBe(true)
    const h1 = s.committedHash.peek()!
    expect(h1).not.toBe(h0)
    expect(s.undo()).toBe(true)
    expect(s.committedHash.peek()).toBe(h0)
    expect(s.redo()).toBe(true)
    expect(s.committedHash.peek()).toBe(h1)
  })
  it('the step hash is the server hash of its plan_inputs', () => {
    const s = live()
    s.apply({ scenario: scenarioWithSuit(120) })
    const st = s.committed.peek()
    expect(st.inputs).toMatchObject({ pad: { id: OFFICIAL }, crew: { suit_kg: 120 } })
    expect(s.committedHash.peek()).toBe(resultHash(st.inputs, { defaults: createDefaults(), stations: catalog.stations }, ID))
  })
  it('static mode: the inputs key round-trips the same way', () => {
    const s = stat()
    const k0 = s.committed.peek().key
    expect(s.committedHash.peek()).toBeUndefined() // no engine identity without the server
    s.apply({ pad: OPTION })
    expect(s.committed.peek().key).not.toBe(k0)
    s.undo()
    expect(s.committed.peek().key).toBe(k0)
  })
  it('a display-only change (budget, variant) is a step but keeps the hash', () => {
    const s = live()
    const h0 = s.committedHash.peek()
    s.apply({ budgetMin: 45 })
    s.apply({ scenario: catalog.scenarios.find((x) => x.variant === 'conservative' && x.suit_kg === 104)!.id })
    expect(s.past.peek()).toHaveLength(2)
    expect(s.committedHash.peek()).toBe(h0)
  })
})

describe('50-step cap', () => {
  it('keeps the last 50 steps; the oldest is dropped', () => {
    const s = stat()
    const budgets = Array.from({ length: 60 }, (_, i) => (i % 59) + 1) // 1..59, 1: every step a change
    const first = s.committed.peek().plan
    for (const b of budgets) expect(s.apply({ budgetMin: b }).ok).toBe(true)
    expect(s.past.peek()).toHaveLength(UNDO_MAX)
    let n = 0
    while (s.undo()) n++
    expect(n).toBe(UNDO_MAX)
    expect(s.committed.peek().plan).not.toEqual(first) // older than 50 steps: gone
    expect(s.committed.peek().plan.budgetMin).toBe(budgets[60 - UNDO_MAX - 1])
  })
})

describe('redo is invalidated by a new edit', () => {
  it('commit after undo clears the redo stack', () => {
    const s = stat()
    s.apply({ budgetMin: 40 })
    s.apply({ budgetMin: 50 })
    s.undo()
    expect(s.canRedo.peek()).toBe(true)
    s.apply({ budgetMin: 20 })
    expect(s.canRedo.peek()).toBe(false)
    expect(s.redo()).toBe(false)
    expect(s.committed.peek().plan.budgetMin).toBe(20)
  })
  it('an open draft does not clear redo; discarding it keeps redo', () => {
    const s = stat()
    s.apply({ budgetMin: 40 })
    s.undo()
    s.propose({ budgetMin: 10 })
    s.cancel()
    expect(s.canRedo.peek()).toBe(true)
  })
})

describe('static mode exposes no server-only option', () => {
  it('offered options in static mode never need the server; live adds the rest', () => {
    const st = offeredOptions(catalog, false)
    expect(st.length).toBeGreaterThan(0)
    expect(st.every((o) => !o.needsServer)).toBe(true)
    expect(st.some((o) => o.kind === 'customPad' || o.kind === 'dwell')).toBe(false)
    expect(offeredOptions(catalog, true)).toEqual(allOptions(catalog))
    expect(allOptions(catalog).some((o) => o.needsServer)).toBe(true)
  })
  it('every static option alone gives a plan with a precomputed result', () => {
    const s = stat()
    for (const o of offeredOptions(catalog, false)) {
      const patch: Partial<EditPlan> = o.kind === 'pad' ? { pad: o.id } : o.kind === 'scenario' ? { scenario: o.id } : o.kind === 'budget' ? { budgetMin: o.min } : {}
      expect(s.check(patch), JSON.stringify(o)).toEqual({ ok: true })
    }
  })
  it('server-only changes are refused in static mode with the reason', () => {
    const s = stat()
    const custom = s.apply({ pad: { lon: 137.39, lat: -4.79 } })
    expect(custom).toMatchObject({ ok: false, needsServer: true, reason: 'states.offline.unavailableHere' })
    const dwell = s.apply({ dwell: { S7: 45 } })
    expect(dwell).toMatchObject({ ok: false, needsServer: true })
    expect(s.past.peek()).toHaveLength(0)
    expect(live().apply({ dwell: { S7: 45 } })).toEqual({ ok: true })
  })
  it('out-of-range values are refused in both modes, not as server-only', () => {
    expect(planAvailability({ scenario: 'nom_104', budgetMin: 30, pad: OFFICIAL, dwell: { S7: 500 } }, catalog, true)).toMatchObject({ ok: false, needsServer: false })
    expect(planAvailability({ scenario: 'nope', budgetMin: 30, pad: OFFICIAL, dwell: {} }, catalog, true)).toMatchObject({ ok: false })
  })
  it('a parking option brings its scenario and a band budget along', () => {
    const s = stat()
    s.apply({ scenario: scenarioWithSuit(120), budgetMin: 17 })
    const d = s.propose({ pad: OPTION })
    expect(d.availability).toEqual({ ok: true })
    expect(d.step.plan).toMatchObject({ pad: OPTION, scenario: catalog.padScenario })
    expect(catalog.bandBudgetsMin).toContain(d.step.plan.budgetMin)
    expect(d.delta.map((r) => r.field).sort()).toEqual(['budgetMin', 'pad', 'scenario'])
  })
})

describe('draft, ghost and delta strip', () => {
  it('static drag snaps to precomputed pads; no value while dragging; ready on release', () => {
    const s = stat()
    s.beginPadDrag()
    const opt = catalog.pads.find((p) => p.id === OPTION)!
    expect(s.updatePadDrag({ lon: opt.lon + 1e-5, lat: opt.lat })).toEqual({ pad: OPTION, snapped: true })
    expect(s.draft.peek()).toMatchObject({ phase: 'dragging', ghost: { status: 'dragging', source: 'none' } })
    expect(s.draft.peek()!.ghost.result).toBeUndefined()
    const d = s.endPadDrag()!
    expect(d).toMatchObject({ phase: 'released', ghost: { status: 'ready', source: 'precomputed' } })
    expect(d.delta[0]).toMatchObject({ field: 'pad', from: OFFICIAL, to: OPTION, hashed: true })
    expect(s.commit()).toBe(true)
    expect(s.committed.peek().plan.pad).toBe(OPTION)
  })
  it('drag back to where it started is no step', () => {
    const s = stat()
    s.beginPadDrag()
    const off = catalog.pads.find((p) => p.official)!
    s.updatePadDrag({ lon: off.lon, lat: off.lat })
    expect(s.endPadDrag()).toBeNull()
    expect(s.draft.peek()).toBeNull()
    expect(s.canUndo.peek()).toBe(false)
  })
  it('live drag: custom spot, computing… until the result arrives, then ready; Escape discards', () => {
    const s = live()
    s.beginPadDrag()
    s.updatePadDrag({ lon: 137.391, lat: -4.791 })
    const d = s.endPadDrag()!
    expect(d.ghost).toEqual({ status: 'computing', source: 'none' })
    const job = s.pendingJob()!
    expect(job.inputs.pad).toEqual({ lon: 137.391, lat: -4.791 })
    expect(s.draftHash.peek()).toBe(resultHash(job.inputs, { defaults: createDefaults(), stations: catalog.stations }, ID))
    s.resolveGhost(job.key, { hash: s.draftHash.peek()!, resultBase: 'https://x/api/v1/results/abc' })
    expect(s.draft.peek()!.ghost).toMatchObject({ status: 'ready', source: 'live' })
    expect(s.pendingJob()).toBeNull()
    s.cancel()
    expect(s.draft.peek()).toBeNull()
  })
  it('a failed job marks the ghost, commits nothing', () => {
    const s = live()
    s.propose({ pad: { lon: 137.39, lat: -4.79 } })
    s.failGhost(s.draft.peek()!.step.key, 'timeout')
    expect(s.draft.peek()!.ghost).toMatchObject({ status: 'error', error: 'timeout' })
  })
  it('Ctrl+Z with an open draft discards the draft first', () => {
    const s = stat()
    s.apply({ budgetMin: 40 })
    s.propose({ budgetMin: 50 })
    expect(s.undo()).toBe(true)
    expect(s.draft.peek()).toBeNull()
    expect(s.committed.peek().plan.budgetMin).toBe(40)
  })
})

describe('keyboard shortcuts (§4.4)', () => {
  const press = (s: PlanEditStore, key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}) => {
    const a = shortcutFor({ key, ...mods })
    return a ? handleEditShortcut(s, a) : handleEditKey(s, { key, ...mods })
  }
  it('Ctrl+Z undoes, Ctrl+Shift+Z redoes (Cmd too)', () => {
    const s = stat()
    s.apply({ budgetMin: 40 })
    expect(press(s, 'z', { ctrlKey: true })).toBe(true)
    expect(s.committed.peek().plan.budgetMin).toBe(catalog.bandBudgetsMin[0])
    expect(press(s, 'Z', { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(s.committed.peek().plan.budgetMin).toBe(40)
    expect(press(s, 'z', { metaKey: true })).toBe(true)
    expect(press(s, 'z', { metaKey: true })).toBe(false) // nothing left
  })
  it('Ctrl+Z in a text field is the field\'s', () => {
    const s = stat()
    s.apply({ budgetMin: 40 })
    expect(handleEditShortcut(s, { action: 'undo' }, { typing: true })).toBe(false)
    expect(s.committed.peek().plan.budgetMin).toBe(40)
  })
  it('Enter keeps a released draft; Escape discards; not from buttons or fields', () => {
    const s = stat()
    s.propose({ budgetMin: 40 })
    expect(handleEditKey(s, { key: 'Enter', target: { localName: 'button' } })).toBe(false)
    expect(handleEditKey(s, { key: 'Enter', target: { localName: 'input', type: 'text' } })).toBe(false)
    expect(press(s, 'Enter')).toBe(true)
    expect(s.committed.peek().plan.budgetMin).toBe(40)
    s.propose({ budgetMin: 50 })
    expect(press(s, 'Escape')).toBe(true)
    expect(s.draft.peek()).toBeNull()
    expect(press(s, 'Escape')).toBe(false) // nothing to discard: Escape goes on to the selection
  })
  it('Enter during a drag does not commit (not released)', () => {
    const s = stat()
    s.beginPadDrag()
    s.updatePadDrag(catalog.pads.find((p) => p.id === OPTION)!)
    expect(press(s, 'Enter')).toBe(false)
  })
  it('the shell\'s Escape order comes first (help overlay, focus mode)', () => {
    const s = stat()
    s.propose({ budgetMin: 40 })
    shell.helpOpen.value = true
    expect(press(s, 'Escape')).toBe(false)
    expect(s.draft.peek()).not.toBeNull()
  })
  it('installPlanEdit handles hl:shortcut events before the selection does', () => {
    const s = stat()
    const target = new EventTarget() as unknown as Window
    const later: string[] = []
    // Browsers run capturing listeners at the target first (DOM "at target" order, 2021), so the
    // selection's later-or-earlier listener never sees a handled Escape. Node's EventTarget has no
    // phases and keeps registration order, so the selection's listener is added after here.
    const dispose = installPlanEdit(s, { win: target, mission: false, actions: false })
    target.addEventListener('hl:shortcut', () => later.push('selection'))
    s.propose({ budgetMin: 40 })
    const ev = new CustomEvent('hl:shortcut', { detail: { action: 'escape' }, cancelable: true })
    target.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(s.draft.peek()).toBeNull()
    expect(later).toEqual([]) // stopped: the selection stays
    s.apply({ budgetMin: 40 })
    target.dispatchEvent(new CustomEvent('hl:shortcut', { detail: { action: 'undo' }, cancelable: true }))
    expect(s.committed.peek().plan.budgetMin).toBe(catalog.bandBudgetsMin[0])
    dispose()
  })
})

describe('buttons and card actions (A5 registry)', () => {
  it('buttons enable with the stacks; disabled ones carry the empty hint', () => {
    const s = stat()
    expect(editButtons(s).map((b) => [b.id, b.enabled, b.hint ?? null])).toEqual([
      ['keep', false, 'edit.keepOrDiscard'], ['discard', false, 'edit.keepOrDiscard'], ['undo', false, 'edit.undoEmpty'], ['redo', false, 'edit.redoEmpty'],
    ])
    s.propose({ budgetMin: 40 })
    expect(editButtons(s).filter((b) => b.enabled).map((b) => b.id)).toEqual(['keep', 'discard', 'undo'])
  })
  it('Keep / Undo are registered only while they do something', () => {
    const s = stat()
    const off = registerEditActions(s)
    const pad = { kind: 'pad' as const, id: OFFICIAL }
    const station = { kind: 'station' as const, id: 'S7' }
    expect(actionsFor(pad)).toEqual([])
    s.propose({ budgetMin: 40 })
    expect(actionsFor(station).map((a) => a.label)).toEqual(['buttons.keep', 'buttons.discard'])
    actionsFor(station)[0].run(station)
    expect(s.committed.peek().plan.budgetMin).toBe(40)
    expect(actionsFor(pad).map((a) => a.label)).toEqual(['buttons.undo'])
    expect(actionsFor(station)).toEqual([])
    actionsFor(pad)[0].run(pad)
    expect(actionsFor(pad).map((a) => a.label)).toEqual(['buttons.redo'])
    off()
    expect(selectionActions.peek()).toEqual([])
  })
})

describe('mission state and session', () => {
  it('a commit writes mission.plan; undo writes it back', () => {
    const s = createPlanEditStore({ catalog, onApply: (st, r, store) => applyToMission(store, st, r) })
    s.apply({ pad: OPTION })
    expect(mission.plan.pad.peek()).toBe(OPTION)
    expect(mission.plan.scenario.peek()).toBe(catalog.padScenario)
    expect(mission.plan.hash.peek()).toBeUndefined() // precomputed: the static tree
    s.undo()
    expect(mission.plan.pad.peek()).toBeNull()
  })
  it('a live custom pad sets the result hash and base once computed', () => {
    const s = createPlanEditStore({ catalog, identity: ID, onApply: (st, r, store) => applyToMission(store, st, r) })
    s.propose({ pad: { lon: 137.39, lat: -4.79 } })
    s.commit()
    const k = s.committed.peek().key
    s.resolveGhost(k, { hash: s.committedHash.peek()!, resultBase: 'https://x/r' })
    expect(mission.plan.hash.peek()).toBe(s.committedHash.peek())
    expect(mission.plan.resultBase.peek()).toBe('https://x/r')
    s.undo()
    expect(mission.plan.hash.peek()).toBeUndefined()
    s.redo()
    expect(mission.plan.hash.peek()).toBe(s.committedHash.peek())
  })
  it('a console change of mission.plan becomes an undo step', () => {
    const s = createPlanEditStore({ catalog, onApply: (st, r, store) => applyToMission(store, st, r) })
    applyToMission(s, s.committed.peek(), undefined)
    const off = followMission(s)
    mission.plan.budgetMin.value = 44
    expect(s.committed.peek().plan.budgetMin).toBe(44)
    expect(s.past.peek()).toHaveLength(1)
    s.undo()
    expect(mission.plan.budgetMin.peek()).toBe(catalog.bandBudgetsMin[0])
    expect(s.past.peek()).toHaveLength(0) // the store's own write is not recorded again
    off()
  })
  it('history survives a reload in the same session (sessionStorage), nothing else', () => {
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    const a = createPlanEditStore({ catalog, storage })
    a.apply({ budgetMin: 40 })
    a.apply({ pad: OPTION })
    a.undo()
    expect([...mem.keys()]).toEqual([STORAGE_KEY])
    const b = createPlanEditStore({ catalog, storage })
    expect(b.committed.peek().plan).toEqual(a.committed.peek().plan)
    expect(b.past.peek().map((x) => x.key)).toEqual(a.past.peek().map((x) => x.key))
    expect(b.redo()).toBe(true)
    expect(b.committed.peek().plan.pad).toBe(OPTION)
    mem.set(STORAGE_KEY, '{broken')
    expect(createPlanEditStore({ catalog, storage }).past.peek()).toEqual([])
  })
})

function createDefaults() {
  return defaultInputs(catalog.pads)
}

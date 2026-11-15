// Wiring of the plan-edit store to the rest of the app (no view is changed here; H2/H3 call it):
//   - mission state: a committed step writes mission.plan; the console's own writes become steps
//   - keyboard: the shell's hl:shortcut undo / redo / escape, and Enter to keep a released draft
//   - selection cards (A5): Keep / Discard / Undo / Redo registered as card actions
import { mission } from '../state/mission'
import { registerSelectionAction, type SelectionRef } from '../state/selection'
import { effect } from '../state/signal'
import { isTypingTarget, type KeyLike, type ShortcutAction } from '../ui/shell/keys'
import { shell } from '../ui/shell/store'
import type { CopyKey } from '../ui/copy'
import { isCustomPad, type EditPlan } from './options'
import type { PlanEditStore, PlanStep, ResultRef } from './store'

// ---- mission state ------------------------------------------------------------------------------

/** The EditPlan the mission state shows now (null pad = the official pad). */
export function planFromMission(store: PlanEditStore): EditPlan {
  const c = store.catalog
  const cur = store.committed.peek().plan
  const pad = mission.plan.pad.peek()
  return {
    scenario: mission.plan.scenario.peek() ?? c.defaultScenario,
    budgetMin: mission.plan.budgetMin.peek(),
    // a custom pad lives in the live result (hash), not in mission.plan.pad
    pad: pad ?? (isCustomPad(cur.pad) && mission.plan.hash.peek() ? cur.pad : c.officialPadId),
    dwell: cur.dwell,
  }
}

let writing = false
/** Write a committed step into mission.plan (scenario, variant, suit, budget, pad, live result). */
export function applyToMission(store: PlanEditStore, step: PlanStep, result: ResultRef | undefined): void {
  const c = store.catalog
  const sc = c.scenarios.find((s) => s.id === step.plan.scenario)
  writing = true
  try {
    mission.plan.scenario.value = step.plan.scenario
    mission.plan.variant.value = sc?.variant
    mission.plan.suitKg.value = sc?.suit_kg
    mission.plan.budgetMin.value = step.plan.budgetMin
    mission.plan.pad.value = isCustomPad(step.plan.pad) || step.plan.pad === c.officialPadId ? null : step.plan.pad
    mission.plan.hash.value = result?.hash
    mission.plan.resultBase.value = result?.resultBase
  } finally {
    writing = false
  }
}

/** Follow mission.plan: a change made elsewhere (console controls) is recorded as an undo step. Returns dispose. */
export function followMission(store: PlanEditStore): () => void {
  let first = true
  return effect(() => {
    void mission.plan.scenario.value
    void mission.plan.budgetMin.value
    void mission.plan.pad.value
    if (first || writing) {
      first = false
      return
    }
    store.adopt(planFromMission(store))
  })
}

// ---- keyboard -----------------------------------------------------------------------------------

export interface EditKeyContext {
  /** focus is in a text field: Ctrl+Z belongs to the field */
  typing?: boolean
}

/** The shell's undo / redo / escape (DESIGN §4.4). Returns true when the edit store used it. */
export function handleEditShortcut(store: PlanEditStore, a: ShortcutAction, k: EditKeyContext = {}): boolean {
  switch (a.action) {
    case 'undo':
      return !k.typing && store.undo()
    case 'redo':
      return !k.typing && store.redo()
    case 'escape':
      // the shell's own order first (help overlay, focus mode), then the ghost, then the selection (A5)
      if (shell.helpOpen.peek() || shell.focusMode.peek()) return false
      return store.cancel()
    default:
      return false
  }
}

/** Enter keeps a released draft (U15). Not from fields, buttons or links (they own Enter). */
export function handleEditKey(store: PlanEditStore, e: KeyLike): boolean {
  if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  if (isTypingTarget(e.target) || isActivatable(e.target)) return false
  return store.commit()
}
function isActivatable(t: unknown): boolean {
  const el = t as { localName?: string; getAttribute?: (k: string) => string | null } | null
  const tag = (el?.localName ?? '').toLowerCase()
  if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'input') return true
  const role = el?.getAttribute?.('role')
  return role === 'button' || role === 'link' || role === 'menuitem' || role === 'option'
}

// ---- buttons and card actions -------------------------------------------------------------------

export interface EditButton {
  id: 'keep' | 'discard' | 'undo' | 'redo'
  label: CopyKey
  enabled: boolean
  /** tooltip when disabled */
  hint?: CopyKey
  run: () => boolean
}

/** Keep / Discard / Undo / Redo for a toolbar or the delta strip. */
export function editButtons(store: PlanEditStore): EditButton[] {
  const d = store.draft.value
  const keepable = !!d && d.phase === 'released' && d.availability.ok
  return [
    { id: 'keep', label: 'buttons.keep', enabled: keepable, hint: 'edit.keepOrDiscard', run: store.commit },
    { id: 'discard', label: 'buttons.discard', enabled: !!d, hint: 'edit.keepOrDiscard', run: store.cancel },
    { id: 'undo', label: 'buttons.undo', enabled: store.canUndo.value, hint: store.canUndo.value ? undefined : 'edit.undoEmpty', run: store.undo },
    { id: 'redo', label: 'buttons.redo', enabled: store.canRedo.value, hint: store.canRedo.value ? undefined : 'edit.redoEmpty', run: store.redo },
  ]
}

const isPad = (r: SelectionRef) => r.kind === 'pad'

/**
 * Register Keep / Discard (any card while a released draft is open) and Undo / Redo (pad cards, when
 * possible) with the selection registry (A5). Registered only while they would do something, so no
 * card renders a dead button. Returns dispose.
 */
export function registerEditActions(store: PlanEditStore): () => void {
  let off: (() => void)[] = []
  const stop = effect(() => {
    for (const f of off) f()
    off = []
    for (const b of editButtons(store)) {
      if (!b.enabled) continue
      const applies = b.id === 'undo' || b.id === 'redo' ? isPad : () => true
      off.push(registerSelectionAction({ id: `edit.${b.id}`, label: b.label, applies, run: () => void b.run() }))
    }
  })
  return () => {
    stop()
    for (const f of off) f()
  }
}

// ---- install ------------------------------------------------------------------------------------

export interface InstallOptions {
  win?: Window
  /** write commits to mission.plan and record console changes as steps (default true) */
  mission?: boolean
  /** register Keep / Discard / Undo / Redo card actions (default true) */
  actions?: boolean
}

/** Wire a store to the window, the mission state and the cards. Returns dispose. */
export function installPlanEdit(store: PlanEditStore, o: InstallOptions = {}): () => void {
  const win = o.win ?? (typeof window !== 'undefined' ? window : undefined)
  const offs: (() => void)[] = []
  if (o.mission !== false) offs.push(followMission(store))
  if (o.actions !== false) offs.push(registerEditActions(store))
  if (win) {
    // capture: at the window target, capturing listeners run before the selection's, so Escape with
    // an open ghost discards the ghost only (the selection stays)
    const onShortcut = (e: Event) => {
      const a = (e as CustomEvent<ShortcutAction>).detail
      if (a && handleEditShortcut(store, a, { typing: isTypingTarget(win.document?.activeElement) })) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && !e.isComposing && handleEditKey(store, e)) e.preventDefault()
    }
    win.addEventListener('hl:shortcut', onShortcut, { capture: true })
    win.addEventListener('keydown', onKey)
    offs.push(() => {
      win.removeEventListener('hl:shortcut', onShortcut, { capture: true })
      win.removeEventListener('keydown', onKey)
    })
  }
  return () => {
    for (const f of offs.reverse()) f()
  }
}

/** onApply for createPlanEditStore: commits go to the mission state. */
export const missionApply = (step: PlanStep, result: ResultRef | undefined, store: PlanEditStore) => applyToMission(store, step, result)

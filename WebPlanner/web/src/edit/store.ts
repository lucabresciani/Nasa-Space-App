// Plan-edit store (DESIGN §5.2 "Plan edit", U15 "Commit and undo"; WS18 task 1).
//
//   draft      the plan being edited (a pad drag or a proposed change), with its ghost result and
//              the delta strip rows (what changed against the committed plan)
//   committed  the plan in use; every commit is one undo step
//   past       undo stack, at most config/design.yaml edit.undo_max steps (oldest dropped)
//   future     redo stack, cleared by a new commit
//
// Every step carries its canonical plan_inputs (canonical.ts), its identity-free inputs key, and,
// once the engine identity is known (live), its D57 result hash: undo restores the exact previous
// hash. Session only: kept in memory (the app passes no storage: privacy note, no browser storage), never sent anywhere (no accounts, D69).
//
// Honesty (U15, design-agents rule 5): the ghost carries no number while dragging; on release it is
// "computing…" until a precomputed or live result is attached (resolveGhost). The browser never
// estimates a route.
import designRaw from '../../../config/design.yaml'
import { cfg } from '../config'
import { batch, computed, signal, type ReadSignal } from '../state/signal'
import { CONTRACT_VERSION, canonicalJson, defaultInputs, hashCanonical, inputsKey, type CanonicalContext, type EngineIdentity, type PlanInputs } from './canonical'
import { isCustomPad, nearestPad, planAvailability, type Availability, type EditCatalog, type EditPlan, type LonLat } from './options'

/** config/design.yaml edit.undo_max */
export const UNDO_MAX: number = cfg<number>(designRaw, 'edit.undo_max')

export interface PlanStep {
  plan: EditPlan
  inputs: PlanInputs
  /** canonical_json(inputs): the text that enters the result hash */
  canonical: string
  /** identity-free key of the canonical inputs (sha256[:16]); equal inputs, equal key */
  key: string
}

/** A computed result tree (live job, or a permalink). */
export interface ResultRef {
  hash: string
  resultBase: string
}

export type GhostStatus = 'dragging' | 'computing' | 'ready' | 'error'
export interface Ghost {
  status: GhostStatus
  /** precomputed = a static result file exists; live = a live result tree; none = not yet */
  source: 'precomputed' | 'live' | 'none'
  result?: ResultRef
  error?: string
}

export type DeltaField = 'pad' | 'scenario' | 'budgetMin' | 'dwell'
export interface DeltaRow {
  field: DeltaField
  station?: string
  from: unknown
  to: unknown
  /** the change enters plan_inputs (changes the result hash); false = a display choice */
  hashed: boolean
}

export interface Draft {
  step: PlanStep
  origin: 'drag' | 'edit'
  phase: 'dragging' | 'released'
  availability: Availability
  ghost: Ghost
  delta: DeltaRow[]
}

export interface PlanEditOptions {
  catalog: EditCatalog
  /** the plan in use at start (default: official pad, default scenario, first band budget) */
  initial?: EditPlan
  undoMax?: number
  /** live planning on, with the engine identity of /engine/version */
  identity?: EngineIdentity | null
  /** optional persistence hook for tests; the app passes none (privacy note: no browser storage) */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** called after every change of the committed step (commit, undo, redo, live result) */
  onApply?: (step: PlanStep, result: ResultRef | undefined, store: PlanEditStore) => void
}

export interface PadDragSample {
  pad: EditPlan['pad']
  /** static mode: the spot was snapped to this precomputed pad */
  snapped: boolean
}

export const STORAGE_KEY = 'hl.planEdit.v1'

const samePlan = (a: EditPlan, b: EditPlan) => planText(a) === planText(b)
function planText(p: EditPlan): string {
  const dwell = Object.keys(p.dwell)
    .sort()
    .map((k) => [k, p.dwell[k]])
  return JSON.stringify([p.scenario, p.budgetMin, p.pad, dwell])
}
const padLabel = (p: EditPlan['pad']) => (isCustomPad(p) ? { lon: p.lon, lat: p.lat } : p)

export function createPlanEditStore(opts: PlanEditOptions) {
  const c = opts.catalog
  const undoMax = opts.undoMax ?? UNDO_MAX
  const ctx: CanonicalContext = { defaults: defaultInputs(c.pads), stations: c.stations }
  const storage = opts.storage ?? null

  const identity = signal<EngineIdentity | null>(opts.identity ?? null)
  const live = computed(() => identity.value !== null)
  /** live results by inputs key */
  const results = signal<Readonly<Record<string, ResultRef>>>({})

  function toInputs(plan: EditPlan): PlanInputs {
    const pad = isCustomPad(plan.pad) ? { lon: plan.pad.lon, lat: plan.pad.lat } : padRow(plan.pad)
    const suit = c.scenarios.find((s) => s.id === plan.scenario)?.suit_kg
    const inputs: PlanInputs = { contract_version: CONTRACT_VERSION, pad, stations: { mode: 'best' } }
    if (suit !== undefined) inputs.crew = { suit_kg: suit }
    if (Object.keys(plan.dwell).length) inputs.stations = { mode: 'best', dwell_min: { ...plan.dwell } }
    return inputs
  }
  function padRow(id: string) {
    const p = c.pads.find((x) => x.id === id)
    if (!p) throw new Error(`unknown pad ${id}`)
    return { id: p.id, lon: p.lon, lat: p.lat }
  }
  function stepOf(plan: EditPlan): PlanStep {
    const inputs = toInputs(plan)
    const canonical = canonicalJson(inputs, ctx)
    return { plan, inputs, canonical, key: inputsKey(canonical) }
  }

  const defaultPlan = (): EditPlan => ({ scenario: c.defaultScenario, budgetMin: c.bandBudgetsMin[0], pad: c.officialPadId, dwell: {} })

  // ---- state ------------------------------------------------------------------------------------
  const restored = restore()
  const committed = signal<PlanStep>(stepOf(restored?.committed ?? opts.initial ?? defaultPlan()))
  const past = signal<readonly PlanStep[]>(restored?.past.map(stepOf) ?? [])
  const future = signal<readonly PlanStep[]>(restored?.future.map(stepOf) ?? [])
  const draft = signal<Draft | null>(null)
  if (restored) results.value = restored.results

  const canUndo = computed(() => past.value.length > 0 || draft.value !== null)
  const canRedo = computed(() => future.value.length > 0)

  /** D57 result hash of a step; undefined until the engine identity is known (live). */
  const hashOf = (s: PlanStep, id = identity.peek()): string | undefined => (id ? hashCanonical(s.canonical, id) : undefined)
  const committedHash = computed(() => hashOf(committed.value, identity.value))
  const draftHash = computed(() => {
    const d = draft.value
    return d ? hashOf(d.step, identity.value) : undefined
  })

  // ---- helpers ----------------------------------------------------------------------------------
  /** Parking options are computed at one scenario and the band budgets: a pad change brings those along. */
  function coerce(plan: EditPlan): EditPlan {
    if (!isCustomPad(plan.pad) && plan.pad === c.officialPadId) return plan
    const out = { ...plan }
    const padSuit = c.scenarios.find((s) => s.id === c.padScenario)?.suit_kg
    const sc = c.scenarios.find((s) => s.id === plan.scenario)
    if (!live.peek() || sc?.suit_kg !== padSuit) out.scenario = c.padScenario
    if (!c.bandBudgetsMin.includes(out.budgetMin)) {
      out.budgetMin = c.bandBudgetsMin.reduce((a, b) => (Math.abs(b - plan.budgetMin) < Math.abs(a - plan.budgetMin) ? b : a))
    }
    return out
  }

  function deltaRows(from: EditPlan, to: EditPlan): DeltaRow[] {
    const rows: DeltaRow[] = []
    if (JSON.stringify(from.pad) !== JSON.stringify(to.pad)) rows.push({ field: 'pad', from: padLabel(from.pad), to: padLabel(to.pad), hashed: true })
    if (from.scenario !== to.scenario) {
      const suit = (id: string) => c.scenarios.find((s) => s.id === id)?.suit_kg
      rows.push({ field: 'scenario', from: from.scenario, to: to.scenario, hashed: suit(from.scenario) !== suit(to.scenario) })
    }
    if (from.budgetMin !== to.budgetMin) rows.push({ field: 'budgetMin', from: from.budgetMin, to: to.budgetMin, hashed: false })
    for (const id of new Set([...Object.keys(from.dwell), ...Object.keys(to.dwell)])) {
      if (from.dwell[id] !== to.dwell[id]) rows.push({ field: 'dwell', station: id, from: from.dwell[id] ?? null, to: to.dwell[id] ?? null, hashed: true })
    }
    return rows
  }

  function ghostFor(step: PlanStep, phase: Draft['phase'], av: Availability): Ghost {
    if (phase === 'dragging') return { status: 'dragging', source: 'none' }
    if (!av.ok) return { status: 'error', source: 'none', error: av.detail }
    if (planAvailability(step.plan, c, false).ok) return { status: 'ready', source: 'precomputed' }
    const r = results.peek()[step.key]
    return r ? { status: 'ready', source: 'live', result: r } : { status: 'computing', source: 'none' }
  }

  function setDraft(plan: EditPlan, origin: Draft['origin'], phase: Draft['phase']): Draft {
    const step = stepOf(plan)
    const av = planAvailability(plan, c, live.peek())
    const d: Draft = { step, origin, phase, availability: av, ghost: ghostFor(step, phase, av), delta: deltaRows(committed.peek().plan, plan) }
    draft.value = d
    return d
  }

  function apply() {
    const s = committed.peek()
    persist()
    opts.onApply?.(s, resultOf(s), store)
  }
  /** The live result of a step that needs one (a precomputed plan is read from the static tree). */
  const resultOf = (s: PlanStep): ResultRef | undefined => (planAvailability(s.plan, c, false).ok ? undefined : results.peek()[s.key])

  // ---- session persistence ----------------------------------------------------------------------
  interface Saved {
    v: 1
    committed: EditPlan
    past: EditPlan[]
    future: EditPlan[]
    results: Record<string, ResultRef>
  }
  function restore(): Saved | null {
    if (!storage) return null
    try {
      const raw = storage.getItem(STORAGE_KEY)
      if (!raw) return null
      const s = JSON.parse(raw) as Saved
      const all = [s.committed, ...s.past, ...s.future]
      // a saved step that no longer resolves (catalog changed) drops the whole history
      if (s.v !== 1 || !all.every((p) => planAvailability(p, c, true).ok)) return null
      for (const p of all) stepOf(p)
      return { ...s, past: s.past.slice(-undoMax) }
    } catch {
      return null
    }
  }
  function persist() {
    if (!storage) return
    try {
      const s: Saved = { v: 1, committed: committed.peek().plan, past: past.peek().map((x) => x.plan), future: future.peek().map((x) => x.plan), results: { ...results.peek() } }
      storage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch {
      /* storage full or blocked: the history stays in memory */
    }
  }

  // ---- API --------------------------------------------------------------------------------------
  const store = {
    catalog: c,
    committed: committed as ReadSignal<PlanStep>,
    draft: draft as ReadSignal<Draft | null>,
    past: past as ReadSignal<readonly PlanStep[]>,
    future: future as ReadSignal<readonly PlanStep[]>,
    canUndo,
    canRedo,
    live,
    identity: identity as ReadSignal<EngineIdentity | null>,
    results: results as ReadSignal<Readonly<Record<string, ResultRef>>>,
    committedHash,
    draftHash,
    undoMax,
    hashOf,
    resultOf,
    /** plan_inputs + canonical text of any plan (for the live job or export) */
    stepOf,
    /** What a change would do, without making it. */
    check(patch: Partial<EditPlan>): Availability {
      return planAvailability(coerce({ ...base(), ...patch }), c, live.peek())
    },

    /** Start or update a draft (released: shows the ghost and the delta strip; Enter / Keep commits). */
    propose(patch: Partial<EditPlan>, origin: Draft['origin'] = 'edit'): Draft {
      return setDraft(coerce({ ...base(), ...patch }), origin, 'released')
    },
    /** Propose and commit at once (budget, scenario, dwell: "update at once", U15). Refused when not available. */
    apply(patch: Partial<EditPlan>): Availability {
      const d = store.propose(patch)
      if (!d.availability.ok) {
        draft.value = null
        return d.availability
      }
      store.commit()
      return d.availability
    },
    /** Commit the released draft as one undo step. No-op when nothing changed. */
    commit(): boolean {
      const d = draft.peek()
      if (!d || d.phase !== 'released' || !d.availability.ok) return false
      batch(() => {
        draft.value = null
        if (samePlan(d.step.plan, committed.peek().plan)) return
        const p = [...past.peek(), committed.peek()]
        past.value = p.length > undoMax ? p.slice(p.length - undoMax) : p
        future.value = []
        committed.value = d.step
      })
      apply()
      return true
    },
    /** Discard the draft (Escape). */
    cancel(): boolean {
      if (!draft.peek()) return false
      draft.value = null
      return true
    },
    /** Undo one step; with a draft open, discards the draft first (that is the undo). */
    undo(): boolean {
      if (store.cancel()) return true
      const p = past.peek()
      if (!p.length) return false
      batch(() => {
        future.value = [committed.peek(), ...future.peek()]
        committed.value = p[p.length - 1]
        past.value = p.slice(0, -1)
      })
      apply()
      return true
    },
    redo(): boolean {
      const f = future.peek()
      if (!f.length) return false
      batch(() => {
        draft.value = null
        past.value = [...past.peek(), committed.peek()].slice(-undoMax)
        committed.value = f[0]
        future.value = f.slice(1)
      })
      apply()
      return true
    },

    // ---- pad drag (H2 gestures) ----------------------------------------------------------------
    /** Pointer down on the rover: a draft that shows no computed value until release. */
    beginPadDrag(): void {
      setDraft(base(), 'drag', 'dragging')
    },
    /** Pointer moved: static mode snaps to the nearest precomputed pad; live mode follows the spot. */
    updatePadDrag(at: LonLat): PadDragSample {
      const d = draft.peek()
      const plan = d?.origin === 'drag' ? d.step.plan : base()
      const pad: EditPlan['pad'] = live.peek() ? { lon: at.lon, lat: at.lat } : nearestPad(c, at).id
      if (!d || d.origin !== 'drag' || JSON.stringify(d.step.plan.pad) !== JSON.stringify(pad)) setDraft(coerce({ ...plan, pad }), 'drag', 'dragging')
      return { pad, snapped: !live.peek() }
    },
    /** Snap to a named precomputed pad while dragging (e.g. the map's snap target). */
    snapPadDrag(id: string): void {
      const d = draft.peek()
      setDraft(coerce({ ...(d?.step.plan ?? base()), pad: id }), 'drag', 'dragging')
    },
    /** Pointer up: the ghost appears (precomputed: ready; live: computing until resolveGhost). */
    endPadDrag(): Draft | null {
      const d = draft.peek()
      if (!d || d.origin !== 'drag') return null
      if (samePlan(d.step.plan, committed.peek().plan)) {
        draft.value = null
        return null
      }
      return setDraft(d.step.plan, 'drag', 'released')
    },
    cancelPadDrag(): boolean {
      return draft.peek()?.origin === 'drag' ? store.cancel() : false
    },

    // ---- live hooks ----------------------------------------------------------------------------
    /** Live planning on (identity of GET /engine/version) or off (null): hashes and options follow. */
    setIdentity(id: EngineIdentity | null): void {
      identity.value = id
      const d = draft.peek()
      if (d) setDraft(d.step.plan, d.origin, d.phase)
    },
    /** A live result for inputs `key` arrived (plan job done, or a permalink): ghost and steps use it. */
    resolveGhost(key: string, r: ResultRef): void {
      results.value = { ...results.peek(), [key]: r }
      const d = draft.peek()
      if (d && d.step.key === key && d.phase === 'released') draft.value = { ...d, ghost: { status: 'ready', source: 'live', result: r } }
      if (committed.peek().key === key) apply()
      else persist()
    },
    /** The live job for `key` failed: the ghost says so; nothing is committed. */
    failGhost(key: string, error: string): void {
      const d = draft.peek()
      if (d && d.step.key === key) draft.value = { ...d, ghost: { status: 'error', source: 'none', error } }
    },
    /** Inputs the released draft needs computed (live, no result yet); null otherwise. */
    pendingJob(): { key: string; inputs: PlanInputs } | null {
      const d = draft.peek()
      return d && d.phase === 'released' && d.ghost.status === 'computing' ? { key: d.step.key, inputs: d.step.inputs } : null
    },
    /** Record a plan changed elsewhere (e.g. the console's own controls) as a committed step. */
    adopt(plan: EditPlan): boolean {
      if (samePlan(plan, committed.peek().plan)) return false
      const d = setDraft(plan, 'edit', 'released')
      if (!d.availability.ok) {
        draft.value = null
        return false
      }
      return store.commit()
    },
  }
  function base(): EditPlan {
    return draft.peek()?.step.plan ?? committed.peek().plan
  }
  return store
}

export type PlanEditStore = ReturnType<typeof createPlanEditStore>

// Drag-the-rover controller, static mode (WS18 task 2, U15). Map-free: the map binding (roverMap.ts)
// and the tests drive it with lon/lat. It reads only fields already in the browser and the plan-edit
// store (H1); it never fetches (no network during a drag) and never offers a server-only option.
//
//   begin()        pointer down on the rover: draft opens, no computed value
//   move(at)       exact lookups at the dragged cell + the snap target (nearest valid precomputed pad)
//   end()          release: the draft snaps to the target; ghost = that pad's precomputed plan
//   keep() / discard()   Enter / Escape (an undo step on keep, through H1)
//   cycle(±1)      keyboard alternative: the next / previous precomputed pad
import { signal, type ReadSignal } from '../state/signal'
import type { PadRow } from './canonical'
import { cyclePad, snapTarget, spotValues, type DragFields, type SpotValues } from './drag'
import { isCustomPad, offeredOptions, type EditOption, type LonLat } from './options'
import type { Draft, PlanEditStore } from './store'

export interface RoverDragState {
  phase: 'dragging' | 'released'
  /** the dragged spot (released: the snapped pad) */
  at: LonLat
  /** exact field lookups at `at` (dragging) */
  values: SpotValues | null
  /** where the rover snaps on release; null = no valid precomputed pad (stays) */
  target: PadRow | null
}

export interface RoverDrag {
  state: ReadSignal<RoverDragState | null>
  /** the precomputed pads the rover can snap to (official + D21 parking options), rank order */
  pads: readonly PadRow[]
  /** the rover's committed spot (a precomputed pad, or a live custom spot) */
  committedAt(): LonLat
  committedPadId(): string | null
  begin(at?: LonLat): void
  move(at: LonLat): RoverDragState
  end(): Draft | null
  cancel(): void
  keep(): boolean
  discard(): boolean
  cycle(dir: 1 | -1): Draft | null
  /** options this mode offers (static: none that need the server) */
  options(): EditOption[]
  /** validity of a precomputed pad's own spot (cached; pads that cannot be checked count as valid) */
  padValid(p: PadRow): boolean
}

export function createRoverDrag(store: PlanEditStore, fields: DragFields): RoverDrag {
  const c = store.catalog
  const pads = c.pads
  const state = signal<RoverDragState | null>(null)
  const validCache = new Map<string, boolean>()
  const padValid = (p: PadRow): boolean => {
    let v = validCache.get(p.id)
    if (v === undefined) {
      v = spotValues(fields, p).validity !== 'invalid'
      // a missing field is not cached: it may load later
      if (fields.grid) validCache.set(p.id, v)
    }
    return v
  }
  const planPad = (): string | LonLat => (store.draft.peek()?.step.plan ?? store.committed.peek().plan).pad
  const padOf = (id: string) => pads.find((p) => p.id === id) ?? null
  const committedAt = (): LonLat => {
    const p = store.committed.peek().plan.pad
    if (isCustomPad(p)) return p
    const row = padOf(p)!
    return { lon: row.lon, lat: row.lat }
  }

  const rd: RoverDrag = {
    state,
    pads,
    committedAt,
    committedPadId: () => {
      const p = store.committed.peek().plan.pad
      return isCustomPad(p) ? null : p
    },
    begin(at = committedAt()) {
      store.beginPadDrag()
      rd.move(at)
    },
    move(at) {
      if (state.peek()?.phase !== 'dragging' && store.draft.peek()?.phase !== 'dragging') store.beginPadDrag()
      const values = spotValues(fields, at)
      const target = snapTarget(pads, at, padValid)
      // static mode: the draft only ever holds a precomputed pad (never the dragged spot itself)
      if (target && planPad() !== target.id) store.snapPadDrag(target.id)
      const s: RoverDragState = { phase: 'dragging', at, values, target }
      state.value = s
      return s
    },
    end() {
      const s = state.peek()
      const d = store.endPadDrag()
      const target = s?.target ?? null
      if (!d || !target) {
        store.cancelPadDrag()
        state.value = null
        return null
      }
      state.value = { phase: 'released', at: { lon: target.lon, lat: target.lat }, values: null, target }
      return d
    },
    cancel() {
      store.cancelPadDrag()
      state.value = null
    },
    keep() {
      const ok = store.commit()
      if (ok || !store.draft.peek()) state.value = null
      return ok
    },
    discard() {
      const ok = store.cancel()
      state.value = null
      return ok
    },
    cycle(dir) {
      const cur = planPad()
      const next = cyclePad(pads.filter(padValid), isCustomPad(cur) ? c.officialPadId : cur, dir)
      if (!next) return null
      if (next.id === rd.committedPadId()) {
        rd.discard()
        return null
      }
      const d = store.propose({ pad: next.id }, 'drag')
      state.value = { phase: 'released', at: { lon: next.lon, lat: next.lat }, values: null, target: next }
      return d
    },
    options: () => offeredOptions(c, store.live.peek()),
    padValid,
  }
  return rd
}

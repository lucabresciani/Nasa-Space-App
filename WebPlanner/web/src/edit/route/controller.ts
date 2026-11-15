// Edit-route controller (R5, D97 §3): the stop list edits (through the route store, one undo step
// each), Compute plan (one live job for the route as given), the staged result and the infeasible
// answer. No DOM and nothing from src/live: the live side passes a RouteJobs port (live/route/jobs.ts)
// and optionally a RouteMap port (live/route/map.ts). D85: nothing is computed while the user drags a
// stop; only "Compute plan" starts a job. Waypoint rule 2: the order is never changed here.
import { computed, signal, type ReadSignal } from '../../state/signal'
import { checkRoute, legCoords, moveStop, routeLegs, setMode, toggleStation, type PlanRoute, type RouteCheck, type RouteMode, type StationGeo, type StopProbe } from './model'
import type { RouteStep, RouteStore } from './store'

/** The limit an infeasible route breaks first (draft §4.2: O₂ at the effort-cap rule D45, daylight, EVA length D28, dose). */
export type RouteLimit = 'O2' | 'daylight' | 'EVA duration' | 'dose'

export type Feasibility = { feasible: true } | { feasible: false; leg: number; from: string; to: string; limit: RouteLimit | string; shortfallMin: number | null; legsPlanned: number | null }

/** A job state as the panel shows it (live job fields it needs). */
export interface RouteJobView {
  status: string
  stage: string | null
  progress: number
  stagesDone: readonly string[]
  hash: string
}

/** One staged snapshot of the result tree (live/stage.ts loadStage, summarised); `data` goes to the map as is. */
export interface RouteStageView {
  stages: readonly string[]
  /** layers present in the tree so far: bands, route, isochrones, edges, partner */
  layers: readonly string[]
  errors: readonly string[]
  data: unknown
}

/** A failed job: HTTP status (0 = no answer), error code, readable text, the stop the error names (422). */
export interface RouteFailure {
  status: number
  code: string
  message: string
  stop: number | null
  retryAfterS: number | null
}

export interface RouteResultView {
  hash: string
  feasibility: Feasibility | null
  /** config/backend.yaml labels.live (the run record's label) */
  label: string
  /** #/plan/{hash}/provenance */
  provenanceHref: string
  engineCommit: string | null
  recordError: string | null
}

export type RouteOutcome = { status: 'done'; result: RouteResultView } | { status: 'failed'; failure: RouteFailure } | { status: 'cancelled' }

export interface RouteJobCallbacks {
  onUpdate(job: RouteJobView): void
  onStage(stage: RouteStageView): void
}
export interface RouteJobs {
  run(inputs: RouteStep['inputs'], cb: RouteJobCallbacks): { promise: Promise<RouteOutcome>; cancel(): void }
}

export interface RouteMap {
  /** Draw a staged snapshot through the console map's own setters (one rendering path). */
  showStage(data: unknown): void | Promise<void>
  /** Highlight the failing leg `leg` (null clears it). */
  highlightLeg(coords: [number, number][] | null, label?: string, leg?: number): void
  /** Give the map back to the static plan. */
  restore(): void
}

export type ComputeState =
  | { kind: 'idle' }
  | { kind: 'running'; job: RouteJobView | null; stage: RouteStageView | null; key: string }
  | { kind: 'done'; job: RouteJobView | null; stage: RouteStageView | null; result: RouteResultView; key: string }
  | { kind: 'failed'; job: RouteJobView | null; stage: RouteStageView | null; failure: RouteFailure; key: string }
  | { kind: 'cancelled'; key: string }

export interface RouteControllerOptions {
  store: RouteStore
  jobs: RouteJobs
  stations: readonly StationGeo[]
  /** pad lon/lat of the plan the console shows now */
  pad: () => { lon: number; lat: number }
  probe?: (lon: number, lat: number) => StopProbe
  map?: RouteMap | null
  /** health says heavy jobs are possible now (index.ts onLiveState + bannerFor) */
  canCompute?: ReadSignal<boolean>
}

export function createRouteController(o: RouteControllerOptions) {
  const { store } = o
  const compute = signal<ComputeState>({ kind: 'idle' })
  /** index of the stop being dragged (D85: nothing is applied or computed until the drop) */
  const dragging = signal<number | null>(null)
  let handle: { cancel(): void } | null = null
  let seq = 0
  let drawn = false

  const check = computed<RouteCheck>(() => {
    void store.step.value // pad changes rebuild the check
    return checkRoute(store.route.value, { stations: o.stations, pad: o.pad(), probe: o.probe })
  })

  function clearResult(): void {
    seq++
    handle?.cancel()
    handle = null
    if (compute.peek().kind !== 'idle') compute.value = { kind: 'idle' }
    o.map?.highlightLeg(null)
    if (drawn) o.map?.restore()
    drawn = false
  }
  /** Every route edit: one undo step; a shown result belongs to the old route, so it is cleared. */
  function edit(next: PlanRoute): boolean {
    if (!store.apply(next)) return false
    clearResult()
    return true
  }

  function runCompute(): boolean {
    const c = compute.peek()
    if (c.kind === 'running' || dragging.peek() !== null) return false
    if (!check.peek().ok || (o.canCompute && !o.canCompute.peek())) return false
    clearResult()
    const my = ++seq
    const step = store.step.peek()
    const route = step.route
    compute.value = { kind: 'running', job: null, stage: null, key: step.key }
    const live = (fn: () => void) => {
      if (my === seq) fn()
    }
    const h = o.jobs.run(step.inputs, {
      onUpdate: (job) =>
        live(() => {
          const s = compute.peek()
          if (s.kind === 'running') compute.value = { ...s, job }
        }),
      onStage: (stage) =>
        live(() => {
          const s = compute.peek()
          if (s.kind !== 'running') return
          compute.value = { ...s, stage }
          drawn = true
          void o.map?.showStage(stage.data)
        }),
    })
    handle = h
    void h.promise.then((out) =>
      live(() => {
        handle = null
        const s = compute.peek()
        const job = s.kind === 'running' ? s.job : null
        const stage = s.kind === 'running' ? s.stage : null
        if (out.status === 'done') {
          compute.value = { kind: 'done', job, stage, result: out.result, key: step.key }
          const f = out.result.feasibility
          if (f && !f.feasible) o.map?.highlightLeg(legCoords(route, f.leg, { stations: o.stations, pad: o.pad() }), `${f.from} → ${f.to}`, f.leg)
        } else if (out.status === 'failed') compute.value = { kind: 'failed', job, stage, failure: out.failure, key: step.key }
        else compute.value = { kind: 'cancelled', key: step.key }
      }),
    )
    return true
  }

  return {
    store,
    compute: compute as ReadSignal<ComputeState>,
    check,
    dragging: dragging as ReadSignal<number | null>,
    legs: computed(() => routeLegs(store.route.value)),
    stations: o.stations,
    setMode: (m: RouteMode) => edit(setMode(store.route.peek(), m)),
    toggle: (id: string, on: boolean) => edit(toggleStation(store.route.peek(), id, on)),
    move: (from: number, to: number) => edit(moveStop(store.route.peek(), from, to)),
    /** Any other route edit (WP6 free points: add, move, rename, delete): one undo step, result cleared. */
    edit,
    /** Drag gesture: start (no store change), drop (one undo step), cancel. */
    dragStart(i: number): void {
      dragging.value = i
    },
    dragDrop(to: number): boolean {
      const from = dragging.peek()
      dragging.value = null
      return from === null ? false : edit(moveStop(store.route.peek(), from, to))
    },
    dragCancel(): void {
      dragging.value = null
    },
    undo(): boolean {
      if (!store.undo()) return false
      clearResult()
      return true
    },
    redo(): boolean {
      if (!store.redo()) return false
      clearResult()
      return true
    },
    computePlan: runCompute,
    cancel(): void {
      handle?.cancel()
    },
    /** Offline or warming: pending work stops and the live layers go. */
    reset: clearResult,
    dispose(): void {
      clearResult()
    },
  }
}

export type RouteController = ReturnType<typeof createRouteController>

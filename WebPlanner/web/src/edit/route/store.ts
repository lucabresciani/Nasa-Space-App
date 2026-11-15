// Route edits with undo (R5, D97 §3.3 "every edit goes through the plan-edit store, so undo works").
//
// The plan (pad, scenario, dwell) comes from the H1 plan-edit store's own step builder (stepOf), and
// the route is added on top, so the job inputs and the D57 hash are the H1 ones plus the route:
//   inputs     H1 plan_inputs + route (auto: no route; ordered: stops in order, labels kept)
//   canonical  H1 canonical text of the inputs with the hash view of the route (labels dropped, auto absent)
//   hash       hashCanonical(canonical, engine identity) as the server computes it (R0 hashing note)
// Every route change is one undo step (config/design.yaml edit.undo_max, as H1). The H1 store file is
// not changed: it ships in the static build, which must stay byte-identical (waypoint rule 4). When
// that constraint is lifted the route can move into store.ts as a field of EditPlan.
import { batch, computed, signal, type ReadSignal } from '../../state/signal'
import { canonicalJson, defaultInputs, hashCanonical, inputsKey, type CanonicalContext, type EngineIdentity, type PlanInputs } from '../canonical'
import type { EditCatalog, EditPlan } from '../options'
import { createPlanEditStore, UNDO_MAX } from '../store'
import { AUTO_ROUTE, routeForHash, routePayload, sameRoute, type PlanRoute } from './model'

export type RouteInputs = PlanInputs & { route?: ReturnType<typeof routePayload> }

export interface RouteStep {
  plan: EditPlan
  route: PlanRoute
  /** POST /jobs plan_inputs (route included when ordered) */
  inputs: RouteInputs
  /** canonical_json of the inputs as hashed (route labels dropped, auto absent) */
  canonical: string
  /** identity-free key (sha256[:16] of canonical) */
  key: string
}

export interface RouteStoreOptions {
  catalog: EditCatalog
  /** The plan the console shows now (pad, scenario, dwell); read at every step. Default: the H1 default plan. */
  plan?: () => EditPlan
  initial?: PlanRoute
  identity?: EngineIdentity | null
  undoMax?: number
}

export function createRouteStore(opts: RouteStoreOptions) {
  const c = opts.catalog
  const undoMax = opts.undoMax ?? UNDO_MAX
  const h1 = createPlanEditStore({ catalog: c, undoMax })
  const ctx: CanonicalContext = { defaults: defaultInputs(c.pads), stations: c.stations }
  const planNow = opts.plan ?? (() => h1.committed.peek().plan)

  const route = signal<PlanRoute>(opts.initial ?? AUTO_ROUTE)
  const past = signal<readonly PlanRoute[]>([])
  const future = signal<readonly PlanRoute[]>([])
  const identity = signal<EngineIdentity | null>(opts.identity ?? null)
  /** bumped when the console's plan may have changed (pad drag, scenario): steps are rebuilt */
  const planTick = signal(0)

  function stepOf(plan: EditPlan, r: PlanRoute): RouteStep {
    const base = h1.stepOf(plan).inputs
    const send = routePayload(r)
    const hashed = routeForHash(r)
    const inputs: RouteInputs = send ? { ...base, route: send } : { ...base }
    const canonical = canonicalJson((hashed ? { ...base, route: hashed } : base) as PlanInputs, ctx)
    return { plan, route: r, inputs, canonical, key: inputsKey(canonical) }
  }

  const step = computed(() => {
    void planTick.value
    return stepOf(planNow(), route.value)
  })
  const hash = computed(() => {
    const id = identity.value
    return id ? hashCanonical(step.value.canonical, id) : undefined
  })

  const store = {
    catalog: c,
    route: route as ReadSignal<PlanRoute>,
    past: past as ReadSignal<readonly PlanRoute[]>,
    future: future as ReadSignal<readonly PlanRoute[]>,
    canUndo: computed(() => past.value.length > 0),
    canRedo: computed(() => future.value.length > 0),
    identity: identity as ReadSignal<EngineIdentity | null>,
    /** inputs, canonical text and key of the current plan + route */
    step: step as ReadSignal<RouteStep>,
    /** D57 result hash of step (undefined until the engine identity is known) */
    hash: hash as ReadSignal<string | undefined>,
    undoMax,
    stepOf,
    /** One undo step; no-op (false) when the route does not change. */
    apply(next: PlanRoute): boolean {
      const cur = route.peek()
      if (sameRoute(cur, next)) return false
      batch(() => {
        const p = [...past.peek(), cur]
        past.value = p.length > undoMax ? p.slice(p.length - undoMax) : p
        future.value = []
        route.value = next
      })
      return true
    },
    undo(): boolean {
      const p = past.peek()
      if (!p.length) return false
      batch(() => {
        future.value = [route.peek(), ...future.peek()]
        route.value = p[p.length - 1]
        past.value = p.slice(0, -1)
      })
      return true
    },
    redo(): boolean {
      const f = future.peek()
      if (!f.length) return false
      batch(() => {
        past.value = [...past.peek(), route.peek()].slice(-undoMax)
        route.value = f[0]
        future.value = f.slice(1)
      })
      return true
    },
    setIdentity(id: EngineIdentity | null): void {
      identity.value = id
    },
    /** The console's plan changed (pad, scenario): rebuild the step (no undo step: not a route edit). */
    planChanged(): void {
      planTick.value = planTick.peek() + 1
    },
  }
  return store
}

export type RouteStore = ReturnType<typeof createRouteStore>

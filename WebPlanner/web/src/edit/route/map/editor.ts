// WP6 (D97 §3.3): the free-waypoint editor of one route controller. Map-free (the map binding is
// layer.ts; tests drive it with lon/lat):
//   add      "Add waypoint" arms one map click; the click appends W{n} (one undo step), max 4
//   move     a marker drag changes nothing until the drop (D85); the drop is one undo step
//   rename   label, capped at limits.title_max_chars; delete; reorder is R5's stop list
//   ghost    pad -> stops -> pad on the browser grid (ghost.ts), recomputed after each edit (never
//            during a drag), every time an ESTIMATE; hidden once a computed live result is drawn
// Every edit goes through the controller (controller.edit -> route store apply), so undo, the
// result reset and the D57 hash work exactly as for R5's station edits.
import { computed, effect, signal, type ReadSignal } from '../../../state/signal'
import type { RouteController } from '../controller'
import type { PlanRoute } from '../model'
import { ACCESS_RADIUS_M, ghostRoute, type Ghost, type GhostGrid } from './ghost'
import { accessCell, cellOf, loadRouteGrid, lonLatOfCell, type RouteGridData } from './grid'
import { addBlocked, addPoint, deletePoint, movePoint, renamePoint } from './points'
import { LegRouter, type Leg } from './router'

export type GhostState = { kind: 'off' } | { kind: 'loading' } | { kind: 'ready'; ghost: Ghost } | { kind: 'unavailable'; reason: string }

export interface WaypointEditorOptions {
  /** route grid of a scenario (default: loadRouteGrid, 5 m T_home + far heights) */
  loadGrid?: (scenario: string) => Promise<RouteGridData>
  /** run the ghost computation later (default setTimeout 0: never inside the click or drop handler) */
  defer?: (fn: () => void) => void
}

export function createWaypointEditor(ctl: RouteController, opts: WaypointEditorOptions = {}) {
  const loadGrid = opts.loadGrid ?? loadRouteGrid
  const defer = opts.defer ?? ((fn: () => void) => void setTimeout(fn, 0))
  const adding = signal(false)
  /** W name of the marker being dragged (D85: no store change and no ghost until the drop) */
  const dragging = signal<string | null>(null)
  const ghost = signal<GhostState>({ kind: 'off' })
  const mapAttached = signal(false)

  let grid: { data: RouteGridData; g: GhostGrid; cache: Map<string, Leg | null> } | null = null
  let gen = 0
  /** how many times the ghost was routed (tests: none while dragging) */
  let runs = 0

  const scenarioNow = () => ctl.store.step.peek().plan.scenario
  const padNow = () => {
    const p = ctl.store.step.peek().inputs.pad
    return { lon: p.lon, lat: p.lat }
  }

  function gridFor(d: RouteGridData) {
    if (grid?.data === d) return grid
    const router = new LegRouter(d.grid, d.model)
    const g: GhostGrid = {
      cellOf: (lon, lat) => accessCell(d.grid, cellOf(d.tHome, lon, lat), ACCESS_RADIUS_M),
      lonLatOf: (c) => lonLatOfCell(d.tHome, c),
      route: (a, b) => router.route(a, b),
    }
    grid = { data: d, g, cache: new Map() }
    return grid
  }

  function recompute(r: PlanRoute): void {
    const my = ++gen
    if (r.mode !== 'ordered' || !r.stops.length) {
      ghost.value = { kind: 'off' }
      return
    }
    const sid = scenarioNow()
    if (!grid || grid.data.scenario !== sid) ghost.value = { kind: 'loading' }
    loadGrid(sid).then(
      (d) =>
        defer(() => {
          if (my !== gen) return
          const G = gridFor(d)
          runs++
          const out = ghostRoute(ctl.store.route.peek(), { stations: ctl.stations, pad: padNow() }, G.g, G.cache)
          ghost.value = out ? { kind: 'ready', ghost: out } : { kind: 'off' }
        }),
      (e: unknown) => {
        if (my !== gen) return
        ghost.value = { kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) }
      },
    )
  }

  // the ghost follows the route and the plan (pad, scenario); a marker drag holds it (D85)
  const off = effect(() => {
    const r = ctl.store.route.value
    void ctl.store.step.value
    if (dragging.value !== null) return
    recompute(r)
  })

  const edit = (next: PlanRoute) => ctl.edit(next)
  const running = () => ctl.compute.peek().kind === 'running'

  const ed = {
    ctl,
    adding: adding as ReadSignal<boolean>,
    dragging: dragging as ReadSignal<string | null>,
    ghost: ghost as ReadSignal<GhostState>,
    mapAttached: mapAttached as ReadSignal<boolean>,
    /** why "Add waypoint" is off: 'auto' | 'tooManyFreePoints' | 'tooManyStops' | 'running' | 'noMap' | null */
    blocked: computed(() => addBlocked(ctl.store.route.value) ?? (ctl.compute.value.kind === 'running' ? 'running' : mapAttached.value ? null : 'noMap')),
    /** the ghost is drawn and listed only while no computed live result is on the map */
    ghostShown: computed(() => {
      const c = ctl.compute.value
      if (c.kind === 'done') return false
      if ((c.kind === 'running' || c.kind === 'failed') && c.stage) return false
      return ghost.value.kind !== 'off'
    }),
    get runs() {
      return runs
    },
    startAdd(): boolean {
      if (ed.blocked.peek()) return false
      adding.value = true
      return true
    },
    cancelAdd(): void {
      adding.value = false
    },
    toggleAdd(): boolean {
      if (adding.peek()) {
        adding.value = false
        return false
      }
      return ed.startAdd()
    },
    /** The armed map click: appends W{n} (one undo step) and disarms. */
    add(lon: number, lat: number): boolean {
      if (!adding.peek()) return false
      adding.value = false
      if (running()) return false
      return edit(addPoint(ctl.store.route.peek(), { lon, lat }))
    },
    /** A marker drag starts: nothing is applied or routed until the drop (D85). */
    dragStart(name: string): void {
      dragging.value = name
    },
    /** The drop: one undo step; the ghost reroutes the two legs of this stop. */
    drop(i: number, lon: number, lat: number): boolean {
      dragging.value = null
      if (running()) {
        recompute(ctl.store.route.peek())
        return false
      }
      const ok = edit(movePoint(ctl.store.route.peek(), i, { lon, lat }))
      if (!ok) recompute(ctl.store.route.peek())
      return ok
    },
    dragCancel(): void {
      dragging.value = null
    },
    rename(i: number, label: string): boolean {
      return !running() && edit(renamePoint(ctl.store.route.peek(), i, label))
    },
    remove(i: number): boolean {
      return !running() && edit(deletePoint(ctl.store.route.peek(), i))
    },
    setMapAttached(on: boolean): void {
      mapAttached.value = on
      if (!on) adding.value = false
    },
    dispose(): void {
      gen++
      off()
      adding.value = false
    },
  }
  return ed
}

export type WaypointEditor = ReturnType<typeof createWaypointEditor>

const editors = new WeakMap<RouteController, WaypointEditor>()

/** The editor of a controller (created on first use; the panel and the map share it). */
export function editorOf(ctl: RouteController, opts?: WaypointEditorOptions): WaypointEditor {
  let e = editors.get(ctl)
  if (!e) {
    e = createWaypointEditor(ctl, opts)
    editors.set(ctl, e)
  }
  return e
}

/** Drop a controller's editor (the panel is unmounted). */
export function disposeEditor(ctl: RouteController): void {
  editors.get(ctl)?.dispose()
  editors.delete(ctl)
}

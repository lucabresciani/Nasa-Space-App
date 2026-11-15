// Mount of the live plan routes (#/plan, #/plan/{hash}, …/provenance, …/play) from a hash listener
// inside src/live. The app router (src/router.ts, WS5) does not know these routes and renders its
// "Not found" page into .outlet; while a plan route is open this module hides .outlet and shows its
// own container next to it, and gives .outlet back on any other route. It starts from mountLive
// (index.ts), so it exists only in builds with VITE_LIVE=1. A router entry would be cleaner; the
// exact lines are in /tmp/hl-orch/notes/U3.md.
import { render as preactRender, type ComponentChildren } from 'preact'
import { dataUrl } from '../env'
import type { ApiClient } from './client'
import type { LiveState } from './health'
import type { ScenarioLayers } from './mapPort'
import { importPlanFile, loadPlan, parsePlanRoute, permalink, type ImportState, type PlanLoad, type PlanRoute, type PlanTree } from './plan'
import { ImportPage, PlanLoading, PlanPage, PlanProblem, PlayHeader, ProvenancePage } from './planview'
import { createPlansStore, type PlansResult, type PlansStore } from './plans/store'
import type { MyPlansProps } from './plans/view'
import type { LoaderFor } from './stage'
import type { PlanInputs, RunOrigin } from './types'

type OkLoad = Extract<PlanLoad, { state: 'ok' }>
type Cleanup = () => void

/** The HUD's public entry (src/hud/index.ts, WS7 slot contract): mount(el, { dataUrl }). */
export interface HudModule {
  mount(el: HTMLElement, ctx: { dataUrl: (path: string) => string }): void | Cleanup | Promise<void | Cleanup>
}

/** File URLs of a result for the HUD: the same tree, read under the result's base URL. */
export const resultDataUrl = (base: string) => (path: string) => dataUrl(path, 'real', base)

/** "Play this plan": the 2D HUD playback on the result tree, through the HUD's own mount. */
export async function playPlan(el: HTMLElement, load: OkLoad, loadHud: () => Promise<HudModule>, urlFor: (load: OkLoad) => (path: string) => string = (l) => resultDataUrl(l.base)): Promise<Cleanup> {
  const hud = await loadHud()
  const c = await hud.mount(el, { dataUrl: urlFor(load) })
  return c ?? (() => {})
}

const EMPTY = { type: 'FeatureCollection' as const, features: [] }

/** The console map's scenario layers for a result (missing layers are empty), or null without bands. */
export function planLayers(tree: PlanTree): ScenarioLayers | null {
  if (!tree.scenario || !tree.bands) return null
  return {
    bands: tree.bands,
    isochrones: tree.isochrones ?? EMPTY,
    edges: tree.edges ?? EMPTY,
    partner: tree.partner ?? (EMPTY as unknown as ScenarioLayers['partner']),
    variant: tree.scenario.variant,
  }
}

/** Default map: the console's own ConsoleMap (one rendering path), lazily loaded with MapLibre. */
async function consoleMapFor(el: HTMLElement, load: OkLoad): Promise<Cleanup> {
  const { ConsoleMap } = await import('../map/consoleMap')
  const cmap = new ConsoleMap(el, (id) => {
    location.hash = `#/station/${encodeURIComponent(id)}`
  })
  const layers = planLayers(load.tree)
  if (layers) await cmap.setScenarioData(layers)
  await cmap.setRoute(load.tree.route)
  const pad = load.record.inputs.pad as { lon?: unknown; lat?: unknown } | undefined
  if (pad && typeof pad.lon === 'number' && typeof pad.lat === 'number') {
    cmap.setPad({ lon: pad.lon, lat: pad.lat, label: 'Pad', title: `Pad of plan ${load.hash}` })
    cmap.fitTo([{ lon: pad.lon, lat: pad.lat }])
  }
  return () => cmap.destroy()
}

export interface PlanRouteOptions {
  client: ApiClient
  /** Result-tree loader per base (default liveLoader; the dev mock passes mockLiveLoader). */
  loaderFor?: LoaderFor
  /** SIM_EXPORT_ENABLED (VITE_SIM_EXPORT). */
  simEnabled: boolean
  /** Default: import('../hud'). */
  loadHud?: () => Promise<HudModule>
  /** HUD file URLs (default: the result base). */
  hudDataUrl?: (load: OkLoad) => (path: string) => string
  /** Draw the result on a map in `el` (default ConsoleMap); null: no map. */
  mountMap?: ((el: HTMLElement, load: OkLoad) => Promise<Cleanup>) | null
  /**
   * Health state source (index.ts onLiveState). While it says offline every #/plan/{hash} view
   * shows the offline text at once, without a request and also for a plan loaded earlier in the
   * session (no Play, Export or simulator slot); the view is shown again when health comes back.
   */
  onLiveState?: (fn: (s: LiveState) => void) => () => void
  /** "My plans" store (D97; default: this browser's storage, createPlansStore()). */
  plans?: PlansStore
  /** Test seam: draw into the box (default preact's render). */
  render?: (vnode: ComponentChildren, el: HTMLElement) => void
}

/** Start the hash listener; returns cleanup. `app` holds the router's .outlet. */
export function mountPlanRoute(app: HTMLElement, opts: PlanRouteOptions): Cleanup {
  const outlet = app.querySelector<HTMLElement>('.outlet')
  if (!outlet) return () => {}
  const box = document.createElement('section')
  box.className = 'live-plan'
  box.hidden = true
  outlet.after(box)
  const render = opts.render ?? ((v: ComponentChildren, el: HTMLElement) => preactRender(v, el))
  const loadHud = opts.loadHud ?? (() => import('../hud') as Promise<HudModule>)
  const mountMap = opts.mountMap === undefined ? consoleMapFor : opts.mountMap
  const loads = new Map<string, Promise<PlanLoad>>()
  /** Run records in before their tree: the loading view shows the origin label from them. */
  const records = new Map<string, RunOrigin>()
  let seq = 0
  let teardown: Cleanup | undefined
  let importState: ImportState = { kind: 'idle' }
  let importAbort: AbortController | undefined
  const store = opts.plans ?? createPlansStore()
  let plansError: string | null = null
  const act = (r: PlansResult) => {
    plansError = r.ok ? null : r.error
    rerender?.()
  }
  /** "My plans" props, read fresh on every draw; `current` = the plan on screen (for Save). */
  const plansProps = (current?: { hash: string; inputs: PlanInputs }): MyPlansProps => ({
    snap: store.list(),
    error: plansError,
    onSave: (hash) => current && current.hash === hash && act(store.save(current)),
    onRename: (id, title) => act(store.rename(id, title)),
    onRemove: (id) => act(store.remove(id)),
  })

  const getLoad = (hash: string) => {
    let p = loads.get(hash)
    if (!p) {
      p = loadPlan(opts.client, hash, {
        loaderFor: opts.loaderFor,
        onRecord: (r) => {
          records.set(hash, r.origin)
          rerender?.()
        },
      })
      loads.set(hash, p)
      // only a found result is kept; not found or offline is asked again next time
      void p.then((l) => l.state !== 'ok' && (loads.delete(hash), records.delete(hash)))
    }
    return p
  }

  const onFile = (file: File) => {
    importAbort?.abort()
    importAbort = new AbortController()
    void importPlanFile(file, {
      client: opts.client,
      navigate: (h) => {
        location.hash = h
      },
      onState: (s) => {
        importState = s
        rerender?.()
      },
      signal: importAbort.signal,
    })
  }
  let rerender: (() => void) | undefined

  async function show(route: PlanRoute, my: number) {
    if (route.view === 'import') {
      rerender = () => render(<ImportPage state={importState} onFile={onFile} plans={plansProps()} />, box)
      rerender()
      return
    }
    if (offline) {
      const load = { state: 'offline', hash: route.hash, message: 'the health check says the live server is offline' } as const
      rerender = () => render(<PlanProblem load={load} plans={plansProps()} />, box)
      rerender()
      return
    }
    rerender = () => render(<PlanLoading hash={route.hash} origin={records.get(route.hash) ?? null} />, box)
    rerender()
    const load = await getLoad(route.hash)
    if (my !== seq) return
    if (load.state !== 'ok') {
      rerender = () => render(<PlanProblem load={load} plans={plansProps()} />, box)
      rerender()
      return
    }
    if (route.view === 'provenance') {
      rerender = undefined
      render(<ProvenancePage load={load} />, box)
      return
    }
    if (route.view === 'play') {
      rerender = undefined
      render(
        <>
          <PlayHeader load={load} />
          <div class="live-play-hud" />
        </>,
        box,
      )
      const el = box.querySelector<HTMLElement>('.live-play-hud')!
      try {
        const c = await playPlan(el, load, loadHud, opts.hudDataUrl)
        if (my !== seq) return c()
        teardown = c
      } catch (e) {
        el.textContent = `The HUD could not play this plan: ${e instanceof Error ? e.message : String(e)}`
      }
      return
    }
    const link = permalink(load.hash, location)
    rerender = () =>
      render(
        <>
          {mountMap && <div class="live-plan-map" />}
          <PlanPage
            load={load}
            permalink={link}
            simEnabled={opts.simEnabled}
            importState={importState}
            onImportFile={onFile}
            plans={plansProps({ hash: load.hash, inputs: load.record.inputs })}
          />
        </>,
        box,
      )
    rerender()
    const mapEl = box.querySelector<HTMLElement>('.live-plan-map')
    if (mountMap && mapEl) {
      try {
        const c = await mountMap(mapEl, load)
        if (my !== seq) return c()
        teardown = c
      } catch (e) {
        mapEl.textContent = `Map unavailable: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  function onHash() {
    const my = ++seq
    teardown?.()
    teardown = undefined
    rerender = undefined
    plansError = null
    const route = parsePlanRoute(location.hash)
    if (!route) {
      if (!box.hidden) {
        render(null, box)
        box.hidden = true
        outlet!.hidden = false
      }
      return
    }
    outlet!.hidden = true
    box.hidden = false
    if (importState.kind !== 'computing') importState = { kind: 'idle' }
    void show(route, my).catch((e) => {
      if (my === seq) box.textContent = `This plan view failed: ${e instanceof Error ? e.message : String(e)}`
    })
  }

  // Health: crossing into or out of offline redraws an open #/plan/{hash} view (a pending load is
  // dropped by the seq bump in onHash, so a hanging server never holds the offline text back).
  let offline = false
  let started = false
  const offLive =
    opts.onLiveState?.((s) => {
      const now = s.kind === 'offline'
      if (now === offline) return
      offline = now
      const route = started ? parsePlanRoute(location.hash) : null
      if (route && route.view !== 'import') onHash()
    }) ?? (() => {})

  window.addEventListener('hashchange', onHash)
  onHash()
  started = true
  return () => {
    offLive()
    window.removeEventListener('hashchange', onHash)
    importAbort?.abort()
    teardown?.()
    render(null, box)
    box.remove()
    outlet.hidden = false
  }
}

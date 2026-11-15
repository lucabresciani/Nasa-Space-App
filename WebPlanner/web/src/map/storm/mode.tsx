// WS16 task 12 (M12): storm mode on the planning map (DESIGN U9), loaded on the first switch-on.
// While mission.conditions.storm is on it follows the mission clock and drives:
//   - the field's dose term: mission.conditions.tauDoseMin = the dose budget left after the tripwire
//     (M3 storm override, fieldUniforms.tauDose); before the tripwire the plan's D39 tau(t) stays
//   - the map panel (timing note, tripwire minute, dose-ring legend) and the alarm banner at the tripwire
//   - the dose ring: boundary of the fieldAt lattice cells with T_home <= the ring leash (ring.ts)
//   - the thread colour: an overlay line on the furniture's `thread` source, in `limit`, shown while
//     HUD alarm 2 holds for the thread's start (T_home >= dose budget left); the furniture's own
//     line is faded out under it (its line-opacity is never touched by the furniture)
//   - the dose-rate curve over the timeline dock's plot lane (A7 exposes no hook: rendered from here
//     into `.hl-tl__plot`, re-attached if the dock remounts)
// All of it comes and goes with the panel that carries the timing note (model.ts stormVisuals).
// No browser storage. No animation: everything follows the clock (reduced motion: nothing to stop).
import type { GeoJSONSource, Map as MlMap, MapSourceDataEvent } from 'maplibre-gl'
import { render } from 'preact'
import { data } from '../../data/loader'
import { effect, mission } from '../../state'
import { TOKENS } from '../../ui/tokens'
import { ensureManifest } from '../../views/common'
import { activeField, fieldAt, onFieldChange, type FieldData } from '../field'
import { buildStormModel, stormView, stormVisuals, threadRed, type StormModel, type StormRad, type StormTimelineRow, type StormView } from './model'
import { StormCurve, StormPanel } from './Panel'
import { ringBoundary, ringCount, ringLattice, ringMask, type LonLat, type RingLattice } from './ring'

export const RING_SOURCE = 'storm-ring'
export const RING_LAYER = 'storm-ring-line'
export const THREAD_SOURCE = 'thread' // furniture/index.ts
export const THREAD_LAYER = 'thread-line' // furniture/index.ts
export const STORM_THREAD_LAYER = 'storm-thread-line'
/** Ring redraw at most this often while the clock runs (the zero-edge labels use the same 4 Hz, M3). */
const RING_REDRAW_MS = 250
/** Dash of the ring line (second cue next to the colour; the margin zero edge is solid). */
const RING_DASH = [3, 2]

export async function loadStormModel(): Promise<StormModel | null> {
  const L = data()
  await ensureManifest()
  const idx = await L.scenarios()
  const entry = idx.scenarios.find((s) => s.id === idx.default) ?? idx.scenarios[0]
  if (!entry) return null
  const [tl, rad] = await Promise.all([L.optional(() => L.timeline(entry.id)), L.optional(() => L.rad())])
  if (!tl || !rad) return null
  return buildStormModel(rad as unknown as StormRad, entry.id, tl as unknown as StormTimelineRow[])
}

export interface StormHandle {
  stop(): void
}

/** Start storm mode on `map`. Resolves null (and changes nothing) when the storm cannot be placed. */
export async function startStormMode(map: MlMap): Promise<(StormHandle & { model: StormModel }) | null> {
  const model = await loadStormModel()
  if (!model) return null
  const container = map.getContainer()
  const overlay = document.createElement('div')
  overlay.className = 'hl-storm'
  container.appendChild(overlay)
  const curveHost = document.createElement('div')
  curveHost.className = 'hl-storm-curve-host'

  let view: StormView | null = null
  let lattice: RingLattice | null = null
  let latticeOf: FieldData | null = null
  let ringAt = 0
  let ringLeash = NaN
  let ringTimer = 0
  let threadTHome: number | null = null
  let red = false
  let stopped = false

  // ---- map layers -------------------------------------------------------------------------------
  const lineColor = TOKENS.color.limit
  const addLayers = (): void => {
    if (!map.getSource(RING_SOURCE)) map.addSource(RING_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (!map.getLayer(RING_LAYER))
      map.addLayer({
        id: RING_LAYER,
        type: 'line',
        source: RING_SOURCE,
        layout: { 'line-join': 'miter', 'line-cap': 'butt' },
        paint: { 'line-color': lineColor, 'line-width': TOKENS.line.fieldEdgePx, 'line-dasharray': RING_DASH },
      })
    if (map.getSource(THREAD_SOURCE) && !map.getLayer(STORM_THREAD_LAYER)) {
      map.addLayer({
        id: STORM_THREAD_LAYER,
        type: 'line',
        source: THREAD_SOURCE,
        layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
        paint: { 'line-color': lineColor, 'line-width': TOKENS.line.threadPx },
      })
    }
  }
  addLayers()

  // ---- dose ring --------------------------------------------------------------------------------
  const ensureLattice = (): RingLattice | null => {
    const f = activeField()
    if (!f) return null
    if (latticeOf !== f) {
      lattice = ringLattice((lo, la) => fieldAt(lo, la), { width: f.t.nom.width, height: f.t.nom.height, bounds: f.bounds, resM: f.resM })
      latticeOf = f
      ringLeash = NaN
    }
    return lattice
  }
  const drawRing = (): void => {
    ringTimer = 0
    if (stopped || !view) return
    const l = ensureLattice()
    const src = map.getSource(RING_SOURCE) as GeoJSONSource | undefined
    if (!l || !src) return
    const leash = view.ringLeashMin
    if (leash === ringLeash) return
    ringLeash = leash
    ringAt = performance.now()
    const mask = ringMask(l, leash)
    const lines: LonLat[][] = ringBoundary(l, mask)
    src.setData({ type: 'Feature', properties: { leash_min: leash, cells: ringCount(mask) }, geometry: { type: 'MultiLineString', coordinates: lines } })
    container.setAttribute('data-storm-ring-cells', String(ringCount(mask)))
  }
  const scheduleRing = (): void => {
    if (ringTimer) return
    const wait = Math.max(0, ringAt + RING_REDRAW_MS - performance.now())
    ringTimer = window.setTimeout(drawRing, wait)
  }
  const offField = onFieldChange(() => {
    ringLeash = NaN
    scheduleRing()
  })

  // ---- thread colour ----------------------------------------------------------------------------
  const applyThread = (): void => {
    if (!map.getLayer(STORM_THREAD_LAYER)) addLayers()
    const want = !!view && threadRed(view, threadTHome)
    if (want === red && map.getLayer(STORM_THREAD_LAYER)) return
    red = want
    if (map.getLayer(STORM_THREAD_LAYER)) map.setLayoutProperty(STORM_THREAD_LAYER, 'visibility', red ? 'visible' : 'none')
    if (map.getLayer(THREAD_LAYER)) map.setPaintProperty(THREAD_LAYER, 'line-opacity', red ? 0 : 1)
    container.setAttribute('data-storm-thread', red ? 'red' : 'normal')
    mirrorDash()
  }
  // the storm line copies the furniture's dash step (dash flow; none under reduced motion)
  const mirrorDash = (): void => {
    if (!red || !map.getLayer(THREAD_LAYER) || !map.getLayer(STORM_THREAD_LAYER)) return
    const d = map.getPaintProperty(THREAD_LAYER, 'line-dasharray')
    if (JSON.stringify(d) !== JSON.stringify(map.getPaintProperty(STORM_THREAD_LAYER, 'line-dasharray'))) map.setPaintProperty(STORM_THREAD_LAYER, 'line-dasharray', d as number[])
  }
  let threadSeq = 0
  const onSourceData = (e: MapSourceDataEvent): void => {
    if (e.sourceId !== THREAD_SOURCE || e.sourceDataType === 'metadata') return
    const src = map.getSource(THREAD_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    const seq = ++threadSeq
    void src.getData().then((g) => {
      if (stopped || seq !== threadSeq) return
      const start = threadStart(g)
      const s = start ? fieldAt(start[0], start[1]) : null
      threadTHome = s ? s.tHome[s.variant] : null
      applyThread()
    })
  }
  map.on('sourcedata', onSourceData)
  map.on('render', mirrorDash)

  // ---- timeline dock overlay --------------------------------------------------------------------
  const attachCurve = (): void => {
    const plot = document.querySelector('.hl-tl__plot')
    if (plot && curveHost.parentNode !== plot) plot.appendChild(curveHost)
  }
  const dockTimer = window.setInterval(attachCurve, 1000)

  // ---- follow the clock -------------------------------------------------------------------------
  const stopClock = effect(() => {
    const t = mission.clock.t.value
    const tMax = mission.clock.tMax.value
    view = stormView(model, t)
    const vis = stormVisuals(true, model, view)
    const tau = view.tauOverride
    if (mission.conditions.tauDoseMin.peek() !== tau) queueMicrotask(() => !stopped && (mission.conditions.tauDoseMin.value = tau))
    render(vis.note ? <StormPanel m={model} v={view} /> : null, overlay)
    attachCurve()
    render(vis.curve ? <StormCurve m={model} tMax={tMax} /> : null, curveHost)
    container.setAttribute('data-storm', view.fired ? 'fired' : 'armed')
    if (map.getLayer(RING_LAYER)) map.setLayoutProperty(RING_LAYER, 'visibility', vis.ring ? 'visible' : 'none')
    scheduleRing()
    applyThread()
  })

  return {
    model,
    stop(): void {
      stopped = true
      stopClock()
      offField()
      window.clearInterval(dockTimer)
      if (ringTimer) window.clearTimeout(ringTimer)
      map.off('sourcedata', onSourceData)
      map.off('render', mirrorDash)
      render(null, overlay)
      render(null, curveHost)
      overlay.remove()
      curveHost.remove()
      container.removeAttribute('data-storm')
      container.removeAttribute('data-storm-thread')
      container.removeAttribute('data-storm-ring-cells')
      if (map.getLayer(STORM_THREAD_LAYER)) map.removeLayer(STORM_THREAD_LAYER)
      if (map.getLayer(THREAD_LAYER)) map.setPaintProperty(THREAD_LAYER, 'line-opacity', 1)
      if (map.getLayer(RING_LAYER)) map.removeLayer(RING_LAYER)
      if (map.getSource(RING_SOURCE)) map.removeSource(RING_SOURCE)
      mission.conditions.tauDoseMin.value = undefined
    },
  }
}

/** First coordinate of the thread source's line (its start: cursor or crew); null when empty. */
export function threadStart(g: unknown): LonLat | null {
  const f = g as { type?: string; geometry?: { type?: string; coordinates?: LonLat[] } } | null
  const c = f?.type === 'Feature' && f.geometry?.type === 'LineString' ? f.geometry.coordinates : null
  return c && c.length ? c[0] : null
}

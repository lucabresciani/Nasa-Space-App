// Planning-console map (F17 default view, F5 slider, F6 scenario layers). Plain TS + MapLibre.
// Offline by construction: the style has no glyphs, sprite or remote source; every source is a
// local data file or a canvas-made image. Labels are HTML markers; the U13 labels from labels.json
// are DOM pills placed by a CPU collision layout (labels/layer.ts, no glyphs needed).
import { LngLatBounds, Map as MlMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl'
import type { ExpressionSpecification, FilterSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { CONFIG } from '../config'
import { accessFor, walkInLines } from '../data/access'
import { data } from '../data/loader'
import { drawnPartner } from '../data/partner'
import type { AnyFC, BandsFC, EdgesFC, IsochroneFC, PartnerFC, RouteFC, ScenarioEntry, Station } from '../data/types'
import { THEME } from '../theme'
import type { BasemapSource } from './basemap'
import { hatchDataUrl } from './hatch'
import { edgeLabelPoints } from './labels'
import { binEdges, stepColorExpression } from './legend'
import { MarsScaleControl } from './scale'
import { effect, ui } from '../state'
import { collapseFade, collapseHeadline, collapseQuery, padGridMetres, playCollapse, setCollapse } from './field/collapse'
import { CollapseHeadlineOverlay, CollapseToggle } from './field/collapseUi'
import { MapFurniture, MARKER_LAYERS, ROUTE_LAYERS } from './furniture'
import { LabelLayer, loadLabels, setLabelPlacementPaused, setSelectedLabel } from './labels/layer'
import type { MapLabel } from './labels/model'
import { TerrainController } from './terrain'
import type { RoverHandle } from '../edit/roverMap'
import { FlythroughControl } from './flythrough/control'
import { installStorm } from './storm'
import { storyParams, storyRequest } from '../story/query'
import { CameraController, type ControllerMap } from './camera'
import { installOverlays } from './overlays'
import { MapSelection, SELECT_ROUTE_HIT, type SelectMap, type SelectSources } from './select'
import { installMapInput, type InputMap, type MapInput } from './input'
import { activeField, BINDING_LABEL, driveMargin, FIELD_TRUST, fieldModeQuery, fieldRequested, loadFieldData, loadFieldLayer, setActiveField, VARIANT_OF, webgl2Available, zeroEdgeLabels, type FieldData, type MarginState } from './field'

/** The GPU field layer handle (field/layer.ts, loaded lazily). */
type FieldLayerHandle = ReturnType<Awaited<ReturnType<typeof loadFieldLayer>>['addFieldLayer']>

/** Polygon layers the GPU field replaces while it is on (they stay as the fallback, DESIGN U2 item 8). */
const POLYGON_BAND_LAYERS = ['band-opt', 'band-con', 'band-lines']

// After bundling, MapLibre cannot find its worker next to itself; point it at the emitted asset.
setWorkerUrl(workerUrl)

export type LayerGroup = 'basemap' | 'bands' | 'unknown' | 'edges' | 'stations' | 'slider' | 'route' | 'partner' | 'siting'

/** Default visibility: SPEC F17 default view = basemap, 30-min nominal band, edge causes, stations. */
export const DEFAULT_VISIBLE: Record<LayerGroup, boolean> = {
  basemap: true,
  bands: true,
  unknown: true,
  edges: true,
  stations: true,
  slider: false,
  route: false,
  partner: false, // never in the default view (brief WS5 "Don't")
  siting: false, // F8 heatmap (siting score); D21 picks the official pad by feasible EVAs
}

const GROUP_LAYERS: Record<LayerGroup, string[]> = {
  basemap: ['basemap'],
  bands: ['band-opt', 'band-con', 'band-lines'],
  unknown: ['unknown-hatch'],
  edges: ['edges-line'],
  stations: ['walkin-line', 'access-pts', ...MARKER_LAYERS],
  slider: ['iso-fill', 'iso-lines', 'iso-current'],
  route: ROUTE_LAYERS, // WS16 task 5: route draw-on, done / coming legs, turn-back ticks (furniture)
  partner: ['partner-line'],
  siting: ['siting-img'],
}

export function blankStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': THEME.mapBackground } }],
  }
}

const EMPTY: AnyFC = { type: 'FeatureCollection', features: [] }

export class ConsoleMap {
  readonly map: MlMap
  private ready: Promise<void>
  private visible: Record<LayerGroup, boolean> = { ...DEFAULT_VISIBLE }
  private budget: number = CONFIG.walkbackBudgetsMin[0]
  private variant = 'nominal'
  private sliderMin = CONFIG.walkbackBudgetsMin[0]
  private edges: EdgesFC | null = null
  private stationMarkers: Marker[] = []
  private padMarker?: Marker
  private sitingMarkers: Marker[] = []
  private padOptionMarkers: Marker[] = []
  private edgeMarkers: Marker[] = []
  private hasBasemap = false
  private groupLayers: Record<LayerGroup, string[]> = Object.fromEntries(Object.entries(GROUP_LAYERS).map(([k, v]) => [k, [...v]])) as Record<LayerGroup, string[]>
  private readonly onStation: (id: string) => void
  // WS16 task 2: GPU field layer (bands mode). Drawn only for the published scenario bands (the field
  // PNGs exist for those); D21 parking options, live previews, no WebGL2 or ?field=off -> polygons.
  private readonly fieldWanted = fieldRequested(location.search, location.hash) && webgl2Available()
  private fieldFailed = false
  private fieldSeq = 0
  private fieldLayer: FieldLayerHandle | null = null
  private fieldData: FieldData | null = null
  private fieldOn = false
  // WS16 task 3: margin mode (mission-state driven; ?field=margin|bands|play until the shell exists)
  private margin: MarginState = { inputs: null, marginMode: false }
  private marginLabels: Marker[] = []
  private marginLabelAt = 0
  private marginLabelTimer = 0
  private stopMargin: (() => void) | null = null
  private stationsScenario: string | null = null
  // WS16 task 4: the collapse (U3). Pad in field-grid metres (u_pad), headline overlay, toggle.
  private collapsePad: [number, number] | null = null
  private fieldScenario: string | null = null
  private headline: CollapseHeadlineOverlay | null = null
  private collapseToggle: CollapseToggle | null = null
  private stopCollapse: (() => void) | null = null
  private collapseQueryDone = false
  /** k < 1: the real band's edge causes (lines, labels) are hidden; they belong to k = 1 */
  private collapseHidesEdges = false
  // WS16 task 5: thread home, route draw-on, markers, compass, cursor readout (U4)
  private furniture: MapFurniture | null = null
  // WS16 task 6: U13 labels from labels.json; they replace the old HTML label of each object they cover
  private labels: LabelLayer | null = null
  private lastStations: { stations: Station[]; scenarioId: string } | null = null
  private lastPad: Parameters<ConsoleMap['setPad']>[0] | null = null
  private lastPadOptions: Parameters<ConsoleMap['setPadOptions']> | null = null
  // WS16 task 8 (M8): U1 terrain; the 3D code loads only when ui.view turns '3d'
  private terrain: TerrainController | null = null
  // WS18 task 2: drag the rover (U15), shell frame only; lazy chunk
  private rover: RoverHandle | null = null
  // WS16 task 10 (M10): U6 flythrough button and story mode (intro, ?demo=1, ?capture=; lazy)
  private stopStory: (() => void) | null = null
  // WS16 task 12 (M12): U9 storm mode switch (visuals load lazily on first switch-on)
  private stopStorm: (() => void) | null = null
  // WS16 task 9 (M9): map clicks/hover -> A5 selection store, highlight, isolation; camera presets and focus (U14, U16)
  private selectMap: MapSelection | null = null
  private camera: CameraController | null = null
  private lastRoute: RouteFC | null = null
  private labelRows: MapLabel[] | null = null
  private readonly selectSources = (): SelectSources => ({
    labels: this.labelRows,
    stations: this.lastStations?.stations ?? null,
    pad: this.lastPad,
    padOptions: this.lastPadOptions?.[0] ?? null,
    route: this.lastRoute,
    edges: this.edges,
  })
  // WS16 task 11 (M11): U7 overlays + layer manager (all off by default)
  private stopOverlays: (() => void) | null = null
  private destroyed = false
  private readonly input: MapInput

  constructor(container: HTMLElement, onStation: (id: string) => void) {
    this.onStation = onStation
    // Trust-chip hook (DESIGN §3.6): the homeline layer group is Modelled; A2's chip attaches here.
    container.setAttribute(FIELD_TRUST.attr, FIELD_TRUST.chip)
    container.setAttribute(FIELD_TRUST.renderAttr, 'polygons')
    const f = CONFIG.aoiFocus
    this.map = new MlMap({
      container,
      style: blankStyle(),
      bounds: [f.west, f.south, f.east, f.north],
      fitBoundsOptions: { padding: 40 },
      attributionControl: false,
      // 2D until ui.view is '3d': TerrainController (terrain/index.ts) lifts maxPitch and rotation then
      maxPitch: 0,
      dragRotate: false,
      boxZoom: false, // I1: left button interacts (select, drag the rover); a left drag on the map does nothing
      renderWorldCopies: false,
      canvasContextAttributes: { preserveDrawingBuffer: true }, // screen capture (Sun 12:00-16:00) reads the canvas
    })
    this.map.touchZoomRotate.disableRotation()
    // I1: right drag pans, Ctrl/Shift + right drag or middle drag rotates / tilts, no context menu (map/input)
    this.input = installMapInput(this.map as unknown as InputMap, { reduced: () => ui.reducedMotion.peek() })
    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-left')
    this.map.addControl(new MarsScaleControl(CONFIG.marsRadiusM), 'bottom-left')
    this.ready = new Promise((res) => this.map.once('load', () => res()))
    // X3 (fallback drill finding 1): the view may be gone before 'load'; never touch a removed map
    this.ready.then(() => !this.destroyed && this.initLayers())
    if (container.closest('.hl-shell'))
      void this.ready.then(() => import('../edit/roverMap')).then((m) => {
        if (this.destroyed) return
        this.rover = m.installRoverDrag(this.map)
        if (this.padMarker) this.rover.attach(this.padMarker)
      })
  }

  whenReady(): Promise<void> {
    return this.ready
  }

  private initLayers(): void {
    const m = this.map
    for (const id of ['bands', 'iso', 'edges', 'partner', 'route', 'walkin', 'access']) m.addSource(id, { type: 'geojson', data: EMPTY })

    const { max } = CONFIG.isochroneMinutes
    const isoColor = stepColorExpression('minutes', binEdges(max, THEME.isoBinStepMin), [...THEME.isoRamp]) as ExpressionSpecification
    m.addLayer({ id: 'iso-fill', type: 'fill', source: 'iso', paint: { 'fill-color': isoColor, 'fill-opacity': THEME.isoFillOpacity } })
    m.addLayer({
      id: 'band-opt',
      type: 'fill',
      source: 'bands',
      paint: { 'fill-color': THEME.variant.optimistic, 'fill-opacity': THEME.bandFillOpacity.optimistic },
    })
    m.addLayer({
      id: 'band-con',
      type: 'fill',
      source: 'bands',
      paint: { 'fill-color': THEME.variant.conservative, 'fill-opacity': THEME.bandFillOpacity.conservative },
    })
    m.addLayer({ id: 'iso-lines', type: 'line', source: 'iso', paint: { 'line-color': isoColor, 'line-width': 1, 'line-opacity': 0.9 } })
    m.addLayer({ id: 'iso-current', type: 'line', source: 'iso', paint: { 'line-color': '#ffffff', 'line-width': 2 } })
    m.addLayer({
      id: 'band-lines',
      type: 'line',
      source: 'bands',
      paint: {
        'line-color': ['match', ['get', 'variant'], 'optimistic', THEME.variant.optimistic, 'conservative', THEME.variant.conservative, THEME.variant.nominal],
        'line-width': THEME.bandLineWidth.other,
      },
    })
    m.addLayer({ id: 'partner-line', type: 'line', source: 'partner', paint: { 'line-color': THEME.partner, 'line-width': 2, 'line-dasharray': [3, 2] } })
    m.addLayer({
      id: 'edges-line',
      type: 'line',
      source: 'edges',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'cause'], 'physiology', THEME.cause.physiology, 'slope', THEME.cause.slope, THEME.cause.data],
        'line-width': THEME.edgeLineWidth,
      },
    })
    // Access-cell rule (user 11:40): straight walk-in line science -> access cell, and the access cell.
    m.addLayer({ id: 'walkin-line', type: 'line', source: 'walkin', paint: { 'line-color': THEME.station, 'line-width': 1.5, 'line-dasharray': [1, 1] } })
    m.addLayer({
      id: 'access-pts',
      type: 'circle',
      source: 'access',
      paint: { 'circle-radius': 4, 'circle-color': THEME.mapBackground, 'circle-stroke-color': THEME.station, 'circle-stroke-width': 2 },
    })
    this.furniture = new MapFurniture(m)
    this.terrain = new TerrainController(m, 'iso-fill') // relief shading above the basemap, under everything else
    this.furniture.setRouteVisible(this.visible.route)
    this.applyFilters()
    this.applyVisibility()
    void this.initLabels()
    this.map.addControl(new FlythroughControl(), 'top-right')
    this.stopStorm = installStorm(this.map)
    this.selectMap = new MapSelection(m as unknown as SelectMap, this.selectSources, { setSelectedLabel, marker: (el) => new Marker({ element: el }) })
    this.selectMap.addLayers()
    this.groupLayers.route.push(SELECT_ROUTE_HIT)
    this.camera = new CameraController(m as unknown as ControllerMap, this.selectSources)
    this.stopOverlays = installOverlays(m as never, { marker: (el) => new Marker({ element: el }) }, !!m.getContainer().closest('.hl-shell'))
    const legacy = !!this.map.getContainer().closest('.hl-frame-legacy')
    const story = storyRequest(storyParams(location.search, location.hash), { reduced: ui.reducedMotion.peek(), introSeen: ui.introSeen.peek(), legacy })
    if (story) void import('../story/attach').then((m) => !this.destroyed && (this.stopStory = m.attachStory(this, story)))
  }

  /** M10c: a live story camera move pauses the per-move label placement (4 Hz) and the furniture loops. */
  setStoryPaused(on: boolean): void {
    setLabelPlacementPaused(on)
    this.furniture?.setPaused(on)
  }

  /** Whether a layer group is on (story mode saves and restores it). */
  layerVisible(group: LayerGroup): boolean {
    return this.visible[group]
  }

  /** U13 labels (labels.json); without the file the old HTML labels stay as they are. */
  private async initLabels(): Promise<void> {
    const ls = await loadLabels().catch((e) => {
      console.warn('labels.json unavailable; keeping the HTML labels:', e)
      return null
    })
    if (!ls?.length || this.labels || this.destroyed) return
    this.labelRows = ls
    this.labels = new LabelLayer(this.map)
    this.labels.setLabels(ls)
    if (this.lastPad) this.setPad(this.lastPad)
    if (this.lastPadOptions) this.setPadOptions(...this.lastPadOptions)
    if (this.lastStations) await this.setStations(this.lastStations.stations, this.lastStations.scenarioId)
    if (this.destroyed) return
    this.applyVisibility()
    this.selectMap?.refresh()
  }

  /** Basemap raster sources (tilejson.json, see basemap.ts), under every other layer. */
  async setBasemap(sources: BasemapSource[]): Promise<void> {
    await this.ready
    if (this.destroyed || !sources.length || this.hasBasemap) return
    const ids: string[] = []
    sources.forEach((src, i) => {
      const id = `basemap-${i}`
      this.map.addSource(id, { type: 'raster', tiles: src.tiles, tileSize: src.tileSize, minzoom: src.minzoom, maxzoom: src.maxzoom, bounds: src.bounds, attribution: src.attribution })
      this.map.addLayer(
        { id, type: 'raster', source: id, ...(src.layerMinzoom !== undefined ? { minzoom: src.layerMinzoom } : {}), paint: { 'raster-opacity': THEME.basemapOpacity, 'raster-fade-duration': 0 } },
        'iso-fill',
      )
      ids.push(id)
    })
    this.groupLayers.basemap = ids
    this.hasBasemap = true
    this.applyVisibility()
  }

  async setScenarioData(d: { bands: BandsFC; isochrones: IsochroneFC; edges: EdgesFC; partner: PartnerFC; variant: string }): Promise<void> {
    await this.ready
    if (this.destroyed) return
    this.variant = d.variant
    this.edges = d.edges
    ;(this.map.getSource('bands') as GeoJSONSource).setData(d.bands)
    ;(this.map.getSource('iso') as GeoJSONSource).setData(d.isochrones)
    ;(this.map.getSource('edges') as GeoJSONSource).setData(d.edges)
    ;(this.map.getSource('partner') as GeoJSONSource).setData(drawnPartner(d.partner)) // D20: cart only, drag never drawn
    this.applyFilters()
    this.renderEdgeLabels()
    void this.syncField(d.bands)
  }

  /**
   * The published scenario these bands belong to, by identity with the loader's cached file (the
   * scenario last passed to setStations, then the default). null for anything else (D21 parking
   * options, live previews): those have no field PNGs, so they keep the polygons.
   */
  private async publishedScenario(bands: BandsFC): Promise<ScenarioEntry | null> {
    const L = data()
    const idx = await L.scenarios()
    for (const id of new Set([this.stationsScenario, idx.default])) {
      const s = idx.scenarios.find((x) => x.id === id)
      if (s && (await L.bands(s)) === bands) return s
    }
    return null
  }

  private async syncField(bands: BandsFC): Promise<void> {
    const seq = ++this.fieldSeq
    try {
      const entry = await this.publishedScenario(bands)
      if (seq !== this.fieldSeq) return
      if (!entry) return this.showField(null)
      const fd = await loadFieldData(entry.suit_kg)
      if (seq !== this.fieldSeq) return
      this.fieldData = fd
      setActiveField(fd) // fieldAt() works with or without WebGL2
      if (!this.fieldWanted || this.fieldFailed) return this.showField(null)
      const mod = await loadFieldLayer()
      if (seq !== this.fieldSeq || this.fieldFailed) return
      const variant = VARIANT_OF[this.variant] ?? 'nom'
      if (!this.fieldLayer) {
        const h = mod.addFieldLayer(this.map, fd, { budget: this.budget, variant, showBands: this.visible.bands, showHatch: this.visible.unknown, margin: null, collapse: null }, 'iso-lines', (e) => this.fieldError(e))
        if (this.fieldFailed) return h.remove()
        this.fieldLayer = h
        this.terrain?.attachField(h) // drape on the terrain while 3D is on
      } else this.fieldLayer.setData(fd)
      this.fieldLayer.update({ variant, budget: this.budget })
      this.showField(fd)
      this.stopMargin ??= driveMargin(() => this.fieldData?.suitKg ?? null, (s) => this.setMargin(s), fieldModeQuery(location.search, location.hash))
      this.setMargin(this.margin)
      void this.furniture?.setScenario(entry.id)
      await this.syncCollapse(fd, entry.id)
    } catch (e) {
      this.fieldError(e)
    }
  }

  /** Collapse (U3): pad -> u_pad, k from the UI store -> layer + fieldAt, headline, toggle, ?collapse=. */
  private async syncCollapse(fd: FieldData, scenarioId: string): Promise<void> {
    const L = data()
    const [pad, manifest] = await Promise.all([L.optional(() => L.pad()), L.optional(() => L.manifest())])
    if (this.destroyed || this.fieldData !== fd || !this.fieldLayer) return
    const p = pad?.pad
    this.collapsePad = p && fd.resM !== null ? padGridMetres(fd.t.nom, fd.resM, p.lon, p.lat) : null
    this.fieldScenario = scenarioId
    this.headline ??= new CollapseHeadlineOverlay(this.map.getContainer())
    this.headline.setHeadline(manifest ? collapseHeadline(manifest as unknown as Record<string, unknown>, scenarioId, this.budget) : null)
    if (this.collapsePad && !this.collapseToggle) {
      this.collapseToggle = new CollapseToggle()
      this.map.addControl(this.collapseToggle, 'top-right')
    }
    this.stopCollapse ??= effect(() => {
      const k = ui.collapseK.value
      const kFrom = collapseFade.kFrom.value
      const xfade = collapseFade.xfade.value
      const pd = this.collapsePad
      const on = k !== undefined && pd !== null
      this.fieldData?.setCollapse(on ? pd : null, on ? k : 1)
      this.fieldLayer?.update({ collapse: on ? { k, kFrom, xfade, pad: pd } : null })
      this.map.getContainer().setAttribute('data-field-collapse', on ? String(k) : 'off')
      const hide = on && (k < 1 || xfade < 1)
      if (hide !== this.collapseHidesEdges) {
        this.collapseHidesEdges = hide
        this.applyVisibility()
      }
    })
    if (!this.collapseQueryDone && this.collapsePad) {
      this.collapseQueryDone = true
      const q = collapseQuery(location.search, location.hash)
      if (q?.kind === 'set') setCollapse(q.k)
      else if (q?.kind === 'play') {
        setCollapse(0)
        this.map.once('idle', () => void playCollapse())
      }
    }
  }

  private fieldError(e: unknown): void {
    this.fieldFailed = true
    console.warn('GPU field layer unavailable; showing the polygon bands:', e)
    this.fieldLayer?.remove()
    this.fieldLayer = null
    this.terrain?.attachField(null)
    this.showField(null)
  }

  private showField(fd: FieldData | null): void {
    this.fieldOn = fd !== null && this.fieldLayer !== null
    if (!fd && this.fieldData && activeField() === this.fieldData) setActiveField(null)
    if (!fd) void this.furniture?.setScenario(null)
    if (!fd) this.headline?.setHeadline(null) // the collapse headline belongs to the published field
    const c = this.map.getContainer()
    c.setAttribute(FIELD_TRUST.renderAttr, this.fieldOn ? 'gpu' : 'polygons')
    if (fd) c.setAttribute(FIELD_TRUST.sourceAttr, fd.sources.join(' '))
    else c.removeAttribute(FIELD_TRUST.sourceAttr)
    this.applyVisibility()
  }

  /** Margin mode (U2): inputs at the clock minute -> shader uniforms, fieldAt, edge labels. */
  private setMargin(s: MarginState): void {
    this.margin = s
    const variant = VARIANT_OF[this.variant] ?? 'nom'
    const inputs = this.fieldOn ? s.inputs : null
    this.fieldData?.setMargin(s.inputs, variant)
    this.fieldLayer?.update({ margin: inputs })
    this.map.getContainer().setAttribute('data-field-mode', inputs ? 'margin' : 'bands')
    // binding labels: at most 4 Hz while the clock runs (CPU scan of the drawn margin)
    const wait = Math.max(0, this.marginLabelAt + 250 - performance.now())
    clearTimeout(this.marginLabelTimer)
    this.marginLabelTimer = window.setTimeout(() => this.renderMarginLabels(), wait)
  }

  private renderMarginLabels(): void {
    this.marginLabelAt = performance.now()
    this.marginLabels.forEach((m) => m.remove())
    this.marginLabels = []
    const inputs = this.fieldOn ? this.margin.inputs : null
    const fd = this.fieldData
    if (!inputs || !fd || !this.visible.bands) return
    for (const l of zeroEdgeLabels(fd, inputs, VARIANT_OF[this.variant] ?? 'nom')) {
      const el = document.createElement('div')
      el.className = 'edge-label field-binding-label'
      el.textContent = `0 min · ${BINDING_LABEL[l.binding]}`
      el.title = `Zero margin: ${BINDING_LABEL[l.binding]} is the limit that binds here (margin per pixel, DESIGN U2; daylight at pad level)`
      this.marginLabels.push(new Marker({ element: el }).setLngLat([l.lon, l.lat]).addTo(this.map))
    }
  }

  /** True while the GPU field draws the bands (the polygons are hidden). */
  get fieldActive(): boolean {
    return this.fieldOn
  }

  async setRoute(route: RouteFC | null): Promise<void> {
    await this.ready
    if (this.destroyed) return
    this.lastRoute = route
    this.selectMap?.refresh()
    ;(this.map.getSource('route') as GeoJSONSource).setData(route ?? EMPTY)
    await this.furniture?.setRoute(route)
  }

  /** Hatched unknown cells from a field alpha (A = 0 unknown), placed on the field-index bounds. */
  async setUnknownMask(mask: { alpha: Uint8ClampedArray; width: number; height: number; bounds: [number, number, number, number] }): Promise<void> {
    await this.ready
    if (this.destroyed || this.map.getSource('unknown')) return
    const [w, s, e, n] = mask.bounds
    this.map.addSource('unknown', {
      type: 'image',
      url: hatchDataUrl(mask.alpha, mask.width, mask.height, THEME.hatch),
      coordinates: [
        [w, n],
        [e, n],
        [e, s],
        [w, s],
      ],
    })
    this.map.addLayer({ id: 'unknown-hatch', type: 'raster', source: 'unknown', paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, 'iso-lines')
    this.applyVisibility()
  }

  /** Station science points (markers), access cells and walk-in lines for one scenario. */
  async setStations(stations: Station[], scenarioId: string): Promise<void> {
    if (this.destroyed) return
    this.stationsScenario = scenarioId
    this.lastStations = { stations, scenarioId }
    this.stationMarkers.forEach((m) => m.remove())
    const labels = this.labels
    this.stationMarkers = stations.flatMap((s) => {
      const a = accessFor(s, scenarioId)
      const el = document.createElement('button')
      el.type = 'button'
      el.className = `station-marker${a.state === 'none' ? ' no-access' : ''}`
      el.dataset.selectStation = s.id // M9: the map selection reads it (select.ts domRef)
      el.textContent = s.id
      const acc =
        a.state === 'access'
          ? `access cell ${a.dist_m} m from the science point`
          : a.state === 'none'
            ? `no access cell within ${a.radius_m ?? '?'} m${a.reason ? ` (${a.reason})` : ''}`
            : 'access cell: no data'
      el.title = `${s.name} (science point; ${acc}): open the station card`
      // U13: the label layer draws this station's pill; the ring stays a map layer (furniture)
      if (labels?.covers(s.id)) {
        labels.bind(s.id, { title: el.title, onActivate: () => this.onStation(s.id) })
        return []
      }
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.onStation(s.id)
      })
      // the ring is a map layer (furniture); this button is its label, to the right of the ring
      return [new Marker({ element: el, anchor: 'left', offset: [12, 0] }).setLngLat([s.lon, s.lat]).addTo(this.map)]
    })
    await this.ready
    if (this.destroyed) return
    this.furniture?.setStations(stations)
    ;(this.map.getSource('walkin') as GeoJSONSource).setData(walkInLines(stations, scenarioId))
    const pts = stations.flatMap((s) => {
      const a = accessFor(s, scenarioId)
      return a.access ? [{ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [a.access.lon, a.access.lat] }, properties: { station: s.id } }] : []
    })
    ;(this.map.getSource('access') as GeoJSONSource).setData({ type: 'FeatureCollection', features: pts })
    this.applyVisibility()
    this.selectMap?.refresh()
  }

  /** F8 siting heatmap (siting.png on siting_png.json corners) and the proposed pad + alternatives. */
  async setSiting(img: { url: string; coordinates: [number, number][] } | null, proposal: { lon: number; lat: number; title: string; alternatives: { rank: number; lon: number; lat: number }[] } | null): Promise<void> {
    if (this.destroyed) return
    this.sitingMarkers.forEach((m) => m.remove())
    this.sitingMarkers = []
    if (proposal) {
      const mk = (cls: string, text: string, title: string, lon: number, lat: number) => {
        const el = document.createElement('div')
        el.className = cls
        el.textContent = text
        el.title = title
        this.sitingMarkers.push(new Marker({ element: el }).setLngLat([lon, lat]).addTo(this.map))
      }
      mk('pad-marker pad-proposal', 'Pad?', proposal.title, proposal.lon, proposal.lat)
      for (const a of proposal.alternatives) mk('pad-alt', `#${a.rank}`, `Siting alternative rank ${a.rank} (pad.json): same rule, not adopted`, a.lon, a.lat)
    }
    await this.ready
    if (this.destroyed) return
    if (img && !this.map.getSource('siting')) {
      const c = img.coordinates as [[number, number], [number, number], [number, number], [number, number]]
      this.map.addSource('siting', { type: 'image', url: img.url, coordinates: c })
      this.map.addLayer({ id: 'siting-img', type: 'raster', source: 'siting', paint: { 'raster-opacity': THEME.sitingOpacity, 'raster-fade-duration': 0 } }, 'iso-lines')
    }
    this.applyVisibility()
  }

  setPad(p: { lon: number; lat: number; label: string; title: string }): void {
    if (this.destroyed) return
    this.lastPad = p
    this.padMarker?.remove()
    const el = document.createElement('div')
    el.className = 'pad-marker'
    el.dataset.selectPad = 'rank1'
    el.textContent = p.label
    el.title = p.title
    if (this.labels?.covers('PAD')) {
      // U13: the PAD pill carries the text; the marker stays as the pad's point graphic
      el.classList.add('hl-label-covered')
      el.textContent = ''
      this.labels.bind('PAD', { title: p.title })
    }
    this.padMarker = new Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(this.map)
    this.rover?.attach(this.padMarker)
    this.applyVisibility()
  }

  /** D21 parking options (scenarios/pads/index.json, official pad excluded): small markers, the selected one highlighted; click selects. */
  setPadOptions(opts: { id: string; lon: number; lat: number; label: string; title: string; selected: boolean }[], onPick: (id: string) => void): void {
    if (this.destroyed) return
    this.lastPadOptions = [opts, onPick]
    this.padOptionMarkers.forEach((m) => m.remove())
    this.padOptionMarkers = opts.map((o) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = `pad-option${o.selected ? ' on' : ''}`
      el.dataset.selectPad = o.id
      el.textContent = o.label
      el.title = o.title
      const code = this.labels?.codeForRef(o.id)
      if (code) {
        // U13: the P2-P5 pill carries the text (and selects too); the button stays as the point graphic
        el.classList.add('hl-label-covered')
        el.textContent = ''
        this.labels!.bind(code, { title: o.title, onActivate: () => onPick(o.id) })
        // X3 (e2e H5-3): the square sits exactly on the pad spot; a mouse click there goes through to
        // the map (live pad tool, map selection). The pill selects; keyboard focus + Enter still works.
        el.style.pointerEvents = 'none'
      }
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        onPick(o.id)
      })
      return new Marker({ element: el }).setLngLat([o.lon, o.lat]).addTo(this.map)
    })
    this.applyVisibility()
  }

  fitTo(points: { lon: number; lat: number }[]): void {
    if (this.destroyed) return
    const f = CONFIG.aoiFocus
    const b = new LngLatBounds([f.west, f.south], [f.east, f.north])
    for (const p of points) b.extend([p.lon, p.lat])
    this.map.fitBounds(b, { padding: 50, duration: 0 })
  }

  setBudget(minutes: number): void {
    this.budget = minutes
    this.fieldLayer?.update({ budget: minutes })
    if (this.headline && this.fieldScenario) {
      const sid = this.fieldScenario
      void data()
        .optional(() => data().manifest())
        .then((m) => !this.destroyed && this.budget === minutes && this.headline?.setHeadline(m ? collapseHeadline(m as unknown as Record<string, unknown>, sid, minutes) : null))
    }
    this.applyFilters()
    this.renderEdgeLabels()
  }

  setSliderMinutes(minutes: number): void {
    this.sliderMin = minutes
    this.applyFilters()
  }

  setVisible(group: LayerGroup, on: boolean): void {
    this.visible[group] = on
    if (group === 'route') this.furniture?.setRouteVisible(on)
    this.applyVisibility()
  }

  private applyFilters(): void {
    const m = this.map
    if (!m.getLayer('band-opt')) return
    const b = this.budget
    const f = (expr: unknown) => expr as FilterSpecification
    m.setFilter('band-opt', f(['all', ['==', ['get', 'budget'], b], ['==', ['get', 'variant'], 'optimistic']]))
    m.setFilter('band-con', f(['all', ['==', ['get', 'budget'], b], ['==', ['get', 'variant'], 'conservative']]))
    m.setFilter('band-lines', f(['==', ['get', 'budget'], b]))
    m.setPaintProperty('band-lines', 'line-width', ['case', ['==', ['get', 'variant'], this.variant], THEME.bandLineWidth.selected, THEME.bandLineWidth.other] as ExpressionSpecification)
    m.setFilter('edges-line', f(['==', ['get', 'budget'], b]))
    // F5: the slider is a MapLibre filter on `minutes`; no recomputation.
    const v = this.sliderMin
    m.setFilter('iso-fill', f(['==', ['get', 'minutes'], v]))
    m.setFilter('iso-lines', f(['all', ['<', ['get', 'minutes'], v], ['==', ['%', ['get', 'minutes'], THEME.isoBinStepMin], 0]]))
    m.setFilter('iso-current', f(['==', ['get', 'minutes'], v]))
  }

  private applyVisibility(): void {
    const m = this.map
    for (const [g, ids] of Object.entries(this.groupLayers) as [LayerGroup, string[]][]) {
      const on = this.visible[g] && !(g === 'edges' && this.collapseHidesEdges)
      for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
    }
    for (const mk of this.stationMarkers) mk.getElement().hidden = !this.visible.stations
    if (this.padMarker) this.padMarker.getElement().hidden = !this.visible.stations
    for (const mk of this.padOptionMarkers) mk.getElement().hidden = !this.visible.stations
    this.labels?.setGroupVisible(this.visible.stations)
    for (const mk of this.sitingMarkers) mk.getElement().hidden = !this.visible.siting
    for (const mk of this.edgeMarkers) mk.getElement().hidden = !this.visible.edges || this.collapseHidesEdges
    // GPU field: replaces the polygon bands (and the hatch image when it has the cell states).
    const fl = this.fieldLayer
    if (fl && m.getLayer(fl.id)) {
      const hatch = this.fieldOn && !!this.fieldData?.state
      const showBands = this.fieldOn && this.visible.bands
      const showHatch = hatch && this.visible.unknown
      if (this.fieldOn) for (const id of POLYGON_BAND_LAYERS) if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', 'none')
      if (hatch && m.getLayer('unknown-hatch')) m.setLayoutProperty('unknown-hatch', 'visibility', 'none')
      fl.update({ showBands, showHatch })
      m.setLayoutProperty(fl.id, 'visibility', showBands || showHatch ? 'visible' : 'none')
    }
  }

  private renderEdgeLabels(): void {
    this.edgeMarkers.forEach((m) => m.remove())
    this.edgeMarkers = []
    if (!this.edges) return
    const minSepDeg = THEME.edgeLabelMinSepM / ((CONFIG.marsRadiusM * Math.PI) / 180)
    for (const p of edgeLabelPoints(this.edges, this.budget, THEME.maxEdgeLabelsPerFeature, { maxTotal: THEME.maxEdgeLabels, minSepDeg })) {
      const el = document.createElement('div')
      el.className = `edge-label edge-${p.cause}`
      el.textContent = THEME.causeLabel[p.cause] ?? p.cause
      el.title = `Edge set by ${THEME.causeLabel[p.cause]}: ${THEME.causeHelp[p.cause]}`
      this.edgeMarkers.push(new Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(this.map))
    }
    this.applyVisibility()
  }

  destroy(): void {
    this.destroyed = true
    this.stopStory?.()
    this.stopStorm?.()
    this.camera?.destroy()
    this.stopOverlays?.()
    this.selectMap?.destroy()
    this.terrain?.destroy()
    this.labels?.destroy()
    this.destroyed = true
    this.rover?.destroy()
    this.input.destroy()
    this.furniture?.destroy()
    this.stopCollapse?.()
    this.headline?.destroy()
    this.stopMargin?.()
    clearTimeout(this.marginLabelTimer)
    this.fieldSeq++
    if (this.fieldData && activeField() === this.fieldData) setActiveField(null)
    this.map.remove()
  }
}

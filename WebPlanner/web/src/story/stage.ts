// WS16 task 10 (M10): puts a director state on the planning map (DESIGN U6, §6.3). Everything it
// touches is saved first and put back by restore(): camera, 2D/3D, layer groups, field mode, collapse,
// clock, selection. Captions come from the copy deck only; the one placeholder ({walkback_min}) is the
// plan's walkback budget (crew.yaml walkback_budgets_min via the mission state).
import type { Map as MlMap } from 'maplibre-gl'
import { CONFIG } from '../config'
import type { ConsoleMap, LayerGroup } from '../map/consoleMap'
import { resetCollapse, setCollapse } from '../map/field/collapse'
import { jumpToPose } from '../map/flythrough/camera'
import { setSelectedLabel, selectedLabel } from '../map/labels/layer'
import { setFpsWatchSuspended } from '../map/terrain/fps'
import { exaggeration, setView } from '../map/terrain/state'
import { mission, missionClock, ui } from '../state'
import { t, type CopyKey } from '../ui/copy'
import { CAMERA_MS, ELEVATION_FACTOR, PANEL_MS } from './config'
import { addReliefLow, removeReliefLow, setReliefLowVisible } from './descent'
import type { DirectorState } from './director'
import './story.css'

/** Storyboard layer id -> console layer groups. terrain and relief_low are handled apart. */
const GROUPS: Record<string, LayerGroup[]> = {
  homeline: ['bands'],
  unknown: ['unknown'],
  edges: ['edges'],
  stations: ['stations'],
  route: ['route'],
  basemap: ['basemap'],
}

/** DESIGN §3.4 camera move 1.2–2.5 s (tokens motion.cameraMs): the longest, for the way home. */
const CAMERA_RETURN_MS = CAMERA_MS[1]

export type ChromePolicy = 'story' | 'hidden' | 'shown'

export class StoryStage {
  readonly map: MlMap
  private readonly cmap: ConsoleMap
  private readonly caption: HTMLDivElement
  private readonly saved: {
    center: [number, number]
    zoom: number
    bearing: number
    pitch: number
    view: '2d' | '3d'
    groups: Partial<Record<LayerGroup, boolean>>
    fieldMode: typeof ui.fieldMode.value
    collapseK: number | undefined
    clockT: number
    playing: boolean
    selection: string | null
  }
  private readonly chrome: ChromePolicy
  private relief: Promise<boolean> | null = null
  private touchedSelection = false
  private touchedCollapse = false
  private last: { caption?: string | null; view?: '2d' | '3d'; layers: Record<string, boolean>; clockT?: number; playing?: boolean; mode?: string; k?: number; opacity?: string; chrome?: string } = { layers: {} }
  /** M10c: a live story pauses the label placement (4 Hz) and the furniture loops until restore() */
  private readonly paused: boolean
  private cover: HTMLDivElement | null = null
  /** the chrome state the storyboard asks for (written to <html> by writeChrome) */
  private chromeWant: 'hide' | 'show' = 'show'

  constructor(cmap: ConsoleMap, chrome: ChromePolicy) {
    this.cmap = cmap
    this.map = cmap.map
    this.chrome = chrome
    const c = this.map.getCenter()
    const groups: Partial<Record<LayerGroup, boolean>> = {}
    for (const gs of Object.values(GROUPS)) for (const g of gs) groups[g] = cmap.layerVisible(g)
    this.saved = {
      center: [c.lng, c.lat],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
      view: ui.view.peek(),
      groups,
      fieldMode: ui.fieldMode.peek(),
      collapseK: ui.collapseK.peek(),
      clockT: missionClock.t,
      playing: missionClock.playing,
      selection: selectedLabel(),
    }
    this.caption = document.createElement('div')
    this.caption.className = 'hl-story-caption'
    this.caption.setAttribute('role', 'status')
    this.caption.setAttribute('aria-live', 'polite')
    this.map.getContainer().append(this.caption)
    document.documentElement.dataset.story = 'on'
    this.setChrome(chrome === 'shown' ? 'reveal' : chrome === 'hidden' ? 'hide' : undefined)
    // live runs only: a capture places the labels on every frame (frame-exact)
    this.paused = chrome === 'story'
    if (this.paused) cmap.setStoryPaused(true)
    // M10d: every story (live and capture) suspends the 3D fps fallback until restore()
    setFpsWatchSuspended(true)
  }

  private setChrome(v: 'hide' | 'reveal' | undefined): void {
    const hide = this.chrome === 'hidden' ? v !== 'reveal' : this.chrome === 'story' ? v === 'hide' : false
    this.chromeWant = hide ? 'hide' : 'show'
    this.writeChrome()
  }

  /**
   * html[data-story-chrome] = the chrome state of the story that is playing. M10d: not written while the
   * warm-up cover is up (html[data-story-warm] hides the chrome then, story.css), only when the clock
   * starts. 'hide' therefore means the intro is playing, not that the page is still linking programs
   * and decoding the field under the cover (long main-thread tasks in software GL).
   */
  private writeChrome(): void {
    if (this.cover) return
    // only on change: an attribute write on <html> restyles the whole page
    if (this.chromeWant === this.last.chrome) return
    this.last.chrome = this.chromeWant
    document.documentElement.dataset.storyChrome = this.chromeWant
  }

  /** M10c warm-up: hide the map canvas and its markers while layers and tiles load out of sight. */
  setCanvasHidden(on: boolean): void {
    // a cover, not visibility: hidden: a hidden WebGL canvas defers its frames and the first visible
    // frame then stalls (measured 17 s in software GL, notes/M10c.md)
    if (on && !this.cover) {
      this.cover = document.createElement('div')
      this.cover.className = 'hl-story-cover'
      this.map.getContainer().append(this.cover)
    }
    if (!on) {
      this.cover?.remove()
      this.cover = null
    }
    // html[data-story-warm]: the story has not started its clock yet (tests, measurements)
    if (on) document.documentElement.dataset.storyWarm = 'on'
    else delete document.documentElement.dataset.storyWarm
    if (!on) this.writeChrome() // M10d: the chrome state of frame 0 lands with t = 0
  }

  /** True when the relief backdrop the state asks for is still loading (capture waits for it). */
  get pending(): Promise<unknown> {
    return this.relief ?? Promise.resolve()
  }

  apply(s: DirectorState): void {
    this.applyLayers(s.layers)
    // field
    if (s.field.mode && s.field.mode !== this.last.mode) ui.fieldMode.value = this.last.mode = s.field.mode
    const c = s.field.collapse
    if (c) {
      // the stage sets k each frame (M4: setCollapse per frame for frame-exact capture). A reduced-motion
      // cross-fade has no public setter for the fade pair, so it lands as a cut on the end picture.
      const k = c.xfade < 1 ? c.kFrom : c.k
      if (k !== this.last.k) setCollapse((this.last.k = k))
      this.touchedCollapse = true
    }
    // clock
    if (s.clock) {
      if (s.clock.tMin !== this.last.clockT) missionClock.seek((this.last.clockT = s.clock.tMin))
      if (s.clock.playing !== this.last.playing) {
        this.last.playing = s.clock.playing
        if (s.clock.playing) mission.clock.playing.value = true
        else missionClock.pause()
      }
    }
    // selection
    if (s.selection !== undefined && s.selection !== selectedLabel()) {
      setSelectedLabel(s.selection)
      this.touchedSelection = true
    }
    // caption (copy key) with a fade-in over the panel time
    if (s.caption !== this.last.caption) {
      this.last.caption = s.caption
      this.caption.textContent = s.caption ? t(s.caption as CopyKey, { walkback_min: mission.plan.budgetMin.peek() }) : ''
      this.caption.hidden = !s.caption
    }
    const opacity = String(Math.min(1, (s.captionAge * 1000) / PANEL_MS[1]))
    if (opacity !== this.last.opacity) this.caption.style.opacity = this.last.opacity = opacity
    this.setChrome(s.ui)
    // camera last: after a 2D/3D switch the pitch limit has moved
    if (s.camera) jumpToPose(this.map, s.camera, { factor: ELEVATION_FACTOR, exaggeration: exaggeration(), radiusM: CONFIG.marsRadiusM })
  }

  /** Storyboard layers on/off (only changes, so the console's own toggles are not fought every frame). */
  applyLayers(layers: Record<string, boolean>): void {
    for (const [id, on] of Object.entries(layers)) {
      if (this.last.layers[id] === on) continue
      this.last.layers[id] = on
      if (id === 'terrain') setView(on ? '3d' : '2d')
      else if (id === 'relief_low') {
        if (on) this.relief ??= addReliefLow(this.map).catch(() => false)
        void this.relief?.then(() => setReliefLowVisible(this.map, on))
      } else for (const g of GROUPS[id] ?? []) this.cmap.setVisible(g, on)
    }
  }

  /** Put the app back as it was; `animate` eases the camera home (never under reduced motion). */
  restore(animate: boolean): void {
    const sv = this.saved
    this.caption.remove()
    this.setCanvasHidden(false)
    if (this.paused) this.cmap.setStoryPaused(false)
    setFpsWatchSuspended(false) // M10d: the watch resumes with a fresh window
    if (this.last.layers.terrain !== undefined) setView(sv.view)
    if (this.relief) removeReliefLow(this.map)
    for (const [g, on] of Object.entries(sv.groups) as [LayerGroup, boolean][]) if (this.cmap.layerVisible(g) !== on) this.cmap.setVisible(g, on)
    ui.fieldMode.value = sv.fieldMode
    // the collapse ends on the real homeline with its headline (as after the Flat vs real toggle)
    if (this.touchedCollapse && sv.collapseK === undefined && (ui.collapseK.peek() ?? 1) < 1) resetCollapse()
    missionClock.seek(sv.clockT)
    if (!sv.playing) missionClock.pause()
    if (this.touchedSelection) setSelectedLabel(sv.selection)
    delete document.documentElement.dataset.story
    delete document.documentElement.dataset.storyChrome
    const cam = { center: sv.center, zoom: sv.zoom, bearing: sv.bearing, pitch: sv.pitch }
    if (animate && !ui.reducedMotion.peek()) this.map.easeTo({ ...cam, duration: CAMERA_RETURN_MS })
    else this.map.jumpTo(cam)
  }
}

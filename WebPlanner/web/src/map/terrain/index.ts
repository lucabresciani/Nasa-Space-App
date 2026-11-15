// WS16 task 8 (M8): U1 wiring on the planning map — small and GL-free; the 3D code (terrain.ts) loads
// with import() the first time 3D is turned on, and so do terrain/tiles.json and the tiles.
//
//   ui.view '3d'   -> terrain + relief shading, tilt and rotation unlocked, camera to the 3D pitch
//   ui.view '2d'   -> terrain off, pitch 0, maxPitch 0, rotation locked; relief shading stays once loaded
//   no WebGL2 / below 30 fps for 3 s in 3D -> flat with relief shading + one-line notice, ui.view '2d'
//   ui.exaggeration -> setTerrain exaggeration (1 = true shape: the 1.878 factor is in the tiles)
//   mission clock  -> relief light = sun azimuth at the whole simulated minute (conditions/clock.json)
//   ui.reducedMotion -> no camera animation
import type { Map as MlMap } from 'maplibre-gl'
import { DATA_MODE, dataUrl } from '../../env'
import { data } from '../../data/loader'
import { parseClockSun, type ClockFile, type SunData } from '../../hud/sun'
import { effect, mission, ui } from '../../state'
import { COPY_PENDING, t } from './config'
import { TerrainControl, TerrainNotice, TERRAIN_TRUST } from './controls'
import { FpsWatch } from './fps'
import { exaggeration, reliefAzimuth, reliefMinute } from './state'
import { parseTerrainTiles, type TerrainTiles } from './tiles'
import type { TerrainHandle } from './terrain'

export { TerrainControl, TERRAIN_TRUST } from './controls'
export { clampExaggeration, exaggeration, setExaggeration, setView, toggleView } from './state'

export type TerrainState = 'off' | 'loading' | '3d' | 'flat' | 'unavailable'

/** Field layer handle shape this module drapes (field/layer.ts FieldLayerHandle). */
interface FieldLike {
  readonly id: string
  update(p: never): void
  setData(fd: never): void
}

function webgl2(): boolean {
  try {
    return typeof document !== 'undefined' && !!document.createElement('canvas').getContext('webgl2')
  } catch {
    return false
  }
}

export class TerrainController {
  private readonly control = new TerrainControl()
  private readonly notice: TerrainNotice
  private readonly fps = new FpsWatch()
  private readonly stops: (() => void)[] = []
  private handle: TerrainHandle | null = null
  private loading: Promise<TerrainHandle | null> | null = null
  private tiles: TerrainTiles | null = null
  private sun: SunData | null = null
  private sunRequested = false
  private lightMinute: number | null = null
  private field: FieldLike | null = null
  private state: TerrainState = 'off'
  private seq = 0

  private readonly map: MlMap
  /** layer the relief shading sits under (it goes above the basemap) */
  private readonly beforeId: string

  constructor(map: MlMap, beforeId: string) {
    this.map = map
    this.beforeId = beforeId
    map.addControl(this.control, 'top-left')
    this.notice = new TerrainNotice(map.getContainer())
    this.setState('off')
    this.stops.push(
      effect(() => {
        const v = ui.view.value
        void this.apply(v)
      }),
      effect(() => {
        const x = exaggeration()
        this.handle?.setExaggeration(x)
        map.getContainer().setAttribute('data-terrain-exaggeration', String(x))
      }),
      effect(() => {
        const m = reliefMinute(mission.clock.t.value)
        if (m !== this.lightMinute) {
          this.lightMinute = m
          this.applyLight()
        }
      }),
    )
    map.on('render', this.onRender)
  }

  /** The field layer to drape while 3D is on (null when the polygons are shown). */
  attachField(h: FieldLike | null): void {
    if (h && h !== this.field) {
      // redraw the draped tiles whenever the field changes (terrainTileRevision)
      const bump = (): void => {
        if (this.state === '3d') void import('./terrain').then((m) => m.bumpDrape(this.map, h.id))
      }
      const upd = h.update.bind(h)
      const set = h.setData.bind(h)
      ;(h as { update: (p: never) => void }).update = (p) => {
        upd(p)
        bump()
      }
      ;(h as { setData: (fd: never) => void }).setData = (fd) => {
        set(fd)
        bump()
      }
    }
    this.field = h
    if (h) this.handle?.drapeField(h.id)
  }

  private setState(s: TerrainState): void {
    this.state = s
    const c = this.map.getContainer()
    c.setAttribute('data-terrain', s)
    if (s === 'off' || s === 'unavailable') return
    // trust-chip hook on the terrain layer group: measured DEM, the factor in the tiles noted
    c.setAttribute('data-trust-terrain', TERRAIN_TRUST.chip)
    c.setAttribute('data-trust-terrain-source', TERRAIN_TRUST.source)
    if (this.tiles) c.setAttribute('data-trust-terrain-factor', String(this.tiles.factor))
  }

  private async load(): Promise<TerrainHandle | null> {
    this.loading ??= (async () => {
      const res = await fetch(dataUrl('terrain/tiles.json', DATA_MODE))
      if (!res.ok) return null
      const ct = res.headers.get('content-type') ?? ''
      if (ct && !ct.includes('json')) return null // dev server SPA fallback
      this.tiles = parseTerrainTiles(await res.json())
      const mod = await import('./terrain')
      this.handle = mod.addTerrain(this.map, this.tiles, (p) => dataUrl(p, DATA_MODE), this.beforeId, { exaggeration: exaggeration(), azimuth: this.azimuth() })
      if (this.field) this.handle.drapeField(this.field.id)
      this.requestSun()
      return this.handle
    })().catch((e) => {
      console.warn('3D terrain unavailable:', e)
      return null
    })
    return this.loading
  }

  private async apply(v: '2d' | '3d'): Promise<void> {
    const seq = ++this.seq
    const animate = !ui.reducedMotion.peek()
    if (v === '2d') {
      if (this.state === '3d') {
        this.handle?.setTerrainOn(false, { animate })
        this.setState('flat')
      }
      if (this.state === 'loading') this.setState(this.handle ? 'flat' : 'off')
      return
    }
    // 3D asked for: a fresh try (a previous slow-fps fallback is forgotten)
    this.fps.rearm()
    this.notice.show(null)
    if (!webgl2()) return this.fallback('webgl')
    this.setState('loading')
    this.notice.show(t('states.loading.terrain3d'))
    const h = await this.load()
    if (seq !== this.seq) return
    this.notice.show(null)
    if (!h) {
      this.control.setUnavailable(COPY_PENDING.noTiles)
      this.setState('unavailable')
      this.notice.show(COPY_PENDING.noTiles)
      ui.view.value = '2d'
      return
    }
    h.setTerrainOn(true, { animate })
    this.setState('3d')
  }

  /** Flat map with relief shading and a one-line notice (DESIGN U1 item 6). */
  private async fallback(why: 'webgl' | 'slow3d'): Promise<void> {
    this.handle?.setTerrainOn(false, { animate: false })
    this.setState('flat')
    this.notice.show(t(why === 'webgl' ? 'states.error.webgl' : 'states.error.slow3d'))
    this.map.getContainer().setAttribute('data-terrain-fallback', why)
    // the toggle shows 2D; apply('2d') finds the state flat and does nothing more
    if (ui.view.peek() !== '2d') ui.view.value = '2d'
    if (!this.handle && !(await this.load())) this.setState('unavailable')
  }

  private readonly onRender = (): void => {
    if (this.state !== '3d') return
    if (this.fps.frame(performance.now()) === 'tripped') void this.fallback('slow3d')
  }

  private azimuth(): number | null {
    return reliefAzimuth(this.sun, mission.clock.t.peek())
  }

  private applyLight(): void {
    this.handle?.setLightAzimuth(this.azimuth())
    const az = this.azimuth()
    this.map.getContainer().setAttribute('data-terrain-light-az', az === null ? 'default' : az.toFixed(1))
  }

  private requestSun(): void {
    if (this.sunRequested) return
    this.sunRequested = true
    void data()
      .optional(() => data().clock())
      .then((c) => {
        this.sun = c ? parseClockSun(c as unknown as ClockFile) : null
        this.applyLight()
      })
      .catch(() => undefined)
  }

  destroy(): void {
    for (const s of this.stops) s()
    this.map.off('render', this.onRender)
    this.notice.destroy()
    this.map.removeControl(this.control)
    this.handle?.remove()
  }
}

// T1 (team lead request, Sun 10:25): 3D exaggeration default 1.0 from config/design.yaml (no copy in
// the code), the storyboard / flythrough cameras keep clear of the terrain at 1.0, and the T shortcut
// toggles 2D/3D exactly like the 2D/3D buttons (not while typing; reduced motion = no camera animation).
// Written before the implementation. CPU only: the 3D picture itself is RR (notes/T1.md).
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Map as MlMap } from 'maplibre-gl'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Plan } from '../../hud/plan'
import { REPO } from '../../hud/testutil'
import { ELEVATION_FACTOR, FLYTHROUGH } from '../../story/config'
import { Director, type DirectorOptions } from '../../story/director'
import { parseStoryboard } from '../../story/storyboard'
import { CONFIG } from '../../config'
import { ui } from '../../state'
import { t } from '../../ui/copy'
import { commandItems } from '../../ui/search/search'
import { HELP_ROWS, installShortcuts } from '../../ui/shell/keys'
import { byTag, installDom, type FakeDocument, type FakeNode } from '../../ui/testing/dom'
import { PRESETS } from '../camera/config'
import { jumpToPose } from '../flythrough/camera'
import type { CameraPose } from '../flythrough/path'
import { flightPath, gridMetric } from '../flythrough/route'
import { TERRAIN } from './config'
import { TerrainControl } from './controls'
import { TerrainController } from './index'
import { exaggeration, setView } from './state'
import { addTerrain } from './terrain'
import { groundSampler, HAVE_TERRAIN } from './testutil'

const design = parse(readFileSync(resolve(REPO, 'config/design.yaml'), 'utf8')) as { exaggeration: { min: number; max: number; default: number; step: number } }

// ---- 1. default exaggeration = config value ----------------------------------------------------------
describe('T1: default exaggeration is config/design.yaml exaggeration.default (1.0), read, not copied', () => {
  beforeEach(() => {
    ui.view.value = '2d'
    ui.exaggeration.value = undefined
  })
  it('TERRAIN reads design.yaml: default 1.0 (true scale), range and step', () => {
    expect(design.exaggeration.default).toBe(1)
    expect(TERRAIN.exaggeration).toEqual({ min: design.exaggeration.min, max: design.exaggeration.max, default: design.exaggeration.default })
    expect(exaggeration()).toBe(1)
    setView('3d')
    expect(ui.exaggeration.value).toBe(1)
  })
  it('config.ts holds no number of its own: every TERRAIN value is a cfg() read of design.yaml', () => {
    const src = readFileSync(resolve(REPO, 'web/src/map/terrain/config.ts'), 'utf8')
    expect(src).toMatch(/import designRaw from '..\/..\/..\/..\/config\/design.yaml'/)
    expect(src).toMatch(/cfg<number>\(designRaw, 'exaggeration.default'\)/)
    // no literal default / factor / pitch typed in (the M8 verbatim copy is gone)
    expect(src).not.toMatch(/default:\s*\d/)
    expect(src).not.toMatch(/1\.878/)
    expect(src).not.toMatch(/COPY\s*=/)
    // and the ui store has no hard-coded default either (undefined until something sets it)
    const uiSrc = readFileSync(resolve(REPO, 'web/src/state/ui.ts'), 'utf8')
    expect(uiSrc).toMatch(/exaggeration: signal<number \| undefined>\(undefined\)/)
  })
  it('the slider (user control) is kept and starts at 1.0, labelled "1.0×"', () => {
    const { container } = installDom()
    const box = new TerrainControl().onAdd() as unknown as FakeNode
    container.appendChild(box)
    const input = byTag(box, 'input')[0] as unknown as { value: string; min: string; max: string; step: string }
    const out = byTag(box, 'output')[0] as unknown as { value: string }
    expect(input.value).toBe('1')
    expect(out.value).toBe('1.0×')
    expect([input.min, input.max, input.step]).toEqual(['1', '3', '0.1'])
  })
})

// ---- 2. cameras keep clear of the terrain at 1.0 -------------------------------------------------------
/** Minimum camera height above the ground under it (true metres) at exaggeration 1.0. */
const MIN_CLEAR_M = 30

function realOptions(): DirectorOptions & { tEnd: number; fp: ReturnType<typeof flightPath> } {
  const DATA = resolve(REPO, 'web/public/data')
  const rd = (p: string) => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'))
  const labels = rd('labels.json').labels as { code: string; lon: number; lat: number }[]
  const metric = gridMetric(rd('fields/index.json'))
  const plan = new Plan(rd('route_nom_104.geojson'), rd('timeline_nom_104.json'), metric)
  const fp = flightPath(plan, metric, 'nom_104')
  return {
    targets: (c) => {
      const l = labels.find((x) => x.code === c)
      return l ? [l.lon, l.lat] : null
    },
    follow: (tm) => fp.poseAt(tm),
    tMax: 360,
    reduced: false,
    tEnd: plan.tEnd,
    fp,
  }
}

describe.skipIf(!HAVE_TERRAIN)('T1: camera clearance over the published terrain at exaggeration 1.0', () => {
  const { trueM } = groundSampler(15)
  /**
   * Run the app's own jumpToPose (flythrough/camera.ts) on a map stub with terrain on: the ground is the
   * tile height × exaggeration (as MapLibre's queryTerrainElevation returns it). Returns the camera's
   * height above the ground under it and the lowest gap between the sight line and the terrain, in true
   * metres; null when the camera or the target is outside the published tiles.
   */
  function clearance(pose: CameraPose, x: number): { cam: number; sight: number } | null {
    type Call = { from: { lng: number; lat: number }; alt: number; to: { lng: number; lat: number }; ground: number }
    const seen: Call[] = []
    const map = {
      getTerrain: () => ({ source: 'terrain-dem', exaggeration: x }),
      queryTerrainElevation: (ll: { lng: number; lat: number }) => {
        const g = trueM(ll.lng, ll.lat)
        return g === null ? null : g * ELEVATION_FACTOR * x
      },
      calculateCameraOptionsFromTo: (from: { lng: number; lat: number }, alt: number, to: { lng: number; lat: number }, ground: number) => {
        seen.push({ from, alt, to, ground })
        return { zoom: 15 }
      },
      getMaxPitch: () => TERRAIN.maxPitch3d,
      jumpTo: () => undefined,
    } as unknown as MlMap
    jumpToPose(map, pose, { factor: ELEVATION_FACTOR, exaggeration: x, radiusM: CONFIG.marsRadiusM })
    const g = seen[0]
    const gc = trueM(g.from.lng, g.from.lat)
    const gt = trueM(g.to.lng, g.to.lat)
    if (gc === null || gt === null) return null
    const k = ELEVATION_FACTOR * x // map metres per true metre, vertically
    const camAlt = g.alt / k
    let sight = Infinity
    for (let i = 1; i <= 36; i++) {
      const u = i / 40 // camera (0) -> target (1); the last 10 % (25 m of the 250 m follow arm) is the target's own ground
      const lon = g.from.lng + (g.to.lng - g.from.lng) * u
      const lat = g.from.lat + (g.to.lat - g.from.lat) * u
      const gu = trueM(lon, lat)
      if (gu !== null) sight = Math.min(sight, camAlt + (gt - camAlt) * u - gu)
    }
    return { cam: camAlt - gc, sight }
  }

  it('flythrough follow camera (U6, every 0.25 EVA min of nom_104): >= 30 m above the ground, clear line of sight', () => {
    const o = realOptions()
    let n = 0
    let worstCam = Infinity
    let worstSight = Infinity
    for (let tm = 0; tm <= o.tEnd; tm += 0.25) {
      const c = clearance(o.fp.poseAt(tm), 1)
      if (!c) continue
      n++
      worstCam = Math.min(worstCam, c.cam)
      worstSight = Math.min(worstSight, c.sight)
    }
    expect(n).toBeGreaterThan(400)
    if (process.env.T1_REPORT) console.log(`flythrough follow: ${n} poses, min camera clearance ${worstCam.toFixed(1)} m, min sight-line gap ${worstSight.toFixed(1)} m`)
    expect(worstCam).toBeGreaterThanOrEqual(MIN_CLEAR_M)
    expect(worstSight).toBeGreaterThan(0)
  })

  for (const id of ['flythrough', 'video_beat1', 'intro', 'kiosk', 'storm']) {
    it(`${id}.json camera keyframes and the eased frames between them clear the terrain at 1.0`, () => {
      const sb = parseStoryboard(JSON.parse(readFileSync(resolve(REPO, `web/public/story/${id}.json`), 'utf8')), id)
      const d = new Director(sb, realOptions())
      let worstCam = Infinity
      let worstSight = Infinity
      for (let s = 0; s <= d.duration; s += 0.25) {
        const pose = d.stateAt(s).camera
        if (!pose) continue
        const c = clearance(pose, 1)
        if (!c) continue // camera or target outside the published terrain (high descent frames: relief only)
        worstCam = Math.min(worstCam, c.cam)
        worstSight = Math.min(worstSight, c.sight)
      }
      if (process.env.T1_REPORT) console.log(`${id}: min camera clearance ${worstCam.toFixed(1)} m, min sight-line gap ${worstSight.toFixed(1)} m`)
      if (worstCam < Infinity) {
        expect(worstCam).toBeGreaterThanOrEqual(MIN_CLEAR_M)
        expect(worstSight).toBeGreaterThan(0)
      }
    })
  }

  it('camera heights scale with the exaggeration (camera.ts), so clearance at 3× = 3 × clearance at 1×: nothing new clips', () => {
    const o = realOptions()
    for (const tm of [10, 40, 90, 150]) {
      const a = clearance(o.fp.poseAt(tm), 1)!
      const b = clearance(o.fp.poseAt(tm), 3)!
      expect(b.cam).toBeCloseTo(a.cam, 6) // true metres: the same; on screen ×3 (map metres)
    }
  })
})

// ---- 2b. pitch cap (orchestrator add-on): MapLibre 6.18 draws no tiles above ~60° at the pad --------
describe('T1: no camera pose exceeds the 3D pitch cap (terrain_3d.max_pitch_deg)', () => {
  const cap = TERRAIN.maxPitch3d
  it('the cap is design.yaml terrain_3d.max_pitch_deg = 60 (above it MapLibre selects zero tiles)', () => {
    const d = parse(readFileSync(resolve(REPO, 'config/design.yaml'), 'utf8')) as { terrain_3d: { max_pitch_deg: number; assumed: string[] } }
    expect(cap).toBe(d.terrain_3d.max_pitch_deg)
    expect(cap).toBeLessThanOrEqual(60)
    expect(d.terrain_3d.assumed).toContain('max_pitch_deg')
  })
  it('camera presets 1-3 (U16) stay at or under the cap', () => {
    for (const p of [PRESETS.overhead.pitch, PRESETS.isometric.pitch, PRESETS.low.pitch, TERRAIN.pitch3d]) expect(p).toBeLessThanOrEqual(cap)
  })
  it('the flythrough follow camera is 175 m above (55°), never over the cap', () => {
    expect(FLYTHROUGH.aboveM).toBe(175)
    const o = realOptions()
    let worst = 0
    for (let tm = 0; tm <= o.tEnd + 30; tm += 0.25) worst = Math.max(worst, o.fp.poseAt(tm).pitch)
    expect(worst).toBeCloseTo((Math.atan2(FLYTHROUGH.behindM, FLYTHROUGH.aboveM) * 180) / Math.PI, 6)
    expect(worst).toBeLessThanOrEqual(55.1)
  })
  for (const id of ['flythrough', 'video_beat1', 'intro', 'kiosk', 'storm']) {
    it(`${id}.json: every frame's camera pitch <= the cap`, () => {
      const sb = parseStoryboard(JSON.parse(readFileSync(resolve(REPO, `web/public/story/${id}.json`), 'utf8')), id)
      const d = new Director(sb, realOptions())
      let worst = 0
      for (let s = 0; s <= d.duration; s += 0.25) worst = Math.max(worst, d.stateAt(s).camera?.pitch ?? 0)
      expect(worst).toBeLessThanOrEqual(cap)
    })
  }
})

// ---- 3. T toggles 2D/3D like the button ---------------------------------------------------------------
/** A keydown the window listener sees with a chosen target (node has Event but no KeyboardEvent). */
class KeyEv extends Event {
  readonly key: string
  readonly isComposing = false
  private readonly tgt: unknown
  constructor(key: string, target: unknown) {
    super('keydown', { cancelable: true })
    this.key = key
    this.tgt = target
  }
  override get target(): EventTarget | null {
    return this.tgt as EventTarget
  }
}

describe('T1: the T shortcut toggles 2D/3D, the same action as the 2D/3D buttons', () => {
  let doc: FakeDocument
  let box: FakeNode
  let control: TerrainControl
  let win: EventTarget
  let uninstall: () => void
  const press = (key: string, target: unknown = doc.body): KeyEv => {
    const e = new KeyEv(key, target)
    win.dispatchEvent(e)
    return e
  }
  /** the radiogroup's buttons in order: 2D, 3D (the fake DOM keeps no text set through textContent) */
  const button = (v: '2d' | '3d'): FakeNode => byTag(box, 'button')[v === '2d' ? 0 : 1]

  beforeEach(() => {
    ui.view.value = '2d'
    ui.exaggeration.value = undefined
    ui.mode.value = 'plan'
    doc = installDom().document
    win = new EventTarget()
    vi.stubGlobal('window', win)
    control = new TerrainControl()
    box = control.onAdd() as unknown as FakeNode
    doc.body.appendChild(box)
    uninstall = installShortcuts(win as Window, () => undefined)
  })
  afterEach(() => {
    uninstall()
    control.onRemove()
    vi.unstubAllGlobals()
  })

  it('T = clicking the other button: same ui store result, the buttons follow', () => {
    button('3d').dispatch('click')
    const byClick = { view: ui.view.value, exaggeration: ui.exaggeration.value }
    button('2d').dispatch('click')
    ui.exaggeration.value = undefined
    expect(ui.view.value).toBe('2d')

    expect(press('t').defaultPrevented).toBe(true)
    expect({ view: ui.view.value, exaggeration: ui.exaggeration.value }).toEqual(byClick)
    expect(button('3d').getAttribute('aria-checked')).toBe('true')
    expect(button('2d').getAttribute('aria-checked')).toBe('false')
    press('T'.toLowerCase())
    expect(ui.view.value).toBe('2d')
    expect(button('2d').getAttribute('aria-checked')).toBe('true')
  })

  it('ignored while the 3D button is disabled (no terrain in this data tree), like a click on it', () => {
    control.setUnavailable('none')
    press('t')
    expect(ui.view.value).toBe('2d')
  })

  it.each([
    ['a text input', { localName: 'input', type: 'text', getAttribute: () => null }],
    ['a textarea', { localName: 'textarea', getAttribute: () => null }],
    ['a contenteditable element', { localName: 'div', isContentEditable: true, getAttribute: () => null }],
    ['the search box (palette combobox input)', { localName: 'input', type: 'text', getAttribute: (k: string) => (k === 'role' ? 'combobox' : null) }],
    ['the exaggeration slider', { localName: 'input', type: 'range', getAttribute: () => null }],
  ])('ignored while focus is in %s', (_, target) => {
    const e = press('t', target)
    expect(ui.view.value).toBe('2d')
    expect(e.defaultPrevented).toBe(false)
  })

  it('shown on the 3D button tooltip ("3D view (T)"), aria-keyshortcuts, the help overlay and the command list', () => {
    expect(t('tooltips.view3d')).toBe('3D view (T)')
    expect((button('3d') as unknown as { title: string }).title).toBe('3D view (T)')
    expect(button('3d').getAttribute('aria-keyshortcuts')).toBe('T')
    expect(HELP_ROWS.find((r) => r.label === 'shortcuts.toggle3d')).toEqual({ keys: ['T'], label: 'shortcuts.toggle3d', ready: true })
    expect(commandItems().find((i) => i.id === 'cmd:toggle3d')).toMatchObject({ command: { action: 'toggle3d' }, keys: ['T'] })
  })
})

// ---- 4. reduced motion: no camera animation on the toggle ---------------------------------------------
describe('T1: the 2D/3D camera transition respects reduced motion', () => {
  /** A map stub that records every call; enough for TerrainController + addTerrain. */
  function fakeMap(container: FakeNode) {
    const calls: { name: string; args: unknown[] }[] = []
    const rec =
      (name: string, ret?: unknown) =>
      (...args: unknown[]) => {
        calls.push({ name, args })
        return ret
      }
    const handler = { enable: rec('enable'), disable: rec('disable'), enableRotation: rec('enableRotation'), disableRotation: rec('disableRotation') }
    const map = {
      addControl: (c: { onAdd: (m: unknown) => unknown }) => container.appendChild(c.onAdd(map) as FakeNode),
      removeControl: (c: { onRemove: () => void }) => c.onRemove(),
      getContainer: () => container,
      on: rec('on'),
      off: rec('off'),
      once: rec('once'),
      getSource: rec('getSource'),
      addSource: rec('addSource'),
      getLayer: rec('getLayer'),
      addLayer: rec('addLayer'),
      setTerrain: rec('setTerrain'),
      setMaxPitch: rec('setMaxPitch'),
      setPaintProperty: rec('setPaintProperty'),
      triggerRepaint: rec('triggerRepaint'),
      easeTo: rec('easeTo'),
      jumpTo: rec('jumpTo'),
      dragRotate: handler,
      touchZoomRotate: handler,
      keyboard: handler,
    }
    return { map: map as unknown as MlMap, calls }
  }

  let doc: FakeDocument
  let win: EventTarget
  beforeEach(() => {
    ui.view.value = '2d'
    ui.mode.value = 'plan'
    doc = installDom().document
    // WebGL2 present (the controller probes a canvas)
    const make = doc.createElement.bind(doc)
    doc.createElement = (name: string) => Object.assign(make(name), name === 'canvas' ? { getContext: () => ({}) } : {})
    win = new EventTarget()
    vi.stubGlobal('window', win)
    const tilesJson = readFileSync(resolve(REPO, 'web/src/map/terrain/fixtures/terrain/tiles.json'), 'utf8')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => (String(u).includes('terrain/tiles.json') ? new Response(tilesJson, { headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 }))),
    )
  })
  afterEach(() => {
    ui.reducedMotion.value = false
    ui.view.value = '2d'
    vi.unstubAllGlobals()
  })

  for (const reduced of [true, false]) {
    it(`T with reduced motion ${reduced ? 'on: jumpTo, no easeTo' : 'off: easeTo (the camera eases)'}, both ways`, async () => {
      ui.reducedMotion.value = reduced
      const container = doc.createElement('div')
      doc.body.appendChild(container)
      const { map, calls } = fakeMap(container)
      const ctl = new TerrainController(map, 'iso-fill')
      const uninstall = installShortcuts(win as Window, () => undefined)
      win.dispatchEvent(new KeyEv('t', doc.body))
      await vi.waitFor(() => expect(container.getAttribute('data-terrain')).toBe('3d'))
      const moves = () => calls.filter((c) => c.name === 'easeTo' || c.name === 'jumpTo').map((c) => c.name)
      expect(moves()).toEqual([reduced ? 'jumpTo' : 'easeTo'])
      expect(calls.find((c) => c.name === moves()[0])!.args[0]).toMatchObject({ pitch: TERRAIN.pitch3d })
      win.dispatchEvent(new KeyEv('t', doc.body))
      await vi.waitFor(() => expect(container.getAttribute('data-terrain')).toBe('flat'))
      expect(moves()).toEqual(reduced ? ['jumpTo', 'jumpTo'] : ['easeTo', 'easeTo'])
      uninstall()
      ctl.destroy()
    })
  }

  it('addTerrain: animate false never eases', () => {
    const container = doc.createElement('div')
    const { map, calls } = fakeMap(container)
    const tiles = JSON.parse(readFileSync(resolve(REPO, 'web/src/map/terrain/fixtures/terrain/tiles.json'), 'utf8'))
    const h = addTerrain(map, tiles, (p) => p, undefined, { exaggeration: 1, azimuth: null })
    h.setTerrainOn(true, { animate: false })
    h.setTerrainOn(false, { animate: false })
    expect(calls.some((c) => c.name === 'easeTo')).toBe(false)
    expect(calls.filter((c) => c.name === 'setTerrain')[0].args[0]).toMatchObject({ exaggeration: 1 })
  })
})

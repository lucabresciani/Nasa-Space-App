// WS16 M1: field-shader spike page (#/spike, not linked from the nav). Decides the GPU field-layer
// rendering path (DESIGN U2 implementation 6-7, brief WS16 task 1). Lazy: imported only by main.ts
// when the hash is #/spike. Query (in the hash or the URL): path=custom|canvas, hz=<update Hz>,
// unknown=state|thome (hatch source; thome = t_home A = 0, to exercise the hatch).
import { Map as MlMap, NavigationControl, setWorkerUrl, type RasterDEMSourceSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import conditionsRaw from '../../../../config/conditions.yaml'
import crewRaw from '../../../../config/crew.yaml'
import hudRaw from '../../../../config/hud.yaml'
import { data } from '../../data/loader'
import { dataUrl } from '../../env'
import { PlaybackClock } from '../../hud/clock'
import { parseHudConfig } from '../../hud/config'
import { loadFieldRGBA } from '../../hud/fields'
import tokens from '../../ui/tokens.json'
import type { View } from '../../views/types'
import { basemapSources } from '../basemap'
import { FIELD_LAYER, SPIKE_TILT_DEG, VARIANTS } from './constants'
import { gridXform, hexToRgb01 } from './decode'
import { FpsMeter, RateCounter } from './fps'
import { addCanvasPath, addCustomLayer, type Bounds, type FieldPath } from './layers'
import type { FieldTextures, FieldUniforms } from './shader'

setWorkerUrl(workerUrl)

export function spikeParams(search: string, hash: string): URLSearchParams {
  const q = new URLSearchParams(search)
  const h = hash.split('?')[1]
  if (h) new URLSearchParams(h).forEach((v, k) => q.set(k, v))
  return q
}

/** Terrain tiles per DESIGN §6.1 (`terrain/tiles.json` + `terrain/{z}/{x}/{y}.png`); null if not published. */
async function probeTerrain(): Promise<RasterDEMSourceSpecification | null> {
  try {
    const res = await fetch(dataUrl('terrain/tiles.json'))
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null
    const j = (await res.json()) as { tiles?: string[]; minzoom?: number; maxzoom?: number; bounds?: Bounds }
    const tiles = (j.tiles ?? ['terrain/{z}/{x}/{y}.png']).map((t) => (/^https?:/.test(t) ? t : dataUrl(t)))
    return { type: 'raster-dem', tiles, tileSize: 256, encoding: 'terrarium', minzoom: j.minzoom, maxzoom: j.maxzoom, bounds: j.bounds }
  } catch {
    return null
  }
}

function gpuName(): string {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return 'no WebGL2'
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
}

const CSS = `
.spike{position:relative;height:calc(100vh - 48px);background:${tokens.color.bg};color:${tokens.color.text};font:${tokens.font.size.small}px/${tokens.font.lineHeight.small}px system-ui}
.spike-map{position:absolute;inset:0}
.spike-bar,.spike-hud{position:absolute;z-index:2;background:${tokens.color.card};border:1px solid ${tokens.color.cardBorder};border-radius:${tokens.radius.card}px;padding:${tokens.space[2]}px}
.spike-bar{left:${tokens.space[3]}px;bottom:${tokens.space[3]}px;display:flex;flex-wrap:wrap;gap:${tokens.space[2]}px;align-items:center;max-width:calc(100% - 340px)}
.spike-hud{right:${tokens.space[3]}px;top:${tokens.space[3]}px;width:300px;font-family:monospace;white-space:pre-wrap}
.spike-hud b{color:${tokens.color.select}}
.spike button,.spike select{background:${tokens.color.sidebar};color:${tokens.color.text};border:1px solid ${tokens.color.cardBorder};border-radius:${tokens.radius.input}px;padding:${tokens.space[1]}px ${tokens.space[2]}px}
.spike button[aria-pressed=true]{border-color:${tokens.color.text}}
.spike input[type=range]{width:180px}`

export const view: View = async (el) => {
  const q = spikeParams(location.search, location.hash)
  const pathKind: 'custom' | 'canvas' = q.get('path') === 'canvas' ? 'canvas' : 'custom'
  const hz = Number(q.get('hz')) > 0 ? Number(q.get('hz')) : FIELD_LAYER.updateHzPlaying
  let unknownSrc: 0 | 1 = q.get('unknown') === 'thome' ? 1 : 0

  el.innerHTML = `<style>${CSS}</style><div class="spike"><div class="spike-map"></div>
    <div class="spike-hud">loading fields…</div>
    <div class="spike-bar">
      <button data-k="play">Play</button>
      <select data-k="speed" title="playback speed (config/hud.yaml)"></select>
      <input data-k="t" type="range" min="0" step="0.1" title="EVA clock (min)"/>
      <select data-k="mode"><option value="0">bands</option><option value="1">margin (simple)</option></select>
      <select data-k="variant">${VARIANTS.map((v, i) => `<option value="${i}"${v === 'nom' ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <select data-k="budget"></select>
      <button data-k="tilt" aria-pressed="false">Tilt ${SPIKE_TILT_DEG}° + terrain</button>
      <button data-k="orbit" aria-pressed="false" title="rotate the camera so the map redraws every frame">Orbit</button>
      <a data-k="other" style="color:${tokens.color.textMuted}"></a>
    </div></div>`
  const $ = <T extends HTMLElement>(k: string) => el.querySelector<T>(`[data-k="${k}"]`)!
  const hud = el.querySelector<HTMLElement>('.spike-hud')!
  const other = $<HTMLAnchorElement>('other')
  const otherKind = pathKind === 'canvas' ? 'custom' : 'canvas'
  other.href = `#/spike?path=${otherKind}`
  other.textContent = `switch to ${otherKind} path`

  const cfg = parseHudConfig(hudRaw, crewRaw, conditionsRaw)
  const clock = new PlaybackClock(cfg.evaMin, cfg.playbackSpeeds, cfg.defaultSpeed)
  $<HTMLSelectElement>('speed').innerHTML = cfg.playbackSpeeds.map((s) => `<option value="${s}"${s === cfg.defaultSpeed ? ' selected' : ''}>${s}×</option>`).join('')
  $<HTMLSelectElement>('budget').innerHTML = cfg.walkbackBudgetsMin.map((b) => `<option value="${b}">${b} min</option>`).join('')
  const tInput = $<HTMLInputElement>('t')
  tInput.max = String(cfg.evaMin)
  tInput.value = '0'

  // ---- data: three t_home variants of the default suit mass + the cell-state grid
  const L = data()
  const [fi, pad, sc, cs, tj] = await Promise.all([L.fieldsIndex(), L.pad(), L.scenarios(), L.optional(() => L.cellstate()), L.optional(() => L.tilejson())])
  const kg = sc.default.split('_')[1]
  const metas = VARIANTS.map((v) => {
    const m = fi.fields[`${v}_${kg}/t_home`]
    if (!m) throw new Error(`fields/index.json has no ${v}_${kg}/t_home`)
    return m
  })
  if (new Set(metas.map((m) => m.scale)).size !== 1) throw new Error('t_home variants differ in scale')
  const rgbas = await Promise.all(metas.map((m) => loadFieldRGBA(dataUrl(m.file))))
  for (const r of rgbas) if (r.width !== fi.width || r.height !== fi.height) throw new Error(`t_home is ${r.width}x${r.height}, index ${fi.width}x${fi.height}`)
  const state = cs ? await loadFieldRGBA(dataUrl(cs.image)) : { rgba: new Uint8ClampedArray(4), width: 1, height: 1 }
  if (!cs) unknownSrc = 1
  const bounds = fi.bounds as Bounds
  const ft: FieldTextures = {
    size: [fi.width, fi.height],
    scale: metas[0].scale,
    t: [rgbas[0].rgba, rgbas[1].rgba, rgbas[2].rgba],
    state: { rgba: state.rgba, size: [state.width, state.height], xform: cs ? gridXform(bounds, cs.bounds as Bounds) : [0, 0, 1, 1] },
  }

  const c = tokens.color
  const uni = (): FieldUniforms => ({
    mode: Number($<HTMLSelectElement>('mode').value) as 0 | 1,
    variant: Number($<HTMLSelectElement>('variant').value) as 0 | 1 | 2,
    unknownSrc,
    budget: Number($<HTMLSelectElement>('budget').value),
    t: clock.t,
    tEva: cfg.evaMin,
    amber: cfg.marginAmberMin,
    hatchPx: FIELD_LAYER.hatchPx,
    pxScale: 1,
    lineHalfPx: tokens.line.fieldEdgePx / 2,
    colors: { safe: hexToRgb01(c.safe), caution: hexToRgb01(c.caution), limit: hexToRgb01(c.limit), unknown: hexToRgb01(c.unknown) },
    opacity: [tokens.overlayOpacity.min, tokens.overlayOpacity.max],
  })

  // ---- map
  const map = new MlMap({
    container: el.querySelector<HTMLElement>('.spike-map')!,
    style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': c.bg } }] },
    center: [pad.pad.lon, pad.pad.lat],
    zoom: 13.2,
    maxPitch: 85,
    attributionControl: false,
    renderWorldCopies: false,
  })
  map.addControl(new NavigationControl({ visualizePitch: true }), 'top-left')
  await new Promise<void>((res) => map.once('load', () => res()))
  if (tj) {
    basemapSources(tj, (p) => dataUrl(p)).forEach((src, i) => {
      const id = `basemap-${i}`
      map.addSource(id, { type: 'raster', tiles: src.tiles, tileSize: src.tileSize, minzoom: src.minzoom, maxzoom: src.maxzoom, bounds: src.bounds })
      map.addLayer({ id, type: 'raster', source: id, ...(src.layerMinzoom !== undefined ? { minzoom: src.layerMinzoom } : {}), paint: { 'raster-fade-duration': 0 } })
    })
  }
  map.addSource('pad', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [pad.pad.lon, pad.pad.lat] } } })
  map.addLayer({ id: 'pad', type: 'circle', source: 'pad', paint: { 'circle-radius': 5, 'circle-color': c.bg, 'circle-stroke-color': c.text, 'circle-stroke-width': 2 } })

  const path: FieldPath = pathKind === 'canvas' ? addCanvasPath(map, bounds, ft, uni(), FIELD_LAYER.halfResAbovePx, 'pad') : addCustomLayer(map, bounds, ft, uni(), 'pad')

  // ---- controls
  const push = (): void => path.update(uni(), clock.playing)
  const updates = new RateCounter()
  const renders = new RateCounter()
  const uploadsAt: number[] = []
  map.on('render', () => renders.tick(performance.now()))
  const playBtn = $<HTMLButtonElement>('play')
  playBtn.onclick = () => {
    clock.toggle()
    playBtn.textContent = clock.playing ? 'Pause' : 'Play'
    if (!clock.playing) push() // full resolution again when paused (canvas path)
  }
  $<HTMLSelectElement>('speed').onchange = (e) => clock.setSpeed(Number((e.target as HTMLSelectElement).value))
  tInput.oninput = () => {
    clock.seek(Number(tInput.value))
    push()
  }
  for (const k of ['mode', 'variant', 'budget']) $<HTMLSelectElement>(k).onchange = push
  let terrain = 'off'
  const tiltBtn = $<HTMLButtonElement>('tilt')
  tiltBtn.onclick = async () => {
    const on = tiltBtn.getAttribute('aria-pressed') !== 'true'
    tiltBtn.setAttribute('aria-pressed', String(on))
    if (on) {
      const dem = await probeTerrain()
      if (dem) {
        if (!map.getSource('dem')) map.addSource('dem', dem)
        map.setTerrain({ source: 'dem', exaggeration: 1 }) // tiles are pre-scaled x1.878 (DESIGN §6.1)
        terrain = 'raster-dem on'
      } else terrain = 'none published (pitch only)'
      map.easeTo({ pitch: SPIKE_TILT_DEG, duration: 0 })
    } else {
      map.setTerrain(null)
      terrain = 'off'
      map.easeTo({ pitch: 0, duration: 0 })
    }
  }
  let orbit = false
  const orbitBtn = $<HTMLButtonElement>('orbit')
  orbitBtn.onclick = () => {
    orbit = !orbit
    orbitBtn.setAttribute('aria-pressed', String(orbit))
  }

  // ---- loop: clock every frame, u_t pushed at `hz`, fps meter, HUD text 4x per second
  const gpu = gpuName()
  const meter = new FpsMeter()
  let last = performance.now()
  let lastPush = 0
  let lastHud = 0
  let raf = 0
  const loop = (now: number): void => {
    meter.frame(now)
    const dt = now - last
    last = now
    if (clock.tick(dt)) tInput.value = clock.t.toFixed(1)
    if (clock.playing && now - lastPush >= 1000 / hz - 1) {
      lastPush = now
      push()
      updates.tick(now)
      if (path.kind === 'canvas') uploadsAt.push(now)
    } else if (!clock.playing && playBtn.textContent === 'Pause') {
      playBtn.textContent = 'Play'
      push()
    }
    if (orbit) map.setBearing(map.getBearing() + dt * 0.006) // 6 deg/s
    if (now - lastHud > 250) {
      lastHud = now
      const s = meter.stats()
      while (uploadsAt.length && uploadsAt[0] <= now - 1000) uploadsAt.shift()
      hud.textContent =
        `PATH   ${path.label}\n` +
        `GPU    ${gpu}\n` +
        `FPS    ${s.fps.toFixed(1)}  p95 ${s.p95Ms.toFixed(1)} ms  max ${s.maxMs.toFixed(1)} ms\n` +
        `map    ${renders.rate(now).toFixed(0)} renders/s  pitch ${map.getPitch().toFixed(0)}°\n` +
        `field  ${updates.rate(now).toFixed(0)} updates/s (target ${hz} while playing)\n` +
        (path.kind === 'canvas' ? `upload ${uploadsAt.length}/s  canvas ${(map.getSource('spike-field') as { getCanvas?: () => HTMLCanvasElement })?.getCanvas?.()?.width ?? '?'} px\n` : '') +
        `draw   ${path.stats.lastCpuMs.toFixed(2)} ms CPU (last)\n` +
        `t      ${clock.t.toFixed(1)} / ${cfg.evaMin} min  ${clock.playing ? 'playing' : 'paused'} ${clock.speed}×\n` +
        `terrain ${terrain}\n` +
        `field  ${fi.width}×${fi.height} @${fi.res_m} m  dpr ${devicePixelRatio}\n` +
        `hatch  ${unknownSrc ? 't_home A=0 (debug)' : 'cell state A=0'}`
    }
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  return () => {
    cancelAnimationFrame(raf)
    path.remove()
    map.remove()
  }
}

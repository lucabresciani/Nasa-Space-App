// /hud view (F18, F19): playback clock, route-following marker, helmet panel, alarms, minimap,
// drag-anywhere, storm switch (D39 placement), drift circle (D39 radius; the F21 ellipse is an
// optional add-on, D19). Self-contained: reads its own files from the data root through
// opts.dataUrl.
//
//   const hud = await mountHud(container, { dataUrl, config })   // config = parseHudConfig(...)
//   hud.destroy()
//
// The pieces are exported separately (hud/index.ts): loadHudData() -> HudData, then each frame
// computeReadout(pos, data.ctx) and createHudPanel(el, cfg).update(readout, pos, extras).
// (WS8's first-person 3D view used to reuse them; it was removed in D99.)
import './hud.css'
import { PlaybackClock, type ClockDriver } from './clock'
import { mission, missionClock } from '../state/mission'
import type { HudConfig } from './config'
import { driftPosition, planFixes, type Fix } from './drift'
import { decodeRGBA, FieldGrid, loadField, loadFieldRGBA } from './fields'
import { HudMap } from './map'
import { hudFrame, takeFixTime, type HudNav } from './navhud'
import { NAV } from '../nav/config'
import { createNavLoader, slotFetcher } from '../nav/load'
import type { Fix as NavFix } from '../nav/types'
import { createHudPanel, fmtEva, type HudPanel } from './panel'
import { Plan } from './plan'
import { readoutSources } from './provenance'
import { hudMarginInputs, playbackPosition, type HudContext, type HudFields } from './readout'
import { radiationInput, routeTHomeSeries, stormReplay, stormState, type StormReplay } from './storm'
import { parseClockSun, sunAt, sunRowText, sunSources, type ClockFile, type SunData } from './sun'
import type { Bounds, FieldsIndex, HudPosition, LonLat, PadFile, PolygonFC, Rad, RouteFC, ScenariosIndex, Station, TimelineEvent } from './types'
import { loadPointer, wayHomeView, type PointerField } from './wayhome'

export interface MountHudOptions {
  /** URL of a file in the active data tree, e.g. dataUrl('fields/index.json'). */
  dataUrl: (path: string) => string
  config: HudConfig
  /** Scenario id; default = scenarios/index.json "default". */
  scenario?: string
  /** Homeline budget (min) for the alarm-3 circle; default crew.yaml walkback_budgets_min[0]. */
  budgetMin?: number
}

export interface HudData {
  ctx: HudContext
  index: FieldsIndex
  scenario: string
  consScenario: string | null
  stations: Station[]
  rad: Rad | null
  dummy: boolean
  /** way-home pointer `{scenario}/pointer` (contracts v1.1.1); null = not exported */
  pointer: PointerField | null
  /** terrain/cellstate.png on its own grid (contracts v1.1.0); null = not available */
  cellstate: FieldGrid | null
  padFromFile: boolean
  partnerFile: string | null
  fixes: Fix[]
  /** F21 nav data for config/nav.yaml default_set (null = no nav/montecarlo file) */
  nav: HudNav | null
  /** WS4 conditions/clock.json EVA sun series + time to dark (null = file absent) */
  sun: SunData | null
}

export interface HudHandle {
  /** the shared mission clock (web/src/state/mission.ts): survives route changes */
  clock: ClockDriver
  data: HudData
  destroy(): void
}

async function getJson<T>(dataUrl: (p: string) => string, path: string): Promise<T> {
  const res = await fetch(dataUrl(path))
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  const text = await res.text()
  if (/^\s*<!doctype html/i.test(text)) throw new Error(`${path}: not found`)
  return JSON.parse(text) as T
}
async function optional<T>(what: string, p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch (e) {
    console.warn(`[hud] optional ${what} unavailable:`, e)
    return null
  }
}

async function loadCellstate(dataUrl: (p: string) => string): Promise<FieldGrid> {
  const meta = await getJson<{ image: string; bounds: Bounds; width: number; height: number; res_m: number }>(dataUrl, 'terrain/cellstate.json')
  const { rgba, width, height } = await loadFieldRGBA(dataUrl(meta.image))
  return new FieldGrid(meta, decodeRGBA(rgba, width, height, 1), 'state')
}

/** Load everything the HUD reads for one scenario. Missing optional files stay unknown. */
export async function loadHudData(opts: MountHudOptions): Promise<HudData> {
  const { dataUrl, config } = opts
  const [scen, index] = await Promise.all([
    getJson<ScenariosIndex>(dataUrl, 'scenarios/index.json'),
    getJson<FieldsIndex>(dataUrl, 'fields/index.json'),
  ])
  const dummy = index.dummy === true || scen.dummy === true
  const sc = opts.scenario ?? scen.default
  const entry = scen.scenarios.find((s) => s.id === sc)
  if (!entry) throw new Error(`scenario ${sc} not in scenarios/index.json`)
  const cons = scen.scenarios.find((s) => s.suit_kg === entry.suit_kg && s.variant === 'conservative')

  const field = async (key: string, required = false): Promise<FieldGrid | undefined> => {
    if (!index.fields[key]) {
      if (required) throw new Error(`fields/index.json lacks ${key}`)
      return undefined
    }
    return loadField(index, key, dataUrl)
  }
  const worstKeys = config.worstCaseRadiiM.map((r) => [r, `${sc}/t_home_worst_${r}`, `${sc}/o2_home_worst_${r}`] as const)
  const partnerFile = entry.files.partner ?? null
  const [tHome, tHomeCons, o2Home, homeBearing, slope, worstLoaded, route, timeline, stations, partner, rad, padFile, cellstate, pointer, clockFile] = await Promise.all([
    field(`${sc}/t_home`, true),
    cons ? field(`${cons.id}/t_home`) : Promise.resolve(undefined),
    field(`${sc}/o2_home`),
    field(`${sc}/home_bearing`),
    field('slope'),
    Promise.all(worstKeys.map(async ([r, tk, ok]) => [r, { tHome: await field(tk), o2Home: await field(ok) }] as const)),
    getJson<RouteFC>(dataUrl, `route_${sc}.geojson`),
    getJson<TimelineEvent[]>(dataUrl, `timeline_${sc}.json`),
    optional('stations.json', getJson<Station[]>(dataUrl, 'stations.json')),
    partnerFile ? optional(partnerFile, getJson<PolygonFC>(dataUrl, partnerFile)) : Promise.resolve(null),
    optional('conditions/rad.json', getJson<Rad>(dataUrl, 'conditions/rad.json')),
    optional('pad.json', getJson<PadFile>(dataUrl, 'pad.json')),
    optional('terrain/cellstate', loadCellstate(dataUrl)),
    index.fields[`${sc}/pointer`]?.stencil ? optional('way-home pointer', loadPointer(index, `${sc}/pointer`, dataUrl)) : Promise.resolve(null),
    optional('conditions/clock.json', getJson<ClockFile>(dataUrl, 'conditions/clock.json')),
  ])
  const navLoader = createNavLoader(slotFetcher(dataUrl), dummy ? 'dummy' : 'real')
  const set = NAV.defaultSet
  const [mc, navFixes, dMax] = await Promise.all([
    optional(`nav/montecarlo_${set}.json`, navLoader.optional(() => navLoader.montecarlo(set))),
    optional('nav/fixes.json', navLoader.optional(() => navLoader.fixes())),
    index.fields[`fix_interval_${set}`] ? optional(`fix_interval_${set}`, loadField(index, `fix_interval_${set}`, dataUrl)) : Promise.resolve(null),
  ])
  const nav: HudNav | null = mc ? { set, mc, fixes: (navFixes as NavFix[] | null) ?? [], dMax, ellipseVertices: NAV.ellipseVertices } : null
  const fields: HudFields = { tHome: tHome!, tHomeCons, o2Home, homeBearing, slope, worst: new Map(worstLoaded) }
  const padLL: LonLat | undefined = padFile ? [padFile.pad.lon, padFile.pad.lat] : undefined
  const plan = new Plan(route, timeline, tHome!, padLL)
  const pad: LonLat = padLL ?? plan.start
  // the exact margin function's inputs (D89): the field's files and mission-state defaults
  const budgets = { reserveL: mission.budgets.o2ReserveL.peek(), dAllowMgy: mission.budgets.doseAllowMgy.peek() }
  const margin = hudMarginInputs(plan, rad, clockFile?.eva?.t_dark_min, config, budgets)
  const ctx: HudContext = { cfg: config, fields, plan, budgetMin: opts.budgetMin ?? config.walkbackBudgetsMin[0], pad, partner, margin }
  return {
    ctx, index, scenario: sc, consScenario: tHomeCons && cons ? cons.id : null, stations: stations ?? [], rad, dummy,
    pointer, cellstate, padFromFile: !!padFile, partnerFile, fixes: planFixes(plan, config), nav,
    sun: clockFile ? parseClockSun(clockFile) : null,
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}
function button(cls: string, text: string, label?: string): HTMLButtonElement {
  const b = el('button', cls, text)
  b.type = 'button'
  if (label) b.setAttribute('aria-label', label)
  return b
}

export async function mountHud(container: HTMLElement, opts: MountHudOptions): Promise<HudHandle> {
  const cfg = opts.config
  const root = el('div', 'hl-hud')
  root.append(el('div', 'hl-hud-loading', `Loading HUD fields… (${cfg.simulatedLabel})`))
  container.append(root)

  let data: HudData
  try {
    data = await loadHudData(opts)
  } catch (e) {
    root.replaceChildren(el('div', 'hl-hud-error', `HUD data could not be loaded: ${(e as Error).message}`))
    throw e
  }
  const { ctx } = data
  root.replaceChildren()

  const stationPts = data.stations.filter((s) => s.lon !== null && s.lat !== null) as { id: string; lon: number; lat: number }[]
  const mapOpts = { grid: ctx.fields.tHome, plan: ctx.plan, budgetMin: ctx.budgetMin, stations: stationPts, cellstate: data.cellstate, pad: ctx.pad }
  const map = new HudMap(mapOpts)
  const mini = new HudMap({ ...mapOpts, follow: true, spanM: 1200, className: 'hl-hud-minimap-canvas' })
  const stage = el('div', 'hl-hud-stage')
  stage.append(map.canvas)
  stage.append(el('div', 'hl-hud-sim-label', cfg.simulatedLabel + (data.dummy ? ' · DUMMY DATA' : '')))
  if (!ctx.plan.legs.length) stage.append(el('div', 'hl-hud-noroute', `No planned route for ${data.scenario} (no reachable station): the HUD stays at the pad; drag the map to read any spot.`))
  root.append(stage)
  const panel: HudPanel = createHudPanel(stage, cfg)

  // the one mission clock (WS15 A3, survives route changes); it is built from the same
  // config/hud.yaml and crew.yaml keys, so a caller with another config gets a private clock
  const shared = missionClock.tMax === cfg.evaMin && missionClock.speeds.join() === cfg.playbackSpeeds.join() && cfg.playbackSpeeds.includes(cfg.defaultSpeed)
  const clock: ClockDriver = shared ? missionClock : new PlaybackClock(cfg.evaMin, cfg.playbackSpeeds, cfg.defaultSpeed)
  const controls = el('div', 'hl-hud-controls')
  const playBtn = button('hl-hud-play', '▶', 'Play / pause')
  controls.append(playBtn)
  let dirty = true
  const speedBtns = cfg.playbackSpeeds.map((s) => {
    const b = button('hl-hud-speed', `${s}×`)
    b.addEventListener('click', () => {
      clock.setSpeed(s)
      dirty = true
    })
    controls.append(b)
    return [s, b] as const
  })
  const scrub = el('input', 'hl-hud-scrub')
  scrub.type = 'range'
  scrub.min = '0'
  scrub.max = String(cfg.evaMin)
  scrub.step = '0.1'
  scrub.setAttribute('aria-label', 'EVA time')
  const timeLbl = el('span', 'hl-hud-time')
  const fpsLbl = el('span', 'hl-hud-fps')
  // storm switch (F18; placement D39) and the drift circle (F19 core, D19; radius D39)
  const series = routeTHomeSeries(ctx.plan, ctx.fields.tHome)
  const replay: StormReplay | null = cfg.stormReplay ? stormReplay(data.rad, series.evaMin, series.tHomeMin) : null
  const tripAt = replay ? `${fmtEva(replay.tripwireEvaMin)}${replay.halfwidthLabel ? ' ' + replay.halfwidthLabel : ''}` : ''
  const stormBtn = button('hl-hud-toggle-btn', 'Storm replay: off')
  stormBtn.title = replay
    ? `Replay the 20 May 2024 storm during this EVA: its tripwire fires at ${tripAt}, the minute of the route's largest T_home (D39, config/conditions.yaml storm_replay)`
    : 'Storm replay unavailable: no storm tripwire, tau_dose or route T_home known'
  const driftBtn = button('hl-hud-toggle-btn', 'Drift: off')
  driftBtn.title = `Dead reckoning: circle radius = max(${cfg.fallbackDrift.sigmaFloorM} m, ${cfg.fallbackDrift.pctOfDistance} % of distance since the last fix) (D39); fixes at the rover pad and surveyed stations`
  // F21 Monte Carlo ellipse (WS9): optional add-on (D19), only when its files exist
  const odoName = data.nav ? `Odometry (F21, ${data.nav.set}, optional)` : ''
  const odoBtn = button('hl-hud-toggle-btn', `${odoName}: off`)
  odoBtn.hidden = !data.nav
  if (data.nav) odoBtn.title = `Optional add-on (D19): dead-reckoning uncertainty from nav/montecarlo_${data.nav.set}.json (95 % ellipse)`
  const fixBtn = button('hl-hud-toggle-btn', 'Take fix')
  fixBtn.hidden = true
  controls.append(scrub, timeLbl, stormBtn, driftBtn, odoBtn, fixBtn, fpsLbl)
  root.append(controls)

  let storm: StormReplay | null = null
  stormBtn.disabled = replay === null
  stormBtn.addEventListener('click', () => {
    storm = storm ? null : replay
    stormBtn.textContent = storm ? `Storm replay: on (tripwire ${tripAt})` : 'Storm replay: off'
    stormBtn.classList.toggle('active', !!storm)
    dirty = true
  })
  // one uncertainty source at a time: the core drift circle or the optional F21 ellipse
  let drift = false
  let odo = false
  const syncPos = () => {
    driftBtn.textContent = `Drift: ${drift ? 'on' : 'off'}`
    driftBtn.classList.toggle('active', drift)
    odoBtn.textContent = `${odoName}: ${odo ? 'on' : 'off'}`
    odoBtn.classList.toggle('active', odo)
    fixBtn.hidden = !odo
    dirty = true
  }
  driftBtn.addEventListener('click', () => {
    drift = !drift
    if (drift) odo = false
    syncPos()
  })
  odoBtn.addEventListener('click', () => {
    odo = !odo && !!data.nav
    if (odo) drift = false
    syncPos()
  })
  fixBtn.addEventListener('click', () => {
    const t = takeFixTime(data.nav, clock.t)
    if (t !== null) clock.seek(t)
    dirty = true
  })

  // drag-anywhere (F18) + user sigma (F19 source "drag": slider 0 .. largest worst-case radius, default 0)
  const dragBar = el('div', 'hl-hud-dragbar')
  dragBar.hidden = true
  const sigmaLbl = el('label', 'hl-hud-sigma', 'σ ')
  const sigma = el('input', 'hl-hud-sigma-input')
  sigma.type = 'range'
  sigma.min = '0'
  sigma.max = String(cfg.worstCaseRadiiM[cfg.worstCaseRadiiM.length - 1])
  sigma.step = '1'
  sigma.value = '0'
  const sigmaVal = el('span', 'hl-hud-sigma-val', '0 m')
  sigmaLbl.append(sigma, sigmaVal)
  const backBtn = button('hl-hud-back', 'Back to playback')
  dragBar.append(el('span', 'hl-hud-draghint', 'Drag-anywhere: drag or click the map'), sigmaLbl, backBtn)
  controls.append(dragBar)
  const dragHint = el('div', 'hl-hud-draghint-map', data.pointer ? 'Click or drag the map: time home and way home from any spot' : 'Click or drag the map: time home from any spot')
  stage.append(dragHint)

  let drag: LonLat | null = null
  let pressed = false
  const setDrag = (e: PointerEvent) => {
    const r = map.canvas.getBoundingClientRect()
    const p = map.screenToLonLat(e.clientX - r.left, e.clientY - r.top)
    if (!p) return
    drag = p
    if (clock.playing) clock.pause()
    dragBar.hidden = false
    dirty = true
  }
  map.canvas.addEventListener('pointerdown', (e) => {
    pressed = true
    map.canvas.setPointerCapture?.(e.pointerId)
    setDrag(e)
  })
  map.canvas.addEventListener('pointermove', (e) => {
    if (pressed) setDrag(e)
  })
  const release = () => {
    pressed = false
  }
  map.canvas.addEventListener('pointerup', release)
  map.canvas.addEventListener('pointercancel', release)
  sigma.addEventListener('input', () => {
    sigmaVal.textContent = `${sigma.value} m`
    dirty = true
  })
  const leaveDrag = () => {
    drag = null
    dragBar.hidden = true
    dirty = true
  }
  backBtn.addEventListener('click', leaveDrag)
  playBtn.addEventListener('click', () => {
    if (drag) leaveDrag()
    clock.toggle()
    dirty = true
  })
  scrub.addEventListener('input', () => {
    clock.seek(Number(scrub.value))
    dirty = true
  })
  panel.onLevelChange = () => {
    dirty = true
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === ' ' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement || e.target instanceof HTMLSelectElement)) {
      e.preventDefault()
      clock.toggle()
      dirty = true
    }
  }
  window.addEventListener('keydown', onKey)
  const ro = new ResizeObserver(() => {
    dirty = true
  })
  ro.observe(stage)

  const stationById = new Map(data.stations.map((s) => [s.id, s]))
  let lastHeading: number | null = null
  let raf = 0
  let last = performance.now()
  let fps = 0
  const frame = (now: number) => {
    const dt = now - last
    last = now
    if (dt > 0) fps = fps ? fps * 0.95 + (1000 / dt) * 0.05 : 1000 / dt
    if (clock.tick(dt)) dirty = true
    if (dirty) {
      dirty = false
      const state = ctx.plan.stateAt(clock.t)
      if (state.headingDeg !== null) lastHeading = state.headingDeg
      const base: HudPosition = drag
        ? { lon: drag[0], lat: drag[1], sigma_m: Number(sigma.value), source: 'drag', t_eva_min: clock.t, last_fix: null }
        : drift
          ? driftPosition(ctx.plan, cfg, data.fixes, clock.t)
          : playbackPosition(ctx.plan, clock.t)
      const st = stormState(storm, clock.t)
      const f = hudFrame(base, { ...ctx, radiation: radiationInput(st) }, odo ? data.nav : null)
      const pos = f.pos
      const r = f.readout
      const way = wayHomeView(data.pointer, drag, ctx.pad)
      const sun = data.sun ? sunAt(data.sun, clock.t, drag ? null : state.station) : null
      const pr = panel.el.getBoundingClientRect()
      const sr = stage.getBoundingClientRect()
      map.insetRightPx = pr.width && pr.right <= sr.right + 1 && getComputedStyle(panel.el).position === 'absolute' ? sr.right - pr.left : 0
      const mf = { state, lon: pos.lon, lat: pos.lat, sigmaM: pos.sigma_m, ring: f.ring, wayHome: way.map, dragging: !!drag }
      map.draw({ ...mf, band: clock.playing ? r.band : 'unknown' })
      if (panel.level === 'expanded') mini.draw({ ...mf, band: r.band })
      panel.update(r, pos, {
        headingDeg: drag ? null : lastHeading,
        stationName: (id) => stationById.get(id)?.name ?? id,
        stationTasks: (id) => stationById.get(id)?.tasks ?? [],
        rad: data.rad,
        dummy: data.dummy,
        minimap: mini.canvas,
        sources: readoutSources(r, { scenario: data.scenario, consScenario: data.consScenario, padFromFile: data.padFromFile, partnerFile: data.partnerFile, sunSources: sun ? sunSources(sun) : null, storm: st }),
        sun: sun ? sunRowText(sun) : null,
        wayHome: way.panel,
        storm: st,
        navLine: f.line,
      })
      playBtn.textContent = clock.playing ? '❚❚' : '▶'
      for (const [s, b] of speedBtns) b.classList.toggle('active', s === clock.speed)
      if (document.activeElement !== scrub) scrub.value = String(clock.t)
      timeLbl.textContent = `${fmtEva(clock.t)} · ${clock.t.toFixed(1)} min${drag ? ' · dragged position' : ''}`
      dragHint.hidden = !!drag
    }
    fpsLbl.textContent = `${Math.round(fps)} fps`
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  return {
    clock,
    data,
    destroy() {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      ro.disconnect()
      panel.destroy()
      root.remove()
    },
  }
}

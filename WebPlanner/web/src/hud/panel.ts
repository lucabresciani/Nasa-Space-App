// Helmet-style HUD panel (F18): a DOM overlay in two levels (D14: minimal by default, expanded one
// click away): createHudPanel(el, cfg).update(readout, pos, extras).
import type { HudConfig } from './config'
import type { PanelRow, RowSource } from './provenance'
import type { Readout } from './readout'
import type { StormState } from './storm'
import type { Binding, HudPosition, Rad } from './types'

export interface PanelExtras {
  headingDeg: number | null // direction of travel for the compass ribbon (null = north-up)
  stationName?: (id: string) => string
  stationTasks?: (id: string) => string[]
  rad?: Rad | null
  dummy?: boolean
  minimap?: HTMLCanvasElement | null // drawn by the caller; mounted in the expanded level
  /** sources per row (provenance.ts readoutSources); data-manifest-key / data-source-files + tooltip */
  sources?: Partial<Record<PanelRow, RowSource>>
  /** true while a nav panel (mounted in navSlot, WS9) replaces the position line */
  navActive?: boolean
  /** F21 position line from WS9 navLine ("Odometry ±N m · next fix due in M m · last fix …") */
  navLine?: string | null
  /** storm switch state (F18): tripwire fired on the EVA clock, minutes since, tau_dose */
  storm?: StormState | null
  /** sun / time-to-dark row (sun.ts sunRowText); null/undefined = no clock.json, row hidden */
  sun?: { value: string; sub: string } | null
  /** way home from the dragged position: drawn on the map; false = no path known from here */
  wayHome?: { reachesPad: boolean; startKnown: boolean } | null
}

const BINDING_LABEL: Record<string, string> = { O2: 'O₂', daylight: 'daylight', dose: 'dose', 'EVA duration': 'EVA duration' }

/** Display text of a binding term (D28: incl. "EVA duration"); undefined = not in the timeline. */
export function bindingLabel(b: Binding | undefined): string {
  if (b === undefined) return '—'
  if (b === null) return 'unknown'
  return BINDING_LABEL[b] ?? b
}

/**
 * Tripwire row (F18, D39): the replayed storm's tripwire fires at t* (the route's largest T_home)
 * on the EVA clock, shown with rad.json's "± 9 min" (D35); then the dose budget left.
 */
export function tripRowText(st: StormState | null, rad: Rad | null): { value: string; sub: string; band: string } {
  const pm = st?.halfwidthLabel ? ` ${st.halfwidthLabel}` : ''
  const tau = (v: number | null | undefined) => (v != null ? `τ at 2024 peak ${fmt(v, 0, 'min')}` : '')
  if (st?.on && st.tFire !== null) {
    const at = `${fmtEva(st.tFire)}${pm}`
    if (st.fired) {
      const left = st.doseLeftMin !== null ? `dose budget left ${fmt(Math.max(0, st.doseLeftMin), 0, 'min')} (${tau(st.tauDoseMin)})` : tau(st.tauDoseMin)
      return { value: `FIRED ${at}`, sub: left, band: 'red' }
    }
    return { value: `armed: fires ${at}`, sub: ["storm replay at the route's largest T_home", tau(st.tauDoseMin)].filter(Boolean).join(' · '), band: '' }
  }
  return { value: 'not fired', sub: tau(rad?.leash.tau_min_at_peak), band: '' }
}

/**
 * Turn-back sub-line (D28): the binding term of the turn-back, and during a station dwell WS2's
 * latest leave for that station with its own binding. '' when the timeline has no bindings.
 */
export function turnBackSub(r: Readout): string {
  const parts: string[] = []
  if (r.binding !== undefined) parts.push(`bound by ${bindingLabel(r.binding)}`)
  if (r.latestLeave) parts.push(`${r.latestLeave.station} latest leave ${fmtEva(r.latestLeave.t_min)} (${bindingLabel(r.latestLeave.binding)})`)
  return parts.join(' · ')
}

export interface HudPanel {
  readonly el: HTMLElement
  update(r: Readout, pos: HudPosition, x: PanelExtras): void
  setLevel(level: 'minimal' | 'expanded'): void
  readonly level: 'minimal' | 'expanded'
  onLevelChange?: (level: 'minimal' | 'expanded') => void
  /** host for WS9's createNavPanel (minimal level, under the position line) */
  readonly navSlot: HTMLElement
  /** host for controls that belong to the expanded level (nav set picker, drag sigma) */
  readonly expSlot: HTMLElement
  destroy(): void
}

const DASH = '—'
export function fmt(v: number | null | undefined, digits = 1, unit = ''): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH
  return `${v.toFixed(digits)}${unit === '°' ? unit : unit ? ' ' + unit : ''}`
}
function signed(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return DASH
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`
}
export function fmtEva(tMin: number): string {
  const s = Math.max(0, Math.round(tMin * 60))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `T+${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function row(parent: HTMLElement, label: string): { v: HTMLElement; sub: HTMLElement; row: HTMLElement } {
  const r = h('div', 'hl-hud-row')
  r.append(h('span', 'hl-hud-k', label))
  const v = h('span', 'hl-hud-v')
  const sub = h('span', 'hl-hud-sub')
  r.append(v, sub)
  parent.append(r)
  return { v, sub, row: r }
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export function createHudPanel(host: HTMLElement, cfg: HudConfig): HudPanel {
  const el = h('div', 'hl-hud-panel')
  const header = h('div', 'hl-hud-header')
  header.append(h('span', 'hl-hud-label', cfg.simulatedLabel))
  const dummyTag = h('span', 'hl-hud-dummy', 'DUMMY DATA')
  dummyTag.hidden = true
  header.append(dummyTag)
  el.append(header)

  const banner = h('div', 'hl-hud-alarm')
  banner.hidden = true
  el.append(banner)

  const min = h('div', 'hl-hud-min')
  const tHome = row(min, 'TIME HOME')
  const margin = row(min, 'MARGIN')
  const o2 = row(min, 'O₂ LEFT / NEED')
  const binding = row(min, 'BINDING')
  const turn = row(min, 'TURN BACK IN')
  const home = row(min, 'ROVER')
  const ribbon = h('div', 'hl-hud-ribbon')
  const ribbonTicks = h('div', 'hl-hud-ribbon-ticks')
  const ribbonHome = h('div', 'hl-hud-ribbon-home', '⌂')
  ribbon.append(ribbonTicks, ribbonHome, h('div', 'hl-hud-ribbon-centre'))
  min.append(ribbon)
  const posLine = h('div', 'hl-hud-pos')
  const fromHere = h('div', 'hl-hud-fromhere')
  fromHere.hidden = true
  const navSlot = h('div', 'hl-hud-navslot')
  min.append(posLine, fromHere, navSlot)
  el.append(min)

  const exp = h('div', 'hl-hud-exp')
  const next = row(exp, 'NEXT STATION')
  const slope = row(exp, 'SLOPE / SPEED CAP')
  const partner = row(exp, 'PARTNER LINE')
  const sun = row(exp, 'SUN / DARK IN')
  const dose = row(exp, 'DOSE RATE')
  const trip = row(exp, 'TRIPWIRE / LEASH')
  const expSlot = h('div', 'hl-hud-expslot')
  const miniHost = h('div', 'hl-hud-minimap')
  exp.append(expSlot, miniHost)
  el.append(exp)

  const toggle = h('button', 'hl-hud-toggle')
  toggle.type = 'button'
  el.append(toggle)
  host.append(el)

  // compass ribbon ticks every 15 deg over 2 turns so a +-90 deg window always has ticks
  const PX_PER_DEG = 1.6
  for (let d = -360; d <= 720; d += 15) {
    const t = h('span', d % 45 === 0 ? 'hl-hud-tick major' : 'hl-hud-tick')
    const norm = ((d % 360) + 360) % 360
    if (norm % 45 === 0) t.textContent = COMPASS[norm / 45]
    t.style.left = `${d * PX_PER_DEG}px`
    ribbonTicks.append(t)
  }

  const rows: Record<PanelRow, HTMLElement> = {
    tHome: tHome.row, margin: margin.row, o2: o2.row, binding: binding.row, turn: turn.row, rover: home.row,
    next: next.row, slope: slope.row, partner: partner.row, sun: sun.row, dose: dose.row, trip: trip.row,
  }
  let lastKeys = ''

  const panel: HudPanel = {
    el,
    level: cfg.defaultLevel,
    navSlot,
    expSlot,
    update(r, pos, x) {
      dummyTag.hidden = !x.dummy
      const keyStr = JSON.stringify(x.sources ?? {})
      if (keyStr !== lastKeys) {
        lastKeys = keyStr
        for (const [name, rowEl] of Object.entries(rows) as [PanelRow, HTMLElement][]) {
          const src = x.sources?.[name]
          if (src && (src.keys.length || src.files.length)) {
            rowEl.dataset.manifestKey = src.keys.join(' ')
            rowEl.dataset.sourceFiles = src.files.join(' ')
            rowEl.title = [src.keys.length ? `manifest: ${src.keys.join(', ')}` : '', `from: ${src.files.join(', ')}`].filter(Boolean).join('\n')
          } else {
            delete rowEl.dataset.manifestKey
            delete rowEl.dataset.sourceFiles
            rowEl.removeAttribute('title')
          }
        }
      }
      // alarm banner
      if (r.alarm) {
        banner.hidden = false
        banner.textContent = r.alarm.text
        banner.dataset.level = r.alarm.level
      } else banner.hidden = true

      const worstTag = r.worstRadiusM && r.worstRadiusM > 0 ? `worst within ${r.worstRadiusM} m` : ''
      tHome.v.textContent = fmt(r.tHomeMin, 1, 'min')
      tHome.sub.textContent = `cons ${fmt(r.tHomeConsMin, 1)}${worstTag ? ' · ' + worstTag : ''}`
      margin.v.textContent = r.marginMin === null ? DASH : `${signed(r.marginMin)} min`
      margin.row.dataset.band = r.band
      o2.v.textContent = `${fmt(r.o2LeftL, 1)} / ${fmt(r.o2NeededL, 2)} L`
      o2.sub.textContent = ''
      if (r.binding === undefined) {
        binding.v.textContent = DASH
        binding.sub.textContent = 'not in timeline'
      } else {
        binding.v.textContent = bindingLabel(r.binding)
        // X2 (D89): the binding term of the exact margin at this minute; after the return the value
        // held at arrival; without margin inputs the timeline row in force (A-WS7-3)
        binding.sub.textContent = r.marginSource === 'exact' ? 'binding limit now' : r.marginSource === 'held' ? 'held at return' : 'planned, timeline row in force'
      }
      turn.v.textContent = r.turnBackInMin === null ? DASH : r.turnBackInMin < 0 ? 'NOW' : `${Math.floor(r.turnBackInMin)} min`
      turn.row.dataset.band = r.band
      turn.sub.textContent = turnBackSub(r)
      home.v.textContent = `${fmt(r.bearingDeg, 0, '°')} · ${r.distanceM >= 1000 ? fmt(r.distanceM / 1000, 2, 'km') : fmt(r.distanceM, 0, 'm')}`
      home.sub.textContent = ''

      const heading = x.headingDeg ?? 0
      ribbonTicks.style.transform = `translateX(${-heading * PX_PER_DEG}px)`
      if (r.bearingDeg === null) ribbonHome.hidden = true
      else {
        ribbonHome.hidden = false
        let rel = ((r.bearingDeg - heading + 540) % 360) - 180
        rel = Math.max(-100, Math.min(100, rel))
        ribbonHome.style.transform = `translateX(${rel * PX_PER_DEG}px)`
      }

      const src = { playback: 'planned route', drag: 'dragged', drift: 'dead reckoning', fix: 'fix' }[pos.source]
      const fix = pos.last_fix ? ` · last fix ${Math.round(pos.t_eva_min - pos.last_fix.t_eva_min)} min ago` : ''
      const nav = !!x.navActive && pos.source !== 'drag'
      posLine.hidden = nav
      navSlot.hidden = !nav
      posLine.textContent = x.navLine && pos.source !== 'drag'
        ? `${x.navLine} · ${fmtEva(pos.t_eva_min)}`
        : `Position: ${src} · ±${Math.round(pos.sigma_m)} m${fix} · ${fmtEva(pos.t_eva_min)}`
      // F18 drag-anywhere: "From here: home in N min (conservative M), O2 needed X L"
      if (pos.source === 'drag') {
        fromHere.hidden = false
        const path = x.wayHome === undefined ? '' : x.wayHome === null ? ' · outside the way-home grid' : !x.wayHome.startKnown ? ' · no way home known from here' : x.wayHome.reachesPad ? ' · way home drawn' : ' · way home ends before the rover'
        fromHere.textContent = `From here: home in ${fmt(r.tHomeMin, 1, 'min')} (conservative ${fmt(r.tHomeConsMin, 1, 'min')}), O₂ needed ${fmt(r.o2NeededL, 2, 'L')}${path}`
      } else fromHere.hidden = true

      if (panel.level === 'expanded') {
        if (r.nextStation) {
          const name = x.stationName?.(r.nextStation.station) ?? r.nextStation.station
          next.v.textContent = `${r.nextStation.station} in ${fmt(r.nextStation.etaMin, 0, 'min')}`
          const tasks = x.stationTasks?.(r.nextStation.station) ?? []
          next.sub.textContent = [name, ...tasks.slice(0, 1)].join(' · ')
        } else {
          next.v.textContent = DASH
          next.sub.textContent = ''
        }
        slope.v.textContent = `${fmt(r.slopeDeg, 1, '°')} / ${r.slopeDeg === null ? DASH : r.vSafeMs === null ? 'no-go' : fmt(r.vSafeMs, 1, 'm/s')}`
        slope.sub.textContent = 'slope cap only (crew.yaml v_safe)'
        partner.v.textContent = r.outsidePartner === null ? DASH : r.outsidePartner ? 'OUTSIDE' : 'inside'
        partner.row.dataset.band = r.outsidePartner ? 'info' : ''
        sun.row.hidden = !x.sun
        if (x.sun) {
          sun.v.textContent = x.sun.value
          sun.sub.textContent = x.sun.sub
          sun.row.dataset.band = x.sun.value === 'DARK' ? 'red' : ''
        }
        const lat = x.rad?.latest
        dose.v.textContent = lat ? fmt(lat.dose_rate_uGy_day, 0, 'µGy/day') : DASH
        dose.sub.textContent = lat?.lag_days != null ? `RAD, ${fmt(lat.lag_days, 0)} days old` : ''
        const tr = tripRowText(x.storm ?? null, x.rad ?? null)
        trip.v.textContent = tr.value
        trip.sub.textContent = tr.sub
        trip.row.dataset.band = tr.band
        if (x.minimap && x.minimap.parentElement !== miniHost) miniHost.append(x.minimap)
      }
    },
    setLevel(level) {
      ;(panel as { level: 'minimal' | 'expanded' }).level = level
      el.dataset.level = level
      exp.hidden = level !== 'expanded'
      toggle.textContent = level === 'expanded' ? 'Less ▴' : 'More ▾'
      toggle.setAttribute('aria-expanded', String(level === 'expanded'))
      panel.onLevelChange?.(level)
    },
    destroy() {
      el.remove()
    },
  }
  toggle.addEventListener('click', () => panel.setLevel(panel.level === 'expanded' ? 'minimal' : 'expanded'))
  panel.setLevel(cfg.defaultLevel)
  return panel
}

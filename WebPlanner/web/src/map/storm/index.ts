// WS16 task 12 (M12): storm mode switch on the planning map (DESIGN U9). Small and JSX-free: the
// toggle writes the mission store (mission.conditions.storm, DESIGN §5.2) and the storm visuals
// (mode.tsx) load with import() the first time the storm is switched on, from this button or any
// other writer of the store (search command, storyboard).
//   ?storm=1         start with the storm on (page or hash query)
//   ?capture=storm   the storm storyboard runs with the storm on: the storyboard contract v1 has no
//                    step key for conditions (notes/M12.md). The storyboard is web/public/story/storm.json.
import type { IControl, Map as MlMap } from 'maplibre-gl'
import { effect, mission } from '../../state'
import { fmtEva } from '../../ui/timeline/model'
import { t } from '../../ui/copy'
import type { StormHandle } from './mode'
import type { StormModel } from './model'
import './storm.css'

/** The storyboard id that runs with the storm on (web/public/story/storm.json). */
export const STORM_STORY_ID = 'storm'

/** `?storm=1`, or `?capture=storm` / the storm storyboard (search or hash query). */
export function stormQuery(search: string, hash: string): boolean {
  const q = new URLSearchParams(search.replace(/^\?/, ''))
  const h = new URLSearchParams(hash.split('?')[1] ?? '')
  const get = (k: string): string | null => q.get(k) ?? h.get(k)
  return get('storm') === '1' || get('capture') === STORM_STORY_ID
}

/** Tooltip of the switch: copy tooltips.storm with the storm date and the tripwire minute (± label). */
export function stormTooltip(m: StormModel | null): string {
  if (!m) return t('tooltips.stormUnavailable')
  const trip = m.replay.stormUtcAtEvaStartMs + m.tFire * 60000
  const date = new Date(trip).toISOString().slice(0, 10)
  return t('tooltips.storm', { storm_date: date, time: `${fmtEva(m.tFire)}${m.halfwidthLabel ? ` ${m.halfwidthLabel}` : ''}` })
}

export class StormControl implements IControl {
  private el: HTMLDivElement | null = null
  private stops: (() => void)[] = []
  private handle: StormHandle | null = null
  private seq = 0

  onAdd(map: MlMap): HTMLElement {
    const box = document.createElement('div')
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group hl-storm-ctrl'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'hl-storm-btn'
    btn.title = t('storm.title')
    btn.addEventListener('click', () => {
      mission.conditions.storm.value = !mission.conditions.storm.peek()
    })
    box.append(btn)
    this.el = box
    this.stops.push(
      effect(() => {
        const on = mission.conditions.storm.value
        btn.textContent = t(on ? 'buttons.stormReplayOn' : 'buttons.stormReplayOff')
        btn.setAttribute('aria-pressed', String(on))
        const seq = ++this.seq
        if (!on) {
          this.handle?.stop()
          this.handle = null
          return
        }
        if (this.handle) return
        void import('./mode')
          .then((m) => m.startStormMode(map))
          .then((h) => {
            if (seq !== this.seq || !mission.conditions.storm.peek()) {
              h?.stop()
              return
            }
            btn.title = stormTooltip(h?.model ?? null)
            if (!h) {
              btn.disabled = true
              mission.conditions.storm.value = false
              return
            }
            this.handle = h
          })
          .catch((e) => {
            console.error('storm mode:', e)
            mission.conditions.storm.value = false
          })
      }),
    )
    return box
  }

  onRemove(): void {
    for (const s of this.stops) s()
    this.stops = []
    this.handle?.stop()
    this.handle = null
    this.el?.remove()
    this.el = null
  }
}

/** Planning-map wiring: the switch, and `?storm=1` / `?capture=storm`. */
export function installStorm(map: MlMap): () => void {
  if (stormQuery(location.search, location.hash)) mission.conditions.storm.value = true
  const ctrl = new StormControl()
  map.addControl(ctrl, 'top-right')
  return () => map.removeControl(ctrl)
}

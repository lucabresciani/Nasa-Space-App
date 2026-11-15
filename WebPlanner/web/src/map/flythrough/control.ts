// WS16 task 10 (M10): the "Flythrough" button of the planning map (DESIGN U6) with its speed control.
// Small and GL-free; the flight itself (fly.ts) loads with import() on the first press.
import type { IControl, Map as MlMap } from 'maplibre-gl'
import { effect, mission, missionClock } from '../../state'
import { t } from '../../ui/copy'
import './flythrough.css'

export class FlythroughControl implements IControl {
  private el: HTMLDivElement | null = null
  private stops: (() => void)[] = []
  private flight: { stop(): void } | null = null
  private flying = false

  onAdd(map: MlMap): HTMLElement {
    const box = document.createElement('div')
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group hl-fly'
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'hl-fly-btn'
    go.textContent = t('buttons.flythrough')
    go.setAttribute('aria-pressed', 'false')
    const speed = document.createElement('button')
    speed.type = 'button'
    speed.className = 'hl-fly-btn hl-fly-speed'
    speed.hidden = true
    const setFlying = (on: boolean): void => {
      this.flying = on
      go.setAttribute('aria-pressed', String(on))
      speed.hidden = !on
    }
    go.addEventListener('click', () => {
      if (this.flying) {
        this.flight?.stop()
        return
      }
      setFlying(true)
      void import('./fly').then(async (m) => {
        if (!this.flying) return
        this.flight = await m.startFlythrough(map, () => {
          this.flight = null
          setFlying(false)
        })
        if (!this.flight) setFlying(false)
      })
    })
    // speed: cycle the mission clock's playback speeds (config/hud.yaml playback_speeds)
    speed.addEventListener('click', () => {
      const sp = missionClock.speeds
      missionClock.setSpeed(sp[(sp.indexOf(missionClock.speed) + 1) % sp.length])
    })
    this.stops.push(
      effect(() => {
        const label = t('buttons.speed', { factor: mission.clock.speed.value })
        speed.textContent = label
        speed.title = label
      }),
    )
    box.append(go, speed)
    this.el = box
    return box
  }

  onRemove(): void {
    this.flight?.stop()
    for (const s of this.stops) s()
    this.stops = []
    this.el?.remove()
    this.el = null
  }
}

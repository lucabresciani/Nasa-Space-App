// WS16 task 10 (M10): the live flythrough (DESIGN U6 "Flythrough"): 3D on, the mission clock plays
// (its speed is the control's), and the camera follows the route from behind and above on every clock
// change, so the timeline scrubs it too. Any input on the map cancels it at once (DESIGN §3.4).
// Loaded with import() on the first press of the Flythrough button.
import type { Map as MlMap } from 'maplibre-gl'
import { CONFIG } from '../../config'
import { effect, mission, missionClock } from '../../state'
import { ELEVATION_FACTOR } from '../../story/config'
import { exaggeration, setView } from '../terrain/state'
import { jumpToPose } from './camera'
import { loadFlightPath } from './route'

const INPUTS = ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const

export async function startFlythrough(map: MlMap, onEnd: () => void): Promise<{ stop(): void } | null> {
  const fp = await loadFlightPath().catch((e) => {
    console.warn('flythrough unavailable:', e)
    return null
  })
  if (!fp) {
    onEnd()
    return null
  }
  setView('3d')
  if (missionClock.t >= fp.plan.tEnd) missionClock.seek(0)
  missionClock.play()
  const el = map.getContainer()
  let raf = 0
  let last = -1
  let stopped = false
  const stopFollow = effect(() => {
    const tm = mission.clock.t.value
    jumpToPose(map, fp.poseAt(tm), { factor: ELEVATION_FACTOR, exaggeration: exaggeration(), radiusM: CONFIG.marsRadiusM })
  })
  // the button itself lives in the map container: input on the controls does not cancel
  const onInput = (e: Event): void => {
    if ((e.target as Element | null)?.closest?.('.maplibregl-ctrl')) return
    stop()
  }
  const stop = (): void => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
    stopFollow()
    for (const ev of INPUTS) el.removeEventListener(ev, onInput, true)
    missionClock.pause()
    onEnd()
  }
  // the planning map has no other clock ticker (A3: one ticker at a time)
  const frame = (now: number): void => {
    if (stopped) return
    if (last >= 0) missionClock.tick(now - last)
    last = now
    if (missionClock.t >= fp.plan.tEnd) return stop()
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  for (const ev of INPUTS) el.addEventListener(ev, onInput, { capture: true, passive: true })
  return { stop }
}

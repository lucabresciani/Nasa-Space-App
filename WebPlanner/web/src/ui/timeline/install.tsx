// Mount the timeline dock into the shell (DESIGN U5; A4's dock registry, store.ts setDockContent).
// Loads the flown plan the HUD and the field fly (scenarios/index.json default, hud.ts / drive.ts rule):
// its timeline, rad.json (D39 storm placement) and clock.json (daylight end), all through the one
// loader. Starts the dock ticker whenever the mission clock plays, whoever pressed play.
import { data } from '../../data/loader'
import { mission, missionClock } from '../../state/mission'
import { effect, signal, useSignalValue, type Signal } from '../../state/signal'
import type { Rad } from '../../hud/types'
import { ensureManifest } from '../../views/common'
import { t } from '../copy'
import { setDockContent } from '../shell/store'
import { buildTimelineModel, type TimelineFileRow, type TimelineModel } from './model'
import { DockTicker } from './ticker'
import { Timeline } from './Timeline'

type DockState = { kind: 'loading' } | { kind: 'none' } | { kind: 'ready'; model: TimelineModel }

export async function loadTimelineModel(): Promise<TimelineModel | null> {
  const L = data()
  await ensureManifest()
  const idx = await L.scenarios()
  const entry = idx.scenarios.find((s) => s.id === idx.default) ?? idx.scenarios[0]
  if (!entry) return null
  const [tl, rad, clock] = await Promise.all([L.optional(() => L.timeline(entry.id)), L.optional(() => L.rad()), L.optional(() => L.clock())])
  if (!tl) return null
  const tDark = (clock as { eva?: { t_dark_min?: number | null } } | null)?.eva?.t_dark_min ?? null
  return buildTimelineModel({
    scenario: entry.id,
    timeline: tl as unknown as TimelineFileRow[],
    tMax: missionClock.tMax,
    rad: rad as unknown as Rad | null,
    tDarkMin: tDark,
  })
}

function Dock({ state, ticker }: { state: Signal<DockState>; ticker: DockTicker }) {
  const s = useSignalValue(state)
  if (s.kind === 'ready') return <Timeline model={s.model} clock={missionClock} ticker={ticker} />
  return <p class="hl-tl__status">{s.kind === 'loading' ? t('states.loading.generic', { what: t('timeline.title') }) : t('timeline.notReady')}</p>
}

export function installTimelineDock(win: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'> | undefined = typeof window === 'undefined' ? undefined : window): () => void {
  const ticker = new DockTicker(missionClock, {
    now: () => performance.now(),
    raf: (cb) => win?.requestAnimationFrame?.(cb) ?? 0,
    caf: (id) => win?.cancelAnimationFrame?.(id),
  })
  const state = signal<DockState>({ kind: 'loading' })
  let alive = true
  setDockContent(() => <Dock state={state} ticker={ticker} />)
  const stop = effect(() => {
    if (mission.clock.playing.value) ticker.start()
  })
  loadTimelineModel()
    .then((model) => {
      if (alive) state.value = model ? { kind: 'ready', model } : { kind: 'none' }
    })
    .catch((e) => {
      console.error(e)
      if (alive) state.value = { kind: 'none' }
    })
  return () => {
    alive = false
    stop()
    ticker.stop()
    setDockContent(undefined)
  }
}

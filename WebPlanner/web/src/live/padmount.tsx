// Mount the pad tool (F24) and the crew panel (F26) into one panel element (the live slot), driven
// by the map through a MapPort. Lazy like the rest of src/live (loaded only behind VITE_LIVE). The
// one-line wiring in the console view is WS5/C's:
//   m.mountPadTool(panelSlot, m.consoleMapPort(cmap, restoreStaticScenario))
import { render } from 'preact'
import type { ApiClient } from './client'
import { createCrew, type CrewModel } from './crew'
import { CrewPanel, crewBlockedText } from './crewview'
import type { MapPort } from './mapPort'
import { createPadTool, type PadTool, type PadToolOptions } from './padtool'
import type { LiveState } from './health'
import { PadToolPanel } from './view'

export interface MountPadToolOptions extends Omit<PadToolOptions, 'client' | 'port' | 'jobInputs'> {
  client: ApiClient
  /** Live state source (index.ts onLiveState: U1's health watch). */
  onLiveState: (fn: (s: LiveState) => void) => () => void
  /** Show the crew panel next to the pad tool (default true); its changed fields go with the full plan. */
  crew?: boolean
}

/** Renders the crew panel and the pad tool into `panel` on every state change; returns cleanup. */
export function mountPadTool(panel: Element, port: MapPort, opts: MountPadToolOptions): { tool: PadTool; crew: CrewModel | null; cleanup: () => void } {
  const { client, onLiveState, crew: withCrew = true, ...rest } = opts
  const crew = withCrew ? createCrew({ client }) : null
  const tool = createPadTool({ client, port, ...rest, ...(crew ? { jobInputs: () => crew.jobInputs() } : {}) })
  const engineHref = `${client.root}/engine/version`
  let ready = false
  const draw = () => {
    if (!ready) return
    render(
      <>
        {crew ? <CrewPanel state={crew.state} actions={crew} engineHref={engineHref} /> : null}
        <PadToolPanel state={tool.state} actions={tool} engineHref={engineHref} computeBlocked={crew ? crewBlockedText(crew.state) : null} />
      </>,
      panel,
    )
  }
  const offState = tool.subscribe(draw)
  const offCrew = crew ? crew.subscribe(draw) : () => {}
  ready = true
  draw()
  const offLive = onLiveState((s) => {
    crew?.setLive(s)
    tool.setLive(s)
  })
  const offClick = port.onClick((p) => tool.click(p))
  return {
    tool,
    crew,
    cleanup() {
      offClick()
      offLive()
      offState()
      offCrew()
      tool.dispose()
      crew?.dispose()
      render(null, panel)
    },
  }
}

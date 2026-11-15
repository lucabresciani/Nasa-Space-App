// Known answers for H2 step 3 (kit rule 4: "With /health unreachable for 2 s, live controls hide
// behind the offline banner"), mid-session: /health is polled while ready; a failed poll moves the
// state to offline within one poll interval plus the 2 s timeout; the server coming back moves it to
// ready; a live request failing (network or 5xx) checks at once; polling pauses on page hide and
// stops on unmount; the pad tool, the permalink actions and the sim slot hide while offline, and a
// permalink shows the offline text at once (no 15 s request timeout) even for a plan already loaded.
import type { ComponentChildren } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { CLIENT, HEALTH_TIMEOUT_MS, OFFLINE_LABEL } from './config'
import { watchHealth, type LiveState, type VisibilitySource } from './health'
import { mountLive, onLiveState } from './index'
import type { MapPort } from './mapPort'
import { HEALTH_WARM, RUN_RECORD_LIVE } from './mock/fixtures'
import { createMockFetch, type MockOptions } from './mock/fetch'
import { MOCK_SIM_FILE, mockFinishedTree } from './mock/result'
import { MOCK_PAD_VALID } from './mock/pads'
import { createPadTool } from './padtool'
import { mountPlanRoute } from './planmount'
import { mockLiveLoader } from './result'
import { textOf, toHtml } from './testing/html'
import type { RunRecord } from './types'
import { PadToolPanel } from './view'

const BANNER = 'Live planning is offline · showing precomputed plans'
const LIVE_HASH = (RUN_RECORD_LIVE as RunRecord).hash

/** A mock API that can be killed and restarted mid-session; 'hang' accepts and never answers. */
function server(opts: MockOptions = {}) {
  const inner = createMockFetch({ health: HEALTH_WARM, trees: { [LIVE_HASH]: mockFinishedTree(true) }, ...opts })
  const ctl = { mode: 'up' as 'up' | 'down' | 'hang', health: 0, hangPaths: new Set<string>() }
  const fetch = (input: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(input).pathname.replace(/^\/api\/v1/, '')
    if (path === '/health') ctl.health++
    if (ctl.mode === 'down') return Promise.reject(new TypeError('Failed to fetch'))
    if (ctl.mode === 'hang' || ctl.hangPaths.has(path)) {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    }
    return inner(input, init)
  }
  const client = createApiClient({ base: 'http://api.test', fetch })
  return { ctl, client, fetch, loaderFor: mockLiveLoader(inner) }
}

function fakeVisibility() {
  let fn: (() => void) | null = null
  const v = {
    hidden: false,
    addEventListener: (_: 'visibilitychange', f: () => void) => void (fn = f),
    removeEventListener: () => void (fn = null),
    set(hidden: boolean) {
      v.hidden = hidden
      fn?.()
    },
    get listening() {
      return fn !== null
    },
  }
  return v
}

describe('health poll while ready (H2 step 3)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the poll interval is an assumed client constant of 3 s; each check keeps the 2 s timeout', () => {
    expect(CLIENT.healthPollMs).toBe(3000)
    expect(HEALTH_TIMEOUT_MS).toBe(2000)
  })

  it('ready -> offline within one interval plus 2 s when the server dies (refused and hanging)', async () => {
    for (const death of ['down', 'hang'] as const) {
      const { ctl, client } = server()
      const states: LiveState[] = []
      const stop = watchHealth(client, (s) => states.push(s), { visibility: null })
      await vi.advanceTimersByTimeAsync(0)
      expect(states.at(-1)!.kind).toBe('ready')
      await vi.advanceTimersByTimeAsync(1) // killed just after a successful check: the worst case
      ctl.mode = death
      await vi.advanceTimersByTimeAsync(CLIENT.healthPollMs + HEALTH_TIMEOUT_MS - 2)
      expect(states.at(-1)!.kind, death).toBe(death === 'down' ? 'offline' : 'ready')
      await vi.advanceTimersByTimeAsync(1)
      expect(states.at(-1), death).toEqual({ kind: 'offline', reason: death === 'down' ? 'unreachable' : 'timeout' })
      stop()
    }
  })

  it('offline -> ready when the server comes back', async () => {
    const { ctl, client } = server()
    ctl.mode = 'down'
    const states: string[] = []
    const stop = watchHealth(client, (s) => states.push(s.kind), { visibility: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual(['checking', 'offline'])
    await vi.advanceTimersByTimeAsync(CLIENT.healthPollMs)
    expect(states.at(-1)).toBe('offline')
    ctl.mode = 'up'
    await vi.advanceTimersByTimeAsync(CLIENT.healthPollMs)
    expect(states.at(-1)).toBe('ready')
    stop()
  })

  it('stop() ends polling: no /health request after unmount', async () => {
    const { ctl, client } = server()
    const stop = watchHealth(client, () => {}, { visibility: null })
    await vi.advanceTimersByTimeAsync(CLIENT.healthPollMs * 2)
    expect(ctl.health).toBe(3)
    stop()
    await vi.advanceTimersByTimeAsync(CLIENT.healthPollMs * 10)
    expect(ctl.health).toBe(3)
  })

  it('page hidden pauses polling, shown checks at once and resumes; unmount drops the listener', async () => {
    const { ctl, client } = server()
    const vis = fakeVisibility()
    const states: string[] = []
    const stop = watchHealth(client, (s) => states.push(s.kind), { visibility: vis as VisibilitySource })
    await vi.advanceTimersByTimeAsync(0)
    expect(ctl.health).toBe(1)
    vis.set(true)
    ctl.mode = 'down'
    await vi.advanceTimersByTimeAsync(CLIENT.healthPollMs * 10)
    expect(ctl.health).toBe(1)
    vis.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(ctl.health).toBe(2)
    expect(states.at(-1)).toBe('offline')
    await vi.advanceTimersByTimeAsync(CLIENT.healthPollMs)
    expect(ctl.health).toBe(3)
    stop()
    expect(vis.listening).toBe(false)
  })

  it('check() runs a check now instead of waiting for the next poll', async () => {
    const { ctl, client } = server()
    const states: string[] = []
    const watch = watchHealth(client, (s) => states.push(s.kind), { visibility: null })
    await vi.advanceTimersByTimeAsync(0)
    ctl.mode = 'down'
    watch.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(ctl.health).toBe(2)
    expect(states.at(-1)).toBe('offline')
    watch()
    watch.check() // after stop: nothing
    await vi.advanceTimersByTimeAsync(0)
    expect(ctl.health).toBe(2)
  })
})

// mountLive with a minimal DOM stand-in (vitest runs in node), as in index.test.ts.
function fakeDocument() {
  const made: { hidden: boolean; textContent: string; dataset: Record<string, string>; className: string }[] = []
  return {
    made,
    doc: {
      createElement: () => {
        const el = { className: '', hidden: false, textContent: '', dataset: {}, setAttribute() {}, remove() {} }
        made.push(el)
        return el
      },
    },
  }
}

describe('mountLive: banner and live controls follow the health poll', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const mount = (s: ReturnType<typeof server>) => {
    const { doc, made } = fakeDocument()
    vi.stubGlobal('document', doc)
    const cleanup = mountLive({ after: () => {} } as unknown as Element, s.client)
    return { line: made[0], cleanup }
  }

  it('server killed mid-session: the exact banner returns and the pad tool hides; back when it returns', async () => {
    const s = server()
    const { line, cleanup } = mount(s)
    const port: MapPort = { onClick: () => () => {}, setLivePad() {}, setScenarioData: async () => {}, setRoute: async () => {}, restoreStatic() {} }
    const tool = createPadTool({ client: s.client, port })
    const offLive = onLiveState((st) => tool.setLive(st)) // what mountPadTool does
    const panel = () => toHtml(<PadToolPanel state={tool.state} actions={tool} engineHref="x" />)
    await vi.advanceTimersByTimeAsync(0)
    expect(line.hidden).toBe(true)
    expect(panel()).toContain('live-pad')

    s.ctl.mode = 'hang'
    await vi.advanceTimersByTimeAsync(CLIENT.healthPollMs + HEALTH_TIMEOUT_MS)
    expect(line.hidden).toBe(false)
    expect(line.textContent).toBe(BANNER)
    expect(line.textContent).toBe(OFFLINE_LABEL)
    expect(line.dataset.state).toBe('offline')
    expect(panel()).toBe('')

    s.ctl.mode = 'up'
    await vi.advanceTimersByTimeAsync(CLIENT.healthPollMs)
    expect(line.hidden).toBe(true)
    expect(line.dataset.state).toBe('ready')
    expect(panel()).toContain('live-pad')
    offLive()
    cleanup()
    const n = s.ctl.health
    await vi.advanceTimersByTimeAsync(CLIENT.healthPollMs * 5)
    expect(s.ctl.health, 'polling stops on unmount').toBe(n)
  })

  it('a 5xx from a live request checks /health at once', async () => {
    const s = server({ padError: { status: 503, body: { error: 'unavailable' } } })
    const { line, cleanup } = mount(s)
    await vi.advanceTimersByTimeAsync(0)
    expect(s.ctl.health).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(s.client.validatePad(MOCK_PAD_VALID)).rejects.toMatchObject({ status: 503 })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.ctl.health, 'checked without waiting for the next poll').toBe(2)
    expect(line.dataset.state).toBe('ready') // /health itself still answers ok
    cleanup()
  })

  it('a network error from a live request checks at once and the banner shows', async () => {
    const s = server()
    const { line, cleanup } = mount(s)
    await vi.advanceTimersByTimeAsync(0)
    s.ctl.mode = 'down'
    await expect(s.client.validatePad(MOCK_PAD_VALID)).rejects.toMatchObject({ status: 0, code: 'network' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.ctl.health).toBe(2)
    expect(line.textContent).toBe(BANNER)
    cleanup()
  })

  it('a 4xx answer is the server working: no extra check', async () => {
    const s = server()
    const { cleanup } = mount(s)
    await vi.advanceTimersByTimeAsync(0)
    await expect(s.client.provenance('ffffffffffffffff')).rejects.toMatchObject({ status: 404 })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.ctl.health).toBe(1)
    cleanup()
  })
})

// mountPlanRoute with a DOM stand-in; the render seam captures what would be drawn in the box.
function planHarness(s: ReturnType<typeof server>, initial: LiveState) {
  let hashListener: (() => void) | null = null
  const loc = { hash: '#/', origin: 'https://x.test', pathname: '/' }
  vi.stubGlobal('location', loc)
  vi.stubGlobal('window', {
    addEventListener: (_: string, f: () => void) => void (hashListener = f),
    removeEventListener: () => void (hashListener = null),
  })
  const box = { className: '', hidden: true, textContent: '', remove() {}, querySelector: () => null }
  vi.stubGlobal('document', { createElement: () => box })
  const outlet = { hidden: false, after() {} }
  const app = { querySelector: () => outlet } as unknown as HTMLElement
  let drawn: ComponentChildren = null
  let live = initial
  const subs = new Set<(st: LiveState) => void>()
  const cleanup = mountPlanRoute(app, {
    client: s.client,
    loaderFor: s.loaderFor,
    simEnabled: true,
    mountMap: null,
    render: (v) => void (drawn = v),
    onLiveState: (fn) => {
      subs.add(fn)
      fn(live)
      return () => subs.delete(fn)
    },
  })
  return {
    cleanup,
    go(h: string) {
      loc.hash = h
      hashListener?.()
    },
    setLive(st: LiveState) {
      live = st
      for (const fn of subs) fn(st)
    },
    text: () => textOf(drawn),
    html: () => toHtml(drawn),
  }
}

const OFFLINE: LiveState = { kind: 'offline', reason: 'unreachable' }
const READY: LiveState = { kind: 'ready', health: HEALTH_WARM }

describe('permalink views follow the health state', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('a plan loaded earlier hides Play, Export and the sim slot and shows the offline text when health goes offline', async () => {
    const s = server()
    const h = planHarness(s, READY)
    h.go(`#/plan/${LIVE_HASH}`)
    await vi.waitFor(() => expect(h.text()).toContain('Play this plan'))
    expect(h.html()).toContain('live-export')
    expect(h.html()).toContain(MOCK_SIM_FILE)

    h.setLive(OFFLINE)
    expect(h.text()).toContain(`${BANNER}. This plan needs the live server.`)
    expect(h.html()).not.toContain('live-play')
    expect(h.html()).not.toContain('live-export')
    expect(h.html()).not.toContain('live-sim')

    // the play and provenance views of the cached plan too
    h.go(`#/plan/${LIVE_HASH}/play`)
    expect(h.text()).toContain(BANNER)
    expect(h.html()).not.toContain('live-play-hud')
    h.go(`#/plan/${LIVE_HASH}`)
    expect(h.text()).toContain(BANNER)

    // back online: the cached plan shows again with its actions
    h.setLive(READY)
    await vi.waitFor(() => expect(h.text()).toContain('Play this plan'))
    expect(h.html()).toContain(MOCK_SIM_FILE)
    h.cleanup()
  })

  it('health already offline: the offline text at once, no request (no 15 s timeout)', async () => {
    const s = server()
    s.ctl.mode = 'hang'
    const h = planHarness(s, OFFLINE)
    h.go(`#/plan/${LIVE_HASH}`)
    expect(h.text()).toContain(`${BANNER}. This plan needs the live server.`)
    expect(h.html()).not.toContain('live-actions')
    h.cleanup()
  })

  it('a load still waiting on a hanging server switches to the offline text as soon as health says offline', async () => {
    const s = server()
    s.ctl.hangPaths.add(`/results/${LIVE_HASH}/provenance`)
    const h = planHarness(s, READY)
    h.go(`#/plan/${LIVE_HASH}`)
    expect(h.text()).toContain('Loading')
    h.setLive(OFFLINE)
    expect(h.text()).toContain(BANNER)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.text()).toContain(BANNER) // the stale load never overwrites it
    h.cleanup()
  })

  it('warming and checking do not block a permalink (the server answers results while warming)', async () => {
    const s = server()
    const h = planHarness(s, { kind: 'checking' })
    h.go(`#/plan/${LIVE_HASH}`)
    await vi.waitFor(() => expect(h.text()).toContain('Play this plan'))
    h.setLive({ kind: 'warming', health: { ...HEALTH_WARM, engine_warm: false } })
    expect(h.text()).toContain('Play this plan')
    h.cleanup()
  })
})

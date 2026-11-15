// mountLive end to end with a minimal DOM stand-in (vitest runs in node): the mounted status line
// shows the offline text after 2 s without an answer, the warming text, then hides when ready.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { mountLive, onLiveState, LIVE_LABEL, type LiveState } from './index'
import { HEALTH_COLD, HEALTH_WARM } from './mock/fixtures'
import { createMockFetch, type MockHealth } from './mock/fetch'

interface FakeEl {
  className: string
  hidden: boolean
  textContent: string
  dataset: Record<string, string>
  attrs: Record<string, string>
  removed: boolean
  setAttribute(k: string, v: string): void
  remove(): void
}

function fakeDom() {
  const made: FakeEl[] = []
  const doc = {
    createElement: () => {
      const el: FakeEl = {
        className: '', hidden: false, textContent: '', dataset: {}, attrs: {}, removed: false,
        setAttribute(k, v) { this.attrs[k] = v },
        remove() { this.removed = true },
      }
      made.push(el)
      return el
    },
  }
  const anchor = { after: vi.fn() }
  return { doc, anchor, made }
}

describe('mountLive', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const mount = (health: MockHealth) => {
    const { doc, anchor, made } = fakeDom()
    vi.stubGlobal('document', doc)
    const client = createApiClient({ base: 'http://api.test', fetch: createMockFetch({ health }) })
    const cleanup = mountLive(anchor as unknown as Element, client)
    return { line: made[0], anchor, cleanup }
  }

  it('shows exactly the offline text when /health does not answer in 2 s', async () => {
    const { line, anchor, cleanup } = mount('hang')
    expect(anchor.after).toHaveBeenCalledWith(line)
    expect(line.attrs.role).toBe('status')
    await vi.advanceTimersByTimeAsync(1999)
    expect(line.hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(line.hidden).toBe(false)
    expect(line.textContent).toBe('Live planning is offline · showing precomputed plans')
    expect(line.dataset.state).toBe('offline')
    cleanup()
    expect(line.removed).toBe(true)
  })

  it('warming then ready: the line hides and subscribers see the states', async () => {
    const states: LiveState['kind'][] = []
    const off = onLiveState((s) => states.push(s.kind))
    const { line, cleanup } = mount([HEALTH_COLD, HEALTH_WARM])
    await vi.advanceTimersByTimeAsync(0)
    expect(line.textContent).toBe('Live planning is warming up · showing precomputed plans')
    expect(line.dataset.tone).toBe('warn')
    await vi.advanceTimersByTimeAsync(3000)
    expect(line.hidden).toBe(true)
    expect(line.dataset.state).toBe('ready')
    expect(states.slice(-3)).toEqual(['checking', 'warming', 'ready'])
    off()
    cleanup()
  })

  it('exports the live label for later views', () => {
    expect(LIVE_LABEL).toBe('Computed live · not part of the validated scorecard')
  })
})

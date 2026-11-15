// Known-answer tests: health check, offline banner, warm transition (F23, kit rule 4).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { HEALTH_TIMEOUT_MS, OFFLINE_LABEL } from './config'
import { bannerFor, checkHealth, watchHealth, type LiveState } from './health'
import { HEALTH_COLD, HEALTH_NOT_OK, HEALTH_WARM } from './mock/fixtures'
import { createMockFetch, type MockHealth } from './mock/fetch'

const client = (health: MockHealth) => createApiClient({ base: 'http://api.test', fetch: createMockFetch({ health }) })

describe('health check', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('timeout is api.health_timeout_s = 2 s', () => {
    expect(HEALTH_TIMEOUT_MS).toBe(2000)
  })

  it('is offline after 2 s with no answer, not before', async () => {
    let state: LiveState | undefined
    void checkHealth(client('hang')).then((s) => (state = s))
    await vi.advanceTimersByTimeAsync(1999)
    expect(state).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(state).toEqual({ kind: 'offline', reason: 'timeout' })
    expect(bannerFor(state!).text).toBe('Live planning is offline · showing precomputed plans')
  })

  it('is offline on a not-ok health answer', async () => {
    const s = await checkHealth(client(HEALTH_NOT_OK))
    expect(s).toEqual({ kind: 'offline', reason: 'not-ok' })
    expect(bannerFor(s)).toMatchObject({ text: OFFLINE_LABEL, controls: false })
  })

  it('is offline on an HTTP error, a network error and a malformed body', async () => {
    expect(await checkHealth(client({ status: 503 }))).toEqual({ kind: 'offline', reason: 'not-ok' })
    expect(await checkHealth(client('down'))).toEqual({ kind: 'offline', reason: 'unreachable' })
    const bad = createApiClient({ base: 'http://api.test', fetch: async () => new Response('{"ok": true}') })
    expect(await checkHealth(bad)).toEqual({ kind: 'offline', reason: 'invalid' })
  })

  it('is warming while engine_warm is false, ready when warm', async () => {
    const warming = await checkHealth(client(HEALTH_COLD))
    expect(warming.kind).toBe('warming')
    expect(bannerFor(warming)).toMatchObject({ text: 'Live planning is warming up · showing precomputed plans', controls: false })
    const ready = await checkHealth(client(HEALTH_WARM))
    expect(ready.kind).toBe('ready')
    expect(bannerFor(ready)).toMatchObject({ text: null, controls: true, heavyJobs: true })
    expect(bannerFor(await checkHealth(client({ ...HEALTH_WARM, heavy_jobs: 'off' }))).heavyJobs).toBe(false)
  })

  it('watchHealth moves checking -> warming -> ready and keeps polling while ready (H2 step 3)', async () => {
    const fetch = createMockFetch({ health: [HEALTH_COLD, HEALTH_COLD, HEALTH_WARM] })
    const c = createApiClient({ base: 'http://api.test', fetch })
    const states: string[] = []
    const stop = watchHealth(c, (s) => states.push(s.kind), { warmPollMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual(['checking', 'warming'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(states).toEqual(['checking', 'warming', 'warming'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(states).toEqual(['checking', 'warming', 'warming', 'ready'])
    // ready: re-checked every CLIENT.healthPollMs (3 s), no longer at warmPollMs
    await vi.advanceTimersByTimeAsync(2999)
    expect(fetch.calls.filter((c) => c.path === '/health')).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch.calls.filter((c) => c.path === '/health')).toHaveLength(4)
    expect(states.at(-1)).toBe('ready')
    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch.calls.filter((c) => c.path === '/health')).toHaveLength(4)
  })

  it('watchHealth stop() ends a pending check silently', async () => {
    const states: string[] = []
    const stop = watchHealth(client('hang'), (s) => states.push(s.kind))
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(states).toEqual(['checking'])
  })
})

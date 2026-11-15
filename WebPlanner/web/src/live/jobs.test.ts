// Known-answer tests: job submit + poll with backoff, staged callbacks, failure, cancel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { startJob, type JobOutcome } from './jobs'
import { failedJobScript, jobScript, MOCK_STAGES, PLAN_INPUTS_OFFICIAL } from './mock/fixtures'
import { createMockFetch, type MockOptions } from './mock/fetch'
import type { Job } from './types'

const BASE = 'http://api.test'
const setup = (o: MockOptions = {}) => {
  const fetch = createMockFetch(o)
  return { fetch, client: createApiClient({ base: BASE, fetch }) }
}
const req = { type: 'plan' as const, inputs: PLAN_INPUTS_OFFICIAL }

describe('startJob', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reaches done through every stage, in order, each once', async () => {
    const { client, fetch } = setup()
    const stages: [string, string][] = []
    const statuses: string[] = []
    const h = startJob(client, req, {
      onStage: (s, _j, base) => stages.push([s, base]),
      onUpdate: (j) => statuses.push(`${j.status}:${j.stage ?? '-'}`),
    })
    let out: JobOutcome | undefined
    void h.promise.then((o) => (out = o))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(out?.status).toBe('done')
    const resultBase = `${BASE}/api/v1/results/0123456789abcdef`
    expect(out).toMatchObject({ status: 'done', resultBase })
    expect(stages).toEqual(MOCK_STAGES.map((s) => [s, resultBase]))
    expect(statuses).toEqual(['queued:-', 'running:nominal', 'running:bands', 'running:hud', 'done:-'])
    // one submit, then one poll per later state; the request body is the JobRequest
    expect(fetch.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /jobs', ...Array(4).fill('GET /jobs/j_01')])
    expect(fetch.calls[0].body).toEqual(req)
  })

  it('polls with growing waits (backoff) capped at pollMaxMs', async () => {
    const running = jobScript()[1]
    const script: Job[] = [jobScript()[0], ...Array(8).fill(running)]
    const { client, fetch } = setup({ job: script })
    const times: number[] = []
    const t0 = Date.now()
    startJob(client, req, { pollInitialMs: 100, pollFactor: 2, pollMaxMs: 500, onUpdate: () => times.push(Date.now() - t0) })
    await vi.advanceTimersByTimeAsync(2_000)
    // submit at 0; polls after 100, 200, 400, 500, 500 ... ms
    expect(times.slice(0, 6)).toEqual([0, 100, 300, 700, 1200, 1700])
    expect(fetch.calls.length).toBe(6)
  })

  it('a failed job surfaces its error', async () => {
    const { client } = setup({ job: failedJobScript('engine_error: no route within the walkback budget') })
    const h = startJob(client, req)
    await vi.advanceTimersByTimeAsync(60_000)
    const out = await h.promise
    expect(out).toMatchObject({ status: 'failed', error: 'engine_error: no route within the walkback budget' })
    expect(out.status === 'failed' && out.job?.status).toBe('error')
  })

  it('a server timeout or refusal is a failure with the status as error when no message is given', async () => {
    const s = jobScript()
    const { client } = setup({ job: [s[0], { ...s[1], status: 'timeout', stage: null }] })
    const h = startJob(client, req)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await h.promise).toMatchObject({ status: 'failed', error: 'timeout' })
  })

  it('a rate-limited submit fails with retry_after_s', async () => {
    const { client } = setup({ submitError: { status: 429, body: { error: 'rate_limited', retry_after_s: 42 } } })
    const out = await startJob(client, req).promise
    expect(out).toEqual({ status: 'failed', job: null, error: 'rate_limited', retryAfterS: 42 })
  })

  it('gives up client-side when a running job outlives the running limit', async () => {
    const s = jobScript()
    const { client } = setup({ job: [s[0], s[1]] })
    const h = startJob(client, req, { runningTimeoutMs: 3_000, pollInitialMs: 1000, pollFactor: 1 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await h.promise).toMatchObject({ status: 'failed', error: 'client_timeout' })
  })

  it('cancel() (unmount) stops polling and aborts the request in flight', async () => {
    const running = jobScript()[1]
    const { client, fetch } = setup({ job: [jobScript()[0], ...Array(50).fill(running)] })
    const h = startJob(client, req, { pollInitialMs: 100, pollFactor: 1 })
    await vi.advanceTimersByTimeAsync(250)
    const n = fetch.calls.length
    h.cancel()
    const out = await h.promise
    expect(out.status).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch.calls.length).toBe(n)
  })

  it('an external AbortSignal cancels too, and a hanging poll is cut by the request timeout', async () => {
    const s = jobScript()
    let polls = 0
    const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') return new Response(JSON.stringify(s[0]), { status: 202 })
      polls++
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }
    const client = createApiClient({ base: BASE, fetch, requestTimeoutMs: 1000 })
    const h = startJob(client, req, { pollInitialMs: 100, pollFactor: 1 })
    await vi.advanceTimersByTimeAsync(20_000)
    // three consecutive timed-out polls -> failed with the timeout code
    expect(await h.promise).toMatchObject({ status: 'failed', error: 'timeout' })
    expect(polls).toBe(3)

    const ctl = new AbortController()
    const h2 = startJob(client, req, { signal: ctl.signal })
    await vi.advanceTimersByTimeAsync(600)
    ctl.abort()
    expect((await h2.promise).status).toBe('cancelled')
  })
})

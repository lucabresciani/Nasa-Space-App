// MARVIS bridge: detection is silent off the loopback address and on plain static hosts; the
// mission hand-over reports the simulator's reason; the walked track is read by column name.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvaLog } from './bridge'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A fresh copy of the module (detect() caches), with the page at `hostname`. */
async function bridgeAt(hostname: string, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.resetModules()
  vi.stubGlobal('location', { hostname })
  const fetchMock = vi.fn(fetchImpl)
  vi.stubGlobal('fetch', fetchMock)
  return { b: await import('./bridge'), fetchMock }
}

afterEach(() => vi.unstubAllGlobals())

describe('detect', () => {
  it('does not ask at all on a public host', async () => {
    const { b, fetchMock } = await bridgeAt('luxkaiwalker.github.io', async () => json({ app: 'MARVIS' }))
    expect(await b.detect()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is true when hello says MARVIS, and asks once', async () => {
    const { b, fetchMock } = await bridgeAt('127.0.0.1', async () => json({ app: 'MARVIS', bridge: 1, version: '1.0' }))
    expect(await b.detect()).toBe(true)
    expect(await b.detect()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/marvis/api/hello')
  })

  it('is false on a plain static host: 404, an HTML fallback page, another app', async () => {
    expect(await (await bridgeAt('localhost', async () => new Response('Not found', { status: 404 }))).b.detect()).toBe(false)
    expect(await (await bridgeAt('localhost', async () => new Response('<!doctype html>', { status: 200 }))).b.detect()).toBe(false)
    expect(await (await bridgeAt('localhost', async () => json({ app: 'other' }))).b.detect()).toBe(false)
  })

  it('is false when the request fails', async () => {
    const { b } = await bridgeAt('127.0.0.1', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await b.detect()).toBe(false)
  })

  it('tries again after a timeout', async () => {
    let n = 0
    const { b, fetchMock } = await bridgeAt('127.0.0.1', async () => {
      if (n++ === 0) throw new DOMException('timed out', 'TimeoutError')
      return json({ app: 'MARVIS' })
    })
    expect(await b.detect()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('sendMission', () => {
  it('posts the document with the X-Marvis header', async () => {
    const { b, fetchMock } = await bridgeAt('127.0.0.1', async () => json({ ok: true, mission_id: 'm-1' }))
    expect(await b.sendMission({ kind: 'homeline_mission' })).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/marvis/api/mission')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'X-Marvis': '1', 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({ kind: 'homeline_mission' })
  })

  it("returns the simulator's reason on 422", async () => {
    const { b } = await bridgeAt('127.0.0.1', async () => json({ ok: false, error: 'pad mismatch' }, 422))
    expect(await b.sendMission({})).toEqual({ ok: false, error: 'pad mismatch' })
  })

  it('reports a refusal without a reason, and no answer', async () => {
    expect(await (await bridgeAt('127.0.0.1', async () => new Response('', { status: 403 }))).b.sendMission({})).toEqual({ ok: false, error: 'HTTP 403' })
    const { b } = await bridgeAt('127.0.0.1', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await b.sendMission({})).toEqual({ ok: false, error: 'MARVIS did not answer' })
  })
})

describe('fetchEvaLog and trackLonLat', () => {
  const log = {
    kind: 'homeline_eva_log',
    summary: { complete: true },
    track: {
      columns: ['t_min', 'lon', 'lat', 'elev_m', 'cross_track_m', 'schedule_delta_min', 'o2_used_l', 'o2_delta_l', 'margin_min', 'status'],
      rows: [
        [0, 137.4, -4.6, -4400, 0, 0, 0, 0, 60, 'ON PLAN'],
        [0.083, null, null, null, null, null, 0.1, 0, 60, 'ON PLAN'],
        [0.167, 137.401, -4.601, -4400, 1, 0, 0.2, 0, 60, 'ON PLAN'],
      ],
    },
  } as unknown as EvaLog

  it('returns the log, or null when there is none or it is another document', async () => {
    expect(await (await bridgeAt('127.0.0.1', async () => json(log))).b.fetchEvaLog()).toEqual(log)
    expect(await (await bridgeAt('127.0.0.1', async () => json({ ok: false, error: 'no log' }, 404))).b.fetchEvaLog()).toBeNull()
    expect(await (await bridgeAt('127.0.0.1', async () => json({ kind: 'homeline_mission' }))).b.fetchEvaLog()).toBeNull()
  })

  it('reads lon and lat by column name and leaves unknown positions out', async () => {
    const { b } = await bridgeAt('127.0.0.1', async () => json({}))
    expect(b.trackLonLat(log)).toEqual([
      [137.4, -4.6],
      [137.401, -4.601],
    ])
    expect(b.trackLonLat({ ...log, track: { columns: ['t_min'], rows: [[0]] } })).toEqual([])
  })
})

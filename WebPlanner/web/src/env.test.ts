import { afterEach, describe, expect, it, vi } from 'vitest'
import { dataDir, dataUrl } from './env'
import { browserFetcher } from './data/loader'

// Known answers for the loader base URL (backend plan 0.8, kit bootstrap step 7, D48/F23).
// The static URL is `${BASE_URL}data/<path>` or `${BASE_URL}data-dummy/<path>` (BASE_URL is './' in
// builds per vite.config.ts and '/' under vitest), exactly as before the optional `base` argument.
const BASE = import.meta.env.BASE_URL

describe('dataUrl without base: byte-for-byte the static URL', () => {
  it('real mode', () => {
    expect(dataUrl('scenarios.json', 'real')).toBe(`${BASE}data/scenarios.json`)
    expect(dataUrl('pads/a/isochrones.geojson', 'real')).toBe(`${BASE}data/pads/a/isochrones.geojson`)
  })

  it('dummy mode', () => {
    expect(dataUrl('scenarios.json', 'dummy')).toBe(`${BASE}data-dummy/scenarios.json`)
    expect(dataUrl('pads/a/isochrones.geojson', 'dummy')).toBe(`${BASE}data-dummy/pads/a/isochrones.geojson`)
  })

  it('leading slashes on the path are stripped (as before)', () => {
    expect(dataUrl('/scenarios.json', 'real')).toBe(`${BASE}data/scenarios.json`)
    expect(dataUrl('///x/y.json', 'dummy')).toBe(`${BASE}data-dummy/x/y.json`)
  })

  it('base undefined or empty is the static URL, identical to the 2-argument call', () => {
    for (const mode of ['real', 'dummy'] as const) {
      const legacy = `${BASE}${dataDir(mode)}/a/b.json`
      expect(dataUrl('a/b.json', mode)).toBe(legacy)
      expect(dataUrl('a/b.json', mode, undefined)).toBe(legacy)
      expect(dataUrl('a/b.json', mode, '')).toBe(legacy)
    }
  })
})

describe('dataUrl with base: <base without trailing slash>/<path without leading slash>', () => {
  const live = 'https://api.example.test/api/v1/results/abc123'

  it('plain join', () => {
    expect(dataUrl('scenarios.json', 'real', live)).toBe(`${live}/scenarios.json`)
  })

  it('mode does not matter: no data/ or data-dummy/ segment', () => {
    expect(dataUrl('pads/a/x.json', 'real', live)).toBe(`${live}/pads/a/x.json`)
    expect(dataUrl('pads/a/x.json', 'dummy', live)).toBe(`${live}/pads/a/x.json`)
  })

  it('trailing slashes on base and leading slashes on path collapse to one', () => {
    expect(dataUrl('x.json', 'real', `${live}/`)).toBe(`${live}/x.json`)
    expect(dataUrl('/x.json', 'real', `${live}///`)).toBe(`${live}/x.json`)
    expect(dataUrl('//x.json', 'real', live)).toBe(`${live}/x.json`)
  })

  it('relative and root-relative bases', () => {
    expect(dataUrl('x.json', 'real', '/api/v1/results/h')).toBe('/api/v1/results/h/x.json')
    expect(dataUrl('x.json', 'real', './live/')).toBe('./live/x.json')
  })

  it('does not encode or otherwise rewrite the path', () => {
    expect(dataUrl('a b/c?.json', 'real', live)).toBe(`${live}/a b/c?.json`)
  })
})

describe('browserFetcher passes base through to dataUrl', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stubFetch = () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return new Response('{"ok":true}', { status: 200 })
    })
    return urls
  }

  it('default (no base) fetches the static URL', async () => {
    const urls = stubFetch()
    expect(await browserFetcher('real')('scenarios.json')).toBe('{"ok":true}')
    expect(await browserFetcher('dummy')('scenarios.json')).toBe('{"ok":true}')
    expect(urls).toEqual([`${BASE}data/scenarios.json`, `${BASE}data-dummy/scenarios.json`])
  })

  it('with base fetches <base>/<path>', async () => {
    const urls = stubFetch()
    await browserFetcher('real', 'https://h.test/api/v1/results/abc/')('/pads/a/x.json')
    expect(urls).toEqual(['https://h.test/api/v1/results/abc/pads/a/x.json'])
  })
})

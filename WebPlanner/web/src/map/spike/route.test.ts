// WS16 M1: the #/spike page is registered (lazy, in main.ts) and never linked from the nav.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO } from '../../hud/testutil'
import { href, isSpikeHash, NAV_ITEMS, parseRoute } from '../../router'
import { FpsMeter, RateCounter } from './fps'

describe('#/spike route', () => {
  it.each(['#/spike', '#/spike/', '#/spike?path=canvas', '/spike?hz=60', '#/spike?unknown=thome'])('%s is the spike', (h) => expect(isSpikeHash(h)).toBe(true))
  it.each(['', '#/', '#/spiked', '#/x/spike', '#/hud', '#/scorecard?key=spike'])('%s is not', (h) => expect(isSpikeHash(h)).toBe(false))

  it('is not linked from the nav', () => {
    for (const item of NAV_ITEMS) {
      expect(item.route.name).not.toBe('spike')
      expect(isSpikeHash(href(item.route))).toBe(false)
    }
  })
  it('does not change the existing routes (still "notfound" for the parser)', () => {
    expect(parseRoute('#/spike')).toEqual({ name: 'notfound', path: '/spike' })
  })
  it('main.ts dispatches it with a dynamic import only (no static import of the spike)', () => {
    const main = readFileSync(resolve(REPO, 'web/src/main.ts'), 'utf8')
    expect(main).toMatch(/isSpikeHash\(location\.hash\)/)
    expect(main).toMatch(/await import\('\.\/map\/spike\/view'\)/)
    expect(main).not.toMatch(/^import .*map\/spike/m)
  })
  it('no other source file links to #/spike', () => {
    for (const f of ['web/src/router.ts', 'web/src/views/index.ts', 'web/index.html']) {
      expect(readFileSync(resolve(REPO, f), 'utf8')).not.toMatch(/href=["'`]#\/spike/)
    }
  })
})

describe('fps meter', () => {
  it('60 Hz frames read 60 fps', () => {
    const m = new FpsMeter()
    for (let i = 0; i <= 120; i++) m.frame(i * (1000 / 60))
    const s = m.stats()
    expect(s.fps).toBeCloseTo(60, 0)
    expect(s.maxMs).toBeCloseTo(1000 / 60, 3)
  })
  it('a 100 ms hitch shows in max and lowers fps', () => {
    const m = new FpsMeter()
    let t = 0
    for (let i = 0; i < 50; i++) m.frame((t += 1000 / 60))
    m.frame((t += 100))
    const s = m.stats()
    expect(s.maxMs).toBeCloseTo(100, 6)
    expect(s.fps).toBeLessThan(60)
  })
  it('rate counter: 30 ticks in a second = 30/s', () => {
    const r = new RateCounter()
    for (let i = 0; i < 30; i++) r.tick(i * (1000 / 30))
    expect(r.rate(999)).toBe(30)
  })
})

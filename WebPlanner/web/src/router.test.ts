import { describe, expect, it } from 'vitest'
import { canonicalHref, href, isLegacy, legacyParam, NAV_ITEMS, parseRoute, redirectFor, type Route } from './router'

describe('hash router (SPEC F17 routes; mount slot for WS7)', () => {
  it.each([
    ['', { name: 'console' }],
    ['#/', { name: 'console' }],
    ['#/station/S1', { name: 'station', id: 'S1' }],
    ['#/trade', { name: 'trade' }],
    ['#/conditions', { name: 'conditions' }],
    ['#/scorecard', { name: 'scorecard' }],
    ['#/scorecard?key=rad.baseline_uGy_day', { name: 'scorecard', key: 'rad.baseline_uGy_day' }],
    ['#/cuff', { name: 'cuff' }],
    ['#/about', { name: 'about' }],
    ['#/hud', { name: 'hud' }],
    ['#/hud3d', { name: 'hud' }],
    ['#/nav', { name: 'scorecard' }],
    ['#/nope', { name: 'notfound', path: '/nope' }],
    ['#/station', { name: 'notfound', path: '/station' }],
  ])('%s', (hash, want) => expect(parseRoute(hash)).toEqual(want))

  it('href round-trips', () => {
    for (const r of [{ name: 'station', id: 'S 4' } as const, { name: 'scorecard', key: 'a.b' } as const, { name: 'trade' } as const]) {
      expect(parseRoute(href(r))).toEqual(r)
    }
  })

  it('the nav lists every page and slot', () => {
    expect(NAV_ITEMS.map((n) => n.route.name)).toEqual(['console', 'trade', 'conditions', 'cuff', 'hud', 'scorecard', 'about'])
  })
})

// DESIGN §4.2 (WS15 task 4, A4): old URLs redirect into their mode; nothing breaks.
describe('mode routes and redirects (DESIGN §4.2)', () => {
  /** Every existing route: [old hash, route, canonical mode hash]. */
  const TABLE: [string, Route, string][] = [
    ['#/', { name: 'console' }, '#/'],
    ['#/station/S1', { name: 'station', id: 'S1' }, '#/station/S1'],
    ['#/trade', { name: 'trade' }, '#/trade'],
    ['#/conditions', { name: 'conditions' }, '#/fly/conditions'],
    ['#/hud', { name: 'hud' }, '#/fly/hud'],
    ['#/cuff', { name: 'cuff' }, '#/report/cuff'],
    ['#/scorecard', { name: 'scorecard' }, '#/evidence/scorecard'],
    ['#/scorecard?key=rad.baseline_uGy_day', { name: 'scorecard', key: 'rad.baseline_uGy_day' }, '#/evidence/scorecard?key=rad.baseline_uGy_day'],
    ['#/about', { name: 'about' }, '#/evidence/about'],
  ]

  it.each(TABLE)('old %s resolves and has a canonical mode hash', (old, route, canon) => {
    expect(parseRoute(old)).toEqual(route)
    expect(canonicalHref(route)).toBe(canon)
    expect(parseRoute(canon)).toEqual(route)
  })

  it.each(TABLE)('%s redirects to its mode route (or stays when already canonical)', (old, _route, canon) => {
    expect(redirectFor(old)).toBe(old === canon ? null : canon)
    expect(redirectFor(canon)).toBeNull() // no loops
  })

  it.each([
    ['#/fly', '#/fly/hud'],
    ['#/report', '#/report/cuff'],
    ['#/evidence', '#/evidence/scorecard'],
    ['#/fly/', '#/fly/hud'],
  ])('bare mode path %s opens the mode default %s', (bare, want) => expect(redirectFor(bare)).toBe(want))

  it('keeps extra query parameters (legacy, deep-link key) across the redirect', () => {
    expect(redirectFor('#/hud?legacy=hud')).toBe('#/fly/hud?legacy=hud')
    expect(redirectFor('#/scorecard?key=a.b&legacy=1')).toBe('#/evidence/scorecard?key=a.b&legacy=1')
  })

  it('never redirects unknown paths or the live plan namespace (#/plan/{hash}, F28)', () => {
    for (const h of ['#/nope', '#/plan', '#/plan/abc123', '#/plan/abc123/play', '#/fly/nope', '#/fly/hud/x', '#/toString', '#/styleguide']) {
      expect(redirectFor(h)).toBeNull()
    }
    expect(parseRoute('#/fly/nope')).toEqual({ name: 'notfound', path: '/fly/nope' })
    expect(parseRoute('#/toString')).toEqual({ name: 'notfound', path: '/toString' })
  })

  it('href() keeps writing the old paths, which still parse (legacy layout links, <Num> scorecard links)', () => {
    for (const [, route] of TABLE) expect(parseRoute(href(route))).toEqual(route)
  })
})

// D98 / D99: the navigation add-on and the first-person 3D view are removed; their old links land on
// EVIDENCE and on the 2D HUD (FLY), never on "Not found".
describe('removed views redirect (D98 /nav -> Evidence, D99 /hud3d -> Fly 2D)', () => {
  it.each([
    ['#/nav', '#/evidence/scorecard'],
    ['#/evidence/nav', '#/evidence/scorecard'],
    ['#/nav/', '#/evidence/scorecard'],
    ['#/hud3d', '#/fly/hud'],
    ['#/fly/3d', '#/fly/hud'],
    ['#/hud3d/', '#/fly/hud'],
  ])('%s redirects to %s', (old, want) => {
    expect(redirectFor(old)).toBe(want)
    expect(redirectFor(want)).toBeNull()
  })

  it('keeps the legacy switch across the redirect', () => {
    expect(redirectFor('#/nav?legacy=1')).toBe('#/evidence/scorecard?legacy=1')
    expect(redirectFor('#/fly/3d?legacy=hud')).toBe('#/fly/hud?legacy=hud')
  })

  it('no route, link or nav entry names the removed views', () => {
    expect(NAV_ITEMS.map((n) => n.route.name)).not.toContain('nav')
    expect(NAV_ITEMS.map((n) => n.route.name)).not.toContain('hud3d')
    expect(parseRoute('#/evidence/nav')).toEqual({ name: 'scorecard' })
    expect(parseRoute('#/fly/3d')).toEqual({ name: 'hud' })
  })
})

// MARVIS build: the Mission Planer page (#/mission), a PLAN view that keeps its URL.
describe('mission route (MARVIS build)', () => {
  it.each([
    ['#/mission', { name: 'mission' }],
    ['#/mission?plan=WzEsW11d', { name: 'mission', plan: 'WzEsW11d' }],
    ['#/mission?add=S4', { name: 'mission', add: 'S4' }],
    ['#/mission/x', { name: 'notfound', path: '/mission/x' }],
  ])('%s', (hash, want) => expect(parseRoute(hash)).toEqual(want))

  it('href round-trips and is the canonical hash: the shell never redirects it', () => {
    for (const r of [{ name: 'mission' } as const, { name: 'mission', plan: 'a-b_c', add: 'S1' } as const]) {
      expect(parseRoute(href(r))).toEqual(r)
      expect(canonicalHref(r)).toBe(href(r))
      expect(redirectFor(href(r))).toBeNull()
    }
  })
})

describe('?legacy switch (DESIGN U0, kit rule 10)', () => {
  it('reads the page query first, then the hash query', () => {
    expect(legacyParam('?legacy=1', '#/trade')).toBe('1')
    expect(legacyParam('', '#/trade?legacy=trade')).toBe('trade')
    expect(legacyParam('?legacy=hud', '#/trade?legacy=trade')).toBe('hud')
    expect(legacyParam('', '#/trade')).toBeNull()
    expect(legacyParam('?x=1', '#/scorecard?key=a')).toBeNull()
  })

  it.each([
    ['1', 'trade', true],
    ['true', 'console', true],
    ['', 'hud', true],
    ['all', 'about', true],
    ['hud', 'hud', true],
    ['hud', 'trade', false],
    ['console,scorecard', 'scorecard', true],
    ['console,scorecard', 'cuff', false],
    [null, 'console', false],
  ] as const)('legacy=%s on %s -> %s', (param, name, want) => {
    expect(isLegacy(param, parseRoute(`#/${name === 'console' ? '' : name}`))).toBe(want)
  })
})

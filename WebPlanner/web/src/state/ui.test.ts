import { describe, expect, it } from 'vitest'
import { parseRoute, REMOVED_PATHS } from '../router'
import { ROUTE_MODE } from './ui'

describe('ROUTE_MODE', () => {
  it('has one key per live route and none for the removed views (D98, D99)', () => {
    expect(Object.keys(ROUTE_MODE).sort()).toEqual(
      ['about', 'conditions', 'console', 'cuff', 'hud', 'mission', 'scorecard', 'station', 'trade'], // mission: MARVIS build (Mission Planer)
    )
    expect(ROUTE_MODE).not.toHaveProperty('hud3d')
    expect(ROUTE_MODE).not.toHaveProperty('nav')
  })

  it('maps every removed path to the mode of the view it redirects to', () => {
    for (const path of Object.keys(REMOVED_PATHS)) {
      const route = parseRoute('#' + path)
      expect(ROUTE_MODE[route.name], path).toBeDefined()
    }
    expect(ROUTE_MODE[parseRoute('#/hud3d').name]).toBe('fly')
    expect(ROUTE_MODE[parseRoute('#/nav').name]).toBe('evidence')
  })
})

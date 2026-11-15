import { describe, expect, it } from 'vitest'
import type { Station } from '../data/types'
import { stationWaypoint } from './stations'

const st = (o: Partial<Station> = {}): Station =>
  ({
    id: 'S2',
    name: 'Fracture-network survey',
    lon: 137.37544,
    lat: -4.778796,
    dwell_min: 30,
    access: { nom_104: { lon: 137.376083, lat: -4.778391, dist_m: 44.9, t_home_min: 40, o2_home_L: 40, reason: null, walk_in: null } },
    ...o,
  }) as unknown as Station

describe('station -> waypoint (Mission Planer ?add=)', () => {
  it("goes to the scenario's access cell (WS2), stops for the station dwell, carries the id", () => {
    expect(stationWaypoint(st(), 'nom_104')).toEqual({ lon: 137.376083, lat: -4.778391, stopMin: 30, tags: [], note: 'S2 · Fracture-network survey', station: 'S2' })
  })
  it('no access data for the scenario: the science point', () => {
    const w = stationWaypoint(st(), 'con_120')!
    expect([w.lon, w.lat]).toEqual([137.37544, -4.778796])
  })
  it('WS2 says no access cell: null (no invented point)', () => {
    const s = st({ access: { nom_104: { lon: null, lat: null, dist_m: null, t_home_min: null, o2_home_L: null, reason: 'too steep', walk_in: null } } } as unknown as Partial<Station>)
    expect(stationWaypoint(s, 'nom_104')).toBeNull()
  })
  it('the note keeps the full station name', () => {
    expect(stationWaypoint(st({ id: 'S6', name: 'dense ridge network + high SINDEX2 sulfate signal (south-west, nearer)' }), 'nom_104')!.note).toBe(
      'S6 · dense ridge network + high SINDEX2 sulfate signal (south-west, nearer)',
    )
  })
})

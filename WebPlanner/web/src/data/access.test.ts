import { describe, expect, it } from 'vitest'
import type { Card, Station } from './types'
import { accessFor, walkInLines } from './access'

// Shapes from WS2's real stations.json / cards (12:01 CET run), trimmed.
const S2: Station = {
  id: 'S2',
  name: 'Fracture-network survey',
  lon: 137.383058,
  lat: -4.776687,
  value: 0.7443,
  objective: '',
  tasks: [],
  dwell_min: 30,
  t_home_min: { nom_104: 71.01 },
  in_partner_line: false,
  card: 'cards/S2.json',
  access_radius_m: 50,
  access: {
    nom_104: {
      lon: 137.382736,
      lat: -4.777025,
      dist_m: 27.6,
      t_home_min: 71.01,
      o2_home_L: 95.56,
      reason: null,
      walk_in: { dist_m: 27.6, modelled: false, rise_m: 7.79, mean_slope_deg: 15.77, max_slope_deg: 21.99, max_terrain_slope_deg: 43.44 },
    },
  },
}
const REASON = '38 assessed cells within 50 m, none with a walk home in this scenario'
const S1: Station = {
  ...S2,
  id: 'S1',
  lon: 137.391523,
  lat: -4.810007,
  t_home_min: { nom_104: null },
  card: 'cards/S1.json',
  access: { nom_104: { lon: null, lat: null, dist_m: null, t_home_min: null, o2_home_L: null, reason: REASON, walk_in: null } },
}
const LEGACY: Station = { ...S2, id: 'S9', access: undefined, access_radius_m: undefined }

describe('access-cell rule display (user 11:40)', () => {
  it('science point stays the station coordinate; access point and walk-in come from the scenario', () => {
    const a = accessFor(S2, 'nom_104')
    expect(a.science).toEqual({ lon: 137.383058, lat: -4.776687 })
    expect(a.access).toEqual({ lon: 137.382736, lat: -4.777025 })
    expect(a.dist_m).toBe(27.6)
    expect(a.walkIn?.rise_m).toBe(7.79)
    expect(a.radius_m).toBe(50)
    expect(a.state).toBe('access')
    expect(a.file).toBe('stations.json')
    expect(a.keyPrefix).toBe('access.S2.nom_104')
  })
  it('no access cell: access null, the reason from the data, never a made-up point', () => {
    const a = accessFor(S1, 'nom_104')
    expect(a.access).toBeNull()
    expect(a.dist_m).toBeNull()
    expect(a.state).toBe('none')
    expect(a.reason).toBe(REASON)
  })
  it('a card access block wins over stations.json (card is the merged per-station file)', () => {
    const card = { access: { ...S2.access!.nom_104, dist_m: 27.6, radius_m: 50, rule: 'nearest…' } } as unknown as Card
    const a = accessFor(S2, 'nom_104', card)
    expect(a.file).toBe('cards/S2.json')
    expect(a.keyPrefix).toBe('card.S2.access')
    expect(a.rule).toBe('nearest…')
  })
  it('stations without access data (older producer): state unknown, nothing invented', () => {
    const a = accessFor(LEGACY, 'nom_104')
    expect(a.state).toBe('unknown')
    expect(a.access).toBeNull()
  })
  it('walk-in lines: one science->access line per station with an access cell, none at 0 m', () => {
    const S4 = { ...S2, id: 'S4', access: { nom_104: { ...S2.access!.nom_104, lon: S2.lon, lat: S2.lat, dist_m: 0 } } }
    const fc = walkInLines([S1, S2, S4, LEGACY], 'nom_104')
    expect(fc.features).toHaveLength(1)
    const f = fc.features[0]
    expect(f.properties).toEqual({ station: 'S2', dist_m: 27.6 })
    expect(f.geometry.coordinates).toEqual([
      [137.383058, -4.776687],
      [137.382736, -4.777025],
    ])
  })
})

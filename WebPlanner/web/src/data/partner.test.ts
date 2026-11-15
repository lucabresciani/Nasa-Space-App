import { describe, expect, it } from 'vitest'
import { CONFIG } from '../config'
import { dragFinding, dragKeyPrefix, drawnPartner, partnerLabel, partnerScenarioId } from './partner'
import type { PartnerFC } from './types'

const NOTE = 'One astronaut cannot drag a suited crewmate on Mars without a cart or sled: the pull needed exceeds boot grip even on flat ground.'
const feat = (props: Record<string, unknown>) => ({ type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [] }, properties: props })

// scenarios/nom_104/partner.geojson as WS2 session 4 writes it (D20: cart only + drag_finding).
const REAL_SHAPE = {
  type: 'FeatureCollection',
  drag_finding: { case: 'drag', theta_deg: 0, force_N: 398.454, traction_limit_N: 350.595, max_mass_kg: 157.5, feasible: false, reason: 'traction', note: NOTE },
  features: [
    feat({ case: 'cart', casualty_kg: 179, label: 'Partner line (cart haul, 60 min)', drag_note: NOTE }),
    feat({ case: 'cart', casualty_kg: 343, label: 'Partner line (cart haul, 60 min)', drag_note: NOTE }),
  ],
} as unknown as PartnerFC

// The tree on main before D20: drag features still in the file, no label, no finding.
const OLD_SHAPE = {
  type: 'FeatureCollection',
  features: [feat({ case: 'cart', casualty_kg: 179 }), feat({ case: 'drag', casualty_kg: 179 }), feat({ case: 'drag', casualty_kg: 343, feasible: false })],
} as unknown as PartnerFC

describe('D20 partner line (cart only)', () => {
  it('label from partner.geojson `label`', () => {
    expect(partnerLabel(REAL_SHAPE)).toBe('Partner line (cart haul, 60 min)')
  })
  it('label falls back to config/haul.yaml partner_label filled from partner_cases and contour_min', () => {
    expect(partnerLabel(OLD_SHAPE)).toBe('Partner line (cart haul, 60 min)')
    expect(partnerLabel(null)).toBe('Partner line (cart haul, 60 min)')
    expect(CONFIG.haulPartnerCases).toEqual(['cart'])
  })
  it('drag-case features are never drawn', () => {
    expect(drawnPartner(OLD_SHAPE).features.map((f) => f.properties?.case)).toEqual(['cart'])
    expect(drawnPartner(REAL_SHAPE).features).toHaveLength(2)
  })
  it('drag finding read from the top-level member; null when the file has none', () => {
    const d = dragFinding(REAL_SHAPE)!
    expect([d.force_N, d.traction_limit_N, d.max_mass_kg, d.feasible]).toEqual([398.454, 350.595, 157.5, false])
    expect(d.note).toBe(NOTE)
    expect(dragFinding(OLD_SHAPE)).toBeNull()
    expect(dragFinding(null)).toBeNull()
  })
  it('note text: file, else config/haul.yaml drag_note (same wording, SPEC F10)', () => {
    expect(CONFIG.haulDragNote).toBe(NOTE)
  })
  it('manifest key prefix: bare haul.drag.flat for the default scenario file, per scenario otherwise', () => {
    expect(partnerScenarioId('scenarios/nom_104/partner.geojson')).toBe('nom_104')
    expect(dragKeyPrefix('scenarios/nom_104/partner.geojson', 'scenarios/nom_104/partner.geojson')).toBe('haul.drag.flat')
    expect(dragKeyPrefix('scenarios/nom_80/partner.geojson', 'scenarios/nom_104/partner.geojson')).toBe('haul.drag.flat.nom_80')
  })
})

import { describe, expect, it } from 'vitest'
import { landmarkKey, marginLabel } from './station'

describe('station card helpers', () => {
  it('margin_binding null (no route, contract v1.1.1) says so instead of a blank', () => {
    expect(marginLabel(null)).toMatch(/no route/)
    expect(marginLabel('dose')).toBe('radiation dose')
    expect(marginLabel('O2')).toBe('oxygen')
    expect(marginLabel(undefined)).toBe('unknown')
  })
  it('landmark manifest keys follow WS3 cards.py (landmark.{S}.{Name_With_Underscores}.{field})', () => {
    expect(landmarkKey('S1', 'Gediz Vallis', 'bearing_deg')).toBe('landmark.S1.Gediz_Vallis.bearing_deg')
  })
})

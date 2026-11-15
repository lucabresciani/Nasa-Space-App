// DESIGN §9 "Contrast" (WS15 acceptance): text ≥ 4.5:1, large text and UI parts ≥ 3:1 on every token
// pair used. Ratios are computed from tokens.json (WCAG 2.x relative luminance).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, MIN_RATIO, SURFACES, TEXT_TOKENS, tokenContrast, USED_PAIRS } from './contrast'

describe('contrast maths', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 6)
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2)
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1)
  })
})

describe('token contrast (DESIGN §9)', () => {
  for (const fg of TEXT_TOKENS) {
    for (const bg of SURFACES) {
      it(`text token ${fg} on ${bg} ≥ 4.5:1`, () => {
        expect(tokenContrast(fg, bg)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
  for (const p of USED_PAIRS) {
    it(`${p.fg} on ${p.bg} (${p.use}: ${p.where}) ≥ ${MIN_RATIO[p.use]}:1`, () => {
      expect(tokenContrast(p.fg, p.bg)).toBeGreaterThanOrEqual(MIN_RATIO[p.use])
    })
  }

  it('component CSS uses text-faint only on disabled controls', () => {
    const css = readFileSync(new URL('./components/components.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    const bad = rules.filter(([, sel, body]) => /(^|[^-])color:\s*var\(--color-text-faint\)/.test(body) && !/disabled/.test(sel)).map(([, sel]) => sel.trim())
    expect(bad).toEqual([])
  })

  it('component CSS puts limit-coloured text only where USED_PAIRS allows it (never on card)', () => {
    const css = readFileSync(new URL('./components/components.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    const bad = rules
      .filter(([, , body]) => /(^|[^-])color:\s*var\(--color-limit\)/.test(body) && /background(-color)?:\s*var\(--color-card\)/.test(body))
      .map(([, sel]) => sel.trim())
    expect(bad).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { hatchUnknown } from './hatch'

describe('hatchUnknown: unknown cells (field PNG alpha = 0) become a hatch, known cells stay clear', () => {
  const w = 8
  const h = 8
  // left half unknown (A = 0), right half valid (A = 255)
  const alpha = new Uint8ClampedArray(w * h).map((_, i) => (i % w < 4 ? 0 : 255))
  const line: [number, number, number, number] = [200, 200, 200, 220]
  const fill: [number, number, number, number] = [120, 120, 120, 60]
  const out = hatchUnknown(alpha, w, h, { period: 4, lineWidth: 1, line, fill })
  const px = (x: number, y: number) => Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 4))

  it('known cells are fully transparent', () => {
    for (let y = 0; y < h; y++) for (let x = 4; x < w; x++) expect(px(x, y)[3]).toBe(0)
  })

  it('unknown cells on a diagonal get the line colour, others the fill', () => {
    expect(px(0, 0)).toEqual(line) // (0+0) % 4 = 0 < 1
    expect(px(1, 3)).toEqual(line) // 4 % 4 = 0
    expect(px(1, 0)).toEqual(fill)
    expect(px(3, 3)).toEqual(fill)
  })

  it('every unknown cell is painted (unknown stays visible)', () => {
    for (let y = 0; y < h; y++) for (let x = 0; x < 4; x++) expect(px(x, y)[3]).toBeGreaterThan(0)
  })

  it('rejects a size mismatch', () => {
    expect(() => hatchUnknown(alpha, w + 1, h, { period: 4, lineWidth: 1, line, fill })).toThrow()
  })
})

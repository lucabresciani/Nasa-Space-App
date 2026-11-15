// WS16 task 4 (M4) acceptance tests, CPU mirror of the collapse (brief WS16 "Acceptance tests",
// DESIGN U3 + §9 "Collapse": k = 0 circle radius 1,764 m within one cell; k = 1 equals the band;
// counted headline equals the manifest; reduced motion has no intermediate k). Real published tree.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { readJson, readPngRGBA, REPO } from '../../hud/testutil'
import type { FieldsIndex } from '../../hud/types'
import { effect, ui } from '../../state'
import tokens from '../../ui/tokens.json'
import {
  collapseBandClass,
  collapseFade,
  collapseFrame,
  collapseHeadline,
  collapseQuery,
  collapseT,
  COLLAPSE_MS,
  currentCollapse,
  easeInOut,
  flatMinutes,
  flatRadiusM,
  headlineCount,
  padDistance,
  padGridMetres,
  playCollapse,
  resetCollapse,
  setCollapse,
} from './collapse'
import { COLLAPSE, FIELD_LAYER, VARIANTS } from './constants'
import { bandClass, bilinear, decodeGrid, decodeState, FieldData, pixelOf, stateAt, valueAtPixel, type Bounds, type DecodedGrid } from './decode'
import { headlineParts } from './collapseUi'
import { FS } from './shader'

const PUB = resolve(REPO, 'web/public/data')
const index = readJson<FieldsIndex>('fields/index.json', PUB)
const SUIT = 104
const RES = index.res_m as number

function grid(key: string): DecodedGrid {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return decodeGrid(rgba, width, height, meta.scale, index.bounds as Bounds)
}
const cs = readJson<{ image: string; bounds: Bounds; width: number; height: number }>('terrain/cellstate.json', PUB)
const csPng = readPngRGBA(resolve(PUB, cs.image))
const state = decodeState(csPng.rgba, csPng.width, csPng.height, cs.bounds)
const t = { opt: grid(`opt_${SUIT}/t_home`), nom: grid(`nom_${SUIT}/t_home`), con: grid(`con_${SUIT}/t_home`) }
const field = new FieldData(SUIT, t, grid(`nom_${SUIT}/o2_home`), state, [], RES)
const padFile = readJson<{ pad: { lon: number; lat: number } }>('pad.json', PUB)
const PAD = padGridMetres(t.nom, RES, padFile.pad.lon, padFile.pad.lat)
const manifest = readJson<Record<string, { value: unknown; file: string }>>('manifest.json', PUB)
const scenarios = readJson<{ default: string; scenarios: { id: string; headline: { budget_min: number; reachable_pct: number; range_pct: [number, number] }; headline_60?: { budget_min: number; reachable_pct: number; range_pct: [number, number]; in_data_pct?: number } }[] }>('scenarios/index.json', PUB)
const designYaml = (() => {
  // config/design.yaml lands with the design branch; until then constants.ts holds the D1 copy
  try {
    return parse(readFileSync(resolve(REPO, 'config/design.yaml'), 'utf8')) as { field_layer: { flat_speed_ms: number; flat_radius_m: Record<string, number> }; collapse: { duration_s: number; easing: string } }
  } catch {
    return null
  }
})()

/** Grid metres (x east, y south of the NW corner) -> lon/lat. */
function lonLatOfGridM(x: number, y: number): [number, number] {
  const [w, s, e, n] = index.bounds as Bounds
  return [w + (x / RES / index.width) * (e - w), n - (y / RES / index.height) * (n - s)]
}

afterEach(() => {
  resetCollapse()
  field.setCollapse(null, 1)
})

describe('constants (D25, DESIGN U3/§3.4)', () => {
  it('flat circle = flat speed x budget: 1,764 m at 30 min, 3,528 m at 60', () => {
    expect(FIELD_LAYER.flatSpeedMs).toBe(0.98)
    expect(flatRadiusM(30)).toBe(1764)
    expect(flatRadiusM(60)).toBe(3528)
    for (const b of [30, 60]) expect(flatMinutes(flatRadiusM(b))).toBeCloseTo(b, 12)
  })
  it('3 s ease-in-out from tokens motion.collapseMs (= design.yaml collapse)', () => {
    expect(COLLAPSE_MS).toBe(tokens.motion.collapseMs)
    expect(COLLAPSE_MS).toBe(COLLAPSE.durationS * 1000)
    expect(COLLAPSE.easing).toBe('ease-in-out')
    if (designYaml) {
      expect(designYaml.collapse.duration_s).toBe(COLLAPSE.durationS)
      expect(designYaml.collapse.easing).toBe(COLLAPSE.easing)
      expect(designYaml.field_layer.flat_speed_ms).toBe(FIELD_LAYER.flatSpeedMs)
      expect(designYaml.field_layer.flat_radius_m['30'] ?? designYaml.field_layer.flat_radius_m[30 as unknown as string]).toBe(1764)
    }
  })
  it('ease-in-out is the CSS curve: 0 -> 0, 1 -> 1, symmetric, flat at both ends, monotonic', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9)
    for (const x of [0.1, 0.2, 0.3, 0.4]) expect(easeInOut(x) + easeInOut(1 - x)).toBeCloseTo(1, 9)
    expect(easeInOut(0.01)).toBeLessThan(0.001)
    expect(1 - easeInOut(0.99)).toBeLessThan(0.001)
    // CSS cubic-bezier(0.42, 0, 0.58, 1) reference values (browser timing function)
    expect(easeInOut(0.25)).toBeCloseTo(0.1291, 3)
    for (let i = 1; i <= 100; i++) expect(easeInOut(i / 100)).toBeGreaterThanOrEqual(easeInOut((i - 1) / 100))
  })
})

describe('pad position (u_pad)', () => {
  it('pad.json lands on the official pad pixel (row 401, col 973; t_home 0.1 min there)', () => {
    expect(pixelOf(t.nom, padFile.pad.lon, padFile.pad.lat)).toEqual({ row: 401, col: 973 })
    expect(valueAtPixel(t.nom, 401, 973)).toBeCloseTo(0.1, 9)
    expect(padDistance(t.nom, RES, PAD, padFile.pad.lon, padFile.pad.lat)).toBeCloseTo(0, 9)
  })
})

describe('k = 0: the flat circle (DESIGN U3 acceptance)', () => {
  // Walk 720 rays from the pad; the drawn edge (last pixel classed in the band) must sit at the
  // flat radius within one field cell (5 m). Rays leaving the field grid first are skipped (the
  // 60-min circle runs off the grid to the north and east; nothing is drawn outside it).
  const edgeOnRay = (theta: number, budget: number): number | null => {
    const R = flatRadiusM(budget)
    let last: number | null = null
    for (let r = R - 40; r <= R + 40; r += 0.25) {
      const [lon, lat] = lonLatOfGridM(PAD[0] + r * Math.cos(theta), PAD[1] + r * Math.sin(theta))
      if (!pixelOf(t.nom, lon, lat)) return null
      if (field.bandClassAt(lon, lat, budget) !== 'none') last = r
    }
    return last
  }
  for (const budget of [30, 60]) {
    it(`budget ${budget}: edge radius ${flatRadiusM(budget)} m within one ${RES} m cell on every ray inside the grid`, () => {
      field.setCollapse(PAD, 0)
      let n = 0
      for (let i = 0; i < 720; i++) {
        const r = edgeOnRay((i / 720) * 2 * Math.PI, budget)
        if (r === null) continue
        n++
        expect(Math.abs(r - flatRadiusM(budget)), `ray ${i}`).toBeLessThanOrEqual(RES)
      }
      expect(n).toBeGreaterThan(budget === 30 ? 700 : 100) // the 30-min circle is wholly inside the grid
    })
  }
  it('k = 0 fills the whole disc (all three variants equal; densest fill) and nothing beyond', () => {
    field.setCollapse(PAD, 0)
    for (let i = 0; i < 2000; i++) {
      const r = (i % 50) * 50
      const th = i * 2.399963
      const [lon, lat] = lonLatOfGridM(PAD[0] + r * Math.cos(th), PAD[1] + r * Math.sin(th))
      if (!pixelOf(t.nom, lon, lat)) continue
      expect(field.bandClassAt(lon, lat, 30)).toBe(r <= 1764 - RES ? 'con' : r >= 1764 + RES ? 'none' : field.bandClassAt(lon, lat, 30))
    }
  })
})

describe('k = 1 equals the M2 band classification exactly', () => {
  it('every field pixel centre and three sub-pixel offsets, budgets 30 and 60', () => {
    field.setCollapse(PAD, 1)
    const [w, s, e, n] = index.bounds as Bounds
    let checked = 0
    for (let row = 0; row < index.height; row += 3) {
      for (let col = 0; col < index.width; col += 3) {
        for (const [dx, dy] of [[0.5, 0.5], [0.1, 0.8], [0.9, 0.3]]) {
          const lon = w + ((col + dx) / index.width) * (e - w)
          const lat = n - ((row + dy) / index.height) * (n - s)
          const drawn = { opt: bilinear(t.opt, lon, lat), nom: bilinear(t.nom, lon, lat), con: bilinear(t.con, lon, lat) }
          const st = stateAt(state, lon, lat)
          for (const b of [30, 60]) {
            const m2 = bandClass(drawn, st === 'unknown' || st === 'outside', b)
            expect(field.bandClassAt(lon, lat, b)).toBe(m2)
          }
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(700000)
  }, 60000)
  it('collapseT is bit-exact at both ends; fieldAt t equals the drawn T_home at k = 1', () => {
    for (const [f, th] of [[12.345, 67.891], [0.1, 0.30000000000000004], [29.9999, null]] as [number, number | null][]) {
      expect(collapseT(f, th, 1)).toBe(th)
      expect(collapseT(f, th, 0)).toBe(f)
    }
    field.setCollapse(PAD, 1)
    for (let i = 0; i < 500; i++) {
      const [lon, lat] = lonLatOfGridM(37 + ((i * 97) % 7300), 41 + ((i * 53) % 7300))
      const sm = field.at(lon, lat)
      expect(sm.t).toBe(sm.drawn.nom)
      expect(sm.k).toBe(1)
    }
  })
  it('without a pad (collapse off) the class is M2 bandClass for any stored k', () => {
    field.setCollapse(null, 0)
    const [lon, lat] = lonLatOfGridM(PAD[0] + 1000, PAD[1])
    const sm = field.at(lon, lat)
    expect(sm.k).toBe(1)
    expect(sm.t).toBe(sm.drawn.nom)
  })
})

describe('between the ends (deterministic, monotone melt)', () => {
  it('T(k) = flat + (T_home - flat) k; no route home counts as infinite time (flat / (1 - k))', () => {
    expect(collapseT(10, 30, 0.25)).toBeCloseTo(15, 12)
    expect(collapseT(10, null, 0.5)).toBeCloseTo(20, 12)
    expect(collapseT(10, null, 1)).toBeNull()
  })
  it('a no-route cell inside the flat disc leaves the band once flat / (1 - k) passes the budget', () => {
    const d = { opt: null, nom: null, con: null }
    expect(collapseBandClass(d, 20, false, 30, 0)).toBe('con')
    expect(collapseBandClass(d, 20, false, 30, 0.3)).toBe('con') // 28.6
    expect(collapseBandClass(d, 20, false, 30, 0.4)).toBe('none') // 33.3
  })
  it('unknown terrain is never coloured at k = 1 (hatch only); before that NASA’s flat world ignores it', () => {
    const d = { opt: 5, nom: 5, con: 5 }
    expect(collapseBandClass(d, 5, true, 30, 1)).toBe('unknown')
    expect(collapseBandClass(d, 5, true, 30, 0)).toBe('con')
  })
})

describe('animation: 3 s ease-in-out, setter API for storyboards, reduced motion', () => {
  function fakeClock() {
    let now = 0
    const q: (() => void)[] = []
    return {
      now: () => now,
      raf: (cb: () => void) => q.push(cb),
      cancelRaf: () => q.splice(0),
      /** advance in frames of `dt` ms until the queue is empty */
      run(dt: number) {
        let guard = 0
        while (q.length && guard++ < 10000) {
          now += dt
          q.shift()!()
        }
      },
    }
  }
  function record(): { k: (number | undefined)[]; xfade: number[]; stop: () => void } {
    const out = { k: [] as (number | undefined)[], xfade: [] as number[], stop: () => {} }
    const s1 = effect(() => void out.k.push(ui.collapseK.value))
    const s2 = effect(() => void out.xfade.push(collapseFade.xfade.value))
    out.stop = () => (s1(), s2())
    return out
  }

  it('normal: k eases 0 -> 1 over exactly 3000 ms, monotonic, ends exactly at 1', async () => {
    const c = fakeClock()
    const r = record()
    const p = playCollapse({ reduced: false, now: c.now, raf: c.raf, cancelRaf: c.cancelRaf })
    c.run(1000 / 60)
    expect(await p).toBe(true)
    r.stop()
    const ks = r.k.filter((k): k is number => k !== undefined)
    expect(ks[0]).toBe(0)
    expect(ks[ks.length - 1]).toBe(1)
    for (let i = 1; i < ks.length; i++) expect(ks[i]).toBeGreaterThanOrEqual(ks[i - 1])
    expect(ks.length).toBeGreaterThan(150) // ~180 frames at 60 fps
    expect(collapseFrame(1500, COLLAPSE_MS, false).k).toBeCloseTo(0.5, 9)
    expect(collapseFrame(750, COLLAPSE_MS, false).k).toBeCloseTo(easeInOut(0.25), 12)
    expect(collapseFrame(2999, COLLAPSE_MS, false).k).toBeLessThan(1)
    expect(collapseFrame(3000, COLLAPSE_MS, false).k).toBe(1)
    expect(r.xfade.every((x) => x === 1)).toBe(true)
    expect(currentCollapse()).toEqual({ k: 1, kFrom: 1, xfade: 1 })
  })

  it('reduced motion: only k = 0 and k = 1 are ever set; the two pictures cross-fade', async () => {
    setCollapse(0)
    const c = fakeClock()
    const r = record()
    const p = playCollapse({ reduced: true, now: c.now, raf: c.raf, cancelRaf: c.cancelRaf })
    c.run(1000 / 60)
    expect(await p).toBe(true)
    r.stop()
    expect(new Set(r.k)).toEqual(new Set([0, 1]))
    const xs = r.xfade
    expect(xs.some((x) => x > 0 && x < 1)).toBe(true) // a real cross-fade
    const fade = xs.slice(xs.indexOf(0)) // from the start of the play (setCollapse(0) left xfade at 1)
    expect(fade[0]).toBe(0)
    expect(fade[fade.length - 1]).toBe(1)
    for (let i = 1; i < fade.length; i++) expect(fade[i]).toBeGreaterThanOrEqual(fade[i - 1])
    expect(currentCollapse()).toEqual({ k: 1, kFrom: 1, xfade: 1 })
    for (let ms = 0; ms <= COLLAPSE_MS; ms += 10) {
      const f = collapseFrame(ms, COLLAPSE_MS, true)
      expect([0, 1]).toContain(f.k)
      expect([0, 1]).toContain(f.kFrom)
    }
  })

  it('setCollapse(k) jumps (clamped) and cancels a running animation; resetCollapse leaves the collapse', async () => {
    const c = fakeClock()
    const p = playCollapse({ reduced: false, now: c.now, raf: c.raf, cancelRaf: c.cancelRaf })
    setCollapse(0.25)
    expect(await p).toBe(false)
    expect(ui.collapseK.peek()).toBe(0.25)
    setCollapse(-3)
    expect(ui.collapseK.peek()).toBe(0)
    setCollapse(7)
    expect(ui.collapseK.peek()).toBe(1)
    expect(collapseFade.playing.peek()).toBe(false)
    resetCollapse()
    expect(ui.collapseK.peek()).toBeUndefined()
    expect(currentCollapse().k).toBe(1)
  })

  it('?collapse=play | flat | real | <k> (search or hash query)', () => {
    expect(collapseQuery('?collapse=play', '')).toEqual({ kind: 'play' })
    expect(collapseQuery('', '#/?collapse=flat')).toEqual({ kind: 'set', k: 0 })
    expect(collapseQuery('?collapse=real', '')).toEqual({ kind: 'set', k: 1 })
    expect(collapseQuery('?collapse=0.4', '')).toEqual({ kind: 'set', k: 0.4 })
    expect(collapseQuery('?collapse=', '')).toBeNull()
    expect(collapseQuery('?field=margin', '')).toBeNull()
  })
})

describe('headline (D25 / D43): read from the manifest, never computed', () => {
  it.each(scenarios.scenarios.map((s) => s.id))('%s: 30 and 60 min equal the manifest and scenarios/index.json', (sid) => {
    const entry = scenarios.scenarios.find((s) => s.id === sid)!
    for (const budget of [30, 60]) {
      const h = collapseHeadline(manifest, sid, budget)
      expect(h).not.toBeNull()
      expect(h!.value).toBe(manifest[`reachable_pct.${sid}.${budget}`].value)
      expect(h!.range).toEqual([manifest[`reachable_pct_range.${sid}.${budget}.low`].value, manifest[`reachable_pct_range.${sid}.${budget}.high`].value])
      expect(h!.file).toBe('scenarios/index.json')
      const src = budget === entry.headline.budget_min ? entry.headline : entry.headline_60
      if (src) {
        expect(h!.value).toBe(src.reachable_pct)
        expect(h!.range).toEqual(src.range_pct)
      }
    }
    // D43: the 60-min headline carries the in-data share
    const h60 = collapseHeadline(manifest, sid, 60)!
    expect(h60.inDataPct).toBe(manifest[`headline.${sid}.disc_60.in_data_pct`].value)
    expect(collapseHeadline(manifest, sid, 30)!.inDataPct).toBeNull()
  })
  it('the published default reads "23.0% (15.2–28.7)" when the count ends (DESIGN U3 example)', () => {
    const h = collapseHeadline(manifest, scenarios.default, 30)!
    const end = headlineParts(h, 1, false)
    expect(end.final).toBe(true)
    expect(Number(end.value.replace('%', ''))).toBe(manifest[`reachable_pct.${scenarios.default}.30`].value)
    expect(`${end.value} ${end.range}`).toBe('23.0% (15.2–28.7)')
  })
  it('the count ends exactly on the manifest value; reduced motion shows only the manifest value', () => {
    const h = collapseHeadline(manifest, scenarios.default, 30)!
    expect(headlineCount(h, 1, false)).toEqual({ text: h.value.toFixed(1), final: true })
    expect(headlineCount(h, 0.5, false).final).toBe(false)
    for (const k of [0, 0.3, 1]) expect(headlineCount(h, k, true)).toEqual({ text: h.value.toFixed(1), final: true })
    expect(headlineParts(h, 0.5, false).range).not.toBeNull()
  })
  it('a scenario the manifest lacks gives no headline (nothing is invented)', () => {
    expect(collapseHeadline(manifest, 'nom_999', 30)).toBeNull()
    expect(collapseHeadline({}, scenarios.default, 30)).toBeNull()
  })
})

describe('shader source mirrors the CPU rule', () => {
  it('declares the contract uniforms and keeps the exact k = 1 branch', () => {
    for (const u of ['u_k', 'u_pad', 'u_cell', 'u_flatSpeed', 'u_kFrom', 'u_xfade']) expect(FS).toContain(`uniform ${u === 'u_pad' ? 'vec2' : 'float'} ${u};`)
    expect(FS).toMatch(/if \(k >= 1\.0 \|\| u_hasPad < 0\.5\) \{ sg = sth; return th; \}/)
    expect(FS).toMatch(/g_flat = dist \/ u_flatSpeed \/ 60\.0/)
    expect(FS).toMatch(/if \(u_xfade < 1\.0\) c = mix\(shade\(u_kFrom\), c, u_xfade\)/)
  })
  it('VARIANTS order unchanged (u_variant)', () => {
    expect([...VARIANTS]).toEqual(['opt', 'nom', 'con'])
  })
})

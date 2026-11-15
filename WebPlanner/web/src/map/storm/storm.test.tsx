// Storm mode acceptance tests (WS16 task 12 / DESIGN U9, package M12), written first, on the REAL
// published tree (web/public/data):
//  1. tripwire time and leash equal rad.json and the HUD's values (one shared storm-timing key, D39);
//  2. no storm visual renders without the "hypothetical timing" note;
//  3. every storm number has a manifest key and a trust chip;
//  4. dose ring cells = fieldAt cells with T_home <= leash (and the ring only tightens);
//  5. thread red = HUD alarm 2; the field's dose term = the dose budget left (M3 storm override);
//  6. storm.json validates (contract + director rules); ?capture=storm runs with the storm on;
//  7. no browser storage, no animation of its own (reduced motion).
/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Manifest } from '../../data/types'
import { evaluateAlarm } from '../../hud/alarms'
import { radiationInput, stormReplay, stormState } from '../../hud/storm'
import { readJson, readPngRGBA, REPO } from '../../hud/testutil'
import type { FieldsIndex } from '../../hud/types'
import { setManifest } from '../../prov/store'
import { fieldUniforms, mission } from '../../state/mission'
import { parseStoryboard } from '../../story/storyboard'
import { all, byClass, hasClass, installDom, type FakeNode } from '../../ui/testing/dom'
import { decodeGrid, decodeState, FieldData, type Bounds, type DecodedGrid, type StateGrid } from '../field/decode'
import { resolveMarginInputs } from '../field/margin'
import { stormQuery, stormTooltip } from './index'
import { threadStart } from './mode'
import { buildStormModel, curveRuns, STORM_KEYS, stormView, stormVisuals, threadRed, type StormRad, type StormTimelineRow } from './model'
import { StormBanner, StormCurve, StormPanel } from './Panel'
import { ringBoundary, ringCount, ringLattice, ringMask } from './ring'

const PUB = resolve(REPO, 'web/public/data')
const SC = 'nom_104'
const rad = readJson<StormRad>('conditions/rad.json', PUB)
const timeline = readJson<StormTimelineRow[]>(`timeline_${SC}.json`, PUB)
const MANIFEST = readJson<Manifest>('manifest.json', PUB)
const mval = (k: string): unknown => (MANIFEST as unknown as Record<string, { value: unknown }>)[k]?.value
const model = buildStormModel(rad, SC, timeline)!
const walk = timeline.filter((r) => r.event !== 'turn_back')
const hudReplay = stormReplay(
  rad,
  walk.map((r) => r.t_min),
  walk.map((r) => r.t_home_min ?? null),
)!
const TMAX = mission.clock.tMax.peek()
const MINUTES = Array.from({ length: Math.ceil(TMAX) + 1 }, (_, i) => i).concat([model.tFire - 1e-6, model.tFire, model.tFire + 1e-6])

describe('1. tripwire and leash equal rad.json and the HUD', () => {
  it('the model places the storm with the HUD function (t* = manifest t_star_min)', () => {
    expect(model).not.toBeNull()
    expect(model.tFire).toBe(hudReplay.tripwireEvaMin)
    expect(model.tFire).toBe(mval(STORM_KEYS.tStar(SC)))
    // the replayed storm instant at the tripwire minute is rad.json's tripwire_utc
    expect(model.replay.stormUtcAtEvaStartMs + model.tFire * 60000).toBe(Date.parse(rad.storm_2024!.tripwire_utc!))
    expect(new Date(model.replay.stormUtcAtEvaStartMs + model.tFire * 60000).toISOString().replace('.000', '')).toBe(mval(STORM_KEYS.tripwireUtc))
  })
  it('the leash is rad.json leash.tau_min_at_peak (and the manifest value)', () => {
    expect(model.leashMin).toBe(rad.leash.tau_min_at_peak)
    expect(model.leashMin).toBe(mval(STORM_KEYS.leash))
    expect(model.halfwidthLabel).toBe(rad.storm_2024!.tripwire_halfwidth_label)
  })
  it('fired / dose budget left at every minute equal the HUD stormState', () => {
    for (const t of MINUTES) {
      const v = stormView(model, t)
      const h = stormState(hudReplay, t)
      expect(v.fired).toBe(h.fired)
      expect(v.doseLeftMin).toBe(h.doseLeftMin)
      expect(v.banner).toBe(t >= model.tFire)
      expect(v.ringLeashMin).toBe(h.fired ? Math.max(0, h.doseLeftMin!) : rad.leash.tau_min_at_peak)
    }
  })
  it('the banner states the leash in the copy.json wording, number linked to rad.leash.tau_min_at_peak', () => {
    setManifest(MANIFEST)
    const { container } = installDom()
    act(() => void render(<StormBanner m={model} />, container as unknown as Element))
    const title = byClass(container, 'hl-banner__title')[0]
    expect(text(title).trim()).toBe('Radiation: head home within 86 min')
    const n = byClass(title, 'num')[0]
    expect(hasClass(n, 'num-ok')).toBe(true)
    expect(n.getAttribute('title')).toContain(`manifest: ${STORM_KEYS.leash}`)
    expect(container.childNodes[0].getAttribute('role')).toBe('alert')
  })
  it('the switch tooltip names the storm date and the tripwire minute with its ± label', () => {
    expect(stormTooltip(model)).toBe(`Replay the 2024-05-20 storm during this EVA; its tripwire fires at 00:44 ${rad.storm_2024!.tripwire_halfwidth_label}`)
    expect(stormTooltip(null)).toBe('Storm replay unavailable: no tripwire, dose limit or route time home known')
  })
  it('unknown stays unknown: no tripwire -> no model', () => {
    const noTrip = JSON.parse(JSON.stringify(rad)) as StormRad
    noTrip.storm_2024!.tripwire_utc = null
    expect(buildStormModel(noTrip, SC, timeline)).toBeNull()
    expect(buildStormModel(rad, SC, [])).toBeNull()
  })
})

// ---- DOM helpers -------------------------------------------------------------------------------
function text(n: FakeNode): string {
  return n.nodeType === 3 ? n.data : n.childNodes.map(text).join('')
}
const notes = (root: FakeNode) => all(root, (n) => n.getAttribute?.('data-storm-note') !== null && n.getAttribute?.('data-storm-note') !== undefined)

describe('2. no storm visual without the timing note', () => {
  beforeEach(() => setManifest(MANIFEST))
  it('stormVisuals: any visual on implies the note; storm off shows nothing', () => {
    for (const t of MINUTES) {
      const v = stormView(model, t)
      const on = stormVisuals(true, model, v)
      expect(on.note).toBe(true)
      for (const k of ['ring', 'curve', 'banner', 'thread'] as const) if (on[k]) expect(on.note).toBe(true)
      const off = stormVisuals(false, model, v)
      expect(Object.values(off).every((x) => x === false)).toBe(true)
      expect(Object.values(stormVisuals(true, null, null)).every((x) => x === false)).toBe(true)
    }
  })
  it('the map panel carries the note before and after the tripwire (banner included)', () => {
    for (const t of [0, model.tFire - 1, model.tFire, model.tFire + 30, TMAX]) {
      const { container } = installDom()
      act(() => void render(<StormPanel m={model} v={stormView(model, t)} />, container as unknown as Element))
      const ns = notes(container)
      expect(ns.length).toBeGreaterThan(0)
      expect(text(ns[0])).toContain('hypothetical timing')
      expect(text(ns[0])).toContain('Hypothetical storm timing (tripwire placed where time home is largest)')
      expect(byClass(container, 'hl-storm__banner').length).toBe(t >= model.tFire ? 1 : 0)
    }
  })
  it('the timeline dose-rate curve carries the note', () => {
    const { container } = installDom()
    act(() => void render(<StormCurve m={model} tMax={TMAX} />, container as unknown as Element))
    const ns = notes(container)
    expect(ns.length).toBe(1)
    expect(text(ns[0])).toContain('hypothetical timing')
  })
})

describe('3. every storm number has a manifest key and a chip', () => {
  beforeEach(() => setManifest(MANIFEST))
  it('every STORM_KEYS key is in the manifest with the rad.json value', () => {
    for (const k of [STORM_KEYS.leash, STORM_KEYS.tripwireUtc, STORM_KEYS.halfwidth, STORM_KEYS.peak, STORM_KEYS.threshold, STORM_KEYS.baseline, STORM_KEYS.tStar(SC)]) expect(mval(k), k).not.toBeUndefined()
    expect(mval(STORM_KEYS.peak)).toBe(model.peakUGyDay)
    expect(mval(STORM_KEYS.threshold)).toBe(model.thresholdUGyDay)
  })
  const check = (root: FakeNode): void => {
    const nums = byClass(root, 'num')
    expect(nums.length).toBeGreaterThan(0)
    for (const n of nums) {
      expect(hasClass(n, 'num-ok') || hasClass(n, 'num-derived'), `${text(n)}: ${n.getAttribute('title')}`).toBe(true)
      // a chip in the same row / title / label as the number
      const row = n.parentNode!
      expect(byClass(row, 'hl-chip').length + all(row, (x) => (x.getAttribute?.('class') ?? '').includes('hl-chip')).length, `chip next to ${text(n)}`).toBeGreaterThan(0)
    }
  }
  it('map panel, armed and fired', () => {
    for (const t of [0, model.tFire + 10]) {
      const { container } = installDom()
      act(() => void render(<StormPanel m={model} v={stormView(model, t)} />, container as unknown as Element))
      check(container)
    }
  })
  it('timeline curve label', () => {
    const { container } = installDom()
    act(() => void render(<StormCurve m={model} tMax={TMAX} />, container as unknown as Element))
    check(container)
  })
})

describe('4. dose ring = fieldAt cells with T_home <= leash', () => {
  const index = readJson<FieldsIndex>('fields/index.json', PUB)
  const grid = (key: string): DecodedGrid => {
    const meta = index.fields[key]
    const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
    return decodeGrid(rgba, width, height, meta.scale, index.bounds as Bounds)
  }
  const cs = readJson<{ image: string; bounds: Bounds }>('terrain/cellstate.json', PUB)
  const png = readPngRGBA(resolve(PUB, cs.image))
  const state: StateGrid = decodeState(png.rgba, png.width, png.height, cs.bounds)
  const f = new FieldData(104, { opt: grid('opt_104/t_home'), nom: grid('nom_104/t_home'), con: grid('con_104/t_home') }, grid('nom_104/o2_home'), state, [], index.res_m)
  f.setMargin(null, 'nom')
  const at = (lo: number, la: number) => f.at(lo, la)
  const lat = ringLattice(at, { width: f.t.nom.width, height: f.t.nom.height, bounds: f.bounds })

  it('every lattice cell: in the ring <=> fieldAt(centre) T_home (plan variant) <= leash, never on unknown or blocked terrain', () => {
    for (const leash of [model.leashMin, 60, 30, 0]) {
      const mask = ringMask(lat, leash)
      let n = 0
      for (let r = 0; r < lat.rows; r++)
        for (let c = 0; c < lat.cols; c++) {
          const [lo, la] = lat.centre(c, r)
          const s = f.at(lo, la)
          const th = s.tHome[s.variant]
          const want = s.inside && !s.unknown && s.state !== 'blocked' && th !== null && th <= leash
          if (mask[r * lat.cols + c] !== (want ? 1 : 0)) throw new Error(`cell ${c},${r} leash ${leash}: mask ${mask[r * lat.cols + c]}, fieldAt ${th}`)
          n += want ? 1 : 0
        }
      expect(ringCount(mask)).toBe(n)
      if (leash === model.leashMin) expect(n).toBeGreaterThan(1000)
    }
  })
  it('the ring tightens with the clock (cell sets nest) and is empty when the budget is spent', () => {
    let prev: Uint8Array | null = null
    for (let t = model.tFire; t <= model.tFire + model.leashMin + 5; t += 5) {
      const m = ringMask(lat, stormView(model, t).ringLeashMin)
      if (prev) for (let i = 0; i < m.length; i++) if (m[i] && !prev[i]) throw new Error(`cell ${i} entered the ring at t=${t}`)
      prev = m
    }
    expect(ringCount(ringMask(lat, stormView(model, model.tFire + model.leashMin + 1).ringLeashMin))).toBe(0)
  })
  it('the drawn boundary is exactly the in/out cell edges', () => {
    const mask = ringMask(lat, 40)
    const lines = ringBoundary(lat, mask)
    let segs = 0
    for (const l of lines) segs += l.length - 1
    let edges = 0
    const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < lat.cols && r < lat.rows && mask[r * lat.cols + c] === 1
    for (let r = 0; r < lat.rows; r++) for (let c = 0; c < lat.cols; c++) if (inside(c, r)) edges += [inside(c, r - 1), inside(c, r + 1), inside(c - 1, r), inside(c + 1, r)].filter((x) => !x).length
    expect(segs).toBe(edges)
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe('5. thread colour and the field dose term', () => {
  afterEach(() => {
    mission.conditions.storm.value = false
    mission.conditions.tauDoseMin.value = undefined
  })
  it('thread red <=> HUD alarm 2 (tripwire fired and T_home >= dose budget left)', () => {
    for (const t of MINUTES) {
      const v = stormView(model, t)
      for (const th of [null, 0, 10, 40, 85.9, 120, 300]) {
        const r = radiationInput(stormState(hudReplay, t))
        const hud = evaluateAlarm({ marginMin: null, tripwireFired: r.tripwireFired, tHomeMin: th, tauDoseMin: r.tauDoseMin, circleCrossesHomeline: false, outsidePartner: null }, 0)
        expect(threadRed(v, th)).toBe(hud?.rule === 2)
      }
    }
    expect(threadRed(stormView(model, 0), 1e9)).toBe(false) // never before the tripwire
  })
  it('the thread start is the first vertex of the thread source', () => {
    expect(threadStart({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } })).toEqual([1, 2])
    expect(threadStart({ type: 'FeatureCollection', features: [] })).toBeNull()
  })
  it('storm on: the field dose term is the dose budget left (M3 storm override); off: the plan tau', () => {
    const t = model.tFire + 20
    const v = stormView(model, t)
    expect(v.tauOverride).toBe(model.leashMin - 20)
    expect(stormView(model, model.tFire - 1).tauOverride).toBeUndefined()
    mission.conditions.tauDoseMin.value = v.tauOverride
    expect(fieldUniforms.value.tauDose).toBeUndefined() // storm off: ignored
    mission.conditions.storm.value = true
    expect(fieldUniforms.value.tauDose).toBe(v.tauOverride)
    const u = { t, tDark: 500, tauDose: fieldUniforms.value.tauDose, tEva: 390, o2Left: 10, reserve: 1 }
    expect(resolveMarginInputs(u, null)!.tauDoseMin).toBe(model.leashMin - 20)
  })
})

describe('6. storyboard and query', () => {
  // the storm storyboard ships as web/public/story/storm.json (M10b; director.test.ts validates the whole set)
  const story = JSON.parse(readFileSync(resolve(REPO, 'web/public/story/storm.json'), 'utf8')) as unknown
  it('storm.json validates (contract + director rules: copy-key captions, known layers, t order)', () => {
    const sb = parseStoryboard(story, 'storm')
    expect(sb.id).toBe('storm')
    // the clock runs through the tripwire minute while the storyboard plays
    const steps = sb.steps
    const start = steps.find((s) => s.clock?.t_min !== undefined)!
    const play = steps.find((s) => s.clock?.playing === true)!
    const stop = steps.find((s) => s.clock?.playing === false && s.t > play.t)!
    const tEnd = start.clock!.t_min! + (stop.t - play.t) * play.clock!.speed!
    expect(start.clock!.t_min!).toBeLessThan(model.tFire)
    expect(tEnd).toBeGreaterThan(model.tFire)
  })
  it('?capture=storm and ?storm=1 turn the storm on; others do not', () => {
    expect(stormQuery('?capture=storm', '')).toBe(true)
    expect(stormQuery('', '#/?capture=storm')).toBe(true)
    expect(stormQuery('?storm=1', '#/')).toBe(true)
    expect(stormQuery('?capture=intro', '#/')).toBe(false)
    expect(stormQuery('', '#/')).toBe(false)
  })
})

describe('7. privacy and motion', () => {
  const dir = resolve(REPO, 'web/src/map/storm')
  const src = readdirSync(dir)
    .filter((f) => !f.includes('.test.'))
    .map((f) => [f, readFileSync(resolve(dir, f), 'utf8')] as const)
  it('no browser storage', () => {
    for (const [f, s] of src) expect(/localStorage|sessionStorage|indexedDB/.test(s), f).toBe(false)
  })
  it('no animation of its own (everything follows the clock; reduced motion has nothing to stop)', () => {
    for (const [f, s] of src) {
      expect(/requestAnimationFrame/.test(s), f).toBe(false)
      if (f.endsWith('.css')) expect(/(^|[^-])(animation|transition)\s*:/.test(s), f).toBe(false)
    }
  })
  it('the curve is clipped to the EVA axis and split at null samples', () => {
    const { runs } = curveRuns(model, TMAX)
    expect(runs.length).toBeGreaterThan(0)
    for (const r of runs) for (const [x, y] of r) expect(y >= 0 && y <= 1 && Number.isFinite(x)).toBe(true)
  })
})

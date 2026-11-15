// M10 acceptance (WS16 task 10, DESIGN U6, §6.3, §3.4), written first:
// - every web/public/story/*.json validates against contracts/storyboard.schema.json (and the rules the
//   schema cannot state: t order, captions are copy keys, known layer ids, resolvable targets);
// - the director gives identical state sequences for two runs at the fixed frame step (deterministic);
// - reduced motion: no intro, camera cuts, the collapse cross-fades.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import schema from '../../../contracts/storyboard.schema.json'
import { checkSchema, type JsonSchema } from '../data/schema'
import { Plan } from '../hud/plan'
import { easeInOut } from '../map/field/collapseMath'
import { angleDiff } from '../map/flythrough/path'
import { flightPath, gridMetric } from '../map/flythrough/route'
import { t as copy } from '../ui/copy'
import { CAPTURE, COLLAPSE_S } from './config'
import { Director, lerpPose, type DirectorOptions } from './director'
import { storyParams, storyRequest, wantsStoryBoot } from './query'
import { FOLLOW_TARGET, parseStoryboard, StoryboardError, type Storyboard } from './storyboard'

const STORY = new URL('../../public/story/', import.meta.url)
const DATA = new URL('../../public/data/', import.meta.url)
const files = readdirSync(STORY).filter((f) => f.endsWith('.json')).sort()
const readStory = (f: string): unknown => JSON.parse(readFileSync(new URL(f, STORY), 'utf8'))
const haveData = existsSync(new URL('labels.json', DATA)) && existsSync(new URL('route_nom_104.geojson', DATA))
const readData = (p: string) => JSON.parse(readFileSync(new URL(p, DATA), 'utf8'))

function realOptions(reduced = false): DirectorOptions {
  const labels = readData('labels.json').labels as { code: string; lon: number; lat: number }[]
  const metric = gridMetric(readData('fields/index.json'))
  const plan = new Plan(readData('route_nom_104.geojson'), readData('timeline_nom_104.json'), metric)
  const fp = flightPath(plan, metric, 'nom_104')
  return {
    targets: (c) => {
      const l = labels.find((x) => x.code === c)
      return l ? [l.lon, l.lat] : null
    },
    follow: (t) => fp.poseAt(t),
    tMax: 360,
    reduced,
  }
}

describe('storyboard files (web/public/story)', () => {
  it('has the U6 set (storm.json = the U9 storm replay, M12; ?capture=storm switches the storm on)', () => {
    expect(files).toEqual(['flythrough.json', 'intro.json', 'kiosk.json', 'storm.json', 'video_beat1.json'])
  })
  for (const f of files) {
    it(`${f} validates against contracts/storyboard.schema.json and the director rules`, () => {
      const raw = readStory(f)
      expect(checkSchema(raw, schema as JsonSchema)).toEqual([])
      const sb = parseStoryboard(raw, f.replace(/\.json$/, ''))
      expect(sb.size).toEqual(CAPTURE.size)
      expect(sb.fps).toBe(CAPTURE.fps)
      // captions are copy.json keys and render (placeholders filled the way apply.ts fills them)
      for (const s of sb.steps) if (typeof s.caption === 'string') expect(copy(s.caption as never, { walkback_min: 30 })).not.toMatch(/\{/)
    })
    it.skipIf(!haveData)(`${f}: every camera target resolves (labels.json or ${FOLLOW_TARGET})`, () => {
      const sb = parseStoryboard(readStory(f))
      expect(() => new Director(sb, realOptions())).not.toThrow()
      const d = new Director(sb, realOptions())
      expect(d.stateAt(0).camera).not.toBeNull()
    })
  }
  it('rejects a caption that is not a copy key, a step out of order, an unknown layer, a wrong id', () => {
    const base = parseStoryboard(readStory('intro.json'))
    const bad = (mut: (s: Storyboard) => void): unknown => {
      const s = structuredClone(base)
      mut(s)
      return s
    }
    expect(() => parseStoryboard(bad((s) => (s.steps[0].caption = 'Gale crater · Mars')))).toThrow(StoryboardError)
    expect(() => parseStoryboard(bad((s) => (s.steps[1].t = -1)))).toThrow(StoryboardError)
    expect(() => parseStoryboard(bad((s) => (s.steps[2].t = 0.5)))).toThrow(/before the previous/)
    expect(() => parseStoryboard(bad((s) => (s.steps[0].layers = { lava: true })))).toThrow(/unknown layer/)
    expect(() => parseStoryboard(base, 'kiosk')).toThrow(/file name/)
  })
  it('video_beat1 is the collapse beat (R15): flat circle, 3 s collapse, ends by 15 s', () => {
    const sb = parseStoryboard(readStory('video_beat1.json'))
    const d = new Director(sb, { targets: () => [0, 0], tMax: 360, reduced: false })
    expect(d.duration).toBe(15)
    const flat = sb.steps.find((s) => s.field?.collapse === 0)!
    const real = sb.steps.find((s) => s.field?.collapse === 1)!
    expect(d.stateAt(flat.t).field.collapse?.k).toBe(0)
    expect(real.field?.duration_s).toBe(COLLAPSE_S)
    expect(d.stateAt(real.t + COLLAPSE_S).field.collapse?.k).toBe(1)
    expect(d.stateAt(real.t + COLLAPSE_S / 2).field.collapse?.k).toBeCloseTo(0.5, 6)
  })
})

describe.skipIf(!haveData)('director: deterministic at the fixed frame step', () => {
  for (const f of files) {
    it(`${f}: two runs give identical state sequences`, () => {
      const sb = parseStoryboard(readStory(f))
      const run = (): string[] => {
        const d = new Director(sb, realOptions())
        const out: string[] = []
        for (let n = 0; n < d.frames; n++) out.push(JSON.stringify(d.stateAtFrame(n)))
        return out
      }
      const a = run()
      const b = run()
      expect(a.length).toBe(Math.floor(new Director(sb, realOptions()).duration * sb.fps) + 1)
      expect(b).toEqual(a)
      // and in a different order (scrub backwards): a frame is a pure function of its index
      const d = new Director(sb, realOptions())
      for (let n = a.length - 1; n >= 0; n -= 97) expect(JSON.stringify(d.stateAtFrame(n))).toBe(a[n])
    })
  }
})

describe('director rules', () => {
  const sb: Storyboard = {
    id: 'unit',
    version: '1',
    size: [1920, 1080],
    fps: 10,
    steps: [
      { t: 0, camera: { lon: 10, lat: 0, alt_m: 1000, bearing: 350, pitch: 0 }, caption: 'intro.gale', ui: 'hide' },
      { t: 2, camera: { lon: 20, lat: 0, alt_m: 100000, bearing: 10, pitch: 60 }, layers: { homeline: false } },
      { t: 3, field: { mode: 'bands', collapse: 0, duration_s: 0 }, clock: { t_min: 10, playing: true, speed: 2 } },
      { t: 4, field: { collapse: 1, duration_s: 3 }, caption: null, selection: 'S4' },
      { t: 8, clock: { playing: false }, ui: 'reveal', layers: { homeline: true } },
    ],
  }
  const o = { targets: () => null, tMax: 360 }

  it('eases the camera between keyframes (log height, short-arc bearing)', () => {
    const d = new Director(sb, { ...o, reduced: false })
    expect(d.stateAt(0).camera).toEqual({ target: [10, 0], altM: 1000, bearing: 350, pitch: 0 })
    const mid = d.stateAt(1).camera!
    expect(mid.target[0]).toBeCloseTo(15, 9)
    expect(mid.altM).toBeCloseTo(10000, 6) // geometric mean of 1 km and 100 km
    expect(Math.abs(angleDiff(0, mid.bearing))).toBeLessThan(1e-9) // 350 -> 10 through north
    const q = d.stateAt(0.5).camera!
    expect(q.pitch).toBeCloseTo(60 * easeInOut(0.25), 9)
    expect(d.stateAt(2).camera).toEqual({ target: [20, 0], altM: 100000, bearing: 10, pitch: 60 })
    expect(d.stateAt(99).camera).toEqual(d.stateAt(2).camera)
  })

  it('runs the clock, the collapse, layers, selection, caption and UI', () => {
    const d = new Director(sb, { ...o, reduced: false })
    expect(d.duration).toBe(8)
    expect(d.frames).toBe(81)
    expect(d.stateAt(2.5).clock).toBeNull()
    expect(d.stateAt(3).clock).toEqual({ tMin: 10, playing: true, speed: 2 })
    expect(d.stateAt(5.5).clock?.tMin).toBeCloseTo(15, 9)
    expect(d.stateAt(9).clock).toEqual({ tMin: 20, playing: false, speed: 2 })
    expect(d.stateAt(3.5).field).toEqual({ mode: 'bands', collapse: { k: 0, kFrom: 0, xfade: 1 } })
    expect(d.stateAt(5.5).field.collapse!.k).toBeCloseTo(0.5, 9)
    expect(d.stateAt(7).field.collapse).toEqual({ k: 1, kFrom: 1, xfade: 1 })
    expect(d.stateAt(1).layers).toEqual({})
    expect(d.stateAt(2).layers).toEqual({ homeline: false })
    expect(d.stateAt(8).layers).toEqual({ homeline: true })
    expect(d.stateAt(3.9).selection).toBeUndefined()
    expect(d.stateAt(4).selection).toBe('S4')
    expect(d.stateAt(1).caption).toBe('intro.gale')
    expect(d.stateAt(1).captionAge).toBe(1)
    expect(d.stateAt(4.2).caption).toBeNull()
    expect(d.stateAt(7.9).ui).toBe('hide')
    expect(d.stateAt(8).ui).toBe('reveal')
    expect(d.stateAt(7.9).done).toBe(false)
    expect(d.stateAt(8).done).toBe(true)
  })

  it('reduced motion: camera cuts, the collapse cross-fades (no k in between)', () => {
    const d = new Director(sb, { ...o, reduced: true })
    expect(d.stateAt(1.99).camera).toEqual(d.stateAt(0).camera)
    expect(d.stateAt(2).camera).toEqual({ target: [20, 0], altM: 100000, bearing: 10, pitch: 60 })
    const ks = new Set<number>()
    let lastX = 0
    for (let n = 40; n <= 80; n++) {
      const c = d.stateAtFrame(n).field.collapse!
      ks.add(c.k)
      if (n > 40) expect(c.xfade).toBeGreaterThanOrEqual(lastX)
      lastX = c.xfade
    }
    expect([...ks]).toEqual([1])
    const half = d.stateAt(5.5).field.collapse!
    expect([half.k, half.kFrom]).toEqual([1, 0])
    expect(half.xfade).toBeCloseTo(0.5, 6)
  })

  it('the CREW target follows the flythrough at the storyboard clock', () => {
    const calls: number[] = []
    const d = new Director(
      { id: 'f', version: '1', size: [1920, 1080], fps: 2, steps: [{ t: 0, clock: { t_min: 5, playing: true, speed: 3 }, camera: { target: FOLLOW_TARGET } }, { t: 4 }] },
      { targets: () => null, tMax: 360, reduced: false, follow: (t) => (calls.push(t), { target: [t, 0], altM: 120, bearing: 0, pitch: 64 }) },
    )
    expect(d.stateAt(2).camera?.target).toEqual([11, 0])
    expect(calls).toContain(11)
  })

  it('lerpPose ends on its keyframes', () => {
    const a = { target: [1, 2] as [number, number], altM: 10, bearing: 20, pitch: 5 }
    const b = { target: [3, 4] as [number, number], altM: 1000, bearing: 300, pitch: 50 }
    expect(lerpPose(a, b, 0)).toEqual(a)
    const e = lerpPose(a, b, 1)
    expect(e.target).toEqual(b.target)
    expect(e.altM).toBeCloseTo(1000, 9)
    expect(e.bearing).toBeCloseTo(300, 9)
  })
})

describe('which story runs (intro once per page session; ?intro, ?demo, ?capture)', () => {
  const p = (search: string, hash = '#/') => storyParams(search, hash)
  const s = { reduced: false, introSeen: false, legacy: false }
  it('plays the intro on the first planning-map visit only', () => {
    expect(storyRequest(p(''), s)).toEqual({ kind: 'intro' })
    expect(storyRequest(p(''), { ...s, introSeen: true })).toBeNull()
  })
  it('?intro=0 never, ?intro=1 once more; never under reduced motion or in ?legacy', () => {
    expect(storyRequest(p('?intro=0'), s)).toBeNull()
    expect(storyRequest(p('', '#/?intro=1'), { ...s, introSeen: true })).toEqual({ kind: 'intro' })
    expect(storyRequest(p('?intro=1'), { ...s, reduced: true })).toBeNull()
    expect(storyRequest(p(''), { ...s, reduced: true })).toBeNull()
    expect(storyRequest(p(''), { ...s, legacy: true })).toBeNull()
  })
  it('?demo=1 and ?capture=<id> win; only a valid id captures', () => {
    expect(storyRequest(p('?demo=1'), { ...s, introSeen: true })).toEqual({ kind: 'demo' })
    expect(storyRequest(p('?capture=video_beat1'), { ...s, reduced: true })).toEqual({ kind: 'capture', id: 'video_beat1', chrome: false })
    expect(storyRequest(p('?capture=intro&chrome=1'), s)).toEqual({ kind: 'capture', id: 'intro', chrome: true })
    expect(storyParams('?capture=../etc', '#/').capture).toBeNull()
    expect(wantsStoryBoot('?capture=intro', '#/')).toBe(true)
    expect(wantsStoryBoot('', '#/?demo=1')).toBe(true)
    expect(wantsStoryBoot('?intro=1', '#/')).toBe(false)
  })
})

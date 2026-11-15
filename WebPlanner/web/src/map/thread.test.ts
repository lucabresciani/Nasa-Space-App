// WS16 task 5 (M5) acceptance tests for the thread home (brief WS16, DESIGN U4 "Acceptance"):
//  * the thread's time equals T_home at its start within 0.5 min (sample cursor points incl. stations);
//  * the thread never crosses a blocked or unknown cell.
// Everything runs on the REAL published tree (web/public/data): t_home PNGs, the WS2 pointer field
// of the plan (nom_104/pointer, con_104/pointer), the 3 m cell states, stations.json, pad.json.
/// <reference types="node" />
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeRGBA, FieldGrid, fieldGrid } from '../hud/fields'
import { readJson, readPngRGBA, REPO } from '../hud/testutil'
import type { FieldsIndex, LonLat } from '../hud/types'
import { PointerField } from '../hud/wayhome'
import { decodeGrid, decodeState, FieldData, stateAt, type Bounds, type DecodedGrid, type StateGrid } from './field/decode'
import type { MarginInputs } from './field/margin'
import { TOKENS } from '../ui/tokens'
import { dashPattern, threadColor, threadPathWith, threadTooltip, type ThreadSources } from './thread'
import { THREAD } from './furniture/text'

const PUB = resolve(REPO, 'web/public/data')
const index = readJson<FieldsIndex>('fields/index.json', PUB)
const SUIT = 104

function grid(key: string): DecodedGrid {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return decodeGrid(rgba, width, height, meta.scale, index.bounds as Bounds)
}
function cellStates(file: string): StateGrid {
  const cs = readJson<{ image: string; bounds: Bounds; width: number; height: number }>(file, PUB)
  const png = readPngRGBA(resolve(PUB, cs.image))
  return decodeState(png.rgba, png.width, png.height, cs.bounds)
}
function pointer(scenario: string): PointerField {
  const key = `${scenario}/pointer`
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return new PointerField(new FieldGrid(fieldGrid(index, key), decodeRGBA(rgba, width, height, meta.scale), meta.units), meta.stencil!)
}

const stateNom = cellStates('terrain/cellstate.json')
const stateCon = cellStates('terrain/cellstate_conservative.json')
const t = { opt: grid(`opt_${SUIT}/t_home`), nom: grid(`nom_${SUIT}/t_home`), con: grid(`con_${SUIT}/t_home`) }
const o2 = grid(`nom_${SUIT}/o2_home`)
const padFile = readJson<{ pad: { lon: number; lat: number } }>('pad.json', PUB)
const PAD: LonLat = [padFile.pad.lon, padFile.pad.lat]
const stations = readJson<{ id: string; lon: number; lat: number; t_home_min: Record<string, number | null>; access: Record<string, { lon: number; lat: number } | null> }[]>('stations.json', PUB)

/** Field for one variant; its cell states are the variant's (conservative has its own, D22). */
function fieldFor(variant: 'nom' | 'con'): FieldData {
  const f = new FieldData(SUIT, t, o2, variant === 'con' ? stateCon : stateNom, [], index.res_m)
  f.setMargin(null, variant)
  return f
}

function sources(variant: 'nom' | 'con', f = fieldFor(variant), clock = 0): ThreadSources {
  return { pointer: pointer(`${variant}_${SUIT}`), pad: PAD, sample: (lon, lat) => f.at(lon, lat), clockT: () => clock }
}

/** Deterministic sample points around the pad (LCG), within `radiusM`. */
function samplePoints(n: number, radiusM: number, seed = 7): LonLat[] {
  const mPerDegLat = (index.height * index.res_m) / (index.bounds[3] - index.bounds[1])
  const mPerDegLon = (index.width * index.res_m) / (index.bounds[2] - index.bounds[0])
  let s = seed
  const rnd = (): number => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
  const out: LonLat[] = []
  for (let i = 0; i < n; i++) {
    const r = radiusM * Math.sqrt(rnd())
    const a = 2 * Math.PI * rnd()
    out.push([PAD[0] + (r * Math.cos(a)) / mPerDegLon, PAD[1] + (r * Math.sin(a)) / mPerDegLat])
  }
  return out
}

/** Cell states along every segment of the thread, sampled every 0.25 m (the cells are 3 m). */
function statesAlong(coords: LonLat[], st: StateGrid): Set<string> {
  const mPerDegLat = (st.height * 3) / (st.bounds[3] - st.bounds[1])
  const mPerDegLon = (st.width * 3) / (st.bounds[2] - st.bounds[0])
  const seen = new Set<string>()
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]]
    const len = Math.hypot((b[0] - a[0]) * mPerDegLon, (b[1] - a[1]) * mPerDegLat)
    const n = Math.max(1, Math.ceil(len / 0.25))
    for (let k = 0; k <= n; k++) seen.add(stateAt(st, a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n))
  }
  return seen
}

/** T_home (nearest pixel) along the thread's vertices. */
function profile(f: FieldData, coords: LonLat[], v: 'nom' | 'con'): (number | null)[] {
  return coords.map(([lon, lat]) => f.at(lon, lat).tHome[v])
}

for (const variant of ['nom', 'con'] as const) {
  describe(`thread home, ${variant}_${SUIT} (pointer field + fieldAt)`, () => {
    const f = fieldFor(variant)
    const src = sources(variant, f)
    const pts: [string, LonLat][] = [
      ...stations.flatMap((s): [string, LonLat][] => {
        const a = s.access[`${variant}_${SUIT}`]
        return a ? [[`${s.id} access cell`, [a.lon, a.lat]]] : []
      }),
      ...samplePoints(400, 2500).map((p, i): [string, LonLat] => [`sample ${i}`, p]),
    ]
    const threads = pts.map(([name, p]) => ({ name, p, th: threadPathWith(src, p[0], p[1], 0) }))
    const drawn = threads.filter((x) => x.th !== null)

    it('draws a thread from most sample points and from every station fieldAt has a T_home for', () => {
      expect(drawn.length).toBeGreaterThan(pts.length * 0.3)
      const noValue: string[] = []
      for (const x of threads.filter((y) => y.name.includes('access'))) {
        if (f.at(x.p[0], x.p[1]).tHome[variant] === null) {
          noValue.push(x.name.split(' ')[0])
          expect(x.th, x.name).toBeNull()
        } else expect(x.th, x.name).not.toBeNull()
      }
      // M2 finding: conservative S1/S2/S8 have no value at their 5 m pixel (it samples a different
      // 3 m cell than the access cell); fieldAt has no T_home there, so no thread is labelled.
      // (S7 too, at its conservative access cell).
      expect(noValue).toEqual(variant === 'con' ? ['S1', 'S2', 'S7', 'S8'] : [])
    })

    it("thread time equals T_home at its start within 0.5 min (fieldAt, and stations.json at the stations)", () => {
      for (const { name, p, th } of drawn) {
        const s = f.at(p[0], p[1])
        // the label quotes fieldAt at the start
        expect(th!.tHomeMin, name).toBe(s.tHome[variant])
        // the thread's own time: T_home falls from its start to the pad along the path
        const prof = profile(f, th!.coords, variant)
        const end = prof[prof.length - 1]
        expect(end, `${name}: T_home at the thread's end (the pad)`).not.toBeNull()
        expect(end!, name).toBeLessThanOrEqual(0.5)
        expect(Math.abs(prof[0]! - end! - th!.tHomeMin), name).toBeLessThanOrEqual(0.5)
        // never climbs the time field by more than the 5 m vs 3 m sampling allows
        let worst = 0
        let prev = prof[0]!
        for (const v of prof.slice(1)) {
          if (v === null) continue
          worst = Math.max(worst, v - prev)
          prev = Math.min(prev, v)
        }
        expect(worst, `${name}: T_home rises along the thread`).toBeLessThanOrEqual(0.5)
      }
      for (const st of stations) {
        const x = threads.find((y) => y.name === `${st.id} access cell`)
        const want = st.t_home_min[`${variant}_${SUIT}`]
        if (!x?.th || want === null) continue
        expect(Math.abs(x.th.tHomeMin - want), st.id).toBeLessThanOrEqual(0.5)
      }
    })

    it('ends on the rover pad', () => {
      for (const { th } of drawn) expect(th!.coords[th!.coords.length - 1]).toEqual(PAD)
    })

    it('never crosses a blocked or unknown cell', () => {
      const st = variant === 'con' ? stateCon : stateNom
      for (const { name, th } of drawn) {
        const seen = statesAlong(th!.coords, st)
        expect([...seen].filter((x) => x !== 'assessed'), name).toEqual([])
      }
    })

    it('no thread from blocked, unknown or outside points', () => {
      const st = variant === 'con' ? stateCon : stateNom
      let blockedChecked = 0
      for (const p of samplePoints(400, 2500, 99)) {
        const cell = stateAt(st, p[0], p[1])
        if (cell !== 'assessed') {
          blockedChecked++
          expect(threadPathWith(src, p[0], p[1], 0)).toBeNull()
        }
      }
      expect(blockedChecked).toBeGreaterThan(10)
      expect(threadPathWith(src, index.bounds[0] - 0.01, index.bounds[1] - 0.01, 0)).toBeNull()
    })
  })
}

describe('thread colour and tooltip = fieldAt margin at its start', () => {
  const f = fieldFor('nom')
  const inputs: MarginInputs = { t: 120, o2LeftL: 380, reserveL: 40.5, o2TasksL: 0, o2RateLMin: 1.35, tDarkMin: 500, tauDoseMin: 60, tEvaMin: 420 }
  f.setMargin(inputs, 'nom')
  // the first sample point where fieldAt has a margin (drawn T_home and O2 both have a value)
  const p0 = samplePoints(200, 1500, 3).find((p) => f.at(p[0], p[1]).margin !== null && threadPathWith(sources('nom', f, 120), p[0], p[1], 120))!
  const a = { lon: p0[0], lat: p0[1] }
  it('colour follows fieldAt cls; tooltip fills the config template from fieldAt', () => {
    const th = threadPathWith(sources('nom', f, 120), a.lon, a.lat, 120)!
    const s = f.at(a.lon, a.lat)
    expect(th.margin).toBe(s.margin)
    expect(th.binding).toBe(s.binding)
    expect(th.cls).toBe(s.cls)
    expect(threadColor(th.cls)).toBe(TOKENS.color[th.cls as 'safe' | 'caution' | 'limit'])
    const b = { O2: 'O₂', daylight: 'daylight', dose: 'dose', 'EVA duration': 'EVA duration' }[s.binding!]
    expect(threadTooltip(th)).toBe(`Home in ${s.tHome.nom!.toFixed(1)} min · margin ${s.margin!.toFixed(1)} min (${b})`)
    expect(THREAD.tooltip).toBe('Home in {t_home} min · margin {margin} min ({binding})')
  })
  it('a minute other than the clock gives no margin (fieldAt is at the clock)', () => {
    const th = threadPathWith(sources('nom', f, 120), a.lon, a.lat, 121)!
    expect(th.margin).toBeNull()
    expect(th.cls).toBe('none')
    expect(threadColor('none')).toBe(TOKENS.color.text)
    expect(threadTooltip(th)).toBe(`Home in ${th.tHomeMin.toFixed(1)} min`)
    expect(threadTooltip(null)).toBe('No way home known from here')
  })
})

describe('dash flow toward the rover (stepped dash patterns)', () => {
  it('has config dash_steps patterns, each one period long, moving forward', () => {
    const pats = Array.from({ length: THREAD.dashSteps }, (_, i) => dashPattern(i))
    for (const p of pats) {
      expect(p.length % 2).toBe(0)
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(4, 9)
      expect(p.every((x) => x >= 0)).toBe(true)
    }
    // start of the main dash moves forward by one step each frame, wrapping after a full period
    const dashStart = (p: number[]): number => (p[0] === 0 ? p[1] : p[0] + p[1])
    for (let i = 1; i < THREAD.dashSteps; i++) expect(dashStart(pats[i]) - dashStart(pats[i - 1])).toBeCloseTo(4 / THREAD.dashSteps, 9)
    expect(dashPattern(THREAD.dashSteps)).toEqual(dashPattern(0))
  })
})

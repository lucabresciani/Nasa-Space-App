// Timeline dock acceptance tests (WS15 task 7 / DESIGN U5, package A7), written first, on the REAL
// published tree (web/public/data):
//  1. the scrubber time equals the HUD clock: one store (missionClock), both directions;
//  2. turn-back and dwell positions equal timeline_*.json (and the cards' manifest keys);
//  3. the margin curve equals the timeline rows within 0.5 min at the rows (drawn path read back);
//  4. keyboard: arrows scrub 1 min (Shift 10), Space plays / pauses (§4.4);
//  5. the dock ticker never double-ticks the shared clock when another view ticks it;
//  6. every dock number is manifest-backed; no browser storage (privacy).
/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Manifest } from '../../data/types'
import { loadConfig, readJson, REPO } from '../../hud/testutil'
import type { Rad } from '../../hud/types'
import { setManifest } from '../../prov/store'
import { PlaybackClock } from '../../state/clock'
import { mission, missionClock } from '../../state/mission'
import { pct, splitByClass } from '../charts'
import { byClass, byRole, installDom, one, type FakeNode } from '../testing/dom'
import { buildTimelineModel, fmtEva, nextTurnBack, rowAt, type TimelineFileRow } from './model'
import { DockTicker } from './ticker'
import { chartScales, CHART_W, Timeline } from './Timeline'

const PUB = resolve(REPO, 'web/public/data')
const SC = 'nom_104'
const FILE = `timeline_${SC}.json`
const timeline = readJson<TimelineFileRow[]>(FILE, PUB)
const rad = readJson<Rad>('conditions/rad.json', PUB)
const clockFile = readJson<{ eva: { t_dark_min: number; eva_min: number } }>('conditions/clock.json', PUB)
const MANIFEST = readJson<Manifest>('manifest.json', PUB)
const mval = (k: string): unknown => (MANIFEST as unknown as Record<string, { value: unknown }>)[k]?.value

const model = buildTimelineModel({
  scenario: SC,
  timeline,
  tMax: missionClock.tMax,
  rad,
  tDarkMin: clockFile.eva.t_dark_min,
})
const tMax = missionClock.tMax
const leftPct = (n: FakeNode): number => parseFloat(String(n.style.left))
const widthPct = (n: FakeNode): number => parseFloat(String(n.style.width))

let root: FakeNode
const mount = (clock = missionClock, ticker?: DockTicker) => act(() => void render(<Timeline model={model} clock={clock} ticker={ticker} />, root as unknown as Element))
const slider = () => one(byRole(root, 'slider'), 'scrubber')
const key = (k: string, shiftKey = false) => act(() => void slider().dispatch('keydown', { key: k, shiftKey }))

beforeEach(() => {
  ;({ container: root } = installDom())
  setManifest(MANIFEST)
  missionClock.pause()
  missionClock.seek(0)
  missionClock.setSpeed(60)
})
afterEach(() => {
  act(() => void render(null, root as unknown as Element))
  setManifest(null)
})

describe('scrubber time equals the HUD clock (one store)', () => {
  it('the HUD flies the shared mission clock (same config keys)', () => {
    const cfg = loadConfig()
    // hud.ts: shared = tMax, speeds and default speed match -> clock = missionClock
    expect(missionClock.tMax).toBe(cfg.evaMin)
    expect(missionClock.speeds.join()).toBe(cfg.playbackSpeeds.join())
    expect(cfg.playbackSpeeds).toContain(cfg.defaultSpeed)
    expect(mission.clock.speed.peek()).toBe(cfg.defaultSpeed) // D13: 60×
  })

  it('a clock change elsewhere (HUD, map, keys) moves the scrubber', () => {
    mount()
    for (const v of [0, 123.4, 287.25, tMax]) {
      act(() => missionClock.seek(v))
      expect(Number(slider().getAttribute('aria-valuenow'))).toBeCloseTo(missionClock.t, 2)
      expect(leftPct(one(byClass(root, 'hl-tl__head')))).toBeCloseTo((missionClock.t / tMax) * 100, 6)
      expect(slider().getAttribute('aria-valuetext')).toBe(`${fmtEva(v)} EVA`)
    }
  })

  it('scrubbing writes the mission clock the HUD reads', () => {
    mount()
    act(() => missionClock.seek(100))
    key('ArrowRight')
    expect(missionClock.t).toBe(101)
    expect(mission.clock.t.peek()).toBe(101)
    key('ArrowRight', true)
    expect(missionClock.t).toBe(111)
    key('ArrowLeft')
    expect(missionClock.t).toBe(110)
    key('ArrowLeft', true)
    expect(missionClock.t).toBe(100)
    key('End')
    expect(missionClock.t).toBe(tMax)
    key('Home')
    expect(missionClock.t).toBe(0)
    expect(Number(slider().getAttribute('aria-valuenow'))).toBe(missionClock.t)
  })

  it('Space on the scrubber plays and pauses the shared clock; the event does not reach the shell', () => {
    mount()
    let ev: { defaultPrevented: boolean } | undefined
    act(() => void (ev = slider().dispatch('keydown', { key: ' ' })))
    expect(missionClock.playing).toBe(true)
    expect(ev?.defaultPrevented).toBe(true)
    expect(one(byClass(root, 'hl-tl__play')).getAttribute('aria-pressed')).toBe('true')
    key(' ')
    expect(missionClock.playing).toBe(false)
  })

  it('pointer drag seeks along the track', () => {
    mount()
    const s = slider()
    ;(
      s as unknown as {
        getBoundingClientRect: () => { left: number; width: number }
      }
    ).getBoundingClientRect = () => ({ left: 100, width: 780 })
    act(() => void s.dispatch('pointerdown', { pointerId: 1, clientX: 100 + 390 }))
    expect(missionClock.t).toBeCloseTo(tMax / 2, 9)
    act(() => void s.dispatch('pointermove', { pointerId: 1, clientX: 100 + 78 }))
    expect(missionClock.t).toBeCloseTo(tMax / 10, 9)
    act(() => void s.dispatch('pointerup', { pointerId: 1 }))
    act(() => void s.dispatch('pointermove', { pointerId: 1, clientX: 100 + 700 }))
    expect(missionClock.t).toBeCloseTo(tMax / 10, 9)
  })

  it('speed buttons are the config speeds and set the shared speed', () => {
    mount()
    const radios = byRole(root, 'radio')
    expect(radios.map((r) => r.textContent)).toEqual(missionClock.speeds.map((s) => `${s}×`))
    act(() => void radios[3].dispatch('click'))
    expect(missionClock.speed).toBe(missionClock.speeds[3])
  })
})

describe('turn-back and dwell positions equal timeline_*.json', () => {
  const arrive = timeline.filter((r) => r.event === 'arrive')
  const leave = timeline.filter((r) => r.event === 'leave')
  const turn = timeline.filter((r) => r.event === 'turn_back')

  it('model: one dwell per arrive/leave pair, one marker per turn_back row', () => {
    expect(model.dwells.map((d) => [d.station, d.t0, d.t1])).toEqual(arrive.map((a, k) => [a.station, a.t_min, leave[k].t_min]))
    expect(model.turnBacks.map((m) => [m.station, m.t])).toEqual(turn.map((r) => [r.station, r.t_min]))
    expect(model.dwells.length).toBe(4)
    expect(model.turnBacks.length).toBe(4)
    // and the station cards' manifest values (card.S.timeline.*)
    for (const d of model.dwells) {
      expect(mval(`card.${d.station}.timeline.arrive`)).toBe(d.t0)
      expect(mval(`card.${d.station}.timeline.leave`)).toBe(d.t1)
    }
    for (const m of model.turnBacks) expect(mval(`card.${m.station}.timeline.turn_back`)).toBe(m.t)
  })

  it('drawn: blocks and markers sit at the file minutes on the 0…EVA-length axis', () => {
    mount()
    const blocks = byClass(root, 'hl-tl__dwell')
    expect(blocks.length).toBe(arrive.length)
    blocks.forEach((b, k) => {
      expect(b.getAttribute('data-station')).toBe(arrive[k].station)
      expect(Number(b.getAttribute('data-t0'))).toBe(arrive[k].t_min)
      expect(Number(b.getAttribute('data-t1'))).toBe(leave[k].t_min)
      expect(leftPct(b)).toBeCloseTo(pct(arrive[k].t_min, 0, tMax), 9)
      expect(leftPct(b) + widthPct(b)).toBeCloseTo(pct(leave[k].t_min, 0, tMax), 9)
    })
    const marks = byClass(root, 'hl-tl__turnback')
    expect(marks.map((m) => [m.getAttribute('data-station'), Number(m.getAttribute('data-t'))])).toEqual(turn.map((r) => [r.station, r.t_min]))
    marks.forEach((m, k) => expect(leftPct(m)).toBeCloseTo(pct(turn[k].t_min, 0, tMax), 9))
    const cps = byClass(root, 'hl-tl__checkpoint').map((c) => Number(c.getAttribute('data-t')))
    expect(cps).toEqual(timeline.filter((r) => r.event === 'o2_checkpoint').map((r) => r.t_min))
  })

  it('storm window and tripwire: D39 placement (t* = manifest route.*.dose.t_star_min), labelled hypothetical timing', () => {
    expect(model.storm).not.toBeNull()
    expect(model.storm!.tripwire).toBe(mval(`route.${SC}.dose.t_star_min`))
    expect(model.storm!.onset!).toBeLessThan(model.storm!.tripwire)
    mount()
    expect(Number(one(byClass(root, 'hl-tl__tripwire')).getAttribute('data-t'))).toBe(model.storm!.tripwire)
    expect(byClass(root, 'hl-tag--hypotheticalTiming').length).toBe(1)
  })

  it('daylight end is clock.json t_dark_min, manifest-backed (beyond the axis is marked, not clipped silently)', () => {
    expect(model.daylightEnd).toBe(mval('clock.eva.t_dark_min'))
    mount()
    const ev = byClass(root, 'hl-tl__event').find((n) => n.getAttribute('data-beyond') === 'true')
    expect(ev).toBeDefined()
    expect(byClass(ev!, 'num-ok').length).toBe(1)
  })
})

describe('margin curve equals the timeline rows within 0.5 min at the rows', () => {
  const rows = timeline.map((r, i) => ({ ...r, i })).filter((r) => r.event !== 'turn_back' && r.margin_min !== null && r.margin_min !== undefined)
  const sc = chartScales(model)

  /** every vertex of the drawn line paths, read back to (minute, margin) */
  function drawnVertices(): [number, number][] {
    const out: [number, number][] = []
    for (const p of byClass(root, 'hl-tl__line')) {
      for (const m of (p.getAttribute('d') ?? '').matchAll(/[ML]([-\d.]+),([-\d.]+)/g)) out.push([(Number(m[1]) / CHART_W) * tMax, sc.yInv(Number(m[2]))])
    }
    return out
  }

  it('one curve vertex per published row, with its margin and binding', () => {
    expect(model.curve.map((r) => [r.t, r.margin, r.binding])).toEqual(rows.map((r) => [r.t_min, r.margin_min, r.margin_binding]))
  })

  it('the drawn line passes through every row within 0.5 min', () => {
    mount()
    const v = drawnVertices()
    for (const r of rows) {
      const hit = v.filter(([t]) => Math.abs(t - r.t_min) < 1e-2)
      expect(hit.length, `vertex at ${r.t_min}`).toBeGreaterThan(0)
      for (const [, m] of hit) expect(Math.abs(m - (r.margin_min as number)), `row ${r.i} t=${r.t_min}`).toBeLessThanOrEqual(0.5)
    }
    const dots = byClass(root, 'hl-tl__vertex')
    expect(dots.map((d) => [Number(d.getAttribute('data-t')), Number(d.getAttribute('data-margin'))])).toEqual(rows.map((r) => [r.t_min, r.margin_min]))
  })

  it('binding lane: runs of rows with one binding term; never across a change', () => {
    for (const run of model.bindingRuns) {
      const inside = rows.filter((r) => r.t_min >= run.t0 && r.t_min <= run.t1)
      expect(inside.length).toBeGreaterThan(0)
      for (const r of inside) expect(r.margin_binding).toBe(run.binding)
    }
  })

  it('the margin readout is the last row at or before the clock, manifest-backed', () => {
    mount()
    for (const t of [0, 29.9, 44.39, 100, 325.94, 389]) {
      act(() => missionClock.seek(t))
      const row = rowAt(model, t)!
      const ro = byClass(root, 'hl-readout')[0]
      const num = one(byClass(ro, 'num'))
      expect(num.textContent.replace(/[^\d.-]/g, '')).toBe(String(row.margin))
      expect(byClass(ro, 'num-ok').length, `margin at ${t} backed`).toBe(1)
      expect(mval(`timeline.${SC}.${row.i}.margin_min`)).toBe(row.margin)
    }
  })

  it('the next turn-back readout is backed by its timeline row key', () => {
    mount()
    act(() => missionClock.seek(345))
    const tb = nextTurnBack(model, 345)!
    expect(tb.station).toBe('S1')
    const ro = byClass(root, 'hl-readout')[1]
    expect(byClass(ro, 'num-ok').length).toBe(1)
    expect(mval(`timeline.${SC}.${tb.i}.t_min`)).toBe(tb.t)
  })

  it('every number in the dock is manifest-backed or the clock minute (derived)', () => {
    mount()
    act(() => missionClock.seek(150))
    const nums = byClass(root, 'num')
    expect(nums.length).toBeGreaterThan(0)
    for (const n of nums) expect(n.getAttribute('class')).toMatch(/num-ok|num-derived/)
  })
})

describe('chart primitives', () => {
  it('splitByClass inserts the threshold crossing and keeps every stored point', () => {
    const cls = (v: number) => (v < 0 ? 'limit' : v <= 10 ? 'caution' : 'safe')
    const runs = splitByClass(
      [
        [0, 30],
        [10, -10],
        [20, 5],
      ],
      [0, 10],
      cls,
    )
    expect(runs.map((r) => r.cls)).toEqual(['safe', 'caution', 'limit', 'caution'])
    expect(runs[0].pts).toEqual([
      [0, 30],
      [5, 10],
    ])
    expect(runs[2].pts[0]).toEqual([7.5, 0])
    expect(runs[3].pts[runs[3].pts.length - 1]).toEqual([20, 5])
  })
})

describe('dock ticker (D13 playback, one ticker at a time)', () => {
  const env = () => {
    let cb: ((n: number) => void) | null = null
    return {
      now: () => 0,
      raf: (f: (n: number) => void) => ((cb = f), 1),
      caf: () => void (cb = null),
      next: () => cb,
    }
  }
  it('advances real time × speed while playing, stops at pause', () => {
    const c = new PlaybackClock(390, [1, 30, 60, 300], 60)
    const e = env()
    const tk = new DockTicker(c, e)
    c.play()
    tk.start()
    e.next()!(1000) // 1 s at 60× = 1 min
    expect(c.t).toBeCloseTo(1, 9)
    c.pause()
    e.next()!(2000)
    expect(c.t).toBeCloseTo(1, 9)
    expect(tk.running).toBe(false)
  })
  it('yields to another ticker of the same clock (no double speed)', () => {
    const c = new PlaybackClock(390, [1, 30, 60, 300], 60)
    const e = env()
    const tk = new DockTicker(c, e)
    c.play()
    tk.start()
    // another view ticks 100 ms per frame before the dock's frame
    for (let k = 1; k <= 20; k++) {
      c.tick(100)
      e.next()!(k * 100)
    }
    // 2 s at 60× = 2 min from the other ticker; the dock adds at most its first frame
    expect(c.t).toBeLessThanOrEqual(2 + 0.1 + 1e-9)
  })
  it('does not tick under the pointer while scrubbing', () => {
    const c = new PlaybackClock(390, [1, 30, 60, 300], 60)
    const e = env()
    const tk = new DockTicker(c, e)
    c.play()
    tk.start()
    tk.scrubbing = true
    e.next()!(1000)
    expect(c.t).toBe(0)
  })
})

describe('privacy', () => {
  it('no browser storage in the dock or the charts', () => {
    for (const dir of ['timeline', 'charts']) {
      const d = resolve(REPO, 'web/src/ui', dir)
      for (const f of readdirSync(d).filter((x) => /\.(ts|tsx)$/.test(x) && !x.includes('.test.'))) {
        expect(readFileSync(resolve(d, f), 'utf8'), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)
      }
    }
  })
})

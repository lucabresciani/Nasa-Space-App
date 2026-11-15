// WS18 task 2 (H2) acceptance: drag the rover, static mode (DESIGN U15; design-agents rules 5, 6).
// Real tree: cell state + t_home through FieldData.at (= fieldAt), the shared slope PNG through
// WS7's FieldGrid, the D21 pads index through the H1 catalog.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeRGBA, FieldGrid, fieldGrid } from '../hud/fields'
import { readJson, readPngRGBA, REPO } from '../hud/testutil'
import type { FieldsIndex } from '../hud/types'
import { decodeGrid, decodeState, FieldData, fieldAt, setActiveField, type Bounds } from '../map/field/decode'
import { hashCanonical, type EngineIdentity } from './canonical'
import { CLICK_SLOP_PX, cyclePad, dragRows, isDragMove, PAD_VALIDITY, snapTarget, spotValues, type DragFields } from './drag'
import { buildCatalog, planAvailability } from './options'
import { createRoverDrag } from './rover'
import { createPlanEditStore } from './store'

const PUB = resolve(REPO, 'web/public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(PUB, p), 'utf8'))
const catalog = buildCatalog(json('scenarios/index.json'), json('scenarios/pads/index.json'), json('stations.json'))
const index = readJson<FieldsIndex>('fields/index.json', PUB)
const grid = (key: string) => {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return decodeGrid(rgba, width, height, meta.scale, index.bounds as Bounds)
}
const cs = readJson<{ image: string; bounds: Bounds; res_m: number }>('terrain/cellstate.json', PUB)
const csPng = readPngRGBA(resolve(PUB, cs.image))
const field = new FieldData(104, { opt: grid('opt_104/t_home'), nom: grid('nom_104/t_home'), con: grid('con_104/t_home') }, grid('nom_104/o2_home'), decodeState(csPng.rgba, csPng.width, csPng.height, cs.bounds), [], index.res_m)
const slopeMeta = index.fields.slope
const slopePng = readPngRGBA(resolve(PUB, slopeMeta.file))
const slope = new FieldGrid(fieldGrid(index, 'slope'), decodeRGBA(slopePng.rgba, slopePng.width, slopePng.height, slopeMeta.scale), slopeMeta.units)

setActiveField(field)
const fields: DragFields = {
  sample: (lon, lat) => fieldAt(lon, lat),
  slope: (lon, lat) => slope.valueAt(lon, lat),
  grid: { bounds: index.bounds as Bounds, mPerDegLon: slope.mPerDegLon, mPerDegLat: slope.mPerDegLat, cellM: Math.min(cs.res_m, index.res_m) },
}
const ID: EngineIdentity = { engine_tree: 'e'.repeat(40), config_hash: 'c'.repeat(16), terrain_hash: 't'.repeat(16) }
const OFFICIAL = catalog.officialPadId

// drag points: a lattice over the pads' neighbourhood (all five pads lie within ~3 km)
const [pw, ps, pe, pn] = [Math.min(...catalog.pads.map((p) => p.lon)) - 0.01, Math.min(...catalog.pads.map((p) => p.lat)) - 0.01, Math.max(...catalog.pads.map((p) => p.lon)) + 0.01, Math.max(...catalog.pads.map((p) => p.lat)) + 0.01]
const pts: { lon: number; lat: number }[] = []
for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) pts.push({ lon: pw + ((i + 0.37) / 15) * (pe - pw), lat: ps + ((j + 0.61) / 15) * (pn - ps) })

afterEach(() => vi.restoreAllMocks())

describe('config', () => {
  it('reads config/design.yaml pad_validity', () => {
    expect(PAD_VALIDITY).toEqual({ maxSlopeDeg: 5, blockM: 20, discM: 1764 })
  })
  it('the precomputed pads are the official pad and the D21 parking options P2–P5', () => {
    expect(catalog.pads.map((p) => p.id)).toEqual(['rank1', 'rank2', 'rank3', 'rank4', 'pad_default'])
    expect(OFFICIAL).toBe('rank1')
  })
})

describe('values shown during a drag = field lookups at that cell (U15 honesty)', () => {
  it('cell state = fieldAt, slope = the slope field, elevation "—" (no elevation field)', () => {
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    rd.begin()
    let checked = 0
    for (const p of pts) {
      const s = rd.move(p)
      const want = fieldAt(p.lon, p.lat)!
      expect(s.values!.state).toBe(want.state)
      expect(s.values!.slopeDeg).toBe(slope.valueAt(p.lon, p.lat))
      expect(s.values!.elevationM).toBeNull()
      if (s.values!.slopeDeg !== null) checked++
    }
    expect(checked).toBeGreaterThan(100)
    rd.cancel()
  })

  it('validity follows the U15 rule over the 20 × 20 m block (assessed, max slope ≤ 5°, disc in the grid)', () => {
    let valid = 0
    let invalid = 0
    // valid spots are rare (D21: 1129 candidate blocks); the pads themselves and their 3 m neighbours are in the set
    const near = catalog.pads.flatMap((p) => [-1, 0, 1].flatMap((i) => [-1, 0, 1].map((j) => ({ lon: p.lon + (i * 3) / slope.mPerDegLon, lat: p.lat + (j * 3) / slope.mPerDegLat }))))
    for (const p of [...pts, ...near]) {
      const v = spotValues(fields, p)
      // recompute the rule by brute force on the same lookups
      const half = PAD_VALIDITY.blockM / 2
      let maxS = -Infinity
      let allAssessed = true
      const steps = Math.ceil(PAD_VALIDITY.blockM / (fields.grid!.cellM / 2))
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
          const dx = -half + (i * PAD_VALIDITY.blockM) / steps
          const dy = -half + (j * PAD_VALIDITY.blockM) / steps
          const lon = p.lon + dx / slope.mPerDegLon
          const lat = p.lat + dy / slope.mPerDegLat
          maxS = Math.max(maxS, slope.valueAt(lon, lat) ?? -Infinity)
          if (fieldAt(lon, lat)!.state !== 'assessed') allAssessed = false
        }
      }
      const [w, s, e, n] = index.bounds
      const disc = Math.min((p.lon - w) * slope.mPerDegLon, (e - p.lon) * slope.mPerDegLon, (p.lat - s) * slope.mPerDegLat, (n - p.lat) * slope.mPerDegLat) >= PAD_VALIDITY.discM
      const want = maxS <= PAD_VALIDITY.maxSlopeDeg && allAssessed && disc
      expect(v.validity).toBe(want ? 'valid' : 'invalid')
      expect(v.maxSlopeDeg).toBe(maxS)
      if (want) valid++
      else invalid++
    }
    expect(valid).toBeGreaterThan(0)
    expect(invalid).toBeGreaterThan(0)
  })

  it('unknown stays unknown: no field loaded -> validity "unknown", never invalid', () => {
    const none: DragFields = { sample: () => null, slope: () => null, grid: null }
    const v = spotValues(none, catalog.pads[0])
    expect(v.validity).toBe('unknown')
    expect(v.failed).toEqual([])
  })

  it('everything else is a ghost with no number while dragging', () => {
    const rows = dragRows(spotValues(fields, pts[0]))
    expect(rows.filter((r) => r.kind === 'exact').map((r) => r.key)).toEqual(['validity', 'elevation', 'slope'])
    for (const r of rows.filter((x) => x.kind === 'ghost')) expect(r.value).toBeNull()
  })

  it('the draft holds no computed result while dragging', () => {
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    rd.begin()
    rd.move(pts[3])
    expect(store.draft.value!.ghost).toEqual({ status: 'dragging', source: 'none' })
    rd.cancel()
  })
})

describe('snap target = nearest valid precomputed pad', () => {
  const rd = createRoverDrag(createPlanEditStore({ catalog }), fields)
  it('the official pad and the D21-screened blocks P2–P4 pass the U15 rule on the browser fields', () => {
    for (const p of catalog.pads.filter((x) => x.id !== 'pad_default')) expect(spotValues(fields, p).validity, p.id).toBe('valid')
  })
  it('pad_default (config site.yaml pad, not a D21-screened block) fails the rule: steep and not all assessed', () => {
    const v = spotValues(fields, catalog.pads.find((x) => x.id === 'pad_default')!)
    expect(v.validity).toBe('invalid')
    expect(v.failed).toEqual(['steep', 'unknown'])
    expect(v.state).toBe('assessed') // the cell itself is assessed; its 20 × 20 m block is not
    expect(rd.padValid(catalog.pads.find((x) => x.id === 'pad_default')!)).toBe(false)
  })

  it('release snaps to the nearest valid pad (brute force over the lattice)', () => {
    for (const p of pts) {
      const k = Math.cos((p.lat * Math.PI) / 180)
      const want = [...catalog.pads].filter((x) => rd.padValid(x)).sort((a, b) => ((a.lon - p.lon) * k) ** 2 + (a.lat - p.lat) ** 2 - (((b.lon - p.lon) * k) ** 2 + (b.lat - p.lat) ** 2))[0]
      expect(rd.move(p).target!.id).toBe(want.id)
    }
    rd.cancel()
  })

  it('an invalid pad is skipped for the next nearest', () => {
    const p = catalog.pads.find((x) => x.id === 'rank4')!
    expect(snapTarget(catalog.pads, p, () => true)!.id).toBe('rank4')
    expect(snapTarget(catalog.pads, p, (x) => x.id !== 'rank4')!.id).not.toBe('rank4')
    expect(snapTarget(catalog.pads, p, () => false)).toBeNull()
  })

  it('on release the rover sits on the snapped pad; the ghost is that pad’s precomputed plan', () => {
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    const r4 = catalog.pads.find((x) => x.id === 'rank4')!
    rd.begin()
    rd.move({ lon: r4.lon + 0.0004, lat: r4.lat - 0.0003 })
    const d = rd.end()!
    expect(d.phase).toBe('released')
    expect(d.step.plan.pad).toBe('rank4')
    expect(d.ghost).toEqual({ status: 'ready', source: 'precomputed' })
    expect(rd.state.value).toMatchObject({ phase: 'released', at: { lon: r4.lon, lat: r4.lat }, target: { id: 'rank4' } })
    expect(d.delta.find((x) => x.field === 'pad')).toMatchObject({ from: OFFICIAL, to: 'rank4' })
  })

  it('released back at the committed pad: nothing to keep', () => {
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    rd.begin()
    rd.move(catalog.pads[0])
    expect(rd.end()).toBeNull()
    expect(store.draft.value).toBeNull()
    expect(rd.state.value).toBeNull()
  })
})

describe('commit, undo, discard', () => {
  it('Keep commits one undo step; undo restores the exact previous inputs key (static)', () => {
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    const before = store.committed.value
    rd.begin()
    rd.move(catalog.pads.find((x) => x.id === 'rank2')!)
    rd.end()
    expect(rd.keep()).toBe(true)
    expect(store.committed.value.plan.pad).toBe('rank2')
    expect(store.past.value).toHaveLength(1)
    expect(store.undo()).toBe(true)
    expect(store.committed.value.key).toBe(before.key)
    expect(store.committed.value.canonical).toBe(before.canonical)
    expect(store.committed.value.plan).toEqual(before.plan)
    expect(store.redo()).toBe(true)
    expect(store.committed.value.plan.pad).toBe('rank2')
  })

  it('with the engine identity, undo restores the exact previous plan hash', () => {
    const store = createPlanEditStore({ catalog, identity: ID })
    const rd = createRoverDrag(store, fields)
    const h0 = store.committedHash.value!
    expect(h0).toBe(hashCanonical(store.committed.value.canonical, ID))
    rd.begin()
    rd.move(catalog.pads.find((x) => x.id === 'pad_default')!)
    rd.end()
    rd.keep()
    expect(store.committedHash.value).not.toBe(h0)
    store.undo()
    expect(store.committedHash.value).toBe(h0)
  })

  it('Escape discards: nothing committed, no undo step', () => {
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    const before = store.committed.value
    rd.begin()
    rd.move(catalog.pads.find((x) => x.id === 'rank3')!)
    rd.end()
    expect(rd.discard()).toBe(true)
    expect(store.committed.value).toBe(before)
    expect(store.past.value).toHaveLength(0)
    expect(rd.state.value).toBeNull()
  })
})

describe('static mode never offers a server-only option', () => {
  it('no needsServer option; every drag draft is a precomputed, available plan', () => {
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    expect(rd.options().length).toBeGreaterThan(0)
    expect(rd.options().some((o) => o.needsServer)).toBe(false)
    expect(rd.options().some((o) => o.kind === 'customPad' || o.kind === 'dwell')).toBe(false)
    rd.begin()
    for (const p of pts) {
      rd.move(p)
      const plan = store.draft.value!.step.plan
      expect(typeof plan.pad).toBe('string')
      expect(planAvailability(plan, catalog, false)).toEqual({ ok: true })
    }
    rd.end()
    if (store.draft.value) expect(store.draft.value.availability).toEqual({ ok: true })
  })
})

describe('no network during a static drag', () => {
  it('begin, 225 moves and release make no fetch', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('network during drag')))
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    rd.begin()
    for (const p of pts) rd.move(p)
    rd.end()
    rd.keep()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('keyboard alternative: arrow keys cycle the pads', () => {
  it('cyclePad wraps in rank order', () => {
    expect(cyclePad(catalog.pads, 'rank1', 1)!.id).toBe('rank2')
    expect(cyclePad(catalog.pads, 'rank1', -1)!.id).toBe('pad_default')
    expect(cyclePad(catalog.pads, 'pad_default', 1)!.id).toBe('rank1')
  })

  it('cycle proposes the next valid pad (released draft); back at the committed pad discards', () => {
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    expect(rd.cycle(1)!.step.plan.pad).toBe('rank2')
    expect(store.draft.value!.phase).toBe('released')
    expect(rd.cycle(1)!.step.plan.pad).toBe('rank3')
    expect(rd.cycle(-1)!.step.plan.pad).toBe('rank2')
    expect(rd.cycle(-1)).toBeNull()
    expect(store.draft.value).toBeNull()
    // pad_default fails the spot rule, so the cycle skips it (as the snap does)
    expect(rd.cycle(-1)!.step.plan.pad).toBe('rank4')
    expect(rd.keep()).toBe(true)
    expect(store.committed.value.plan.pad).toBe('rank4')
    expect(rd.cycle(1)!.step.plan.pad).toBe('rank1') // rank4 -> rank1 (pad_default skipped)
  })
})

describe('click vs drag on the rover (H2b): only movement beyond the click slop is a drag', () => {
  it('the slop is the platform default (~4 px), above MapLibre\'s own 3 px drag start', () => {
    expect(CLICK_SLOP_PX).toBe(4)
  })
  it('a press that moves no farther than the slop is a click; beyond it, a drag', () => {
    const o = { x: 100, y: 200 }
    expect(isDragMove(o, o)).toBe(false)
    expect(isDragMove(o, { x: 103, y: 200 })).toBe(false)
    expect(isDragMove(o, { x: 100, y: 196 })).toBe(false) // exactly the slop: still a click
    expect(isDragMove(o, { x: 102.9, y: 202.9 })).toBe(true) // 4.1 px diagonal
    expect(isDragMove(o, { x: 95, y: 200 })).toBe(true)
    expect(isDragMove(o, { x: 100, y: 260 })).toBe(true)
  })
})

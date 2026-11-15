// R7 (D97 §3.7, contracts v1.2.0) known answers: "My plans" saves, lists, renames and deletes with storage present;
// works with empty storage, with no storage, with storage that throws (private mode) and with a full
// storage, and then says so on screen; export -> import keeps the route (ordered stations and free
// points with labels); a bad route is refused with readable errors; a permalink whose run record
// carries a route shows its route mode.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Fragment, type VNode } from 'preact'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../client'
import { OFFLINE_LABEL, TITLE_MAX_CHARS } from '../config'
import { createMockFetch } from '../mock/fetch'
import { PLAN_INPUTS_OFFICIAL, RUN_RECORD_LIVE } from '../mock/fixtures'
import { mockFinishedTree } from '../mock/result'
import { checkRunRecord, loadPlan, recordRoute, type PlanLoad } from '../plan'
import { checkPlanInputsText, exportPlanInputs } from '../planio'
import { ImportPage, PlanPage, PlanProblem, ProvenancePage } from '../planview'
import { mockLiveLoader } from '../result'
import { textOf, toHtml } from '../testing/html'
import type { PlanInputs, RunRecord } from '../types'
import { checkRoute, routeOf, routeText, type RouteSpec } from './route'
import { createPlansStore, planId, NOTE_FULL, NOTE_UNAVAILABLE, NOTE_UNREADABLE, PLANS_KEY, savedPlanInputs, type PlansStore, type StorageLike } from './store'
import { MyPlans, PLANS_CAPTION, SavePlan, type MyPlansProps } from './view'

const H1 = '0123456789abcdef'
const H2 = 'fedcba9876543210'
const H3 = '00000000000000aa'

const ROUTE: RouteSpec = {
  mode: 'ordered',
  stops: [{ station: 'S4' }, { lon: 77.512345, lat: 18.401234, label: 'Crater rim' }, { station: 'S1' }, { lon: 77.5, lat: 18.39 }],
}
const withRoute = (route: unknown = ROUTE, title?: string): PlanInputs => ({ ...(PLAN_INPUTS_OFFICIAL as PlanInputs), route, ...(title ? { title } : {}) })

/** A Map-backed Web Storage. */
function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return {
    m,
    s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } satisfies StorageLike,
  }
}
/** One empty storage for the whole test (the store calls its accessor on every access). */
const fresh = () => {
  const { s } = memStorage()
  return () => s
}
/** Private mode / blocked site data: every access throws. */
const throwing: StorageLike = {
  getItem: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
}

let tick = 0
const clock = () => new Date(Date.UTC(2026, 10, 15, 10, 0, tick++))

/** The saved entry of a result hash (tests save one entry per hash unless they say otherwise). */
const byHash = (store: PlansStore, h: string) => store.list().plans.find((p) => p.hash === h) ?? null
const idOf = (store: PlansStore, h: string) => byHash(store, h)?.id ?? `missing-${h}`

/** MyPlans props over a store, the way planmount.tsx builds them. */
function propsOf(store: PlansStore, current?: { hash: string; inputs: PlanInputs }): MyPlansProps & { lastError: () => string | null } {
  let error: string | null = null
  const act = (r: { ok: boolean; error?: string }) => (error = r.ok ? null : (r.error ?? null))
  const p = {
    get snap() {
      return store.list()
    },
    get error() {
      return error
    },
    onSave: (h: string) => current && current.hash === h && act(store.save(current)),
    onRename: (h: string, t: string) => act(store.rename(h, t)),
    onRemove: (h: string) => act(store.remove(h)),
    lastError: () => error,
  }
  return p
}

/** Every element's props in a hook-free tree (function components expanded). */
function elements(node: unknown): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(elements)
  const v = node as VNode<Record<string, unknown>>
  if (typeof v.type === 'function' && v.type !== Fragment) return elements((v.type as (p: unknown) => unknown)(v.props))
  return [v.props ?? {}, ...elements(v.props?.children)]
}
const byClass = (node: unknown, cls: string) => elements(node).filter((p) => typeof p.class === 'string' && p.class.split(' ').includes(cls))

describe('"My plans" store, storage present', () => {
  it('save, list (newest first), rename, delete; a new page reads the same list', () => {
    const { s, m } = memStorage()
    const store = createPlansStore(() => s, clock)
    expect(store.save({ hash: H1, inputs: withRoute(ROUTE, 'Rim first') })).toEqual({ ok: true })
    expect(store.save({ hash: H2, inputs: PLAN_INPUTS_OFFICIAL as PlanInputs })).toEqual({ ok: true })
    let snap = store.list()
    expect(snap).toMatchObject({ persistent: true, note: null })
    expect(snap.plans.map((p) => [p.hash, p.title])).toEqual([
      [H2, (PLAN_INPUTS_OFFICIAL as { title: string }).title],
      [H1, 'Rim first'],
    ])
    expect(store.save({ hash: H3, inputs: { ...(PLAN_INPUTS_OFFICIAL as PlanInputs), title: undefined } })).toEqual({ ok: true })
    expect(byHash(store, H3)?.title).toBe(`Plan ${H3}`)
    expect(store.remove(idOf(store, H3))).toEqual({ ok: true })
    expect(snap.plans[1].route).toEqual(ROUTE)
    expect(snap.plans[0].route).toEqual({ mode: 'auto' })
    expect(snap.plans[1].saved_utc).toMatch(/^2026-11-15T10:00:\d\dZ|^2026-11-15T10:00:\d\d\.\d{3}Z$/)
    expect(JSON.parse(m.get(PLANS_KEY)!).plans).toHaveLength(2)

    expect(store.rename(idOf(store, H1), '  Rim, then S1  ')).toEqual({ ok: true })
    expect(byHash(store, H1)?.title).toBe('Rim, then S1')
    expect(store.remove(idOf(store, H2))).toEqual({ ok: true })

    const again = createPlansStore(() => s).list()
    expect(again.plans.map((p) => [p.hash, p.title])).toEqual([[H1, 'Rim, then S1']])
    expect(again.plans[0].inputs.route).toEqual(ROUTE)
  })

  it('saving a hash again replaces its entry (one entry per result)', () => {
    const { s } = memStorage()
    const store = createPlansStore(() => s, clock)
    store.save({ hash: H1, inputs: withRoute(), title: 'A' })
    store.save({ hash: H1, inputs: withRoute(), title: 'B' })
    expect(store.list().plans.map((p) => p.title)).toEqual(['B'])
  })

  it('labels are not hashed (D57): two plans with one hash but different labels are two entries, each keeping its labels', () => {
    const store = createPlansStore(fresh(), clock)
    const relabelled: RouteSpec = { mode: 'ordered', stops: [{ station: 'S4' }, { lon: 77.512345, lat: 18.401234, label: 'Dark sand edge' }, { station: 'S1' }, { lon: 77.5, lat: 18.39 }] }
    store.save({ hash: H1, inputs: withRoute(ROUTE, 'First labels') })
    store.save({ hash: H1, inputs: withRoute(relabelled, 'Second labels') })
    const plans = store.list().plans
    expect(plans.map((p) => p.title)).toEqual(['Second labels', 'First labels'])
    expect(new Set(plans.map((p) => p.id)).size).toBe(2)
    expect(plans.map((p) => p.hash)).toEqual([H1, H1])
    const back = plans.map((p) => checkPlanInputsText(exportPlanInputs(savedPlanInputs(p)).text))
    expect(back.map((b) => b.ok && b.inputs.route)).toEqual([relabelled, ROUTE])
    // the same plan saved again is one entry
    store.save({ hash: H1, inputs: withRoute(ROUTE, 'First labels') })
    expect(store.list().plans).toHaveLength(2)
  })

  it('refuses an empty or over-long title, a bad hash, a bad route, and unknown plans', () => {
    const store = createPlansStore(fresh(), clock)
    expect(store.save({ hash: 'nope', inputs: withRoute() }).ok).toBe(false)
    const bad = store.save({ hash: H1, inputs: withRoute({ mode: 'ordered', stops: [] }) })
    expect(bad.ok === false && bad.error).toMatch(/at least one stop/)
    store.save({ hash: H1, inputs: withRoute() })
    expect(store.rename(idOf(store, H1), '   ')).toEqual({ ok: false, error: 'A plan needs a title.' })
    expect(store.rename(idOf(store, H1), 'x'.repeat(TITLE_MAX_CHARS + 1)).ok).toBe(false)
    expect(store.rename(idOf(store, H1), 'x'.repeat(TITLE_MAX_CHARS)).ok).toBe(true)
    expect(store.rename(idOf(store, H3), 'x').ok).toBe(false)
    expect(store.remove(idOf(store, H3)).ok).toBe(false)
  })
})

describe('"My plans" without usable storage', () => {
  it('empty storage: an empty list, no note, and the view says how to save', () => {
    const store = createPlansStore(() => memStorage().s)
    expect(store.list()).toEqual({ plans: [], persistent: true, note: null })
    const text = textOf(<MyPlans {...propsOf(store)} />)
    expect(text).toMatch(/My plans No saved plans yet/)
    expect(text).toContain(PLANS_CAPTION)
  })

  it('storage throws on every access (private mode): the list works for this page and the view shows a note', () => {
    const store = createPlansStore(() => throwing, clock)
    expect(store.list()).toEqual({ plans: [], persistent: false, note: NOTE_UNAVAILABLE })
    const props = propsOf(store, { hash: H1, inputs: withRoute(ROUTE, 'Kept in memory') })
    props.onSave(H1)
    expect(props.lastError()).toBeNull()
    const snap = store.list()
    expect(snap.plans.map((p) => p.title)).toEqual(['Kept in memory'])
    expect(snap.note).toBe(NOTE_UNAVAILABLE)
    const html = toHtml(<MyPlans {...props} />)
    expect(textOf(<MyPlans {...props} />)).toContain(NOTE_UNAVAILABLE)
    expect(html).toContain('role="status"')
    props.onRename(idOf(store, H1), 'Renamed')
    expect(byHash(store, H1)?.title).toBe('Renamed')
    props.onRemove(idOf(store, H1))
    expect(store.list().plans).toEqual([])
  })

  it('reading the storage property itself throws (blocked site data), or there is none: same', () => {
    const blocked = createPlansStore(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(blocked.save({ hash: H1, inputs: withRoute() })).toEqual({ ok: true })
    expect(blocked.list()).toMatchObject({ persistent: false, note: NOTE_UNAVAILABLE })
    expect(blocked.list().plans).toHaveLength(1)
    // the default store in node: no localStorage at all
    const none = createPlansStore()
    expect(none.list()).toEqual({ plans: [], persistent: false, note: NOTE_UNAVAILABLE })
  })

  it('storage full (setItem throws): the change holds for this page and the note says so', () => {
    const { m } = memStorage()
    const full: StorageLike = {
      getItem: (k) => m.get(k) ?? null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
    }
    const store = createPlansStore(() => full, clock)
    expect(store.save({ hash: H1, inputs: withRoute() })).toEqual({ ok: true })
    expect(store.list()).toMatchObject({ persistent: false, note: NOTE_FULL })
    expect(store.list().plans.map((p) => p.hash)).toEqual([H1])
  })

  it('garbage under the key: an empty list with a note; good entries survive bad ones', () => {
    expect(createPlansStore(() => memStorage({ [PLANS_KEY]: '{not json' }).s).list()).toEqual({ plans: [], persistent: true, note: NOTE_UNREADABLE })
    const good = { id: planId(H1, withRoute()), hash: H1, title: 'Good', saved_utc: '2026-11-15T10:00:00.000Z', route: ROUTE, inputs: withRoute() }
    const mixed = JSON.stringify({ version: 1, plans: [good, { hash: H2, title: 3 }, { ...good, hash: H3, route: { mode: 'sideways' } }] })
    const snap = createPlansStore(() => memStorage({ [PLANS_KEY]: mixed }).s).list()
    expect(snap.plans.map((p) => p.hash)).toEqual([H1])
    expect(snap.note).toBe(NOTE_UNREADABLE)
  })
})

describe('"My plans" view', () => {
  it('lists each plan with open link, route, rename, export and delete; buttons act on the store', () => {
    const { s } = memStorage()
    const store = createPlansStore(() => s, clock)
    store.save({ hash: H1, inputs: withRoute(ROUTE, 'Rim first') })
    const props = propsOf(store)
    const tree = <MyPlans {...props} />
    const html = toHtml(tree)
    expect(html).toContain(`href="#/plan/${H1}"`)
    expect(textOf(tree)).toContain('Route ordered: S4 → W1 Crater rim (77.512345, 18.401234) → S1 → W2 (77.500000, 18.390000)')
    const ex = byClass(tree, 'live-plan-export')[0]
    expect(ex.download).toBe('plan_inputs.json')
    const exported = decodeURIComponent(String(ex.href).replace(/^data:application\/json;charset=utf-8,/, ''))
    const back = checkPlanInputsText(exported)
    expect(back.ok && back.inputs.route).toEqual(ROUTE)
    expect(back.ok && back.inputs.title).toBe('Rim first')

    const form = byClass(tree, 'live-plan-rename')[0]
    const input = { value: 'Renamed in the list' }
    ;(form.onSubmit as (e: unknown) => void)({ preventDefault: () => {}, currentTarget: { elements: { namedItem: (n: string) => (n === 'title' ? input : null) } } })
    expect(byHash(store, H1)?.title).toBe('Renamed in the list')

    ;(byClass(<MyPlans {...props} />, 'live-plan-delete')[0].onClick as () => void)()
    expect(store.list().plans).toEqual([])
  })

  it('a refused rename shows its error', () => {
    const store = createPlansStore(fresh(), clock)
    store.save({ hash: H1, inputs: withRoute() })
    const props = propsOf(store)
    props.onRename(idOf(store, H1), '')
    expect(textOf(<MyPlans {...props} />)).toContain('A plan needs a title.')
  })

  it('"Save to My plans" saves the plan on screen and then says it is saved', () => {
    const store = createPlansStore(fresh(), clock)
    const props = propsOf(store, { hash: H1, inputs: withRoute(ROUTE, 'From the permalink') })
    const btn = <SavePlan hash={H1} id={planId(H1, withRoute(ROUTE, 'From the permalink'))} snap={props.snap} onSave={props.onSave} />
    expect(textOf(btn)).toBe('Save to My plans')
    expect(toHtml(btn)).toContain('class="live-plan-save" data-saved="false"')
    ;(elements(btn).find((p) => typeof p.onClick === 'function')!.onClick as () => void)()
    expect(byHash(store, H1)).toMatchObject({ title: 'From the permalink', route: ROUTE })
    const after = <SavePlan hash={H1} id={planId(H1, withRoute(ROUTE, 'From the permalink'))} snap={props.snap} onSave={props.onSave} />
    expect(textOf(after)).toMatch(/Save again to My plans Saved in this browser/)
    expect(toHtml(after)).toContain('data-saved="true"')
  })

  it('#/plan shows the import and "My plans"; without plans props it is unchanged', () => {
    const store = createPlansStore(() => throwing)
    const with_ = textOf(<ImportPage state={{ kind: 'idle' }} onFile={() => {}} plans={propsOf(store)} />)
    expect(with_).toContain('Open a plan_inputs.json')
    expect(with_).toContain('My plans')
    expect(with_).toContain(NOTE_UNAVAILABLE)
    expect(textOf(<ImportPage state={{ kind: 'idle' }} onFile={() => {}} />)).not.toContain('My plans')
  })
})

describe('live server unreachable (published site, D97)', () => {
  it('a saved plan whose permalink cannot load (offline, not found): the message, then "My plans" with a working export', async () => {
    const store = createPlansStore(fresh(), clock)
    store.save({ hash: H1, inputs: withRoute(ROUTE, 'Saved before the server went down') })
    const down = createApiClient({
      base: 'http://api.test',
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const load = await loadPlan(down, H1)
    expect(load.state).toBe('offline')
    const page = <PlanProblem load={load as Exclude<PlanLoad, { state: 'ok' }>} plans={propsOf(store)} />
    const text = textOf(page)
    expect(text).toContain(OFFLINE_LABEL)
    expect(text).toContain('Saved before the server went down')
    const ex = byClass(page, 'live-plan-export')[0]
    const back = checkPlanInputsText(decodeURIComponent(String(ex.href).replace(/^data:application\/json;charset=utf-8,/, '')))
    expect(back.ok && back.inputs.route).toEqual(ROUTE)
    // and with no storage either: still a page, with the note
    expect(textOf(<PlanProblem load={load as Exclude<PlanLoad, { state: 'ok' }>} plans={propsOf(createPlansStore(() => throwing))} />)).toContain(NOTE_UNAVAILABLE)
  })
})

describe('JSON export and import carry the route (draft plan_inputs v1.2.0)', () => {
  it('round trip keeps the route: ordered stations and free points with labels, byte for byte', () => {
    const x = withRoute(ROUTE, 'Rim first')
    const ex = exportPlanInputs(x)
    expect(ex.text).toContain('"route": {')
    const back = checkPlanInputsText(ex.text)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.inputs).toEqual(x)
    expect(back.inputs.route).toEqual(ROUTE)
    expect(exportPlanInputs(back.inputs).text).toBe(ex.text)
  })

  it('auto routes (no stops or an empty list) and files without a route stay valid (missing = auto)', () => {
    expect(checkPlanInputsText(JSON.stringify(withRoute({ mode: 'auto' }))).ok).toBe(true)
    expect(checkPlanInputsText(JSON.stringify(withRoute({ mode: 'auto', stops: [] }))).ok).toBe(true)
    expect(checkPlanInputsText(JSON.stringify(PLAN_INPUTS_OFFICIAL)).ok).toBe(true)
    expect(routeOf(PLAN_INPUTS_OFFICIAL as PlanInputs)).toEqual({ mode: 'auto' })
    expect(routeText({ mode: 'auto' })).toMatch(/^auto/)
  })

  const refused = (route: unknown) => {
    const r = checkPlanInputsText(JSON.stringify(withRoute(route)))
    expect(r.ok).toBe(false)
    return r.ok ? '' : r.errors.join('\n')
  }
  it('refuses a bad route with readable errors naming the stop', () => {
    expect(refused('ordered')).toMatch(/route: \$\.route: must be an object/)
    expect(refused({ mode: 'shuffled', stops: [] })).toMatch(/\$\.route\.mode: must be "auto" or "ordered", not "shuffled"/)
    expect(refused({ mode: 'ordered' })).toMatch(/an ordered route needs at least one stop/)
    expect(refused({ mode: 'auto', stops: [{ station: 'S4' }] })).toMatch(/an auto route has no stops/)
    expect(refused({ mode: 'ordered', stops: [{ station: 'X9' }] })).toMatch(/\$\.route\.stops\[0\]\.station: "X9" is not a station id/)
    expect(refused({ mode: 'ordered', stops: [{ station: 'S4' }, { lon: 400, lat: 18 }] })).toMatch(/\$\.route\.stops\[1\]\.lon: must be a number from -180 to 360/)
    expect(refused({ mode: 'ordered', stops: [{ lon: 77, lat: '18' }] })).toMatch(/stops\[0\]\.lat/)
    expect(refused({ mode: 'ordered', stops: [{ lon: 77, lat: 18, label: 'x'.repeat(TITLE_MAX_CHARS + 1) }] })).toMatch(/stops\[0\]\.label: longer than/)
    expect(refused({ mode: 'ordered', stops: [{ station: 'S4', dwell: 5 }] })).toMatch(/stops\[0\]\.dwell: unknown field "dwell"/)
    expect(refused({ mode: 'ordered', stops: [{ station: 'S4' }], speed: 2 })).toMatch(/\$\.route\.speed: unknown field/)
    expect(refused({ mode: 'ordered', stops: 'S4' })).toMatch(/\$\.route\.stops: must be a list/)
  })

  it('the rest of the file is still checked against the schema (unknown fields refused)', () => {
    const r = checkPlanInputsText(JSON.stringify({ ...withRoute(), share_code: 'x' }))
    expect(r.ok === false && r.errors.join()).toMatch(/plan_inputs\.schema\.json: .*share_code/)
    expect(checkRoute(ROUTE)).toEqual([])
  })
})

describe('#/plan/{hash} permalink of a plan with a route', () => {
  const LIVE = RUN_RECORD_LIVE as RunRecord
  const recordWith = (extra: Record<string, unknown>, route?: unknown): RunRecord =>
    ({ ...LIVE, ...extra, inputs: { ...LIVE.inputs, ...(route === undefined ? {} : { route }) } }) as RunRecord
  async function open(record: RunRecord) {
    const fetch = createMockFetch({ provenance: { [LIVE.hash]: record }, trees: { [LIVE.hash]: mockFinishedTree(false) } })
    return loadPlan(createApiClient({ base: 'http://api.test', fetch }), LIVE.hash, { loaderFor: mockLiveLoader(fetch) })
  }
  type Ok = Extract<PlanLoad, { state: 'ok' }>

  it('the result shows route mode ordered and the stops in the given order; provenance too', async () => {
    const load = await open(recordWith({ route_mode: 'ordered' }, ROUTE))
    expect(load.state).toBe('ok')
    const ok = load as Ok
    expect(recordRoute(ok.record)).toEqual(ROUTE)
    const page = <PlanPage load={ok} permalink="p" simEnabled={false} importState={{ kind: 'idle' }} onImportFile={() => {}} />
    const text = textOf(page)
    expect(text).toContain('Route mode: ordered (your stops, computed in the order given)')
    expect(text).toContain('S4 W1 Crater rim (77.512345, 18.401234) S1 W2 (77.500000, 18.390000)')
    expect(toHtml(page)).toContain('data-route-mode="ordered"')
    expect(textOf(<ProvenancePage load={ok} />)).toMatch(/Route mode ordered/)
    // its export carries the route back out
    const ex = byClass(page, 'live-export')[0]
    const back = checkPlanInputsText(decodeURIComponent(String(ex.href).replace(/^data:application\/json;charset=utf-8,/, '')))
    expect(back.ok && back.inputs.route).toEqual(ROUTE)
  })

  it('a result without a route shows mode auto', async () => {
    const ok = (await open(LIVE)) as Ok
    expect(ok.state).toBe('ok')
    expect(textOf(<PlanPage load={ok} permalink="p" simEnabled={false} importState={{ kind: 'idle' }} onImportFile={() => {}} />)).toContain('Route mode: auto')
  })

  it('route_mode alone (no stops in the inputs) is shown as given', () => {
    expect(recordRoute(recordWith({ route_mode: 'ordered' })).mode).toBe('ordered')
  })

  it('a broken route or route_mode is a contract error, not a page', async () => {
    expect((await open(recordWith({}, { mode: 'ordered', stops: [{ station: 'nope' }] }))).state).toBe('error')
    expect((await open(recordWith({ route_mode: 'sideways' }))).state).toBe('error')
    expect(checkRunRecord(recordWith({ route_mode: 'ordered', feasibility: { feasible: true } }, ROUTE))).toEqual([])
    expect(checkRunRecord({ ...LIVE, surprise: 1 }).join()).toMatch(/surprise/)
  })

  it('"Save to My plans" on the result page saves the plan with its route', async () => {
    const ok = (await open(recordWith({ route_mode: 'ordered' }, ROUTE))) as Ok
    const store = createPlansStore(fresh(), clock)
    const props = propsOf(store, { hash: ok.hash, inputs: ok.record.inputs })
    const page = <PlanPage load={ok} permalink="p" simEnabled={false} importState={{ kind: 'idle' }} onImportFile={() => {}} plans={props} />
    const save = elements(page).find((p) => typeof p.onClick === 'function' && p.class === 'live-btn')!
    ;(save.onClick as () => void)()
    expect(byHash(store, ok.hash)?.route).toEqual(ROUTE)
    expect(savedPlanInputs(byHash(store, ok.hash)!).route).toEqual(ROUTE)
    expect(textOf(<PlanPage load={ok} permalink="p" simEnabled={false} importState={{ kind: 'idle' }} onImportFile={() => {}} plans={props} />)).toContain('Saved in this browser')
  })
})

// R0's v1.2.0 examples (contracts/backend/examples/*route*.json): the route here matches the contract.
describe('R0 contract examples (v1.2.0)', () => {
  const json = (n: string) => JSON.parse(readFileSync(resolve(__dirname, '../../../../contracts/backend/examples', n), 'utf8'))
  it.each(['plan_inputs.route_free.json', 'plan_inputs.route_ordered.json'])('%s imports and keeps its route (labels included) through export', (n) => {
    const doc = json(n)
    const back = checkPlanInputsText(exportPlanInputs(doc).text)
    expect(back.ok ? [] : back.errors).toEqual([])
    expect(back.ok && back.inputs.route).toEqual(doc.route)
  })
  it.each(['run_record.route_free.json', 'run_record.route_infeasible.json'])('%s passes the run record check and shows its route mode', (n) => {
    const rec = json(n) as RunRecord
    expect(checkRunRecord(rec)).toEqual([])
    expect(recordRoute(rec).mode).toBe(rec.route_mode ?? 'auto')
    const html = textOf(<ProvenancePage load={{ state: 'ok', hash: rec.hash, base: 'b', record: rec, tree: { scenario: null, timeline: null, errors: [] } as never }} />)
    expect(html).toContain(`Route mode ${rec.route_mode}`)
  })
})

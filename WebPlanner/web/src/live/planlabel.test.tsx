// Known answers for the fallback drill's "label flicker" (docs/hardening/fallback-drill.md, finding 3):
// while a permalink loads, no origin label is drawn (a neutral placeholder on the same label line, so
// nothing jumps); once the run record has loaded, the official tree shows labels.precomputed and a
// computed result labels.live, and from then on the label never disappears. The live label is never
// drawn for the official tree: not while loading, not after, not on the offline text.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ComponentChildren } from 'preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { LIVE_LABEL, PRECOMPUTED_LABEL } from './config'
import type { LiveState } from './health'
import { RUN_RECORD_LIVE } from './mock/fixtures'
import { createMockFetch } from './mock/fetch'
import { MOCK_OFFICIAL_HASH } from './mock/hashes'
import { mockFinishedTree } from './mock/result'
import { mountPlanRoute } from './planmount'
import { PlanLoading, PlanProblem } from './planview'
import { mockLiveLoader } from './result'
import { textOf, toHtml } from './testing/html'
import type { RunRecord } from './types'

const DATA = resolve(__dirname, '../../public/data')
const LIVE_HASH = (RUN_RECORD_LIVE as RunRecord).hash
const staticTree = (path: string): string | null => {
  const f = resolve(DATA, path)
  return f.startsWith(DATA) && existsSync(f) ? readFileSync(f, 'utf8') : null
}

function gate() {
  let open!: () => void
  const p = new Promise<void>((r) => (open = r))
  return { p, open }
}

/** mountPlanRoute on a mock API whose provenance answer and result files wait for a gate each. */
function harness(live?: LiveState) {
  const prov = gate()
  const files = gate()
  const inner = createMockFetch({
    trees: {
      [MOCK_OFFICIAL_HASH]: async (p) => (await files.p, staticTree(p)),
      [LIVE_HASH]: async (p) => (await files.p, mockFinishedTree(false)(p)),
    },
  })
  const fetch = async (input: string, init: RequestInit = {}) => {
    if (new URL(input).pathname.endsWith('/provenance')) await prov.p
    return inner(input, init)
  }
  const client = createApiClient({ base: 'http://api.test', fetch })
  let hashListener: (() => void) | null = null
  const loc = { hash: '#/', origin: 'https://x.test', pathname: '/' }
  vi.stubGlobal('location', loc)
  vi.stubGlobal('window', {
    addEventListener: (_: string, f: () => void) => void (hashListener = f),
    removeEventListener: () => void (hashListener = null),
  })
  const box = { className: '', hidden: true, textContent: '', remove() {}, querySelector: () => null }
  vi.stubGlobal('document', { createElement: () => box })
  const outlet = { hidden: false, after() {} }
  const app = { querySelector: () => outlet } as unknown as HTMLElement
  /** Every frame drawn into the box, in order. */
  const frames: string[] = []
  const cleanup = mountPlanRoute(app, {
    client,
    loaderFor: mockLiveLoader(inner),
    simEnabled: false,
    mountMap: null,
    render: (v: ComponentChildren) => void frames.push(toHtml(v)),
    onLiveState: live ? (fn) => (fn(live), () => {}) : undefined,
  })
  return {
    prov,
    files,
    frames,
    cleanup,
    go(h: string) {
      loc.hash = h
      hashListener?.()
    },
    last: () => frames.at(-1) ?? '',
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('permalink origin label while loading (fallback drill: label flicker)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('official hash, delayed run record: never the live label; the precomputed label once the record is in', async () => {
    const h = harness()
    h.go(`#/plan/${MOCK_OFFICIAL_HASH}`)
    await flush()
    await flush()
    // before the record: a neutral placeholder on the label line, no origin label at all
    expect(h.frames.length).toBeGreaterThan(0)
    for (const f of h.frames) {
      expect(f).not.toContain(LIVE_LABEL)
      expect(f).not.toContain(PRECOMPUTED_LABEL)
    }
    expect(h.last()).toContain('Loading')
    expect(h.last()).toMatch(/<p class="live-label"[^>]*><span class="live-origin-pending" aria-hidden="true">/)
    expect(h.last()).toContain(`href="#/plan/${MOCK_OFFICIAL_HASH}/provenance"`)

    // the record arrives; the tree files are still pending: the precomputed label shows at once
    const before = h.frames.length
    h.prov.open()
    await vi.waitFor(() => expect(h.last()).toContain(PRECOMPUTED_LABEL))
    expect(h.last()).toContain('Loading')
    expect(h.last()).not.toContain('live-origin-pending')

    // the tree arrives: the plan page, still precomputed
    h.files.open()
    await vi.waitFor(() => expect(textOf(h.last())).toContain('Play this plan'))
    const after = h.frames.slice(before)
    for (const f of after) expect(f).toContain(PRECOMPUTED_LABEL) // never no label once the record is in

    // its provenance and play views (cached record) too
    h.go(`#/plan/${MOCK_OFFICIAL_HASH}/provenance`)
    await vi.waitFor(() => expect(textOf(h.last())).toContain('Provenance of plan'))
    h.go(`#/plan/${MOCK_OFFICIAL_HASH}`)
    await vi.waitFor(() => expect(textOf(h.last())).toContain('Play this plan'))
    for (const f of h.frames) expect(f).not.toContain(LIVE_LABEL)
    for (const f of h.frames.slice(before)) expect(f).toContain(PRECOMPUTED_LABEL)
    h.cleanup()
  })

  it('computed hash, delayed run record: the live label only after the record is in', async () => {
    const h = harness()
    h.go(`#/plan/${LIVE_HASH}`)
    await flush()
    await flush()
    expect(h.frames.length).toBeGreaterThan(0)
    for (const f of h.frames) {
      expect(f).not.toContain(LIVE_LABEL)
      expect(f).not.toContain(PRECOMPUTED_LABEL)
      expect(f).toContain('live-origin-pending')
    }
    const before = h.frames.length
    h.prov.open()
    await vi.waitFor(() => expect(h.last()).toContain(LIVE_LABEL))
    expect(h.last()).toContain('Loading')
    h.files.open()
    await vi.waitFor(() => expect(textOf(h.last())).toContain('Play this plan'))
    for (const f of h.frames.slice(before)) {
      expect(f).toContain(LIVE_LABEL)
      expect(f).not.toContain(PRECOMPUTED_LABEL)
    }
    h.cleanup()
  })

  it('no record (offline, not found): the problem text carries no origin label, only the placeholder', async () => {
    const h = harness({ kind: 'offline', reason: 'unreachable' })
    h.go(`#/plan/${MOCK_OFFICIAL_HASH}`)
    expect(h.last()).not.toContain(LIVE_LABEL)
    expect(h.last()).toContain('live-origin-pending')
    h.cleanup()
    const t = toHtml(<PlanProblem load={{ state: 'notfound', hash: 'ffffffffffffffff', reason: 'unknown' }} />)
    expect(t).not.toContain(LIVE_LABEL)
    expect(t).toContain('live-origin-pending')
  })

  it('PlanLoading: placeholder without an origin, the origin label with one', () => {
    const none = toHtml(<PlanLoading hash={LIVE_HASH} origin={null} />)
    expect(none).not.toContain(LIVE_LABEL)
    expect(none).not.toContain(PRECOMPUTED_LABEL)
    expect(none).toContain('live-origin-pending')
    expect(toHtml(<PlanLoading hash={MOCK_OFFICIAL_HASH} origin="precomputed" />)).toContain(PRECOMPUTED_LABEL)
    expect(toHtml(<PlanLoading hash={LIVE_HASH} origin="computed_live" />)).toContain(LIVE_LABEL)
  })
})

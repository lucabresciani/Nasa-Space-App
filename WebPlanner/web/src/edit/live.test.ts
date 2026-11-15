// Live hook: /engine/version gives the identity; failure (or a static build) keeps static mode.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectLive, loadLivePort } from './live'
import { buildCatalog } from './options'
import { createPlanEditStore } from './store'

const DATA = resolve(__dirname, '../../public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'))
const catalog = buildCatalog(json('scenarios/index.json'), json('scenarios/pads/index.json'), json('stations.json'))
// contracts/backend/examples/run_record.live.json engine block shape (GET /engine/version)
const VERSION = { engine_tree: 'a'.repeat(40), commit: 'b'.repeat(40), config_hash: `sha256:${'1'.repeat(64)}`, web_contract_version: '1.0.0', backend_contract_version: '1.1.0', terrain_hash: `sha256:${'2'.repeat(64)}` }

describe('live hook', () => {
  it('connectLive turns hashes and live-only options on; a failure turns them off', async () => {
    const s = createPlanEditStore({ catalog })
    expect(s.live.peek()).toBe(false)
    expect(await connectLive(s, { engineVersion: async () => VERSION })).toBe(true)
    expect(s.live.peek()).toBe(true)
    expect(s.committedHash.peek()).toMatch(/^[0-9a-f]{16}$/)
    expect(s.check({ dwell: { S7: 45 } })).toEqual({ ok: true })
    expect(await connectLive(s, { engineVersion: async () => Promise.reject(new Error('offline')) })).toBe(false)
    expect(s.live.peek()).toBe(false)
    expect(s.committedHash.peek()).toBeUndefined()
    expect(s.check({ dwell: { S7: 45 } })).toMatchObject({ ok: false, needsServer: true })
  })
  it('a static build (VITE_LIVE off) has no live client', async () => {
    expect(await loadLivePort()).toBeNull()
  })
})

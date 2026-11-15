// Live-mode hook (WS18 task 3 builds on it): the engine identity that makes step hashes equal the
// server's. Nothing from src/live is imported statically, not even types (live/isolation.test.ts);
// the client is loaded behind VITE_LIVE, so a static build carries none of it (design-agents rule 6).
import type { EngineIdentity } from './canonical'

/** The fields of GET /engine/version (live/types.ts EngineVersion) the hash needs. */
export type EngineVersion = EngineIdentity
import type { PlanEditStore } from './store'

/** The part of the live API client (WS13) the edit store needs. */
export interface LiveEditPort {
  engineVersion(): Promise<EngineVersion>
}

/** /engine/version -> the three parts of the D57 hash. */
export const identityOf = (v: EngineVersion): EngineIdentity => ({ engine_tree: v.engine_tree, config_hash: v.config_hash, terrain_hash: v.terrain_hash })

/** Turn live planning on for `store` (identity from /engine/version); off again on failure. */
export async function connectLive(store: PlanEditStore, port: LiveEditPort): Promise<boolean> {
  try {
    store.setIdentity(identityOf(await port.engineVersion()))
    return true
  } catch {
    store.setIdentity(null)
    return false
  }
}

/** The live API client, or null in a static build (VITE_LIVE off). */
export async function loadLivePort(): Promise<LiveEditPort | null> {
  if (import.meta.env.VITE_LIVE === '1' || import.meta.env.VITE_LIVE === 'true') {
    const m = await import('../live/client')
    return m.createApiClient()
  }
  return null
}

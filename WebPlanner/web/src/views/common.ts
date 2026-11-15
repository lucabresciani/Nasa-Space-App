import { data } from '../data/loader'
import { getManifest, setManifest } from '../prov/store'
import type { Manifest } from '../data/types'

let pending: Promise<Manifest | null> | undefined

/** Load manifest.json once (optional: a missing manifest flags every number as unbacked). */
export function ensureManifest(): Promise<Manifest | null> {
  if (getManifest()) return Promise.resolve(getManifest())
  pending ??= data()
    .optional(() => data().manifest())
    .then((m) => {
      setManifest(m)
      return m
    })
    .catch((e) => {
      console.error(e)
      pending = undefined
      return null
    })
  return pending
}

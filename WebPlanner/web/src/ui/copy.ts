// Typed access to the copy deck (readiness R4, DESIGN §3.8 and U11). copy.json is the only source of
// interface text (WS15 brief); it is a draft used provisionally until D reviews it (D73).
// Copy holds no numbers: values arrive through {placeholders}, formatted by the caller with units.
import raw from './copy.json'

/** Top-level fields of copy.json that are metadata, not interface text. */
export const COPY_META_KEYS: readonly string[] = ['status', 'provisional', 'version']

type Meta = 'status' | 'provisional' | 'version'
export type Copy = Omit<typeof raw, Meta>

/** Dotted paths to every string leaf, e.g. 'cards.pad.title'. */
type Paths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : T[K] extends object ? `${K}.${Paths<T[K]>}` : never
}[keyof T & string]
export type CopyKey = Paths<Copy>

export type CopyVars = Record<string, string | number>

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g

function lookup(key: string): string {
  let node: unknown = raw
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || (node === raw && COPY_META_KEYS.includes(part))) {
      throw new Error(`copy: no text at "${key}"`)
    }
    node = (node as Record<string, unknown>)[part]
  }
  if (typeof node !== 'string') throw new Error(`copy: no text at "${key}"`)
  return node
}

/** Placeholder names used by a key, in order of appearance. */
export function placeholders(key: CopyKey): string[] {
  return [...lookup(key).matchAll(PLACEHOLDER)].map((m) => m[1])
}

/**
 * Interface text for `key` with its {placeholders} filled from `vars`. Throws when a placeholder has
 * no value, so a half-filled string never reaches the screen.
 */
export function t(key: CopyKey, vars: CopyVars = {}): string {
  return lookup(key).replace(PLACEHOLDER, (_, name: string) => {
    const v = vars[name]
    if (v === undefined || v === null) throw new Error(`copy: "${key}" needs a value for {${name}}`)
    return String(v)
  })
}

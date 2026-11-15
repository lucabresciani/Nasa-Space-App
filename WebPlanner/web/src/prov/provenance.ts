// Provenance for every on-screen number (AGENTS rule 6, SPEC F16). The browser shows a value read
// from a data file and links it to its manifest.json entry. Contracts v1.0 fix no key naming
// (each producer picks dotted keys via pipeline/provenance/manifest.py), so a number resolves
//   1. by the key the caller names, when the manifest has it (value must agree), else
//   2. by an entry recorded for the same data file with the same value.
// Anything else is "unbacked": flagged on screen and warned about in dev mode.
import type { Manifest, ManifestEntry } from '../data/types'

export interface ProvQuery {
  /** Manifest key the caller expects (optional; producers choose their keys). */
  key?: string
  /** Data file (path under data/ or data-dummy/) the value was read from. */
  file: string
  value: unknown
}

export type ProvResult =
  | { status: 'ok'; key: string; entry: ManifestEntry }
  /** Found by file + value; `expectedKey` set when the caller named a key the manifest lacks. */
  | { status: 'matched'; key: string; entry: ManifestEntry; expectedKey?: string }
  | { status: 'mismatch'; key: string; entry: ManifestEntry }
  | { status: 'missing'; expectedKey?: string }
  | { status: 'no-manifest' }

const TREE_PREFIX = /^(?:web\/public\/)?(?:data|data-dummy)\//

export function normFile(f: string): string {
  return f.replace(/^\.?\/+/, '').replace(TREE_PREFIX, '')
}

export function isEntry(v: unknown): v is ManifestEntry {
  return !!v && typeof v === 'object' && 'value' in v && 'file' in v
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a))
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Index manifest entries by normalised file, for the file + value fallback. */
export function indexByFile(m: Manifest): Map<string, [string, ManifestEntry][]> {
  const idx = new Map<string, [string, ManifestEntry][]>()
  for (const [k, e] of Object.entries(m)) {
    if (!isEntry(e)) continue
    const f = normFile(e.file)
    let list = idx.get(f)
    if (!list) idx.set(f, (list = []))
    list.push([k, e])
  }
  return idx
}

const byFileCache = new WeakMap<object, Map<string, [string, ManifestEntry][]>>()

export function resolveProvenance(m: Manifest | null | undefined, q: ProvQuery): ProvResult {
  if (!m) return { status: 'no-manifest' }
  const key = q.key && q.key !== 'dummy' ? q.key : undefined
  if (key) {
    const e = m[key]
    if (isEntry(e)) return { status: sameValue(e.value, q.value) ? 'ok' : 'mismatch', key, entry: e }
  }
  let idx = byFileCache.get(m)
  if (!idx) byFileCache.set(m, (idx = indexByFile(m)))
  const hit = idx.get(normFile(q.file))?.find(([, e]) => sameValue(e.value, q.value))
  if (hit) return key ? { status: 'matched', key: hit[0], entry: hit[1], expectedKey: key } : { status: 'matched', key: hit[0], entry: hit[1] }
  return key ? { status: 'missing', expectedKey: key } : { status: 'missing' }
}

const UNIT_LABELS: Record<string, string> = { km2: 'km²', 'uGy/day': 'µGy/day', 'uGy/h': 'µGy/h', deg: '°', degC: '°C' }
const TIGHT_UNITS = new Set(['%', '°', 'deg'])

export interface FormatOptions {
  /** Fixed decimals for display only (the manifest entry and the tooltip keep the stored value). */
  dp?: number
  /** Print a + on positive numbers (e.g. a bias). */
  signed?: boolean
}

/**
 * Display formatting only: the value is printed as stored (no rounding) unless the caller asks for
 * fixed decimals; negatives get a true minus.
 */
export function formatValue(v: number | string | boolean | null | undefined, units?: string | null, opt: FormatOptions = {}): string {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return 'unknown'
  let s: string
  if (typeof v === 'number') {
    s = (opt.dp !== undefined ? v.toFixed(opt.dp) : String(v)).replace(/^-/, '−')
    if (opt.signed && v > 0) s = `+${s}`
  } else s = String(v)
  if (!units || units === '1') return s
  const u = UNIT_LABELS[units] ?? units
  return TIGHT_UNITS.has(units) ? `${s}${u}` : `${s} ${u}`
}

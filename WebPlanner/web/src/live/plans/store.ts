// "My plans" (D97 §3.7): plans saved in this browser only, with their route, title, result hash and
// date. The one sanctioned use of browser storage in the app (privacy.tsx says so; privacy.test.ts
// allows the storage API in this file and nowhere else). Live builds only (VITE_LIVE).
//
// Every storage access sits in try/catch: the storage may be missing (node, old browsers), empty,
// unreadable (garbage under our key), or throw on every access (private mode, blocked site data,
// quota). In each case the list still works for this page from an in-memory copy and `note` says why
// saved plans will not outlast the page. Nothing here is sent anywhere.
import { HASH_HEX_CHARS, TITLE_MAX_CHARS } from '../config'
import { canonicalJson } from '../planio'
import type { PlanInputs } from '../types'
import { checkRoute, routeOf, type RouteSpec } from './route'

/** Storage key (versioned: a later layout gets a new key instead of misreading this one). */
export const PLANS_KEY = 'homeline.myplans.v1'

export interface SavedPlan {
  /** planId(hash, inputs): one entry per result hash and route with its labels. */
  id: string
  /** Result hash: the plan opens as #/plan/{hash}. Labels are not hashed (D57), so plans that differ
   *  only in stop labels share a hash; they are kept as separate entries, each with its labels. */
  hash: string
  title: string
  /** When it was saved (ISO 8601 UTC). */
  saved_utc: string
  /** The route the plan was computed with (missing in the inputs = auto). */
  route: RouteSpec
  /** The plan's inputs (with the route), for export. */
  inputs: PlanInputs
}

export interface PlansSnapshot {
  plans: SavedPlan[]
  /** False when saved plans last only until the page closes (storage unavailable or full). */
  persistent: boolean
  /** Why not persistent, or that the stored list could not be read; null when all is well. */
  note: string | null
}

export type PlansResult = { ok: true } | { ok: false; error: string }

/** The parts of Web Storage the store uses. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export const NOTE_UNAVAILABLE = 'Browser storage is not available here (private mode or blocked site data), so saved plans last only until this page is closed.'
export const NOTE_FULL = 'Browser storage is full or refused the write, so this change lasts only until this page is closed.'
export const NOTE_UNREADABLE = 'The plans saved in this browser could not be read; saving starts a new list.'

/** The browser's local storage, or null. Reading the property can itself throw (blocked site data). */
export function browserStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null
  } catch {
    return null
  }
}

const HASH_RE = new RegExp(`^[0-9a-f]{${HASH_HEX_CHARS}}$`)

/** FNV-1a, 32 bit, as 8 hex characters (an entry id, not a security hash). */
function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

/** Entry id of a plan: its result hash plus a digest of its route with the labels (which the hash drops). */
export const planId = (hash: string, inputs: PlanInputs): string => `${hash}-${fnv(canonicalJson(routeOf(inputs)))}`
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function validEntry(e: unknown): e is SavedPlan {
  return (
    isObj(e) &&
    typeof e.id === 'string' &&
    typeof e.hash === 'string' &&
    HASH_RE.test(e.hash) &&
    typeof e.title === 'string' &&
    typeof e.saved_utc === 'string' &&
    isObj(e.inputs) &&
    checkRoute(e.route).length === 0
  )
}

/** A title the store accepts: trimmed, not empty, at most limits.title_max_chars characters. */
export function checkTitle(title: string): string | null {
  const t = title.trim()
  if (!t) return 'A plan needs a title.'
  if ([...t].length > TITLE_MAX_CHARS) return `A title has at most ${TITLE_MAX_CHARS} characters (limits.title_max_chars).`
  return null
}

/** A write refused for space (QuotaExceededError; Firefox: NS_ERROR_DOM_QUOTA_REACHED). */
const isQuota = (e: unknown) => !!e && typeof e === 'object' && /quota/i.test(String((e as { name?: unknown }).name))

const newestFirst = (a: SavedPlan, b: SavedPlan) => (a.saved_utc < b.saved_utc ? 1 : a.saved_utc > b.saved_utc ? -1 : 0)

export interface PlansStore {
  list(): PlansSnapshot
  get(id: string): SavedPlan | null
  /** Save (or re-save: same hash and route with labels) a plan. Title: `title`, else inputs.title, else "Plan {hash}". */
  save(p: { hash: string; inputs: PlanInputs; title?: string }): PlansResult
  rename(id: string, title: string): PlansResult
  remove(id: string): PlansResult
}

export function createPlansStore(storage: () => StorageLike | null = browserStorage, now: () => Date = () => new Date()): PlansStore {
  /** Copy of the list for this page; the source of truth after a failed write. */
  let mem: SavedPlan[] = []
  /** A write failed: storage no longer matches `mem`, so reads use `mem`. */
  let diverged = false
  let note: string | null = null

  function read(): SavedPlan[] {
    if (diverged) return mem
    let raw: string | null
    try {
      const s = storage()
      if (!s) {
        note = NOTE_UNAVAILABLE
        return mem
      }
      raw = s.getItem(PLANS_KEY)
    } catch {
      note = NOTE_UNAVAILABLE
      return mem
    }
    note = null
    if (raw === null) return (mem = [])
    try {
      const doc: unknown = JSON.parse(raw)
      const plans = isObj(doc) && Array.isArray(doc.plans) ? doc.plans : null
      if (!plans) throw new Error('not a plan list')
      const good = plans.filter(validEntry)
      if (good.length !== plans.length) note = NOTE_UNREADABLE
      return (mem = good)
    } catch {
      note = NOTE_UNREADABLE
      return (mem = [])
    }
  }

  function write(plans: SavedPlan[]): PlansResult {
    mem = plans
    try {
      const s = storage()
      if (!s) {
        diverged = true
        note = NOTE_UNAVAILABLE
        return { ok: true }
      }
      s.setItem(PLANS_KEY, JSON.stringify({ version: 1, plans }))
      diverged = false
      note = null
    } catch (e) {
      diverged = true
      note = isQuota(e) ? NOTE_FULL : NOTE_UNAVAILABLE
    }
    return { ok: true }
  }

  const snapshot = (): PlansSnapshot => {
    const plans = [...read()].sort(newestFirst)
    return { plans, persistent: note !== NOTE_UNAVAILABLE && note !== NOTE_FULL, note }
  }

  return {
    list: snapshot,
    get: (id) => read().find((p) => p.id === id) ?? null,
    save({ hash, inputs, title }) {
      if (!HASH_RE.test(hash)) return { ok: false, error: `"${hash}" is not a result hash.` }
      const routeErrs = inputs.route === undefined ? [] : checkRoute(inputs.route)
      if (routeErrs.length) return { ok: false, error: `The plan's route is not valid: ${routeErrs.join('; ')}` }
      const fromInputs = typeof inputs.title === 'string' ? inputs.title : ''
      const t = (title ?? fromInputs).trim() || `Plan ${hash}`
      const bad = checkTitle(t)
      if (bad) return { ok: false, error: bad }
      const id = planId(hash, inputs)
      const entry: SavedPlan = { id, hash, title: t, saved_utc: now().toISOString(), route: routeOf(inputs), inputs }
      return write([entry, ...read().filter((p) => p.id !== id)])
    },
    rename(id, title) {
      const bad = checkTitle(title)
      if (bad) return { ok: false, error: bad }
      const plans = read()
      if (!plans.some((p) => p.id === id)) return { ok: false, error: `No saved plan ${id}.` }
      return write(plans.map((p) => (p.id === id ? { ...p, title: title.trim() } : p)))
    },
    remove(id) {
      const plans = read()
      if (!plans.some((p) => p.id === id)) return { ok: false, error: `No saved plan ${id}.` }
      return write(plans.filter((p) => p.id !== id))
    },
  }
}

/** The plan inputs to export for a saved plan: its inputs with the saved title (the route included). */
export function savedPlanInputs(p: SavedPlan): PlanInputs {
  return { ...p.inputs, title: p.title }
}

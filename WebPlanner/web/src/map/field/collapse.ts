// WS16 task 4 (M4): the collapse (DESIGN U3, §3.4, §6.3, §6.4; contracts/field_shader.md §3.1).
// One value u_k in [0, 1] blends NASA's flat walk time (distance from the pad / 0.98 m/s, D25) into
// the real T_home:  T(x) = mix(d(x) / u_flatSpeed / 60, T_home(x), k).  k = 0 is the flat circle
// (1,764 m at 30 min, 3,528 m at 60), k = 1 is exactly the M2 band (and the M3 margin).
//
// This module is the CPU mirror (pure functions, tested against the real tree) and the animation
// driver. The shader (shader.ts) does the same per pixel. Storyboards drive k deterministically:
//   setCollapse(k)                       jump to k (cancels a running animation)
//   playCollapse({ from, to, durationMs }) 3 s ease-in-out (tokens motion.collapseMs); reduced
//                                        motion: a cross-fade of the two end pictures, no k between
//   collapseFrame(elapsedMs, ...)        the frame at a given time, for a director that owns time
// The k value lives in the UI store (ui.collapseK, A3); the cross-fade pair lives here.
import { signal, ui, type ReadSignal } from '../../state'
import { FIELD_QUERY_KEY } from './constants'
import { COLLAPSE_MS, collapseFrame, type CollapseFrame } from './collapseMath'
export * from './collapseMath'


const kFromSig = signal<number>(1)
const xfadeSig = signal<number>(1)
const playingSig = signal<boolean>(false)
/** Cross-fade source picture (reduced motion) and weight of the target picture; xfade 1 = no fade. */
export const collapseFade: { kFrom: ReadSignal<number>; xfade: ReadSignal<number>; playing: ReadSignal<boolean> } = { kFrom: kFromSig, xfade: xfadeSig, playing: playingSig }

let run = 0
let cancelRun: (() => void) | null = null

function stop(): void {
  run++
  cancelRun?.()
  cancelRun = null
  playingSig.value = false
}

const clamp01 = (k: number): number => (Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : 1)

/** Jump to k (storyboard `field.collapse` without a duration; the "Flat vs real" toggle). */
export function setCollapse(k: number): void {
  stop()
  apply({ k: clamp01(k), kFrom: clamp01(k), xfade: 1 })
}

/** Leave the collapse (k undefined in the store = the real field, no headline overlay). */
export function resetCollapse(): void {
  stop()
  apply({ k: 1, kFrom: 1, xfade: 1 })
  ui.collapseK.value = undefined
}

function apply(f: CollapseFrame): void {
  kFromSig.value = f.kFrom
  xfadeSig.value = f.xfade
  ui.collapseK.value = f.k
}

export interface PlayOptions {
  /** start value (default 0: the flat circle) */
  from?: number
  /** end value (default 1: the real band) */
  to?: number
  /** default tokens motion.collapseMs (3000) */
  durationMs?: number
  /** default the UI store's reduced-motion flag */
  reduced?: boolean
  /** injectable clock for tests and capture */
  now?: () => number
  raf?: (cb: () => void) => number
  cancelRaf?: (id: number) => void
}

/**
 * Play the collapse once (DESIGN §3.4: 3 s ease-in-out, once per trigger). Resolves true when it
 * finished, false when cancelled (setCollapse, resetCollapse or another play).
 */
export function playCollapse(o: PlayOptions = {}): Promise<boolean> {
  stop()
  const id = run
  const from = clamp01(o.from ?? 0)
  const to = clamp01(o.to ?? 1)
  const dur = o.durationMs ?? COLLAPSE_MS
  const reduced = o.reduced ?? ui.reducedMotion.peek()
  const now = o.now ?? (() => performance.now())
  const raf = o.raf ?? ((cb: () => void) => requestAnimationFrame(cb))
  const cancelRaf = o.cancelRaf ?? ((h: number) => cancelAnimationFrame(h))
  const t0 = now()
  playingSig.value = true
  apply(collapseFrame(0, dur, reduced, from, to))
  return new Promise<boolean>((resolve) => {
    let h = 0
    cancelRun = () => {
      cancelRaf(h)
      resolve(false)
    }
    const step = (): void => {
      if (id !== run) return
      const el = now() - t0
      apply(collapseFrame(el, dur, reduced, from, to))
      if (el >= dur) {
        cancelRun = null
        playingSig.value = false
        resolve(true)
      } else h = raf(step)
    }
    h = raf(step)
  })
}

/** Current collapse picture for the layer (k undefined in the store = 1, the real field). */
export function currentCollapse(): CollapseFrame {
  const k = ui.collapseK.value
  return { k: k === undefined ? 1 : k, kFrom: kFromSig.value, xfade: xfadeSig.value }
}

// ---- RR / capture switch ----------------------------------------------------------------------------
export type CollapseQuery = { kind: 'play' } | { kind: 'set'; k: number } | null

/** `?collapse=play | flat | real | <k>` in the search or the hash query. */
export function collapseQuery(search: string, hash: string): CollapseQuery {
  const q = new URLSearchParams(search)
  const h = hash.split('?')[1]
  if (h) new URLSearchParams(h).forEach((v, key) => q.set(key, v))
  const v = q.get(COLLAPSE_QUERY_KEY)
  if (v === null) return null
  if (v === 'play') return { kind: 'play' }
  if (v === 'flat') return { kind: 'set', k: 0 }
  if (v === 'real') return { kind: 'set', k: 1 }
  const n = Number(v)
  return v.trim() !== '' && Number.isFinite(n) ? { kind: 'set', k: clamp01(n) } : null
}
export const COLLAPSE_QUERY_KEY = 'collapse'
if ((COLLAPSE_QUERY_KEY as string) === FIELD_QUERY_KEY) throw new Error('query keys clash')

// ---- the headline (D25, D43): read from the manifest, never computed here --------------------------
export interface ManifestLike {
  [key: string]: unknown
}
interface Entry {
  value: unknown
  file: string
}
const entryOf = (m: ManifestLike, k: string): Entry | null => {
  const e = m[k] as Entry | undefined
  return e && typeof e === 'object' && 'value' in e && 'file' in e ? e : null
}

export interface CollapseHeadline {
  scenario: string
  budget: number
  /** % reachable of the assessed flat disc (D25); for 60 min the share over the part inside the data (D43) */
  value: number
  /** [conservative, optimistic] % */
  range: [number, number] | null
  /** D43: % of the 60-min circle inside the terrain data (null when the headline does not carry it) */
  inDataPct: number | null
  /** manifest keys of each number, for the trust chip / provenance popover */
  keys: { value: string; low: string | null; high: string | null; inData: string | null }
  file: string
}

/**
 * The headline the collapse counts up to, straight from manifest.json (the console's keys:
 * reachable_pct.{scenario}.{budget}, reachable_pct_range.{scenario}.{budget}.low|high and, D43,
 * headline.{scenario}.disc_{budget}.in_data_pct). null when the manifest lacks the value.
 */
export function collapseHeadline(m: ManifestLike, scenario: string, budget: number): CollapseHeadline | null {
  const kv = `reachable_pct.${scenario}.${budget}`
  const v = entryOf(m, kv)
  if (!v || typeof v.value !== 'number') return null
  const kl = `reachable_pct_range.${scenario}.${budget}.low`
  const kh = `reachable_pct_range.${scenario}.${budget}.high`
  const lo = entryOf(m, kl)
  const hi = entryOf(m, kh)
  const ki = `headline.${scenario}.disc_${budget}.in_data_pct`
  const inD = entryOf(m, ki)
  const range: [number, number] | null = lo && hi && typeof lo.value === 'number' && typeof hi.value === 'number' ? [lo.value, hi.value] : null
  const inDataPct = inD && typeof inD.value === 'number' ? inD.value : null
  return {
    scenario,
    budget,
    value: v.value,
    range,
    inDataPct,
    keys: { value: kv, low: range ? kl : null, high: range ? kh : null, inData: inDataPct !== null ? ki : null },
    file: v.file,
  }
}

/** Display decimals of the headline (DESIGN U3: "23.0% (15.2–28.7)"). */
export const HEADLINE_DP = 1

/**
 * Headline text at collapse progress k (DESIGN U3: "the headline counts up to its value"). At k = 1
 * (and always under reduced motion) it is the manifest value; during the count the digits are a
 * tween, marked aria-hidden by the caller, ending exactly on the manifest value.
 */
export function headlineCount(h: CollapseHeadline, k: number, reduced: boolean): { text: string; final: boolean } {
  const final = reduced || k >= 1
  const v = final ? h.value : h.value * Math.max(0, k)
  return { text: v.toFixed(HEADLINE_DP), final }
}

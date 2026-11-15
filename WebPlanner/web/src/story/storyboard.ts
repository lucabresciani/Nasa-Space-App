// WS16 task 10 (M10): storyboard files (web/public/story/{id}.json, contracts/storyboard.schema.json v1,
// DESIGN §6.3). Parse = schema check (the same checker the data loader uses) + the rules the schema
// cannot say: steps in non-decreasing t, every caption is a copy.json key (captions come from the copy
// deck only; DESIGN §3.8), every layer id is one the director knows.
import schema from '../../../contracts/storyboard.schema.json'
import { checkSchema, type JsonSchema } from '../data/schema'
import { placeholders, type CopyKey } from '../ui/copy'

export interface StoryCamera {
  lon?: number
  lat?: number
  target?: string
  alt_m?: number
  bearing?: number
  pitch?: number
}

export interface StoryField {
  mode?: 'bands' | 'margin'
  collapse?: number
  duration_s?: number
  variant?: 'opt' | 'nom' | 'con'
}

export interface StoryClock {
  t_min?: number
  playing?: boolean
  speed?: number
}

export interface StoryStep {
  t: number
  camera?: StoryCamera
  layers?: Record<string, boolean>
  field?: StoryField
  clock?: StoryClock
  selection?: string | null
  caption?: string | null
  ui?: 'hide' | 'reveal'
}

export interface Storyboard {
  id: string
  version: '1'
  title?: string
  size: [number, number]
  fps: number
  steps: StoryStep[]
}

/**
 * Camera target code for the flythrough follow camera (DESIGN U6 item 2, U16 preset 5 "follow the
 * crew"): the look-at point runs ahead of the crew position at the storyboard clock. It fits the v1
 * target pattern, so the schema needs no change; it is not a labels.json code.
 */
export const FOLLOW_TARGET = 'CREW'

/** Storyboard layer ids and what they switch (story/apply.ts). */
export const STORY_LAYERS = ['homeline', 'unknown', 'edges', 'stations', 'route', 'basemap', 'terrain', 'relief_low'] as const
export type StoryLayer = (typeof STORY_LAYERS)[number]

export class StoryboardError extends Error {}

function isCopyKey(k: string): boolean {
  try {
    placeholders(k as CopyKey)
    return true
  } catch {
    return false
  }
}

/** Validate and type a storyboard; throws StoryboardError with every problem found. */
export function parseStoryboard(raw: unknown, expectId?: string): Storyboard {
  const errs = checkSchema(raw, schema as JsonSchema).map((e) => `${e.path}: ${e.message}`)
  if (errs.length) throw new StoryboardError(`storyboard does not match the contract: ${errs.join('; ')}`)
  const sb = raw as Storyboard
  const problems: string[] = []
  if (expectId !== undefined && sb.id !== expectId) problems.push(`id "${sb.id}" is not the file name "${expectId}"`)
  sb.steps.forEach((s, i) => {
    if (i > 0 && s.t < sb.steps[i - 1].t) problems.push(`step ${i}: t ${s.t} before the previous step`)
    if (typeof s.caption === 'string' && !isCopyKey(s.caption)) problems.push(`step ${i}: caption "${s.caption}" is not a copy.json key`)
    for (const id of Object.keys(s.layers ?? {})) if (!(STORY_LAYERS as readonly string[]).includes(id)) problems.push(`step ${i}: unknown layer "${id}"`)
  })
  if (problems.length) throw new StoryboardError(problems.join('; '))
  return sb
}

/** Fetch web/public/story/{id}.json (outside the data root: not the data loader) and parse it. */
export async function loadStoryboard(id: string, base: string = import.meta.env.BASE_URL): Promise<Storyboard> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new StoryboardError(`bad storyboard id "${id}"`)
  const res = await fetch(`${base}story/${id}.json`)
  const ct = res.headers.get('content-type') ?? ''
  if (!res.ok || (ct && !ct.includes('json'))) throw new StoryboardError(`storyboard "${id}" not found`)
  return parseStoryboard(await res.json(), id)
}

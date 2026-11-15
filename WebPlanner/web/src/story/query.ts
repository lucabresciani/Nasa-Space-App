// WS16 task 10 (M10): which story runs on the planning map (DESIGN U6). Small and pure, so the console
// can decide without loading the director:
//   ?capture=<id>  capture mode: storyboard <id> at its fixed frame step, no UI chrome (?chrome=1 keeps it)
//   ?demo=1        kiosk loop (kiosk.json, repeated; any input exits)
//   ?intro=0|1     never / always (once more) play the descent intro
//   otherwise      the intro plays on the first planning-map visit of this page session
// The intro never plays under reduced motion (DESIGN §3.4). DESIGN U6 item 4 says "once per browser
// (stored setting)"; the app keeps no browser storage (privacy note, src/live/privacy.test.ts), so
// "seen" is held in memory (ui.introSeen) for this page session only: deviation, see notes/M10.md.
// Parameters are read from the page query and from the hash query (`#/?intro=0`).

export type StoryRequest =
  | { kind: 'capture'; id: string; chrome: boolean }
  | { kind: 'demo' }
  | { kind: 'intro' }
  | null

export interface StoryParams {
  capture: string | null
  demo: boolean
  intro: '0' | '1' | null
  chrome: boolean
}

const ID = /^[a-z0-9][a-z0-9_-]*$/

export function storyParams(search: string, hash: string): StoryParams {
  const q = new URLSearchParams(search.replace(/^\?/, ''))
  const h = new URLSearchParams(hash.split('?')[1] ?? '')
  const get = (k: string): string | null => q.get(k) ?? h.get(k)
  const cap = get('capture')
  const intro = get('intro')
  return {
    capture: cap && ID.test(cap) ? cap : null,
    demo: get('demo') === '1',
    intro: intro === '0' || intro === '1' ? intro : null,
    chrome: get('chrome') === '1',
  }
}

/** True when the page asks for capture or kiosk (main.ts boots story mode before the first render). */
export function wantsStoryBoot(search: string, hash: string): boolean {
  const p = storyParams(search, hash)
  return p.capture !== null || p.demo
}

export function storyRequest(p: StoryParams, s: { reduced: boolean; introSeen: boolean; legacy: boolean }): StoryRequest {
  if (p.capture) return { kind: 'capture', id: p.capture, chrome: p.chrome }
  if (p.demo) return { kind: 'demo' }
  if (s.legacy || s.reduced || p.intro === '0') return null
  if (p.intro === '1' || !s.introSeen) return { kind: 'intro' }
  return null
}
